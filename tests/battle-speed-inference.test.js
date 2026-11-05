'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Speed = require('../js/battle-speed-inference.js');
const BattleMath = require('../js/battle-math.js');

// Isolated declarations only: no parser, network, user-profile or database IO.
const clone = value => JSON.parse(JSON.stringify(value));
const catalog = new Map([[101, { id: 101, base_spd: 120 }], [202, { id: 202, base_spd: 120 }], [203, { id: 203, base_spd: 70 }]]);
const options = { getMonsterById: id => catalog.get(id) };
function record() {
  return {
    version: 1, id: 'synthetic-speed-contract', rounds: 100,
    sides: { me: { pets: [{ instanceId: '1', monsterId: 101, level: 60 }] }, enemy: { pets: [{ instanceId: '401', monsterId: 202, level: 60 }] } },
    events: [], speedObservations: []
  };
}
function observe(r, round, first = 'me', overrides = {}) {
  const index = r.speedObservations.length;
  const meActor = overrides.meActor || '1', enemyActor = overrides.enemyActor || '401';
  const obs = {
    id: `observation:${index}`, round, meEvent: `me:${index}`, enemyEvent: `enemy:${index}`,
    meMonsterId: 101, enemyMonsterId: 202, meLevel: 60, enemyLevel: 60,
    meSpeed: 220, mePriority: 0, enemyPriority: 0, first,
    prioritiesVerified: true, speedConditionsVerified: true,
    conditions: 'same-current-priority-and-speed-state; no ordering modifiers',
    evidence: ['synthetic normalized declaration; not a real battle'],
    ...overrides
  };
  delete obs.meActor; delete obs.enemyActor;
  r.events.push(
    { id: obs.meEvent, side: 'me', actor: meActor, round, seq: round * 10, execIndex: first === 'me' ? 1 : 2, kind: 'skill', phase: 'executed', skillClass: 'ordinary', skillId: 10 },
    { id: obs.enemyEvent, side: 'enemy', actor: enemyActor, round, seq: round * 10, execIndex: first === 'enemy' ? 1 : 2, kind: 'skill', phase: 'executed', skillClass: 'ordinary', skillId: 20 }
  );
  r.speedObservations.push(obs);
  return obs;
}
function sample(order, overrides = {}) {
  const r = record(); order.forEach((first, i) => observe(r, i + 1, first, overrides)); return r;
}
const project = (r, extra = {}) => Speed.project(r, { ...options, ...extra });
const enemy = r => project(r).sides.enemy['401'];
function joint(base = 120, level = 60) {
  const out = [];
  for (let iv = 0; iv <= 60; iv++) for (let nature = 0; nature <= 2; nature++) out.push({ iv, nature, speed: BattleMath.statFromEffectiveIV(base, 'speed', nature, iv, level) });
  return out;
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
function assertUI(result) {
  for (const key of ['status', 'relation', 'basis', 'candidates', 'message', 'samples', 'monsterId']) assert.ok(Object.hasOwn(result, key), key);
  assert.ok(Array.isArray(result.candidates)); assert.equal(typeof result.message, 'string');
  assert.ok(Number.isInteger(result.samples.meFirst)); assert.ok(Number.isInteger(result.samples.enemyFirst));
}
function assertSkipped(r, count = r.speedObservations.length) {
  const result = project(r); assert.equal(result.groups.length, 0); assert.equal(result.skipped.length, count); assert.deepEqual(Object.keys(result.sides.enemy), []);
}

test('empty or undeclared observations produce no inferred results', () => {
  for (const r of [undefined, null, {}, record(), { events: [], speedObservations: [null, 7] }]) {
    const result = project(r); assert.deepEqual(result.groups, []); assert.deepEqual(Object.keys(result.sides.enemy), []);
  }
  const r = sample(['me', 'me']); delete r.speedObservations;
  assert.deepEqual(project(r).groups, [], 'raw action sequence alone is not a normalized speed declaration');
});

test('a single non-boundary order is insufficient in either direction', () => {
  for (const first of ['me', 'enemy']) {
    const result = enemy(sample([first])); assertUI(result);
    assert.equal(result.status, 'insufficient'); assert.equal(result.relation, null); assert.deepEqual(result.candidates, []);
    assert.equal(result.samples.meFirst + result.samples.enemyFirst, 1);
  }
});

test('2:0 own-first applies the requested slower heuristic to every joint candidate', () => {
  const result = enemy(sample(['me', 'me'])); assertUI(result);
  assert.equal(result.status, 'inferred'); assert.equal(result.relation, 'slower'); assert.equal(result.basis, 'two-first');
  assert.deepEqual(result.samples, { meFirst: 2, enemyFirst: 0 });
  assert.deepEqual(result.candidates, joint().filter(c => c.speed < 220));
  assert.ok(result.candidates.some(c => c.iv > 0 && c.iv < 60));
});

test('0:2 enemy-first applies the requested faster heuristic, not species matching', () => {
  const result = enemy(sample(['enemy', 'enemy'])); assert.equal(result.status, 'inferred');
  assert.equal(result.relation, 'faster'); assert.deepEqual(result.samples, { meFirst: 0, enemyFirst: 2 });
  assert.deepEqual(result.candidates, joint().filter(c => c.speed > 220)); assert.equal(result.monsterId, 202);
});

test('mixed 2:1 or 1:1 replaces an earlier directional guess with equality', () => {
  const r = sample(['me', 'me']); assert.equal(enemy(r).relation, 'slower'); observe(r, 3, 'enemy');
  for (const fixture of [r, sample(['me', 'enemy']), sample(['enemy', 'me'])]) {
    const result = enemy(fixture); assert.equal(result.relation, 'equal'); assert.equal(result.basis, 'mixed-order');
    assert.deepEqual(result.candidates, joint().filter(c => c.speed === 220));
  }
});

test('equal speed retains all IV0..60 × nature0/1/2 solutions, not two presets', () => {
  const result = enemy(sample(['me', 'enemy']));
  assert.deepEqual(result.candidates, [{ iv: 0, nature: 1, speed: 220 }, { iv: 50, nature: 0, speed: 220 }, { iv: 51, nature: 0, speed: 220 }]);
  assert.ok(result.candidates.length > 2);
});

test('maximum260 with one enemy-first observation yields exact IV60 positive nature', () => {
  const result = enemy(sample(['enemy'], { meSpeed: 260 }));
  assert.equal(result.status, 'inferred'); assert.equal(result.relation, 'equal'); assert.equal(result.basis, 'boundary-max');
  assert.deepEqual(result.candidates, [{ iv: 60, nature: 1, speed: 260 }]);
});

test('minimum178 with one own-first observation yields exact IV0 negative nature', () => {
  const result = enemy(sample(['me'], { meSpeed: 178 }));
  assert.equal(result.status, 'inferred'); assert.equal(result.relation, 'equal'); assert.equal(result.basis, 'boundary-min');
  assert.deepEqual(result.candidates, [{ iv: 0, nature: 2, speed: 178 }]);
});

test('explicit equal priority zero and negative priorities are accepted without defaulting absent values', () => {
  for (const priority of [0, -1, -1000000, 1000000]) {
    const result = enemy(sample(['me', 'me'], { mePriority: priority, enemyPriority: priority })); assert.equal(result.status, 'inferred');
  }
  for (const key of ['mePriority', 'enemyPriority']) { const r = sample(['me']); delete r.speedObservations[0][key]; assertSkipped(r); }
});

test('missing verification, mismatched priority, unknown speed conditions and invalid numbers are excluded', () => {
  const invalid = [
    { prioritiesVerified: false }, { prioritiesVerified: 1 }, { speedConditionsVerified: false }, { speedConditionsVerified: 'true' },
    { mePriority: 1, enemyPriority: 0 }, { mePriority: null, enemyPriority: null }, { mePriority: 1000001, enemyPriority: 1000001 },
    { conditions: '' }, { evidence: [] }, { evidence: [''] }, { meSpeed: 0 }, { meSpeed: '220' },
    { meSpeed: Number.MAX_SAFE_INTEGER }, { meSpeed: 220.5 }, { meLevel: 0 }, { enemyLevel: 100 }, { round: 0 }
  ];
  for (const patch of invalid) assertSkipped(sample(['me'], patch));
});

test('confirmed ordinary stun skips on either side cannot supply speed-order evidence', () => {
  for (const side of ['me', 'enemy']) {
    const r = sample(['me', 'enemy']);
    for (const event of r.events.filter(event => event.side === side)) Object.assign(event, { protocolSkillId: '700001200', skillId: 0 });
    const before = JSON.stringify(r); assertSkipped(freeze(r)); assert.equal(JSON.stringify(r), before);
  }
  const unknown = sample(['me', 'enemy']);
  for (const event of unknown.events) Object.assign(event, { protocolSkillId: '700001201', skillId: 0 });
  assert.equal(project(unknown).groups.length, 1, 'Nearby unknown IDs keep the existing explicit observation contract');
});

test('response, interrupted, switch, passive, system and unclassified events cannot be compared', () => {
  for (const patch of [{ skillClass: 'response' }, { phase: 'interrupted' }, { kind: 'switch' }, { skillClass: 'passive' }, { skillClass: 'system' }, { skillClass: undefined }, { phase: 'predicted' }, { execIndex: undefined }]) {
    for (const index of [0, 1]) { const r = sample(['me']); Object.assign(r.events[index], patch); assertSkipped(r); }
  }
});

test('both event references must match side, round and strict sequence/exec order', () => {
  for (const change of [
    r => { r.events[1].round = 2; }, r => { r.events[0].side = 'enemy'; },
    r => { r.speedObservations[0].enemyEvent = 'absent'; }, r => { r.speedObservations[0].first = 'enemy'; },
    r => { r.events[1].execIndex = r.events[0].execIndex; }, r => { r.events[0].seq = -1; }
  ]) { const r = sample(['me']); change(r); assertSkipped(r); }
  const r = sample(['me']); r.events[0].seq = 0; r.events[0].execIndex = 100; r.events[1].seq = 1; r.events[1].execIndex = 0;
  assert.equal(project(r).groups.length, 1, 'sequence precedes execution index; zero is explicit and valid');
});

test('different own peers and different enemy instances never pool their votes', () => {
  const r = record(); r.sides.me.pets.push({ instanceId: '2', monsterId: 101, level: 60 });
  observe(r, 1, 'me'); observe(r, 2, 'me', { meActor: '2' });
  let result = project(r); assert.equal(result.groups.length, 2); assert.ok(result.groups.every(g => g.status === 'insufficient'));
  const q = record(); q.sides.enemy.pets.push({ instanceId: '402', monsterId: 202, level: 60 });
  observe(q, 1, 'me'); observe(q, 2, 'me', { enemyActor: '402' });
  result = project(q); assert.equal(result.groups.length, 2); assert.equal(result.sides.enemy['401'].status, 'insufficient'); assert.equal(result.sides.enemy['402'].status, 'insufficient');
});

test('changed conditions, actual priority, own speed or either current level start independent groups', () => {
  for (const patch of [{ conditions: 'another verified state' }, { mePriority: 1, enemyPriority: 1 }, { meSpeed: 221 }, { meLevel: 61 }, { enemyLevel: 61 }]) {
    const r = sample(['me']); observe(r, 2, 'me', patch); const result = project(r);
    assert.equal(result.groups.length, 2, JSON.stringify(patch)); assert.ok(result.groups.every(g => g.status === 'insufficient'), JSON.stringify(patch));
    assert.deepEqual(result.sides.enemy['401'].samples, { meFirst: 1, enemyFirst: 0 });
  }
});

test('action-time forms are side/instance-specific and cannot be pooled with an earlier form', () => {
  const r = sample(['me']);
  r.events.push({ id: 'form', side: 'enemy', actor: '401', round: 2, seq: 19, execIndex: 1, kind: 'form', phase: 'executed', form: { fromMonsterId: 202, toMonsterId: 203 } });
  observe(r, 2, 'me', { enemyMonsterId: 203, meSpeed: 140 });
  const result = project(r); assert.equal(result.groups.length, 2); assert.equal(result.sides.enemy['401'].monsterId, 203); assert.equal(result.sides.enemy['401'].status, 'insufficient');
  const stale = clone(r); stale.speedObservations[1].enemyMonsterId = 202;
  assert.equal(project(stale).skipped.length, 1, 'initial form cannot override current form');
  const future = sample(['me']); future.events.push({ ...r.events[2], id: 'future-form', round: 3, seq: 30 });
  assert.equal(project(future).groups[0].monsterId, 202, 'a future form is not applied backward');
});

test('identical duplicate observations, alternate IDs for one pair and identical events count once', () => {
  const r = sample(['me']); r.speedObservations.push(clone(r.speedObservations[0]), { ...clone(r.speedObservations[0]), id: 'alternate-id' });
  r.events.push(clone(r.events[0])); const result = enemy(r);
  assert.equal(result.status, 'insufficient'); assert.deepEqual(result.samples, { meFirst: 1, enemyFirst: 0 });
});

test('conflicting observation IDs, reused pairs with changed conditions and conflicting event IDs reject', () => {
  const a = sample(['me']); a.speedObservations.push({ ...clone(a.speedObservations[0]), meSpeed: 221 }); assert.throws(() => project(a), /冲突/);
  const b = sample(['me']); b.speedObservations.push({ ...clone(b.speedObservations[0]), id: 'new-id', meSpeed: 221 }); assert.throws(() => project(b), /冲突/);
  const c = sample(['me']); c.events.push({ ...clone(c.events[0]), execIndex: 3 }); assert.throws(() => project(c), /冲突/);
});

test('direct speed and direct IV/nature remain stronger than inferred candidates', () => {
  const r = sample(['me', 'me']); r.sides.enemy.pets[0].speed = 220;
  const result = enemy(r); assertUI(result); assert.equal(result.status, 'direct'); assert.equal(result.basis, 'recorded-speed');
  assert.deepEqual(result.candidates, joint().filter(c => c.speed === 220));
  const q = sample(['me', 'enemy']); q.sides.enemy.pets[0].iv = { speed: { value: 50, certainty: 'direct' } }; q.sides.enemy.pets[0].nature = { speed: { value: 0, certainty: 'direct' } };
  assert.deepEqual(enemy(q).candidates, [{ iv: 50, nature: 0, speed: 220 }]);
  const weak = sample(['me', 'enemy']); weak.sides.enemy.pets[0].iv = { speed: { value: 60, certainty: 'inferred' } };
  assert.deepEqual(enemy(weak).candidates, joint().filter(c => c.speed === 220), 'a weak previous IV guess is not a direct constraint');
});

test('all candidates use the exact shared BattleMath call at the declared current level', () => {
  const calls = [], math = { statFromEffectiveIV(...args) { calls.push(args); return BattleMath.statFromEffectiveIV(...args); } };
  const level = 69, r = sample(['me', 'me'], { enemyLevel: level, meSpeed: 240 });
  const result = project(r, { math }).sides.enemy['401'];
  assert.equal(calls.length, 183); assert.ok(calls.every(args => args[0] === 120 && args[1] === 'speed' && args[4] === level));
  assert.deepEqual(new Set(calls.map(args => `${args[3]}:${args[2]}`)), new Set(joint().map(c => `${c.iv}:${c.nature}`)));
  assert.deepEqual(result.candidates, joint(120, level).filter(c => c.speed < 240));
});

test('unknown roster identity is never manufactured from order or an omitted species ID', () => {
  const mismatched = sample(['me']); mismatched.speedObservations[0].enemyMonsterId = 999; assertSkipped(mismatched);
  const ambiguous = sample(['me']); ambiguous.sides.enemy.pets.push(clone(ambiguous.sides.enemy.pets[0])); assertSkipped(ambiguous);
  const missingOwn = sample(['me', 'me']); missingOwn.sides.me.pets = [];
  for (const o of missingOwn.speedObservations) delete o.meMonsterId;
  assertSkipped(missingOwn);
  const missingEnemy = sample(['me', 'me']); delete missingEnemy.sides.enemy.pets[0].monsterId;
  for (const o of missingEnemy.speedObservations) delete o.enemyMonsterId;
  assertSkipped(missingEnemy);
});

test('prototype-like IDs are safe keys and identical IDs on opposite sides remain separate', () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'same-id']) {
    const r = record(); r.sides.me.pets[0].instanceId = id; r.sides.enemy.pets[0].instanceId = id;
    observe(r, 1, 'me', { meActor: id, enemyActor: id }); observe(r, 2, 'me', { meActor: id, enemyActor: id });
    const result = project(r); assert.equal(Object.getPrototypeOf(result.sides.enemy), null); assert.equal(result.sides.enemy[id].status, 'inferred'); assert.equal(result.sides.enemy[id].monsterId, 202);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  }
});

