/** Read-only description glossary. Load after common.js; await init() after RKData.init(). */
(function (global, factory) {
  const api = factory(global);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global.document) global.GameGlossary = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
  'use strict';
  const CATEGORIES = Object.freeze(['状态', '印记', '战斗动作', '战斗规则', '天气', '其他']);
  // Deliberately NOT whole cards, headings, names, table cells, or editor fields.
  const DESCRIPTION_SELECTORS = Object.freeze([
    '.detail-skill-desc', '.move-detail-skill-desc', '.refraction-effect-desc',
    '.detail-trait-desc', '.detail-trait-summary', '.detail-trait-extra'
  ]);
  const selector = DESCRIPTION_SELECTORS.join(',');
  const skipSelector = [
    '.game-glossary-term', '.game-glossary-tooltip', '[role="tooltip"]',
    'script', 'style', 'noscript', 'textarea', 'input', 'select', 'option',
    'button', 'a', 'code', 'pre', 'th', 'thead',
    '[contenteditable]:not([contenteditable="false"])',
    '.detail-skill-name', '.detail-trait-name', '.move-detail-skill-name',
    '#ud-tab-content', '.cui-popup-overlay', '[data-game-glossary="off"]'
  ].join(',');
  const doc = global.document;
  const common = () => typeof CommonUI !== 'undefined' ? CommonUI : global.CommonUI;

  function normalizeEntries(raw) {
    if (!Array.isArray(raw)) throw new TypeError('游戏描述数据必须是数组');
    const names = new Map();
    const ids = new Set();
    for (const row of raw) {
      if (!row || typeof row.name !== 'string' || !row.name.trim() ||
          typeof row.description !== 'string' || !row.description.trim() ||
          !CATEGORIES.includes(row.category) ||
          (row.attribute != null && typeof row.attribute !== 'string')) {
        throw new TypeError('无效的游戏描述词条');
      }
      const name = row.name.trim();
      const previous = names.get(name);
      if (previous) {
        if (previous.description !== row.description || previous.category !== row.category ||
            previous.attribute !== (row.attribute || null)) throw new Error(`词条内容冲突：${name}`);
        continue; // Exact duplicate names produce only one matcher branch / page entry.
      }
      const id = String(row.id || name);
      if (ids.has(id)) throw new Error(`重复的词条 ID：${id}`);
      ids.add(id);
      names.set(name, Object.freeze({ id, name, category: row.category,
        attribute: row.attribute || null, description: row.description }));
    }
    return Object.freeze([...names.values()]);
  }

  /** Literal trie, not a regex or HTML replacement. Left-to-right, longest at each position. */
  function createMatcher(raw) {
    const entries = normalizeEntries(raw);
    const trie = { children: new Map() };
    for (const entry of entries) {
      let node = trie;
      for (const char of entry.name) {
        if (!node.children.has(char)) node.children.set(char, { children: new Map() });
        node = node.children.get(char);
      }
      node.entry = entry;
    }
    function tokenize(value) {
      const chars = Array.from(String(value ?? ''));
      const parts = [];
      let plain = '';
      for (let i = 0; i < chars.length;) {
        let node = trie, hit = null, end = i;
        for (let j = i; j < chars.length && node.children.has(chars[j]); j++) {
          node = node.children.get(chars[j]);
          if (node.entry) { hit = node.entry; end = j + 1; }
        }
        if (!hit) { plain += chars[i++]; continue; }
        if (plain) { parts.push({ text: plain, entry: null }); plain = ''; }
        parts.push({ text: chars.slice(i, end).join(''), entry: hit });
        i = end;
      }
      if (plain) parts.push({ text: plain, entry: null });
      return parts;
    }
    return Object.freeze({ entries, tokenize });
  }

  let matcher = createMatcher([]), initPromise = null, installed = false;
  let observer = null, frame = null, layer = null, anchor = null, closeLayer = null, hideTimer = null;
  const pending = new Set(), listeners = [], ownNodes = new WeakSet();
  const byId = new Map();
  const requestFrame = fn => global.requestAnimationFrame(fn);
  const elementOf = node => node?.nodeType === 1 ? node : node?.parentElement;
  const inLayer = node => !!elementOf(node)?.closest('.game-glossary-tooltip');

  function queue(root) {
    if (!root || inLayer(root)) return;
    for (const old of pending) if (old === root || old.contains?.(root)) return;
    for (const old of pending) if (root.contains?.(old)) pending.delete(old);
    pending.add(root);
    if (frame == null) frame = requestFrame(() => {
      frame = null;
      const roots = [...pending];
      pending.clear();
      roots.forEach(node => { if (node.isConnected) decorate(node); });
    });
  }

  function decorateText(text) {
    const parent = text.parentElement;
    if (!parent || parent.closest(skipSelector) || !text.nodeValue) return 0;
    const parts = matcher.tokenize(text.nodeValue);
    if (!parts.some(part => part.entry)) return 0;
    const fragment = doc.createDocumentFragment();
    let count = 0;
    for (const part of parts) {
      let node;
      if (!part.entry) node = doc.createTextNode(part.text);
      else {
        node = doc.createElement('span');
        node.className = 'game-glossary-term';
        node.tabIndex = 0;
        node.dataset.glossaryId = part.entry.id;
        // No innerHTML, no inline event handlers, no data/description write-back.
        node.textContent = part.text;
        count++;
      }
      ownNodes.add(node);
      fragment.appendChild(node);
    }
    ownNodes.add(text);
    text.replaceWith(fragment);
    return count;
  }

  /** Synchronous and idempotent; returns the number of new term spans. */
  function decorate(root = doc?.body) {
    if (!root || !matcher.entries.length) return 0;
    const base = root.nodeType === 3 ? root.parentElement : root;
    if (!base || elementOf(base)?.closest(skipSelector)) return 0;
    const regions = new Set();
    const containing = elementOf(base)?.closest(selector);
    if (containing) regions.add(containing);
    base.querySelectorAll?.(selector).forEach(region => regions.add(region));
    const texts = new Set();
    for (const region of regions) {
      if (region.closest(skipSelector)) continue;
      const walker = doc.createTreeWalker(region, 4 /* SHOW_TEXT */);
      while (walker.nextNode()) texts.add(walker.currentNode);
    }
    let count = 0;
    for (const text of texts) count += decorateText(text);
    return count;
  }

  function clearHide() { if (hideTimer != null) global.clearTimeout(hideTimer); hideTimer = null; }
  function close() {
    clearHide();
    if (closeLayer) { const dispose = closeLayer; closeLayer = null; dispose(); return; }
    if (anchor && layer) {
      const ids = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== layer.id);
      if (ids.length) anchor.setAttribute('aria-describedby', ids.join(' '));
      else anchor.removeAttribute('aria-describedby');
    }
    anchor = null;
    if (layer) layer.hidden = true;
  }
  function closeSoon() {
    clearHide();
    // Small pointer bridge between the inline text and the fixed popup.
    hideTimer = global.setTimeout(() => {
      hideTimer = null;
      if (anchor?.contains(doc.activeElement) || layer?.contains(doc.activeElement)) return;
      close();
    }, 200);
  }
  function termOf(target) { return elementOf(target)?.closest('.game-glossary-term'); }
  function insideActive(target) { return !!target && (anchor?.contains(target) || layer?.contains(target)); }

  function show(next) {
    if (!next?.isConnected || !byId.has(next.dataset.glossaryId) ||
        !next.getClientRects().length || next.parentElement?.closest(skipSelector) ||
        doc.querySelector('.cui-popup-overlay')) return;
    const ui = common();
    if (!ui?.positionAnchoredLayer || !ui?.bindAnchoredLayer) return;
    clearHide();
    if (anchor === next) return;
    close();
    anchor = next;
    const entry = byId.get(next.dataset.glossaryId);
    if (!layer) {
      layer = doc.createElement('div');
      layer.id = 'game-glossary-tooltip';
      layer.className = 'game-glossary-tooltip';
      layer.setAttribute('role', 'tooltip');
      layer.tabIndex = 0;
      doc.body.appendChild(layer);
    }
    const title = doc.createElement('strong');
    title.className = 'game-glossary-tooltip-title';
    title.textContent = entry.name;
    const meta = doc.createElement('div');
    meta.className = 'game-glossary-tooltip-meta';
    meta.textContent = `类别：${entry.category} · 属性：${entry.attribute || '无'}`;
    const body = doc.createElement('div');
    body.className = 'game-glossary-tooltip-body';
    body.textContent = entry.description;
    layer.replaceChildren(title, meta, body);
    layer.hidden = false;
    // Above pet/move details (200/300) and team picker (9999), below edit/confirm (99999).
    let z = 10001;
    for (let el = anchor; el && el !== doc.body; el = el.parentElement) {
      const parentZ = parseInt(global.getComputedStyle(el).zIndex, 10);
      if (Number.isFinite(parentZ)) z = Math.max(z, parentZ + 1);
    }
    layer.style.zIndex = String(Math.min(99998, z));
    const ids = new Set((anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    ids.add(layer.id);
    anchor.setAttribute('aria-describedby', [...ids].join(' '));
    ui.positionAnchoredLayer(anchor, layer);
    closeLayer = ui.bindAnchoredLayer(anchor, layer, () => { closeLayer = null; close(); });
  }

  function install() {
    if (installed) return;
    if (!doc?.body || !common()?.bindAnchoredLayer || !common()?.positionAnchoredLayer) {
      throw new Error('GameGlossary.init 需要 document.body 和 CommonUI 锚定浮层接口');
    }
    installed = true;
    const listen = (type, fn, capture = false) => {
      doc.addEventListener(type, fn, capture);
      listeners.push(() => doc.removeEventListener(type, fn, capture));
    };
    listen('pointerover', event => {
      if (inLayer(event.target)) { clearHide(); return; }
      const term = termOf(event.target);
      if (term) show(term);
    });
    listen('pointerout', event => {
      if (insideActive(event.target) && !insideActive(event.relatedTarget)) closeSoon();
    });
    listen('focusin', event => {
      if (inLayer(event.target)) { clearHide(); return; }
      const term = termOf(event.target);
      if (term) show(term); else close();
    });
    listen('focusout', event => {
      if (insideActive(event.target) && !insideActive(event.relatedTarget)) closeSoon();
    });
    // A term click must not open the parent skill detail or toggle a trait/card.
    listen('click', event => {
      const term = termOf(event.target);
      if (term) { event.stopPropagation(); show(term); }
    }, true);
    observer = new global.MutationObserver(records => {
      if (anchor && (!anchor.isConnected || !anchor.getClientRects().length ||
          doc.querySelector('.cui-popup-overlay'))) close();
      for (const record of records) {
        if (inLayer(record.target)) continue;
        if (record.type === 'childList') {
          const changed = [...record.addedNodes, ...record.removedNodes];
          // Ignore only our exact replacements; external edits still enqueue normally.
          if (changed.length && changed.every(node => ownNodes.has(node) || inLayer(node))) continue;
          record.addedNodes.forEach(node => queue(node));
        } else queue(record.target);
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    decorate(doc.body);
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const response = await global.fetch('data/game-descriptions.json');
      if (!response.ok) throw new Error(`游戏描述加载失败（${response.status}）`);
      matcher = createMatcher(await response.json());
      byId.clear();
      matcher.entries.forEach(entry => byId.set(entry.id, entry));
      install();
      return matcher.entries;
    })().catch(error => { initPromise = null; throw error; });
    return initPromise;
  }

  /** Optional application shutdown/test cleanup, NOT a per-page lifecycle method. */
  function destroy() {
    close();
    observer?.disconnect(); observer = null;
    listeners.splice(0).forEach(dispose => dispose());
    if (frame != null) global.cancelAnimationFrame(frame);
    frame = null; pending.clear();
    layer?.remove(); layer = null;
    installed = false; initPromise = null;
    // Existing spans are inert until the next init; never rewrite caller-owned data.
  }
  return Object.freeze({ init, decorate, close, destroy, getEntries: () => matcher.entries,
    tokenize: value => matcher.tokenize(value), createMatcher, normalizeEntries,
    categories: CATEGORIES, descriptionSelectors: DESCRIPTION_SELECTORS });
});
