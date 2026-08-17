// 提个醒 · 文案润色测试
// 覆盖：prompt 构建（风格指令/条数提示/裁剪）、JSON 解析、失败抛错、成功拼会话前缀、refinable 标记

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRefineMessages, parseRefineResult, refineTitleAndBody } from "../lib/refine.js";
import { STYLES, sessionPrefix } from "../lib/style.js";

const style = (id) => STYLES[id];

test("refinable：语气型风格参与润色，格式型整活风格不参与", () => {
  for (const id of ["default", "plain", "cheerful", "gentle", "biz"]) {
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

test("buildRefineMessages：append 提示累计条数，snippet 超长裁剪", () => {
  const msgs = buildRefineMessages({ agentName: "助手B", style: style("cheerful"), kind: "append", snippet: "长".repeat(200), count: 4 });
  assert.match(msgs[1].content, /补弹/);
  assert.match(msgs[1].content, /3 条/);
  assert.ok(msgs[1].content.length < 400, "snippet 被裁剪");
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
  const mc = { sample: async () => { throw new Error("timeout"); } };
  await assert.rejects(refineTitleAndBody({
    mc, agentName: "小花", style: style("gentle"), kind: "first", snippet: "x", count: 1, sessionPrefix
  }));
});
