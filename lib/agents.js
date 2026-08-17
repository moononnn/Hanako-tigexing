// 提个醒 · 助手列表（磁盘读取版）
// routes 层没有 bus，直接从 agents 目录扫 id + config.yaml 的 name 字段。
// 仅用于设置页「给每个助手配音效」的列表展示。
import fs from "node:fs";
import path from "node:path";

/**
 * 列出 Hana 助手（id + 显示名）。
 * @param {string} agentsHome Hana agents 目录（如 ~/.hanako/agents）
 * @returns {Array<{id:string, name:string}>}
 */
export function listAgentsFromDisk(agentsHome) {
  try {
    return fs
      .readdirSync(agentsHome, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const id = d.name;
        const name = readAgentName(path.join(agentsHome, id));
        return { id, name: name || id };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

/** 从 agent 目录的 config.yaml 读 name 字段（轻量正则，不引 YAML 依赖） */
function readAgentName(agentDir) {
  try {
    const cfgPath = path.join(agentDir, "config.yaml");
    if (!fs.existsSync(cfgPath)) return null;
    const text = fs.readFileSync(cfgPath, "utf-8");
    const m = text.match(/^\s*name:\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
  } catch {
    /* 读不到返回 null */
  }
  return null;
}
