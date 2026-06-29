# PromptDesktop

三栏 AI 桌面端，同时使用 DeepSeek / Kimi / 豆包。

## 功能

- 三栏并排显示三个 AI 网页版
- 底部输入框一键同步发送 prompt 到三个 webview
- 一键截图，保存最新问答对到本地 PNG

## 安装

下载 [最新 Release](https://github.com/jiuming-gif/prompt-desktop/releases) 的 `PromptDesktop Setup x.x.x.exe`，双击安装。

## 开发

```bash
npm install
npm start
```

## 打包

```bash
npm run build          # NSIS 安装包 (dist/)
npm run build:portable # 便携版
```

## 截图位置

- 开发模式：项目根目录 `PromptDesktop截图/`
- 安装后：安装目录 `PromptDesktop截图/`
