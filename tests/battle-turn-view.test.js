'use strict';
// Pure in-memory fixtures. Optional frozen real JSON is READ ONLY, explicitly
// selected with BATTLE_TURN_VIEW_FIXTURE; never open a live DB or write a profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { project } = require('../js/battle-turn-view.js');
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const record = (events = [], extra = {}) => ({
  id: 'isolated-view-only', rounds: 1, quality: { actions: false },
  sides: {
    me: { pets: [{ instanceId: 'a', monsterId: 101, name: 'A' }, { instanceId: 'b', monsterId: 102, name: 'B' }] },
    enemy: { pets: [{ instanceId: 'a', monsterId: 201, name: 'Enemy A' }, { instanceId: 'b', monsterId: 202, name: 'Enemy B' }] }
  }, events, ...extra
});
const event = (id, extra = {}) => ({ id, round: 1, seq: 7, execIndex: 0, kind: 'skill', phase: 'executed',
  side: 'me', actor: 'a', targetSide: 'enemy', target: 'a', protocolSkillId: '700', skillClass: 'ordinary', ...extra });
const damage = (extra = {}) => event('damage', { kind: 'damage', execIndex: 2, amount: 642, hpChange: -340, hpAfter: 0, ...extra });
const resource = (extra = {}) => event('energy', { kind: 'resource', target: undefined, targetSide: undefined, energyChange: -3, energyAfter: 7, ...extra });
const legacyDamage = (extra = {}) => damage({ id: 'rkpp:action:1:7:2:damage_info', protocolSkillId: undefined,
  text: '同一条执行消息、同一目标的数值同步；来源标识 700（不直接当作技能ID）。CSV逻辑行 597。 报告伤害与实际生命变化分开保留，不推导隐藏配置。', ...extra });
const faint = (extra = {}) => event('rkpp:action:1:7:4:faint', { kind: 'effect', execIndex: 4, skillClass: undefined,
  label: '倒下通知', text: '明确 dead_info；不由动画或HP推测。', ...extra });
const supply = (extra = {}) => event('rkpp:action:2:1:0:supply:b', { round: 2, seq: 1, actor: 'b', kind: 'effect', skillClass: undefined,
  label: '补位通知', text: '同一既有实例的 supply_pet 通知；不增加初始队员。', ...extra });
const turn = (view, round = 1) => view.rounds.find(item => item.round === round);
const action = (view, round = 1, side = 'me', index = 0) => turn(view, round).sides[side].actions[index];
const state = (view, round = 1, side = 'me') => turn(view, round).sides[side].endState;
const ids = events => events.map(item => item.id);

function checkShape(view) {
  assert.deepEqual(Object.keys(view).sort(), ['lifecycle', 'rounds', 'warnings']);
  for (const row of view.rounds) {
    assert.deepEqual(Object.keys(row).filter(key => key !== 'endRound').sort(), ['events', 'round', 'sides', 'teamStates', 'unassigned']);
    assert.deepEqual(Object.keys(row.sides).sort(), ['enemy', 'me']);
    for (const side of Object.values(row.sides)) {
      assert.deepEqual(Object.keys(side).sort(), ['actions', 'annotations', 'endState', 'notes', 'participants', 'replacements']);
      for (const annotation of side.annotations) assert.deepEqual(Object.keys(annotation).sort(), ['event', 'kind', 'pet']);
      for (const s of [side.endState, ...side.replacements]) {
        assert.deepEqual(Object.keys(s).sort(), ['confirmedActive', 'energy', 'energyRound', 'evidence', 'hp', 'hpMax', 'hpRatio', 'hpRound', 'pet', 'sourceRound', 'status']);
        assert.ok(['present', 'empty', 'unknown'].includes(s.status));
      }
      for (const a of side.actions) assert.deepEqual(Object.keys(a).sort(), ['damage', 'damageEvents', 'energyCost', 'energyEvents', 'energyGain', 'event', 'hpLoss', 'pet']);
      for (const pet of [...side.participants, ...side.actions.map(a => a.pet), side.endState.pet].filter(Boolean)) {
        assert.deepEqual(Object.keys(pet).sort(), ['declaredName', 'instanceId', 'monsterId']);
      }
    }
  }
}

