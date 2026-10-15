/**
 * Atomic DOM extraction script ported from jev-ultrafast/snapshot.js.
 * This script runs directly inside the target WebContents page context.
 */

const { adaptersForInjection } = require('./sites');
const __SITE_ADAPTERS__ = adaptersForInjection();

const SNAPSHOT_SCRIPT = `(() => {
  const __SITE_ADAPTERS__ = ${JSON.stringify(__SITE_ADAPTERS__)};
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  // Identify organic search result title links via site adapters
  const matchedAdapter = (__SITE_ADAPTERS__ || []).find((a) => new RegExp(a.pagePatternSource, 'i').test(location.href));
  const isSearchPage = Boolean(matchedAdapter);
  const searchResultLinks = new Map();
  const sponsored = link => {
    const container = link.closest('[data-tuiguang], [data-text-ad], .b_ad, #tads, #tadsb');
    // Baidu sponsored results use baidu.php instead of the organic /link redirect.
    return Boolean(container || /(?:baidu\\.com\\/baidu\\.php|googleadservices\\.com|bing\\.com\\/aclick)/i.test(link.href));
  };
  if (matchedAdapter) {
    const resultContainers = document.querySelectorAll(matchedAdapter.resultContainers);
    let ordinal = 1;
    for (const container of resultContainers) {
      if (!visible(container)) continue;
      const titleLink = container.querySelector('h2 a, h3 a, .c-title a, a.c-title-text, a[data-showurl-highlight]');
      if (titleLink && visible(titleLink) && !sponsored(titleLink) && !searchResultLinks.has(titleLink)) {
        searchResultLinks.set(titleLink, ordinal++);
      }
    }
    if (searchResultLinks.size === 0) {
      const headingLinks = document.querySelectorAll(matchedAdapter.headingLinks);
      const noise = new RegExp(matchedAdapter.noiseLabel, 'i');
      let fallbackOrd = 1;
      for (const hl of headingLinks) {
        if (!visible(hl) || sponsored(hl)) continue;
        const txt = hl.innerText.trim();
        if (txt.length > 3 && !noise.test(txt)) {
          searchResultLinks.set(hl, fallbackOrd++);
        }
      }
    }
  }

  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    let res = referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (['INPUT', 'TEXTAREA'].includes(e.tagName) ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || e.getAttribute('data-placeholder') || '';

    // Infer field label from parent container or previous siblings (e.g. 出发地, 目的地, 出发日期, 返程日期)
    const isGenericCity = /^(可输入城市或机场|请输入城市|城市或机场|中文|拼音|城市|请输入出发地|请输入目的地|城市名)$/i.test(res);
    const isGenericDate = /^(请选择日期|出发日期|去程日期|返程日期|选择日期|日期)$/i.test(res);
    if ((!res || isGenericCity || isGenericDate) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName)) {
      const formParent = e.closest('.form-item, .search-box-item, [class*="item"], [class*="box"], [class*="field"], [class*="input"], [class*="city"], [class*="dest"], [class*="depart"], [class*="date"], div, label');
      if (formParent) {
        const candidates = Array.from(formParent.querySelectorAll('label, span, p, .label, .title, [class*="label"], [class*="title"], [class*="name"], div'))
          .filter(el => el !== e && !el.contains(e) && !e.contains(el))
          .map(el => el.innerText.trim())
          .filter(t => t && t.length > 0 && t.length <= 16 && !/^\d+$/.test(t));
        if (candidates.length > 0) {
          const first = candidates[0];
          if (/日期|时间|date|日/i.test(first) || isGenericDate) {
            const datePrefix = /返/i.test(first) ? '返程日期' : '出发日期';
            res = datePrefix + (res ? ' (' + res + ')' : '');
          } else if (/目的|到达/i.test(first)) {
            res = '目的地城市输入框' + (res ? ' (' + res + ')' : '');
          } else if (/出发/i.test(first)) {
            res = '出发地城市输入框' + (res ? ' (' + res + ')' : '');
          }
        }
      }
    }

    // Identify swap / exchange button between cities
    if (/swap|exchange/i.test((e.className || '') + ' ' + (e.id || '')) || (res || '').trim() === '') {
      res = '互换出发地和目的地 (Swap Cities)';
    }

    const isSearchEngine = /baidu\.com|google\.[a-z.]+|bing\.com|sogou\.com|so\.com/i.test(location.href);
    const isCityOrPicker = Boolean(
      e.closest('[class*="city"], [class*="dest"], [class*="depart"], [class*="picker"], [class*="airport"], [class*="station"]') ||
      /城市|机场|车站|目的地|出发地|到达地/i.test((res || '') + ' ' + (e.getAttribute('placeholder') || ''))
    );
    const isSearchInput = !isCityOrPicker && ['INPUT', 'TEXTAREA'].includes(e.tagName) && (
      e.type === 'search' ||
      /search|chat-textarea|chat-input|s_ipt|kw|wd/i.test((e.id || '') + ' ' + (e.name || '') + ' ' + (e.className || '')) ||
      e.closest('form[action*="search"], form[action*="baidu"], .s_form, #form')
    );
    if (isSearchInput) {
      if (isSearchEngine) {
        res = '网页搜索框 (Web Search Box)' + (res ? ' - ' + res : '');
      } else {
        res = (res ? res + ' (全站搜索)' : '全站搜索输入框 (Site Search Box)');
      }
    } else if (isCityOrPicker && ['INPUT', 'TEXTAREA'].includes(e.tagName)) {
      const isDest = Boolean(e.closest('[class*="dest"], [class*="arrive"], [class*="to"]') || /目的|到达/i.test(res));
      const isDepart = Boolean(e.closest('[class*="depart"], [class*="from"]') || /出发/i.test(res));
      if (isDest && !/目的|到达/i.test(res)) {
        res = '目的地城市输入框' + (res ? ' (' + res + ')' : '');
      } else if (isDepart && !/出发/i.test(res)) {
        res = '出发地城市输入框' + (res ? ' (' + res + ')' : '');
      }
    }
    if (!res && e.tagName === 'A') {
      const href = e.getAttribute('href') || '';
      const pageMatch = href.match(/page=(\\d+)/i);
      if (pageMatch) res = '第 ' + pageMatch[1] + ' 页';
      const svg = e.querySelector('svg');
      if (svg) {
        const svgCls = (svg.getAttribute('class') || '') + ' ' + (svg.getAttribute('id') || '');
        if (/right|next|chevron-right|arrow-right/i.test(svgCls)) res = (res ? res + ' ' : '') + '下一页 (Next Page)';
        else if (/left|prev|chevron-left|arrow-left/i.test(svgCls)) res = (res ? res + ' ' : '') + '上一页 (Prev Page)';
      }
    }
    if (e.tagName === 'LI' && /^\\d+$/.test(e.innerText.trim())) {
      res = '第 ' + e.innerText.trim() + ' 页 (Page ' + e.innerText.trim() + ')';
    }
    if (searchResultLinks.has(e)) {
      const ord = searchResultLinks.get(e);
      const cleanTitle = (res || e.innerText.trim()).replace(/^搜索结果第\\s*\\d+\\s*条[^:]*:\\s*/, '');
      res = '搜索结果第 ' + ord + ' 条 (Search Result #' + ord + '): ' + cleanTitle;
    }
    return res;
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',') +
    ',.paging li, .pagination li, [class*="pager"] li, [class*="pagination"] li,' +
    '[class*="btn"], [class*="button"], [class*="search"], [class*="city"], [class*="dest"],' +
    '[class*="depart"], [class*="arrive"], [class*="station"], [class*="airport"],' +
    '[class*="date"], [class*="calendar"], [class*="picker"], [class*="swap"], [class*="exchange"],' +
    '[class*="form-item"], [class*="search-box"], [class*="searchBox"], [class*="input-box"],' +
    '[onclick], [tabindex]:not([tabindex="-1"])';
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (['INPUT', 'TEXTAREA'].includes(e.tagName)) {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      const isSearch = e.type === 'search' ||
        /search|chat-textarea|chat-input|s_ipt|kw|wd/i.test((e.id || '') + ' ' + (e.name || '') + ' ' + (e.className || '')) ||
        e.closest('form[action*="search"], form[action*="baidu"], .s_form, #form');
      if (isSearch) return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (e.tagName==='TEXTAREA' || ['text','email','url','tel',''].includes(e.type)) return 'textbox';
    }
    if (e.isContentEditable) return 'textbox';
    if (e.tagName === 'LI' && (e.closest('.paging, .pagination, [class*="pager"], [class*="pagination"]') || /^\d+$/.test(e.innerText.trim()))) {
      return 'button';
    }
    if (['DIV', 'SPAN', 'LABEL', 'I', 'SECTION', 'LI'].includes(e.tagName)) {
      if (e.closest('button, a[href], select')) return null;
      const hasVisibleControl = Array.from(e.querySelectorAll('input:not([type="hidden"]), select, textarea, button'))
        .some(c => visible(c) && !c.matches(':disabled'));
      if (hasVisibleControl && e.children.length > 0) return null;

      const cls = (e.className || '') + ' ' + (e.id || '');
      const txt = (e.innerText || '').trim();

      // 1. Search, submit, confirm buttons
      if (/search-btn|search_btn|searchBtn|btn-search|submit-btn|btn-primary|search-button/i.test(cls) ||
          (txt && /^搜索$|^查询$|^确定$|^完成$|^查航班$|^立即搜索$/i.test(txt))) {
        return 'button';
      }

      // 2. Swap / exchange button between cities
      if (/swap|exchange/i.test(cls) || txt === '') {
        return 'button';
      }

      // 3. City, date, destination, origin boxes
      if (/city|dest|depart|arrive|station|airport|date|picker|calendar|form-item|search-box|searchBox|input-box/i.test(cls)) {
        return 'combobox';
      }

      // 4. Autocomplete / dropdown suggestion items (e.g. li in city picker)
      if (e.tagName === 'LI' || /item|suggest|option|city-item/i.test(cls)) {
        if (txt.length > 0 && txt.length <= 40) return 'option';
      }

      // 5. Elements with cursor: pointer and reasonable text length
      if (e.hasAttribute('onclick') || (txt.length > 0 && txt.length <= 30 && /pointer/i.test(window.getComputedStyle(e).cursor))) {
        return 'button';
      }
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };

  const actions=[];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || r.right<=0 || r.bottom<=0 || r.left>=innerWidth || r.top>=innerHeight) continue;
    const clampedX = Math.max(r.left + 5, Math.min(x, innerWidth - 5));
    const clampedY = Math.max(r.top + 5, Math.min(y, innerHeight - 5));
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:name(e)||rname,
      rect:{x:clampedX,y:clampedY,w:r.width,h:r.height},
      search_result_ordinal: searchResultLinks.get(e) || null, href: e.tagName === 'A' ? e.href : null};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-80);
  actions.splice(80);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions};
})()`;

