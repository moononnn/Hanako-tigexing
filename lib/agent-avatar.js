// 提个醒 · 助手头像解析
// 头像跟随 Hana 的助手配置：{HANA_HOME}/agents/<agentId>/avatars/ 下找图片
// （与 Hana 原版通知一致：谁回你，就显示谁的头像）
import fs from "node:fs";
import path from "node:path";

const EXT_ORDER = ["png", "jpg", "jpeg", "webp"];

/**
 * 解析助手头像文件路径。
 * @param {string} agentsHome Hana agents 目录（如 ~/.hanako/agents）
 * @param {string} agentId 助手 id（如 hanako）
 * @returns {string|null} 头像绝对路径，找不到返回 null
 */
export function resolveAgentAvatar(agentsHome, agentId) {
  if (!agentsHome || !agentId) return null;
  const avatarsDir = path.join(agentsHome, agentId, "avatars");
  try {
    if (!fs.existsSync(avatarsDir)) return null;
    const files = fs.readdirSync(avatarsDir);
    for (const ext of EXT_ORDER) {
      const hit = files.find((f) => f.toLowerCase().endsWith("." + ext));
      if (hit) return path.join(avatarsDir, hit);
    }
  } catch {
    /* 目录不可读返回 null */
  }
  return null;
}
