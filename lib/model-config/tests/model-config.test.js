// model-config 测试 — node:test 零依赖
// 运行：node --test tests/model-config.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createCrypto, encryptKey, decryptKey, maskKey, protectKey, unprotectKey, getStorageMode,
  mergeModelConfig, sanitizeModelConfig, validateModelConfig, normalizeApi,
  ModelConfig, extractModelText, parseModelJson,
} from "../index.js";

// ── 工具：内存 store ──
function makeStore(initial = {}) {
  let cfg = { modelSource: "agent", agentFollow: "", ...initial };
  return {
    getConfig: () => cfg,
    saveConfig: async (mutator) => { mutator(cfg); },
    _peek: () => cfg,
  };
}

function makeCtx(overrides = {}) {
  const calls = [];
  return {
    bus: {
      request: async (topic, payload, opts) => {
        calls.push({ topic, payload, opts });
        return { text: `ok:${topic}` };
      },
    },
    network: {
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: "通了" } }] }),
          json: async () => ({ choices: [{ message: { content: "通了" } }] }),
        };
      },
    },
    agentId: "hanako",
    sessionPath: "/tmp/s.json",
    log: { warn: () => {}, info: () => {}, error: () => {} },
    _calls: calls,
    ...overrides,
  };
}

// ═══════ crypto ═══════

test("crypto：加密/解密往返一致", () => {
  const c = createCrypto("test-salt");
  const plain = "sk-1234567890abcdef";
  const enc = c.encryptKey(plain);
  assert.ok(enc.startsWith("enc:"));
  assert.notEqual(enc, plain);
  assert.equal(c.decryptKey(enc), plain);
});

test("crypto：空值处理（空串不进加密，解密空串返回空）", () => {
  const c = createCrypto("test-salt");
  assert.equal(c.encryptKey(""), "");
  assert.equal(c.decryptKey(""), "");
  assert.equal(c.decryptKey(null), "");
});

test("crypto：兼容旧版明文存量（不带 enc: 前缀原样返回）", () => {
  const c = createCrypto("test-salt");
  assert.equal(c.decryptKey("sk-plain-old"), "sk-plain-old");
});

test("crypto：明文恰好以 enc: 开头不会被误判（非 base64 回退原样）", () => {
  const c = createCrypto("test-salt");
  assert.equal(c.decryptKey("enc:hello world"), "enc:hello world"); // 含空格非法 base64
  assert.equal(c.decryptKey("enc:abc"), "enc:abc");                 // 长度不是 4 的倍数
  assert.equal(c.decryptKey("enc:!!!"), "enc:!!!");                 // 非法字符
});

test("crypto：mask 规则 — 短 Key 全星、长 Key 保头尾", () => {
  const c = createCrypto("test-salt");
  assert.equal(c.maskKey(""), "");
  assert.equal(c.maskKey(c.encryptKey("short123")), "********");
  const long = c.encryptKey("sk-abcdefghijklmnop");
  assert.equal(c.maskKey(long), "sk-a…mnop");
});

test("crypto：不同 salt 互相解不开（同 salt 才能解）", () => {
  const enc = createCrypto("salt-a").encryptKey("secret");
  const b = createCrypto("salt-b");
  assert.notEqual(b.decryptKey(enc), "secret");
});

// ═══════ dpapi / 三层存储（L2 系统锁 / enc 兼容 / L3 明文兜底）═══════

test("crypto：protect/unprotect 往返（Windows 真 DPAPI；非 Windows 明文兜底）", async () => {
  const c = createCrypto("test-salt");
  const enc = await c.protectKey("sk-dpapi-12345");
  assert.ok(enc);
  if (process.platform === "win32") {
    assert.ok(enc.startsWith("dpapi:"));
    assert.equal(await c.unprotectKey(enc), "sk-dpapi-12345");
  } else {
    assert.equal(enc, "sk-dpapi-12345"); // 非 Windows 明文兜底
  }
});

