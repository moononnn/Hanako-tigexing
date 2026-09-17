// 提个醒 · 主入口（lifecycle 插件）
// 小喇叭的耳朵——订阅 bus 事件流，监听正常回合、自动重试和异常释放，
// 按策略弹 Windows toast；异常路径只提醒，不自动续接。
//
// v0.2 改造（2026-08-16，分享版）：
//   - 监听机制从 Pi SDK Extension onResponse 换成 bus.subscribe(turn_end)
//     （星星屋实测 onResponse 钩子宿主不调用；bus 订阅实测有效）
//   - 只认最终回合（stopReason=stop），工具循环中的中间回合不提醒
//   - 助手显示名/头像动态获取（agent:list + avatars/ 目录），跟原版通知一致
//   - 提醒范围可配置：只提醒后台窗口（默认，跟原版一致）/ 所有窗口
// 弹窗方案：lib/notify.ps1（PowerShell WinRT toast，环境变量传参）

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { Notifier, isInQuietHours, resolveChatTrigger } from "./lib/policy.js";
import { createConfigManager } from "./lib/config.js";
import { sendToast } from "./lib/toast.js";
import {
  parseTurnEnd,
  parseTurnFailure,
  parseProviderError,
  parseSessionAbort,
  parseAutoRetryStart,
  parseAutoRetryEnd,
  parseSessionUnhealthyWarning,
  parseActivityUpdate,
  parseSessionBackgroundTask,
  sessionIdFromPath,
  agentIdFromSessionPath,
  isFinalTurn,
  isIntermediateToolTurn,
  isUserInitiatedAbortReason
} from "./lib/event-parse.js";
import { ActivityNotificationTracker, resolveActivitySessionPath } from "./lib/activity-notify.js";
import { resolveAgentAvatar } from "./lib/agent-avatar.js";
import { isHanaFocused } from "./lib/window-focus.js";
import { resolveSound } from "./lib/sounds.js";
import { resolveSessionTitleWithRetry } from "./lib/session-title.js";
import { getStyle, sessionPrefix } from "./lib/style.js";
import { ModelConfig } from "./lib/model-config/index.js";
import { refineTitleAndBody } from "./lib/refine.js";
import { setupExtraStyles } from "./lib/dialect-links.js";
import { AbnormalTurnTracker, ABNORMAL_FAILURE_GRACE_MS } from "./lib/abnormal-state.js";
import { buildAbnormalCopy, isRetryCancelled } from "./lib/abnormal-copy.js";
import { TurnTrace } from "./lib/turn-trace.js";
import { BackgroundTaskTracker } from "./lib/background-tasks.js";
import { appendDebugLog, isDebugNoisyEvent } from "./lib/debug-log.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
// 「当前窗口」判定阈值：该会话最近 X 毫秒内有用户消息 → 认为是正在看的窗口
const ACTIVE_WINDOW_MS = 120 * 1000;
// 宿主先发 activity_update，再按原版设置发送完成通知；留一点窗口等通知事件到达后再去重。
const ACTIVITY_NOTIFICATION_GRACE_MS = 1500;
// turn_end(error) 先等宿主决定是否进入自动重试；未进入时才做兜底提醒。
const ABNORMAL_TURN_GRACE_MS = ABNORMAL_FAILURE_GRACE_MS;

// 调试日志（排查用，写插件数据目录，不进发布包；高频事件和大小上限由 debug-log 统一收口）
function dbgLog(dataDir, line) {
  appendDebugLog(dataDir, line);
}

