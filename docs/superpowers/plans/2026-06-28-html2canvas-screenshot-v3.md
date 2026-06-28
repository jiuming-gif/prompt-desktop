# html2canvas Screenshot v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CDP-based screenshot pipeline with html2canvas, eliminating DOM modification, coordinate calculation, and cross-process debugger operations.

**Architecture:** renderer injects html2canvas UMD bundle into each webview via executeJavaScript. Webview locates latest QA elements, renders to canvas, exports dataURL. renderer polls for result, sends base64 to main process via IPC, main writes PNG file.

**Tech Stack:** Electron 33, html2canvas 1.4.1

## Global Constraints

- Three webviews: DeepSeek (`chat.deepseek.com`), Kimi (`www.kimi.com`), Doubao (`www.doubao.com`)
- Partition: `persist:deepseek`, `persist:kimi`, `persist:doubao`
- Screenshot scope: latest user question + latest AI reply pair
- Zero DOM modification — only querySelector reads
- `allowTaint: true` + `toDataURL()` to handle cross-origin images (avatars)
- Reply detection: MutationObserver + 3s quiet period + text length stable check + 120s timeout
- Timestamp subfolder: `screenshots/YYYYMMDD_hhmmss/`
- File naming: `deepseek.png`, `kimi.png`, `doubao.png`

---

### Task 1: Install html2canvas dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install html2canvas**

```bash
npm install html2canvas@1.4.1
```

- [ ] **Step 2: Verify install**

```bash
node -e "require('html2canvas'); console.log('html2canvas OK');"
```
Expected: `html2canvas OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add html2canvas 1.4.1 dependency"
```

---

### Task 2: main.js — Strip CDP + add screenshot-data handler

**Files:**
- Modify: `main.js`

**Interfaces:**
- Consumes: `ipcMain.on('show-webview-context-menu', ...)` (kept from current)
- Consumes: `ipcMain.on('screenshot-data', (event, { folder, name, dataURL })` (new)
- Produces: `event.reply('screenshot-ok', { name, filepath })` (new)

- [ ] **Step 1: Rewrite main.js**

Replace entire file:

```js
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ============ webview 右键菜单 ============

ipcMain.on('show-webview-context-menu', (event, index) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  Menu.buildFromTemplate([
    { label: '检查元素', click: () => event.sender.send('open-webview-devtools', index) },
    { type: 'separator' },
    { label: '复制', role: 'copy' },
    { label: '粘贴', role: 'paste' },
  ]).popup({ window: win });
});

// ============ 截图：接收 dataURL 写 PNG ============

ipcMain.on('screenshot-data', (event, { folder, name, dataURL }) => {
  if (!dataURL || !dataURL.startsWith('data:image/png;base64,')) {
    console.error(`${name}: 无效 dataURL`);
    return;
  }

  const dir = path.join(__dirname, 'screenshots', folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filepath = path.join(dir, `${name}.png`);
  const base64 = dataURL.replace('data:image/png;base64,', '');

  try {
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
    event.reply('screenshot-ok', { name, filepath });
  } catch (e) {
    console.error(`${name}: 写文件失败 - ${e.message}`);
  }
});
```

- [ ] **Step 2: Verify main.js is valid**

```bash
node -c main.js
```
Expected: no output (syntax OK)

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "refactor: replace CDP screenshot pipeline with dataURL handler in main"
```

---

### Task 3: index.html — Remove Kimi UA attribute

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Delete useragent attribute from Kimi webview**

Replace:
```html
      <div class="panel" id="panel-2">
        <div class="panel-header">Kimi</div>
        <webview
          id="webview-kimi"
          src="https://www.kimi.com"
          partition="persist:kimi"
          allowpopups
          useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
        ></webview>
      </div>
```

With:
```html
      <div class="panel" id="panel-2">
        <div class="panel-header">Kimi</div>
        <webview
          id="webview-kimi"
          src="https://www.kimi.com"
          partition="persist:kimi"
          allowpopups
        ></webview>
      </div>
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "refactor: remove unnecessary Kimi UA override"
```

---

### Task 4: renderer.js — Rewrite screenshot pipeline

**Files:**
- Modify: `renderer.js`

**Interfaces:**
- Consumes: `ipcRenderer` from electron, `#webview-*`, `#prompt-input`, `#send-btn`, `#screenshot-btn` DOM elements
- Consumes: `ipcRenderer.on('open-webview-devtools', ...)` (kept)
- Consumes: `ipcRenderer.on('screenshot-ok', ...)` (new)
- Produces: `sendPrompt()`, `captureAll()`, `ipcRenderer.send('screenshot-data', ...)`
- Internal: `injectPrompt()`, `watchReplyDone()`, `captureLatestQA()`, `newScreenshotFolder()`, `getSiteKey()`