test("crypto：dpapi 禁用时 protectKey 明文兜底（不产生伪加密）", async () => {
  const c = createCrypto("test-salt", { dpapi: false });
  assert.equal(await c.protectKey("sk-plain"), "sk-plain");
  assert.equal(await c.unprotectKey("sk-plain"), "sk-plain");
  assert.equal(c.getStorageMode("sk-plain"), "plain");
});

test("crypto：unprotectKey 通吃 dpapi: / enc: / 明文三种存量", async () => {
  const c = createCrypto("test-salt");
  const dp = await c.protectKey("k1");
  assert.equal(await c.unprotectKey(dp), "k1");
  assert.equal(await c.unprotectKey(c.encryptKey("k2")), "k2"); // enc: 兼容
  assert.equal(await c.unprotectKey("plain-k3"), "plain-k3");   // 明文原样
});

test("crypto：maskKey 对 dpapi: 只显示加密标识，不解密", async () => {
  const c = createCrypto("test-salt");
  const enc = await c.protectKey("sk-very-secret-key-123");
  assert.equal(c.maskKey(enc), "********");
});

test("crypto：getStorageMode 各态", () => {
  const c = createCrypto("test-salt");
  assert.equal(c.getStorageMode(""), "none");
  assert.equal(c.getStorageMode("dpapi:xxx"), "dpapi");
  assert.equal(c.getStorageMode("enc:xxx"), "enc");
  assert.equal(c.getStorageMode("plain"), "plain");
});

test("merge：enc: 存量保存时自动迁移（新 Key 不再产生 enc:）", async () => {
  const c = createCrypto("test-salt");
  const prev = { customModel: { apiKey: c.encryptKey("sk-old-legacy") } };
  const out = await mergeModelConfig(prev, { customModel: { apiKey: "sk-new" } }, c);
  assert.equal(await unprotectKey(out.customModel.apiKey), "sk-new");
  assert.ok(!out.customModel.apiKey.startsWith("enc:")); // 新写入不产生伪加密
});

// ═══════ merge / sanitize / validate ═══════

test("merge：普通字段覆盖、apiKey 加密落盘", async () => {
  const c = createCrypto("test-salt");
  const out = await mergeModelConfig({}, {
    source: "custom",
    customModel: { baseUrl: "https://x", apiKey: "sk-abc", model: "m1", api: "openai-completions" },
  }, c);
  assert.equal(out.modelSource, "custom");
  assert.notEqual(out.customModel.apiKey, "sk-abc"); // 不落明文
  assert.equal(await unprotectKey(out.customModel.apiKey), "sk-abc"); // 能还原
});

test("merge：空值 / 占位符不覆盖已存 Key", async () => {
  const prev = { customModel: { apiKey: encryptKey("sk-old") } };
  let out = await mergeModelConfig(prev, { customModel: { apiKey: "" } });
  assert.equal(decryptKey(out.customModel.apiKey), "sk-old");
  out = await mergeModelConfig(prev, { customModel: { apiKey: "********" } });
  assert.equal(decryptKey(out.customModel.apiKey), "sk-old");
});

test("merge：clearApiKey 显式清除", async () => {
  const prev = { customModel: { apiKey: encryptKey("sk-old") } };
  const out = await mergeModelConfig(prev, { customModel: { clearApiKey: true } });
  assert.equal(out.customModel.apiKey, "");
});

test("merge：hanaModel 局部字段更新不丢另一半", async () => {
  const prev = { hanaModel: { providerId: "p1", modelId: "m1" } };
  const out = await mergeModelConfig(prev, { hanaModel: { modelId: "m2" } });
  assert.deepEqual(out.hanaModel, { providerId: "p1", modelId: "m2" });
});

test("merge：next 为空时原样返回", async () => {
  const prev = { source: "agent" };
  assert.deepEqual(await mergeModelConfig(prev, null), { source: "agent" });
});

test("sanitize：永不含明文 Key，只有掩码", () => {
  const raw = {
    source: "custom",
    customModel: { baseUrl: "https://x", apiKey: encryptKey("sk-super-secret"), model: "m1" },
  };
  const s = sanitizeModelConfig(raw);
  assert.equal(s.customModel.apiKeyMask, "sk-s…cret");
  assert.equal(s.customModel.storageMode, "enc");
  assert.ok(!JSON.stringify(s).includes("sk-super-secret"));
  assert.ok(!JSON.stringify(s).includes("enc:"));
});

