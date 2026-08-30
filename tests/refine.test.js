// 提个醒 · 文案润色测试
// 覆盖：prompt 构建（风格指令/条数提示/裁剪）、JSON 解析、失败抛错、成功拼会话前缀、refinable 标记

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRefineMessages, parseRefineResult, parseRefineResultLenient, refineTitleAndBody, isRefusalText } from "../lib/refine.js";
import { STYLES, sessionPrefix } from "../lib/style.js";

const style = (id) => STYLES[id];

test("refinable：语气型风格参与润色，格式型整活风格不参与", () => {
  for (const id of ["default", "plain", "cheerful", "gentle", "biz", "sister", "epistle",
    "ac_shizue", "ac_jack", "ac_jun", "ac_chacha", "ac_monica", "ac_judy", "ac_ankha", "ac_zucker", "ac_nook", "ac_timmy"]) {
    assert.equal(STYLES[id].refinable, true, id + " 应可润色");
  }
  for (const id of ["morse", "glitch", "mojibake"]) {
    assert.equal(STYLES[id].refinable, false, id + " 不应润色");
  }
});

test("buildRefineMessages：system 约束格式，user 带上下文", () => {
  const msgs = buildRefineMessages({ agentName: "小花", style: style("gentle"), kind: "first", snippet: "接口报错了", count: 1 });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /JSON/);
  assert.match(msgs[0].content, /title/);
  assert.match(msgs[0].content, /body/);
  assert.match(msgs[0].content, /会话标题前缀/);
  assert.match(msgs[1].content, /小花/);
  assert.match(msgs[1].content, /温柔贴心/);
  assert.match(msgs[1].content, /接口报错了/);
});