test('candidate bounds stay at183 and impossible speeds or unusable catalog/math data fail closed', () => {
  const r = sample(['me', 'me'], { meSpeed: 1000000 }); const result = enemy(r);
  assert.equal(result.candidates.length, 183); assert.equal(new Set(result.candidates.map(c => `${c.iv}:${c.nature}`)).size, 183);
  for (const config of [{ getMonsterById: () => undefined }, { getMonsterById: () => { throw Error('missing catalog'); } }, { getMonsterById: () => ({ base_spd: 10001 }) }, { math: {} }, { math: { statFromEffectiveIV: () => NaN } }]) {
    const out = project(sample(['me', 'me']), config).sides.enemy['401']; assert.equal(out.status, 'conflict'); assert.deepEqual(out.candidates, []);
  }
  for (const [first, speed] of [['enemy', 261], ['me', 177]]) { const out = enemy(sample([first], { meSpeed: speed })); assert.equal(out.status, 'conflict'); assert.deepEqual(out.candidates, []); }
});

test('projection accepts frozen inputs, never mutates data and returns detached candidate objects', () => {
  const r = sample(['me', 'enemy']), before = clone(r); freeze(r);
  const result = project(r); assert.deepEqual(r, before); result.sides.enemy['401'].candidates[0].iv = 59;
  assert.deepEqual(r, before); assert.deepEqual(enemy(r).candidates, joint().filter(c => c.speed === 220)); assert.ok(Object.isFrozen(Speed));
});

const realCandidate = path.resolve(__dirname, '..', '..', 'metadata-candidate-final.json');
test('optional sanitized actual battle has no safe declarations and produces no inferred enemy configuration', { skip: !fs.existsSync(realCandidate) }, () => {
  const source = JSON.parse(fs.readFileSync(realCandidate, 'utf8').replace(/^\uFEFF/, ''));
  const records = Array.isArray(source.records) ? source.records : [source];
  assert.ok(records.length > 0);
  for (const r of records) {
    assert.equal((r.speedObservations || []).length, 0); const before = clone(r); const result = project(freeze(r));
    assert.deepEqual(result.groups, []); assert.ok(Object.values(result.sides.enemy).every(x => x.status !== 'inferred')); assert.deepEqual(r, before);
  }
});
