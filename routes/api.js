// 提个醒 · 路由
// 提供：
//   1. /page — 设置页面（服务端渲染，坑 41；前端 api() 带 token 凭证，坑 6）
//   2. GET  /api/config — 读配置
//   3. POST /api/config — 存配置（局部更新）
//   4. 个性化：GET /api/sounds / POST /api/sounds/assign / POST /api/agents/style / POST /api/sound/preview
//   5. 分享版入口：GET /api/check-update / POST /api/feedback/chat(+close)
//
// v0.2.0：页面整体重做（修复 api() 无凭证按钮全废）；删合并间隔设置；删通知历史
// v0.3.0：删重要关键词；新增按助手通知风格（default/plain/cheerful/gentle），设置页自由组合 风格+音效
// v0.3.1：删通知样式选择器（固定带头像）；删试一试卡片与 /api/test；页面翻新为纸感手帐风

import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { createConfigManager } from "../lib/config.js";
import { sendToast } from "../lib/toast.js";
import { listSounds, resolveSound, soundsDir } from "../lib/sounds.js";
import { listAgentsFromDisk } from "../lib/agents.js";
import { resolveAgentAvatar } from "../lib/agent-avatar.js";
import { getStyle, getStyleIds } from "../lib/style.js";
import { biaoqingbaoInstalled, resolveHanaHome } from "../lib/dialect-links.js";
import { ModelConfig } from "../lib/model-config/index.js";
import { listHanaTextModels } from "../lib/hana-models.js";
import { UpdateChecker } from "../lib/update-checker/index.js";
import { Feedback } from "../lib/feedback/index.js";
// 副作用导入：让服务端能生成积木 UI 的 HTML；浏览器端会在页面脚本里再执行一份。
import "../lib/update-checker/ui/update-checker.js";
import "../lib/feedback/ui/feedback.js";

const HANA_HOME = process.env.HANA_HOME || path.join(homedir(), ".hanako");
// 分享版默认仓库：发布后固定指向公开仓库；环境变量可覆盖（测试/自用换仓库用）
const GITHUB_REPO = process.env.TIGEXING_GITHUB_REPO || "moononnn/Hanako-tigexing";

