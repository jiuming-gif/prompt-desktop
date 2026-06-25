# 三栏 AI 桌面端 - 项目计划

## 项目概述

做一个 Electron 桌面应用：底部共享输入框，上方三栏分别加载 DeepSeek、Kimi、豆包的网页版。输入 prompt 后自动注入三个网站的输入框并发送。

## 技术栈

- **框架**: Electron 33+
- **前端**: 原生 HTML/CSS/JS（不引入 React/Vue）
- **Node**: v18+

## 项目结构

```
D:\prompt_桌面版\
├── package.json
├── main.js                # Electron 主进程
├── index.html             # 主界面
├── style.css              # 样式
├── renderer.js            # 渲染进程逻辑
├── inject-deepseek.js     # DeepSeek 注入脚本
├── inject-kimi.js         # Kimi 注入脚本
├── inject-doubao.js       # 豆包注入脚本
└── .gitignore
```

## 界面布局

```
┌──────────────────────────────────────────────────┐
│  ┌──────────┐  │  ┌──────────┐  │  ┌──────────┐ │
│  │          │  │  │          │  │  │          │ │
│  │ DeepSeek │  │  │  Kimi    │  │  │  豆包    │ │
│  │          │拖│  │          │拖│  │          │ │
│  │ webview  │拽│  │ webview  │拽│  │ webview  │ │
│  │          │条│  │          │条│  │          │ │
│  │          │  │  │          │  │  │          │ │
│  └──────────┘  │  └──────────┘  │  └──────────┘ │
├──────────────────────────────────────────────────┤
│  [输入框................................] [发送]  │
└──────────────────────────────────────────────────┘
```

- 上方三栏：各占 1/3 宽度，中间有可拖拽分隔条
- 下方固定：输入框 + 发送按钮，高度固定约 60px
- 窗口默认大小：1400 x 900

## 详细实现

### 1. package.json

```json
{
  "name": "prompt-desktop",
  "version": "1.0.0",
  "description": "三栏 AI 桌面端",
  "main": "main.js",
  "scripts": {
    "start": "electron ."
  },
  "devDependencies": {
    "electron": "^33.0.0"
  }
}
```

### 2. main.js - 主进程

```javascript
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      webviewTag: true,           // 必须开启 webview 标签
      nodeIntegration: true,      // 渲染进程需要 node
      contextIsolation: false,    // 简化通信
    }
  });

  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
```

### 3. index.html - 主界面

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>三栏 AI 桌面端</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="container">
    <!-- 上方三栏区域 -->
    <div class="panels">
      <div class="panel" id="panel-1">
        <div class="panel-header">DeepSeek</div>
        <webview
          id="webview-deepseek"
          src="https://chat.deepseek.com"
          partition="persist:deepseek"
          allowpopups
        ></webview>
      </div>

      <div class="divider" id="divider-1"></div>

      <div class="panel" id="panel-2">
        <div class="panel-header">Kimi</div>
        <webview
          id="webview-kimi"
          src="https://kimi.moonshot.cn"
          partition="persist:kimi"
          allowpopups
        ></webview>
      </div>

      <div class="divider" id="divider-2"></div>

      <div class="panel" id="panel-3">
        <div class="panel-header">豆包</div>
        <webview
          id="webview-doubao"
          src="https://www.doubao.com"
          partition="persist:doubao"
          allowpopups
        ></webview>
      </div>
    </div>

    <!-- 下方输入框 -->
    <div class="input-bar">
      <textarea id="prompt-input" placeholder="输入 prompt，同时发送给三个 AI..." rows="2"></textarea>
      <button id="send-btn">发送</button>
    </div>
  </div>

  <script src="renderer.js"></script>
