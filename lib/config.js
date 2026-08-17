// 提个醒 · 配置管理
// preferences.json 存 Hana 数据目录（与插件代码分离，避免更新覆盖）。
// 内存缓存 + 写队列串行化（坑 47：并发写会损坏配置）。

import fs from "node:fs";
import path from "node:path";
import { getStyleIds } from "./style.js";

export const DEFAULT_CONFIG = {
  enabled: true,            // 总开关（兼容旧配置）
  // 三项通知各自独立的监听档位（跟 Hana 原版设置一一对应）：
  chatTrigger: "whenSessionUnfocused", // 聊天回复完成：never / whenUnfocused / whenSessionUnfocused / always
  scheduledTrigger: "whenUnfocused",   // 计划任务完成：never / whenUnfocused / always
  patrolTrigger: "whenUnfocused",      // 巡检完成：never / whenUnfocused / always
  toastStyle: "icon",       // 通知样式：icon=带头像（助手头像）/ plain=简洁纯文本
  mergeWindowMs: 30000,     // 同一窗口内的合并窗口（毫秒）。v0.2.0 起设置页不再暴露此选项，固定默认 30 秒防轰炸；字段保留供合并逻辑使用，兼容旧配置
  soundDir: "",             // 自定义音效文件夹（绝对路径）；留空 = 默认插件数据目录 sounds/
  agentSounds: {},          // 按助手分配音效：{ agentId: "default" | "silent" | "<音效文件名>" }
  agentStyles: {},          // 按助手分配通知风格：{ agentId: "default" | "plain" | "cheerful" | "gentle" }
  refineEnabled: false,     // 文案润色（可选高级档）：开启后语气型风格的标题+正文由模型改写，默认关
  quietHours: {
    enabled: false,
    start: "22:00",         // HH:mm
    end: "08:00"
  }
};

// 旧版 notifyScope 字段 → trigger 档位映射（v0.2 兼容）
const SCOPE_TO_TRIGGER = { background: "whenSessionUnfocused", all: "always" };
// 聊天档位：四档（含 always）；计划任务/巡检：三档（无 whenSessionUnfocused，跟原版一致）
const VALID_CHAT_TRIGGERS = ["never", "whenUnfocused", "whenSessionUnfocused", "always"];
const VALID_TASK_TRIGGERS = ["never", "whenUnfocused", "always"];

/** 旧单 trigger 字段 → chatTrigger（v0.3.1 兼容：拆分前配置只控聊天） */
function legacyTriggerToChat(raw) {
  if (VALID_CHAT_TRIGGERS.includes(raw.trigger)) return raw.trigger;
  if (SCOPE_TO_TRIGGER[raw.notifyScope]) return SCOPE_TO_TRIGGER[raw.notifyScope];
  return DEFAULT_CONFIG.chatTrigger;
}

export function configFilePath(dataDir, pluginId) {
  return path.join(dataDir, pluginId, "preferences.json");
}

