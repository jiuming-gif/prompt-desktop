# DeepSeek Screenshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable DeepSeek screenshot capture by adding SITE config and wiring into existing html2canvas pipeline.

**Architecture:** Single-file change to renderer.js. Add `deepseek` entry to SITE object with `allMsg` + `aiMarker` strategy, extend `allMsg` branch with descendant detection for user/AI distinction, wire `watchReplyDone` and `captureLatestQA` calls.

**Tech Stack:** Electron webview, html2canvas 1.4.1, vanilla JS

## Global Constraints

- Zero new dependencies
- Do not modify main.js, index.html, style.css, package.json
- Follow existing SITE config pattern (doubao `allMsg` path)
- `aiMarker` detection must coexist with doubao's `justify-end`/`justify-start` detection without interference

---

### Task 1: Add DeepSeek SITE config + aiMarker discrimination logic

**Files:**
- Modify: `renderer.js` (SITE object ~line 30, allMsg branch ~line 220)

**Interfaces:**
- Consumes: `SITE` object structure, `allMsg` branch in `injectScreenshotJS`
- Produces: `deepseek` config with `allMsg`, `aiMarker`, `chatContainer`, `stopTexts`; extended `allMsg` path that checks `C.aiMarker`

- [ ] **Step 1: Add deepseek entry to SITE object**

After the `doubao` entry (~line 37), add:

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

- [ ] **Step 2: Add aiMarker descendant detection in allMsg branch**

In `injectScreenshotJS()`, inside the `if (C.allMsg)` block, wrap the existing doubao parent-class loop with a branch on `C.aiMarker`:

Replace this (~line 195-220):
```js
      if (C.allMsg) {
        // 豆包路径：单一选择器匹配所有消息，JS 检查父元素对齐区分 user/AI
        var allEls = [];
        for (var i = 0; i < C.allMsg.length; i++) {
          allEls = queryAllSafe(C.allMsg[i]);
          if (allEls.length > 0) break;
        }
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
```

With:
```js
      if (C.allMsg) {
        var allEls = [];
        for (var i = 0; i < C.allMsg.length; i++) {
          allEls = queryAllSafe(C.allMsg[i]);
          if (allEls.length > 0) break;
        }

        if (C.aiMarker) {
          // DeepSeek 路径：后代检测 ds-markdown → AI，否则 → 用户
          for (var i = 0; i < allEls.length; i++) {
            var el = allEls[i];
            var hasMarker = !!el.querySelector('[class*="' + C.aiMarker + '"]');
            if (hasMarker) aiEls.push(el);
            else userEls.push(el);
          }
        } else {
          // 豆包路径：父元素对齐类检测（justify-end / justify-start）
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
```

- [ ] **Step 3: Verify syntax — no missing braces or orphaned else**

Check that the `if (C.aiMarker)` / `else` blocks are properly closed and the outer `if (C.allMsg)` remains balanced. The `else` block is the existing doubao code, unchanged.

- [ ] **Step 4: Commit**

```bash
git add renderer.js
git commit -m "feat(deepseek): add SITE config and aiMarker descendant detection for screenshot

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Wire DeepSeek into captureAll and sendPrompt

**Files:**
- Modify: `renderer.js` (`captureAll()` ~line 586, `sendPrompt()` ~line 56)

**Interfaces:**
- Consumes: `captureLatestQA()`, `watchReplyDone()`, `diagnoseDOM()` — all already defined
- Produces: DeepSeek webview participates in auto + manual screenshot flows

- [ ] **Step 1: Add watchReplyDone for deepseek in sendPrompt()**

In `sendPrompt()`, after `watchReplyDone(doubao, 'doubao', folder)` (~line 75), add:

```js
watchReplyDone(deepseek, 'deepseek', folder);
```

- [ ] **Step 2: Add captureLatestQA and diagnoseDOM for deepseek in captureAll()**

In `captureAll()`, after the doubao calls (~line 591-592), add:

```js
diagnoseDOM(deepseek, 'deepseek');
captureLatestQA(deepseek, 'deepseek', folder);
```

The full `captureAll()` should read:

```js
function captureAll() {
  diagnoseDOM(kimi, 'kimi');
  diagnoseDOM(doubao, 'doubao');
  diagnoseDOM(deepseek, 'deepseek');
  const folder = newScreenshotFolder();
  captureLatestQA(kimi, 'kimi', folder);
  captureLatestQA(doubao, 'doubao', folder);
  captureLatestQA(deepseek, 'deepseek', folder);
}
```

- [ ] **Step 3: Commit**

```bash
git add renderer.js
git commit -m "feat(deepseek): wire screenshot capture into sendPrompt and captureAll

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Manual verification

- [ ] **Step 1: Start the app**

```bash
npm start
```

- [ ] **Step 2: Login to DeepSeek** in the leftmost webview panel

- [ ] **Step 3: Send a test prompt** — "Python 完整入门介绍" in the input field, click send

- [ ] **Step 4: Wait for DeepSeek reply to complete** — "停止生成" button should disappear

- [ ] **Step 5: Check screenshot output**

```bash
ls screenshots/*/deepseek.png
```

Open the file — verify: contains user question + full AI reply, no truncation, no nav/sidebar debris.

- [ ] **Step 6: Test manual screenshot button** — click screenshot button, verify second screenshot produced

- [ ] **Step 7: Check console** — verify `deepseek 截图已保存: ...` appears, no errors

- [ ] **Step 8: Check shot debug file**

```bash
cat .shot-debug-deepseek.json
```

Verify `userEls` and `aiEls` counts are > 0, `containerTag` is sensible.

- [ ] **Step 9: Regression check** — verify Kimi and Doubao screenshots still work. Check `screenshots/<timestamp>/kimi.png` and `doubao.png` exist and look correct.
