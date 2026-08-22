// 提个醒 · 通知策略（纯逻辑，可单元测试）
//
// 规则（2026-08-09 定）：
//   1. 每条回复完成都弹；同一会话（窗口）30 秒内的多条回复合并，跨窗口永远不合并
//   2. 合并窗口结束（30 秒无新回复）且期间有合并 → 补弹一条追加条
//   3. 静默时段 → 不弹窗
//
// v0.3.0：重要关键词功能已删除（页面感知不到价值，与「总是提醒」档重叠），合并/静默保留

export const DEFAULT_SNIPPET_LEN = 48; // 粗截（通知栏只显示两行，最终长度由风格正文加工决定）

// 聊天提醒时机档位（与 config.js 的 VALID_CHAT_TRIGGERS 保持一致）
export const CHAT_TRIGGERS = ["never", "whenUnfocused", "whenSessionUnfocused", "always"];

/**
 * 解析某个助手实际生效的聊天提醒时机（v0.5.0）：
 * 清单里配了档位 → 用该助手的；没配 → 跟随全局 chatTrigger。
 * @param {object} cfg 配置（含 chatTrigger / agentTriggers）
 * @param {string} agentId 助手 id
 * @returns {string} never / whenUnfocused / whenSessionUnfocused / always
 */
export function resolveChatTrigger(cfg, agentId) {
  const global = cfg?.chatTrigger;
  const map = cfg?.agentTriggers && typeof cfg.agentTriggers === "object" ? cfg.agentTriggers : {};
  const custom = agentId ? map[agentId] : undefined;
  return custom && CHAT_TRIGGERS.includes(custom) ? custom : (global || "whenSessionUnfocused");
}

/**
 * 是否处于静默时段（支持跨午夜，如 22:00 → 08:00）。
 */
export function isInQuietHours(config, date = new Date()) {
  const qh = config?.quietHours;
  if (!qh || !qh.enabled) return false;
  const startMatch = /^(\d{1,2}):(\d{2})$/.exec(String(qh.start || ""));
  const endMatch = /^(\d{1,2}):(\d{2})$/.exec(String(qh.end || ""));
  if (!startMatch || !endMatch) return false;

  const startMin = Number(startMatch[1]) * 60 + Number(startMatch[2]);
  const endMin = Number(endMatch[1]) * 60 + Number(endMatch[2]);
  if (startMin === endMin) return false;

  const curMin = date.getHours() * 60 + date.getMinutes();
  if (startMin < endMin) return curMin >= startMin && curMin < endMin;
  return curMin >= startMin || curMin < endMin; // 跨午夜
}

/** 截取 snippet */
export function makeSnippet(text, len = DEFAULT_SNIPPET_LEN) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "(空回复)";
  return t.length > len ? t.slice(0, len) + "…" : t;
}

/**
 * 按会话维护合并窗口的通知决策器。
 *
 * 用法：
 *   const n = new Notifier(config);
 *   const d1 = n.decide({ sessionId, agentName, text }, now1);   // -> toast(first)
 *   const d2 = n.decide({ sessionId, agentName, text }, now2);   // -> merge（窗口内）
 *   const d3 = n.flush(sessionId, now3);                          // 窗口结束 → toast(append) 或 null
 */
export class Notifier {
  constructor(config) {
    this.config = config;
    /** sessionId -> { count, snippet, agentName, lastEventAt } */
    this.sessions = new Map();
  }

  _state(sessionId) {
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = { count: 0, snippet: "", agentId: "", agentName: "", sessionPath: "", lastEventAt: 0 };
      this.sessions.set(sessionId, st);
    }
    return st;
  }

  /**
   * 处理一条回复完成事件。
   * @returns {{action:string, ...}} toast(first) / merge / skip(reason)
   */
  decide({ sessionId, agentId, agentName, text, sessionPath }, now = Date.now()) {
    if (!this.config.enabled) return { action: "skip", reason: "disabled" };
    if (isInQuietHours(this.config, new Date(now))) return { action: "skip", reason: "quiet" };

    const snippet = makeSnippet(text);
    const st = this._state(sessionId);
    const windowMs = Math.max(0, Number(this.config.mergeWindowMs) || 0);

    // 窗口内新事件 → 合并
    if (st.count > 0 && now - st.lastEventAt < windowMs) {
      st.count += 1;
      st.snippet = snippet;
      st.agentId = agentId;
      st.agentName = agentName;
      st.sessionPath = sessionPath || st.sessionPath;
      st.lastEventAt = now;
      return { action: "merge", sessionId, count: st.count };
    }

    // 开新窗口，立即弹第一条
    st.count = 1;
    st.snippet = snippet;
    st.agentId = agentId;
    st.agentName = agentName;
    st.sessionPath = sessionPath || "";
    st.lastEventAt = now;
    return { action: "toast", kind: "first", sessionId, agentId, agentName, sessionPath: st.sessionPath, snippet, count: 1 };
  }

  /**
   * 合并窗口结束（外部定时器到点调用）。
   * @returns {{action:"toast", kind:"append", ...} | null} 窗口内只有 1 条时不补弹
   */
  flush(sessionId, now = Date.now()) {
    const st = this._state(sessionId);
    if (st.count === 0) return null;
    const result =
      st.count > 1
        ? {
            action: "toast",
            kind: "append",
            sessionId,
            agentId: st.agentId,
            agentName: st.agentName,
            sessionPath: st.sessionPath,
            snippet: st.snippet,
            count: st.count
          }
        : null;
    st.count = 0;
    st.snippet = "";
    st.agentId = "";
    st.agentName = "";
    st.sessionPath = "";
    st.lastEventAt = 0;
    return result;
  }
}

/**
 * 组装弹窗标题。
 * @param {string} agentName 助手显示名（如「小花」）
 * @param {number} [count] append 时传入累计条数
 */
export function buildTitle(kind, agentName, count) {
  const name = agentName || "助手";
  if (kind === "append") return `${name} 又回了 ${Math.max(0, (count || 1) - 1)} 条`;
  return `${name} 回你了`;
}
