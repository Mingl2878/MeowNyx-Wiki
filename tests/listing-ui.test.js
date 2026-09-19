const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

// Small deterministic DOM/event double. Uses the real CommonUI lifecycle and
// anchor functions; no browser, packages, build, or application data writes.
function runtime(storageThrows = false) {
  let document;
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type, props = {}) { if (type === 'pointerenter') this.hovered = true; if (type === 'pointerleave') this.hovered = false; for (const fn of [...(this.listeners.get(type) || [])]) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...props }); }
    count(type) { return this.listeners.get(type)?.size || 0; }
    total() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
  }
  class Element extends Target {
    constructor(tag = 'div') {
      super(); this.tagName = tag; this.children = []; this.parentNode = null; this.style = {}; this.dataset = {}; this.attributes = {}; this.hidden = false;
      this.className = ''; this.innerHTML = ''; this.textContent = ''; this.id = '';
      this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter(n => !names.includes(n)).join(' '); }, contains: name => this.className.split(' ').includes(name) };
    }
    get parentElement() { return this.parentNode; }
    get isConnected() { return this === document.body || !!this.parentNode?.isConnected; }
    appendChild(node) { node.remove(); node.parentNode = this; this.children.push(node); return node; }
    insertBefore(node, sibling) { node.remove(); node.parentNode = this; this.children.splice(this.children.indexOf(sibling), 0, node); }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    querySelector(selector) {
      const matches = node => selector.startsWith('#') ? node.id === selector.slice(1) : selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : selector.startsWith('[') ? (() => {
        const [, key, value] = selector.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/); return value === undefined ? node.getAttribute(key) !== null : node.getAttribute(key) === value;
      })() : false;
      for (const child of this.children) { if (matches(child)) return child; const found = child.querySelector(selector); if (found) return found; }
      return null;
    }
    matches(selector) { if (selector === ':hover') return !!this.hovered; return selector.startsWith('.') && this.classList.contains(selector.slice(1)); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { left: 20, right: 620, top: 100, bottom: 140, width: Number.parseFloat(this.style.width) || 600, height: 40 }; }
  }
  document = new Target(); document.body = new Element('body'); document.createElement = tag => new Element(tag);
  document.getElementById = id => document.body.querySelector('#' + id);
  const window = new Target(); window.innerWidth = 1200; window.innerHeight = 800; window.__getPageZoom = () => 1;
  const memory = new Map(), timers = new Map(); let timerId = 0, now = 0;
  const RKData = {
    getTotalStats: m => ['base_hp', 'base_phy_atk', 'base_mag_atk', 'base_phy_def', 'base_mag_def', 'base_spd'].reduce((s, k) => s + (m[k] || 0), 0),
    getEffectiveStats: m => 1000 + m.id, // Deliberately NOT the historical local formula.
    getMonsterName: m => m.name || '同名', getMonsterDisplayName: m => m.name || '同名', getMonsterDisplayNameHtml: m => m.name || '同名',
    typeBadgeHtml: type => `<span>${type}</span>`, getWikiData: () => null,
    getTypeShortZh: type => type,
    PILL_ORDER: ['Normal','Grass','Fire','Water','Light','Ground','Ice','Dragon','Electric','Poison','Bug','Fighting','Flying','Cute','Ghost','Dark','Mechanical','Illusion']
  };
  const context = vm.createContext({ console, window, document, RKData,
    getComputedStyle: el => ({ display: el.hidden ? 'none' : el.style.display || 'block', zIndex: el.style.zIndex || 'auto' }),
    localStorage: { getItem(key) { if (storageThrows) throw Error('blocked'); return memory.get(key); }, setItem(key, value) { if (storageThrows) throw Error('blocked'); memory.set(key, value); } },
    setTimeout(fn, delay) { timers.set(++timerId, { at: now + delay, fn }); return timerId; }, clearTimeout: id => timers.delete(id)
  });
  const common = source('js/common.js'); vm.runInContext(common.slice(common.indexOf('const CommonUI')), context);
  vm.runInContext(source('js/listing-ui.js'), context);
  const api = vm.runInContext('ListingUI', context), commonApi = vm.runInContext('CommonUI', context);
  const element = (id, parent = document.body) => { const node = new Element(); node.id = id; parent.appendChild(node); return node; };
  return { context, api, commonApi, element, document, window, memory, RKData, timers,
    mountFilters(panel, page) {
      const slotId = (page === 'petdex' ? 'petdex' : 'move') + '-search-slot';
      if (!panel.querySelector('#' + slotId)) element(slotId, panel);
      return api.mountFilters(panel, page);
    },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } } };
}
const ids = monsters => Array.from(monsters, m => m.id);
const rowIds = html => [...html.matchAll(/<tr data-monster-id="([^"]+)"/g)].map(m => Number(m[1]));

