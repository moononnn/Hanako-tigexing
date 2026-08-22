// 提个醒 · 活跃回合追踪测试
// 覆盖：标记/擦除/干净退出/读取残留/时间窗过滤/重置

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { TurnTrace, traceFilePath } from "../lib/turn-trace.js";

function makeTrace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txs-trace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new TurnTrace({ dataDir: dir });
}

test("初始状态：文件不存在视为干净退出，无残留", (t) => {
  const tr = makeTrace(t);
  assert.deepEqual(tr.readInterrupted(), []);
});

test("markActive 后 readInterrupted 返回该会话（非干净退出残留）", (t) => {
  const tr = makeTrace(t);
  tr.markActive("sess_abc", { agentId: "hanako", sessionPath: "/x/s.jsonl" });
  const hits = tr.readInterrupted();
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, "sess_abc");
  assert.equal(hits[0].agentId, "hanako");
});

test("clearActive 擦除：回合正常结束后不留残留", (t) => {
  const tr = makeTrace(t);
  tr.markActive("sess_abc", { agentId: "hanako" });
  tr.clearActive("sess_abc");
  assert.deepEqual(tr.readInterrupted(), []);
});

test("markCleanShutdown：正常退出后重启不补弹", (t) => {
  const tr = makeTrace(t);
  tr.markActive("sess_abc", { agentId: "hanako" });
  tr.markCleanShutdown();
  assert.deepEqual(tr.readInterrupted(), []);
});

test("readInterrupted 时间窗：超过 maxAgeMs 的旧残留不补弹", (t) => {
  // 用独立目录手动写旧 ts
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "txs-trace-old-"));
  t.after(() => fs.rmSync(oldDir, { recursive: true, force: true }));
  const oldTr = new TurnTrace({ dataDir: oldDir });
  oldTr.markActive("sess_old", { agentId: "hanako" });
  // 篡改 ts 为 10 小时前
  const f = traceFilePath(oldDir);
  const data = JSON.parse(fs.readFileSync(f, "utf-8"));
  data.sessions.sess_old.ts = Date.now() - 10 * 3600 * 1000;
  fs.writeFileSync(f, JSON.stringify(data));
  assert.deepEqual(oldTr.readInterrupted({ maxAgeMs: 6 * 3600 * 1000 }), []);
});

test("reset：补弹完成后清空并回到干净状态", (t) => {
  const tr = makeTrace(t);
  tr.markActive("sess_abc", { agentId: "hanako" });
  tr.reset();
  assert.deepEqual(tr.readInterrupted(), []);
});

test("readInterrupted 只返回 sessionId 有效的记录", (t) => {
  const tr = makeTrace(t);
  tr.markActive("sess_abc", { agentId: "hanako" });
  const hits = tr.readInterrupted();
  assert.ok(hits.every((s) => s.sessionId));
});
