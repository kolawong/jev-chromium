/** Cancellable task lifecycle and verified browser execution. */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { SNAPSHOT_SCRIPT, contentScript } = require('./snapshot');
const models = require('./model');
const { applyDecisionSafeguards, isCommitAction } = require('./safeguards');
const { check, sleep } = require('./abort');
const { LIMITS, webUrl, normalizePlan, newTask, groundedRows, mergeRows,
  collectionProgress, collectionReturnUrl, validateVerification } = require('./task');
const { logger } = require('./logger');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ACTIVE = new Set(['planning', 'running', 'observing', 'deciding', 'generating_text',
  'executing', 'collecting', 'verifying', 'pausing', 'stopping']);

class AgentRunner extends EventEmitter {
  constructor(webContents, options = {}) {
    super();
    this.webContents = webContents;
    this.models = { ...models, ...options.models };
    this.store = options.store;
    this.limits = { ...LIMITS, ...options.limits };
    this.status = 'idle';
    this.task = null;
    this.page = null;
    this.decision = null;
    this.blockedReason = null;
    this.execution = null;
    this.loopPromise = null;
    this.debuggerAttached = false;
    try {
      this.task = this.store?.load() || null;
      if (this.task) {
        this.status = ['done', 'stopped'].includes(this.task.status) ? this.task.status : 'paused';
        this.needsRestoreNavigation = this.status === 'paused';
        this.blockedReason = this.status === 'paused' ? '已恢复上次任务，点击继续后重新观察页面。' : null;
      }
    } catch (err) { this.blockedReason = `无法恢复上次任务：${err.message}`; }
  }

  get goal() { return this.task?.goal || ''; }
  get history() { return this.task?.history || []; }
  get busy() { return Boolean(this.loopPromise) || ACTIVE.has(this.status); }
  guard(ctx) {
    check(ctx?.controller.signal);
    if (!ctx || this.execution !== ctx) throw new DOMException('任务已取消', 'AbortError');
  }
  async js(code, ctx) {
    this.guard(ctx);
    const result = await this.webContents.executeJavaScript(code);
    this.guard(ctx);
    return result;
  }
  async sendCdp(method, params, ctx) {
    this.guard(ctx);
    if (!this.debuggerAttached) {
      if (!this.webContents.debugger.isAttached()) this.webContents.debugger.attach('1.3');
      this.debuggerAttached = true;
      this.webContents.debugger.once('detach', () => { this.debuggerAttached = false; });
      await this.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      this.guard(ctx);
    }
    const result = await this.webContents.debugger.sendCommand(method, params);
    this.guard(ctx);
    return result;
  }
  phase(status, ctx, extra = {}) {
    this.guard(ctx);
    this.status = status;
    this.emitState(extra);
  }
  modelOptions(ctx) {
    const phase = this.status;
    let receipt;
    return { signal: ctx.controller.signal, onRecovery: event => {
      this.guard(ctx);
      if (!receipt) {
        receipt = { phase, url: this.task.url || this.webContents.getURL(), startedAt: new Date().toISOString() };
        this.task.recoveries = [...(this.task.recoveries || []), receipt].slice(-60);
      }
      Object.assign(receipt, event);
      this.emitState({ tickerMessage: event.status === 'retrying'
        ? `云端格式异常，正在自动纠正（${event.attempt + 1}/${event.maxAttempts}），已保留 ${this.task.rows.length} 条结果…`
        : event.status === 'recovered' ? '云端格式已恢复，正在继续任务…' : '自动纠正已达上限，已有结果已保留。' });
    } };
  }
  elapsed() { return (this.task?.activeMs || 0) + (this.execution ? Date.now() - this.execution.started : 0); }
  getState() {
    return { status: this.status, goal: this.goal, history: this.history,
      elapsed_ms: this.elapsed(), decision: this.decision, blockedReason: this.blockedReason,
      url: this.webContents.isDestroyed?.() ? this.task?.url || '' : this.webContents.getURL(),
      elementCount: this.page?.actions?.length || 0,
      task: this.task ? { id: this.task.id, plan: this.task.plan, rows: this.task.rows,
        verification: this.task.verification, steps: this.task.steps,
        progress: this.task.plan?.mode === 'collect' ? collectionProgress(this.task) : null } : null };
  }
  emitState(extra = {}) {
    if (this.task) {
      this.task.status = this.status;
      try { this.store?.save({ ...this.task, activeMs: this.elapsed() }); }
      catch (err) { logger.warn('TASK', `任务保存失败: ${err.message}`); }
    }
    this.emit('state', { ...this.getState(), ...extra });
  }

