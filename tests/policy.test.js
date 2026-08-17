// 提个醒 · 策略逻辑测试
// 覆盖：合并窗口（同窗口合并/跨窗口不合并/窗口滑动）、静默时段、开关、标题组装

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Notifier,
  isInQuietHours,
  makeSnippet,
  buildTitle
} from "../lib/policy.js";
import { DEFAULT_CONFIG, normalizeConfig } from "../lib/config.js";

function baseConfig(overrides = {}) {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    ...overrides
  };
}

// ── 静默时段 ──

test("静默时段：不在时段内返回 false", () => {
  const cfg = baseConfig({ quietHours: { enabled: true, start: "22:00", end: "08:00" } });
  const d = new Date("2026-08-09T15:00:00"); // 下午 3 点
  assert.equal(isInQuietHours(cfg, d), false);
});

test("静默时段：跨午夜时段，晚上命中", () => {
  const cfg = baseConfig({ quietHours: { enabled: true, start: "22:00", end: "08:00" } });
  const d = new Date("2026-08-09T23:30:00");
  assert.equal(isInQuietHours(cfg, d), true);
});

test("静默时段：跨午夜时段，凌晨命中", () => {
  const cfg = baseConfig({ quietHours: { enabled: true, start: "22:00", end: "08:00" } });
  const d = new Date("2026-08-09T02:00:00");
  assert.equal(isInQuietHours(cfg, d), true);
});

test("静默时段：不跨午夜时段（08:00-12:00）", () => {
  const cfg = baseConfig({ quietHours: { enabled: true, start: "08:00", end: "12:00" } });
  assert.equal(isInQuietHours(cfg, new Date("2026-08-09T10:00:00")), true);
  assert.equal(isInQuietHours(cfg, new Date("2026-08-09T14:00:00")), false);
  assert.equal(isInQuietHours(cfg, new Date("2026-08-09T06:00:00")), false);
});

test("静默时段：开关关闭时不生效", () => {
  const cfg = baseConfig({ quietHours: { enabled: false, start: "22:00", end: "08:00" } });
  assert.equal(isInQuietHours(cfg, new Date("2026-08-09T02:00:00")), false);
});

test("静默时段：无效时间格式返回 false", () => {
  const cfg = baseConfig({ quietHours: { enabled: true, start: "abc", end: "08:00" } });
  assert.equal(isInQuietHours(cfg, new Date("2026-08-09T02:00:00")), false);
});

test("通知样式固定带头像：旧配置 plain 也归一为 icon（v0.3.1 拍板）", () => {
  const cfg = normalizeConfig({ toastStyle: "plain" });
  assert.equal(cfg.toastStyle, "icon");
  const cfg2 = normalizeConfig({ toastStyle: "icon" });
  assert.equal(cfg2.toastStyle, "icon");
  const cfg3 = normalizeConfig({});
  assert.equal(cfg3.toastStyle, "icon");
});

test("三项监听档位：各自独立，非法值回退默认", () => {
  const cfg = normalizeConfig({
    chatTrigger: "always",
    scheduledTrigger: "whenUnfocused",
    patrolTrigger: "never"
  });
  assert.equal(cfg.chatTrigger, "always");
  assert.equal(cfg.scheduledTrigger, "whenUnfocused");
  assert.equal(cfg.patrolTrigger, "never");
  // 任务档位不接受 whenSessionUnfocused（跟原版一致，无会话概念）
  const bad = normalizeConfig({ scheduledTrigger: "whenSessionUnfocused" });
  assert.equal(bad.scheduledTrigger, "whenUnfocused");
  // 聊天档位不接受非法值
  const bad2 = normalizeConfig({ chatTrigger: "bogus" });
  assert.equal(bad2.chatTrigger, "whenSessionUnfocused");
});

test("旧单 trigger 配置迁移到 chatTrigger（v0.3.1 兼容）", () => {
  const cfg = normalizeConfig({ trigger: "always" });
  assert.equal(cfg.chatTrigger, "always");
  assert.equal(cfg.scheduledTrigger, "whenUnfocused");
  assert.equal(cfg.patrolTrigger, "whenUnfocused");
  const old = normalizeConfig({ notifyScope: "background" });
  assert.equal(old.chatTrigger, "whenSessionUnfocused");
  const empty = normalizeConfig({});
  assert.equal(empty.chatTrigger, "whenSessionUnfocused");
});

// ── snippet ──

test("snippet：超长截断加省略号，空白折叠", () => {
  const s = makeSnippet("  a   b ".repeat(30), 20);
  assert.ok(s.endsWith("…"));
  assert.ok(!s.includes("  "));
});

test("snippet：空回复有兜底文案", () => {
  assert.equal(makeSnippet("", 10), "(空回复)");
  assert.equal(makeSnippet(null, 10), "(空回复)");
});

// ── 合并窗口核心 ──

