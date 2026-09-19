'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { defaults, resolve } = require('../js/pet-configuration');
const pet = (hp, attack, magic, speed) => ({ base_hp: hp, base_phy_atk: attack, base_mag_atk: magic, base_spd: speed });
test('defaults use current form BASE stats, inclusive attack gap 20 and strict speed boundaries', () => {
  for (const speed of [84, 85, 114, 115]) {
    for (const gap of [0, 20, 21, -20, -21]) {
      const p = pet(50, 100 + gap, 100, speed), d = defaults(p);
      assert.equal(d.mode, 0); assert.equal(d.iv.hp, true);
      assert.equal(!!d.iv.defense, speed < 85);
      assert.equal(!!d.iv.attack, gap >= -20);
      assert.equal(!!d.iv.magic_attack, gap <= 20);
      assert.equal(d.iv.speed, undefined); assert.equal(d.iv.magic_defense, undefined);
      const expected = speed >= 115 ? {} : Math.abs(gap) <= 20 ? { attack: 1, magic_attack: 1 } : gap > 0 ? { attack: 1 } : { magic_attack: 1 };
      assert.deepEqual(d.nature, expected);
    }
  }
});
test('HP dominates, HP=highest attack has no nature, fast pets have no nature', () => {
  assert.deepEqual(defaults(pet(120, 100, 80, 114)).nature, { hp: 1 });
  assert.deepEqual(defaults(pet(100, 100, 80, 114)).nature, {});
  assert.deepEqual(defaults(pet(120, 100, 80, 115)).nature, {});
  assert.deepEqual(defaults(pet(20, 80, 101, 84)).nature, { magic_attack: 1 });
});
test('absence/mode0 regenerate; every existing legacy record (even empty) is manual; no mutation', () => {
  const p = Object.freeze({ id: 1, ...pet(100, 120, 100, 80), hp: 999, attack: 999 });
  assert.deepEqual(resolve(p), defaults(p));
  assert.deepEqual(resolve(p, { mode: 0, iv: { hp: false }, nature: { hp: 2 } }), defaults(p));
  for (const r of [{}, { iv: {}, nature: {} }, { mode: 1, iv: {}, nature: {} }]) {
    assert.deepEqual(resolve(p, r), { mode: 1, iv: {}, nature: {} });
  }
  const r = { iv: { hp: false, attack: true }, nature: { hp: 0, attack: 2 } };
  const d = resolve(p, r); d.iv.hp = true; d.nature.attack = 1;
  assert.equal(r.iv.hp, false); assert.equal(r.nature.attack, 2);
});
test('forms never consult species/display names or inherited stats; no count limits', () => {
  const a = { id: 1, name: 'same', ...pet(50, 120, 100, 84) };
  const b = { id: 2, name: 'same', ...pet(150, 100, 80, 115) };
  assert.notDeepEqual(defaults(a), defaults(b));
  assert.equal(Object.keys(defaults(a).iv).length, 4);
  const all = { hp: true, attack: true, magic_attack: true, defense: true, magic_defense: true, speed: true };
  assert.deepEqual(resolve(a, { mode: 1, iv: all }).iv, all);
});
