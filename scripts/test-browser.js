/** Real Chromium + local fixture. --live additionally calls the configured cloud models. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
const { AgentRunner } = require('../src/agent/runner');
const { TaskStore, toCsv } = require('../src/agent/task');
const { logger } = require('../src/agent/logger');
const live = process.argv.includes('--live');
if (live) require('dotenv').config({ path: path.join(__dirname, '../.env') });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-browser-test-'));
app.setPath('userData', path.join(temp, 'profile'));
const deadline = setTimeout(() => { console.error('BROWSER TEST TIMEOUT'); app.exit(2); }, live ? 240000 : 45000);
const css = '<style>body{font:16px -apple-system;background:#f8fafc;color:#172033;margin:36px}a,button{display:inline-block;padding:12px;margin:8px}article{background:white;border:1px solid #ccc;border-radius:12px;padding:24px;max-width:500px}</style>';
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/a') res.end(css + '<title>产品 A</title><article><h1>产品 A</h1><p>名称：青松键盘</p><p>价格：199 元</p><p>库存：12 件</p></article><a href="/">返回列表</a>');
  else if (req.url === '/baidu.com/s') res.end(css + '<div id="content_left"><div class="c-container"><h3><a href="https://www.baidu.com/baidu.php?id=ad">浏览器广告</a></h3></div><div class="result"><h3><a href="/a">官方文档</a></h3></div><div class="result"><h3><a href="/b">第二条自然结果</a></h3></div></div>');
  else if (req.url === '/b') res.end(css + '<title>产品 B</title><article><h1>产品 B</h1><p>名称：白桦鼠标</p><p>价格：89 元</p></article><a href="/">返回列表</a>');
  else if (req.url === '/form') res.end(css + '<title>搜索测试</title><form action="/search"><label>搜索<input name="q" aria-label="搜索"></label><button>查询</button></form>');
  else if (req.url === '/filter') res.end(css + '<label>航空公司<select id="airline" onchange="result.textContent=this.value"><option>全部航司</option><option>南方航空</option><option>东方航空</option></select></label><p id="result">南方航空 东方航空</p>');
  else if (req.url.startsWith('/search')) res.end(css + '<title>搜索完成</title><h1>查询结果</h1><p>已找到青松键盘</p>');
  else res.end(css + '<title>产品目录</title><h1>产品目录</h1><a href="/a">青松键盘详情</a><a href="/b">白桦鼠标详情</a>');
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await app.whenReady();
  await session.defaultSession.setProxy({ mode: 'system' });
  const win = new BrowserWindow({ width: 1440, height: 940, show: false,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, nodeIntegration: false } });
  const view = new WebContentsView({ webPreferences: { partition: 'test-fixture', sandbox: true, nodeIntegration: false, contextIsolation: true } });
  win.contentView.addChildView(view); view.setBounds({ x: 0, y: 56, width: 1060, height: 884 });
  view.webContents.setWindowOpenHandler(({ url }) => { view.webContents.loadURL(url); return { action: 'deny' }; });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  const fixtureModels = {
    planTask: async () => ({ mode: 'collect', summary: '跨页面搜集产品名称、价格和库存', startUrl: base,
      columns: ['名称', '价格', '库存'], minRows: 2, minSources: 2, checks: ['搜集两个产品的名称和价格，库存缺失需留空'] }),
    extractRows: async (_goal, _plan, page) => {
      const match = page.content.match(/名称：([^\n]+)\n价格：([^\n]+)/);
      if (!match) return { rows: [] };
      const stock = page.content.match(/库存：([^\n]+)/)?.[1] || null;
      return { rows: [{ values: { 名称: match[1], 价格: match[2], 库存: stock },
        evidence: { 名称: `名称：${match[1]}`, 价格: `价格：${match[2]}`, 库存: stock ? `库存：${stock}` : null } }] };
    },
    choose: async (page, _goal, history, _cb, options) => {
      const choose = label => page.actions.find(a => a.label.includes(label));
      const action = page.actions.find(a => a.id === 'next_source') ||
        (page.url === base + '/' ? choose(options.task.collected_sources.includes(base + '/a') ? '白桦' : '青松') : choose('返回列表'));
      assert.ok(action, 'fixture action exists');
      return { choice: action.id, operation: action.kind.toUpperCase(), confidence: .95, latency_ms: 1 };
    },
    verifyTask: async () => ({ checks: [{ index: 0, satisfied: true, evidence: '名称：青松键盘' }], reason: '已核对两个产品，缺失库存留空' }),
  };
  const liveModels = { ...require('../src/agent/model') };
  if (live) {
    const extract = liveModels.extractRows;
    liveModels.extractRows = async (...args) => { const result = await extract(...args); console.log('LIVE_EXTRACTION', JSON.stringify({ url: args[2].url, result })); return result; };
  }
  const runner = new AgentRunner(view.webContents, { store: new TaskStore(path.join(temp, 'tasks')),
    models: live ? liveModels : fixtureModels, limits: { steps: 12, activeMs: live ? 180000 : 30000 } });
  runner.on('error', message => console.error('RUNNER_ERROR', message));
  runner.on('state', state => { win.webContents.send('agent:state', state); });
  logger.on('log', entry => win.webContents.send('agent:log', entry));
  ipcMain.handle('agent:status', () => runner.getState());
  ipcMain.handle('agent:start', (_e, { goal }) => { runner.start(goal); return { status: 'started' }; });
  ipcMain.handle('agent:pause', () => { runner.pause(); return { status: runner.status }; });
  ipcMain.handle('agent:stop', () => { runner.stop(); return { status: runner.status }; });
  ipcMain.handle('agent:resume', () => { runner.resume(); return { status: runner.status }; });
  ipcMain.handle('agent:step', (_e, goal) => { runner.step(goal); return { status: runner.status }; });
  ipcMain.handle('agent:setDrawerOpen', () => true);
  ipcMain.handle('agent:resultsCsv', () => toCsv(runner.task));
  ipcMain.handle('agent:exportResults', () => ({ saved: true }));
  ipcMain.handle('agent:navigate', async (_e, url) => { await view.webContents.loadURL(url); });
  await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  await view.webContents.loadURL(base);
  const goal = live ? `从 ${base}/a 和 ${base}/b 这两个页面搜集两个产品的名称、价格、库存并整理成表格。库存缺失标为未找到，不要编造。`
    : '跨页面搜集两个产品的名称、价格、库存，整理表格，缺失库存留空';
  await win.webContents.executeJavaScript(`(() => { document.getElementById('promptInput').value=${JSON.stringify(goal)}; document.getElementById('mainBtn').click(); })()`);
  for (let i = 0; !runner.loopPromise && i < 30; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(runner.loopPromise, 'Run button started task through IPC');
  await runner.loopPromise;
  assert.equal(runner.status, 'done', JSON.stringify({ reason: runner.blockedReason, verification: runner.task.verification, history: runner.history }));
  assert.equal(runner.task.rows.length, 2);
  const names = runner.task.rows.map(r => Object.values(r.values).join(' ')).join(' ');
  assert.ok(names.includes('青松键盘')); assert.ok(names.includes('白桦鼠标'));
  assert.ok(names.includes('199')); assert.ok(names.includes('89'));
  const csv = toCsv(runner.task);
  assert.ok(csv.includes('未找到'));
  fs.writeFileSync(path.join(temp, 'results.csv'), csv);
  await new Promise(resolve => setTimeout(resolve, 250));
  const ui = await win.webContents.executeJavaScript(`({rows:document.querySelectorAll('#resultTable tbody tr').length,
    state:document.getElementById('kpiStatus').textContent,
    visible:getComputedStyle(document.getElementById('collectionResults')).display !== 'none',
    thinkingHidden:getComputedStyle(document.getElementById('thinkingBanner')).display === 'none',
    emptyHidden:getComputedStyle(document.getElementById('stepsEmpty')).display === 'none',
    overflow:document.documentElement.scrollWidth > innerWidth})`);
  assert.equal(ui.rows, 2); assert.equal(ui.state, '已完成'); assert.equal(ui.visible, true); assert.equal(ui.overflow, false); assert.equal(ui.thinkingHidden, true); assert.equal(ui.emptyHidden, true);
  assert.deepEqual(errors, []);
  const screenshot = path.join(temp, 'completed.png');
  fs.writeFileSync(path.join(temp, 'source-page.png'), (await view.webContents.capturePage()).toPNG());
  fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ mode: live ? 'live-models-local-pages' : 'fixture-models-real-chromium',
    status: runner.status, rows: runner.task.rows.length, sources: runner.task.rows.map(r => r.sourceUrl), ui, artifactDirectory: temp }));

  if (!live) {
    await view.webContents.loadURL(base + '/baidu.com/s');
    const snapshot = await view.webContents.executeJavaScript(require('../src/agent/snapshot').SNAPSHOT_SCRIPT);
    const organic = snapshot.actions.filter(action => action.search_result_ordinal);
    assert.equal(organic.length, 2);
    assert.equal(organic[0].search_result_ordinal, 1);
    assert.ok(organic[0].label.includes('官方文档'));
    assert.equal(snapshot.actions.find(action => action.href?.includes('baidu.php')).search_result_ordinal, null);
    console.log('CHROMIUM_ORGANIC_RESULT_NUMBERING_PASSED');
    let choices = 0;
    runner.models.planTask = async () => ({ mode: 'browse', startUrl: base + '/filter', checks: ['仅显示南方航空'] });
    runner.models.choose = async page => {
      choices++;
      const action = page.actions.find(a => a.kind === 'select' && a.value === '南方航空') || page.actions[0];
      return { choice: action.id, confidence: .95 };
    };
    runner.models.verifyTask = async (_task, page) => {
      assert.equal(page.contentTruncated, false);
      assert.ok(!page.content.includes('东方航空'), 'unselected options are not result text');
      return { checks: [{ index: 0, satisfied: true, evidenceIds: ['page:current'] }] };
    };
    await runner.start('选择南方航空');
    assert.equal(runner.status, 'done');
    assert.equal(choices, 1, 'verify after selecting instead of undoing the satisfied filter');
    console.log('CHROMIUM_SELECT_COMPLETION_NO_UNDO_PASSED');
    // Actual CDP input and form submission; completion is independently verified afterwards.
    runner.models.planTask = async () => ({ mode: 'browse', startUrl: base + '/form', checks: ['已找到青松键盘'] });
    runner.models.fieldText = async () => ({ value: '青松键盘' });
    runner.models.choose = async page => {
      const field = page.actions.find(a => a.kind === 'fill');
      const action = field && field.value !== '青松键盘' ? field : page.actions.find(a => a.label === '查询');
      return { choice: action?.id || 'DONE', confidence: .95 };
    };
    runner.models.verifyTask = async () => ({ checks: [{ index: 0, satisfied: true, evidence: '已找到青松键盘' }] });
    await runner.start('搜索青松键盘');
    assert.equal(runner.status, 'done', runner.blockedReason);
    assert.ok(view.webContents.getURL().includes('/search?q='));
    assert.equal(runner.history.filter(h => h.outcome === 'failed').length, 0);
    console.log('CHROMIUM_FILL_CLICK_VERIFY_PASSED');
    let releaseDecision;
    runner.models.choose = () => new Promise(resolve => { releaseDecision = resolve; });
    await win.webContents.executeJavaScript(`(() => { document.getElementById('promptInput').value='重新搜索青松键盘'; document.getElementById('mainBtn').click(); })()`);
    for (let i = 0; !releaseDecision && i < 60; i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(releaseDecision);
    assert.equal(await win.webContents.executeJavaScript("document.getElementById('mainBtnLabel').textContent"), '暂停');
    const pending = runner.loopPromise;
    await win.webContents.executeJavaScript("document.getElementById('mainBtn').click()");
    for (let i = 0; runner.status !== 'pausing' && i < 30; i++) await new Promise(r => setTimeout(r, 20));
    releaseDecision({ choice: 'DONE', confidence: .9 });
    await pending;
    assert.equal(runner.status, 'paused');
    assert.equal(runner.history.length, 0);
    console.log('CHROMIUM_UI_PAUSE_NO_LATE_ACTION_PASSED');
  }
  clearTimeout(deadline); server.close(); win.destroy(); app.exit(0);
}
main().catch(err => { console.error(err.stack); clearTimeout(deadline); server.close(); app.exit(1); });
