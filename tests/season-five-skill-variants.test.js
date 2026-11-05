'use strict';
// Pure source-data/selection regression. Reads only this isolated project's catalog;
// no application, network, database, persistent profile, or external source access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const V = require('../js/skill-variants.js');
const S = require('../js/skill-simulation.js');
const publicCatalogData = require('../js/catalog-data.js');
const { readProjectData } = require('./catalog-read-fixture.cjs');
const candidateCatalog = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
const candidateLegacy = publicCatalogData.toLegacy(candidateCatalog);
const byId = id => candidateLegacy.moves.find(move => move.id === id);
const plain = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// Independent reviewed expectations: ID, name, complete description, category,
// local type ID/label, source single-hit power, stored initial combo, disposition.
const expected = [
  [5963, '蛋壳', '减伤60%，应对攻击：驱散敌方所有增益。', 'Defense', 1, '普通', null, null, 'non-attack'],
  [5964, '外附传播', '减伤80%，应对攻击：敌方获得2层寄生。', 'Defense', 2, '草', null, null, 'non-attack'],
  [5965, '果粒', '造成魔伤，2连击。', 'Magic Attack', 2, '草', 45, 2, 'ordinary'],
  [5966, '维管束重构', '造成魔伤，自己累计回复至少40%生命后，每次使用本技能可回复3能量。', 'Magic Attack', 2, '草', 110, null, 'base-only'],
  [5967, '离岸流', '造成物伤，使用至少2次水系技能后，本技能能耗永久-3。', 'Physical Attack', 4, '水', 125, null, 'base-only'],
  [5968, '续杯', '自己获得双攻+50%，本技能能耗每-1，额外获得50%。', 'Status', 4, '水', null, null, 'non-attack'],
  [5969, '间歇泉', '造成物伤，自己每有1层减益，本技能能耗-1。', 'Physical Attack', 4, '水', 115, null, 'base-only'],
  [5970, '碎银', '造成魔伤，消耗至少10能量后，本技能能耗永久-5。', 'Magic Attack', 6, '地', 170, null, 'base-only'],
  [5971, '矿物置换', '自己获得魔攻+120%和3回合禁足。', 'Status', 6, '地', null, null, 'non-attack'],
  [5972, '严霜', '敌方获得8层冻结。', 'Status', 7, '冰', null, null, 'non-attack'],
  [5973, '热桥', '减伤80%，应对攻击：敌方获得魔防-60%。', 'Defense', 7, '冰', null, null, 'non-attack'],
  [5974, '冷冻', '造成物伤，使敌方获得至少2次冻结后，每次使用本技能可使敌方能耗+1。', 'Physical Attack', 7, '冰', 100, null, 'base-only'],
  [5975, '深红龙击', '造成物伤。自己每进入1次蓄力状态，本技能能耗永久-2。', 'Physical Attack', 8, '龙', 115, null, 'base-only'],
  [5976, '咒火', '蓄力，自己获得2层龙噬印记。', 'Status', 8, '龙', null, null, 'non-attack'],
  [5977, '荒芜之噬', '造成物伤，若击败敌方，自己等级+20。', 'Physical Attack', 8, '龙', 130, null, 'base-only'],
  [5978, '画龙点睛', '蓄力，自己获得双攻+80%和速度+30。任意方式蓄力2次后，本技能不再需要蓄力。', 'Status', 8, '龙', null, null, 'non-attack'],
  [5979, '龙之爪牙', '蓄力，造成物伤，5连击。', 'Physical Attack', 8, '龙', 25, 5, 'ordinary'],
  [5980, '圣龙狂斩', '造成大量物伤，自己等级-5。', 'Physical Attack', 8, '龙', 160, null, 'base-only'],
  [5981, '过充电', '造成物伤，聚能至少1次后，本技能威力永久+30。', 'Physical Attack', 9, '电', 65, null, 'base-only'],
  [5982, '重启', '本回合和下个回合的结束时，自己返场。', 'Status', 9, '电', null, null, 'non-attack'],
  [5983, '投毒', '造成物伤，使敌方获得至少2次中毒后，每次使用本技能攻击中毒目标时威力+25。', 'Physical Attack', 10, '毒', 90, null, 'base-only'],
  [5984, '夏蛰', '己方队伍获得2次随机奉献，应对防御：获得所有种类的奉献各1次。', 'Status', 11, '虫', null, null, 'non-attack'],
  [5985, '筑梦', '将天气改为霞光梦境，持续8回合。', 'Status', 14, '萌', null, null, 'non-attack'],
  [5986, '恋恋不舍', '造成魔伤，使敌方获得至少3次减益后，本技能威力永久+30。', 'Magic Attack', 14, '萌', 110, null, 'base-only'],
  [5987, '冥暗诅咒', '敌方失去5能量，且下回合末回复3能量，应对防御：下回合不回复能量。', 'Status', 15, '幽', null, null, 'non-attack'],
  [5988, '灵扰', '造成物伤，3连击。偷取敌方能量至少1次后，本技能连击数永久+1。', 'Physical Attack', 15, '幽', 25, 3, 'base-only'],
  [5989, '地缚灵', '敌方获得双防-70%，若敌方本回合更换精灵，敌方额外获得速度-50。', 'Status', 15, '幽', null, null, 'non-attack'],
  [5990, '蓝移', '造成魔伤，使敌方获得至少4层星陨后，每次使用本技能可使敌方获得1层星陨。', 'Magic Attack', 18, '幻', 110, null, 'base-only'],
  [5991, '混合态', '敌方获得随机10层属性减益。', 'Status', 18, '幻', null, null, 'non-attack']
];
const newIds = new Set(expected.map(row => row[0]));
const changedFields = new Set(['basePower', 'basePowerExpression', 'comboCount', 'skillType', 'skillAttr', 'currentSkillName']);
const seed = Object.freeze({
  basePower: 999, basePowerExpression: '9+990', comboCount: 77,
  skillType: 'magic_attack', skillAttr: '旧属性', currentSkillName: 'prior',
  fixedBonus: -17, percentBonus: 23.5, buff: -35, debuffPercent: '10+5',
  defenseMod: '-50', starMeteor: 4, finalPowerManual: '0', mode: 1,
  currentLevel: 99, energy: 10, atkIV: Object.freeze({ hp: true }),
  rk_skill_simulation: Object.freeze({ '14:113': Object.freeze({ powerCount: 2, fireAttackCount: 2 }) }),
  unknownPersonalField: 'keep'
});

