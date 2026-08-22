// 提个醒 · 异常回合文案测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAbnormalCopy, failureReasonLabel, isRetryCancelled } from "../lib/abnormal-copy.js";

test("异常文案：连接错误归纳成大白话", () => {
  assert.equal(failureReasonLabel("WebSocket error"), "模型连接断了");
  assert.equal(failureReasonLabel("fetch failed"), "模型连接断了");
  assert.equal(failureReasonLabel("401 Unauthorized"), "模型凭据没通过");
  assert.equal(failureReasonLabel("429 rate limit"), "模型暂时忙");
  assert.equal(failureReasonLabel("unknown failure"), "模型请求没完成");
});

test("异常文案：带会话标题和已收到的部分内容", () => {
  const r = buildAbnormalCopy({
    kind: "failure",
    agentName: "小花",
    sessionTitle: "设置面板优化建议",
    partialText: "已经收到一半内容",
    errorMessage: "WebSocket error"
  });
  assert.equal(r.title, "设置面板优化建议 · 小花 · 这轮没接上");
  assert.match(r.body, /收到/);
  assert.match(r.body, /继续/);
});

test("异常文案：没有部分内容时给出继续动作", () => {
  const r = buildAbnormalCopy({ kind: "failure", agentName: "小花", errorMessage: "fetch failed" });
  assert.equal(r.title, "小花 · 这轮没接上");
  assert.equal(r.body, "模型连接断了，说“继续”再试");
});

test("异常文案：会话不健康给出新开对话建议", () => {
  const r = buildAbnormalCopy({ kind: "unhealthy", agentName: "小花", recentErrors: 4, totalChecked: 4 });
  assert.equal(r.title, "小花 · 对话状态不稳");
  assert.match(r.body, /4\/4/);
  assert.match(r.body, /新开对话/);
});

test("异常文案：主动取消可识别", () => {
  assert.equal(isRetryCancelled("Retry cancelled"), true);
  assert.equal(isRetryCancelled("WebSocket error"), false);
});
