// 提个醒 · 调试日志收口测试
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendDebugLog,
  isDebugNoisyEvent,
  DEBUG_LOG_MAX_BYTES,
  DEBUG_LOG_KEEP_BYTES
} from "../lib/debug-log.js";

test("调试日志：高频事件过滤，关键事件保留", () => {
  assert.equal(isDebugNoisyEvent("tool_execution_start"), true);
  assert.equal(isDebugNoisyEvent("message_end"), true);
  assert.equal(isDebugNoisyEvent("session_background_task"), false);
  assert.equal(isDebugNoisyEvent("已提醒"), false);
});

test("调试日志：超过上限后只保留最近记录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-debug-"));
  const dir = path.join(root, "tigexing");
  const file = path.join(dir, "debug.log");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(DEBUG_LOG_MAX_BYTES + 1, 0x78));

  appendDebugLog(root, "保留这一条");

  const size = fs.statSync(file).size;
  const text = fs.readFileSync(file, "utf8");
  assert.ok(size < DEBUG_LOG_MAX_BYTES + 1024);
  assert.ok(size >= DEBUG_LOG_KEEP_BYTES);
  assert.match(text, /保留这一条/);

  fs.rmSync(root, { recursive: true, force: true });
});