function preserveInputs(state, original) {
  for (const key of Object.keys(original)) if (!changedFields.has(key)) assert.deepEqual(state[key], original[key], key);
}

test('current candidate uses the public local-schema projection and all 29 exact S5 identities', () => {
  assert.deepEqual(candidateLegacy.moves, readProjectData('moves.json'));
  assert.deepEqual(candidateCatalog.skills.filter(skill => skill.season === 'S5').map(skill => skill.id), [...newIds]);
  const audit = V.audit(candidateLegacy.moves);
  assert.equal(audit.total, candidateCatalog.skills.length);
  assert.deepEqual(audit.unreviewed, []);
  assert.equal(new Set(audit.rows.map(row => row.id)).size, audit.total);
  assert.deepEqual(V.audit(candidateLegacy.moves.filter(move => newIds.has(move.id))).counts,
    { supported: 0, ordinary: 2, 'manual-only': 0, 'base-only': 13, 'non-attack': 14 });
});

for (const [id, name, description, category, typeId, element, power, combo, disposition] of expected) {
  test(`${id} ${name}: exact reviewed source, initial values, repeat-safe selection`, () => {
    const move = byId(id);
    assert.ok(move, `missing ${id}`);
    assert.deepEqual([move.id, move.localized.zh.name, move.localized.zh.description, move.move_category,
      move.move_type.id, move.move_type.localized.zh, move.power, move.base_combo, move.power_formula],
    [id, name, description, category, typeId, element, power, combo, null]);
    const before = JSON.stringify(move), d = V.describe(move);
    assert.equal(d.reviewed, true);
    assert.equal(d.disposition, disposition);
    assert.equal(d.dynamic, null);
    assert.equal(d.evidence, description);
    assert.equal(d.element, element);
    assert.equal(d.showUnknownPower, false);
    assert.match(V.tooltip(move), /基础威力：[\s\S]*效果：/);
    assert.ok(V.tooltip(move).endsWith(description));
    assert.doesNotMatch(V.tooltip(move), /左键：|右键：/);
    for (const petId of [1, 14, 568, 569, 619, 623]) {
      const original = { ...seed, atkPet: Object.freeze({ id: petId }) };
      let state = original;
      assert.deepEqual(V.forAttacker(move, petId), d, 'new IDs never delegate to old Garl choices');
      for (const side of ['left', 'right', 'right', 'left', 'right', 'left']) {
        const oldState = plain(state), selected = V.select(state, move, side);
        const applies = disposition !== 'non-attack' && (side === 'left' || disposition === 'base-only');
        assert.equal(selected.applied, applies, `${petId}/${side}`);
        assert.deepEqual(state, oldState, 'selection does not mutate its input');
        if (applies) {
          assert.deepEqual([selected.state.basePower, selected.state.comboCount], [power, combo ?? 1]);
          assert.equal(selected.state.basePowerExpression, '', 'no inherited expression or growth formula');
          assert.equal(selected.state.skillType, category === 'Magic Attack' ? 'magic_attack' : 'attack');
          assert.equal(selected.state.skillAttr, element);
          assert.equal(selected.state.currentSkillName, name);
          assert.match(d.left.label, /源/);
          if (side === 'right') assert.match(d.right.label, /不模拟条件/);
        } else assert.equal(selected.state, state, 'unsupported selection leaves all state untouched');
        preserveInputs(selected.state, original);
        state = selected.state;
      }
      const middle = V.select(state, move, 'middle');
      assert.equal(middle.applied, false);
      assert.equal(middle.state, state);
      assert.equal(S.kind(move, petId), null, 'new dynamic text must not enable old simulation maps');
      const counters = Object.freeze({ powerCount: 18, comboCount: 25, counterMode: true, energy: 10 });
      for (const side of ['left', 'right', 'middle']) assert.equal(S.select(move, petId, side, counters), null);
    }
    if (disposition === 'non-attack') {
      assert.equal(power, null);
      assert.equal(d.left, null);
      assert.equal(d.right, null);
    }
    if (disposition === 'base-only') {
      assert.deepEqual(d.left, d.right);
      assert.match(d.reason, /永久次数、能耗、等级、BUFF、印记/);
    }
    assert.equal(JSON.stringify(move), before, 'source full text/power/category are read-only');
  });
}