export default class TigexingPlugin {
  async onload() {
    const ctx = this.ctx;
    dbgLog(ctx?.dataDir, "onload 开始，this.ctx=" + (ctx ? "有" : "无"));
    this._log = ctx.log;
    this._dataDir = ctx.dataDir || path.join(HANA_HOME, "plugin-data", ctx.pluginId);
    this._pluginDir = ctx.pluginDir || path.join(HANA_HOME, "plugins", ctx.pluginId);
    this._agentsHome = path.join(HANA_HOME, "agents");
    dbgLog(this._dataDir, "dataDir=" + this._dataDir);

    this._agentNames = {};
    this._lastUserMsgAt = new Map(); // sessionId -> ts（最近一次用户消息）
    this._timers = new Map();
    this._backgroundTasks = new BackgroundTaskTracker();
    this._activityNotifications = new ActivityNotificationTracker();
    this._abnormal = new AbnormalTurnTracker({
      graceMs: ABNORMAL_TURN_GRACE_MS,
      onAlert: (alert) => this._handleAbnormalAlert(alert)
    });
    this._turnTrace = new TurnTrace({ dataDir: this._dataDir });

    this._config = createConfigManager({ dataDir: this._dataDir, pluginId: ctx.pluginId, log: ctx.log });
    this._notifier = new Notifier(this._config.get());
    // 文案润色（可选高级档）：模型配置三档（跟随助手/Hana 模型/自定义 API），Key 加密存插件数据目录
    this._refineMc = new ModelConfig({
      ctx,
      store: {
        getConfig: () => {
          try {
            const f = path.join(this._dataDir, "refine-model.json");
            return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf-8")) : {};
          } catch { return {}; }
        },
        saveConfig: (mutator) => {
          const cfg = this._refineStoreCfg();
          mutator(cfg);
          try { fs.writeFileSync(path.join(this._dataDir, "refine-model.json"), JSON.stringify(cfg, null, 2)); } catch { /* 写入失败不影响主流程 */ }
        }
      }
    });

    // 启动时拉一次助手名单（失败不阻断，后面按需再拉）
    this._refreshAgents();

    // 表情包插件方言联动（分享版）：装了 biaoqingbao 才挂载方言/学我说话风格，失败静默不阻断
    try {
      const extra = await setupExtraStyles(HANA_HOME);
      dbgLog(this._dataDir, `扩展风格注册: ${extra ? extra.styles.map((s) => s.id).join(",") : "无（未装表情包插件或无可注册风格）"}`);
    } catch (e) {
      dbgLog(this._dataDir, `扩展风格注册失败（已降级）: ${e?.message || e}`);
    }

    // 核心：订阅 bus 事件流
    try {
      this._off = ctx.bus.subscribe((event, scopedSessionPath) => {
        try {
          const et = event?.type || "?";
          // 高频噪音事件不落盘（避免日志爆炸），只记关键事件
          if (!isDebugNoisyEvent(et)) dbgLog(this._dataDir, `事件 ${et} path=${scopedSessionPath || "无"}`);
          // 宿主通知事件先记下来；后续 activity_update 到达时用同一 sessionFile 去重。
          if (event?.type === "notification") {
            const notificationPath = scopedSessionPath || event?.sessionFile || event?.sessionPath;
            if (this._activityNotifications.mark(notificationPath)) {
              dbgLog(this._dataDir, `已记录宿主活动通知: ${notificationPath}`);
            }
            return;
          }
          // 0) 后台任务（如子 agent）只算中间过程；任务全部收齐前不发聊天完成提醒。
          const backgroundTask = parseSessionBackgroundTask(event, scopedSessionPath);
          if (backgroundTask) {
            this._backgroundTasks.update(backgroundTask);
            const taskDone = backgroundTask.action === "remove" || ["completed", "failed", "canceled", "aborted"].includes(backgroundTask.status.toLowerCase());
            dbgLog(this._dataDir, `后台任务${taskDone ? "结束" : "开始"}: sessionId=${backgroundTask.sessionId} taskId=${backgroundTask.taskId} status=${backgroundTask.status || "未知"} remaining=${this._backgroundTasks.count(backgroundTask.sessionId)}`);
            return;
          }
          // 1) 用户消息：记下会话的最后活跃时间，开启新的异常提醒周期，并标记活跃回合（进程被杀时重启补弹用）。
          if (event?.type === "session_user_message") {
            const sid = sessionIdFromPath(scopedSessionPath);
            if (sid) {
              this._lastUserMsgAt.set(sid, Date.now());
              this._abnormal.beginUserTurn(sid);
              this._turnTrace.markActive(sid, {
                agentId: agentIdFromSessionPath(scopedSessionPath) || "unknown",
                sessionPath: scopedSessionPath || ""
              });
            }
            return;
          }
          // 1.1) 自动重试状态：turn_end(error) 只做候选记录，等宿主决定是否重试耗尽。
          const retryStart = parseAutoRetryStart(event, scopedSessionPath);
          if (retryStart) {
            this._abnormal.onRetryStart(retryStart.sessionId);
            dbgLog(this._dataDir, `自动重试开始: sessionId=${retryStart.sessionId} attempt=${retryStart.attempt}/${retryStart.maxAttempts}`);
            return;
          }
          const retryEnd = parseAutoRetryEnd(event, scopedSessionPath);
          if (retryEnd) {
            this._abnormal.onRetryEnd(retryEnd);
            // 重试成功 = 回合正常结束，擦掉活跃追踪
            if (retryEnd.success) this._turnTrace.clearActive(retryEnd.sessionId);
            dbgLog(this._dataDir, `自动重试结束: sessionId=${retryEnd.sessionId} success=${retryEnd.success} finalError=${retryEnd.finalError || "无"}`);
            return;
          }
          // 1.2) provider 错误 / 强制释放兜底。通常会和 turn_end 成对出现，状态机负责去重。
          const providerError = parseProviderError(event, scopedSessionPath);
          if (providerError) {
            if (this._lastUserMsgAt.has(providerError.sessionId)) this._abnormal.onTurnFailure(providerError);
            return;
          }
          const sessionAbort = parseSessionAbort(event, scopedSessionPath);
          if (sessionAbort) {
            if (this._lastUserMsgAt.has(sessionAbort.sessionId)) this._abnormal.onTurnFailure(sessionAbort);
            return;
          }
          // 1.3) 会话恢复时的连续失败警告。只处理当前进程里用户实际参与过的会话，避免启动时翻旧账。
          const unhealthy = parseSessionUnhealthyWarning(event, scopedSessionPath);
          if (unhealthy) {
            if (this._lastUserMsgAt.has(unhealthy.sessionId)) this._abnormal.onSessionUnhealthy(unhealthy);
            return;
          }
          // 1.3) 失败回合：记录部分正文和错误原因；没有进入自动重试时由状态机兜底提醒。
          const failure = parseTurnFailure(event, scopedSessionPath);
          if (failure) {
            if (this._lastUserMsgAt.has(failure.sessionId)) this._abnormal.onTurnFailure(failure);
            dbgLog(this._dataDir, `记录异常回合: sessionId=${failure.sessionId} textLen=${String(failure.text).length} error=${failure.errorMessage || "无"}`);
            return;
          }
          // 1.5) 计划任务 / 巡检完成（接管自动完成通知，并对已有通知去重）
          const act = parseActivityUpdate(event);
          if (act) {
            this._handleActivityUpdate(act);
            return;
          }
          // 2) 回合完成
          const info = parseTurnEnd(event, scopedSessionPath);
          if (!info) return;
          dbgLog(this._dataDir, `解析到 turn_end: agent=${info.agentId} stopReason=${info.stopReason} aborted=${info.aborted} textLen=${String(info.text).length}`);
          // 用户主动停止/关闭：回合已结束，擦掉活跃追踪（不留残留，避免下次重启误报）。
          if (info.aborted && isUserInitiatedAbortReason(info.reason)) {
            this._turnTrace.clearActive(info.sessionId);
          }
          if (isFinalTurn(info.stopReason) && !isIntermediateToolTurn(info) && !info.aborted && info.stopReason !== "error") {
            this._abnormal.onTurnSuccess(info.sessionId);
            this._turnTrace.clearActive(info.sessionId);
          }
          this._handleTurnEnd(info);
        } catch (err) {
          dbgLog(this._dataDir, `事件处理异常: ${err?.stack || err?.message || err}`);
          this._log?.error?.("[提个醒] 事件处理异常", { error: err?.message || err });
        }
      });
      dbgLog(this._dataDir, "bus 订阅成功");
    } catch (err) {
      dbgLog(this._dataDir, "bus 订阅失败: " + (err?.message || err));
      throw err;
    }

    ctx.log.info("[提个醒] 小喇叭已戴上（bus 监听）");

    // 重启补弹：Hana 非正常退出时，把「没走完的回合」补提醒给用户（对话框断了）。
    // 等几秒让宿主恢复 + 助手名单刷新完成，再查残留并弹。
    this._restoreTimer = setTimeout(() => {
      this._handleRestoredInterrupts().catch(() => {});
    }, 4000);
    this._restoreTimer.unref?.();
  }