test("sanitize：缺省字段有安全默认值", () => {
  const s = sanitizeModelConfig({});
  assert.equal(s.source, "agent");
  assert.equal(s.modelSource, "agent");
  assert.deepEqual(s.hanaModel, { providerId: "", modelId: "" });
  assert.deepEqual(s.customModel, { baseUrl: "", apiKeyMask: "", storageMode: "none", model: "", api: "openai-completions" });
});

test("sanitize：source 与 modelSource 双字段一致（存取契约统一）", () => {
  const s = sanitizeModelConfig({ modelSource: "hana", hanaModel: { providerId: "p", modelId: "m" } });
  assert.equal(s.source, "hana");
  assert.equal(s.modelSource, "hana");
  // 旧写法 source 也兼容
  const s2 = sanitizeModelConfig({ source: "custom" });
  assert.equal(s2.source, "custom");
  assert.equal(s2.modelSource, "custom");
});

test("validate：agent 档永远可用", () => {
  assert.deepEqual(validateModelConfig({ source: "agent" }), { ok: true });
  assert.deepEqual(validateModelConfig({}), { ok: true });
});

test("validate：hana 档必须选了 provider + model", () => {
  assert.equal(validateModelConfig({ source: "hana", hanaModel: {} }).ok, false);
  assert.equal(validateModelConfig({ source: "hana", hanaModel: { providerId: "p" } }).ok, false);
  assert.deepEqual(
    validateModelConfig({ source: "hana", hanaModel: { providerId: "p", modelId: "m" } }),
    { ok: true },
  );
});

test("validate：custom 档缺字段 / 非法 URL 报错", () => {
  assert.equal(validateModelConfig({ source: "custom", customModel: {} }).ok, false);
  assert.equal(
    validateModelConfig({ source: "custom", customModel: { baseUrl: "ftp://x", apiKey: "k", model: "m" } }).ok,
    false,
  );
  assert.equal(
    validateModelConfig({ source: "custom", customModel: { baseUrl: "https://x", apiKey: "k", model: "m" } }).ok,
    true,
  );
});

test("normalizeApi：兼容各写法", () => {
  assert.equal(normalizeApi("openai-completions"), "openai-completions");
  assert.equal(normalizeApi("openai"), "openai-completions");
  assert.equal(normalizeApi("openai-responses"), "openai-responses");
  assert.equal(normalizeApi("responses"), "openai-responses");
  assert.equal(normalizeApi("anthropic-messages"), "anthropic-messages");
  assert.equal(normalizeApi("claude"), "anthropic-messages");
  assert.equal(normalizeApi(undefined), "openai-completions");
});

// ═══════ ModelConfig 类 ═══════

test("ModelConfig：缺 ctx / store 直接抛错", () => {
  assert.throws(() => new ModelConfig({ store: makeStore() }));
  assert.throws(() => new ModelConfig({ ctx: makeCtx() }));
});

test("ModelConfig：saveConfig 走 merge + 加密落盘", async () => {
  const store = makeStore();
  const mc = new ModelConfig({ ctx: makeCtx(), store, });
  await mc.saveConfig({ source: "custom", customModel: { baseUrl: "https://x", apiKey: "sk-1", model: "m" } });
  const cfg = store._peek();
  assert.equal(cfg.modelSource, "custom");
  const stored = cfg.customModel.apiKey;
  assert.notEqual(stored, "sk-1"); // 不落明文
  assert.equal(await unprotectKey(stored), "sk-1"); // 能还原
  assert.ok(cfg.updatedAt);
});

test("ModelConfig：agent 档走 bus 且带 agentId/sessionPath", async () => {
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store: makeStore() });
  const text = await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(text, "ok:utility:call-text");
  const call = ctx._calls[0];
  assert.equal(call.topic, "utility:call-text");
  assert.equal(call.payload.agentId, "hanako");
  assert.equal(call.payload.sessionPath, "/tmp/s.json");
  assert.equal(call.payload.operation, "model-config");
});

