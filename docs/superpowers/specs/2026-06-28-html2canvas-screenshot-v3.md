# 截图方案 v3：html2canvas 替换 CDP 管线

## 问题

v2 (CDP + modern-screenshot 两阶段) 三个月内反复出 bug：

- **Kimi 白屏**：`computeClip` 注入 CSS 修改（隐藏侧栏 + 展开滚动容器）破坏页面布局，cleanup 在错误路径未执行
- **豆包无文件**：截图静默失败，无报错
- **DeepSeek 截不全**：坐标转换偏差 + 视口高度不够，内容截断
- **站点改版即挂**：硬编码选择器，Kimi K2.6 更新后失效

本质：CDP 截图管线要求 **注入CSS → 算坐标 → 跨IPC截图 → 清理CSS**，链长 7 步，任意环节失败即全军覆没。

## 方案

**html2canvas 一步到位**：在 webview 内定位最新问答元素 → html2canvas 渲染为 canvas → toDataURL 导出 base64 → IPC 写文件。

零 DOM 写入，零坐标转换，零跨 IPC debugger 操作。

### 与 v2 对比

| | v2 (CDP) | v3 (html2canvas) |
|---|---|---|
| DOM 修改 | CSS 注入 + 滚动展开 + 还原 | 无 |
| 坐标系统 | 视口→文档转换，易出错 | 不需要（canvas = 元素像素） |
| 跨进程通信 | 3次（computeClip→IPC→screenshot→IPC→cleanup） | 1次（base64→IPC→写文件） |
| 截图完整性 | 依赖视口高度 + captureBeyondViewport | 元素完整渲染，不受视口限制 |
| 站点适配 | 选择器失效即白屏 | 有 2 层兜底 |
| 页面破坏风险 | 高（CSS 修改残留） | 零 |

## 架构

```
sendPrompt()
  └→ watchReplyDone()          每个 webview 独立监听
       └→ MutationObserver       检测 DOM 变化
            ├─ 3s 安静期
            ├─ 文字长度稳定（连续 2 次轮询不变）
            └─ 或 120s 超时
                 └→ captureLatestQA(webview)
                      └→ webview.executeJavaScript(   ← 唯一一次注入
                           1. 定位最新 user+AI 消息元素
                           2. html2canvas(el) 渲染
                           3. canvas.toDataURL() → base64
                         )
                         └→ IPC 'screenshot-data' → main
                              └→ Buffer.from(base64) → fs.writeFileSync
```

## html2canvas 加载

html2canvas 通过 npm 安装：`npm install html2canvas`，用 node_modules 里的 UMD 压缩包（~45KB）。

**注入链**：

```
renderer.js (nodeIntegration: true)
  └→ fs.readFileSync('node_modules/html2canvas/dist/html2canvas.min.js', 'utf-8')
       └→ 拼接到 screenshot JS 字符串
            └→ webview.executeJavaScript(html2canvasCode + screenshotLogic)
```

html2canvas 是 UMD bundle，注入后挂到 `window.html2canvas`，后续截图逻辑直接用。

renderer 进程有 nodeIntegration，可读本地文件。html2canvas 是 UMD bundle，注入后挂到 `window.html2canvas`，后续截图逻辑直接用。

避免 CDN 网络不可达、ESM import 在 sandbox webview 不兼容的问题。

### 截图执行（webview 内）

html2canvas 返回 Promise，executeJavaScript 不能直接 await。webview 内采用结果写入全局变量 + renderer 轮询：

```js
// 注入到 webview
`
${html2canvasCode}

(function() {
  var C = ${JSON.stringify(siteConfig)};
  
  // ... 定位 targetEl ...
  
  if (!targetEl) {
    window.__shotResult = JSON.stringify({ error: 'no element found' });
    return;
  }
  
  window.html2canvas(targetEl, {
    scale: 2,
    useCORS: true,
    allowTaint: true,
    backgroundColor: '#ffffff',
    logging: false,
  }).then(function(canvas) {
    window.__shotResult = canvas.toDataURL('image/png');
  }).catch(function(err) {
    window.__shotResult = JSON.stringify({ error: err.message });
  });
})();
`

// renderer 轮询 (最多等 30s)
poll(() => webview.executeJavaScript('window.__shotResult'))
  .then(result => {
    webview.executeJavaScript('delete window.__shotResult;');
    if (result.startsWith('data:image/png;base64,')) {
      ipcRenderer.send('screenshot-data', { folder, name, dataURL: result });
    }
  });
```

html2canvas 版本：1.4.1（稳定，~45KB gzip）。

## 元素定位

只读 querySelector，不修改任何 DOM。

### 站点选择器配置

