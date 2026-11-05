'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { toLegacy, upgrade } = require('../js/catalog-data.js');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

// Only synthetic in-memory fixtures: no canonical data reads/writes or real profile.
const stdout = execFileSync('go', ['test', './internal/catalog', '-run', '^TestMonsterSeasonJSProjectionFixture$', '-count=1', '-v'], {
  cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024
});
const line = stdout.split(/\r?\n/).find(value => value.startsWith('MONSTER_SEASON_JS_FIXTURE='));
assert.ok(line, 'Go season projection fixture must succeed, not become empty data');
const fixtures = JSON.parse(line.slice('MONSTER_SEASON_JS_FIXTURE='.length));

function petdexRuntime(monsters = []) {
  const context = vm.createContext({
    window: {},
    RKData: { getMonsters: () => monsters },
    ListingUI: { sortMonsters: rows => rows, statHeaders: () => '' },
    CommonUI: { destroyWithin() {} }
  });
  const code = source('js/pages/petdex.js');
  const original = 'return { render, toggleTrait, toggleForm, showPetDetail };';
  assert.ok(code.includes(original));
  // Expose the existing private functions only in this test VM; no production API.
  vm.runInContext(code.replace(original, 'return { render, toggleTrait, toggleForm, showPetDetail, getSeason, getFilteredMonsters, state };'), context);
  return vm.runInContext('PetDexPage', context);
}

function captureInitialHTML(render) {
  let html;
  const stopAfterTemplate = new Error('stop after the actual initial template');
  const container = { set innerHTML(value) { html = value; throw stopAfterTemplate; } };
  assert.throws(() => render(container), error => error === stopAfterTemplate);
  return html;
}

test('monster season JS projection equals Go and does not force old season fields', () => {
  for (const fixture of fixtures) {
    const before = JSON.stringify(fixture.catalog);
    assert.deepEqual(toLegacy(fixture.catalog), fixture.legacy);
    assert.equal(JSON.stringify(fixture.catalog), before, 'projection mutated source');
    for (const row of toLegacy(fixture.catalog).monsters) {
      const m = fixture.catalog.monsters.find(m => m.id === row.id);
      assert.equal(Object.hasOwn(row, 'season'), !!m.season);
      if (m.season) assert.equal(row.season, m.season);
    }
  }
  for (const value of ['', null]) {
    const c = clone(fixtures[0].catalog); c.monsters[0].season = value;
    assert.equal(Object.hasOwn(toLegacy(c).monsters[0], 'season'), false);
  }
});

test('optional monster season validates like skill season and rejects legacy metadata override', () => {
  for (const value of [5, true, [], {}]) {
    for (const collection of ['monsters', 'skills']) {
      const c = clone(fixtures[0].catalog); c[collection][0].season = value;
      assert.throws(() => toLegacy(c), /invalid string season/);
    }
  }
  for (const extensions of [{ legacy: { season: 'S4' } }, { legacy_omit: ['season'] }]) {
    const c = clone(fixtures[1].catalog); c.monsters[0].extensions = extensions;
    assert.throws(() => toLegacy(c), /core field season/);
  }
});

test('old schema, unknown local data and future season strings are preserved without startup writes', () => {
  for (const version of [1, 2]) {
    const old = clone(fixtures[0].catalog);
    old.schema_version = version;
    old.monsters[0].future_local_field = { keep: ['unknown', 1] };
    if (version === 1) for (const m of old.monsters) delete m.evolution_members;
    const before = JSON.stringify(old);
    const current = upgrade(old);
    assert.equal(current.schema_version, 2);
    assert.equal(JSON.stringify(old), before);
    assert.equal(Object.hasOwn(current.monsters[0], 'season'), false);
    assert.deepEqual(current.monsters[0].future_local_field, old.monsters[0].future_local_field);
    current.monsters[0].season = 'S6';
    current.monsters[0].stats.hp = 111; // unrelated in-memory edit
    const serialized = JSON.parse(JSON.stringify(current));
    assert.equal(upgrade(serialized).monsters[0].season, 'S6');
    assert.equal(toLegacy(serialized).monsters[0].season, 'S6');
    assert.deepEqual(upgrade(serialized).monsters[0].future_local_field, old.monsters[0].future_local_field);
    const futureSchema = { ...old, schema_version: 3 };
    assert.throws(() => toLegacy(futureSchema), /unsupported schema_version/);
  }
});

