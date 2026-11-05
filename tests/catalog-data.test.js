'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { toLegacy, upgrade } = require('../js/catalog-data.js');
const { readLegacy, readDataFile } = require('../scripts/lib/catalog-data.js');
const root = path.resolve(__dirname, '..');

// Pure-Go migration and export, stdout only: no generated source files or real
// data writes. The optional bridge also works after legacy files are retired.
const stdout = execFileSync('go', ['test', './internal/catalog', '-run', '^TestEmitJSProjectionFixture$', '-count=1', '-v'], {
  cwd: root, encoding: 'utf8', maxBuffer: 48 * 1024 * 1024,
  env: { ...process.env, CATALOG_JS_FIXTURE: '1' }
});
const fixtureLine = stdout.split(/\r?\n/).find(line => line.startsWith('CATALOG_JS_FIXTURE='));
if (!fixtureLine) throw new Error('Go projection fixture bridge returned no fixture; conversion failure is not empty data');
const fixtures = JSON.parse(fixtureLine.slice('CATALOG_JS_FIXTURE='.length));
const clone = value => JSON.parse(JSON.stringify(value));
const { historicalMingulong } = require('./catalog-history-fixture.cjs');

function temporaryRoot(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meownyx-catalog-js-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'data'));
  return directory;
}
function writeJSON(directory, filename, value) {
  fs.writeFileSync(path.join(directory, 'data', filename), JSON.stringify(value), { flag: 'wx' });
}

test('JS projection equals Go ExportLegacy for full local and extended synthetic catalogs', () => {
  for (const fixture of fixtures) {
    const before = JSON.stringify(fixture.catalog);
    assert.deepEqual(toLegacy(fixture.catalog), fixture.legacy);
    assert.equal(JSON.stringify(fixture.catalog), before, 'projection mutated canonical catalog');
  }
});

test('unknown legacy JSON and source-ref fields survive without reserved-key confusion', () => {
  const catalog = clone(fixtures[1].catalog);
  catalog.monsters[0].extensions.legacy.local_metadata = { extensions: 'an ordinary historical value', constructor: { prototype: 'data' } };
  catalog.monsters[0].source_ref.future_key = { keep: true };
  const projected = toLegacy(catalog);
  assert.deepEqual(projected.monsters[0].local_metadata, catalog.monsters[0].extensions.legacy.local_metadata);
  assert.deepEqual(projected.monsters[0]._source_ref.future_key, { keep: true });
  assert.equal({}.polluted, undefined);
});

test('UMD exposes only the same read-only API in a browser context', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'js', 'catalog-data.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.CatalogData), ['toLegacy', 'upgrade']);
  const projected = context.CatalogData.toLegacy(fixtures[1].catalog);
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), fixtures[1].legacy);
});

test('projection preserves explicit identity, seasons, rules, nulls, aliases and image roles', () => {
  const { catalog, legacy } = fixtures[1];
  const result = toLegacy(catalog);
  assert.equal(result.monsters[0].id, 1);
  assert.equal(result.monsters[0]._source_ref.id, '9001');
  assert.deepEqual(result.monsters[0]._source_ref.revision, { v: 2 });
  assert.equal(result.moves[0].power, null);
  assert.equal(result.moves[1].power, 0);
  assert.equal(result.moves[1].season, 'S2');
  assert.equal(result.moves[1].base_combo, 2);
  assert.equal(result.moves[1].power_formula, 'speed_diff');
  assert.equal(result.moves[0].base_combo, null, 'old alt/counter hints must not generate rules');
  assert.equal(result.moves[0].alt_power_total, 999);
  assert.equal(result.monsters[0].image, '甲头像.png');
  assert.equal(result.wiki['小甲'].image, 'wiki/甲立绘.png');
  assert.equal(result.wiki['小乙'].image, '');
  assert.deepEqual(result.wiki['小甲'].aliases, ['旧甲名']);
  assert.deepEqual(result.wiki['小甲'].skills, legacy.wiki['小甲'].skills);
  assert.deepEqual(result.wiki['小甲'].skills.map(row => row.source), ['默认', '传说', '血脉', '血脉']);
  assert.equal(result.monsters[1].learnset_mode, 'inherit');
  assert.equal(result.monsters[1].learnset_inherits_from_id, 1);
  assert.ok(!('element' in result.wiki['小甲'].skills[0]));
  assert.deepEqual(result.wiki['小甲'].skills[0].extra, { 'a/b': {} });
  assert.equal({}.polluted, undefined);
  assert.ok(Object.hasOwn(result.monsters[0].unknown, '__proto__'));
  assert.deepEqual(result.monsters[0].unknown.__proto__, { polluted: true });
});

