// 提个醒 · 异常回合状态机测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { AbnormalTurnTracker } from "../lib/abnormal-state.js";

function fixture() {
  const pending = new Map();
  const alerts = [];
  let nextId = 0;
  const tracker = new AbnormalTurnTracker({
    graceMs: 2500,
    schedule: (fn) => {
      const id = ++nextId;
      pending.set(id, fn);
      return id;
    },
    cancel: (id) => pending.delete(id),
    onAlert: (alert) => alerts.push(alert)
  });
  return { tracker, pending, alerts };
}

const failure = (extra = {}) => ({
  sessionId: "s1",
  agentId: "hanako",
  sessionPath: "C:/agents/hanako/sessions/s1.jsonl",
  text: "已经收到一半",
  errorMessage: "WebSocket error",
  ...extra
});

test("自动重试耗尽：只提醒一次，并保留失败回合内容", () => {
  const { tracker, pending, alerts } = fixture();
  tracker.beginUserTurn("s1");
  tracker.onTurnFailure(failure());
  assert.equal(pending.size, 1);
  tracker.onRetryStart("s1");
  assert.equal(pending.size, 0);
  tracker.onRetryEnd({ sessionId: "s1", agentId: "hanako", success: false, finalError: "fetch failed" });
  tracker.onRetryEnd({ sessionId: "s1", agentId: "hanako", success: false, finalError: "fetch failed" });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].source, "retry_exhausted");
  assert.equal(alerts[0].text, "已经收到一半");
});

test("自动重试成功：清掉失败候选，不误报", () => {
  const { tracker, pending, alerts } = fixture();
  tracker.beginUserTurn("s1");
  tracker.onTurnFailure(failure());
  tracker.onRetryStart("s1");
  tracker.onRetryEnd({ sessionId: "s1", success: true, attempt: 1 });
  assert.equal(pending.size, 0);
  assert.equal(alerts.length, 0);
});

test("正常最终回合：清掉 provider error 兜底计时", () => {
  const { tracker, pending, alerts } = fixture();
  tracker.beginUserTurn("s1");
  tracker.onTurnFailure(failure());
  tracker.onTurnSuccess("s1");
  assert.equal(pending.size, 0);
  assert.equal(alerts.length, 0);
});

test("没有进入自动重试：宽限期后兜底提醒，新回合可再次提醒", () => {
  const { tracker, alerts } = fixture();
  tracker.beginUserTurn("s1");
  tracker.onTurnFailure(failure({ text: "" }));
  assert.equal(tracker.flush("s1"), true);
  assert.equal(tracker.flush("s1"), false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].source, "turn_failure");

  tracker.beginUserTurn("s1");
  tracker.onTurnFailure(failure({ errorMessage: "fetch failed" }));
  assert.equal(tracker.flush("s1"), true);
  assert.equal(alerts.length, 2);
});

test("用户主动取消重试：不弹异常提醒", () => {
  const { tracker, alerts } = fixture();
  tracker.beginUserTurn("s1");
  tracker.onTurnFailure(failure());
  tracker.onRetryStart("s1");
  tracker.onRetryEnd({ sessionId: "s1", success: false, finalError: "Retry cancelled" });
  assert.equal(alerts.length, 0);
});

test("会话不健康：同一周期去重，新回合重新允许提醒", () => {
  const { tracker, alerts } = fixture();
  tracker.beginUserTurn("s1");
  assert.equal(tracker.onSessionUnhealthy({ sessionId: "s1", recentErrors: 4, totalChecked: 4 }), true);
  assert.equal(tracker.onSessionUnhealthy({ sessionId: "s1", recentErrors: 4, totalChecked: 4 }), false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "unhealthy");

  tracker.beginUserTurn("s1");
  assert.equal(tracker.onSessionUnhealthy({ sessionId: "s1", recentErrors: 3, totalChecked: 3 }), true);
  assert.equal(alerts.length, 2);
});
