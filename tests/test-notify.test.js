// 提个醒 · 测试通知工具路径回归
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePluginDir } from "../tools/test-notify.js";

test("测试通知工具：优先使用宿主提供的插件目录", () => {
  assert.equal(resolvePluginDir({ pluginId: "tigexing", pluginDir: "D:/Hana/plugins/tigexing" }), "D:/Hana/plugins/tigexing");
});

test("测试通知工具：缺少插件目录时回退默认 Hana 路径", () => {
  assert.match(resolvePluginDir({ pluginId: "tigexing" }), /[\\/]plugins[\\/]tigexing$/);
});