</body>
</html>
```

**关键点**：
- `partition="persist:xxx"` 使每个 webview 的 cookie 独立存储且持久化，重启不用重新登录
- `allowpopups` 允许弹窗（某些登录流程需要）

### 4. style.css - 样式

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body {
  height: 100%;
  overflow: hidden;
  font-family: -apple-system, "Microsoft YaHei", sans-serif;
  background: #1a1a2e;
  color: #e0e0e0;
}

.container {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* 上方三栏区域 */
.panels {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 200px;
}

.panel-header {
  height: 32px;
  line-height: 32px;
  text-align: center;
  background: #16213e;
  font-size: 13px;
  font-weight: 600;
  color: #7ec8e3;
  border-bottom: 1px solid #0f3460;
}

.panel webview {
  flex: 1;
  width: 100%;
}

/* 可拖拽分隔条 */
.divider {
  width: 6px;
  cursor: col-resize;
  background: #0f3460;
  transition: background 0.2s;
}

.divider:hover,
.divider.active {
  background: #7ec8e3;
}

/* 下方输入框 */
.input-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: #16213e;
  border-top: 1px solid #0f3460;
}

#prompt-input {
  flex: 1;
  resize: none;
  padding: 8px 12px;
  border: 1px solid #0f3460;
  border-radius: 8px;
  background: #1a1a2e;
  color: #e0e0e0;
  font-size: 14px;
  font-family: inherit;
  outline: none;
}

#prompt-input:focus {
  border-color: #7ec8e3;
}

#send-btn {
  padding: 8px 24px;
  background: #7ec8e3;
  color: #1a1a2e;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

#send-btn:hover {
  background: #a0e4f8;
}
```

### 5. renderer.js - 交互逻辑

```javascript
const deepseek = document.getElementById('webview-deepseek');
const kimi = document.getElementById('webview-kimi');
const doubao = document.getElementById('webview-doubao');
const input = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');

// ============ 发送逻辑 ============

function sendPrompt(prompt) {
  if (!prompt.trim()) return;

  // 通过 executeJavaScript 注入到每个 webview
  const webviews = [
    { webview: deepseek, injector: 'inject-deepseek.js' },
    { webview: kimi,     injector: 'inject-kimi.js' },
    { webview: doubao,   injector: 'inject-doubao.js' },
  ];

  webviews.forEach(({ webview }) => {
    // 等待 webview 加载完成再注入
    if (webview.isLoading()) {
      webview.addEventListener('did-stop-loading', () => {
        injectPrompt(webview, prompt);
      }, { once: true });
    } else {
      injectPrompt(webview, prompt);
    }
  });

  input.value = '';
}

function injectPrompt(webview, prompt) {
  // 转义特殊字符，防止 JS 注入
  const escaped = prompt.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

  const js = `
    (function() {
      const prompt = \`${escaped}\`;

      // 通用：找 contenteditable 或 textarea
      function findInput() {
        // 尝试 contenteditable
        let el = document.querySelector('[contenteditable="true"]');
        if (el) return { el, type: 'contenteditable' };

        // 尝试 textarea
        el = document.querySelector('textarea');
        if (el) return { el, type: 'textarea' };

        // 尝试 input
        el = document.querySelector('input[type="text"]');
        if (el) return { el, type: 'input' };

        return null;
      }

      function simulateInput(element, text) {
        element.focus();
        // 使用 execCommand 或 input 事件模拟输入
        if (element.isContentEditable) {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
        } else {
          // React/Vue 等框架需要触发原生事件
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(element, text);
          } else {
            element.value = text;
          }
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      function simulateEnter(element) {
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13,
          which: 13, bubbles: true
        });
        element.dispatchEvent(enterEvent);
      }

      const input = findInput();
      if (input) {
        simulateInput(input.el, prompt);
        // 延迟一点再按回车，确保输入已生效
        setTimeout(() => simulateEnter(input.el), 300);
      } else {
        console.warn('未找到输入框');
      }
    })();
  `;

  webview.executeJavaScript(js).catch(err => {
    console.error('注入失败:', err.message);
  });
}

// ============ 事件绑定 ============

sendBtn.addEventListener('click', () => sendPrompt(input.value));

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt(input.value);
  }
});

