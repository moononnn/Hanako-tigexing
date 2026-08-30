// 提个醒 · 通知风格模板（按助手配置）
// 纯模板、零依赖、零延迟：风格只决定标题/正文的「包装方式」，回复内容本身不变。
// 分享版不接模型（通知要快 + 零配置），以后若要 AI 润色可另做高级档。

import { buildTitle } from "./policy.js";

// ── 正文加工工具 ──
// 通知栏宽度有限，正文必须短：所有风格都会截断，超长加省略号。
// 截断优先断在句子完整处（句号/逗号后），避免留下半句话吊胃口。
const LEN_DEFAULT = 24; // 跟随默认 / 活泼可爱 / 温柔贴心
const LEN_PLAIN = 18;   // 简洁高效：电报风，更短

// 断句用的标点（按优先级）：句末标点 > 停顿标点
const SENT_END_CHARS = "。！？!?；;";
const SENT_PAUSE_CHARS = "，,、：:";
// 截断时的后向宽容窗口：宁可多显示几个字，也要断在完整句子处
const CLIP_BUFFER = 8;

function clip(text, len = LEN_DEFAULT) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= len) return t;

  const win = t.slice(0, len + CLIP_BUFFER);
  let cut = -1;
  // 优先找句末标点（从句尾往前扫，取最后一个）
  for (let i = win.length - 1; i >= 0; i--) {
    if (SENT_END_CHARS.includes(win[i])) { cut = i + 1; break; }
  }
  // 句号太靠前（句子过短）不值得断，放弃，改找停顿标点
  if (cut >= 0 && cut < Math.floor(len / 2)) cut = -1;
  if (cut < 0) {
    for (let i = win.length - 1; i >= 0; i--) {
      if (SENT_PAUSE_CHARS.includes(win[i])) { cut = i + 1; break; }
    }
  }
  // 断点太靠前同样放弃（保留更多内容比断句更重要）
  if (cut >= Math.floor(len / 2) && cut <= win.length) {
    return t.slice(0, cut) + "…";
  }
  return t.slice(0, len) + "…";
}

/** 去掉 emoji/装饰符号；去完为空时回退原文（正文永远展示真实内容，不引入模板句） */
function stripEmoji(text) {
  const t = String(text || "").replace(/\p{Extended_Pictographic}/gu, "").replace(/\s+/g, " ").trim();
  return t || String(text || "");
}

/** 结尾句号变感叹号（活泼用） */
function exclaim(text) {
  return String(text || "").replace(/。$/, "！");
}

/** 温柔软化：句号/叹号变波浪号（句子内部也软），问号保留 */
function soften(text) {
  return String(text || "").replace(/。+/g, "～").replace(/！+/g, "～").replace(/!+/g, "～");
}

/** 温柔正文：软化 + 引号信件感 + 句尾无标点补～ */
function gentleBody(snippet) {
  const t = clip(snippet, LEN_DEFAULT);
  if (!t) return "";
  const soft = soften(t);
  const tail = /[～？?…]$/.test(soft) ? "" : "～";
  return `「${soft}${tail}」`;
}

/** 古风收束：短截原文，句尾缺标点补「。」（雅句收尾） */
function classicBody(snippet) {
  const t = clip(snippet, LEN_DEFAULT);
  if (!t) return "";
  return /[。！？!?…]$/.test(t) ? t : t + "。";
}

/** 活泼兴奋：句尾标点统一升级，无标点补「！！」，省略号不动 */
function excite(text) {
  const t = String(text || "").trim();
  if (!t || t.endsWith("…")) return t;
  if (t.endsWith("？") || t.endsWith("?")) return t.slice(0, -1) + "？！";
  if (/[。！!]+$/.test(t)) return t.replace(/[。！!]+$/, "！！");
  return t + "！！";
}

// ── 会话标题前缀 ──
// 痛点：同时开多个对话框时不知道哪个框回复完了，标题带上会话标题（截 12 字）
const SESSION_TITLE_MAX = 12;

