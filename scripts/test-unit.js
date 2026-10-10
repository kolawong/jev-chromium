const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyDecisionSafeguards } = require('../src/agent/safeguards');
const { extractTargetPage, extractRequestedResultIndex } = require('../src/agent/goalParse');
const { parseEnv, serializeEnv } = require('../src/agent/envFile');
const { adaptersForInjection } = require('../src/agent/sites');

assert.strictEqual(extractTargetPage('翻到第3页看结果'), 3);
assert.strictEqual(extractRequestedResultIndex('打开第2条搜索结果'), 2);

const page = {
  url: 'https://www.baidu.com/s?wd=test',
  actions: [
    { id: 'scroll_down', kind: 'scroll', label: '向下滚动' },
    { id: 'e1', kind: 'fill', label: '网页搜索框', role: 'searchbox' },
  ],
};
const blockedScroll = applyDecisionSafeguards({
  selected: 'BLOCKED',
  decision: { probabilities: { BLOCKED: 1 } },
  page,
  goal: '搜索深圳天气并翻到第2页',
  history: [],
});
assert.strictEqual(blockedScroll.selected, 'scroll_down');

const blockedFill = applyDecisionSafeguards({
  selected: 'BLOCKED',
  decision: { probabilities: { BLOCKED: 1 } },
  page,
  goal: '搜索深圳天气',
  history: [],
});
assert.strictEqual(blockedFill.selected, 'e1');

const done = applyDecisionSafeguards({
  selected: 'DONE',
  decision: {},
  page: { url: 'https://example.com', actions: [] },
  goal: '随便看看',
  history: [],
});
assert.strictEqual(done.done, true);

const map = parseEnv('FOO=1\nBAR=two\n');
map.set('FOO', '9');
map.set('BAZ', 'x');
const out = serializeEnv(map, ['FOO', 'BAR', 'BAZ']);
assert.ok(out.includes('FOO=9'));
assert.ok(out.includes('BAR=two'));
assert.ok(out.includes('BAZ=x'));

const adapters = adaptersForInjection();
assert.ok(adapters.some((a) => a.id === 'baidu'));
assert.ok(adapters.some((a) => a.id === 'google'));

console.log('ALL UNIT TESTS PASSED');
