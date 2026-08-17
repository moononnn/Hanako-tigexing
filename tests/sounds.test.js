// 提个醒 · 音效与助手扫描测试
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSounds, resolveSound, soundsDir } from "../lib/sounds.js";
import { listAgentsFromDisk } from "../lib/agents.js";

function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "txs-snd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("soundsDir 自动创建目录", (t) => {
  const dir = makeTmp(t);
  const sd = soundsDir(dir);
  assert.ok(fs.existsSync(sd));
  assert.ok(sd.endsWith("sounds"));
});

test("listSounds 只列白名单音频，忽略其他文件", (t) => {
  const dir = makeTmp(t);
  const sd = soundsDir(dir);
  fs.writeFileSync(path.join(sd, "zelda.wav"), "x");
  fs.writeFileSync(path.join(sd, "animal.mp3"), "x");
  fs.writeFileSync(path.join(sd, "note.m4a"), "x");
  fs.writeFileSync(path.join(sd, "readme.txt"), "x");
  fs.writeFileSync(path.join(sd, "hide.aac"), "x");
  const files = listSounds(dir);
  assert.deepEqual(files, ["animal.mp3", "hide.aac", "note.m4a", "zelda.wav"]);
});

test("listSounds 空目录返回空数组", (t) => {
  const dir = makeTmp(t);
  assert.deepEqual(listSounds(dir), []);
});

// ── 自定义音效文件夹（v0.4.0：设置页可配，留空回默认） ──

test("soundsDir 自定义目录：用用户路径并自动创建", (t) => {
  const dir = makeTmp(t);
  const custom = path.join(dir, "我的音效");
  const sd = soundsDir(dir, custom);
  assert.ok(fs.existsSync(sd));
  assert.equal(sd, custom);
});

test("soundsDir 自定义目录留空/非法时回退默认", (t) => {
  const dir = makeTmp(t);
  assert.ok(soundsDir(dir, "").endsWith("sounds"));
  assert.ok(soundsDir(dir, "   ").endsWith("sounds"));
  assert.ok(soundsDir(dir, null).endsWith("sounds"));
  assert.ok(soundsDir(dir, undefined).endsWith("sounds"));
  assert.ok(soundsDir(dir, 123).endsWith("sounds"));
});

test("listSounds 自定义目录生效，默认目录不再看", (t) => {
  const dir = makeTmp(t);
  const def = soundsDir(dir); // 默认目录放一个，不该被自定义目录读到
  fs.writeFileSync(path.join(def, "old.wav"), "x");
  const custom = path.join(dir, "custom-snd");
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, "new.mp3"), "x");
  fs.writeFileSync(path.join(custom, "note.txt"), "x");
  assert.deepEqual(listSounds(dir, custom), ["new.mp3"]);
});

test("resolveSound 自定义目录解析 + 防路径穿越照常生效", (t) => {
  const dir = makeTmp(t);
  const custom = path.join(dir, "custom-snd");
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, "zelda.wav"), "x");
  const r = resolveSound(dir, "zelda.wav", custom);
  assert.ok(r && r.endsWith("zelda.wav") && r.includes("custom-snd"));
  assert.equal(resolveSound(dir, "../evil.wav", custom), null);
  assert.equal(resolveSound(dir, "zelda.wav", ""), null, "不传自定义目录时默认目录里没有该文件");
});

test("resolveSound 正常解析存在的文件", (t) => {
  const dir = makeTmp(t);
  const sd = soundsDir(dir);
  fs.writeFileSync(path.join(sd, "ding.wav"), "x");
  const r = resolveSound(dir, "ding.wav");
  assert.ok(r && r.endsWith("ding.wav"));
});

test("resolveSound 防路径穿越", (t) => {
  const dir = makeTmp(t);
  assert.equal(resolveSound(dir, "../evil.wav"), null);
  assert.equal(resolveSound(dir, "a\\b.wav"), null);
  assert.equal(resolveSound(dir, "C:/evil.wav"), null);
});

test("resolveSound 白名单外扩展名与不存在文件返回 null", (t) => {
  const dir = makeTmp(t);
  assert.equal(resolveSound(dir, "note.exe"), null);
  assert.equal(resolveSound(dir, "no.wav"), null);
  assert.equal(resolveSound(dir, ""), null);
  assert.equal(resolveSound(dir, null), null);
});

test("listAgentsFromDisk 读 id 和 config.yaml 的 name", (t) => {
  const dir = makeTmp(t);
  const agents = path.join(dir, "agents");
  fs.mkdirSync(path.join(agents, "hanako"), { recursive: true });
  fs.mkdirSync(path.join(agents, "feiyue"), { recursive: true });
  fs.writeFileSync(path.join(agents, "hanako", "config.yaml"), "# comment\nagent:\n  name: 小花\n  yuan: hanako\n");
  // feiyue 无 config.yaml → 显示名回退 id
  const list = listAgentsFromDisk(agents);
  assert.deepEqual(list, [
    { id: "feiyue", name: "feiyue" },
    { id: "hanako", name: "小花" }
  ]);
});

test("listAgentsFromDisk 目录不存在返回空", () => {
  assert.deepEqual(listAgentsFromDisk("Z:/no-such-dir"), []);
});