function sessionPrefix(sessionTitle) {
  if (!sessionTitle) return "";
  const t = String(sessionTitle).trim();
  if (!t) return "";
  const clipped = t.length > SESSION_TITLE_MAX ? t.slice(0, SESSION_TITLE_MAX) + "…" : t;
  return clipped + " · ";
}
export { sessionPrefix };

/** 包装风格标题函数：统一在标题前加会话标题前缀（不传则无前缀，预览/测试用） */
function withSessionTitle(fn) {
  return (kind, agentName, count, sessionTitle) =>
    sessionPrefix(sessionTitle) + fn(kind, agentName, count);
}

export { withSessionTitle, clip };

// ── 动森口癖正文加工 ──
// 截断原话（给口癖留位置）后，尾部缀固定口癖词。
// 口癖是固定词、不改变原话信息（铁律：正文永远展示真实内容）。
const ACNH_LEN = 18; // 口癖占位，正文截短一点，保证口癖后总长不超 24
function catchTail(text, catchword, sep = "，", end = "") {
  const t = clip(text, ACNH_LEN);
  if (!t) return "";
  return t + sep + catchword + end;
}

// ── 整活风格加工 ──

// 摩斯电码表（字母 + 数字，标准国际摩斯）
const MORSE = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....",
  I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.",
  Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-",
  Y: "-.--", Z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
  "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----."
};

/** 字符转摩斯：字母/数字直接查表，其余（含中文）转 Unicode 码点数字再转摩斯 */
function charToMorse(ch) {
  const up = String(ch).toUpperCase();
  if (MORSE[up]) return MORSE[up];
  const code = String(ch.codePointAt(0));
  return [...code].map((d) => MORSE[d]).join(" ");
}

/** 正文转摩斯串（空格 → /），整体截断到 LEN_MORSE（整活风格，氛围为主） */
const LEN_MORSE = 60;
function toMorse(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const out = [...t].map((ch) => (ch === " " ? "/" : charToMorse(ch))).join(" ");
  return out.length > LEN_MORSE ? out.slice(0, LEN_MORSE) + "…" : out;
}

// 系统故障乱码字库（替换用）
const GLITCH_CHARS = ["�", "□", "▓", "╳", "◇"];

/** 故障风：截断后每隔 4 个字符把第 4 个替换成乱码字符（格式损坏感） */
function glitch(text) {
  const t = clip(text, LEN_DEFAULT);
  if (!t) return "";
  const arr = [...t];
  for (let i = 3; i < arr.length; i += 4) {
    arr[i] = GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
  }
  return arr.join("");
}

// 锟斤拷乱码词库（经典编码错误产物，成串才有味道）
const MOJIBAKE_CHUNKS = ["锟斤拷", "烫烫烫", "屯屯屯", "锟斤拷", "烫烫烫", "�", "□□□"];

/** 锟斤拷风：按正文长度生成等长乱码串（长度对得上，像真的解码坏了） */
function mojibake(text) {
  const len = clip(text, LEN_DEFAULT).length;
  if (!len) return "";
  let out = "";
  while (out.length < len) {
    out += MOJIBAKE_CHUNKS[Math.floor(Math.random() * MOJIBAKE_CHUNKS.length)];
  }
  return out.slice(0, len);
}

// 大厂黑话标题模板（每次通知随机一个，换着姿势黑话）
const BIZ_TITLES = {
  first: [
    (n) => `${n} 回复已触达 ✅`,
    (n) => `【闭环】${n} 回复完成`,
    (n) => `${n}：新回复已同步`,
    (n) => `拉通对齐：${n} 回复完成`,
    (n) => `${n} 回复已交付`
  ],
  append: [
    (n, c) => `${n} 又回 ${c} 条，链路已更新`,
    (n, c) => `【增补】${n} 追加 ${c} 条回复`,
    (n, c) => `${n} 新增 ${c} 条，信息已拉齐`
  ]
};

