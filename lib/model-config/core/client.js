// model-config · core/client.js — ModelConfig 主类：三档分派调用 + 路由 handler
// 三档：
//   agent  — 跟随助手当前模型（utility:call-text 带 agentId/sessionPath，由 Hana 解析）
//   hana   — 指定 providerId/modelId（读取 Hana 已配置凭据后由插件直连）
//   custom — 插件数据目录存 Key，直连自定义 API（openai-completions / openai-responses / anthropic-messages）
//
// store 契约（插件提供，参考 README「快速开始」）：
//   getConfig() → 配置对象（必须返回对象，不能返回 undefined）
//   saveConfig(mutator) → mutator(cfg) 就地修改 cfg 后持久化（mutator 不是返回新对象！）
//
// ctx 契约：
//   ctx.bus.request(topic, payload, opts)  — 必需（agent 档走 Hana 总线；hana 档读取运行时凭据）
//   ctx.network?.fetch || globalThis.fetch — 可选（hana/custom 档直连用）
//   ctx.agentId / ctx.sessionPath           — 可选（agent 档跟随目标）
//   ctx.log?.warn?. / ctx.log?.info?.       — 可选日志
//   ctx.pluginDir                            — 可选（读 manifest 时推荐用它拼路径）
//
// manifest 最小声明（插件 manifest.json 里必须有）：
//   "trust": "full-access",
//   "capabilities": ["model", "network.fetch"]   // model=跟随档；network.fetch=hana/custom 档直连
//
// 注意：本文件的 extractModelText 与 feedback 积木的 extractText 是同一逻辑的两份拷贝
//       （零依赖的代价），改动需两边同步。

import { createCrypto } from "./crypto.js";
import { mergeModelConfig, sanitizeModelConfig, validateModelConfig, normalizeApi } from "./merge.js";
import { callHanaConfiguredModel } from "./hana-direct.js";

const REASONING_BLOCK_TYPES = new Set(["analysis", "reasoning", "thinking"]);
const HIDDEN_MODEL_TAGS = ["think", "analysis", "reasoning", "mood", "pulse"];
const FINAL_ONLY_INSTRUCTION = "请直接返回最终可见正文，不要输出思考过程、分析过程或任何隐藏标签。";

function markThinking(state, value = true) {
  if (value !== null && value !== undefined && value !== "") state.hadThinking = true;
}

function appendVisibleContent(value, parts, state) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const part of value) appendVisibleContent(part, parts, state);
    return;
  }
  if (typeof value !== "object") return;
  for (const key of ["reasoning_content", "reasoning", "reasoning_text", "thinking"]) {
    if (value[key] !== undefined) markThinking(state, value[key]);
  }
  const kind = String(value.type || value.kind || "").trim().toLowerCase();
  if (REASONING_BLOCK_TYPES.has(kind)) {
    markThinking(state);
    return;
  }
  if (typeof value.text === "string") {
    parts.push(value.text);
    return;
  }
  if (typeof value.output_text === "string") {
    parts.push(value.output_text);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(value, "content")) appendVisibleContent(value.content, parts, state);
}

function stripHiddenModelBlocks(text) {
  let cleaned = String(text || "");
  for (const tag of HIDDEN_MODEL_TAGS) {
    cleaned = cleaned
      .replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tag}\\s*>`, "gi"), "")
      .replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*$`, "gi"), "");
  }
  return cleaned.replace(/```\s*(?:think|analysis|reasoning)\b[\s\S]*?```/gi, "").trim();
}

