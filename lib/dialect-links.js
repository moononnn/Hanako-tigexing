// lib/dialect-links.js - 表情包插件方言联动（分享版）
//
// 前提：用户装了 biaoqingbao 插件 → 提个醒动态挂上它的九种方言风格 + 学我说话风格。
// 机制：
//   - 方言风格 = 规则版（标题方言模板点味，正文原文照显）+ 润色版（精修文案全量注入，标题正文全方言化）
//   - 学我说话 = 只有润色版有效（用户风格只能靠模型模仿），规则版回归默认标题
//   - 全部依赖仅发生在「检测到插件」之后：没装插件直接空注册，分享版其他用户不受影响
//
// 实现（v0.4.0）：onload 时调用 setupExtraStyles() 一次性注册；注册失败静默降级。
// 动态 import 表情包的 DIALECTS 拿精修文案（personaAdvanced），路径在 HANA_HOME/plugins/biaoqingbao。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

import { registerStyle, withSessionTitle, clip } from "./style.js";
import { registerRefineInstruction } from "./refine.js";

// ── 方言展示顺序（跟随表情包方言库对象键序；新增方言自动跟随）──
// 不再写死九种：表情包加新款，提个醒重启后自动挂载。
// 内置规则版方言标题模板（不开润色时靠标题点味；语气词取自各方言库），
// 新增方言没有内置模板时自动回退默认标题（照样挂上，不缺席）。

// ── 规则版方言标题模板（不开润色时靠标题点味；语气词取自各方言库）──
const TITLE_TEMPLATES = {
  dongbei: { first: (name) => `${name} 回你了哈！`, append: (name, n) => `${name} 又回 ${n} 条，麻溜儿看！` },
  henan: { first: (name) => `中！${name} 回你了`, append: (name, n) => `${name} 又回 ${n} 条嘞，得劲儿` },
  shanghai: { first: (name) => `侬看，${name} 回你了呀`, append: (name, n) => `${name} 又回 ${n} 条啦` },
  cantonese: { first: (name) => `${name} 回你喇！`, append: (name, n) => `${name} 又回 ${n} 条啦！` },
  taiwan: { first: (name) => `${name} 回你惹～`, append: (name, n) => `${name} 又回 ${n} 条惹～` },
  sichuan: { first: (name) => `${name} 回你了噻`, append: (name, n) => `${name} 又回 ${n} 条咯` },
  shaanxi: { first: (name) => `${name} 回你了么`, append: (name, n) => `${name} 又回 ${n} 条了么` },
  beijing: { first: (name) => `您呐，${name} 回你了`, append: (name, n) => `${name} 又回 ${n} 条，得嘞` },
  xinjiang: { first: (name) => `${name} 回你了撒`, append: (name, n) => `${name} 又回 ${n} 条撒` },
};

/** 默认 Hana 根目录（环境变量可覆盖，测试用） */
export function resolveHanaHome() {
  return process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
}

/** 表情包插件是否安装（目录 + 方言库文件都在才算） */
export function biaoqingbaoInstalled(hanaHome = resolveHanaHome()) {
  return (
    fs.existsSync(path.join(hanaHome, "plugins", "biaoqingbao")) &&
    fs.existsSync(path.join(hanaHome, "plugins", "biaoqingbao", "lib", "dialect.js"))
  );
}

/** 读「学我说话」模板（style-template.json 的 current）；无模板返回空串 */
export function readUserStyleTemplate(pluginDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pluginDataDir, "style-template.json"), "utf-8"));
    return typeof raw?.current === "string" && raw.current.trim() ? raw.current.trim() : "";
  } catch {
    return "";
  }
}