test('main form projection carries protected stable IDs rather than only form labels', () => {
  const c = clone(fixtures[0].catalog), result = toLegacy(c);
  for (const m of c.monsters) assert.equal(result.monsters.find(row => row.id === m.id).main_form_id, m.main_form_id || null);
  assert.equal(result.monsters.find(m => m.id === 50).main_form_id, 48);
  assert.equal(result.monsters.find(m => m.id === 53).main_form_id, 49);
  for (const extension of [{ legacy: { main_form_id: 999 } }, { legacy_omit: ['main_form_id'] }]) {
    const bad = clone(c); bad.monsters.find(m => m.id === 50).extensions = extension;
    assert.throws(() => toLegacy(bad), /CatalogData:/);
  }
});

test('winter aliases are bound to explicit IDs; historical placeholder keeps runtime-only None and Leader semantics', () => {
  const result = toLegacy(historicalMingulong(fixtures[0].catalog));
  assert.equal(result.types.filter(type => type.name === 'None').length, 0);
  assert.ok(result.types.some(type => type.name === 'Leader'));
  for (const [name, id] of [['雪绒鸟', 40], ['冬羽雀', 44], ['岚鸟', 48], ['霜翼领主', 49]]) {
    const row = result.wiki[`${name}（本来的样子）`];
    assert.equal(row.monster_id, id);
    assert.ok(row.aliases.includes(name));
    assert.ok(row.aliases.includes(`${name}（冬天的样子）`), 'confirmed rename retains the full historical form alias');
  }
  const placeholder = result.monsters.find(monster => monster.id === 619);
  assert.equal(placeholder.default_level, 99);
  assert.equal(placeholder.main_type.id, 8);
  assert.equal(placeholder.main_type.name, 'Dragon');
  assert.equal(placeholder.sub_type.id, 15);
  assert.equal(placeholder.sub_type.name, 'Ghost');
  assert.equal(placeholder.image, '');
  assert.equal(result.wiki['冥古龙'].image || '', '');
  assert.deepEqual(result.wiki['冥古龙'].skills, []);
});

test('Mingulong accepts complete legacy and approved stat tuples, never partial mixes or metadata guesses', () => {
  const approved = {hp:118,phy_atk:128,phy_def:81,mag_atk:42,mag_def:63,speed:70};
  const legacy = Object.fromEntries(Object.keys(approved).map(key => [key,100]));
  for (const stats of [legacy,approved]) {
    const c = historicalMingulong(fixtures[0].catalog), m = c.monsters.find(row => row.id === 619);
    Object.assign(m.stats,stats);
    const before=JSON.stringify(c), row=toLegacy(c).monsters.find(row=>row.id===619);
    assert.deepEqual([row.base_hp,row.base_phy_atk,row.base_phy_def,row.base_mag_atk,row.base_mag_def,row.base_spd],Object.values(stats));
    assert.equal(JSON.stringify(c),before);
    for (const key of Object.keys(stats)) {
      const bad=clone(c);bad.monsters.find(row=>row.id===619).stats[key]++;
      assert.throws(()=>toLegacy(bad),/monster 619 stats/);
    }
    for (const mutate of [m=>{m.default_level=89;},m=>{m.type_ids=[3];},m=>{m.images.avatar='guessed.png';}]) {
      const bad=clone(c);mutate(bad.monsters.find(row=>row.id===619));
      assert.throws(()=>toLegacy(bad),/monster 619 placeholder/);
    }
  }
  const mixed=historicalMingulong(fixtures[0].catalog), m=mixed.monsters.find(row=>row.id===619);
  Object.assign(m.stats,legacy,{speed:70});
  assert.throws(()=>toLegacy(mixed),/monster 619 stats/);
});

