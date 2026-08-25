/**
 * main.js — DeepFusion Electron 主进程
 * 参考：dsh-desktop 的 Electron 模式 + Reasonix desktop 的 tray/single-instance/window-state
 * 
 * 功能：
 * - 单实例锁（app.requestSingleInstanceLock）
 * - 内置启动 Node server（ELECTRON_RUN_AS_NODE 模式）
 * - BrowserWindow 加载 http://127.0.0.1:43210
 * - 系统托盘（Tray：显示/隐藏/退出）
 * - 窗口状态保存/恢复（bounds + maximized）
 * - 退出时kill server
 */
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

const PORT = 43210;
const HOST = '127.0.0.1';
const TITLE = 'DeepFusion 深融';

let mainWindow = null;
let tray = null;
let serverProcess = null;
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

// ── 窗口状态 ──
function loadWindowState() {
  try {
    if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}
  return { width: 1280, height: 800 };
}
function saveWindowState(win) {
  try {
    if (!win || win.isMinimized() || win.isMaximized()) return;
    const bounds = win.getBounds();
    fs.writeFileSync(stateFile, JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized: win.isMaximized() }), 'utf8');
  } catch {}
}

// ── 启动内置 server ──
function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', 'src', 'server.js');
    if (!fs.existsSync(serverPath)) {
      reject(new Error('server.js 不存在: ' + serverPath));
      return;
    }
    // 用 ELECTRON_RUN_AS_NODE 以纯 Node 模式跑 server.js（打包后也能用）
    serverProcess = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    serverProcess.stdout.on('data', (d) => console.log('[server]', d.toString().trim()));
    serverProcess.stderr.on('data', (d) => console.error('[server-err]', d.toString().trim()));
    serverProcess.on('error', (e) => reject(e));
    serverProcess.on('exit', (code) => {
      console.log('[server] 退出, code=' + code);
      serverProcess = null;
    });

    // 轮询等待端口就绪
    const poll = () => {
      const req = http.request({ hostname: HOST, port: PORT, path: '/api/health', method: 'GET', timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (d) => body += d);
        res.on('end', () => { if (res.statusCode === 200) resolve(); else setTimeout(poll, 500); });
      });
      req.on('error', () => setTimeout(poll, 500));
      req.on('timeout', () => { req.destroy(); setTimeout(poll, 500); });
      req.end();
    };
    setTimeout(poll, 500);
  });
}

// ── 创建窗口 ──
function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width || 1280,
    height: state.height || 800,
    x: state.x,
    y: state.y,
    title: TITLE,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  });

  mainWindow.loadURL('http://' + HOST + ':' + PORT + '/');
  mainWindow.once('ready-to-show', () => { mainWindow.show(); });
  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });

  // 窗口状态变化保存
  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move', () => saveWindowState(mainWindow));
}

// ── 托盘（参考 Reasonix tray.go）──
function createTray() {
  // 16x16 简单图标（electron 默认图标或生成）
  let icon = null;
  try {
    const iconPath = path.join(__dirname, 'icon.png');
    if (fs.existsSync(iconPath)) icon = nativeImage.createFromPath(iconPath);
  } catch {}
  tray = new Tray(icon || nativeImage.createEmpty());
  tray.setToolTip(TITLE);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: '隐藏窗口', click: () => { if (mainWindow) mainWindow.hide(); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

// ── 单实例（参考 dsh-desktop + Reasonix single_instance.go）──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('window-all-closed', () => { /* 不退出，保持托盘 */ });
  app.on('before-quit', () => { app.isQuitting = true; });
  app.on('activate', () => { if (!mainWindow) createWindow(); });
}

app.whenReady().then(async () => {
  try {
    console.log('启动内置 server…');
    await startServer();
    console.log('server 就绪');
    createWindow();
    createTray();
  } catch (e) {
    console.error('启动失败:', e.message);
    app.quit();
  }
});

// 退出时清理 server
app.on('will-quit', () => {
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
});
