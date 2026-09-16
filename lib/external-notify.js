// 提个醒 · 对外弹窗接口核心（纯逻辑，可单元测试）
// 供其他插件（如模型自动降级提醒）经 Hana 主 API 代理调用：
//   POST /api/plugins/tigexing/api/external/notify
// 这里只做「要不要弹、按什么弹」的决策，route 层负责真正 sendToast。
// 复用提个醒现有配置：总开关、静默时段、按助手音效/头像、通知时长、通知视觉样式。

import { isInQuietHours } from "./policy.js";

/**
 * 请求体校验（只收 title/message 必填）。
 * @returns {{ok:true,title:string,message:string}|{ok:false,error:string}}
 */
export function validateExternalNotify(body) {
  const title = String(body?.title ?? "").trim();
  const message = String(body?.message ?? "").trim();
  if (!title || !message) {
    return { ok: false, error: "title and message are required" };
  }
  return { ok: true, title, message };
}

/**
 * 按请求与配置决策：弹 / 被静默。
 * @param {object} req { title, message, agentId?, style?, sound?, duration? }
 * @param {object} cfg 提个醒配置（configManager.get()）
 * @param {object} helpers { resolveSoundFile(file)->string|null, resolveAgentAvatar(agentId)->string|null }
 * @param {Date} [now] 测试用：注入当前时间判定静默时段；缺省用真实时间
 * @returns {object}
 *   { action:"suppressed", reason:"disabled"|"quiet" }  静默时段/总开关关闭，不弹
 *   { action:"send", toast:{...}, meta:{ style } }      按解析好的参数弹
 */
export function planExternalNotify(req, cfg, helpers, now) {
  if (!cfg.enabled) return { action: "suppressed", reason: "disabled" };
  if (isInQuietHours(cfg, now)) return { action: "suppressed", reason: "quiet" };

  const agentId = String(req.agentId ?? "").trim();

  // 视觉样式：icon / plain（同设置页 toastStyle），非法忽略回退配置
  const rawStyle = String(req.style ?? "").trim();
  const toastStyle = rawStyle === "plain" || rawStyle === "icon"
    ? rawStyle
    : cfg.toastStyle === "plain" ? "plain" : "icon";

  // 音效：显式 silent / 显式文件名（只收存在的）/ 未指定按该助手配置
  const rawSound = String(req.sound ?? "").trim();
  let sound;
  if (rawSound === "silent") {
    sound = "silent";
  } else if (rawSound) {
    sound = helpers.resolveSoundFile(rawSound) || undefined;
  } else {
    const agentSound = (cfg.agentSounds || {})[agentId] || "default";
    if (agentSound === "silent") {
      sound = "silent";
    } else if (agentSound && agentSound !== "default") {
      sound = helpers.resolveSoundFile(agentSound) || undefined;
    }
  }

  // 时长：显式 long / 否则跟随全局配置
  const duration = String(req.duration ?? "").trim() === "long" ? "long" : cfg.toastDuration;

  // 头像：按该助手的头像（找不到回退插件图标），不传 agentId 则不带头像
  const icon = agentId ? helpers.resolveAgentAvatar(agentId) || undefined : undefined;

  return {
    action: "send",
    toast: {
      title: req.title,
      message: req.message,
      style: toastStyle,
      icon,
      sound,
      duration
    },
    meta: { style: toastStyle }
  };
}