// Rendering + sorting contracts.
test('one immutable eight-column config supplies both pages, with exact learner table columns', () => {
  const { api } = runtime();
  assert.deepEqual(Array.from(api.STAT_COLUMNS, c => c.label), ['生命','物攻','魔攻','物防','魔防','速度','总种族','有效种族']);
  assert.ok(Object.isFrozen(api.STAT_COLUMNS) && Object.isFrozen(api.STAT_COLUMNS[0]));
  const html = api.monsterTable([{ id: 1, base_hp: 10 }]);
  assert.equal((html.match(/<th[ >]/g) || []).length, 10);
  assert.equal((html.match(/class="stat-col"/g) || []).length, 8);
  assert.ok(!html.includes('学习来源'));
  assert.match(api.statHeaders({}, { petdex: true }), /data-sort="effective"[^>]*>有效种族值/);
});

test('every numeric column starts descending, toggles ascending, and preserves input tie order', () => {
  const { api, RKData } = runtime(); RKData.getEffectiveStats = m => m.base_hp;
  for (const { key } of api.STAT_COLUMNS) {
    const field = ['total','effective'].includes(key) ? 'base_hp' : key;
    const input = [{ id: 3, [field]: 40 }, { id: 1, [field]: 40 }, { id: 2, [field]: 10 }];
    let sort = api.nextSort({ key: null, asc: false }, key);
    assert.equal(sort.asc, false); assert.deepEqual(ids(api.sortMonsters(input, key, sort.asc)), [3,1,2]);
    sort = api.nextSort(sort, key);
    assert.equal(sort.asc, true); assert.deepEqual(ids(api.sortMonsters(input, key, sort.asc)), [2,3,1]);
    assert.deepEqual(ids(input), [3,1,2]);
  }
});

