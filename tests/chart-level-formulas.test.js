'use strict';
// Real DamagePage level/menu/snapshot closures -> real ChartPage renderer, with
// in-memory DOM/Chart/profile adapters only. Never touches a running app/profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { environment, plain } = require('./chart-fixture.cjs');
const { harness } = require('./skill-simulation-fixture.cjs');
const { realData } = require('./damage-levels-ui-fixture.cjs');
const { createStore } = require('../js/chart-workspace.js');
const BattleMath = require('../js/battle-math.js');
const root = path.resolve(__dirname, '..');
const catalogBefore = fs.readFileSync(path.join(root, 'data/catalog.json'));
test.after(() => assert.deepEqual(fs.readFileSync(path.join(root, 'data/catalog.json')), catalogBefore, 'real catalog bytes unchanged'));
const tick = () => new Promise(setImmediate);
const configurations = [[false, 0], [true, 0], [true, 1]].flatMap(([atkIV, atkNature]) =>
  [false, true].flatMap(defIV => [false, true].map(hpNature => ({ atkIV, atkNature, defIV, defNature: 0, hpNature }))));

// Independent integer/rational oracles: no rounded displayed factor and no
// DamagePage personal-stat helper is allowed to stand in for the chart formula.
function stat(base, key, nature, iv, level) {
  const hp = key === 'hp', scaled = Math.floor(((hp ? 2 * level + 50 : level + 50) * (base + (iv ? 30 : 0)) + 50) / 100);
  return Math.floor(((scaled + (hp ? level + 10 : 10)) * (nature === 1 ? 120 : nature === 2 ? 90 : 100) + 50) / 100) + (hp ? 100 : 50);
}
function damage(attack, power, defense, level, effect = 1, combo = 1) {
  return Number(BigInt(power) * BigInt(attack) * BigInt(1000 + 45 * level) * BigInt(effect * 4) / (4100n * BigInt(defense) * 4n)) * combo;
}
function expected(h, context, pet, values, level, changes = {}) {
  const c = { ...context, ...changes }, d = h.RKData, atk = c.attackType, def = atk === 'attack' ? 'defense' : 'magic_defense';
  const defenderLevel = d.getPetLevel(pet), defense = stat(d.getBaseStat(pet, def), def, 0, values.defIV, defenderLevel);
  const hp = stat(d.getBaseStat(pet, 'hp'), 'hp', values.hpNature ? 1 : 0, true, defenderLevel);
  const attack = stat(c.mode === 'defense' ? d.getBaseStat(c.atkPet, atk) : c.qualification, atk, values.atkNature, values.atkIV, level);
  const power = c.mode === 'defense' ? BattleMath.finalPower(c.basePower, c.fixedBonus, c.percentBonus, c.sameType, 1, c.buff)
    : BattleMath.finalPower(c.power, 0, 0, c.sameType);
  const effect = d.getTypeEff(c.skillAttr, pet.main_type?.name || '', pet.sub_type?.name || '');
  return { attack, defense, hp, power, effect, damage: damage(attack, power, defense, level, effect, c.mode === 'defense' ? c.comboCount : 1) };
}