/** 动态加载 biaoqingbao 方言库；失败返回 null（不抛） */
export async function loadDialects(hanaHome = resolveHanaHome()) {
  if (!biaoqingbaoInstalled(hanaHome)) return null;
  try {
    const file = path.join(hanaHome, "plugins", "biaoqingbao", "lib", "dialect.js");
    const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`); // 防模块缓存：测试多次装载同一临时目录
    return mod?.DIALECTS || null;
  } catch {
    return null;
  }
}

/**
 * 构造扩展风格集（纯函数，可测）。
 * @param {{ dialects?: object, userTemplate?: string }} env 方言库对象 + 学我说话模板（空串=没有）
 * @returns {{ styles: object[], instructions: Record<string,string> }}
 */
export function buildExtraStyles({ dialects = null, userTemplate = "" } = {}) {
  const styles = [];
  const instructions = {};

  if (dialects && typeof dialects === "object") {
    // 动态跟随：遍历表情包方言表全部键；userstyle（学我说话）走模板流程，单独处理
    for (const id of Object.keys(dialects)) {
      if (id === "userstyle") continue;
      const d = dialects[id];
      if (!d || !d.name) continue;
      const styleId = `dh_${id}`;
      const tpl = TITLE_TEMPLATES[id];
      const n = (kind, count) => Math.max(0, (count || 1) - 1);
      styles.push({
        id: styleId,
        label: d.name,
        desc: d.tagline ? `${d.tagline}，${d.name}味` : `${d.name}味`,
        refinable: true,
        title: withSessionTitle((kind, agentName, count) => {
          // 有内置方言标题模板用模板，没有则回退默认标题（新增方言兜底）
          if (tpl) return kind === "append" ? tpl.append(agentName, n(kind, count)) : tpl.first(agentName);
          return kind === "append" ? `${agentName} 又回了 ${n(kind, count)} 条` : `${agentName} 回你了`;
        }),
        // 规则版正文永远是原话（提个醒铁律），方言感交给标题
        body: (kind, snippet, count) => clip(snippet)
      });
      // 润色指令：精修文案全量注入（方案 B）
      if (d.personaAdvanced) {
        instructions[styleId] =
          `把通知标题和正文改写成${d.name}的口吻：标题一句话含助手名，正文保留核心信息、句尾语气词带出来。参考这个人的说话方式：${d.personaAdvanced}`;
      } else {
        instructions[styleId] = `把通知标题和正文改写成${d.name}的口吻，自然带出方言味`;
      }
    }
  }

  // 学我说话：模板是用户的独家风格；只有润色能模仿，规则版标题回归默认
  if (userTemplate) {
    const styleId = "userstyle";
    styles.push({
      id: styleId,
      label: "学我说话",
      desc: "模仿你的打字风格（需开润色）",
      refinable: true,
      title: withSessionTitle((kind, agentName, count) =>
        kind === "append"
          ? `${agentName} 又回了 ${Math.max(0, (count || 1) - 1)} 条`
          : `${agentName} 回你了`
      ),
      body: (kind, snippet, count) => clip(snippet)
    });
    instructions[styleId] =
      `把通知标题和正文改写成用户本人打字的风格，完全模仿 ta 的习惯（语气词/句式/标点/口头禅），标题一句话含助手名、正文保留核心信息。参考用户风格模板：${userTemplate}`;
  }

  return { styles, instructions };
}

/**
 * 一键接线：检测环境 → 构造 → 注册到提个醒（幂等，重复调用覆盖旧注册）。
 * 没装插件 / 读取失败 → 空注册，静默返回 null。
 * @returns {{ styles: object[], instructions: Record<string,string> } | null}
 */
export async function setupExtraStyles(hanaHome = resolveHanaHome()) {
  const installed = biaoqingbaoInstalled(hanaHome);
  const userTemplate = installed
    ? readUserStyleTemplate(path.join(hanaHome, "plugin-data", "biaoqingbao"))
    : "";
  const dialects = installed ? await loadDialects(hanaHome) : null;
  const extra = buildExtraStyles({ dialects, userTemplate });

  for (const s of extra.styles) registerStyle(s);
  for (const [id, instr] of Object.entries(extra.instructions)) registerRefineInstruction(id, instr);

  return extra.styles.length ? extra : null;
}