/**
 * Decision post-processing safeguards for pagination and search.
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
 * @returns {{ selected: string, status?: string, blockedReason?: string, verify?: boolean }}
 */
function applyDecisionSafeguards({
  selected,
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
          h.search_result_ordinal === targetResultOrdinal && h.opened_target_result === true &&
          h.after_url === page.url
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
      const goalNeedsScroll = /翻|滚动|scroll|page|bottom|more|next|更多/i.test(goal);
      if (goalNeedsScroll) {
        logger.info('SAFEGUARD', 'Overriding premature BLOCKED with scroll_down');
        next = 'scroll_down';
      }
    }

    if (next === 'BLOCKED' && /搜索|搜一下|查找|search|look up/i.test(goal)) {
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
      return { selected: next, verify: true };
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
    return { selected: next, verify: true };
  }

  if (next === 'BLOCKED') {
    return {
      selected: next,
      status: 'waiting_for_user',
      blockedReason:
        '当前页面没有找到能够继续完成目标的操作，任务尚未完成。请检查是否到达正确页面，或补充更明确的目标后运行新任务。',
    };
  }
  return { selected: next };
}

const RISKY_LABEL = /支付|下单|购买|删除|退出登录|确认订单|加入购物车|去结算|pay now|buy now|place order|add to cart|checkout|delete|send message|发送/i;
const DOWNLOAD_URL = /\.(?:pkg|exe|dmg|zip)(?:$|[?#])/i;
const CHECKOUT_URL = /(?:^|[/?#])(?:checkout|cart|add-to-cart|orders?)(?:\/|$|\?|#)/i;

function isCommitAction(action) {
  const label = action?.label || '';
  const href = action?.href || action?.url || '';
  if (['click', 'fill', 'navigate'].includes(action?.kind) && RISKY_LABEL.test(label)) return true;
  return ['click', 'navigate'].includes(action?.kind) && (DOWNLOAD_URL.test(href) || CHECKOUT_URL.test(href));
}

module.exports = {
  applyDecisionSafeguards,
  isCommitAction,
};
