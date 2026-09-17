// 提个醒 · 事件解析（纯逻辑，可单元测试）
// 从 bus 广播的事件里解析正常回复和异常回合信息。
// 事件源：bus.subscribe 全量订阅；正常通知看 turn_end，异常路径补看
// error / auto_retry_start / auto_retry_end / session_status / session_unhealthy_warning。
// sessionPath：bus 回调第二参数（如 .../agents/hanako/sessions/<id>.jsonl）。

/**
 * 从 turn_end 事件解析回复完成信息。
 * @param {object} event bus 事件对象
 * @param {string|null} sessionPath bus 回调第二参数（作用域会话路径）
 * @returns {{ agentId:string, sessionId:string, text:string, stopReason:string|null, aborted:boolean, reason:string, wasSuccessful:boolean|null, sessionPath:string|null } | null}
 */
export function parseTurnEnd(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "turn_end") return null;
  const agentId = String(event.agentId || agentIdFromSessionPath(sessionPath) || "unknown");
  const sessionId = sessionIdFromPath(sessionPath) || "unknown";
  const text = extractAssistantText(event.message);
  const content = event.message && typeof event.message === "object" && Array.isArray(event.message.content)
    ? event.message.content
    : [];
  const hasToolCall = content.some((part) => part && typeof part === "object" && part.type === "toolCall");
  const stopReason =
    event.message && typeof event.message === "object" ? event.message.stopReason || null : null;
  return {
    agentId,
    sessionId,
    text,
    hasToolCall,
    stopReason,
    aborted: event.aborted === true,
    reason: String(event.reason || "").trim(),
    wasSuccessful: typeof event.wasSuccessful === "boolean" ? event.wasSuccessful : null,
    sessionPath: sessionPath || null
  };
}

/** 从会话文件路径提取 sessionId（文件名去 .jsonl） */
export function sessionIdFromPath(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return "";
  const base = String(sessionPath).split(/[\\\\\\/]/).pop() || "";
  return base.replace(/\.jsonl$/i, "");
}

/** 从 .../agents/<agentId>/sessions/<session>.jsonl 路径提取 agentId。 */
export function agentIdFromSessionPath(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return "";
  const match = String(sessionPath).match(/[\\\\\\/]agents[\\\\\\/]([^\\\\\\/]+)[\\\\\\/]sessions[\\\\\\/]/i);
  return match ? match[1] : "";
}

function messageError(message) {
  if (!message || typeof message !== "object") return "";
  return String(message.errorMessage || message.error || "").trim();
}

const USER_ABORT_REASONS = new Set(["abort", "abort_all", "close", "close_all", "user_abort", "user_cancel"]);

/** 用户明确停止/关闭时不把控制动作报成故障。 */
export function isUserInitiatedAbortReason(reason) {
  return USER_ABORT_REASONS.has(String(reason || "").trim().toLowerCase());
}

/** 解析失败回合，供异常提醒状态机记录部分正文。 */
export function parseTurnFailure(event, sessionPath) {
  const info = parseTurnEnd(event, sessionPath);
  if (!info) return null;
  const errorMessage = messageError(event.message) || String(event.errorMessage || event.error || "").trim();
  const abnormalAbort = info.aborted && !isUserInitiatedAbortReason(info.reason);
  const failedByStatus = info.wasSuccessful === false && !isIntermediateToolTurn(info);
  if (info.stopReason !== "error" && !abnormalAbort && !failedByStatus) return null;
  return {
    ...info,
    errorMessage: errorMessage || info.reason
  };
}

/** provider 错误事件兜底；通常后面还会跟着 turn_end/error。 */
export function parseProviderError(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "error") return null;
  const errorMessage = String(event.message || event.errorMessage || event.error || "").trim();
  if (!errorMessage) return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || "unknown"),
    sessionId: sessionIdFromPath(sessionPath) || "unknown",
    sessionPath: sessionPath || null,
    text: "",
    errorMessage
  };
}

/** session_status 的强制释放兜底；turn_end 通常会先到，但不依赖时序。 */
export function parseSessionAbort(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "session_status") return null;
  if (event.isStreaming !== false || event.aborted !== true) return null;
  const reason = String(event.reason || "").trim();
  if (isUserInitiatedAbortReason(reason)) return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || "unknown"),
    sessionId: sessionIdFromPath(sessionPath) || "unknown",
    sessionPath: sessionPath || null,
    text: "",
    aborted: true,
    reason,
    errorMessage: reason || "会话被提前释放"
  };
}