test('effective values and ordering always call current RKData helper; totals remain independent', () => {
  const { api, RKData } = runtime(); const m = { id: 7, base_hp: 20, base_spd: 80 };
  assert.match(api.statCells(m), /stat-effective">1007</);
  assert.equal(api.statValue(m, 'total'), 100);
  RKData.getEffectiveStats = m => -m.id;
  assert.match(api.statCells(m), /stat-effective">-7</);
  assert.deepEqual(ids(api.sortMonsters([{ id: 7 }, { id: 2 }], 'effective')), [2,7]);
});

test('ID dedup merges numeric/string ID only, not display names or distinct forms', () => {
  const { api } = runtime();
  assert.deepEqual(ids(api.uniqueMonsters([{ id: 7 }, { id: '7' }, { id: 8 }, { id: 9 }])), [7,8,9]);
  assert.deepEqual(rowIds(api.monsterTable([{ id: 7 }, { id: 7 }, { id: 8 }])), [7,8]);
});

// Filter shell + actual CommonUI cleanup / anchor contract.
test('default expanded, independent persisted modes, and same input/filter DOM across switches', () => {
  const r = runtime(); const host = r.element('host'), panel = r.element('panel', host), slot = r.element('petdex-search-slot', panel), input = r.element('search', slot); input.value = 'a.*[';
  const ui = r.mountFilters(panel, 'petdex');
  assert.equal(ui.getMode(), 'expanded'); assert.equal(panel.hidden, false);
  ui.setMode('collapsed'); assert.equal(panel.hidden, true); assert.equal(ui.modes.parentNode, ui.bar);
  ui.setMode('floating'); ui.open(); assert.equal(panel.parentNode, r.document.body); assert.equal(panel.hidden, false);
  ui.close(); assert.equal(panel.parentNode, ui.shell); assert.equal(panel.hidden, true); assert.equal(input.value, 'a.*[');
  ui.setMode('expanded'); assert.equal(input.parentNode, slot); assert.equal(slot.parentNode, ui.bar); assert.equal(panel.style.position, '');
  ui.setMode('collapsed'); r.commonApi.destroyWithin(host); host.remove();
  const nextHost = r.element('next'), next = r.mountFilters(r.element('next-panel', nextHost), 'petdex');
  assert.equal(next.getMode(), 'collapsed');
  const other = r.mountFilters(r.element('other-panel', nextHost), 'moves'); assert.equal(other.getMode(), 'expanded');
});

test('storage denial still remembers each page mode in memory', () => {
  const r = runtime(true), host = r.element('host');
  r.mountFilters(r.element('p1', host), 'moves').setMode('floating');
  r.commonApi.destroyWithin(host);
  assert.equal(r.mountFilters(r.element('p2', host), 'moves').getMode(), 'floating');
  assert.equal(r.mountFilters(r.element('p3', host), 'petdex').getMode(), 'expanded');
});

test('hover union cancels closing, external leave closes at 80ms, native floating click works', () => {
  const r = runtime(), host = r.element('host'), ui = r.mountFilters(r.element('panel', host), 'moves');
  ui.setMode('floating'); const bar = ui.shell;
  bar.emit('pointerenter'); assert.equal(ui.panel.hidden, false);
  bar.emit('pointerleave', { relatedTarget: ui.panel }); r.advance(201); assert.equal(ui.panel.hidden, false);
  ui.panel.emit('pointerleave'); r.advance(79); assert.equal(ui.panel.hidden, false);
  bar.emit('pointerenter'); r.advance(10); assert.equal(ui.panel.hidden, false);
  bar.emit('focusin'); ui.trigger.emit('click'); assert.equal(ui.panel.hidden, false);
  bar.emit('pointerleave'); r.advance(80); assert.equal(ui.panel.hidden, true);
});

test('scroll/resize/zoom/font/Escape/outside clicks close without changing remembered mode', () => {
  const r = runtime(), ui = r.mountFilters(r.element('panel'), 'petdex'); ui.setMode('floating');
  for (const [target, event, props] of [[r.document,'scroll',{}],[r.window,'resize',{}],[r.window,'appzoomchange',{}],[r.window,'appfontchange',{}],[r.document,'keydown',{key:'Escape'}],[r.document,'pointerdown',{}]]) {
    ui.open(); assert.equal(ui.panel.hidden, false); target.emit(event, props);
    assert.equal(ui.panel.hidden, true, event); assert.equal(ui.getMode(), 'floating');
  }
  ui.open(); r.document.emit('scroll', { target: ui.panel }); assert.equal(ui.panel.hidden, false);
  r.window.__getPageZoom = () => 2; ui.close(); ui.open(); assert.equal(ui.panel.style.width, '300px');
});

test('repeated mount/open/destroy clears portal, timers, and all global widget listeners', () => {
  const r = runtime();
  for (let i = 0; i < 12; i++) {
    const host = r.element('host'), ui = r.mountFilters(r.element('panel', host), 'petdex');
    ui.setMode('floating'); ui.open(); ui.panel.emit('pointerleave');
    r.commonApi.destroyWithin(host); host.remove(); r.advance(1000);
    assert.equal(r.document.total(), 0); assert.equal(r.window.total(), 0); assert.equal(r.timers.size, 0);
    assert.equal(ui.panel.isConnected, false);
  }
});

test('style switch has exactly two adjacent buttons, supports keyboard and has no popup listeners', () => {
  const r = runtime(), host = r.element('style'); const changes = [];
  r.api.mountStyleSwitch(host, 'default', value => changes.push(value));
  assert.equal(host.getAttribute('role'), 'group');
  assert.deepEqual(host.children.map(c => c.textContent), ['默认','表格']);
  const [normal, table] = host.children;
  assert.equal(normal.getAttribute('aria-pressed'), 'true');
  table.emit('click'); assert.deepEqual(changes, ['table']);
  assert.equal(normal.getAttribute('aria-pressed'), 'false');
  assert.equal(table.getAttribute('aria-pressed'), 'true');
  table.emit('click'); assert.equal(changes.length, 1);
  table.focus(); host.emit('keydown', { key: 'ArrowLeft' });
  assert.equal(r.document.activeElement, normal); assert.deepEqual(changes, ['table', 'default']);
  host.emit('keydown', { key: 'End' }); assert.equal(r.document.activeElement, table);
  host.emit('keydown', { key: 'Home' }); assert.equal(r.document.activeElement, normal);
  assert.equal(r.document.total(), 0); assert.equal(r.window.total(), 0);
  r.commonApi.destroyWithin(host); assert.equal(host.total(), 0); assert.equal(table.total(), 0);
  const js = source('js/listing-ui.js'), css = source('css/listing-ui.css');
  for (const text of [js, css]) assert.doesNotMatch(text, /listing-style-menu|listing-style-trigger|menuitemradio|mountStyleMenu/);
});

test('statistics refresh fanout has one global listener, replacing subscriptions and pruning detached owners', () => {
  const r = runtime(), a = r.element('a'), b = r.element('b'); let first = 0, latest = 0, second = 0;
  r.api.onStatsChange(a, () => first++); r.api.onStatsChange(a, () => latest++); r.api.onStatsChange(b, () => second++);
  assert.equal(r.window.count('appstatspreferenceschange'), 1);
  r.window.emit('appstatspreferenceschange'); assert.deepEqual([first, latest, second], [0,1,1]);
  a.remove(); r.window.emit('appstatspreferenceschange'); assert.deepEqual([first, latest, second], [0,1,2]);
  r.commonApi.destroyWithin(b); assert.equal(r.window.count('appstatspreferenceschange'), 0);
});

function pageApi(r, name, exports) {
  const file = name === 'PetDexPage' ? 'petdex' : 'moves';
  const code = source(`js/pages/${file}.js`).replace(/return \{ render, ([^\n]+) \};\s*\}\)\(\);\s*$/, (_, members) => `return { render, ${members}, ${exports} };\n})();`);
  vm.runInContext(code, r.context); return vm.runInContext(name, r.context);
}
function learnerFixture(r) {
  const monsters = [{ id:1 },{ id:2, evolves_from_id:1 },{ id:3, name:'同名独立形态' },{ id:4 },{ id:5, is_leader_form:true },{ id:6 }];
  const skills = {
    1: [{ name:'测试',source:'默认' }],
    2: [{ name:'测试',source:'默认' },{ name:'测试',source:'技能石' },{ name:'交集',source:'血脉' }],
    3: [{ name:'测试',source:'传说' },{ name:'交集',source:'默认' }],
    4: [{ name:'测试',source:'默认' }],
    5: [{ name:'测试',source:'默认' }],
    6: [{ name:'别的技能',source:'默认' }]
  };
  r.RKData.getMonsters = () => monsters;
  r.RKData.resolveSkillSource = m => { const source = m.id === 4 ? monsters[1] : m; return { sourceMonster:source, wiki:{skills:skills[source.id]} }; };
  r.RKData.getResolvedWikiData = m => r.RKData.resolveSkillSource(m).wiki;
  r.RKData.getTypeShortZh = () => '';
  return monsters;
}

