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
  assert.equal(normalizeConfig(undefined).enabled, true);
  assert.equal(normalizeConfig("字符串").chatTrigger, DEFAULT_CONFIG.chatTrigger);
  const ok = normalizeConfig({ enabled: false, refineEnabled: true, chatTrigger: "always" });
  assert.equal(ok.enabled, false);
  assert.equal(ok.refineEnabled, true);
  assert.equal(ok.chatTrigger, "always");
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