/** 宿主开始自动重试；这里只传状态，不发通知。 */
export function parseAutoRetryStart(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "auto_retry_start") return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || "unknown"),
    sessionId: sessionIdFromPath(sessionPath) || "unknown",
    sessionPath: sessionPath || null,
    attempt: Number(event.attempt) || 0,
    maxAttempts: Number(event.maxAttempts) || 0,
    errorMessage: String(event.errorMessage || "").trim()
  };
}

/** 宿主自动重试结束；只有 success=false 才是异常提醒候选。 */
export function parseAutoRetryEnd(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "auto_retry_end") return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || "unknown"),
    sessionId: sessionIdFromPath(sessionPath) || "unknown",
    sessionPath: sessionPath || null,
    success: event.success === true,
    attempt: Number(event.attempt) || 0,
    finalError: String(event.finalError || event.errorMessage || "").trim()
  };
}

/** 会话恢复时的连续失败警告。 */
export function parseSessionUnhealthyWarning(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "session_unhealthy_warning") return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || "unknown"),
    sessionId: sessionIdFromPath(sessionPath) || "unknown",
    sessionPath: sessionPath || null,
    recentErrors: Number(event.recentErrors) || 0,
    totalChecked: Number(event.totalChecked) || 0
  };
}

/**
 * 是否最终回合（该弹通知的那一次）。
 * agent 一次回复里会有多个 turn_end：工具循环中间轮 stopReason=toolUse 等，
 * 最终轮 stopReason=stop。缺失时兼容处理（老事件可能没字段）。
 */
export function isFinalTurn(stopReason) {
  return !stopReason || stopReason === "stop";
}

/** 工具循环中的中间回合：有明确 toolUse，或旧事件缺 stopReason 但带 toolCall。 */
export function isIntermediateToolTurn(info) {
  return info?.stopReason === "toolUse"
    || (info?.stopReason == null && info?.hasToolCall === true);
}

/**
 * 思考 / 元信息块标签正则（纯逻辑，可单测）。
 * 注意：反引号 U+0060 用 hex escape 写出，源码里没有真实反引号字符，
 * 避免被工具输入端 normalize 成 XML 形式。JS runtime 解析时 hex escape
 * 会解为真实字符参与正则匹配。
 */
const MOOD_OPEN = "(?:<mood>|\\[mood\\])";
// 4 种思考标签并行：反引号类 3 种 + XML 类 1 种
const THINK_OPEN_PARTS = ["\x60think\x3e", "\x60think\x3e", "\x60think\x3e", "<thinking>"];
const THINK_CLOSE_PARTS = ["\x60\x2fthink\x3e", "\x60\x2fthink\x3e", "\x60\x2fthink\x3e", "</thinking>"];
const THINK_OPEN = THINK_OPEN_PARTS.join("|");
const THINK_CLOSE = THINK_CLOSE_PARTS.join("|");

/**
 * 清洗回复文本里的思考 / 元信息块（不展示给用户的内容）。
 * 兼容六种写法：
 *   - <mood>...</mood>          （标准尖括号）
 *   - [mood]...[/mood]          （方括号，DSv4 实测会出现混搭）
 *   - `think>...`/think>        （MiniMax-M3 默认思考块，闭标签带斜杠）
 *   - `think>...`think>         （DS 系，闭标签无斜杠）
 *   - `think>...`/think>        （部分 prompt 注入样式）
 *   - <thinking>...</thinking>  （Anthropic / 通用 XML，闭标签有斜杠）
 * 顺带处理「开头有 mood / think 块但未闭合」的截断残留，避免尾巴漏到通知文案里。
 */
