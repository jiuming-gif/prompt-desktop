const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const deepseek = document.getElementById('webview-deepseek');
const kimi = document.getElementById('webview-kimi');
const doubao = document.getElementById('webview-doubao');
// DeepSeek 截图已移除，Kimi + 豆包截图启用
const input = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const screenshotBtn = document.getElementById('screenshot-btn');

// ============ 站点选择器（只读，不修改 DOM）============

const SITE = {
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
    allMsg: ['[data-message-id]'],
    chatContainer: [
      '[class*="message-list"]',
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
  watchReplyDone(kimi, 'kimi', folder);
  watchReplyDone(doubao, 'doubao', folder);
}

function injectPrompt(webview, prompt) {
  const js = `
    (function() {
      const prompt = ${JSON.stringify(prompt)};

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

      var lastUser = null;
      var lastAI = null;

      // Layer 1: 定位最新 user + AI 消息
      var userEls = [];
      var aiEls = [];

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
      } else {
        // Kimi / DeepSeek 路径：CSS 选择器分别匹配 user 和 AI
        for (var i = 0; i < C.userMsg.length; i++) {
          userEls = queryAllSafe(C.userMsg[i]);
          if (userEls.length > 0) break;
        }
        for (var i = 0; i < C.aiMsg.length; i++) {
          aiEls = queryAllSafe(C.aiMsg[i]);
          if (aiEls.length > 0) break;
        }
      }
      lastUser = userEls[userEls.length - 1];
      lastAI = aiEls[aiEls.length - 1];

      function upgradeToWrapper(el) {
        if (!el || !el.closest) return el;
        if (el.hasAttribute && el.hasAttribute("data-message-id")) return el;
        var w = el.closest("[data-message-id]");
        if (w) return w;
        // 兜底：用户消息无 data-message-id，从气泡往上走到 grid 容器
        if (document.querySelector("[data-message-id]")) {
          var p = el.parentElement;
          while (p && p !== document.body) {
            var cls = p.className || "";
            if (typeof cls === "string" && cls.indexOf("grid-cols") !== -1) return p;
            if (p.offsetWidth > 150) return p;
            p = p.parentElement;
          }
        }
        return el;
      }
      lastUser = upgradeToWrapper(lastUser);
      lastAI = upgradeToWrapper(lastAI);

      // 找截图容器：优先聊天列表容器，兜底 main/body
      var container = null;
      for (var i = 0; i < C.chatContainer.length; i++) {
        var c = document.querySelector(C.chatContainer[i]);
        if (c) { container = c; break; }
      }
      if (!container) container = document.querySelector('main') || document.body;

      // 容器 rect 为 0x0（如 DeepSeek ds-scroll-area display:contents），往上找有尺寸的祖先
      var cr = container.getBoundingClientRect();
      if (cr.width === 0 && cr.height === 0) {
        var p = container.parentElement;
        while (p && p !== document.documentElement) {
          var pr = p.getBoundingClientRect();
          if (pr.width > 0 && pr.height > 0) { container = p; break; }
          p = p.parentElement;
        }
        if (!p) container = document.documentElement;
      }

      if (!container) {
        window.__shotResult = JSON.stringify({ error: 'no element found' });
        return;
      }

      window.__shotDebug = JSON.stringify({
        site: '${siteKey}',
        userEls: userEls.length,
        aiEls: aiEls.length,
        containerTag: container.tagName,
        containerCls: (container.className || '').slice(0, 120),
        containerId: container.id || '',
        hasAllMsg: !!C.allMsg,
        lastUserTag: lastUser ? lastUser.tagName : null,
        lastAITag: lastAI ? lastAI.tagName : null,
        lastUserCls: lastUser ? (lastUser.className || '').slice(0, 100) : null,
        lastAICls: lastAI ? (lastAI.className || '').slice(0, 100) : null,
        lastUserRect: lastUser ? JSON.stringify(lastUser.getBoundingClientRect()) : null,
        lastAIRect: lastAI ? JSON.stringify(lastAI.getBoundingClientRect()) : null,
        containerRect: JSON.stringify(container.getBoundingClientRect()),
        containerScrollTop: container.scrollTop || 0,
        containerScrollHeight: container.scrollHeight,
      });

      function doShot() {
        var shotDone = false;
        // 修复 html2canvas 在 DeepSeek addColorStop 非有限值报错
        if (!window.__gradientPatched) {
          window.__gradientPatched = true;
          var _origAddColorStop = CanvasGradient.prototype.addColorStop;
          CanvasGradient.prototype.addColorStop = function(offset, color) {
            if (isFinite(offset)) { _origAddColorStop.call(this, offset, color); }
          };
        }
        // 超大容器降 scale 防 OOM 挂死
        var shotScale = container.scrollHeight > 6000 ? 1 : 2;
        // 15s 超时兜底，防止 html2canvas 挂死
        var timeout = setTimeout(function() {
          if (!shotDone) { shotDone = true; window.__shotResult = JSON.stringify({ error: 'html2canvas timeout' }); }
        }, 15000);

        window.html2canvas(container, {
          scale: shotScale,
          useCORS: true,
          allowTaint: true,
          backgroundColor: '#ffffff',
          logging: false,
        }).then(function(canvas) {
          if (shotDone) return;
          shotDone = true;
          clearTimeout(timeout);
          // 如果同时拿到 user 和 AI，裁剪到二者的包围盒
          if (lastUser && lastAI) {
            var cr = container.getBoundingClientRect();
            var ur = lastUser.getBoundingClientRect();
            var ar = lastAI.getBoundingClientRect();
            var st = container.scrollTop || 0;
            var PAD = 8; // 上下留白
            var relTop = Math.min(ur.top, ar.top) - cr.top + st - PAD;
            var relBottom = Math.max(ur.bottom, ar.bottom) - cr.top + st;
            // 扩展底部：AI 消息的操作按钮（点赞/复制等）常在 data-message-id 包裹外
            var wrapper = lastAI.closest ? (lastAI.closest('[data-message-id]') || lastAI) : lastAI;
            var next = wrapper.nextElementSibling;
            while (next && !(next.hasAttribute && next.hasAttribute('data-message-id'))) {
              if (next.querySelector && (next.querySelector('button') || next.querySelector('[role="button"]'))) {
                var nr = next.getBoundingClientRect();
                var nBottom = nr.bottom - cr.top + st;
                if (nBottom > relBottom) relBottom = nBottom;
                break;
              }
              next = next.nextElementSibling;
            }
            relBottom += PAD;
            var relLeft = 0; // 宽度取容器全宽，避免截断代码块
            var relRight = cr.width;

            var cropW = (relRight - relLeft) * shotScale;
            var cropH = (relBottom - relTop) * shotScale;
            var cropX = relLeft * shotScale;
            var cropY = relTop * shotScale;

            // 防止越界
            if (cropX < 0) cropX = 0;
            if (cropY < 0) cropY = 0;
            if (cropX + cropW > canvas.width) cropW = canvas.width - cropX;
            if (cropY + cropH > canvas.height) cropH = canvas.height - cropY;
            if (cropW <= 0 || cropH <= 0) {
              window.__shotResult = canvas.toDataURL('image/png');
              return;
            }

            var crop = document.createElement('canvas');
            crop.width = cropW;
            crop.height = cropH;
            var ctx = crop.getContext('2d');
            ctx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
            window.__shotResult = crop.toDataURL('image/png');
          } else {
            // 兜底：全容器截图
            window.__shotResult = canvas.toDataURL('image/png');
          }
        }).catch(function(err) {
          if (shotDone) return;
          shotDone = true;
          clearTimeout(timeout);
          window.__shotResult = JSON.stringify({ error: err.message });
        });
      }

      doShot();
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
      webview.executeJavaScript('window.__shotDebug').then(debugRaw => {
        if (debugRaw) {
          try { fs.writeFileSync(path.join(__dirname, `.shot-debug-${name}.json`), debugRaw, 'utf-8'); } catch(_) {}
          webview.executeJavaScript('delete window.__shotDebug;').catch(() => {});
        }
      }).catch(() => {});

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

// ============ DOM 诊断：发现真实选择器 ============

function diagnoseDOM(webview, siteKey) {
  const js = `
    (function() {
      var result = { classPrefixes: [], textContainers: [], roles: [], dataAttrs: [] };

      // 收集所有 class 前缀模式（取 - 或 _ 之前的部分）
      var prefixCount = {};
      var allEls = document.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        var cls = allEls[i].className;
        if (!cls || typeof cls !== 'string') continue;
        var classes = cls.split(/\\s+/);
        for (var j = 0; j < classes.length; j++) {
          var c = classes[j].trim();
          if (!c || c.length < 2) continue;
          var prefix = c.match(/^([a-zA-Z]+(-[a-zA-Z]+)?)/);
          if (prefix) {
            var p = prefix[1].toLowerCase();
            prefixCount[p] = (prefixCount[p] || 0) + 1;
          }
        }
      }
      result.classPrefixes = Object.entries(prefixCount)
        .filter(function(e) { return e[1] > 3; })
        .sort(function(a, b) { return b[1] - a[1]; })
        .slice(0, 30)
        .map(function(e) { return e[0] + ':' + e[1]; });

      // 找包含大量文本的叶子元素（可能是消息气泡）
      var textEls = [];
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        if (el.children.length > 0) continue;
        var text = el.textContent.trim();
        if (text.length > 80) {
          textEls.push({
            tag: el.tagName.toLowerCase(),
            cls: el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).slice(0, 8).join(' ') : '',
            parentCls: el.parentElement && el.parentElement.className && typeof el.parentElement.className === 'string'
              ? el.parentElement.className.split(/\\s+/).slice(0, 8).join(' ') : '',
            textLen: text.length,
            textPreview: text.slice(0, 60)
          });
        }
      }
      result.textContainers = textEls.slice(-15);

      // 收集 role 属性
      var roles = new Set();
      for (var i = 0; i < allEls.length; i++) {
        var r = allEls[i].getAttribute('role');
        if (r) roles.add(r);
      }
      result.roles = Array.from(roles);

      // 收集 data-* 属性名
      var dataSet = new Set();
      for (var i = 0; i < allEls.length; i++) {
        var attrs = allEls[i].attributes;
        for (var j = 0; j < attrs.length; j++) {
          if (attrs[j].name.startsWith('data-')) dataSet.add(attrs[j].name);
        }
      }
      result.dataAttrs = Array.from(dataSet);

      // 找消息类元素结构（匹配常见消息选择器）
      var msgSels = ['[data-message-id]', '[class*="chat-item"]', '[class*="message"]', '[class*="bubble"]',
                      '[class*="ds-markdown"]', '[class*="user"]', '[class*="assistant"]',
                      '[data-author]', '[data-role]'];
      var msgSamples = [];
      for (var s = 0; s < msgSels.length; s++) {
        try {
          var els = document.querySelectorAll(msgSels[s]);
          if (els.length > 0) {
            var samples = [];
            for (var e = 0; e < Math.min(els.length, 3); e++) {
              var el = els[e];
              var allAttrs = [];
              for (var a = 0; a < el.attributes.length; a++) {
                allAttrs.push(el.attributes[a].name + '="' + el.attributes[a].value.slice(0, 40) + '"');
              }
              samples.push({
                tag: el.tagName.toLowerCase(),
                cls: (el.className && typeof el.className === 'string') ? el.className.split(/\\s+/).slice(0, 12).join(' ') : '',
                attrs: allAttrs.slice(0, 10).join(' | ')
              });
            }
            msgSamples.push({ sel: msgSels[s], count: els.length, samples: samples });
          }
        } catch(e) {}
      }
      result.msgSamples = msgSamples;

      window.__domDiag = JSON.stringify(result);

      // 同时在 webview 内部控制台输出，方便直接查看
      console.log('%c═══ DOM诊断: ${siteKey} ═══', 'font-weight:bold;font-size:14px;color:#00bcd4;');
      console.log('class前缀(top30):', result.classPrefixes.join(', '));
      console.log('消息元素匹配:');
      msgSamples.forEach(function(m) {
        console.log('  ' + m.sel + ' → ' + m.count + '个', JSON.stringify(m.samples, null, 2));
      });
      console.log('文本容器(末尾15):', JSON.stringify(result.textContainers, null, 2));
      console.log('role属性:', result.roles.join(', ') || '(无)');
      console.log('data-*属性:', result.dataAttrs.join(', ') || '(无)');
    })();
  `;

  webview.executeJavaScript(js).then(() => {
    // 轮询拿结果
    function pollDiag() {
      webview.executeJavaScript('window.__domDiag').then(raw => {
        if (!raw) { setTimeout(pollDiag, 300); return; }
        webview.executeJavaScript('delete window.__domDiag;').catch(() => {});
        try {
          const diag = JSON.parse(raw);
          // 临时：写文件便于调试选择器
          try { fs.writeFileSync(path.join(__dirname, `.diag-${siteKey}.json`), JSON.stringify(diag, null, 2), 'utf-8'); } catch(_) {}
          console.log(`%c[DOM诊断] ${siteKey}`, 'font-weight:bold;color:#00bcd4;');
          console.log('  class前缀(top30):', diag.classPrefixes.join(', '));
          console.log('  消息元素匹配:', diag.msgSamples);
          console.log('  文本容器(末尾15):', diag.textContainers);
          console.log('  role属性:', diag.roles.join(', ') || '(无)');
          console.log('  data-*属性:', diag.dataAttrs.join(', ') || '(无)');
        } catch (e) {
          console.warn(`${siteKey}: 诊断解析失败 - ${e.message}`);
        }
      }).catch(() => { setTimeout(pollDiag, 300); });
    }
    setTimeout(pollDiag, 200);
  }).catch(err => {
    console.error(`${siteKey}: 诊断注入失败 - ${err.message}`);
  });
}

// ============ 截图入口 ============

function captureAll() {
  diagnoseDOM(kimi, 'kimi');
  diagnoseDOM(doubao, 'doubao');
  const folder = newScreenshotFolder();
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
          ${config.stopTexts ? `var stopTexts = ${JSON.stringify(config.stopTexts)};
          var bodyText = document.body.textContent;
          for (var i = 0; i < stopTexts.length; i++) {
            if (bodyText.indexOf(stopTexts[i]) !== -1) {
              return; // 停止按钮还在，等下一次 mutation
            }
          }` : ''}
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
    // 超时兜底: 120s + 10s margin, 65 polls * 2s = 130s
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

ipcRenderer.on('screenshot-error', (event, { name, error }) => {
  console.error(`${name} 截图失败: ${error}`);
});
