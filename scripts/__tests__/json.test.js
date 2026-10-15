const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonObject } = require('../../src/agent/json');
test('structured model output tolerates commentary without corrupting quoted braces', () => {
  const data = { rows: [{ values: { 名称: 'A {"quoted"}', 库存: null } }] };
  assert.deepEqual(parseJsonObject('```json\n' + JSON.stringify(data) + '\n```\n以上为提取结果。'), data);
  assert.deepEqual(parseJsonObject('<think>reason</think>' + JSON.stringify(data)), data);
});
test('truncated, malformed or ambiguous multiple JSON objects are rejected', () => {
  for (const value of ['{"rows":[', '{"a":1} {"a":2}', '{"a":undefined}', 'not JSON']) {
    assert.throws(() => parseJsonObject(value), /格式无效/);
  }
});
