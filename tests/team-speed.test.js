const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatch(type) { listeners.get(type)?.forEach(fn => fn()); },
    count() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); }
  };
}

async function runtime() {
  const nodes = new Map(), memory = new Map(), frames = new Map(), observers = [];
  const window = eventTarget(), fonts = Object.assign(eventTarget(), { ready: Promise.resolve() });
  let frameId = 0;
  const context = {
    console: { log() {}, warn() {}, error() {} }, window,
    document: { fonts, getElementById: id => nodes.get(id) || null },
    localStorage: { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) },
    fetch: async file => ({ ok: true, json: async () => JSON.parse(read(file)) }),
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    getComputedStyle: node => node.computed || { paddingLeft: '4px', paddingRight: '4px' },
    ResizeObserver: class {
      constructor(fn) { this.fn = fn; this.active = true; observers.push(this); }
      observe(node) { this.node = node; }
      disconnect() { this.active = false; }
    }
  };
  vm.createContext(context);
  for (const file of ['js/battle-math.js', 'js/monster-identity.js', 'js/data.js']) vm.runInContext(read(file), context);
  await vm.runInContext('RKData.init()', context);
  // Test-only closure access; production pages do not expose mutation/testing APIs.
  const teamCode = read('js/pages/team.js').replace('return { render, togglePet, onLeave };', `return {
    render, onLeave, calcTeamAttackSummary, renderTeamAttackSummary, calcTeamTypeSummary,
    getDefensiveMatchups, getTeamDisplayMonster, refreshStatsPreferences,
    setFixture(value) { team = value.team || []; petSkills = value.petSkills || {}; detailBloodline = value.detailBloodline || {}; leaderFormId = value.leaderFormId || {}; searchKeyword = value.search || ''; }
  };`);
  const speedCode = read('js/pages/speed.js').replace('return { render, onLeave };', `return {
    render, onLeave, avatarCapacity, prioritizeSearchedPet, calcSpeedStat, bindResponsiveLayout,
    scheduleResponsiveLayout, updateResponsiveLayout, recordPetSearch, getPetPriority,
    getFormGroupKey, setFormOverride,
    getState: () => tierState,
    setLayout(value) { layoutState = value; }
  };`);
  vm.runInContext(teamCode, context);
  vm.runInContext(speedCode, context);
  const api = vm.runInContext('RKData', context), team = vm.runInContext('TeamPage', context), speed = vm.runInContext('SpeedPage', context);
  return { api, team, speed, nodes, memory, window, fonts, frames, observers,
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); } };
}

function fixtureMove(name, type, category = 'Physical Attack') {
  return { localized: { zh: { name } }, move_type: { name: type }, move_category: category };
}

test('attacks deduplicate by pet per target even across multiple attack attributes', async () => {
  const { api, team } = await runtime();
  const members = [{ id: 1, monster: { id: 1 } }, { id: 2, monster: { id: 2 } }, { id: '1', monster: { id: 1 } }];
  const moves = [fixtureMove('A', 'Fire'), fixtureMove('B', 'Fire', 'Magic Attack'), fixtureMove('C', 'Water')];
  const equipped = { 1: ['A', 'B', 'C', 'A'], 2: ['B'] };
  const summary = team.calcTeamAttackSummary(members, equipped, moves, ['Fire', 'Water'], (atk, target) => target === 'Fire' ? 2 : .5, api.isAttackMove);
  assert.equal(summary.Fire.strong.length, 2);
  assert.equal(summary.Water.resisted.length, 2);
  assert.deepEqual(plain(summary.Fire.strong[0].skills), ['A', 'B', 'C']);
  assert.deepEqual(equipped[1], ['A', 'B', 'C', 'A'], 'input is not mutated');
});

test('only authoritative physical/magic moves with known types count; unknown never falls back', async () => {
  const { api, team } = await runtime();
  const categories = ['Status', 'Defense', 'Conditional Attack', 'Energy', 'Unknown', '', 'Physical Attack', 'Magic Attack'];
  const moves = categories.map((category, i) => fixtureMove('move' + i, 'Fire', category));
  moves.push(fixtureMove('unknown-type', 'Unknown'));
  const equipped = { 1: [null, '', 'missing', 'unknown-type', ...moves.slice(0, 6).map(m => m.localized.zh.name)] };
  const calculate = () => team.calcTeamAttackSummary([{ id: 1, monster: {} }], equipped, moves, ['Fire'], () => 2, api.isAttackMove);
  assert.equal(calculate().Fire.strong.length, 0);
  equipped[1].push('move6', 'move7');
  assert.equal(calculate().Fire.strong.length, 1);
});