  async onunload() {
    if (this._off) this._off();
    if (this._restoreTimer) clearTimeout(this._restoreTimer);
    for (const [sid, t] of this._timers) {
      clearTimeout(t);
      this._timers.delete(sid);
    }
    this._backgroundTasks?.clear();
    this._abnormal?.dispose();
    // 正常退出：清空活跃回合追踪，重启后不补弹（用户知道自己关了 Hana）。
    this._turnTrace?.markCleanShutdown();
    this._log?.info?.("[提个醒] 小喇叭已摘下");
  }

  // ─── 助手显示名（动态） ───
  async _refreshAgents() {
    try {
      const res = await this.ctx.bus.request("agent:list", {});
      const map = {};
      for (const a of res?.agents || []) {
        if (a?.id) map[a.id] = a.name || a.id;
      }
      if (Object.keys(map).length) this._agentNames = map;
    } catch {
      // 保留旧缓存；agent:list 不可用时显示 agentId 原名
    }
  }

  _agentName(agentId) {
    if (this._agentNames[agentId]) return this._agentNames[agentId];
    // 未知助手：顺手刷新一次名单，兜底显示原名
    this._refreshAgents();
    return agentId || "助手";
  }

  // ─── 重启补弹：上次进程非正常退出时，把没走完的回合提醒给用户 ───
  async _handleRestoredInterrupts() {
    try {
      const interrupted = this._turnTrace.readInterrupted();
      if (!interrupted.length) {
        this._turnTrace.reset();
        return;
      }
      await this._refreshAgents();
      const cfg = this._config.get();
      for (const s of interrupted) {
        const agentName = this._agentName(s.agentId);
        const sessionTitle = await resolveSessionTitleWithRetry({
          bus: this.ctx.bus,
          agentsHome: this._agentsHome,
          agentId: s.agentId,
          sessionPath: s.sessionPath || undefined,
          sessionId: s.sessionId
        });
        const title = sessionTitle
          ? `${sessionPrefix(sessionTitle)}${agentName} · 上次对话被打断`
          : `${agentName} · 上次对话被打断`;
        const body = "对话框在退出前没有完成回复，可能需要重启 Hana 恢复";
        const avatar = resolveAgentAvatar(this._agentsHome, s.agentId);
        sendToast({
          pluginDir: this._pluginDir,
          title,
          message: body,
          style: "icon",
          icon: avatar || undefined,
          duration: cfg.toastDuration,
          log: this._log
        });
        dbgLog(this._dataDir, `重启补弹: sessionId=${s.sessionId} title=${title}`);
      }
      this._turnTrace.reset();
    } catch (err) {
      dbgLog(this._dataDir, `重启补弹异常: ${err?.stack || err?.message || err}`);
    }
  }

