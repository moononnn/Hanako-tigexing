// 提个醒 · 窗口焦点查询
// 判断 HanaAgent 主窗口是否为系统前台窗口（对应原版通知的 whenUnfocused 档位）
// 实现：PowerShell + user32 GetForegroundWindow，查前台进程名
import { spawn } from "node:child_process";

const PS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TxsFw {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [TxsFw]::GetForegroundWindow()
$p = 0
[TxsFw]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
(Get-Process -Id $p -ErrorAction SilentlyContinue).Name
`;

// 结果缓存：焦点状态短时间不会变，避免每个事件都 spawn
const CACHE_TTL_MS = 800;
let cache = { t: 0, focused: null };

/**
 * HanaAgent 主窗口当前是否为系统前台窗口。
 * @returns {Promise<boolean>} 查询失败时保守返回 false（不阻断提醒）
 */
export function isHanaFocused() {
  const now = Date.now();
  if (cache.focused !== null && now - cache.t < CACHE_TTL_MS) {
    return Promise.resolve(cache.focused);
  }
  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-Command", PS_SCRIPT],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("close", () => {
      const name = out.trim();
      const focused = name === "HanaAgent";
      cache = { t: Date.now(), focused };
      resolve(focused);
    });
    child.on("error", () => {
      cache = { t: Date.now(), focused: false };
      resolve(false);
    });
  });
}
