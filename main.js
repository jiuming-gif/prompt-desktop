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
    event.reply('screenshot-error', { name, error: '无效 dataURL' });
    return;
  }

  const base = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
  const dir = path.join(base, 'PromptDesktop截图', folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filepath = path.join(dir, `${name}.png`);
  const base64 = dataURL.replace('data:image/png;base64,', '');

  try {
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
    event.reply('screenshot-ok', { name, filepath });
  } catch (e) {
    console.error(`${name}: 写文件失败 - ${e.message}`);
    event.reply('screenshot-error', { name, error: e.message });
  }
});

// ============ 调试文件写入（renderer 通过 IPC 请求 main process 写盘）============

ipcMain.on('write-debug-file', (event, { name, data }) => {
  const dir = path.join(app.getPath('userData'), 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, name), data, 'utf-8');
  } catch (_) {}
});
