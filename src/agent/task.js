const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { extractRequestedResultIndex } = require('./goalParse');

const LIMITS = Object.freeze({ steps: 60, pages: 12, rows: 100, activeMs: 10 * 60 * 1000, decisionRetries: 12 });
const QUOTE_CONTEXT = 160;
const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const isSourceColumn = column => /^(来源(?:页面|网址|链接)?|网址|链接|source(?:[ _]?(?:url|page))?|url)$/i.test(column);
function isHashRoute(url) {
  return url.hash.startsWith('#/') || url.hash.startsWith('#!/');
}
function webUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // In-page anchors are the same document. Hash paths are different routes and must be loaded.
    if (!isHashRoute(url)) url.hash = '';
    return url.href;
  } catch { return null; }
}
function crossPageGoal(goal) {
  const urls = [...String(goal || '').matchAll(/https?:\/\/[^\s，。；、<>"']+/g)];
  return urls.length > 1 || /跨页|多个(?:页面|网站|来源)|分别打开|不同的/.test(goal || '');
}
function planValidationError(value, goal) {
  if (!value || !['browse', 'collect'].includes(value.mode) || !Array.isArray(value.checks) || !value.checks.length ||
      value.checks.some(item => typeof item !== 'string' || !item.trim())) {
    return { validationError: 'Return mode browse/collect and 1 to 12 non-empty string checks.' };
  }
  if (value.checks.length > 12) {
    return { validationError: 'Use at most 12 checks. Narrow the goal instead of adding more conditions.' };
  }
  if (value.columns != null && (!Array.isArray(value.columns) || value.columns.length > 12 ||
      value.columns.some(item => typeof item !== 'string' || !item.trim()))) {
    return { validationError: 'columns must be at most 12 non-empty strings.' };
  }
  if (value.mode !== 'collect') return null;
  if (!Array.isArray(value.columns) || !value.columns.length || value.columns.length > 12 ||
      value.columns.some(item => typeof item !== 'string' || !item.trim())) {
    return { validationError: 'collect requires 1 to 12 non-empty string columns.' };
  }
  const rows = value.minRows == null ? 1 : Number(value.minRows);
  if (!Number.isInteger(rows) || rows < 1 || rows > LIMITS.rows) {
    return { validationError: `minRows must be an integer from 1 to ${LIMITS.rows}. Narrow the request; do not ask for every record on the site.` };
  }
  if (value.minSources == null && crossPageGoal(goal)) {
    return { validationError: 'This goal names multiple pages. Set minSources to the requested page count (at least 2, at most 12).' };
  }
  const sources = value.minSources == null ? 1 : Number(value.minSources);
  if (!Number.isInteger(sources) || sources < 1 || sources > LIMITS.pages) {
    return { validationError: `minSources must be an integer from 1 to ${LIMITS.pages}. Narrow the request.` };
  }
  return null;
}

function normalizePlan(raw, goal, currentUrl) {
  if (!raw || !['browse', 'collect'].includes(raw.mode)) throw new Error('任务规划格式无效');
  const explicitUrls = [...goal.matchAll(/https?:\/\/[^\s，。；、<>"']+/g)]
    .map(([url]) => webUrl(url.replace(/[),;]+$/, ''))).filter(Boolean);
  if (raw.columns != null && !Array.isArray(raw.columns) || !Array.isArray(raw.checks)) {
    throw new Error('任务字段与完成条件格式无效');
  }
  const columns = [...new Set((raw.columns || []).map(normalize).filter(Boolean))]
    .filter(column => raw.mode !== 'collect' || !isSourceColumn(column));
  const checks = raw.checks.map(normalize).filter(Boolean);
  if (!checks.length || checks.length > 12) throw new Error('任务需要明确的完成条件');
  if (raw.mode === 'collect' && (!columns.length || columns.length > 12)) {
    throw new Error('请明确要整理的字段，最多支持 12 列');
  }
  const minRows = raw.mode === 'collect' ? Number(raw.minRows ?? 1) : 0;
  const minSources = raw.mode === 'collect' ? Number(raw.minSources ?? (crossPageGoal(goal) ? 2 : 1)) : 0;
  if (raw.mode === 'collect' && (!Number.isInteger(minRows) || minRows < 1 || minRows > LIMITS.rows ||
      !Number.isInteger(minSources) || minSources < 1 || minSources > LIMITS.pages)) {
    throw new Error('本轮最多搜集 100 条记录、12 个页面；请缩小目标范围');
  }
  const startUrls = [...new Set(explicitUrls.length ? explicitUrls :
    [webUrl(raw.startUrl) || webUrl(currentUrl)].filter(Boolean))];
  if (!startUrls.length || startUrls.length > LIMITS.pages) throw new Error('需要有效的起始网址，最多 12 个');
  return { mode: raw.mode, columns, checks, minRows, minSources, startUrls,
    summary: normalize(raw.summary || goal).slice(0, 500) };
}

function newTask(goal) {
  return { version: 1, id: crypto.randomUUID(), goal, status: 'planning', plan: null,
    history: [], rows: [], visited: [], extracted: [], activeMs: 0, steps: 0,
    url: '', verification: null, createdAt: new Date().toISOString() };
}

function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isWord(ch) { return /[A-Za-z\u00C0-\u024F\u4e00-\u9fff]/.test(ch || ''); }
function bounded(text, at, needle) {
  const before = text[at - 1] || '', after = text[at + needle.length] || '';
  const prev = text[at - 2] || '', next = text[at + needle.length + 1] || '';
  const first = needle[0], last = needle[needle.length - 1];
  if (isDigit(last) && (isDigit(after) || ((after === '.' || after === ',') && isDigit(next)))) return false;
  if (isDigit(first) && (isDigit(before) || ((before === '.' || before === ',') && isDigit(prev)))) return false;
  if (isWord(last) && isWord(after)) return false;
  if (isWord(first) && isWord(before)) return false;
  return true;
}
function occursAsToken(haystack, needle) {
  if (!needle || !haystack) return false;
  let from = 0;
  while (from < haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    if (bounded(haystack, at, needle)) return true;
    from = at + 1;
  }
  return false;
}
// A cell is grounded only when the quote is a short window of the page and the value is a whole token in that quote.
function cellGrounded(body, quote, value) {
  if (!value || !quote || quote.length > value.length + QUOTE_CONTEXT) return false;
  return occursAsToken(body, quote) && occursAsToken(quote, value);
}
function pageBody(page) {
  return normalize([page.title, page.content || page.text].filter(Boolean).join(' '));
}

// Model-provided URLs and timestamps are deliberately ignored.
function groundedRows(raw, page, columns) {
  const body = pageBody(page);
  const url = webUrl(page.url);
  if (!url || !Array.isArray(raw?.rows)) throw new Error('信息提取格式无效');
  const rows = [];
  for (const candidate of raw.rows.slice(0, LIMITS.rows)) {
    const values = Object.create(null), evidence = Object.create(null);
    for (const column of columns) {
      if (isSourceColumn(column)) {
        values[column] = url;
        evidence[column] = url;
        continue;
      }
      const value = normalize(candidate.values?.[column]);
      const quote = normalize(candidate.evidence?.[column]);
      const grounded = cellGrounded(body, quote, value);
      values[column] = grounded ? value.slice(0, 2000) : null;
      if (grounded) evidence[column] = quote.slice(0, 4000);
    }
    // The first column identifies an entity; do not save an anonymous collection of prices.
    if (!values[columns[0]]) continue;
    rows.push({ values, evidence, sourceUrl: url, sourceTitle: page.title,
      collectedAt: new Date().toISOString() });
  }
  return rows;
}

function extractionIssues(raw, page, columns) {
  const body = pageBody(page);
  return (raw?.rows || []).flatMap((row, index) => columns.flatMap(column => {
    const value = normalize(row.values?.[column]), quote = normalize(row.evidence?.[column]);
    return !isSourceColumn(column) && value && !cellGrounded(body, quote, value)
      ? [{ row: index, column, value }] : [];
  }));
}
function evidenceSlack(quote, value) {
  const text = normalize(quote), item = normalize(value);
  if (!text || !item || !occursAsToken(text, item)) return Infinity;
  return text.length - item.length;
}

function collectionReturnUrl(task, currentUrl) {
  const sources = new Set(task.rows.map(row => row.sourceUrl));
  // A previously collected detail page is not a list to return to.
  return task.returnUrls?.filter(url => url !== currentUrl && !sources.has(url)).at(-1);
}

function mergeRows(existing, incoming, columns, page) {
  const body = page ? pageBody(page) : '';
  const rows = structuredClone(existing);
  for (const row of incoming) {
    const index = rows.findIndex(r => r.sourceUrl === row.sourceUrl &&
      normalize(r.values[columns[0]]) === normalize(row.values[columns[0]]));
    if (index < 0) {
      if (rows.length < LIMITS.rows) rows.push(row);
    } else {
      for (const column of columns) {
        const next = row.values[column];
        const prev = rows[index].values[column];
        if (next === null) {
          // A failed quote must not wipe a value that still appears on the page.
          if (prev !== null && body && !cellGrounded(body, rows[index].evidence?.[column], prev)) {
            rows[index].values[column] = null;
            delete rows[index].evidence[column];
          }
          continue;
        }
        if (prev === null || prev === next ||
            evidenceSlack(row.evidence[column], next) < evidenceSlack(rows[index].evidence?.[column], prev)) {
          rows[index].values[column] = next;
          rows[index].evidence[column] = row.evidence[column];
        }
      }
      if (!normalize(rows[index].values[columns[0]])) rows.splice(index, 1);
    }
  }
  return rows;
}

function collectionProgress(task) {
  const plan = task.plan;
  const sources = new Set(task.rows.map(r => r.sourceUrl)).size;
  const remaining = plan.startUrls.filter(url => !task.visited.includes(url) && !(task.sourceVisits || []).includes(url));
  const unread = Object.keys(task.contentCursor || {}).length > 0;
  const ready = task.rows.length >= plan.minRows && sources >= plan.minSources && !remaining.length && !unread;
  return { rows: task.rows.length, sources, remaining, ready,
    message: `已搜集 ${task.rows.length}/${plan.minRows} 条，${sources}/${plan.minSources} 个来源页面` };
}

function verificationEvidence(task, page) {
  if (task.plan.mode === 'collect') {
    return [
      ...task.visited.map((url, index) => ({ id: `visit:${index}`, url })),
      ...task.history.flatMap((h, index) => h.outcome === 'observed' && !h.error &&
        h.before_url !== h.after_url && webUrl(h.before_url) && webUrl(h.after_url)
        ? [{ id: `navigation:${index}`, fromUrl: h.before_url, destinationUrl: h.after_url, clickedLabel: h.label }] : []),
      ...task.rows.map((row, index) => ({ id: `row:${index}`, ...row })),
      { id: 'collection:counts', ...collectionProgress(task),
        output: { kind: 'table', rowCount: task.rows.length, columns: [...task.plan.columns, '来源网址'], csvAvailable: true },
        columns: task.plan.columns, missing: task.rows.map((row, index) => ({ row: index,
          columns: task.plan.columns.filter(column => row.values[column] === null) })) },
    ];
  }
  const fields = new Map();
  for (const action of page.actions || []) {
    if (action.kind !== 'fill' && action.kind !== 'select' && action.checked == null && action.selected == null) continue;
    fields.set(action.node, { label: action.label.split(' → ')[0],
      value: action.kind === 'select' ? action.current_value : action.value,
      checked: action.checked, selected: action.selected });
  }
  const navigations = task.history.flatMap((h, index) =>
    h.opened_target_result === true && h.outcome === 'observed' &&
    h.before_url !== h.after_url && h.after_url === page.url
      ? [{ id: `navigation:${index}`, fromUrl: h.before_url, fromTitle: h.before_title,
        searchQuery: h.search_query, resultOrdinal: h.search_result_ordinal,
        clickedLabel: h.label, destinationUrl: h.after_url }] : []);
  const interactions = task.history.flatMap((h, index) =>
    h.outcome === 'observed' && !h.error &&
    ((h.kind === 'fill' && h.text) || h.before_url !== h.after_url)
      ? [{ id: `interaction:${index}`, kind: h.kind, label: h.label,
        verifiedInput: h.kind === 'fill' ? h.text : undefined,
        fromUrl: h.before_url, toUrl: h.after_url }] : []);
  return [{ id: 'page:current', url: page.url, title: page.title,
    content: page.content || page.text, contentTruncated: page.contentTruncated !== false,
    fields: [...fields.values()] }, ...navigations, ...interactions];
}

function validateVerification(raw, task, page) {
  const checks = task.plan.checks;
  const catalog = verificationEvidence(task, page);
  const haystacks = task.plan.mode === 'collect'
    ? task.rows.map(r => normalize([r.sourceUrl, ...Object.values(r.evidence)].join(' ')))
    : [normalize([page.url, page.title, page.content || page.text,
      ...catalog[0].fields.map(field => `${field.label}: ${field.value ?? ''}`)].join(' '))];
  const items = checks.map((label, index) => {
    const answer = raw?.checks?.find(c => c.index === index);
    const evidence = normalize(answer?.evidence);
    const references = answer?.evidenceIds;
    const supported = Array.isArray(references)
      ? references.length > 0 && references.every(id => catalog.some(entry => entry.id === id))
      : evidence.length > 0 && haystacks.some(text => text.includes(evidence));
    return { label, satisfied: answer?.satisfied === true && supported,
      evidence: Array.isArray(references) ? references.join(', ') : evidence };
  });
  const ordinal = task.plan.mode === 'browse' && extractRequestedResultIndex(task.goal);
  const opened = !ordinal || task.history.some(h => h.search_result_ordinal === ordinal &&
    h.opened_target_result === true && h.before_url !== h.after_url && h.after_url === page.url);
  if (!opened) items.push({ label: `第 ${ordinal} 条结果已实际打开`, satisfied: false, evidence: '' });
  const ready = task.plan.mode !== 'collect' || collectionProgress(task).ready;
  return { complete: ready && items.every(c => c.satisfied), checks: items,
    reason: normalize(raw?.reason || '完成条件尚未全部满足').slice(0, 600),
    checkedAt: new Date().toISOString() };
}

function toCsv(task) {
  if (!task?.plan || task.plan.mode !== 'collect') throw new Error('当前没有可导出的表格');
  const cell = (value) => {
    let text = String(value ?? '未找到');
    if (/^[\s]*[=+\-@]|^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const columns = task.plan.columns;
  return '\uFEFF' + [ [...columns, '来源网址', '采集时间'],
    ...task.rows.map(r => [...columns.map(c => r.values[c]), r.sourceUrl, r.collectedAt]) ]
    .map(row => row.map(cell).join(',')).join('\r\n');
}

class TaskStore {
  constructor(directory) { this.file = path.join(directory, 'current-task.json'); }
  save(task) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(task), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  load() {
    if (!fs.existsSync(this.file)) return null;
    const task = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (task.version !== 1 || typeof task.id !== 'string' || typeof task.goal !== 'string' ||
        !Array.isArray(task.history) || !Array.isArray(task.rows) || !Array.isArray(task.visited)) {
      throw new Error('任务记录格式无效');
    }
    return task;
  }
}

module.exports = { LIMITS, normalize, webUrl, crossPageGoal, planValidationError, normalizePlan, newTask, groundedRows,
  extractionIssues, collectionReturnUrl, mergeRows, collectionProgress, verificationEvidence, validateVerification, toCsv, TaskStore };
