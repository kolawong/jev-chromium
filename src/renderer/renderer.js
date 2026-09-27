// Beautiful UI (beautifului.dev) Renderer Controller for Jev Chromium

// Clean Lucide SVG Icon Set
const SVG = {
  play: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  pause: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`,
  resume: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  check: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  chevronDown: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  click: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>`,
  fill: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
  scroll: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg>`,
  wait: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  navigate: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`,
  done: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

// DOM References
const promptInput = document.getElementById('promptInput');
const mainBtn = document.getElementById('mainBtn');
const mainBtnIcon = document.getElementById('mainBtnIcon');
const mainBtnLabel = document.getElementById('mainBtnLabel');
const stepBtn = document.getElementById('stepBtn');
const resetBtn = document.getElementById('resetBtn');
const pixelGrid = document.getElementById('pixelGrid');

const backBtn = document.getElementById('backBtn');
const forwardBtn = document.getElementById('forwardBtn');
const reloadBtn = document.getElementById('reloadBtn');
const homeBtn = document.getElementById('homeBtn');
const drawerToggleBtn = document.getElementById('drawerToggleBtn');
const closeDrawerBtn = document.getElementById('closeDrawerBtn');
const traceDrawer = document.getElementById('traceDrawer');
const stepCountBadge = document.getElementById('stepCountBadge');

const tabStepsBtn = document.getElementById('tabStepsBtn');
const tabLogsBtn = document.getElementById('tabLogsBtn');
const tabStepCount = document.getElementById('tabStepCount');
const tabLogCount = document.getElementById('tabLogCount');
const stepsView = document.getElementById('stepsView');
const logsView = document.getElementById('logsView');

const kpiElapsed = document.getElementById('kpiElapsed');
const kpiSteps = document.getElementById('kpiSteps');
const kpiStatus = document.getElementById('kpiStatus');

const thinkingBanner = document.getElementById('thinkingBanner');
const thinkingText = document.getElementById('thinkingText');
const thinkingTimer = document.getElementById('thinkingTimer');
const stepsContainer = document.getElementById('stepsContainer');
const stepsEmpty = document.getElementById('stepsEmpty');

const logsContainer = document.getElementById('logsContainer');
const logsEmpty = document.getElementById('logsEmpty');
const copyLogsBtn = document.getElementById('copyLogsBtn');
const clearLogsBtn = document.getElementById('clearLogsBtn');

// State
let currentStatus = 'ready';
let isDrawerOpen = true;
let currentTab = 'steps';
let activeFilter = 'all';
let allLogs = [];
let startTime = null;
let timerInterval = null;

// Status Localization
const STATUS_LABELS = {
  ready: '就绪',
  idle: '就绪',
  running: '运行中',
  generating_text: '生成文本',
  retrying: '重新决策',
  waiting: '等待加载',
  paused: '已暂停',
  blocked: '已受阻',
  done: '已完成',
  error: '异常中断',
};

// 1. Navigation Controls
backBtn?.addEventListener('click', () => window.agentAPI.goBack());
forwardBtn?.addEventListener('click', () => window.agentAPI.goForward());
reloadBtn?.addEventListener('click', () => window.agentAPI.reload());
homeBtn?.addEventListener('click', () => window.agentAPI.goHome());

// 2. Drawer Toggle
function toggleDrawer(isOpen) {
  isDrawerOpen = isOpen !== undefined ? isOpen : !isDrawerOpen;
  if (isDrawerOpen) {
    traceDrawer.classList.remove('collapsed');
    drawerToggleBtn.classList.add('active');
  } else {
    traceDrawer.classList.add('collapsed');
    drawerToggleBtn.classList.remove('active');
  }
  window.agentAPI.setDrawerOpen(isDrawerOpen);
}

drawerToggleBtn?.addEventListener('click', () => toggleDrawer());
closeDrawerBtn?.addEventListener('click', () => toggleDrawer(false));

// 3. Tab Switching
const tabSettingsBtn = document.getElementById('tabSettingsBtn');
const settingsView = document.getElementById('settingsView');

function switchTab(tab) {
  currentTab = tab;
  tabStepsBtn.classList.toggle('active', tab === 'steps');
  tabLogsBtn.classList.toggle('active', tab === 'logs');
  tabSettingsBtn?.classList.toggle('active', tab === 'settings');

  stepsView.classList.toggle('hidden', tab !== 'steps');
  logsView.classList.toggle('hidden', tab !== 'logs');
  settingsView?.classList.toggle('hidden', tab !== 'settings');

  if (tab === 'logs') {
    renderLogs();
    logsView.scrollTop = logsView.scrollHeight;
  } else if (tab === 'settings') {
    loadSettingsIntoForm();
  }
}

tabStepsBtn?.addEventListener('click', () => switchTab('steps'));
tabLogsBtn?.addEventListener('click', () => switchTab('logs'));
tabSettingsBtn?.addEventListener('click', () => switchTab('settings'));



// 5. Main Action Handler (Run / Pause / Resume)
function handleMainAction() {
  const text = promptInput.value.trim();

  // If paused -> resume
  if (currentStatus === 'paused') {
    window.agentAPI.resume();
    return;
  }

  // If running -> pause
  if (['running', 'generating_text', 'retrying', 'waiting'].includes(currentStatus)) {
    window.agentAPI.pause();
    return;
  }

  // If empty, prompt user
  if (!text) {
    promptInput.placeholder = '请在此输入目标（如：查询航班）或网址后回车...';
    promptInput.focus();
    return;
  }

  // Check if direct URL navigation
  if (/^(https?:\/\/|[a-z0-9-]+(\.[a-z0-9-]+)+\/?)/i.test(text) && !text.includes(' ') && !/[\u4e00-\u9fa5]/.test(text)) {
    window.agentAPI.navigate(text);
    return;
  }

  // Start Agent task
  startTimer();
  resetBtn?.classList.remove('hidden');
  window.agentAPI.start({ goal: text });
}

mainBtn?.addEventListener('click', handleMainAction);

stepBtn?.addEventListener('click', () => {
  if (['idle', 'ready', 'paused'].includes(currentStatus)) {
    window.agentAPI.step();
  }
});

resetBtn?.addEventListener('click', () => {
  stopTimer();
  window.agentAPI.stop();
});

promptInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleMainAction();
  }
});

