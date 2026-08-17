// 提个醒 · 会话标题读取测试
// 覆盖：标题映射文件读取、三种 key 匹配（sessionId/完整路径/文件名）、路径分隔符归一化、缺文件回退

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { loadSessionTitles, findSessionTitle, getSessionTitle, resolveSessionTitle } from "../lib/session-title.js";

const SESSION_DIR = "sessions";
const SAMPLE = {
  "C:\\Users\\user\\.hanako\\agents\\hanako\\sessions\\2026-06-18T00-40-57-885Z_019ed82c-891c-77af-b810-f57da61668d9.jsonl": "GitHub项目使用指南",
  "sess_0mqk8fx5z_5d7781fc619c89eb1d9d": "GitHub release链接询问"
};

test("findSessionTitle：按完整路径匹配", () => {
  assert.equal(
    findSessionTitle(SAMPLE, "C:\\Users\\user\\.hanako\\agents\\hanako\\sessions\\2026-06-18T00-40-57-885Z_019ed82c-891c-77af-b810-f57da61668d9.jsonl", "abc"),
    "GitHub项目使用指南"
  );
});

test("findSessionTitle：按 sessionId 匹配", () => {
  assert.equal(findSessionTitle(SAMPLE, "/x/y/whatever.jsonl", "sess_0mqk8fx5z_5d7781fc619c89eb1d9d"), "GitHub release链接询问");
});

test("findSessionTitle：路径分隔符归一化（正斜杠也能命中反斜杠 key）", () => {
  assert.equal(
    findSessionTitle(SAMPLE, "C:/Users/user/.hanako/agents/hanako/sessions/2026-06-18T00-40-57-885Z_019ed82c-891c-77af-b810-f57da61668d9.jsonl", ""),
    "GitHub项目使用指南"
  );
});

test("findSessionTitle：未命中返回 null", () => {
  assert.equal(findSessionTitle(SAMPLE, "/x/y/z.jsonl", "sess_unknown"), null);
  assert.equal(findSessionTitle(null, "/x", "s"), null);
  assert.equal(findSessionTitle({}, "/x", "s"), null);
});

test("loadSessionTitles：文件不存在返回空对象", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "txs-title-"));
  try {
    assert.deepEqual(loadSessionTitles(tmp, "hanako"), {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("getSessionTitle：真实目录结构读标题", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "txs-title-"));
  try {
    const sessDir = path.join(tmp, "hanako", SESSION_DIR);
    fs.mkdirSync(sessDir, { recursive: true });
    const p = path.join(sessDir, "2026-06-18T00-40-57-885Z_019ed82c-891c-77af-b810-f57da61668d9.jsonl");
    const titles = {
      [p]: "GitHub项目使用指南",
      "sess_0mqk8fx5z_5d7781fc619c89eb1d9d": "GitHub release链接询问"
    };
    fs.writeFileSync(path.join(sessDir, "session-titles.json"), JSON.stringify(titles), "utf-8");
    assert.equal(getSessionTitle(tmp, "hanako", p, "sess_x"), "GitHub项目使用指南");
    // 正斜杠路径也能命中（分隔符归一化）
    assert.equal(getSessionTitle(tmp, "hanako", p.replace(/\\/g, "/"), "sess_x"), "GitHub项目使用指南");
    // 文件损坏回退 null
    fs.writeFileSync(path.join(sessDir, "session-titles.json"), "{bad json", "utf-8");
    assert.equal(getSessionTitle(tmp, "hanako", p, "sess_x"), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveSessionTitle：宿主接口命中 sess_ 映射（真实通知链路）", async () => {
  const bus = { request: async () => ({ titles: { "/x/y/s.jsonl": "设置面板风格优化建议" } }) };
  assert.equal(await resolveSessionTitle({ bus, agentsHome: "/a", agentId: "hanako", sessionPath: "/x/y/s.jsonl", sessionId: "file-name" }), "设置面板风格优化建议");
});

test("resolveSessionTitle：接口失败回退文件版", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "txs-title-"));
  try {
    const sessDir = path.join(tmp, "hanako", SESSION_DIR);
    fs.mkdirSync(sessDir, { recursive: true });
    const p = path.join(sessDir, "old-session.jsonl");
    fs.writeFileSync(path.join(sessDir, "session-titles.json"), JSON.stringify({ [p]: "GitHub项目使用指南" }), "utf-8");
    const bus = { request: async () => { throw new Error("bus down"); } };
    assert.equal(await resolveSessionTitle({ bus, agentsHome: tmp, agentId: "hanako", sessionPath: p, sessionId: "" }), "GitHub项目使用指南");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveSessionTitle：接口返回空也回退文件版", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "txs-title-"));
  try {
    const sessDir = path.join(tmp, "hanako", SESSION_DIR);
    fs.mkdirSync(sessDir, { recursive: true });
    const p = path.join(sessDir, "old-session.jsonl");
    fs.writeFileSync(path.join(sessDir, "session-titles.json"), JSON.stringify({ [p]: "GitHub项目使用指南" }), "utf-8");
    const bus = { request: async () => ({ titles: {} }) };
    assert.equal(await resolveSessionTitle({ bus, agentsHome: tmp, agentId: "hanako", sessionPath: p, sessionId: "" }), "GitHub项目使用指南");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