test('Mingulong keeps legacy None readable but only accepts ordered Dragon then Ghost as the approved dual type', () => {
  for (const ids of [[0],[8,15]]) {
    const c=historicalMingulong(fixtures[0].catalog);c.monsters.find(m=>m.id===619).type_ids=ids;
    const before=JSON.stringify(c), row=toLegacy(c).monsters.find(m=>m.id===619);
    assert.equal(row.main_type.id,ids[0]);
    if(ids.length===2){assert.equal(row.main_type.name,'Dragon');assert.equal(row.sub_type.id,15);assert.equal(row.sub_type.name,'Ghost');}
    else assert.equal(row.main_type.name,'None');
    assert.equal(JSON.stringify(c),before);
  }
  for (const ids of [[15,8],[8],[15],[8,8],[15,15],[0,8],[8,1],[8,15,1]]) {
    const c=historicalMingulong(fixtures[0].catalog);c.monsters.find(m=>m.id===619).type_ids=ids;
    assert.throws(()=>toLegacy(c));
  }
  const bad=historicalMingulong(fixtures[0].catalog);bad.monsters.find(m=>m.id===619).type_ids=[8,15];
  bad.types.find(t=>t.id===8).code='WrongDragon';
  assert.throws(()=>toLegacy(bad));
});

test('invalid schema, incomplete data and ambiguous references fail rather than project emptiness', () => {
  const modifications = [
    c => { c.schema_version = 3; }, c => { c.schema_version = 0; },
    c => { c.monsters = []; }, c => { c.skills = null; }, c => { c.types = []; }, c => { c.traits = []; },
    c => { c.learnsets[0].skills = null; }, c => { c.monsters[1].id = c.monsters[0].id; },
    c => { c.monsters[0].trait_id = 'missing'; }, c => { c.skills[0].type_id = 999; },
    c => { c.learnsets[0].skills[0].skill_id = 999; }, c => { c.learnsets[1].from_id = 999; },
    c => { c.monsters[0].evolves_from_id = 2; }, c => { c.learnsets[0].mode = 'inherit'; c.learnsets[0].from_id = 2; },
    c => { c.skills[0].power = -1; }, c => { delete c.skills[0].power; },
    c => { c.monsters[0].stats.hp = NaN; }, c => { c.monsters[0].images = null; },
    c => { c.monsters[0].source_ref.id = ''; }, c => { c.monsters[0].source_ref.extensions = { id: 'override' }; },
    c => { c.monsters[0].extensions.legacy.id = 999; },
    c => { c.learnsets[0].extensions.legacy_skills = { 999: { desc: 'bad index' } }; },
    c => { c.learnsets[0].extensions.legacy_skills = { 0: { name: 'wrong identity' } }; },
    c => { c.learnsets[0].extensions.legacy_skill_omit = { 0: ['name'] }; },
    c => { c.types[0].vulnerable_to = [999]; }
  ];
  for (const modify of modifications) {
    const catalog = clone(fixtures[1].catalog); modify(catalog);
    assert.throws(() => toLegacy(catalog), /CatalogData:/);
  }
  for (const value of [null, [], {}, 'catalog']) assert.throws(() => toLegacy(value), /CatalogData:/);
});

test('v1 upgrade is pure and once-only; v2 local lists are not graph families', () => {
  const old = clone(fixtures[2].catalog), before = JSON.stringify(old);
  assert.equal(old.schema_version, 1);
  const c = upgrade(old);
  assert.equal(JSON.stringify(old), before);
  assert.equal(c.schema_version, 2);
  assert.deepEqual(c.monsters.map(m => m.evolution_members), [[1, 2], [1, 2]]);
  c.monsters[0].evolution_members = [];
  c.monsters[1].evolution_members = [1]; // self is not mandatory
  c.monsters[1].leader_of_id = 1;
  delete c.monsters[1].evolves_from_id;
  assert.deepEqual(upgrade(c), c);
  const projected = toLegacy(c);
  assert.deepEqual(projected.monsters.map(m => m.evolution_members), [[], [1]]);
  assert.equal(projected.monsters[1].leader_of_id, 1);
  assert.equal(projected.monsters[1].evolves_from_id, null);
  assert.deepEqual(toLegacy(old), fixtures[2].legacy);
});

