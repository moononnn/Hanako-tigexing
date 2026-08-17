// 提个醒 · 助手头像解析测试
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentAvatar } from "../lib/agent-avatar.js";

function makeFakeAgent(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txs-avatar-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agents = path.join(dir, "agents");
  const av = path.join(agents, "hanako", "avatars");
  fs.mkdirSync(av, { recursive: true });
  return { agents, av };
}

test("找到 png 头像", (t) => {
  const { agents, av } = makeFakeAgent(t);
  fs.writeFileSync(path.join(av, "agent.png"), "x");
  const r = resolveAgentAvatar(agents, "hanako");
  assert.ok(r && r.endsWith("agent.png"));
});

test("优先级 png > jpg > webp", (t) => {
  const { agents, av } = makeFakeAgent(t);
  fs.writeFileSync(path.join(av, "a.webp"), "x");
  fs.writeFileSync(path.join(av, "b.png"), "x");
  fs.writeFileSync(path.join(av, "c.jpg"), "x");
  const r = resolveAgentAvatar(agents, "hanako");
  assert.ok(r && r.endsWith("b.png"));
});

test("大小写不敏感匹配扩展名", (t) => {
  const { agents, av } = makeFakeAgent(t);
  fs.writeFileSync(path.join(av, "FACE.JPG"), "x");
  const r = resolveAgentAvatar(agents, "hanako");
  assert.ok(r && r.endsWith("FACE.JPG"));
});

test("无头像目录返回 null", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txs-avatar-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(resolveAgentAvatar(dir, "nobody"), null);
  assert.equal(resolveAgentAvatar(null, "x"), null);
  assert.equal(resolveAgentAvatar("x", null), null);
});