  // ─── 异常回合提醒（只提醒，不续接、不注入） ───
  async _handleAbnormalAlert(alert) {
    try {
      const sessionId = String(alert?.sessionId || "");
      const agentId = String(alert?.agentId || "unknown");
      if (!sessionId || sessionId === "unknown" || !this._lastUserMsgAt.has(sessionId)) {
        dbgLog(this._dataDir, `异常提醒拦截: 无用户会话 sessionId=${sessionId || "无"}`);
        return;
      }
      if (alert?.kind === "failure" && isRetryCancelled(alert.finalError)) {
        dbgLog(this._dataDir, `异常提醒拦截: 用户主动取消重试 sessionId=${sessionId}`);
        return;
      }

      const cfg = this._config.get();
      const chatTrigger = resolveChatTrigger(cfg, agentId);
      if (!cfg.enabled || !cfg.abnormalEnabled || chatTrigger === "never") {
        dbgLog(this._dataDir, `异常提醒拦截: enabled=${cfg.enabled} abnormalEnabled=${cfg.abnormalEnabled} chatTrigger=${chatTrigger}`);
        return;
      }
      if (isInQuietHours(cfg)) {
        dbgLog(this._dataDir, `异常提醒拦截: 静默时段 sessionId=${sessionId}`);
        return;
      }
      if (chatTrigger === "whenUnfocused") {
        const focused = await isHanaFocused();
        if (focused) return;
      } else if (chatTrigger === "whenSessionUnfocused") {
        const lastUserAt = this._lastUserMsgAt.get(sessionId) || 0;
        if (Date.now() - lastUserAt < ACTIVE_WINDOW_MS) return;
      }

      const agentName = this._agentName(agentId);
      const fallback = buildAbnormalCopy({
        kind: alert.kind,
        agentName,
        sessionTitle: "",
        partialText: alert.text,
        errorMessage: alert.finalError || alert.errorMessage,
        recentErrors: alert.recentErrors,
        totalChecked: alert.totalChecked
      });
      let title = fallback.title;
      let body = fallback.body;
      const styleId = (cfg.agentStyles || {})[agentId] || "default";
      const style = getStyle(styleId);

      // 沿用提个醒现有的可选润色开关；失败自动退回上面的规则版。
      if (cfg.refineEnabled && style.refinable) {
        try {
          const refined = await refineTitleAndBody({
            mc: this._refineMc,
            agentName,
            style,
            kind: alert.kind === "unhealthy" ? "unhealthy" : "failure",
            snippet: alert.text || (alert.kind === "unhealthy"
              ? `最近 ${alert.recentErrors || 0}/${alert.totalChecked || 0} 次回复失败`
              : "模型连接中断，请说继续再试"),
            count: 1,
            failureReason: alert.finalError || alert.errorMessage || "",
            sessionTitle: "",
            sessionPrefix,
            timeoutMs: 8000
          });
          title = refined.title;
          body = refined.body;
          dbgLog(this._dataDir, `异常提醒润色成功: title=${title} body=${body}`);
        } catch (err) {
          dbgLog(this._dataDir, `异常提醒润色失败降级规则版: ${err?.message || err}`);
        }
      }

      // 会话标题查询挪到润色之后（润色耗时正好给宿主异步起名留时间），查不到再补一次短重试
      const sessionTitle = await resolveSessionTitleWithRetry({
        bus: this.ctx.bus,
        agentsHome: this._agentsHome,
        agentId,
        sessionPath: alert.sessionPath,
        sessionId
      });
      if (sessionTitle) {
        title = sessionPrefix(sessionTitle) + title;
      }

      const avatar = resolveAgentAvatar(this._agentsHome, agentId);
      const soundCfg = (cfg.agentSounds || {})[agentId] || "default";
      let sound;
      if (soundCfg === "silent") {
        sound = "silent";
      } else if (soundCfg && soundCfg !== "default") {
        sound = resolveSound(this._dataDir, soundCfg, cfg.soundDir) || undefined;
      }

      sendToast({
        pluginDir: this._pluginDir,
        title,
        message: body,
        style: cfg.toastStyle === "plain" ? "plain" : "icon",
        icon: avatar || undefined,
        sound,
        duration: cfg.toastDuration,
        log: this._log
      });
      dbgLog(this._dataDir, `异常提醒已弹: source=${alert.source} kind=${alert.kind} sessionId=${sessionId} title=${title} body=${body}`);
      // 异常回合已提醒 = 回合告一段落，擦掉活跃追踪（重启补弹不重复提醒）
      this._turnTrace.clearActive(sessionId);
      this._log?.info?.("[提个醒] 异常回合已提醒", { source: alert.source, kind: alert.kind, agentId, sessionId });
    } catch (err) {
      dbgLog(this._dataDir, `异常回合提醒异常: ${err?.stack || err?.message || err}`);
      this._log?.error?.("[提个醒] 异常回合提醒异常", { error: err?.message || err });
    }
  }

