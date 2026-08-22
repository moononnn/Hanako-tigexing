// 提个醒 · 异常回合文案
// 异常通知必须让人一眼知道发生了什么、下一步该说什么；不把底层错误原文直接塞进弹窗。

import { clip, sessionPrefix } from "./style.js";

/** 判断是否是用户主动取消重试；这种情况不需要再提醒一次。 */
export function isRetryCancelled(errorMessage) {
  const text = String(errorMessage || "").trim().toLowerCase();
  return /retry\s+cancelled|retry\s+canceled|\bcancelled\b|\bcanceled\b|\baborted\b/.test(text);
}

/** 把底层错误归纳成用户能直接看懂的短句。 */
export function failureReasonLabel(errorMessage) {
  const text = String(errorMessage || "").trim().toLowerCase();
  if (/websocket|fetch failed|network|socket|connect|timeout|timed out/.test(text)) {
    return "模型连接断了";
  }
  if (/401|403|api[ _-]?key|credential|unauthori|forbidden|auth/.test(text)) {
    return "模型凭据没通过";
  }
  if (/429|rate.?limit|overload|too busy|busy/.test(text)) {
    return "模型暂时忙";
  }
  return "模型请求没完成";
}

/**
 * 构造异常通知的规则版标题和正文。
 * partialText 会保留一小段已经收到的助手内容，避免只弹一个冷冰冰的错误码。
 */
export function buildAbnormalCopy({
  kind = "failure",
  agentName = "助手",
  sessionTitle = "",
  partialText = "",
  errorMessage = "",
  recentErrors = 0,
  totalChecked = 0
} = {}) {
  const prefix = sessionPrefix(sessionTitle);
  const name = String(agentName || "助手").trim() || "助手";

  if (kind === "unhealthy") {
    const count = Number.isFinite(Number(recentErrors)) && Number.isFinite(Number(totalChecked))
      && Number(totalChecked) > 0
      ? `（近 ${Number(recentErrors)}/${Number(totalChecked)} 次失败）`
      : "";
    return {
      title: `${prefix}${name} · 对话状态不稳`,
      body: `这个对话连续失败${count}，建议新开对话`
    };
  }

  const partial = clip(partialText, 12);
  const body = partial
    ? `收到「${partial}」；说“继续”再试`
    : `${failureReasonLabel(errorMessage)}，说“继续”再试`;
  return {
    title: `${prefix}${name} · 这轮没接上`,
    body
  };
}
