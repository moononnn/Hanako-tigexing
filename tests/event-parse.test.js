// 提个醒 · 事件解析测试
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTurnEnd,
  parseTurnFailure,
  parseProviderError,
  parseSessionAbort,
  isUserInitiatedAbortReason,
  parseAutoRetryStart,
  parseAutoRetryEnd,
  parseSessionUnhealthyWarning,
  parseActivityUpdate,
  parseSessionBackgroundTask,
  sessionIdFromPath,
  agentIdFromSessionPath,
  extractAssistantText,
  stripMetaBlocks,
  isFinalTurn
} from "../lib/event-parse.js";

test("非 turn_end 事件返回 null", () => {
  assert.equal(parseTurnEnd({ type: "turn_start", agentId: "hanako" }, null), null);
  assert.equal(parseTurnEnd(null, null), null);
  assert.equal(parseTurnEnd("str", null), null);
});

// ── session_background_task（子 agent 完成门） ──

test("session_background_task：解析开始/结束及会话路径", () => {
  const sp = "C:/Users/x/.hanako/agents/hanako/sessions/main.jsonl";
  assert.deepEqual(parseSessionBackgroundTask({
    type: "session_background_task",
    action: "upsert",
    taskId: "child-a",
    sessionId: "logical-main"
  }, sp), { action: "upsert", taskId: "child-a", sessionId: "main", sessionPath: sp, status: "" });
  assert.deepEqual(parseSessionBackgroundTask({
    type: "session_background_task",
    action: "remove",
    taskId: "child-a",
    sessionPath: sp
  }, null), { action: "remove", taskId: "child-a", sessionId: "main", sessionPath: sp, status: "" });
  assert.equal(parseSessionBackgroundTask({ type: "session_background_task", action: "upsert" }, sp), null);
  assert.equal(parseSessionBackgroundTask({ type: "turn_end", action: "remove", taskId: "x" }, sp), null);
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
      status: "done",
      sessionFile: "cron_123.jsonl"
    }
  };
  const r = parseActivityUpdate(ev);
  assert.equal(r.kind, "scheduled");
  assert.equal(r.agentId, "hanako");
  assert.equal(r.agentName, "小花");
  assert.equal(r.label, "每日备份");
  assert.equal(r.status, "done");
  assert.equal(r.sessionFile, "cron_123.jsonl");
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
  assert.equal(extractAssistantText(msg), "开头正文结尾正文");
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
  assert.equal(stripMetaBlocks("开头正文 [mood]Vibe: 内心戏</mood> 结尾正文"), "开头正文结尾正文");
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

// ── 异常回合事件（只观察，不续接） ──

const sessionPath = "C:/Users/x/.hanako/agents/hanako/sessions/turn-1.jsonl";

test("异常事件：从 sessionPath 推导助手和会话", () => {
  assert.equal(agentIdFromSessionPath(sessionPath), "hanako");
  const r = parseTurnFailure({
    type: "turn_end",
    message: {
      stopReason: "error",
      errorMessage: "WebSocket error",
      content: [{ type: "text", text: "已经收到一半" }]
    }
  }, sessionPath);
  assert.equal(r.agentId, "hanako");
  assert.equal(r.sessionId, "turn-1");
  assert.equal(r.text, "已经收到一半");
  assert.equal(r.errorMessage, "WebSocket error");
});

test("异常事件：正常 stop 和工具中间轮不进入失败解析", () => {
  assert.equal(parseTurnFailure({ type: "turn_end", message: { stopReason: "stop", content: [] } }, sessionPath), null);
  assert.equal(parseTurnFailure({ type: "turn_end", message: { stopReason: "toolUse", content: [] } }, sessionPath), null);
});

test("异常事件：非主动超时释放进入失败解析，主动停止过滤", () => {
  const timeout = parseTurnFailure({ type: "turn_end", aborted: true, reason: "turn_stall_timeout" }, sessionPath);
  assert.equal(timeout.reason, "turn_stall_timeout");
  assert.equal(timeout.errorMessage, "turn_stall_timeout");
  assert.equal(parseTurnFailure({ type: "turn_end", aborted: true, reason: "abort" }, sessionPath), null);
  assert.equal(isUserInitiatedAbortReason("close_all"), true);
});

