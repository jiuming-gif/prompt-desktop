# Kimi 截图完整流程

> 基于 html2canvas 1.4.1，截图范围：最新一条用户问题 + 最新一条 AI 回复。

## 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│  renderer.js (渲染进程)                                          │
│                                                                  │
│  sendPrompt("Python...")                                         │
│    ├── injectPrompt(kimi, "Python...")                           │
│    │     └── webview.executeJavaScript(填充输入框+点发送)          │
│    ├── folder = newScreenshotFolder()  →  "20260628_143025"      │
│    └── watchReplyDone(kimi, 'kimi', folder)                      │
│          │                                                        │
│          │  webview 内: MutationObserver                          │
│          │  渲染进程: 每2秒轮询                                    │
│          │                                                        │
│          └── 检测完成 → captureLatestQA(kimi, 'kimi', folder)     │
│                ├── injectScreenshotJS(kimi, 'kimi')               │
│                │     ├── html2canvas UMD 源码注入 (~700KB)         │
│                │     ├── 选择器定位 lastUser + lastAI              │
│                │     ├── html2canvas(container) → canvas          │
│                │     └── canvas 裁剪 → window.__shotResult        │
│                └── pollShotResult(kimi, 'kimi', folder, 30000)   │
│                      ├── 轮询 window.__shotResult                 │
│                      └── ipcRenderer.send('screenshot-data', ...) │
│                            │                                      │
└────────────────────────────┼──────────────────────────────────────┘
                             │ IPC