// Prefer main text, then the rest of the body. Page in 24k windows so a long page is not frozen at its header.
function contentScript(skip = 0) {
  const start = Math.max(0, Math.floor(Number(skip) || 0));
  return `(() => {
    if (!document.body) return null;
    const visible = (el) => Boolean(el) && !el.closest('script,style,noscript,template,[aria-hidden="true"],[inert]') &&
      el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    const parts = [], seen = new Set();
    const main = document.querySelector('main, article, [role="main"]');
    const roots = main && main !== document.body ? [main, document.body] : [document.body];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (seen.has(node)) continue;
        seen.add(node);
        const parent = node.parentElement, value = node.textContent.trim();
        if (!value || !visible(parent) || parent.closest('option')) continue;
        parts.push(value);
      }
    }
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (!visible(el) || ['password', 'hidden', 'file'].includes(el.type)) continue;
      const value = el.tagName === 'SELECT'
        ? [...el.selectedOptions].map(option => option.label.trim()).filter(Boolean).join(', ')
        : String(el.value || '').trim();
      if (value) parts.push(value);
    }
    const capped = [];
    let total = 0, hitCap = false;
    for (const value of parts) {
      if (total >= 200000) { hitCap = true; break; }
      capped.push(value);
      total += value.length + 1;
    }
    const joined = capped.join('\\n');
    const start = ${start};
    const content = joined.slice(start, start + 24000);
    const reachedEnd = start + content.length >= joined.length;
    return { url: location.href, content, truncated: !reachedEnd || hitCap, consumed: content.length, total: joined.length };
  })()`;
}
const CONTENT_SCRIPT = contentScript(0);

module.exports = { SNAPSHOT_SCRIPT, CONTENT_SCRIPT, contentScript };