export function stripMetaBlocks(text) {
  let t = String(text || "");
  // 1) mood 完整块：连同周围空白替换为单空格（防残留双空格 / 空行）
  t = t.replace(
    new RegExp(`\\s?(?:${MOOD_OPEN})[\\s\\S]*?(?:<\\/mood>|\\[\\/mood\\])\\s?`, "gi"),
    ""
  );
  // 2) mood 开头未闭合（被截断）的残留：从开头到末尾整段清掉
  if (new RegExp(`^\\s*(?:${MOOD_OPEN})`, "i").test(t)) {
    t = t.replace(new RegExp(`^\\s*(?:${MOOD_OPEN})[\\s\\S]*$`, "i"), "");
  }

  // 3) 思考链块（深度思考 / CoT）：反引号类与 XML 类并行匹配
  t = t.replace(
    new RegExp(`\\s?(?:${THINK_OPEN})[\\s\\S]*?(?:${THINK_CLOSE})\\s?`, "gi"),
    ""
  );
  // 4) think 块开头未闭合（被截断）的残留：从开头到末尾整段清掉
  if (new RegExp(`^\\s*(?:${THINK_OPEN})`, "i").test(t)) {
    t = t.replace(new RegExp(`^\\s*(?:${THINK_OPEN})[\\s\\S]*$`, "i"), "");
  }

  return t.trim();
}

/**
 * 从 assistant 消息里提取可展示的文本。
 * 规则：type=text 的 text 拼接（先滤掉元信息块）；type=toolCall 记一句「调用了 xxx」；
 * type=thinking 的独立部分不进通知；嵌套在 text part 里的思考标签被 stripMetaBlocks 剥离。
 * 没有可展示内容返回空串（由调用方兜底）。
 * @param {object} message assistant 消息（turn_end 的 message 字段）
 * @returns {string}
 */
export function extractAssistantText(message) {
  if (!message || typeof message !== "object") return "";
  const content = Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
      parts.push(c.text.trim());
    } else if (c.type === "toolCall" && typeof c.name === "string" && c.name) {
      parts.push(`[调用了 ${c.name}]`);
    }
  }
  return stripMetaBlocks(parts.join("\n"));
}

/**
 * 解析对话框里的后台任务（如子 agent）状态。
 * 任务 upsert 到 remove 之间，主对话框的完成通知必须保持静默。
 */
export function parseSessionBackgroundTask(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "session_background_task") return null;
  const action = event.action === "upsert" || event.action === "remove" ? event.action : "";
  const taskId = String(event.taskId || "").trim();
  const resolvedPath = typeof sessionPath === "string" && sessionPath
    ? sessionPath
    : (typeof event.sessionPath === "string" ? event.sessionPath : "");
  // turn_end 使用会话文件名作为键；后台任务事件的逻辑 sessionId 可能不同，统一优先采用路径键。
  const sessionId = String(sessionIdFromPath(resolvedPath) || event.sessionId || "").trim();
  if (!action || !taskId || !sessionId) return null;
  const task = event.task && typeof event.task === "object" ? event.task : null;
  return {
    action,
    taskId,
    sessionId,
    sessionPath: resolvedPath || null,
    status: typeof task?.status === "string" ? task.status : ""
  };
}

/**
 * 从 activity_update 事件解析「计划任务 / 巡检完成」信息，并保留活动 sessionFile 供通知去重。
 * 事件源（server bundle 源码确认）：
 *   计划任务（cron）和巡检（heartbeat）执行结束后广播：
 *   eventBus.emit({ type: "activity_update", activity: I }, null)
 *   activity: { id, type: "cron"|"heartbeat", label, agentId, agentName,
 *               summary, status: "done"|"error", error, sessionFile }
 * @param {object} event bus 事件对象
 * @returns {{ id:string, kind:"scheduled"|"patrol", agentId:string, agentName:string, label:string, summary:string, status:"done"|"error", sessionFile:string } | null}
 */
export function parseActivityUpdate(event) {
  if (!event || typeof event !== "object" || event.type !== "activity_update") return null;
  const a = event.activity;
  if (!a || typeof a !== "object") return null;
  const type = String(a.type || "");
  if (type !== "cron" && type !== "heartbeat") return null;
  return {
    id: String(a.id || ""),
    kind: type === "cron" ? "scheduled" : "patrol",
    agentId: String(a.agentId || "unknown"),
    agentName: String(a.agentName || a.agentId || "HanaAgent"),
    label: String(a.label || ""),
    summary: String(a.summary || ""),
    status: a.status === "error" ? "error" : "done",
    sessionFile: String(a.sessionFile || "")
  };
}