- [ ] **Step 1: Write the new renderer.js**

Replace entire file:

```js
const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const deepseek = document.getElementById('webview-deepseek');
const kimi = document.getElementById('webview-kimi');
const doubao = document.getElementById('webview-doubao');
const input = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const screenshotBtn = document.getElementById('screenshot-btn');

// ============ 站点选择器（只读，不修改 DOM）============

const SITE = {
  deepseek: {
    userMsg: [
      '[class*="ds-markdown"]',
    ],
    aiMsg: [
      '[class*="ds-markdown ds-assistant"]',
      '[class*="ds-assistant-message"]',
    ],
    chatContainer: [
      '[class*="ds-scroll-area"]',
      'main',
    ],
    stopTexts: ['停止生成', 'Stop generating'],
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
    stopTexts: ['停止生成', 'Stop'],
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
    stopTexts: ['停止生成', 'AI 生成中'],
  },
};

// ============ html2canvas 加载 ============

const html2canvasCode = (function() {
  try {
    return fs.readFileSync(
      path.join(__dirname, 'node_modules', 'html2canvas', 'dist', 'html2canvas.min.js'),
      'utf-8'
    );
  } catch (e) {
    console.error('无法加载 html2canvas:', e.message);
    return null;
  }
})();

// ============ 发送逻辑 ============

function sendPrompt(prompt) {
  if (!prompt.trim()) return;

  const webviews = [deepseek, kimi, doubao];

  webviews.forEach((webview) => {
    if (webview.isLoading()) {
      webview.addEventListener('did-stop-loading', () => {
        injectPrompt(webview, prompt);
      }, { once: true });
    } else {
      injectPrompt(webview, prompt);
    }
  });

  input.value = '';

  const folder = newScreenshotFolder();
  watchReplyDone(deepseek, 'deepseek', folder);
  watchReplyDone(kimi, 'kimi', folder);
  watchReplyDone(doubao, 'doubao', folder);
}

function injectPrompt(webview, prompt) {
  const escaped = prompt.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

  const js = `
    (function() {
      const prompt = \`${escaped}\`;

      function findInput() {
        let el = document.querySelector('[contenteditable="true"]');
        if (el) return { el, type: 'contenteditable' };

        el = document.querySelector('textarea');
        if (el) return { el, type: 'textarea' };

        el = document.querySelector('input[type="text"]');
        if (el) return { el, type: 'input' };

        return null;
      }

      function simulateInput(element, text) {
        element.focus();
        if (element.isContentEditable) {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
        } else {
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
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
        element.dispatchEvent(new KeyboardEvent('keydown', opts));
        element.dispatchEvent(new KeyboardEvent('keypress', opts));
        element.dispatchEvent(new KeyboardEvent('keyup', opts));
      }

      function clickSendButton() {
        const btn = document.querySelector('[class*="send"]') ||
                    document.querySelector('[aria-label*="发送"]') ||
                    document.querySelector('button svg')?.closest('button');
        if (btn) btn.click();
      }

      const input = findInput();
      if (input) {
        simulateInput(input.el, prompt);
        setTimeout(() => {
          simulateEnter(input.el);
          clickSendButton();
        }, 300);
      }
    })();
  `;

  webview.executeJavaScript(js).catch(err => {
    console.error('注入失败:', err.message);
  });
}

// ============ 截图功能 ============

function newScreenshotFolder() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
}

function getSiteKey(webview) {
  if (webview === deepseek) return 'deepseek';
  if (webview === kimi) return 'kimi';
  if (webview === doubao) return 'doubao';
  return null;
}

