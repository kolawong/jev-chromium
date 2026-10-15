const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentRunner } = require('../../src/agent/runner');
const { logger } = require('../../src/agent/logger');
logger.log = () => {};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const page = (url = 'https://example.test/a') => ({ url, title: '产品', text: '产品 A 价格 99', content: '产品 A 价格 99',
  fingerprint: url, actions: [{ id: 'e1', node: 1, kind: 'click', label: '详情' }], guards: {} });
const plan = { mode: 'browse', checks: ['已打开产品 A'], startUrl: 'https://example.test/a' };
function setup(overrides = {}, options = {}) {
  let current = page();
  const wc = { getURL: () => current.url, stop() {}, loadURL: async url => { current = page(url); } };
  const runner = new AgentRunner(wc, { ...options, models: {
    planTask: async () => plan,
    choose: async () => ({ choice: 'DONE', confidence: .9 }),
    verifyTask: async () => ({ checks: [{ index: 0, satisfied: true, evidence: '产品 A' }] }),
    ...overrides,
  } });
  runner.observe = async ctx => { runner.guard(ctx); return current; };
  runner.settle = runner.observe;
  return runner;
}

test('stopping during a model call prevents the later action and stale state', async () => {
  const choice = deferred(), reached = deferred();
  const runner = setup({ choose: async () => { reached.resolve(); return choice.promise; } });
  let acts = 0; runner.act = async () => { acts++; };
  const run = runner.start('打开产品 A'); await reached.promise;
  runner.stop();
  choice.resolve({ choice: 'e1', confidence: .9 });
  await run;
  assert.equal(acts, 0); assert.equal(runner.status, 'stopped'); assert.equal(runner.history.length, 0);
});
test('stop during planning cancels navigation; overlapping starts are rejected', async () => {
  const planning = deferred();
  const runner = setup({ planTask: () => planning.promise });
  let nav = 0; runner.navigate = async () => { nav++; };
  const run = runner.start('a');
  await assert.rejects(runner.start('b'), /任务仍在运行/);
  runner.stop(); planning.resolve({ ...plan, startUrl: 'https://other.example/' });
  await run;
  assert.equal(nav, 0); assert.equal(runner.goal, 'a');
});
test('pause discards late decision; resume observes again and single-step does one cycle', async () => {
  const pending = deferred(), reached = deferred();
  const runner = setup({ choose: async () => { reached.resolve(); return pending.promise; },
    verifyTask: async () => ({ checks: [{ index: 0, satisfied: false, evidenceIds: [] }] }) });
  let acts = 0, observations = 0;
  const observe = runner.observe;
  runner.observe = runner.settle = async ctx => { observations++; return observe(ctx); };
  runner.act = async () => { acts++; };
  const run = runner.start('打开产品 A'); await reached.promise;
  runner.pause(); pending.resolve({ choice: 'e1', confidence: .9 }); await run;
  assert.equal(runner.status, 'paused'); assert.equal(acts, 0);
  const before = observations;
  runner.models.choose = async () => ({ choice: 'e1', confidence: .9 });
  await runner.step();
  assert.equal(acts, 1); assert.equal(runner.status, 'paused'); assert.ok(observations > before);
});
test('resuming an achieved goal verifies before allowing another operation', async () => {
  const runner = setup({ choose: async () => ({ choice: 'e1', confidence: .9 }) });
  let acts = 0; runner.act = async () => { acts++; };
  await runner.step('打开产品 A');
  assert.equal(acts, 1);
  await runner.resume();
  assert.equal(runner.status, 'done'); assert.equal(acts, 1);
});
test('stop during verification cannot later mark task done', async () => {
  const pending = deferred(), reached = deferred();
  const runner = setup({ verifyTask: async () => { reached.resolve(); return pending.promise; } });
  const run = runner.start('打开产品 A'); await reached.promise;
  runner.stop(); pending.resolve({ checks: [{ index: 0, satisfied: true, evidence: '产品 A' }] });
  await run; assert.equal(runner.status, 'stopped'); assert.equal(runner.task.verification, null);
});
test('single-step with an edited goal starts a new task instead of resuming the old one', async () => {
  const runner = setup({ choose: async () => ({ choice: 'e1', confidence: .9 }) });
  runner.act = async () => {};
  await runner.step('旧目标');
  const previousId = runner.task.id;
  await runner.step('新目标');
  assert.equal(runner.goal, '新目标');
  assert.notEqual(runner.task.id, previousId);
  assert.equal(runner.task.steps, 1);
  assert.equal(runner.status, 'paused');
});
test('closing a stopped task preserves its terminal state', async () => {
  const runner = setup({ choose: async () => ({ choice: 'e1', confidence: .9 }) });
  runner.act = async () => {};
  await runner.step('测试停止');
  runner.stop();
  runner.pause(); // window close
  assert.equal(runner.status, 'stopped');
});
test('DONE without grounded evidence stops for assistance, never succeeds', async () => {
  const runner = setup({ verifyTask: async () => ({ checks: [{ index: 0, satisfied: true, evidence: 'invented' }] }) });
  await runner.start('打开产品 A');
  assert.equal(runner.status, 'waiting_for_user');
  assert.equal(runner.task.verification.complete, false);
});
test('uncertain next action verifies an already achieved goal before requesting handoff', async () => {
  const runner = setup({ choose: async () => ({ choice: 'e1', confidence: .7, target_confidence: .1 }) });
  let acts = 0; runner.act = async () => { acts++; };
  await runner.start('打开产品 A');
  assert.equal(runner.status, 'done'); assert.equal(acts, 0);
});
test('step budget includes repeated WAIT and survives resume', async () => {
  const runner = setup({ choose: async () => ({ choice: 'e1', confidence: .9 }) }, { limits: { steps: 2 } });
  runner.act = async () => {};
  await runner.start('打开产品 A');
  assert.equal(runner.task.steps, 2); assert.equal(runner.status, 'waiting_for_user');
  await runner.resume(); assert.equal(runner.task.steps, 2);
});
test('stop during extraction keeps late rows out of the result', async () => {
  const pending = deferred(), reached = deferred();
  const runner = setup({ planTask: async () => ({ ...plan, mode: 'collect', columns: ['名称'], minRows: 1, minSources: 1 }),
    extractRows: async () => { reached.resolve(); return pending.promise; } });
  const run = runner.start('整理产品表'); await reached.promise;
  runner.stop(); pending.resolve({ rows: [{ values: { 名称: 'A' }, evidence: { 名称: '产品 A' } }] });
  await run; assert.equal(runner.task.rows.length, 0);
});
test('cross-page extraction merges grounded rows and verifies complete coverage', async () => {
  const runner = setup({
    planTask: async () => ({ ...plan, mode: 'collect', columns: ['名称', '价格'], minRows: 2, minSources: 2 }),
    extractRows: async () => ({ rows: [{ values: { 名称: 'A', 价格: '99' }, evidence: { 名称: '产品 A', 价格: '价格 99' } }] }),
    choose: async () => ({ choice: 'next_source', confidence: .9 }),
  });
  await runner.start('从 https://example.test/a 和 https://example.test/b 搜集产品并整理表格');
  assert.equal(runner.status, 'done');
  assert.equal(runner.task.rows.length, 2);
  assert.equal(new Set(runner.task.rows.map(r => r.sourceUrl)).size, 2);
});
test('returning from a collected detail consumes the navigation trail without offering it at the list', async () => {
  let decisions = 0;
  const runner = setup({
    planTask: async () => ({ ...plan, mode: 'collect', columns: ['名称'], minRows: 3, minSources: 3 }),
    extractRows: async (_goal, _plan, page) => page.url.endsWith('/b')
      ? { rows: [{ values: { 名称: 'A' }, evidence: { 名称: '产品 A' } }] } : { rows: [] },
    choose: async page => {
      decisions++;
      const back = page.actions.find(a => a.id === 'return_to_list');
      if (decisions === 1) return { choice: 'e1', confidence: .9 };
      if (decisions === 2) { assert.equal(back.url, 'https://example.test/a'); return { choice: back.id, confidence: .9 }; }
      assert.equal(back, undefined);
      return { choice: 'BLOCKED', confidence: .9 };
    },
  });
  const act = runner.act.bind(runner);
  runner.act = async (action, text, ctx) => action.id === 'e1'
    ? runner.navigate('https://example.test/b', ctx) : act(action, text, ctx);
  await runner.start('从入口进入详情并整理表格');
  assert.equal(decisions, 3);
  assert.deepEqual(runner.task.returnUrls, []);
  assert.equal(runner.status, 'waiting_for_user');
});
test('persisted running tasks restore paused and never execute automatically', async () => {
  const runner = setup(); await runner.start('打开产品 A');
  const snapshot = { ...runner.task, status: 'executing' };
  const restored = setup({}, { store: { load: () => snapshot, save() {} } });
  assert.equal(restored.status, 'paused'); assert.equal(restored.loopPromise, null);
});