test('all new semantic bindings fail closed when ID/name/full text/category/type/power/combo/formula change', () => {
  for (const [id] of expected) {
    const move = byId(id);
    const mutations = [
      changed => { changed.id = 900000 + id; },
      changed => { changed.localized.zh.name += '（变体）'; },
      changed => { changed.localized.zh.description += '本技能威力永久+999。'; },
      changed => { changed.move_category = move.move_category === 'Magic Attack' ? 'Physical Attack' : 'Magic Attack'; },
      changed => { changed.move_type.localized.zh = '未审阅属性'; },
      changed => { changed.power = move.power === null ? 1 : move.power + 1; },
      changed => { changed.base_combo = (move.base_combo ?? 1) + 1; },
      changed => { changed.power_formula = 'speed_diff'; }
    ];
    for (const mutate of mutations) {
      const changed = plain(move); mutate(changed);
      assert.equal(V.describe(changed).reviewed, false, String(id));
      const selected = V.select(seed, changed, 'right');
      assert.equal(selected.applied, false);
      assert.equal(selected.state, seed);
    }
    const whitespace = plain(move);
    whitespace.localized.zh.description = ' \n' + move.localized.zh.description.split('').join(' ') + '\t';
    assert.equal(V.describe(whitespace).reviewed, true, 'only glossary whitespace is semantically ignored');
  }
});

