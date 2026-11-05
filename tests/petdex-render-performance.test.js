const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const source = file => require('./catalog-read-fixture.cjs').readResource(root, file);

// Deliberately small deterministic table DOM, not a substitute for the browser
// suite. Uses actual current RKData / ListingUI / PetDexPage source and fixtures.
class Element {
  constructor(doc, tag) { this.doc = doc; this.tagName = tag; this.nodeType = tag === 'fragment' ? 11 : 1; this.children = []; this.dataset = {}; this.className = ''; this.events = new Map(); this.parentElement = null; this._html = ''; this._text = ''; }
  get isConnected() { return this === this.doc.body || !!this.parentElement?.isConnected; }
  get childNodes() { return this.children; }
  get cells() { return this.children; }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() { const siblings = this.parentElement?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
  get textContent() { return this.children.length ? this.children.map(n => n.textContent).join('') : this._text; }
  set textContent(value) { this.doc.metrics.textWrites++; this.children.forEach(n => n.parentElement = null); this.children = []; this._text = String(value); }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this.doc.metrics.htmlWrites++; this._html = value;
    this.children.forEach(n => n.parentElement = null); this.children = [];
    if (this.tagName === 'tbody') throw Error('wholesale tbody rewrite');
    if (this.tagName === 'tr') {
      this.doc.metrics.rowBuilds++;
      for (const match of value.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)) { const cell = this.doc.createElement('td'); this.appendChild(cell); cell.innerHTML = match[1]; }
    } else if (this.tagName === 'td' && /^<span class="stat-/.test(value)) {
      const span = this.doc.createElement('span'); span.textContent = value.replace(/<[^>]*>/g, ''); this.appendChild(span);
    }
  }
  remove() { if (!this.parentElement) return; const list = this.parentElement.children; list.splice(list.indexOf(this), 1); this.parentElement = null; }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, cursor) {
    if (this.tagName === 'tbody') this.doc.metrics.insertions++;
    const nodes = node.nodeType === 11 ? [...node.children] : [node];
    for (const n of nodes) { n.remove(); const index = cursor ? this.children.indexOf(cursor) : this.children.length; assert.ok(index >= 0); this.children.splice(index, 0, n); n.parentElement = this; }
    return node;
  }
  contains(node) { return this === node || this.children.some(n => n.contains(node)); }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(fn); }
  removeEventListener(type, fn) { this.events.get(type)?.delete(fn); }
}

async function runtime(mutateData) {
  const metrics = { rowBuilds: 0, htmlWrites: 0, textWrites: 0, insertions: 0 };
  const doc = { metrics, activeElement: null, createElement(tag) { return new Element(doc, tag); }, createDocumentFragment() { return new Element(doc, 'fragment'); } };
  doc.body = doc.createElement('body'); const tbody = doc.createElement('tbody'), header = doc.createElement('th'); doc.body.appendChild(tbody);
  doc.querySelector = () => header;
  const cleanups = new Map();
  const prefs = { enabled: false, policy: { mode: 'include', threshold: 80 }, getTrickRoom() { return this.enabled; }, getEffectiveSpeedPolicy() { return this.policy; } };
  const context = vm.createContext({ document: doc, window: { AppPreferences: prefs }, console: {log(){},error(){}},
    CommonUI: { registerCleanup(owner, fn) { cleanups.set(owner, fn); return () => cleanups.delete(owner); } },
    fetch: async file => ({ ok: true, json: async () => JSON.parse(source(file)) }) });
  for (const file of ['js/battle-math.js', 'js/monster-identity.js', 'js/data.js', 'js/listing-ui.js', 'js/petdex-family.js']) vm.runInContext(source(file), context);
  const data = vm.runInContext('RKData', context); await data.init();
  if (mutateData) mutateData(data);
  // Instrument the test's private closure only; no production debug API.
  vm.runInContext(source('js/pages/petdex.js').replace('return { render, toggleTrait, toggleForm, showPetDetail };',
    'return { render, toggleTrait, toggleForm, showPetDetail, mountTable, renderTable, state, getFilteredMonsters, expandedForms, cache: () => tableView?.rows };'), context);
  const dex = vm.runInContext('PetDexPage', context); dex.mountTable(tbody);
  return { doc, tbody, header, prefs, metrics, cleanups, data, dex };
}
const ids = tbody => tbody.children.map(row => Number(row.dataset.id));

