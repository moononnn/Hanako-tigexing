// 提个醒 · 对话框后台任务追踪
// 只记录某个对话框当前仍在运行的后台任务（如子 agent），不发送通知。

export class BackgroundTaskTracker {
  constructor() {
    this._tasks = new Map(); // sessionId -> Set(taskId)
  }

  update(task) {
    const sessionId = String(task?.sessionId || "").trim();
    const taskId = String(task?.taskId || "").trim();
    if (!sessionId || !taskId) return false;

    let tasks = this._tasks.get(sessionId);
    if (task.action === "upsert") {
      const terminal = new Set(["completed", "failed", "canceled", "aborted"]);
      if (terminal.has(String(task.status || "").toLowerCase())) {
        if (!tasks) return true;
        tasks.delete(taskId);
        if (!tasks.size) this._tasks.delete(sessionId);
        return true;
      }
      if (!tasks) {
        tasks = new Set();
        this._tasks.set(sessionId, tasks);
      }
      tasks.add(taskId);
      return true;
    }
    if (task.action === "remove") {
      if (!tasks) return false;
      tasks.delete(taskId);
      if (!tasks.size) this._tasks.delete(sessionId);
      return true;
    }
    return false;
  }

  has(sessionId) {
    const tasks = this._tasks.get(String(sessionId || "").trim());
    return Boolean(tasks?.size);
  }

  count(sessionId) {
    return this._tasks.get(String(sessionId || "").trim())?.size || 0;
  }

  clear() {
    this._tasks.clear();
  }
}
