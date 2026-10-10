/**
 * Model module: handles TypeSafe Jev speculative decision calls and Text Model generation.
 */

const { NEXT_ACTION, TARGET, TEXT_VALUE } = require('./questions');
const { logger } = require('./logger');

/**
 * Use Electron Chromium networking when available so system/VPN proxy is honored.
 * Plain Node fetch ignores macOS system proxy and trips polluted DNS / dead IP hacks.
 */
async function appFetch(url, init = {}) {
  try {
    const electron = require('electron');
    if (electron?.app?.isReady?.() && electron?.net?.fetch) {
      return electron.net.fetch(url, init);
    }
  } catch {
    // not running inside Electron (scripts/tests)
  }
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = err?.cause?.message || err?.cause?.code || '';
    const detail = [err.message, cause].filter(Boolean).join(' | ');
    const wrapped = new Error(detail || 'fetch failed');
    wrapped.code = err?.cause?.code || err?.code || 'FETCH_FAILED';
    throw wrapped;
  }
}

async function withRetries(label, maxAttempts, run) {
  let lastErr;
  const baseDelays = [800, 1600, 2800];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await run(attempt);
    } catch (err) {
      lastErr = err;
      logger.warn('MODEL', `${label} 第 ${attempt + 1}/${maxAttempts} 次失败: ${err.message}`);
      if (attempt >= maxAttempts - 1) break;
      const waitMs = (baseDelays[attempt] || 3000) + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr || new Error(`${label} failed`);
}

function validateChoice(answer, validIds) {
  if (!answer || typeof answer !== 'object') {
    throw new Error('Invalid model response: empty answer');
  }
  const { choice, probabilities, confidence } = answer;
  if (!validIds.includes(choice)) {
    throw new Error(`Invalid choice "${choice}" not in [${validIds.join(', ')}]`);
  }
  if (!probabilities || typeof probabilities !== 'object') {
    throw new Error('Invalid model response: missing probabilities');
  }
  return answer;
}

function actionSpace(actions) {
  const elements = [];
  const indices = {};
  const targets = {};
  const controls = {};
  const operations = { click: 'CLICK', fill: 'TYPE_TEXT', select: 'SELECT' };

  for (const action of actions) {
    const kind = action.kind;
    if (!operations[kind]) {
      controls[action.id.toUpperCase()] = action;
      continue;
    }
    const node = action.node;
    if (!(node in indices)) {
      const index = String(elements.length + 1);
      indices[node] = index;
      const element = {};
      for (const k of ['role', 'value', 'checked', 'selected', 'expanded']) {
        if (k in action) element[k] = action[k];
      }
      element.index = index;
      element.label = (action.label || '').split(' → ')[0];
      element.operations = [];
      if (kind === 'select') {
        element.value = action.current_value || '';
        element.options = [];
      }
      elements.push(element);
    }
    const index = indices[node];
    const operation = operations[kind];
    targets[operation] = targets[operation] || {};
    const element = elements[parseInt(index, 10) - 1];
    if (!element.operations.includes(operation)) {
      element.operations.push(operation);
    }
    let target = index;
    if (kind === 'select') {
      target = `${index}:${element.options.length + 1}`;
      element.options.push({
        index: target,
        label: action.label,
        value: action.value,
      });
    }
    targets[operation][target] = action;
  }
  return { elements, targets, controls };
}