function containsHiddenModelBlocks(text) {
  return HIDDEN_MODEL_TAGS.some((tag) => new RegExp(`<\\s*${tag}\\b`, "i").test(text))
    || /```\s*(?:think|analysis|reasoning)\b/i.test(text);
}

export function extractModelResponse(result) {
  const state = { hadThinking: false };
  const parts = [];
  if (typeof result === "string") {
    parts.push(result);
  } else if (result && typeof result === "object") {
    for (const key of ["reasoning_content", "reasoning", "thinking"]) {
      if (result[key] !== undefined) markThinking(state, result[key]);
    }
    const candidates = [
      result.text,
      result.content,
      result.output_text,
      result.output,
      result.message,
      result.choices?.[0]?.message,
      result.response?.choices?.[0]?.message,
      result.data?.choices?.[0]?.message,
      result.data,
    ];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue;
      const before = parts.length;
      appendVisibleContent(candidate, parts, state);
      if (parts.slice(before).join("").trim()) break;
    }
  }
  const rawText = parts.join("");
  const text = stripHiddenModelBlocks(rawText);
  if (containsHiddenModelBlocks(rawText)) state.hadThinking = true;
  return {
    text,
    hadThinking: state.hadThinking,
    finishReason: result?.finish_reason ?? result?.choices?.[0]?.finish_reason ?? result?.stop_reason ?? "",
    usage: result?.usage || null,
  };
}

export function extractModelText(result) {
  return extractModelResponse(result).text;
}

function normalizeReasoningLevel(value) {
  if (value === false) return "off";
  const normalized = String(value ?? "off").trim().toLowerCase();
  return normalized || "off";
}

function inferCallPurpose(opts) {
  const explicit = String(opts?.callPurpose || "").trim().toLowerCase();
  if (explicit) return explicit;
  const operation = String(opts?.operation || "").trim().toLowerCase();
  if (/summary|summarize|compile/.test(operation)) return "summary";
  if (/health|test|connect/.test(operation)) return "health_check";
  return "utility";
}

// 同模型重试的输出预算。默认按 ×3 试探；一旦首轮证实「有思考内容且被长度截断」，
// 说明这一档关不掉思考（部分中转会忽略 thinking:disabled），小步试探根本不够——
// 直接按思考的量级给足，否则重试注定还是 length。
// 只增不减：原预算本来就大时，重试绝不能把它砍小。
const MAX_RETRY_TOKEN_BUDGET = 12000;

export function growRetryTokenBudget(value, { hadThinking = false, finishReason = "" } = {}) {
  const base = Number(value);
  const safeBase = Number.isFinite(base) && base > 0 ? Math.floor(base) : 300;
  const truncated = String(finishReason || "").trim().toLowerCase() === "length";
  let target = safeBase * 3;
  if (hadThinking) target = Math.max(target, truncated ? 8000 : 6000);
  return Math.max(safeBase, Math.min(MAX_RETRY_TOKEN_BUDGET, target));
}

function addFinalOnlyInstruction(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const next = source.map((message) => ({ ...message }));
  const index = next.findLastIndex((message) => message?.role === "user");
  if (index >= 0 && typeof next[index].content === "string") {
    next[index].content = `${next[index].content}\n\n${FINAL_ONLY_INSTRUCTION}`;
  } else {
    next.push({ role: "user", content: FINAL_ONLY_INSTRUCTION });
  }
  return next;
}

function isMiniMaxOpenAIReasoningModel(baseUrl, model) {
  let hostname = "";
  try { hostname = new URL(baseUrl).hostname.toLowerCase(); } catch { /* 允许代理 URL 继续走普通协议 */ }
  if (!/(^|\.)minimaxi?\.(com|io)$/.test(hostname)) return false;
  return /^minimax-m(?:3|2(?:\.\d+)?)(?:-[a-z0-9._-]+)?$/i.test(String(model || "").trim());
}

// 容错解析模型响应 JSON：
//   - 剥离 BOM
//   - SSE 流（data: 前缀）：逐行提取，取最后一段 JSON
//   - 前导非 JSON 字符（个别代理在 JSON 前垫内容）：从第一个 { 或 [ 重新解析
//   - 完整值 + 尾巴（如 "null\nxxx"）：按 V8 报错位置截断重试
//   全部失败：友好错误 + 原文片段，不抛原生 JSON 报错
//   参考：opencode.ai 等代理实测返回过 SSE 流 / 包装格式，解析必须宽容
export function parseModelJson(rawText, ctx) {
  let text = String(rawText || "").replace(/^\uFEFF/, "").trim();
  if (text.startsWith("data:")) {
    const chunks = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^data:\s*(.*)$/.exec(String(line).trim());
      if (m && m[1] && m[1] !== "[DONE]") chunks.push(m[1]);
    }
    if (chunks.length) text = chunks[chunks.length - 1];
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // 前导垫料：从第一个 { 或 [ 开始重新解析
    const idx = text.search(/[{[]/);
    if (idx > 0) {
      try { return JSON.parse(text.slice(idx)); } catch { /* 继续兜底 */ }
    }
    // 完整值 + 尾巴（V8 报 "Unexpected non-whitespace character after JSON"）：按位置截断
    const posMatch = /position (\d+)/.exec(String(e.message || ""));
    if (posMatch) {
      const pos = Number(posMatch[1]);
      if (pos > 0 && pos < text.length) {
        try { return JSON.parse(text.slice(0, pos)); } catch { /* 继续兜底 */ }
      }
    }
    ctx?.log?.warn?.("[model-config] 模型响应无法解析为 JSON", text.slice(0, 200));
    throw new Error(`模型服务返回了无法解析的内容（响应不是标准 JSON，可能是流式输出或服务异常）：${text.slice(0, 120)}`);
  }
}

export class ModelConfig {
  constructor({ ctx, store, salt }) {
    if (!ctx) throw new Error("model-config: ctx 必填");
    if (!store || typeof store.getConfig !== "function" || typeof store.saveConfig !== "function") {
      throw new Error("model-config: store 需要提供 getConfig() 和 saveConfig(mutator)");
    }
    this.ctx = ctx;
    this.store = store;
    this.crypto = createCrypto(salt);
    this.hanaModelsProvider = null;
  }

  // 插槽（函数插槽）：插件注入"拉取 Hana 模型列表"的实现（积木不直接读 Hana 内部文件）
  // 不注入时 getHanaModels() 返回 []，hana 档下拉会是空的——接入方务必实现
  // 参考实现：读 Hana 的 models.json 解析 providers，过滤文本模型（表情包插件 lib/shared.js 有现成逻辑）
  setHanaModelsProvider(fn) {
    this.hanaModelsProvider = typeof fn === "function" ? fn : null;
  }

  getConfig() {
    return this.store.getConfig();
  }

  async saveConfig(patch) {
    // 串行队列：并发保存不依赖接入方 store 实现是否原子（读-改-写竞态由积木内部消化）
    // merge 是异步（Key 走系统锁加密），先 await 合并再同步写 store
    const run = async () => {
      const merged = await mergeModelConfig(this.getConfig(), patch, this.crypto);
      await this.store.saveConfig((cfg) => {
        cfg.modelSource = merged.modelSource;
        cfg.agentFollow = merged.agentFollow;
        cfg.hanaModel = merged.hanaModel || cfg.hanaModel;
        cfg.customModel = merged.customModel || cfg.customModel;
        cfg.updatedAt = new Date().toISOString();
      });
    };
    this._chain = (this._chain || Promise.resolve())
      .catch(() => {})   // 前一个失败不阻塞后续保存
      .then(run);
    return this._chain;
  }

  sanitize() {
    return sanitizeModelConfig(this.getConfig());
  }

  validate(sourceOverride) {
    const cfg = this.getConfig();
    const source = sourceOverride || cfg.modelSource || "agent";
    return validateModelConfig({ ...cfg, source });
  }

  // 拉取 Hana 已配置模型列表（走插件注入的实现；没注入返回空数组）
  async getHanaModels() {
    if (!this.hanaModelsProvider) return [];
    try {
      const list = await this.hanaModelsProvider();
      return Array.isArray(list) ? list : [];
    } catch (e) {
      this.ctx?.log?.warn?.("[model-config] 拉取 Hana 模型列表失败:", e.message);
      return [];
    }
  }

  // 调用：messages = [{ role, content }]
  // opts.configOverride：可选，临时配置（前端表单未保存值），测试用但不落盘
  // 短任务默认关闭思考；空正文只自动用同一模型重试一次，避免思考内容耗尽预算后误报失败。
  async sample(messages, opts = {}) {
    const cfg = opts.configOverride || this.getConfig();
    const source = opts.source || cfg.modelSource || "agent";
    const callOpts = {
      ...opts,
      reasoningLevel: normalizeReasoningLevel(opts.reasoningLevel),
      callPurpose: inferCallPurpose(opts),
    };

    // 本次调用的诊断留在实例上，供调用方判断「这一档是不是关不掉思考」。
    // 判据是硬证据：我们要了关闭思考（reasoningLevel=off），它还是产出了思考内容。
    this.lastDiagnostics = null;
    const reasoningWasDisabled = callOpts.reasoningLevel === "off";

    const sampleOnce = () => {
      if (source === "custom") return this._sampleCustom(messages, callOpts, cfg);
      if (source === "hana") {
        if (cfg.hanaModel?.providerId && cfg.hanaModel?.modelId) {
          return this._sampleHana(messages, callOpts, cfg.hanaModel);
        }
        // 脏配置（选了 hana 档但缺 provider/model）：回落 agent 档并留日志，别静默
        this.ctx?.log?.warn?.("[model-config] hana 档配置不完整（缺 providerId/modelId），回落 agent 档");
      }
      return this._sampleAgent(messages, callOpts);
    };

    const first = extractModelResponse(await sampleOnce());
    this.lastDiagnostics = {
      hadThinking: first.hadThinking,
      finishReason: first.finishReason || "",
      reasoningDisabledButStillThinking: reasoningWasDisabled && first.hadThinking,
      retried: false,
      retrySucceeded: null,
    };
    if (first.text || opts.retryOnEmpty === false) return first.text;

    this.ctx?.log?.warn?.(
      `[model-config] 模型未交付可见正文，准备同模型重试（hadThinking=${first.hadThinking}, finishReason=${first.finishReason || "unknown"}）`,
    );
    const retryOpts = {
      ...callOpts,
      reasoningLevel: "off",
      maxTokens: growRetryTokenBudget(callOpts.maxTokens, {
        hadThinking: first.hadThinking,
        finishReason: first.finishReason,
      }),
      retryOnEmpty: false,
    };
    const retryMessages = addFinalOnlyInstruction(messages);
    const retry = extractModelResponse(await (source === "custom"
      ? this._sampleCustom(retryMessages, retryOpts, cfg)
      : source === "hana" && cfg.hanaModel?.providerId && cfg.hanaModel?.modelId
        ? this._sampleHana(retryMessages, retryOpts, cfg.hanaModel)
        : this._sampleAgent(retryMessages, retryOpts)));
    this.lastDiagnostics = {
      ...this.lastDiagnostics,
      retried: true,
      retryHadThinking: retry.hadThinking,
      retryFinishReason: retry.finishReason || "",
      retrySucceeded: !!retry.text,
    };
    if (!retry.text) {
      const diag = `hadThinking=${retry.hadThinking}, finishReason=${retry.finishReason || "unknown"}`;
      this.ctx?.log?.warn?.(`[model-config] 同模型重试仍无可见正文（${diag}）`);
      // 思考吃光预算：这一档多半关不掉思考（部分中转忽略 thinking:disabled）。
      // 与其把一句没头没尾的「模型未回复正文」丢给用户，不如把诊断和可行的下一步一起说清楚。
      if (retry.hadThinking && String(retry.finishReason || "").trim().toLowerCase() === "length") {
        throw new Error(
          `模型把输出预算全花在思考上、没留下正文（${diag}）。这一档可能不支持关闭思考：`
          + "换一个能关掉思考的模型档，或把输出预算调大后再试",
        );
      }
    }
    return retry.text;
  }

  async _sampleAgent(messages, opts) {
    const { ctx } = this;
    const input = {
      messages,
      temperature: opts.temperature ?? 0.8,
      maxTokens: opts.maxTokens ?? 300,
      operation: opts.operation || "model-config",
      callPurpose: opts.callPurpose || "utility",
      reasoningLevel: opts.reasoningLevel || "off",
    };
    if (opts.agentId) input.agentId = opts.agentId;
    else if (ctx.agentId) input.agentId = ctx.agentId;
    if (ctx.sessionPath) input.sessionPath = ctx.sessionPath;
    return ctx.bus.request("utility:call-text", input, { timeoutMs: opts.timeoutMs || 30000 });
  }

  async _sampleHana(messages, opts, model) {
    return callHanaConfiguredModel(this.ctx, model, messages, {
      temperature: opts.temperature ?? 0.8,
      maxTokens: opts.maxTokens ?? 300,
      timeoutMs: opts.timeoutMs || 30000,
      modelsPath: opts.modelsPath,
    });
  }

  async _sampleCustom(messages, opts, cfgOverride) {
    const cfg = cfgOverride || this.getConfig();
    const custom = cfg.customModel || {};
    const baseUrl = String(custom.baseUrl || "").replace(/\/+$/, "");
    const apiKey = await this.crypto.unprotectKey(custom.apiKey || "");
    const model = custom.model || "";
    const api = normalizeApi(custom.api);
    if (!baseUrl || !apiKey || !model) throw new Error("自定义模型配置不完整。");

    const fetcher = this.ctx.network?.fetch || globalThis.fetch;
    if (typeof fetcher !== "function") throw new Error("宿主网络能力不可用，无法连接自定义模型。");
    // anthropic 真实端点是 /v1/messages（baseUrl 可能已含 /v1 或完整端点）
    let url;
    if (api === "openai-responses") {
      // 兼容：用户把完整 /responses 端点当 baseUrl 填（否则拼出 /responses/responses）
      url = /\/responses$/i.test(baseUrl) ? baseUrl : `${baseUrl}/responses`;
    } else if (api === "anthropic-messages") {
      if (/\/v1\/messages$/i.test(baseUrl)) url = baseUrl;
      else url = baseUrl.endsWith("/v1") ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
    } else {
      // 兼容：baseUrl 已含完整 /chat/completions 端点时不重复拼
      url = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
    }
    const headers = { "Content-Type": "application/json" };
    if (api === "anthropic-messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const body = api === "openai-responses"
      ? { model, input: messages.map((m) => ({ role: m.role, content: m.content })), temperature: opts.temperature ?? 0.8, max_output_tokens: opts.maxTokens ?? 300 }
      : { model, messages, temperature: opts.temperature ?? 0.8, max_tokens: opts.maxTokens ?? 300 };
    // MiniMax-M2/M3 的 OpenAI-compatible 接口用 thinking.type 控制思考；
    // 只对官方 MiniMax OpenAI 端点生效，避免把私有字段误发给其他代理。
    if (api === "openai-completions"
      && normalizeReasoningLevel(opts.reasoningLevel) === "off"
      && isMiniMaxOpenAIReasoningModel(baseUrl, model)) {
      body.thinking = { type: "disabled" };
    }

    const response = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs || 30000),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      const detail = String(errBody || "").replace(/\s+/g, " ").trim().slice(0, 200);
      this.ctx?.log?.warn?.("[model-config] 自定义模型返回错误", `HTTP ${response.status}`, detail);
      throw new Error(`模型返回错误（HTTP ${response.status}${detail ? `：${detail}` : ""}）`);
    }
    const rawText = await response.text();
    const json = parseModelJson(rawText, this.ctx);
    return json;
  }

  // 测试连通：发一条短消息（不保存任何东西）
  async testConnection(sourceOverride) {
    const cfg = this.getConfig();
    const source = sourceOverride || cfg.modelSource || "agent";
    const text = await this.sample(
      [{ role: "user", content: "回复两个字：通了" }],
      { source, temperature: 0.2, maxTokens: 20, timeoutMs: 20000, operation: "model-config-test" },
    );
    return { ok: true, text: String(text || "").slice(0, 100) };
  }

  // 用临时配置测试连通（前端表单未保存的值，merge 后测，不落盘）
  // 不传 crypto：临时配置的 Key 明文暂存即可（unprotectKey 能原样读回），避免多余加密开销
  async testConnectionWith(sourceOverride, patch) {
    const base = this.getConfig();
    const source = sourceOverride || base.modelSource || "agent";
    const temp = await mergeModelConfig(base, { ...(patch || {}), source });
    const text = await this.sample(
      [{ role: "user", content: "回复两个字：通了" }],
      { source, configOverride: temp, temperature: 0.2, maxTokens: 20, timeoutMs: 20000, operation: "model-config-test" },
    );
    return { ok: true, text: String(text || "").slice(0, 100) };
  }

  // ── 路由 handler（插件挂到自家 app 上即可，4 行接入）──

  handleGet = async () => ({ ok: true, config: this.sanitize() });

  handleSave = async (body) => {
    if (!body || typeof body !== "object") return { ok: false, error: "参数错误" };
    await this.saveConfig(body);
    return { ok: true, config: this.sanitize() };
  };

  handleTest = async (body) => {
    const source = body?.source || this.getConfig().modelSource || "agent";
    const v = this.validate(source);
    if (!v.ok) return { ok: false, error: v.error };
    try {
      // 前端带了表单 patch：用临时配置测（不落盘）；没带则测已保存配置
      const r = body?.patch
        ? await this.testConnectionWith(source, body.patch)
        : await this.testConnection(source);
      return { ok: true, note: "测试成功啦！" };
    } catch (e) {
      const msg = e.message || "连通失败";
      const code = String(e.code || "").toUpperCase();
      if (code === "PLUGIN_NETWORK_HOST_NOT_ALLOWED" || /PLUGIN_NETWORK_HOST_NOT_ALLOWED|network\.allowedHosts|host .*not declared in manifest/i.test(msg)) {
        return { ok: false, error: "这个 API 域名不在提个醒的网络放行名单里。请把域名加入插件目录 manifest.json 的 network.allowedHosts 后重启 HanaAgent，再点测试。" };
      }
      if (code === "PLUGIN_NETWORK_PRIVATE_HOST_FORBIDDEN" || /PLUGIN_NETWORK_PRIVATE_HOST_FORBIDDEN|private network|localhost/i.test(msg)) {
        return { ok: false, error: "这个 API 地址属于本机或私网，当前 Hana 网络权限不允许访问。请确认 manifest.json 已声明 allowLocalhost: true，并重启 HanaAgent。" };
      }
      if (code === "PLUGIN_NETWORK_SCHEME_NOT_ALLOWED" || /PLUGIN_NETWORK_SCHEME_NOT_ALLOWED|only allows HTTPS|scheme/i.test(msg)) {
        return { ok: false, error: "这个 API 地址的协议不符合 Hana 网络规则：公网请使用 HTTPS，本机服务才可使用 HTTP。" };
      }
      // JSON 解析类错误：模型服务返回了非标准内容（流式/错误页等），翻译成人话
      if (/Unexpected|JSON|parse|syntax/i.test(msg) && /position|token|column/i.test(msg)) {
        return { ok: false, error: "模型服务返回了无法解析的内容（响应不是标准 JSON，可能是流式输出或服务异常）。可以试试跟随助手档或其他模型。" };
      }
      return { ok: false, error: msg };
    }
  };

  handleHanaModels = async () => {
    const models = await this.getHanaModels();
    return { ok: true, models };
  };
}
