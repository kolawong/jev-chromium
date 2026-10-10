/**
 * AgentRunner: Manages the Jev execution loop on an Electron WebContentsView via native CDP debugger.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { SNAPSHOT_SCRIPT } = require('./snapshot');
const { choose, fieldContext, fieldText } = require('./model');
const { MAX_STEPS } = require('./questions');
const { logger } = require('./logger');
const { applyDecisionSafeguards } = require('./safeguards');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
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
      } catch (err) {
        logger.warn('CDP', `ignored error: ${err.message}`);
      }
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
        try { e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
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
            try { e.click(); return { x: clampedX, y: clampedY, domClicked: true }; } catch (_) {}
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
            try { field.select(); } catch (_) {}
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
      `).catch((err) => { logger.warn('CDP', `ignored error: ${err && err.message ? err.message : err}`); });

      // 2. Also send CDP keyboard selectAll + insertText for full browser-level fidelity
      await this.sendCdp('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: process.platform === 'darwin' ? 4 : 2,
        commands: ['selectAll'],
      }).catch((err) => { logger.warn('CDP', `ignored error: ${err && err.message ? err.message : err}`); });
      await this.sendCdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        modifiers: process.platform === 'darwin' ? 4 : 2,
      }).catch((err) => { logger.warn('CDP', `ignored error: ${err && err.message ? err.message : err}`); });
      await this.sendCdp('Input.insertText', { text: text || '' }).catch((err) => { logger.warn('CDP', `ignored error: ${err && err.message ? err.message : err}`); });

      await this.webContents.executeJavaScript(`
        (() => {
          const active = document.activeElement;
          if (active) {
            active.dispatchEvent(new Event('input', { bubbles: true }));
            active.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()
      `).catch((err) => { logger.warn('CDP', `ignored error: ${err && err.message ? err.message : err}`); });

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
        }).catch((err) => { logger.warn('CDP', `ignored error: ${err && err.message ? err.message : err}`); });
        await this.sendCdp('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        }).catch((err) => { logger.warn('CDP', `ignored error: ${err && err.message ? err.message : err}`); });
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

    const safeguard = applyDecisionSafeguards({
      selected,
      decision: this.decision,
      page: this.page,
      goal: this.goal,
      history: this.history,
    });
    selected = safeguard.selected;

    if (safeguard.done) {
      logger.info('AGENT', '任务全部目标已达成，顺利完成！');
      this.status = 'done';
      this.isRunning = false;
      this.emitState();
      return;
    }

    if (safeguard.status === 'waiting_for_user') {
      this.status = 'waiting_for_user';
      this.blockedReason = safeguard.blockedReason;
      this.isRunning = false;
      this.emitState({ requiresHumanIntervention: true });
      return;
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
