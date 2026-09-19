const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const glossary = require('../js/game-glossary.js');
const pageAPI = require('../js/pages/game-description.js');
const entries = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/game-descriptions.json'), 'utf8'));
const entry = (name, description = '原文 <img src=x onerror=alert(1)> & "说明"') => ({ name, description, category: '状态' });

test('54 unique entries, six categories, clean scrape metadata, immutable copies', () => {
  const snapshot = JSON.stringify(entries);
  const result = glossary.normalizeEntries(entries);
  assert.equal(result.length, 54);
  assert.equal(new Set(result.map(e => e.name)).size, 54);
  assert.deepEqual(glossary.categories.map(c => result.filter(e => e.category === c).length), [14, 15, 11, 7, 4, 3]);
  for (const row of result) {
    assert.ok(Object.isFrozen(row));
    assert.doesNotMatch(row.description, /查看关联内容|\d+\s*(特性|技能)/);
    assert.ok(row.attribute == null || row.attribute.endsWith('系'));
  }
  assert.ok(Object.isFrozen(result));
  assert.equal(JSON.stringify(entries), snapshot);
});

test('every description equals the original final line, without touching the input file', t => {
  const source = 'D:/echoagent/old/描述/Text Document.txt';
  if (!fs.existsSync(source)) return t.skip('Source is local-only; portable checks still verify the committed 54 entries');
  const text = fs.readFileSync(source, 'utf8');
  const blocks = text.replace(/^\uFEFF/, '').split('查看关联内容')
    .map(block => block.split(/\r?\n/).filter(line => line.trim())).filter(lines => lines.length);
  assert.equal(blocks.length, 54);
  blocks.forEach((lines, index) => {
    assert.equal(entries[index].name, lines.at(-2));
    assert.equal(entries[index].description, lines.at(-1));
    const header = lines.slice(0, -2);
    assert.equal(entries[index].category, header.find(line => glossary.categories.includes(line)));
    assert.equal(entries[index].attribute, header.find(line => /^[\u4e00-\u9fff]+系$/.test(line)) || null);
  });
  assert.equal(fs.readFileSync(source, 'utf8'), text);
});

test('longest literal match wins, including 中毒效果/中毒印记 before 中毒/印记', () => {
  const matcher = glossary.createMatcher(entries);
  const text = '中毒印记、中毒效果、中毒与印记，紧急脱离后离场';
  const parts = matcher.tokenize(text);
  assert.deepEqual(parts.filter(p => p.entry).map(p => p.text), ['中毒印记', '中毒效果', '中毒', '印记', '紧急脱离', '离场']);
  assert.equal(parts.map(p => p.text).join(''), text);
  assert.deepEqual(matcher.tokenize(text), parts, 'matching has no lastIndex state');
});

test('duplicates coalesce; conflicting rows/IDs and malformed data fail loudly', () => {
  assert.equal(glossary.createMatcher([entry('中毒'), entry('中毒')]).entries.length, 1);
  assert.throws(() => glossary.normalizeEntries([entry('中毒'), entry('中毒', '不同正文')]), /冲突/);
  assert.throws(() => glossary.normalizeEntries([{ ...entry('甲'), id: 'same' }, { ...entry('乙'), id: 'same' }]), /ID/);
  for (const value of [null, {}, [null], [{ name: 'a' }], [entry('')]]) assert.throws(() => glossary.normalizeEntries(value));
});

test('regex metacharacters, HTML-like text, ampersands and Unicode remain literal', () => {
  const matcher = glossary.createMatcher([entry('a+b?'), entry('<img>'), entry('🌙')]);
  const text = '<script>alert("x")</script> a+b? <img> & 🌙';
  assert.equal(matcher.tokenize(text).map(p => p.text).join(''), text);
  assert.deepEqual(matcher.tokenize(text).filter(p => p.entry).map(p => p.text), ['a+b?', '<img>', '🌙']);
  assert.equal(matcher.tokenize('aaab').filter(p => p.entry).length, 0);
});