test('full-catalogue toggles retain row identity, build only missing IDs and keep one delegated listener', async t => {
  const r = await runtime(); const beforeData = JSON.stringify(r.data.getMonsters());
  r.dex.renderTable(); const initialForms = [...r.dex.state.activeForms];
  const initial = ids(r.tbody), originals = new Map(r.tbody.children.map(row => [row.dataset.id, row]));
  const coldStart = performance.now(); r.dex.state.activeForms.clear(); r.dex.renderTable(); const coldMs = performance.now() - coldStart;
  const all = ids(r.tbody), rows = new Map(r.tbody.children.map(row => [row.dataset.id, row]));
  assert.ok(all.length > initial.length); assert.equal(new Set(all).size, all.length);
  for (const [id, row] of originals) assert.equal(rows.get(id), row);
  assert.equal(r.metrics.rowBuilds, all.length);
  const built = {...r.metrics}, samples = [];
  for (let round = 0; round < 12; round++) {
    for (const form of initialForms) r.dex.state.activeForms.add(form);
    r.dex.renderTable(); assert.deepEqual(ids(r.tbody), initial);
    const start = performance.now(); r.dex.state.activeForms.clear(); r.dex.renderTable(); samples.push(performance.now() - start);
    assert.deepEqual(ids(r.tbody), all);
    r.tbody.children.forEach(row => { assert.equal(row, rows.get(row.dataset.id)); assert.equal(row.events.size, 0); });
    assert.equal(r.dex.cache().size, all.length);
  }
  assert.equal(r.metrics.rowBuilds, built.rowBuilds); assert.equal(r.metrics.htmlWrites, built.htmlWrites); assert.equal(r.metrics.textWrites, built.textWrites);
  assert.equal(r.tbody.events.get('click').size, 1); assert.equal(JSON.stringify(r.data.getMonsters()), beforeData);
  t.diagnostic(JSON.stringify({ fixture: 'Node deterministic DOM; not browser timing', highRows: initial.length, allRows: all.length, coldMs, warmMs: samples, builtRows: r.metrics.rowBuilds }));
});

test('sort/rank, live effective policy and 200-Q projection change only required cells', async () => {
  const r = await runtime(); r.dex.renderTable(); r.dex.state.activeForms.clear(); r.dex.renderTable();
  const originals = new Map(r.tbody.children.map(row => [row.dataset.id, row]));
  const html = r.metrics.htmlWrites;
  r.dex.state.sortKey = 'base_spd'; r.dex.state.sortAsc = false; r.prefs.enabled = true; r.dex.renderTable();
  assert.equal(r.header.textContent, '速度（梦境）');
  let previous = Infinity;
  r.tbody.children.forEach((row, index) => {
    assert.equal(row, originals.get(row.dataset.id)); assert.equal(row.cells[0].textContent, String(index + 1));
    const raw = r.data.getMonsterById(Number(row.dataset.id)); const speed = Number(row.cells[9].textContent);
    assert.equal(speed, 200 - raw.base_spd); assert.ok(speed <= previous); previous = speed;
  });
  for (const mode of ['exclude', 'threshold', 'include']) {
    r.prefs.policy = { mode, threshold: 80 }; r.dex.state.sortKey = 'effective'; r.dex.renderTable();
    r.tbody.children.forEach(row => {
      const m = r.data.getMonsterById(Number(row.dataset.id));
      assert.equal(Number(row.cells[11].textContent), r.data.getEffectiveStats({...m, base_spd: 200 - m.base_spd}));
    });
  }
  assert.equal(r.metrics.htmlWrites, html, 'no image/trait/type HTML rewrites for numeric state');
});

