# 豆包截图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Doubao screenshot using existing html2canvas pipeline via `allMsg` path with two bug fixes.

**Architecture:** Single-file change to `renderer.js` — add `doubao` entry to SITE config using `allMsg: ['[data-message-id]']`, fix alignment detection (traversal start + AI fallback), wire doubao into `captureAll()` and `sendPrompt()`. All infrastructure (html2canvas injection, polling, crop logic, reply detection) already generic.

**Tech Stack:** Electron 33, html2canvas 1.4.1

## Global Constraints

- Kimi screenshot pipeline unchanged — only add doubao, don't touch kimi config or logic
- Zero DOM modification — only `querySelectorAll` reads
- `[data-message-id]` is the stable message identifier for Doubao
- `justify-end` on the element itself (not parent) distinguishes user messages
- AI messages have no alignment class — fallback to default-as-AI
- `stopTexts: ['停止生成', 'AI 生成中']` checked during reply-completion detection
- Timestamp subfolder: `screenshots/YYYYMMDD_hhmmss/`
- File naming: `doubao.png`

---

### Task 1: Add doubao SITE config + fix allMsg alignment detection + wire event flow

**Files:**
- Modify: `renderer.js`

**Interfaces:**
- Consumes: `SITE` object (add `doubao` key)
- Consumes: `injectScreenshotJS()` allMsg branch (fix alignment traversal)
- Consumes: `captureAll()` (add doubao call)
- Consumes: `sendPrompt()` (add doubao watchReplyDone call)
- Produces: doubao screenshots via existing `ipcRenderer.send('screenshot-data', ...)`

- [ ] **Step 1: Add `doubao` config to SITE object (line 29, before `};`)**

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

- [ ] **Step 2: Fix alignment detection — traversal start (line 195)**

Replace:
```js
          var p = el.parentElement;
```
With:
```js
          var p = el;
```

- [ ] **Step 3: Fix alignment detection — AI fallback (after line 205, before `if (found)` on line 206)**

After the while loop closing `}` on line 205, insert:
```js
          if (!found) { isUser = false; found = true; }
```

- [ ] **Step 4: Wire doubao into `captureAll()` (line 577-581)**

Replace:
```js
function captureAll() {
  // 仅 Kimi 截图
  diagnoseDOM(kimi, 'kimi');
  const folder = newScreenshotFolder();
  captureLatestQA(kimi, 'kimi', folder);
}
```
With:
```js
function captureAll() {
  diagnoseDOM(kimi, 'kimi');
  diagnoseDOM(doubao, 'doubao');
  const folder = newScreenshotFolder();
  captureLatestQA(kimi, 'kimi', folder);
  captureLatestQA(doubao, 'doubao', folder);
}
```

- [ ] **Step 5: Wire doubao into `sendPrompt()` (line 67)**

After:
```js
  watchReplyDone(kimi, 'kimi', folder);
```
Add:
```js
  watchReplyDone(doubao, 'doubao', folder);
```

- [ ] **Step 6: Verify syntax**

```powershell
node -c renderer.js
```
Expected: no output (syntax OK)

- [ ] **Step 7: Commit**

```bash
git add renderer.js
git commit -m "feat: enable Doubao screenshot via allMsg path with alignment detection fixes"
```

---

## Execution Order

```
Task 1 (single task, all changes in renderer.js)
```

## Verification Checklist

1. `npm start` — app launches, three webviews load (DeepSeek, Kimi, Doubao)
2. Type "Python 完整入门介绍" and press Enter
3. Wait for Doubao to finish generating
4. Check `screenshots/<timestamp>/doubao.png`:
   - Contains full user question + AI response
   - No truncation
   - No sidebar/navigation artifacts
5. Click manual screenshot button — Doubao captured again
6. Console shows `doubao 截图已保存: ...`
7. Kimi screenshots still work (regression check)
