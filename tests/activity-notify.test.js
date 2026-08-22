// 提个醒 · 计划任务通知去重测试
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ActivityNotificationTracker,
  activityNotificationKeys,
  resolveActivitySessionPath
} from "../lib/activity-notify.js";
import { parseActivityUpdate } from "../lib/event-parse.js";

test("活动通知去重：notification 全路径能和 activity_update 文件名还原后的路径对上", () => {
  const tracker = new ActivityNotificationTracker();
  const fullPath = "C:\\Users\\x\\.hanako\\agents\\hanako\\activity\\cron_123.jsonl";
  tracker.mark(fullPath, 1000);
  const activity = parseActivityUpdate({
    type: "activity_update",
    activity: { type: "cron", agentId: "hanako", sessionFile: "cron_123.jsonl" }
  });
  const activityPath = resolveActivitySessionPath("C:/Users/x/.hanako/agents", activity.agentId, activity.sessionFile);

  assert.equal(tracker.has(activityPath, 2000), true);
});

test("活动通知去重：activity_update 先到时，后到 notification 仍可命中", () => {
  const tracker = new ActivityNotificationTracker();
  const activityPath = resolveActivitySessionPath("C:/Users/x/.hanako/agents", "hanako", "cron_456.jsonl");
  assert.equal(tracker.has(activityPath, 1000), false);
  tracker.mark("C:\\Users\\x\\.hanako\\agents\\hanako\\activity\\cron_456.jsonl", 1200);
  assert.equal(tracker.has(activityPath, 1300), true);
});

test("活动通知去重：不同完整路径的同名活动不会互相误判", () => {
  const tracker = new ActivityNotificationTracker();
  tracker.mark("C:/Users/x/.hanako/agents/hanako/activity/cron_same.jsonl", 1000);
  assert.equal(
    tracker.has("C:/Users/x/.hanako/agents/feiyue/activity/cron_same.jsonl", 1001),
    false
  );
});

test("活动通知去重：同一 sessionFile 兼容斜杠差异", () => {
  const tracker = new ActivityNotificationTracker();
  tracker.mark("C:\\Users\\x\\.hanako\\agents\\hanako\\activity\\cron_123.jsonl", 1000);

  assert.equal(
    tracker.has("C:/Users/x/.hanako/agents/hanako/activity/cron_123.jsonl", 2000),
    true
  );
});

test("活动通知去重：空路径不误判", () => {
  const tracker = new ActivityNotificationTracker();
  assert.equal(tracker.mark("", 1000), false);
  assert.equal(tracker.has("", 1000), false);
});

test("活动通知去重：过期标记会清理", () => {
  const tracker = new ActivityNotificationTracker(1000);
  tracker.mark("C:/activity/cron.jsonl", 1000);
  assert.equal(tracker.has("C:/activity/cron.jsonl", 1999), true);
  assert.equal(tracker.has("C:/activity/cron.jsonl", 2000), false);
});

test("活动通知去重：只使用规范化完整路径键", () => {
  assert.deepEqual(
    activityNotificationKeys("C:/activity/cron.jsonl"),
    ["path:c:\\activity\\cron.jsonl"]
  );
});
