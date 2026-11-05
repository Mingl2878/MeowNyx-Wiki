'use strict';
// Isolated synthetic catalogs only. No real data writes, Go subprocesses, network,
// backups, browser profiles or AppData; test resources live in OS temporary roots.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { readDataFile, readLegacy, readResource } = require('./catalog-read-fixture.cjs');
const { toLegacy } = require('../js/catalog-data.js');
const BattleMath = require('../js/battle-math.js');
const ROOT = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const legacyNames = { 'monsters.json': 'monsters', 'moves.json': 'moves', 'types.json': 'types', 'wiki_monster_data.json': 'wiki' };
function sample() {
  const pet = (id, name, type_ids, extra = {}) => ({ id, name, dex_number: id,
    stats: { hp: 100, phy_atk: 120, phy_def: 90, mag_atk: 80, mag_def: 95, speed: 110 },
    images: {}, type_ids, trait_id: 'fixture-trait', form: 'default', form_category: '无多形态', evolution_stage: '高级形态', ...extra });
  return { schema_version: 1,
    monsters: [pet(1, '隔离甲', [1], { aliases: ['夹具旧甲'] }), pet(2, '隔离乙', [2], { evolves_from_id: 1 })],
    skills: [{ id: 11, name: '隔离技能', description: '仅供读取测试的物理攻击。', category: 'Physical Attack', type_id: 1, power: 60, energy_cost: 2, season: 'S1' }],
    types: [{ id: 1, code: 'Normal', name: '普通', vulnerable_to: [], resistant_to: [] }, { id: 2, code: 'Water', name: '水', vulnerable_to: [1], resistant_to: [] }],
    traits: [{ id: 'fixture-trait', name: '隔离特性', description: '没有真实资料副作用。' }],
    learnsets: [{ monster_id: 1, mode: 'own', skills: [{ skill_id: 11, source: '默认' }] }, { monster_id: 2, mode: 'inherit', from_id: 1, skills: [] }],
    skill_rules: [{ skill_id: 11, base_combo: 2 }]
  };
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meownyx-readers-'));
  fs.mkdirSync(path.join(root, 'data'));
  t.after(() => { assert.ok(path.basename(root).startsWith('meownyx-readers-')); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function writeJSON(root, filename, value) { fs.writeFileSync(path.join(root, 'data', filename), JSON.stringify(value)); }
async function runtime(root, { codec = false, overrides = {} } = {}) {
  const requests = [];
  const context = vm.createContext({ console: { log() {}, error() {} }, window: {},
    fetch: async file => { requests.push(file); return { ok: true, json: async () => Object.hasOwn(overrides, file) ? overrides[file] : JSON.parse(readResource(root, file)) }; } });
  for (const file of ['js/battle-math.js', 'js/monster-identity.js', ...(codec ? ['js/catalog-data.js'] : []), 'js/data.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  const api = vm.runInContext('RKData', context); await api.init();
  return { api, context, requests };
}

test('canonical-only synthetic root supports all four compatibility views and real RKData math/identity/inheritance', async t => {
  const root = temporary(t), catalog = sample(), expected = toLegacy(catalog);
  writeJSON(root, 'catalog.json', catalog);
  const bytes = fs.readFileSync(path.join(root, 'data/catalog.json'), 'utf8');
  assert.deepEqual(readLegacy(root), expected);
  for (const [name, key] of Object.entries(legacyNames)) {
    assert.equal(fs.existsSync(path.join(root, 'data', name)), false);
    assert.deepEqual(readDataFile(root, name), expected[key]);
    assert.deepEqual(JSON.parse(readResource(root, 'data/' + name)), expected[key]);
  }
  for (const codec of [false, true]) {
    const { api, requests } = await runtime(root, { codec });
    assert.equal(api.getMonsterById(1).localized.zh.name, '隔离甲');
    assert.equal(api.getMonsterById(2).learnset_inherits_from_id, 1);
    assert.equal(api.getResolvedWikiData(2).skills[0].name, '隔离技能');
    assert.equal(api.getMoves()[0].base_combo, 2);
    assert.equal(api.getPetStat(api.getMonsterById(1), 'attack', 1, true), BattleMath.statFromBase(120, 'attack', 1, true));
    assert.equal(api.getTypeEff('Normal', 'Water'), 2);
    assert.deepEqual(requests.sort(), codec ? ['data/catalog.json'] : Object.keys(legacyNames).map(name => 'data/' + name).sort());
    assert.equal(fs.readFileSync(path.join(root, 'data/catalog.json'), 'utf8'), bytes);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')), ['catalog.json']);
});

test('repository canonical catalog serves real runtime while every retired data path is denied', async t => {
  const catalogFile = path.join(ROOT, 'data/catalog.json');
  assert.ok(fs.existsSync(catalogFile), 'migration must provide the single authoritative repository catalog');
  const before = fs.readFileSync(catalogFile, 'utf8');
  const denied = new Set(Object.keys(legacyNames).map(name => path.join(ROOT, 'data', name)));
  const originalRead = fs.readFileSync, attempts = [];
  fs.readFileSync = function (file, ...args) {
    if (typeof file === 'string' && denied.has(path.resolve(file))) { attempts.push(file); throw Error('Retired data path must not be read: ' + file); }
    return originalRead.call(this, file, ...args);
  };
  t.after(() => { fs.readFileSync = originalRead; });
  const views = readLegacy(ROOT);
  for (const codec of [false, true]) {
    const { api } = await runtime(ROOT, { codec });
    assert.equal(api.getMoves().length, views.moves.length);
    assert.equal(api.getMonsterById(434).id, 434);
    assert.ok(api.getResolvedWikiData(434).skills.some(skill => skill.name === '拖拉机'));
    assert.equal(api.getPetStat(api.getMonsterById(249), 'hp', 1, true), BattleMath.statFromBase(views.monsters.find(pet => pet.id === 249).base_hp, 'hp', 1, true));
  }
  assert.deepEqual(attempts, [], 'canonical reads must not inspect even an existing retired file');
  assert.equal(fs.readFileSync(catalogFile, 'utf8'), before);
});

test('canonical always wins over stale legacy neighbors; projected callers cannot mutate the source', t => {
  const root = temporary(t), catalog = sample(); writeJSON(root, 'catalog.json', catalog);
  for (const name of Object.keys(legacyNames)) writeJSON(root, name, { stale: 'must never win' });
  const first = readDataFile(root, 'monsters.json'); first[0].base_hp = -1;
  assert.equal(readDataFile(root, 'monsters.json')[0].base_hp, 100);
  assert.deepEqual(readLegacy(root), toLegacy(catalog));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'data/catalog.json'), 'utf8')), catalog);
});

test('invalid schema or broken canonical JSON must fail closed even beside valid legacy fixtures', async t => {
  const root = temporary(t), old = toLegacy(sample());
  for (const [name, key] of Object.entries(legacyNames)) writeJSON(root, name, old[key]);
  for (const bad of [{ ...sample(), schema_version: 99 }, { ...sample(), skills: [] }]) {
    writeJSON(root, 'catalog.json', bad);
    assert.throws(() => readLegacy(root), /CatalogData:/);
    for (const name of Object.keys(legacyNames)) assert.throws(() => readDataFile(root, name), /CatalogData:/);
    await assert.rejects(runtime(root), /CatalogData:/);
    await assert.rejects(runtime(root, { codec: true }), /CatalogData:/);
  }
  fs.writeFileSync(path.join(root, 'data/catalog.json'), '{');
  assert.throws(() => readLegacy(root), SyntaxError);
  await assert.rejects(runtime(root), SyntaxError);
});

test('legacy-only temporary fixtures and explicit null overrides preserve their original behavior', async t => {
  const root = temporary(t), old = toLegacy(sample());
  for (const [name, key] of Object.entries(legacyNames)) writeJSON(root, name, old[key]);
  assert.deepEqual(readLegacy(root), old);
  const normal = await runtime(root); assert.equal(normal.api.getResolvedWikiData(2).skills[0].name, '隔离技能');
  const alternate = clone(old.wiki); alternate['隔离甲'].skills = [{ name: '测试覆盖', source: '默认' }];
  const changed = await runtime(root, { overrides: { 'data/wiki_monster_data.json': alternate } });
  assert.equal(changed.api.getResolvedWikiData(1).skills[0].name, '测试覆盖');
  await assert.rejects(runtime(root, { overrides: { 'data/wiki_monster_data.json': null } }), /图鉴数据必须是对象/);
  assert.deepEqual(readLegacy(root), old, 'fixture override must not rewrite its source');
});

test('resource reader projects only exact four catalog paths, keeping unrelated text and JSON bytes', t => {
  const root = temporary(t); writeJSON(root, 'catalog.json', sample());
  fs.mkdirSync(path.join(root, 'js')); fs.mkdirSync(path.join(root, 'other'));
  const source = '\uFEFFconst fixture = "raw text, not JSON";\n';
  fs.writeFileSync(path.join(root, 'js/code.js'), source);
  fs.writeFileSync(path.join(root, 'data/other.json'), ' { "raw": true }\n');
  fs.writeFileSync(path.join(root, 'other/monsters.json'), '[ "not catalog data" ]\n');
  assert.equal(readResource(root, 'js/code.js'), source);
  assert.equal(readResource(root, 'data/other.json'), ' { "raw": true }\n');
  assert.equal(readResource(root, 'other/monsters.json'), '[ "not catalog data" ]\n');
  assert.equal(readResource(root, path.join(root, 'other/monsters.json')), '[ "not catalog data" ]\n');
  assert.throws(() => readResource(root, 'data/missing.json'), { code: 'ENOENT' });
});

test('Node test consumers no longer require retired real data JSON modules', () => {
  const files = fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js') || name.endsWith('fixture.cjs'));
  for (const filename of files) {
    const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    assert.doesNotMatch(source, /require\(['"]\.\.\/data\/(?:monsters|moves|types|wiki_monster_data)\.json['"]\)/, filename);
  }
});
