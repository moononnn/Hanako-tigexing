// 提个醒 · 配置管理测试
// 覆盖：默认值、读写、带文件的外部修改感知（双实例同步——设置页改配置后弹通知进程要能读到）

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createConfigManager, normalizeConfig, DEFAULT_CONFIG, configFilePath } from "../lib/config.js";

/** 临时插件数据目录（每个测试独立，测完删） */
function tmpCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-cfg-"));
  return {
    dataDir: dir,
    pluginId: "tigexing",
    log: { error() {}, info() {}, warn() {} },
    dir
  };
}

test("normalizeConfig：默认值齐全，非法输入回退默认", () => {
  assert.equal(normalizeConfig(null).refineEnabled, false);
  assert.equal(normalizeConfig(null).toastDuration, "default");
  assert.equal(normalizeConfig(null).scheduledTakeover, true);
  assert.equal(normalizeConfig(undefined).enabled, true);
  assert.equal(normalizeConfig(null).abnormalEnabled, true);
  assert.equal(normalizeConfig("字符串").chatTrigger, DEFAULT_CONFIG.chatTrigger);
  const ok = normalizeConfig({ enabled: false, refineEnabled: true, chatTrigger: "always", scheduledTakeover: false });
  assert.equal(ok.enabled, false);
  assert.equal(ok.refineEnabled, true);
  assert.equal(ok.chatTrigger, "always");
  assert.equal(ok.scheduledTakeover, false);
  assert.equal(normalizeConfig({ toastDuration: "long" }).toastDuration, "long");
  assert.equal(normalizeConfig({ toastDuration: "short" }).toastDuration, "default");
  assert.equal(normalizeConfig({ toastDuration: 25 }).toastDuration, "default");
});

test("normalizeConfig：abnormalEnabled 独立开关只收布尔，非法输入回默认 true", () => {
  assert.equal(normalizeConfig({ abnormalEnabled: false }).abnormalEnabled, false);
  assert.equal(normalizeConfig({ abnormalEnabled: "no" }).abnormalEnabled, true);
  assert.equal(normalizeConfig({ abnormalEnabled: 0 }).abnormalEnabled, true);
});

test("normalizeConfig：soundDir 只收绝对路径，相对/超长/非字符串回默认", () => {
  assert.equal(DEFAULT_CONFIG.soundDir, "");
  assert.equal(normalizeConfig(null).soundDir, "");
  // 合法绝对路径（Windows 盘符/UNC/斜杠开头都可，用 path 构造保证跨平台）
  const abs = path.join(os.tmpdir(), "我的音效");
  assert.equal(normalizeConfig({ soundDir: abs }).soundDir, abs);
  // 相对路径 → 忽略
  assert.equal(normalizeConfig({ soundDir: "sounds" }).soundDir, "");
  assert.equal(normalizeConfig({ soundDir: "../sounds" }).soundDir, "");
  // 超长 → 忽略
  assert.equal(normalizeConfig({ soundDir: "D:" + "x".repeat(1100) }).soundDir, "");
  // 非字符串 → 忽略
  assert.equal(normalizeConfig({ soundDir: 123 }).soundDir, "");
  assert.equal(normalizeConfig({ soundDir: { p: "C:\\a" } }).soundDir, "");
  // 带空白的合法路径会 trim
  assert.equal(normalizeConfig({ soundDir: "  " + abs + "  " }).soundDir, abs);
});

