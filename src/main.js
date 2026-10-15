const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog } = require('electron');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { AgentRunner } = require('./agent/runner');
const fs = require('fs');
const { TaskStore, toCsv } = require('./agent/task');
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
    mainWindow.webContents.send('agent:state', { ...runner?.getState(), url });
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
  if (!userSession.listenerCount('will-download')) {
    userSession.on('will-download', (event, item) => {
      event.preventDefault();
      const name = item.getFilename() || '文件';
      logger.warn('BROWSER', `已拦截下载：${name}`);
      if (runner && !['idle', 'done', 'stopped'].includes(runner.status)) {
        runner.handOff(`已拦截下载 ${name}。需要保存时请自行下载，然后再继续。`);
      }
    });
  }

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

  ipcMain.removeHandler('agent:setDrawerOpen');
  ipcMain.handle('agent:setDrawerOpen', async (_event, isOpen) => {
    isDrawerOpen = Boolean(isOpen);
    updateBounds();
    return isDrawerOpen;
  });

  runner = new AgentRunner(browserView.webContents, {
    store: new TaskStore(path.join(app.getPath('userData'), 'tasks')),
  });
  const taskWindow = mainWindow;
  const windowRunner = runner;
  taskWindow.webContents.on('did-finish-load', () => windowRunner.emitState());
  taskWindow.on('close', () => windowRunner.pause());

  runner.on('state', (state) => {
    if (!taskWindow.isDestroyed()) {
      taskWindow.webContents.send('agent:state', state);
    }
  });

  runner.on('error', (err) => {
    if (!taskWindow.isDestroyed()) {
      taskWindow.webContents.send('agent:error', err);
    }
  });

  // Window-scoped listeners are removed on close (including macOS reopen).
  const onLog = entry => { if (!taskWindow.isDestroyed()) taskWindow.webContents.send('agent:log', entry); };
  const onClear = () => { if (!taskWindow.isDestroyed()) taskWindow.webContents.send('agent:clearLogs'); };
  logger.on('log', onLog);
  logger.on('clear', onClear);
  const taskBrowser = browserView;
  taskWindow.on('closed', () => {
    logger.removeListener('log', onLog);
    logger.removeListener('clear', onClear);
    if (!taskBrowser.webContents.isDestroyed()) taskBrowser.webContents.close();
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
  runner.pause();
  await runner.loopPromise;
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
  runner.pause();
  await runner.loopPromise;
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
  if (runner.busy) return { error: '当前任务仍在运行或停止中' };
  if (!goal?.trim()) return { error: '请输入任务目标' };
  runner.start(goal, [], { url }).catch(err => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('agent:error', err.message);
  });
  return { status: 'started' };
});

ipcMain.handle('agent:pause', async () => {
  runner.pause();
  return { status: runner.status };
});

ipcMain.handle('agent:step', async (_event, goal) => {
  runner.step(goal).catch(err => mainWindow.webContents.send('agent:error', err.message));
  return { status: 'stepping' };
});

ipcMain.handle('agent:stop', async () => {
  runner.stop();
  return { status: runner.status };
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
  runner.pause();
  await runner.loopPromise;
  if (userSession) {
    await userSession.clearStorageData();
    console.log('[Main] User persistent session cleared.');
  }
  return { status: 'cleared' };
});

ipcMain.handle('agent:goBack', async () => {
  runner.pause();
  await runner.loopPromise;
  if (browserView && browserView.webContents.canGoBack()) {
    browserView.webContents.goBack();
  }
  return true;
});

ipcMain.handle('agent:goForward', async () => {
  runner.pause();
  await runner.loopPromise;
  if (browserView && browserView.webContents.canGoForward()) {
    browserView.webContents.goForward();
  }
  return true;
});

ipcMain.handle('agent:reload', async () => {
  runner.pause();
  await runner.loopPromise;
  if (browserView) {
    browserView.webContents.reload();
  }
  return true;
});

ipcMain.handle('agent:status', async () => runner.getState());

ipcMain.handle('agent:resultsCsv', async (_event, taskId) => {
  if (runner.task?.id !== taskId) throw new Error('任务已变化，请重试');
  return toCsv(runner.task);
});
ipcMain.handle('agent:exportResults', async (_event, taskId) => {
  if (runner.task?.id !== taskId) throw new Error('任务已变化，请重试');
  const csv = toCsv(runner.task);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出搜集结果', defaultPath: `网页搜集-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV 表格', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.promises.writeFile(result.filePath, csv, { mode: 0o600 });
  return { saved: true };
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
