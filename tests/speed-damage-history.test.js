'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function setup(history, cache, view) {
  const writes = [], reads = [], stored = { rk_speed_pet_priority: { 100: [1, 2] }, rk_damage_view: view ?? { skill: { keep: true } } };
  const c = { console, localStorage: {
    getItem(key) { reads.push(key); return key === 'rk_searched_pets' ? JSON.stringify(cache || []) : null; },
    setItem(key, value) { writes.push({ key, value }); }
  }, UserConfig: {
    getObject(key, fallback) { reads.push(key); return stored[key] ?? fallback; },
    patch(key, fields) { writes.push({ key, fields: plain(fields) }); stored[key] = { ...stored[key], ...plain(fields) }; return Promise.resolve(true); }
  } };
  c.window = c;
  if (history !== undefined) c.DamagePage = { getState: () => ({ searchedPets: history }) };
  vm.createContext(c);
  vm.runInContext(source('js/damage-speed-priority.js'), c);
  vm.runInContext(source('js/pages/speed.js').replace('return { render, onLeave };', 'return { render, onLeave, readDamageHistory, getPetPriority };'), c);
  return { api: vm.runInContext('SpeedPage', c), writes, reads, stored, c };
}

test('legacy damage MRU fallback precedes speed priorities without changing or migrating either source', () => {
  const history = [2, 3, 2, 9001, 0, true, 'bad', '4'], r = setup(history);
  assert.deepEqual(Array.from(r.api.getPetPriority(100)), [2, 3, 4, 1]);
  assert.deepEqual(history, [2, 3, 2, 9001, 0, true, 'bad', '4']);
  assert.deepEqual(r.stored.rk_damage_view, { skill: { keep: true } }); assert.equal(r.writes.length, 0);
});

test('cached legacy damage history works before damage page selection is initialized', () => {
  for (const history of [undefined, []]) {
    const r = setup(history, [3, 2]);
    assert.deepEqual(Array.from(r.api.getPetPriority(100)), [3, 2, 1]); assert.equal(r.writes.length, 0);
  }
});

test('independent damage priority replaces—not combines with—legacy history, then preserves speed-own MRU', () => {
  const history = [7, 2, 3], view = { speedPriority: [4, 3], skill: { keep: true }, unknown: 42 }, r = setup(history, [8], view);
  const before = plain(r.stored);
  assert.deepEqual(Array.from(r.api.getPetPriority(100)), [4, 3, 1, 2]);
  assert.deepEqual(Array.from(r.api.getPetPriority(130)), [4, 3]);
  assert.deepEqual(r.stored, before); assert.deepEqual(history, [7, 2, 3]); assert.equal(r.writes.length, 0);
  assert.ok(r.reads.includes('rk_damage_view'), 'the real new module reads the existing profile section');
});

test('explicit empty independent array is authoritative, while an invalid stored field remains read-only legacy fallback', () => {
  const empty = setup([3, 4], [8], { speedPriority: [], skill: { keep: true } });
  assert.deepEqual(Array.from(empty.api.getPetPriority(100)), [1, 2]); assert.equal(empty.writes.length, 0);
  for (const speedPriority of [null, '4,3', [4, '3'], [4, 9001], [3, 3]]) {
    const r = setup([3, 4], [], { speedPriority });
    assert.deepEqual(Array.from(r.api.getPetPriority(100)), [3, 4, 1, 2]); assert.equal(r.writes.length, 0);
  }
});

test('real module queued explicit priority is immediately consumed by speed without moving legacy history', async () => {
  const history = [1, 2, 3], r = setup(history);
  const pending = r.c.DamageSpeedPriority.record({ id: 4 }, history);
  assert.deepEqual(Array.from(r.api.getPetPriority(100)), [4, 1, 2, 3], 'synchronous queued draft is visible before awaiting persistence');
  assert.deepEqual(history, [1, 2, 3]);
  assert.deepEqual(r.writes, [{ key: 'rk_damage_view', fields: { speedPriority: [4, 1, 2, 3] } }]);
  assert.deepEqual(r.stored.rk_speed_pet_priority, { 100: [1, 2] });
  assert.deepEqual(r.stored.rk_damage_view.skill, { keep: true });
  assert.equal(await pending, true);
  await r.c.DamageSpeedPriority.record({ id: 2 }, history);
  assert.deepEqual(Array.from(r.api.getPetPriority(100)), [2, 4, 1, 3]);
  assert.deepEqual(history, [1, 2, 3]);
});

test('bad optional legacy storage does not reset independent or retained speed priority', () => {
  for (const view of [undefined, { speedPriority: [4, 3] }]) {
    const r = setup(undefined, undefined, view);
    r.c.localStorage.getItem = () => { throw Error('storage unavailable'); };
    assert.deepEqual(Array.from(r.api.getPetPriority(100)), view ? [4, 3, 1, 2] : [1, 2]); assert.equal(r.writes.length, 0);
  }
});

test('older damage priority/history or speed MRU is ordering-only and never elects a shared leader member', () => {
  const r = setup([13, 14], [], { speedPriority: [13, 14] }); let selected = 14, records = 0;
  r.c.SpeedLeaderDisplay = { visibleIds: () => new Set([selected]), preferredIds: () => new Set([selected]), recordSearch(pet) { records++; selected = pet.id; } };
  for (const history of [[13, 14], [14, 13], [13], [], [9001, '13', 13]]) {
    r.c.DamagePage.getState = () => ({ searchedPets: history });
    r.api.getPetPriority(130); r.api.getPetPriority(100);
    assert.equal(selected, 14, 'priority replay cannot revert a newer explicit group choice');
  }
  assert.equal(records, 0); assert.equal(r.writes.length, 0);
});