test("ModelConfig：agent 档 sample 的 source 覆盖优先于配置", async () => {
  const store = makeStore({ modelSource: "hana", hanaModel: { providerId: "p", modelId: "m" } });
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store });
  await mc.sample([{ role: "user", content: "hi" }], { source: "agent" });
  const call = ctx._calls[0];
  assert.equal(call.payload.agentId, "hanako");
  assert.equal(call.payload.providerId, undefined);
});

test("ModelConfig：hana 档直连选定模型，不把 providerId/modelId 传给 utility", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tigexing-hana-direct-"));
  const modelsPath = path.join(dir, "models.json");
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: {
    p1: { baseUrl: "https://model.test/v1", api: "openai-completions", models: [{ id: "m1", input: ["text"] }] },
  } }));
  const store = makeStore({ modelSource: "hana", hanaModel: { providerId: "p1", modelId: "m1" } });
  const ctx = makeCtx({
    bus: { request: async (topic, payload, opts) => {
      ctx._calls.push({ topic, payload, opts });
      if (topic === "provider:credentials") return { apiKey: "test-key" };
      throw new Error(`不应调用 ${topic}`);
    } },
    network: { fetch: async (url, init) => {
      ctx._calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "通了" } }] }) };
    } },
  });
  const oldHome = process.env.HANA_HOME;
  process.env.HANA_HOME = dir;
  try {
    const mc = new ModelConfig({ ctx, store });
    const text = await mc.sample([{ role: "user", content: "hi" }], { modelsPath });
    assert.equal(text, "通了");
    assert.equal(ctx._calls.some((call) => call.topic === "utility:call-text"), false);
    const call = ctx._calls.find((item) => item.url);
    assert.equal(call.url, "https://model.test/v1/chat/completions");
    assert.equal(call.init.headers.Authorization, "Bearer test-key");
    assert.equal(JSON.parse(call.init.body).model, "m1");
  } finally {
    if (oldHome === undefined) delete process.env.HANA_HOME;
    else process.env.HANA_HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ModelConfig：custom 档直连 fetch（openai-completions）", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.x.com/v1", apiKey: encryptKey("sk-custom"), model: "m9" },
  });
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store, });
  const text = await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(text, "通了");
  const call = ctx._calls[0];
  assert.equal(call.url, "https://api.x.com/v1/chat/completions");
  assert.equal(call.init.headers.Authorization, "Bearer sk-custom");
  assert.equal(call.init.body.includes('"model":"m9"'), true);
});

test("ModelConfig：custom 档 openai-responses 拼 /responses", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.x.com/v1", apiKey: encryptKey("k"), model: "m", api: "openai-responses" },
  });
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store, });
  await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(ctx._calls[0].url, "https://api.x.com/v1/responses");
  assert.equal(ctx._calls[0].init.headers.Authorization, "Bearer k");
});

test("ModelConfig：custom 档 baseUrl 填完整 /responses 端点不重复拼", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.x.com/v1/responses", apiKey: encryptKey("k"), model: "m", api: "openai-responses" },
  });
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store, });
  await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(ctx._calls[0].url, "https://api.x.com/v1/responses");
});

test("ModelConfig：custom 档 baseUrl 填完整 /chat/completions 端点不重复拼", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.x.com/v1/chat/completions", apiKey: encryptKey("k"), model: "m", api: "openai-completions" },
  });
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store, });
  await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(ctx._calls[0].url, "https://api.x.com/v1/chat/completions");
});

test("ModelConfig：custom 档 anthropic-messages 走 /v1/messages + x-api-key 头", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.anthropic.com", apiKey: encryptKey("sk-ant"), model: "claude-x", api: "anthropic-messages" },
  });
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store, });
  await mc.sample([{ role: "user", content: "hi" }]);
  const call = ctx._calls[0];
  assert.equal(call.url, "https://api.anthropic.com/v1/messages");
  assert.equal(call.init.headers["x-api-key"], "sk-ant");
  assert.equal(call.init.headers["anthropic-version"], "2023-06-01");
});