// 在 webview 内定位最新问答 + html2canvas 渲染，结果写到 window.__shotResult
function injectScreenshotJS(webview, siteKey) {
  const config = SITE[siteKey];
  if (!html2canvasCode) {
    console.error(`${siteKey}: html2canvas 未加载`);
    return;
  }

  const js = `
    ${html2canvasCode}

    (function() {
      var C = ${JSON.stringify(config)};

      // 两层定位：精确 → 模糊兜底
      function queryAllSafe(sel) {
        try { return Array.from(document.querySelectorAll(sel)); }
        catch (e) { return []; }
      }

      function commonAncestor(a, b) {
        if (!a || !b) return a || b;
        var el = a;
        while (el) {
          if (el.contains(b)) return el;
          el = el.parentElement;
        }
        return a;
      }

      var targetEl = null;

      // Layer 1: 精确定位最新 user + AI 消息
      var userEls = [];
      var aiEls = [];
      for (var i = 0; i < C.userMsg.length; i++) {
        userEls = queryAllSafe(C.userMsg[i]);
        if (userEls.length > 0) break;
      }
      for (var i = 0; i < C.aiMsg.length; i++) {
        aiEls = queryAllSafe(C.aiMsg[i]);
        if (aiEls.length > 0) break;
      }
      var lastUser = userEls[userEls.length - 1];
      var lastAI = aiEls[aiEls.length - 1];

      if (lastUser || lastAI) {
        targetEl = commonAncestor(lastUser, lastAI);
      }

      // Layer 2: 模糊兜底
      if (!targetEl) {
        for (var i = 0; i < C.chatContainer.length; i++) {
          var c = document.querySelector(C.chatContainer[i]);
          if (c) { targetEl = c; break; }
        }
        if (!targetEl) targetEl = document.querySelector('main') || document.body;
      }

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
  `;

  webview.executeJavaScript(js).catch(err => {
    console.error(`${siteKey}: 截图脚本注入失败 - ${err.message}`);
  });
}

// 轮询 webview 直到 window.__shotResult 有值
function pollShotResult(webview, name, folder, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);

  function check() {
    if (Date.now() > deadline) {
      console.warn(`${name}: 截图超时`);
      webview.executeJavaScript('delete window.__shotResult;').catch(() => {});
      return;
    }

    webview.executeJavaScript('window.__shotResult').then(result => {
      if (!result) {
        setTimeout(check, 500);
        return;
      }

      // 清理
      webview.executeJavaScript('delete window.__shotResult;').catch(() => {});

      // 解析结果
      if (typeof result === 'string' && result.startsWith('data:image/png;base64,')) {
        ipcRenderer.send('screenshot-data', { folder, name, dataURL: result });
      } else {
        try {
          const err = JSON.parse(result);
          console.warn(`${name}: 截图失败 - ${err.error}`);
        } catch (e) {
          console.warn(`${name}: 未知截图结果`);
        }
      }
    }).catch(() => {
      setTimeout(check, 500);
    });
  }

  setTimeout(check, 200); // 首轮等 html2canvas 开始渲染
}

// 完整的截图流程：注入 → 轮询 → 等结果
function captureLatestQA(webview, name, folder) {
  const siteKey = getSiteKey(webview);
  if (!siteKey) return;

  injectScreenshotJS(webview, siteKey);
  pollShotResult(webview, name, folder, 30000);
}

function captureAll() {
  const folder = newScreenshotFolder();
  captureLatestQA(deepseek, 'deepseek', folder);
  captureLatestQA(kimi, 'kimi', folder);
  captureLatestQA(doubao, 'doubao', folder);
}

// ============ 回复完成检测 ============