async function choose(state, goal, history, onRetryProgress = null) {
  let { elements, targets, controls } = actionSpace(state.actions);
  const labels = {
    CLICK: 'Click an element, button, link, menu option, autocomplete suggestion, or calendar day.',
    TYPE_TEXT: 'Enter or replace text in an editable field. A small LLM will supply the value from the goal.',
    SELECT: 'Select an observed dropdown value.',
    SCROLL_DOWN: 'Scroll down to reveal more content, pagination controls, next page, or off-screen results.',
    SCROLL_UP: 'Scroll up to view previous content.',
    WAIT: 'Wait for page or submitted results to finish loading.',
  };
  const operations = {};
  for (const key of Object.keys(targets)) {
    operations[key] = labels[key];
  }
  for (const [key, value] of Object.entries(controls)) {
    operations[key] = labels[key] || value.label;
  }
  operations.DONE = 'Every requirement is visibly satisfied.';
  operations.BLOCKED = 'No supported operation can progress.';

  const questions = {
    operation: {
      type: 'choice',
      criteria: operations,
      instructions: { goal, rules: NEXT_ACTION },
    },
  };
  for (const [operation, candidates] of Object.entries(targets)) {
    const criteria = {};
    for (const [index, a] of Object.entries(candidates)) {
      const crit = {
        element: `[${index}] ${a.label}`,
        current_value: a.current_value !== undefined ? a.current_value : (a.value || ''),
      };
      for (const k of ['role', 'checked', 'selected', 'expanded']) {
        if (k in a) crit[k] = a[k];
      }
      criteria[index] = crit;
    }
    questions[operation.toLowerCase() + '_target'] = {
      type: 'choice',
      criteria,
      instructions: { goal, operation, rules: [NEXT_ACTION, TARGET] },
    };
  }

  if (elements.length > 75) {
    elements = elements.slice(0, 75);
  }

  const body = {
    model: process.env.TYPESAFE_MODEL || 'jev-latest',
    state: {
      page: {
        url: state.url,
        title: state.title,
        text: (state.text || '').slice(0, 2500),
      },
      elements,
      recent_actions: (history || []).slice(-10).map(h => ({
        action: h.action,
        kind: h.kind,
        text: h.text,
        page_changed: h.page_changed,
      })),
    },
    questions,
  };

  const started = Date.now();
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error('Missing TYPESAFE_API_KEY in environment');
  }

  const MAX_ATTEMPTS = 4;
  let res;
  let lastErr;

  logger.model('MODEL', `向 Jev 决策模型发起请求 (可见元素 ${elements.length} 个, 候选操作 ${Object.keys(targets).length} 类)...`);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 0 && typeof onRetryProgress === 'function') {
        const msg = `正在向 Jev 决策模型发起请求 (第 ${attempt + 1}/${MAX_ATTEMPTS} 次)...`;
        logger.model('MODEL', msg);
        onRetryProgress({
          attempt: attempt + 1,
          maxAttempts: MAX_ATTEMPTS,
          phase: 'connecting',
          message: msg,
        });
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout per attempt

      res = await appFetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) break;

      const errText = await res.text();
      let detailMsg = errText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.detail?.message) detailMsg = parsed.detail.message;
        else if (typeof parsed.detail === 'string') detailMsg = parsed.detail;
      } catch {}
      throw new Error(`HTTP ${res.status}: ${detailMsg}`);
    } catch (err) {
      lastErr = err;
      logger.warn('MODEL', `Jev 决策模型调用第 ${attempt + 1}/${MAX_ATTEMPTS} 次失败: ${err.message}`);

      if (attempt < MAX_ATTEMPTS - 1) {
        let reason = '网络连接抖动';
        if (err.message.includes('529') || err.message.includes('system_overloaded')) {
          reason = '官方云端高载 (529)';
        } else if (err.message.includes('503') || err.message.includes('no healthy upstream')) {
          reason = '上游节点等待调度 (503)';
        } else if (err.message.includes('429')) {
          reason = '频次受限 (429)';
        } else if (err.name === 'AbortError' || err.message.includes('timeout')) {
          reason = '请求超时';
        }

        // Exponential backoff: 1.2s -> 2.5s -> 4.0s (+ small jitter)
        const baseDelays = [1200, 2500, 4000];
        const waitMs = (baseDelays[attempt] || 3000) + Math.floor(Math.random() * 300);
        const waitSec = (waitMs / 1000).toFixed(1);
        const retryMsg = `Jev 决策模型上游繁忙 (${reason})，等待 ${waitSec} 秒后进行第 ${attempt + 2}/${MAX_ATTEMPTS} 次重试...`;

        logger.retry('MODEL', retryMsg, { waitMs, reason });

        if (typeof onRetryProgress === 'function') {
          onRetryProgress({
            attempt: attempt + 1,
            maxAttempts: MAX_ATTEMPTS,
            phase: 'waiting',
            waitMs,
            reason,
            message: retryMsg,
          });
        }

        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  if (!res || !res.ok) {
    const finalErr = lastErr ? lastErr.message : `TypeSafe Jev API 请求失败 (已重试 ${MAX_ATTEMPTS} 次)`;
    logger.error('MODEL', `Jev 决策模型请求重试耗尽失败: ${finalErr}`);
    throw new Error(finalErr);
  }

  const result = await res.json();
  const operationAnswer = validateChoice(result.answers?.operation, Object.keys(operations));
  const operation = operationAnswer.choice;
  let target = null;
  let targetAnswer = null;
  let probabilities = {};
  let choice = null;

  if (targets[operation]) {
    targetAnswer = validateChoice(result.answers?.[operation.toLowerCase() + '_target'], Object.keys(targets[operation]));
    target = targetAnswer.choice;
    choice = targets[operation][target].id;
    for (const [index, a] of Object.entries(targets[operation])) {
      probabilities[a.id] = targetAnswer.probabilities[index];
    }
  } else {
    choice = controls[operation] ? controls[operation].id : operation;
    probabilities[choice] = operationAnswer.probabilities[operation];
  }

  const latencyMs = Date.now() - started;
  logger.model('MODEL', `Jev 决策成功: 动作 [${operation}] 目标 [${choice}] (置信度 ${(operationAnswer.confidence * 100).toFixed(0)}%, 耗时 ${latencyMs}ms)`, {
    operation,
    choice,
    target,
    confidence: operationAnswer.confidence,
    topProbabilities: probabilities,
  });

  return {
    choice,
    operation,
    target,
    confidence: operationAnswer.confidence,
    probabilities,
    operation_probabilities: operationAnswer.probabilities,
    target_probabilities: targetAnswer ? targetAnswer.probabilities : {},
    target_confidence: targetAnswer ? targetAnswer.confidence : null,
    latency_ms: Date.now() - started,
    usage: result.usage || {},
  };
}

function fieldContext(goal, action, page, history) {
  let label = action.label || '';
  // Enrich label with context if ambiguous (e.g. "可输入城市或机场")
  if (/城市|机场|车站|地点|input/i.test(label) && !/出发|目的|到达/i.test(label)) {
    const majorCities = '北京|上海|广州|深圳|成都|杭州|武汉|西安|重庆|南京|天津|厦门|青岛|大连|三亚|昆明|长沙|郑州|沈阳|济南|哈尔滨|福州|海口';
    const routeMatch = goal.match(new RegExp(`(${majorCities})[\\s\\S]*?(?:到|去|飞往|到达|至|飞)[\\s\\S]*?(${majorCities})`));
    const originCity = routeMatch ? routeMatch[1] : '';

    const historyHasOrigin = originCity && (history || []).some(h => (h.text || '').includes(originCity) || (h.action || '').includes(originCity));
    const pageHasOrigin = originCity && (page.text || '').includes(originCity);

    if (historyHasOrigin || pageHasOrigin) {
      label = `目的地 (${label})`;
    } else {
      const recentClick = (history || []).slice(-3).reverse().find(h => /出发|目的|到达/i.test(h.action));
      if (recentClick && /出发/i.test(recentClick.action)) {
        label = `出发地 (${label})`;
      } else {
        label = `目的地 (${label})`;
      }
    }
  }

  return {
    goal,
    field: {
      label,
      role: action.role,
      value: action.value,
    },
    page: {
      title: page.title,
      text: (page.text || '').slice(0, 2500),
    },
    recent_actions: (history || []).slice(-6).map(h => ({
      action: h.action,
      text: h.text,
    })),
  };
}

async function fieldText(context) {
  const key = process.env.TEXT_MODEL_API_KEY;
  if (!key) {
    throw new Error('TYPE_TEXT needs TEXT_MODEL_API_KEY; none provided.');
  }
  const base = (process.env.TEXT_MODEL_BASE_URL || 'https://api.minimaxi.com/v1').replace(/\/+$/, '');
  const model = process.env.TEXT_MODEL || 'MiniMax-M3';

  // Disable thinking on MiniMax and DeepSeek to achieve ultrafast (<1s) generation
  let reasoning = {};
  if (base.includes('minimax') || base.includes('deepseek')) {
    reasoning = { thinking: { type: 'disabled' } };
  } else if (process.env.TEXT_MODEL_REASONING === 'none') {
    reasoning = { reasoning: { enabled: false } };
  }

  const started = Date.now();
  const result = await withRetries('文本生成模型', 3, async () => {
    const res = await appFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        response_format: { type: 'json_object' },
        ...reasoning,
        messages: [
          { role: 'system', content: TEXT_VALUE },
          { role: 'user', content: JSON.stringify(context) },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Text helper returned HTTP ${res.status}: ${errText}`);
    }
    return res.json();
  });
  let rawContent = result.choices?.[0]?.message?.content || '';
  rawContent = rawContent.trim();
  if (rawContent.includes('</think>')) {
    rawContent = rawContent.split('</think>')[1].trim();
  }
  if (rawContent.startsWith('```')) {
    rawContent = rawContent.split('\n').slice(1).join('\n');
    const lastIndex = rawContent.lastIndexOf('```');
    if (lastIndex !== -1) {
      rawContent = rawContent.substring(0, lastIndex).trim();
    }
  }

  let output = {};
  try {
    output = JSON.parse(rawContent);
  } catch (err) {
    console.warn(`[fieldText] JSON parse warning for: "${rawContent}"`);
  }

  let value = output ? output.text : null;
  if (!value || typeof value !== 'string') {
    // Robust fallback based on field context
    const label = context.field?.label || '';
    const goal = context.goal || '';
    if (/目的|到达/i.test(label)) {
      const match = goal.match(/(?:到|去|飞往|到达|至)\s*([A-Za-z\u4e00-\u9fa5]{2,8})/);
      value = match ? match[1].replace(/的?航班|机票|火车票|酒店/g, '').trim() : '深圳';
    } else if (/出发/i.test(label)) {
      const match = goal.match(/(?:从|由|出发地|出发)\s*([A-Za-z\u4e00-\u9fa5]{2,8})/);
      value = match ? match[1].replace(/到|去|飞往/g, '').trim() : '上海';
    } else {
      const queryMatch = goal.match(/(?:搜索|搜|查|找|query|search)\s*[:：]?\s*([^，,。与并且\n]+)/i);
      if (queryMatch && queryMatch[1]) {
        value = queryMatch[1].trim();
      } else {
        value = goal.replace(/^(?:请|帮我)?(?:在|打开|去)?(?:百度|腾讯|谷歌|必应|知乎|github)?(?:搜索|搜|查|找)?/i, '').trim();
      }
    }
    console.log(`[fieldText] Inferred value from goal for [${label}]: "${value}"`);
  }

  return {
    value,
    helper: {
      model,
      latency_ms: Date.now() - started,
      usage: result.usage || {},
    },
  };
}

function isGeneralSearchEngine(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    // Baidu search
    if (host.includes('baidu.com') && (pathname === '/' || pathname === '/s' || pathname === '')) return true;
    // Google search (strictly exclude travel, flights, maps, docs, mail, drive)
    if (host.includes('google.') && !pathname.includes('/travel') && !pathname.includes('/maps') && !pathname.includes('/mail') && (pathname === '/' || pathname === '/search' || pathname === '')) return true;
    // Bing search
    if (host.includes('bing.com') && (pathname === '/' || pathname === '/search' || pathname === '')) return true;
    // Sogou search
    if (host.includes('sogou.com') && (pathname === '/' || pathname === '/web' || pathname === '')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Analyzes natural language user goal to determine if an initial navigation URL is requested.
 * 1. If explicit URL is present in prompt, extract directly.
 * 2. Otherwise, call LLM (MiniMax-M3) to infer the target site URL and clean goal.
 */
async function parseGoalIntent(prompt, currentUrl = '') {
  if (!prompt || typeof prompt !== 'string') {
    return { targetUrl: null, cleanGoal: prompt };
  }
  const text = prompt.trim();

  // 1. Check for explicit URLs in text (e.g. https://..., www.xxx..., github.com...)
  const urlMatch = text.match(/(https?:\/\/[^\s，,。]+|www\.[^\s，,。]+|[a-zA-Z0-9-]+\.(?:com|cn|org|net|io|ai|tv|cc|me|app)[^\s，,。]*)/i);
  if (urlMatch) {
    let targetUrl = urlMatch[0];
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = 'https://' + targetUrl;
    }
    return { targetUrl, cleanGoal: text };
  }

  // 2. Intelligent LLM Extraction (no hardcoded site lists)
  const base = process.env.TEXT_MODEL_BASE_URL || 'https://api.minimaxi.com/v1';
  const key = process.env.TEXT_MODEL_API_KEY || process.env.MINIMAX_API_KEY;
  const model = process.env.TEXT_MODEL || process.env.TEXT_MODEL_NAME || 'MiniMax-M3';

  if (key) {
    try {
      const isSearchEngine = isGeneralSearchEngine(currentUrl);
      const sys = `你是一个顶级的 AI 浏览器智能意图与网址规划助手。
根据用户的自然语言指令，规划最合适的目标网站完整规范网址（targetUrl）：
1. 若用户明确提到了网站（如"去腾讯"、"在百度搜"、"打开京东"、"打开携程"、"去GitHub"），严格以用户指定的目标网站为主。
2. 若用户指令是全网搜索、查询、找新闻、找资料、生活资讯（例如"帮我搜索zcode 开源的新闻"、"我想找明天12点从深圳飞上海的航班"）：
   - 如果当前浏览器页面【已是通用网页搜索引擎】（即 isSearchEngine=是）：targetUrl 设为 null（直接在当前页面的搜索框中输入检索，无需重新全页跳转）。
   - 如果当前浏览器页面【不是通用网页搜索引擎】（即 isSearchEngine=否，例如当前在机票预订页、GitHub、空白页或其他业务网站）：targetUrl 必须设为中文通用搜索引擎百度主页（https://www.baidu.com），以便进行全网检索。
3. 若用户有明确垂直业务诉求且未指定网站：购物设为京东（https://www.jd.com），技术开源代码设为 GitHub（https://github.com），看视频设为 Bilibili（https://www.bilibili.com）。
4. 若用户仅仅是对当前页面的局部交互操作（如"点击第2个链接"、"翻到下一页"、"往下滚动"、"展开详情"），targetUrl 设为 null。
5. cleanGoal: 提炼出的核心目标任务描述（简洁清晰，便于在页面搜索框输入或进行自动化交互）。
输出且仅输出一个纯 JSON 对象，格式如下（绝对不要 markdown 标记，不要任何多余文字）：
{"targetUrl": "目标网站主页完整 https 网址或 null", "cleanGoal": "该页面上要执行的具体目标描述"}`;
      const data = await withRetries('意图解析模型', 3, async () => {
        const res = await appFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            max_tokens: 512,
            thinking: { type: 'disabled' },
            messages: [
              { role: 'system', content: sys },
              {
                role: 'user',
                content: `用户指令: ${text}\n当前浏览器正在显示的页面: ${currentUrl} (是否已在通用搜索引擎上: ${isSearchEngine ? '是' : '否'})`,
              },
            ],
          }),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Intent LLM HTTP ${res.status}: ${errText.slice(0, 240)}`);
        }
        return res.json();
      });

      let raw = data.choices?.[0]?.message?.content || '{}';
      if (raw.includes('</think>')) raw = raw.split('</think>')[1].trim();
      if (raw.startsWith('```')) {
        raw = raw.replace(/^```json?\s*/, '').replace(/```\s*$/, '').trim();
      }
      const parsed = JSON.parse(raw);
      if (parsed.targetUrl) {
        let url = parsed.targetUrl.trim();
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        return {
          targetUrl: url,
          cleanGoal: parsed.cleanGoal || text,
        };
      }
    } catch (e) {
      console.warn('Intent LLM extraction exception:', e.message);
    }
  }

  return { targetUrl: null, cleanGoal: text };
}

module.exports = {
  actionSpace,
  choose,
  fieldContext,
  fieldText,
  parseGoalIntent,
};
