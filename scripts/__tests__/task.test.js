const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizePlan, newTask, groundedRows, extractionIssues, collectionReturnUrl, verificationEvidence,
  mergeRows, collectionProgress, validateVerification, toCsv, TaskStore, webUrl, planValidationError } = require('../../src/agent/task');

const plan = { mode: 'collect', columns: ['名称', '价格', '库存'], checks: ['搜集产品名称及价格'], minRows: 2, minSources: 2, startUrls: ['https://test.example/a', 'https://test.example/b'] };
test('plan preserves all explicit source URLs and rejects unsupported task sizes', () => {
  const p = normalizePlan({ ...plan, startUrl: null }, '从 https://test.example/a 和 https://test.example/b 整理表格', 'https://test.example/');
  assert.deepEqual(p.startUrls, plan.startUrls);
  assert.throws(() => normalizePlan({ ...plan, minRows: 101 }, '整理产品', 'https://test.example'));
  assert.throws(() => normalizePlan({ ...plan, checks: [] }, '整理产品', 'https://test.example'));
});
test('requested source links use the built-in source column once, never as an entity or duplicate', () => {
  const normalized = normalizePlan({ ...plan, columns: ['名称', '价格', '来源', 'source_url'] },
    '从 https://test.example/a 整理名称价格并附来源', 'https://test.example/');
  assert.deepEqual(normalized.columns, ['名称', '价格']);
  const task = { plan: normalized, rows: [{ values: { 名称: 'A', 价格: '99' }, sourceUrl: 'https://test.example/a' }] };
  assert.equal(toCsv(task).split('\r\n')[0], '\uFEFF"名称","价格","来源网址","采集时间"');
  assert.throws(() => normalizePlan({ ...plan, columns: ['来源'] }, '附来源', 'https://test.example/'));
});
test('only observed evidence is accepted; model URLs and unsupported values are discarded', () => {
  const rows = groundedRows({ rows: [{ values: { 名称: 'A', 价格: '99', 库存: '10' },
    evidence: { 名称: '产品 A', 价格: '价格 99', 库存: '库存 10' }, sourceUrl: 'https://invented.example' }] },
  { url: plan.startUrls[0], title: 'A', content: '产品 A 价格 99' }, plan.columns);
  assert.equal(rows[0].values.库存, null);
  assert.equal(rows[0].sourceUrl, plan.startUrls[0]);
  assert.equal(mergeRows(rows, rows, plan.columns).length, 1);
  assert.equal(mergeRows(rows, [{ ...rows[0], sourceUrl: plan.startUrls[1] }], plan.columns).length, 2);
});
test('completion requires each check to have grounded evidence plus quantity and source coverage', () => {
  const task = { ...newTask('整理产品'), plan, visited: plan.startUrls };
  task.rows = [{ values: { 名称: 'A' }, evidence: { 名称: '产品 A' }, sourceUrl: plan.startUrls[0] }];
  const answer = { checks: [{ index: 0, satisfied: true, evidence: '产品 A' }] };
  assert.equal(validateVerification(answer, task, {}).complete, false);
  task.rows.push({ ...task.rows[0], sourceUrl: plan.startUrls[1] });
  assert.equal(validateVerification(answer, task, {}).complete, true);
  answer.checks[0].evidence = '编造的证据';
  assert.equal(validateVerification(answer, task, {}).complete, false);
});
test('CSV quotes delimiters, preserves zero and prevents spreadsheet formulas', () => {
  const task = { plan, rows: [{ values: { 名称: '=HYPERLINK("x")', 价格: '0', 库存: null }, sourceUrl: plan.startUrls[0], collectedAt: '2026-10-11' }] };
  const csv = toCsv(task);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'));
  assert.ok(csv.includes('"0","未找到"'));
});
test('task persistence is atomic and keeps collected rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-store-test-'));
  try {
    const store = new TaskStore(dir), task = { ...newTask('task'), plan, rows: [{ values: { 名称: 'A' } }] };
    store.save(task);
    assert.deepEqual(store.load(), task);
    assert.equal(fs.existsSync(store.file + '.tmp'), false);
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('verification rejects invented evidence IDs and unsuccessful result navigation', () => {
  const task = { ...newTask('打开第2条搜索结果'), plan: { mode: 'browse', checks: ['已打开目标'] } };
  const page = { url: 'https://example.test/search', text: '目标链接', actions: [] };
  const valid = { checks: [{ index: 0, satisfied: true, evidenceIds: ['page:current'] }] };
  task.history.push({ search_result_ordinal: 2, before_url: page.url, after_url: page.url, opened_target_result: false });
  assert.equal(validateVerification(valid, task, page).complete, false);
  task.goal = '查看页面';
  assert.equal(validateVerification(valid, task, page).complete, true);
  valid.checks[0].evidenceIds = ['invented'];
  assert.equal(validateVerification(valid, task, page).complete, false);
});

test('verification exposes current select value, never an unselected candidate as current state', () => {
  const { verificationEvidence } = require('../../src/agent/task');
  const task = { ...newTask('选择广东'), plan: { mode: 'browse', checks: ['地区为广东'] } };
  const page = { url: 'https://example.test', text: '', actions: [{ node: 1, kind: 'select',
    label: '地区 → 广东', value: 'guangdong', current_value: '上海' }] };
  const evidence = verificationEvidence(task, page);
  assert.deepEqual(evidence[0].fields, [{ label: '地区', value: '上海', checked: undefined, selected: undefined }]);
  assert.equal(validateVerification({ checks: [{ index: 0, satisfied: true, evidence: 'guangdong' }] }, task, page).complete, false);
});
test('only successful navigation to the current destination can supply prior search evidence', () => {
  const { verificationEvidence } = require('../../src/agent/task');
  const task = { ...newTask('搜索并打开第一个结果'), plan: { mode: 'browse', checks: ['已打开'] } };
  const page = { url: 'https://example.test/detail', actions: [] };
  const receipt = { opened_target_result: true, outcome: 'observed', before_url: 'https://www.baidu.com/s?wd=abc',
    after_url: page.url, search_query: 'abc', search_result_ordinal: 1 };
  task.history = [{ ...receipt, outcome: 'failed' }, { ...receipt, after_url: 'https://other.test' }, receipt];
  const evidence = verificationEvidence(task, page);
  assert.deepEqual(evidence.filter(e => e.id.startsWith('navigation:')).map(e => e.id), ['navigation:2']);
  assert.equal(evidence[1].searchQuery, 'abc');
});

test('collection return action never labels a collected detail page as a list', () => {
  const task = { rows: [{ sourceUrl: 'https://example.test/a' }, { sourceUrl: 'https://example.test/b' }],
    returnUrls: ['https://example.test/', 'https://example.test/a', 'https://example.test/b'] };
  assert.equal(collectionReturnUrl(task, 'https://example.test/b'), 'https://example.test/');
  assert.equal(collectionReturnUrl(task, 'https://example.test/'), undefined);
});
test('collection verification can prove the observed entry and successful detail navigation', () => {
  const task = { ...newTask('从目录采集详情'), plan, visited: ['https://example.test/', 'https://example.test/a'],
    history: [{ before_url: 'https://example.test/', after_url: 'https://example.test/a', outcome: 'failed' },
      { before_url: 'https://example.test/', after_url: 'https://example.test/a', outcome: 'observed', label: '详情' }] };
  const evidence = verificationEvidence(task, {});
  assert.deepEqual(evidence.filter(e => e.id.startsWith('visit:')), [
    { id: 'visit:0', url: 'https://example.test/' }, { id: 'visit:1', url: 'https://example.test/a' }]);
  assert.deepEqual(evidence.filter(e => e.id.startsWith('navigation:')).map(e => e.id), ['navigation:1']);
  assert.ok(!evidence.some(e => e.id === 'visit:2'));
});
test('date normalization is detected as unsupported instead of silently becoming a missing field', () => {
  const columns = ['名称', '发布日期'];
  const page = { url: 'https://example.test/a', content: 'Python 3.12.15 Release date: Sept. 30, 2026' };
  const raw = { rows: [{ values: { 名称: 'Python 3.12.15', 发布日期: '2026-09-30' },
    evidence: { 名称: 'Python 3.12.15', 发布日期: 'Release date: Sept. 30, 2026' } }] };
  assert.deepEqual(extractionIssues(raw, page, columns), [{ row: 0, column: '发布日期', value: '2026-09-30' }]);
  raw.rows[0].values.发布日期 = 'Sept. 30, 2026';
  assert.deepEqual(extractionIssues(raw, page, columns), []);
  assert.equal(groundedRows(raw, page, columns)[0].values.发布日期, 'Sept. 30, 2026');
});
test('a quote from the actual document title grounds the entity, while an invented title cannot', () => {
  const page = { url: 'https://example.test/release', title: 'Python Release Python 3.10.22 | Python.org',
    content: 'Python 3.10.22 Release date: Oct. 1, 2026' };
  const raw = { rows: [{ values: { 名称: 'Python 3.10.22' }, evidence: { 名称: page.title } }] };
  assert.deepEqual(extractionIssues(raw, page, ['名称']), []);
  assert.equal(groundedRows(raw, page, ['名称'])[0].values.名称, 'Python 3.10.22');
  raw.rows[0].evidence.名称 = 'Invented Release Python 3.10.22';
  assert.equal(extractionIssues(raw, page, ['名称']).length, 1);
  assert.equal(groundedRows(raw, page, ['名称']).length, 0);
});
test('numeric fragments and whole-page quotes do not ground, and a stale fragment can be cleared', () => {
  const page = { url: 'https://example.test/a', title: '库存', content: `库存：12 件 ${'说明'.repeat(120)}` };
  const columns = ['名称', '库存'];
  const fragment = { rows: [{ values: { 名称: '件', 库存: '1' }, evidence: { 名称: '件', 库存: '12' } }] };
  assert.deepEqual(extractionIssues(fragment, page, columns).map(issue => issue.value), ['1']);
  assert.equal(groundedRows(fragment, page, columns)[0].values.库存, null);
  const whole = { rows: [{ values: { 名称: '件', 库存: '12' },
    evidence: { 名称: '件', 库存: page.content } }] };
  assert.equal(extractionIssues(whole, page, columns).some(issue => issue.value === '12'), true);
  const grounded = groundedRows({ rows: [{ values: { 名称: '件', 库存: '12' },
    evidence: { 名称: '件', 库存: '库存：12 件' } }] }, page, columns);
  assert.equal(grounded[0].values.库存, '12');
  assert.equal(mergeRows(grounded, groundedRows(fragment, page, columns), columns, page)[0].values.库存, '12');
  const stale = { ...grounded[0], values: { ...grounded[0].values, 库存: '1' }, evidence: { 名称: '件', 库存: '1' } };
  assert.equal(mergeRows([stale], [{ ...stale, values: { 名称: '件', 库存: null } }], columns, page)[0].values.库存, null);
});
test('hash routes stay distinct and in-page anchors collapse to the document', () => {
  assert.equal(webUrl('https://app.example/#/item/2'), 'https://app.example/#/item/2');
  assert.equal(webUrl('https://example.com/page#section'), 'https://example.com/page');
  const routed = normalizePlan({ mode: 'collect', columns: ['名称'], checks: ['打开两条'], minRows: 2, minSources: 2 },
    '从 https://app.example/#/a 和 https://app.example/#/b 搜集', 'https://app.example/');
  assert.deepEqual(routed.startUrls, ['https://app.example/#/a', 'https://app.example/#/b']);
});
test('a cross-page goal defaults to two sources and an oversized plan is rejected before execution', () => {
  const deferred = normalizePlan({ mode: 'collect', columns: ['名称'], checks: ['整理两页'], minRows: 2 },
    '从 https://test.example/a 和 https://test.example/b 整理', 'https://test.example/');
  assert.equal(deferred.minSources, 2);
  assert.ok(planValidationError({ mode: 'collect', columns: ['名称'], checks: ['整理'], minRows: 101, minSources: 1 }, '整理产品'));
  assert.equal(planValidationError({ mode: 'collect', columns: ['名称'], checks: ['整理'], minRows: 2 },
    '从 https://test.example/a 和 https://test.example/b 整理').validationError.includes('minSources'), true);
});
test('an unfinished page window keeps collection from being marked ready', () => {
  const task = { plan, rows: [
    { values: { 名称: 'A' }, sourceUrl: plan.startUrls[0] },
    { values: { 名称: 'B' }, sourceUrl: plan.startUrls[1] },
  ], visited: plan.startUrls, contentCursor: { [plan.startUrls[0]]: 24000 } };
  assert.equal(collectionProgress(task).ready, false);
  delete task.contentCursor;
  assert.equal(collectionProgress(task).ready, true);
});