test('plain table search covers all four columns; no hidden category filter remains', () => {
  assert.equal(pageAPI.filterEntries(entries).length, 54);
  assert.equal(pageAPI.filterEntries(entries, '天气').length, 4);
  assert.equal(pageAPI.filterEntries(entries, '', '天气').length, 54);
  assert.equal(pageAPI.filterEntries(entries, '毒系').length, entries.filter(e => [e.attribute, e.description].some(v => v?.includes('毒系'))).length);
  assert.ok(pageAPI.filterEntries(entries, '  中毒印记  ').some(entry => entry.name === '中毒印记'));
  assert.equal(pageAPI.filterEntries(entries, '<img>').length, 0);
  assert.equal(pageAPI.filterEntries(entries, '不存在的词条').length, 0);
});

// Minimal deterministic DOM for unit tests, NOT a browser. Browser integration lives in .browser.js.
class Events {
  constructor() { this.events = new Map(); }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(fn); }
  removeEventListener(type, fn) { this.events.get(type)?.delete(fn); }
  emit(type, target, extras = {}) { for (const fn of [...(this.events.get(type) || [])]) fn({ type, target, stopPropagation() {}, ...extras }); }
  listenerCount() { return [...this.events.values()].reduce((n, s) => n + s.size, 0); }
}
class Node extends Events {
  constructor(doc, type = 1, tag = '') { super(); this.ownerDocument = doc; this.nodeType = type; this.tagName = tag.toLowerCase(); this.children = []; this.parentElement = null; this.className = ''; this.dataset = {}; this.attrs = {}; this.style = {}; this.scrollTop = 0; this.value = ''; this.hidden = false; }
  get isConnected() { return this === this.ownerDocument?.body || !!this.parentElement?.isConnected; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.children.map(n => n.textContent).join(''); }
  set textContent(value) { if (this.nodeType === 3) this.nodeValue = String(value); else this.replaceChildren(this.ownerDocument.createTextNode(String(value))); }
  appendChild(node) {
    if (node.nodeType === 11) { for (const child of [...node.children]) this.appendChild(child); return node; }
    node.remove(); this.children.push(node); node.parentElement = this;
    this.ownerDocument?.notify({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] }); return node;
  }
  append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
  replaceChildren(...nodes) { [...this.children].forEach(n => n.remove()); this.append(...nodes); }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null;
    this.ownerDocument.notify({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
  }
  replaceWith(fragment) {
    const parent = this.parentElement, index = parent.children.indexOf(this);
    const nodes = fragment.nodeType === 11 ? [...fragment.children] : [fragment];
    nodes.forEach(n => { n.remove(); n.parentElement = parent; });
    parent.children.splice(index, 1, ...nodes); this.parentElement = null;
    this.ownerDocument.notify({ type: 'childList', target: parent, addedNodes: nodes, removedNodes: [this] });
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  matches(selector) { return selector.split(',').some(s => {
    s = s.trim();
    if (s === '[contenteditable]:not([contenteditable="false"])') return this.attrs.contenteditable != null && this.attrs.contenteditable !== 'false';
    if (s.startsWith('.')) return this.className.split(/\s+/).includes(s.slice(1));
    if (s.startsWith('#')) return this.id === s.slice(1);
    if (s.startsWith('[')) { const m = s.match(/^\[([^=]+)="([^"]*)"\]$/); return !!m && this.attrs[m[1]] === m[2]; }
    return this.tagName === s;
  }); }
  closest(selector) { return this.nodeType === 1 && this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.nodeType === 1 && child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() { for (let n = this; n; n = n.parentElement) if (n.hidden) return []; return this.isConnected ? [{}] : []; }
}
function runtime(rows = entries) {
  const doc = new Events(); doc.records = []; doc.observer = null; doc.activeElement = null;
  doc.notify = record => { if (doc.observer && record.target.isConnected) doc.records.push(record); };
  doc.createElement = tag => new Node(doc, 1, tag);
  doc.createTextNode = text => { const n = new Node(doc, 3); n.nodeValue = text; return n; };
  doc.createDocumentFragment = () => new Node(doc, 11);
  doc.body = doc.createElement('body');
  doc.querySelector = selector => doc.body.querySelector(selector);
  doc.createTreeWalker = root => {
    const all = []; const visit = node => { if (node.nodeType === 3) all.push(node); else node.children.forEach(visit); }; visit(root);
    let i = 0; return { nextNode() { this.currentNode = all[i++]; return !!this.currentNode; } };
  };
  const global = new Events(), frames = new Map(), cleanups = new Map();
  let nextFrame = 0, fetchCount = 0, bindCount = 0, activeBindings = 0;
  Object.assign(global, { document: doc, setTimeout, clearTimeout, getComputedStyle: el => ({ zIndex: el.style.zIndex || 'auto' }),
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame(id) { frames.delete(id); },
    fetch: async () => { fetchCount++; return { ok: true, json: async () => rows }; },
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() { doc.observer = this; } disconnect() { doc.observer = null; doc.records = []; } },
    CommonUI: {
      positionAnchoredLayer() {},
      bindAnchoredLayer(anchor, layer, callback) { bindCount++; activeBindings++; let active = true; return () => { if (active) { active = false; activeBindings--; callback(); } }; },
      registerCleanup(owner, fn) { cleanups.set(owner, fn); return () => cleanups.delete(owner); }
    }
  });
  const context = vm.createContext({ window: global, console, setTimeout, clearTimeout });
  for (const file of ['js/data.js', 'js/game-glossary.js', 'js/pages/game-description.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context);
  function flush() {
    let turns = 0;
    while (doc.records.length || frames.size) {
      assert.ok(++turns < 20, 'MutationObserver must settle rather than self-trigger');
      if (doc.records.length) { const records = doc.records.splice(0); doc.observer?.fn(records); }
      const tasks = [...frames.values()]; frames.clear(); tasks.forEach(fn => fn());
    }
    return turns;
  }
  function node(tag, cls, text, parent = doc.body) { const el = doc.createElement(tag); el.className = cls; if (text != null) el.textContent = text; parent.appendChild(el); return el; }
  return { doc, global, api: global.GameGlossary, page: global.GameDescriptionPage, flush, node, cleanups,
    stats: () => ({ fetchCount, bindCount, activeBindings, listeners: doc.listenerCount() }) };
}

test('DOM decoration is safe/idempotent and excludes headings, inputs, names and nested tooltips', async () => {
  const r = runtime(); await r.api.init();
  const text = '<img src=x onerror=alert(1)> 中毒印记 & 中毒';
  const desc = r.node('div', 'detail-skill-desc', text);
  const input = r.node('textarea', 'detail-skill-desc', '中毒'); input.value = '中毒';
  const name = r.node('span', 'detail-skill-name', '中毒');
  const heading = r.node('th', 'detail-skill-desc', '中毒');
  const editor = r.node('div', 'detail-trait-desc', '中毒'); editor.setAttribute('contenteditable', 'true');
  const tooltip = r.node('div', 'game-glossary-tooltip'); r.node('div', 'detail-skill-desc', '中毒', tooltip);
  const termCount = r.api.decorate(r.doc.body);
  assert.equal(termCount, 2);
  assert.equal(desc.textContent, text);
  assert.equal(desc.querySelectorAll('img').length, 0);
  assert.equal(desc.querySelectorAll('.game-glossary-term')[0].textContent, '中毒印记');
  for (const excluded of [input, name, heading, editor, tooltip]) assert.equal(excluded.querySelectorAll('.game-glossary-term').length, 0);
  assert.equal(input.value, '中毒');
  assert.equal(r.api.decorate(r.doc.body), 0);
  r.flush(); assert.equal(desc.querySelectorAll('.game-glossary-term').length, 2);
  r.api.destroy();
});

test('one init/fetch/lifecycle, batched dynamic rendering, all six selectors, no listener growth', async () => {
  const r = runtime(); const a = r.api.init(), b = r.api.init(); assert.equal(a, b); await a;
  const baseline = r.stats().listeners;
  const host = r.node('div', 'host');
  for (let i = 0; i < 12; i++) {
    host.replaceChildren();
    for (const selector of r.api.descriptionSelectors) r.node('div', selector.slice(1), '中毒印记与中毒', host);
    r.flush();
    assert.equal(host.querySelectorAll('.game-glossary-term').length, 12);
    assert.equal(r.stats().listeners, baseline);
    await r.api.init();
  }
  assert.equal(r.stats().fetchCount, 1);
  const description = host.querySelector('.detail-skill-desc');
  description.textContent = '灼烧'; r.flush();
  assert.equal(description.querySelector('.game-glossary-term').textContent, '灼烧');
  r.api.destroy(); assert.equal(r.stats().listeners, 0);
});

test('shared tooltip uses plain text, reuses its node, pairs cleanup and closes on anchor removal', async () => {
  const r = runtime([entry('中毒'), entry('灼烧')]); await r.api.init();
  const desc = r.node('div', 'detail-skill-desc', '中毒灼烧'); r.flush();
  const terms = desc.querySelectorAll('.game-glossary-term');
  r.doc.emit('focusin', terms[0]);
  const layer = r.doc.querySelector('.game-glossary-tooltip');
  assert.ok(layer.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(layer.querySelectorAll('img').length, 0);
  assert.equal(terms[0].getAttribute('aria-describedby'), layer.id);
  r.doc.emit('pointerover', terms[0]); assert.equal(r.stats().bindCount, 1);
  r.doc.emit('focusin', terms[1]); assert.equal(r.stats().activeBindings, 1);
  assert.equal(terms[0].getAttribute('aria-describedby'), null);
  assert.equal(r.doc.querySelector('.game-glossary-tooltip'), layer);
  desc.remove(); r.flush();
  assert.equal(layer.hidden, true); assert.equal(r.stats().activeBindings, 0);
  assert.equal(terms[1].getAttribute('aria-describedby'), null);
  r.api.destroy();
});

test('rendered table preserves all 54 four-column rows, plain search and local listener cleanup', async () => {
  const r = runtime(); await r.api.init(); const container = r.node('main', 'page');
  const baseline = r.stats().listeners;
  for (let i = 0; i < 4; i++) { r.page.render(container); r.flush(); assert.equal(r.cleanups.size, 1); }
  assert.equal(container.querySelectorAll('.game-description-entry').length, 54);
  assert.equal(container.querySelectorAll('button').length, 0);
  assert.equal(container.querySelectorAll('select').length, 0);
  assert.equal(container.querySelectorAll('label').length, 0);
  assert.deepEqual(container.querySelector('thead').querySelectorAll('th').map(th => th.textContent), ['名称','类别','属性','效果']);
  container.querySelectorAll('.game-description-entry').forEach((row, index) => {
    assert.equal(row.tagName, 'tr');
    assert.deepEqual(row.children.map(cell => cell.textContent), [entries[index].name, entries[index].category, '', entries[index].description]);
    assert.equal(row.children[2].getAttribute('aria-label'), entries[index].attribute || '无属性');
    const image = row.children[2].querySelector('img');
    assert.ok(image.getAttribute('src').startsWith('assets/icons/type/'));
    if (entries[index].attribute == null) assert.equal(image.getAttribute('src'), 'assets/icons/type/normal.png');
  });
  const search = container.querySelector('input');
  assert.equal(search.type, 'text'); assert.ok(search.className.split(' ').includes('search-bar'));
  search.value = '天气'; search.emit('input', search);
  assert.equal(container.querySelectorAll('.game-description-entry').length, 4);
  search.value = '水系'; search.emit('input', search);
  assert.equal(container.querySelectorAll('.game-description-entry').length, 2, 'search spans categories rather than retaining a category filter');
  search.value = '雨天'; search.emit('input', search);
  assert.equal(container.querySelector('.game-description-name').textContent, '雨天');
  search.value = '<img>'; search.emit('input', search);
  assert.equal(container.querySelectorAll('.game-description-entry').length, 0);
  assert.equal(container.querySelector('.game-description-empty').colSpan, 4);
  search.value = ''; search.emit('input', search);
  search.emit('compositionstart', search); search.value = '雨天'; search.emit('input', search, {isComposing:true});
  assert.equal(container.querySelectorAll('.game-description-entry').length, 54);
  search.emit('compositionend', search);
  assert.equal(container.querySelectorAll('.game-description-entry').length, 1);
  r.page.onLeave(); assert.equal(r.cleanups.size, 0); assert.equal(search.listenerCount(), 0);
  assert.equal(r.stats().listeners, baseline); r.api.destroy();
});

test('table uses literal text, preserves query/scroll, and disposes composition listeners', async () => {
  const r = runtime([entry('<name>', '<img src=x onerror=alert(1)> & 原文')]); await r.api.init();
  const host = r.node('main'); r.page.render(host);
  assert.equal(host.querySelector('.game-description-body').querySelectorAll('img').length, 0);
  assert.equal(host.querySelectorAll('img').length, 1, 'only the intended attribute icon exists');
  assert.equal(host.querySelector('.game-description-body').textContent, '<img src=x onerror=alert(1)> & 原文');
  const input = host.querySelector('input'), list = host.querySelector('.game-description-list');
  input.value = '<name>'; input.emit('input', input); list.scrollTop = 120; list.scrollLeft = 30;
  r.page.onLeave(); assert.equal(input.listenerCount(), 0);
  r.page.render(host);
  assert.equal(host.querySelector('input').value, '<name>');
  assert.equal(host.querySelector('.game-description-list').scrollTop, 120);
  assert.equal(host.querySelector('.game-description-list').scrollLeft, 30);
  r.page.onLeave(); r.api.destroy();
});

test('description page reuses search/table classes without retaining card or category-filter CSS', () => {
  const code = fs.readFileSync(path.join(ROOT, 'js/pages/game-description.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'css/game-glossary.css'), 'utf8');
  assert.match(code, /search-bar game-description-search/); assert.match(code, /data-table game-description-table/);
  assert.doesNotMatch(code, /state\.category|onCategory|game-description-heading|make\('select'/);
  assert.doesNotMatch(css, /game-description-meta|game-description-heading|game-description-control\b|game-description-entry\s*\{/);
  assert.equal(css.match(/\.game-description-search\s*\{([^}]+)\}/)[1].trim(), 'width: 100%;');
});

test('attribute icons reuse real data mapping without changing semantic None or accepting arbitrary URLs', () => {
  const context = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/data.js'), 'utf8'), context);
  const data = vm.runInContext('RKData', context);
  for (const row of entries) {
    const before=JSON.stringify(row), icon=pageAPI.attributeIcon(row.attribute,data);
    assert.ok(fs.existsSync(path.join(ROOT, icon.src)));
    assert.equal(icon.label,row.attribute || '无属性');
    assert.equal(JSON.stringify(row),before);
  }
  assert.equal(pageAPI.attributeIcon(null,data).src,'assets/icons/type/normal.png');
  assert.equal(pageAPI.attributeIcon('草系',data).src,'assets/icons/type/grass.png');
  assert.equal(pageAPI.attributeIcon('机械系',data).src,'assets/icons/type/mechanical.png');
  assert.equal(pageAPI.attributeIcon('../../api/user-config',data).src,'assets/icons/type/normal.png');
});

test('failed load rejects and can retry without a partial global lifecycle', async () => {
  const r = runtime(); r.global.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(r.api.init(), /503/); assert.equal(r.stats().listeners, 0);
  r.global.fetch = async () => ({ ok: true, json: async () => entries });
  await r.api.init(); assert.equal(r.api.getEntries().length, 54); r.api.destroy();
});