function bizTitle(kind, agentName, count) {
  const pool = BIZ_TITLES[kind] || BIZ_TITLES.first;
  const fn = pool[Math.floor(Math.random() * pool.length)];
  return fn(agentName, Math.max(0, (count || 1) - 1));
}

/**
 * 风格定义。title/body 都是纯函数：
 *   title(kind, agentName, count) → 标题
 *   body(kind, snippet, count)     → 正文
 * kind: "first"（第一条）/ "append"（合并补弹）
 */
export const STYLES = {
  default: {
    id: "default",
    label: "跟随默认",
    desc: "标准提醒，跟以前一样",
    group: "normal",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) => buildTitle(kind, agentName, count)),
    body: (kind, snippet, count) =>
      kind === "append" ? `补充：${clip(snippet, LEN_DEFAULT)}` : clip(snippet, LEN_DEFAULT)
  },
  plain: {
    id: "plain",
    label: "简洁高效",
    desc: "电报风，去装饰说正事",
    group: "normal",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `${agentName} · 又回 ${Math.max(0, (count || 1) - 1)} 条`
        : `${agentName} · 新回复`
    ),
    body: (kind, snippet, count) => clip(stripEmoji(snippet), LEN_PLAIN)
  },
  cheerful: {
    id: "cheerful",
    label: "活泼可爱",
    desc: "撒花报喜，热闹有元气",
    group: "normal",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `🎉 ${agentName} 又回了 ${Math.max(0, (count || 1) - 1)} 条！`
        : `🎉 ${agentName} 回你啦！`
    ),
    body: (kind, snippet, count) => `${excite(clip(snippet, LEN_DEFAULT))} 🎉`
  },
  gentle: {
    id: "gentle",
    label: "温柔贴心",
    desc: "信件感，轻声递话",
    group: "normal",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `💌 「${agentName}」又留了 ${Math.max(0, (count || 1) - 1)} 条话～`
        : `💌 「${agentName}」给你捎了句话～`
    ),
    body: (kind, snippet, count) => gentleBody(snippet)
  },
  sister: {
    id: "sister",
    label: "闺蜜俏皮",
    desc: "姐妹拽袖，快看快看",
    group: "normal",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `姐妹！${agentName} 又回 ${Math.max(0, (count || 1) - 1)} 条！`
        : `姐妹！${agentName} 回你了！`
    ),
    body: (kind, snippet, count) => excite(clip(snippet, LEN_DEFAULT))
  },
  epistle: {
    id: "epistle",
    label: "古风书简",
    desc: "展信佳，笺札递话",
    group: "normal",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `📜 ${agentName} 又寄来 ${Math.max(0, (count || 1) - 1)} 行`
        : `📜 展信佳 · ${agentName} 有书至`
    ),
    body: (kind, snippet, count) => classicBody(snippet)
  },
  biz: {
    id: "biz",
    label: "大厂黑话",
    desc: "标题黑话化，正文原文",
    group: "normal",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) => bizTitle(kind, agentName, count)),
    body: (kind, snippet, count) => clip(snippet, LEN_DEFAULT)
  },

  // ── 动森岛民风格（acnh 组）──
  // 口癖与译名基于《集合啦！动物森友会》简中官方文本。
  // 2026-08-30 交叉审查优化（审查伙伴三维度）：
  //   - 口癖只占标题一处，正文尽量完整留给原话（截断风险）
  //   - 章丸丸简中口癖是「没错」不是繁体「认同」
  //   - 狸克魂是铃钱，不是「欢迎光临」（那是豆狸粒狸的迎宾语）
  //   - 杰克惜字如金：正文零词缀
  //   - 艳后「尼罗」加语气词软化（尼罗哟）
  ac_shizue: {
    id: "ac_shizue",
    label: "西施惠播报",
    desc: "秘书官晨间新闻腔，正经又温暖",
    group: "acnh",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `📢 本台消息 · ${agentName} 又回 ${Math.max(0, (count || 1) - 1)} 条`
        : `📢 今日播报 · ${agentName} 有消息来啦`
    ),
    body: (kind, snippet, count) => {
      const t = clip(snippet, LEN_DEFAULT);
      return t ? t + " ♪" : "";
    }
  },
  ac_jack: {
    id: "ac_jack",
    label: "杰克·严肃",
    desc: "惜字如金，高冷猫猫",
    group: "acnh",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `${agentName} 又回了 ${Math.max(0, (count || 1) - 1)} 条。`
        : `${agentName} 回你了。`
    ),
    // 零词缀：杰克是 10 套里最短的那套，惜字如金本身就是角色表达
    body: (kind, snippet, count) => clip(snippet, LEN_DEFAULT)
  },
  ac_jun: {
    id: "ac_jun",
    label: "小润·傲娇",
    desc: "哼一声，傲娇少爷",
    group: "acnh",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `哼，${agentName} 又回 ${Math.max(0, (count || 1) - 1)} 条。`
        : `哼，${agentName} 回你了。`
    ),
    body: (kind, snippet, count) => clip(snippet, LEN_DEFAULT)
  },
  ac_chacha: {
    id: "ac_chacha",
    label: "茶茶丸·哇耶",
    desc: "操场领操，元气满满",
    group: "acnh",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `哇耶！${agentName} 又回 ${Math.max(0, (count || 1) - 1)} 条！`
        : `哇耶！${agentName} 回你啦！`
    ),
    body: (kind, snippet, count) => clip(snippet, LEN_DEFAULT)
  },
  ac_monica: {
    id: "ac_monica",
    label: "莫妮卡·呀哈",
    desc: "元气偶像狼，呀哈一声",
    group: "acnh",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `呀哈！${agentName} 又回 ${Math.max(0, (count || 1) - 1)} 条～`
        : `呀哈！${agentName} 回你啦～`
    ),
    body: (kind, snippet, count) => clip(snippet, LEN_DEFAULT)
  },
  ac_judy: {
    id: "ac_judy",
    label: "美玲·哦呀",
    desc: "梦幻小熊，哦呀一声",
    group: "acnh",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `哦呀，${agentName} 又留了 ${Math.max(0, (count || 1) - 1)} 条话`
        : `哦呀，${agentName} 给你留了句话`
    ),
    body: (kind, snippet, count) => clip(snippet, LEN_DEFAULT)
  },
  ac_ankha: {
    id: "ac_ankha",
    label: "艳后·尼罗",
    desc: "三千年的猫，尼罗哟",
    group: "acnh",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `尼罗河畔 · ${agentName} 又回 ${Math.max(0, (count || 1) - 1)} 条`
        : `尼罗河畔有信 · ${agentName} 回你了`
    ),
    // 尼罗加语气词软化（审查伙伴建议），避免「原话，尼罗。」像报名字
    body: (kind, snippet, count) => catchTail(snippet, "尼罗哟", "…", "。")
  },
  ac_zucker: {
    id: "ac_zucker",
    label: "章丸丸·没错",
    desc: "慢悠悠，没错没错",
    group: "acnh",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `嗯…没错，${agentName} 又回 ${Math.max(0, (count || 1) - 1)} 条`
        : `嗯…没错，${agentName} 回你了`
    ),
    body: (kind, snippet, count) => catchTail(snippet, "没错", "…", "。")
  },
  ac_nook: {
    id: "ac_nook",
    label: "狸克商店",
    desc: "铃钱结清，货已到店",
    group: "acnh",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `🏪 本店补货 · ${agentName} 又上 ${Math.max(0, (count || 1) - 1)} 件（铃钱已结清）`
        : `🏪 本店通知 · ${agentName} 的货到了（铃钱已结清）`
    ),
    body: (kind, snippet, count) => {
      const t = clip(snippet, LEN_DEFAULT);
      return t ? t : "";
    }
  },
  ac_timmy: {
    id: "ac_timmy",
    label: "豆狸粒狸",
    desc: "双胞胎接龙，一唱一和",
    group: "acnh",
    refinable: true,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `豆狸：${agentName} 又回 ${Math.max(0, (count || 1) - 1)} 条！粒狸：别错过！`
        : `豆狸：${agentName} 回你啦！粒狸：快去看！`
    ),
    body: (kind, snippet, count) => clip(snippet, LEN_DEFAULT)
  },
  morse: {
    id: "morse",
    label: "摩斯电码",
    desc: "正文转摩斯，电报味拉满",
    group: "fun",
    refinable: false,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `📡 ${agentName} 又发来 ${Math.max(0, (count || 1) - 1)} 条电码`
        : `📡 ${agentName} 给你发了条摩斯电码`
    ),
    body: (kind, snippet, count) => toMorse(snippet)
  },
  glitch: {
    id: "glitch",
    label: "系统故障",
    desc: "内容夹乱码，像格式损坏",
    group: "fun",
    refinable: false,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `🖥 ${agentName} 又回 ${Math.max(0, (count || 1) - 1)} 条（信号不稳）`
        : `🖥 ${agentName} 回你了（信号不稳）`
    ),
    body: (kind, snippet, count) => glitch(snippet)
  },
  mojibake: {
    id: "mojibake",
    label: "锟斤拷",
    desc: "全乱码，编码错误经典梗",
    group: "fun",
    refinable: false,
    title: withSessionTitle((kind, agentName, count) =>
      kind === "append"
        ? `💽 ${agentName} 又回 ${Math.max(0, (count || 1) - 1)} 条（编码损坏）`
        : `💽 ${agentName} 的回复编码损坏`
    ),
    body: (kind, snippet, count) => mojibake(snippet)
  }
};

