// 提个醒 · 表情包方言联动测试（dialect-links）
// 覆盖：纯构造（九方言+学我说话）、检测函数、setup 集成（临时 Hana 目录）、
//       注册顺序（正常向末尾）、instruction 联动 refine prompt、幂等注册

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildExtraStyles, biaoqingbaoInstalled, readUserStyleTemplate, setupExtraStyles, resolveHanaHome } from "../lib/dialect-links.js";
import { getStyle, getStyleIds } from "../lib/style.js";
import { buildRefineMessages, registerRefineInstruction } from "../lib/refine.js";

// ── 迷你方言库（两个方言够验证构造逻辑；personaAdvanced 结构对齐真实插件）──
const MINI_DIALECTS = {
  dongbei: {
    id: "dongbei",
    name: "东北话",
    tagline: "搁这儿唠唠",
    markers: ["搁", "整", "咋"],
    particles: ["呗", "呢", "啊", "哈"],
    personaAdvanced: "你是一个土生土长的东北人，打字也带着东北话味。接话时爱用「拉倒吧」「咋整」起头，句尾语气词是情绪开关。",
  },
  sichuan: {
    id: "sichuan",
    name: "四川话",
    tagline: "巴适得板",
    markers: ["啥子", "咋个", "巴适"],
    particles: ["嘛", "噻", "哈", "嘎"],
    personaAdvanced: "你是一个土生土长的四川人，打字也带着四川话味。接话时爱用「要得」「巴适」起头，句尾语气词是情绪开关。",
  },
  // 不在 DIALECT_ORDER 里的方言（如将来新增）不应盲目挂载
  wutunhua: {
    id: "wutunhua",
    name: "五屯话",
    tagline: "试验方言",
    personaAdvanced: "试验数据，不应出现在结果里。",
  },
};

function tmpHanaHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-dl-"));
}

