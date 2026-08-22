// 提个醒 · 活跃回合追踪（turn-trace）
// 目的：Hana 进程被杀/崩溃重启时，把「没走完的回合」补提醒给用户——对话框断了，需要知道。
// 机制：
//   - markActive(sessionId, ...)：用户消息到达时写入磁盘（标记「该会话有回合在进行」）
//   - clearActive(sessionId)：回合正常结束（回复完成 / 异常已提醒 / 用户主动停止）时擦除
//   - markCleanShutdown()：Hana 正常退出时调用（onunload），清空并标记干净退出
//   - readInterrupted()：重启后读取「非干净退出 + 未走完」的会话（补弹候选）
//   - reset()：补弹完成后清空，开始新一轮追踪
// 关键语义：cleanShutdown=false + sessions 有残留 = 上次进程非正常终止且有回合被打断。

import fs from "node:fs";
import path from "node:path";

export function traceFilePath(dataDir) {
  return path.join(dataDir, "tigexing", "turn-trace.json");
}

function load(file) {
  try {
    if (!fs.existsSync(file)) return { cleanShutdown: true, sessions: {} };
    const obj = JSON.parse(fs.readFileSync(file, "utf-8"));
    return {
      cleanShutdown: obj?.cleanShutdown !== false,
      sessions: obj?.sessions && typeof obj.sessions === "object" ? obj.sessions : {}
    };
  } catch {
    return { cleanShutdown: true, sessions: {} };
  }
}

function save(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch { /* 记录失败不影响主流程 */ }
}

export class TurnTrace {
  constructor({ dataDir }) {
    this._file = traceFilePath(dataDir);
  }

  /** 用户消息到达：标记该会话有活跃回合；有活跃回合时退出 = 非干净退出。 */
  markActive(sessionId, { agentId, sessionPath } = {}) {
    const id = String(sessionId || "").trim();
    if (!id || id === "unknown") return;
    const data = load(this._file);
    data.cleanShutdown = false;
    data.sessions[id] = {
      sessionId: id,
      agentId: String(agentId || "unknown"),
      sessionPath: String(sessionPath || ""),
      ts: Date.now()
    };
    save(this._file, data);
  }

  /** 回合正常结束：擦除该会话记录。 */
  clearActive(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id) return;
    const data = load(this._file);
    if (data.sessions[id]) {
      delete data.sessions[id];
      save(this._file, data);
    }
  }

  /** Hana 正常退出（onunload）：清空并标记干净退出，重启后不补弹。 */
  markCleanShutdown() {
    save(this._file, { cleanShutdown: true, sessions: {} });
  }

  /** 重启后读取补弹候选：非干净退出 + 有残留 + 最近 maxAgeMs 内。 */
  readInterrupted({ maxAgeMs = 6 * 3600 * 1000 } = {}) {
    const data = load(this._file);
    if (data.cleanShutdown) return [];
    const now = Date.now();
    return Object.values(data.sessions).filter(
      (s) => s && s.sessionId && now - Number(s.ts || 0) <= maxAgeMs
    );
  }

  /** 补弹完成后清空，开始新一轮追踪。 */
  reset() {
    save(this._file, { cleanShutdown: true, sessions: {} });
  }
}
