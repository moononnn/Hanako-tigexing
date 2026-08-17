# 提个醒 · 测试说明

## 命令

```bash
# 语法检查
node --check lib/policy.js
node --check lib/config.js
node --check lib/toast.js
node --check routes/api.js
node --check tools/test-notify.js

# 单元测试（零依赖，node:test）
node --test tests/*.test.js
node --test lib/update-checker/tests/update-checker.test.js lib/feedback/tests/feedback.test.js
```

## 覆盖范围

| 文件 | 覆盖逻辑 |
|------|---------|
| tests/policy.test.js | 合并窗口（同窗口合并 / 跨窗口不合并 / 窗口滑动 / 过期重置 / flush 补弹与不补弹）、静默时段（跨午夜 / 不跨午夜 / 无效格式 / 开关关闭）、总开关、snippet 截断、标题组装 |
| tests/style.test.js | 八套通知风格（默认/简洁高效/活泼可爱/温柔贴心/摩斯电码/系统故障/锟斤拷/大厂黑话）的标题与正文格式（含会话标题前缀与截断）、未知风格回退、样式完整性 |
| tests/refine.test.js | 文案润色：refinable 标记、prompt 构建（风格指令/条数提示/snippet 裁剪）、JSON 解析与超长裁剪、模型失败抛错、成功拼会话前缀 |
| tests/session-title.test.js | 会话标题读取：sessionId/完整路径/文件名三种 key 匹配、路径分隔符归一化、损坏文件回退 |
| tests/event-parse.test.js | turn_end 解析（最终回合判定 / mood 清洗 / 文本提取） |
| tests/agent-avatar.test.js | 助手头像解析（png>jpg>jpeg>webp） |
| tests/sounds.test.js | 音效目录、白名单过滤、防路径穿越 |
| tests/agents.test.js | 磁盘扫描助手列表（id + config.yaml name） |
| tests/support-entry.test.js | 检查更新 / 反馈积木的页面落点、路由注册、Response 凭证适配、未配置仓库降级 |
| lib/update-checker/tests/update-checker.test.js | 版本比较、GitHub release 响应、缓存与网络异常降级 |
| lib/feedback/tests/feedback.test.js | 环境信息、反馈多轮会话、单条消息长度限制、issue 草稿解析、预填页、模型失败降级 |

> 注：v0.2.0 删「通知历史」（页面/API/存储全移除）；v0.3.0 删「重要关键词」功能（策略/配置/页面全移除）。检查更新仓库通过 `TIGEXING_GITHUB_REPO` 注入；未配置时页面明确提示，不伪造地址。

## 高回归风险点

- 合并窗口时间边界（毫秒级判断，滑动窗口语义）
- 跨窗口隔离（sessionId 作为 key）
- 重要消息重置窗口

## 实机验证清单（重启 Hana 后）

1. 打开插件抽屉，确认「提个醒」页面渲染正常
2. 点测试按钮，确认桌面右上角弹窗（标题「提个醒 · 测试通知」）
3. 点提醒时机四档，确认选中态切换 + 已保存提示
4. 正常对话等一条回复完成，确认自动弹「XX 回你了」
5. 同一窗口快速连发两条（30 秒内），确认第二条不弹、30 秒后补弹合并条
6. 改静默时段为当前时间附近，发消息验证不弹
7. 回复里带「报错」验证重要弹窗
8. 打开页面底部「关于提个醒」，确认「检查更新」和「反馈」并排、没有打断设置节奏
9. 未配置公开仓库时点「检查更新」，确认显示友好提示而不是报错
10. 点「反馈」，确认聊天窗能打开；模型可用时聊出 issue 草稿，点击「复制文案」可粘贴到 GitHub Issues
11. 公开仓库确定后设置 `TIGEXING_GITHUB_REPO=owner/repo`，点「检查更新」验证最新版本 / 新版本 / 网络失败三态