async function joined(id = 623) {
  const data = await realData(), catalog = plain(data.getMonsters());
  const h = harness({ data });
  // Add just the DOM primitives required by production level-menu callbacks.
  let layer;
  const enhance = element => {
    element.isConnected = true;
    element.removeAttribute ||= key => { delete element.attrs[key]; };
    element.removeEventListener ||= (key, handler) => { if (element.events[key] === handler) delete element.events[key]; };
    element.focus ||= () => { h.document.activeElement = element; };
    element.contains ||= child => element.children.includes(child);
    return element;
  };
  const get = h.document.getElementById.bind(h.document), create = h.document.createElement.bind(h.document);
  h.document.getElementById = key => key === 'battle-snapshot-panel' ? null : enhance(get(key));
  h.document.createElement = () => enhance(create());
  h.document.body = { appendChild(node) { layer = node; node.isConnected = true; } };
  h.CommonUI.positionAnchoredLayer = () => {};
  h.CommonUI.bindAnchoredLayer = (_owner, _layer, close) => () => close();
  for (const side of ['attacker', 'defender']) {
    h.document.getElementById(side + 'Types').insertAdjacentHTML = function (_where, html) { this.innerHTML += html; };
    h.page.searchBoxes[side] = { input: h.document.createElement(), setValue() {}, destroy() {} };
  }
  const radios = ['attack', 'magic_attack'].map(value => Object.assign(h.document.createElement(), { value }));
  const query = h.document.querySelectorAll.bind(h.document);
  h.document.querySelectorAll = selector => selector === 'input[name="skillType"]' ? radios : query(selector);
  h.page.bindEvents();
  h.choose = (side, petId) => h.page.selectPet(side, data.getMonsterById(petId), null, 'history');
  h.input = (key, value) => { const element = h.document.getElementById(key); element.value = String(value); element.fire('input'); };
  h.radio = type => radios.find(r => r.value === type).fire('change');
  h.mode = (side, mode) => {
    h.document.getElementById(side + '-level-mode').fire('click');
    const option = layer.children.find(node => node.dataset.mode === mode);
    assert.ok(option, 'real level menu exposes ' + mode); option.fire('click');
  };
  h.level = async (side, value) => {
    const index = h.page.CalcEngine.levelSteps(side).indexOf(value); assert.ok(index >= 0, `available level ${value}`);
    const slider = h.document.getElementById(side + '-level-slider'); slider.value = String(index); slider.fire('input'); await tick();
    assert.equal(h.page.CalcEngine.effectiveLevel(side), value);
  };
  h.choose('attacker', id); h.choose('defender', 619);
  for (const [key, value] of Object.entries({ basePower: 167, fixedBonus: 13, percentBonus: 17, buff: 21, comboCount: 3, defenseMod: 50, starMeteor: 4, finalPowerManual: 999 })) h.input(key, value);
  h.state.skillAttr = 'Dragon';
  const e = environment({ data: h.RKData, damage: h.page });
  e.set('rk_chart_fav_pets', [id, 249, 619, 623]);
  e.page.test.setActive(true);
  h.e = e;
  h.assertUnchanged = () => assert.deepEqual(plain(data.getMonsters()), catalog, 'real species stats/traits/types/levels unchanged');
  return h;
}