test('in-place source edits, filter return, trait/form expansion and cleanup invalidate narrowly', async () => {
  const r = await runtime(); r.dex.state.activeForms.clear(); r.dex.renderTable();
  const monsters = r.data.getMonsters(), m = monsters.find(m => !m.hidden && m.trait && r.dex.cache().has(String(m.id)) && ![129,469].includes(m.id));
  const entry = r.dex.cache().get(String(m.id)), row = entry.row, before = r.metrics.htmlWrites;
  m.trait.localized.zh.description += ' 中毒印记'; r.dex.renderTable();
  assert.equal(r.metrics.htmlWrites, before + 1); assert.equal(r.dex.cache().get(String(m.id)).row, row);
  const again = r.metrics.htmlWrites; m.base_hp++; r.dex.renderTable(); assert.equal(r.metrics.htmlWrites, again);
  const multi = monsters.find(m => !m.hidden && m.form_category === '主形态' && r.dex.cache().get(String(m.id))?.cells[1].innerHTML.includes('data-petdex-action="form"'));
  assert.ok(multi); const baseRow = r.dex.cache().get(String(multi.id)).row;
  r.dex.toggleForm(multi.id); assert.equal(r.dex.cache().get(String(multi.id)).row, baseRow); assert.ok(r.dex.expandedForms.has(multi.id));
  const special = r.dex.cache().get('129'); assert.ok(special);
  const traitBefore = special.cells[3].innerHTML; r.dex.toggleTrait(129); assert.notEqual(special.cells[3].innerHTML, traitBefore);
  r.dex.state.keyword = '不存在的名称'; r.dex.renderTable(); assert.equal(r.tbody.children.length, 0);
  r.dex.state.keyword = ''; r.dex.renderTable(); assert.equal(r.dex.cache().get(String(m.id)).row, row);
  m.hidden = true; r.dex.renderTable(); assert.equal(r.dex.cache().has(String(m.id)), false);
  assert.ok(r.dex.cache().size <= monsters.filter(m => !m.hidden).length);
  const oldCache = r.dex.cache(); r.cleanups.get(r.tbody)();
  assert.equal(oldCache.size, 0); assert.equal(r.dex.cache(), undefined); assert.equal(r.cleanups.size, 0); assert.equal(r.tbody.events.get('click').size, 0);
  r.dex.mountTable(r.tbody); r.dex.renderTable(); assert.notEqual(r.dex.cache(), oldCache); assert.equal(r.cleanups.size, 1);
});