test('R15 exact ordinary stun skips stay side-local annotations, not casts, costs or HP attribution', () => {
  const skip = event('rkpp:2306377934505522485:live:15:83:2:cast:1', { round: 15, seq: 83, execIndex: 2, actor: 'a', side: 'enemy', targetSide: 'me', protocolSkillId: '700001200', skillId: 0 });
  const ownSkip = { ...skip, id: 'own-skip', side: 'me', targetSide: 'enemy', phase: 'interrupted' };
  const fact = resource({ id: 'independent-resource', round: 15, seq: 83, execIndex: 2, side: 'enemy', protocolSkillId: '700001200', energyChange: -2, energyAfter: 3, hpAfter: 90, hpMax: 100 });
  const hit = damage({ id: 'independent-hp', round: 15, seq: 83, execIndex: 3, side: 'enemy', targetSide: 'me', protocolSkillId: '700001200', amount: 8, hpChange: -5, hpAfter: 45, hpMax: 100 });
  const r = record([hit, skip, fact, ownSkip], { rounds: 16, quality: { actions: false, lead: { me: true, enemy: true } } });
  r.sides.me.lead = 'a'; r.sides.enemy.lead = 'a';
  const before = JSON.stringify(r), v = project(freeze(r), { getMoveById() { throw Error('A skip cannot consult skill cost metadata'); } }), row = turn(v, 15);
  checkShape(v);
  assert.deepEqual(ids(row.events), [skip.id, fact.id, ownSkip.id, hit.id]);
  assert.deepEqual(row.unassigned, row.events, 'No raw event, resource or HP fact is consumed by a fake action');
  for (const [side, original, id] of [['me', ownSkip, 101], ['enemy', skip, 201]]) {
    assert.equal(row.sides[side].actions.length, 0);
    const annotation = row.sides[side].annotations[0];
    assert.equal(annotation.event, original); assert.equal(annotation.kind, 'stunSkip'); assert.equal(annotation.pet.monsterId, id);
    assert.equal(annotation.energyCost, undefined); assert.equal(annotation.hpLoss, undefined);
    assert.equal(turn(v, 16).sides[side].annotations.length, 0, 'A skip is not a persistent whole-round/team condition');
  }
  assert.equal(state(v, 15, 'enemy').hp, 90); assert.equal(state(v, 15, 'enemy').energy, 3);
  assert.equal(state(v, 15, 'me').hp, 45); assert.equal(state(v, 16, 'me').hp, 45);
  assert.equal(JSON.stringify(r), before); assert.equal(skip.skillId, 0);
  const isolated = project(record([skip], { rounds: 15 }));
  assert.equal(state(isolated, 15, 'enemy').status, 'unknown', 'A skip alone cannot establish a cast or active slot');
  assert.equal(turn(isolated, 15).sides.enemy.annotations[0].pet.monsterId, 201);
});

test('one actor skipping does not suppress other actions or relabel a colliding resource as skill cost', () => {
  const skip = event('skip', { protocolSkillId: '700001200', skillId: 0 });
  const cast = event('actual-cast');
  const independent = event('other-actor', { actor: 'b', execIndex: 1 });
  const fact = resource({ energyChange: -2 });
  const r = freeze(record([skip, cast, independent, fact])), v = project(r), row = turn(v);
  assert.deepEqual(row.sides.me.actions.map(a => a.event.id), ['actual-cast', 'other-actor']);
  assert.equal(row.sides.me.annotations.length, 1); assert.equal(row.sides.me.annotations[0].pet.instanceId, 'a');
  assert.equal(action(v).energyCost, null); assert.deepEqual(action(v).energyEvents, []);
  assert.ok(row.unassigned.includes(fact));
  assert.equal(row.teamStates.me.find(state => state.pet.instanceId === 'a').energy, 7, 'The unassigned resource still advances the measured state');
});

test('nearby unknown runtime and positive local skill contradictions never become stun annotations', () => {
  const events = ['700001199', '700001201', '7000012000'].map((protocolSkillId, i) => event('unknown-' + i, { protocolSkillId, skillId: 0 }));
  events.push(event('positive-local', { protocolSkillId: '700001200', skillId: 37 }));
  const v = project(freeze(record(events)));
  assert.deepEqual(turn(v).sides.me.actions.map(a => a.event), events); assert.deepEqual(turn(v).sides.me.annotations, []);
});

