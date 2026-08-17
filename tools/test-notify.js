// 提个醒 · 测试弹窗工具
// 喊一声，小花就能弹一条测试通知验证链路。

import path from "node:path";
import { homedir } from "node:os";

import { sendToast } from "../lib/toast.js";

export const name = "test_notify";
export const description = "弹一条「提个醒」测试通知到桌面，验证通知链路是否正常。";
export const sessionPermission = { readOnly: true };
export const parameters = {
  type: "object",
  properties: {
    title: { type: "string", description: "通知标题，可省略" },
    message: { type: "string", description: "通知正文，可省略" }
  }
};

export async function execute(input = {}, ctx) {
  const userHome = process.env["HOME"] || process.env["USERPROFILE"] || homedir();
  const pluginDir = path.join(userHome, ".hanako", "plugins", ctx.pluginId);

  const title = input.title || "提个醒 · 测试通知";
  const message = input.message || "弹窗链路正常！回复完成时，就会这样提醒你。";

  const sent = sendToast({ pluginDir, title, message, log: ctx.log });
  return {
    content: [{ type: "text", text: sent ? "已弹出测试通知，看桌面右上角～" : "通知发送失败（见日志）" }]
  };
}
