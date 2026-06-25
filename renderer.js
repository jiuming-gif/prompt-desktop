const { ipcRenderer } = require('electron');
const deepseek = document.getElementById('webview-deepseek');
const kimi = document.getElementById('webview-kimi');
const doubao = document.getElementById('webview-doubao');
const input = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const screenshotBtn = document.getElementById('screenshot-btn');

// ============ 截图功能 ============

function captureWebview(webview, name) {
  const webContentsId = webview.getWebContentsId();
  if (!webContentsId) {
    console.warn(`${name}: webview 尚未加载，跳过截图`);
    return;
  }
  ipcRenderer.send('screenshot-webview', { webviewId: webContentsId, name });
}

function captureAll() {
  captureWebview(deepseek, 'deepseek');
  captureWebview(kimi, 'kimi');
  captureWebview(doubao, 'doubao');
}

ipcRenderer.on('screenshot-saved', (event, { filepath, name }) => {
  console.log(`${name} 截图已保存: ${filepath}`);
});

// ============ 回复完成检测 ============

function watchReplyDone(webview, name) {
  const observerJs = `
    (function() {
      if (window.__replyWatcher) return;
      window.__replyWatcher = true;
      let timer = null;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          observer.disconnect();
          window.__replyDone = true;
        }, 3000);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        window.__replyDone = true;
      }, 120000);
    })();
  `;

  webview.executeJavaScript(observerJs).catch(() => {});

  const poll = setInterval(() => {
    webview.executeJavaScript('window.__replyDone === true').then(done => {
      if (done) {
        clearInterval(poll);
        webview.executeJavaScript('delete window.__replyDone; delete window.__replyWatcher;').catch(() => {});
        captureWebview(webview, name);
      }
    }).catch(() => {});
  }, 2000);
}

// ============ 发送逻辑 ============

function sendPrompt(prompt) {
  if (!prompt.trim()) return;

  const webviews = [
    { webview: deepseek, name: 'deepseek' },
    { webview: kimi, name: 'kimi' },
    { webview: doubao, name: 'doubao' },
  ];

  webviews.forEach(({ webview, name }) => {
    if (webview.isLoading()) {
      webview.addEventListener('did-stop-loading', () => {
        injectPrompt(webview, prompt);
        watchReplyDone(webview, name);
      }, { once: true });
    } else {
      injectPrompt(webview, prompt);
      watchReplyDone(webview, name);
    }
  });

  input.value = '';
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

screenshotBtn.addEventListener('click', captureAll);

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
