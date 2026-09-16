// model-config · Hana 已配置模型直连
// utility:call-text 只接受宿主全局 utility 配置；指定模型必须读取 Hana
// 的模型目录与运行时凭据后，由插件通过 network.fetch 直连对应接口。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const MODELS_JSON = path.join(HANA_HOME, "models.json");
const PROVIDER_CATALOG = path.join(HANA_HOME, "provider-catalog.json");

function trimSlashes(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeApi(value) {
  const api = String(value || "openai-completions").trim().toLowerCase();
  if (api.includes("responses")) return "openai-responses";
  if (api.includes("anthropic") || api.includes("claude")) return "anthropic-messages";
  return "openai-completions";
}

function isDeepSeek(providerId, modelId) {
  return providerId === "deepseek" || /deepseek/i.test(String(modelId || ""));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function readConfiguredHanaModel(providerId, modelId, modelsPath = MODELS_JSON) {
  const pid = String(providerId || "").trim();
  const mid = String(modelId || "").trim();
  if (!pid || !mid) throw new Error("未选择供应商和模型。");
  const catalog = readJson(modelsPath, null);
  if (!catalog?.providers || typeof catalog.providers !== "object") {
    throw new Error("读取 Hana 模型目录失败。");
  }
  const provider = catalog.providers[pid];
  if (!provider || typeof provider !== "object") throw new Error(`Hana 模型供应商不存在：${pid}`);
  const entry = (Array.isArray(provider.models) ? provider.models : [])
    .find((item) => (typeof item === "string" ? item : item?.id) === mid);
  if (!entry) throw new Error(`Hana 模型不存在：${pid}/${mid}`);
  const model = typeof entry === "object" ? entry : { id: entry };
  return {
    providerId: pid,
    modelId: mid,
    api: normalizeApi(model.api || provider.api),
    baseUrl: provider.baseUrl || provider.base_url || "",
    reasoning: model.reasoning === true,
  };
}

function readStoredProvider(providerId) {
  const provider = readJson(PROVIDER_CATALOG, null)?.providers?.[providerId];
  if (!provider || typeof provider !== "object") return {};
  return {
    apiKey: provider.api_key || provider.apiKey || "",
    baseUrl: provider.base_url || provider.baseUrl || provider.api_base || "",
  };
}

async function resolveModel(ctx, providerId, modelId, modelsPath) {
  const definition = readConfiguredHanaModel(providerId, modelId, modelsPath);
  let runtime = {};
  try {
    const result = await ctx?.bus?.request?.("provider:credentials", { providerId: definition.providerId });
    if (result && typeof result === "object") runtime = result;
  } catch {
    // 旧宿主或权限未开放时，使用本机 provider-catalog 兼容回退。
  }
  const stored = readStoredProvider(definition.providerId);
  const baseUrl = runtime.baseUrl || runtime.base_url || stored.baseUrl || definition.baseUrl;
  const apiKey = runtime.apiKey || runtime.api_key || stored.apiKey || "";
  if (!baseUrl) throw new Error(`模型供应商未配置 API 地址：${definition.providerId}`);
  return { ...definition, baseUrl: trimSlashes(baseUrl), apiKey };
}

function endpoint(baseUrl, api) {
  const base = trimSlashes(baseUrl);
  if (api === "openai-responses") return /\/responses$/i.test(base) ? base : `${base}/responses`;
  if (api === "anthropic-messages") {
    return /\/messages$/i.test(base) ? base : `${base}${/\/v1$/i.test(base) ? "" : "/v1"}/messages`;
  }
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}${/\/v1$/i.test(base) ? "" : "/v1"}/chat/completions`;
}

function extractText(payload, api) {
  if (!payload || typeof payload !== "object") return "";
  if (api === "openai-responses") {
    if (typeof payload.output_text === "string") return payload.output_text.trim();
    return (payload.output || [])
      .filter((item) => item?.type === "message")
      .flatMap((item) => item.content || [])
      .filter((part) => part?.type === "output_text")
      .map((part) => part.text || "")
      .join("").trim();
  }
  if (api === "anthropic-messages") {
    return (payload.content || [])
      .filter((part) => !/reasoning|thinking/i.test(String(part?.type || "")))
      .map((part) => part?.text || "")
      .join("").trim();
  }
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  return Array.isArray(content)
    ? content.filter((part) => !/reasoning|thinking/i.test(String(part?.type || ""))).map((part) => part?.text || "").join("").trim()
    : "";
}

export async function callHanaConfiguredModel(ctx, config, messages, options = {}) {
  const model = await resolveModel(ctx, config?.providerId, config?.modelId, options.modelsPath);
  const api = model.api;
  const headers = { "Content-Type": "application/json" };
  if (api === "anthropic-messages") {
    headers["x-api-key"] = model.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (model.apiKey && !String(model.apiKey).startsWith("hana-runtime-api-key:")) {
    headers.Authorization = `Bearer ${model.apiKey}`;
  }

  const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? Math.floor(options.maxTokens) : 300;
  const temperature = Number.isFinite(options.temperature) ? options.temperature : undefined;
  const input = Array.isArray(messages) ? messages : [];
  let body;
  if (api === "openai-responses") {
    body = { model: model.modelId, input, max_output_tokens: maxTokens, stream: false };
    if (temperature !== undefined) body.temperature = temperature;
  } else if (api === "anthropic-messages") {
    body = {
      model: model.modelId,
      messages: input.filter((m) => m?.role !== "system").map((m) => ({ role: m?.role === "assistant" ? "assistant" : "user", content: m?.content ?? "" })),
      max_tokens: maxTokens,
      stream: false,
    };
    const system = input.filter((m) => m?.role === "system").map((m) => String(m.content || "")).filter(Boolean).join("\n\n");
    if (system) body.system = system;
    if (temperature !== undefined) body.temperature = temperature;
  } else {
    body = { model: model.modelId, messages: input, max_tokens: maxTokens, stream: false };
    if (temperature !== undefined) body.temperature = temperature;
    if (model.reasoning && isDeepSeek(model.providerId, model.modelId)) body.thinking = { type: "disabled" };
  }

  const fetcher = ctx?.network?.fetch || globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("宿主网络能力不可用，无法连接 Hana 模型。");
  const response = await fetcher(endpoint(model.baseUrl, api), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs || 30000),
  });
  const raw = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`模型返回错误（HTTP ${response.status}${raw ? `：${raw.replace(/\s+/g, " ").slice(0, 200)}` : ""}）`);
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error("模型服务返回了无法解析的内容。"); }
  const text = extractText(payload, api);
  if (!text) throw new Error("模型未回复正文，请检查思考内容或稍后重试。");
  return { text };
}
