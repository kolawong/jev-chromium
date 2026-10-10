const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { AgentRunner } = require('./agent/runner');
const { parseGoalIntent } = require('./agent/model');
const { logger } = require('./agent/logger');
const { getSettings, saveSettings, testConnection } = require('./agent/config');

let mainWindow;
let browserView;
let runner;
let userSession;

const TOP_BAR_HEIGHT = 56;
const DEFAULT_HOME_URL = 'https://www.baidu.com';

function sendUrlUpdate(url) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent:state', {
      status: runner ? runner.status : 'ready',
      url,
      goal: runner ? runner.goal : '',
      history: runner ? runner.history : [],
    });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    title: 'Jev Chromium',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#121316',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  // Persistent user session: retains cookies, logins, and localStorage across runs (like Ego Lite)
  userSession = session.fromPartition('persist:jev-user-profile', { cache: true });
  userSession.setProxy({ mode: 'system' }).catch((err) => {
    console.warn('[Main] userSession setProxy(system) failed:', err?.message || err);
  });
  userSession.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  );

  browserView = new WebContentsView({
    webPreferences: {
      session: userSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.contentView.addChildView(browserView);

  let isDrawerOpen = true;

  const updateBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [w, h] = mainWindow.getContentSize();
    const DRAWER_WIDTH = isDrawerOpen ? 380 : 0;
    browserView.setBounds({
      x: 0,
      y: TOP_BAR_HEIGHT,
      width: Math.max(0, w - DRAWER_WIDTH),
      height: Math.max(0, h - TOP_BAR_HEIGHT),
    });
  };

  mainWindow.on('resize', updateBounds);
  updateBounds();

  ipcMain.handle('agent:setDrawerOpen', async (_event, isOpen) => {
    isDrawerOpen = Boolean(isOpen);
    updateBounds();
    return isDrawerOpen;
  });

  runner = new AgentRunner(browserView.webContents);

  runner.on('state', (state) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:state', state);
    }
  });

  runner.on('error', (err) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:error', err);
    }
  });

  // Stream logs to renderer in real-time
  logger.on('log', (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:log', entry);
    }
  });

  logger.on('clear', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:clearLogs');
    }
  });

  browserView.webContents.setWindowOpenHandler(({ url }) => {
    logger.info('BROWSER', `拦截新窗口并于当前视窗加载: ${url}`);
    browserView.webContents.loadURL(url);
    sendUrlUpdate(url);
    return { action: 'deny' };
  });

  browserView.webContents.on('did-navigate', (_event, url) => {
    logger.info('BROWSER', `页面已加载跳转: ${url}`);
    sendUrlUpdate(url);
  });
  browserView.webContents.on('did-navigate-in-page', (_event, url) => {
    sendUrlUpdate(url);
  });

  // Load initial page
  logger.info('SYS', `初始化浏览器并加载主页: ${DEFAULT_HOME_URL}`);
  browserView.webContents.loadURL(DEFAULT_HOME_URL);
}

ipcMain.handle('agent:navigate', async (_event, url) => {
  if (!url) return;
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) {
    target = 'https://' + target;
  }
  try {
    logger.info('NAV', `前往网址: ${target}`);
    await browserView.webContents.loadURL(target);
  } catch (err) {
    if (err.code !== 'ERR_ABORTED') {
      logger.warn('NAV', `导航异常: ${err.message}`);
    }
  }
  return target;
});

ipcMain.handle('agent:goHome', async () => {
  if (browserView) {
    logger.info('NAV', `点击 Home 按钮返回主页: ${DEFAULT_HOME_URL}`);
    await browserView.webContents.loadURL(DEFAULT_HOME_URL);
    sendUrlUpdate(DEFAULT_HOME_URL);
  }
  return { status: 'ok', url: DEFAULT_HOME_URL };
});

ipcMain.handle('agent:getLogs', async () => {
  return logger.getLogs();
});

ipcMain.handle('agent:clearLogs', async () => {
  logger.clear();
  return true;
});

ipcMain.handle('agent:getSettings', async () => {
  return getSettings();
});

ipcMain.handle('agent:saveSettings', async (_event, settings) => {
  return saveSettings(settings);
});