  // ─── 计划任务 / 巡检完成（接管自动完成通知） ───
  async _handleActivityUpdate(act) {
    try {
      let cfg = this._config.get();
      // 计划任务 / 巡检各用各的档位；计划任务另有总接管开关。
      const triggerKey = act.kind === "scheduled" ? "scheduledTrigger" : "patrolTrigger";
      let trigger = cfg[triggerKey] || "whenUnfocused";
      if (!cfg.enabled || trigger === "never") {
        dbgLog(this._dataDir, `活动通知拦截: ${triggerKey}=${trigger}`);
        return;
      }
      if (act.kind === "scheduled" && !cfg.scheduledTakeover) {
        dbgLog(this._dataDir, "活动通知拦截: 计划任务接管已关闭");
        return;
      }
      if (act.kind === "scheduled") {
        // 宿主 0.447.4 的顺序是 activity_update → 原版 completion notification；
        // 等待后再查一次，才能同时覆盖原版通知和任务自己调用的 notify。
        await new Promise((resolve) => setTimeout(resolve, ACTIVITY_NOTIFICATION_GRACE_MS));
        cfg = this._config.get();
        trigger = cfg[triggerKey] || "whenUnfocused";
        if (!cfg.enabled || trigger === "never" || !cfg.scheduledTakeover) {
          dbgLog(this._dataDir, `活动通知拦截: ${triggerKey}=${trigger} 或计划任务接管已关闭`);
          return;
        }
      }
      const activitySessionPath = act.kind === "scheduled"
        ? resolveActivitySessionPath(this._agentsHome, act.agentId, act.sessionFile)
        : "";
      if (act.kind === "scheduled" && this._activityNotifications.has(activitySessionPath)) {
        dbgLog(this._dataDir, `活动通知去重: 任务已有宿主通知 sessionFile=${act.sessionFile || "无"}`);
        return;
      }
      if (trigger === "whenUnfocused") {
        const focused = await isHanaFocused();
        if (focused) {
          dbgLog(this._dataDir, "活动通知拦截: HanaAgent 在前台");
          return;
        }
      }
      if (isInQuietHours(cfg)) {
        dbgLog(this._dataDir, `活动通知拦截: 静默时段`);
        return;
      }

      const kindLabel = act.kind === "scheduled" ? "计划任务" : "巡检";
      const statusLabel = act.status === "error" ? "失败" : "完成";
      const title = `${act.agentName} · ${kindLabel}${statusLabel}`;
      const body = act.label
        ? (act.status === "error" ? `${act.label} 执行失败` : `${act.label} 已完成`)
        : (act.summary || `${kindLabel}${statusLabel}`);

      // 头像 / 音效：跟随该助手（跟聊天通知一致）
      const avatar = resolveAgentAvatar(this._agentsHome, act.agentId);
      const soundCfg = (cfg.agentSounds || {})[act.agentId] || "default";
      let sound;
      if (soundCfg === "silent") {
        sound = "silent";
      } else if (soundCfg && soundCfg !== "default") {
        sound = resolveSound(this._dataDir, soundCfg, cfg.soundDir) || undefined;
      }

      sendToast({
        pluginDir: this._pluginDir,
        title,
        message: body,
        style: "icon", // 统一带头像（v0.3.1 拍板）
        icon: avatar || undefined,
        sound,
        duration: cfg.toastDuration,
        log: this._log
      });
      dbgLog(this._dataDir, `活动通知已弹: kind=${act.kind} status=${act.status} agent=${act.agentId}`);
    } catch (err) {
      dbgLog(this._dataDir, `活动通知异常: ${err?.stack || err?.message || err}`);
      this._log?.error?.("[提个醒] 活动通知异常", { error: err?.message || err });
    }
  }

