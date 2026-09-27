/**
 * AgentRunner: Manages the Jev execution loop on an Electron WebContentsView via native CDP debugger.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { SNAPSHOT_SCRIPT } = require('./snapshot');
const { choose, fieldContext, fieldText } = require('./model');
const { MAX_STEPS } = require('./questions');
const { logger } = require('./logger');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function extractRequestedResultIndex(goal) {
  if (!goal) return null;
  const numMap = {
    '一': 1, '1': 1,
    '二': 2, '两': 2, '2': 2,
    '三': 3, '3': 3,
    '四': 4, '4': 4,
    '五': 5, '5': 5,
    '六': 6, '6': 6,
    '七': 7, '7': 7,
    '八': 8, '8': 8,
    '九': 9, '9': 9,
    '十': 10, '10': 10,
  };

  const cnMatch = goal.match(/(?:点开|打开|点击|查看|进入|浏览)?第\s*([0-9一二两三四五六七八九十]+)\s*(?:个|条|项)\s*(?:搜索结果|结果|链接|网页|新闻|内容)?/i)
    || goal.match(/第\s*([0-9一二两三四五六七八九十]+)\s*(?:个|条|项)?(?:搜索结果|结果|链接)/i);

  if (cnMatch) {
    const raw = cnMatch[1].trim();
    if (numMap[raw]) return numMap[raw];
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  const enMap = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5 };
  const enMatch = goal.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:search\s+)?(?:result|link)\b/i)
    || goal.match(/\b(?:result|link)\s*#?\s*([1-9]\d*)\b/i);
  if (enMatch) {
    const raw = enMatch[1].toLowerCase();
    if (enMap[raw]) return enMap[raw];
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  return null;
}

function extractTargetPage(goal) {
  if (!goal) return null;
  const numMap = {
    '一': 1, '1': 1,
    '二': 2, '两': 2, '2': 2,
    '三': 3, '3': 3,
    '四': 4, '4': 4,
    '五': 5, '5': 5,
    '六': 6, '6': 6,
    '七': 7, '7': 7,
    '八': 8, '8': 8,
    '九': 9, '9': 9,
    '十': 10, '10': 10,
  };
  const m = goal.match(/(?:翻到|前往|进入|转到|去|到)?\s*第\s*([0-9一二两三四五六七八九十]+)\s*页/i)
    || goal.match(/page\s*([0-9]+)/i);
  if (!m) return null;
  const raw = m[1].trim();
  if (numMap[raw]) return numMap[raw];
  const parsed = parseInt(raw, 10);
  return (!isNaN(parsed) && parsed > 0) ? parsed : null;
}

function isTargetPageReached(page, history, targetPageNum) {
  if (!targetPageNum || targetPageNum <= 1) return true;

  const url = page?.url || '';
  // Baidu: pn = (page - 1) * 10
  const expectedBaiduPn = (targetPageNum - 1) * 10;
  if (/baidu\.com\/s/i.test(url)) {
    const pnMatch = url.match(/[?&]pn=(\d+)/);
    if (pnMatch && parseInt(pnMatch[1], 10) === expectedBaiduPn) {
      return true;
    }
  }

  // Google / Bing / generic: page=2 or start=10
  if (new RegExp(`[?&]page=${targetPageNum}\\b`, 'i').test(url)) {
    return true;
  }

  // Check history: did we successfully click "下一页" or "第 N 页" with page_changed === true?
  const hasNavigatedToTargetPage = history.some((h) => {
    if (!h.page_changed) return false;
    const actionText = (h.action || '').toLowerCase();
    return (
      actionText.includes(`第 ${targetPageNum} 页`) ||
      actionText.includes(`page ${targetPageNum}`) ||
      (targetPageNum === 2 && (actionText.includes('下一页') || actionText.includes('next page')))
    );
  });
  if (hasNavigatedToTargetPage) {
    return true;
  }

  // Check page text/active pagination element
  if (page?.text && new RegExp(`第\\s*${targetPageNum}\\s*页`, 'i').test(page.text)) {
    if (/baidu\.com|google|bing/i.test(url)) {
      return true;
    }
  }

  return false;
}


class AgentRunner extends EventEmitter {
  constructor(webContents) {
    super();
    this.webContents = webContents;
    this.status = 'idle'; // idle, running, paused, done, blocked, error
    this.goal = '';
    this.history = [];
    this.decisions = [];
    this.page = null;
    this.decision = null;
    this.pendingText = null;
    this.startedAt = null;
    this.stepMode = false;
    this.isPaused = false;
    this.isRunning = false;
    this.debuggerAttached = false;
    this.blockedReason = null;
  }

  async attachDebugger() {
    if (this.debuggerAttached) return;
    try {
      this.webContents.debugger.attach('1.3');
      this.debuggerAttached = true;
      this.webContents.debugger.on('detach', () => {
        this.debuggerAttached = false;
      });
      await this.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (err) {
      if (!String(err).includes('Already attached')) {
        throw err;
      }
      this.debuggerAttached = true;
    }
  }

  async sendCdp(method, params = {}) {
    await this.attachDebugger();
    return this.webContents.debugger.sendCommand(method, params);
  }

  async observe() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const info = await this.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
        if (!info) {
          await sleep(50);
          continue;
        }
        info.fingerprint = sha256({
          url: info.url,
          text: info.text,
          actions: info.actions,
          scroll: info.scroll,
        });
        logger.info('OBSERVE', `网页状态提取成功 (${info.actions?.length || 0} 个可操作元素, 页面: "${info.title || info.url}")`);
        return info;
      } catch (err) {
        if (attempt === 4) throw err;
        await sleep(50);
      }
    }
    throw new Error('Failed to observe page after 5 attempts');
  }

  async waitAfterInput(action) {
    if (!action || action.kind === 'wait') return;
    const isDialogCloser = action.label && /(done|apply|confirm|search)/i.test(action.label);
    try {
      await this.webContents.executeJavaScript(`
        ((action) => new Promise((resolve) => {
          const field = window.__jevFast?.nodes.get(action.node);
          const autocomplete = action.kind === 'fill' && field?.getAttribute('role') === 'combobox';
          let frames = 0, stopped = false;
          const finish = () => { stopped = true; resolve(); };
          setTimeout(finish, ${isDialogCloser ? 350 : 80});
          const ready = () => {
            if (stopped) return;
            const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '')
              .split(/\\s+/).filter(Boolean);
            const roots = ids.length ? ids.map(id => document.getElementById(id)).filter(Boolean) : [document];
            const options = roots.flatMap(root => [...root.querySelectorAll('[role="option"]')]);
            if (++frames >= 2 && (!autocomplete || options.some(e => {
              const r = e.getBoundingClientRect();
              return r.width && r.height && r.bottom > 0 && r.top < innerHeight &&
                e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
            }))) {
              finish();
            } else {
              requestAnimationFrame(ready);
            }
          };
          requestAnimationFrame(ready);
        }))(${JSON.stringify(action)})
      `);
    } catch {
      // Ignore if document navigates
    }
  }

  async act(action, page, text = null) {
    const kind = action.kind;
    if (kind === 'scroll') {
      await this.webContents.executeJavaScript(`window.scrollBy({ top: ${action.delta}, behavior: 'instant' });`);
      try {
        await this.sendCdp('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 400,
          y: 400,
          deltaX: 0,
          deltaY: action.delta,
        });
      } catch {}
      await sleep(250);
      return { executed: action.id };
    }

    if (kind === 'wait') {
      await sleep(100);
      return { executed: action.id };
    }

    // Geometry & hit-testing
    const target = await this.webContents.executeJavaScript(`
      ((action) => {
        const e = window.__jevFast?.nodes.get(action.node);
        if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
            !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
        try { e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
        const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        const clampedX = Math.max(r.left + 5, Math.min(x, innerWidth - 5));
        const clampedY = Math.max(r.top + 5, Math.min(y, innerHeight - 5));
        if (!r.width || !r.height || clampedX < 0 || clampedY < 0 || clampedX >= innerWidth || clampedY >= innerHeight) return null;
        const hit = document.elementFromPoint(clampedX, clampedY);
        if (hit && !e.contains(hit) && !hit.contains(e)) {
          const hitBtn = hit.closest('button, [role="button"], label, a, [role="combobox"], [role="searchbox"], li');
          const eBtn = e.closest('button, [role="button"], label, a, [role="combobox"], [role="searchbox"], li');
          const sameControl = (hitBtn && (hitBtn === e || hitBtn === eBtn)) || (eBtn && eBtn.contains(hit));
          const sameParent = e.parentElement && (e.parentElement === hit || e.parentElement.contains(hit) || hit.parentElement === e.parentElement);
          const commonPager = e.closest('.paging, .pagination, [class*="pager"], [class*="pagination"], form, nav, #page');
          const isPagerHit = commonPager && commonPager.contains(hit);
          if (!sameControl && !sameParent && !isPagerHit) {
            try { e.click(); return { x: clampedX, y: clampedY, domClicked: true }; } catch {}
            return null;
          }
        }
        if (action.kind === 'select') {
          if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value &&
              !o.disabled && !o.closest('optgroup[disabled]'))) return null;
          e.value = action.value;
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { x: clampedX, y: clampedY };
      })(${JSON.stringify(action)})
    `);

    if (!target) {
      throw new Error(`Target [${action.label}] is obscured, disabled, or stale`);
    }

    if (kind !== 'select' && !target.domClicked) {
      const { x, y } = target;
      await this.sendCdp('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      await this.sendCdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
    }

    if (kind === 'fill') {
      // 1. Focus element and directly inject value using prototype setter to support Vue/React/SPA
      await this.webContents.executeJavaScript(`
        ((action, text) => {
          const field = window.__jevFast?.nodes.get(action.node);
          if (field) {
            field.focus();
            try { field.select(); } catch {}
            const isInput = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
            if (isInput) {
              const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) {
                setter.call(field, text || '');
              } else {
                field.value = text || '';
              }
            } else if (field.isContentEditable) {
              field.innerText = text || '';
            }
            field.dispatchEvent(new Event('focus', { bubbles: true }));
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })(${JSON.stringify(action)}, ${JSON.stringify(text || '')})
      `).catch(() => {});

      // 2. Also send CDP keyboard selectAll + insertText for full browser-level fidelity
      await this.sendCdp('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: process.platform === 'darwin' ? 4 : 2,
        commands: ['selectAll'],
      }).catch(() => {});
      await this.sendCdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        modifiers: process.platform === 'darwin' ? 4 : 2,
      }).catch(() => {});
      await this.sendCdp('Input.insertText', { text: text || '' }).catch(() => {});

      await this.webContents.executeJavaScript(`
        (() => {
          const active = document.activeElement;
          if (active) {
            active.dispatchEvent(new Event('input', { bubbles: true }));
            active.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()
      `).catch(() => {});

      // 3. If typing into a general web search engine query box (Baidu, Google, Bing), dispatch Enter
      const isSearchEngine = /baidu\.com|google\.[a-z.]+|bing\.com|sogou\.com|so\.com/i.test(this.page?.url || '');
      const isWebSearchBox = isSearchEngine && (action.role === 'searchbox' || /网页搜索框|kw|wd|#su/i.test(action.label || ''));
      if (isWebSearchBox) {
        await sleep(100);
        await this.sendCdp('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: '\r',
          unmodifiedText: '\r',
        }).catch(() => {});
        await this.sendCdp('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        }).catch(() => {});
      }
    }

    await this.waitAfterInput(action);
    logger.action('ACT', `执行动作完成: [${action.kind}] on [${action.label || action.id}]${text ? ' 参数: "' + text + '"' : ''}`);
    return { executed: action.id };
  }

  async start(goal, initialHistory = []) {
    if (!goal || !goal.trim()) throw new Error('Provide a goal');
    this.goal = goal.trim();
    this.history = Array.isArray(initialHistory) ? [...initialHistory] : [];
    this.decisions = [];
    this.pendingText = null;
    this.decision = null;
    this.startedAt = Date.now();
    this.status = 'running';
    this.isPaused = false;
    this.isRunning = true;
    this.blockedReason = null;

    logger.info('AGENT', `启动 Agent 任务: "${this.goal}" (历史步数: ${this.history.length})`);
    this.emitState();

    try {
      this.page = await this.observe();

      while (this.isRunning && this.status !== 'done' && this.status !== 'blocked' && this.status !== 'waiting_for_user') {
        if (this.isPaused) {
          this.status = 'paused';
          this.emitState();
          break;
        }

        await this.tick();

        if (this.stepMode) {
          this.isPaused = true;
          this.status = 'paused';
          this.emitState();
          break;
        }
      }
    } catch (err) {
      this.status = 'error';
      this.emit('error', err.message);
      this.emitState();
      throw err;
    }
  }

  async tick() {
    this.status = 'deciding';
    this.emitState({
      tickerMessage: 'Jev 正在根据页面状态决策下一步动作...',
    });

    // 1. Predict with real-time retry feedback
    this.decision = await choose(this.page, this.goal, this.history, (progress) => {
      this.emitState({
        status: 'deciding',
        tickerMessage: progress.message,
        statusTextOverride: progress.phase === 'waiting'
          ? `服务高载等待 (${progress.attempt}/${progress.maxAttempts})`
          : `重试连接中 (${progress.attempt}/${progress.maxAttempts})`,
      });
    });
    let selected = this.decision.choice;

    // Prevent premature BLOCKED if scrolling down can reveal pagination or required content
    if (selected === 'BLOCKED') {
      const blockedPageNum = extractTargetPage(this.goal);
      if (blockedPageNum) {
        const pageBtn = this.page.actions.find(a =>
          new RegExp(`第\\s*${blockedPageNum}\\s*页|Page\\s*${blockedPageNum}\\b`, 'i').test(a.label)
        );
        if (pageBtn) {
          console.log(`[Pagination Safeguard] Found target page button ${pageBtn.label} (${pageBtn.id}), overriding BLOCKED!`);
          selected = pageBtn.id;
        }
      }

      if (selected === 'BLOCKED' && this.page.actions.some((a) => a.id === 'scroll_down')) {
        const goalNeedsScroll = /翻|页|page|scroll|bottom|more|next|下|更多/i.test(this.goal);
        if (goalNeedsScroll) {
          console.log('[Pagination Safeguard] Overriding premature BLOCKED with scroll_down to reveal pagination/results');
          selected = 'scroll_down';
        }
      }

      // Search box safeguard: if on a search engine or page with a search input,
      // and the current goal hasn't been searched yet, override BLOCKED with the search input
      if (selected === 'BLOCKED') {
        const searchInput = this.page.actions.find(
          (a) =>
            a.kind === 'fill' &&
            (/搜索|search|kw|wd/i.test(a.label) ||
              a.role === 'searchbox' ||
              (a.role === 'textbox' && /搜索/i.test(a.label)))
        );
        const hasNotFilledSearch = !this.history.some((h) => h.kind === 'fill');
        if (searchInput && hasNotFilledSearch) {
          console.log(`[Search Safeguard] Page has search box [${searchInput.label}], overriding premature BLOCKED with fill!`);
          selected = searchInput.id;
        }
      }
    }
    // Target page & ordinal search result safeguard
    const targetResultOrdinal = extractRequestedResultIndex(this.goal);
    const targetPageNum = extractTargetPage(this.goal);
    const targetPageReached = isTargetPageReached(this.page, this.history, targetPageNum);
    const hasOpenedTargetResult = targetResultOrdinal ? this.history.some(
      (h) => h.search_result_ordinal === targetResultOrdinal || (h.target && h.target.includes(`搜索结果第 ${targetResultOrdinal} 条`))
    ) : false;

    // A. Check if the ordinal link goal is already accomplished (clicked on earlier step)
    if (targetResultOrdinal && hasOpenedTargetResult && !/查看详情后|总结|提取|填写|复制/i.test(this.goal)) {
      const lastAction = this.history[this.history.length - 1];
      if (lastAction && (lastAction.search_result_ordinal === targetResultOrdinal || lastAction.opened_target_result)) {
        logger.info('AGENT', `已成功打开目标第 ${targetResultOrdinal} 条搜索结果网页，任务全部达成！`);
        this.status = 'done';
        this.isRunning = false;
        this.emitState();
        return;
      }
    }

    // B. If goal asked for an ordinal result link, and target page is reached, but link is not opened yet:
    if (targetResultOrdinal && targetPageReached && !hasOpenedTargetResult) {
      const targetLink = this.page.actions.find(
        (a) => a.search_result_ordinal === targetResultOrdinal
      ) || this.page.actions.find(
        (a) => a.kind === 'click' && new RegExp(`搜索结果第\\s*${targetResultOrdinal}\\s*条|Search Result #${targetResultOrdinal}\\b`, 'i').test(a.label)
      );

      if (targetLink) {
        if (selected === 'DONE' || selected === 'BLOCKED' || selected !== targetLink.id) {
          logger.action('SEARCH_RESULT', `已翻至目标第 ${targetPageNum || 1} 页，定位目标第 ${targetResultOrdinal} 条搜索结果: [${targetLink.label}] (${targetLink.id})，执行点击打开`);
          selected = targetLink.id;
        }
      } else {
        if (selected === 'DONE') {
          const scrollDown = this.page.actions.find(a => a.id === 'scroll_down');
          if (scrollDown) {
            logger.info('SEARCH_RESULT', `尚未找到目标第 ${targetResultOrdinal} 条搜索结果，向下滚动寻找目标链接`);
            selected = scrollDown.id;
          }
        }
      }
    }

    // C. If goal asked for a specific page, but we haven't reached target page yet:
    if (targetPageNum && targetPageNum > 1 && !targetPageReached) {
      if (selected === 'DONE') {
        const pageBtn = this.page.actions.find(a =>
          new RegExp(`第\\s*${targetPageNum}\\s*页|Page\\s*${targetPageNum}\\b`, 'i').test(a.label)
        );
        if (pageBtn) {
          logger.info('PAGINATION', `尚未到达第 ${targetPageNum} 页，跳转目标页: [${pageBtn.label}]`);
          selected = pageBtn.id;
        } else {
          const nextBtn = this.page.actions.find(a => /下一页|next page|下一页 >/i.test(a.label));
          if (nextBtn) {
            logger.info('PAGINATION', `尚未到达第 ${targetPageNum} 页，点击下一页: [${nextBtn.label}]`);
            selected = nextBtn.id;
          } else {
            selected = 'scroll_down';
          }
        }
      } else {
        const candidateAction = this.page.actions.find(a => a.id === selected);
        if (candidateAction && candidateAction.search_result_ordinal) {
          logger.info('PAGINATION', `目标要求在第 ${targetPageNum} 页操作，拦截第 1 页结果点击，转为翻页`);
          const pageBtn = this.page.actions.find(a =>
            new RegExp(`第\\s*${targetPageNum}\\s*页|Page\\s*${targetPageNum}\\b`, 'i').test(a.label)
          );
          if (pageBtn) {
            selected = pageBtn.id;
          } else {
            const nextBtn = this.page.actions.find(a => /下一页|next page|下一页 >/i.test(a.label));
            selected = nextBtn ? nextBtn.id : 'scroll_down';
          }
        }
      }
    }

    if (selected === 'DONE') {
      logger.info('AGENT', '任务全部目标已达成，顺利完成！');
      this.status = 'done';
      this.isRunning = false;
      this.emitState();
      return;
    }

    if (selected === 'BLOCKED') {
      // Hand-off: Transition to waiting_for_user instead of fatal termination
      this.status = 'waiting_for_user';
      this.blockedReason = 'AI 模型遇到了需要人工协助的节点（如滑块验证码、账号登录、权限拦截或页面确认）。请直接在左侧浏览器中操作，完成后点击【我已处理，继续】。';
      this.isRunning = false;
      this.emitState({ requiresHumanIntervention: true });
      return;
    }

    // Anti-loop safeguard: if the model predicts the exact same target that just resulted in page_changed === false
    const lastStep = this.history[this.history.length - 1];
    if (lastStep && lastStep.choice === selected && lastStep.page_changed === false) {
      console.warn(`[Anti-Loop] Target ${selected} (${lastStep.action}) repeated with no page change. Searching for fallback...`);
      // 1. Check if a confirmation/search button (Done, Apply, Confirm, Search, Submit, 搜索, 查询, 确定) exists on page
      const confirmAction = this.page.actions.find((a) =>
        /(done|apply|confirm|ok|select|submit|search|搜索|查询|确定|查航班|检索)/i.test((a.label || '').trim())
      );
      if (confirmAction && confirmAction.id !== selected) {
        logger.info('SAFEGUARD', `检测到重复操作无响应，自动切换点击确认/搜索按钮: [${confirmAction.label}] (${confirmAction.id})`);
        selected = confirmAction.id;
      } else if (lastStep.kind === 'fill') {
        const otherAction = this.page.actions.find(a => a.id !== selected && a.id !== 'wait' && (a.kind === 'click' || a.id === 'scroll_down'));
        if (otherAction) {
          logger.info('SAFEGUARD', `检测到输入框重复填入无反馈，切换执行: [${otherAction.label}] (${otherAction.id})`);
          selected = otherAction.id;
        }
      } else if (this.decision.probabilities) {
        // 2. Fallback to the next best candidate
        const sorted = Object.entries(this.decision.probabilities)
          .filter(([id]) => id !== selected && id !== 'BLOCKED' && id !== 'DONE')
          .sort((a, b) => b[1] - a[1]);
        if (sorted.length > 0 && this.page.actions.some((a) => a.id === sorted[0][0])) {
          console.log(`[Anti-Loop] Picking next best candidate: ${sorted[0][0]} (p=${sorted[0][1]})`);
          selected = sorted[0][0];
        }
      }
    }

    let action = this.page.actions.find((a) => a.id === selected);
    if (!action) {
      throw new Error(`Chosen action ${selected} not found in page actions`);
    }

    // Form submission safeguard: if search inputs are populated and a Search button is visible,
    // and the date modal is closed, prevent re-opening or cycling departure date, and trigger Search instead!
    const isModalOpen = this.page.actions.some((a) => /(done|reset)/i.test(a.label));
    if (!isModalOpen) {
      const searchBtn = this.page.actions.find((a) =>
        a.kind === 'click' && /(^|\b)search(\b|$)/i.test((a.label || '').trim()) && !/done/i.test(a.label)
      );
      if (searchBtn && searchBtn.id !== action.id) {
        const isTryingToReopenDate = /departure/i.test(action.label);
        const hasDateInHistory = this.history.some((h) =>
          /done/i.test(h.action) || /departure date/i.test(h.action) || /sep|oct|nov|dec|jan|feb|mar|apr|may|jun|jul|aug/i.test(h.action)
        );
        if (isTryingToReopenDate && hasDateInHistory) {
          console.log(`[Form Safeguard] Date already configured; overriding ${action.label} with ${searchBtn.label} (${searchBtn.id})`);
          selected = searchBtn.id;
          action = searchBtn;
        }
      }
    }

    // Pagination goal safeguard: avoid accidentally clicking home/logo links when trying to paginate
    const isPaginationGoal = /翻|第\s*\d+\s*页|下一页|page\s*\d+/i.test(this.goal);
    if (isPaginationGoal && action.kind === 'click') {
      const isHomeOrLogo = /返回首页|首页|^home$|^logo$|腾讯网/i.test((action.label || '').trim());
      if (isHomeOrLogo) {
        const scrollDown = this.page.actions.find((a) => a.id === 'scroll_down');
        if (scrollDown) {
          console.log(`[Pagination Safeguard] Overriding home/logo link [${action.label}] with scroll_down`);
          selected = scrollDown.id;
          action = scrollDown;
        }
      }
    }

    // 2. Generate text if TYPE_TEXT
    let text = null;
    let helper = null;
    if (action.kind === 'fill') {
      this.status = 'generating_text';
      this.emitState({ currentAction: action.label });
      try {
        const ctx = fieldContext(this.goal, action, this.page, this.history);
        const res = await fieldText(ctx);
        text = res.value;
        helper = res.helper;
      } catch (err) {
        logger.warn('MODEL', `文本生成异常: ${err.message}，采用安全回退值`);
        text = action.value || '';
      }
    }

    // 3. Act
    this.status = 'executing';
    this.emitState({ currentAction: action.label, text });
    try {
      await this.act(action, this.page, text);
    } catch (err) {
      console.warn('Action failed or stale target:', err.message);
      this.history.push({
        step: this.history.length + 1,
        action: `${action.label} (${err.message})`,
        kind: action.kind,
        choice: selected,
        text,
        latency_ms: this.decision.latency_ms,
        confidence: Math.round(this.decision.confidence * 100),
        operation: this.decision.operation,
        target: this.decision.target,
        text_helper: helper ? helper.model : null,
        elapsed_ms: Date.now() - this.startedAt,
        page_changed: false,
        search_result_ordinal: null,
      });
      await sleep(100);
      this.page = await this.observe();
      this.status = 'ready';
      this.emitState();
      return;
    }

    // 4. Record step
    const stepRecord = {
      step: this.history.length + 1,
      action: action.label,
      kind: action.kind,
      choice: selected,
      text,
      latency_ms: this.decision.latency_ms,
      confidence: Math.round(this.decision.confidence * 100),
      operation: this.decision.operation,
      target: this.decision.target,
      text_helper: helper ? helper.model : null,
      probabilities: this.decision.probabilities || {},
      elapsed_ms: Date.now() - this.startedAt,
      search_result_ordinal: action.search_result_ordinal || null,
      opened_target_result: Boolean(action.search_result_ordinal),
    };
    this.history.push(stepRecord);

    // 5. Re-observe
    const oldPage = this.page;
    this.page = await this.observe();
    stepRecord.page_changed = this.page.fingerprint !== oldPage.fingerprint;

    // Check consecutive repeated failures
    const repeated = this.history.slice(-3);
    if (
      repeated.length === 3 &&
      repeated.every((h) => h.page_changed === false && h.kind !== 'wait')
    ) {
      this.status = 'waiting_for_user';
      this.blockedReason = `检测到连续 3 次执行操作 [${repeated[0].action}] 页面无反馈变化（可能需要手动点击确认、通过滑块验证码或关闭遮罩弹窗）。请在网页中处理后点击【我已处理，继续】。`;
      this.isRunning = false;
      this.emitState({ requiresHumanIntervention: true });
    } else {
      this.status = 'ready';
    }

    this.emitState();
  }

  handOff(reason) {
    this.status = 'waiting_for_user';
    this.blockedReason = reason || 'AI 模型请求人工接力协助（请在页面处理后继续）。';
    this.isRunning = false;
    this.emitState({ requiresHumanIntervention: true });
  }

  async resume() {
    const canResume = this.isPaused || this.status === 'paused' || this.status === 'waiting_for_user' || this.status === 'blocked';
    if (!canResume && !this.isRunning) return;

    const wasWaitingForUser = this.status === 'waiting_for_user';
    this.isPaused = false;
    this.stepMode = false;
    this.isRunning = true;
    this.status = 'running';
    this.blockedReason = null;

    if (wasWaitingForUser) {
      this.history.push({
        step: this.history.length + 1,
        action: '人工协助处理完成，AI 重新接管执行',
        kind: 'take_over',
        choice: 'RESUME',
        text: null,
        latency_ms: 0,
        confidence: 100,
        operation: 'RESUME',
        target: null,
        text_helper: null,
        elapsed_ms: this.startedAt ? Date.now() - this.startedAt : 0,
        page_changed: true,
      });
    }

    this.emitState();

    try {
      // If user performed actions on page, re-observe latest DOM
      if (wasWaitingForUser) {
        await sleep(300);
        this.page = await this.observe();
      }

      while (this.isRunning && this.status !== 'done' && this.status !== 'blocked' && this.status !== 'waiting_for_user') {
        if (this.isPaused) {
          this.status = 'paused';
          this.emitState();
          break;
        }
        await this.tick();
        if (this.stepMode) {
          this.isPaused = true;
          this.status = 'paused';
          this.emitState();
          break;
        }
      }
    } catch (err) {
      this.status = 'error';
      this.emit('error', err.message);
      this.emitState();
      throw err;
    }
  }

  step() {
    this.stepMode = true;
    this.isPaused = false;
    this.resume();
  }

  pause() {
    this.isPaused = true;
    this.status = 'paused';
    this.emitState();
  }

  stop() {
    this.isRunning = false;
    this.isPaused = false;
    this.status = 'idle';
    this.blockedReason = null;
    this.emitState();
  }

  emitState(extra = {}) {
    const payload = {
      status: this.status,
      goal: this.goal,
      elapsed_ms: this.startedAt ? Date.now() - this.startedAt : 0,
      history: this.history,
      decision: this.decision,
      blockedReason: this.blockedReason,
      elementCount: this.page?.actions?.length || 0,
      url: this.page?.url || this.webContents.getURL(),
      ...extra,
    };
    this.emit('state', payload);
  }
}

module.exports = {
  AgentRunner,
};
