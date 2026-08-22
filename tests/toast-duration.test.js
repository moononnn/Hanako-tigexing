// 提个醒 · 系统通知时长接线回归
// 保护设置页、Node→PowerShell 环境变量和 WinRT toast 属性不会被后续改动拆开。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = fs.readFileSync(path.join(ROOT, "routes", "api.js"), "utf8");
const TOAST = fs.readFileSync(path.join(ROOT, "lib", "toast.js"), "utf8");
const NOTIFY_PS1 = fs.readFileSync(path.join(ROOT, "lib", "notify.ps1"), "utf8");


test("系统通知时长：设置页提供默认 / 长时长两档", () => {
  assert.match(ROUTE, /id="seg-duration"/);
  assert.match(ROUTE, /data-duration="default"/);
  assert.match(ROUTE, /data-duration="long"/);
  assert.match(ROUTE, /toastDuration/);
});

test("系统通知时长：Node 只允许把 long 传给 PowerShell", () => {
  assert.match(TOAST, /TXS_DURATION: duration === "long" \? "long" : ""/);
});

test("系统通知时长：PowerShell 将 long 写入 toast duration 属性", () => {
  assert.match(NOTIFY_PS1, /TXS_DURATION/);
  assert.match(NOTIFY_PS1, /duration='long'/);
  assert.match(NOTIFY_PS1, /<toast\$durationAttr>/);
});