test("配置读：文件不存在用默认值，写入后可读回", async () => {
  const ctx = tmpCtx();
  const cm = createConfigManager(ctx);
  assert.equal(cm.get().refineEnabled, false, "无文件时用默认值");

  await cm.patch({ refineEnabled: true });
  assert.equal(cm.get().refineEnabled, true, "patch 后内存可见");

  // 重新创建实例（模拟重启）→ 从文件读回
  const cm2 = createConfigManager(ctx);
  assert.equal(cm2.get().refineEnabled, true, "新实例从文件读到已保存配置");

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test("旧配置无 scheduledTakeover 字段时，升级后保持默认接管", () => {
  const ctx = tmpCtx();
  const fp = configFilePath(ctx.dataDir, ctx.pluginId);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ scheduledTrigger: "whenUnfocused" }), "utf8");

  const cm = createConfigManager(ctx);
  assert.equal(cm.get().scheduledTakeover, true);
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test("双实例同步：设置页（实例B）改配置，弹通知进程（实例A）能读到（回归：润色开关失效）", async () => {
  const ctx = tmpCtx();
  // 实例 A：弹通知进程（index.js），先读一次配置（旧值）
  const cmA = createConfigManager(ctx);
  cmA.get(); // 无需用返回值，重点：它缓存了「没有 refineEnabled」的默认
  assert.equal(cmA.get().refineEnabled, false, "初始为关");

  // 实例 B：设置页（routes/api.js）打开润色开关并落盘
  const cmB = createConfigManager(ctx);
  await cmB.patch({ refineEnabled: true });

  // 实例 A 再次读取 → 必须感知文件变化，读到新值
  assert.equal(cmA.get().refineEnabled, true, "A 应感知 B 的修改（文件签名变化重读）");

  // 反向：B 再关掉，A 也要能读到
  await cmB.patch({ refineEnabled: false });
  assert.equal(cmA.get().refineEnabled, false, "A 应感知 B 再次修改");

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test("双实例同步：实例A自己不做写操作时，多次 get 不丢配置", async () => {
  const ctx = tmpCtx();
  const cmA = createConfigManager(ctx);
  await cmA.set({ enabled: true });
  const first = cmA.get();
  const second = cmA.get();
  assert.deepEqual(first, second, "无外部改动时多次读取保持一致");

  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test("configFilePath：数据目录/插件 id 拼接正确", () => {
  assert.equal(
    path.normalize(configFilePath("D:/data", "tigexing")),
    path.normalize("D:/data/tigexing/preferences.json")
  );
});

test("normalizeConfig：agentStyles 白名单应包含扩展风格（回归：方言保存丢失）", async () => {
  // 背景：方言等扩展风格由 registerStyle 动态注册到 EXTRA_STYLES，
  // 之前白名单用静态 STYLE_IDS（只有基础 10 套），导致选上海话保存后被静默丢弃、刷新变回默认。
  const style = await import("../lib/style.js");
  style.registerStyle({ id: "dh_shanghai", label: "上海话", refinable: true, title: () => "", body: () => "" });

  const norm = normalizeConfig({ agentStyles: { hanako: "dh_shanghai" } });
  assert.equal(norm.agentStyles.hanako, "dh_shanghai", "已注册的扩展风格应保留");

  // 未注册的非法 id 仍应被过滤
  const norm2 = normalizeConfig({ agentStyles: { hanako: "dh_not_exists" } });
  assert.deepEqual(norm2.agentStyles, {}, "非法风格 id 应被过滤");

  // 基础风格照常
  const norm3 = normalizeConfig({ agentStyles: { hanako: "epistle" } });
  assert.equal(norm3.agentStyles.hanako, "epistle", "基础风格照常保留");
});

test("normalizeConfig：agentTriggers 只收聊天档位白名单，其余助手跟随全局", () => {
  // 默认空对象
  assert.deepEqual(normalizeConfig(null).agentTriggers, {}, "默认无按助手设置");

  // 合法档位全部保留
  const ok = normalizeConfig({ agentTriggers: { xiansheng: "never", hanako: "always", yumi: "whenSessionUnfocused", yukina: "whenUnfocused" } });
  assert.equal(ok.agentTriggers.xiansheng, "never");
  assert.equal(ok.agentTriggers.hanako, "always");
  assert.equal(ok.agentTriggers.yumi, "whenSessionUnfocused");
  assert.equal(ok.agentTriggers.yukina, "whenUnfocused");

  // 非法档位 / 非对象输入被过滤，不留脏数据
  const bad = normalizeConfig({ agentTriggers: { xiansheng: "sometimes", hanako: 123, yumi: { a: 1 } } });
  assert.deepEqual(bad.agentTriggers, {}, "非法值应全部过滤");

  // 数组视为非法（引用类型防御）
  const arr = normalizeConfig({ agentTriggers: ["never"] });
  assert.deepEqual(arr.agentTriggers, {}, "数组输入被忽略");

  // 任务档位（whenUnfocused 之外的 scheduled 专属值）不在聊天白名单
  const sched = normalizeConfig({ agentTriggers: { xiansheng: "always" } });
  assert.equal(sched.agentTriggers.xiansheng, "always");
});

test("normalizeConfig：hiddenAgents 只收安全字符集的 id 数组，去重", () => {
  // 默认空数组
  assert.deepEqual(normalizeConfig(null).hiddenAgents, [], "默认无隐藏助手");

  // 合法 id 保留
  const ok = normalizeConfig({ hiddenAgents: ["hanabrew-visitor-192c98fb3fcf", "hanako"] });
  assert.deepEqual(ok.hiddenAgents, ["hanabrew-visitor-192c98fb3fcf", "hanako"]);

  // 非法字符 / 超长 / 非字符串被过滤（数字字符串合法，会保留）
  const bad = normalizeConfig({ hiddenAgents: ["../evil", "a b", "x".repeat(200), null, ""] });
  assert.deepEqual(bad.hiddenAgents, [], "非法 id 全部过滤");
  // 数字字符串：安全字符集内，保留
  const num = normalizeConfig({ hiddenAgents: [123] });
  assert.deepEqual(num.hiddenAgents, ["123"], "数字字符串合法保留");

  // 去重
  const dup = normalizeConfig({ hiddenAgents: ["hanako", "hanako", "hanako"] });
  assert.deepEqual(dup.hiddenAgents, ["hanako"], "重复 id 只留一个");

  // 非数组输入忽略
  const notArr = normalizeConfig({ hiddenAgents: "hanako" });
  assert.deepEqual(notArr.hiddenAgents, [], "非数组忽略");
});