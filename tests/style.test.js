// 提个醒 · 通知风格模板测试
// 覆盖：四套风格的标题/正文格式、正文截断与加工、未知风格回退、风格 id 完整性

import { test } from "node:test";
import assert from "node:assert/strict";

import { STYLES, STYLE_IDS, getStyle, getStyleIds, getAllStyles, registerStyle } from "../lib/style.js";

test("风格：十套风格齐全", () => {
  assert.deepEqual([...STYLE_IDS].sort(), ["biz", "cheerful", "default", "epistle", "gentle", "glitch", "mojibake", "morse", "plain", "sister"].sort());
});

test("风格：正常向在前，整活向在后（列表展示顺序）", () => {
  // 正常向：default / plain / cheerful / gentle / sister / epistle / biz（可润色为主）
  // 整活向：morse / glitch / mojibake（格式玩法）
  assert.deepEqual(STYLE_IDS, [
    "default", "plain", "cheerful", "gentle", "sister", "epistle", "biz",
    "morse", "glitch", "mojibake"
  ]);
});

test("风格：未知 id 回退默认", () => {
  assert.equal(getStyle("不存在").id, "default");
  assert.equal(getStyle(undefined).id, "default");
});

test("默认风格：标题「XX 回你了」，正文截断到 24 字", () => {
  const s = getStyle("default");
  assert.equal(s.title("first", "小花", 1), "小花 回你了");
  assert.equal(s.body("first", "今天天气不错", 1), "今天天气不错");
  assert.equal(s.body("append", "补充内容", 3), "补充：补充内容");
  const long = "长".repeat(60);
  assert.equal(s.body("first", long, 1), "长".repeat(24) + "…");
  assert.equal(s.body("append", long, 3), "补充：" + "长".repeat(24) + "…");
});

test("简洁高效：标题电报风，正文去 emoji 且更短", () => {
  const s = getStyle("plain");
  assert.equal(s.title("first", "助手A", 1), "助手A · 新回复");
  assert.equal(s.title("append", "助手A", 3), "助手A · 又回 2 条");
  assert.equal(s.body("first", "✨ 接口 500 了 ✨", 1), "接口 500 了");
  const long = "字".repeat(60);
  assert.equal(s.body("first", long, 1), "字".repeat(18) + "…");
  // 纯 emoji 回复去完为空时回退原文（正文永远展示真实内容）
  assert.equal(s.body("first", "😂😂😂", 1), "😂😂😂");
});

test("活泼可爱：标题带 emoji，正文感叹号加倍加撒花（规则改写）", () => {
  const s = getStyle("cheerful");
  assert.equal(s.title("first", "助手B", 1), "🎉 助手B 回你啦！");
  assert.equal(s.title("append", "助手B", 4), "🎉 助手B 又回了 3 条！");
  // 无标点结尾补「！！」
  assert.equal(s.body("first", "搞定啦", 1), "搞定啦！！ 🎉");
  // 句号/感叹号结尾升为「！！」
  assert.equal(s.body("first", "搞定啦。", 1), "搞定啦！！ 🎉");
  assert.equal(s.body("first", "太棒了！", 1), "太棒了！！ 🎉");
  // 问号结尾变「？！"
  assert.equal(s.body("first", "你猜怎么着？", 1), "你猜怎么着？！ 🎉");
  // 省略号结尾不动
  assert.equal(s.body("first", "这个嘛…", 1), "这个嘛… 🎉");
});

test("温柔贴心：标题带书名号和波浪号，正文软化加引号（规则改写）", () => {
  const s = getStyle("gentle");
  assert.equal(s.title("first", "助手C", 1), "💌 「助手C」给你捎了句话～");
  assert.equal(s.title("append", "助手C", 2), "💌 「助手C」又留了 1 条话～");
  // 无标点结尾补～
  assert.equal(s.body("first", "记得喝水", 1), "「记得喝水～」");
  // 句号/叹号变波浪号
  assert.equal(s.body("first", "别急，我看看。", 1), "「别急，我看看～」");
  assert.equal(s.body("first", "太好了！", 1), "「太好了～」");
  // 中间句号也软化
  assert.equal(s.body("first", "先吃饭。然后睡觉。", 1), "「先吃饭～然后睡觉～」");
  // 问号保留
  assert.equal(s.body("first", "你吃饭了吗？", 1), "「你吃饭了吗？」");
  // 省略号结尾不动
  assert.equal(s.body("first", "这个嘛…", 1), "「这个嘛…」");
});