ipcMain.handle('agent:testConnection', async (_event, { type, config }) => {
  return testConnection(type, config);
});


ipcMain.handle('agent:start', async (_event, { url, goal }) => {
  const currentUrl = browserView.webContents.getURL();
  let effectiveGoal = (goal || '').trim();
  let effectiveUrl = (url || '').trim();
  let didNavigate = false;
  const navStart = Date.now();

  // 1. Natural Language Intent & Target URL extraction
  try {
    const intent = await parseGoalIntent(effectiveGoal, currentUrl);
    if (intent.targetUrl) {
      effectiveUrl = intent.targetUrl;
      // Notify frontend to update the URL omnibox
      sendUrlUpdate(effectiveUrl);
    }
    if (intent.cleanGoal) {
      effectiveGoal = intent.cleanGoal;
    }
  } catch (err) {
    console.warn('Intent parsing failed, continuing with current URL:', err.message);
  }

  // 2. Perform navigation if needed
  if (effectiveUrl) {
    let target = effectiveUrl;
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    const current = browserView.webContents.getURL();
    if (current !== target && !current.startsWith(target)) {
      try {
        console.log(`[Main] Navigating from ${current} to ${target}...`);
        await Promise.race([
          browserView.webContents.loadURL(target),
          new Promise((resolve) => setTimeout(resolve, 6000)),
        ]);
        didNavigate = true;
        console.log('[Main] Navigation finished or settled.');
        await new Promise((resolve) => setTimeout(resolve, 600));
      } catch (err) {
        if (err.code !== 'ERR_ABORTED') {
          console.warn('[Main] Navigation error:', err.message);
        }
      }
    }
  }

  const initialHistory = [];
  if (didNavigate && effectiveUrl) {
    initialHistory.push({
      step: 1,
      action: `智能识别目标网站并跳转: ${effectiveUrl}`,
      kind: 'navigate',
      choice: 'NAVIGATE',
      text: effectiveUrl,
      latency_ms: Math.max(50, Date.now() - navStart),
      confidence: 100,
      operation: 'NAVIGATE',
      page_changed: true,
      elapsed_ms: Date.now() - navStart,
    });
  }

  runner.start(effectiveGoal, initialHistory).catch((err) => {
    console.error('Agent loop stopped:', err.message);
  });
  return { status: 'started', effectiveUrl };
});

ipcMain.handle('agent:pause', async () => {
  runner.pause();
  return { status: 'paused' };
});

ipcMain.handle('agent:step', async () => {
  runner.step();
  return { status: 'stepping' };
});

ipcMain.handle('agent:stop', async () => {
  runner.stop();
  return { status: 'stopped' };
});

ipcMain.handle('agent:resume', async () => {
  runner.resume().catch((err) => {
    console.error('Agent resume failed:', err.message);
  });
  return { status: runner.status };
});

ipcMain.handle('agent:handOff', async (_event, reason) => {
  runner.handOff(reason);
  return { status: 'waiting_for_user' };
});

ipcMain.handle('agent:clearSession', async () => {
  if (userSession) {
    await userSession.clearStorageData();
    console.log('[Main] User persistent session cleared.');
  }
  return { status: 'cleared' };
});

ipcMain.handle('agent:goBack', async () => {
  if (browserView && browserView.webContents.canGoBack()) {
    browserView.webContents.goBack();
  }
  return true;
});

ipcMain.handle('agent:goForward', async () => {
  if (browserView && browserView.webContents.canGoForward()) {
    browserView.webContents.goForward();
  }
  return true;
});

ipcMain.handle('agent:reload', async () => {
  if (browserView) {
    browserView.webContents.reload();
  }
  return true;
});

ipcMain.handle('agent:status', async () => {
  return {
    status: runner.status,
    url: browserView.webContents.getURL(),
    history: runner.history,
  };
});

app.whenReady().then(async () => {
  try {
    await session.defaultSession.setProxy({ mode: 'system' });
    console.log('[Main] defaultSession proxy mode=system (uses VPN/local proxy)');
  } catch (err) {
    console.warn('[Main] defaultSession setProxy(system) failed:', err?.message || err);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
