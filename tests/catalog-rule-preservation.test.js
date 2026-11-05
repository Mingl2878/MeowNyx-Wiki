'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readLegacy } = require('../scripts/lib/catalog-data.js');
const Variants = require('../js/skill-variants.js');
const Simulation = require('../js/skill-simulation.js');
const Traits = require('../js/trait-power-defaults.js');
const data = readLegacy(path.resolve(__dirname, '..'));
const clone = value => JSON.parse(JSON.stringify(value));

for (const [id, name] of [[35, '魔能爆'], [19, '彗星'], [195, '鸣沙陷阱'], [358, '闪击']]) {
  test(`catalog formatting does not disable reviewed dynamic rule: ${name}`, () => {
    const original = data.moves.find(move => move.id === id);
    assert.equal(original.localized.zh.name, name);
    const before = Variants.describe(original);
    assert.equal(before.reviewed, true);
    const formatted = clone(original);
    formatted.localized.zh.description = ' \n' + formatted.localized.zh.description.replace(/，/g, '， ') + '\t';
    const after = Variants.describe(formatted);
    assert.equal(after.reviewed, true);
    for (const field of ['left', 'right', 'dynamic', 'showUnknownPower', 'displayPower']) assert.deepEqual(after[field], before[field]);
    formatted.localized.zh.description += '额外机制改变。';
    assert.equal(Variants.describe(formatted).reviewed, false, 'real semantic changes must remain unreviewed');
  });
}

test('energy and HP-ratio calculations remain independent of official placeholder power', () => {
  assert.equal(Simulation.input('energy', '0').basePower, 46);
  assert.equal(Simulation.input('energy', '10').basePower, 211);
  assert.equal(Simulation.input('hp-ratio', '77/100').basePower, 200);
  const energyMove = data.moves.find(move => move.id === 35);
  assert.equal(Simulation.select(energyMove, 1, 'left').values.basePower, 211);
  assert.equal(Simulation.select(energyMove, 1, 'right').values.basePower, 46);
  assert.equal(data.moves.find(move => move.id === 195).power_formula, 'phy_def_diff');
  assert.equal(data.moves.find(move => move.id === 358).power_formula, 'speed_diff');
});

test('trait signature accepts only formatting changes, never new numeric semantics', () => {
  const pet = clone(data.monsters.find(monster => monster.id === 40));
  const before = Traits.resolve(pet, '测试', '翼');
  assert.deepEqual(before?.value, 50);
  pet.trait.localized.zh.description = ' \n' + pet.trait.localized.zh.description.replace(/，/g, '， ') + '\t';
  assert.deepEqual(Traits.resolve(pet, '测试', '翼'), before);
  pet.trait.localized.zh.description = pet.trait.localized.zh.description.replace('50%', '99%');
  assert.equal(Traits.resolve(pet, '测试', '翼'), null);
});
