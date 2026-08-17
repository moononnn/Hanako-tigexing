// 提个醒 · 事件解析测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTurnEnd, parseActivityUpdate, sessionIdFromPath, extractAssistantText, stripMetaBlocks, isFinalTurn } from "../lib/event-parse.js";

test("非 turn_end 事件返回 null", () => {
  assert.equal(parseTurnEnd({ type: "turn_start", agentId: "hanako" }, null), null);
  assert.equal(parseTurnEnd(null, null), null);
  assert.equal(parseTurnEnd("str", null), null);
});

// ── activity_update（计划任务/巡检完成） ──

test("activity_update：cron 解析为计划任务完成", () => {
  const ev = {
    type: "activity_update",
    activity: {
      id: "cron_123",
      type: "cron",
      label: "每日备份",
      agentId: "hanako",
      agentName: "小花",
      summary: "每日备份 执行成功",
      status: "done"
    }
  };
  const r = parseActivityUpdate(ev);
  assert.equal(r.kind, "scheduled");
  assert.equal(r.agentId, "hanako");
  assert.equal(r.agentName, "小花");
  assert.equal(r.label, "每日备份");
  assert.equal(r.status, "done");
});

test("activity_update：heartbeat 解析为巡检", () => {
  const ev = {
    type: "activity_update",
    activity: {
      type: "heartbeat",
      agentId: "hanako",
      agentName: "小花",
      summary: "日常巡检 执行成功",
      status: "done"
    }
  };
  const r = parseActivityUpdate(ev);
  assert.equal(r.kind, "patrol");
  assert.equal(r.status, "done");
});

test("activity_update：error 状态透传", () => {
  const ev = {
    type: "activity_update",
    activity: { type: "cron", agentId: "x", agentName: "X", status: "error", error: "boom" }
  };
  const r = parseActivityUpdate(ev);
  assert.equal(r.status, "error");
});

test("activity_update：非 cron/heartbeat 返回 null", () => {
  assert.equal(parseActivityUpdate({ type: "activity_update", activity: { type: "other" } }), null);
  assert.equal(parseActivityUpdate({ type: "activity_update" }), null);
  assert.equal(parseActivityUpdate({ type: "turn_end" }), null);
  assert.equal(parseActivityUpdate(null), null);
});

test("turn_end 解析 agentId / sessionId / sessionPath", () => {
  const ev = { type: "turn_end", agentId: "hanako", message: { role: "assistant", content: [] } };
  const sp = "C:/Users/x/.hanako/agents/hanako/sessions/2026-01-01T00-00-00Z_abc.jsonl";
  const r = parseTurnEnd(ev, sp);
  assert.equal(r.agentId, "hanako");
  assert.equal(r.sessionId, "2026-01-01T00-00-00Z_abc");
  assert.equal(r.sessionPath, sp);
});

test("turn_end 缺 agentId 兜底 unknown", () => {
  const r = parseTurnEnd({ type: "turn_end", message: {} }, null);
  assert.equal(r.agentId, "unknown");
  assert.equal(r.sessionId, "unknown");
});

test("提取文本：text 拼接，跳过 thinking", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "内部思考不展示" },
      { type: "text", text: "  第一段  " },
      { type: "text", text: "第二段" }
    ]
  };
  assert.equal(extractAssistantText(msg), "第一段\n第二段");
});

test("提取文本：滤掉 <mood> 元信息块", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "text", text: "<mood>\nVibe: 羽毛来打招呼啦\nSparks: ...\n</mood>\n\n这才是真正想说的话" }
    ]
  };
  assert.equal(extractAssistantText(msg), "这才是真正想说的话");
});

test("提取文本：mood 块在中间也能滤掉", () => {
  const msg = {
    role: "assistant",
    content: [{ type: "text", text: "开头正文 <mood>Vibe: 内心戏</mood> 结尾正文" }]
  };
  assert.equal(extractAssistantText(msg), "开头正文 结尾正文");
});

test("stripMetaBlocks：未闭合 mood 开头残留被清掉", () => {
  assert.equal(stripMetaBlocks("<mood>Vibe: 没写完的内心戏"), "");
  assert.equal(stripMetaBlocks("  正常正文"), "正常正文");
  assert.equal(stripMetaBlocks("<mood>Vibe: 内心戏</mood>正文"), "正文");
  assert.equal(stripMetaBlocks(""), "");
});

test("stripMetaBlocks：方括号 [mood] 开头也能滤掉（DSv4 混搭格式）", () => {
  // 方括号开头 + 尖括号收尾（实测案例：DSv4 输出 [mood]…</mood>）
  assert.equal(stripMetaBlocks("[mood]\nVibe: 内心戏\n</mood>\n\n这才是正文"), "这才是正文");
  // 方括号完整闭合
  assert.equal(stripMetaBlocks("[mood]Vibe: 内心戏[/mood]正文"), "正文");
  // 正文中间混搭块（真实形态：方括号开 + 尖括号闭）
  assert.equal(stripMetaBlocks("开头正文 [mood]Vibe: 内心戏</mood> 结尾正文"), "开头正文 结尾正文");
  // 未闭合方括号开头残留
  assert.equal(stripMetaBlocks("[mood]Vibe: 没写完的内心戏"), "");
  // 正常正文不受影响
  assert.equal(stripMetaBlocks("正常正文，没有花括号"), "正常正文，没有花括号");
});

test("提取文本：纯工具调用时给提示", () => {
  const msg = {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "exec_command", arguments: "{}" }]
  };
  assert.equal(extractAssistantText(msg), "[调用了 exec_command]");
});

test("提取文本：空内容返回空串", () => {
  assert.equal(extractAssistantText({ content: [] }), "");
  assert.equal(extractAssistantText(null), "");
  assert.equal(extractAssistantText({}), "");
});

test("sessionIdFromPath 兼容反斜杠与大小写", () => {
  assert.equal(sessionIdFromPath("C:\\Users\\x\\.hanako\\agents\\hanako\\sessions\\abc.jsonl"), "abc");
  assert.equal(sessionIdFromPath(".../sessions/ABC.JSONL"), "ABC");
  assert.equal(sessionIdFromPath(null), "");
  assert.equal(sessionIdFromPath(""), "");
});

test("isFinalTurn：只认 stop 或缺失", () => {
  assert.equal(isFinalTurn("stop"), true);
  assert.equal(isFinalTurn(null), true);
  assert.equal(isFinalTurn(undefined), true);
  assert.equal(isFinalTurn(""), true);
  assert.equal(isFinalTurn("toolUse"), false);
  assert.equal(isFinalTurn("length"), false);
});
