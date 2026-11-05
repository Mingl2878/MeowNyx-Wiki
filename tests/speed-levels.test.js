'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../js/battle-math');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const variants = { negNature: [false, 2], base: [false, 0], iv: [true, 0], ivNature: [true, 1] };
const levels = [1, 9, 19, 29, 39, 49, 59, 69, 79, 89, 99];
const expectedStat = (base, iv, nature, level) => Math.round((Math.round((level + 50) * (base + (iv ? 30 : 0)) / 100) + 10) * (nature === 1 ? 1.2 : nature === 2 ? .9 : 1)) + 50;
const { runtime, fixtures, fixturePet } = require('./speed-levels-fixture.cjs');
const cells = row => Object.fromEntries(row.querySelectorAll('[data-col]').map(cell => [cell.dataset.col, cell]));
const value = cell => Number(cell.textContent);
function highlighted(r, key, col) {
  const rows = r.rows.filter(row => row.className === 'tier-highlight'); assert.equal(rows.length, 1); assert.equal(rows[0].dataset.rowKey, key);
  const selected = Object.values(cells(rows[0])).filter(cell => cell.className.includes('tier-selected'));
  assert.deepEqual(selected.map(cell => cell.dataset.col), col ? [col] : []);
}

test('one stable species row and full legacy grid: both directions, boundaries, source immutable', () => {
  const pets = fixtures(), before = plain(pets), r = runtime(pets), row = r.row(), lower = r.button(-1), upper = r.button(1);
  assert.deepEqual(r.rows.map(row => row.dataset.rowKey), ['103:89', 'pet:619', '70:99', '70:60']);
  assert.equal(row.querySelector('.speed-row-label').textContent, '70 · Lv99');
  assert.equal(lower.textContent, '<'); assert.equal(upper.textContent, '>'); assert.ok(upper.disabled); assert.ok(!lower.disabled);
  for (const level of [...levels].reverse().concat(levels)) {
    r.level(level); assert.equal(r.row(), row); assert.equal(r.button(-1), lower); assert.equal(r.button(1), upper);
    assert.equal(row.dataset.level, String(level)); assert.equal(row.querySelector('.speed-row-label').textContent, `70 · Lv${level}`);
    assert.equal(r.rows.filter(row => row.dataset.rowKey === 'pet:619').length, 1);
    assert.deepEqual(r.pools().get('pet:619'), [619]); assert.ok(!r.pools().get('70:60').includes(619)); assert.deepEqual(r.pools().get('70:99'), [802]);
    assert.equal(lower.disabled, level === 1); assert.equal(upper.disabled, level === 99);
  }
  upper.click(); assert.equal(r.api.getState().mingSpeedLevel, 99);
  r.level(1); lower.click(); assert.equal(r.api.getState().mingSpeedLevel, 1);
  assert.equal(pets.filter(pet => pet.id === 619).length, 1); assert.deepEqual(plain(pets), before); assert.equal(r.writes.length, 0);
  assert.equal(r.api.levelRows([70], [...pets, pets[2]]).filter(row => row.key === 'pet:619').length, 1);
});

test('619 identity is not a name/default/config; same speed/level60 never shares its species pool', () => {
  const pets = [fixturePet(619, '改名仍同ID', 73, { default_level: 43, level_configurable: true }), fixturePet(900, '冥古龙', 70)];
  const r = runtime(pets); assert.equal(r.row().dataset.level, '99'); assert.equal(r.search.renderItem(pets[0]), '速度资质 73 · Lv99');
  r.search.onSelect(pets[0]); highlighted(r, 'pet:619', null); assert.deepEqual(r.pools().get('70:60'), [900]);
  assert.equal(runtime([fixturePet(619, '隐藏', 70, { hidden: true })]).rows.length, 0);
  const ordinary = runtime(); ordinary.api.getState().mingSpeedLevel = 60; ordinary.api.renderTierTable();
  assert.equal(ordinary.row().querySelector('.speed-row-label').textContent, '70 · Lv60');
  assert.deepEqual(ordinary.pools().get('pet:619'), [619]); assert.ok(!ordinary.pools().get('70:60').includes(619));
  ordinary.click('pet:619', 'iv'); highlighted(ordinary, 'pet:619', 'iv');
  ordinary.click('70:60', 'iv'); highlighted(ordinary, '70:60', 'iv');
  ordinary.step(-1); assert.equal(ordinary.row().dataset.level, '59'); highlighted(ordinary, '70:60', 'iv');
  ordinary.api.getState().mingSpeedLevel = 60; ordinary.api.renderTierTable(); ordinary.step(1); assert.equal(ordinary.row().dataset.level, '69');
});

