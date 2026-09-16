// 提个醒 · 对话框后台任务门测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { BackgroundTaskTracker } from "../lib/background-tasks.js";

const task = (action, taskId, sessionId = "sess_main") => ({ action, taskId, sessionId });

test("后台任务门：任一子 agent 运行时保持阻塞", () => {
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "child-a"));
  tracker.update(task("upsert", "child-b"));
  assert.equal(tracker.has("sess_main"), true);
  assert.equal(tracker.count("sess_main"), 2);
  tracker.update(task("remove", "child-a"));
  assert.equal(tracker.has("sess_main"), true);
  assert.equal(tracker.count("sess_main"), 1);
});

test("后台任务门：全部子 agent 收齐后解除阻塞", () => {
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "child-a"));
  tracker.update({ ...task("upsert", "child-a"), status: "completed" });
  assert.equal(tracker.has("sess_main"), false);
  assert.equal(tracker.count("sess_main"), 0);
});

test("后台任务门：终态 upsert 也解除阻塞", () => {
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "child-a"));
  tracker.update({ ...task("upsert", "child-a"), status: "failed" });
  assert.equal(tracker.has("sess_main"), false);
});

test("后台任务门：不同对话框互不影响，非法事件不改变状态", () => {
  const tracker = new BackgroundTaskTracker();
  tracker.update(task("upsert", "child-a", "sess-a"));
  assert.equal(tracker.has("sess-a"), true);
  assert.equal(tracker.has("sess-b"), false);
  assert.equal(tracker.update({ action: "unknown", taskId: "x", sessionId: "sess-a" }), false);
  assert.equal(tracker.update({ action: "remove", taskId: "missing", sessionId: "sess-a" }), true);
  assert.equal(tracker.has("sess-a"), true);
});
