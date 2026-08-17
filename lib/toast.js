// 提个醒 · 弹窗核心
// Node 侧 spawn PowerShell 跑 notify.ps1，标题/正文走环境变量，无注入风险。
// 方案源自歇一会插件（生产验证过），零外部依赖（Windows 自带 PowerShell）。

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const KILL_AFTER_MS = 20000;

/**
 * 发一条 Windows toast。
 * @param {object} opts
 * @param {string} opts.pluginDir 插件源码目录（找 lib/notify.ps1）
 * @param {string} opts.title 通知标题
 * @param {string} opts.message 通知正文
 * @param {string} [opts.style] 通知样式：icon（默认，带头像）/ plain（纯文本）
 * @param {string} [opts.icon] 头像图片绝对路径（助手头像），缺省用插件图标
 * @param {string} [opts.sound] 音效："silent"=静音 / 绝对路径 wav 等音频 / 缺省用系统默认通知音
 * @param {object} [opts.log] ctx.log，可选
 * @returns {boolean} 是否成功发起
 */
export function sendToast({ pluginDir, title, message, style, icon, sound, log }) {
  const ps1 = path.join(pluginDir, "lib", "notify.ps1");
  if (!fs.existsSync(ps1)) {
    log?.error?.("[提个醒] notify.ps1 不存在", { ps1 });
    return false;
  }

  const env = {
    ...process.env,
    TXS_TITLE: String(title),
    TXS_MSG: String(message),
    TXS_STYLE: style === "plain" ? "plain" : "icon",
    TXS_ICON: icon ? String(icon) : "",
    TXS_SOUND: sound ? String(sound) : ""
  };

  let child;
  try {
    child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", ps1],
      { env, stdio: "ignore", windowsHide: true }
    );
  } catch (err) {
    log?.error?.("[提个醒] 启动 powershell 失败", { error: err.message });
    return false;
  }

  // 兜底：20 秒没退出就杀掉，防止僵尸进程
  const killer = setTimeout(() => {
    try { child.kill(); } catch { /* 已退出 */ }
  }, KILL_AFTER_MS);
  killer.unref?.();

  child.on("error", (err) => {
    log?.error?.("[提个醒] 通知进程出错", { error: err.message });
  });
  child.on("exit", () => clearTimeout(killer));

  return true;
}
