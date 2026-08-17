// 提个醒 · 分享版入口接入回归
// 保护检查更新 / 反馈积木的路由、页面挂载点和凭证适配不被后续翻新删掉。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = fs.readFileSync(path.join(ROOT, "routes", "api.js"), "utf8");
const FEEDBACK_UI = fs.readFileSync(path.join(ROOT, "lib", "feedback", "ui", "feedback.js"), "utf8");

test("分享入口：页面保留检查更新和反馈的自然落点", () => {
  assert.match(ROUTE, /class="card support-card"/);
  assert.match(ROUTE, /关于提个醒/);
  assert.match(ROUTE, /updateUiHtml/);
  assert.match(ROUTE, /feedbackUiHtml/);
  assert.match(ROUTE, /id="feedback-entry"/);
  assert.match(ROUTE, /aria-haspopup="dialog"/);
  assert.match(ROUTE, /openerId: "feedback-entry"/);
});

test("分享入口：后端注册更新检查和反馈聊天路由", () => {
  assert.match(ROUTE, /app\.get\("\/api\/check-update"/);
  assert.match(ROUTE, /app\.post\("\/api\/feedback\/chat"/);
  assert.match(ROUTE, /app\.post\("\/api\/feedback\/chat\/close"/);
});

test("分享入口：反馈弹窗脱离会 hover 的卡片，保持 fixed 定位稳定", () => {
  assert.match(ROUTE, /反馈弹窗放在卡片外/);
  assert.match(ROUTE, /#fb-open-btn \{ display:none; \}/);
  assert.match(FEEDBACK_UI, /role="dialog" aria-modal="true"/);
  assert.match(FEEDBACK_UI, /Escape/);
});

test("分享入口：积木请求拿到原始 Response，避免二次 json 解析", () => {
  assert.match(ROUTE, /function rawApi\(path, init\)/);
  assert.match(ROUTE, /apiFetch: rawApi/);
  assert.match(ROUTE, /function api\(path, init\)\s*\{\s*return rawApi\(path, init\)/s);
});

test("分享入口：公开仓库未配置时明确降级，不伪造仓库地址", () => {
  assert.match(ROUTE, /const GITHUB_REPO = process\.env\.TIGEXING_GITHUB_REPO \|\| ""/);
  assert.match(ROUTE, /公开仓库还没配置/);
});