// 6. Live Timer
function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  startTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    if (kpiElapsed) kpiElapsed.textContent = `${elapsedSec}s`;
    if (thinkingTimer) thinkingTimer.textContent = `${elapsedSec}s`;
  }, 100);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// 7. Update UI from State
window.agentAPI.onState((state) => {
  const prevStatus = currentStatus;
  currentStatus = state.status || 'ready';

  // Update Main Button appearance
  updateMainButton(currentStatus);

  // Update Pixel Grid animation (01 Loading State)
  const isBusy = ['running', 'generating_text', 'retrying', 'waiting'].includes(currentStatus);
  if (isBusy) {
    pixelGrid?.classList.add('is-loading');
  } else {
    pixelGrid?.classList.remove('is-loading');
  }

  // Update KPIs
  if (state.elapsed_ms !== undefined) {
    kpiElapsed.textContent = `${(state.elapsed_ms / 1000).toFixed(1)}s`;
  }
  const history = state.history || [];
  kpiSteps.textContent = `${history.length} 步`;
  kpiStatus.textContent = STATUS_LABELS[currentStatus] || currentStatus;

  // Badges
  stepCountBadge.textContent = history.length;
  tabStepCount.textContent = history.length;

  // Sync Input if goal provided and input is empty
  if (state.goal && !promptInput.value) {
    promptInput.value = state.goal;
  }

  // Update Thinking State Banner
  updateThinkingBanner(currentStatus, state);

  // Render Task Rows
  renderTaskRows(history, state.decision, isBusy);

  // If task finished or errored
  if (['done', 'blocked', 'error'].includes(currentStatus)) {
    stopTimer();
    if (currentStatus === 'done') {
      kpiStatus.style.color = 'var(--green)';
    } else if (currentStatus === 'blocked') {
      kpiStatus.style.color = 'var(--orange)';
    } else {
      kpiStatus.style.color = 'var(--red)';
    }
  } else {
    kpiStatus.style.color = 'var(--ink)';
  }
});

// Update Main Action Button
function updateMainButton(status) {
  mainBtn.className = 'btn-primary';

  if (['running', 'generating_text', 'retrying', 'waiting'].includes(status)) {
    mainBtn.classList.add('mode-running');
    mainBtnIcon.innerHTML = SVG.pause;
    mainBtnLabel.textContent = '暂停';
    resetBtn?.classList.remove('hidden');
  } else if (status === 'paused') {
    mainBtn.classList.add('mode-paused');
    mainBtnIcon.innerHTML = SVG.resume;
    mainBtnLabel.textContent = '继续';
    resetBtn?.classList.remove('hidden');
  } else {
    mainBtnIcon.innerHTML = SVG.play;
    mainBtnLabel.textContent = status === 'done' ? '重新运行' : '运行';
  }
}