export function normalizeConfig(raw) {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!raw || typeof raw !== "object") return base;
  const out = base;

  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  // 三项独立档位：新字段优先；旧单 trigger 迁移到 chatTrigger（v0.3.1）
  out.chatTrigger = VALID_CHAT_TRIGGERS.includes(raw.chatTrigger) ? raw.chatTrigger : legacyTriggerToChat(raw);
  out.scheduledTrigger = VALID_TASK_TRIGGERS.includes(raw.scheduledTrigger) ? raw.scheduledTrigger : DEFAULT_CONFIG.scheduledTrigger;
  out.patrolTrigger = VALID_TASK_TRIGGERS.includes(raw.patrolTrigger) ? raw.patrolTrigger : DEFAULT_CONFIG.patrolTrigger;
  // 通知样式固定带头像（v0.3.1 定：不需要用户选择，永远带头像跟随助手，符合使用习惯）
  out.toastStyle = "icon";
  if (typeof raw.refineEnabled === "boolean") out.refineEnabled = raw.refineEnabled;
  if (typeof raw.mergeWindowMs === "number" && raw.mergeWindowMs >= 0) out.mergeWindowMs = raw.mergeWindowMs;

  // 助手风格分配：只收合法风格 id（白名单在 style.js）
  // 自定义音效文件夹：只收绝对路径字符串（含盘符/UNC），相对路径与超长忽略回默认
  if (typeof raw.soundDir === "string") {
    const s = raw.soundDir.trim();
    out.soundDir = s.length <= 1024 && (s === "" || path.isAbsolute(s)) ? s : "";
  }

  if (raw.agentStyles && typeof raw.agentStyles === "object" && !Array.isArray(raw.agentStyles)) {
    const map = {};
    for (const [agentId, v] of Object.entries(raw.agentStyles)) {
      const val = String(v || "default").trim();
      if (getStyleIds().includes(val)) {
        map[String(agentId).slice(0, 100)] = val;
      }
    }
    out.agentStyles = map;
  }

  // 助手音效分配：只收对象，值白名单（default/silent/文件名，文件名安全校验在 resolve 时做）
  if (raw.agentSounds && typeof raw.agentSounds === "object" && !Array.isArray(raw.agentSounds)) {
    const map = {};
    for (const [agentId, v] of Object.entries(raw.agentSounds)) {
      const val = String(v || "default").trim();
      if (val === "default" || val === "silent" || val.length <= 200) {
        map[String(agentId).slice(0, 100)] = val;
      }
    }
    out.agentSounds = map;
  }

  if (raw.quietHours && typeof raw.quietHours === "object") {
    if (typeof raw.quietHours.enabled === "boolean") out.quietHours.enabled = raw.quietHours.enabled;
    if (typeof raw.quietHours.start === "string" && /^\d{1,2}:\d{2}$/.test(raw.quietHours.start)) {
      out.quietHours.start = raw.quietHours.start;
    }
    if (typeof raw.quietHours.end === "string" && /^\d{1,2}:\d{2}$/.test(raw.quietHours.end)) {
      out.quietHours.end = raw.quietHours.end;
    }
  }

  return out;
}

/**
 * 创建配置管理器。
 * 注意：插件主进程（index.js，弹通知）与设置页路由（routes/api.js，改配置）会各自创建一份实例。
 * 若 get() 只认内存缓存，设置页改完配置当前进程不会生效（坑：润色开关改了还在跑）。
 * 因此 get() 会校验本文件签名：文件被外部改动（另一实例写入）时强制重读，保证两边同步。
 * @param {object} ctx 插件上下文（dataDir / pluginId / log）
 */
export function createConfigManager(ctx) {
  const { dataDir, pluginId, log } = ctx;
  const fp = configFilePath(dataDir, pluginId);

  let cache = null;      // 最近一次读取/写入的配置快照
  let fileSig = null;    // 文件签名（mtimeMs:size），用于检测外部改动
  let injected = null;   // 测试注入（get 时优先返回）
  let writeChain = Promise.resolve();

  function fileSignature() {
    try {
      const st = fs.statSync(fp);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null; // 文件不存在/读不到 → 视为无签名
    }
  }

  function load() {
    if (injected) return injected;
    const sig = fileSignature();
    // 文件签名没变（外部没人改）→ 直接用缓存；签名变了 → 强制重读文件
    if (cache && sig !== null && sig === fileSig) return cache;
    try {
      if (fs.existsSync(fp)) {
        cache = normalizeConfig(JSON.parse(fs.readFileSync(fp, "utf-8")));
      } else {
        cache = normalizeConfig(null);
      }
      fileSig = fileSignature();
    } catch (err) {
      log?.error?.("[提个醒] 配置读取失败，用默认值", { error: err.message });
      cache = normalizeConfig(null);
    }
    return cache;
  }

  function save() {
    const snapshot = JSON.stringify(cache, null, 2);
    writeChain = writeChain.then(() => {
      try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, snapshot, "utf-8");
      } catch (err) {
        log?.error?.("[提个醒] 配置写入失败", { error: err.message });
      }
    });
    return writeChain;
  }

  return {
    get() { return load(); },
    /** 整体替换配置（前端表单提交） */
    set(next) {
      cache = normalizeConfig(next);
      return save();
    },
    /** 局部修改 */
    patch(patchObj) {
      cache = normalizeConfig({ ...load(), ...patchObj });
      return save();
    },
    /** 测试用：直接注入配置对象并跳过文件 */
    __inject(raw) { injected = normalizeConfig(raw); }
  };
}