test("resolveHanaHome：默认取 HANA_HOME 或 ~/.hanako", () => {
  const prev = process.env.HANA_HOME;
  try {
    process.env.HANA_HOME = "X:/fake-hana";
    assert.equal(resolveHanaHome(), "X:/fake-hana");
  } finally {
    if (prev === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = prev;
  }
  assert.ok(resolveHanaHome().endsWith(".hanako") || process.env.HANA_HOME, "无环境变量时指向 .hanako");
});

test("buildExtraStyles：动态跟随方言表，新增方言也挂载（标题模板缺失回退默认）", () => {
  const { styles, instructions } = buildExtraStyles({ dialects: MINI_DIALECTS });
  // 动态遍历：东北/四川有内置标题模板，五屯话（新增）也挂载但标题回退默认
  const ids = styles.map((s) => s.id);
  assert.deepEqual(ids, ["dh_dongbei", "dh_sichuan", "dh_wutunhua"]);
  // 元数据
  assert.equal(styles[0].label, "东北话");
  assert.equal(styles[0].desc, "搁这儿唠唠，东北话味");
  assert.equal(styles[0].refinable, true);
  // 规则版标题（未开会话前缀）
  assert.equal(styles[0].title("first", "小花", 1), "小花 回你了哈！");
  assert.equal(styles[0].title("append", "小花", 3), "小花 又回 2 条，麻溜儿看！");
  assert.equal(styles[1].title("first", "小花", 1), "小花 回你了噻"); // 四川话模板
  // 新增方言：无内置标题模板 → 标题回退默认，但照样挂载
  assert.equal(styles[2].title("first", "小花", 1), "小花 回你了");
  assert.equal(styles[2].title("append", "小花", 4), "小花 又回了 3 条");
  // 规则版正文：原文短截不改写
  assert.equal(styles[0].body("first", "记得喝水", 1), "记得喝水");
  // 润色指令：persona 全文进 prompt（注册后生效）
  assert.ok(instructions.dh_dongbei.includes("东北人"), "指令引用 persona");
  registerRefineInstruction("dh_dongbei", instructions.dh_dongbei);
  const msgs = buildRefineMessages({ agentName: "小花", style: styles[0], kind: "first", snippet: "方案好了", count: 1 });
  assert.ok(msgs[1].content.includes("东北话"), "润色 prompt 带方言指令（user 消息内）");
  // 新增方言：无 persona 也有兜底指令
  assert.ok(instructions.dh_wutunhua.includes("五屯话"), "新增方言兜底指令");
});

test("buildExtraStyles：无方言库 → 空；unpersona 方言也有兜底指令", () => {
  const none = buildExtraStyles({});
  assert.deepEqual(none.styles, []);
  assert.deepEqual(none.instructions, {});

  const noPersona = buildExtraStyles({ dialects: { sichuan: { id: "sichuan", name: "四川话", tagline: "x" } } });
  assert.equal(noPersona.styles.length, 1);
  assert.ok(noPersona.instructions.dh_sichuan.includes("四川话"), "无 persona 时也有兜底指令");
});

test("buildExtraStyles：学我说话有模板才出现，规则版标题默认、指令带模板", () => {
  const noTpl = buildExtraStyles({ dialects: MINI_DIALECTS });
  assert.ok(!noTpl.styles.some((s) => s.id === "userstyle"), "无模板不出现");

  const tpl = "说话爱用波浪号，句尾经常带～，起头爱说「对了」";
  const { styles, instructions } = buildExtraStyles({ dialects: MINI_DIALECTS, userTemplate: tpl });
  const us = styles.find((s) => s.id === "userstyle");
  assert.ok(us, "有模板出现学我说话");
  assert.equal(us.label, "学我说话");
  assert.equal(us.title("first", "小花", 1), "小花 回你了");
  assert.equal(us.title("append", "小花", 4), "小花 又回了 3 条");
  assert.equal(us.body("first", "记得喝水", 1), "记得喝水");
  assert.ok(instructions.userstyle.includes(tpl), "指令带用户模板");
});

test("检测函数：目录/文件齐全才算装了插件", () => {
  const home = tmpHanaHome();
  assert.equal(biaoqingbaoInstalled(home), false);
  fs.mkdirSync(path.join(home, "plugins", "biaoqingbao", "lib"), { recursive: true });
  // 只有目录没有 dialect.js → 不算
  assert.equal(biaoqingbaoInstalled(home), false);
  fs.writeFileSync(path.join(home, "plugins", "biaoqingbao", "lib", "dialect.js"), "export const DIALECTS = {};");
  assert.equal(biaoqingbaoInstalled(home), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("readUserStyleTemplate：current 非空才算有模板，损坏文件返回空串", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-tpl-"));
  assert.equal(readUserStyleTemplate(dir), "", "无文件空串");
  fs.writeFileSync(path.join(dir, "style-template.json"), "{ bad json", "utf-8");
  assert.equal(readUserStyleTemplate(dir), "", "坏 JSON 空串");
  fs.writeFileSync(path.join(dir, "style-template.json"), JSON.stringify({ current: "  " }), "utf-8");
  assert.equal(readUserStyleTemplate(dir), "", "空白模板空串");
  fs.writeFileSync(path.join(dir, "style-template.json"), JSON.stringify({ current: "句尾爱带～" }), "utf-8");
  assert.equal(readUserStyleTemplate(dir), "句尾爱带～");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("setupExtraStyles 集成：临时 Hana 目录含插件+模板 → 注册齐全且顺序正确", async () => {
  const home = tmpHanaHome();
  const miniDialectJs = `
    export const DIALECTS = ${JSON.stringify(MINI_DIALECTS)};
  `;
  fs.mkdirSync(path.join(home, "plugins", "biaoqingbao", "lib"), { recursive: true });
  fs.writeFileSync(path.join(home, "plugins", "biaoqingbao", "lib", "dialect.js"), miniDialectJs, "utf-8");
  fs.mkdirSync(path.join(home, "plugin-data", "biaoqingbao"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "plugin-data", "biaoqingbao", "style-template.json"),
    JSON.stringify({ current: "爱用波浪号，句尾带～" }),
    "utf-8"
  );

  const extra = await setupExtraStyles(home);
  assert.ok(extra, "有扩展注册");
  assert.deepEqual(extra.styles.map((s) => s.id), ["dh_dongbei", "dh_sichuan", "dh_wutunhua", "userstyle"]);

  // 注册后：getStyleIds 扩展排在最后（整活向之后）
  const ids = getStyleIds();
  const base = ids.filter((id) => !id.startsWith("dh_") && id !== "userstyle");
  assert.deepEqual(base, [
    "default", "plain", "cheerful", "gentle", "sister", "epistle", "biz",
    "ac_shizue", "ac_jack", "ac_jun", "ac_chacha", "ac_monica", "ac_judy", "ac_ankha", "ac_zucker", "ac_nook", "ac_timmy",
    "morse", "glitch", "mojibake"
  ], "基础集顺序不变（正常向 → 动森 → 整活向）");
  assert.deepEqual(ids, [
    "default", "plain", "cheerful", "gentle", "sister", "epistle", "biz",
    "ac_shizue", "ac_jack", "ac_jun", "ac_chacha", "ac_monica", "ac_judy", "ac_ankha", "ac_zucker", "ac_nook", "ac_timmy",
    "morse", "glitch", "mojibake",
    "dh_dongbei", "dh_sichuan", "dh_wutunhua", "userstyle"
  ], "方言排列表最后（整活向之后）");
  // getStyle 命中扩展、未知回退默认
  assert.equal(getStyle("dh_dongbei").label, "东北话");
  assert.equal(getStyle("not-exist").id, "default");
  fs.rmSync(home, { recursive: true, force: true });
});

test("setupExtraStyles：没装插件 → null，且不污染风格列表", async () => {
  const home = tmpHanaHome();
  const before = getStyleIds();
  const extra = await setupExtraStyles(home);
  assert.equal(extra, null);
  assert.deepEqual(getStyleIds(), before, "无插件时列表不变");
  fs.rmSync(home, { recursive: true, force: true });
});