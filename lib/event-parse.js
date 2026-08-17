// 提个醒 · 事件解析（纯逻辑，可单元测试）
// 从 bus 广播的事件里解析「回复完成」信息。
// 事件源：bus.subscribe 全量订阅，过滤 type === "turn_end"（实测 2026-08-16 有效）。
// 结构（探针实测）：
//   turn_end: { type, message: { role, content: [...], ... }, toolResults, agentId }
//   sessionPath: bus 回调第二参数（如 .../agents/hanako/sessions/<id>.jsonl）

/**
 * 从 turn_end 事件解析回复完成信息。
 * @param {object} event bus 事件对象
 * @param {string|null} sessionPath bus 回调第二参数（作用域会话路径）
 * @returns {{ agentId:string, sessionId:string, text:string, stopReason:string|null, sessionPath:string|null } | null}
 */
export function parseTurnEnd(event, sessionPath) {
  if (!event || typeof event !== "object" || event.type !== "turn_end") return null;
  const agentId = String(event.agentId || "unknown");
  const sessionId = sessionIdFromPath(sessionPath) || "unknown";
  const text = extractAssistantText(event.message);
  const stopReason =
    event.message && typeof event.message === "object" ? event.message.stopReason || null : null;
  return { agentId, sessionId, text, stopReason, sessionPath: sessionPath || null };
}

/** 从会话文件路径提取 sessionId（文件名去 .jsonl） */
export function sessionIdFromPath(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return "";
  const base = String(sessionPath).split(/[\\/]/).pop() || "";
  return base.replace(/\.jsonl$/i, "");
}

/**
 * 是否最终回合（该弹通知的那一次）。
 * agent 一次回复里会有多个 turn_end：工具循环中间轮 stopReason=toolUse 等，
 * 最终轮 stopReason=stop。缺失时兼容处理（老事件可能没字段）。
 */
export function isFinalTurn(stopReason) {
  return !stopReason || stopReason === "stop";
}

/**
 * 清洗回复文本里的元信息块（不展示给用户的内容）。
 * 兼容两种写法：<mood>…</mood>（尖括号）与 [mood]…</mood>（方括号开头，DSv4 实测会出现混搭），
 * 顺带处理「开头有 mood 但未闭合」的截断残留。
 */
export function stripMetaBlocks(text) {
  let t = String(text || "");
  // 完整块：连同周围空白替换为单空格（防残留双空格/空行）
  t = t.replace(/\s*(?:<mood>|\[mood\])[\s\S]*?(?:<\/mood>|\[\/mood\])\s*/gi, " ");
  if (/^\s*(?:<mood>|\[mood\])/i.test(t)) t = t.replace(/^\s*(?:<mood>|\[mood\])[\s\S]*$/i, "");
  return t.trim();
}

/**
 * 从 assistant 消息里提取可展示的文本。
 * 规则：type=text 的 text 拼接（先滤掉 <mood> 元信息块）；type=toolCall 记一句「调用了 xxx」；
 * thinking 不进通知。没有可展示内容返回空串（由调用方兜底）。
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
 * 从 activity_update 事件解析「计划任务 / 巡检完成」信息（接管 Hana 原版两项通知）。
 * 事件源（server bundle 源码确认）：
 *   计划任务（cron）和巡检（heartbeat）执行结束后广播：
 *   eventBus.emit({ type: "activity_update", activity: I }, null)
 *   activity: { id, type: "cron"|"heartbeat", label, agentId, agentName,
 *               summary, status: "done"|"error", error, sessionFile }
 * @param {object} event bus 事件对象
 * @returns {{ kind:"scheduled"|"patrol", agentId:string, agentName:string, label:string, summary:string, status:"done"|"error" } | null}
 */
export function parseActivityUpdate(event) {
  if (!event || typeof event !== "object" || event.type !== "activity_update") return null;
  const a = event.activity;
  if (!a || typeof a !== "object") return null;
  const type = String(a.type || "");
  if (type !== "cron" && type !== "heartbeat") return null;
  return {
    kind: type === "cron" ? "scheduled" : "patrol",
    agentId: String(a.agentId || "unknown"),
    agentName: String(a.agentName || a.agentId || "HanaAgent"),
    label: String(a.label || ""),
    summary: String(a.summary || ""),
    status: a.status === "error" ? "error" : "done"
  };
}