test("ModelConfig：custom 档 anthropic baseUrl 已含 /v1 时不重复拼", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.anthropic.com/v1", apiKey: encryptKey("k"), model: "claude-x", api: "anthropic-messages" },
  });
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store, });
  await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(ctx._calls[0].url, "https://api.anthropic.com/v1/messages");
});

test("ModelConfig：custom 档 baseUrl 填完整 anthropic 端点不重复拼", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.anthropic.com/v1/messages", apiKey: encryptKey("k"), model: "claude-x", api: "anthropic-messages" },
  });
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store, });
  await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(ctx._calls[0].url, "https://api.anthropic.com/v1/messages");
});

test("ModelConfig：custom 档 baseUrl 尾斜杠不拼出双斜杠（/v1/ → /v1/messages）", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.anthropic.com/v1/", apiKey: encryptKey("k"), model: "claude-x", api: "anthropic-messages" },
  });
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store, });
  await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(ctx._calls[0].url, "https://api.anthropic.com/v1/messages");
});

test("ModelConfig：custom 档 anthropic 响应解析 content 数组", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.anthropic.com", apiKey: encryptKey("k"), model: "claude-x", api: "anthropic-messages" },
  });
  const ctx = makeCtx({
    network: {
      fetch: async () => ({
        ok: true, status: 200, text: async () => JSON.stringify({ content: [{ text: "a" }, { text: "b" }] }),
        json: async () => ({ content: [{ text: "a" }, { text: "b" }] }),
      }),
    },
  });
  const mc = new ModelConfig({ ctx, store });
  const text = await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(text, "ab");
});

test("ModelConfig：saveConfig 并发安全（串行队列，两次保存互不丢失）", async () => {
  let cfg = { modelSource: "agent", agentFollow: "" };
  const writes = [];
  const store = {
    getConfig: () => cfg,
    saveConfig: async (mutator) => {
      // 模拟慢速异步落盘：读-改-写中间有延迟，无串行队列时并发会互相覆盖
      const snapshot = { ...cfg };
      await new Promise((r) => setTimeout(r, 15));
      mutator(snapshot);
      cfg = snapshot;
      writes.push({ ...cfg });
    },
  };
  const mc = new ModelConfig({ ctx: makeCtx(), store });
  await Promise.all([
    mc.saveConfig({ source: "custom", customModel: { baseUrl: "https://a", apiKey: "k1", model: "m1" } }),
    mc.saveConfig({ source: "hana", hanaModel: { providerId: "p", modelId: "m" } }),
  ]);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].modelSource, "custom"); // 第一次保存先落盘
  assert.equal(writes[1].modelSource, "hana");   // 第二次保存没覆盖第一次
  // 第一次的 customModel 还留着（第二次只改 hanaModel）
  assert.equal(cfg.customModel.model, "m1");
  assert.equal(cfg.hanaModel.modelId, "m");
});

test("ModelConfig：saveConfig 前一次失败不阻塞后续保存", async () => {
  let fail = true;
  const store = {
    getConfig: () => ({ modelSource: "agent" }),
    saveConfig: async (mutator) => {
      if (fail) { fail = false; throw new Error("磁盘错误"); }
      mutator({ modelSource: "custom", customModel: { baseUrl: "https://b", apiKey: encryptKey("k2"), model: "m2" } });
    },
  };
  const mc = new ModelConfig({ ctx: makeCtx(), store });
  await assert.rejects(() => mc.saveConfig({ source: "custom" }), /磁盘错误/);
  // 前一个失败后，队列继续：第二次保存能成功（不抛错）
  await mc.saveConfig({ source: "hana", hanaModel: { providerId: "p", modelId: "m" } });
});

test("ModelConfig：custom 档配置不完整时抛错", async () => {
  const store = makeStore({ modelSource: "custom", customModel: { baseUrl: "", apiKey: "", model: "" } });
  const mc = new ModelConfig({ ctx: makeCtx(), store });
  await assert.rejects(() => mc.sample([{ role: "user", content: "hi" }]), /自定义模型配置不完整/);
});