test('all grid levels and all IV/nature columns recompute bonuses and comparisons against separate ordinary/generic pools', () => {
  const r = runtime(), state = r.api.getState(); r.node('tier-negnature-btn').click();
  r.click('pet:619', 'iv');
  for (const level of [...levels].reverse()) {
    r.level(level); highlighted(r, 'pet:619', state.selectedCol);
    for (const iv of [false, true]) for (const nature of [0, 1, 2]) assert.equal(r.api.calcSpeedStat(70, iv, nature, level), expectedStat(70, iv, nature, level));
    for (const selectedCol of [null, ...Object.keys(variants)]) for (const [fixed, percent] of [[0, 0], [-20, 20], [30, 50], [130, -50], [.5, 12.5]]) {
      Object.assign(state, { selectedCol, fixed, percent }); r.api.renderTierTable(); highlighted(r, 'pet:619', selectedCol);
      for (const row of r.rows) for (const [col, [iv, nature]] of Object.entries(variants)) {
        const regular = expectedStat(Number(row.dataset.baseSpeed), iv, nature, Number(row.dataset.level));
        const own = row.dataset.rowKey === 'pet:619', apply = own && (!selectedCol || selectedCol === col), cell = cells(row)[col];
        assert.equal(value(cell), apply ? Math.round((regular + fixed) * (100 + percent) / 100) : regular, `${level}/${selectedCol}/${fixed}/${percent}/${row.dataset.rowKey}/${col}`);
        if (selectedCol) {
          const [selIV, selNature] = variants[selectedCol], threshold = Math.round((expectedStat(70, selIV, selNature, level) + fixed) * (100 + percent) / 100);
          const left = Object.keys(variants).indexOf(col) < Object.keys(variants).indexOf(selectedCol);
          assert.equal(cell.className.includes('tier-grayed'), own ? col !== selectedCol && (left || regular < threshold) : regular < threshold);
          assert.equal(cell.getAttribute('aria-pressed'), String(own && col === selectedCol));
        }
      }
    }
  }
  assert.equal(r.writes.length, 0); assert.ok(r.damageReads.length); assert.ok(r.damageReads.every(key => key === 'searchedPets'));
});

test('real delegated events preserve selected column, row/cell/button identity and keyboard focus without bubbling', () => {
  const r = runtime(), row = r.row(), cell = cells(row).iv;
  let bubbles = 0; for (const type of ['click', 'keydown', 'keyup']) r.container.addEventListener(type, () => bubbles++);
  assert.equal(cell.getAttribute('role'), 'button'); assert.equal(cell.getAttribute('tabindex'), '0');
  r.press(cell, 'Enter'); highlighted(r, 'pet:619', 'iv'); const baseline = bubbles;
  const lower = r.button(-1); lower.focus();
  for (const key of ['Enter', ' ']) {
    const previous = Number(row.dataset.level), events = r.press(lower, key);
    assert.equal(events.down.defaultPrevented, false, 'native level-button activation must not be canceled');
    assert.ok(events.down.cancelBubble && events.up.cancelBubble); assert.equal(bubbles, baseline);
    assert.equal(Number(row.dataset.level), previous - 10, 'one native activation advances exactly once');
    assert.equal(r.doc.activeElement, lower); highlighted(r, 'pet:619', 'iv'); assert.equal(cells(row).iv, cell);
  }
  r.node('tier-fixed').value = '30'; r.node('tier-fixed').dispatch('input');
  r.node('tier-percent').value = '20'; r.node('tier-percent').dispatch('input');
  r.api.renderTierTable(); assert.equal(r.doc.activeElement, lower); assert.equal(r.row(), row); highlighted(r, 'pet:619', 'iv');
  r.level(1); assert.equal(r.doc.activeElement, r.button(1), 'disabled boundary returns focus to enabled direction');
  assert.equal(value(cells(row).iv), B.basePower(B.statFromBase(70, 'speed', 0, true, 1), 30, 20));
  r.press(r.button(1), ' '); assert.equal(row.dataset.level, '9'); highlighted(r, 'pet:619', 'iv');
  r.press(cell, ' '); assert.equal(r.api.getState().selectedCol, null); assert.equal(r.api.getState().selectedRowKey, null);
  assert.equal(r.writes.length, 0);
});

