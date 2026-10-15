const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractRows } = require('../../src/agent/model');

test('extraction repairs a normalized date against the actual page before returning it', async () => {
  const priorFetch = global.fetch, priorKey = process.env.TEXT_MODEL_API_KEY;
  process.env.TEXT_MODEL_API_KEY = 'test-only';
  const calls = [];
  const record = date => ({ rows: [{ values: { 名称: 'Python 3.12.15', 发布日期: date },
    evidence: { 名称: 'Python 3.12.15', 发布日期: 'Release date: Sept. 30, 2026' } }] });
  global.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ choices: [{ message: {
      content: JSON.stringify(record(calls.length === 1 ? '2026-09-30' : 'Sept. 30, 2026')) } }] }) };
  };
  try {
    const result = await extractRows('采集版本和日期', { columns: ['名称', '发布日期'], checks: [] },
      { url: 'https://example.test/release', content: 'Python 3.12.15 Release date: Sept. 30, 2026' });
    assert.equal(calls.length, 2);
    assert.equal(result.rows[0].values.发布日期, 'Sept. 30, 2026');
    assert.deepEqual(JSON.parse(calls[1].messages[1].content).unsupportedCells,
      [{ row: 0, column: '发布日期', value: '2026-09-30' }]);
  } finally {
    global.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.TEXT_MODEL_API_KEY;
    else process.env.TEXT_MODEL_API_KEY = priorKey;
  }
});
