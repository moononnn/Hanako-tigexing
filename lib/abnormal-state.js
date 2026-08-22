// 提个醒 · 异常回合状态机
// 只负责识别“一轮是否已经需要提醒”和去重，不发送消息、不自动续接。

import { isRetryCancelled } from "./abnormal-copy.js";

export const ABNORMAL_FAILURE_GRACE_MS = 2500;

function safeSessionId(sessionId) {
  const id = String(sessionId || "").trim();
  return id || "unknown";
}

export class AbnormalTurnTracker {
  constructor({ onAlert, graceMs = ABNORMAL_FAILURE_GRACE_MS, schedule = setTimeout, cancel = clearTimeout } = {}) {
    this._onAlert = typeof onAlert === "function" ? onAlert : () => {};
    this._graceMs = Math.max(0, Number(graceMs) || 0);
    this._schedule = schedule;
    this._cancel = cancel;
    this._states = new Map();
  }

  _get(sessionId) {
    const id = safeSessionId(sessionId);
    let state = this._states.get(id);
    if (!state) {
      state = {
        sessionId: id,
        retrying: false,
        alerted: false,
        healthAlerted: false,
        lastFailure: null,
        timer: null
      };
      this._states.set(id, state);
    }
    return state;
  }

  _clearTimer(state) {
    if (state.timer !== null) {
      this._cancel(state.timer);
      state.timer = null;
    }
  }

  _alert(state, detail) {
    if (state.alerted) return false;
    state.alerted = true;
    this._onAlert({ ...detail, sessionId: state.sessionId });
    return true;
  }

  /** 一条新的用户消息开始，开启新的异常提醒周期。 */
  beginUserTurn(sessionId) {
    const state = this._get(sessionId);
    this._clearTimer(state);
    state.retrying = false;
    state.alerted = false;
    state.healthAlerted = false;
    state.lastFailure = null;
  }

  /** 宿主开始自动重试，取消 turn_end(error) 的兜底计时。 */
  onRetryStart(sessionId) {
    const state = this._get(sessionId);
    state.retrying = true;
    this._clearTimer(state);
  }

  /** 记录失败回合；若宿主没有进入自动重试，宽限期后再兜底提醒。 */
  onTurnFailure(failure) {
    const state = this._get(failure?.sessionId);
    state.lastFailure = { ...failure };
    if (state.alerted || state.retrying || state.timer !== null) return false;

    state.timer = this._schedule(() => {
      state.timer = null;
      if (state.retrying || state.alerted) return;
      this._alert(state, {
        ...state.lastFailure,
        kind: "failure",
        source: "turn_failure"
      });
    }, this._graceMs);
    return true;
  }

  /** 正常最终回合到达时，取消 provider error 的兜底计时。 */
  onTurnSuccess(sessionId) {
    const state = this._get(sessionId);
    this._clearTimer(state);
    state.retrying = false;
    state.lastFailure = null;
  }

  /** 自动重试结束：成功不提醒，耗尽才提醒；主动取消不提醒。 */
  onRetryEnd(result) {
    const state = this._get(result?.sessionId);
    this._clearTimer(state);
    state.retrying = false;

    if (result?.success === true) {
      state.lastFailure = null;
      return false;
    }
    if (isRetryCancelled(result?.finalError)) {
      state.lastFailure = null;
      return false;
    }
    if (state.alerted) return false;

    return this._alert(state, {
      ...state.lastFailure,
      ...result,
      kind: "failure",
      source: "retry_exhausted"
    });
  }

  /** 会话恢复时发现历史连续失败：同一周期只提醒一次。 */
  onSessionUnhealthy(warning) {
    const state = this._get(warning?.sessionId);
    if (state.healthAlerted) return false;
    state.healthAlerted = true;
    this._onAlert({
      ...warning,
      sessionId: state.sessionId,
      kind: "unhealthy",
      source: "session_unhealthy"
    });
    return true;
  }

  /** 测试/卸载用：立即执行指定会话的兜底计时。生产逻辑不调用它。 */
  flush(sessionId) {
    const state = this._states.get(safeSessionId(sessionId));
    if (!state || state.timer === null) return false;
    this._clearTimer(state);
    if (state.retrying || state.alerted || !state.lastFailure) return false;
    return this._alert(state, {
      ...state.lastFailure,
      kind: "failure",
      source: "turn_failure"
    });
  }

  dispose() {
    for (const state of this._states.values()) this._clearTimer(state);
    this._states.clear();
  }
}