// ============ 拖拽分隔条 ============

const dividers = document.querySelectorAll('.divider');
const panels = document.querySelectorAll('.panel');

let isDragging = false;
let dragDivider = null;
let leftPanel = null;
let rightPanel = null;
let startX = 0;
let leftStartWidth = 0;
let rightStartWidth = 0;

dividers.forEach((divider, index) => {
  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragDivider = divider;
    leftPanel = panels[index];
    rightPanel = panels[index + 1];
    startX = e.clientX;
    leftStartWidth = leftPanel.offsetWidth;
    rightStartWidth = rightPanel.offsetWidth;
    divider.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;

  const dx = e.clientX - startX;
  const newLeftWidth = leftStartWidth + dx;
  const newRightWidth = rightStartWidth - dx;

  // 最小宽度限制
  if (newLeftWidth < 200 || newRightWidth < 200) return;

  leftPanel.style.flex = 'none';
  leftPanel.style.width = newLeftWidth + 'px';
  rightPanel.style.flex = 'none';
  rightPanel.style.width = newRightWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging = false;
  if (dragDivider) dragDivider.classList.remove('active');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});
```

### 6. 注入脚本说明

由于三个 AI 网站的 DOM 结构不同，`executeJavaScript` 方式比 preload 更灵活——不需要提前知道页面结构，注入时实时查找。

**三个网站输入框特征**（2024-2025 年验证，可能随版本变化需调整）：

| 网站 | 输入框类型 | 输入框定位 | 发送方式 |
|------|-----------|-----------|---------|
| DeepSeek | textarea | `textarea` (通常只有一个) | Enter 键 |
| Kimi | contenteditable div | `[contenteditable="true"]` | Enter 键或点击发送按钮 |
| 豆包 | contenteditable div | `[contenteditable="true"]` | Enter 键或点击发送按钮 |

**如果自动注入失败，备用方案**：
1. 用 Chrome DevTools 检查各网站输入框的实际 DOM 结构
2. 在 renderer.js 的 `injectPrompt` 函数中针对各网站写不同的选择器
3. 可通过 `webview.getURL()` 判断当前网站，走不同注入逻辑

## 安装和运行

```bash
cd D:\prompt_桌面版

# 如果 npm 下载 Electron 慢，设置国内镜像
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install

# 启动
npm start
```

## 核心难点和解决方案

### 难点 1：输入框注入对 React/Vue 框架无效

现代 AI 网站都用前端框架，直接设置 `value` 不会触发框架的数据绑定。

**解决**：使用 `nativeInputValueSetter`（见 renderer.js），这是 React 官方推荐的方式。对于 contenteditable，用 `document.execCommand('insertText')`，它会产生框架能监听的 input 事件。

### 难点 2：cookie 持久化 / 登录态保持

**解决**：webview 的 `partition="persist:xxx"` 属性。`persist:` 前缀使 Electron 将 cookie 存到磁盘（而非内存），重启应用后登录态保留。每个网站用不同的 partition 名，互不干扰。

### 难点 3：某些网站阻止 webview 嵌入

部分网站会检查 `window.top !== window.self`（frame-busting）。

**解决**：在 main.js 中添加 `will-prevent-unload` 和 `did-navigate` 事件处理。如果某个网站确实无法嵌入 webview，备选方案是用 `BrowserWindow` 打开独立窗口。

### 难点 4：Enter 键发送可能不生效

有些网站监听的是 `keydown`，有些监听 `keypress`，有些用 React 的 SyntheticEvent。

**解决**：同时派发 `keydown`、`keypress`、`keyup` 三个事件，覆盖大多数情况。

## 扩展方向（暂不实现）

- 支持更多 AI 源（ChatGPT、Claude 等），动态增删
- 对比模式：三个回答并排高亮差异
- 导出对话记录
- 快捷键支持
- 系统托盘最小化