test('search, controls, reentry retain page-only level; fresh runtime defaults99 and never reads/writes personal or damage level stores', () => {
  for (const userConfig of [false, true]) {
    const memory = new Map([['rk_damage_levels', '{"619":{"manual":43}}'], ['rk_speed_view', '{"mingSpeedLevel":1}'], ['rk_pet_configs', '{"619":{"level":9}}']]);
    const r = runtime(fixtures(), memory, userConfig), state = r.api.getState(), pet = r.pets.find(p => p.id === 619);
    r.search.onSelect(pet); highlighted(r, 'pet:619', null); r.click('pet:619', 'ivNature');
    r.level(59); highlighted(r, 'pet:619', 'ivNature');
    r.node('tier-iv-btn').click(); r.node('tier-monsters-btn').click(); highlighted(r, 'pet:619', 'ivNature');
    assert.equal(r.row().dataset.level, '59'); assert.equal(r.api.getLayout().rowPets.length, 0);
    r.node('tier-nature-btn').click(); highlighted(r, 'pet:619', null); r.node('tier-nature-btn').click(); r.node('tier-monsters-btn').click();
    r.search.onSelect(r.pets[0]); highlighted(r, '70:60', null); r.step(-1); highlighted(r, '70:60', null);
    assert.deepEqual(r.pools().get('pet:619'), [619]); r.search.onSelect(pet); highlighted(r, 'pet:619', null); assert.equal(state.mingSpeedLevel, 49);
    r.click('70:60', 'ivNature'); highlighted(r, 'pet:619', 'ivNature');
    r.api.onLeave(); r.api.render(r.container); highlighted(r, 'pet:619', 'ivNature'); assert.equal(r.row().dataset.level, '49');
    r.search.onInput(''); r.api.renderTierTable(); assert.equal(r.rows.filter(row => row.className === 'tier-highlight').length, 0);
    r.search.onInput('冥古龙'); r.api.renderTierTable(); highlighted(r, 'pet:619', null); assert.equal(r.search.renderItem(pet), '速度资质 70 · Lv49');
    const writeCount = r.writes.length; r.step(1); r.api.onLeave(); r.api.render(r.container); assert.equal(r.writes.length, writeCount);
    assert.ok(r.writes.every(key => ['rk_speed_pet_priority', 'rk_speed_form_overrides'].includes(key)));
    assert.equal(memory.get('rk_damage_levels'), '{"619":{"manual":43}}'); assert.equal(memory.get('rk_pet_configs'), '{"619":{"level":9}}');
    const fresh = runtime(fixtures(), memory, userConfig); assert.equal(fresh.row().dataset.level, '99'); assert.equal(fresh.api.getState().selectedRowKey, null); assert.equal(fresh.api.getState().search, '');
    assert.equal(r.data.getPetLevel(pet), 99, 'shared species level remains untouched');
  }
});

test('ordinary search insertion/history/form override remain independent of Ming level and retained rows', () => {
  const r = runtime(), ming = r.row(); assert.deepEqual(r.pools().get('70:60'), [2, 1, 3]);
  r.level(19); r.search.onSelect(r.pets.find(p => p.id === 801)); highlighted(r, '33:60', null); assert.deepEqual(r.pools().get('33:60'), [801]);
  r.search.onSelect(r.pets.find(p => p.id === 4)); highlighted(r, '70:60', null); assert.deepEqual(r.pools().get('70:60'), [4, 2, 1]);
  assert.equal(r.row('33:60'), undefined); assert.equal(r.row(), ming); assert.equal(ming.dataset.level, '19'); assert.deepEqual(r.pools().get('pet:619'), [619]);
});

test('Ming row stays between105 and100 at every level without changing its base, selected identity or ordinary ordering', () => {
  const pets = [...fixtures(), fixturePet(810, '上锚点', 105), fixturePet(811, '下锚点', 100), fixturePet(812, '高速', 130)];
  const before = plain(pets), r = runtime(pets), row = r.row(), initialKeys = r.rows.map(row => row.dataset.rowKey);
  r.click('pet:619', 'iv');
  for (const level of [...levels].reverse().concat(levels)) {
    r.level(level);
    const keys = r.rows.map(row => row.dataset.rowKey), index = keys.indexOf('pet:619');
    assert.deepEqual(keys, initialKeys); assert.ok(keys.indexOf('105:60') < index && index < keys.indexOf('100:60'));
    assert.equal(r.row(), row); assert.equal(row.dataset.baseSpeed, '70'); highlighted(r, 'pet:619', 'iv');
    assert.equal(r.api.getState().selectedSpeed, 70); assert.equal(r.api.getState().selectedLevel, level);
    assert.equal(value(cells(row).iv), expectedStat(70, true, 0, level));
  }
  assert.deepEqual(plain(pets), before); assert.equal(r.writes.length, 0);
});

