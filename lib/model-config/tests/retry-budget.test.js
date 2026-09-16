// model-config 积木 · 空正文重试的输出预算与失败诊断
//
// 背景：部分中转/兼容端点会忽略 thinking:{type:"disabled"}，模型照思考不误，
// 把小预算全吃在思考上、正文为空（finishReason=length）。这时候 ×3 小步试探注定不够，
// 且失败信息不能只说一句「模型未回复正文」。
//
// 说明：这份副本的 Hana 档走工具总线（旧版实现），抓不到请求，
// 所以行为测试统一用自定义档——它是直连，新旧版实现一致。

import { test } from "node:test";
import assert from "node:assert/strict";

import { ModelConfig } from "../index.js";
import { growRetryTokenBudget } from "../core/client.js";

// ── 预算策略（纯函数） ──

test("重试预算：没观测到思考时按 ×3 试探", () => {
  assert.equal(growRetryTokenBudget(500), 1500);
  assert.equal(growRetryTokenBudget(700), 2100);
  assert.equal(growRetryTokenBudget(100), 300);
});

test("重试预算：只增不减，原预算大时绝不被砍小", () => {
  // 老实现是 Math.min(4000, ...)，8000 会被砍到 4000——越救越紧，这里钉死
  assert.equal(growRetryTokenBudget(8000), 12000);
  assert.equal(growRetryTokenBudget(12000), 12000);
  assert.equal(growRetryTokenBudget(20000), 20000);
});

test("重试预算：一旦观测到思考，就按思考的量级给足", () => {
  assert.equal(growRetryTokenBudget(700, { hadThinking: true }), 6000);
  assert.equal(growRetryTokenBudget(700, { hadThinking: true, finishReason: "length" }), 8000);
  assert.equal(growRetryTokenBudget(500, { hadThinking: true, finishReason: "stop" }), 6000);
  assert.equal(growRetryTokenBudget(50000, { hadThinking: true, finishReason: "length" }), 50000);
});

test("重试预算：非法或缺失输入有兜底，不产生 NaN", () => {
  assert.equal(growRetryTokenBudget(undefined), 900);
  assert.equal(growRetryTokenBudget(0), 900);
  assert.equal(growRetryTokenBudget(-5), 900);
  assert.equal(growRetryTokenBudget("abc"), 900);
  assert.equal(growRetryTokenBudget(null, {}), 900);
});

// ── 行为：两次都空时的表现（自定义档直连） ──

function makeCustomModel(respond) {
  const calls = [];
  const mc = new ModelConfig({
    ctx: {
      network: {
        async fetch(url, init) {
          calls.push({ url, body: JSON.parse(init.body) });
          return { ok: true, status: 200, async text() { return JSON.stringify(respond()); } };
        },
      },
      log: { info() {}, warn() {}, error() {} },
    },
    store: {
      getConfig() {
        return {
          modelSource: "custom",
          customModel: {
            baseUrl: "https://api.commandcode.ai/provider/v1",
            apiKey: "test-key",
            model: "deepseek/deepseek-v4-flash",
            api: "openai-completions",
          },
        };
      },
      saveConfig() {},
    },
  });
  return { mc, calls };
}

test("空正文重试：思考吃光预算时，抛出带诊断和下一步的错误，不静默换档", async () => {
  const { mc, calls } = makeCustomModel(() => ({
    choices: [{ message: { reasoning_content: "想了很久很久", content: "" } }],
    finish_reason: "length",
  }));

  await assert.rejects(
    mc.sample([{ role: "user", content: "写一段总结" }], { maxTokens: 500, operation: "summary" }),
    (err) => {
      assert.match(err.message, /思考/);
      assert.match(err.message, /hadThinking=true/);
      assert.match(err.message, /finishReason=length/);
      return true;
    },
  );

  assert.equal(calls.length, 2, "应该只重试一次");
  assert.equal(calls[1].body.max_tokens, 8000, "重试要按「思考吃光预算」给足");
  // 还是同一个模型，没被偷偷换掉
  assert.equal(calls[0].body.model, calls[1].body.model);
  // 重试时仍然带着「只回最终正文」的收紧指令
  assert.match(String(calls[1].body.messages.at(-1).content), /直接返回最终可见正文/);
});

test("空正文重试（无思考、非长度截断）：仍返回空串，不误判成思考型", async () => {
  const { mc, calls } = makeCustomModel(() => ({
    choices: [{ message: { content: "" } }],
    finish_reason: "stop",
  }));

  const text = await mc.sample([{ role: "user", content: "写一段总结" }], { maxTokens: 500, operation: "summary" });
  assert.equal(text, "");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.max_tokens, 1500, "没有思考证据时退回 ×3，不硬套大预算");
});