test('new source rows never consult legacy alt/counter helpers or inherit similarly named dragon identity', () => {
  for (const [id] of expected) {
    const move = byId(id), poison = { ...move };
    for (const key of ['counter_power_multiplier', 'alt_power_total', 'alt_condition_zh']) {
      Object.defineProperty(poison, key, { get() { throw Error('legacy helper accessed: ' + key); } });
    }
    assert.deepEqual(V.describe(poison), V.describe(move));
    for (const side of ['left', 'right']) assert.deepEqual(V.select(seed, poison, side), V.select(seed, move, side));
  }
  const oldDragon = byId(250), newDragon = byId(5979), spirit = byId(5988), fruit = byId(5965);
  assert.equal(oldDragon.localized.zh.name, '龙之利爪');
  assert.equal(oldDragon.power, 130);
  assert.deepEqual([V.describe(newDragon).left.basePower, V.describe(newDragon).left.comboCount], [25, 5]);
  assert.deepEqual([V.describe(spirit).left.basePower, V.describe(spirit).left.comboCount], [25, 3]);
  assert.deepEqual([V.describe(fruit).left.basePower, V.describe(fruit).left.comboCount], [45, 2]);
  const borrowed = { ...newDragon, id: 250 };
  assert.equal(V.describe(borrowed).reviewed, false);
  assert.equal(byId(5998), undefined, '5988 is the precise audited identity');
});

test('the existing 579 reviewed rows, all implementation APIs and the complete simulation module stay frozen', () => {
  const text = fs.readFileSync(path.join(__dirname, '../js/skill-variants.js'), 'utf8');
  const start = text.indexOf('  const REVIEWED = {'), end = text.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start);
  const body = text.slice(start, end);
  const rows = body.slice(body.indexOf('\n') + 1).split('\n');
  const oldRows = rows.filter(line => !newIds.has(Number(/^    "(\d+)":/.exec(line)?.[1])));
  // A one-time audited byte freeze, not a filter that reduces current-catalog coverage.
  assert.equal(sha256(oldRows.join('\n')), '288f110a9eb2a490930b4a1b7f762e32385ba5ba95fa637481f5fc9ad89b9155');
  assert.equal(sha256(text.slice(0, start) + text.slice(end)), '79755b7069e9c90126628094fa940b23a2dddcac816bd5168798a9f005951fb6');
  assert.equal(sha256(fs.readFileSync(path.join(__dirname, '../js/skill-simulation.js'))), 'af5d28a309e9e85706d59a0d5dde01c6130df9bf1cbd93febc7bda992fe3dbff');
  assert.deepEqual(Object.keys(V).sort(), ['audit', 'describe', 'forAttacker', 'powerExpression', 'select', 'tooltip']);
});