function checkRender(h, level, mode, swapped, type, all = false) {
  const e = h.e, t = e.page.test, v = t.view;
  Object.assign(v, { mode, axisSwapped: swapped, attackType: type, sameType: true, qualification: 131, power: 347, hpNature: all, showAll: all });
  v.overrides.atkIV[type] = true; v.overrides.atkNature[type] = all ? 1 : 0;
  v.overrides.defIV[type === 'attack' ? 'defense' : 'magic_defense'] = true;
  const saved = plain(h.profile), writes = h.writes.length, state = plain(h.state);
  t.renderChart();
  const c = e.lastChart(), context = t.operatingContext(h.state);
  assert.equal(context.attackerLevel, level, 'ChartPage carries effective battle attacker level');
  assert.ok(e.element('chartInfo').textContent.includes(`Lv${level}`), 'chart heading exposes effective attack level');
  const rows = c.data.datasets.filter(row => row.damageConfig);
  assert.equal(rows.length, all ? 12 : 1);
  assert.equal(rows.filter(row => !row.hidden).length, 1);
  if (all) assert.deepEqual(plain(rows.map(row => row.damageConfig)), configurations);
  for (const row of rows) {
    const expectedPoints = plain(c.data.labels).map(x => {
      const point = expected(h, context, h.state.defPet, row.damageConfig, level,
        mode === 'defense' ? {} : swapped ? { power: x } : { qualification: x });
      const defense = mode === 'defense' ? stat(x, type === 'attack' ? 'defense' : 'magic_defense', 0, row.damageConfig.defIV, h.RKData.getPetLevel(h.state.defPet)) : point.defense;
      return damage(point.attack, point.power, defense, level, mode === 'defense' ? 1 : point.effect, mode === 'defense' ? context.comboCount : 1);
    });
    assert.deepEqual(plain(row.data), expectedPoints, `${h.state.atkPet.id}/Lv${level}/${mode}/${swapped}/${type}/${row.viewKey}`);
    const operating = e.math.operatingPoint(context, h.state.defPet, row.damageConfig, h.RKData, BattleMath);
    const oracle = expected(h, context, h.state.defPet, row.damageConfig, level);
    for (const key of ['attack', 'defense', 'hp', 'power', 'effect', 'damage']) assert.equal(operating[key], oracle[key], key);
    assert.equal(operating.level, level);
  }
  const selected = rows.find(row => !row.hidden).damageConfig;
  const markers = t.favoriteMarkers(h.state);
  for (const marker of markers) {
    const point = expected(h, context, marker.pet, selected, level);
    for (const key of ['damage', 'defense', 'hp', 'effect']) assert.equal(marker[key], point[key], `marker ${marker.id}/${key}`);
    const survive = t.survivalContext()(marker.pet);
    assert.equal(survive.damage, point.damage); assert.equal(survive.hp, point.hp);
    if (mode === 'defense') {
      assert.equal(marker.y, point.effect ? point.hp / point.effect : null);
      const referenceDefense = stat(h.RKData.getBaseStat(marker.pet, type === 'attack' ? 'defense' : 'magic_defense'), type === 'attack' ? 'defense' : 'magic_defense', 0, selected.defIV, h.RKData.getPetLevel(h.state.defPet));
      assert.equal(marker.referenceDefense, referenceDefense);
      assert.equal(marker.referenceDamage, damage(point.attack, point.power, referenceDefense, level, 1, context.comboCount));
      assert.equal(marker.referenceRawDamage, BattleMath.normalDamageRaw(point.attack, point.power, referenceDefense, 1, level) * context.comboCount);
    } else if (point.effect > 0) {
      const at = x => expected(h, context, marker.pet, selected, level, swapped ? { power: x } : { qualification: x }).damage;
      assert.ok(at(marker.x) >= marker.hp, 'minimal integer kill succeeds');
      assert.ok(marker.x === 0 || at(marker.x - 1) < marker.hp, 'one below minimal integer kill fails');
      assert.equal(marker.y, point.hp);
    }
    const lines = t.markerTooltip(marker);
    assert.equal(lines.length, 6); assert.ok(lines.every((line, index) => line.startsWith('①②③④⑤⑥'[index])));
    assert.ok(lines[0].includes(`Lv${level}`), lines[0]);
    assert.ok(lines[0].includes(`${level} ÷ 100 + 0.5`), lines[0]);
    assert.ok(lines[0].includes('四舍五入'), lines[0]);
    const attackQ = mode === 'defense' ? h.RKData.getBaseStat(h.state.atkPet, type) : v.qualification;
    assert.ok(lines[0].includes(`R((R((${level} ÷ 100 + 0.5) × (${attackQ} + ${selected.atkIV ? 30 : 0})) + 10) × ${selected.atkNature === 1 ? 1.2 : 1}) + 50 = ${point.attack}`), lines[0]);
    assert.ok(lines[4].includes(`1000 + 45 × ${level}`), lines[4]);
    assert.ok(lines[4].includes('4100'), lines[4]);
    assert.match(lines[4], /⌊.*⌋(?: × \d+连击)? = \d+$/);
    assert.ok(lines[4].endsWith(`= ${point.damage}`), lines[4]);
    const combo = mode === 'defense' ? context.comboCount : 1;
    assert.equal(lines[4], `⑤ 最终伤害 = ⌊${point.power} × (${point.attack} ÷ ${point.defense}) × 等级系数B[(1000 + 45 × ${level}) ÷ 4100]${point.effect === 1 ? '' : ` × 克制${point.effect}`}⌋${combo === 1 ? '' : ` × ${combo}连击`} = ${point.damage}`);
    assert.ok(lines[5].includes(`${point.damage} ÷ ${point.hp}`));
  }
  const hpLine = c.data.datasets.find(row => row.reference);
  if (hpLine) assert.ok(hpLine.data.every(y => y === expected(h, context, h.state.defPet, selected, level).hp));
  const scatter = c.data.datasets.find(row => row.favoriteMarker);
  if (scatter?.data.length) {
    const raw = scatter.data[0];
    assert.deepEqual(plain(c.config.options.plugins.tooltip.callbacks.label({ dataset: scatter, raw })), plain(t.markerTooltip(raw)), 'actual chart tooltip callback uses the same effective-level formula');
  }
  assert.deepEqual(plain(h.profile), saved, 'chart did not save levels/profiles/skill configs');
  assert.equal(h.writes.length, writes); assert.deepEqual(plain(h.state), state, 'chart did not alter DamagePage state');
  return { chart: c, context, rows, markers };
}