test('closing the browser during a pending call persists a resumable task', async () => {
  const pending = deferred(), reached = deferred(); let saved, destroyed = false;
  const runner = setup({ choose: async () => { reached.resolve(); return pending.promise; } },
    { store: { load: () => null, save: task => { saved = structuredClone(task); } } });
  const getURL = runner.webContents.getURL;
  runner.webContents.isDestroyed = () => destroyed;
  runner.webContents.getURL = () => { if (destroyed) throw new Error('Object destroyed'); return getURL(); };
  const run = runner.start('打开产品 A'); await reached.promise;
  runner.pause(); destroyed = true;
  pending.resolve({ choice: 'DONE', confidence: .9 }); await run;
  assert.equal(runner.status, 'paused'); assert.equal(saved.status, 'paused');
});
test('premature DONE opens the next requested source instead of giving up', async () => {
  const runner = setup({
    planTask: async () => ({ ...plan, mode: 'collect', columns: ['名称'], minRows: 1, minSources: 1, checks: ['搜集名称'] }),
    extractRows: async (_goal, _plan, observed) => observed.url.endsWith('/b')
      ? { rows: [{ values: { 名称: 'B' }, evidence: { 名称: '产品 B' } }] } : { rows: [] },
    choose: async () => ({ choice: 'DONE', confidence: .9 }),
    verifyTask: async () => ({ checks: [{ index: 0, satisfied: true, evidenceIds: ['collection:counts'] }] }),
  });
  runner.observe = runner.settle = async ctx => {
    runner.guard(ctx);
    const url = runner.webContents.getURL();
    return { url, title: 'B', content: url.endsWith('/b') ? '产品 B' : '列表', fingerprint: url, actions: [] };
  };
  await runner.start('从 https://example.test/a 和 https://example.test/b 搜集名称');
  assert.equal(runner.status, 'done');
  assert.ok(runner.task.visited.includes('https://example.test/b'));
  assert.equal(runner.task.failedVerifications || 0, 0);
});
test('a failed load holds for another try and does not blame the model format', async () => {
  let url = 'https://example.test/a', loads = 0;
  const runner = setup({
    planTask: async () => ({ ...plan, mode: 'collect', columns: ['名称'], minRows: 1, minSources: 1, checks: ['打开页面'] }),
    extractRows: async () => ({ rows: [{ values: { 名称: 'B' }, evidence: { 名称: '产品 B' } }] }),
    choose: async () => ({ choice: 'DONE', confidence: .9 }),
    verifyTask: async () => ({ checks: [{ index: 0, satisfied: true, evidenceIds: ['collection:counts'] }] }),
  });
  runner.webContents.getURL = () => url;
  runner.webContents.loadURL = async target => {
    loads++;
    url = loads === 1 ? 'chrome-error://chromewebdata/' : target;
    if (loads === 1) throw new Error('ERR_NAME_NOT_RESOLVED');
  };
  runner.observe = runner.settle = async ctx => {
    runner.guard(ctx);
    return { url, title: 'B', content: '产品 B', fingerprint: url, actions: [] };
  };
  await runner.start('打开 https://example.test/missing');
  assert.equal(runner.status, 'waiting_for_user');
  assert.match(runner.blockedReason, /未能打开/);
  assert.equal(runner.task.visited.includes(null), false);
  assert.equal(runner.task.rows.length, 0);
  await runner.resume();
  assert.equal(loads, 2);
  assert.equal(runner.status, 'done');
  assert.doesNotMatch(runner.blockedReason || '', /信息提取格式无效/);
});
test('an oversized plan is remembered and corrected on resume', async () => {
  let calls = 0;
  const runner = setup({
    planTask: async (_goal, _url, options) => {
      calls++;
      if (calls === 1) {
        assert.equal(options.rejection, null);
        const error = new Error('云端模型结构化内容连续格式无效，已保留结果；可以稍后继续重试');
        error.code = 'MODEL_FORMAT_INVALID';
        error.reason = 'minRows must be an integer from 1 to 100';
        throw error;
      }
      assert.match(options.rejection, /minRows/);
      return plan;
    },
  });
  await runner.start('搜集全部产品');
  assert.equal(runner.status, 'error');
  assert.match(runner.task.planRejection, /minRows/);
  await runner.resume();
  assert.equal(calls, 2);
  assert.equal(runner.task.plan.mode, 'browse');
  assert.equal(runner.task.planRejection, null);
});
test('download links are handed back instead of being clicked', async () => {
  const runner = setup({ choose: async () => ({ choice: 'e1', confidence: .9 }) });
  let acts = 0;
  runner.act = async () => { acts++; };
  runner.observe = runner.settle = async ctx => {
    runner.guard(ctx);
    return { ...page(), actions: [{ id: 'e1', kind: 'click', label: 'Python.pkg', href: 'https://example.test/python.pkg' }] };
  };
  await runner.start('打开产品 A');
  assert.equal(acts, 0);
  assert.equal(runner.status, 'waiting_for_user');
  assert.match(runner.blockedReason, /Python\.pkg/);
});
test('collection excludes a proven same-URL reload across documents, while retaining same-page JS controls', async () => {
  const sameUrl = 'https://example.test/a';
  const { newTask, normalizePlan } = require('../../src/agent/task');
  const runner = setup({ extractRows: async () => ({ rows: [] }), choose: async state => {
    assert.equal(state.actions.some(a => a.id === 'reload'), false);
    assert.equal(state.actions.some(a => a.id === 'expand'), true);
    assert.equal(state.actions.some(a => a.id === 'hash'), true);
    return { choice: 'scroll_down', confidence: .9 };
  } });
  runner.task = newTask('采集两页');
  runner.task.plan = normalizePlan({ ...plan, mode: 'collect', columns: ['名称'], minRows: 2, minSources: 2 }, runner.goal, sameUrl);
  runner.task.history = [
    { kind: 'click', label: 'Downloads', href: sameUrl, before_url: sameUrl, after_url: sameUrl, before_document_id: 1, after_document_id: 2 },
    { kind: 'click', label: '展开', href: sameUrl, before_url: sameUrl, after_url: sameUrl, before_document_id: 2, after_document_id: 2 },
  ];
  runner.status = 'paused';
  runner.observe = runner.settle = async ctx => { runner.guard(ctx); return { ...page(), marker: [2], actions: [
    { id: 'reload', kind: 'click', href: sameUrl, label: 'Downloads' },
    { id: 'expand', kind: 'click', href: sameUrl, label: '展开' },
    { id: 'hash', kind: 'click', href: sameUrl + '#part', label: '目录' },
    { id: 'scroll_down', kind: 'scroll', label: '向下滚动' },
  ] }; };
  runner.act = async () => {};
  await runner.step();
  assert.equal(runner.status, 'paused'); assert.equal(runner.task.steps, 1);
});