  start(goal, _initialHistory = [], options = {}) {
    if (this.busy) return Promise.reject(new Error('任务仍在运行或停止中，请先停止当前任务'));
    if (!goal?.trim()) return Promise.reject(new Error('请输入任务目标'));
    this.task = newTask(goal.trim());
    this.needsRestoreNavigation = false;
    this.task.requestedUrl = webUrl(options.url);
    this.page = null;
    this.decision = null;
    this.blockedReason = null;
    return this.launch(Boolean(options.singleStep));
  }
  resume({ singleStep = false } = {}) {
    if (this.busy) return this.loopPromise || Promise.resolve();
    if (!this.task || !['paused', 'waiting_for_user', 'error'].includes(this.status)) return Promise.resolve();
    this.blockedReason = null;
    return this.launch(singleStep, true);
  }
  step(goal) {
    if (!this.task || ['idle', 'done', 'stopped'].includes(this.status) ||
        (typeof goal === 'string' && goal.trim() !== this.goal)) return this.start(goal, [], { singleStep: true });
    return this.resume({ singleStep: true });
  }
  cancel(finalStatus, reason) {
    if (!this.execution) {
      if (this.task && !['done', 'stopped'].includes(this.status)) this.status = finalStatus;
      this.blockedReason = reason || null;
      this.emitState();
      return;
    }
    this.execution.finalStatus = finalStatus;
    this.blockedReason = reason || null;
    this.status = finalStatus === 'stopped' ? 'stopping' : 'pausing';
    this.execution.controller.abort(new DOMException('任务已取消', 'AbortError'));
    this.webContents.stop?.();
    this.emitState();
  }
  pause() { this.cancel('paused'); }
  stop() { this.cancel('stopped'); }
  handOff(reason) { this.cancel('waiting_for_user', reason || '请处理页面后继续。'); }

  launch(singleStep, resuming = false) {
    const ctx = { controller: new AbortController(), started: Date.now(), singleStep, resuming, finalStatus: null };
    this.execution = ctx;
    this.status = this.task.plan ? 'observing' : 'planning';
    this.emitState();
    const remaining = this.limits.activeMs - this.task.activeMs;
    const timer = setTimeout(() => {
      if (this.execution === ctx) this.cancel('waiting_for_user', '已达到任务时间上限，保留部分结果。请缩小范围后重新运行。');
    }, Math.max(0, remaining));
    this.loopPromise = this.run(ctx).catch(err => {
      if (ctx.controller.signal.aborted || this.execution !== ctx) return;
      this.status = 'error';
      this.blockedReason = err.message;
      if (this.listenerCount('error')) this.emit('error', err.message);
      logger.warn('AGENT', err.message);
    }).finally(() => {
      clearTimeout(timer);
      if (this.execution !== ctx) return;
      this.task.activeMs += Date.now() - ctx.started;
      if (ctx.finalStatus) this.status = ctx.finalStatus;
      this.execution = null;
      this.loopPromise = null;
      this.emitState();
    });
    return this.loopPromise;
  }

