const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentRunner } = require('../../src/agent/runner');
const { newTask, normalizePlan } = require('../../src/agent/task');
const { logger } = require('../../src/agent/logger');
logger.log = () => {};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sourceA = 'https://example.test/a', sourceB = 'https://example.test/b';
function setup(choose, limits = {}) {
  let url = sourceA, observations = 0, acts = 0;
  const wc = { getURL: () => url, stop() {}, loadURL: async target => { url = target; } };
  const runner = new AgentRunner(wc, { limits, models: {
    choose,
    extractRows: async (_goal, _plan, page) => page.url === sourceB
      ? { rows: [{ values: { 名称: 'B' }, evidence: { 名称: '产品 B' } }] } : { rows: [] },
    verifyTask: async () => ({ checks: [{ index: 0, satisfied: true, evidenceIds: ['collection:counts'] }] }),
  } });
  runner.task = newTask(`从 ${sourceA} 和 ${sourceB} 采集两页`);
  runner.task.plan = normalizePlan({ mode: 'collect', columns: ['名称'], checks: ['采集两页'], minRows: 2, minSources: 2 }, runner.goal, sourceA);
  runner.task.rows = [{ values: { 名称: 'A' }, evidence: { 名称: '产品 A' }, sourceUrl: sourceA, sourceTitle: '产品 A', collectedAt: '2026-10-12T00:00:00Z' }];
  runner.task.visited = [sourceA]; runner.status = 'paused';
  runner.observe = runner.settle = async ctx => {
    runner.guard(ctx); observations++;
    return { url, title: url === sourceA ? '产品 A' : '产品 B', content: url === sourceA ? '产品 A' : '产品 B',
      fingerprint: url, marker: [observations], actions: [{ id: `fresh-${observations}`, kind: 'click', label: '新详情', node: observations }] };
  };
  runner.act = async (action, _text, ctx) => {
    runner.guard(ctx); acts++;
    assert.equal(action.id, `fresh-${observations}`, 'only the fresh observed candidate can be executed');
    await wc.loadURL(sourceB);
  };
  return { runner, counts: () => ({ observations, acts }) };
}

test('low target confidence reobserves new candidates, preserves rows and completes without resume', async () => {
  let calls = 0; const seen = [];
  const { runner, counts } = setup(async (page, _goal, _history, _progress, options) => {
    seen.push(page.marker[0]); calls++;
    if (calls === 2) {
      assert.equal(options.task.decision_recovery.previousDecision.targetConfidence, .1);
      assert.ok(seen[1] > seen[0]);
      assert.equal(page.actions.some(a => a.id === `fresh-${seen[0]}`), false);
    }
    return { choice: page.actions[0].id, confidence: .95, target_confidence: calls === 1 ? .1 : .9 };
  });
  const retained = structuredClone(runner.task.rows[0]), id = runner.task.id;
  await runner.resume();
  assert.equal(runner.status, 'done'); assert.equal(calls, 2); assert.equal(counts().acts, 1);
  assert.equal(runner.task.rows.length, 2); assert.deepEqual(runner.task.rows[0], retained);
  assert.equal(runner.task.id, id); assert.equal(runner.task.steps, 2); assert.equal(runner.task.decisionRetries, 1);
  assert.equal(runner.task.recoveries[0].status, 'recovered'); assert.equal(runner.task.recoveries[0].observations.length, 1);
});

test('low-confidence DONE and BLOCKED are reconsidered before handoff; sustained uncertainty is bounded', async () => {
  let calls = 0;
  const { runner, counts } = setup(async () => ({ choice: ++calls === 1 ? 'DONE' : 'BLOCKED', confidence: .1 }));
  const retained = structuredClone(runner.task.rows);
  await runner.resume();
  assert.equal(calls, 3); assert.equal(counts().acts, 0); assert.equal(runner.status, 'waiting_for_user');
  assert.deepEqual(runner.task.rows, retained); assert.equal(runner.task.steps, 1); assert.equal(runner.task.decisionRetries, 2);
  assert.equal(runner.task.failedVerifications || 0, 0); assert.equal(runner.task.recoveries[0].status, 'exhausted');
});

test('the task-wide rejudgement budget persists across resume and never lowers the threshold', async () => {
  let calls = 0;
  const { runner, counts } = setup(async page => ({ choice: page.actions[0].id, confidence: .24 }), { decisionRetries: 1 });
  const choose = runner.models.choose; runner.models.choose = async (...args) => { calls++; return choose(...args); };
  await runner.resume();
  assert.equal(calls, 2); assert.equal(runner.task.decisionRetries, 1); assert.equal(counts().acts, 0);
  const steps = runner.task.steps, time = runner.task.activeMs;
  await runner.resume(); assert.equal(calls, 3); assert.equal(runner.task.decisionRetries, 1);
  assert.equal(runner.task.steps, steps + 1); assert.ok(runner.task.activeMs >= time);
});

for (const cancel of ['stop', 'pause']) test(`${cancel} during uncertainty waiting cancels the next request and keeps results`, async () => {
  let calls = 0;
  const { runner, counts } = setup(async () => { calls++; return { choice: 'BLOCKED', confidence: .1 }; });
  const retained = structuredClone(runner.task.rows);
  runner.on('state', state => { if (state.tickerMessage?.includes('重新观察并判断') && !runner.execution?.controller.signal.aborted) runner[cancel](); });
  await runner.resume();
  assert.equal(calls, 1); assert.equal(counts().acts, 0); assert.deepEqual(runner.task.rows, retained);
  assert.equal(runner.status, cancel === 'stop' ? 'stopped' : 'paused');
  assert.equal(runner.task.recoveries[0].status, 'cancelled');
});

test('stopping a pending rejudgement discards a late confident response', async () => {
  let calls = 0; const pending = deferred(), reached = deferred();
  const { runner, counts } = setup(async page => {
    if (++calls === 1) return { choice: page.actions[0].id, confidence: .1 };
    reached.resolve(); return pending.promise;
  });
  const run = runner.resume(); await reached.promise;
  runner.stop(); pending.resolve({ choice: 'fresh-4', confidence: .99 }); await run;
  assert.equal(calls, 2); assert.equal(counts().acts, 0); assert.equal(runner.status, 'stopped');
  assert.equal(runner.task.rows.length, 1); assert.equal(runner.task.recoveries[0].status, 'cancelled');
});

test('a changed source during reobservation is collected and verified before another action', async () => {
  let calls = 0;
  const { runner, counts } = setup(async page => { calls++; return { choice: page.actions[0].id, confidence: .1 }; });
  const settle = runner.settle;
  runner.settle = async ctx => {
    if (runner.task.decisionRetries) await runner.webContents.loadURL(sourceB);
    return settle(ctx);
  };
  await runner.resume();
  assert.equal(runner.status, 'done'); assert.equal(calls, 1); assert.equal(counts().acts, 0);
  assert.equal(runner.task.rows.length, 2); assert.ok(runner.task.visited.includes(sourceB));
  assert.equal(runner.task.recoveries[0].resolvedBy, 'verification');
});
