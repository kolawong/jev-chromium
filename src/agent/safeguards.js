/**
 * Decision post-processing safeguards (pagination, search, anti-loop).
 * Kept separate from AgentRunner so behavior can be unit-tested.
 */
const {
  extractRequestedResultIndex,
  extractTargetPage,
  isTargetPageReached,
} = require('./goalParse');
const { logger } = require('./logger');

/**
 * Apply rule-based overrides to the model-selected action id.
 * @returns {{ selected: string, status?: string, blockedReason?: string, done?: boolean }}
 */
function applyDecisionSafeguards({
  selected,
  decision,
  page,
  goal,
  history,
}) {
  let next = selected;
  const targetResultOrdinal = extractRequestedResultIndex(goal);
  const targetPageNum = extractTargetPage(goal);
  const targetPageReached = isTargetPageReached(page, history, targetPageNum);
  const hasOpenedTargetResult = targetResultOrdinal
    ? history.some(
        (h) =>
          h.search_result_ordinal === targetResultOrdinal ||
          (h.target && h.target.includes(`搜索结果第 ${targetResultOrdinal} 条`))
      )
    : false;

  // Prevent premature BLOCKED
  if (next === 'BLOCKED') {
    const blockedPageNum = extractTargetPage(goal);
    if (blockedPageNum) {
      const pageBtn = page.actions.find((a) =>
        new RegExp(`第\\s*${blockedPageNum}\\s*页|Page\\s*${blockedPageNum}\\b`, 'i').test(a.label)
      );
      if (pageBtn) {
        logger.info('SAFEGUARD', `Found target page button ${pageBtn.label}, overriding BLOCKED`);
        next = pageBtn.id;
      }
    }

    if (next === 'BLOCKED' && page.actions.some((a) => a.id === 'scroll_down')) {
      const goalNeedsScroll = /翻|页|page|scroll|bottom|more|next|下|更多/i.test(goal);
      if (goalNeedsScroll) {
        logger.info('SAFEGUARD', 'Overriding premature BLOCKED with scroll_down');
        next = 'scroll_down';
      }
    }

    if (next === 'BLOCKED') {
      const searchInput = page.actions.find(
        (a) =>
          a.kind === 'fill' &&
          (/搜索|search|kw|wd/i.test(a.label) ||
            a.role === 'searchbox' ||
            (a.role === 'textbox' && /搜索/i.test(a.label)))
      );
      const hasNotFilledSearch = !history.some((h) => h.kind === 'fill');
      if (searchInput && hasNotFilledSearch) {
        logger.info('SAFEGUARD', `Page has search box [${searchInput.label}], overriding BLOCKED with fill`);
        next = searchInput.id;
      }
    }
  }

  // Ordinal result already opened
  if (targetResultOrdinal && hasOpenedTargetResult && !/查看详情后|总结|提取|填写|复制/i.test(goal)) {
    const lastAction = history[history.length - 1];
    if (
      lastAction &&
      (lastAction.search_result_ordinal === targetResultOrdinal || lastAction.opened_target_result)
    ) {
      return { selected: next, done: true };
    }
  }

  // Ordinal result on target page
  if (targetResultOrdinal && targetPageReached && !hasOpenedTargetResult) {
    const targetLink =
      page.actions.find((a) => a.search_result_ordinal === targetResultOrdinal) ||
      page.actions.find(
        (a) =>
          a.kind === 'click' &&
          new RegExp(`搜索结果第\\s*${targetResultOrdinal}\\s*条|Search Result #${targetResultOrdinal}\\b`, 'i').test(
            a.label
          )
      );

    if (targetLink) {
      if (next === 'DONE' || next === 'BLOCKED' || next !== targetLink.id) {
        logger.action(
          'SEARCH_RESULT',
          `定位目标第 ${targetResultOrdinal} 条搜索结果: [${targetLink.label}]，执行点击打开`
        );
        next = targetLink.id;
      }
    } else if (next === 'DONE') {
      const scrollDown = page.actions.find((a) => a.id === 'scroll_down');
      if (scrollDown) next = scrollDown.id;
    }
  }

  // Need to reach target page first
  if (targetPageNum && targetPageNum > 1 && !targetPageReached) {
    if (next === 'DONE') {
      const pageBtn = page.actions.find((a) =>
        new RegExp(`第\\s*${targetPageNum}\\s*页|Page\\s*${targetPageNum}\\b`, 'i').test(a.label)
      );
      if (pageBtn) next = pageBtn.id;
      else {
        const nextBtn = page.actions.find((a) => /下一页|next page|下一页 >/i.test(a.label));
        next = nextBtn ? nextBtn.id : 'scroll_down';
      }
    } else {
      const candidateAction = page.actions.find((a) => a.id === next);
      if (candidateAction && candidateAction.search_result_ordinal) {
        logger.info('PAGINATION', `目标要求在第 ${targetPageNum} 页操作，拦截过早结果点击`);
        const pageBtn = page.actions.find((a) =>
          new RegExp(`第\\s*${targetPageNum}\\s*页|Page\\s*${targetPageNum}\\b`, 'i').test(a.label)
        );
        if (pageBtn) next = pageBtn.id;
        else {
          const nextBtn = page.actions.find((a) => /下一页|next page|下一页 >/i.test(a.label));
          next = nextBtn ? nextBtn.id : 'scroll_down';
        }
      }
    }
  }

  if (next === 'DONE') {
    return { selected: next, done: true };
  }

  if (next === 'BLOCKED') {
    return {
      selected: next,
      status: 'waiting_for_user',
      blockedReason:
        '模型遇到需要人工协助的节点（如滑块验证码、账号登录、权限拦截或页面确认）。请直接在左侧浏览器中操作，完成后点击【我已处理，继续】。',
    };
  }

  // Anti-loop
  const lastStep = history[history.length - 1];
  if (lastStep && lastStep.choice === next && lastStep.page_changed === false) {
    const confirmAction = page.actions.find((a) =>
      /(done|apply|confirm|ok|select|submit|search|搜索|查询|确定|查航班|检索)/i.test((a.label || '').trim())
    );
    if (confirmAction && confirmAction.id !== next) {
      logger.info('SAFEGUARD', `重复操作无响应，切换确认/搜索按钮: [${confirmAction.label}]`);
      next = confirmAction.id;
    } else if (lastStep.kind === 'fill') {
      const otherAction = page.actions.find(
        (a) => a.id !== next && a.id !== 'wait' && (a.kind === 'click' || a.id === 'scroll_down')
      );
      if (otherAction) {
        logger.info('SAFEGUARD', `输入无反馈，切换执行: [${otherAction.label}]`);
        next = otherAction.id;
      }
    } else if (decision?.probabilities) {
      const sorted = Object.entries(decision.probabilities)
        .filter(([id]) => id !== next && id !== 'BLOCKED' && id !== 'DONE')
        .sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0 && page.actions.some((a) => a.id === sorted[0][0])) {
        next = sorted[0][0];
      }
    }
  }

  return { selected: next };
}

module.exports = {
  applyDecisionSafeguards,
};