  async run(ctx) {
    const signal = ctx.controller.signal;
    let needsNavigation = this.needsRestoreNavigation;
    if (this.task.activeMs >= this.limits.activeMs) {
      this.hold('已达到任务时间上限，请缩小范围后重新运行。');
      return;
    }
    if (!this.task.plan) {
      try {
        const raw = await this.models.planTask(this.goal, this.webContents.getURL(),
          { ...this.modelOptions(ctx), rejection: this.task.planRejection || null });
        this.guard(ctx);
        this.task.plan = normalizePlan(raw, this.goal, this.webContents.getURL());
        this.task.planRejection = null;
      } catch (err) {
        if (err.name !== 'AbortError') this.task.planRejection = err.reason || err.message;
        if (err.name === 'AbortError' || err.code === 'MODEL_FORMAT_INVALID') throw err;
        this.hold(err.message);
        return;
      }
      if (this.task.requestedUrl) this.task.plan.startUrls = [this.task.requestedUrl, ...this.task.plan.startUrls.filter(u => u !== this.task.requestedUrl)];
      this.task.url = this.task.plan.startUrls[0];
      needsNavigation = true;
      this.emitState();
    }
    if (!webUrl(this.webContents.getURL()) && webUrl(this.task.url)) needsNavigation = true;
    if (needsNavigation && this.task.url && this.webContents.getURL() !== this.task.url) {
      try { await this.navigate(this.task.url, ctx); }
      catch (err) {
        this.guard(ctx);
        if (err.code === 'NAVIGATION_FAILED') { this.hold(err.message); return; }
        throw err;
      }
    }
    this.needsRestoreNavigation = false;
    this.page = await this.observe(ctx);
    if (ctx.resuming && this.task.plan.mode === 'browse' && await this.verify(ctx, { opportunistic: true })) return;
    while (this.execution === ctx && !signal.aborted) {
      if (this.task.steps >= this.limits.steps) {
        this.hold(`已达到 ${this.limits.steps} 步上限，保留部分结果；请缩小范围后重新运行。`);
        break;
      }
      this.task.steps++;
      await this.tick(ctx);
      this.guard(ctx);
      if (['done', 'waiting_for_user'].includes(this.status)) break;
      if (ctx.singleStep) { this.status = 'paused'; break; }
    }
  }
  hold(reason) {
    this.status = 'waiting_for_user';
    this.blockedReason = reason;
    this.emitState();
  }
  async navigate(url, ctx) {
    this.phase('executing', ctx, { tickerMessage: '正在打开来源页面…' });
    const target = webUrl(url);
    if (!target) throw new Error('只支持 HTTP/HTTPS 网页');
    try { await this.webContents.loadURL(target); }
    catch (err) {
      this.guard(ctx);
      if (webUrl(this.webContents.getURL()) !== target) {
        const failure = new Error(`页面未能打开：${target}。请检查网络后继续。`);
        failure.code = 'NAVIGATION_FAILED';
        throw failure;
      }
    }
    this.guard(ctx);
    if (!webUrl(this.webContents.getURL())) {
      const failure = new Error(`页面未能打开：${target}。请检查网络后继续。`);
      failure.code = 'NAVIGATION_FAILED';
      throw failure;
    }
    this.task.url = this.webContents.getURL();
    if (this.task.plan.startUrls.includes(target)) {
      this.task.sourceVisits = [...new Set([...(this.task.sourceVisits || []), target])];
    }
  }
  async observe(ctx) {
    this.phase('observing', ctx);
    for (let attempt = 0; attempt < 5; attempt++) {
      this.guard(ctx);
      try {
        const page = await this.js(SNAPSHOT_SCRIPT, ctx);
        if (!page) { await sleep(100, ctx.controller.signal); continue; }
        const content = await this.js(contentScript(0), ctx);
        if (content.url !== page.url) continue;
        page.content = content.content;
        page.contentTruncated = content.truncated;
        page.contentTotal = content.total;
        page.fingerprint = hash({ url: page.url, text: page.text, actions: page.actions, scroll: page.scroll });
        return page;
      } catch (err) {
        this.guard(ctx);
        if (attempt === 4) throw err;
        await sleep(100, ctx.controller.signal);
      }
    }
    throw new Error('页面仍未就绪，请稍后继续');
  }
  async settle(ctx) {
    await sleep(200, ctx.controller.signal);
    for (let i = 0; i < 60 && this.webContents.isLoadingMainFrame?.(); i++) {
      await sleep(100, ctx.controller.signal);
    }
    return this.observe(ctx);
  }
  async verify(ctx, { opportunistic = false } = {}) {
    // Refresh evidence: a previous click/old snapshot can never certify completion.
    this.page = await this.settle(ctx);
    if (this.task.plan.mode === 'collect' && !collectionProgress(this.task).ready) return false;
    this.phase('verifying', ctx);
    const answer = await this.models.verifyTask(this.task, this.page, this.modelOptions(ctx));
    this.guard(ctx);
    this.task.verification = validateVerification(answer, this.task, this.page);
    this.emitState();
    if (this.task.verification.complete) {
      this.status = 'done';
      this.blockedReason = null;
      return true;
    }
    if (opportunistic) return false;
    this.task.failedVerifications = (this.task.failedVerifications || 0) + 1;
    if (this.task.failedVerifications >= 3) this.hold('完成验证未通过：' + this.task.verification.reason);
    return false;
  }

