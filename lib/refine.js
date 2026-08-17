// 提个醒 · 文案润色（可选高级档，默认关）
// 开启后，语气型风格的标题+正文由模型改写（真正「改原话」）；
// 失败/超时自动降级规则版，通知永不哑火。
// 格式型整活风格（摩斯/故障/锟斤拷）不参与润色——它们本身就是编码玩法。

import { parseModelJson } from "./model-config/core/client.js";

// ── 风格是否参与润色（在 STYLES 上标记 refinable，这里只是兜底集合）──

const STYLE_INSTRUCTIONS = {
  default: "标准提醒口吻：直接、自然，像平常聊天",
  plain: "简洁高效电报风：去掉装饰和语气词，短而直接，像工作汇报",
  cheerful: "活泼可爱：用感叹号和 emoji，元气满满，像开心报喜",
  gentle: "温柔贴心：语气柔和，句尾用波浪号，像朋友轻声递话",
  sister: "闺蜜俏皮：用「姐妹！」开头，感叹号有劲儿，像闺蜜拽袖子催你快看",
  epistle: "古风书简：标题用「展信佳/有书至/寄来几行」这类笺札用语，正文雅致简短，像一封文言信",
  biz: "互联网大厂黑话风：用「触达/闭环/拉通对齐/链路/交付」等黑话词，正文也黑话化但保留核心信息"
};

// 扩展风格指令（方言/学我说话等动态注册）：注册时写入，运行时按 id 查
const EXTRA_INSTRUCTIONS = new Map();
export function registerRefineInstruction(styleId, instruction) {
  if (styleId) EXTRA_INSTRUCTIONS.set(styleId, String(instruction || ""));
}

const TITLE_MAX = 16; // 模型生成标题上限（会话前缀由插件自己加）
const BODY_MAX = 24;  // 正文上限（通知栏两行内，与规则版一致）

function clipText(text, len) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > len ? t.slice(0, len) + "…" : t;
}

/** 构建润色 prompt（system 约束格式，user 给上下文） */
export function buildRefineMessages({ agentName, style, kind, snippet, count }) {
  const kindText = kind === "append"
    ? `补弹（同一会话累计 ${Math.max(0, (count || 1) - 1)} 条，标题要体现「又回了几条」）`
    : "第一条（标题用「回你了/回你啦」这类口吻）";
  const styleText = `${style.label}：${EXTRA_INSTRUCTIONS.get(style.id) || STYLE_INSTRUCTIONS[style.id] || STYLE_INSTRUCTIONS.default}`;
  return [
    {
      role: "system",
      content: `你是「提个醒」通知文案润色器。把助手的回复改写成指定风格的弹窗标题和正文。
要求：
1. 只输出一个 JSON 对象：{"title": "...", "body": "..."}，不要输出任何其他内容
2. title 一句话，不超过 ${TITLE_MAX} 字，必须包含助手名
3. body 不超过 ${BODY_MAX} 字，保留回复的核心信息，语气和措辞按风格改写
4. 不要加会话标题前缀，系统会自己加`
    },
    {
      role: "user",
      content: `助手：${agentName}\n通知类型：${kindText}\n风格：${styleText}\n回复内容：${clipText(snippet, 120)}`
    }
  ];
}

/** 解析润色结果；格式不对抛错（调用方降级规则版） */
export function parseRefineResult(rawText) {
  const json = parseModelJson(rawText);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("润色结果不是 JSON 对象");
  }
  const title = String(json.title || "").trim();
  const body = String(json.body || "").trim();
  if (!title || !body) throw new Error("润色结果缺 title 或 body");
  return { title: clipText(title, TITLE_MAX), body: clipText(body, BODY_MAX) };
}

/**
 * 完整润色流程：构建 prompt → 调模型 → 解析 → 拼会话标题前缀。
 * 任何一步失败都抛错，由调用方降级规则版。
 */
export async function refineTitleAndBody({ mc, agentName, style, kind, snippet, count, sessionTitle, sessionPrefix, timeoutMs }) {
  const messages = buildRefineMessages({ agentName, style, kind, snippet, count });
  const raw = await mc.sample(messages, {
    temperature: 0.7,
    maxTokens: 300,
    timeoutMs: timeoutMs || 8000,
    operation: "tigexing-refine"
  });
  const r = parseRefineResult(raw);
  return { title: (sessionPrefix ? sessionPrefix(sessionTitle) : "") + r.title, body: r.body };
}