test('browser UMD uses the shared exact skip predicate without I/O', () => {
  const window = {}, context = vm.createContext({ window, globalThis: window });
  for (const file of ['battle-system-actions.js', 'battle-turn-view.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + file), 'utf8'), context);
  const v = window.BattleTurnView.project(freeze(record([event('skip', { protocolSkillId: '700001200', skillId: 0 })])));
  assert.equal(v.rounds[0].sides.me.actions.length, 0); assert.equal(v.rounds[0].sides.me.annotations.length, 1);
});

test('UMD exposes only project and does not depend on browser, storage, catalogue or profiles', () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/battle-turn-view.js'), 'utf8');
  const window = {};
  for (const name of ['document', 'localStorage', 'sessionStorage', 'RKData', 'UserConfig', 'fetch']) {
    Object.defineProperty(window, name, { get() { throw Error('Forbidden dependency: ' + name); } });
  }
  vm.runInNewContext(source, { window });
  assert.deepEqual(Object.keys(window.BattleTurnView), ['project']);
  assert.equal(window.BattleTurnView.project(null).rounds.length, 0);
  checkShape(project(record([event('cast'), damage(), resource()])));
});

test('deeply frozen inputs and derived snapshots remain isolated across calls and records', () => {
  const first = freeze(record([event('cast'), resource({ hpAfter: 300 })], { rounds: 2 }));
  const before = JSON.stringify(first), one = project(first), baseline = project(first);
  turn(one).sides.me.participants[0].monsterId = 999;
  action(one).pet.monsterId = 998;
  state(one).pet.monsterId = 997;
  state(one).hp = 1;
  state(one).evidence.pop();
  assert.equal(state(one, 2).pet.monsterId, 101);
  assert.equal(state(one, 2).hp, 300);
  assert.deepEqual(project(first), baseline);
  assert.equal(JSON.stringify(first), before);
  const second = record([event('cast')]); second.sides.me.pets[0].monsterId = 303;
  assert.equal(state(project(freeze(second))).pet.monsterId, 303);
  assert.equal(state(project(second)).hp, null);
  assert.equal(state(project(second)).energy, null);
  assert.equal(state(project(first)).pet.monsterId, 101);
});

test('roster order, missing data, source names and profile/default fields never establish active or values', () => {
  const r = record([], { rounds: 2 });
  Object.assign(r.sides.me.pets[0], { hp: 999, maxHP: 999, energy: 10, level: 99 });
  r.sides.me.before = { hp: 999, energy: 10 }; r.sides.me.after = { hp: 999, energy: 10 };
  const v = project(freeze(r));
  assert.deepEqual(turn(v).sides.me.participants, []);
  assert.deepEqual(state(v), { status: 'unknown', pet: null, hp: null, hpMax: null, hpRatio: null, energy: null, hpRound: null, energyRound: null, sourceRound: 0, confirmedActive: false, evidence: [] });
  assert.match(v.warnings.join(' '), /最后记录.*未确认/);
  assert.equal(project(undefined).rounds.length, 0);
});

test('initial active is seeded only by a verified exact side-local lead declaration, never roster order', () => {
  const r = record([], { rounds: 2, quality: { actions: false, lead: { me: true, enemy: false } } });
  r.sides.me.lead = 'b'; r.sides.enemy.lead = 'a';
  const v = project(freeze(r));
  assert.equal(state(v).status, 'present'); assert.equal(state(v).confirmedActive, true);
  assert.equal(state(v).pet.instanceId, 'b'); assert.equal(state(v).pet.monsterId, 102);
  assert.equal(state(v).hp, null); assert.equal(state(v).energy, null); assert.equal(state(v).sourceRound, 0);
  assert.deepEqual(state(v).evidence, []); assert.deepEqual(turn(v).events, []);
  assert.deepEqual(turn(v).sides.me.participants.map(p => p.instanceId), ['b']);
  assert.equal(state(v, 2).pet.instanceId, 'b'); assert.equal(state(v, 1, 'enemy').status, 'unknown');
  for (const [verified, lead] of [[false, 'b'], [undefined, 'b'], ['true', 'b'], [1, 'b'], [true, undefined], [true, 'B'], [true, 'missing'], [true, 1]]) {
    const invalid = record([], { quality: { lead: { me: verified } } }); invalid.sides.me.lead = lead;
    assert.equal(state(project(freeze(invalid))).status, 'unknown', JSON.stringify([verified, lead]));
  }
  const ambiguous = record([], { quality: { lead: { me: true } } });
  ambiguous.sides.me.lead = 'b'; ambiguous.sides.me.pets.push({ instanceId: 'b', monsterId: 777 });
  assert.equal(state(project(ambiguous)).status, 'unknown');
  const otherSide = record([], { quality: { lead: { me: true } } });
  otherSide.sides.enemy.pets.push({ instanceId: 'enemy-only', monsterId: 303 }); otherSide.sides.me.lead = 'enemy-only';
  assert.equal(state(project(otherSide)).status, 'unknown');
});

test('strict identity is side plus instance, executed forms only, unknown destinations and reversions survive', () => {
  const form = (id, extra) => event(id, { kind: 'form', form: { toMonsterId: 111 }, ...extra });
  const r = record([
    event('cast-before', { seq: 1 }),
    form('frost', { seq: 2, execIndex: undefined, form: { execIndex: 2, toMonsterId: 111 } }),
    event('cast-frost', { seq: 2, execIndex: 3 }),
    event('enemy-cast', { seq: 2, execIndex: 4, side: 'enemy' }),
    form('unmapped', { seq: 2, execIndex: 5, form: { toMonsterId: 0, toBaseId: '222', name: 'Guess me' } }),
    event('cast-unmapped', { seq: 2, execIndex: 6 }),
    form('preview-form', { seq: 2, execIndex: 7, phase: 'preview', form: { toMonsterId: 888 } }),
    event('still-unmapped', { seq: 2, execIndex: 8 }),
    form('return', { seq: 2, execIndex: 9, form: { toMonsterId: 101 } }),
    event('cast-return', { seq: 2, execIndex: 10 }),
    event('next-round', { round: 2, seq: 0 })
  ], { rounds: 2 });
  const v = project(freeze(r));
  assert.deepEqual(turn(v).sides.me.actions.map(a => a.pet.monsterId), [101, 111, 0, 0, 101]);
  assert.equal(action(v, 1, 'enemy').pet.monsterId, 201);
  assert.equal(state(v, 1, 'enemy').pet.monsterId, 201);
  assert.equal(action(v, 2).pet.monsterId, 101);
  assert.equal(r.sides.me.pets[0].monsterId, 101);
  assert.ok(turn(v).unassigned.includes(r.events[1]));
});

test('round seq explicit zero legacy form index stable ordering does not reorder input', () => {
  const events = [
    event('r2', { round: 2 }), event('legacy', { seq: 2, execIndex: undefined, form: { execIndex: 3 } }),
    event('two', { seq: 2, execIndex: 2 }), event('explicit-zero', { seq: 2, execIndex: 0, form: { execIndex: 5 } }),
    event('missing', { seq: 2, execIndex: undefined }), event('one', { seq: 2, execIndex: 1 }),
    event('same-one', { seq: 2, execIndex: 1 }), event('earlier-seq', { seq: 1, execIndex: 999 }),
    event('unknown-round', { round: undefined })
  ];
  const before = ids(events), v = project(freeze(record(events, { rounds: 2 })));
  assert.deepEqual(v.rounds.map(row => ids(row.events)), [['unknown-round'], ['earlier-seq', 'explicit-zero', 'missing', 'one', 'same-one', 'two', 'legacy'], ['r2']]);
  assert.deepEqual(ids(events), before);
});

test('overkill report642 stays separate from explicit HP loss340 and source event identity', () => {
  const r = freeze(record([event('cast'), legacyDamage(), resource()])), v = project(r), a = action(v);
  assert.equal(a.event, r.events[0]);
  assert.equal(a.damage, 642); assert.equal(a.hpLoss, 340); assert.equal(a.energyCost, 3); assert.equal(a.energyGain, null);
  assert.deepEqual(a.damageEvents, [r.events[1]]); assert.deepEqual(a.energyEvents, [r.events[2]]);
  assert.equal(r.events[1].protocolSkillId, undefined);
  assert.equal(state(v, 1, 'enemy').status, 'unknown', 'Damage alone does not prove target active');
});

test('multi-hit reports sum only attributed amounts; hpLoss null if any hit lacks explicit delta', () => {
  const v = project(record([event('cast'), damage({ amount: 40, hpChange: -30 }), damage({ id: 'second', execIndex: 3, amount: 15, hpChange: -10 })]));
  assert.equal(action(v).damage, 55); assert.equal(action(v).hpLoss, 40); assert.equal(action(v).damageEvents.length, 2);
  const incomplete = project(record([event('cast'), damage(), damage({ id: 'unknown-delta', execIndex: 3, amount: 9, hpChange: undefined })]));
  assert.equal(action(incomplete).damage, 651); assert.equal(action(incomplete).hpLoss, null);
  const unreported = project(record([event('cast'), damage({ amount: undefined })]));
  assert.equal(action(unreported).damage, null); assert.equal(action(unreported).hpLoss, 340);
  const zero = project(record([event('cast'), damage({ amount: 0, hpChange: 0 })]));
  assert.equal(action(zero).damage, 0); assert.equal(action(zero).hpLoss, 0);
  const noHit = project(record([event('cast')]));
  assert.equal(action(noHit).damage, null); assert.equal(action(noHit).hpLoss, null);
});

test('damage aggregates require every linked report and a finite safe-bounded total without losing evidence', () => {
  for (const amount of [undefined, null, '5', NaN, Infinity, -1, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1]) {
    const r = record([event('cast'), damage(), damage({ id: 'incomplete-report', execIndex: 3, amount })]);
    const v = project(freeze(r));
    assert.equal(action(v).damage, null, String(amount)); assert.equal(action(v).hpLoss, 680);
    assert.deepEqual(action(v).damageEvents, [r.events[1], r.events[2]]);
  }
  const overflow = project(record([event('cast'), damage({ amount: Number.MAX_SAFE_INTEGER }), damage({ id: 'one-too-many', execIndex: 3, amount: 1 })]));
  assert.equal(action(overflow).damage, null); assert.equal(action(overflow).damageEvents.length, 2);
  const boundary = project(record([event('cast'), damage({ amount: Number.MAX_SAFE_INTEGER - 1 }), damage({ id: 'last-safe', execIndex: 3, amount: 1 })]));
  assert.equal(action(boundary).damage, Number.MAX_SAFE_INTEGER);
  const hpOverflow = project(record([event('cast'), damage({ hpChange: -Number.MAX_SAFE_INTEGER }), damage({ id: 'hp-overflow', execIndex: 3, hpChange: -1 })]));
  assert.equal(action(hpOverflow).hpLoss, null); assert.equal(action(hpOverflow).damage, 1284);
  const fractional = project(record([event('cast'), damage({ amount: 1.25 }), damage({ id: 'fractional', execIndex: 3, amount: 2.5 })]));
  assert.equal(action(fractional).damage, 3.75);
});

test('legacy damage compatibility requires the complete exact generated signature, never prose hints', () => {
  const original = legacyDamage();
  for (const changed of [
    { id: original.id + '-extra' }, { id: original.id + '\n' }, { text: original.text + ' ' }, { text: original.text + '\n' },
    { text: original.text.slice(0, -1) }, { text: '来源标识 700' }, { text: original.text.replace('CSV逻辑行 597。', 'CSV逻辑行 ?。') },
    { text: original.text.replace('来源标识 700', '来源标识 00700') }, { text: original.text.replace('来源标识 700', '来源标识 701') },
    { kind: 'effect' }, { phase: 'preview' }, { protocolSkillId: 700 }, { protocolSkillId: 'other' }
  ]) {
    const d = { ...original, ...changed }, v = project(record([event('cast'), d]));
    assert.equal(action(v).damage, null, JSON.stringify(changed));
    assert.ok(turn(v).unassigned.includes(d));
  }
  const explicit = damage({ id: 'arbitrary-explicit', text: 'No legacy parsing needed' });
  assert.equal(action(project(record([event('cast'), explicit]))).damage, 642);
  assert.equal(action(project(record([event('cast', { protocolSkillId: '701', skillId: 700 }), damage()]))).damage, null, 'Local skillId never substitutes protocol ref');
});

test('damage matching requires complete same round seq side actor target and preceding index', () => {
  for (const changed of [
    { round: 2 }, { seq: 8 }, { side: 'enemy' }, { actor: 'b' }, { targetSide: 'me' }, { target: 'b' },
    { round: undefined }, { seq: undefined }, { side: 'unknown' }, { actor: undefined }, { targetSide: undefined }, { target: undefined },
    { execIndex: undefined }, { execIndex: 0 }, { execIndex: -1 }, { phase: 'interrupted' }
  ]) {
    const d = damage(changed), v = project(record([event('cast'), d], { rounds: 2 }));
    assert.equal(action(v).damage, null, JSON.stringify(changed));
    assert.ok(v.rounds.some(row => row.unassigned.includes(d)));
  }
  const before = project(record([event('cast', { execIndex: 4 }), damage()]));
  assert.equal(action(before).damage, null);
});

test('multiple same-protocol casts are ambiguous, not nearest-cast assignment; future casts do not match earlier damage', () => {
  const v = project(record([event('first'), event('second', { execIndex: 1 }), damage()]));
  assert.deepEqual(turn(v).sides.me.actions.map(a => a.damage), [null, null]);
  assert.ok(turn(v).unassigned.some(e => e.id === 'damage'));
  const interrupted = project(record([event('interrupted', { phase: 'interrupted' }), event('executed', { execIndex: 1 }), damage()]));
  assert.deepEqual(turn(interrupted).sides.me.actions.map(a => a.damage), [null, 642]);
  const later = project(record([event('first'), damage(), event('future', { execIndex: 3 })]));
  assert.deepEqual(turn(later).sides.me.actions.map(a => a.damage), [642, null]);
});

test('energy negative positive and explicit zero use only unique same-exec resource, including interrupted cost', () => {
  for (const [delta, cost, gain] of [[-3, 3, null], [5, null, 5], [0, 0, 0]]) {
    const v = project(record([event('cast'), resource({ energyChange: delta, energyAfter: 0 })]));
    assert.equal(action(v).energyCost, cost); assert.equal(action(v).energyGain, gain); assert.equal(state(v).energy, 0);
  }
  const interrupted = project(record([event('interrupted', { phase: 'interrupted' }), resource(), damage()]));
  assert.equal(action(interrupted).energyCost, 3); assert.equal(action(interrupted).damage, null);
  assert.equal(state(interrupted).status, 'unknown'); assert.equal(state(interrupted).confirmedActive, false);
  assert.deepEqual(turn(interrupted).sides.me.participants.map(p => p.instanceId), ['a']);
});

test('unknown active can retain a unique interrupted participant and explicit values, never an ambiguous candidate', () => {
  const v = project(record([
    event('interrupted', { phase: 'interrupted' }), resource({ hpAfter: 343, energyAfter: 10 }),
    event('interrupted-again', { round: 2, phase: 'interrupted' }), resource({ id: 'energy-round-2', round: 2, hpAfter: 228, energyAfter: 10 })
  ], { rounds: 3 }));
  for (const [round, hp] of [[1, 343], [2, 228], [3, 228]]) {
    const s = state(v, round);
    assert.equal(s.status, 'unknown'); assert.equal(s.confirmedActive, false); assert.equal(s.pet.instanceId, 'a');
    assert.equal(s.hp, hp); assert.equal(s.energy, 10); assert.equal(s.hpRound, Math.min(round, 2));
  }
  const ambiguous = project(record([
    event('interrupted-a', { phase: 'interrupted' }), resource({ hpAfter: 100 }),
    event('interrupted-b', { phase: 'interrupted', actor: 'b', seq: 8 }), resource({ id: 'energy-other-actor', actor: 'b', seq: 8, hpAfter: 200 })
  ]));
  assert.equal(state(ambiguous).status, 'unknown'); assert.equal(state(ambiguous).pet, null);
  assert.equal(state(ambiguous).hp, null); assert.equal(state(ambiguous).energy, null);
  assert.deepEqual(turn(ambiguous).sides.me.participants.map(p => p.instanceId), ['a', 'b']);
});

test('missing or ambiguous energy links stay unknown; nearby system gains never assign', () => {
  for (const changed of [
    { round: 2 }, { seq: 8 }, { execIndex: 1 }, { side: 'enemy' }, { actor: 'b' }, { phase: 'preview' },
    { round: undefined }, { seq: undefined }, { execIndex: undefined, form: { execIndex: 0 } },
    { side: 'unknown' }, { actor: undefined }, { energyChange: undefined }, { energyChange: '0' }
  ]) {
    const v = project(record([event('cast'), resource(changed)], { rounds: 2 }));
    assert.equal(action(v).energyCost, null, JSON.stringify(changed)); assert.equal(action(v).energyGain, null);
  }
  const twoActions = project(record([event('first'), event('second'), resource()]));
  assert.deepEqual(turn(twoActions).sides.me.actions.map(a => a.energyCost), [null, null]);
  const twoResources = project(record([event('cast'), resource(), resource({ id: 'also-energy' })]));
  assert.equal(action(twoResources).energyCost, null); assert.equal(turn(twoResources).unassigned.length, 2);
  const missingIndex = project(record([event('cast', { execIndex: undefined, form: { execIndex: 0 } }), resource()]));
  assert.equal(action(missingIndex).energyCost, null);
  const charge = project(record([event('charge', { kind: 'effect', skillClass: 'system', label: '聚能' }), resource({ execIndex: 3, energyChange: 5 })]));
  assert.equal(action(charge).energyGain, null); assert.equal(state(charge).energy, 7);
  assert.ok(turn(charge).unassigned.some(e => e.kind === 'resource'));
});

test('ordinary response and explicit system actions display; passive and arbitrary effect labels stay supplemental', () => {
  const v = project(record([
    event('ordinary'), event('response', { execIndex: 1, skillClass: 'response' }),
    event('legacy', { execIndex: 2, skillClass: undefined }), event('system', { execIndex: 3, kind: 'effect', skillClass: 'system', label: '愿力冲击' }),
    event('passive-effect', { execIndex: 4, kind: 'effect', skillClass: 'passive' }),
    event('passive-skill', { execIndex: 5, kind: 'skill', skillClass: 'passive' }),
    event('label-only', { execIndex: 6, kind: 'effect', skillClass: undefined, label: '聚能' }),
    resource({ id: 'system-resource', execIndex: 7, skillClass: 'system' }), event('selection', { phase: 'selection' }),
    event('unknown-side', { side: 'unknown' })
  ]));
  assert.deepEqual(turn(v).sides.me.actions.map(a => a.event.id), ['ordinary', 'response', 'legacy', 'system']);
  assert.deepEqual(new Set(ids(turn(v).unassigned)), new Set(['passive-effect', 'passive-skill', 'label-only', 'system-resource', 'selection', 'unknown-side']));
});

test('executed system actions are participants/candidates, never proof of active or a switch from the bench', () => {
  for (const kind of ['effect', 'skill']) {
    const system = event('system-b', { kind, skillClass: 'system', actor: 'b', label: '聚能' });
    const candidate = project(record([system, resource({ actor: 'b', hpAfter: 123, energyAfter: 4 })]));
    assert.equal(state(candidate).status, 'unknown'); assert.equal(state(candidate).confirmedActive, false);
    assert.equal(state(candidate).pet.instanceId, 'b'); assert.equal(state(candidate).hp, 123);
    assert.equal(action(candidate).event.id, 'system-b'); assert.equal(action(candidate).pet.instanceId, 'b');
    const active = project(record([
      event('ordinary-a'), resource({ hpAfter: 300, energyAfter: 7 }),
      { ...system, round: 2 }, resource({ id: 'energy-round-2', round: 2, actor: 'b', hpAfter: 123, energyAfter: 4 })
    ], { rounds: 2 }));
    assert.equal(state(active, 2).status, 'present'); assert.equal(state(active, 2).confirmedActive, true);
    assert.equal(state(active, 2).pet.instanceId, 'a'); assert.equal(state(active, 2).hp, 300);
    assert.equal(state(active, 2).energy, 7); assert.equal(state(active, 2).sourceRound, 1);
    assert.deepEqual(turn(active, 2).sides.me.participants.map(p => p.instanceId), ['a', 'b']);
    const empty = project(record([event('ordinary-a'), faint(), { ...system, round: 2 }], { rounds: 2 }));
    assert.equal(state(empty, 2).status, 'empty'); assert.equal(state(empty, 2).pet, null);
    assert.equal(turn(empty, 2).sides.me.replacements.length, 0);
  }
});

test('bench damage/resource/passive/form never establish active; later switch can show explicitly recorded stale values', () => {
  const v = project(record([
    damage({ side: 'enemy', actor: 'a', targetSide: 'me', target: 'b', hpAfter: 17 }),
    resource({ actor: 'b', execIndex: 3, energyAfter: 4 }),
    event('bench-passive', { actor: 'b', execIndex: 4, kind: 'effect', skillClass: 'passive' }),
    event('bench-form', { actor: 'b', execIndex: 5, kind: 'form', form: { toMonsterId: 103 } }),
    event('switch', { round: 2, actor: 'b', kind: 'switch', target: 'a', targetSide: 'me' })
  ], { rounds: 2 }));
  assert.deepEqual(turn(v).sides.me.participants, []); assert.equal(state(v).status, 'unknown');
  assert.equal(state(v, 2).pet.instanceId, 'b'); assert.equal(state(v, 2).pet.monsterId, 103);
  assert.equal(state(v, 2).hp, 17); assert.equal(state(v, 2).energy, 4);
  assert.equal(state(v, 2).hpRound, 1); assert.equal(state(v, 2).energyRound, 1); assert.equal(state(v, 2).sourceRound, 2);
  assert.deepEqual(turn(v, 2).sides.me.replacements, []);
});

test('impossible residual deltas stay unknown until a source result arrives; HP0 is not a death notification', () => {
  const v = project(record([
    event('cast'), resource({ hpAfter: 100, energyAfter: 5 }),
    damage({ round: 2, targetSide: 'me', target: 'a', hpAfter: undefined, hpChange: -999 }),
    resource({ id: 'energy-round-2', round: 2, energyAfter: undefined, energyChange: -9 }),
    event('third', { round: 3 }), resource({ id: 'energy-round-3', round: 3, hpAfter: 0, energyAfter: 0 })
  ], { rounds: 4 }));
  assert.equal(state(v, 2).hp, null); assert.equal(state(v, 2).energy, null);
  assert.equal(state(v, 2).hpRound, 2); assert.equal(state(v, 2).energyRound, 2); assert.equal(state(v, 2).sourceRound, 2);
  assert.equal(state(v, 3).status, 'present'); assert.equal(state(v, 3).hp, 0); assert.equal(state(v, 3).energy, 0);
  assert.equal(state(v, 4).sourceRound, 3); assert.equal(state(v, 4).hpRound, 3); assert.equal(state(v, 4).energyRound, 3);
  assert.equal(turn(v, 4).sides.me.replacements.length, 0);
});

test('exact confirmed-active faint clears slot; immediate next-round supply attaches prior fourth row at supply-time snapshot', () => {
  const r = record([
    event('cast'), resource({ actor: 'b', execIndex: 1, hpAfter: 80, energyAfter: 4 }), faint(),
    supply(), event('later-cast', { round: 2, seq: 2, actor: 'b' }), resource({ id: 'energy-round-2', round: 2, seq: 2, actor: 'b', hpAfter: 30, energyAfter: 1 })
  ], { rounds: 2 });
  const v = project(freeze(r)), replacement = turn(v).sides.me.replacements[0];
  assert.equal(state(v).status, 'empty'); assert.equal(state(v).pet, null); assert.equal(state(v).hp, null);
  assert.equal(state(v).sourceRound, 1); assert.equal(state(v).confirmedActive, false);
  assert.equal(replacement.pet.instanceId, 'b'); assert.equal(replacement.hp, 80); assert.equal(replacement.energy, 4);
  assert.equal(replacement.sourceRound, 2); assert.equal(replacement.hpRound, 1); assert.equal(replacement.energyRound, 1);
  assert.equal(state(v, 2).hp, 30); assert.equal(state(v, 2).energy, 1);
  assert.equal(turn(v, 2).sides.me.replacements.length, 0);
  assert.ok(turn(v, 2).unassigned.includes(r.events[3]));
  assert.ok(replacement.evidence.includes(r.events[3]));
  assert.ok(!replacement.evidence.includes(r.events[5]));
});

test('same-round supply uses its own row; no cross-round attachment after first action or a missing round', () => {
  const same = project(record([event('cast'), faint(), supply({ round: 1, seq: 8 })]));
  assert.equal(turn(same).sides.me.replacements[0].sourceRound, 1); assert.equal(state(same).pet.instanceId, 'b');
  for (const preceding of [event('interrupted', { round: 2, seq: 0, phase: 'interrupted' }), event('executed', { round: 2, seq: 0 })]) {
    const v = project(record([event('cast'), faint(), preceding, supply()], { rounds: 2 }));
    assert.equal(turn(v).sides.me.replacements.length, 0); assert.equal(turn(v, 2).sides.me.replacements.length, 1);
  }
  const delayed = project(record([event('cast'), faint(), supply({ round: 3 })], { rounds: 3 }));
  assert.equal(turn(delayed).sides.me.replacements.length, 0); assert.equal(turn(delayed, 3).sides.me.replacements.length, 1);
});

test('faint/supply compatibility rejects generic labels, partial signatures, unknown instances and other phases', () => {
  const f = faint(), s = supply();
  for (const changed of [{ id: 'faint' }, { id: f.id + '\n' }, { label: '倒下' }, { text: f.text + ' ' }, { text: f.text + '\n' }, { phase: 'preview' }, { kind: 'note' }, { actor: 'b' }]) {
    const v = project(record([event('cast'), { ...f, ...changed }]));
    assert.equal(state(v).status, 'present', JSON.stringify(changed));
  }
  for (const changed of [{ id: 'supply' }, { id: s.id + '\n' }, { label: '补位' }, { text: s.text + ' ' }, { phase: 'preview' }, { kind: 'note' }, { actor: 'a' }, { actor: 'missing', id: 'rkpp:action:2:1:0:supply:missing' }]) {
    const v = project(record([event('cast'), f, { ...s, ...changed }], { rounds: 2 }));
    assert.equal(state(v, 2).status, 'empty', JSON.stringify(changed));
    assert.equal(turn(v).sides.me.replacements.length, 0);
  }
  const unconfirmed = project(record([event('interrupted', { phase: 'interrupted' }), f]));
  assert.equal(state(unconfirmed).status, 'unknown', 'Faint of an unconfirmed actor cannot clear a known active slot');
});

test('ordinary switches never become death replacements, including after HP0 or known empty', () => {
  for (const preceding of [resource({ hpAfter: 0 }), faint()]) {
    const v = project(record([event('cast'), preceding, event('tactical-switch', { kind: 'switch', seq: 8, actor: 'b', targetSide: 'me', target: 'a' })]));
    assert.equal(state(v).pet.instanceId, 'b'); assert.equal(turn(v).sides.me.replacements.length, 0);
  }
  const unknown = project(record([event('cast'), event('unknown-switch', { seq: 8, kind: 'switch', actor: undefined })]));
  assert.equal(state(unknown).status, 'unknown'); assert.equal(state(unknown).pet, null);
});

test('lifecycle exact legacy/new metadata stays separate; arbitrary notes and huge authoritative gaps are preserved', () => {
  const legacy = { kind: 'note', id: 'rkpp:131a:2', round: 2, text: 'Observed RKPP round_start; gameplay attribution unavailable.' };
  const explicit = { kind: 'note', id: 'new-finish', lifecycle: 'finish', round: 0 };
  const notLifecycle = [ { ...legacy, id: 'rkpp:131a:02' }, { ...legacy, text: legacy.text + ' ' }, { ...legacy, lifecycle: 'toString' }, { ...legacy, kind: 'effect' } ];
  const v = project(freeze(record([legacy, explicit], { rounds: 3 })));
  assert.deepEqual(new Set(v.lifecycle), new Set([legacy, explicit]));
  assert.equal(v.rounds.length, 3);
  for (const variant of notLifecycle) {
    const isolated = project(freeze(record([variant], { rounds: 3 })));
    assert.equal(isolated.lifecycle.length, 0);
    assert.equal(turn(isolated, 2).unassigned.length, 1);
  }
  assert.deepEqual(project({ events: [legacy] }).rounds, []);
  assert.deepEqual(project({ rounds: '36', events: [] }).rounds, []);
  const sparse = project({ rounds: 1000000, events: [event('later', { round: 999999 })] });
  assert.equal(sparse.rounds.length, 3); assert.equal(sparse.rounds[0].endRound, 999998); assert.equal(sparse.rounds[2].round, 1000000);
});

test('prototype-like instance IDs and duplicate species do not merge side or instance state', () => {
  const r = record([event('one', { actor: '__proto__' }), resource({ actor: '__proto__', hpAfter: 45 }), event('two', { actor: 'b', seq: 8 })]);
  r.sides.me.pets[0].instanceId = '__proto__'; r.sides.me.pets[1].monsterId = 101;
  const v = project(freeze(r));
  assert.equal(action(v).pet.monsterId, 101); assert.equal(action(v, 1, 'me', 1).pet.monsterId, 101);
  assert.equal(state(v).hp, null); assert.equal(state(v).pet.instanceId, 'b');
  assert.equal(state(v, 1, 'enemy').status, 'unknown');
});

test('optional current real200 frozen backup: exact counts, all26 hits,24 energy links, faint/supply/forms', { skip: !process.env.BATTLE_TURN_VIEW_FIXTURE }, () => {
  const bytes = fs.readFileSync(process.env.BATTLE_TURN_VIEW_FIXTURE, 'utf8');
  const r = freeze(JSON.parse(bytes)), v = project(r), actions = v.rounds.flatMap(row => Object.values(row.sides).flatMap(side => side.actions));
  checkShape(v);
  assert.equal(r.events.length, 200); assert.equal(v.rounds.length, 36); assert.equal(v.lifecycle.length, 38);
  assert.equal(v.rounds.reduce((n, row) => n + row.events.length, 0), 162);
  assert.equal(actions.reduce((n, a) => n + a.damageEvents.length, 0), 26);
  assert.equal(actions.reduce((n, a) => n + a.energyEvents.length, 0), 24);
  assert.equal(v.rounds.flatMap(row => row.unassigned).filter(e => e.kind === 'resource' && Number.isSafeInteger(e.energyChange)).length, 8);
  const overkill = action(v, 8, 'enemy');
  assert.equal(overkill.damage, 642); assert.equal(overkill.hpLoss, 340); assert.equal(overkill.energyCost, 8);
  assert.equal(action(v, 8).event.phase, 'interrupted'); assert.equal(action(v, 8).energyCost, 3); assert.equal(action(v, 8).damage, null);
  for (const [round, side, sourceRound, instanceId] of [[8, 'me', 9, '2'], [25, 'enemy', 26, '401'], [26, 'me', 27, '2']]) {
    assert.equal(state(v, round, side).status, 'empty');
    const replacement = turn(v, round).sides[side].replacements[0];
    assert.equal(replacement.sourceRound, sourceRound); assert.equal(replacement.pet.instanceId, instanceId);
  }
  assert.equal(turn(v, 8).sides.me.replacements[0].energy, null, 'No future round9 cost state leaks into supply snapshot');
  assert.equal(state(v, 1).status, 'unknown', 'Interrupted initial actor is not confirmed active');
  assert.equal(state(v, 1).confirmedActive, false); assert.equal(state(v, 1).pet.instanceId, '3');
  assert.equal(state(v, 1).hp, 343); assert.equal(state(v, 2).hp, 228); assert.equal(state(v, 2).energy, 10);
  assert.equal(state(v, 20, 'enemy').pet.monsterId, 73); assert.equal(state(v, 21, 'enemy').pet.monsterId, 72);
  assert.equal(state(v, 22, 'enemy').pet.monsterId, 103);
  assert.equal(v.rounds.flatMap(row => row.unassigned).filter(e => e.kind === 'form').length, 7);
  assert.equal(action(v, 4, 'enemy').event.label, '聚能'); assert.equal(action(v, 4, 'enemy').energyGain, null);
  assert.equal(JSON.stringify(r), JSON.stringify(JSON.parse(bytes)));
});
