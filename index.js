// 提个醒 · 主入口（lifecycle 插件）
// 小喇叭的耳朵——订阅 bus 事件流，监听「回合完成」（turn_end），
// 按策略弹 Windows toast。
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

import { Notifier, isInQuietHours } from "./lib/policy.js";
import { createConfigManager } from "./lib/config.js";
import { sendToast } from "./lib/toast.js";
import { parseTurnEnd, parseActivityUpdate, isFinalTurn } from "./lib/event-parse.js";
import { resolveAgentAvatar } from "./lib/agent-avatar.js";
import { isHanaFocused } from "./lib/window-focus.js";
import { resolveSound } from "./lib/sounds.js";
import { resolveSessionTitle } from "./lib/session-title.js";
import { getStyle, sessionPrefix } from "./lib/style.js";
import { ModelConfig } from "./lib/model-config/index.js";
import { refineTitleAndBody } from "./lib/refine.js";
import { setupExtraStyles } from "./lib/dialect-links.js";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
// 「当前窗口」判定阈值：该会话最近 X 毫秒内有用户消息 → 认为是正在看的窗口
const ACTIVE_WINDOW_MS = 120 * 1000;

// 调试日志（排查用，写插件数据目录，不进发布包）
function dbgLog(dataDir, line) {
  try {
    fs.appendFileSync(path.join(dataDir, "tigexing", "debug.log"), `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* 日志失败不影响主流程 */ }
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
          const noisy = et === "message_update" || et === "llm_usage" || et === "resource.changed" || et === "bridge_status" || et === "message_start" || et === "tool_execution_update" || et === "session_status" || et === "agent_start";
          if (!noisy) dbgLog(this._dataDir, `事件 ${et} path=${scopedSessionPath || "无"}`);
          // 1) 用户消息：记下会话的最后活跃时间（用于「当前窗口」判定）
          if (event?.type === "session_user_message") {
            const sid = scopedSessionPath ? scopedSessionPath.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, "") : null;
            if (sid) this._lastUserMsgAt.set(sid, Date.now());
            return;
          }
          // 1.5) 计划任务 / 巡检完成（接管 Hana 原版两项通知）
          const act = parseActivityUpdate(event);
          if (act) {
            this._handleActivityUpdate(act);
            return;
          }
          // 2) 回合完成
          const info = parseTurnEnd(event, scopedSessionPath);
          if (!info) return;
          dbgLog(this._dataDir, `解析到 turn_end: agent=${info.agentId} stopReason=${info.stopReason} textLen=${String(info.text).length}`);
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
  }

  async onunload() {
    if (this._off) this._off();
    for (const [sid, t] of this._timers) {
      clearTimeout(t);
      this._timers.delete(sid);
    }
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

  // ─── 计划任务 / 巡检完成（接管 Hana 原版两项通知） ───
  async _handleActivityUpdate(act) {
    try {
      const cfg = this._config.get();
      // 计划任务 / 巡检完成（接管 Hana 原版两项通知）：各用各的档位（跟原版一致）
      const triggerKey = act.kind === "scheduled" ? "scheduledTrigger" : "patrolTrigger";
      const trigger = cfg[triggerKey] || "whenUnfocused";
      if (!cfg.enabled || trigger === "never") {
        dbgLog(this._dataDir, `活动通知拦截: ${triggerKey}=${trigger}`);
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
      // stopReason 缺失时兼容处理（老版本事件可能没有该字段）
      if (!isFinalTurn(info.stopReason)) {
        dbgLog(this._dataDir, `非最终回合跳过: stopReason=${info.stopReason}`);
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

      // 每次事件前刷新配置（用户在设置页改过会即时生效）
      const cfg = this._config.get();
      this._notifier = new Notifier(cfg);
      dbgLog(this._dataDir, `配置: chatTrigger=${cfg.chatTrigger} enabled=${cfg.enabled} mergeWindowMs=${cfg.mergeWindowMs}`);

      // 提醒时机（聊天回复完成，跟原版通知四档一致）
      if (!cfg.enabled || cfg.chatTrigger === "never") {
        dbgLog(this._dataDir, `档位拦截: enabled=${cfg.enabled} chatTrigger=${cfg.chatTrigger}`);
        return;
      }
      if (cfg.chatTrigger === "always") {
        // 总是提醒，不做焦点/窗口判定
      } else if (cfg.chatTrigger === "whenUnfocused") {
        const focused = await isHanaFocused();
        if (focused) return; // HanaAgent 在前台，不打扰
      } else if (cfg.chatTrigger === "whenSessionUnfocused") {
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
    // 标题带会话标题（痛点：多窗口时不知道哪个对话框回复完了）；走宿主接口解析 sess_ 映射，失败回退文件版
    const sessionTitle = await resolveSessionTitle({
      bus: this.ctx.bus,
      agentsHome: this._agentsHome,
      agentId: decision.agentId,
      sessionPath: decision.sessionPath,
      sessionId: decision.sessionId
    });
    let title = style.title(decision.kind, decision.agentName, decision.count, sessionTitle);
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
          sessionTitle,
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
      log: this._log
    });
  }
}