test('default learning groups retain legend, source resolution, leader/evolution policies; table alone ID-dedups', () => {
  const r = runtime(); learnerFixture(r);
  const page = pageApi(r, 'MovesPage', 'getMoveLearners');
  const groups = page.getMoveLearners('测试');
  assert.deepEqual(ids(groups.selfLearnDedup.map(i => i.monster)), [2]);
  assert.deepEqual(ids(groups.legendLearnDedup.map(i => i.monster)), [3]);
  assert.deepEqual(ids(groups.skillStoneDedup.map(i => i.monster)), [2]);
  const all = Object.values(groups).flat().map(i => i.monster);
  assert.deepEqual(ids(r.api.uniqueMonsters(all)), [2,3]);
  assert.equal(all.length, 3); // default source groups were not mutated by the table.
});

test('intersection keeps its existing resolved/form policy in both views and shares numeric sorting', () => {
  const r = runtime(); learnerFixture(r); const result = r.element('multi-skill-result');
  const page = pageApi(r, 'MovesPage', "updateMultiSkillResult, configure(style, sort) { detailStyle=style; learnerSort=sort; multiSkillSelected=['交集']; }");
  page.configure('table', { key:'effective', asc:false }); page.updateMultiSkillResult('测试');
  // Existing intersection includes inherited form 4, unlike single-skill source projection.
  assert.deepEqual(rowIds(result.innerHTML), [4,3,2]);
  page.configure('table', { key:'effective', asc:true }); page.updateMultiSkillResult('测试'); assert.deepEqual(rowIds(result.innerHTML), [2,3,4]);
  page.configure('default', { key:'effective', asc:false }); page.updateMultiSkillResult('测试');
  assert.ok(!result.innerHTML.includes('listing-monster-table'));
  assert.deepEqual([...result.innerHTML.matchAll(/showPetDetail\((\d+)\)/g)].map(m => Number(m[1])), [2,3,4]);
});

test('pet effective ranking retains separate advanced/leader pools and no basic/hidden rank', () => {
  const r = runtime(), monsters = [
    {id:1,evolution_stage:'基础形态'}, {id:2,evolution_stage:'高级形态'}, {id:3,evolution_stage:'高级形态'},
    {id:4,evolution_stage:'首领形态'}, {id:5,evolution_stage:'高级形态',hidden:true}
  ];
  r.RKData.getMonsters = () => monsters;
  const page = pageApi(r, 'PetDexPage', 'getEffectiveRank');
  const rank = m => JSON.parse(JSON.stringify(page.getEffectiveRank(m)));
  assert.deepEqual(rank(monsters[0]), {rank:0,count:0});
  assert.deepEqual(rank(monsters[1]), {rank:2,count:2});
  assert.deepEqual(rank(monsters[3]), {rank:1,count:3});
  r.RKData.getEffectiveStats = m => -m.id;
  assert.deepEqual(rank(monsters[1]), {rank:1,count:2});
  assert.deepEqual(rank(monsters[3]), {rank:3,count:3});
});