for (const [id, wolfMode, levels] of [[623, null, [60, 62, 80, 99]], [619, null, [79, 99]],
  ...[595, 616, 617].flatMap(id => [[id, 'abu', [60, 62, 80, 99]], [id, 'ming', [79, 99]]])]) {
  test(`joined real levels ${id}/${wolfMode || 'native'} reach every curve/marker/tooltip path without changing defense defaults`, async () => {
    const h = await joined(id), e = h.e;
    if (wolfMode) h.mode('attacker', wolfMode);
    await h.level('defender', 9); // Deliberately not the defender species default99.
    for (const level of levels) {
      await h.level('attacker', level);
      for (const type of ['attack', 'magic_attack']) {
        h.radio(type);
        for (const [mode, swapped] of [['defense', false], ['attack', false], ['attack', true]]) checkRender(h, level, mode, swapped, type, level === levels.at(-1));
      }
    }
    h.assertUnchanged(); e.page.onLeave();
  });
}

test('ordinary battle snapshot level overrides BOTH stat and coefficient, never imports precise personal IV/nature', async () => {
  const h = await joined(488), e = h.e, a = h.page.CalcEngine;
  h.choose('defender', 488); h.state.skillAttr = 'Normal';
  const before = plain(h.profile), state = plain(h.state), writes = h.writes.length;
  const record = { sides: { me: { pets: [{ instanceId: 'a', monsterId: 488, level: 37 }] }, enemy: { pets: [{ instanceId: 'd', monsterId: 488, level: 9 }] } } };
  const original = plain(record);
  h.window.BattleRecordsClient = { getRecord: () => record, getRevision: () => 1, snapshotValues: p => ({ iv: { attack: 31, magic_attack: 17, defense: 11, magic_defense: 9, hp: 3 }, nature: { attack: 2, defense: 2, hp: 2 }, level: p.level }) };
  for (let pass = 0; pass < 2; pass++) {
    assert.ok(a.applyBattlePet('attacker', 'me', 'a')); assert.ok(a.applyBattlePet('defender', 'enemy', 'd'));
    for (const level of [37, 41, 69]) {
      await h.level('attacker', level);
      assert.equal(h.RKData.getPetLevel(h.state.atkPet), 60);
      for (const type of ['attack', 'magic_attack']) {
        h.radio(type);
        for (const [mode, swapped] of [['defense', false], ['attack', false], ['attack', true]]) {
          const { context, rows } = checkRender(h, level, mode, swapped, type, true);
          const values = rows.at(-1).damageConfig, point = expected(h, context, h.state.defPet, values, level);
          assert.notEqual(point.attack, expected(h, context, h.state.defPet, values, 60).attack, 'attack stat must change, not just coefficient');
          assert.notEqual(point.damage, damage(point.attack, point.power, point.defense, 60, point.effect, mode === 'defense' ? context.comboCount : 1), 'coefficient must change, not just attack stat');
          assert.notEqual(point.damage, expected(h, context, h.state.defPet, values, 60).damage, 'old default-level result differs');
        }
      }
    }
    assert.deepEqual(plain(h.profile), before); assert.equal(h.writes.length, writes);
    a.endBattleSimulation(); assert.deepEqual(plain(h.state), state);
  }
  assert.deepEqual(record, original); h.assertUnchanged(); e.page.onLeave();
});