// ── 风格分组（设置页二级折叠展示） ──
// 每个风格带 group 字段归组；组顺序 = 首次出现顺序（getStyleGroups）。
const STYLE_GROUPS = {
  normal: { id: "normal", label: "日常风格", desc: "平时顺手用的" },
  fun: { id: "fun", label: "整活玩法", desc: "摩斯/故障/乱码" },
  acnh: { id: "acnh", label: "动森岛民", desc: "岛民口癖与 NPC 播报" }
};

/** 全部分组（按风格列表首次出现顺序） */
export function getStyleGroups() {
  const seen = [];
  for (const id of getStyleIds()) {
    const g = getStyle(id).group || "normal";
    if (STYLE_GROUPS[g] && !seen.some((x) => x.id === g)) seen.push(STYLE_GROUPS[g]);
  }
  return seen;
}

// ── 扩展风格（动态注册，如表情包插件方言联动） ──
// 基础 10 套永远在；扩展风格按需注册（装了 biaoqingbao 插件才有方言/学我说话）。
// 位置约定：扩展风格排在列表最后（整活向之后）。
const EXTRA_STYLES = [];

/** 注册一张扩展风格（幂等：同 id 重复注册覆盖旧定义并保持原位置） */
export function registerStyle(style) {
  if (!style || typeof style !== "object" || !style.id) return;
  const idx = EXTRA_STYLES.findIndex((s) => s.id === style.id);
  if (idx >= 0) EXTRA_STYLES[idx] = style;
  else EXTRA_STYLES.push(style);
  // 同一对象的属性补齐（getAllStyles 依赖 id/label/desc/refinable/group 存在）
  style.label = style.label || style.id;
  style.desc = style.desc || "";
  style.refinable = style.refinable !== false;
  style.group = style.group || "normal";
}

/** 全部风格 id（基础 + 扩展，按展示顺序） */
export function getStyleIds() {
  return [...Object.keys(STYLES), ...EXTRA_STYLES.map((s) => s.id)];
}

/** 取风格模板（含扩展）；未知 id 回退默认 */
export function getStyle(id) {
  const hit = EXTRA_STYLES.find((s) => s.id === id);
  return hit || STYLES[id] || STYLES.default;
}

/** 全部风格对象（按展示顺序） */
export function getAllStyles() {
  return getStyleIds().map((id) => getStyle(id));
}

/** 兼容旧引用：基础风格集合（不含扩展） */
export const STYLE_IDS = Object.keys(STYLES);
