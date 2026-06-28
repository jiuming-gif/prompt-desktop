# 豆包截图 v1：复用 html2canvas 管线

## 背景

v3 已将截图管线统一为 html2canvas（零 DOM 写入、零坐标转换、零跨进程 debugger）。当前仅 Kimi 启用截图，豆包截图被注释掉。本设计为豆包适配同一管线。

## 核心差异：豆包 DOM vs Kimi DOM

| | Kimi | 豆包 |
|---|---|---|
| 消息标识 | `.chat-content-item-user` / `.chat-content-item-assistant` 两类 CSS 类 | `data-message-id` 属性，用户/AI 共用 |
| 用户/AI 区分 | CSS 选择器级别区分 | class 中 `justify-end`（用户）vs 无（AI），需 JS 判断 |
| 消息包裹 | `data-message-id` 属性可选 | `data-message-id` 在消息根元素上 |
| 聊天容器 | `.chat-content-list` | `[class*="message-list"]`（CSS module 类名 `message-list-zLoNs1`） |

## 方案：`allMsg` 路径 + 修复对齐检测 bug

### SITE 配置

```js
doubao: {
  allMsg: ['[data-message-id]'],
  chatContainer: [
    '[class*="message-list"]',
    'main',
  ],
  stopTexts: ['停止生成', 'AI 生成中'],
},
```

- `allMsg`：单一选择器匹配所有消息，JS 区分用户/AI
- `[data-message-id]`：语义属性，比 CSS module 类名稳定
- `chatContainer`：`[class*="message-list"]` 匹配 CSS module 类名

### Bug fix 1：对齐检测遍历起点

现有 `allMsg` 路径（renderer.js line 195）从 `parentElement` 开始遍历：

```js
var p = el.parentElement;  // bug：跳过元素自身
```

豆包的 `justify-end` 在 `[data-message-id]` 元素自身上。修法：从 `el` 自身开始：

```js
var p = el;
```

### Bug fix 2：AI 消息无对齐标记的兜底

诊断数据显示豆包 AI 消息 class 为 `relative grid w-full grid-cols-[minmax(0,1fr)_auto]`，既无 `justify-end` 也无 `justify-start`。当前 while 循环只认这两个对齐类，AI 消息遍历到 body 都不会命中 → `found` 保持 false → 消息被丢弃。

修法：while 循环结束后，未命中任何对齐标记的默认当 AI（用户消息有明确 `justify-end` 特征，不匹配的大概率是 AI）：

```js
if (!found) { isUser = false; found = true; }
```

完整对齐检测逻辑：

```js
var p = el;
var found = false;
while (p && p !== document.body) {
  var pCls = p.className;
  if (typeof pCls === 'string') {
    if (/\bjustify-end\b/.test(pCls)) { isUser = true; found = true; break; }
    if (/\bjustify-start\b/.test(pCls)) { isUser = false; found = true; break; }
  }
  p = p.parentElement;
}
if (!found) { isUser = false; found = true; }
```

### 事件流

```
sendPrompt()
  ├─ watchReplyDone(kimi, ...)    // 已有
  └─ watchReplyDone(doubao, ...)  // 新增

captureAll()（手动截图按钮）
  ├─ captureLatestQA(kimi, ...)    // 已有
  └─ captureLatestQA(doubao, ...)  // 新增
```

`getSiteKey()`、`injectScreenshotJS()`、`pollShotResult()`、`SITE` 配置等基础设施已是站点无关的通用函数，不需改动。

### 其他复用

- **回复完成检测**：`watchReplyDone()` 通用逻辑，豆包自动受益（MutationObserver + 3s 安静期 + 文字稳定 + 120s 超时）
- **裁剪逻辑**：`upgradeToWrapper()` 已认 `data-message-id`，裁剪到最新 user+AI 包围盒
- **操作按钮扩展**：AI 消息后紧跟的操作按钮（点赞/复制）在 `data-message-id` 外，裁剪逻辑已处理
- **html2canvas 容错**：超大容器降 scale（`scrollHeight > 6000`）、15s 超时、`addColorStop` 补丁、跨域图片 `allowTaint`

## 边界情况

| 场景 | 处理 |
|------|------|
| `allMsg` 选择器全失效 | Layer 2 兜底：`[class*="message-list"]` → `main` → `body` |
| AI 消息无 `justify-start` 标记 | 遍历完未命中任何对齐类 → 默认标记为 AI（`isUser=false, found=true`） |
| 只有用户消息没 AI | `commonAncestor(lastUser, null)` 返回 lastUser，截用户区域 |
| 只有 AI 没用户 | 反向同理 |
| 120s 超时无内容 | 放弃截图，不写文件 |
| 120s 超时有内容 | 强制截图 |

## 改动文件

| 文件 | 改动 |
|------|------|
| `renderer.js` | 1. SITE 对象加 `doubao` 配置；2. `allMsg` 路径修遍历起点 + AI 无对齐标记兜底；3. `captureAll()` 加 doubao 调用；4. `sendPrompt()` 加 `watchReplyDone(doubao, ...)` |

不改 `main.js`、`index.html`、`style.css`、`package.json`。

## 验证

1. `npm start` 启动，三个 webview 正常加载
2. 输入 prompt "Python 完整入门介绍"，发送
3. 等待豆包回复完成
4. 检查 `screenshots/<timestamp>/doubao.png`：包含完整用户问题 + AI 回复，无截断，无导航/侧栏杂项
5. 点手动截图按钮，豆包也正常出图
6. Console 输出 `doubao 截图已保存: ...`
