'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Families = require('../js/battle-rule-families.js');
const { readLegacy } = require('../scripts/lib/catalog-data.js');
const root = path.join(__dirname, '..');
const monsters = readLegacy(root).monsters;

const rule = (monsterIds = [], anyOf, excludedMonsterIds = []) => ({ id: 'stable-rule', name: '保留名字', monsterIds, excludedMonsterIds, ...(anyOf ? { anyOf } : {}) });

test('real 小帕尔/帕尔萨斯/龙息帕尔 becomes one required existing deepest representative', () => {
  const byID = new Map(monsters.map(m => [m.id, m]));
  assert.deepEqual([443, 444, 445].map(id => byID.get(id).localized.zh.name), ['小帕尔', '帕尔萨斯', '龙息帕尔']);
  const input = rule([231], [[443, 444, 445]]), before = structuredClone(input);
  const normalized = Families.normalizeRule(input, monsters);
  assert.deepEqual(normalized, rule([231, 445]));
  assert.deepEqual(input, before);
  assert.deepEqual(Families.normalizeRule(normalized, monsters), normalized);
  assert.deepEqual(Families.normalizeRule(rule([443, 444, 445]), monsters), rule([445]));
  assert.deepEqual(Families.normalizeRule(rule([443, 444]), monsters), rule([444])); // never invent 445
});

test('Kava snow/volcano are separate alternatives and cannot expand other branches', () => {
  const index = Families.createIndex(monsters);
  assert.deepEqual(index.family(111), [103, 107, 111]);
  assert.deepEqual(index.family(109), [101, 105, 109]);
  assert.deepEqual(Families.normalizeRule(rule([233], [[103, 107, 111, 101, 105, 109]]), index), rule([233], [[111, 109]]));
  for (const id of [100, 102, 104, 106, 108, 110]) {
    assert.ok(!index.family(111).includes(id)); assert.ok(!index.family(109).includes(id));
  }
});

test('regional lions, chess and required/excluded predicates preserve membership', () => {
  const index = Families.createIndex(monsters);
  assert.deepEqual(index.family(170), [168, 170]);
  assert.deepEqual(index.family(171), [169, 171]);
  const original = rule([443, 444, 231], [[444, 445], [311, 312]], [101, 105, 109]);
  const normalized = Families.normalizeRule(original, index);
  assert.deepEqual(normalized, rule([445, 231], [[311, 312]], [109]));
  const matches = (r, ids) => {
    const have = new Set(ids), family = id => index.family(id).some(member => have.has(member));
    return r.monsterIds.every(family) && !r.excludedMonsterIds.some(family) && (r.anyOf || []).every(g => g.some(family));
  };
  for (const ids of [[443, 231, 311], [445, 231, 312], [444, 231, 311, 109], [445, 231], [443, 311]]) assert.equal(matches(original, ids), matches(normalized, ids));
});

test('only explicit ordinary/leader edges, deterministic order-independent representative', () => {
  const catalog = [{ id: 1, name: 'same' }, { id: 2, evolves_from_id: 1 }, { id: 3, leader_of_id: 2 }, { id: 4, name: 'same', dex_number: 1, main_form_id: 3, evolution_members: [1, 2, 3] }];
  const input = [rule([1, 2, 3, 4]), { ...rule([], [[1, 2, 3], [999123]]), id: 'second' }];
  const result = Families.normalizeRules(input, catalog);
  assert.deepEqual(result, [rule([3, 4]), { ...rule([3, 999123]), id: 'second' }]);
  assert.deepEqual(Families.normalizeRules(input, [...catalog].reverse()), result);
  result[0].monsterIds[0] = 99; assert.equal(input[0].monsterIds[0], 1);
});

test('different required OR groups do not flatten into one group; redundant AND safely collapses', () => {
  const input = rule([445], [[443, 999001], [311, 312], [312, 311], [111, 109]]);
  assert.deepEqual(Families.normalizeRule(input, monsters), rule([445], [[311, 312], [111, 109]]));
  assert.deepEqual(Families.normalizeRule(rule([], [[443, 107], [111, 445]]), monsters), rule([], [[445, 111]]));
  const contradictory = rule([], [[111]], [111]);
  assert.deepEqual(Families.normalizeRule(contradictory, monsters), contradictory);
  assert.throws(() => Families.normalizeRule(rule([0]), monsters), /stable monster ID/);
  assert.throws(() => Families.normalizeRule(rule([], [[]]), monsters), /Empty rule/);
});

test('over-budget singleton promotion preserves the valid original 24+24 predicate', () => {
  const core = Array.from({ length: 24 }, (_, i) => 900000 + i);
  const groups = Array.from({ length: 24 }, (_, i) => [900024 + i]);
  const input = rule(core, groups), before = structuredClone(input);
  const normalized = Families.normalizeRule(input, []);
  assert.deepEqual(normalized, input);
  assert.equal(normalized.monsterIds.length, 24); assert.equal(normalized.anyOf.length, 24);
  normalized.anyOf[0][0] = 999123; assert.deepEqual(input, before);
});

test('browser exports pure helper without CommonJS or DOM access', () => {
  const context = {}; vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'js/battle-rule-families.js'), 'utf8'), context);
  assert.equal(typeof context.BattleRuleFamilies.normalizeRules, 'function');
  assert.equal(JSON.stringify(context.BattleRuleFamilies.normalizeRules([rule([777, 777])], [])), JSON.stringify([rule([777])]));
});