test("ModelConfig：custom 档 HTTP 非 2xx 抛友好错误", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://x", apiKey: encryptKey("k"), model: "m" },
  });
  const ctx = makeCtx({
    network: {
      fetch: async () => ({ ok: false, status: 401, text: async () => "nope" }),
    },
  });
  const mc = new ModelConfig({ ctx, store, });
  await assert.rejects(() => mc.sample([{ role: "user", content: "hi" }]), /HTTP 401/);
});

test("ModelConfig：extractModelText 兼容多种返回形态", () => {
  assert.equal(extractModelText("plain"), "plain");
  assert.equal(extractModelText({ text: "a" }), "a");
  assert.equal(extractModelText({ content: "b" }), "b");
  assert.equal(extractModelText({ output: "c" }), "c");
  assert.equal(extractModelText({ content: [{ text: "x" }, { text: "y" }] }), "xy");
  assert.equal(extractModelText({ content: ["p", { text: "q" }] }), "pq");
  assert.equal(extractModelText(null), "");
});

// ═══════ parseModelJson（响应容错解析）═══════

test("parseModelJson：标准 JSON 直接解析", () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
});

test("parseModelJson：SSE data: 流取最后一段", () => {
  const raw = 'data: {"type":"response.created"}\n\ndata: {"output":[{"text":"你好"}]}\n\ndata: [DONE]';
  assert.deepEqual(parseModelJson(raw), { output: [{ text: "你好" }] });
});

test("parseModelJson：BOM 剥离", () => {
  assert.deepEqual(parseModelJson("\uFEFF{\"a\":1}"), { a: 1 });
});

test("parseModelJson：前导垫料从第一个 { 重新解析", () => {
  assert.deepEqual(parseModelJson('prefix text {"a":1}'), { a: 1 });
});

test("parseModelJson：完整值+尾巴按 V8 报错位置截断", () => {
  // 模拟 "null\nextra" 这类（V8 报 Unexpected non-whitespace character after JSON at position 4）
  assert.equal(parseModelJson("null\nextra"), null);
});

test("parseModelJson：无法解析时抛友好错误（含原文片段）", () => {
  assert.throws(() => parseModelJson("not json at all"), /无法解析/);
});

// ═══════ Responses 档解析 ═══════

test("ModelConfig：responses 档解析标准 output 格式", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.x.com/v1", apiKey: encryptKey("k"), model: "m", api: "openai-responses" },
  });
  const ctx = makeCtx({
    network: {
      fetch: async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "标准格式回复" }] }] }),
      }),
    },
  });
  const mc = new ModelConfig({ ctx, store });
  const text = await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(text, "标准格式回复");
});

test("ModelConfig：responses 档兼容代理返回 choices 格式", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.x.com/v1", apiKey: encryptKey("k"), model: "m", api: "openai-responses" },
  });
  const ctx = makeCtx({
    network: {
      fetch: async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "代理返回的兼容格式" } }] }),
      }),
    },
  });
  const mc = new ModelConfig({ ctx, store });
  const text = await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(text, "代理返回的兼容格式");
});

test("ModelConfig：responses 档 SSE 流式响应剥离解析", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.x.com/v1", apiKey: encryptKey("k"), model: "m", api: "openai-responses" },
  });
  const ctx = makeCtx({
    network: {
      fetch: async () => ({
        ok: true, status: 200,
        text: async () => 'data: {"type":"response.created"}\n\ndata: {"output":[{"content":[{"text":"流式回复"}]}]}\n\ndata: [DONE]',
      }),
    },
  });
  const mc = new ModelConfig({ ctx, store });
  const text = await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(text, "流式回复");
});

test("ModelConfig：responses 档多段 output 拼接", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.x.com/v1", apiKey: encryptKey("k"), model: "m", api: "openai-responses" },
  });
  const ctx = makeCtx({
    network: {
      fetch: async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ output: [
          { type: "message", content: [{ type: "output_text", text: "第一段" }] },
          { type: "message", content: "第二段直接字符串" },
        ] }),
      }),
    },
  });
  const mc = new ModelConfig({ ctx, store });
  const text = await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(text, "第一段第二段直接字符串");
});

