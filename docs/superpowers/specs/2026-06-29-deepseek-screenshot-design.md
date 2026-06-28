# DeepSeek 截图 v1：复用 html2canvas 管线 + allMsg 路径

## 背景

v3 已将截图管线统一为 html2canvas。当前 Kimi 和豆包已启用截图，DeepSeek 未配置。本设计为 DeepSeek 适配同一管线。

## 核心差异：DeepSeek DOM vs Kimi/豆包

| | Kimi | 豆包 | DeepSeek |
|---|---|---|---|
| 消息标识 | `.chat-content-item-user` / `.chat-content-item-assistant` 两类 CSS 类 | `data-message-id` 属性，用户/AI 共用 | `ds-message` CSS module 类，用户/AI 共用 |
| 用户/AI 区分 | CSS 选择器级别区分 | class 中 `justify-end`（用户）vs 无（AI），从父元素上找 | 检查后代是否有 `ds-markdown`（AI）vs 无（用户） |
| 虚拟列表 | 无 | 无 | `data-virtual-list-item-key`，消息在视口外会被卸载 |
| 容器 | `.chat-content-list` | `[class*="message-list"]`（CSS module） | CSS module hash 类，需动态查找 |
| 消息包裹 | 无需额外修正 | `data-message-id` 在消息根元素上 | `ds-message` 即消息根元素 |

## 方案：`allMsg` 路径 + `aiMarker` 后代检测

### SITE 配置

```js
deepseek: {
  allMsg: ['[class*="ds-message"]'],
  aiMarker: 'ds-markdown',
  chatContainer: [
    '[class*="ds-scroll"]',
    'main',
  ],
  stopTexts: ['停止生成', 'Stop generating'],
},
```

- `allMsg`：`ds-message` 匹配所有消息包裹（用户和 AI 共用）
- `aiMarker`：驱动区分逻辑——元素后代有该 CSS 类 → AI；没有 → 用户
- `chatContainer`：`[class*="ds-scroll"]` 匹配 DeepSeek 滚动区域（前缀 `ds-scroll` 出现 27 次），回退 `main`
- `stopTexts`：和现有一致

### allMsg 分支改造

现有 `allMsg` 分支用 parent-class 对齐检测（豆包的 `justify-end`/`justify-start`）。新增 `aiMarker` 后代检测路径，两者通过 `C.aiMarker` 是否存在分岔：

```js
if (C.allMsg) {
  var allEls = [];
  for (var i = 0; i < C.allMsg.length; i++) {
    allEls = queryAllSafe(C.allMsg[i]);
    if (allEls.length > 0) break;
  }

  if (C.aiMarker) {
    // DeepSeek 路径：后代检测
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      var hasMarker = !!el.querySelector('[class*="' + C.aiMarker + '"]');
      if (hasMarker) aiEls.push(el);
      else userEls.push(el);
    }
  } else {
    // 豆包路径：parent class 对齐检测（现有逻辑不变）
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      var p = el;
      var isUser = false;
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
      if (found) {
        if (isUser) userEls.push(el);
        else aiEls.push(el);
      }
    }
  }
}
```

### 容器查找

现有两层兜底逻辑已覆盖：

1. `chatContainer[i]` 逐个试 → `[class*="ds-scroll"]` → `main`
2. 兜底：`document.querySelector('main') || document.body`
3. 0x0 rect 修正：`display:contents` 往上找有尺寸祖先（DeepSeek `ds-scroll-area` 可能出现）

不需额外改动。

### upgradeToWrapper

DeepSeek 无 `data-message-id` 属性，`upgradeToWrapper` 执行路径：

1. `el.hasAttribute("data-message-id")` → false
2. `el.closest("[data-message-id]")` → null
3. `document.querySelector("[data-message-id]")` → null（页面上没有）
4. `return el` — `ds-message` 原样返回，正确

不需改动。

### 虚拟列表

DeepSeek 使用 `data-virtual-list-item-key` 虚拟列表，滚动出视口的消息被卸载。处理策略：不特殊处理。截图只取最新 QA 对，回复完成后最新消息在底部视口内，虚拟列表不会卸载最新消息。若未来需要截长对话，再考虑 scrollIntoView 方案。

## 改动文件

| 文件 | 改动 |
|------|------|
| `renderer.js` | 1. `SITE` 对象加 `deepseek` 配置；2. `allMsg` 分支加 `aiMarker` 后代检测逻辑；3. `captureAll()` 加 `captureLatestQA(deepseek, 'deepseek', folder)` + `diagnoseDOM(deepseek, 'deepseek')`；4. `sendPrompt()` 加 `watchReplyDone(deepseek, 'deepseek', folder)` |

不改 `main.js`、`index.html`、`style.css`、`package.json`。

`getSiteKey()` 已有 `deepseek` 映射。`pollShotResult()`、`injectScreenshotJS()`、`watchReplyDone()` 等基础设施是站点无关的通用函数，不需改动。

## 事件流

```
sendPrompt()
  ├─ watchReplyDone(kimi, ...)     // 已有
  ├─ watchReplyDone(doubao, ...)   // 已有
  └─ watchReplyDone(deepseek, ...) // 新增

captureAll()（手动截图按钮）
  ├─ captureLatestQA(kimi, ...)     // 已有
  ├─ captureLatestQA(doubao, ...)   // 已有
  └─ captureLatestQA(deepseek, ...) // 新增
```

## 边界情况

| 场景 | 处理 |
|------|------|
| `allMsg` 选择器全失效 | Layer 2 兜底：`[class*="ds-scroll-area"]` → `main` → `body` |
| 只有用户消息没 AI | `commonAncestor(lastUser, null)` 返回 lastUser，截用户区域 |
| 只有 AI 没用户 | 反向同理 |
| `ds-message` 同时含 `ds-markdown` 和普通文本 | `aiMarker` 检测只要有后代匹配即标为 AI |
| 120s 超时无内容 | 放弃截图，不写文件 |
| 120s 超时有内容 | 强制截图 |
| 虚拟列表卸载了最新消息 | 理论上不会——回复完成后页面自动滚到底部，最新消息在视口内 |

## 验证

1. `npm start` 启动，三个 webview 正常加载
2. DeepSeek 登录后进入聊天页面
3. 输入 prompt "Python 完整入门介绍"，发送
4. 等待 DeepSeek 回复完成
5. 检查 `screenshots/<timestamp>/deepseek.png`：包含完整用户问题 + AI 回复，无截断，无导航/侧栏杂项
6. 点手动截图按钮，DeepSeek 也正常出图
7. Console 输出 `deepseek 截图已保存: ...`
8. 检查 Console 无报错