test("buildRefineMessages：system 含输出示例与「思考完必须输出」硬约束", () => {
  const msgs = buildRefineMessages({ agentName: "小花", style: style("gentle"), kind: "first", snippet: "x", count: 1 });
  assert.match(msgs[0].content, /示例/);
  assert.match(msgs[0].content, /\{"title": "小花回你啦～", "body":/);
  assert.match(msgs[0].content, /思考完毕必须把最终 JSON/);
  assert.match(msgs[0].content, /不要只思考不输出/);
  assert.match(msgs[0].content, /Markdown/);
});

test("buildRefineMessages：append 提示累计条数，snippet 超长裁剪", () => {
  const msgs = buildRefineMessages({ agentName: "助手B", style: style("cheerful"), kind: "append", snippet: "长".repeat(200), count: 4 });
  assert.match(msgs[1].content, /补弹/);
  assert.match(msgs[1].content, /3 条/);
  assert.ok(msgs[1].content.length < 400, "snippet 被裁剪");
});

test("buildRefineMessages：异常回合要求保留内容并提醒继续", () => {
  const msgs = buildRefineMessages({
    agentName: "小花",
    style: style("gentle"),
    kind: "failure",
    snippet: "已经收到一半",
    count: 1,
    failureReason: "WebSocket error"
  });
  assert.match(msgs[1].content, /异常回合/);
  assert.match(msgs[1].content, /继续/);
  assert.match(msgs[1].content, /WebSocket error/);
});

test("parseRefineResult：标准 JSON", () => {
  const r = parseRefineResult('{"title":"小花 回你啦！","body":"搞定啦～"}');
  assert.equal(r.title, "小花 回你啦！");
  assert.equal(r.body, "搞定啦～");
});

test("parseRefineResult：缺字段/损坏抛错", () => {
  assert.throws(() => parseRefineResult("{}"));
  assert.throws(() => parseRefineResult('{"title":"x"}'));
  assert.throws(() => parseRefineResult("不是json"));
});

test("parseRefineResult：超长裁剪", () => {
  const r = parseRefineResult(JSON.stringify({ title: "长".repeat(50), body: "长".repeat(100) }));
  assert.ok([...r.title].length <= 17, "标题上限 16 字 + 省略号");
  assert.ok([...r.body].length <= 25, "正文上限 24 字 + 省略号");
});

test("refineTitleAndBody：成功返回带会话前缀标题 + 正文", async () => {
  const mc = { sample: async () => '{"title":"小花 回你啦！","body":"接口报错啦，别担心～"}' };
  const r = await refineTitleAndBody({
    mc, agentName: "小花", style: style("gentle"), kind: "first",
    snippet: "接口报错了", count: 1, sessionTitle: "设置面板优化", sessionPrefix
  });
  assert.equal(r.title, "设置面板优化 · 小花 回你啦！");
  assert.equal(r.body, "接口报错啦，别担心～");
});

test("refineTitleAndBody：模型失败抛错（调用方降级规则版）", async () => {
  let calls = 0;
  const mc = { sample: async () => { calls += 1; throw new Error("timeout"); } };
  await assert.rejects(refineTitleAndBody({
    mc, agentName: "小花", style: style("gentle"), kind: "first", snippet: "x", count: 1, sessionPrefix
  }));
  assert.equal(calls, 2, "失败应自动重试一次");
});

test("refineTitleAndBody：第一次只思考不输出，重试后成功（治光想不写）", async () => {
  let calls = 0;
  const mc = {
    sample: async () => {
      calls += 1;
      if (calls === 1) throw new Error("模型未回复正文，请检查思考内容或稍后重试。");
      return '{"title":"小花 回你啦！","body":"这次给出正文啦～"}';
    }
  };
  const r = await refineTitleAndBody({
    mc, agentName: "小花", style: style("gentle"), kind: "first", snippet: "x", count: 1, sessionTitle: "设置面板优化", sessionPrefix
  });
  assert.equal(calls, 2);
  assert.equal(r.title, "设置面板优化 · 小花 回你啦！");
  assert.equal(r.body, "这次给出正文啦～");
});

test("refineTitleAndBody：第一次 JSON 格式错，重试后成功", async () => {
  let calls = 0;
  const mc = {
    sample: async () => {
      calls += 1;
      if (calls === 1) return '{"title": "小花回你啦~", "body": "表情';
      return '{"title":"小花 回你啦！","body":"格式对了～"}';
    }
  };
  const r = await refineTitleAndBody({
    mc, agentName: "小花", style: style("gentle"), kind: "first", snippet: "x", count: 1, sessionPrefix
  });
  assert.equal(calls, 2);
  assert.equal(r.title, "小花 回你啦！");
});

test("parseRefineResultLenient：Markdown 代码块围栏可剥离", () => {
  const r = parseRefineResultLenient('```json\n{"title":"小花 回你啦！","body":"搞定～"}\n```');
  assert.equal(r.title, "小花 回你啦！");
});

test("parseRefineResultLenient：前后有解释文字也能抠出 JSON", () => {
  const r = parseRefineResultLenient('好的，我来改写：\n{"title":"小花 回你啦！","body":"搞定～"}\n希望你喜欢！');
  assert.equal(r.title, "小花 回你啦！");
});

// ── 安全拒绝文案识别（2026-08-28 实机：MiniMax-M3 把科普当成越权请求，输出拒绝文案被当正常结果弹窗）──

test("isRefusalText：识别常见安全拒绝文案", () => {
  assert.equal(isRefusalText("抱歉，这个话题我不能帮你～"), true, "实机原文");
  assert.equal(isRefusalText("抱歉，我无法生成通知文案"), true);
  assert.equal(isRefusalText("我不能帮你完成这个请求"), true);
  assert.equal(isRefusalText("拒绝回答这个问题"), true);
  assert.equal(isRefusalText("换个话题吧"), true);
  assert.equal(isRefusalText("这违反了安全政策"), true);
});

test("isRefusalText：正常文案不误伤", () => {
  assert.equal(isRefusalText("「刚才说的事，有着落啦～」"), false);
  assert.equal(isRefusalText("已经删好啦，页面清爽多了"), false);
  assert.equal(isRefusalText("身体不舒服就早点休息"), false);
  assert.equal(isRefusalText("这个方法能帮到你"), false);
  assert.equal(isRefusalText("他说抱歉来晚了，但事办妥了"), false, "引语里带抱歉但不是拒绝");
  assert.equal(isRefusalText("别担心，我来帮你处理"), false);
});

test("parseRefineResult：模型输出安全拒绝文案时抛错（降级规则版）", () => {
  assert.throws(() => parseRefineResult('{"title":"小花回你啦～","body":"抱歉，这个话题我不能帮你～"}'));
  assert.throws(() => parseRefineResult('{"title":"抱歉，我无法完成这个请求","body":"请换个话题"}'));
});

test("refineTitleAndBody：第一次输出拒绝文案，重试后成功", async () => {
  let calls = 0;
  const mc = {
    sample: async () => {
      calls += 1;
      if (calls === 1) return '{"title":"小花回你啦～","body":"抱歉，这个话题我不能帮你～"}';
      return '{"title":"小花 回你啦！","body":"搞定啦～"}';
    }
  };
  const r = await refineTitleAndBody({
    mc, agentName: "小花", style: style("gentle"), kind: "first", snippet: "x", count: 1, sessionPrefix
  });
  assert.equal(calls, 2, "拒绝文案应触发重试");
  assert.equal(r.title, "小花 回你啦！");
  assert.equal(r.body, "搞定啦～");
});

test("refineTitleAndBody：两次都输出拒绝文案则抛错（调用方降级规则版）", async () => {
  let calls = 0;
  const mc = {
    sample: async () => {
      calls += 1;
      return '{"title":"小花回你啦～","body":"抱歉，这个话题我不能帮你～"}';
    }
  };
  await assert.rejects(refineTitleAndBody({
    mc, agentName: "小花", style: style("gentle"), kind: "first", snippet: "x", count: 1, sessionPrefix
  }));
  assert.equal(calls, 2, "两次都拒绝应抛错让调用方降级");
});