test("ModelConfig：responses 档过滤 reasoning 条目（opg 渠道实测）", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.x.com/v1", apiKey: encryptKey("k"), model: "m", api: "openai-responses" },
  });
  const ctx = makeCtx({
    network: {
      fetch: async () => ({
        ok: true, status: 200,
        text: async () => JSON.stringify({ output: [
          { type: "reasoning", content: [{ type: "reasoning_text", text: "We need answer in Chinese." }] },
          { type: "message", content: [{ type: "output_text", text: "通了" }] },
        ] }),
      }),
    },
  });
  const mc = new ModelConfig({ ctx, store });
  const text = await mc.sample([{ role: "user", content: "hi" }]);
  assert.equal(text, "通了");
});

test("ModelConfig：响应无法解析时给友好错误", async () => {
  const store = makeStore({
    modelSource: "custom",
    customModel: { baseUrl: "https://api.x.com/v1", apiKey: encryptKey("k"), model: "m", api: "openai-completions" },
  });
  const ctx = makeCtx({
    network: {
      fetch: async () => ({ ok: true, status: 200, text: async () => "<html>error page</html>" }),
    },
  });
  const mc = new ModelConfig({ ctx, store });
  await assert.rejects(() => mc.sample([{ role: "user", content: "hi" }]), /无法解析/);
});

test("ModelConfig：testConnection 发短消息且成功返回回显", async () => {
  const store = makeStore({ modelSource: "custom", customModel: { baseUrl: "https://x", apiKey: encryptKey("k"), model: "m" } });
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store, });
  const r = await mc.testConnection();
  assert.equal(r.ok, true);
  assert.equal(r.text, "通了");
  const call = ctx._calls[0];
  assert.equal(call.init.body.includes('"temperature":0.2'), true);
  assert.equal(call.init.body.includes("回复两个字：通了"), true);
});

test("ModelConfig：getHanaModels 三态（没注入 / 正常 / 抛错）", async () => {
  const mc = new ModelConfig({ ctx: makeCtx(), store: makeStore() });
  assert.deepEqual(await mc.getHanaModels(), []);

  const mc2 = new ModelConfig({ ctx: makeCtx(), store: makeStore() });
  mc2.setHanaModelsProvider(async () => [{ id: "p1", name: "P1" }]);
  assert.deepEqual(await mc2.getHanaModels(), [{ id: "p1", name: "P1" }]);

  const mc3 = new ModelConfig({ ctx: makeCtx(), store: makeStore() });
  mc3.setHanaModelsProvider(async () => { throw new Error("boom"); });
  assert.deepEqual(await mc3.getHanaModels(), []);
});

test("ModelConfig：setHanaModelsProvider 传非函数等同清除", async () => {
  const mc = new ModelConfig({ ctx: makeCtx(), store: makeStore() });
  mc.setHanaModelsProvider("not-a-fn");
  assert.deepEqual(await mc.getHanaModels(), []);
});

// ═══════ 路由 handler ═══════

test("handler：handleGet 返回脱敏配置", async () => {
  const store = makeStore({ modelSource: "custom", customModel: { baseUrl: "https://x", apiKey: encryptKey("sk-secret"), model: "m" } });
  const mc = new ModelConfig({ ctx: makeCtx(), store, });
  const r = await mc.handleGet();
  assert.equal(r.ok, true);
  assert.equal(r.config.customModel.apiKeyMask, "sk-s…cret");
  assert.ok(!JSON.stringify(r).includes("sk-secret"));
});

