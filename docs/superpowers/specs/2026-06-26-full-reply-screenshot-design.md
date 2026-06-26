# 完整回复截图设计

## 问题

当前截图只捕获 webview 可视区域，最后一条 AI 回复如果超出视口则截不全。三个 webview（DeepSeek / Kimi / 豆包）都有此问题。

## 方案

模拟 DevTools「捕获节点截图」行为：临时拉高视口到目标元素完整高度，单次截图，截完恢复。

## 流程

1. webview 内执行 JS：逐步滚动强制渲染全部内容 → 滚回顶部
2. 查找最后一条 AI 回复 DOM 元素，返回 `{x, y, w, h}`
3. 主进程用 CDP `Emulation.setDeviceMetricsOverride` 临时设视口高度 = 元素底边（y + h）
4. `Page.captureScreenshot` 带 `clip` 参数截取该元素区域
5. `Emulation.clearDeviceMetricsOverride` 恢复原始视口
6. 保存 PNG

## 改动范围

### main.js

截图 IPC 处理增加视口操控步骤：

```js
// 1. 获取原始视口尺寸
const layout = await wc.debugger.sendCommand('Page.getLayoutMetrics');
const origWidth = layout.cssVisualViewport.clientWidth;
const origHeight = layout.cssVisualViewport.clientHeight;

// 2. 临时拉高视口
await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
  width: origWidth,
  height: Math.max(origHeight, y + h),  // 视口至少覆盖到元素底边
  deviceScaleFactor: 1,
  mobile: false,
});

// 3. 截图
const result = await wc.debugger.sendCommand('Page.captureScreenshot', {
  format: 'png',
  clip: { x, y, width: w, height: h, scale: 1 },
  captureBeyondViewport: true,
});

// 4. 恢复视口
await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
```

### renderer.js

`captureWebview` 函数基本不变，滚动+定位逻辑已有。唯一调整：确保返回的坐标基于文档（非视口），当前实现已用 `scrollX/scrollY` 偏移，无需改动。

## 选择器策略

现有选择器列表保持不变，按优先级依次尝试。如全部未命中则回退到全页截图（视口拉高到 scrollHeight）。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 临时拉高视口触发页面重排 | 滚动步骤已提前强制渲染，影响小 |
| 某些站点 max-height 限制内容区 | 截图前注入 CSS 临时移除（后续迭代） |
| setDeviceMetricsOverride 失败 | try/catch 包裹，失败则回退到当前行为 |

## 不做的事

- 不做分段截图拼接（单次截图够用）
- 不做整段对话长图（只截最后一条回复）
- 不做 PDF 转 PNG
- 不做 lazy-load 图片等待（滚动步骤已覆盖）