test('delegated form and trait fold actions retain arrow glyphs, cached rows and unrelated cells', async () => {
  const r = await runtime(); r.dex.state.activeForms.clear(); r.dex.renderTable();
  const form = [...r.dex.cache().values()].find(entry => entry.cells[1].innerHTML.includes('class="form-toggle-arrow"'));
  assert.ok(form);
  const traitEntries = [129, 469].map(id => r.dex.cache().get(String(id)));
  const formGlyph = () => form.cells[1].innerHTML.match(/class="form-toggle-arrow"[^>]*>([▶▼])<\/span>/)?.[1];
  const traitGlyph = entry => entry.cells[3].innerHTML.match(/class="trait-arrow">([▶▼])<\/span>/)?.[1];
  // Dispatch the existing delegated listener with a deterministic closest() double;
  // this checks event routing, not native browser pointer geometry/paint order.
  const click = (entry, action) => {
    const target = { dataset: { petdexAction: action }, closest(selector) {
      if (selector === '[data-petdex-action], tr[data-id]') return target;
      if (selector === 'tr[data-id]') return entry.row;
      assert.equal(selector, '.game-glossary-term'); return null;
    } };
    for (const listener of r.tbody.events.get('click')) listener({ target });
  };
  assert.equal(formGlyph(), '▶');
  traitEntries.forEach(entry => assert.equal(traitGlyph(entry), '▶'));
  click(form, 'form'); assert.equal(formGlyph(), '▼');
  const builtRows = r.metrics.rowBuilds, originals = new Map(r.tbody.children.map(row => [row.dataset.id, row]));
  for (let round = 0; round < 3; round++) {
    click(form, 'form'); assert.equal(formGlyph(), '▶');
    click(form, 'form'); assert.equal(formGlyph(), '▼');
    for (const entry of traitEntries) {
      const nameBefore = entry.cells[1].innerHTML, before = r.metrics.htmlWrites;
      click(entry, 'trait'); assert.equal(traitGlyph(entry), '▼');
      click(entry, 'trait'); assert.equal(traitGlyph(entry), '▶');
      assert.equal(r.metrics.htmlWrites, before + 2, 'only the two trait-cell updates');
      assert.equal(entry.cells[1].innerHTML, nameBefore);
    }
    r.dex.state.keyword = '不存在的名称'; r.dex.renderTable(); assert.equal(r.tbody.children.length, 0);
    r.dex.state.keyword = ''; r.dex.state.sortKey = 'base_spd'; r.dex.state.sortAsc = !r.dex.state.sortAsc; r.dex.renderTable();
    assert.equal(formGlyph(), '▼');
    r.tbody.children.forEach(row => assert.equal(row, originals.get(row.dataset.id)));
  }
  assert.equal(r.metrics.rowBuilds, builtRows);
  assert.equal(r.tbody.events.get('click').size, 1);
  assert.ok(r.tbody.children.every(row => row.events.size === 0));
});

test('unknown official stage is independently visible, never silently high or leader', async () => {
  const id = 99001;
  const r = await runtime(data => {
    const pet = structuredClone(data.getMonsters()[0]);
    Object.assign(pet, { id, evolution_stage: '未确认', is_leader_form: false, hidden: false, form: 'default', form_category: '无多形态' });
    pet.localized.zh.name = '阶段未确认测试精灵';
    data.getMonsters().push(pet);
  });
  r.dex.renderTable();
  assert.ok(r.dex.state.activeForms.has('pending'));
  assert.ok(ids(r.tbody).includes(id), 'new unknown-stage entries are visible in the initial view');
  const row = r.dex.cache().get(String(id)).row;
  assert.match(row.cells[1].innerHTML, /class="pet-stage-pending"/);
  r.dex.state.activeForms.clear(); r.dex.state.activeForms.add('high'); r.dex.renderTable();
  assert.ok(!ids(r.tbody).includes(id), 'unknown must not match the high-only filter');
  r.dex.state.activeForms.clear(); r.dex.state.activeForms.add('leader'); r.dex.renderTable();
  assert.ok(!ids(r.tbody).includes(id), 'unknown must not match the leader-only filter');
  r.dex.state.activeForms.add('pending'); r.dex.renderTable();
  assert.equal(r.dex.cache().get(String(id)).row, row);
  r.data.getMonsters().find(pet => pet.id === id).evolution_stage = '高级形态';
  r.dex.state.activeForms.clear(); r.dex.state.activeForms.add('high'); r.dex.renderTable();
  assert.ok(ids(r.tbody).includes(id));
  assert.doesNotMatch(row.cells[1].innerHTML, /class="pet-stage-pending"/);
  assert.match(source('js/pages/updatedata.js'), /m\.evolution_stage === '未确认'.*editorStages\.push\('未确认'\)/);
});

test('petdex historical-name filtering resolves only its original form ID', async () => {
  const r = await runtime();
  r.dex.state.activeForms.clear();
  r.dex.state.keyword = '雪绒鸟（冬天的样子）';
  r.dex.renderTable();
  assert.deepEqual(ids(r.tbody), [40]);
  r.dex.state.keyword = '月使鸷纳';
  r.dex.renderTable();
  assert.deepEqual(ids(r.tbody), [604]);
  assert.equal(r.data.getMonsterById(604).localized.zh.name, '月使鹭纳');
});