test("handler：handleSave 保存并返回新脱敏配置", async () => {
  const mc = new ModelConfig({ ctx: makeCtx(), store: makeStore(), });
  const r = await mc.handleSave({ source: "custom", customModel: { baseUrl: "https://x", apiKey: "sk-new-key-12345", model: "m" } });
  assert.equal(r.ok, true);
  assert.equal(r.config.source, "custom");
  if (process.platform === "win32") {
    // 系统锁下掩码只显示加密标识
    assert.equal(r.config.customModel.apiKeyMask, "********");
    assert.equal(r.config.customModel.storageMode, "dpapi");
  } else {
    assert.equal(r.config.customModel.apiKeyMask, "sk-n…2345");
    assert.equal(r.config.customModel.storageMode, "plain");
  }
  assert.ok(!JSON.stringify(r).includes("sk-new-key-12345"));
});

test("handler：handleSave 参数非法时报错", async () => {
  const mc = new ModelConfig({ ctx: makeCtx(), store: makeStore() });
  assert.deepEqual(await mc.handleSave(null), { ok: false, error: "参数错误" });
  assert.deepEqual(await mc.handleSave("x"), { ok: false, error: "参数错误" });
});

test("handler：handleTest 配置不全返回友好错误，不抛", async () => {
  const store = makeStore({ modelSource: "custom", customModel: {} });
  const mc = new ModelConfig({ ctx: makeCtx(), store });
  const r = await mc.handleTest({});
  assert.equal(r.ok, false);
  assert.match(r.error, /自定义模型需要填写完整/);
});

test("handler：handleTest 把网络白名单错误翻译成人话", async () => {
  const store = makeStore({ modelSource: "custom", customModel: { baseUrl: "https://custom.example/v1", apiKey: encryptKey("k"), model: "m" } });
  const ctx = makeCtx({
    network: {
      fetch: async () => { const e = new Error('host "custom.example" is not declared in manifest network.allowedHosts'); e.code = 'PLUGIN_NETWORK_HOST_NOT_ALLOWED'; throw e; },
    },
  });
  const mc = new ModelConfig({ ctx, store });
  const r = await mc.handleTest({});
  assert.equal(r.ok, false);
  assert.match(r.error, /network\.allowedHosts/);
  assert.match(r.error, /重启 HanaAgent/);
});

test("handler：handleTest 成功返回连通文案（不带 patch 测已保存配置）", async () => {
  const store = makeStore({ modelSource: "custom", customModel: { baseUrl: "https://x", apiKey: encryptKey("k"), model: "m" } });
  const mc = new ModelConfig({ ctx: makeCtx(), store, });
  const r = await mc.handleTest({});
  assert.equal(r.ok, true);
  assert.match(r.note, /测试成功啦/);
});

test("ModelConfig：testConnectionWith 用临时配置测试且不落盘", async () => {
  const store = makeStore({ modelSource: "agent" }); // 已保存是 agent，表单要测 custom
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store });
  const r = await mc.testConnectionWith("custom", {
    customModel: { baseUrl: "https://api.x.com/v1", apiKey: "sk-temp", model: "m9" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, "通了");
  // 不落盘：store 里还是 agent 档
  const cfg = store._peek();
  assert.equal(cfg.modelSource, "agent");
  assert.equal(cfg.customModel, undefined);
  // 请求用的是临时 Key
  assert.equal(ctx._calls[0].init.headers.Authorization, "Bearer sk-temp");
});

test("handler：handleTest 带 patch 时用临时配置测（不落盘）", async () => {
  const store = makeStore({ modelSource: "agent" });
  const ctx = makeCtx();
  const mc = new ModelConfig({ ctx, store });
  const r = await mc.handleTest({
    source: "custom",
    patch: { customModel: { baseUrl: "https://x", apiKey: "sk-patch", model: "m" } },
  });
  assert.equal(r.ok, true);
  assert.match(r.note, /测试成功啦/);
  assert.equal(store._peek().modelSource, "agent"); // 没保存
});

test("handler：handleHanaModels 返回注入的列表", async () => {
  const mc = new ModelConfig({ ctx: makeCtx(), store: makeStore() });
  mc.setHanaModelsProvider(async () => [{ providerId: "p", modelId: "m" }]);
  const r = await mc.handleHanaModels();
  assert.deepEqual(r.models, [{ providerId: "p", modelId: "m" }]);
});