test('thresholds use >=2 and <=0.5, including zero; neutral does not contribute', async () => {
  const { api, team } = await runtime();
  const types = ['Fire', 'Water', 'Grass', 'Ice', 'Ground', 'Normal'];
  const eff = { Fire: 2, Water: 3, Grass: .5, Ice: 0, Ground: .51, Normal: 1.99 };
  const summary = team.calcTeamAttackSummary([{ id: 1, monster: {} }], { 1: ['A'] }, [fixtureMove('A', 'Fire')], types, (_, target) => eff[target], api.isAttackMove);
  assert.deepEqual(types.map(t => [summary[t].strong.length, summary[t].resisted.length]), [[1, 0], [1, 0], [0, 1], [0, 1], [0, 0], [0, 0]]);
});

test('real master-table moves agree with the shared effectiveness helper across all 18 target types', async () => {
  const { api, team } = await runtime();
  const moves = api.getMoves().filter(api.isAttackMove).filter(m => api.PILL_ORDER.includes(m.move_type?.name));
  const equipped = { 501: moves.slice(0, 4).map(m => m.localized.zh.name), 434: moves.slice(-4).map(m => m.localized.zh.name) };
  const members = [501, 434].map(id => ({ id, monster: api.getMonsterById(id) }));
  const summary = team.calcTeamAttackSummary(members, equipped, api.getMoves(), api.PILL_ORDER, api.getTypeEff, api.isAttackMove);
  assert.equal(Object.keys(summary).length, 18);
  for (const target of api.PILL_ORDER) {
    const values = members.map(({ id }) => equipped[id].map(name => api.getTypeEff(moves.find(m => m.localized.zh.name === name).move_type.name, target)));
    assert.equal(summary[target].strong.length, values.filter(v => v.some(e => e >= 2)).length);
    assert.equal(summary[target].resisted.length, values.filter(v => !v.some(e => e >= 2) && v.some(e => e <= .5)).length);
    assert.ok(summary[target].strong.length + summary[target].resisted.length <= members.length);
  }
});

