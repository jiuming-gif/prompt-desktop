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
      '[class*="flex-row"][class*="w-full"][class*="justify-end"]:not([class*="message-action-bar"])',
    ],
    aiMsg: [
      '[data-message-id]',
    ],
    chatContainer: [
      '[class*="message-list"]',
      'main',
    ],
  },
  deepseek: {
    userMsg: [
      '[class*="ds-message"]:not(:has([class*="ds-markdown"]))',
    ],
    aiMsg: [
      '[class*="ds-message"]:has([class*="ds-markdown"])',
      '[class*="ds-markdown"]',
    ],
    chatContainer: [
      '[class*="ds-scroll"]',
      'main',
    ],
  },
};

// ============ html2canvas 加载 ============

const html2canvasCode = (function() {
  try {
    let code = fs.readFileSync(
      path.join(__dirname, 'node_modules', 'html2canvas', 'dist', 'html2canvas.min.js'),
      'utf-8'
    );
    // 修复 html2canvas v1.4.1 parseComponentValues bug:
    // consumeComponentValue 可能返回 undefined，导致 e.type 崩溃
    var patched = code.replace(
      /parseComponentValues=function\(\)\{for\(var (\w)=\[\];;\)\{var (\w)=this\.consumeComponentValue\(\);if\(32===\2\.type\)return \1;\1\.push\(\2\),\1\.push\(\)\}\}/g,
      'parseComponentValues=function(){for(var $1=[];;){var $2=this.consumeComponentValue();if(!$2||32===$2.type)return $1;$1.push($2)}}'
    );
    if (patched === code) {
      console.warn('html2canvas: parseComponentValues patch did not match — html2canvas may have upgraded');
    }
    return patched;
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

      // 虚拟滚动：先滚到底确保最新消息在 DOM 中
      for (var _si = 0; _si < C.chatContainer.length; _si++) {
        var _sc = document.querySelector(C.chatContainer[_si]);
        if (_sc && _sc.scrollHeight > _sc.clientHeight + 50) {
          _sc.scrollTop = _sc.scrollHeight;
          break;
        }
      }

      setTimeout(function() {

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

      for (var i = 0; i < C.userMsg.length; i++) {
        userEls = queryAllSafe(C.userMsg[i]);
        if (userEls.length > 0) break;
      }
      for (var i = 0; i < C.aiMsg.length; i++) {
        aiEls = queryAllSafe(C.aiMsg[i]);
        if (aiEls.length > 0) break;
      }

      // 过滤不可见元素（opacity-0 / pointer-events-none 占位 spacer 等）
      function isMessageVisible(el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        // className 检测 spacer 模式：同时含 opacity-0 + pointer-events-none
        var cls = el.className || '';
        if (typeof cls === 'string') {
          if (cls.indexOf('opacity-0') !== -1 && cls.indexOf('pointer-events-none') !== -1) return false;
        }
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (cs.opacity === '0') return false;
        return true;
      }
      userEls = userEls.filter(isMessageVisible);
      aiEls = aiEls.filter(isMessageVisible);

      var firstUser = userEls[0];
      var firstAI = aiEls[0];
      lastUser = userEls[userEls.length - 1];
      lastAI = aiEls[aiEls.length - 1];

      var _hasDataMsgId = !!document.querySelector("[data-message-id]");
      function upgradeToWrapper(el) {
        if (!el || !el.closest) return el;
        if (el.hasAttribute && el.hasAttribute("data-message-id")) return el;
        var w = el.closest("[data-message-id]");
        if (w) return w;
        if (el.hasAttribute && el.hasAttribute("data-streaming")) return el;
        if (el.hasAttribute && el.hasAttribute("data-observe-row")) return el;
        // ds-markdown 需提升到父级 ds-message（DeepSeek fallback selector 命中内容层）
        var uCls = el.className || '';
        if (typeof uCls === 'string' && uCls.indexOf('ds-markdown') !== -1 && uCls.indexOf('ds-message') === -1) {
          var mp = el.closest('[class*="ds-message"]');
          if (mp) return mp;
        }
        // 兜底：用户消息无 data-message-id（豆包等），先走父级 grid/max-w 检测
        if (_hasDataMsgId) {
          var p = el.parentElement;
          while (p && p !== document.body) {
            var cls = p.className || "";
            if (typeof cls === "string") {
              if (cls.indexOf("grid-cols") !== -1) return p;
              if (cls.indexOf("max-w-") !== -1 && cls.indexOf("max-w-full") === -1) return p;
            }
            if (p.offsetWidth > 150 && p.offsetHeight > 0) return p;
            p = p.parentElement;
          }
        }
        // 自身够大且无 data-message-id 体系 → 直接用
        if (el.offsetWidth > 150 && el.offsetHeight > 0) return el;
        return el;
      }
      firstUser = upgradeToWrapper(firstUser);
      firstAI = upgradeToWrapper(firstAI);
      lastUser = upgradeToWrapper(lastUser);
      lastAI = upgradeToWrapper(lastAI);

      // 找截图容器：优先 LCA，若 LCA 结果是视口级 wrapper 则改用 chatContainer，兜底 main/body
      var container = null;

      function findLCA(a, b) {
        if (!a || !b) return null;
        var path = [];
        var n = a;
        while (n) { path.push(n); n = n.parentElement; }
        n = b;
        while (n) {
          if (path.indexOf(n) !== -1) {
            var r = n.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return n;
          }
          n = n.parentElement;
        }
        return null;
      }

      if (firstUser && lastAI) {
        container = findLCA(firstUser, lastAI);
      }

      // LCA 可能走到视口级 wrapper（scrollHeight ≈ viewport → 不是真正的滚动容器），
      // 改用 chatContainer CSS 选择器获取真实内容高度。
      if (container && container.scrollHeight <= window.innerHeight * 1.1) { // 1.1× 容忍浮点误差
        for (var i = 0; i < C.chatContainer.length; i++) {
          var c = document.querySelector(C.chatContainer[i]);
          if (c && c.scrollHeight > container.scrollHeight * 1.2) { // 显著更高才是真滚动容器
            container = c;
            break;
          }
        }
      }

      if (!container) {
        for (var i = 0; i < C.chatContainer.length; i++) {
          var c = document.querySelector(C.chatContainer[i]);
          if (c) { container = c; break; }
        }
        if (!container) container = document.querySelector('main') || document.body;
      }

      // 容器 rect 为 0x0（如 display:contents），往上找有尺寸的祖先
      var cr = container.getBoundingClientRect();
      if (cr.width === 0 || cr.height === 0) {
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

      // 精炼容器：优先用含有消息的子元素，防 LCA 走到全局包裹层
      if (firstUser && lastAI) {
        var fur2 = firstUser.getBoundingClientRect();
        var lar2 = lastAI.getBoundingClientRect();
        var contentSpan = lar2.bottom - fur2.top;
        var cbr2 = container.getBoundingClientRect();

        // 消息溢出容器（如用户消息 position:absolute 跑到容器上方）→ 往上找包含祖先
        if (fur2.top < cbr2.top - 4 || lar2.bottom > cbr2.bottom + 4) {
          var p = container.parentElement;
          while (p && p !== document.documentElement) {
            var pr = p.getBoundingClientRect();
            if (pr.top <= fur2.top + 2 && pr.bottom >= lar2.bottom - 2) {
              container = p;
              cbr2 = pr;
              break;
            }
            p = p.parentElement;
          }
        }

        // 消息内容远大于容器高度 → 虚拟滚动，找内部滚动容器
        if (contentSpan > container.scrollHeight * 1.3) { // 1.3× 阈值防误判
          var children = container.children;
          for (var k = 0; k < children.length; k++) {
            if (children[k].scrollHeight > container.scrollHeight * 1.2) { // 子元素显著更高 → 真滚动容器
              container = children[k];
              break;
            }
          }
          if (container.scrollHeight < contentSpan * 0.8) { // 仍远小于消息跨度 → 继续找
            var wrappers = container.querySelectorAll('[class*="virtual"], [class*="inner"], [class*="message-list"], [class*="chat-list"], [class*="list"]');
            for (var w = 0; w < wrappers.length; w++) {
              if (wrappers[w].scrollHeight > container.scrollHeight * 1.2) { // 显著更高 → 真滚动容器
                container = wrappers[w];
                break;
              }
            }
          }
        }
        // 容器在视口顶部且占满视口 → 可能是 body 级包裹层，往下找更聚焦的子元素
        cbr2 = container.getBoundingClientRect();
        if (cbr2.top <= 2 && cbr2.height >= window.innerHeight * 0.9 && container.children.length <= 3) { // 占满视口的 body 级包裹层
          for (var k = 0; k < container.children.length; k++) {
            var childRect = container.children[k].getBoundingClientRect();
            var childContainsUser = childRect.top <= fur2.top && childRect.bottom >= fur2.bottom;
            if (childContainsUser && childRect.height > 100) {
              container = container.children[k];
              break;
            }
          }
        }
      }

      window.__shotDebug = JSON.stringify({
        site: '${siteKey}',
        userEls: userEls.length,
        aiEls: aiEls.length,
        containerTag: container.tagName,
        containerCls: (container.className || '').slice(0, 120),
        containerId: container.id || '',
        firstUserTag: firstUser ? firstUser.tagName : null,
        firstAITag: firstAI ? firstAI.tagName : null,
        lastUserTag: lastUser ? lastUser.tagName : null,
        lastAITag: lastAI ? lastAI.tagName : null,
        lastUserCls: lastUser ? (lastUser.className || '').slice(0, 100) : null,
        lastAICls: lastAI ? (lastAI.className || '').slice(0, 100) : null,
        firstUserRect: firstUser ? JSON.stringify(firstUser.getBoundingClientRect()) : null,
        firstAIRect: firstAI ? JSON.stringify(firstAI.getBoundingClientRect()) : null,
        lastUserRect: lastUser ? JSON.stringify(lastUser.getBoundingClientRect()) : null,
        lastAIRect: lastAI ? JSON.stringify(lastAI.getBoundingClientRect()) : null,
        containerRect: JSON.stringify(container.getBoundingClientRect()),
        containerScrollTop: container.scrollTop || 0,
        containerScrollHeight: container.scrollHeight,
        lastAI_scrollHeight: lastAI ? lastAI.scrollHeight : null,
        lastAI_childCount: lastAI ? lastAI.children.length : null,
        lastAI_textLen: lastAI ? (lastAI.textContent || '').length : null,
      });

      function doShot() {
        if (window.__shotInProgress) return;
        window.__shotInProgress = true;
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

        // 容器扩展：当消息内容超出容器 bounds 时，临时撑开容器防止 html2canvas 裁剪
        var _cssBackup = {};
        if (firstUser && lastAI) {
          var _allEls = userEls.concat(aiEls);
          var _minY = Infinity, _maxY = -Infinity;
          for (var _t = 0; _t < _allEls.length; _t++) {
            var _r = _allEls[_t].getBoundingClientRect();
            if (_r.top < _minY) _minY = _r.top;
            if (_r.bottom > _maxY) _maxY = _r.bottom;
          }
          var _cbr = container.getBoundingClientRect();
          if (_minY < _cbr.top - 8 || _maxY > _cbr.bottom + 8) {
            _cssBackup.overflow = container.style.overflow;
            _cssBackup.height = container.style.height;
            container.style.overflow = 'visible';
            container.style.height = Math.max(_cbr.height, container.scrollHeight + 16) + 'px';
          }
        }

        function restoreContainer() {
          if (_cssBackup.overflow !== undefined) container.style.overflow = _cssBackup.overflow;
          if (_cssBackup.height !== undefined) container.style.height = _cssBackup.height;
          window.__shotInProgress = false;
        }

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
          restoreContainer();
          // 裁剪到对话包围盒（fullConversation 则全对话，否则最新一对）
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
          restoreContainer();
          window.__shotResult = JSON.stringify({ error: err.message });
        });
      }

      doShot();
      }, 350); })();
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
          ipcRenderer.send('write-debug-file', { name: `shot-debug-${name}.json`, data: debugRaw });
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
          ipcRenderer.send('write-debug-file', { name: `diag-${siteKey}.json`, data: JSON.stringify(diag, null, 2) });
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
  diagnoseDOM(deepseek, 'deepseek');
  const folder = newScreenshotFolder();
  captureLatestQA(kimi, 'kimi', folder);
  captureLatestQA(doubao, 'doubao', folder);
  captureLatestQA(deepseek, 'deepseek', folder);
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
