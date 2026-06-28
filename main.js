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