┌────────────────────────────┼──────────────────────────────────────┐
│  main.js (主进程)           ▼                                      │
│                                                                  │
│  ipcMain.on('screenshot-data', (event, {folder, name, dataURL})  │
│    ├── 校验 dataURL 前缀                                          │
│    ├── mkdir screenshots/20260628_143025/                         │
│    ├── base64 解码 → Buffer                                       │
│    ├── fs.writeFileSync → kimi.png                                │
│    └── event.reply('screenshot-ok', {name, filepath})             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## 触发路径

### 路径 A：发送 prompt 后自动截图

```
用户输入 "Python 入门介绍" → 点发送或按 Enter
  → sendBtn click / input keydown Enter
  → sendPrompt("Python 入门介绍")
```

### 路径 B：手动截图

```
用户点 "截图" 按钮
  → screenshotBtn click
  → captureAll()
```

---

## 第一步：sendPrompt — 注入 prompt 到 Kimi webview

**代码位置：** `renderer.js:79-100`

### 1.1 函数签名

```js
function sendPrompt(prompt)  // prompt = "Python 入门介绍"
```

### 1.2 执行流程

```
1. prompt.trim() 判空
2. 遍历 [deepseek, kimi, doubao] 三个 webview
3. 对每个 webview:
   - 如果 webview.isLoading() → 等 did-stop-loading 事件
   - 否则 → 立即 injectPrompt(webview, prompt)
4. input.value = '' 清空输入框
5. folder = newScreenshotFolder()  → 例: "20260628_143025"
6. watchReplyDone(kimi, 'kimi', folder)  启动回复检测
```

### 1.3 injectPrompt 详细逻辑

**代码位置：** `renderer.js:102-168`

通过 `webview.executeJavaScript(js)` 在 Kimi 页面内执行以下脚本：

```
(function() {
    const prompt = "Python 入门介绍";  // JSON.stringify 注入，安全转义

    // 步骤 1: 找输入框
    findInput():
      ① document.querySelector('[contenteditable="true"]')  // Kimi 用这个
      ② document.querySelector('textarea')
      ③ document.querySelector('input[type="text"]')

    // 步骤 2: 填入文字
    simulateInput(element, prompt):
      - contenteditable → document.execCommand('insertText', false, text)
      - textarea/input  → nativeSetter.call(element, text) + dispatchEvent('input')

    // 步骤 3: 300ms 后触发发送
    setTimeout:
      simulateEnter(element)    // keydown/keypress/keyup Enter
      clickSendButton()         // 找 [class*="send"] / [aria-label*="发送"] / button svg
})();
```

**Kimi 输入框特征：** Kimi 使用 `contenteditable="true"` 的 div 作为输入框。

---

## 第二步：newScreenshotFolder — 时间戳文件夹

**代码位置：** `renderer.js:172-183`

```js
function newScreenshotFolder() {
  const now = new Date();
  return [
    now.getFullYear(),              // "2026"
    String(now.getMonth() + 1).padStart(2, '0'),  // "06"
    String(now.getDate()).padStart(2, '0'),        // "28"
    '_',
    String(now.getHours()).padStart(2, '0'),       // "14"
    String(now.getMinutes()).padStart(2, '0'),     // "30"
    String(now.getSeconds()).padStart(2, '0'),     // "25"
  ].join('');  // → "20260628_143025"
}
```

---

## 第三步：watchReplyDone — 回复完成检测

**代码位置：** `renderer.js:499-588`

这是最复杂的部分。分两层：

### 3.1 Webview 内：MutationObserver

通过 `webview.executeJavaScript` 注入到 Kimi 页面：

```js
(function() {
    if (window.__replyWatcher) return;  // 防止重复注入
    window.__replyWatcher = true;
    window.__replySeenContent = false;

    // 120 秒硬超时
    var maxWait = setTimeout(function() {
        window.__replyDone = true;
        window.__replyTimedOut = true;
    }, 120000);

    // 找聊天容器
    // Kimi config: ['.chat-content-list', '[class*="chat-content-list"]', 'main']
    var conv = document.querySelector('.chat-content-list')
            || document.querySelector('[class*="chat-content-list"]')
            || document.querySelector('main')
            || document.body;

    // 监听 DOM 变化
    var observer = new MutationObserver(function() {
        window.__replySeenContent = true;  // 确认有过内容输出
        clearTimeout(timer);
        timer = setTimeout(function() {     // 3 秒静默窗口
            observer.disconnect();
            clearTimeout(maxWait);
            window.__replyDone = true;       // 标记回复完成
        }, 3000);
    });

    observer.observe(conv, {
        childList: true,       // 子节点增删
        subtree: true,         // 递归监听所有后代
        characterData: true    // 文本内容变化
    });
})();
```

**Kimi 的 MutationObserver 监听目标：** `.chat-content-list` 元素。Kimi 的 AI 回复以流式方式逐步插入 DOM 节点到此容器内。每次插入都触发 observer，重置 3 秒定时器。当 AI 停止输出 3 秒后，`window.__replyDone = true`。

### 3.2 渲染进程：每 2 秒轮询

```js
const poll = setInterval(() => {
    pollCount++;

    // 130 秒超时 (65 次 × 2 秒)
    if (pollCount > 65) { clearInterval(poll); return; }

    // 查询 webview 内的状态
    webview.executeJavaScript(`
        JSON.stringify({
            done: window.__replyDone === true,
            timedOut: window.__replyTimedOut === true,
            seenContent: window.__replySeenContent === true,
            textLen: document.querySelector('.chat-content-list').textContent.length
        })
    `).then(raw => {
        const state = JSON.parse(raw);

        // 必须确认有过内容输出（排除空白页面）
        if (!state.seenContent && !state.timedOut) return;

        // 文字长度连续 2 次不变 → stableCount >= 2
        if (state.textLen === prevTextLen && state.textLen > 0) {
            stableCount++;
        } else {
            stableCount = 0;
        }
        prevTextLen = state.textLen;

        // 触发条件
        const done = state.done && stableCount >= 2;        // 3s静默 + 文字稳定
        const timedOutWithContent = state.timedOut && state.textLen > 0;  // 120s超时兜底

        if (done || timedOutWithContent) {
            clearInterval(poll);
            // 清理 webview 内所有 __reply* 标记
            webview.executeJavaScript('delete window.__replyDone; ...');
            // 等 1 秒让 DOM 完全渲染
            setTimeout(() => captureLatestQA(kimi, 'kimi', folder), 1000);
        }
    });
}, 2000);
```

### 3.3 回复检测时间线

```
时间轴 (秒):
0     ─ 用户点发送, prompt 注入
1     ─ Kimi 开始回复, MutationObserver 检测到首次 DOM 变化
        __replySeenContent = true
1.5   ─ 第二段文字到达, 3s 定时器重置
2.0   ─ 轮询 #1: seenContent=true, textLen=156, done=false
2.2   ─ 第三段文字到达, 3s 定时器重置
...
8.0   ─ 最后一段文字到达, 3s 定时器开始倒数
8.0   ─ 轮询 #4: textLen=3421
10.0  ─ 轮询 #5: textLen=3421 (不变#1)
11.0  ─ 3s 定时器到期 → __replyDone = true
12.0  ─ 轮询 #6: done=true, textLen=3421 (不变#2)
        → stableCount=2 → 触发截图!
13.0  ─ captureLatestQA 执行
```

---

## 第四步：injectScreenshotJS — 定位 + 渲染 + 裁剪

**代码位置：** `renderer.js:193-298`

### 4.1 注入内容

通过 `webview.executeJavaScript` 注入到 Kimi 页面，包含两部分：

1. **html2canvas UMD 完整源码** (~700KB)，从 `node_modules/html2canvas/dist/html2canvas.min.js` 读入
2. **定位 + 渲染 + 裁剪脚本**

### 4.2 Kimi CSS 选择器

```js
kimi: {
    userMsg: [
        '.chat-content-item-user',       // 第一优先级：精确 class
        '[class*="user-content"]',       // 兜底：子串匹配
    ],
    aiMsg: [
        '.chat-content-item-assistant',  // 第一优先级：精确 class
        '[class*="assistant-content"]',  // 兜底：子串匹配
    ],
    chatContainer: [
        '.chat-content-list',            // 第一优先级：精确 class
        '[class*="chat-content-list"]',  // 兜底：子串匹配
        'main',                           // 终极兜底
    ],
},
```

### 4.3 Layer 1：定位最新用户消息和 AI 回复

```js
// 找所有用户消息（按优先级尝试选择器）
var userEls = [];
for (var i = 0; i < C.userMsg.length; i++) {
    userEls = document.querySelectorAll(C.userMsg[i]);  // '.chat-content-item-user'
    if (userEls.length > 0) break;  // 命中 5 个用户消息
}
var lastUser = userEls[userEls.length - 1];  // 第 5 个（最新）

// 找所有 AI 消息
var aiEls = [];
for (var i = 0; i < C.aiMsg.length; i++) {
    aiEls = document.querySelectorAll(C.aiMsg[i]);  // '.chat-content-item-assistant'
    if (aiEls.length > 0) break;  // 命中 5 个 AI 消息
}
var lastAI = aiEls[aiEls.length - 1];  // 第 5 个（最新）
```

**Kimi DOM 结构示意：**

```html
<div class="chat-content-list">            ← 聊天容器
  <div class="chat-content-item-user">     ← 用户消息 1
    <div class="user-content">...</div>
  </div>
  <div class="chat-content-item-assistant">← AI 回复 1
    <div class="assistant-content">...</div>
  </div>
  <div class="chat-content-item-user">     ← 用户消息 2
    ...
  </div>
  <div class="chat-content-item-assistant">← AI 回复 2
    ...
  </div>
  ... (共 5 轮对话)
  <div class="chat-content-item-user">     ← 用户消息 5 (lastUser)
    <div class="user-content">
      <p>Python 入门介绍</p>              ← 目标：最新问题
    </div>
  </div>
  <div class="chat-content-item-assistant">← AI 回复 5 (lastAI)
    <div class="assistant-content">
      <h2>Python 入门</h2>                ← 目标：最新回复
      <p>Python 是一种...</p>
      <pre><code>print("Hello")</code></pre>
      ...
    </div>
  </div>
</div>
```

### 4.4 找截图容器

```js
var container = null;
// 按优先级尝试: '.chat-content-list' → '[class*="chat-content-list"]' → 'main'
for (var i = 0; i < C.chatContainer.length; i++) {
    var c = document.querySelector(C.chatContainer[i]);
    if (c) { container = c; break; }
}
if (!container) container = document.querySelector('main') || document.body;
```

**Kimi 结果：** `container = document.querySelector('.chat-content-list')` — 包含所有历史消息的滚动容器。

### 4.5 html2canvas 渲染 + Canvas 裁剪

```js
function doShot() {
    // ① 渲染整个聊天容器到 canvas (scale:2 → 2x 高清)
    window.html2canvas(container, {
        scale: 2,
        useCORS: true,          // 处理 Kimi 头像等跨域图片
        allowTaint: true,       // 允许被跨域图片"污染"的 canvas 导出
        backgroundColor: '#ffffff',
        logging: false,
    }).then(function(canvas) {

        // ② 裁剪：仅保留最新 QA 对的包围盒
        if (lastUser && lastAI) {
            // 获取三个关键元素的 viewport 坐标
            var cr = container.getBoundingClientRect();
            var ur = lastUser.getBoundingClientRect();
            var ar = lastAI.getBoundingClientRect();

            // 计算相对于容器的裁剪区域
            var relTop    = Math.min(ur.top, ar.top) - cr.top;
            var relBottom = Math.max(ur.bottom, ar.bottom) - cr.top;
            var relLeft   = 0;           // 左边界 = 容器左边界
            var relRight  = cr.width;    // 右边界 = 容器右边界

            // 转换到 canvas 坐标系 (× 2 scale)
            var cropX = relLeft * 2;
            var cropY = relTop * 2;
            var cropW = (relRight - relLeft) * 2;
            var cropH = (relBottom - relTop) * 2;

            // ③ 边界保护：防止越界
            if (cropX < 0) cropX = 0;
            if (cropY < 0) cropY = 0;
            if (cropX + cropW > canvas.width)  cropW = canvas.width - cropX;
            if (cropY + cropH > canvas.height) cropH = canvas.height - cropY;

            // ④ 创建裁剪画布
            var crop = document.createElement('canvas');
            crop.width = cropW;
            crop.height = cropH;
            var ctx = crop.getContext('2d');
            ctx.drawImage(canvas,
                cropX, cropY, cropW, cropH,   // 源区域
                0, 0, cropW, cropH            // 目标区域
            );

            // ⑤ 导出为 PNG dataURL
            window.__shotResult = crop.toDataURL('image/png');
        } else {
            // 兜底：user/AI 没同时找到 → 全容器截图
            window.__shotResult = canvas.toDataURL('image/png');
        }
    }).catch(function(err) {
        window.__shotResult = JSON.stringify({ error: err.message });
    });
}
```

### 4.6 裁剪坐标计算图解

```
container.getBoundingClientRect()
┌─────────────────────────────────────┐ ← cr.top (容器顶部 viewport 坐标)
│  用户消息 1                          │
│  AI 回复 1                          │
│  用户消息 2                          │
│  AI 回复 2                          │
│  ...                                │
│  ┌──────────────────────────────┐   │ ← cr.top + relTop = ur.top
│  │ 用户消息 5 (lastUser)        │   │    = Math.min(ur.top, ar.top)
│  │ "Python 入门介绍"             │   │
│  └──────────────────────────────┘   │
│  ┌──────────────────────────────┐   │
│  │ AI 回复 5 (lastAI)           │   │
│  │ "Python 是一种高级编程语言..." │   │
│  │                              │   │
│  └──────────────────────────────┘   │ ← cr.top + relBottom = ar.bottom
│                                     │    = Math.max(ur.bottom, ar.bottom)
└─────────────────────────────────────┘ ← cr.bottom

relLeft = 0 ─────────────────────────── relRight = cr.width

最终截图 = 从 "用户消息 5" 顶部 到 "AI 回复 5" 底部，宽度为容器全宽
```

### 4.7 html2canvas 配置说明

| 参数 | 值 | 原因 |
|------|-----|------|
| `scale` | 2 | 2x 高清输出，适配 Retina 屏幕 |
| `useCORS` | true | Kimi 头像等图片是跨域资源，需 CORS |
| `allowTaint` | true | 允许被跨域图片"污染"的 canvas 仍然导出 |
| `backgroundColor` | #ffffff | 白色背景（容器本身可能透明） |
| `logging` | false | 不输出 html2canvas 内部调试日志 |

### 4.8 结果写入

```js
window.__shotResult = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgA..."
```

---

## 第五步：pollShotResult — 轮询拿结果

**代码位置：** `renderer.js:300-337`

### 5.1 轮询逻辑

```js
function pollShotResult(webview, 'kimi', '20260628_143025', 30000) {
    const deadline = Date.now() + 30000;  // 30 秒超时

    function check() {
        if (Date.now() > deadline) {
            // 超时 → 清理 + 放弃
            webview.executeJavaScript('delete window.__shotResult;');
            return;
        }

        webview.executeJavaScript('window.__shotResult').then(result => {
            if (!result) {
                setTimeout(check, 500);  // 无结果 → 500ms 后重试
                return;
            }

            // 有结果 → 清理 webview 内的临时变量
            webview.executeJavaScript('delete window.__shotResult;');

            // 判断结果类型
            if (result.startsWith('data:image/png;base64,')) {
                // ✅ 成功 → IPC 发给主进程
                ipcRenderer.send('screenshot-data', {
                    folder: '20260628_143025',
                    name: 'kimi',
                    dataURL: result
                });
            } else {
                // ❌ 失败 → 尝试解析错误信息
                try {
                    const err = JSON.parse(result);
                    console.warn('kimi: 截图失败 - ' + err.error);
                } catch (e) {
                    console.warn('kimi: 未知截图结果');
                }
            }
        }).catch(() => {
            setTimeout(check, 500);  // executeJavaScript 失败 → 重试
        });
    }

    setTimeout(check, 200);  // 首轮延迟 200ms，等 html2canvas 开始渲染
}
```

### 5.2 轮询时序

```
t=0ms     injectScreenshotJS 注入
t=200ms   首轮检查 → window.__shotResult 为 undefined (html2canvas 还在渲染)
t=700ms   第二轮 → undefined
t=1200ms  第三轮 → undefined
t=1700ms  第四轮 → "data:image/png;base64,iVBORw0..."
          → 结果有效 → IPC 发送
          → 停止轮询
```

---

## 第六步：main.js 接收 dataURL 写 PNG

**代码位置：** `main.js:35-55`

```js
ipcMain.on('screenshot-data', (event, { folder, name, dataURL }) => {
    //  folder = "20260628_143025"
    //  name   = "kimi"
    //  dataURL = "data:image/png;base64,iVBORw0KGgo..."

    // ① 校验
    if (!dataURL || !dataURL.startsWith('data:image/png;base64,')) {
        console.error('kimi: 无效 dataURL');
        event.reply('screenshot-error', { name: 'kimi', error: '无效 dataURL' });
        return;
    }

    // ② 创建目录
    const dir = path.join(__dirname, 'screenshots', '20260628_143025');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // ③ 解码 base64 → Buffer → 写文件
    const filepath = path.join(dir, 'kimi.png');
    const base64 = dataURL.replace('data:image/png;base64,', '');
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));

    // ④ 通知渲染进程
    event.reply('screenshot-ok', {
        name: 'kimi',
        filepath: 'D:\\prompt_桌面版\\screenshots\\20260628_143025\\kimi.png'
    });
});
```

---

## 第七步：渲染进程收到确认

```js
ipcRenderer.on('screenshot-ok', (event, { name, filepath }) => {
    console.log('kimi 截图已保存: D:\\prompt_桌面版\\screenshots\\20260628_143025\\kimi.png');
});

ipcRenderer.on('screenshot-error', (event, { name, error }) => {
    console.error('kimi 截图失败: ' + error);
});
```

---

## 手动截图路径 (captureAll)

**代码位置：** `renderer.js:485-495`

```js
function captureAll() {
    // 先运行 DOM 诊断（输出到 webview 控制台）
    diagnoseDOM(deepseek, 'deepseek');
    diagnoseDOM(kimi, 'kimi');
    diagnoseDOM(doubao, 'doubao');

    // 创建新时间戳文件夹
    const folder = newScreenshotFolder();  // "20260628_143025"

    // 三个 webview 同时截图（不等回复完成）
    captureLatestQA(deepseek, 'deepseek', folder);
    captureLatestQA(kimi, 'kimi', folder);
    captureLatestQA(doubao, 'doubao', folder);
}
```

手动截图不经过 `watchReplyDone`，直接对当前页面可见内容截图。

---

## 完整数据流

```
用户输入 "Python 入门介绍"
  │
  ▼
injectPrompt → Kimi webview 内执行:
  findInput() → contenteditable div
  simulateInput → 填入文字
  simulateEnter → 触发发送
  │
  ▼
watchReplyDone → 双重检测:
  │  webview 内: MutationObserver 监听 .chat-content-list
  │    每次 DOM 变化 → 重置 3s 定时器
  │    3s 无变化 → __replyDone = true
  │    120s → 强制 __replyDone = true (超时兜底)
  │
  │  渲染进程: 每 2s 轮询
  │    检查 seenContent + done + textLen 稳定
  │    done && stableCount>=2 → 触发截图
  │    timedOut && textLen>0 → 超时兜底
  │
  ▼
captureLatestQA → 两步:
  │
  ├── injectScreenshotJS → Kimi webview 内执行:
  │     ① querySelectorAll('.chat-content-item-user')  → 5 个
  │        lastUser = 第 5 个 (<div>Python 入门介绍</div>)
  │     ② querySelectorAll('.chat-content-item-assistant') → 5 个
  │        lastAI = 第 5 个 (<div>Python 是一种...</div>)
  │     ③ container = document.querySelector('.chat-content-list')
  │     ④ html2canvas(container, {scale:2, ...})
  │         → 渲染整个聊天列表到 canvas (宽 720px, 高 8000px)
  │     ⑤ getBoundingClientRect:
  │         ur = {top: 1200, bottom: 1280, left: 20, right: 700}
  │         ar = {top: 1290, bottom: 3500, left: 20, right: 700}
  │         cr = {top: 100, bottom: 8000, left: 0, right: 720}
  │         relTop = 1200 - 100 = 1100
  │         relBottom = 3500 - 100 = 3400
  │     ⑥ crop canvas: 从 (0, 2200) 裁 1440×4600 像素
  │     ⑦ crop.toDataURL('image/png') → base64 dataURL
  │     ⑧ window.__shotResult = "data:image/png;base64,..."
  │
  └── pollShotResult → 轮询:
        200ms 首查 → 无值 → 500ms 重试
        ... → 拿到 base64 → 清理 window.__shotResult
        → ipcRenderer.send('screenshot-data', {
              folder: "20260628_143025",
              name: "kimi",
              dataURL: "data:image/png;base64,iVBORw0KGgo..."
          })
  │
  ▼
main.js ipcMain.on('screenshot-data'):
  校验前缀 → mkdir screenshots/20260628_143025/
  → Buffer.from(base64, 'base64')
  → fs.writeFileSync('screenshots/20260628_143025/kimi.png')
  → event.reply('screenshot-ok', {name:'kimi', filepath:'...'})
  │
  ▼
renderer.js ipcRenderer.on('screenshot-ok'):
  console.log('kimi 截图已保存: screenshots/20260628_143025/kimi.png')
```

---

## 进程架构

```
┌──────────────────────────────────────────────────────────────────┐
│  主进程 (main.js)                                                │
│  - 创建 BrowserWindow                                            │
│  - IPC: screenshot-data → 写 PNG 文件                             │
│  - IPC: show-webview-context-menu → 右键菜单                      │
└──────────────────────────────────────────────────────────────────┘
        │
        │ 创建窗口, 加载 index.html
        ▼
┌──────────────────────────────────────────────────────────────────┐
│  渲染进程 (index.html + renderer.js)                              │
│  - DOM: 3 个 <webview> + 输入框 + 按钮                            │
│  - 注入 prompt 到 webview                                         │
│  - 回复完成检测 (MutationObserver + 轮询)                          │
│  - 截图 (html2canvas 注入 + 轮询 + IPC 发送)                      │
│  - 右键菜单、拖拽分隔条、错误处理                                   │
└──────────────────────────────────────────────────────────────────┘
        │                    │                    │
        │ webview            │ webview            │ webview
        ▼                    ▼                    ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ Kimi webview  │  │DeepSeek wv    │  │ Doubao wv     │
│ (独立进程)     │  │(独立进程)      │  │(独立进程)      │
│               │  │               │  │               │
│ partition:    │  │ partition:    │  │ partition:    │
│ persist:kimi  │  │persist:deepsk │  │persist:doubao │
│               │  │               │  │               │
│ executeJS:    │  │ executeJS:    │  │ executeJS:    │
│ - injectPrompt│  │ - injectPrompt│  │ - injectPrompt│
│ - injectShot  │  │ - injectShot  │  │ - injectShot  │
│ - watchReply  │  │ - watchReply  │  │ - watchReply  │
│ - pollShot    │  │ - pollShot    │  │ - pollShot    │
└───────────────┘  └───────────────┘  └───────────────┘
```

---

## 超时参数汇总

| 超时项 | 值 | 位置 |
|--------|-----|------|
| html2canvas 渲染等待 | 30s | pollShotResult deadline |
| 回复检测总超时 (webview 内) | 120s | watchReplyDone MutationObserver maxWait |
| 回复检测总超时 (渲染进程) | 130s | pollCount > 65 × 2s |
| MutationObserver 静默窗口 | 3s | 无新 DOM 变化视为完成 |
| 文字长度稳定确认 | 连续 2 次轮询 (4s) | stableCount >= 2 |
| pollShotResult 首轮延迟 | 200ms | 等 html2canvas 启动 |
| pollShotResult 重试间隔 | 500ms | - |
| watchReplyDone 轮询间隔 | 2s | - |
| 检测完成到截图延迟 | 1s | 等 DOM 完全渲染 |

---

## 约束条件

- **零 DOM 修改**：webview 内所有操作仅读取 DOM（querySelector/querySelectorAll/getBoundingClientRect），不增删改任何节点
- **跨域图片**：`useCORS: true` + `allowTaint: true` 处理 Kimi 头像等跨域资源，canvas 被标记为污染但不影响 PNG 导出
- **html2canvas 完整注入**：每次截图注入完整 UMD 包 ~700KB，未做缓存（已知优化点）
- **contextIsolation: false** + **nodeIntegration: true**：渲染进程可直接使用 `fs.readFileSync` 读取 html2canvas 文件
- **文件命名**：`screenshots/YYYYMMDD_hhmmss/kimi.png`
- **截图范围**：最新用户问题 + 最新 AI 回复的 canvas 裁剪区域
