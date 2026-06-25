const { app, BrowserWindow, ipcMain, webContents } = require('electron');
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

// 截图 IPC 处理
ipcMain.on('screenshot-webview', (event, { webviewId, name, folder, width, height }) => {
  const wc = webContents.fromId(webviewId);
  if (!wc) return;

  const screenshotDir = path.join(__dirname, 'screenshots', folder);
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

  const filename = `${name}.png`;
  const filepath = path.join(screenshotDir, filename);

  // 截取完整页面（含滚动区域）
  const rect = (width && height) ? { x: 0, y: 0, width, height } : undefined;

  wc.capturePage(rect).then(image => {
    fs.writeFileSync(filepath, image.toPNG());
    event.reply('screenshot-saved', { filepath, name, folder });
  }).catch(err => {
    console.error('截图失败:', err.message);
  });
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