  async tick(ctx) {
    let receipt, feedback;
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const rejected = await this.tickOnce(ctx, feedback, receipt);
        this.guard(ctx);
        if (!rejected) {
          if (receipt) {
            receipt.status = this.status === 'waiting_for_user' ? 'blocked' : 'recovered';
            receipt.resolvedBy = this.status === 'done' ? 'verification' : 'fresh_decision';
            this.emitState();
          }
          return;
        }
        if (!receipt) {
          receipt = { kind: 'low_confidence', phase: 'deciding', startedAt: new Date().toISOString(),
            url: rejected.url, retainedRows: this.task.rows.length, observations: [] };
          this.task.recoveries = [...(this.task.recoveries || []), receipt].slice(-60);
        }
        Object.assign(receipt, { attempt, confidence: rejected.confidence,
          targetConfidence: rejected.targetConfidence, status: 'retrying' });
        if (attempt === 3 || (this.task.decisionRetries || 0) >= this.limits.decisionRetries) {
          receipt.status = 'exhausted';
          this.hold(`重新观察和判断后仍无法确定下一步，已保留 ${this.task.rows.length} 条结果。请补充要求或处理页面后继续。`);
          return;
        }
        this.task.decisionRetries = (this.task.decisionRetries || 0) + 1;
        feedback = { previousDecision: rejected,
          instruction: 'The previous operation or target confidence was insufficient. Re-evaluate the freshly observed page and current candidates. Prefer relevant unvisited sources; scroll to reveal detail links if necessary. When the goal permits any N sources, multiple acceptable unvisited alternatives are not a blocker: choose one supported by the page. Do not inflate confidence just to proceed. DONE requires all original conditions; BLOCKED requires no supported way to progress.' };
        logger.retry('AGENT', `下一步置信度不足，重新观察并判断（${attempt + 1}/3）；已有结果保留`);
        this.phase('observing', ctx, { tickerMessage: `置信度不足，正在重新观察并判断（${attempt + 1}/3），保留 ${this.task.rows.length} 条结果…` });
        await sleep(250 * attempt, ctx.controller.signal);
      }
    } catch (err) {
      if (receipt) {
        receipt.status = ctx.controller.signal.aborted ? 'cancelled' : 'failed';
        this.emitState();
      }
      throw err;
    }
  }

  async tickOnce(ctx, feedback, recovery) {
    const signal = ctx.controller.signal;
    const plan = this.task.plan;
    let verifiedThisTick = false;
    this.page = await this.settle(ctx);
    const url = webUrl(this.page.url);
    if (!url) {
      this.hold('页面未能打开，请检查网络或网址后继续。');
      return;
    }
    if (!this.task.visited.includes(url)) {
      if (this.task.visited.length >= this.limits.pages) { this.hold('已达到来源页面上限，保留部分结果。'); return; }
      this.task.visited.push(url);
      this.task.failedVerifications = 0;
    }
    this.task.url = this.page.url;
    if (plan.mode === 'collect') {
      const cursor = this.task.contentCursor?.[url] || 0;
      const chunk = cursor === 0
        ? { content: this.page.content, truncated: this.page.contentTruncated === true,
          consumed: (this.page.content || '').length, total: this.page.contentTotal ?? (this.page.content || '').length }
        : await this.js(contentScript(cursor), ctx);
      if (cursor !== 0) this.guard(ctx);
      if (cursor !== 0 && chunk?.url && webUrl(chunk.url) !== url) {
        this.hold('页面在读取时发生跳转，请继续后重新观察。');
        return;
      }
      const windowPage = { ...this.page, content: chunk.content, contentTruncated: chunk.truncated === true };
      const extractionKey = hash({ url, cursor, content: chunk.content });
      if (!this.task.extracted.includes(extractionKey)) {
        this.phase('collecting', ctx);
        const beforeRows = this.task.rows.length;
        const beforeSources = new Set(this.task.rows.map(row => row.sourceUrl)).size;
        const raw = await this.models.extractRows(this.goal, plan, windowPage, this.modelOptions(ctx));
        this.guard(ctx);
        const rows = groundedRows(raw, windowPage, plan.columns);
        this.task.rows = mergeRows(this.task.rows, rows, plan.columns, windowPage);
        const afterSources = new Set(this.task.rows.map(row => row.sourceUrl)).size;
        if (this.task.rows.length > beforeRows || afterSources > beforeSources) this.task.failedVerifications = 0;
        this.task.extracted.push(extractionKey);
        this.task.contentCursor = { ...(this.task.contentCursor || {}) };
        const consumed = chunk.consumed || 0;
        const covered = cursor + consumed;
        if (chunk.truncated && consumed > 0 && (chunk.total == null || covered < chunk.total)) this.task.contentCursor[url] = covered;
        else delete this.task.contentCursor[url];
        this.emitState();
      }
      if (this.task.contentCursor?.[url]) {
        this.phase('running', ctx);
        return;
      }
      if (collectionProgress(this.task).ready) {
        verifiedThisTick = true;
        if (await this.verify(ctx) || this.status === 'waiting_for_user') return;
      }
    }

    const actions = this.page.actions.filter(action => {
      if (plan.mode !== 'collect' || action.kind !== 'click' || webUrl(action.href) !== url) return true;
      // A confirmed reload of this same URL is not another source. Keep same-page JS controls eligible.
      return !this.history.some(h => h.kind === 'click' && h.href === action.href && h.label === action.label &&
        h.before_url === url && h.after_url === url && !h.error &&
        h.before_document_id != null && h.after_document_id !== h.before_document_id);
    });
    if (plan.mode === 'collect') {
      const next = collectionProgress(this.task).remaining[0];
      if (next) actions.push({ id: 'next_source', kind: 'navigate', url: next, label: '打开下一个用户指定来源: ' + next });
      const back = collectionReturnUrl(this.task, url);
      if (back) actions.push({ id: 'return_to_list', kind: 'navigate', url: back, label: '返回之前的列表，继续打开其他详情页' });
    }
    const taskContext = { mode: plan.mode, checks: plan.checks, columns: plan.columns,
      progress: plan.mode === 'collect' ? collectionProgress(this.task) : null,
      visited_pages: this.task.visited, collected_sources: [...new Set(this.task.rows.map(r => r.sourceUrl))],
      verification_feedback: this.task.verification,
      decision_recovery: feedback || null };
    if (recovery) {
      recovery.observations.push({ url: this.page.url, documentId: this.page.marker?.[0],
        observedAt: new Date().toISOString(), candidateCount: actions.length });
      recovery.attempt = recovery.observations.length + 1;
    }
    this.phase('deciding', ctx);
    this.decision = await this.models.choose({ ...this.page, actions }, this.goal, this.history,
      progress => { if (!signal.aborted && this.execution === ctx) this.emitState({ tickerMessage: progress.message }); },
      { ...this.modelOptions(ctx), task: taskContext });
    this.guard(ctx);
    if (!Number.isFinite(this.decision.confidence) || this.decision.confidence < 0.25 ||
        (this.decision.target_confidence != null && (!Number.isFinite(this.decision.target_confidence) || this.decision.target_confidence < 0.25))) {
      const rejected = { choice: this.decision.choice, confidence: this.decision.confidence,
        targetConfidence: this.decision.target_confidence ?? null, url: this.page.url };
      if (!verifiedThisTick && await this.verify(ctx, { opportunistic: true })) return;
      return rejected;
    }
    let safeguard = applyDecisionSafeguards({ selected: this.decision.choice, decision: this.decision,
      page: { ...this.page, actions }, goal: this.goal, history: this.history });
    if (safeguard.verify) {
      const progress = plan.mode === 'collect' ? collectionProgress(this.task) : null;
      if (progress && !progress.ready) {
        const next = actions.find(action => action.id === 'next_source');
        if (next) safeguard = { selected: next.id };
        else if (actions.some(action => action.kind !== 'wait')) {
          return { choice: this.decision.choice, confidence: this.decision.confidence,
            targetConfidence: this.decision.target_confidence ?? null, url: this.page.url };
        } else {
          this.task.failedVerifications = (this.task.failedVerifications || 0) + 1;
          this.task.verification = { complete: false, checks: [], reason: progress.message + '，需继续搜集' };
          if (this.task.failedVerifications >= 3) this.hold('搜集数量或来源尚未满足，已保留部分结果。');
          return;
        }
      } else {
        if (!verifiedThisTick) await this.verify(ctx);
        return;
      }
    }
    if (safeguard.status === 'waiting_for_user') {
      if (!verifiedThisTick && await this.verify(ctx)) return;
      this.hold(safeguard.blockedReason); return;
    }
    const action = actions.find(a => a.id === safeguard.selected);
    if (!action) throw new Error('模型选择了不存在的操作');
    // Purchases, messages, account changes and file downloads stay with the user.
    if (isCommitAction(action)) {
      this.hold(`此操作需要你处理：${action.label}。处理后可以继续。`); return;
    }
    let text = null;
    if (action.kind === 'fill') {
      this.phase('generating_text', ctx);
      const response = await this.models.fieldText(this.models.fieldContext(this.goal, action, this.page, this.history), this.modelOptions(ctx));
      this.guard(ctx);
      text = response.value;
    }
    const before = this.page;
    const started = Date.now();
    this.phase('executing', ctx, { currentAction: action.label });
    let failure = null;
    try { await this.act(action, text, ctx); }
    catch (err) { this.guard(ctx); failure = err.message; }
    this.guard(ctx);
    this.page = await this.settle(ctx);
    if (!webUrl(this.page.url)) {
      this.hold(failure || '页面未能打开，请检查网络后继续。');
      return;
    }
    const changed = this.page.fingerprint !== before.fingerprint;
    if (this.page.url !== before.url) {
      const trail = this.task.returnUrls || [];
      const returning = trail.lastIndexOf(this.page.url);
      // Returning consumes the trail; adding the detail page again would create a back-and-forth loop.
      this.task.returnUrls = returning >= 0 ? trail.slice(0, returning) : [...trail, before.url].slice(-12);
    }
    this.task.url = this.page.url;
    this.history.push({ step: this.history.length + 1, action: action.label, label: action.label,
      kind: action.kind, choice: action.id, text, latency_ms: this.decision.latency_ms,
      duration_ms: Date.now() - started, elapsed_ms: this.elapsed(),
      confidence: this.decision.confidence, target: action.label, operation: this.decision.operation,
      page_changed: changed, before_url: before.url, after_url: this.page.url,
      href: action.href || null, before_document_id: before.marker?.[0],
      before_title: before.title,
      after_document_id: this.page.marker?.[0],
      search_query: before.actions.find(a => a.kind === 'fill' && a.role === 'searchbox')?.value || null,
      search_result_ordinal: action.search_result_ordinal || null,
      opened_target_result: Boolean(action.search_result_ordinal && this.page.url !== before.url && !failure),
      outcome: failure ? 'failed' : changed ? 'observed' : 'unconfirmed', error: failure });
    this.task.stagnant = changed && !failure ? 0 : (this.task.stagnant || 0) + 1;
    if (!failure && changed && plan.mode === 'browse' &&
        (action.kind === 'select' || action.checked != null || action.selected != null)) {
      if (await this.verify(ctx, { opportunistic: true })) return;
    }
    if (this.task.stagnant >= 4) this.hold(failure || '连续操作没有可验证的页面进展，请处理页面后继续。');
    else this.phase('running', ctx);
  }

  async act(action, text, ctx) {
    if (action.kind === 'navigate') { await this.navigate(action.url, ctx); return; }
    if (action.kind === 'wait') { await sleep(500, ctx.controller.signal); return; }
    if (action.kind === 'scroll') {
      await this.js(`window.scrollBy({top:${Number(action.delta)},behavior:'instant'})`, ctx); return;
    }
    const target = await this.js(`((action) => {
      if (location.href !== action.pageUrl || performance.timeOrigin !== action.timeOrigin) return {error:'页面已跳转'};
      const e = window.__jevFast?.nodes.get(action.node);
      if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
          !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return {error:'元素已移除、隐藏或禁用'};
      const current = window.__jevFast.guard(e);
      if (JSON.stringify(current) !== JSON.stringify(action.guard)) return {error:'元素内容已变化'};
      e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      // Inline links may span lines with empty space in their bounding box.
      for (const r of e.getClientRects()) {
        const left=Math.max(1,r.left), right=Math.min(innerWidth-1,r.right);
        const top=Math.max(1,r.top), bottom=Math.min(innerHeight-1,r.bottom);
        if (right<=left || bottom<=top) continue;
        const x=(left+right)/2, y=(top+bottom)/2, hit=document.elementFromPoint(x,y);
        if (hit && (e === hit || e.contains(hit))) return {x,y};
      }
      return {error:'元素被其他内容遮挡'};
    })(${JSON.stringify({ ...action, guard: this.page.guards?.[action.node], pageUrl: this.page.url, timeOrigin: this.page.marker?.[0] })})`, ctx);
    if (!target || target.error) throw new Error(`${target?.error || '目标不可用'}：${action.label}`);
    if (action.kind === 'select') {
      await this.js(`((a) => {
        const e=window.__jevFast.nodes.get(a.node);
        if (!e || ![...e.options].some(o=>o.value===a.value && !o.disabled)) throw Error('选项不可用');
        e.value=a.value; e.dispatchEvent(new Event('input',{bubbles:true}));
        e.dispatchEvent(new Event('change',{bubbles:true}));
      })(${JSON.stringify(action)})`, ctx);
      return;
    }
    this.webContents.focus?.();
    try {
      await this.sendCdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...target, button: 'left', clickCount: 1 }, ctx);
      await this.sendCdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', clickCount: 1 }, ctx);
    } finally {
      // Release an already-pressed button on cancellation; no further click/typing is queued.
      if (ctx.controller.signal.aborted && this.webContents.debugger.isAttached()) {
        await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: -1, y: -1, button: 'left', clickCount: 0 }).catch(() => {});
      }
    }
    if (action.kind === 'fill') {
      await this.js(`((a) => {
        const e=window.__jevFast.nodes.get(a.node);
        if (!e?.isConnected) throw Error('输入框已失效');
        e.focus(); if (e.select) e.select();
        else {const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);}
      })(${JSON.stringify(action)})`, ctx);
      await this.sendCdp('Input.insertText', { text }, ctx);
      const value = await this.js(`(() => { const e=window.__jevFast.nodes.get(${Number(action.node)});
        return e?.value ?? e?.innerText; })()`, ctx);
      if (value !== text) throw new Error('输入内容未能写入目标字段');
    }
  }
}
module.exports = { AgentRunner, ACTIVE };
