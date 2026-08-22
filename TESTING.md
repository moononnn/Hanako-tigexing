# 提个醒 · 测试说明

## 命令

```bash
# 语法检查
node --check index.js
node --check lib/policy.js
node --check lib/config.js
node --check lib/event-parse.js
node --check lib/activity-notify.js
node --check lib/toast.js
node --check routes/api.js
node --check tests/toast-duration.test.js
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
| tests/event-parse.test.js | turn_end / activity_update / provider error / auto retry / session abort 解析（最终回合判定 / mood 清洗 / 文本提取 / 活动 sessionFile） |
| tests/abnormal-copy.test.js | 异常回合文案归纳、部分回复内容保留、主动取消过滤、会话不健康提示 |
| tests/abnormal-state.test.js | 自动重试开始/成功/耗尽、失败兜底宽限期、正常回合清除、会话级去重 |
| tests/activity-notify.test.js | 计划任务通知去重：路径分隔符兼容、空路径保护、TTL 清理、活动路径键 |
| tests/agent-avatar.test.js | 助手头像解析（png>jpg>jpeg>webp） |
| tests/sounds.test.js | 音效目录、白名单过滤、防路径穿越 |
| tests/agents.test.js | 磁盘扫描助手列表（id + config.yaml name） |
| tests/support-entry.test.js | 检查更新 / 反馈积木的页面落点、路由注册、Response 凭证适配、全新纯色圆角弹窗外壳、未配置仓库降级 |
| tests/toast-duration.test.js | 系统通知时长设置页、Node → PowerShell 环境变量、WinRT toast duration 属性接线 |
| lib/update-checker/tests/update-checker.test.js | 版本比较、GitHub release 响应、缓存与网络异常降级 |
| lib/feedback/tests/feedback.test.js | 环境信息、反馈多轮会话、单条消息长度限制、issue 草稿解析、预填页、模型失败降级 |

> 注：v0.2.0 删「通知历史」（页面/API/存储全移除）；v0.3.0 删「重要关键词」功能（策略/配置/页面全移除）。检查更新仓库通过 `TIGEXING_GITHUB_REPO` 注入；未配置时页面明确提示，不伪造地址。

## 高回归风险点

- 合并窗口时间边界（毫秒级判断，滑动窗口语义）
- 跨窗口隔离（sessionId 作为 key）
- 计划任务接管开关与宿主 notification/activity_update 事件时序去重
- 异常回合状态迁移（provider error → auto retry → retry exhausted / success）与提醒去重
- 超时/强制释放的 aborted 事件过滤，避免把用户主动停止报成故障
- 配置刷新后 Notifier 合并状态保留
- 系统通知时长配置只允许 default / long，并完整传到 WinRT toast

## 实机验证清单（重启 Hana 后）

1. 打开插件抽屉，确认「提个醒」页面渲染正常
2. 确认「接管计划任务提醒」「开启润色」「静默时段」三个开关可用鼠标和键盘操作，状态反馈清楚
3. 点提醒时机各档位，确认选中态切换 + 已保存提示
4. 关闭「接管计划任务提醒」，确认普通计划任务完成时不再由提个醒补弹；重新打开后恢复
5. 正常对话等一条回复完成，确认自动弹「XX 回你了」
6. 同一窗口快速连发两条（30 秒内），确认第二条不弹、30 秒后补弹合并条
7. 用一个会调用小花桌面通知功能的计划任务实测，确认只出现任务自己的通知，不再出现提个醒的重复完成提醒
8. 开发验证时临时打开 Hana 原版计划任务通知，运行一个不主动通知的任务，确认等待片刻后只出现一条完成提醒
9. 改静默时段为当前时间附近，发消息验证不弹，并确认保存反馈出现
10. 修改助手通知风格和音效，确认保存与试听反馈正常，并确认「看看效果」按钮留在个性化卡片内、不发生横向溢出
11. 打开页面底部「关于提个醒」，确认「检查更新」和「反馈」并排、没有打断设置节奏
12. 未配置公开仓库时点「检查更新」，确认显示友好提示而不是报错
13. 点「反馈」，确认聊天窗能打开；模型可用时聊出 issue 草稿，点击「复制文案」可粘贴到 GitHub Issues
14. 公开仓库确定后设置 `TIGEXING_GITHUB_REPO=owner/repo`，点「检查更新」验证最新版本 / 新版本 / 网络失败三态
15. 开发验证模型中转失败：确认自动重试期间不重复弹，重试耗尽后只弹一条异常通知
16. 确认异常通知标题带会话标题、正文保留已收到的部分内容，默认显示「说“继续”再试」文案
17. 打开「开启润色」后复测异常通知：模型润色成功显示润色文案，润色失败仍回退规则版，不出现空弹窗
18. 触发/模拟 `turn_stall_timeout`：确认提醒；点击主动停止或关闭会话：确认不把主动操作报成故障
