/**
 * Site adapter config injected into the in-page SNAPSHOT_SCRIPT.
 * Keep selectors data-only; logic stays in snapshot.js.
 */

const SEARCH_ENGINES = {
  baidu: {
    id: 'baidu',
    pagePatternSource: String.raw`baidu\.com\/s`,
    resultContainers:
      '#content_left .result, #content_left .c-container, #content_left [tpl]',
    headingLinks: '#content_left h3 a, h2 a, h3 a',
    noiseLabel: String.raw`百度|设置|登录|广告|推广|热搜|相关搜索`,
  },
  google: {
    id: 'google',
    pagePatternSource: String.raw`google\.[a-z.]+\/search`,
    resultContainers: '#rso .g',
    headingLinks: 'h3 a',
    noiseLabel: String.raw`Settings|Sign in|Ads|Sponsored`,
  },
  bing: {
    id: 'bing',
    pagePatternSource: String.raw`bing\.com\/search`,
    resultContainers: '#b_results .b_algo',
    headingLinks: 'h2 a',
    noiseLabel: String.raw`Settings|Sign in|Ads|Sponsored`,
  },
  generic: {
    id: 'generic',
    pagePatternSource: String.raw`sogou\.com\/web|so\.com\/s`,
    resultContainers: '.results .rb, .result',
    headingLinks: 'h2 a, h3 a',
    noiseLabel: String.raw`设置|登录|广告|推广`,
  },
};

function buildSearchPagePattern() {
  return new RegExp(
    Object.values(SEARCH_ENGINES)
      .map((s) => s.pagePatternSource)
      .join('|'),
    'i'
  );
}

/** Serialize adapters for injection into the page script string. */
function adaptersForInjection() {
  return Object.values(SEARCH_ENGINES).map((s) => ({
    id: s.id,
    pagePatternSource: s.pagePatternSource,
    resultContainers: s.resultContainers,
    headingLinks: s.headingLinks,
    noiseLabel: s.noiseLabel,
  }));
}

module.exports = {
  SEARCH_ENGINES,
  buildSearchPagePattern,
  adaptersForInjection,
};