test('empty teams render all three 18-type panels and offense has independent sign/color semantics', async () => {
  const { api, team } = await runtime();
  const summary = team.calcTeamAttackSummary([], {}, [], api.PILL_ORDER, api.getTypeEff, api.isAttackMove);
  const empty = team.renderTeamAttackSummary(summary);
  assert.equal((empty.match(/data-summary=/g) || []).length, 3);
  assert.equal((empty.match(/data-type=/g) || []).length, 54);
  const source = { monster: { localized: { zh: { name: '<pet>' } } }, attackTypes: ['Fire'], skills: ['<skill>"'] };
  summary.Fire.strong.push(source);
  summary.Water.resisted.push(source);
  const html = team.renderTeamAttackSummary(summary);
  const net = html.slice(html.indexOf('data-summary="attack-net"'));
  assert.match(net, /attack-positive" data-type="Fire"[^]*?team-defense-score">\+1/);
  assert.match(net, /attack-risk" data-type="Water"[^]*?team-defense-score">-1/);
  assert.doesNotMatch(net, /team-defense-item (weak|strong)"/);
  assert.match(net, /&lt;skill&gt;&quot;/);
});

test('defense uses the shared multiplier and currently selected leader form', async () => {
  const { api, team } = await runtime();
  const base = api.getMonsters().find(m => !m.is_leader_form && api.getMonsters().some(l => l.is_leader_form && l.dex_number === m.dex_number));
  const leader = api.getMonsters().find(m => m.is_leader_form && m.dex_number === base.dex_number);
  team.setFixture({ team: [base.id], detailBloodline: { [base.id]: 'Leader' }, leaderFormId: { [base.id]: leader.id } });
  assert.equal(team.getTeamDisplayMonster(base.id).id, leader.id);
  const calls = [];
  api.getTypeEff = (...args) => { calls.push(args); return .25; };
  const defense = team.calcTeamTypeSummary();
  assert.equal(calls.length, 18);
  assert.ok(calls.every(args => args[1] === leader.main_type?.name && args[2] === leader.sub_type?.name));
  assert.ok(Object.values(defense.resistances).every(value => value === 1));
  assert.equal(team.getDefensiveMatchups('Fire', 'Water').resist025.length, 18);
});

test('stats preference refresh re-sorts current candidates but ranks against the original full pool', async () => {
  const { api, team, nodes } = await runtime();
  const total = { innerHTML: '' }, list = { innerHTML: '', clientWidth: 600, style: {}, querySelectorAll: () => [] };
  nodes.set('team-candidate-list', list);
  nodes.set('team-skill-picker-modal', { dataset: { petId: '1' }, querySelector: () => total });
  const monsters = [
    { id: 1, localized: { zh: { name: 'visible A' } }, speed: 100, value: 10 },
    { id: 2, localized: { zh: { name: 'visible B' } }, speed: 0, value: 20 },
    { id: 3, localized: { zh: { name: 'hidden rank' } }, hidden: true, speed: 0, value: 300 }
  ];
  api.getMonsters = () => monsters;
  api.getMonsterById = id => monsters.find(m => m.id === id);
  let includeSpeed = true;
  api.getEffectiveStats = m => m.value + (includeSpeed ? m.speed : 0);
  team.setFixture({ search: 'visible' });
  team.refreshStatsPreferences();
  assert.ok(list.innerHTML.indexOf('data-pet-id="1"') < list.innerHTML.indexOf('data-pet-id="2"'));
  assert.match(total.innerHTML, /^110.*#2\/3/);
  includeSpeed = false;
  team.refreshStatsPreferences();
  assert.ok(list.innerHTML.indexOf('data-pet-id="2"') < list.innerHTML.indexOf('data-pet-id="1"'));
  assert.doesNotMatch(list.innerHTML, /hidden rank/);
  assert.match(total.innerHTML, /^10.*#3\/3/);
});

test('avatar capacity maximizes every real width and never imposes 7 or 13', async () => {
  const { speed } = await runtime();
  for (let width = 0; width < 1800; width += .75) {
    const count = speed.avatarCapacity(width);
    assert.ok(count * 34 <= width);
    assert.ok((count + 1) * 34 > width);
  }
  assert.equal(speed.avatarCapacity(33.99), 0);
  assert.equal(speed.avatarCapacity(34), 1);
  assert.equal(speed.avatarCapacity(680), 20);
  assert.equal(speed.avatarCapacity(NaN), 0);
});

test('search injection precedes slicing and preserves the complete pool / priority / form coverage', async () => {
  const { speed, api, memory } = await runtime();
  const pets = Array.from({ length: 30 }, (_, id) => ({ id: id + 1 }));
  assert.equal(speed.prioritizeSearchedPet(pets, pets[29]).slice(0, 1)[0].id, 30);
  assert.equal(speed.prioritizeSearchedPet(pets, { id: 99 }).length, 31);
  assert.equal(pets[0].id, 1);
  const pair = api.getMonsters().filter(m => m.form_category === '变体形态' && m.base_spd);
  const variant = pair[0];
  assert.ok(variant);
  speed.setFormOverride(variant);
  assert.equal(speed.getState().formOverrides[speed.getFormGroupKey(variant)], variant.id);
  speed.recordPetSearch(variant); speed.recordPetSearch(variant);
  assert.equal(speed.getPetPriority(variant.base_spd).filter(id => id === variant.id).length, 1);
  assert.ok(memory.has('rk_speed_pet_priority'));
  assert.ok(memory.has('rk_speed_form_overrides'));
});

function fakeTable() {
  let writes = 0;
  const strip = { dataset: {}, computed: { width: '350px' }, set innerHTML(value) { this.html = value; writes++; } };
  const columns = ['speed', 'base', 'monsters'].map(colKey => ({ dataset: { colKey }, style: {} }));
  const table = {
    isConnected: true, style: {}, parentElement: { clientWidth: 736 },
    querySelectorAll(selector) {
      if (selector === 'col') return columns;
      if (selector === 'thead th') return [{}, {}, { querySelector: () => ({ offsetWidth: 28 }) }];
      if (selector === '.speed-avatar-strip') return [strip];
      return [{ offsetWidth: 40 }];
    }
  };
  return { table, strip, writes: () => writes };
}

test('layout updates only changed capacities; resize/font/zoom events coalesce and cleanup prevents leaks', async () => {
  const r = await runtime(), f = fakeTable();
  const rowPets = [Array.from({ length: 30 }, (_, id) => ({ id, localized: { zh: { name: 'pet' + id } } }))];
  const attach = () => { r.speed.setLayout({ table: f.table, rowPets, hasHighlight: false }); r.speed.bindResponsiveLayout(); };
  attach();
  await Promise.resolve(); r.flush();
  assert.equal(f.writes(), 1);
  assert.equal(f.strip.dataset.capacity, '10');
  const htmlBefore = f.strip.html;
  for (const type of ['resize', 'appzoomchange', 'appfontchange']) r.window.dispatch(type);
  r.fonts.dispatch('loadingdone');
  assert.equal(r.frames.size, 1);
  r.flush();
  assert.equal(f.writes(), 1, 'unchanged capacity does not rewrite DOM');
  assert.equal(f.strip.html, htmlBefore);
  const observer = r.observers[0];
  observer.fn([{ contentRect: { width: 736, height: 100 } }]); r.flush();
  observer.fn([{ contentRect: { width: 736, height: 200 } }]);
  assert.equal(r.frames.size, 0, 'height-only observer callbacks are ignored');
  f.strip.computed.width = '102px';
  r.window.dispatch('appzoomchange'); r.flush();
  assert.equal(f.strip.dataset.capacity, '3');
  assert.equal(f.writes(), 2);
  r.window.dispatch('resize'); r.speed.onLeave();
  assert.equal(r.frames.size, 0);
  assert.equal(r.window.count(), 0);
  assert.equal(r.fonts.count(), 0);
  assert.ok(r.observers.every(o => !o.active));
  for (let i = 0; i < 5; i++) { attach(); r.speed.onLeave(); }
  await Promise.resolve();
  assert.equal(r.frames.size, 0, 'stale font-ready promises cannot revive a departed page');
  assert.equal(r.window.count(), 0);
  assert.ok(r.observers.every(o => !o.active));
});

test('source/CSS contract: no duplicate relationship table, fixed slice, or global selectors', () => {
  const team = read('js/pages/team.js'), speed = read('js/pages/speed.js'), css = read('css/team-speed-features.css');
  assert.doesNotMatch(team, /vulnerable_to|resistant_to/);
  assert.doesNotMatch(speed, /slice\(0,\s*(7|13)\)|petsSliced/);
  assert.match(team, /appstatspreferenceschange/);
  assert.match(team, /refreshTeamCard\(\);\s*saveConfig\(\);\s*const equippedRaw/);
  assert.match(team, /refreshTeamCard\(\);\s*saveConfig\(\);\s*\/\/ 更新技能槽位/);
  for (const selector of css.replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) {
    assert.match(selector[1].trim(), /^(?:\.team-attack-summary|\.speed-responsive|\[data-theme="dark"\] \.team-attack-summary)/);
  }
});


test('strong beats resisted per pet/target; neutral plus resisted retains resistance; empty attacks contribute neither', async () => {
  const { api, team } = await runtime();
  const moves = [fixtureMove('strong', 'Fire'), fixtureMove('resisted', 'Water'), fixtureMove('neutral', 'Grass'), fixtureMove('status', 'Fire', 'Status')];
  const effects = { Fire: 2, Water: .5, Grass: 1 };
  const members = [1, 2, 3, 4, 5].map(id => ({ id, monster: { id } }));
  const equipped = { 1: ['strong', 'resisted', 'neutral'], 2: ['resisted', 'neutral'], 3: ['neutral'], 4: [], 5: ['status', 'missing'] };
  const summary = team.calcTeamAttackSummary(members, equipped, moves, Object.keys(effects), type => effects[type], api.isAttackMove);
  for (const result of Object.values(summary)) {
    assert.deepEqual(plain(result.strong.map(s => s.petId)), [1]);
    assert.deepEqual(plain(result.resisted.map(s => s.petId)), [2]);
    assert.deepEqual(plain(result.strong[0].skills), ['strong']);
    assert.deepEqual(plain(result.resisted[0].skills), ['resisted']);
    assert.equal(result.strong.length - result.resisted.length, 0);
  }
});
