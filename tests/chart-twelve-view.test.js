'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../js/chart-workspace.js');
const BattleMath = require('../js/battle-math.js');
// Reuse the small DOM/Chart adapter directly, without evaluating a test prefix.
const { environment } = require('./chart-fixture.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
async function realStore() {
  const e = environment();
  let saved = {};
  e.context.RKData.getMonsters = () => e.pets;
  e.context.UserConfig = { init: async () => true, getObject: () => saved,
    patch: async (key, value) => { assert.equal(key, 'rk_chart_workspace'); saved = plain(value); return true; } };
  e.context.ChartWorkspace = createStore(e.context);
  await e.context.ChartWorkspace.init();
  e.page.test.setActive(true); e.page.test.bindFeatures(); await tick();
  return e;
}

test('real rendered datasets: every subset defaults to one; ALL offers twelve with only the selected curve visible', () => {
  const e = environment(), t = e.page.test; t.setActive(true);
  for (const mode of ['defense', 'attack']) for (const swapped of [false, true]) for (const attackType of ['attack', 'magic_attack'])
    for (const [iv, nature] of [[false, 0], [true, 0], [true, 1]])
      for (const defIV of [false, true]) for (const hpNature of [false, true]) for (const showAll of [false, true]) {
        e.state.skillType = attackType;
        Object.assign(t.view, { mode, attackType, axisSwapped: swapped, hpNature, showAll });
        t.view.overrides.atkIV[attackType] = iv; t.view.overrides.atkNature[attackType] = nature;
        t.view.overrides.defIV[attackType === 'attack' ? 'defense' : 'magic_defense'] = defIV;
        (mode === 'defense' ? t.renderDefenseChart : t.renderAttackChart)(e.element('defenseChart'), e.state);
        const rows = e.lastChart().data.datasets.filter(d => d.damageConfig);
        const full = showAll && iv && nature === 1 && defIV && hpNature;
        assert.equal(rows.length, full ? 12 : 1);
        assert.equal(rows.filter(d => d.hidden).length, full ? 11 : 0);
        assert.deepEqual(plain(rows.find(d => !d.hidden).damageConfig), { atkIV: iv, atkNature: nature, defIV, defNature: 0, hpNature });
        assert.deepEqual(plain(rows.at(-1).damageConfig), { atkIV: iv, atkNature: nature, defIV, defNature: 0, hpNature });
        assert.ok(rows.every(d => d.damageConfig.atkNature !== 2 && (d.damageConfig.atkIV || !d.damageConfig.atkNature)));
        if (full) {
          assert.equal(new Set(rows.map(d => JSON.stringify(d.damageConfig))).size, 12);
          assert.deepEqual(plain(rows[0].data), plain(rows[1].data), 'HP-only variants may legitimately overlap');
        }
      }
  e.page.onLeave();
});

test('actual view buttons delegate linked changes to store; right click cannot write negative nature', async () => {
  const e = await realStore(), t = e.page.test, store = e.context.ChartWorkspace;
  t.bindEvents();
  assert.deepEqual(plain(store.getState().controls), { atkIV: { attack: true, magic_attack: true }, atkNature: { attack: 0, magic_attack: 0 }, defIV: { defense: false, magic_defense: false }, hpNature: false, doubleLife: false });
  const click = async id => { e.element(id).handlers.click(); await tick(); };
  await click('chartAtkIVBtn'); assert.equal(store.getState().controls.atkIV.attack, false);
  await click('chartAtkNatureBtn'); assert.equal(store.getState().controls.atkIV.attack, true); assert.equal(store.getState().controls.atkNature.attack, 1);
  await click('chartAtkIVBtn'); assert.equal(store.getState().controls.atkNature.attack, 0);
  const before = plain(store.getState()); e.element('chartAtkNatureBtn').handlers.contextmenu({ preventDefault() {} }); await tick();
  assert.deepEqual(plain(store.getState()), before);
  await click('chartAtkNatureBtn'); await click('chartIVBtn'); await click('chartDoubleLifeBtn');
  assert.equal(e.lastChart().data.datasets.filter(d => d.damageConfig).length, 1);
  assert.equal(e.element('chartAllBtn').hidden, false);
  const controls = plain(store.getState());
  await click('chartAllBtn');
  assert.equal(t.view.showAll, true);
  assert.deepEqual(plain(store.getState()), controls, 'ALL does not change persisted workspace state');
  const rows = e.lastChart().data.datasets.filter(d => d.damageConfig);
  assert.equal(rows.length, 12);
  assert.equal(rows.filter(d => !d.hidden).length, 1);
  assert.deepEqual(plain(rows.find(d => !d.hidden).damageConfig), { atkIV: true, atkNature: 1, defIV: true, defNature: 0, hpNature: true });
  const legend = index => { const c = e.lastChart(); c.config.options.plugins.legend.onClick({}, { datasetIndex: index }, { chart: c }); };
  const visibleKeys = () => plain(e.lastChart().data.datasets.filter(d => d.damageConfig && !d.hidden).map(d => d.viewKey));
  legend(0); legend(11);
  assert.deepEqual(visibleKeys(), [rows[0].viewKey], 'can reveal a comparison and hide the selected curve');
  e.state.basePower++; t.renderChart();
  assert.deepEqual(visibleKeys(), [rows[0].viewKey], 'numeric power changes preserve both shown and hidden choices');
  for (const event of ['appthemechange', 'appfontchange']) {
    for (const callback of e.events.get(event)) callback();
    assert.deepEqual(visibleKeys(), [rows[0].viewKey], event + ' preserves legend choices');
  }
  e.page.onLeave(); t.setActive(true); t.bindFeatures(); await tick(); t.renderChart();
  assert.equal(t.view.showAll, true);
  assert.deepEqual(visibleKeys(), [rows[0].viewKey], 'page reentry retains session ALL and legend state');
  legend(0); e.state.comboCount++; t.renderChart();
  assert.deepEqual(visibleKeys(), [], 'zero visible curves remains zero on numerical redraw');
  assert.equal(t.view.showAll, true, 'hiding every line does not leave ALL');
  await click('chartAllBtn');
  assert.equal(t.view.showAll, false);
  assert.equal(e.lastChart().data.datasets.filter(d => d.damageConfig && !d.hidden).length, 1);
  await click('chartAllBtn');
  assert.equal(e.lastChart().data.datasets.filter(d => d.damageConfig && !d.hidden).length, 1, 'reactivating ALL resets to the selected line');
  assert.equal(e.lastChart().data.datasets.filter(d => d.damageConfig).length, 12);
  assert.deepEqual(plain(store.getState()), controls, 'legend and lifecycle changes never write controls');
  await click('chartDoubleLifeBtn');
  assert.equal(t.view.showAll, false); assert.equal(e.element('chartAllBtn').hidden, true);
  await click('chartDoubleLifeBtn');
  assert.equal(t.view.showAll, false); assert.equal(e.element('chartAllBtn').hidden, false);
  assert.equal(e.lastChart().data.datasets.filter(d => d.damageConfig).length, 1);
  e.page.onLeave();
});

test('both attack sweep inputs preserve ALL shown/hidden choices through their actual input handlers', () => {
  const e = environment(), t = e.page.test; t.setActive(true); t.bindEvents();
  t.view.overrides.atkNature.attack = 1; t.view.hpNature = true;
  for (const axisSwapped of [false, true]) {
    Object.assign(t.view, { mode: 'attack', axisSwapped, showAll: true }); t.renderChart();
    const c = e.lastChart(), rows = c.data.datasets.filter(d => d.damageConfig);
    for (const datasetIndex of [0, 11]) c.config.options.plugins.legend.onClick({}, { datasetIndex }, { chart: c });
    const input = e.element('chartPowerInput'); input.value = axisSwapped ? '135' : '275'; input.handlers.input();
    assert.equal(t.view[axisSwapped ? 'qualification' : 'power'], axisSwapped ? 135 : 275);
    assert.equal(t.view.showAll, true);
    assert.equal(e.lastChart().data.datasets.filter(d => d.damageConfig).length, 12);
    assert.deepEqual(plain(e.lastChart().data.datasets.filter(d => d.damageConfig && !d.hidden).map(d => d.viewKey)), [rows[0].viewKey]);
  }
  e.page.onLeave();
});

test('defense mode has no fixed reference or crossing plugin, above and below the old reference', () => {
  const e = environment(), t = e.page.test; t.setActive(true);
  for (const basePower of [0, 600]) for (const showAll of [false, true]) {
    Object.assign(t.view, { hpNature: true, showAll }); t.view.overrides.atkNature.attack = 1;
    e.state.basePower = basePower; t.renderChart();
    const c = e.lastChart();
    assert.equal(c.data.datasets.some(d => d.reference), false);
    assert.deepEqual(plain(c.config.plugins.map(p => p.id)), ['favoriteAvatars']);
    assert.equal(c.data.datasets.filter(d => d.damageConfig).length, showAll ? 12 : 1);
    assert.equal(c.data.datasets.filter(d => d.damageConfig && !d.hidden).length, 1);
  }
  e.page.onLeave();
});

test('attack qualification/power modes retain actual target HP kill line and forward crossing labels', () => {
  const e = environment(), t = e.page.test; t.setActive(true);
  e.state.defPet = e.pets[2]; // Neutral target; enough power reaches actual HP in both sweeps.
  for (const axisSwapped of [false, true]) for (const attackType of ['attack', 'magic_attack']) for (const hpNature of [false, true]) {
    Object.assign(t.view, { mode: 'attack', axisSwapped, attackType, hpNature, power: 600, qualification: 200 });
    t.renderAttackChart(e.element('defenseChart'), e.state);
    const c = e.lastChart(), hp = e.context.RKData.getPetStat(e.state.defPet, 'hp', hpNature ? 1 : 0, true);
    const references = c.data.datasets.filter(d => d.reference);
    assert.equal(references.length, 1); assert.equal(references[0].label, `斩杀线(${hp})`);
    assert.ok(references[0].data.every(y => y === hp));
    const plugin = c.config.plugins.find(p => p.id === 'killLabel'); assert.ok(plugin);
    const text = [], row = c.data.datasets.find(d => d.damageConfig);
    const first = row.data.findIndex(y => y >= hp); assert.ok(first >= 0);
    c.ctx = { save() {}, restore() {}, strokeText() {}, fillText: value => text.push(value), beginPath() {}, arc() {}, fill() {} };
    c.getDatasetMeta = i => ({ hidden: c.data.datasets[i].hidden, data: c.data.labels.map((x, y) => ({ x, y })) });
    plugin.afterDatasetsDraw(c);
    assert.deepEqual(text, [`${axisSwapped ? '威力:' : '资质'}${c.data.labels[first]}`]);
    const referenceIndex = c.data.datasets.indexOf(references[0]);
    c.config.options.plugins.legend.onClick({}, { datasetIndex: referenceIndex }, { chart: c });
    t.renderAttackChart(e.element('defenseChart'), e.state);
    assert.equal(e.lastChart().data.datasets.find(d => d.reference).hidden, true, 'real kill line still supports legend memory');
  }
  Object.assign(t.view, { axisSwapped: false, power: 0 }); t.renderAttackChart(e.element('defenseChart'), e.state);
  assert.equal(e.lastChart().data.datasets.some(d => d.reference), false, 'unreachable target HP keeps previous no-reference behavior');
  e.page.onLeave();
});

test('ALL gating exits on each original control and re-enabling never auto-activates', async () => {
  const e = await realStore(), t = e.page.test, store = e.context.ChartWorkspace; t.bindEvents();
  for (const id of ['chartAtkIVBtn', 'chartAtkNatureBtn', 'chartIVBtn', 'chartDoubleLifeBtn']) {
    await store.setControls({ atkIV: { attack: true }, atkNature: { attack: 1 }, defIV: { defense: true }, hpNature: true });
    e.element('chartAllBtn').handlers.click(); assert.equal(t.view.showAll, true);
    e.element(id).handlers.click(); await tick();
    assert.equal(t.view.showAll, false, id); assert.equal(e.element('chartAllBtn').hidden, true, id);
    assert.equal(e.lastChart().data.datasets.filter(d => d.damageConfig).length, 1);
    await store.setControls({ atkIV: { attack: true }, atkNature: { attack: 1 }, defIV: { defense: true }, hpNature: true });
    assert.equal(t.view.showAll, false); assert.equal(e.element('chartAllBtn').hidden, false);
  }
  e.page.onLeave();
});

test('single/multi tooltip uses each visible HP configuration, accurate factor/combo and excludes references', () => {
  const e = environment(), t = e.page.test, pet = e.pets[2];
  for (const mode of ['defense', 'attack']) for (const level of [60, 99]) {
    Object.assign(e.state.atkPet, { level_configurable: true, default_level: level }); t.view.mode = mode;
    const context = t.operatingContext(e.state);
    const rows = [false, true].map((hpNature, i) => ({ shortLabel: 'curve-' + i, damageConfig: { atkIV: true, atkNature: 1, defIV: false, defNature: 0, hpNature } }));
    for (const row of rows) {
      const expected = e.math.operatingPoint(context, pet, row.damageConfig, e.context.RKData, BattleMath);
      const lines = e.math.tooltipLines(context, pet, [row], e.context.RKData, BattleMath);
      assert.equal(lines.length, 6); assert.ok(lines.every((line, i) => line.startsWith('①②③④⑤⑥'[i])));
      assert.ok(lines[5].includes(`÷ ${expected.hp} (`)); assert.ok(lines[5].includes((expected.damage / expected.hp * 100).toFixed(2) + '%'));
      assert.ok(lines[4].includes(`等级系数B[(1000 + 45 × ${level}) ÷ 4100]`));
      assert.match(lines[4], /⌊.*⌋(?: × \d+连击)? = \d+$/);
      assert.ok(lines[0].includes(`Lv${level}`));
      assert.ok(lines[0].includes(`${level} ÷ 100 + 0.5`));
      assert.equal(lines[4].includes('连击'), mode === 'defense');
      assert.doesNotMatch(lines.join(' '), /配置来源|剩余HP|能否扛住|坐标|以下数值/);
    }
    const chart = { data: { datasets: [...rows, { reference: true }, { type: 'scatter' }, { favoriteMarker: true }] }, isDatasetVisible: () => true };
    const visible = e.math.visibleDamageRows(chart), lines = e.math.tooltipLines(context, pet, visible, e.context.RKData, BattleMath);
    assert.equal(visible.length, 2); assert.equal(e.math.visibleDamageConfig(chart), null);
    assert.equal(lines.length, 2); assert.ok(lines.every(line => line.includes('⑥') && !/[①②③④⑤]/.test(line)));
    assert.match(lines[0], /✓个体&×性格/); assert.match(lines[1], /✓个体&✓性格/);
    chart.isDatasetVisible = i => i !== 0;
    assert.equal(e.math.visibleDamageConfig(chart).hpNature, true);
    chart.isDatasetVisible = i => i >= 2;
    assert.equal(e.math.tooltipLines(context, pet, e.math.visibleDamageRows(chart), e.context.RKData, BattleMath).length, 0);
  }
});

test('single tooltip exactly follows the user six-step wording and hides zero modifiers', () => {
  const e = environment();
  const context = {mode:'defense',atkPet:{name:'黑猫巫师'},attackType:'magic_attack',skillAttr:'普',basePower:130,fixedBonus:0,percentBonus:0,buff:0,comboCount:1,sameType:1.25};
  const data = {getBaseStat:()=>124,getPetStat:(p,stat)=>stat==='hp'?411:207,getTypeEff:()=>1,getPetLevel:()=>60,getMonsterDisplayName:p=>p.name,getTypeZhFull:()=> '普通'};
  const rows = [{damageConfig:{atkIV:false,atkNature:0,defIV:false,defNature:0,hpNature:false}}];
  assert.deepEqual(Array.from(e.math.tooltipLines(context,{name:'水泡壳'},rows,data,BattleMath)), [
    '① 黑猫巫师魔攻（Lv60） = R((R((60 ÷ 100 + 0.5) × (124 + 0)) + 10) × 1) + 50 = 196 (×个体&×性格；R=四舍五入)',
    '② 水泡壳魔防 = 207 (×个体&×性格)',
    '③ 技能基础威力 = 130，技能属性 = 普通',
    '④ 技能最终威力 = 130 × 本系1.25 = 163',
    '⑤ 最终伤害 = ⌊163 × (196 ÷ 207) × 等级系数B[(1000 + 45 × 60) ÷ 4100]⌋ = 139',
    '⑥ 伤害占比 = 139 ÷ 411 (✓个体&×性格) = 33.82%'
  ]);
});

test('availability view blocks active 101 without markers, copy/import disabled; recovers at 100 and distinguishes zero/unavailable', async () => {
  const e = await realStore(), t = e.page.test, store = e.context.ChartWorkspace;
  e.pets.splice(0, e.pets.length, ...Array.from({ length: 100 }, (_, i) => ({ ...e.state.defPet, id: 1000 + i, evolution_stage: '高级形态', form_category: '主形态' })));
  e.state.basePower = 0; t.renderChart();
  await store.selectGroup('preset:Survivors'); t.renderChart();
  assert.equal(t.currentEntries().length, 100);
  assert.equal(e.element('chartGroupCopy').disabled, false);
  e.pets.push({ ...e.pets[0], id: 1100 }); t.renderChart();
  assert.equal(t.currentEntries().length, 0); assert.equal(e.element('chartGroupCopy').disabled, true);
  assert.match(e.element('chartFavoriteStatus').textContent, /不可斩杀精灵过多/);
  assert.ok(!e.lastChart().data.datasets.some(d => d.favoriteMarker));
  assert.throws(() => t.requirePreset('preset:Survivors'), /不可斩杀精灵过多/);
  await store.selectGroup('ungrouped'); e.element('chartGroupImportPreset').value = 'preset:Survivors'; t.renderChart();
  assert.equal(e.element('chartGroupImport').disabled, true);
  e.pets.pop(); t.renderChart(); assert.equal(e.element('chartGroupImport').disabled, false);
  assert.equal(t.presetAvailability('preset:Survivors').count, 100);
  e.state.basePower = 100000; t.renderChart(); assert.equal(t.presetAvailability('preset:Survivors').count, 0);
  e.state.atkPet = null; t.renderChart(); assert.equal(t.presetAvailability('preset:Survivors').disabled, true);
  assert.equal(t.presetAvailability('preset:Survivors').count, null);
  e.page.onLeave();
});

test('Favorites live readonly UI includes all valid stages, no personal configuration, imports snapshot', async () => {
  const e = await realStore(), t = e.page.test, store = e.context.ChartWorkspace;
  Object.assign(e.pets[0], { evolution_stage: '基础形态', hidden: true });
  Object.assign(e.pets[1], { evolution_stage: '高级形态', is_leader_form: true });
  e.set('rk_fav_pets', [1, 2, 1, 999999]); e.api.notify();
  await store.selectGroup('preset:Favorites'); t.renderChart();
  assert.deepEqual(plain(t.currentEntries().map(e => e.id)), [1, 2]);
  assert.equal(e.element('chartGroupImport').disabled, true); assert.equal(e.element('chartGroupRename').disabled, true);
  const before = plain(t.favoriteMarkers(e.state));
  e.set('rk_pet_configs', { 1: { iv: {}, nature: { hp: 2, defense: 2 } } });
  assert.deepEqual(plain(t.favoriteMarkers(e.state)), before);
  e.set('rk_fav_pets', [3, 2]); e.api.notify();
  assert.deepEqual(plain(t.currentEntries().map(e => e.id)), [3, 2]);
  assert.match(e.element('chartFavoriteGrid').innerHTML, /data-chart-favorite="3"/);
  await store.selectGroup('ungrouped'); await store.importPreset('preset:Favorites', 'ungrouped'); t.renderChart();
  assert.deepEqual(plain(t.currentEntries().map(e => e.id)), [3, 2]);
  e.set('rk_fav_pets', []); e.api.notify();
  assert.deepEqual(plain(t.currentEntries().map(e => e.id)), [3, 2], 'own imported copy stays unchanged');
  e.page.onLeave();
});
