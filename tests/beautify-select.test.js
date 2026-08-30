// 提个醒 · 自定义下拉组件回归
// 保护：页面所有原生 select 都被 beautifySelect 换肤（不再渲染 Windows 原生下拉面板），
// 面板与触发栏等宽对齐，change 事件链与动态选项同步不被后续改动弄丢。
// 组件本体在 lib/beautify-select/（plugin-kit 积木），页面通过读取文件内联。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = fs.readFileSync(path.join(ROOT, "routes", "api.js"), "utf8");
const STYLE = fs.readFileSync(path.join(ROOT, "lib", "style.js"), "utf8");
const DD_JS = fs.readFileSync(path.join(ROOT, "lib", "beautify-select", "beautify-select.js"), "utf8");
const DD_CSS = fs.readFileSync(path.join(ROOT, "lib", "beautify-select", "beautify-select.css"), "utf8");

test("自定义下拉：页面从 plugin-kit 积木文件读取内联组件", () => {
  assert.match(ROUTE, /lib\/beautify-select\//);
  assert.match(ROUTE, /beautifySelectCss/);
  assert.match(ROUTE, /beautifySelectJs/);
});

test("自定义下拉：组件 JS 保留值同步与 change 事件链", () => {
  assert.match(DD_JS, /function beautifySelect\(sel\)/);
  assert.match(DD_JS, /sel\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)/);
  assert.match(DD_JS, /sel\.selectedIndex = Number\(opt\.dataset\.i\)/);
});

test("自定义下拉：选中后触发栏立即更新（关闭时 updateLabel），不残留旧值", () => {
  assert.match(DD_JS, /function updateLabel\(\)/);
  assert.match(DD_JS, /wrap\.classList\.remove\("open"\);\n\s*updateLabel\(\)/);
  assert.match(DD_JS, /wrap\._ddRefresh = renderPanel/);
});

test("自定义下拉：外部只改 value 时提供 _ddRefresh 手动同步，页面回填已接入", () => {
  assert.match(DD_JS, /wrap\._ddRefresh = renderPanel/);
  assert.match(ROUTE, /if \(dd && dd\._ddRefresh\) dd\._ddRefresh\(\);/);
});

test("自定义下拉：组件 CSS 面板与触发栏等宽 + 选中态样式", () => {
  assert.match(DD_CSS, /\.dd-panel\s*\{[^}]*position: absolute;[^}]*left: 0;[^}]*right: 0;/s);
  assert.match(DD_CSS, /\.dd-opt\.on/);
  assert.match(DD_CSS, /\.dd-check/); // 选中项 ✓ 标记
  assert.match(DD_CSS, /::-webkit-scrollbar/); // 细滚动条，替代原生灰条
});

test("自定义下拉：穿模防护（展开提升容器层级，收起移除）", () => {
  assert.match(DD_JS, /findLiftTarget/);
  assert.match(DD_JS, /classList\.add\("dd-open-card"\)/);
  assert.match(DD_JS, /classList\.remove\("dd-open-card"\)/);
  assert.match(DD_JS, /all\[i\]\._ddClose/); // 打开新下拉时完整关闭旧的（含移除提升）
  assert.match(DD_CSS, /\.dd-open-card\s*\{[^}]*z-index: 30;/);
});

test("自定义下拉：静态配置三处下拉（供应商/模型/API 类型）统一换肤", () => {
  assert.match(ROUTE, /\["sel-refine-provider", "sel-refine-model", "sel-refine-api"\]\.forEach/);
  assert.match(ROUTE, /beautifySelect\(sel\)/);
});

test("自定义下拉：按助手个性化的动态下拉生成后也换肤", () => {
  assert.match(ROUTE, /list\.querySelectorAll\("select"\)\.forEach\(function \(sel\) \{ beautifySelect\(sel\); \}\)/);
});

test("自定义下拉：外部直接改 options/value 时 MutationObserver 同步面板", () => {
  assert.match(DD_JS, /new MutationObserver/);
  assert.match(DD_JS, /setTimeout\(renderPanel, 0\)/);
});