test('PetDex prefers exact declared S1..S5 and leaves historical fallback boundaries unchanged', () => {
  const page = petdexRuntime();
  for (const season of ['S1', 'S2', 'S3', 'S4', 'S5']) {
    for (const dex_number of [0, 1, 348, 376, 443, 466, 467, 468, 469, 493, 999]) {
      assert.equal(page.getSeason({ dex_number, season }), season);
    }
  }
  const boundaries = [[0, 'S1'], [347, 'S1'], [348, 'S2'], [375, 'S2'], [376, 'S3'], [442, 'S3'], [443, 'S4'], [465, 'S4'], [466, 'S4'], [467, 'S1'], [468, 'S1'], [469, 'S1'], [493, 'S1'], [999, 'S1']];
  for (const [dex_number, fallback] of boundaries) {
    for (const season of [undefined, null, '', 'S6', 's5', ' S5 ', 'unknown', 5, true, []]) {
      const m = { dex_number, season }, before = JSON.stringify(m);
      assert.equal(page.getSeason(m), fallback);
      assert.equal(JSON.stringify(m), before, 'fallback changed future/unknown metadata');
    }
  }
});

test('PetDex season filtering is the existing union and keeps unknown dex out of S5', () => {
  const monsters = [
    { id: 1, dex_number: 467, season: 'S4' },
    { id: 2, dex_number: 468, season: 'S4' },
    { id: 3, dex_number: 469, season: 'S5' },
    { id: 4, dex_number: 493, season: 'S5' },
    { id: 5, dex_number: 470 },
    { id: 6, dex_number: 443 },
    { id: 7, dex_number: 471, season: 'S6' }
  ];
  const before = JSON.stringify(monsters);
  const page = petdexRuntime(monsters); page.state.activeForms.clear();
  const ids = () => Array.from(page.getFilteredMonsters(), m => m.id);
  assert.deepEqual(ids(), [1, 2, 3, 4, 5, 6, 7]);
  page.state.activeSeasons.add('S5'); assert.deepEqual(ids(), [3, 4]);
  page.state.activeSeasons.add('S4'); assert.deepEqual(ids(), [1, 2, 3, 4, 6]);
  page.state.activeSeasons.clear(); assert.deepEqual(ids(), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(JSON.stringify(monsters), before);
});

test('PetDex and Moves generate S1..S5 controls; Moves reuses unchanged season include/exclude filtering', () => {
  const dexHTML = captureInitialHTML(petdexRuntime().render);
  assert.deepEqual(Array.from(dexHTML.matchAll(/data-season="(S\d)"/g), match => match[1]), ['S1', 'S2', 'S3', 'S4', 'S5']);

  const moves = [
    { id: 1, season: 'S5' }, { id: 2, season: 'S4' }, { id: 3 }, { id: 4, season: 'S6' }
  ];
  const list = { innerHTML: '' };
  const context = vm.createContext({
    document: { getElementById: id => id === 'move-list-container' ? list : null },
    RKData: {
      getMoves: () => moves, getMoveName: mv => `move${mv.id}`, getMoveDesc: () => '',
      buildSkillCardHtml: options => `<card data-id="${options.moveId}"></card>`
    },
    CommonUI: { destroyWithin() {} }
  });
  // Use the actual shared filter implementation without unrelated startup/window hooks.
  const common = source('js/common.js');
  const start = common.indexOf('  const FilterExclusion = (function () {');
  const end = common.indexOf('  const SkillPicker = (function () {', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${common.slice(start, end)}\nCommonUI.FilterExclusion = FilterExclusion;`, context);
  const code = source('js/pages/moves.js');
  const original = 'return { render, toggleRefraction, removeMultiSkill, showMoveDetail };';
  assert.ok(code.includes(original));
  vm.runInContext(code.replace(original, 'return { render, toggleRefraction, removeMultiSkill, showMoveDetail, renderList, valueFilters };'), context);
  const page = vm.runInContext('MovesPage', context);
  const movesHTML = captureInitialHTML(page.render);
  assert.deepEqual(Array.from(movesHTML.matchAll(/data-filter-season="(S\d)"/g), match => match[1]), ['S1', 'S2', 'S3', 'S4', 'S5']);
  const ids = () => { page.renderList(); return Array.from(list.innerHTML.matchAll(/data-id="(\d+)"/g), match => Number(match[1])); };
  assert.deepEqual(ids(), [1, 2, 3, 4]);
  const filter = context.CommonUI.FilterExclusion;
  filter.toggle(page.valueFilters, 'season', 'S5'); assert.deepEqual(ids(), [1]);
  filter.toggle(page.valueFilters, 'season', 'S4'); assert.deepEqual(ids(), [1, 2]);
  filter.toggle(page.valueFilters, 'season', 'S5', true); assert.deepEqual(ids(), [2]);
  filter.toggle(page.valueFilters, 'season', 'S4'); assert.deepEqual(ids(), [2, 3, 4]);
});