test('real slider/menu reentry preserves ALL legend selection and multi-visible tooltip only lists each visible sixth step', async () => {
  const h = await joined(595), e = h.e, t = e.page.test;
  h.mode('attacker', 'abu'); await h.level('attacker', 80); h.radio('attack');
  let { chart, rows } = checkRender(h, 80, 'defense', false, 'attack', true);
  const legend = (c, index) => c.config.options.plugins.legend.onClick({}, { datasetIndex: index }, { chart: c });
  legend(chart, 0); // two visible configurations with distinct HP nature
  let marker = t.favoriteMarkers(h.state)[0], lines = t.markerTooltip(marker);
  assert.equal(lines.length, 2); assert.ok(lines.every(line => line.startsWith('⑥') && !/[①②③④⑤]/.test(line)));
  for (const [index, row] of [rows[0], rows[11]].entries()) {
    const point = expected(h, t.operatingContext(h.state), marker.pet, row.damageConfig, 80);
    assert.ok(lines[index].includes(`${point.damage} ÷ ${point.hp}`));
  }
  legend(chart, 11); const key = rows[0].viewKey;
  const profile = plain(h.profile), writes = h.writes.length;
  for (const [mode, requested, actual] of [['abu', 99, 99], ['ming', 79, 79], ['ming', null, 99], ['abu', null, 60], ['abu', 80, 80]]) {
    h.mode('attacker', mode); if (requested !== null) await h.level('attacker', requested);
    e.page.onLeave(); t.setActive(true); t.renderChart(); chart = e.lastChart();
    assert.equal(t.view.showAll, true); assert.equal(t.operatingContext(h.state).attackerLevel, actual);
    assert.deepEqual(plain(chart.data.datasets.filter(row => row.damageConfig && !row.hidden).map(row => row.viewKey)), [key]);
    marker = t.favoriteMarkers(h.state)[0]; lines = t.markerTooltip(marker);
    assert.equal(lines.length, 6); assert.ok(lines[0].includes(`Lv${actual}`));
    const point = expected(h, t.operatingContext(h.state), marker.pet, chart.data.datasets[0].damageConfig, actual);
    assert.ok(lines[5].includes(`${point.damage} ÷ ${point.hp}`));
  }
  assert.deepEqual(plain(h.profile), profile, 'wolf menu/levels/chart never persist'); assert.equal(h.writes.length, writes);
  h.assertUnchanged(); e.page.onLeave();
});

test('dynamic Survivors preset recomputes real catalog membership from joined levels in all three chart modes without persisting derived IDs', async () => {
  const h = await joined(), e = h.e, t = e.page.test;
  const state = createStore({}).defaults(); state.activeGroupId = 'preset:Survivors';
  let chartWrites = 0;
  e.context.UserConfig = { getObject: () => ({ state }), patch: async () => { chartWrites++; throw Error('Unexpected chart persistence'); } };
  const store = e.context.ChartWorkspace = createStore(e.context); await store.init();
  const initial = plain(store.getState());
  const eligible = h.RKData.getMonsters().filter(p => !p.hidden && p.evolution_stage === '高级形态' && !p.is_leader_form && ['主形态', '无多形态'].includes(p.form_category));
  h.radio('attack');
  for (const [mode, swapped] of [['defense', false], ['attack', false], ['attack', true]]) {
    Object.assign(t.view, { mode, axisSwapped: swapped, attackType: 'attack', sameType: true, qualification: 131, hpNature: true });
    await h.level('attacker', 60);
    const values = t.variants()[0].values;
    const ids = level => eligible.filter(p => { const point = expected(h, t.operatingContext(h.state), p, values, level); return point.damage < point.hp; }).map(p => p.id);
    // Choose a real-data operating point with a nonempty <=100 live group;
    // no fixture species and no truncation of the preset population.
    for (let power = 50; power <= 3000; power += 25) {
      if (mode === 'defense') h.input('basePower', power); else t.view.power = power;
      if (ids(60).length <= 50) break;
    }
    const originalIds = ids(60); assert.ok(originalIds.length > 0 && originalIds.length <= 100);
    for (const level of [60, 99, 60]) {
      await h.level('attacker', level);
      const profile = plain(h.profile), writes = h.writes.length;
      t.renderChart();
      const expectedIds = ids(level), entries = store.getEntries().map(entry => entry.id);
      assert.deepEqual(plain(entries), expectedIds, `${mode}/${swapped}/Lv${level}`);
      assert.equal(store.getPresetAvailability('preset:Survivors').count, expectedIds.length);
      assert.deepEqual(plain(t.favoriteMarkers(h.state).map(marker => marker.id)), expectedIds);
      assert.equal(t.operatingContext(h.state).attackerLevel, level);
      if (level === 99) assert.notDeepEqual(expectedIds, originalIds, 'real level change must affect dynamic membership');
      assert.deepEqual(plain(h.profile), profile); assert.equal(h.writes.length, writes);
      assert.deepEqual(plain(store.getState()), initial, 'derived population never becomes a saved snapshot');
    }
  }
  assert.equal(chartWrites, 0); h.assertUnchanged(); e.page.onLeave();
});