test('members and leader graph validation rejects unavailable data, not asymmetry or ordering', () => {
  const modifications = [
    c => { delete c.monsters[0].evolution_members; },
    c => { c.monsters[0].evolution_members = null; },
    c => { c.monsters[0].evolution_members = [1, 1]; },
    c => { c.monsters[0].evolution_members = [999]; },
    c => { c.monsters[1].evolution_members = []; },
    c => { c.monsters[0].leader_of_id = 1; },
    c => { c.monsters[0].leader_of_id = 999; },
    c => { c.monsters[1].leader_of_id = 1; },
    c => { c.monsters[0].leader_of_id = 2; c.monsters[1].leader_of_id = 1; delete c.monsters[1].evolves_from_id; },
    c => { c.monsters[0].extensions.legacy.evolution_members = []; },
    c => { c.monsters[0].extensions.legacy_omit = ['leader_of_id']; }
  ];
  for (const change of modifications) { const c = clone(fixtures[1].catalog); change(c); assert.throws(() => upgrade(c), /CatalogData:/); }
  for (const change of [c => { c.monsters[0].evolves_from_id = 2; }, c => { c.monsters[0].evolves_from_id = 999; }, c => { c.monsters[0].evolution_members = null; }]) {
    const c = clone(fixtures[2].catalog); change(c); assert.throws(() => upgrade(c), /CatalogData:/);
  }
  const c = clone(fixtures[1].catalog);
  c.monsters[0].evolution_members = [2]; c.monsters[1].evolution_members = [2, 1];
  assert.deepEqual(upgrade(c).monsters.map(m => m.evolution_members), [[2], [2, 1]]);
});

test('reader prefers canonical catalog and does not require a parallel legacy dataset', t => {
  const directory = temporaryRoot(t);
  writeJSON(directory, 'catalog.json', fixtures[1].catalog);
  assert.deepEqual(readLegacy(directory), fixtures[1].legacy);
  for (const [name, key] of [['monsters.json', 'monsters'], ['moves.json', 'moves'], ['types.json', 'types'], ['wiki_monster_data.json', 'wiki']]) {
    assert.deepEqual(readDataFile(directory, name), fixtures[1].legacy[key]);
    assert.deepEqual(readDataFile(directory, path.join(directory, 'data', name)), fixtures[1].legacy[key]);
  }
  writeJSON(directory, 'monsters.json', ['stale legacy must not win']);
  assert.deepEqual(readDataFile(directory, 'monsters.json'), fixtures[1].legacy.monsters);
  writeJSON(directory, 'other.json', { unrelated: true });
  assert.deepEqual(readDataFile(directory, 'other.json'), { unrelated: true });
  writeJSON(directory, 'constructor', { ordinary: 'JSON file' });
  assert.deepEqual(readDataFile(directory, 'constructor'), { ordinary: 'JSON file' });
});

test('reader falls back only when catalog is absent; it never hides invalid/future catalog', t => {
  const directory = temporaryRoot(t);
  for (const [name, key] of [['monsters.json', 'monsters'], ['moves.json', 'moves'], ['types.json', 'types'], ['wiki_monster_data.json', 'wiki']]) writeJSON(directory, name, fixtures[1].legacy[key]);
  assert.deepEqual(readLegacy(directory), fixtures[1].legacy);
  writeJSON(directory, 'catalog.json', { ...fixtures[1].catalog, schema_version: 3 });
  assert.throws(() => readLegacy(directory), /unsupported schema_version/);
  assert.throws(() => readDataFile(directory, 'monsters.json'), /unsupported schema_version/);
});

test('reader propagates malformed/missing file errors, with no writes or empty substitute', t => {
  const directory = temporaryRoot(t);
  assert.throws(() => readLegacy(directory), { code: 'ENOENT' });
  assert.throws(() => readDataFile(directory, 'not-present.json'), { code: 'ENOENT' });
  fs.writeFileSync(path.join(directory, 'data', 'catalog.json'), '{');
  assert.throws(() => readLegacy(directory), SyntaxError);
  assert.throws(() => readDataFile(directory, 'moves.json'), SyntaxError);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'data')), ['catalog.json']);
});