test('default tiers exclude49/44/40 but keep50/92; explicit slow searches inject their real rows and clear removes them immediately', () => {
  const slow = [49, 44, 40, 45, 33].map((spd, i) => fixturePet(820 + i, `低速${spd}`, spd, { evolution_stage: '初级形态' }));
  const r = runtime([...fixtures(), ...slow, fixturePet(825, '保留50', 50), fixturePet(826, '保留92', 92)]);
  const defaults = r.rows.map(row => row.dataset.rowKey); assert.ok(defaults.includes('50:60')); assert.ok(defaults.includes('92:60'));
  for (const pet of slow) assert.ok(!r.row(`${pet.base_spd}:60`));
  r.level(19); const ming = r.row();
  for (const pet of slow) {
    r.search.onSelect(pet); const key = `${pet.base_spd}:60`; highlighted(r, key, null);
    assert.deepEqual(r.pools().get(key), [pet.id]); assert.equal(value(cells(r.row(key)).base), expectedStat(pet.base_spd, false, 0, 60));
    assert.equal(r.row(), ming); assert.equal(ming.dataset.level, '19');
    r.search.onInput(''); // No artificial render: this is the real clear callback.
    assert.equal(r.row(key), undefined); assert.deepEqual(r.rows.map(row => row.dataset.rowKey), defaults);
  }
});

test('shared leader API filters once per render before history/search injection and retains independent form overrides', () => {
  const pets = [...fixtures(),
    fixturePet(13, '火神', 130), fixturePet(14, '烈火战神', 130, { evolution_stage: '首领形态', is_leader_form: true, leader_of_id: 13 }),
    fixturePet(30, '无关同速甲', 130), fixturePet(31, '无关同速乙', 130),
    fixturePet(356, '爵士鹿', 120), fixturePet(357, '波普鹿', 125, { evolution_stage: '首领形态', leader_of_id: 356 }),
    fixturePet(8, '魔力猫', 55), fixturePet(10, '武斗酷猫', 135, { evolution_stage: '首领形态', leader_of_id: 8 }),
    fixturePet(70, '叮叮恶魔', 105), fixturePet(71, '恶魔男爵', 120, { evolution_stage: '首领形态', leader_of_id: 70 }),
    fixturePet(32, '确认首领非特殊名称', 95, { evolution_stage: '待定', is_leader_form: true }),
    fixturePet(33, '非高级非首领', 95, { evolution_stage: '初级形态' })
  ];
  let selected = 13; const calls = [];
  // Contract mock with an explicitly declared pair, not a second relationship implementation.
  const display = {
    visibleIds(all) { assert.equal(all, pets); calls.push(['visible', selected]); return new Set(all.map(p => p.id).filter(id => id !== (selected === 13 ? 14 : 13))); },
    preferredIds(all) { assert.equal(all, pets); calls.push(['preferred', selected]); return new Set([selected]); },
    recordSearch(pet, all) { assert.equal(all, pets); calls.push(['record', pet.id]); if ([13, 14].includes(pet.id)) selected = pet.id; }
  };
  const memory = new Map([['rk_speed_pet_priority', '{"130":[14,31,30]}']]), r = runtime(pets, memory, true, display);
  const countReads = () => calls.filter(c => c[0] === 'visible').length;
  assert.equal(countReads(), 1); assert.deepEqual(r.pools().get('130:60'), [31, 30, 13]);
  for (const [id, speed] of [[8, 55], [10, 135], [70, 105], [71, 120], [356, 120], [357, 125], [32, 95]]) assert.ok(r.pools().get(`${speed}:60`).includes(id));
  assert.ok(!r.pools().get('95:60').includes(33));
  const select = id => r.search.onSelect(pets.find(p => p.id === id));
  const expectFire = id => { const pool = r.pools().get('130:60'); assert.ok(pool.includes(id)); assert.ok(!pool.includes(id === 13 ? 14 : 13)); assert.ok(pool.includes(30) && pool.includes(31)); };
  let reads = countReads(); select(14); assert.equal(countReads(), reads + 1); assert.deepEqual(calls.slice(-3), [['record', 14], ['visible', 14], ['preferred', 14]]); expectFire(14);
  r.search.onInput(''); expectFire(14); r.api.onLeave(); r.api.render(r.container); expectFire(14);
  select(13); expectFire(13);
  // A newer explicit damage selection wins even with the older speed search still populated.
  display.recordSearch(pets.find(p => p.id === 14), pets); reads = countReads(); r.api.renderTierTable(); assert.equal(countReads(), reads + 1); expectFire(14);
  assert.equal(r.api.getState().search, '火神'); highlighted(r, '130:60', null);
  r.api.onLeave(); r.api.render(r.container); expectFire(14);
  select(4); assert.deepEqual(r.pools().get('70:60'), [4, 2, 1]); expectFire(14);
  r.search.onInput(''); assert.deepEqual(r.pools().get('70:60'), [2, 4, 1]); expectFire(14);
  select(3); assert.ok(r.pools().get('70:60').includes(3)); assert.ok(!r.pools().get('70:60').includes(4));
  assert.ok(r.writes.every(key => ['rk_speed_pet_priority', 'rk_speed_form_overrides'].includes(key)));
});