// Update Thinking Banner (02 Thinking State)
function updateThinkingBanner(status, state) {
  if (!thinkingBanner) return;

  if (['running', 'generating_text', 'retrying', 'waiting'].includes(status)) {
    thinkingBanner.classList.remove('hidden');
    if (status === 'generating_text') {
      thinkingText.textContent = 'MiniMax 正在生成字段输入内容...';
    } else if (status === 'retrying') {
      thinkingText.textContent = 'Jev 正在重新评估页面交互...';
    } else if (status === 'waiting') {
      thinkingText.textContent = '正在等待页面过渡与结果加载...';
    } else {
      thinkingText.textContent = 'Jev 正在分析页面并决策下一步...';
    }
  } else {
    thinkingBanner.classList.add('hidden');
  }
}

// Format Action Title
function getActionTitle(action) {
  const kind = (action.kind || action.operation || '').toLowerCase();
  const label = action.label || action.target || '';
  const value = action.value || action.text || '';

  if (kind === 'type_text' || kind === 'fill') {
    return value ? `输入 "${value}"` : `输入内容到 ${label}`;
  }
  if (kind === 'click') {
    return `点击 "${label || '目标元素'}"`;
  }
  if (kind === 'scroll_down' || kind === 'scroll') {
    return '向下滚动查看更多内容';
  }
  if (kind === 'scroll_up') {
    return '向上滚动查看内容';
  }
  if (kind === 'wait') {
    return '等待页面数据加载完成';
  }
  if (kind === 'navigate') {
    return `导航至 ${action.url || label}`;
  }
  if (kind === 'done') {
    return '目标已达成，任务结束';
  }
  return action.description || `${kind} 操作`;
}

