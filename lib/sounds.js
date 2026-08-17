// 提个醒 · 音效管理
// 用户把音效文件（wav/mp3/m4a/aac）放进音效目录，设置页可给每个助手指定音效。
// 音效目录 = 配置里的自定义目录（soundDir），留空则用插件数据目录 sounds/ 兜底。
// 只影响提个醒自己的通知，不动系统音效。
import fs from "node:fs";
import path from "node:path";

const ALLOWED_EXT = [".wav", ".mp3", ".m4a", ".aac"];

/**
 * 音效目录：优先用用户自定义的绝对路径（设置页可配），留空回退插件数据目录 sounds/。
 * @param {string} dataDir 插件数据目录（自定义目录为空时的默认根）
 * @param {string} [customDir] 用户配置的音效文件夹绝对路径，空/非法回退默认
 */
export function soundsDir(dataDir, customDir) {
  const dir = customDir && typeof customDir === "string" && customDir.trim()
    ? path.resolve(customDir.trim())
    : path.join(dataDir, "sounds");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录创建失败时返回路径，读取侧自行兜底 */
  }
  return dir;
}

/** 列出音效目录里的音频文件（按文件名排序） */
export function listSounds(dataDir, customDir) {
  try {
    return fs
      .readdirSync(soundsDir(dataDir, customDir))
      .filter((f) => ALLOWED_EXT.includes(path.extname(f).toLowerCase()))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 把设置里的文件名解析成绝对路径（安全校验：防路径穿越 + 白名单扩展名）。
 * @returns {string|null} 文件不存在或非法返回 null
 */
export function resolveSound(dataDir, fileName, customDir) {
  if (!fileName || typeof fileName !== "string") return null;
  const base = path.basename(fileName);
  if (base !== fileName) return null; // 含路径分隔符 → 拒绝
  if (!ALLOWED_EXT.includes(path.extname(base).toLowerCase())) return null;
  const fp = path.join(soundsDir(dataDir, customDir), base);
  return fs.existsSync(fp) ? fp : null;
}