test('same-name form policy never hides the shared preferred exact ID, including duplicate display labels', () => {
  const pets = [
    fixturePet(40, '同名', 130, { form_category: '主形态', form: '原始' }),
    fixturePet(41, '同名', 130, { form_category: '变体形态', form: '首领', main_form_name: '原始', main_form_id: 40, leader_of_id: 40, evolution_stage: '首领形态' }),
    fixturePet(42, '同名', 130, { form_category: '变体形态', form: '独立', main_form_name: '原始', main_form_id: 40 })
  ];
  let selected = 40;
  const display = {
    visibleIds: all => new Set(all.map(p => p.id).filter(id => id !== (selected === 40 ? 41 : 40))),
    preferredIds: () => new Set([selected]),
    recordSearch(pet) { if ([40, 41].includes(pet.id)) selected = pet.id; }
  };
  const r = runtime(pets, new Map([['rk_speed_form_overrides', '{"同名|原始|130":42}']]), true, display);
  assert.deepEqual(r.pools().get('130:60'), [40, 42]);
  display.recordSearch(pets[1]); r.api.renderTierTable(); assert.deepEqual(r.pools().get('130:60'), [41, 42]);
  // A source may provide the same display label for distinct IDs; explicit selection must not find() the first.
  r.data.getMonsterDisplayName = () => '同名'; r.search.onSelect(pets[1]); assert.equal(r.api.getState().searchPetId, 41);
  assert.ok(r.pools().get('130:60').includes(41)); assert.ok(!r.pools().get('130:60').includes(40));
  r.search.onInput(''); display.recordSearch(pets[0]); r.api.renderTierTable(); assert.ok(r.pools().get('130:60').includes(40)); assert.ok(!r.pools().get('130:60').includes(41));
});

test('speed consumes the real shared module and patches form preferences without replaying stale leader choices', () => {
  for (const userConfig of [false, true]) {
    const pets = [...fixtures(), fixturePet(13, '火神', 130), fixturePet(14, '烈火战神', 130, { evolution_stage: '首领形态', leader_of_id: 13 })];
    const memory = new Map(), r = runtime(pets, memory, userConfig, 'shared'), key = 'rk_speed_form_overrides';
    const select = id => r.search.onSelect(pets.find(p => p.id === id));
    const firePool = runtime => runtime.pools().get('130:60');
    assert.deepEqual(firePool(r), [13]);
    select(13); r.display.recordSearch(pets.find(p => p.id === 14), pets); // actual module, same callback as the other page
    r.api.renderTierTable(); assert.deepEqual(firePool(r), [14]); assert.equal(r.api.getState().searchPetId, 13);
    select(4); r.search.onInput(''); assert.deepEqual(firePool(r), [14]);
    assert.equal(JSON.parse(memory.get(key))['leader:13:130'], 14, 'ordinary form patch must retain the newest shared selection');
    const fresh = runtime(pets, memory, userConfig, 'shared'); assert.deepEqual(firePool(fresh), [14]); assert.ok(fresh.pools().get('70:60').includes(4));
    select(3); assert.equal(JSON.parse(memory.get(key))['leader:13:130'], 14, 'clearing a form override patches only its own key');
    select(13); r.search.onInput(''); assert.deepEqual(firePool(r), [13]);
    assert.deepEqual(firePool(runtime(pets, memory, userConfig, 'shared')), [13]);
  }
});

test('selector CSS is speed-scoped and combined label includes controls for responsive sizing', () => {
  const css = read('css/team-speed-features.css');
  for (const selector of css.replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) if (/speed-level/.test(selector[1])) assert.ok(selector[1].trim().split(',').every(s => s.trim().startsWith('.speed-responsive ')));
  const r = runtime(); const measured = r.row().querySelector('.speed-column-label'); assert.equal(measured.querySelectorAll('.speed-level-step').length, 2);
  assert.equal(r.row('70:60').querySelectorAll('.speed-level-step').length, 0);
});