// Render Task Rows (Beautiful UI 06 Task Rows)
function renderTaskRows(history, currentDecision, isBusy) {
  if (!stepsContainer) return;

  if (history.length === 0 && !isBusy) {
    stepsContainer.innerHTML = '';
    stepsEmpty?.classList.remove('hidden');
    return;
  }

  stepsEmpty?.classList.add('hidden');
  let html = '';

  // Render completed historical steps
  history.forEach((step, idx) => {
    const stepNum = idx + 1;
    const kind = (step.kind || step.operation || 'click').toLowerCase();
    const title = getActionTitle(step);
    const chipIcon = SVG[kind] || SVG.click;
    const duration = step.elapsed_ms ? `${step.elapsed_ms}ms` : '';
    const confidence = step.confidence ? `${Math.round(step.confidence * 100)}%` : '';

    html += `
      <div class="task-row" data-index="${idx}">
        <div class="task-row-header" onclick="this.parentElement.classList.toggle('expanded')">
          <div class="task-status-icon completed">
            ${SVG.check}
          </div>
          <div class="task-info">
            <span class="task-title">${title}</span>
            <div class="task-meta">
              <span class="tool-chip ${kind}">
                ${chipIcon}
                <span>${kind.toUpperCase()}</span>
              </span>
              ${duration ? `<span>${duration}</span>` : ''}
              ${confidence ? `<span>置信度 ${confidence}</span>` : ''}
            </div>
          </div>
          <span style="color:var(--ink-3);">${SVG.chevronDown}</span>
        </div>
        <div class="task-row-details">
          ${step.target ? `<div class="task-detail-row"><span class="task-detail-key">目标:</span><span class="task-detail-val">${escapeHtml(step.target)}</span></div>` : ''}
          ${step.label ? `<div class="task-detail-row"><span class="task-detail-key">元素标签:</span><span class="task-detail-val">${escapeHtml(step.label)}</span></div>` : ''}
          ${step.value ? `<div class="task-detail-row"><span class="task-detail-key">输入值:</span><span class="task-detail-val">${escapeHtml(step.value)}</span></div>` : ''}
          ${step.choice ? `<div class="task-detail-row"><span class="task-detail-key">Jev 决策:</span><span class="task-detail-val">${escapeHtml(step.choice)}</span></div>` : ''}
        </div>
      </div>
    `;
  });

  // Render currently active step if running
  if (isBusy) {
    const nextNum = history.length + 1;
    html += `
      <div class="task-row" style="border-color:var(--accent);">
        <div class="task-row-header">
          <div class="task-status-icon running"></div>
          <div class="task-info">
            <span class="task-title" style="color:var(--accent);">第 ${nextNum} 步：正在执行...</span>
            <div class="task-meta">
              <span class="shimmer-text">AI 正在与页面交互</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  stepsContainer.innerHTML = html;
}

// 8. Detailed Logs View
window.agentAPI.onLog((log) => {
  allLogs.push(log);
  tabLogCount.textContent = allLogs.length;
  if (currentTab === 'logs') {
    appendLog(log);
  }
});

window.agentAPI.onClearLogs(() => {
  allLogs = [];
  tabLogCount.textContent = '0';
  if (logsContainer) logsContainer.innerHTML = '';
  logsEmpty?.classList.remove('hidden');
});

function renderLogs() {
  if (!logsContainer) return;
  const filtered = activeFilter === 'all'
    ? allLogs
    : allLogs.filter(l => (l.category || '').toUpperCase() === activeFilter.toUpperCase() || (l.level || '').toUpperCase() === activeFilter.toUpperCase());

  if (filtered.length === 0) {
    logsContainer.innerHTML = '';
    logsEmpty?.classList.remove('hidden');
    return;
  }

  logsEmpty?.classList.add('hidden');
  logsContainer.innerHTML = filtered.map(log => formatLogHtml(log)).join('');
}

function appendLog(log) {
  if (activeFilter !== 'all' && (log.category || '').toUpperCase() !== activeFilter.toUpperCase()) {
    return;
  }
  logsEmpty?.classList.add('hidden');
  const div = document.createElement('div');
  div.innerHTML = formatLogHtml(log);
  if (div.firstElementChild) {
    logsContainer.appendChild(div.firstElementChild);
    logsView.scrollTop = logsView.scrollHeight;
  }
}

function formatLogHtml(log) {
  const cat = escapeHtml((log.category || 'SYS').toUpperCase());
  const msg = escapeHtml(log.message || '');
  const time = escapeHtml(log.timestamp || '');
  return `
    <div class="log-entry">
      <span class="log-time">${time}</span>
      <span class="log-cat ${cat}">${cat}</span>
      <span class="log-msg">${msg}</span>
    </div>
  `;
}

// Log Filter buttons
document.querySelectorAll('.log-filters .filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.log-filters .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    renderLogs();
  });
});

// Copy Logs
copyLogsBtn?.addEventListener('click', async () => {
  if (allLogs.length === 0) return;
  const text = allLogs.map(l => `[${l.timestamp}] [${l.category}] ${l.message}`).join('\n');
  await navigator.clipboard.writeText(text);
  const orig = copyLogsBtn.innerHTML;
  copyLogsBtn.innerHTML = `${SVG.check} <span>已复制</span>`;
  setTimeout(() => { copyLogsBtn.innerHTML = orig; }, 1500);
});

// Clear Logs
clearLogsBtn?.addEventListener('click', () => {
  window.agentAPI.clearLogs();
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 9. Settings Controller (Beautiful UI Modal)
const settingsBtn = document.getElementById('settingsBtn');
const modelPillBtn = document.getElementById('modelPillBtn');
const topModelLabel = document.getElementById('topModelLabel');
const settingsModal = document.getElementById('settingsModal');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const saveStatusHint = document.getElementById('saveStatusHint');

const cfgTypeSafeApiKey = document.getElementById('cfgTypeSafeApiKey');
const cfgTypeSafeModel = document.getElementById('cfgTypeSafeModel');
const testJevBtn = document.getElementById('testJevBtn');
const testJevFeedback = document.getElementById('testJevFeedback');

const cfgTextModelBaseUrl = document.getElementById('cfgTextModelBaseUrl');
const cfgTextModelApiKey = document.getElementById('cfgTextModelApiKey');
const cfgTextModel = document.getElementById('cfgTextModel');
const testTextModelBtn = document.getElementById('testTextModelBtn');
const testTextFeedback = document.getElementById('testTextFeedback');

const PROVIDER_PRESETS = {
  minimax: {
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M3',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
};

async function loadSettingsIntoForm() {
  if (testJevFeedback) testJevFeedback.className = 'test-feedback hidden';
  if (testTextFeedback) testTextFeedback.className = 'test-feedback hidden';
  if (saveStatusHint) {
    saveStatusHint.textContent = '配置修改后即时热更新生效并写入本地 .env';
    saveStatusHint.style.color = 'var(--ink-3)';
  }

  try {
    const s = await window.agentAPI.getSettings();
    if (s) {
      if (cfgTypeSafeApiKey) cfgTypeSafeApiKey.value = s.typeSafeApiKey || '';
      if (cfgTypeSafeModel) cfgTypeSafeModel.value = s.typeSafeModel || 'jev-latest';
      if (cfgTextModelBaseUrl) cfgTextModelBaseUrl.value = s.textModelBaseUrl || 'https://api.minimaxi.com/v1';
      if (cfgTextModelApiKey) cfgTextModelApiKey.value = s.textModelApiKey || '';
      if (cfgTextModel) cfgTextModel.value = s.textModel || 'MiniMax-M3';

      syncProviderPill(s.textModelBaseUrl);
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

function openSettings() {
  if (!isDrawerOpen) {
    toggleDrawer(true);
  }
  switchTab('settings');
}

function syncProviderPill(url = '') {
  document.querySelectorAll('.provider-pill').forEach(btn => btn.classList.remove('active'));
  if (/minimax/i.test(url)) {
    document.querySelector('.provider-pill[data-provider="minimax"]')?.classList.add('active');
  } else if (/deepseek/i.test(url)) {
    document.querySelector('.provider-pill[data-provider="deepseek"]')?.classList.add('active');
  } else if (/openai/i.test(url)) {
    document.querySelector('.provider-pill[data-provider="openai"]')?.classList.add('active');
  } else {
    document.querySelector('.provider-pill[data-provider="custom"]')?.classList.add('active');
  }
}

settingsBtn?.addEventListener('click', openSettings);
modelPillBtn?.addEventListener('click', openSettings);

// Provider pill switching
document.querySelectorAll('.provider-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.provider-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const provider = btn.dataset.provider;
    if (PROVIDER_PRESETS[provider]) {
      cfgTextModelBaseUrl.value = PROVIDER_PRESETS[provider].baseUrl;
      cfgTextModel.value = PROVIDER_PRESETS[provider].model;
    }
  });
});

// Toggle password visibility
document.querySelectorAll('.toggle-pwd-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const targetId = btn.dataset.target;
    const input = document.getElementById(targetId);
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      btn.style.color = 'var(--accent)';
    } else {
      input.type = 'password';
      btn.style.color = 'var(--ink-3)';
    }
  });
});

// Test Jev Connection
testJevBtn?.addEventListener('click', async () => {
  testJevFeedback.className = 'test-feedback loading';
  testJevFeedback.textContent = '正在向 TypeSafe 发起握手测试...';
  const res = await window.agentAPI.testConnection('typesafe', {
    typeSafeApiKey: cfgTypeSafeApiKey.value,
    typeSafeModel: cfgTypeSafeModel.value,
  });
  if (res.success) {
    testJevFeedback.className = 'test-feedback success';
    testJevFeedback.textContent = `✓ ${res.message || '连接成功'}`;
  } else {
    testJevFeedback.className = 'test-feedback error';
    testJevFeedback.textContent = `✕ 测试失败: ${res.error || '无法连接'}`;
  }
});

// Test Text Model Connection
testTextModelBtn?.addEventListener('click', async () => {
  testTextFeedback.className = 'test-feedback loading';
  testTextFeedback.textContent = '正在向模型发送测试请求...';
  const res = await window.agentAPI.testConnection('text_model', {
    textModelApiKey: cfgTextModelApiKey.value,
    textModelBaseUrl: cfgTextModelBaseUrl.value,
    textModel: cfgTextModel.value,
  });
  if (res.success) {
    testTextFeedback.className = 'test-feedback success';
    testTextFeedback.textContent = `✓ ${res.message || '模型响应正常'}`;
  } else {
    testTextFeedback.className = 'test-feedback error';
    testTextFeedback.textContent = `✕ 测试失败: ${res.error || '无法连接'}`;
  }
});

// Save Settings
saveSettingsBtn?.addEventListener('click', async () => {
  const newSettings = {
    typeSafeApiKey: cfgTypeSafeApiKey.value,
    typeSafeModel: cfgTypeSafeModel.value,
    textModelBaseUrl: cfgTextModelBaseUrl.value,
    textModelApiKey: cfgTextModelApiKey.value,
    textModel: cfgTextModel.value,
  };

  saveSettingsBtn.textContent = '正在保存...';
  const res = await window.agentAPI.saveSettings(newSettings);
  saveSettingsBtn.textContent = '保存配置';

  if (res.success) {
    saveStatusHint.textContent = '✓ 配置已成功更新并持久化！';
    saveStatusHint.style.color = 'var(--green)';
    if (topModelLabel) {
      topModelLabel.textContent = newSettings.typeSafeModel || 'Jev 1.0';
    }
    setTimeout(() => {
      closeSettings();
    }, 600);
  } else {
    saveStatusHint.textContent = `✕ 保存失败: ${res.error}`;
    saveStatusHint.style.color = 'var(--red)';
  }
});

