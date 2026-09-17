// 提个醒 · 调试日志收口
// 高频事件不落盘，日志超过上限时只保留最近记录，避免运行数日后无限膨胀。
import fs from "node:fs";
import path from "node:path";

export const DEBUG_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const DEBUG_LOG_KEEP_BYTES = 4 * 1024 * 1024;

const NOISY_EVENTS = new Set([
  "message_update",
  "llm_usage",
  "resource.changed",
  "bridge_status",
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "session_status",
  "agent_start",
  "agent_end",
  "agent_settled",
  "agent_activity",
  "turn_start",
  "block_update",
  "session_created",
  "session_closed",
  "terminal_started",
  "terminal_output",
  "terminal_exited",
  "deferred_result",
  "turn_input_presentation",
  "wait_task_settled",
  "wait_finished"
]);

export function isDebugNoisyEvent(type) {
  return NOISY_EVENTS.has(String(type || ""));
}

function compactIfNeeded(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size < DEBUG_LOG_MAX_BYTES) return;

  try {
    const raw = fs.readFileSync(file);
    const start = Math.max(0, raw.length - DEBUG_LOG_KEEP_BYTES);
    const newline = raw.indexOf(0x0A, start);
    const kept = raw.subarray(newline >= 0 ? newline + 1 : start);
    const marker = Buffer.from(`[debug.log 已达到上限，已截取最近记录 ${new Date().toISOString()}]\n`, "utf8");
    fs.writeFileSync(file, Buffer.concat([marker, kept]));
  } catch {
    // 日志收口失败不影响提醒主流程。
  }
}

export function appendDebugLog(dataDir, line) {
  if (!dataDir) return;
  try {
    const dir = path.join(dataDir, "tigexing");
    const file = path.join(dir, "debug.log");
    fs.mkdirSync(dir, { recursive: true });
    compactIfNeeded(file);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${String(line)}\n`);
  } catch {
    // 调试日志失败不影响提醒主流程。
  }
}