test('pure UMD recognizes new rows without DOM, storage, network or mutable global simulation', () => {
  const forbidden = () => { throw Error('unexpected effect or persistence'); };
  const box = vm.createContext({ fetch: forbidden, localStorage: { getItem: forbidden, setItem: forbidden } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/skill-variants.js'), 'utf8'), box);
  for (const [id] of expected) assert.deepEqual(plain(box.SkillVariants.describe(byId(id))), V.describe(byId(id)));
  assert.deepEqual(Object.keys(box).sort(), ['SkillVariants', 'fetch', 'localStorage']);
});

// Exercise the shipped damage-page rendering and event closures, not a replacement
// event implementation. Test-only instrumentation exposes its existing renderer.
test('actual damage icons use new source bases/combos without conditions, counter writes or BUFF resets', () => {
  const decode = value => value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  class Element {
    constructor() {
      this.value = ''; this.textContent = ''; this.dataset = {}; this.events = {};
      this.children = []; this.attrs = {}; this.style = {};
      const classes = new Set();
      this.classList = { add: name => classes.add(name), remove: name => classes.delete(name),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) };
    }
    addEventListener(type, callback) { this.events[type] = callback; }
    setAttribute(key, value) { this.attrs[key] = value; }
    appendChild(child) { this.children.push(child); return child; }
    remove() { this.removed = true; }
    querySelectorAll(selector) { return selector === '.skill-icon-item' ? this.children : []; }
    fire(type, options = {}) {
      const event = { prevented: false, preventDefault() { this.prevented = true; }, ...options };
      this.events[type]?.(event); return event;
    }
  }
  const nodes = new Map(), grid = new Element();
  Object.defineProperty(grid, 'innerHTML', { set(html) {
    this.html = html; this.children = [];
    for (const match of html.matchAll(/<div class="skill-icon-item[^>]*>/g)) {
      const item = new Element();
      for (const attr of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) {
        if (attr[1].startsWith('data-')) item.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = decode(attr[2]);
        else item.attrs[attr[1]] = decode(attr[2]);
      }
      this.children.push(item);
    }
  }, get() { return this.html; } });
  nodes.set('skill-icons-grid', grid);
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    createElement: () => new Element(), querySelector: () => new Element(), querySelectorAll: () => [] };
  const profile = { rk_pet_configs: { 1: { mode: 1, iv: { hp: true }, nature: { attack: 2 }, extra: 'keep' } },
    rk_skill_simulation: plain(seed.rk_skill_simulation), rk_damage_skill_configs: { 1: { extra: 'keep' } },
    rk_damage_view: { skill: { extra: 'keep' } } };
  const beforePet = plain(profile.rk_pet_configs), beforeCounts = plain(profile.rk_skill_simulation), writes = [];
  const UserConfig = { getObject: (key, fallback = {}) => profile[key] ?? fallback,
    patch(key, patch) { writes.push({ key, patch: plain(patch) }); profile[key] = { ...profile[key], ...plain(patch) }; return Promise.resolve(true); } };
  const pet = { id: 1, dex_number: 1, name: 'Fixture', stats: { speed: 160, defense: 90 }, main_type: { name: 'Normal' } };
  const moves = candidateLegacy.moves;
  const RKData = { ALL_TYPES: [], getTypeZhFull: value => value, getTypeEff: () => 1, getBaseStat: () => 100,
    getPetStat: (selected, stat) => selected.stats?.[stat] ?? 100,
    getTypeIcon: value => value, getTypeEn: value => value, getTypeShortZh: value => value,
    getTypeZh: value => value, getMonsterDisplayName: selected => selected.name || 'Fixture',
    getMonsterById: id => id === 1 ? pet : null, getMoves: () => moves,
    getMoveName: move => move?.localized.zh.name,
    getMoveCategoryZh: move => move.move_category === 'Physical Attack' ? '物攻' : '魔攻',
    isAttackMove: move => !!move && ['Physical Attack', 'Magic Attack'].includes(move.move_category),
    getResolvedWikiData: () => ({ skills: expected.map(([id, name, , category, , element], index) => ({
      name, element, source: index % 2 ? '血脉' : '传说',
      type: { 'Physical Attack': '物攻', 'Magic Attack': '魔攻', Status: '状态', Defense: '防御' }[category]
    })) }) };
  const box = vm.createContext({ document, RKData, BattleMath: require('../js/battle-math.js'), SkillVariants: V, SkillSimulation: S,
    PetConfiguration: require('../js/pet-configuration.js'), CommonUI: { StatBox: { syncButtons() {}, refreshValues() {} } },
    window: { UserConfig, addEventListener() {} }, localStorage: { getItem: () => null, setItem() { throw Error('unexpected persistent write'); } },
    setTimeout: () => 1, clearTimeout() {} });
  const source = fs.readFileSync(path.join(__dirname, '../js/pages/damage.js'), 'utf8');
  const marker = 'return { render, onLeave, getState: () => state, CalcEngine };';
  assert.ok(source.includes(marker), 'instrument only the known existing renderer entry');
  vm.runInContext(source.replace(marker, 'return { render, onLeave, getState: () => state, CalcEngine, renderSkillIcons };') + '\nthis.page = DamagePage;', box);
  const state = box.page.getState();
  Object.assign(state, seed, { atkPet: pet, defPet: { id: 9001, stats: { speed: 100, defense: 100 }, main_type: { name: 'Normal' } } });
  const manual = { fixedBonus: seed.fixedBonus, percentBonus: seed.percentBonus, buff: seed.buff,
    debuffPercent: seed.debuffPercent, defenseMod: seed.defenseMod, starMeteor: seed.starMeteor, finalPowerManual: seed.finalPowerManual };
  for (const [key, value] of Object.entries({ basePower: seed.basePower, comboCount: seed.comboCount, ...manual })) document.getElementById(key).value = String(value);
  box.page.renderSkillIcons();
  const attacks = expected.filter(row => row[8] !== 'non-attack');
  assert.deepEqual(grid.children.map(item => item.dataset.skillName).sort(), attacks.map(row => row[1]).sort());
  for (const [id, name, description, category, , element, power, combo, disposition] of expected) {
    const item = grid.children.find(icon => icon.dataset.skillName === name);
    if (disposition === 'non-attack') { assert.equal(item, undefined); continue; }
    assert.ok(item.attrs.title.endsWith(description));
    assert.ok(item.attrs['aria-label'].endsWith(description));
    assert.doesNotMatch(item.attrs.title, /未审阅|左键：|右键：/);
    for (const [event, options, side] of [['click', {}, 'left'], ['contextmenu', {}, 'right'],
      ['keydown', { key: 'Enter' }, 'left'], ['keydown', { key: ' ', shiftKey: true }, 'right']]) {
      const before = plain(state), count = writes.length;
      const fired = item.fire(event, options);
      if (event !== 'click') assert.equal(fired.prevented, true);
      if (side === 'right' && disposition === 'ordinary') {
        assert.deepEqual(plain(state), before);
        assert.equal(writes.length, count, 'ordinary right key does not save a false result');
      } else {
        assert.deepEqual([state.basePower, state.comboCount], [power, combo ?? 1], String(id));
        assert.equal(state.currentSkillName, name);
        assert.equal(state.skillAttr, element);
        assert.equal(state.skillType, category === 'Magic Attack' ? 'magic_attack' : 'attack');
        assert.equal(state.skillInputKind, 'power');
        assert.equal(state.basePowerExpression, '');
        assert.equal(String(document.getElementById('comboCount').value), String(combo ?? 1));
        assert.equal(profile.rk_damage_skill_configs[1].currentSkillName, name);
        assert.equal(profile.rk_damage_skill_configs[1].basePower, power);
      }
      for (const [key, value] of Object.entries(manual)) assert.equal(state[key], value, `${id}/${key}`);
      assert.deepEqual(profile.rk_skill_simulation, beforeCounts, 'no new or old counter reset/growth');
      assert.deepEqual(profile.rk_pet_configs, beforePet, 'no personal mode/stat mutation');
    }
  }
  assert.ok(writes.length > 0, 'real snapshot path was exercised in memory');
  assert.ok(writes.every(write => ['rk_damage_view', 'rk_damage_skill_configs'].includes(write.key)));
});