```js
const SITE_SELECTORS = {
  deepseek: {
    userMsg: [
      '[class*="ds-markdown"]',           // 精确
    ],
    aiMsg: [
      '[class*="ds-markdown ds-assistant"]',
      '[class*="ds-assistant-message"]',
    ],
    chatContainer: [
      '[class*="ds-scroll-area"]',
      'main',
    ],
  },
  kimi: {
    userMsg: [
      '.chat-content-item-user',
      '[class*="user-content"]',
    ],
    aiMsg: [
      '.chat-content-item-assistant',
      '[class*="assistant-content"]',
    ],
    chatContainer: [
      '.chat-content-list',
      '[class*="chat-content-list"]',
      'main',
    ],
  },
  doubao: {
    userMsg: [
      '[class*="bg-g-send"]',
      '[class*="user-bubble"]',
    ],
    aiMsg: [
      '[class*="bg-g-receive"]',
      '[class*="ai-bubble"]',
    ],
    chatContainer: [
      '[class*="overflow-y-auto"][class*="flow-scrollbar"]',
      'main',
    ],
  },
};
```

### 定位策略（两层兜底）

```
Layer 1: 精确定位
  userEls = querySelectorAll(userMsg[i])
  aiEls = querySelectorAll(aiMsg[i])
  lastUser = userEls[userEls.length - 1]
  lastAI = aiEls[aiEls.length - 1]
  target = commonAncestor(lastUser, lastAI)

Layer 2: 模糊兜底（Layer 1 未命中）
  target = querySelector(chatContainer[i]) || document.querySelector('main') || document.body
```

### 公共祖先算法

```js
function commonAncestor(a, b) {
  if (!a || !b) return a || b;
  let el = a;
  while (el) {
    if (el.contains(b)) return el;
    el = el.parentElement;
  }
  return a;
}
```

## 回复完成检测

### 检测流程

```
注入 MutationObserver 监听 chatContainer
  └→ 每次 mutation:
       ├─ 重置 3s 安静期计时器
       └─ 记录 hasSeenContent = true （内容出现过）
  
  独立轮询 (2s 间隔):
    └→ 检查三个条件:
         ├─ hasSeenContent === true         （确认有过输出）
         ├─ 连续 2 次 textContent.length 不变 （文字真正稳定）
         └─ 停止/生成中按钮不存在           （站点特定）
         └─ 全部满足 → 截图
         
  120s 超时兜底:
    └─ 有内容 → 截图；没内容 → 放弃
```

### 停止按钮检测

| 站点 | 检测文本 |
|------|---------|
| DeepSeek | "停止生成", "Stop generating" |
| Kimi | "停止生成", "Stop" |
| 豆包 | "停止生成", "AI 生成中" |

停止按钮存在 → 还在生成。按钮消失 → 生成完毕。

## html2canvas 配置

```js
const canvas = await html2canvas(targetEl, {
  scale: 2,             // 2x 高清
  useCORS: true,        // 处理跨域图片
  allowTaint: true,     // 允许非 CORS 图片（头像等）
  backgroundColor: '#ffffff',
  logging: false,
});
```

`allowTaint: true` + `canvas.toDataURL('image/png')` 可以在 canvas 被跨域图片 taint 后仍导出。不用 `toBlob()`——tainted canvas 上 toBlob() 直接抛异常。

## IPC 通道

删掉旧的 `screenshot-capture` / `screenshot-finished` / `screenshot-failed` 三个通道，换成两个：

```
renderer → main:
  'screenshot-data': { folder, name, dataURL: 'data:image/png;base64,...' }

main 处理:
  1. dataURL.replace('data:image/png;base64,', '')
  2. Buffer.from(base64, 'base64')
  3. mkdirSync + writeFileSync
  4. event.reply('screenshot-ok', { name, filepath })

renderer ← main:
  'screenshot-ok': { name, filepath }
  → console.log 日志
```

## 删除的代码

| 文件 | 删除内容 |
|------|---------|
| `renderer.js` | `computeClip()`、`cleanupShotCSS()`、`captureWebview()` 旧版、`CLEANUP_CSS` 常量、scroll 展开/还原逻辑、`screenshot-finished/failed` 事件监听、`captureAll()` 旧版、`SITE_CANDIDATES` 旧结构 |
| `main.js` | `captureWithCDP()`、`captureWithModernScreenshot()`、`screenshot-capture` IPC handler、`screenshot-finished/failed` 事件发送 |

## 文件存储

保持不变：
```
screenshots/
  └── 20260628_193000/
      ├── deepseek.png
      ├── kimi.png
      └── doubao.png
```

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `package.json` | 加 `html2canvas` 依赖 |
| `renderer.js` | 重写：选择器配置、回复检测、截图函数、读 html2canvas 注入、IPC 通道 |
| `main.js` | 删 CDP 代码，加 `screenshot-data` IPC handler |
| `index.html` | 删除 Kimi UA 属性（不再需要） |
| `style.css` | 无改动 |

## 验证

1. `npm start` 启动
2. 三个 webview 正常加载，无白屏
3. 输入 prompt "Python 完整入门介绍"，发送
4. 等待三个站回复完成
5. 检查 `screenshots/<timestamp>/`：
   - `deepseek.png` — 包含完整用户问题 + AI 回复，无截断
   - `kimi.png` — 同上
   - `doubao.png` — 同上
6. 点手动截图按钮，再验证一次
7. 检查 Console 无报错