test("闺蜜俏皮：标题姐妹口吻，正文感叹号升级不撒花", () => {
  const s = getStyle("sister");
  assert.equal(s.title("first", "助手C", 1), "姐妹！助手C 回你了！");
  assert.equal(s.title("append", "助手C", 3), "姐妹！助手C 又回 2 条！");
  // 无标点补「！！」，句号/叹号升为「！！」，问号变「？！」，不追加 emoji
  assert.equal(s.body("first", "搞定啦", 1), "搞定啦！！");
  assert.equal(s.body("first", "搞定啦。", 1), "搞定啦！！");
  assert.equal(s.body("first", "你猜？", 1), "你猜？！");
});

test("古风书简：标题笺札感，正文短截缺标点补句号", () => {
  const s = getStyle("epistle");
  assert.equal(s.title("first", "助手D", 1), "📜 展信佳 · 助手D 有书至");
  assert.equal(s.title("append", "助手D", 2), "📜 助手D 又寄来 1 行");
  // 缺标点补句号，已有句号/叹号不动
  assert.equal(s.body("first", "记得喝水", 1), "记得喝水。");
  assert.equal(s.body("first", "别急，我看看。", 1), "别急，我看看。");
  assert.equal(s.body("first", "太好了！", 1), "太好了！");
  // 长内容同样短截断到 24 字
  const long = "长".repeat(60);
  assert.equal(s.body("first", long, 1), "长".repeat(24) + "…");
});

test("截断：优先断在句子完整处，标点靠前才硬截", () => {
  const s = getStyle("default");
  // 句号在截断窗口后半段 → 断在句号后，宁可多几个字也要完整
  const a = "好".repeat(20) + "。" + "长".repeat(20);
  assert.equal(s.body("first", a, 1), "好".repeat(20) + "。…");
  // 逗号同理（无句号时用停顿标点断句）
  const b = "中".repeat(15) + "，" + "长".repeat(20);
  assert.equal(s.body("first", b, 1), "中".repeat(15) + "，…");
  // 句号太靠前（不足一半）→ 不值得断，硬截保长度
  const c = "第一句。" + "好".repeat(30);
  assert.equal(s.body("first", c, 1), "第一句。" + "好".repeat(20) + "…");
  // 完全没有标点 → 硬截
  assert.equal(s.body("first", "长".repeat(60), 1), "长".repeat(24) + "…");
});

test("风格：title/body 都是函数，样式完整", () => {
  for (const id of getStyleIds()) {
    const s = getStyle(id);
    assert.equal(typeof s.title, "function", id + " title");
    assert.equal(typeof s.body, "function", id + " body");
    assert.ok(s.label && s.desc, id + " 文案");
  }
});

test("摩斯电码：正文转点横，字母数字可解，中文走码点，超长截断", () => {
  const s = getStyle("morse");
  assert.equal(s.title("first", "助手A", 1), "📡 助手A 给你发了条摩斯电码");
  assert.equal(s.title("append", "助手A", 3), "📡 助手A 又发来 2 条电码");
  // 字母直接查表：HI → .... ..
  assert.equal(s.body("first", "HI", 1), ".... ..");
  // 数字查表：1 → .----
  assert.equal(s.body("first", "1", 1), ".----");
  // 中文走 Unicode 码点数字再转摩斯，只含 . - 空格 / …
  const cn = s.body("first", "好", 1);
  assert.match(cn, /^[\.\-\/ …]+$/);
  // 超长截断（60 字符上限）
  const long = s.body("first", "好".repeat(40), 1);
  assert.ok(long.length <= 61, "摩斯串有长度上限");
});

test("系统故障：正文夹乱码，长度与原文一致", () => {
  const s = getStyle("glitch");
  assert.equal(s.title("first", "助手B", 1), "🖥 助手B 回你了（信号不稳）");
  assert.equal(s.title("append", "助手B", 4), "🖥 助手B 又回 3 条（信号不稳）");
  const out = s.body("first", "今天天气真的很好呀", 1);
  assert.equal([...out].length, [..."今天天气真的很好呀"].length, "乱码替换不改变长度");
  assert.match(out, /[�□▓╳◇]/, "包含乱码字符");
  assert.match(out, /今天|天气|很好/, "仍保留大部分原文");
});

