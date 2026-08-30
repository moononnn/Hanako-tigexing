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
  biz: "互联网大厂黑话风：用「触达/闭环/拉通对齐/链路/交付」等黑话词，正文也黑话化但保留核心信息",
  // 动森岛民（acnh 组）：口癖感靠标题/语气，正文保留核心信息（2026-08-30 交叉审查后与规则版对齐）
  ac_shizue: "西施惠晨间播报腔：标题像岛务处广播（「今日播报/本台消息」），措辞半正式温柔，像正经播音员说温暖的话，正文直接自然",
  ac_jack: "杰克式冷淡精英：标题惜字如金、句尾用句号，正文也极简，像高冷猫猫不咸不淡地通知你，绝不多说一个字",
  ac_jun: "小润傲娇少爷：标题用「哼」开头（如「哼，XX 回你了。」），嘴上嫌弃但其实是关心，像别扭地告诉你，正文纯原话",
  ac_chacha: "茶茶丸元气羊：标题用感叹号和「哇耶！」，像操场边给你加油的运动少年，正文纯原话",
  ac_monica: "莫妮卡元气偶像狼：标题带「呀哈！」和波浪号，像戴着太阳镜、爱健身的元气狼女，阳光轻快，正文纯原话",
  ac_judy: "美玲梦幻小熊：标题用「哦呀」开头，像眼里有星星的洋娃娃小熊，温柔软糯带梦幻感，正文纯原话",
  ac_ankha: "艳后古埃及神秘风：标题用「尼罗河畔」这类意象，可带「三千年」的岁月感（她自称活了三千岁），正文保留原话并可用「尼罗哟」收尾",
  ac_zucker: "章丸丸呆萌章鱼：标题以「嗯…没错」开头（简中口癖是「没错」不是「认同」），慢悠悠点头的章鱼，正文可缀「没错」",
  ac_nook: "狸克商人广播：标题用「本店通知/本店补货」加「（铃钱已结清）」，商人腔带奸商梗，正文纯原话（别用「欢迎光临」，那是豆狸粒狸的台词）",
  ac_timmy: "豆狸粒狸双胞胎接龙：标题前半句豆狸、后半句粒狸，一唱一和（如「豆狸：XX 回你啦！粒狸：快去看！」），正文纯原话"
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
export function buildRefineMessages({ agentName, style, kind, snippet, count, failureReason }) {
  const kindText = kind === "append"
    ? `补弹（同一会话累计 ${Math.max(0, (count || 1) - 1)} 条，标题要体现「又回了几条」）`
    : kind === "failure"
      ? "异常回合（这一轮没有正常结束，标题要说清连接中断，正文保留已收到的内容或提醒用户说“继续”）"
      : kind === "unhealthy"
        ? "会话状态提醒（标题要说清这个对话连续失败，正文给出新开对话或继续的建议）"
        : "第一条（标题用「回你了/回你啦」这类口吻）";
  const styleText = `${style.label}：${EXTRA_INSTRUCTIONS.get(style.id) || STYLE_INSTRUCTIONS[style.id] || STYLE_INSTRUCTIONS.default}`;
  return [
    {
      role: "system",
      content: `你是「提个醒」通知文案润色器。把助手的回复改写成指定风格的弹窗标题和正文。
输出格式（严格 JSON，不要 Markdown 代码块，不要任何解释文字）：
{"title": "...", "body": "..."}

示例：
{"title": "小花回你啦～", "body": "「刚才说的事，有着落啦～」"}

要求：
1. 只输出上面这一个 JSON 对象，前后不要有任何其他内容
2. title 一句话，不超过 ${TITLE_MAX} 字，必须包含助手名
3. body 不超过 ${BODY_MAX} 字，保留回复的核心信息，语气和措辞按风格改写
4. 不要加会话标题前缀，系统会自己加
5. 思考完毕必须把最终 JSON 作为回复正文完整输出，不要只思考不输出`
    },
    {
      role: "user",
      content: `助手：${agentName}\n通知类型：${kindText}\n风格：${styleText}\n回复内容：${clipText(snippet, 120)}${failureReason ? `\n底层原因（仅供改写理解，不要原样输出）：${clipText(failureReason, 80)}` : ""}`
    }
  ];
}

/**
 * 安全拒绝文案识别：模型输出「抱歉/不能帮你/无法完成/拒绝/换个话题」这类安全拒绝字眼时，
 * 视为润色失败（调用方降级规则版），而不是把拒绝文案当正常结果弹给用户看。
 * 2026-08-28 实机：MiniMax-M3 把科普「执行命令/操作文件」的正文当成越权请求，
 * 输出 `抱歉，这个话题我不能帮你～`，被当作正常润色结果弹窗（debug.log 见 13:07:32）。
 */
