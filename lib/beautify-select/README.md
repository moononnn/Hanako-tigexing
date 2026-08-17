# beautify-select · 手帐风自定义下拉组件

零依赖、服务端内联友好的自定义下拉组件，替换原生 `<select>` 的 Windows 系统默认下拉外观。

## 文件

| 文件 | 说明 |
|------|------|
| `beautify-select.js` | 组件（IIFE，挂 `window.beautifySelect`），零依赖 |
| `beautify-select.css` | 组件样式（CSS 变量驱动，不硬编码颜色） |

## 用法

1. 把两个文件拷进插件（如 `lib/beautify-select/`）；
2. 页面引入（Hana 插件页面建议服务端渲染时读文件内联，避免外部资源鉴权问题）：

```html
<style>/* beautify-select.css 内容 */</style>
<script>/* beautify-select.js 内容 */</script>
```

3. 对每个原生 select 调用一次（动态生成的 select 在插入 DOM 后调用）：

```js
beautifySelect(document.getElementById("my-select"));
// 或批量：
document.querySelectorAll("select").forEach(function (sel) { beautifySelect(sel); });
```

## 依赖的 CSS 变量（插件必须已定义）

| 变量 | 用途 |
|------|------|
| `--card` | 触发栏/面板底色（米白） |
| `--ink` | 正文色 |
| `--ink-soft` | 次要文字 |
| `--line` | 细边框色 |
| `--accent` | 主色（hover 边框、选中底） |
| `--accent-deep` | 深主色（选中文字、箭头） |
| `--accent-soft` | 浅主色（hover 底） |

可选覆盖（不覆盖用默认薄荷绿）：`--dd-ring`（展开光圈）、`--dd-shadow`（面板阴影）、`--dd-thumb` / `--dd-thumb-hover`（滚动条）。

## 行为细节

- **原生 select 保留为值和事件载体**（视觉隐藏）：点击选项后 `sel.dispatchEvent(new Event("change", { bubbles: true }))`，原有 change 监听照常工作；
- **面板与触发栏等宽**：面板 `position:absolute; left:0; right:0`，永远对齐触发栏，无宽度错位；
- **动态选项同步**：外部代码直接改 `select.innerHTML` / `select.value`（如异步拉取模型列表）时，MutationObserver 自动重建面板；
- **穿模防护**：展开时自动沿祖先链找最近的 `.card` 或 `[data-dd-lift]` 容器加 `.dd-open-card`（`position:relative; z-index:30`），收起时移除。适用于面板会溢出容器、容器 hover 带 transform 的场景（transform 会创建层叠上下文，把下层卡片内容抬到面板上面）；
- 长文本选项省略号 + hover 显示全名；点击外部 / Esc 收起；展开时自动收起其他已开的下拉。

## 参考实现

提个醒插件（`routes/api.js` 页面内联使用）。