test("合并：同窗口 30 秒内多条回复合并，flush 后补弹追加条", () => {
  const n = new Notifier(baseConfig({ mergeWindowMs: 30000 }));
  const t0 = 1_000_000;

  const d1 = n.decide({ sessionId: "s1", agentId: "hanako", agentName: "小花", text: "第一条回复" }, t0);
  assert.equal(d1.action, "toast");
  assert.equal(d1.kind, "first");

  const d2 = n.decide({ sessionId: "s1", agentId: "hanako", agentName: "小花", text: "第二条回复" }, t0 + 5000);
  assert.equal(d2.action, "merge");
  assert.equal(d2.count, 2);

  const d3 = n.decide({ sessionId: "s1", agentId: "hanako", agentName: "小花", text: "第三条回复" }, t0 + 10000);
  assert.equal(d3.action, "merge");
  assert.equal(d3.count, 3);

  const f = n.flush("s1", t0 + 40000);
  assert.equal(f.action, "toast");
  assert.equal(f.kind, "append");
  assert.equal(f.count, 3);
  assert.equal(f.snippet, "第三条回复");
});

test("合并：窗口内只有 1 条时 flush 不补弹", () => {
  const n = new Notifier(baseConfig({ mergeWindowMs: 30000 }));
  n.decide({ sessionId: "s1", agentId: "hanako", agentName: "小花", text: "就一条" }, 1_000_000);
  const f = n.flush("s1", 1_000_000 + 40000);
  assert.equal(f, null);
});

test("合并：跨窗口永不合并，各弹各的", () => {
  const n = new Notifier(baseConfig({ mergeWindowMs: 30000 }));
  const t0 = 1_000_000;

  const d1 = n.decide({ sessionId: "sA", agentId: "hanako", agentName: "小花", text: "窗口A第一条" }, t0);
  assert.equal(d1.kind, "first");

  const d2 = n.decide({ sessionId: "sB", agentId: "agent-a", agentName: "助手A", text: "窗口B第一条" }, t0 + 1000);
  assert.equal(d2.action, "toast");
  assert.equal(d2.kind, "first");
  assert.equal(d2.agentName, "助手A");

  // 两个窗口各自 flush
  assert.equal(n.flush("sA", t0 + 40000), null); // 各只有一条
  assert.equal(n.flush("sB", t0 + 40000), null);
});

test("合并：窗口滑动——持续有新回复就一直延后", () => {
  const n = new Notifier(baseConfig({ mergeWindowMs: 30000 }));
  const t0 = 1_000_000;
  n.decide({ sessionId: "s1", agentId: "hanako", agentName: "小花", text: "第一条" }, t0);
  n.decide({ sessionId: "s1", agentId: "hanako", agentName: "小花", text: "第二条" }, t0 + 25000); // 窗口内
  n.decide({ sessionId: "s1", agentId: "hanako", agentName: "小花", text: "第三条" }, t0 + 50000); // 距上一条 25 秒，仍在滑动窗口内
  const f = n.flush("s1", t0 + 100000);
  assert.equal(f.count, 3);
});

test("合并：窗口过期后新回复开新窗口（count 重置为 1）", () => {
  const n = new Notifier(baseConfig({ mergeWindowMs: 30000 }));
  const t0 = 1_000_000;
  n.decide({ sessionId: "s1", agentId: "hanako", agentName: "小花", text: "第一条" }, t0);
  // 40 秒后新回复：窗口已过期
  const d = n.decide({ sessionId: "s1", agentId: "hanako", agentName: "小花", text: "新一条" }, t0 + 40000);
  assert.equal(d.action, "toast");
  assert.equal(d.kind, "first");
  assert.equal(d.count, 1);
});

// ── 开关 ──

test("总开关关闭：跳过且原因 disabled", () => {
  const n = new Notifier(baseConfig({ enabled: false }));
  const d = n.decide({ sessionId: "s1", agentId: "hanako", agentName: "小花", text: "任何内容" }, 1_000_000);
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "disabled");
});

test("静默时段：跳过且原因 quiet，不进入合并窗口", () => {
  const n = new Notifier(baseConfig({ quietHours: { enabled: true, start: "22:00", end: "08:00" } }));
  const d = n.decide(
    { sessionId: "s1", agentId: "hanako", agentName: "小花", text: "深夜回复" },
    new Date("2026-08-09T23:00:00").getTime()
  );
  assert.equal(d.action, "skip");
  assert.equal(d.reason, "quiet");
});

// ── 标题 ──

test("标题组装：first / append", () => {
  assert.equal(buildTitle("first", "小花"), "小花 回你了");
  assert.equal(buildTitle("first", null), "助手 回你了");
  assert.equal(buildTitle("append", "小花", 3), "小花 又回了 2 条");
  assert.equal(buildTitle("append", "小花", 1), "小花 又回了 0 条");
});
