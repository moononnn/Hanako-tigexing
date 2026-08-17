// 提个醒 · 会话标题读取
// 标题来源：agents/<agentId>/sessions/session-titles.json（宿主维护的 路径/sessionId → 标题 映射）
// 匹配规则与宿主 _sessionTitleFromMap 一致：依次试 sessionId、完整路径、文件名；
// 路径分隔符做归一化（\ 与 / 混用也能命中）。
// 纯读文件，零依赖；读不到返回 null（调用方回退旧标题格式）。

import path from "node:path";
import fs from "node:fs";

function normalizePath(p) {
  return String(p || "").replace(/\\/g, "/");
}

/** 读会话标题映射文件；读不到或损坏返回空对象 */
export function loadSessionTitles(agentsHome, agentId) {
  try {
    const file = path.join(agentsHome, agentId, "sessions", "session-titles.json");
    if (!fs.existsSync(file)) return {};
    const obj = JSON.parse(fs.readFileSync(file, "utf-8"));
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

/** 按宿主匹配规则找标题：依次试 sessionId、完整路径、文件名 */
export function findSessionTitle(map, sessionPath, sessionId) {
  if (!map) return null;
  const keys = [];
  if (sessionId) keys.push(String(sessionId));
  if (sessionPath) {
    keys.push(normalizePath(sessionPath));
    keys.push(path.basename(sessionPath));
  }
  for (const k of keys) {
    const v = map[k];
    if (v && typeof v === "string" && v.trim()) return v.trim();
  }
  // 键也归一化后再试一次（防御 key 与查询路径分隔符不一致）
  if (sessionPath) {
    const norm = normalizePath(sessionPath);
    for (const k of Object.keys(map)) {
      if (normalizePath(k) === norm && map[k] && typeof map[k] === "string") {
        return map[k].trim();
      }
    }
  }
  return null;
}

/** 取会话标题；读不到返回 null */
export function getSessionTitle(agentsHome, agentId, sessionPath, sessionId) {
  if (!agentsHome || !agentId) return null;
  const map = loadSessionTitles(agentsHome, agentId);
  return findSessionTitle(map, sessionPath, sessionId);
}

/**
 * 解析会话标题（真实通知用）：优先走宿主官方接口 session:get-titles
 * （宿主内部维护 sess_ sessionId ↔ 路径映射 + TTL 缓存，session-titles.json 新会话只有 sess_ key，
 *   直接读文件会匹配不到——2026-08-16 实机踩坑）；失败/超时回退文件版（老会话路径 key 能命中）。
 * @param {object} opts { bus, agentsHome, agentId, sessionPath, sessionId }
 * @returns {string|null}
 */
export async function resolveSessionTitle({ bus, agentsHome, agentId, sessionPath, sessionId }) {
  if (bus?.request && sessionPath) {
    try {
      const res = await bus.request("session:get-titles", { paths: [sessionPath] }, { timeoutMs: 800 });
      const title = res?.titles?.[sessionPath];
      if (title && typeof title === "string" && title.trim()) return title.trim();
    } catch {
      /* 接口不可用/超时 → 回退文件版 */
    }
  }
  return getSessionTitle(agentsHome, agentId, sessionPath, sessionId);
}