// 试看示例：每个风格一条接近真实回复长度的句子（故意超过截断线，能看到截断/省略号效果）
const PREVIEW_SAMPLES = {
  default: "好呀，我把刚才说的方案整理成文档发给你啦，你先看看合不合适，有什么想调整的地方随时跟我说就行～",
  plain: "会议纪要已生成，共 3 页，重点在第 2 页的预算部分，记得核对数据哦，有疑问随时喊我",
  cheerful: "哈哈哈哈笑死我了！！你怎么这么会啊，这个操作我直接看呆，下次我也要试试！！",
  gentle: "记得喝水呀，工作再忙也要照顾好自己，我一直在呢，别太累了，有什么事随时叫我就好～",
  sister: "我跟你说，刚看到个超有意思的东西，你肯定也喜欢，快去看看，错过就没了",
  epistle: "今日诸事已定，文稿亦已寄达，若有不明之处，随时问我即好，勿要客气",
  morse: "好呀，方案我整理好了，你先看看合不合适，有问题随时说～",
  glitch: "这个接口报错了，我先查一下日志，可能是参数格式的问题，稍等哈",
  mojibake: "文件我收到了，内容有点问题，我重新处理一下再发给你哈",
  biz: "周末的安排我做了三版方案，第一版性价比最高，你看下要不要按这个来",
  dh_dongbei: "我寻思这个方案整体没毛病，就是流程有点绕，再捋捋就利索了，你看咋整",
  dh_henan: "中，就这么办，恁看还有啥要改嘞，俺再去弄",
  dh_shanghai: "我看了下，整体邪气好，就是第三段流程有点绕，数据校验提到前头要好点，侬讲伐",
  dh_cantonese: "我睇过晒啦，整体冇得顶，就系第三段个流程有啲绕，数据校验摆前边会好啲，你话呢",
  dh_taiwan: "我觉得整体超赞的欸，就是第三段流程有点绕，数据校验放前面会更好，你觉得呢",
  dh_sichuan: "我看了哈，整体没得啥子大问题，就是第三段的流程有点绕，数据校验提到前面要好点，你看要得不",
  dh_shaanxi: "我看了下，整体嫽咋咧，就是第三段流程有点绕，数据校验搁前头美得很，你觉得咋样么",
  dh_beijing: "我寻思着整体倍儿地道，就是第三段流程有点儿绕，数据校验挪前边儿正合适，您说呢",
  dh_xinjiang: "我看了个撒，整体歹得很，就是第三段流程有点绕，数据校验放前面歹，你看咋样撒",
  userstyle: "这个方案我觉得可以，就按这个来吧，有问题随时跟我说"
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default function (app, ctx) {
  const { dataDir, pluginId, log } = ctx;

  const userHome = process.env["HOME"] || process.env["USERPROFILE"] || homedir();
  const pluginDir = ctx.pluginDir || path.join(userHome, ".hanako", "plugins", pluginId);
  const manifestPath = path.join(pluginDir, "manifest.json");
  let currentVersion = "0.0.0";
  try {
    currentVersion = String(JSON.parse(fs.readFileSync(manifestPath, "utf-8")).version || currentVersion);
  } catch { /* 页面仍可渲染，更新积木会给出友好降级 */ }
  const configManager = createConfigManager(ctx);

  // ── 文案润色模型配置（三档，Key 加密存插件数据目录） ──
  const refineCfgFile = path.join(dataDir, "refine-model.json");
  const refineStore = {
    getConfig: () => {
      try {
        return fs.existsSync(refineCfgFile) ? JSON.parse(fs.readFileSync(refineCfgFile, "utf-8")) : {};
      } catch { return {}; }
    },
    saveConfig: (mutator) => {
      const cfg = refineStore.getConfig();
      mutator(cfg);
      try { fs.writeFileSync(refineCfgFile, JSON.stringify(cfg, null, 2)); } catch { /* 写入失败不影响主流程 */ }
    }
  };
  const refineMc = new ModelConfig({ ctx, store: refineStore });
  refineMc.setHanaModelsProvider(listHanaTextModels);

  // ── 分享版通用入口：检查更新 + 反馈 ──
  const updateChecker = new UpdateChecker({ ctx, manifestPath });
  const feedback = new Feedback({
    ctx,
    config: {
      pluginName: "提个醒",
      manifestPath,
      repo: GITHUB_REPO,
      hanaVersion: ctx.hanaVersion || "",
    },
  });
  // 反馈沿用提个醒已经配置好的文案模型；没有自定义配置时，默认跟随当前助手。
  feedback.setModelProvider((messages) => refineMc.sample(messages, {
    temperature: 0.7,
    maxTokens: 800,
    timeoutMs: 30000,
    operation: "tigexing-feedback",
  }));

  // 积木 UI 服务端渲染资源：沿用现有手帐色板，只在这里做局部覆盖。
  const ddDir = fileURLToPath(new URL("../lib/beautify-select/", import.meta.url));
  const beautifySelectCss = fs.readFileSync(path.join(ddDir, "beautify-select.css"), "utf-8");
  const beautifySelectJs = fs.readFileSync(path.join(ddDir, "beautify-select.js"), "utf-8");
  const updateUiDir = fileURLToPath(new URL("../lib/update-checker/ui/", import.meta.url));
  const feedbackUiDir = fileURLToPath(new URL("../lib/feedback/ui/", import.meta.url));
  const updateUiCss = fs.readFileSync(path.join(updateUiDir, "update-checker.css"), "utf-8");
  const updateUiJs = fs.readFileSync(path.join(updateUiDir, "update-checker.js"), "utf-8");
  const feedbackUiCss = fs.readFileSync(path.join(feedbackUiDir, "feedback.css"), "utf-8");
  const feedbackUiJs = fs.readFileSync(path.join(feedbackUiDir, "feedback.js"), "utf-8");
  const updateUiHtml = globalThis.updateCheckerHtml ? globalThis.updateCheckerHtml() : "";
  const feedbackUiHtml = globalThis.feedbackHtml ? globalThis.feedbackHtml() : "";

  // ============================================================
  // 页面（服务端渲染完整 HTML）
  // ============================================================
  app.get("/page", (c) => {
    const cfg = configManager.get();
    const qh = cfg.quietHours;
    const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>提个醒</title>
<style>
  :root {
    --bg: #EDF2EB;            /* 淡薄荷纸底 */
    --card: #FBFCF8;          /* 米白卡片 */
    --ink: #454B43;           /* 暖墨绿字 */
    --ink-soft: #6E7770;      /* 柔和灰绿（略深，提升小字号可读性） */
    --accent: #5DAE8E;        /* 薄荷绿主 */
    --accent-deep: #4A9277;
    --accent-soft: #E4F0EA;
    --pink: #E89BB0;          /* 樱花粉点缀 */
    --pink-soft: #FBEDF1;
    --line: rgba(93,122,107,.20);
    --line-soft: rgba(93,122,107,.12);
    --warn: #A77947;
    --warn-soft: #FBF3E4;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--ink);
    font-family: "LXGW WenKai", "霞鹜文楷", "Kaiti SC", "KaiTi", "Microsoft YaHei", serif;
    padding: 22px 18px 40px; max-width: 560px; margin: 0 auto;
    background-image: radial-gradient(circle at 12% 8%, rgba(93,174,142,.14) 0, transparent 110px),
                      radial-gradient(circle at 90% 24%, rgba(232,155,176,.12) 0, transparent 120px);
  }
  .card {
    background: var(--card); border: 1px solid var(--line-soft); border-radius: 20px;
    padding: 18px 18px 16px; margin-bottom: 16px;
    box-shadow: 0 3px 14px rgba(93,122,107,.07);
    transition: box-shadow .18s ease, transform .18s ease;
  }
  .card:hover { box-shadow: 0 6px 20px rgba(93,122,107,.11); transform: translateY(-1px); }
  .card h2 { font-size: 15.5px; font-weight: 600; margin-bottom: 13px; display: flex; align-items: center; gap: 7px; }
  .card h2::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  .hint { font-size: 14px; color: var(--ink-soft); line-height: 1.8; font-family: "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif; }
  input[type="text"], input[type="time"], select {
    border: 1px solid var(--line); border-radius: 10px; background: var(--card);
    padding: 8px 11px; font-size: 14px; color: var(--ink); font-family: inherit;
  }
  select {
    appearance: none; -webkit-appearance: none; -moz-appearance: none;
    min-width: 0; min-height: 38px; padding: 8px 36px 8px 12px;
    line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background-color: var(--card);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 14 14' fill='none'%3E%3Cpath d='M3.25 5.25 7 9l3.75-3.75' stroke='%234A9277' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 11px center; background-size: 14px 14px;
    cursor: pointer; transition: border-color .16s, background-color .16s, box-shadow .16s;
    color-scheme: light;
  }
  select:hover { border-color: var(--accent); background-color: var(--accent-soft); }
  select:disabled { opacity: .6; cursor: default; }
  select option { background: var(--card); color: var(--ink); }
  input[type="time"] { width: 130px; }
  input:focus { outline: 2px solid rgba(93,174,142,.35); border-color: var(--accent); }
  select:focus { outline: 2px solid rgba(93,174,142,.35); outline-offset: 1px; border-color: var(--accent); }
  .switch {
    width: 46px; height: 25px; border-radius: 13px; border: 1px solid var(--line);
    background: #E7EDE5; position: relative; cursor: pointer; transition: background .2s, border-color .2s; flex-shrink: 0;
  }
  .switch::after {
    content: ""; position: absolute; top: 2px; left: 2px; width: 19px; height: 19px;
    border-radius: 50%; background: #FFF; transition: left .2s; box-shadow: 0 1px 3px rgba(0,0,0,.15);
  }
  .switch.on { background: var(--pink); border-color: var(--pink); }
  .switch.on::after { left: 23px; }
  button {
    font-family: inherit; border: 1px solid var(--line); border-radius: 11px; cursor: pointer;
    font-size: 14px; padding: 9px 17px; background: var(--card); color: var(--ink); transition: all .16s;
  }
  button:hover { border-color: var(--accent); color: var(--accent-deep); }
  button:active { transform: scale(.97); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #FBFFFC; width: 100%; padding: 12px; font-size: 15px; letter-spacing: 2px; }
  button.primary:hover { background: var(--accent-deep); border-color: var(--accent-deep); color: #FBFFFC; }
  .btn-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .seg { display: flex; flex-direction: column; gap: 5px; }
  .mode-block { margin-bottom: 14px; }
  .mode-block:last-child { margin-bottom: 0; }
  .mode-name { font-size: 16px; font-weight: 600; color: var(--accent-deep); margin-bottom: 6px; }
  .mode-name::before { content: "✧ "; }
  .seg-btn {
    border: 1px solid var(--line); border-radius: 12px; padding: 11px 15px;
    font-size: 15.5px; font-weight: 400; background: var(--card); color: var(--ink); cursor: pointer;
    font-family: inherit; transition: all .16s; text-align: left;
  }
  .seg-btn:hover { border-color: var(--accent); }
  .seg-btn.on { background: var(--accent); border-color: var(--accent); color: #FBFFFC; }
  .seg-btn .seg-desc { display: block; font-size: 13.5px; opacity: 1; margin-top: 3px; color: var(--ink-soft); font-family: "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif; }
  .seg-btn.on .seg-desc { opacity: 1; color: rgba(255,255,255,.95); }
  .seg-inline { display: flex; gap: 10px; }
  .seg-inline .seg-btn { flex: 1; text-align: center; padding: 11px 6px; }
  .snd-folder { margin-bottom: 8px; }
  .snd-folder-label {
    display: block; font-size: 13.5px; font-weight: 600; color: var(--ink); margin-bottom: 5px;
  }
  .snd-folder-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .snd-head, .snd-row {
    display: grid;
    grid-template-columns: minmax(60px, .8fr) minmax(136px, 1fr) minmax(120px, 1.4fr) minmax(82px, auto);
    gap: 8px; align-items: center;
  }
  .snd-row {
    padding: 8px 2px; border-bottom: 1px dashed var(--line-soft);
  }
  .snd-row:last-child { border-bottom: none; }
  .snd-row .who { font-size: 14.5px; font-weight: 600; min-width: 0; }
  .snd-head {
    padding: 2px 2px 6px; font-size: 13px; color: var(--ink-soft); font-weight: 600;
    font-family: "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  .snd-head .col-style, .snd-head .col-sound { min-width: 0; }
  .snd-head .col-action { min-width: 82px; }
  .snd-row .dd-trigger {
    min-height: 36px;
    padding: 7px 10px; font-size: 13.5px;
    background-color: var(--card);
  }
  .snd-row .mini { min-width: 82px; font-size: 13px; padding: 6px 13px; border-radius: 999px; white-space: nowrap; }
  /* ── 自定义下拉组件（plugin-kit beautify-select，从 lib/beautify-select/ 读取内联） ── */
  ${beautifySelectCss}
  @media (max-width: 440px) {
    .snd-head { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .snd-head .who, .snd-head .col-action { display: none; }
    .snd-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .snd-row .who { grid-column: 1 / -1; }
    .snd-row .dd[data-kind="style"] { grid-column: 1; }
    .snd-row .dd[data-kind="sound"] { grid-column: 2; }
    .snd-row .mini { grid-column: 1 / -1; justify-self: start; }
  }
  .tip-line { font-size: 13.5px; color: var(--ink-soft); min-height: 20px; margin-top: 9px; font-family: "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif; }
  .tip-ok { color: var(--accent-deep); font-weight: 600; }
  .tip-err { color: #C96A6A; font-weight: 600; }
  .empty { color: var(--ink-soft); font-size: 14px; text-align: center; padding: 15px 0; font-family: "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif; }
  .footer { text-align: center; color: var(--ink-soft); font-size: 13px; margin-top: 6px; letter-spacing: 1.5px; }
  /* 全局保存反馈闪条 */
  .flash {
    position: fixed; top: 18px; left: 50%; transform: translateX(-50%) translateY(-10px);
    background: var(--ink); color: #F7FAF4; font-size: 13.5px; letter-spacing: .5px;
    padding: 9px 19px; border-radius: 999px; box-shadow: 0 6px 18px rgba(60,70,62,.2);
    opacity: 0; pointer-events: none; transition: opacity .22s ease, transform .22s ease; z-index: 99;
    white-space: nowrap; max-width: 86vw; overflow: hidden; text-overflow: ellipsis;
  }
  .flash.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .flash.flash-ok { background: var(--accent-deep); }
  .flash.flash-err { background: #C96A6A; }

  /* plugin-kit：检查更新 + 反馈，沿用提个醒自己的薄荷纸感 */
  ${updateUiCss}
  ${feedbackUiCss}
  .support-card { padding-bottom: 15px; }
  .support-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
  .support-head h2 { margin-bottom: 4px; }
  .support-version { flex-shrink:0; color:var(--accent-deep); background:var(--accent-soft); border:1px dashed var(--line); border-radius:999px; padding:5px 10px; font-size:13px; font-family:"Poppins", "Noto Sans SC", system-ui, sans-serif; }
  .support-actions { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; align-items:start; margin-top:13px; }
  .support-actions .uc-wrap { min-width:0; gap:7px; }
  .support-actions .uc-btn,
  .support-actions .support-feedback-btn { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:11px; background:var(--card); color:var(--ink); font-family:inherit; font-size:14px; cursor:pointer; transition:all .16s; }
  .support-actions .uc-btn:hover,
  .support-actions .support-feedback-btn:hover { border-color:var(--accent); color:var(--accent-deep); background:var(--accent-soft); }
  .support-actions .uc-result,
  .support-actions .uc-link { flex-basis:100%; min-width:0; font-size:13px; line-height:1.55; color:var(--ink-soft); }
  .support-actions .uc-result:empty { display:none; }
  .support-actions .uc-link { color:var(--accent-deep); text-decoration:none; }
  .support-actions .uc-link:hover { text-decoration:underline; }
  .support-actions .support-feedback-btn { grid-column:2; }
  #fb-open-btn { display:none; }
  .fb-modal-mask { background:rgba(69, 75, 67, .20); }
  .fb-modal-panel { background:var(--card); border:1px dashed var(--line); border-radius:20px; box-shadow:0 16px 36px rgba(69,75,67,.16); }
  .fb-modal-head, .fb-input-row, .fb-actions { border-color:var(--line); border-style:dashed; }
  .fb-modal-title { color:var(--accent-deep); font-family:inherit; }
  .fb-modal-close { color:var(--ink-soft); }
  .fb-send-btn, .fb-btn-primary { background:var(--accent); border-color:var(--accent); border-radius:999px; }
  .fb-send-btn:hover:not(:disabled), .fb-btn-primary:hover { background:var(--accent-deep); }
  .fb-btn, .fb-open-btn { border-radius:999px; }
  .support-feedback-btn { display:flex; align-items:center; justify-content:center; gap:7px; }
  .support-entry-icon { width:18px; height:18px; flex-shrink:0; }
  @media (max-width: 420px) { .support-actions { grid-template-columns:1fr; } .support-actions .support-feedback-btn { grid-column:auto; } }
</style>
</head>
<body>
  ${cfg.chatTrigger !== "never" || cfg.scheduledTrigger !== "never" || cfg.patrolTrigger !== "never" ? `
  <div class="card" style="border-color:var(--warn);background:var(--warn-soft)">
    <h2>小提示</h2>
    <div class="hint">提个醒已接管 <b>聊天回复完成 / 计划任务完成 / 巡检完成</b> 三项提醒。为避免双弹，记得在 Hana 设置 → <b>通用</b> → 通知 里把这三项都设为 <b>从不</b>。</div>
  </div>
  ` : ""}

  <div class="card">
    <h2>提醒时机</h2>

    <div class="mode-block">
      <div class="mode-name">聊天回复完成</div>
      <div class="seg" id="seg-chat">
        <button class="seg-btn ${cfg.chatTrigger === "always" ? "on" : ""}" data-trigger="always">总是提醒<span class="seg-desc">当前窗口也提醒，任何回复完成都弹</span></button>
        <button class="seg-btn ${cfg.chatTrigger === "whenSessionUnfocused" ? "on" : ""}" data-trigger="whenSessionUnfocused">焦点不在该聊天时<span class="seg-desc">正在看的窗口完成时不打扰，其他窗口完成时提醒（推荐）</span></button>
        <button class="seg-btn ${cfg.chatTrigger === "whenUnfocused" ? "on" : ""}" data-trigger="whenUnfocused">焦点不在 HanaAgent 时<span class="seg-desc">HanaAgent 在前台就不提醒，切到别的应用才提醒</span></button>
        <button class="seg-btn ${cfg.chatTrigger === "never" ? "on" : ""}" data-trigger="never">从不提醒<span class="seg-desc">关掉弹窗，需要时再打开</span></button>
      </div>
    </div>

    <div class="mode-block">
      <div class="mode-name">计划任务完成</div>
      <div class="seg" id="seg-scheduled">
        <button class="seg-btn ${cfg.scheduledTrigger === "always" ? "on" : ""}" data-trigger="always">总是提醒<span class="seg-desc">任务跑完就弹，不管 Hana 在不在前台</span></button>
        <button class="seg-btn ${cfg.scheduledTrigger === "whenUnfocused" ? "on" : ""}" data-trigger="whenUnfocused">焦点不在 HanaAgent 时<span class="seg-desc">正在用 Hana 就不提醒，切走才提醒（推荐）</span></button>
        <button class="seg-btn ${cfg.scheduledTrigger === "never" ? "on" : ""}" data-trigger="never">从不提醒<span class="seg-desc">计划任务跑完不打扰</span></button>
      </div>
    </div>

    <div class="mode-block">
      <div class="mode-name">巡检完成</div>
      <div class="seg" id="seg-patrol">
        <button class="seg-btn ${cfg.patrolTrigger === "always" ? "on" : ""}" data-trigger="always">总是提醒<span class="seg-desc">巡检跑完就弹，不管 Hana 在不在前台</span></button>
        <button class="seg-btn ${cfg.patrolTrigger === "whenUnfocused" ? "on" : ""}" data-trigger="whenUnfocused">焦点不在 HanaAgent 时<span class="seg-desc">正在用 Hana 就不提醒，切走才提醒（推荐）</span></button>
        <button class="seg-btn ${cfg.patrolTrigger === "never" ? "on" : ""}" data-trigger="never">从不提醒<span class="seg-desc">巡检跑完不打扰</span></button>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>按助手个性化</h2>
    <div class="hint" style="margin-bottom:8px">每个助手可以配不同的音效和通知风格。风格只改变标题语气和正文包装，正文永远显示助手原话，不改写不生成；音效用你放进来的音频文件。</div>
    ${biaoqingbaoInstalled(resolveHanaHome())
      ? '<div class="hint" style="margin-bottom:8px">🎁 已解锁联动风格：装了表情包插件，风格列表末尾多出九种方言（东北话/河南话/上海话/粤语/台湾腔/四川话/陕西话/北京话/新疆话）+ 学我说话，方言文案跟着表情包自动更新。</div>'
      : '<div class="hint" style="margin-bottom:8px">🎁 装「表情包」插件可解锁更多通知风格：九种方言（东北话/四川话/粤语…）+ 学我说话。没装也不影响，现有风格照常用。</div>'}
    <div class="snd-folder">
      <label class="snd-folder-label" for="in-snd-dir">音效文件夹</label>
      <div class="snd-folder-row">
        <input type="text" id="in-snd-dir" placeholder="留空 = 默认目录" style="flex:1;min-width:200px">
        <button id="btn-pick-snd-dir">选择文件夹…</button>
        <button id="btn-save-snd-dir">保存</button>
      </div>
      <div class="hint" style="margin-top:4px">默认在插件数据目录里，想自己挑地方放音效（比如放工作台、放 D 盘），点「选择文件夹…」或者手动填路径都行，留空恢复默认。填好保存后，把音频文件放进去，点「刷新音效」就能选。</div>
    </div>
    <div class="btn-row" style="margin-bottom:4px">
      <button id="btn-refresh-sounds">刷新音效</button>
      <span class="hint" id="snd-tip"></span>
    </div>
    <div id="snd-list"></div>
  </div>

  <div class="card">
    <h2>文案润色（可选）</h2>
    <div class="hint" style="margin-bottom:8px">标题和正文由模型改写，真正改原话（温柔风：接口报错了 → 接口报错啦，别担心～）。开启后通知会晚 1-2 秒，失败自动回退规则版。</div>
    <div class="btn-row" style="justify-content:space-between;margin-bottom:10px">
      <div>
        <div style="font-size:14px">开启润色</div>
        <div class="hint">仅对语气型风格生效（跟随默认/简洁/活泼/温柔/黑话）</div>
      </div>
      <div class="switch ${cfg.refineEnabled ? "on" : ""}" id="sw-refine"></div>
    </div>
    <div id="refine-box" style="${cfg.refineEnabled ? "" : "opacity:.45;pointer-events:none;"}">
      <div class="seg-inline" id="seg-refine-source" style="margin-bottom:10px">
        <button class="seg-btn" data-source="agent">跟随助手<span class="seg-desc">零配置，用当前助手的模型</span></button>
        <button class="seg-btn" data-source="hana">选模型<span class="seg-desc">从 Hana 已配置的模型里挑</span></button>
        <button class="seg-btn" data-source="custom">自定义 API<span class="seg-desc">自己填地址和 Key</span></button>
      </div>
      <div class="hint" id="refine-agent-note" style="margin-bottom:8px;display:none">跟随当前助手的模型，什么都不用配～</div>
      <div id="refine-hana-box" style="display:none" class="btn-row">
        <select id="sel-refine-provider" style="flex:1"><option value="">选择供应商…</option></select>
        <select id="sel-refine-model" style="flex:1"><option value="">选择模型…</option></select>
      </div>
      <div id="refine-custom-box" style="display:none">
        <input type="text" id="in-refine-base" placeholder="API 地址，如 https://api.openai.com/v1" style="width:100%;box-sizing:border-box;margin-bottom:6px">
        <div class="btn-row" style="margin-bottom:6px">
          <select id="sel-refine-api" style="flex:1">
            <option value="openai-completions">OpenAI 兼容（/chat/completions）</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic-messages">Anthropic（/v1/messages）</option>
          </select>
          <input type="password" id="in-refine-key" placeholder="API Key" style="flex:1">
        </div>
        <input type="text" id="in-refine-model" placeholder="模型名，如 gpt-4o-mini" style="width:100%;box-sizing:border-box">
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="primary" id="btn-refine-save">保存配置</button>
        <button id="btn-refine-test">测试一下</button>
        <span class="hint" id="refine-tip"></span>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>静默时段</h2>
    <div class="btn-row" style="justify-content:space-between;margin-bottom:10px">
      <div>
        <div style="font-size:14px">静默时段内不弹窗</div>
        <div class="hint">适合睡觉、开会，不想被吵醒的时候</div>
      </div>
      <div class="switch ${qh.enabled ? "on" : ""}" id="sw-quiet"></div>
    </div>
    <div class="btn-row" id="quiet-times" style="${qh.enabled ? "" : "opacity:.45;pointer-events:none;"}">
      <input type="time" id="in-qstart" value="${escapeHtml(qh.start || "22:00")}">
      <span style="color:var(--ink-soft)">至</span>
      <input type="time" id="in-qend" value="${escapeHtml(qh.end || "08:00")}">
      <span class="hint">（支持跨午夜）</span>
    </div>
  </div>

  <div class="card support-card">
    <div class="support-head">
      <div>
        <h2>关于提个醒</h2>
        <div class="hint">有新版本就来这里看看，遇到问题也可以直接和反馈小助手聊聊。</div>
      </div>
      <span class="support-version">v${escapeHtml(currentVersion)}</span>
    </div>
    <div class="support-actions">
      ${updateUiHtml}
      <button type="button" class="support-feedback-btn" id="feedback-entry" aria-controls="fb-modal" aria-haspopup="dialog" title="有问题想说？跟反馈小助手聊聊">
        <svg class="support-entry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.6 0-3.1-.4-4.4-1.2L3 20l1.2-5.1A8.5 8.5 0 1 1 21 11.5z"/></svg>
        <span>反馈</span>
      </button>
    </div>
  </div>
  ${feedbackUiHtml}

  <div class="footer">提个醒 · moononnn & 小花</div>
  <div class="flash" id="flash" role="status"></div>

<script>window.__CFG__ = ${cfgJson};</script>
<script>
${beautifySelectJs}
</script>
<script>
${updateUiJs}
${feedbackUiJs}
(function () {
  window.parent && window.parent.postMessage({ protocol: "hana.plugin.ui", version: 1, kind: "event", type: "hana.ready" }, "*");

  var cfg = window.__CFG__ || {};
  var params = new URLSearchParams(window.location.search || "");
  var surfaceSession = params.get("pluginSurfaceSession");
  var legacyToken = params.get("token");

  // 插件页面里的 fetch 必须带凭证（token 或 surfaceSession），否则被宿主拒绝（坑 6）
  // rawApi 保留原始 Response 给积木组件；api 则给现有页面逻辑统一返回 JSON 对象。
  function rawApi(path, init) {
    var cleanPath = path.charAt(0) === "/" ? path.slice(1) : path;
    var request = Object.assign({}, init || {});
    var headers = Object.assign({}, request.headers || {});
    var url = "/api/plugins/tigexing/" + cleanPath;
    if (legacyToken) {
      url += "?token=" + encodeURIComponent(legacyToken);
    } else if (surfaceSession) {
      headers["X-Hana-Plugin-Surface-Session"] = surfaceSession;
    } else {
      return Promise.reject(new Error("缺少插件页面凭证"));
    }
    request.headers = headers;
    if (!request.signal) request.signal = AbortSignal.timeout(5000);
    return fetch(url, request);
  }

  function api(path, init) {
    return rawApi(path, init).then(function (r) {
      return r.json().catch(function () { return {}; });
    });
  }

  function bind(id, evt, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  }

  function showTip(id, text, ms) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (ms) setTimeout(function () { el.textContent = ""; }, ms);
  }

  // 页面内所有静态下拉（文案润色的供应商 / 模型 / API 类型）统一换肤
  // beautifySelect 组件本体由上方独立 script 块提供（plugin-kit beautify-select）
  ["sel-refine-provider", "sel-refine-model", "sel-refine-api"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) beautifySelect(el);
  });

  // 全局保存反馈闪条（顶部居中淡入淡出）
  var flashTimer = null;
  function flashTip(text, kind) {
    var el = document.getElementById("flash");
    if (!el) return;
    el.textContent = text;
    el.className = "flash show" + (kind === "ok" ? " flash-ok" : kind === "err" ? " flash-err" : "");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.className = "flash"; }, kind === "err" ? 3200 : 1800);
  }

  // ── 分享版入口积木：检查更新 + 反馈 ──
  function kitToast(text, isError) { flashTip(text, isError ? "err" : "ok"); }
  if (typeof bindUpdateChecker === "function") {
    bindUpdateChecker({ apiBase: "api/check-update", apiFetch: rawApi, onToast: kitToast });
  }
  if (typeof bindFeedback === "function") {
    bindFeedback({ apiBase: "api/feedback", apiFetch: rawApi, onToast: kitToast, openerId: "feedback-entry" });
  }
  // 反馈弹窗放在卡片外，避免卡片 hover 的 transform 改变 fixed 弹窗的定位。
  bind("feedback-entry", "click", function () {
    var btn = document.getElementById("fb-open-btn");
    if (btn) btn.click();
  });

  // ── 提醒时机（三项各自独立，跟 Hana 原版一致） ──
  var TRIGGER_FIELDS = {
    "seg-chat": "chatTrigger",
    "seg-scheduled": "scheduledTrigger",
    "seg-patrol": "patrolTrigger"
  };
  Object.keys(TRIGGER_FIELDS).forEach(function (segId) {
    var field = TRIGGER_FIELDS[segId];
    var seg = document.getElementById(segId);
    if (!seg) return;
    seg.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".seg-btn[data-trigger]") : null;
      if (!btn) return;
      cfg[field] = btn.dataset.trigger;
      seg.querySelectorAll(".seg-btn").forEach(function (b) {
        b.classList.toggle("on", b === btn);
      });
      var patch = {};
      patch[field] = cfg[field];
      api("/api/config", { method: "POST", body: JSON.stringify(patch) })
        .then(function () { flashTip("已保存 ✓", "ok"); })
        .catch(function () { flashTip("保存失败，看 Hana 日志", "err"); });
    });
  });

  // ── 静默时段 ──
  bind("sw-quiet", "click", function () {
    cfg.quietHours.enabled = !cfg.quietHours.enabled;
    var sw = document.getElementById("sw-quiet");
    var qt = document.getElementById("quiet-times");
    if (sw) sw.classList.toggle("on", cfg.quietHours.enabled);
    if (qt) {
      qt.style.opacity = cfg.quietHours.enabled ? "" : ".45";
      qt.style.pointerEvents = cfg.quietHours.enabled ? "" : "none";
    }
    api("/api/config", { method: "POST", body: JSON.stringify({ quietHours: cfg.quietHours }) })
      .catch(function () { flashTip("保存失败，看 Hana 日志", "err"); });
  });
  bind("in-qstart", "change", saveQuietTime);
  bind("in-qend", "change", saveQuietTime);
  function saveQuietTime() {
    var qs = document.getElementById("in-qstart");
    var qe = document.getElementById("in-qend");
    cfg.quietHours.start = (qs && qs.value) || "22:00";
    cfg.quietHours.end = (qe && qe.value) || "08:00";
    api("/api/config", { method: "POST", body: JSON.stringify({ quietHours: cfg.quietHours }) })
      .catch(function () { flashTip("保存失败，看 Hana 日志", "err"); });
  }

  // ── 按助手个性化（风格 + 音效） ──
  var sndData = { files: [], agents: [], assignments: {}, styleAssignments: {}, styles: [] };
  var esc = function (s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  var sndVal = function (a) { return sndData.assignments[a.id] || "default"; };
  var styleVal = function (a) { return sndData.styleAssignments[a.id] || "default"; };

  function styleOptions(a) {
    var opts = "";
    for (var i = 0; i < sndData.styles.length; i++) {
      var st = sndData.styles[i];
      var sel = styleVal(a) === st.id ? " selected" : "";
      opts += '<option value="' + esc(st.id) + '"' + sel + ">" + esc(st.label) + "</option>";
    }
    return opts;
  }

  function sndOptions(a) {
    var opts = '<option value="default">系统默认</option><option value="silent">静音</option>';
    for (var i = 0; i < sndData.files.length; i++) {
      var f = sndData.files[i];
      var sel = sndVal(a) === f ? " selected" : "";
      opts += '<option value="' + esc(f) + '"' + sel + ">" + esc(f) + "</option>";
    }
    return opts;
  }

  function loadSounds() {
    api("/api/sounds")
      .then(function (r) {
        sndData = {
          files: r.files || [],
          agents: r.agents || [],
          assignments: r.assignments || {},
          styleAssignments: r.styleAssignments || {},
          styles: r.styles || []
        };
        var dirIn = document.getElementById("in-snd-dir");
        if (dirIn) dirIn.value = r.customDir || "";
        var list = document.getElementById("snd-list");
        if (!list) return;
        if (sndData.agents.length === 0) {
          list.innerHTML = '<div class="empty">没有找到助手</div>';
          return;
        }
        var html = '<div class="snd-head"><span class="who"></span><span class="col-style">文案风格</span><span class="col-sound">音效</span><span class="col-action" aria-hidden="true"></span></div>';
        for (var i = 0; i < sndData.agents.length; i++) {
          var a = sndData.agents[i];
          html += '<div class="snd-row"><span class="who">' + esc(a.name) + "</span>" +
            '<select data-agent="' + esc(a.id) + '" data-kind="style">' + styleOptions(a) + "</select>" +
            '<select data-agent="' + esc(a.id) + '" data-kind="sound">' + sndOptions(a) + "</select>" +
            '<button class="mini" data-preview="' + esc(a.id) + '">看看效果</button></div>';
        }
        list.innerHTML = html;
        list.querySelectorAll("select").forEach(function (sel) { beautifySelect(sel); });
        list.querySelectorAll("select").forEach(function (sel) {
          sel.addEventListener("change", function () {
            var kind = sel.dataset.kind;
            var path = kind === "style" ? "/api/agents/style" : "/api/sounds/assign";
            api(path, {
              method: "POST",
              body: JSON.stringify({ agentId: sel.dataset.agent, value: sel.value })
            }).then(function (rr) {
              if (rr.ok && kind === "style") sndData.styleAssignments = rr.assignments || {};
              if (rr.ok && kind === "sound") sndData.assignments = rr.assignments || {};
              showTip("snd-tip", rr.ok ? "已保存 ✓" : "保存失败：" + (rr.error || "未知原因"), rr.ok ? 1500 : 3000);
            }).catch(function () { showTip("snd-tip", "保存失败", 3000); });
          });
        });
        list.querySelectorAll("[data-preview]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var aid = btn.dataset.preview;
            // 所见即所得：直接读下拉控件当前选中值（不等保存时序），没有对应控件才回退已保存配置
            var styleSel = list.querySelector('select[data-kind="style"][data-agent="' + aid + '"]');
            var soundSel = list.querySelector('select[data-kind="sound"][data-agent="' + aid + '"]');
            var styleValue = styleSel ? styleSel.value : (sndData.styleAssignments[aid] || "default");
            var value = soundSel ? soundSel.value : (sndData.assignments[aid] || "default");
            api("/api/sound/preview", {
              method: "POST",
              body: JSON.stringify({ agentId: aid, file: value === "default" ? "" : value, style: styleValue })
            }).then(function (rr) {
              showTip("snd-tip", rr.sent ? "弹了，听～" : "发送失败", 2500);
            }).catch(function () { showTip("snd-tip", "请求失败", 3000); });
          });
        });
      })
      .catch(function (e) { showTip("snd-tip", "加载失败：" + e.message, 4000); });
  }
  bind("btn-refresh-sounds", "click", loadSounds);
  loadSounds();

  // ── 自定义音效文件夹：保存后刷新音效列表（文件可能变了） ──
  bind("btn-save-snd-dir", "click", function () {
    var input = document.getElementById("in-snd-dir");
    var val = input ? input.value.trim() : "";
    showTip("snd-tip", "保存中…", 1500);
    api("/api/sounds/dir", {
      method: "POST",
      body: JSON.stringify({ dir: val })
    }).then(function (r) {
      if (!r || !r.ok) {
        showTip("snd-tip", (r && r.error) || "保存失败", 4000);
        return;
      }
      showTip("snd-tip", "已保存", 2000);
      loadSounds(); // 刷新目录显示 + 音效列表（文件可能变了）
    }).catch(function (e) { showTip("snd-tip", "保存失败：" + e.message, 4000); });
  });

  // ── 原生文件夹选择：弹 Windows 选择框 → 自动保存 → 刷新 ──
  bind("btn-pick-snd-dir", "click", function () {
    var input = document.getElementById("in-snd-dir");
    var cur = input ? input.value.trim() : "";
    showTip("snd-tip", "请在弹出的窗口里选文件夹…", 4000);
    api("/api/sounds/pick-folder", {
      method: "POST",
      body: JSON.stringify({ initial: cur })
    }).then(function (r) {
      if (!r || !r.ok) {
        showTip("snd-tip", (r && r.error) || "没有选择文件夹", 3000);
        return;
      }
      showTip("snd-tip", "已切换音效文件夹", 2000);
      loadSounds(); // 回显新路径 + 刷新音效列表
    }).catch(function (e) { showTip("snd-tip", "选择失败：" + e.message, 3000); });
  });

  // ── 文案润色（可选高级档）：开关 + 三档模型配置 + 显式保存 + 测试 ──
  var refineState = { source: "agent", enabled: false, hanaModel: {} };
  // sticky=true 时提示常驻（测试结果要一直能看到），普通提示 4 秒自动清
  function refineSetTip(text, kind, sticky) {
    var el = document.getElementById("refine-tip");
    if (!el) return;
    el.textContent = text || "";
    el.className = "hint" + (kind === "ok" ? " tip-ok" : kind === "err" ? " tip-err" : "");
    if (!sticky && text) setTimeout(function () { el.textContent = ""; el.className = "hint"; }, 4000);
  }

  function refineSetEnabled(on) {
    refineState.enabled = on;
    var sw = document.getElementById("sw-refine");
    var box = document.getElementById("refine-box");
    if (sw) sw.classList.toggle("on", on);
    if (box) box.style.cssText = on ? "" : "opacity:.45;pointer-events:none;";
  }

  function refineRenderSource() {
    var note = document.getElementById("refine-agent-note");
    var hanaBox = document.getElementById("refine-hana-box");
    var customBox = document.getElementById("refine-custom-box");
    if (note) note.style.display = refineState.source === "agent" ? "" : "none";
    if (hanaBox) hanaBox.style.display = refineState.source === "hana" ? "" : "none";
    if (customBox) customBox.style.display = refineState.source === "custom" ? "" : "none";
    var seg = document.getElementById("seg-refine-source");
    if (seg) seg.querySelectorAll(".seg-btn").forEach(function (b) {
      b.classList.toggle("on", b.dataset.source === refineState.source);
    });
  }

  function refineFillModels(selectedModelId) {
    var pid = document.getElementById("sel-refine-provider").value;
    var modelSel = document.getElementById("sel-refine-model");
    if (!pid || !modelSel) return;
    api("/api/refine/hana-models").then(function (r) {
      var p = null;
      for (var i = 0; i < (r.models || []).length; i++) {
        if (r.models[i].providerId === pid) { p = r.models[i]; break; }
      }
      var html = '<option value="">选择模型…</option>';
      for (var i = 0; i < (p ? p.models : []).length; i++) {
        html += '<option value="' + p.models[i].id + '">' + p.models[i].name + "</option>";
      }
      modelSel.innerHTML = html;
      if (selectedModelId) modelSel.value = selectedModelId;
    }).catch(function () {});
  }

  function refineLoadHanaModels() {
    api("/api/refine/hana-models").then(function (r) {
      var sel = document.getElementById("sel-refine-provider");
      if (!sel || !r.models || !r.models.length) return;
      var html = '<option value="">选择供应商…</option>';
      for (var i = 0; i < r.models.length; i++) {
        html += '<option value="' + r.models[i].providerId + '">' + r.models[i].providerName + "</option>";
      }
      sel.innerHTML = html;
      if (refineState.hanaModel && refineState.hanaModel.providerId) {
        sel.value = refineState.hanaModel.providerId;
        refineFillModels(refineState.hanaModel.modelId);
      }
    }).catch(function () {});
  }

  function refineCollectPatch() {
    var patch = { modelSource: refineState.source };
    if (refineState.source === "hana") {
      patch.hanaModel = {
        providerId: document.getElementById("sel-refine-provider").value,
        modelId: document.getElementById("sel-refine-model").value
      };
    } else if (refineState.source === "custom") {
      patch.customModel = {
        baseUrl: document.getElementById("in-refine-base").value.trim(),
        apiKey: document.getElementById("in-refine-key").value,
        model: document.getElementById("in-refine-model").value.trim(),
        api: document.getElementById("sel-refine-api").value
      };
    }
    return patch;
  }

  function refineApplySaved(cfg) {
    refineState.hanaModel = (cfg && cfg.hanaModel) || {};
    var keyEl = document.getElementById("in-refine-key");
    if (keyEl) {
      keyEl.value = "";
      keyEl.placeholder = cfg && cfg.customModel && cfg.customModel.apiKey ? "已保存（留空不修改）" : "API Key";
    }
  }

  // 初始化：读开关 + 模型配置回填
  api("/api/refine").then(function (r) {
    if (!r || !r.config) return;
    refineState.enabled = !!r.enabled;
    refineState.source = r.config.source || "agent"; // 注意：sanitize 返回 source（不是 modelSource）
    refineState.hanaModel = r.config.hanaModel || {};
    refineSetEnabled(refineState.enabled);
    refineRenderSource();
    var cm = r.config.customModel || {};
    var base = document.getElementById("in-refine-base");
    var key = document.getElementById("in-refine-key");
    var model = document.getElementById("in-refine-model");
    var apiSel = document.getElementById("sel-refine-api");
    if (base) base.value = cm.baseUrl || "";
    if (key) key.placeholder = cm.apiKey ? "已保存（留空不修改）" : "API Key";
    if (model) model.value = cm.model || "";
    if (apiSel) {
      apiSel.value = cm.api || "openai-completions";
      // 外部改 select.value 不触发组件自动同步，手动刷新触发栏显示
      var dd = apiSel.closest ? apiSel.closest(".dd") : null;
      if (dd && dd._ddRefresh) dd._ddRefresh();
    }
    if (refineState.source === "hana") refineLoadHanaModels();
  }).catch(function () {});

  bind("sw-refine", "click", function () {
    var next = !refineState.enabled;
    api("/api/refine", { method: "POST", body: JSON.stringify({ enabled: next }) })
      .then(function (r) {
        if (r && r.ok) {
          refineState.enabled = !!r.enabled;
          refineSetEnabled(refineState.enabled);
          refineSetTip("已保存 ✓", "ok");
          if (refineState.enabled && refineState.source === "hana") refineLoadHanaModels();
        }
      }).catch(function () { refineSetTip("保存失败", "err"); });
  });

  var segRefine = document.getElementById("seg-refine-source");
  if (segRefine) {
    // 只切显示，不自动保存（点「保存配置」才落盘）
    segRefine.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".seg-btn[data-source]") : null;
      if (!btn) return;
      refineState.source = btn.dataset.source;
      refineRenderSource();
      if (refineState.source === "hana") refineLoadHanaModels();
    });
  }

  bind("sel-refine-provider", "change", function () { refineFillModels(); });
  bind("sel-refine-model", "change", function () { /* 值在保存时收集 */ });

  // 保存配置：一次提交当前表单值（Key 留空不覆盖已存）
  bind("btn-refine-save", "click", function () {
    api("/api/refine/model", { method: "POST", body: JSON.stringify(refineCollectPatch()) })
      .then(function (r) {
        if (r && r.ok) {
          refineApplySaved(r.config);
          refineSetTip("已保存 ✓", "ok");
        } else {
          refineSetTip("保存失败：" + ((r && r.error) || "未知错误"), "err", true);
        }
      }).catch(function () { refineSetTip("保存失败", "err"); });
  });

  // 测试一下：按钮态反馈 + 结果常驻显示（成功/失败都看得到）
  bind("btn-refine-test", "click", function () {
    var btn = document.getElementById("btn-refine-test");
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = "测试中…";
    refineSetTip("", "");
    api("/api/refine/test", { method: "POST", body: JSON.stringify({ source: refineState.source, patch: refineCollectPatch() }) })
      .then(function (r) {
        if (r && r.ok) {
          refineSetTip("✓ 测试成功啦！", "ok", true);
        } else {
          refineSetTip("✗ 失败：" + ((r && r.error) || "未知错误"), "err", true);
        }
      })
      .catch(function () { refineSetTip("✗ 请求失败", "err", true); })
      .then(function () { btn.disabled = false; btn.textContent = old; });
  });
})();
</script>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  });

  // ============================================================
  // API
  // ============================================================
  app.get("/api/config", (c) => {
    return c.json({ ok: true, config: configManager.get() });
  });

  app.post("/api/config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // 部分更新（patch）：只改传入字段，不重置未传字段
    configManager.patch(body);
    log?.info?.("[提个醒] 配置已保存", { keys: Object.keys(body) });
    return c.json({ ok: true, config: configManager.get() });
  });

  // ============================================================
  // 分享版入口：检查更新 + 反馈
  // ============================================================
  app.get("/api/check-update", async (c) => {
    if (!GITHUB_REPO) {
      const current = updateChecker.readCurrentVersion(manifestPath);
      return c.json({
        ok: true,
        hasUpdate: false,
        current,
        latest: current,
        latestTitle: "",
        releaseUrl: "",
        message: "公开仓库还没配置，等发布后这里就能自动检查更新啦",
      });
    }
    return c.json(await updateChecker.check({ repo: GITHUB_REPO, manifestPath }));
  });

  function syncFeedbackModelInfo() {
    try { feedback.setModelConfigInfo(refineMc.sanitize()); } catch { /* 脱敏信息只是辅助，不阻断反馈 */ }
  }
  app.post("/api/feedback/chat", async (c) => {
    syncFeedbackModelInfo();
    return c.json(await feedback.handleChat(await c.req.json().catch(() => ({}))));
  });
  app.post("/api/feedback/chat/close", async (c) => {
    return c.json(await feedback.handleClose(await c.req.json().catch(() => ({}))));
  });

  // ============================================================
  // 文案润色（可选高级档）：开关 + 三档模型配置 + 测试
  // ============================================================
  app.get("/api/refine", (c) => {
    return c.json({ ok: true, enabled: configManager.get().refineEnabled, config: refineMc.sanitize() });
  });

  app.post("/api/refine", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled === "boolean") {
      await configManager.patch({ refineEnabled: body.enabled });
      log?.info?.("[提个醒] 文案润色开关", { enabled: body.enabled });
    }
    return c.json({ ok: true, enabled: configManager.get().refineEnabled });
  });

  app.post("/api/refine/model", async (c) => c.json(await refineMc.handleSave(await c.req.json().catch(() => ({})))));
  app.post("/api/refine/test", async (c) => c.json(await refineMc.handleTest(await c.req.json().catch(() => ({})))));
  app.get("/api/refine/hana-models", async (c) => c.json(await refineMc.handleHanaModels()));

  // ============================================================
  // 音效
  // ============================================================
  app.get("/api/sounds", (c) => {
    const cfg = configManager.get();
    return c.json({
      ok: true,
      dir: soundsDir(dataDir, cfg.soundDir),
      customDir: cfg.soundDir || "",
      files: listSounds(dataDir, cfg.soundDir),
      agents: listAgentsFromDisk(path.join(HANA_HOME, "agents")),
      styles: getStyleIds().map((id) => { const s = getStyle(id); return { id, label: s.label, desc: s.desc }; }),
      assignments: cfg.agentSounds || {},
      styleAssignments: cfg.agentStyles || {}
    });
  });

  // 自定义音效文件夹：留空恢复默认（插件数据目录 sounds/），非空必须是存在的绝对路径
  app.post("/api/sounds/dir", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = String(body.dir ?? "").trim();
    if (raw.length > 1024) return c.json({ ok: false, error: "路径太长了" });
    if (raw !== "" && !path.isAbsolute(raw)) return c.json({ ok: false, error: "要填绝对路径，比如 D:\\音效" });
    if (raw !== "") {
      let st = null;
      try { st = fs.statSync(raw); } catch { /* 不存在 */ }
      if (!st) return c.json({ ok: false, error: "文件夹不存在，先建好再填" });
      if (!st.isDirectory()) return c.json({ ok: false, error: "填的是文件，要选文件夹" });
    }
    await configManager.patch({ soundDir: raw });
    const cfg = configManager.get();
    return c.json({
      ok: true,
      dir: soundsDir(dataDir, cfg.soundDir),
      customDir: cfg.soundDir || "",
      files: listSounds(dataDir, cfg.soundDir)
    });
  });

  // 弹 Windows 原生文件夹选择框（PowerShell FolderBrowserDialog），选中即保存
  app.post("/api/sounds/pick-folder", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const initial = String(body.initial || "").trim();
    const ps1 = path.join(pluginDir, "lib", "pick-folder.ps1");
    if (!fs.existsSync(ps1)) return c.json({ ok: false, error: "缺少 pick-folder.ps1" });
    const picked = await new Promise((resolve) => {
      const child = spawn(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", ps1, "-InitialDir", initial],
        { windowsHide: true }
      );
      let out = "";
      child.stdout.on("data", (d) => { out += String(d); });
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(out.trim()));
      // 兜底：用户长时间不操作（对话框挂着），5 分钟后杀掉
      const killer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve(""); }, 300000);
      killer.unref?.();
    });
    if (!picked) return c.json({ ok: false, error: "没有选择文件夹" });
    let st = null;
    try { st = fs.statSync(picked); } catch { /* 不存在 */ }
    if (!st || !st.isDirectory()) return c.json({ ok: false, error: "选择的路径无效" });
    await configManager.patch({ soundDir: picked });
    const cfg = configManager.get();
    return c.json({
      ok: true,
      dir: soundsDir(dataDir, cfg.soundDir),
      customDir: cfg.soundDir || "",
      files: listSounds(dataDir, cfg.soundDir)
    });
  });

  app.post("/api/agents/style", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentId = String(body.agentId || "").trim();
    const value = String(body.value || "default").trim();
    if (!agentId) return c.json({ ok: false, error: "missing agentId" });
    if (!getStyleIds().includes(value)) return c.json({ ok: false, error: "unknown style" });
    const cfg = configManager.get();
    const next = { ...(cfg.agentStyles || {}) };
    next[agentId] = value;
    await configManager.patch({ agentStyles: next });
    return c.json({ ok: true, assignments: configManager.get().agentStyles || {} });
  });

  app.post("/api/sounds/assign", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentId = String(body.agentId || "").trim();
    const value = String(body.value || "default").trim();
    if (!agentId) return c.json({ ok: false, error: "missing agentId" });
    const cfg = configManager.get();
    // 值白名单：default / silent / 存在的音效文件名（按当前生效目录）
    if (value !== "default" && value !== "silent" && !listSounds(dataDir, cfg.soundDir).includes(value)) {
      return c.json({ ok: false, error: "unknown sound file" });
    }
    const next = { ...(cfg.agentSounds || {}) };
    next[agentId] = value;
    await configManager.patch({ agentSounds: next });
    return c.json({ ok: true, assignments: configManager.get().agentSounds || {} });
  });

  app.post("/api/sound/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // 同步读不到 body 时用 query 兼容
    const file = (body && body.file) || c.req.query("file") || "";
    const agentId = String((body && body.agentId) || "").trim();
    const reqStyle = String((body && body.style) || "").trim();
    const cfg = configManager.get();
    // 风格优先用请求里当前选中的值（所见即所得，不等保存时序）；没传才回退已保存配置
    const styleId = reqStyle && getStyleIds().includes(reqStyle)
      ? reqStyle
      : (cfg.agentStyles || {})[agentId] || "default";
    const style = getStyle(styleId);
    const agents = listAgentsFromDisk(path.join(HANA_HOME, "agents"));
    const agent = agents.find((a) => a.id === agentId);
    const name = agent ? agent.name : "助手";
    const sound = file === "silent" ? "silent" : resolveSound(dataDir, String(file || ""), cfg.soundDir) || undefined;
    // 试看示例按风格给不同句子，让风格差异一点就看出来
    const sample = PREVIEW_SAMPLES[styleId] || PREVIEW_SAMPLES.default;
    const sent = sendToast({
      pluginDir,
      title: style.title("first", name, 1),
      message: style.body("first", sample, 1),
      style: cfg.toastStyle,
      // 头像：该助手的头像（跟真实通知一致），找不到回退插件图标
      icon: resolveAgentAvatar(path.join(HANA_HOME, "agents"), agentId) || undefined,
      sound,
      log
    });
    return c.json({ ok: true, sent });
  });
}