  // ─── 核心：处理一条回合完成 ───
  async _handleTurnEnd(info) {
    try {
      // 只认最终回合：工具循环里的中间回合（stopReason=toolUse 等）不提醒；
      // stopReason 缺失时兼容处理；但含 toolCall 的事件仍是工具循环中间回合。
      if (!isFinalTurn(info.stopReason) || isIntermediateToolTurn(info)) {
        dbgLog(this._dataDir, `非最终回合跳过: stopReason=${info.stopReason} hasToolCall=${info.hasToolCall}`);
        return;
      }
      dbgLog(this._dataDir, `最终回合通过, textLen=${String(info.text).length}`);

      const now = Date.now();
      const { agentId, sessionId, text } = info;

      // 只提醒「用户真实参与的会话」：插件后台调度（如漂流瓶写瓶、小生活日常）也会产生
      // turn_end，但该会话从未有过 session_user_message（用户消息事件），弹了反而打扰（2026-08-17 反馈）
      if (!this._lastUserMsgAt.has(sessionId)) {
        dbgLog(this._dataDir, `无用户消息的会话跳过（后台调度）: sessionId=${sessionId}`);
        return;
      }
      if (this._backgroundTasks.has(sessionId)) {
        dbgLog(this._dataDir, `对话框仍有后台任务，完成回合暂不提醒: sessionId=${sessionId} remaining=${this._backgroundTasks.count(sessionId)}`);
        return;
      }

      // 每次事件前刷新配置（用户在设置页改过会即时生效）
      const cfg = this._config.get();
      // 刷新配置但保留 Notifier.sessions，否则每轮 turn_end 都会把合并窗口清空。
      this._notifier.config = cfg;
      dbgLog(this._dataDir, `配置: chatTrigger=${cfg.chatTrigger} enabled=${cfg.enabled} mergeWindowMs=${cfg.mergeWindowMs}`);

      // 提醒时机（聊天回复完成，跟原版通知四档一致；按助手覆盖优先）
      const chatTrigger = resolveChatTrigger(cfg, agentId);
      if (!cfg.enabled || chatTrigger === "never") {
        dbgLog(this._dataDir, `档位拦截: enabled=${cfg.enabled} chatTrigger=${chatTrigger} agent=${agentId}`);
        return;
      }
      if (chatTrigger === "always") {
        // 总是提醒，不做焦点/窗口判定
      } else if (chatTrigger === "whenUnfocused") {
        const focused = await isHanaFocused();
        if (focused) return; // HanaAgent 在前台，不打扰
      } else if (chatTrigger === "whenSessionUnfocused") {
        // 焦点不在该聊天时：该会话最近有用户消息 = 正在看 → 不提醒
        const lastUserAt = this._lastUserMsgAt.get(sessionId) || 0;
        if (now - lastUserAt < ACTIVE_WINDOW_MS) return;
      }

      const decision = this._notifier.decide(
        { sessionId, agentId, agentName: this._agentName(agentId), text, sessionPath: info.sessionPath },
        now
      );

      if (decision.action === "skip") {
        // 静默时段：不弹
        return;
      }

      if (decision.action === "merge") {
        this._scheduleFlush(sessionId, this._config.get().mergeWindowMs || 30000);
        return;
      }

      // toast(first / important)：立即弹
      await this._doToast(decision, now, cfg.toastStyle);      if (decision.kind === "first") {
        this._scheduleFlush(sessionId, this._config.get().mergeWindowMs || 30000);
      }

      dbgLog(this._dataDir, `已弹通知: kind=${decision.kind} agent=${agentId} snippetLen=${String(text).length}`);

      this._log?.info?.("[提个醒] 已提醒", {
        kind: decision.kind,
        agentId,
        snippetLen: String(text).length
      });
    } catch (err) {
      // 监听失败不能影响主流程
      dbgLog(this._dataDir, `处理回合完成异常: ${err?.stack || err?.message || err}`);
      this._log?.error?.("[提个醒] 处理回合完成异常", { error: err?.message || err });
    }
  }

