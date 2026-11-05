'use strict';
// Pure local, post-migration fixtures: no official fetching, writes, profiles or AppData.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const MonsterIdentity = require('../js/monster-identity.js');
const { runtime } = require('./selection-search-fixture.cjs');
const source = fs.readFileSync(path.join(__dirname, '../js/data.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
// The 12 explicitly reviewed old identities; these are test evidence, not runtime mapping rules.
const reviewed = [
  [40, '雪绒鸟', '本来的样子', '雪绒鸟', '冬天的样子'],
  [44, '冬羽雀', '本来的样子', '冬羽雀', '冬天的样子'],
  [48, '岚鸟', '本来的样子', '岚鸟', '冬天的样子'],
  [49, '霜翼领主', '本来的样子', '霜翼领主', '冬天的样子'],
  [365, '香草甜甜', '樱桃饰品', '香草甜甜', 'Original'],
  [368, '圣代甜甜', '樱桃巧克力口味', '圣代甜甜', 'Original'],
  [512, '加油蟹', '两只海葵的样子', '加油蟹', 'Original'],
  [569, '黑化加尔', '黑化的样子', '黑化加尔', 'default'],
  [615, '新月鹭', 'default', '新月鸷', 'default'],
  [606, '月辉鹭', 'default', '月辉鸠', 'default'],
  [604, '月使鹭纳', 'default', '月使鸷纳', 'default'],
  [610, '玳龟', 'default', '斑鱼', 'default']
];
const display = (name, form) => form && !['default', 'Original'].includes(form) ? `${name}（${form}）` : name;
function fixture() {
  const monsters = [], wiki = {};
  function add(id, name, form, aliases, extra = {}) {
    const monster = { id, localized: { zh: { name } }, form, dex_number: id,
      learnset_mode: 'own', image: `portrait-${id}.png`, source_ref: { name: '不是搜索别名', source_id: `source-${id}` }, ...extra };
    monsters.push(monster);
    wiki[display(name, form)] = { monster_id: id, aliases, image: '', skills: [{ name: '保留技能', source: '传说' }] };
  }
  for (const [id, name, form, oldName, oldForm] of reviewed) add(id, name, form, [...new Set([oldName, display(oldName, oldForm)])]);
  add(8001, '岚鸟', '春天的样子', ['岚鸟（春季旧称）'], { main_form_name: '本来的样子', learnset_mode: 'inherit', learnset_inherits_from_id: 48 });
  add(8002, '派生鸟', 'default', ['子旧名'], { learnset_mode: 'inherit', learnset_inherits_from_id: 48, source_ref: { source_id: 'source-48', name: '岚鸟（冬天的样子）' } });
  add(8100, '权杖-Ⅱ', 'default', ['旧权杖_Ⅱ']);
  add(8101, '隐藏精灵', 'default', ['隐藏旧名'], { hidden: true });
  add(8102, '筛除精灵', 'default', ['筛除旧名']);
  return { ok: true, format: 'meownyx-catalog-view/1', revision: 'fixture-r1', monsters, wiki, moves: [], types: [] };
}
async function load() {
  const input = fixture(), original = JSON.stringify(input), calls = [];
  const context = vm.createContext({ MonsterIdentity, console: { log() {}, error() {} }, window: { __MEOWNYX_NATIVE_CATALOG__: true },
    fetch: async url => { calls.push(url); assert.equal(url, '/api/catalog/data'); return { ok: true, json: async () => copy(input) }; }
  });
  vm.runInContext(source, context);
  const data = vm.runInContext('RKData', context); await data.init();
  return { data, input, original, calls };
}
const ids = list => Array.from(list, item => item.id);
function selector(data, opts = {}) {
  const h = runtime(data.getMonsters()); Object.assign(h.RKData, data);
  const picks = []; const box = h.box({ ...opts, onSelect: monster => { picks.push(monster); opts.onSelect?.(monster); } });
  return { h, box, picks };
}

test('all twelve reviewed historical identities search their original local ID after renaming', async () => {
  const { data } = await load();
  for (const [id, name, form, oldName, oldForm] of reviewed) {
    const monster = data.getMonsterById(id), oldDisplay = display(oldName, oldForm);
    assert.equal(data.matchesMonsterName(monster, oldDisplay, { exact: true }), true, oldDisplay);
    assert.equal(data.matchesMonsterName(monster, display(name, form), { exact: true }), true);
    assert.ok(data.searchMonsters(oldDisplay).includes(monster), oldDisplay);
    const exact = data.getMonsters().filter(m => data.matchesMonsterName(m, oldDisplay, { exact: true }));
    assert.deepEqual(ids(exact), [id]);
  }
});

test('local partial keywords, whitespace, width, parentheses and Roman numerals normalize consistently', async () => {
  const { data } = await load();
  assert.deepEqual(ids(data.searchMonsters('月辉鸠')), [606]);
  assert.deepEqual(ids(data.searchMonsters('月使鸷')), [604]);
  assert.deepEqual(ids(data.searchMonsters('　岚鸟(冬天的样子)　')), [48]);
  assert.deepEqual(ids(data.searchMonsters('旧权杖-II')), [8100]);
  assert.equal(data.matchesMonsterName(data.getMonsterById(8100), ' 权杖_ii ', { exact: true }), true);
  assert.equal(data.matchesMonsterName(data.getMonsterById(606), '月辉', { exact: true }), false);
  assert.equal(data.matchesMonsterName(data.getMonsterById(606), '', { exact: true }), false);
  assert.equal(data.matchesMonsterName(null, '月辉'), false);
  assert.equal(data.searchMonsters(''), data.getMonsters());
});

test('aliases use only exact wiki stable IDs, never inherited learning, source ID, chain or bare-name fallback', async () => {
  const { data } = await load();
  const winter = data.getMonsterById(48), spring = data.getMonsterById(8001), child = data.getMonsterById(8002);
  assert.equal(data.getResolvedWikiData(spring).monster_id, 48); // This is a learnset reference, not alias ownership.
  assert.equal(data.getResolvedWikiData(child).monster_id, 48);
  assert.equal(data.matchesMonsterName(winter, '岚鸟（冬天的样子）', { exact: true }), true);
  assert.equal(data.matchesMonsterName(spring, '岚鸟（冬天的样子）'), false);
  assert.equal(data.matchesMonsterName(child, '岚鸟（冬天的样子）'), false);
  assert.equal(data.matchesMonsterName(spring, '岚鸟（春季旧称）', { exact: true }), true);
  assert.equal(data.matchesMonsterName(winter, '岚鸟（春季旧称）'), false);
  assert.equal(data.matchesMonsterName(child, '子旧名', { exact: true }), true);
  assert.deepEqual(ids(data.searchMonsters('source-48')), []);
  assert.deepEqual(ids(data.searchMonsters('不是搜索别名')), []);
  assert.equal(data.matchesMonsterName({ id: 99999, localized: { zh: { name: '派生鸟' } }, source_ref: { source_id: 'source-48' } }, '岚鸟（冬天的样子）'), false);
  assert.deepEqual(ids(data.getMonsters().filter(m => data.matchesMonsterName(m, '岚鸟', { exact: true }))), [48, 8001]);
});

test('shared old-name candidate click and unique exact Enter return existing objects for all twelve identities', async () => {
  const { data } = await load(); const { h, box, picks } = selector(data);
  const count = data.getMonsters().length;
  for (const [id, , , oldName, oldForm] of reviewed) {
    const oldDisplay = display(oldName, oldForm), monster = data.getMonsterById(id);
    h.type(box, oldDisplay); assert.ok(h.ids(box).includes(id)); h.pick(box, id);
    assert.equal(picks.at(-1), monster); assert.equal(box.getValue(), data.getMonsterDisplayName(monster));
    h.type(box, oldDisplay); h.key(box, 'Enter');
    assert.equal(picks.at(-1), monster); assert.equal(box.getValue(), data.getMonsterDisplayName(monster));
  }
  assert.equal(picks.length, 24); assert.equal(data.getMonsters().length, count);
  h.type(box, '岚鸟(冬天的样子)'); assert.deepEqual(h.ids(box), [48]);
  h.type(box, '岚鸟(春季旧称)'); assert.deepEqual(h.ids(box), [8001]);
  box.destroy();
});

test('fuzzy aliases and multiple forms never auto-commit or choose the first icon, but explicit candidates still select', async () => {
  const { data } = await load(); const { h, box, picks } = selector(data);
  const icon = box.wrapper.children.find(node => node.className === 'autocomplete-input-icon');
  h.type(box, '月辉'); assert.deepEqual(h.ids(box), [606]); assert.equal(icon.innerHTML, '');
  h.key(box, 'Enter'); assert.equal(picks.length, 0);
  h.type(box, '岚鸟'); assert.deepEqual(h.ids(box), [48, 8001]); assert.equal(icon.innerHTML, '');
  h.key(box, 'Enter'); assert.equal(picks.length, 0);
  h.key(box, 'ArrowDown'); h.key(box, 'Enter'); assert.equal(picks[0], data.getMonsterById(48));
  h.type(box, '岚鸟（春季旧称）'); assert.match(icon.innerHTML, /portrait-8001/); h.key(box, 'Enter'); assert.equal(picks[1], data.getMonsterById(8001));
  box.destroy();
});

test('hidden and caller-filtered aliases cannot bypass eligibility, including stale dropdown candidates', async () => {
  const { data } = await load(); let allow = true;
  const { h, box, picks } = selector(data, { filter: m => m.id !== 8102 && (m.id !== 606 || allow) });
  for (const keyword of ['隐藏旧名', '筛除旧名']) { h.type(box, keyword); assert.deepEqual(h.ids(box), []); h.key(box, 'Enter'); }
  assert.equal(picks.length, 0);
  h.type(box, '月辉鸠'); assert.deepEqual(h.ids(box), [606]); allow = false; h.key(box, 'Enter'); assert.equal(picks.length, 0);
  h.pick(box, 606); assert.equal(picks.length, 0); // acceptMonster rechecks the filter at commit time.
  allow = true; h.type(box, '月辉鸠'); h.key(box, 'Enter'); assert.equal(picks.length, 1);
  box.destroy();
});

test('old-name lookup is read-only and selection keeps caller onInput/MRU callback ownership', async () => {
  const loaded = await load(), { data } = loaded;
  const snapshot = JSON.stringify({ monsters: data.getMonsters(), wiki: data.getMonsters().map(m => data.getExactWikiData(m)), moves: data.getMoves(), types: data.getTypes() });
  const inputs = [], mru = [];
  const { h, box, picks } = selector(data, { onInput: value => inputs.push(value), onSelect: pet => mru.push(pet.id) });
  h.type(box, '新月鸷'); assert.deepEqual(mru, []); h.key(box, 'Enter'); assert.deepEqual(mru, [615]);
  box.input.click(); assert.deepEqual(mru, [615]);
  h.type(box, '月辉鸠'); h.pick(box, 606); assert.deepEqual(mru, [615, 606]);
  assert.deepEqual(inputs, ['新月鸷', '月辉鸠']); assert.equal(picks.length, 2);
  for (const [, , , name] of reviewed) data.searchMonsters(name);
  assert.equal(JSON.stringify({ monsters: data.getMonsters(), wiki: data.getMonsters().map(m => data.getExactWikiData(m)), moves: data.getMoves(), types: data.getTypes() }), snapshot);
  assert.equal(JSON.stringify(loaded.input), loaded.original); assert.deepEqual(loaded.calls, ['/api/catalog/data']);
  box.destroy();
});

test('old mocked RKData without the helper retains legacy name/chain filtering and highlighted selection', () => {
  const monsters = [{ id: 1, name: 'Bird', evolution_chain_name: 'Flock', form: 'winter' }];
  const h = runtime(monsters), picks = [], box = h.box({ onSelect: pet => picks.push(pet) });
  h.type(box, 'Flock(winter)'); assert.deepEqual(h.ids(box), [1]);
  h.type(box, 'Bird'); h.key(box, 'Enter'); assert.equal(picks.length, 0); // Old no-highlight Enter remains unchanged.
  h.key(box, 'ArrowDown'); h.key(box, 'Enter'); assert.equal(picks[0], monsters[0]);
  box.destroy();
});
