# 截图管线完整文档

> 基于 html2canvas 1.4.1，替代 CDP 截图方案。三个 webview (DeepSeek / Kimi / 豆包) 共用同一管线，仅 CSS 选择器不同。

## 架构概览

```
用户输入 → injectPrompt (webview内填文字+发送)
         → watchReplyDone (MutationObserver + 轮询检测回复完成)
         → captureLatestQA
              ├── injectScreenshotJS (定位 user/AI → 渲染容器 → canvas 裁剪到 QA 包围盒)
              └── pollShotResult (轮询 → 拿到 dataURL → IPC 发 main)
                   └── main.js 收 screenshot-data → 解码 base64 → 写 PNG
```

## 两个触发路径

### 路径 A：发送 prompt 后自动截图

1. 用户输入文字 → 点"发送"或按 Enter
2. `sendPrompt(prompt)` 向三个 webview 注入 prompt
3. `newScreenshotFolder()` 创建时间戳文件夹
4. `watchReplyDone()` 启动回复完成检测
5. 检测到完成 → 等 1s → `captureLatestQA()`

### 路径 B：手动点"截图"按钮

`captureAll()` — 立即对三个 webview 截图，不等回复。

---

## 详细流程

### 1. 注入 Prompt (`injectPrompt`, renderer.js:105)

通过 `webview.executeJavaScript` 在目标页面内执行：

1. 找输入框：`[contenteditable="true"]` → `textarea` → `input[type="text"]`
2. 填入文字：
   - contenteditable: `document.execCommand('insertText', ...)`
   - textarea/input: 原生 `HTMLTextAreaElement.prototype.value` setter + `dispatchEvent('input')`
3. 300ms 后触发 `Enter` keydown/keypress/keyup
4. 点击发送按钮：匹配 `[class*="send"]` 或 `[aria-label*="发送"]` 或含 SVG 的 button

Prompt 使用 `JSON.stringify()` 注入，安全处理 `${}` 等特殊字符。

### 2. 回复完成检测 (`watchReplyDone`, renderer.js:335)

**webview 内 MutationObserver：**

```
找聊天容器 → MutationObserver 监听 childList/subtree/characterData
  ├── 任何 DOM 变化 → 重置 3s 定时器
  ├── 3s 无新变化 → __replyDone = true
  └── 120s 超时 → __replyDone = true + __replyTimedOut = true
```

**渲染进程每 2s 轮询：**

```
查询: { done, timedOut, seenContent, textLen }
触发条件（满足任一）:
  A. done=true && 文字长度连续2次不变 && 长度>0
  B. timedOut=true && textLen>0
硬超时: 130s (65次 × 2s)
```

### 3. 元素定位 (`injectScreenshotJS`, renderer.js:196)

在 webview 内执行，注入 html2canvas UMD 源码 (~700KB) + 定位脚本。

**Layer 1 — 精确（两层兜底）：**

```
按优先级遍历 userMsg 选择器 → querySelectorAll
  取最后一个元素 = lastUser

按优先级遍历 aiMsg 选择器 → querySelectorAll
  取最后一个元素 = lastAI

如果 lastUser && lastAI 都存在:
  commonAncestor(lastUser, lastAI)
    → 从 lastUser 往上走 parentElement
    → 找到包含 lastAI 的共同祖先
```

`commonAncestor` 逻辑：
```js
function commonAncestor(a, b) {
  var el = a;
  while (el) {
    if (el.contains(b)) return el;
    el = el.parentElement;
  }
  return a;  // 兜底
}
```

**Layer 1 结果处理：裁剪到最新 QA 包围盒**

```
lastUser && lastAI 同时存在时:
  1. 渲染 chatContainer 全量到 canvas (html2canvas, scale:2)
  2. 取 lastUser.getBoundingClientRect() 和 lastAI.getBoundingClientRect()
  3. 计算相对于 container 的包围盒:
     relTop = min(ur.top, ar.top) - cr.top
     relBottom = max(ur.bottom, ar.bottom) - cr.top
     relLeft = 0 (容器全宽，避免截断代码块)
     relRight = cr.width
  4. 创建新 crop canvas，ctx.drawImage 裁剪
  5. crop canvas → toDataURL('image/png')

只有一方匹配或都不匹配:
  全容器截图（兜底）
```

**Layer 2 — 兜底（Layer 1 未同时找到 user 和 AI）：**

```
按优先级遍历 chatContainer 选择器 → 第一个命中的
  → 都没有 → document.querySelector('main')
  → 都没有 → document.body
```

### 4. html2canvas 渲染

```js
html2canvas(container, {
  scale: 2,              // 2x 高清
  useCORS: true,         // 处理跨域图片（头像）
  allowTaint: true,      // 允许污染 canvas（跨域图）
  backgroundColor: '#ffffff',
  logging: false,
})
.then(canvas => {
  window.__shotResult = canvas.toDataURL('image/png');
})
```