test('pet stats refresh changes only value/rank, not detail filters or modal stacking', () => {
  const r = runtime(), m = {id:2,evolution_stage:'高级形态'}, modal = r.element('pet-modal'), body = r.element('pet-modal-body',modal);
  modal.style.display='flex'; modal.style.zIndex='500'; body.scrollTop=120;
  const value = r.element('value',body); value.className='detail-stats-total';
  r.RKData.getMonsters=()=>[m];
  const page=pageApi(r,'PetDexPage','refreshPetStats');
  page.refreshPetStats(m,body); assert.match(value.innerHTML,/1002.*#1\/1/);
  r.RKData.getEffectiveStats=()=>123; page.refreshPetStats(m,body); assert.match(value.innerHTML,/123.*#1\/1/);
  assert.equal(body.scrollTop,120); assert.equal(modal.style.zIndex,'500');
  modal.style.display='none'; r.RKData.getEffectiveStats=()=>999; page.refreshPetStats(m,body); assert.ok(!value.innerHTML.includes('999'));
});

test('page wiring delegates columns/cells/sort and has no duplicate effective formula, regex search, or per-detail document listener', () => {
  const pet=source('js/pages/petdex.js'), moves=source('js/pages/moves.js');
  for(const call of ['statHeaders','statCells','sortMonsters']) assert.ok(pet.includes(`ListingUI.${call}`));
  assert.ok(moves.includes('ListingUI.monsterTable'));
  assert.ok(!pet.includes('Math.min('+'m.base_phy_atk'));
  assert.ok(!pet.includes('Math.min('+'a.base_phy_atk'));
  for(const code of [pet,moves]) { assert.ok(code.includes('ListingUI.mountFilters')); assert.ok(code.includes('ListingUI.onStatsChange')); assert.ok(!code.includes('new RegExp')); }
  assert.ok(!moves.includes("document.addEventListener('click'"));
});


test('learner heading owns the style switch in both views and preserves source vs unique counts', () => {
  const r = runtime(), title = r.element('move-learners-title');
  r.element('move-learners-default'); r.element('move-learners-table'); r.element('multi-skill-result');
  const page = pageApi(r, 'MovesPage', "renderLearnerViews, configure(style) { detailStyle=style; currentDetail={name:'测试',monsters:[{id:1},{id:1},{id:2}]}; }");
  page.configure('default'); page.renderLearnerViews(); assert.equal(title.textContent, '可学习该技能的精灵 (3)');
  page.configure('table'); page.renderLearnerViews(); assert.equal(title.textContent, '可学习该技能的精灵 (2)');
  const moves = source('js/pages/moves.js');
  // Preserve intersection-before-base-list order; keep the switch beside its own title.
  assert.match(moves, /id="multi-skill-result"[^]*?id="move-learners-title"[^]*?id="move-detail-style"[^]*?id="move-learners-default"/);
  assert.equal((moves.match(/id="move-detail-style"/g) || []).length, 1);
  assert.doesNotMatch(moves, /move-detail-skill-name-line[^\n]*listing-style-host/);
  assert.doesNotMatch(source('css/listing-ui.css'), /margin-left:\s*auto/);
});

test('selected intersection tiles are whole native remove buttons with image/name only', () => {
  const r = runtime(), list = r.element('multi-skill-selected-list'), input = r.element('multi-skill-search');
  r.element('multi-skill-result'); learnerFixture(r);
  const page = pageApi(r, 'MovesPage', "renderSelectedSkills, configure() { multiSkillSelected=['交集']; currentDetail={name:'测试'}; }");
  page.configure(); page.renderSelectedSkills();
  assert.match(list.innerHTML, /<button type="button" class="multi-skill-selected-item"[^>]*onclick="MovesPage.removeMultiSkill\(0\)"/);
  assert.match(list.innerHTML, /multi-skill-selected-skill-img/);
  assert.match(list.innerHTML, /multi-skill-selected-name">交集/);
  assert.doesNotMatch(list.innerHTML, /&times;|selected-remove|selected-elem|showMoveDetail/);
  r.document.activeElement = list;
  page.removeMultiSkill(0);
  assert.equal(list.innerHTML, ''); assert.equal(input.disabled, false);
  assert.equal(r.document.activeElement, input);
});

test('inline toolbar moves original slot once; only conditions hide/portal; search focus and handlers survive', () => {
  const r = runtime(), panel = r.element('panel'), slot = r.element('petdex-search-slot', panel);
  const input = r.element('search', slot), filter = r.element('condition', panel);
  input.value = '输入.*['; input.focus(); let inputs = 0;
  input.addEventListener('input', () => inputs++);
  const ui = r.api.mountFilters(panel, 'petdex');
  assert.deepEqual(ui.bar.children, [slot, ui.modes]);
  assert.equal(ui.bar.children.length, 2); // No title/spacer/duplicate search.
  assert.equal(ui.modes.getAttribute('aria-label'), '筛选条件显示模式');
  for (const mode of ['collapsed', 'floating', 'expanded', 'floating', 'collapsed']) {
    ui.setMode(mode);
    assert.equal(r.document.activeElement, input);
    assert.equal(input.parentNode, slot); assert.equal(slot.parentNode, ui.bar);
    assert.equal(input.value, '输入.*['); assert.equal(filter.parentNode, panel);
    assert.equal(slot.hidden, false); assert.equal(ui.modes.hidden, false);
    assert.equal(panel.contains(input), false);
    input.emit('input');
  }
  assert.equal(inputs, 5);
  ui.setMode('floating'); ui.close();
  slot.emit('focusin'); r.advance(100);
  assert.equal(panel.hidden, true, 'keyboard search focus alone does not open');
  ui.shell.emit('pointerenter'); assert.equal(panel.hidden, false, 'whole permanent header opens');
  slot.emit('pointerdown'); slot.emit('focusin');
  assert.equal(panel.hidden, false, 'search interaction no longer closes');
  ui.shell.emit('pointerleave', { relatedTarget: input }); r.advance(100);
  assert.equal(panel.hidden, false, 'search is inside pointer union');
  ui.shell.emit('pointerleave'); r.advance(79);
  assert.equal(panel.hidden, false); r.advance(1); assert.equal(panel.hidden, true);
  ui.setMode('collapsed'); ui.shell.emit('pointerenter'); slot.emit('focusin');
  assert.equal(panel.hidden, true, 'collapsed header never opens on hover/focus');
});

test('keyboard modes, focus/pointer union, and Escape focus restoration', () => {
  const r = runtime(), ui = r.mountFilters(r.element('panel'), 'petdex');
  const [expanded, collapsed, floating] = ui.modes.children;
  expanded.focus(); ui.modes.emit('keydown', {key:'ArrowRight'});
  assert.equal(ui.getMode(), 'collapsed'); assert.equal(r.document.activeElement, collapsed);
  ui.modes.emit('keydown', {key:'End'});
  assert.equal(ui.getMode(), 'floating'); assert.equal(r.document.activeElement, floating);
  assert.equal(floating.getAttribute('aria-controls'), ui.panel.id);
  ui.modes.emit('pointerenter'); ui.modes.emit('pointerleave'); r.advance(100);
  assert.equal(ui.panel.hidden, false, 'focus still owns popup after pointer leaves');
  ui.modes.emit('keydown', {key:'Tab'}); assert.equal(r.document.activeElement, ui.panel);
  ui.panel.emit('keydown', {key:'Tab',shiftKey:true}); assert.equal(r.document.activeElement, floating);
  ui.panel.focus(); r.document.emit('keydown', {key:'Escape'});
  assert.equal(ui.panel.hidden, true); assert.equal(r.document.activeElement, floating);
  ui.modes.emit('keydown', {key:'Home'}); assert.equal(ui.getMode(), 'expanded');
  ui.panel.focus(); ui.setMode('collapsed'); assert.equal(r.document.activeElement, collapsed);
  ui.setMode('floating'); ui.panel.focus(); ui.setMode('expanded');
  assert.equal(r.document.activeElement, ui.panel); assert.equal(ui.panel.parentNode, ui.shell);
});

test('unsupported consumers do not receive controls and old full-search descriptor is removed', () => {
  const r = runtime(), panel = r.element('panel');
  assert.throws(() => r.api.mountFilters(panel, 'game-description'), /supported page/);
  assert.equal(panel.parentNode, r.document.body);
  assert.doesNotMatch(source('js/pages/game-description.js'), /ListingUI.mountFilters/);
  assert.doesNotMatch(source('js/listing-ui.js'), /搜索与筛选|listing-filter-trigger|listing-filter-icon/);
  assert.doesNotMatch(source('css/listing-ui.css'), /listing-filter-trigger|listing-filter-icon/);
  assert.match(source('css/listing-ui.css'), /@container \(min-width: 780px\)/);
});

test('legacy appendChild focus restoration cannot recursively open duplicate portals/listeners', () => {
  const r = runtime(), ui = r.mountFilters(r.element('panel'), 'petdex');
  const input = r.element('condition-input', ui.panel);
  input.focus();
  const append = r.document.body.appendChild.bind(r.document.body);
  r.document.body.appendChild = node => { const result = append(node); r.document.activeElement = null; return result; };
  input.focus = () => { r.document.activeElement = input; ui.panel.emit('focusin'); };
  ui.setMode('floating');
  assert.equal(r.document.activeElement, input);
  assert.equal(r.document.count('keydown'), 1);
  assert.equal(r.document.count('pointerdown'), 1);
  ui.destroy();
  assert.equal(r.document.total(), 0); assert.equal(r.window.total(), 0);
});

test('attribute priority stable-partitions after all numeric sorts, matching either type without mutating/dropping rows', () => {
  const r = runtime();
  const monsters = [
    {id:1,base_hp:50,main_type:{name:'Water'}},
    {id:2,base_hp:10,main_type:{name:'Fire'}},
    {id:3,base_hp:50,main_type:{name:'Water'},sub_type:{name:'Fire'}},
    {id:4,base_hp:50,main_type:{name:'Fire'},sub_type:{name:'Fire'}},
    {id:5,base_hp:5}, {id:'3',base_hp:999,main_type:{name:'Fire'}}
  ];
  const snapshot = JSON.stringify(monsters);
  assert.deepEqual(rowIds(r.api.monsterTable(monsters,{key:'base_hp',asc:false},'Fire')), [3,4,2,1,5]);
  assert.deepEqual(rowIds(r.api.monsterTable(monsters,{key:'base_hp',asc:true},'Fire')), [2,3,4,5,1]);
  assert.deepEqual(rowIds(r.api.monsterTable(monsters,{key:'base_hp',asc:false},'')), [1,3,4,2,5]);
  for (const {key} of r.api.STAT_COLUMNS) for (const asc of [true,false]) {
    const sorted = r.api.sortMonsters(r.api.uniqueMonsters(monsters),key,asc);
    const match = m => m.main_type?.name==='Fire' || m.sub_type?.name==='Fire';
    assert.deepEqual(rowIds(r.api.monsterTable(monsters,{key,asc},'Fire')), ids([...sorted.filter(match),...sorted.filter(m=>!match(m))]));
  }
  let sort = {key:null,asc:false,priorityType:'Fire'};
  assert.deepEqual(rowIds(r.api.monsterTable(monsters,sort)),[2,3,4,1,5],'pin works without numeric sort');
  for(const key of ['base_hp','effective','base_hp']) {
    sort=r.api.nextSort(sort,key);
    assert.equal(sort.priorityType,'Fire','numeric sort never drops priorityType');
    assert.deepEqual(rowIds(r.api.monsterTable(monsters,sort)),rowIds(r.api.monsterTable(monsters,sort,'Fire')));
  }
  assert.equal(JSON.stringify(monsters), snapshot);
  assert.deepEqual(ids(r.api.prioritizeMonsters(monsters,'Illusion')),ids(monsters));
  assert.match(r.api.monsterTable(monsters,{},'Fire'), /data-listing-priority="Fire"[^>]*aria-label="属性：Fire优先/);
  assert.match(r.api.monsterTable(monsters,{},'Fire'), /listing-priority-indicator/);
  assert.doesNotMatch(r.api.monsterTable(monsters), /listing-priority-indicator/);
});

test('priority picker uses 18 native toggles, actual modal stacking, CommonUI dismissal and bounded cleanup', () => {
  const r = runtime(), modal = r.element('modal'); modal.style.zIndex = '780';
  const host = r.element('table',modal), anchor = r.element('attribute',host);
  anchor.setAttribute('data-listing-priority','Fire');
  const changes = [];
  const popup = () => r.document.body.querySelector('.listing-priority-popup');
  r.api.mountAttributePriority(host,'Fire', value => changes.push(value));
  anchor.emit('click'); let layer = popup();
  assert.equal(layer.children.length,18);
  assert.ok(layer.children.every(b=>b.tagName==='button' && b.type==='button'));
  assert.equal(layer.style.zIndex,'781'); assert.equal(layer.style.position,'fixed');
  assert.equal(anchor.getAttribute('aria-expanded'),'true');
  const fire = layer.children.find(b=>b.dataset.priorityType==='Fire');
  assert.equal(r.document.activeElement,fire); assert.equal(fire.getAttribute('aria-pressed'),'true');
  fire.emit('click'); assert.deepEqual(changes,['']); assert.equal(popup(),null);
  assert.equal(r.document.activeElement,anchor);
  anchor.emit('click'); popup().children.find(b=>b.dataset.priorityType==='Water').emit('click');
  assert.deepEqual(changes,['','Water']);
  for(const [target,event,props] of [[r.document,'keydown',{key:'Escape'}],[r.document,'pointerdown',{}],[r.document,'scroll',{}],[r.window,'resize',{}],[r.window,'appzoomchange',{}],[r.window,'appfontchange',{}]]) {
    anchor.emit('click'); target.emit(event,props);
    assert.equal(popup(),null,event); assert.equal(anchor.getAttribute('aria-expanded'),'false');
    assert.equal(r.document.total(),0,event); assert.equal(r.window.total(),0,event);
  }
  anchor.emit('click'); layer=popup(); r.document.emit('scroll',{target:layer});
  assert.equal(popup(),layer,'internal scroll retains picker');
  anchor.emit('click'); assert.equal(popup(),null,'same header toggles popup');
  r.commonApi.destroyWithin(host);
  for(let i=0;i<15;i++) {
    r.api.mountAttributePriority(host,'',()=>{}); anchor.emit('click');
    assert.ok(popup()); r.commonApi.destroyWithin(host);
    assert.equal(popup(),null); assert.equal(anchor.total(),0);
    assert.equal(r.document.total(),0); assert.equal(r.window.total(),0);
  }
});

test('both learner tables coordinate pin and numeric sorting while default source groups remain untouched', () => {
  const r = runtime(), monsters=learnerFixture(r);
  monsters[1].main_type={name:'Fire'};
  monsters[2].sub_type={name:'Fire'};
  r.element('move-learners-title'); const normal=r.element('move-learners-default');
  normal.innerHTML='unchanged grouped own/inherit/source cards';
  const table=r.element('move-learners-table'), intersection=r.element('multi-skill-result');
  const page=pageApi(r,'MovesPage', "renderLearnerViews, configure(type, asc, style='table') { currentDetail={name:'测试',monsters:RKData.getMonsters().filter(m=>[2,3,4].includes(m.id))}; detailStyle=style; learnerSort={key:'effective',asc,priorityType:type}; multiSkillSelected=['交集']; }");
  for(const [type,asc,expected] of [['Fire',false,[3,2,4]],['Fire',true,[2,3,4]],['',false,[4,3,2]]]) {
    page.configure(type,asc); page.renderLearnerViews();
    assert.deepEqual(rowIds(table.innerHTML),expected); assert.deepEqual(rowIds(intersection.innerHTML),expected);
    assert.equal(normal.innerHTML,'unchanged grouped own/inherit/source cards');
  }
  page.configure('Fire',false,'default'); page.renderLearnerViews();
  assert.equal(table.innerHTML,'');
  assert.deepEqual([...intersection.innerHTML.matchAll(/showPetDetail\((\d+)\)/g)].map(m=>Number(m[1])),[2,3,4]);
});

test('live header hover, pointer vs keyboard ownership and close restoration remain independent', () => {
  const r=runtime(),ui=r.mountFilters(r.element('panel'),'moves'); ui.setMode('floating');
  ui.trigger.focus(); ui.modes.emit('focusin');
  ui.shell.emit('pointerenter'); ui.shell.emit('pointerdown'); r.advance(1);
  ui.shell.emit('pointerleave'); r.advance(80);
  assert.equal(ui.panel.hidden,true,'mouse clears keyboard ownership even when mode remains focused');
  ui.shell.emit('pointerenter'); ui.panel.emit('pointerleave');
  ui.shell.hovered=false; // Portal relocation can omit pointerleave: consult live :hover.
  r.advance(80); assert.equal(ui.panel.hidden,true);
  ui.modes.emit('focusin'); ui.panel.focus(); r.document.emit('keydown',{key:'Escape'});
  assert.equal(ui.panel.hidden,true); assert.equal(r.document.activeElement,ui.trigger);
});

test('keyboard return to search releases ownership, but a real header hover still retains popup', () => {
  const r=runtime(),ui=r.mountFilters(r.element('panel'),'moves');
  const input=r.element('search',ui.searchSlot);
  ui.setMode('floating'); ui.trigger.focus(); ui.modes.emit('focusin');
  input.focus(); ui.modes.emit('focusout',{relatedTarget:input}); ui.searchSlot.emit('focusin');
  r.advance(80); assert.equal(ui.panel.hidden,true,'keyboard-only search does not pin popup');
  ui.shell.emit('pointerenter'); ui.trigger.focus(); ui.modes.emit('focusin');
  input.focus(); ui.modes.emit('focusout',{relatedTarget:input}); ui.searchSlot.emit('focusin');
  r.advance(80); assert.equal(ui.panel.hidden,false,'search remains in live pointer union');
});
