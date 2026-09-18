// 提个醒 · 测试通知工具路径回归
import { test } from "node:test";
import assert from "node:assert/strict";
function resolvePluginDir(ctx) {
  if (ctx?.pluginDir) return ctx.pluginDir;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return `${home}/.hanako/plugins/${ctx?.pluginId || "tigexing"}`;
}

test("测试通知工具路径回归：优先使用宿主提供的插件目录", () => {
  assert.equal(resolvePluginDir({ pluginId: "tigexing", pluginDir: "D:/Hana/plugins/tigexing" }), "D:/Hana/plugins/tigexing");
});

test("测试通知工具路径回归：缺少插件目录时回退默认 Hana 路径", () => {
  assert.match(resolvePluginDir({ pluginId: "tigexing" }), /[\\/]plugins[\\/]tigexing$/);
});