**为什么 `allowTaint: true`：** 三个 AI 站点的头像图片是跨域资源。不设此项 html2canvas 会因 canvas 被污染而拒绝导出。

### 5. 结果轮询 (`pollShotResult`, renderer.js:279)

```
首轮延迟 200ms（等 html2canvas 开始渲染）
  → 查 window.__shotResult
  → 有值 → 清理 window.__shotResult → 解析
  → 无值 → 500ms 后重试
  → 30s 超时
```

解析结果：
- `data:image/png;base64,...` → IPC 发 `screenshot-data`
- `{ error: "..." }` → `console.warn`
- 其他 → `console.warn` 未知结果

### 6. IPC → main 进程写文件

**renderer 发送：**
```
ipcRenderer.send('screenshot-data', {
  folder: '20260628_143025',
  name: 'kimi',
  dataURL: 'data:image/png;base64,iVBORw0KGgo...'
})
```

**main 接收 (main.js:35)：**
```js
ipcMain.on('screenshot-data', (event, { folder, name, dataURL }) => {
  // 校验 dataURL 必须以 'data:image/png;base64,' 开头
  if (!valid) → event.reply('screenshot-error', ...)

  mkdir screenshots/<folder>/
  解码 base64 → Buffer
  fs.writeFileSync → screenshots/<folder>/<name>.png

  event.reply('screenshot-ok', { name, filepath })
  // 或 event.reply('screenshot-error', { name, error })
})
```

### 7. 渲染进程确认

```js
ipcRenderer.on('screenshot-ok', (event, { name, filepath }) => {
  console.log(`${name} 截图已保存: ${filepath}`);
});

ipcRenderer.on('screenshot-error', (event, { name, error }) => {
  console.error(`${name} 截图失败: ${error}`);
});
```

---

## 文件命名

- 文件夹：`screenshots/YYYYMMDD_hhmmss/`（如 `20260628_143025`）
- 文件名：`deepseek.png` / `kimi.png` / `doubao.png`
- `.gitignore` 中已排除 `screenshots/`

---

## 站点选择器配置

### DeepSeek (`chat.deepseek.com`)

| 用途 | 选择器 |
|------|--------|
| 用户消息 | `[class*="user-message"]` → `[data-author="user"]` → `[class*="ds-message-user"]` |
| AI 消息 | `[class*="ds-assistant-message"]` → `[class*="assistant-message"]` → `[data-author="assistant"]` |
| 聊天容器 | `[class*="ds-scroll-area"]` → `main` |

### Kimi (`www.kimi.com`)

| 用途 | 选择器 |
|------|--------|
| 用户消息 | `.chat-content-item-user` → `[class*="user-content"]` |
| AI 消息 | `.chat-content-item-assistant` → `[class*="assistant-content"]` |
| 聊天容器 | `.chat-content-list` → `[class*="chat-content-list"]` → `main` |

### 豆包 (`www.doubao.com`)

| 用途 | 选择器 |
|------|--------|
| 用户消息 | `[class*="user-message"]` → `[class*="user-bubble"]` → `[data-role="user"]` → `[data-author="user"]` |
| AI 消息 | `[class*="assistant-message"]` → `[class*="assistant-bubble"]` → `[data-role="assistant"]` → `[data-author="assistant"]` |
| 聊天容器 | `[class*="overflow-y-auto"]` → `[class*="scroll"]` → `main` |

---

## 约束条件

- **零 DOM 修改** — 全部只读 `querySelector`/`querySelectorAll`
- `contextIsolation: false` + `nodeIntegration: true`（renderer 可读 `fs`、`path`）
- html2canvas 从 `node_modules/html2canvas/dist/html2canvas.min.js` 读入内存
- 每次截图注入完整 html2canvas UMD ~700KB（当前未做缓存优化）
- `allowTaint: true` 处理跨域头像，副作用是 canvas 被标记为污染（不影响 PNG 导出）
- 截图范围：最新一条用户问题 + 最新一条 AI 回复的包围盒裁剪（canvas crop）

## 超时汇总

| 阶段 | 超时 |
|------|------|
| html2canvas 渲染 | 30s（pollShotResult） |
| 回复检测轮询 | 130s（65 次 × 2s） |
| 回复 MutationObserver | 120s（webview 内硬超时） |
| MutationObserver 静默 | 3s（无 DOM 变化视为完成） |
| 文字稳定确认 | 连续 2 次轮询（4s）不变 |

## 错误恢复

- `did-fail-load`：errorCode ≠ -3 时打日志（-3 是用户取消导航，忽略）
- `crashed`：自动 `webview.reload()`
- `console-message`：level ≥ 2（warn/error）转发到渲染进程日志
- 截图失败：`screenshot-error` IPC 通知，不打乱其他 webview 的截图