function watchReplyDone(webview, name, folder) {
  const siteKey = getSiteKey(webview);
  const config = SITE[siteKey];
  if (!config) return;

  webview.executeJavaScript(`
    (function() {
      if (window.__replyWatcher) return;
      window.__replyWatcher = true;
      window.__replySeenContent = false;
      window.__replyTextLen = 0;
      window.__replyStableCount = 0;

      var timer = null;
      var maxWait = setTimeout(function() {
        // 超时兜底：有内容才截图
        window.__replyDone = true;
        window.__replyTimedOut = true;
      }, 120000);

      // 找聊天容器
      var conv = null;
      var convSels = ${JSON.stringify(config.chatContainer)};
      for (var i = 0; i < convSels.length; i++) {
        var c = document.querySelector(convSels[i]);
        if (c) { conv = c; break; }
      }
      if (!conv) conv = document.body;

      var observer = new MutationObserver(function() {
        window.__replySeenContent = true;
        clearTimeout(timer);
        timer = setTimeout(function() {
          observer.disconnect();
          clearTimeout(maxWait);
          window.__replyDone = true;
        }, 3000);
      });
      observer.observe(conv, { childList: true, subtree: true, characterData: true });
    })();
  `).catch(() => {});

  // 轮询检测
  let prevTextLen = -1;
  let stableCount = 0;
  let pollCount = 0;

  const poll = setInterval(() => {
    pollCount++;
    // 超时兜底: 120s / 2s = 60 polls
    if (pollCount > 65) {
      clearInterval(poll);
      webview.executeJavaScript('delete window.__replyDone; delete window.__replyWatcher; delete window.__replySeenContent;').catch(() => {});
      return;
    }

    webview.executeJavaScript(`
      JSON.stringify({
        done: window.__replyDone === true,
        timedOut: window.__replyTimedOut === true,
        seenContent: window.__replySeenContent === true,
        textLen: (document.querySelector('${config.chatContainer[0]}') || document.body).textContent.length
      })
    `).then(raw => {
      const state = JSON.parse(raw);

      // 确认有过内容输出
      if (!state.seenContent && !state.timedOut) return;

      // 文字长度稳定检测：连续 2 次不变
      if (state.textLen === prevTextLen && state.textLen > 0) {
        stableCount++;
      } else {
        stableCount = 0;
      }
      prevTextLen = state.textLen;

      // 触发条件：done + 文字稳定
      const done = state.done && stableCount >= 2;
      // 或超时但有内容
      const timedOutWithContent = state.timedOut && state.textLen > 0;

      if (done || timedOutWithContent) {
        clearInterval(poll);
        webview.executeJavaScript('delete window.__replyDone; delete window.__replyTimedOut; delete window.__replyWatcher; delete window.__replySeenContent; delete window.__replyTextLen; delete window.__replyStableCount;').catch(() => {});
        setTimeout(() => captureLatestQA(webview, name, folder), 1000);
      }
    }).catch(() => {});
  }, 2000);
}

// ============ 事件绑定 ============

sendBtn.addEventListener('click', () => sendPrompt(input.value));
screenshotBtn.addEventListener('click', captureAll);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt(input.value);
  }
});

// ============ 面板标题双击开 DevTools ============

document.querySelectorAll('.panel-header').forEach((header, i) => {
  header.addEventListener('dblclick', () => {
    const map = [deepseek, kimi, doubao];
    if (map[i]) map[i].openDevTools();
  });
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

// ============ webview 事件 ============

[deepseek, kimi, doubao].forEach((wv, i) => {
  wv.addEventListener('context-menu', (e) => {
    e.preventDefault();
    ipcRenderer.send('show-webview-context-menu', i);
  });
});

// 监控 webview 加载失败
const wvNames = ['deepseek', 'kimi', 'doubao'];
[deepseek, kimi, doubao].forEach((wv, i) => {
  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode !== -3) {
      console.error(`${wvNames[i]} 加载失败: code=${e.errorCode} desc="${e.errorDescription}" url=${e.validatedURL}`);
    }
  });
  wv.addEventListener('crashed', () => {
    console.error(`${wvNames[i]} webview 崩溃，正在重载...`);
    wv.reload();
  });
  wv.addEventListener('console-message', (e) => {
    if (e.level >= 2) {
      console.log(`[${wvNames[i]}] ${e.message}`);
    }
  });
});

ipcRenderer.on('open-webview-devtools', (event, index) => {
  [deepseek, kimi, doubao][index].openDevTools();
});

ipcRenderer.on('screenshot-ok', (event, { name, filepath }) => {
  console.log(`${name} 截图已保存: ${filepath}`);
});
```

- [ ] **Step 2: Verify renderer.js is valid**

```bash
node -c renderer.js
```
Expected: no output (syntax OK)

- [ ] **Step 3: Commit**

```bash
git add renderer.js
git commit -m "refactor: replace CDP screenshot with html2canvas pipeline"
```

---

## Execution Order

```
Task 1 (install dep)
  └─ Task 2 (main.js)
      └─ Task 3 (index.html)
          └─ Task 4 (renderer.js)
```

Task 1 must run first (dependency). Tasks 2, 3 independent of each other but both depend on Task 1. Task 4 depends on Task 2 (IPC channel `screenshot-data` must exist in main).

## Verification Checklist

All tasks complete:
1. `npm start` — app launches without errors
2. Three webviews load: DeepSeek, Kimi, Doubao all render content (no white screens)
3. Type "Python 完整入门介绍" and press Enter
4. Wait for all three to finish generating
5. Check `screenshots/<timestamp>/`:
   - `deepseek.png` — full user question + AI response
   - `kimi.png` — full user question + AI response
   - `doubao.png` — full user question + AI response
6. Click manual screenshot button — all three captured again
7. Console: no uncaught errors, `screenshot-ok` logged for each
