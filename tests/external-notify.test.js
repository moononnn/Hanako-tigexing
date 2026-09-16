// 提个醒 · 对外弹窗接口测试
// 覆盖：必填校验、静默时段/总开关 → suppressed、风格/音效/时长/头像解析、按助手音效

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateExternalNotify, planExternalNotify } from "../lib/external-notify.js";
import { DEFAULT_CONFIG } from "../lib/config.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROUTE = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "routes", "api.js"), "utf8");

function baseCfg(overrides = {}) {
  return {
    ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    ...overrides
  };
}

function helpers(overrides = {}) {
  return {
    resolveSoundFile: (f) => (f === "custom.wav" ? "C:\\sounds\\custom.wav" : null),
    resolveAgentAvatar: (agentId) => (agentId === "hanako" ? "C:\\agents\\hanako\\avatars\\a.png" : null),
    ...overrides
  };
}

// ── 必填校验 ──

test("校验：title 和 message 必填", () => {
  assert.deepEqual(validateExternalNotify({}), { ok: false, error: "title and message are required" });
  assert.deepEqual(validateExternalNotify({ title: "  " }), { ok: false, error: "title and message are required" });
  assert.deepEqual(validateExternalNotify({ title: "标题", message: "" }), { ok: false, error: "title and message are required" });
  const ok = validateExternalNotify({ title: "标题", message: "内容" });
  assert.equal(ok.ok, true);
  assert.equal(ok.title, "标题");
  assert.equal(ok.message, "内容");
});

test("校验：title/message 收 trim 后的字符串", () => {
  const ok = validateExternalNotify({ title: "  提醒  ", message: "  内容  " });
  assert.equal(ok.title, "提醒");
  assert.equal(ok.message, "内容");
});

// ── 静默 / 关闭 ──

test("总开关关闭：suppressed=disabled", () => {
  const plan = planExternalNotify({ title: "t", message: "m" }, baseCfg({ enabled: false }), helpers());
  assert.deepEqual(plan, { action: "suppressed", reason: "disabled" });
});

test("静默时段：suppressed=quiet", () => {
  const cfg = baseCfg({ quietHours: { enabled: true, start: "22:00", end: "08:00" } });
  // 注入固定时间：2026-08-09T23:00（晚上，静默时段内）
  const plan = planExternalNotify({ title: "t", message: "m" }, cfg, helpers(), new Date("2026-08-09T23:00:00"));
  assert.deepEqual(plan, { action: "suppressed", reason: "quiet" });
});

test("静默时段：非静默时段正常发", () => {
  const cfg = baseCfg({ quietHours: { enabled: true, start: "22:00", end: "08:00" } });
  const plan = planExternalNotify({ title: "t", message: "m" }, cfg, helpers(), new Date("2026-08-09T15:00:00"));
  assert.equal(plan.action, "send");
});

// ── 正常弹窗参数解析 ──

test("默认参数：style 跟随全局 toastStyle，无音效无头像", () => {
  const plan = planExternalNotify({ title: "标题", message: "内容" }, baseCfg(), helpers());
  assert.equal(plan.action, "send");
  assert.equal(plan.toast.style, "icon"); // 默认 toastStyle 是 icon
  assert.equal(plan.toast.title, "标题");
  assert.equal(plan.toast.message, "内容");
  assert.equal(plan.toast.icon, undefined);
  assert.equal(plan.toast.sound, undefined);
  assert.equal(plan.toast.duration, "default");
});

test("style 显式 plain / icon 覆盖", () => {
  const p1 = planExternalNotify({ title: "t", message: "m", style: "plain" }, baseCfg(), helpers());
  assert.equal(p1.toast.style, "plain");
  const p2 = planExternalNotify({ title: "t", message: "m", style: "icon" }, baseCfg(), helpers());
  assert.equal(p2.toast.style, "icon");
  // 非法值回退配置
  const p3 = planExternalNotify({ title: "t", message: "m", style: "fancy" }, baseCfg({ toastStyle: "plain" }), helpers());
  assert.equal(p3.toast.style, "plain");
});

test("音效：显式 silent / 显式文件（只收存在）/ 非法忽略", () => {
  const silent = planExternalNotify({ title: "t", message: "m", sound: "silent" }, baseCfg(), helpers());
  assert.equal(silent.toast.sound, "silent");

  const custom = planExternalNotify({ title: "t", message: "m", sound: "custom.wav" }, baseCfg(), helpers());
  assert.equal(custom.toast.sound, "C:\\sounds\\custom.wav");

  const missing = planExternalNotify({ title: "t", message: "m", sound: "nope.wav" }, baseCfg(), helpers());
  assert.equal(missing.toast.sound, undefined);
});

test("音效：未指定时按该助手配置（silent / 文件 / default）", () => {
  const silent = planExternalNotify(
    { title: "t", message: "m", agentId: "a1" },
    baseCfg({ agentSounds: { a1: "silent" } }),
    helpers()
  );
  assert.equal(silent.toast.sound, "silent");

  const file = planExternalNotify(
    { title: "t", message: "m", agentId: "a2" },
    baseCfg({ agentSounds: { a2: "custom.wav" } }),
    helpers()
  );
  assert.equal(file.toast.sound, "C:\\sounds\\custom.wav");

  const def = planExternalNotify(
    { title: "t", message: "m", agentId: "a3" },
    baseCfg({ agentSounds: { a3: "default" } }),
    helpers()
  );
  assert.equal(def.toast.sound, undefined);
});

test("duration：显式 long 才 long，其余跟随全局", () => {
  const long = planExternalNotify({ title: "t", message: "m", duration: "long" }, baseCfg(), helpers());
  assert.equal(long.toast.duration, "long");
  const def = planExternalNotify({ title: "t", message: "m", duration: "short" }, baseCfg(), helpers());
  assert.equal(def.toast.duration, "default");
  const cfgLong = planExternalNotify({ title: "t", message: "m" }, baseCfg({ toastDuration: "long" }), helpers());
  assert.equal(cfgLong.toast.duration, "long");
});

test("头像：按 agentId 取，无 agentId 不带头像", () => {
  const withAgent = planExternalNotify({ title: "t", message: "m", agentId: "hanako" }, baseCfg(), helpers());
  assert.equal(withAgent.toast.icon, "C:\\agents\\hanako\\avatars\\a.png");

  const unknown = planExternalNotify({ title: "t", message: "m", agentId: "nobody" }, baseCfg(), helpers());
  assert.equal(unknown.toast.icon, undefined);

  const noAgent = planExternalNotify({ title: "t", message: "m" }, baseCfg(), helpers());
  assert.equal(noAgent.toast.icon, undefined);
});

// ── 路由注册（防翻新误删） ──

test("路由：对外弹窗端点已注册", () => {
  assert.match(ROUTE, /app\.post\("\/api\/external\/notify"/);
  assert.match(ROUTE, /validateExternalNotify/);
  assert.match(ROUTE, /planExternalNotify/);
  assert.match(ROUTE, /suppressed/);
  assert.match(ROUTE, /sendToast\(\{ pluginDir, \.\.\.plan\.toast, log \}\)/);
});