const REFUSAL_PATTERNS = [
  /抱歉[，,\s].{0,12}(不能|无法|没[办法法]|帮不了)/,
  /这个话题我不能帮/,
  /这个请求我不能帮/,
  /我无法(生成|完成|帮助|协助|回答|提供|处理)/,
  /我不能(生成|完成|帮助|协助|回答|提供|处理|帮你)/,
  /拒绝(回答|生成|完成|提供|处理|改写|帮助|协助)/,
  /换个话题/,
  /这(个|类)(内容|话题|请求|问题)(我)?(不|没[办法法])/,
  /不在我的(能力|职责|范围)(内|里)?/,
  /无法为你提供/,
  /不?涉及.{0,6}违规/,
  /违反(了)?(安全|政策|规定|规则|准则)/
];

/** 判断文本是否带安全拒绝语义；命中任一模式返回 true */
export function isRefusalText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return REFUSAL_PATTERNS.some((re) => re.test(t));
}

/** 解析润色结果；格式不对或内容带安全拒绝语义抛错（调用方降级规则版） */
export function parseRefineResult(rawText) {
  const json = parseModelJson(rawText);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("润色结果不是 JSON 对象");
  }
  const title = String(json.title || "").trim();
  const body = String(json.body || "").trim();
  if (!title || !body) throw new Error("润色结果缺 title 或 body");
  // 拒绝文案识别：模型输出安全拒绝时，不把它当正常润色结果
  if (isRefusalText(title) || isRefusalText(body)) {
    throw new Error("润色结果被模型安全拒绝，降级规则版");
  }
  return { title: clipText(title, TITLE_MAX), body: clipText(body, BODY_MAX) };
}

/**
 * 完整润色流程：构建 prompt → 调模型 → 解析 → 拼会话标题前缀。
 * 任何一步失败都抛错，由调用方降级规则版。
 */
/**
 * 从杂文本里尽力提取 JSON 对象（分享版要面对各种模型的输出习惯）：
 * 1. 剥掉 Markdown 代码块围栏（```json ... ```）
 * 2. 从第一个 { 到最后一个 } 截取（容忍前后多余的解释文字）
 * 3. 仍失败则交给 parseRefineResult 原生报错（调用方降级）
 */
export function parseRefineResultLenient(rawText) {
  let text = String(rawText || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(text);
  if (fence) text = fence[1].trim();
  try {
    return parseRefineResult(text);
  } catch (err) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return parseRefineResult(text.slice(start, end + 1));
    }
    throw err;
  }
}

/** 重试时追加的硬指令：治思考型模型「光想不写」 */
const RETRY_HINT = "\n\n注意：刚才你没有输出正文或输出格式不对。这次请直接输出严格 JSON（不要 Markdown 代码块、不要思考过程、不要任何解释）。";

async function sampleRefineOnce(mc, messages, { timeoutMs, temperature, hint }) {
  const msgs = hint
    ? messages.map((m, i) => (i === 0 ? { ...m, content: m.content + hint } : m))
    : messages;
  return mc.sample(msgs, {
    temperature: temperature ?? 0.7,
    maxTokens: 500,
    timeoutMs: timeoutMs || 8000,
    operation: hint ? "tigexing-refine-retry" : "tigexing-refine"
  });
}

/**
 * 完整润色流程：构建 prompt → 调模型 → 解析 → 拼会话标题前缀。
 * 失败自动重试一次（追加「必须输出」硬指令），任何一步最终失败都抛错，由调用方降级规则版。
 */
export async function refineTitleAndBody({ mc, agentName, style, kind, snippet, count, failureReason, sessionTitle, sessionPrefix, timeoutMs }) {
  const messages = buildRefineMessages({ agentName, style, kind, snippet, count, failureReason });
  const budget = timeoutMs || 8000;

  // 第一次尝试：较短超时，失败/格式错快速进入重试
  let raw = null;
  try {
    raw = await sampleRefineOnce(mc, messages, { timeoutMs: Math.min(budget, 6000), temperature: 0.7 });
  } catch {
    raw = null;
  }
  if (raw != null) {
    try {
      const r = parseRefineResultLenient(raw);
      return { title: (sessionPrefix ? sessionPrefix(sessionTitle) : "") + r.title, body: r.body };
    } catch {
      raw = null; // 格式不对 → 重试
    }
  }

  // 第二次尝试：追加「必须输出」硬指令，思考型模型第二次通常会给正文
  const raw2 = await sampleRefineOnce(mc, messages, { timeoutMs: budget, temperature: 0.5, hint: RETRY_HINT });
  const r2 = parseRefineResultLenient(raw2);
  return { title: (sessionPrefix ? sessionPrefix(sessionTitle) : "") + r2.title, body: r2.body };
}