test("异常事件：error 和 session_status 释放可作为兜底", () => {
  const provider = parseProviderError({ type: "error", message: "fetch failed" }, sessionPath);
  assert.equal(provider.sessionId, "turn-1");
  assert.equal(provider.errorMessage, "fetch failed");
  const abort = parseSessionAbort({ type: "session_status", isStreaming: false, aborted: true, reason: "turn_stall_timeout" }, sessionPath);
  assert.equal(abort.reason, "turn_stall_timeout");
  assert.equal(parseSessionAbort({ type: "session_status", isStreaming: false, aborted: true, reason: "abort_all" }, sessionPath), null);
});

test("异常事件：自动重试开始/结束解析", () => {
  const start = parseAutoRetryStart({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage: "fetch failed" }, sessionPath);
  assert.equal(start.agentId, "hanako");
  assert.equal(start.attempt, 2);
  assert.equal(start.maxAttempts, 3);
  assert.equal(start.errorMessage, "fetch failed");

  const failed = parseAutoRetryEnd({ type: "auto_retry_end", success: false, attempt: 3, finalError: "WebSocket error" }, sessionPath);
  assert.equal(failed.success, false);
  assert.equal(failed.attempt, 3);
  assert.equal(failed.finalError, "WebSocket error");

  const success = parseAutoRetryEnd({ type: "auto_retry_end", success: true, attempt: 1 }, sessionPath);
  assert.equal(success.success, true);
});

test("异常事件：会话不健康警告保留计数", () => {
  const r = parseSessionUnhealthyWarning({ type: "session_unhealthy_warning", recentErrors: 4, totalChecked: 4 }, sessionPath);
  assert.equal(r.agentId, "hanako");
  assert.equal(r.recentErrors, 4);
  assert.equal(r.totalChecked, 4);
  assert.equal(parseSessionUnhealthyWarning({ type: "session_status" }, sessionPath), null);
});


// ── 思考链块剥离（v0.4.11 新增修复：通知文案漏思考链） ──

test("stripMetaBlocks：剥离反引号 think 块（MiniMax-M3 默认，闭标签带斜杠）", () => {
  const ml = "好的\x60think\x3e哦，用户在看视频\n\x60\x2fthink\x3e这条弹幕不错";
  assert.equal(stripMetaBlocks(ml), "好的这条弹幕不错");
  const inline = "前\x60think\x3e思考\x60\x2fthink\x3e后";
  assert.equal(stripMetaBlocks(inline), "前后");
});

test("stripMetaBlocks：剥离 <thinking>...</thinking> 块（Anthropic / 通用 XML）", () => {
  assert.equal(stripMetaBlocks("前\x3cthinking\x3e内部思考\x3c\x2fthinking\x3e后"), "前后");
  assert.equal(stripMetaBlocks("\x3cthinking\x3e多行\n思考\x3c\x2fthinking\x3e\n正文"), "正文");
  assert.equal(stripMetaBlocks("<mood>Vibe: 内心戏</mood>\x3cthinking\x3e思考\x3c\x2fthinking\x3e真想说"), "真想说");
});

test("stripMetaBlocks：think 块开头未闭合残留被清掉", () => {
  assert.equal(stripMetaBlocks("\x60think\x3eVibe: 还没想完"), "");
  assert.equal(stripMetaBlocks("\x3cthinking\x3e思考被打断"), "");
  assert.equal(stripMetaBlocks("  正常正文"), "正常正文");
});

test("提取文本：含 think 块的 text part 也能清掉（关键回归）", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "独立 thinking part 直接跳过" },
      { type: "text", text: "\x60think\x3e哦，问用户选择的面板弹不出来——解…\x60\x2fthink\x3e这是真想说" }
    ]
  };
  assert.equal(extractAssistantText(msg), "这是真想说");
});

test("提取文本：仅含 think 块的纯思考回复返回空串（兜底）", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "text", text: "\x60think\x3e纯粹思考\x60\x2fthink\x3e" }
    ]
  };
  assert.equal(extractAssistantText(msg), "");
});

test("提取文本：think 块 + mood 块混搭都剥离", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "text", text: "<mood>\nVibe: 内心戏\n</mood>\n\n\x60think\x3e思考\x60\x2fthink\x3e\n真正的回复" }
    ]
  };
  assert.equal(extractAssistantText(msg), "真正的回复");
});