test("自定义下拉：窄屏 grid 布局选择器已适配 .dd 容器（含提醒时机列）", () => {
  assert.match(ROUTE, /\.snd-row \.dd\[data-kind="style"\] \{ grid-column: 1; \}/);
  assert.match(ROUTE, /\.snd-row \.dd\[data-kind="trigger"\] \{ grid-column: 2; \}/);
  assert.match(ROUTE, /\.snd-row \.dd\[data-kind="sound"\] \{ grid-column: 1 \/ -1; \}/);
});

test("自定义下拉：441～620px 窄卡片也切成两列，避免试听按钮横向溢出", () => {
  assert.match(ROUTE, /@media \(max-width: 620px\)/);
  assert.match(ROUTE, /\.snd-row \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); \}/);
  // 操作区（看看效果 + 隐藏）整行放下，按钮不溢出
  assert.match(ROUTE, /\.snd-row \.snd-actions \{ grid-column: 1 \/ -1; justify-self: start; width: 100%; \}/);
});

test("自定义下拉：风格 label 不带 emoji，窄栏能完整显示", () => {
  // 通知标题的 emoji 在 title 函数里硬编码，label 只用于设置页下拉
  assert.doesNotMatch(STYLE, /label: "[^\n]*\p{Extended_Pictographic}/u);
});

test("自定义下拉：支持 optgroup 二级分组（组头 + 收合）", () => {
  // 组件渲染 optgroup 为可点击组头，展开后渲染组内 option
  assert.match(DD_JS, /optgroup/);
  assert.match(DD_JS, /dd-group-head/);
  assert.match(DD_JS, /dd-group-body/);
  assert.match(DD_JS, /data-group/);
  assert.match(DD_JS, /collapsed/); // 收合状态记忆
  // 面板渲染时遍历 sel.children，识别 optgroup
  assert.match(DD_JS, /tagName\.toLowerCase\(\) === "optgroup"/);
  // 组头点击收合/展开
  assert.match(DD_JS, /\.dd-group-head/);
  // 样式
  assert.match(DD_CSS, /\.dd-group-head/);
  assert.match(DD_CSS, /\.dd-group-caret/);
  assert.match(DD_CSS, /\.dd-group-body/);
});

test("设置页：风格下拉按 optgroup 分组渲染", () => {
  // styleOptions 生成 <optgroup>，组标签取 groupLabel
  assert.match(ROUTE, /optgroup label=/);
  assert.match(ROUTE, /st\.groupLabel/);
  assert.match(ROUTE, /st\.group \|\| "normal"/);
  // 后端 /api/sounds 返回 styles 带 group 与 groupLabel
  assert.match(ROUTE, /group: s\.group \|\| "normal"/);
  assert.match(ROUTE, /groupLabel/);
});

test("设置页：动森风格都有独立预览样例（不 fallback 到默认文案）", () => {
  const acnhIds = ["ac_shizue", "ac_jack", "ac_jun", "ac_chacha", "ac_monica", "ac_judy", "ac_ankha", "ac_zucker", "ac_nook", "ac_timmy"];
  for (const id of acnhIds) {
    assert.match(ROUTE, new RegExp(id + ": "), id + " 有专属预览样例");
  }
});

test("设置页：助手显示/隐藏收敛到「管理助手」勾选控制", () => {
  // 管理助手弹层：全量助手 + 勾选框（勾=显示，不勾=隐藏）
  assert.match(ROUTE, /btn-manage-hidden/);
  assert.match(ROUTE, /data-visible/);
  assert.match(ROUTE, /hide-check-box/);
  // 行内不再有独立隐藏按钮（隐藏管理只用一次，收敛进弹层）
  assert.doesNotMatch(ROUTE, /data-hide/);
  // 隐藏接口 + 恢复接口 + 全量助手接口
  assert.ok(ROUTE.includes("/api/agents/hide"), "有隐藏接口");
  assert.ok(ROUTE.includes("/api/agents/unhide"), "有恢复接口");
  assert.ok(ROUTE.includes("/api/agents/all"), "有全量助手接口");
  // 勾选变化实时保存：勾上=unhide，不勾=hide
  assert.match(ROUTE, /visible \? "\/api\/agents\/unhide" : "\/api\/agents\/hide"/);
  // /api/sounds 按隐藏名单过滤 agents，并返回 hiddenAgents
  assert.match(ROUTE, /\.filter\(/);
  assert.match(ROUTE, /hiddenAgents: cfg\.hiddenAgents/);
});
