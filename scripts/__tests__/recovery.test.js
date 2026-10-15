const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractRows, planTask, verifyTask } = require('../../src/agent/model');
const { AgentRunner } = require('../../src/agent/runner');
const { logger } = require('../../src/agent/logger');
logger.log = () => {};
const plan = { mode: 'collect', columns: ['名称'], minRows: 2, minSources: 2,
  checks: ['采集两页'], startUrl: 'https://example.test/a' };
const record = { rows: [{ values: { 名称: '产品 A' }, evidence: { 名称: '产品 A' } }] };
const page = url => ({ url, title: '产品 A', content: '产品 A', text: '产品 A', actions: [], fingerprint: url });
const response = (content, finish_reason = 'stop') => ({ ok: true,
  json: async () => ({ choices: [{ message: { content }, finish_reason }] }) });
async function mockFetch(fetcher, run) {
  const old = global.fetch, key = process.env.TEXT_MODEL_API_KEY;
  process.env.TEXT_MODEL_API_KEY = 'test-only'; global.fetch = fetcher;
  try { await run(); } finally {
    global.fetch = old;
    if (key === undefined) delete process.env.TEXT_MODEL_API_KEY; else process.env.TEXT_MODEL_API_KEY = key;
  }
}
function runnerSetup() {
  let current = page('https://example.test/a');
  const runner = new AgentRunner({ getURL: () => current.url, stop() {},
    loadURL: async url => { current = page(url); } }, { models: {
    planTask: async () => plan,
    choose: async () => ({ choice: 'next_source', confidence: .95 }),
    verifyTask: async () => ({ checks: [{ index: 0, satisfied: true, evidenceIds: ['collection:counts'] }] }),
  } });
  runner.observe = runner.settle = async ctx => { runner.guard(ctx); return current; };
  return runner;
}
test('syntax, schema and truncated responses share four attempts, preserving earlier rows without resume', async () => {
  let calls = 0; const bodies = [], runner = runnerSetup();
  const oldRows = [];
  runner.on('state', state => { if (state.task?.rows.length === 1) oldRows.push(structuredClone(state.task.rows[0])); });
  await mockFetch(async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body); calls++;
    if (calls === 2) return response('{"rows":[');
    if (calls === 3) return response('{"rows":[null]}');
    if (calls === 4) return response(JSON.stringify(record), 'length');
    return response(JSON.stringify(record));
  }, async () => {
    await runner.start('从 https://example.test/a 和 https://example.test/b 采集两页');
    assert.equal(runner.status, 'done'); assert.equal(calls, 5);
    assert.equal(runner.task.steps, 2); assert.equal(runner.history.length, 1);
    assert.equal(runner.task.rows.length, 2);
    for (const row of oldRows) assert.deepEqual(row, runner.task.rows[0]);
    assert.equal(runner.task.recoveries.length, 1);
    assert.equal(runner.task.recoveries[0].status, 'recovered');
    assert.equal(runner.task.recoveries[0].attempt, 4);
    assert.ok(JSON.parse(bodies[2].messages[1].content).validationError);
    assert.equal(bodies[4].max_tokens, 6000);
  });
});
test('persistent malformed response exhausts budget with partial rows, no extracted marker or replay', async () => {
  let calls = 0; const runner = runnerSetup();
  await mockFetch(async () => response(++calls === 1 ? JSON.stringify(record) : '{"rows":['), async () => {
    await runner.start('从 https://example.test/a 和 https://example.test/b 采集两页');
    assert.equal(calls, 5); assert.equal(runner.status, 'error');
    assert.equal(runner.task.rows.length, 1); assert.equal(runner.history.length, 1);
    assert.equal(runner.task.extracted.length, 1); assert.equal(runner.task.steps, 2);
    assert.equal(runner.task.recoveries[0].status, 'exhausted');
    assert.match(runner.blockedReason, /已保留结果/);
  });
});
test('stop during recovery backoff retains partial results and prevents further requests/actions', async () => {
  let calls = 0; const runner = runnerSetup();
  runner.on('state', () => { if (runner.task?.recoveries?.[0]?.status === 'retrying' && runner.execution && !runner.execution.controller.signal.aborted) runner.stop(); });
  await mockFetch(async () => response(++calls === 1 ? JSON.stringify(record) : 'bad'), async () => {
    await runner.start('从 https://example.test/a 和 https://example.test/b 采集两页');
    assert.equal(calls, 2); assert.equal(runner.status, 'stopped');
    assert.equal(runner.task.rows.length, 1); assert.equal(runner.history.length, 1);
    assert.equal(runner.task.extracted.length, 1);
  });
});
test('planning corrects invalid schema; verification corrects invented IDs but can remain unsatisfied', async () => {
  let calls = 0;
  await mockFetch(async () => response(JSON.stringify(++calls === 1 ? { mode: 'bad' } : plan)), async () => {
    const value = await planTask('采集两页', 'https://example.test/a');
    assert.equal(value.mode, 'collect'); assert.equal(calls, 2);
  });
  calls = 0;
  await mockFetch(async () => response(JSON.stringify({ checks: [{ index: 0,
    satisfied: calls++ === 0, evidenceIds: calls === 1 ? ['invented:0'] : [] }] })), async () => {
    const value = await verifyTask({ goal: '采集两页', plan: { ...plan, startUrls: ['https://example.test/a'] }, rows: [], history: [], visited: [] }, page('https://example.test/a'));
    assert.equal(calls, 2); assert.equal(value.checks[0].satisfied, false);
  });
});
test('abort while a retry response is pending discards a late valid response', async () => {
  const controller = new AbortController(); let calls = 0, ready, resolve;
  const pending = new Promise(r => { resolve = r; });
  const reached = new Promise(r => { ready = r; });
  await mockFetch(async () => {
    if (++calls === 1) return response('bad');
    ready(); return pending;
  }, async () => {
    const run = extractRows('采集', plan, page('https://example.test/a'), { signal: controller.signal });
    await reached; controller.abort(); resolve(response(JSON.stringify(record)));
    await assert.rejects(run, { name: 'AbortError' }); assert.equal(calls, 2);
  });
});
test('JEV malformed choices are corrected within the existing request budget before choosing an action', async () => {
  const { choose } = require('../../src/agent/model');
  const priorKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-only';
  let calls = 0; const receipts = [], bodies = [];
  try {
    await mockFetch(async (_url, init) => {
      const body = JSON.parse(init.body); bodies.push(body); calls++;
      const probabilities = Object.fromEntries(Object.keys(body.questions.operation.criteria).map(id => [id, id === 'DONE' ? 1 : 0]));
      return { ok: true, json: async () => ({ answers: { operation: {
        choice: calls === 1 ? 'INVENTED' : 'DONE', confidence: .95, probabilities } } }) };
    }, async () => {
      const decision = await choose(page('https://example.test/a'), '任务', [], null, { onRecovery: e => receipts.push(e) });
      assert.equal(decision.choice, 'DONE'); assert.equal(calls, 2);
      assert.ok(bodies[1].state.model_response_error);
      assert.deepEqual(receipts.map(e => e.status), ['retrying', 'recovered']);
    });
  } finally {
    if (priorKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = priorKey;
  }
});