  _scheduleFlush(sessionId, windowMs) {
    this._clearSessionTimer(sessionId);
    const t = setTimeout(async () => {
      this._timers.delete(sessionId);
      const result = this._notifier.flush(sessionId);
      if (result) {
        try { await this._doToast(result, Date.now(), this._config.get().toastStyle); } catch { /* 兜底 */ }
      }
    }, windowMs);
    this._timers.set(sessionId, t);
  }

  _clearSessionTimer(sessionId) {
    const t = this._timers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this._timers.delete(sessionId);
    }
  }

  _refineStoreCfg() {
    try {
      const f = path.join(this._dataDir, "refine-model.json");
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf-8")) : {};
    } catch { return {}; }
  }

  async _doToast(decision, now, toastStyle) {
    // 通知风格：按助手配置（default/plain/cheerful/gentle），只影响标题正文的包装
    const cfg = this._config.get();
    const styleId = (cfg.agentStyles || {})[decision.agentId] || "default";
    const style = getStyle(styleId);
    // 规则版先按无会话标题构建（标题查询挪到润色之后，给宿主异步起名留时间）
    let title = style.title(decision.kind, decision.agentName, decision.count, "");
    let body = style.body(decision.kind, decision.snippet, decision.count);

    // 文案润色（可选）：语气型风格 + 开关开启 → 模型改写标题正文；失败/超时自动降级规则版
    if (cfg.refineEnabled && style.refinable) {
      try {
        const refined = await refineTitleAndBody({
          mc: this._refineMc,
          agentName: decision.agentName,
          style,
          kind: decision.kind,
          snippet: decision.snippet,
          count: decision.count,
          sessionTitle: "",
          sessionPrefix,
          timeoutMs: 8000
        });
        title = refined.title;
        body = refined.body;
        dbgLog(this._dataDir, `润色成功: title=${title} body=${body}`);
      } catch (err) {
        dbgLog(this._dataDir, `润色失败降级规则版: ${err?.message || err}`);
      }
    }

    // 会话标题查询挪到润色之后（润色耗时正好给宿主异步起名留时间），查不到再补一次短重试
    const sessionTitle = await resolveSessionTitleWithRetry({
      bus: this.ctx.bus,
      agentsHome: this._agentsHome,
      agentId: decision.agentId,
      sessionPath: decision.sessionPath,
      sessionId: decision.sessionId
    });
    if (sessionTitle) {
      title = sessionPrefix(sessionTitle) + title;
    }

    // 头像：助手自己的头像（跟原版通知一致），找不到回退插件图标
    const avatar = resolveAgentAvatar(this._agentsHome, decision.agentId);

    // 音效：按助手分配（default/silent/自定义文件）；只影响本通知
    const soundCfg = (cfg.agentSounds || {})[decision.agentId] || "default";
    let sound;
    if (soundCfg === "silent") {
      sound = "silent";
    } else if (soundCfg && soundCfg !== "default") {
      sound = resolveSound(this._dataDir, soundCfg, cfg.soundDir) || undefined;
    }

    sendToast({
      pluginDir: this._pluginDir,
      title,
      message: body,
      style: toastStyle === "plain" ? "plain" : "icon",
      icon: avatar || undefined,
      sound,
      duration: cfg.toastDuration,
      log: this._log
    });
  }
}
