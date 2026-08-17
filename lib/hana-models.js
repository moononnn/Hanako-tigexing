// 提个醒 · Hana 文本模型列表（供「文案润色」hana 档选择）
// 只读 Hana 的 models.json（用户主动配置过的模型），过滤文本模型，不碰任何密钥。
// 参考表情包插件 lib/shared.js 的同类实现。

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

/** 列出 Hana 已配置的文本模型（按 provider 分组） */
export function listHanaTextModels() {
  const result = [];
  try {
    const file = path.join(HANA_HOME, "models.json");
    if (!fs.existsSync(file)) return result;
    const catalog = JSON.parse(fs.readFileSync(file, "utf-8"));
    for (const [pid, provider] of Object.entries(catalog.providers || {})) {
      const models = (provider.models || []).filter((m) => {
        const input = Array.isArray(m.input) ? m.input : [];
        return input.includes("text") || input.includes("chat");
      });
      if (!models.length) continue;
      result.push({
        providerId: pid,
        providerName: provider.name || pid,
        models: models.map((m) => ({ id: m.id, name: m.name || m.id }))
      });
    }
  } catch {
    /* 读不到返回空列表，前端提示 */
  }
  return result;
}
