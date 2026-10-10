/** Goal parsing helpers shared by runner safeguards. */
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



module.exports = {
  extractRequestedResultIndex,
  extractTargetPage,
  isTargetPageReached,
};