test('legacy contexts fall back to species default; supplied attack level is normalized consistently', () => {
  const e = environment(), t = e.page.test, values = configurations[0];
  Object.assign(e.state.atkPet, { level_configurable: true, default_level: 99 });
  const context = t.operatingContext(e.state); delete context.attackerLevel;
  assert.equal(e.math.operatingPoint(context, e.state.defPet, values, e.context.RKData, BattleMath).level, 99);
  for (const [given, level] of [[37.49, 37], [41.5, 42], [0, 1], [120, 99], ['62', 62], [NaN, 60]]) {
    const point = e.math.operatingPoint({ ...context, attackerLevel: given }, e.state.defPet, values, e.context.RKData, BattleMath);
    assert.equal(point.level, level); assert.equal(point.attack, stat(e.state.atkPet.attack, 'attack', 0, false, level));
  }
});

test('legacy tiny data adapter without base access receives the effective level as stat argument five', () => {
  const e = environment(), context = e.page.test.operatingContext(e.state), calls = [];
  const data = { ...e.context.RKData }; delete data.getBaseStat;
  const statGetter = data.getPetStat;
  data.getPetStat = (...args) => { calls.push(args); return statGetter(...args); };
  context.attackerLevel = 37;
  const point = e.math.operatingPoint(context, e.state.defPet, configurations[0], data, BattleMath);
  assert.equal(point.attack, stat(e.state.atkPet.attack, 'attack', 0, false, 37));
  assert.equal(calls.find(args => args[0] === e.state.atkPet && args[1] === 'attack')[4], 37);
  assert.ok(calls.filter(args => args[0] === e.state.defPet).every(args => args.length === 4), 'defender default still belongs to its data adapter');
});

test('exact 37/41 boundary, type multiplier before floor and per-hit floor before combo survive tooltip expansion', () => {
  const e = environment(), pet = { name: 'Boundary', base: 100 }, values = configurations[0];
  const data = { getBaseStat: p => p.base, getPetLevel: () => 60, getPetStat: (p, key, nature, iv) => stat(p.base, key, nature, iv, 60), getTypeEff: () => 1, getMonsterDisplayName: p => p.name };
  const context = { mode: 'defense', atkPet: pet, attackerLevel: 60, attackType: 'attack', skillAttr: 'Normal', basePower: 41, fixedBonus: 0, percentBonus: 0, buff: 0, comboCount: 3, sameType: 1 };
  const rows = [{ damageConfig: values }];
  assert.equal(e.math.operatingPoint(context, pet, values, data, BattleMath).damage, 111, '41 × 37/41 exactly37 per hit');
  assert.ok(e.math.tooltipLines(context, pet, rows, data, BattleMath)[4].endsWith('= 111'));
  context.basePower = 37;
  assert.equal(e.math.operatingPoint(context, pet, values, data, BattleMath).damage, 99);
  assert.equal(Math.floor(37 * 37 / 41 * 3), 100, 'moving combo inside floor would wrongly produce100');
  data.getTypeEff = () => 2;
  context.basePower = 1;
  assert.equal(e.math.operatingPoint(context, pet, values, data, BattleMath).damage, 3, 'effect applied before per-hit floor');
  assert.notEqual(3, Math.floor(37 / 41) * 2 * 3);
  for (const [level, base] of [[8, 25], [69, 150]]) {
    const p = { ...pet, base }; context.atkPet = p; context.attackerLevel = level;
    const point = e.math.operatingPoint(context, pet, values, data, BattleMath);
    assert.equal(point.attack, stat(base, 'attack', 0, false, level), 'round half up before nature');
  }
});