test("锟斤拷：全乱码但长度与原文一致", () => {
  const s = getStyle("mojibake");
  assert.equal(s.title("first", "助手C", 1), "💽 助手C 的回复编码损坏");
  assert.equal(s.title("append", "助手C", 2), "💽 助手C 又回 1 条（编码损坏）");
  const out = s.body("first", "记得喝水呀", 1);
  assert.equal([...out].length, [..."记得喝水呀"].length, "乱码长度对得上原文");
  assert.match(out, /[锟斤拷烫屯�□]/, "是乱码家族成员");
  assert.ok(!out.includes("喝水"), "原文已不可读");
});

test("大厂黑话：标题在黑话模板集合内，正文原文", () => {
  const s = getStyle("biz");
  const firstTitles = [
    "小花 回复已触达 ✅", "【闭环】小花 回复完成", "小花：新回复已同步",
    "拉通对齐：小花 回复完成", "小花 回复已交付"
  ];
  const appendTitles = ["小花 又回 2 条，链路已更新", "【增补】小花 追加 2 条回复", "小花 新增 2 条，信息已拉齐"];
  for (let i = 0; i < 30; i++) {
    assert.ok(firstTitles.includes(s.title("first", "小花", 1)), "first 标题在黑话池内: " + s.title("first", "小花", 1));
    assert.ok(appendTitles.includes(s.title("append", "小花", 3)), "append 标题在黑话池内: " + s.title("append", "小花", 3));
  }
  assert.equal(s.body("first", "接口 500 了", 1), "接口 500 了");
});

test("风格：标题带会话标题前缀（多窗口区分）", () => {
  const s = getStyle("default");
  assert.equal(s.title("first", "小花", 1, "设置面板风格优化建议"), "设置面板风格优化建议 · 小花 回你了");
  assert.equal(s.title("append", "小花", 3, "设置面板风格优化建议"), "设置面板风格优化建议 · 小花 又回了 2 条");
  // 不传会话标题（预览/测试）时无前缀
  assert.equal(s.title("first", "小花", 1), "小花 回你了");
  // 空标题无前缀
  assert.equal(s.title("first", "小花", 1, "  "), "小花 回你了");
});

test("风格：会话标题超长截断到 12 字加省略号", () => {
  const s = getStyle("cheerful");
  const long = "帮我想想周末去哪玩顺便规划路线"; // 16 字
  assert.equal(s.title("first", "助手B", 1, long), "帮我想想周末去哪玩顺便规… · 🎉 助手B 回你啦！");
  // 各风格都带前缀
  assert.equal(getStyle("plain").title("first", "助手A", 1, long), "帮我想想周末去哪玩顺便规… · 助手A · 新回复");
  assert.equal(getStyle("gentle").title("first", "助手C", 1, long), "帮我想想周末去哪玩顺便规… · 💌 「助手C」给你捎了句话～");
});

test("风格：扩展注册排在列表最后，重复注册幂等", () => {
  const fakeDialect = {
    id: "dh_test", label: "测试方言", desc: "测试", refinable: true,
    title: (kind, name, count) => `${name} 回你了测试`,
    body: (kind, snippet) => String(snippet).slice(0, 20)
  };
  registerStyle(fakeDialect);
  registerStyle(fakeDialect); // 幂等：重复注册不重复出现
  const ids = getStyleIds();
  assert.deepEqual(
    ids.filter((id) => !id.startsWith("dh_")),
    ["default", "plain", "cheerful", "gentle", "sister", "epistle", "biz", "morse", "glitch", "mojibake"]
  );
  assert.ok(ids.includes("dh_test"));
  const mojibakeIdx = ids.indexOf("mojibake"), extIdx = ids.indexOf("dh_test");
  assert.ok(mojibakeIdx < extIdx, "扩展风格排在整活向之后");
  assert.equal(extIdx, ids.length - 1, "扩展风格在列表最后");
  // 样式完整 + getStyle 命中
  const s = getStyle("dh_test");
  assert.equal(typeof s.title, "function");
  assert.equal(typeof s.body, "function");
  assert.ok(getAllStyles().some((x) => x.id === "dh_test"));
  // 未知 id 仍回退默认（扩展不存在时）
  assert.equal(getStyle("dh_nope").id, "default");
});