test('岚鸟 and leader variants follow their explicit owner after sorting/filtering/repeated expansion', async () => {
  const r = await runtime(); r.dex.state.activeForms.clear(); r.dex.renderTable();
  const pairs = [[48, [50, 51, 52]], [49, [53, 54, 55]]];
  const ownerRows = new Map(pairs.map(([id]) => [id, r.dex.cache().get(String(id)).row]));
  for (const [id] of pairs) r.dex.toggleForm(id);
  const childRows = new Map(pairs.flatMap(([, children]) => children.map(id => [id, r.dex.cache().get(String(id)).row])));
  const assertGrouped = () => {
    const order = ids(r.tbody), filtered = Array.from(r.dex.getFilteredMonsters(), m => m.id);
    assert.equal(new Set(order).size, order.length);
    assert.deepEqual([...order].sort((a, b) => a - b), [...filtered].sort((a, b) => a - b));
    for (const [owner, children] of pairs) {
      const present = children.filter(id => filtered.includes(id));
      if (!order.includes(owner)) continue;
      const attached = order.slice(order.indexOf(owner) + 1, order.indexOf(owner) + 1 + present.length);
      assert.deepEqual([...attached].sort(), [...present].sort(), `owner ${owner}`);
    }
    for (const [id, row] of [...ownerRows, ...childRows]) assert.equal(r.dex.cache().get(String(id)).row, row);
  };
  for (const sortKey of ['dex_number', 'base_spd', 'effective']) for (const sortAsc of [true, false]) {
    Object.assign(r.dex.state, { sortKey, sortAsc }); r.dex.renderTable(); assertGrouped();
    if (sortKey !== 'dex_number') {
      const rank = new Map(Array.from(r.dex.getFilteredMonsters(), (m, i) => [m.id, String(i + 1)]));
      for (const row of r.tbody.children) assert.equal(row.cells[0].textContent, rank.get(Number(row.dataset.id)), 'rank retains sorted numeric position, not nested display position');
    }
    for (let i = 0; i < 3; i++) {
      r.dex.toggleForm(48); assert.ok(!ids(r.tbody).includes(50)); assert.ok(ids(r.tbody).includes(53));
      r.dex.toggleForm(48); assertGrouped();
    }
    r.dex.state.keyword = '岚鸟'; r.dex.renderTable(); assertGrouped(); assert.ok(!ids(r.tbody).includes(49));
    r.dex.state.keyword = '春天的样子'; r.dex.renderTable(); assertGrouped();
    assert.ok(ids(r.tbody).includes(50) && !ids(r.tbody).includes(48), 'matched variant remains visible when its owner is filtered out');
    r.dex.state.keyword = ''; r.dex.state.activeTypes.add('Flying'); r.dex.renderTable(); assertGrouped();
    r.dex.state.activeTypes.clear(); r.dex.state.activeForms.add('leader'); r.dex.renderTable(); assertGrouped();
    assert.ok(!ids(r.tbody).includes(48) && ids(r.tbody).includes(49));
    r.dex.state.activeForms.clear(); r.dex.renderTable(); assertGrouped();
  }
  assert.equal(r.tbody.events.get('click').size, 1);
  assert.ok(r.tbody.children.every(row => row.events.size === 0));
});

test('source keeps scoped cache, shared stat helpers, no per-row click code or persisted-key rename', () => {
  const code = source('js/pages/petdex.js');
  assert.doesNotMatch(code, /tbody\.innerHTML|tr\.addEventListener|onclick="event\.stopPropagation\(\);PetDexPage\.toggle/);
  assert.doesNotMatch(code, /速度（戏法）/); assert.match(code, /200 - \(Number\(monster\.base_spd\)/);
  assert.match(code, /CommonUI\.registerCleanup\(tbody/);
});
