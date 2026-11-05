'use strict';
// Reuse only the existing isolated DOM/API harness, not its registered tests.
// Every request resolves in memory; these tests never connect to a profile, DB or relay.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const harnessPath = path.join(__dirname, 'battle-records-ui.test.js');
const harness = fs.readFileSync(harnessPath, 'utf8');
const sandbox = { module: { exports: {} }, require: createRequire(harnessPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
vm.runInNewContext(harness.slice(0, harness.indexOf('\ntest(')) + '\nmodule.exports = runtime;', sandbox, { filename: harnessPath });
const runtime = sandbox.module.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = body => ({ ok: true, json: async () => body });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const nodes = (r, cls) => r.all().filter(node => node.className.split(' ').includes(cls));
const overlay = r => nodes(r, 'br-modal-root')[0];
const body = r => nodes(r, 'br-dialog-body')[0];
const dialog = r => nodes(r, 'br-dialog')[0];
const main = r => nodes(r, 'br-rounds')[0];
async function mount(t, options = {}) { const r = runtime(options); t.after(() => r.page.onLeave()); await tick(); return r; }
async function opened(t, options = {}) { const r = await mount(t, options); r.btn('查看详情').click(); await tick(); return r; }
function fixture() {
  return { version: 1, id: 'modal-isolated', rounds: 2, outcome: 'win', quality: {},
    sides: { me: { pets: [{ instanceId: 'a', monsterId: 35 }] }, enemy: { pets: [{ instanceId: 'b', monsterId: 42 }] } }, events: [] };
}
function projectedFixture() {
  const pet = { instanceId: 'a', monsterId: 35, declaredName: '不可信来源名' };
  const enemy = { instanceId: 'b', monsterId: 42, declaredName: '别名' };
  const blank = status => ({ status, pet: null, hp: null, energy: null, hpRound: null, energyRound: null, sourceRound: 1, confirmedActive: false, evidence: [] });
  const event = (id, properties = {}) => ({ id, round: 1, seq: 1, execIndex: 0, side: 'me', actor: 'a', kind: 'skill', phase: 'executed', skillId: 37, ...properties });
  const action = (event, properties = {}) => ({ event, pet, damage: null, hpLoss: null, energyCost: null, energyGain: null, damageEvents: [], energyEvents: [], ...properties });
  const side = (pet, properties = {}) => ({ participants: pet ? [pet] : [], actions: [], endState: blank('unknown'), replacements: [], notes: [], ...properties });
  const events = [event('ordinary'), event('interrupted', { phase: 'interrupted', side: 'enemy', actor: 'b' }), event('wish', { skillId: 38 }), event('charge', { skillId: 39, skillClass: 'system' }), event('unsafe', { skillId: 0, label: '<img src=x onerror=evil()>' })];
  const current = { ...blank('present'), pet, hp: 0, energy: 2, hpRound: 1, energyRound: 1, confirmedActive: true };
  return { rounds: [
    { round: 1, events, unassigned: [event('unassigned', { kind: 'damage', amount: 999 })], sides: {
      me: side(pet, { actions: [action(events[0], { hpLoss: 340, damage: 642, energyCost: 0 }), action(events[2]), action(events[3], { energyGain: 4 }), action(events[4])], endState: current }),
      enemy: side(enemy, { actions: [action(events[1], { pet: enemy, damage: 888, hpLoss: 777, energyCost: 2, energyGain: 5 })], endState: blank('empty'), replacements: [{ ...current, pet: enemy, hp: 123, energy: null, sourceRound: 2, hpRound: 2 }] })
    } },
    { round: 2, events: [], unassigned: [], sides: { me: side(null, { endState: { ...current, sourceRound: 1 } }), enemy: side(null, { endState: blank('empty') }) } }
  ], lifecycle: [], warnings: ['projected-warning-must-not-mount'] };
}
const catalogue = {
  getMonsterById: id => [35, 42].includes(id) ? { id, image: id === 35 ? '正确头像.png?v=exact' : '敌方头像.png?v=exact' } : null,
  getMonsterDisplayName: pet => pet.id === 35 ? '正确形态' : '敌方形态',
  getMoves: () => [{ id: 37, name: '规范技能' }, { id: 38, name: '愿力冲击' }, { id: 39, name: '聚能' }],
  getMoveName: move => move.name
};

test('list cards remove old metadata and warnings, retain exact time label and only actual rank fields', async t => {
  const record = fixture(); record.rounds = 36; record.durationSeconds = 0;
  record.source = 'source-must-not-mount'; record.mode = 'mode-must-not-mount';
  record.quality = { roster: { me: true, enemy: true }, actions: false };
  record.sides.me.before = { score: 0 }; record.sides.me.after = { rank: 3, tier: '明示段位' };
  record.sides.enemy.before = { score: null, rank: 0, tier: '' }; record.sides.enemy.after = {};
  const before = JSON.stringify(record), r = await mount(t, { record: freeze(record) });
  const list = nodes(r, 'br-match-list')[0], card = list.children[0];
  assert.equal(card.children[1].textContent, '对战回合：36回合；对战用时：0分钟0秒');
  assert.doesNotMatch(card.textContent, /modal-isolated|source-must-not-mount|mode-must-not-mount|声明完整|不完整|结算回合|行动明细按需加载|已记录事件|事件数不是回合数/);
  const summaries = r.all(card).filter(n => n.className === 'br-side-summary');
  assert.match(summaries[0].textContent, /赛前 积分 0/); assert.match(summaries[0].textContent, /赛后 榜单名次 3 · 段位 明示段位/);
  assert.doesNotMatch(summaries[0].textContent, /积分 未知|榜单名次 未知|段位 未知/);
  assert.doesNotMatch(summaries[1].textContent, /赛前|赛后|积分|榜单名次|段位/);
  assert.ok(r.btn('查看详情')); r.btn('查看详情').click(); await tick();
  assert.match(body(r).textContent, /对战回合：36回合；对战用时：0分钟0秒/);
  assert.doesNotMatch(body(r).textContent, /结算回合|已记录事件|事件数不是回合数|逐回合对战/);
  assert.equal(main(r).getAttribute('aria-label'), '回合行动');
  assert.equal(JSON.stringify(record), before); assert.equal(r.calls.some(c => c.options.method), false);
});

test('list and modal use normalized outcome/start only and omit unknown duration instead of a guessed clock', async t => {
  for (const durationSeconds of [undefined, null, '0', -1, 0, 61]) {
    const record = fixture(); record.rounds = 36; record.outcome = 'loss'; record.startedAt = '2026-11-01T01:02:03Z';
    record.finishedAt = '2026-11-01T02:02:03Z'; record.durationSeconds = durationSeconds;
    record.events = [{ id: 'misleading-note', kind: 'note', round: 283, text: 'win / victory / 胜利' }];
    const before = JSON.stringify(record), r = await opened(t, { record: freeze(record) });
    const list = nodes(r, 'br-match-list')[0], label = list.children[0].children[1].textContent;
    assert.equal(nodes(r, 'br-outcome')[0].textContent, '失败');
    assert.equal(r.all(list).find(n => n.tagName === 'time').textContent, new Date(record.startedAt).toLocaleString('zh-CN', { hour12: false }));
    const expected = '对战回合：36回合' + (durationSeconds === 0 ? '；对战用时：0分钟0秒' : durationSeconds === 61 ? '；对战用时：1分钟1秒' : '');
    assert.equal(label, expected); assert.equal(body(r).children[1].textContent, expected);
    assert.match(body(r).children[0].textContent, /^失败/); assert.doesNotMatch(label, /用时未知|60分钟|283|已记录事件|时间未知/);
    assert.equal(JSON.stringify(record), before); r.page.onLeave();
  }
});

test('initial roster avatars preserve six original instances/order and canonical forms, never nicknames or later forms', async t => {
  const record = fixture();
  for (const side of ['me', 'enemy']) record.sides[side] = {
    pets: Array.from({ length: 6 }, (_, i) => ({ instanceId: `${side}-${i}`, monsterId: i === 4 ? 0 : i === 5 ? 999 : i % 2 ? 42 : 35, name: i === 4 ? '正确形态' : '假昵称', protocolBaseId: '35', protocolId: '35', image: '正确头像.png' })), lead: `${side}-3`
  };
  record.quality = { lead: { me: true, enemy: false } };
  record.events = [{ id: 'late-form', round: 1, kind: 'form', phase: 'executed', side: 'me', actor: 'me-0', form: { fromMonsterId: 35, toMonsterId: 42 } }];
  const before = JSON.stringify(record), r = await mount(t, { record: freeze(record), data: catalogue });
  const list = nodes(r, 'br-match-list')[0], rosters = r.all(list).filter(n => n.className === 'br-roster');
  assert.equal(rosters.length, 2);
  for (const [index, side] of ['me', 'enemy'].entries()) {
    const items = rosters[index].children; assert.equal(items.length, 6);
    assert.deepEqual(Array.from(items, n => n.dataset.instanceId), record.sides[side].pets.map(p => p.instanceId));
    assert.deepEqual(Array.from(items, n => n.dataset.side), Array(6).fill(side));
    assert.equal(items[0].title, '正确形态'); assert.equal(items[1].title, '敌方形态');
    assert.equal(items[0].children[0].children[0].src, 'assets/monster/images/' + encodeURIComponent('正确头像.png') + '?v=exact');
    assert.equal(items[1].children[0].children[0].src, 'assets/monster/images/' + encodeURIComponent('敌方头像.png') + '?v=exact');
    assert.equal(items[4].children[0].children.length, 0); assert.match(items[4].title, /身份未映射.*来源名：正确形态/);
    assert.equal(items[5].children[0].children.length, 0); assert.match(items[5].title, /未收录精灵 #999/);
    assert.ok(items.every(n => n.tabIndex === 0 && n.getAttribute('aria-label') === n.title));
    assert.doesNotMatch(rosters[index].textContent, /#35|#42|假昵称|正确形态|敌方形态/);
  }
  assert.equal(nodes(r, 'br-lead-badge').length, 1); assert.equal(rosters[0].children[3].dataset.lead, 'true');
  assert.match(rosters[0].children[3].title, /敌方形态 · 首发（已确认）/);
  assert.equal(JSON.stringify(record), before); assert.equal(r.calls.some(c => c.options.method), false);
});

test('lead badges require explicit quality and unique exact same-side instance, never first item or action actor', async t => {
  for (const [quality, lead, duplicate, expected] of [[true, 'b', false, 1], [false, 'b', false, 0], [undefined, 'b', false, 0], [1, 'b', false, 0], [true, '', false, 0], [true, 'missing', false, 0], [true, 0, false, 0], [true, 'b', true, 0]]) {
    const record = fixture(); record.sides.me.pets = [{ instanceId: 'a', monsterId: 35 }, { instanceId: 'b', monsterId: 42 }];
    record.sides.me.lead = lead; record.quality = { lead: { me: quality, enemy: true } };
    record.sides.enemy.lead = 'a'; // Another side's instance cannot resolve this side's lead.
    if (duplicate) record.sides.me.pets.push({ instanceId: 'b', monsterId: 35 });
    record.events = [{ id: 'first-action', round: 1, seq: 1, kind: 'skill', phase: 'executed', side: 'me', actor: 'a' }];
    const r = await mount(t, { record: freeze(record), data: catalogue });
    const leads = nodes(r, 'br-roster-pet').filter(n => n.dataset.lead === 'true'); assert.equal(leads.length, expected);
    if (expected) assert.equal(leads[0].dataset.instanceId, 'b');
    r.page.onLeave();
  }
});

test('matching rank is unphased and sparse; raw stars never manufacture a tier or pre/post value', async t => {
  const record = fixture(); record.sides.me.matching = { score: 0, rank: 12, stars: 0 };
  record.sides.enemy.matching = { tier: '来源段位', stars: 8 };
  const r = await mount(t, { record: freeze(record) });
  const summaries = nodes(r, 'br-side-summary');
  assert.match(summaries[0].textContent, /匹配时 积分 0 · 榜单名次 12 · 星数 0/);
  assert.doesNotMatch(summaries[0].textContent, /赛前|赛后|段位/);
  assert.match(summaries[1].textContent, /匹配时 段位 来源段位 · 星数 8/);
  assert.doesNotMatch(summaries[1].textContent, /赛前|赛后|积分|榜单名次/);
});

test('roster own configuration is a safe read-only hover/focus tooltip with no inference/fetch on hover', async t => {
  const record = fixture(); record.sides.me.pets[0].iv = {
    hp: { certainty: 'direct', value: 0 }, attack: { certainty: 'direct', value: 60 },
    defense: { certainty: 'candidate', candidates: [0, 60] }, speed: { certainty: 'unique', value: 42 }, magic_attack: { certainty: 'direct', value: '10' }
  };
  record.sides.me.pets[0].nature = { hp: { certainty: 'direct', value: 0 }, magic_attack: { certainty: 'direct', value: 2 }, speed: { certainty: 'direct', value: 1 }, defense: { certainty: 'direct', value: 3 } };
  record.sides.enemy.pets[0].iv = { hp: { certainty: 'direct', value: 59 } };
  record.sides.me.lead = 'a'; record.quality = { lead: { me: true } };
  const before = JSON.stringify(record); let projectCalls = 0;
  const r = await mount(t, { record: freeze(record), data: catalogue, speedInference: { project() { projectCalls++; throw Error('Must not run for list or hover'); } } });
  const anchor = nodes(r, 'br-roster-pet')[0], count = r.calls.length;
  anchor.focus(); let tip = nodes(r, 'br-pet-tooltip')[0];
  assert.ok(tip); assert.equal(tip.getAttribute('role'), 'tooltip'); assert.equal(anchor.getAttribute('aria-describedby'), tip.id);
  assert.equal(r.root.document.activeElement === anchor, true); assert.equal(anchor.title, '', 'Native title is suppressed while custom tooltip is open');
  assert.match(tip.textContent, /正确形态 · 首发（已确认）.*记录配置.*生命：个体 0 · 中性.*物攻：个体 60.*魔攻：负性格.*速度：正性格/);
  assert.doesNotMatch(tip.textContent, /来源直接声明|条件下唯一|个体 42|59|防御|未知|速度推测/);
  assert.equal(r.layers.at(-1).anchor === anchor, true); assert.equal(r.layers.at(-1).options.avoidAnchor, true);
  assert.equal(r.layers.at(-1).matchWidth, false); assert.equal(r.layerBindings.size, 1);
  anchor.emit('pointerleave'); assert.equal(r.timers.size, 0, 'Focused tooltip remains visible when pointer leaves');
  r.root.document.emit('keydown', { key: 'Escape' }); assert.equal(nodes(r, 'br-pet-tooltip').length, 0); assert.equal(anchor.getAttribute('aria-describedby'), null);
  assert.match(anchor.title, /记录配置/); assert.equal(r.layerBindings.size, 0);
  r.btn('查看详情').focus(); anchor.emit('pointerenter'); tip = nodes(r, 'br-pet-tooltip')[0];
  anchor.emit('pointerleave'); assert.equal(r.timers.size, 1); tip.emit('pointerenter'); assert.equal(r.timers.size, 0, 'Pointer can cross to and read the tooltip');
  r.root.document.emit('scroll', { target: r.host }); assert.equal(nodes(r, 'br-pet-tooltip').length, 0);
  nodes(r, 'br-roster-pet')[1].emit('pointerenter'); assert.doesNotMatch(nodes(r, 'br-pet-tooltip')[0].textContent, /记录配置|速度推测|59/);
  assert.equal(projectCalls, 0); assert.equal(r.calls.length, count); assert.equal(JSON.stringify(record), before);
  r.page.onLeave(); assert.equal(r.layerBindings.size, 0); assert.equal(r.timers.size, 0); assert.equal(nodes(r, 'br-pet-tooltip').length, 0);
});

test('own speed is labeled opening speed only and never substituted from recorded ranges or current form', async t => {
  for (const speed of [undefined, null, 0, '260', -1, 1.5, 1000001, 260]) {
    const record = fixture(); record.sides.me.pets[0].speed = speed;
    record.sides.me.pets[0].speedMin = 100; record.sides.me.pets[0].speedMax = 300;
    record.sides.enemy.pets[0].speedMin = 110; record.sides.enemy.pets[0].speedMax = 310;
    const projected = projectedFixture(); projected.rounds[0].sides.me.participants[0].monsterId = 42;
    const before = JSON.stringify([record, projected]), r = await mount(t, { record: freeze(record), data: catalogue, projector: { project: () => freeze(projected) } });
    nodes(r, 'br-roster-pet')[0].emit('pointerenter'); let tip = nodes(r, 'br-pet-tooltip')[0];
    assert.equal(tip.textContent.includes('开场速度：260'), speed === 260);
    assert.doesNotMatch(tip.textContent, /当前速度|当前形态速度|100|300|310/);
    nodes(r, 'br-roster-pet')[1].emit('pointerenter'); assert.doesNotMatch(nodes(r, 'br-pet-tooltip')[0].textContent, /开场速度|110|310/);
    r.btn('查看详情').click(); await tick();
    const me = nodes(r, 'br-round')[0].children.find(n => n.dataset.row === 'pets').children[0].children[0];
    me.emit('pointerenter'); tip = nodes(r, 'br-pet-tooltip')[0];
    assert.match(tip.textContent, /敌方形态/); assert.equal(tip.textContent.includes('开场速度：260'), speed === 260);
    assert.doesNotMatch(tip.textContent, /当前速度|当前形态速度/);
    assert.equal(JSON.stringify([record, projected]), before); assert.equal(r.calls.some(c => c.options.method), false); r.page.onLeave();
  }
});

test('modal inference is projected once and grouped without gaps becoming facts; removed damage handoff leaves raw data immutable', async t => {
  const record = freeze(fixture()), projected = freeze(projectedFixture());
  const candidates = [{ iv: 4, nature: 0, speed: 104 }, { iv: 1, nature: 0, speed: 101 }, { iv: 0, nature: 0, speed: 100 }, { iv: 2, nature: 0, speed: 102 }, { iv: 60, nature: 0, speed: 130 }, { iv: 60, nature: 2, speed: 117 }, { iv: 0, nature: 1, speed: 110 }, { iv: 2, nature: 0, speed: 102 }];
  const inferred = freeze({ sides: { me: { a: { status: 'inferred', candidates: [{ iv: 59, nature: 1, speed: 140 }] } }, enemy: { b: { monsterId: 42, status: 'inferred', relation: 'equal', message: '<img>同速仍有候选', candidates } } } });
  const before = JSON.stringify([record, projected, inferred]); let calls = 0;
  const r = await mount(t, { record, data: catalogue, projector: { project: () => projected }, speedInference: { project(input, options) {
    calls++; assert.equal(input === record, true); assert.deepEqual(Object.keys(options), ['getMonsterById']);
    assert.deepEqual(options.getMonsterById(42), catalogue.getMonsterById(42)); return inferred;
  } } });
  assert.equal(calls, 0); r.btn('查看详情').click(); await tick(); assert.equal(calls, 1);
  const row = nodes(r, 'br-round')[0].children.find(n => n.dataset.row === 'pets');
  const enemy = row.children[1].children[0], me = row.children[0].children[0], count = r.calls.length;
  enemy.focus(); let tip = nodes(r, 'br-pet-tooltip')[0];
  assert.match(tip.textContent, /敌方形态.*速度推测.*<img>同速仍有候选.*中性：个体 0–2、4、60.*加速：个体 0.*减速：个体 60/);
  assert.doesNotMatch(tip.textContent, /0–60|确定|个体 59/); assert.equal(r.all(tip).some(n => n.tagName === 'img'), false);
  assert.equal(tip.parentNode === overlay(r), true); assert.equal(calls, 1); assert.equal(r.calls.length, count);
  r.root.document.emit('keydown', { key: 'Escape' }); assert.ok(overlay(r)); assert.equal(nodes(r, 'br-pet-tooltip').length, 0, 'First Escape dismisses tooltip, not the modal');
  me.focus(); assert.doesNotMatch(nodes(r, 'br-pet-tooltip')[0].textContent, /速度推测|59/);
  assert.equal(r.btn('用于伤害计算'), undefined); assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, ''); r.btn('关闭').click(); assert.equal(overlay(r), undefined);
  assert.equal(nodes(r, 'br-pet-tooltip').length, 0); assert.equal(r.layerBindings.size, 0);
  assert.equal(JSON.stringify([record, projected, inferred]), before); assert.equal(r.calls.some(c => c.options.method), false);
});

test('real read-only speed projector integrates without profile IO or changing the raw record', async t => {
  const record = fixture(); record.sides.enemy.pets[0].level = 60;
  record.sides.enemy.pets[0].speed = require('../js/battle-math.js').statFromEffectiveIV(100, 'speed', 0, 0, 60);
  const projected = freeze(projectedFixture()), before = JSON.stringify(record);
  const r = await opened(t, { record: freeze(record), data: { ...catalogue, getMonsterById: id => { const pet = catalogue.getMonsterById(id); return pet && { ...pet, base_spd: 100 }; } }, projector: { project: () => projected }, speedInference: require('../js/battle-speed-inference.js') });
  const enemy = nodes(r, 'br-round')[0].children.find(n => n.dataset.row === 'pets').children[1].children[0];
  enemy.emit('pointerenter'); const tip = nodes(r, 'br-pet-tooltip')[0];
  assert.match(tip.textContent, /速度推测/); assert.match(tip.textContent, /中性：个体/);
  assert.equal(r.btn('用于伤害计算'), undefined); assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, ''); assert.equal(JSON.stringify(record), before);
  assert.equal(r.calls.some(c => c.options.method), false);
});

test('inference tooltip requires successful exact side/instance/form result, and unique remains a prediction', async t => {
  for (const [status, monsterId, instance, expected] of [['inferred', 42, 'b', true], ['direct', 42, 'b', true], ['insufficient', 42, 'b', false], ['conflict', 42, 'b', false], ['inferred', 35, 'b', false], ['inferred', 42, 'a', false]]) {
    const projected = freeze(projectedFixture()), record = freeze(fixture());
    const result = freeze({ sides: { me: { b: { status: 'inferred', monsterId: 42, candidates: [{ iv: 58, nature: 0, speed: 99 }] } }, enemy: { [instance]: { status, monsterId, message: '仅本条件下候选', candidates: [{ iv: 0, nature: 0, speed: 100 }] } } } });
    const r = await opened(t, { record, data: catalogue, projector: { project: () => projected }, speedInference: { project: () => result } });
    const enemy = nodes(r, 'br-round')[0].children.find(n => n.dataset.row === 'pets').children[1].children[0];
    enemy.emit('pointerenter'); const text = nodes(r, 'br-pet-tooltip')[0].textContent;
    assert.equal(text.includes('速度推测'), expected, `${status}/${monsterId}/${instance}`);
    if (expected) assert.match(text, /速度推测.*中性：个体 0/);
    assert.doesNotMatch(text, /58/); r.page.onLeave();
  }
});

test('tooltip lifecycle clears on refresh, modal open/close, route leave and dependency error', async t => {
  const r = await mount(t, { record: freeze(fixture()), data: catalogue, speedInference: { project() { throw Error('Inference unavailable'); } } });
  const first = nodes(r, 'br-roster-pet')[0]; first.emit('pointerenter'); assert.equal(nodes(r, 'br-pet-tooltip').length, 1);
  r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); assert.equal(nodes(r, 'br-pet-tooltip').length, 0); assert.equal(r.layerBindings.size, 0); await tick();
  const next = nodes(r, 'br-roster-pet')[0]; next.emit('pointerenter'); next.emit('pointerleave');
  r.btn('查看详情').click(); assert.equal(nodes(r, 'br-pet-tooltip').length, 0); assert.equal(r.timers.size, 0); await tick();
  assert.ok(main(r)); assert.doesNotMatch(body(r).textContent, /Inference unavailable/);
  first.emit('pointerenter'); assert.equal(nodes(r, 'br-pet-tooltip').length, 0, 'Detached/inert list anchors cannot open above a modal');
  r.btn('关闭').click(); next.focus(); assert.equal(nodes(r, 'br-pet-tooltip').length, 1);
  r.page.onLeave(); assert.equal(nodes(r, 'br-pet-tooltip').length, 0); assert.equal(r.layerBindings.size, 0); assert.equal(r.timers.size, 0);
  assert.equal(r.calls.some(c => c.options.method), false);
});

test('click opens one immediate body modal, not a fourth tab; background and scroll restore exactly', async t => {
  let resolve;
  const r = await mount(t, { handle: url => url.includes('/record?') ? new Promise(done => { resolve = done; }) : null });
  const doc = r.root.document, page = nodes(r, 'battle-records-page')[0], trigger = r.btn('查看详情');
  const preexisting = doc.createElement('aside'); preexisting.inert = true; preexisting.setAttribute('aria-hidden', 'false'); doc.body.append(preexisting);
  r.host.inert = false; page.scrollTop = 321; page.scrollLeft = 7;
  page.style.setProperty('overflow', 'auto', 'important'); doc.body.style.setProperty('overflow', 'clip');
  const list = nodes(r, 'br-match-list')[0], listCard = list.children[0];
  trigger.focus(); trigger.click();
  assert.equal(overlay(r).parentNode, doc.body); assert.equal(r.host.contains(overlay(r)), false);
  assert.match(body(r).textContent, /正在加载/); assert.equal(body(r).getAttribute('aria-busy'), 'true');
  assert.equal(dialog(r).getAttribute('role'), 'dialog'); assert.equal(dialog(r).getAttribute('aria-modal'), 'true');
  assert.equal(body(r).getAttribute('role'), 'region'); assert.equal(body(r).getAttribute('aria-label'), '战斗详情内容'); assert.equal(body(r).tabIndex, 0);
  assert.ok(r.find(n => n.id === dialog(r).getAttribute('aria-labelledby')));
  assert.equal(doc.activeElement, r.btn('关闭')); assert.equal(r.host.inert, true); assert.equal(r.host.getAttribute('aria-hidden'), 'true');
  assert.equal(page.style.getPropertyValue('overflow'), 'hidden'); assert.equal(doc.body.style.getPropertyValue('overflow'), 'hidden');
  assert.equal(nodes(r, 'br-tabs')[0].children.length, 2); assert.equal(r.find(n => n.dataset.brPanel === 'detail'), undefined);
  trigger.click(); assert.equal(nodes(r, 'br-modal-root').length, 1); assert.equal(r.calls.filter(c => c.url.includes('/record?')).length, 1);
  const oldBody = body(r), get = r.calls.find(c => c.url.includes('/record?'));
  r.btn('关闭').click();
  assert.equal(overlay(r), undefined); assert.equal(get.options.signal.aborted, true); assert.equal(doc.activeElement, trigger);
  assert.equal(r.host.inert, false); assert.equal(r.host.getAttribute('aria-hidden'), null);
  assert.equal(preexisting.inert, true); assert.equal(preexisting.getAttribute('aria-hidden'), 'false');
  assert.equal(page.style.getPropertyValue('overflow'), 'auto'); assert.equal(page.style.getPropertyPriority('overflow'), 'important');
  assert.equal(doc.body.style.getPropertyValue('overflow'), 'clip'); assert.equal(page.scrollTop, 321); assert.equal(page.scrollLeft, 7);
  assert.equal(list.children[0], listCard, 'Opening/closing must not rebuild the list');
  resolve(response(fixture())); await tick();
  assert.match(oldBody.textContent, /正在加载/); assert.equal(overlay(r), undefined, 'Late GET must not paint detached body or reopen modal');
  assert.equal(r.calls.some(c => c.options.method), false);
});

test('keyboard loop contains focus with no advanced controls; Escape/backdrop and route disposal clean up', async t => {
  const r = await opened(t), doc = r.root.document, trigger = r.btn('查看详情'), close = r.btn('关闭');
  const last = r.all(dialog(r)).filter(n => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length).at(-1);
  assert.equal(nodes(r, 'br-advanced').length, 0); assert.equal(nodes(r, 'br-source-evidence').length, 0);
  close.focus(); assert.equal(doc.emit('keydown', { key: 'Tab', shiftKey: true }).defaultPrevented, true); assert.equal(doc.activeElement, last);
  assert.equal(doc.emit('keydown', { key: 'Tab' }).defaultPrevented, true); assert.equal(doc.activeElement, close);
  body(r).focus(); assert.equal(doc.activeElement, body(r), 'Scrollable named region is keyboard focusable inside the trap');
  assert.equal(doc.emit('keydown', { key: 'PageDown' }).defaultPrevented, undefined, 'Native keyboard scrolling is not intercepted');
  trigger.focus(); assert.equal(doc.activeElement, close, 'Stray external focus returns to modal');
  overlay(r).emit('click', { target: dialog(r) }); assert.ok(overlay(r), 'Dialog content click is not backdrop');
  doc.emit('keydown', { key: 'Escape' }); assert.equal(overlay(r), undefined); assert.equal(doc.activeElement, trigger);
  trigger.click(); await tick(); overlay(r).emit('click'); assert.equal(overlay(r), undefined);
  trigger.click(); await tick(); assert.equal(r.inference, null);
  const requestCount = r.calls.length; r.page.onLeave();
  assert.equal(overlay(r), undefined); assert.equal(doc.listeners.keydown.length, 0); assert.equal(doc.listeners.focusin.length, 0);
  assert.equal(r.timers.size, 0); assert.equal(r.host.getAttribute('aria-hidden'), null);
  await tick(); assert.equal(r.calls.length, requestCount); assert.equal(overlay(r), undefined);
  r.page.render(r.host); await tick(); assert.equal(overlay(r), undefined, 'Route re-entry must not resurrect selected detail');
});

test('GET failure has immediate accessible in-modal retry, stays closable and does not change list filters', async t => {
  let failed = true;
  const r = await mount(t, { handle: url => url.includes('/record?') && failed ? { ok: false, json: async () => ({ error: '<script>read failed</script>' }) } : null });
  r.named('outcome').value = 'loss'; r.btn('查看详情').click(); await tick();
  assert.equal(r.find(n => n.getAttribute('role') === 'alert').textContent, '<script>read failed</script>');
  assert.equal(body(r).getAttribute('aria-busy'), 'false'); assert.equal(r.all().some(n => n.tagName === 'script'), false);
  assert.ok(r.btn('关闭')); failed = false; r.btn('重试').click();
  assert.match(body(r).textContent, /正在加载/); await tick(); assert.ok(main(r));
  assert.equal(r.named('outcome').value, 'loss'); assert.equal(r.calls.some(c => c.options.method), false);
});

test('replaced pending GETs cannot repaint a newly opened same-id modal; no inference is mounted', async t => {
  const pending = [];
  const r = await mount(t, { record: fixture(), handle: url => url.includes('/record?') ? new Promise(resolve => pending.push(resolve)) : null });
  r.btn('查看详情').click(); const firstBody = body(r); r.btn('关闭').click(); r.btn('查看详情').click();
  pending[0](response({ ...fixture(), id: 'stale', outcome: 'loss' })); await tick(); assert.match(body(r).textContent, /正在加载/);
  pending[1](response(fixture())); await tick(); assert.ok(main(r)); assert.match(firstBody.textContent, /正在加载/);
  assert.equal(r.inference, null);
  r.btn('关闭').click(); r.btn('查看详情').click(); const current = body(r), count = r.calls.length;
  await tick(); assert.match(current.textContent, /正在加载/); assert.equal(r.calls.length, count);
  pending[2](response(fixture())); await tick(); assert.ok(main(r));
});

test('advanced editing and inference are never mounted; opening, closing and reopening perform no POST', async t => {
  const r = await opened(t);
  const detail = body(r), before = r.calls.length;
  for (const cls of ['br-advanced', 'br-identity-editor', 'br-mapping-row', 'br-inference-host', 'br-source-evidence', 'br-pet-profile', 'br-source-turn']) assert.equal(nodes(r, cls).length, 0, cls);
  assert.equal(r.all(detail).some(n => ['input', 'select', 'textarea', 'details', 'table'].includes(n.tagName)), false);
  assert.equal(r.selectors.length, 1, 'Rule pickers are created only while their modal is connected');
  assert.equal(r.btn('确认本记录精灵映射'), undefined); assert.equal(r.btn('确认本记录技能映射'), undefined);
  assert.equal(r.inference, null); assert.equal(r.tracked.length, 0);
  r.btn('关闭').click(); await tick(); assert.equal(r.calls.length, before);
  r.btn('查看详情').click(); await tick(); assert.ok(main(r)); assert.equal(r.inference, null);
  assert.equal(r.calls.some(c => c.options.method), false);
});

test('renderer consumes only injected VM, clean canonical names, independent sides and honest states/replacements', async t => {
  const record = freeze(fixture()), projected = freeze(projectedFixture()), before = JSON.stringify(record); let calls = 0;
  const r = await opened(t, { record, data: catalogue, projector: { project(input, options) {
    assert.equal(input, record); calls++;
    assert.deepEqual(Object.keys(options).sort(), ['getMonsterById', 'getMoveById']);
    assert.deepEqual(options.getMonsterById(35), catalogue.getMonsterById(35));
    assert.deepEqual(options.getMoveById(37), catalogue.getMoves()[0]);
    assert.equal(options.getMonsterById(999), null); assert.equal(options.getMoveById(999), undefined);
    return projected;
  } } });
  assert.equal(calls, 1); assert.equal(JSON.stringify(record), before);
  const rounds = nodes(r, 'br-round'); assert.equal(rounds.length, 2);
  const row = (round, kind) => round.children.find(n => n.dataset.row === kind);
  for (const round of rounds) for (const grid of round.children.filter(n => n.dataset.row)) assert.deepEqual(Array.from(grid.children, n => n.dataset.side), ['me', 'enemy']);
  assert.deepEqual(Array.from(rounds[0].children.filter(n => n.dataset.row), n => n.dataset.row), ['pets', 'actions', 'endstate', 'replacements']);
  assert.deepEqual(Array.from(rounds[1].children.filter(n => n.dataset.row), n => n.dataset.row), ['pets', 'actions', 'endstate']);
  assert.match(row(rounds[0], 'pets').children[0].textContent, /正确形态/); assert.doesNotMatch(row(rounds[0], 'pets').textContent, /#35|不可信来源名/);
  const ordinary = nodes(r, 'br-action').find(n => n.dataset.eventId === 'ordinary');
  assert.match(ordinary.textContent, /规范技能/); assert.match(ordinary.textContent, /伤害 340/); assert.match(ordinary.textContent, /耗能 0/); assert.doesNotMatch(ordinary.textContent, /642|999/);
  const interrupted = nodes(r, 'br-action').find(n => n.dataset.eventId === 'interrupted');
  assert.match(interrupted.textContent, /被打断/); assert.doesNotMatch(interrupted.textContent, /耗能|回能|888|777|伤害/);
  assert.match(main(r).textContent, /生命 0/);
  assert.doesNotMatch(body(r).textContent, /补充记录见|系统行动|回合结束状态|按最后记录|上次记录|补位来源|仅补位时记录|来源 \/ 数据提示|配置、映射与来源证据|projected-warning-must-not-mount/);
  assert.doesNotMatch(ordinary.textContent, /正确形态|敌方形态/);
  assert.match(nodes(r, 'br-action').find(n => n.dataset.eventId === 'charge').textContent, /回能 \+4/);
  assert.doesNotMatch(row(rounds[0], 'replacements').children[1].textContent, /补位来源/); assert.match(row(rounds[0], 'replacements').children[1].textContent, /生命 123/);
  assert.equal(row(rounds[0], 'replacements').children[0].children.length, 0, 'Missing side gets no fake replacement card');
  assert.equal(row(rounds[1], 'pets').children[1].children.length, 0); assert.equal(r.all(row(rounds[1], 'endstate').children[1]).some(n => n.className === 'br-pet-line'), false);
  assert.equal(r.all(main(r)).some(n => n.tagName === 'table'), false, 'No old five-column primary timeline');
  assert.equal(nodes(r, 'br-advanced').length, 0);
  assert.equal(r.inference, null); assert.equal(r.btn('用于伤害计算'), undefined); assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, ''); r.btn('关闭').click(); assert.equal(overlay(r), undefined);
  assert.equal(JSON.stringify(record), before); assert.equal(r.calls.some(c => c.options.method), false);
});

test('state percentage is VM-only, nullable and bounded; absolute HP including zero wins', async t => {
  for (const [hp, hpRatio, expected] of [[null, 0, '生命 0%'], [null, 1, '生命 100%'], [null, .375, '生命 37.5%'], [undefined, .23456, '生命 23.46%'], [0, .75, '生命 0'], [123, .5, '生命 123'], [null, null, '生命 未确认'], [null, -.1, '生命 未确认'], [null, 1.1, '生命 未确认'], [null, '0.5', '生命 未确认'], [null, NaN, '生命 未确认']]) {
    const projection = projectedFixture();
    projection.rounds[0].sides.me.endState = { ...projection.rounds[0].sides.me.endState, status: 'unknown', confirmedActive: false, hp, hpRatio };
    const before = JSON.stringify(projection); freeze(projection);
    const r = await opened(t, { record: freeze(fixture()), data: catalogue, projector: { project: () => projection } });
    const state = nodes(r, 'br-round')[0].children.find(n => n.dataset.row === 'endstate').children[0];
    assert.equal(r.all(state).find(n => n.className === 'br-state-value').textContent, expected);
    assert.match(state.textContent, /正确形态/); assert.doesNotMatch(state.textContent, /是否仍在场未确认|上次记录|补位来源/);
    assert.equal(JSON.stringify(projection), before); assert.equal(r.calls.some(c => c.options.method), false); r.page.onLeave();
  }
});

test('UI does not substitute canonical costs for absent VM values and interrupted always hides all numbers', async t => {
  const projection = projectedFixture();
  for (const side of Object.values(projection.rounds[0].sides)) for (const action of side.actions) { action.energyCost = null; action.energyGain = null; }
  const interrupted = projection.rounds[0].sides.enemy.actions[0]; interrupted.energyCost = 0; interrupted.energyGain = 0;
  const r = await opened(t, { record: freeze(fixture()), data: { ...catalogue, getMoves: () => catalogue.getMoves().map(move => ({ ...move, energy_cost: 9 })) }, projector: { project: () => freeze(projection) } });
  for (const action of nodes(r, 'br-action')) assert.doesNotMatch(action.textContent, /耗能|回能/);
  assert.match(nodes(r, 'br-action').find(n => n.dataset.eventId === 'interrupted').textContent, /被打断/);
  assert.match(nodes(r, 'br-round')[0].children.find(n => n.dataset.row === 'endstate').children[1].textContent, /^空场$/);
});

test('real VM integration keeps overkill separate and shows recorded values for an unconfirmed interrupted participant', async t => {
  const record = fixture();
  record.events = [
    { id: 'cast', round: 1, seq: 1, execIndex: 0, side: 'me', actor: 'a', targetSide: 'enemy', target: 'b', kind: 'skill', phase: 'executed', skillClass: 'response', skillId: 37, protocolSkillId: '700' },
    { id: 'hit', round: 1, seq: 1, execIndex: 1, side: 'me', actor: 'a', targetSide: 'enemy', target: 'b', kind: 'damage', phase: 'executed', protocolSkillId: '700', amount: 642, hpChange: -340, hpAfter: 0 },
    { id: 'cost', round: 1, seq: 1, execIndex: 0, side: 'me', actor: 'a', kind: 'resource', phase: 'executed', energyChange: -2, energyAfter: 3 },
    { id: 'interrupt', round: 1, seq: 2, execIndex: 0, side: 'enemy', actor: 'b', kind: 'skill', phase: 'interrupted', skillId: 37 },
    { id: 'charge', round: 2, seq: 3, execIndex: 1, side: 'me', actor: 'a', kind: 'effect', phase: 'executed', skillClass: 'system', label: '聚能' },
    { id: 'independent-gain', round: 2, seq: 3, execIndex: 3, side: 'me', actor: 'a', kind: 'resource', phase: 'executed', energyChange: 5, energyAfter: 8 }
  ];
  const before = JSON.stringify(record); freeze(record);
  const r = await opened(t, { record, data: catalogue });
  const cast = nodes(r, 'br-action').find(n => n.dataset.eventId === 'cast');
  assert.match(cast.textContent, /伤害 340/); assert.match(cast.textContent, /耗能 2/); assert.doesNotMatch(cast.textContent, /642/);
  const badge = r.all(cast).find(n => n.className === 'br-response-badge'); assert.equal(badge.textContent, '应对');
  assert.equal(badge.parentNode.children[0].textContent, '规范技能'); assert.equal(cast.children[0].children[0].src, 'assets/monster/skill/' + encodeURIComponent('规范技能') + '.png');
  const first = nodes(r, 'br-round')[0], enemyState = first.children.find(n => n.dataset.row === 'endstate').children[1];
  assert.match(enemyState.textContent, /敌方形态/); assert.doesNotMatch(enemyState.textContent, /是否仍在场未确认/); assert.match(enemyState.textContent, /生命 0/);
  assert.equal(enemyState.children[0].dataset.status, 'unknown', 'Interrupted actor is not confirmed active or dead');
  assert.doesNotMatch(main(r).textContent, /不按阵容顺序、受击或资源同步推定/, 'VM caveats are not mounted in the modal');
  assert.equal(nodes(r, 'br-source-evidence').length, 0);
  const charge = nodes(r, 'br-action').find(n => n.dataset.eventId === 'charge');
  assert.match(charge.textContent, /聚能/); assert.doesNotMatch(charge.textContent, /耗能|回能/);
  assert.match(main(r).textContent, /能量 8/); assert.doesNotMatch(body(r).textContent, /报告伤害 642|independent-gain/);
  assert.equal(JSON.stringify(record), before); assert.equal(r.calls.some(c => c.options.method), false);
});

test('portrait switch separator requires an exact executed same-side consecutive target-to-actor pair', async t => {
  const base = { id: 'switch-proof', kind: 'switch', phase: 'executed', round: 1, seq: 1, side: 'me', targetSide: 'me', target: 'a', actor: 'b' };
  const cases = [
    ['exact me', {}, [1, 0]], ['implicit switch target side', { targetSide: undefined }, [1, 0]],
    ['exact enemy, never me despite equal instance IDs', { side: 'enemy', targetSide: 'enemy' }, [0, 1]],
    ['cross-side target', { targetSide: 'enemy' }, [0, 0]], ['unknown side', { side: 'unknown' }, [0, 0]],
    ['unknown target side', { targetSide: 'unknown' }, [0, 0]], ['preview', { phase: 'preview' }, [0, 0]],
    ['interrupted', { phase: 'interrupted' }, [0, 0]], ['unknown phase', { phase: 'unknown' }, [0, 0]],
    ['label alone', { kind: 'effect', label: '换场' }, [0, 0]], ['reverse pair', { target: 'b', actor: 'a' }, [0, 0]],
    ['missing outgoing', { target: undefined }, [0, 0]], ['unrelated incoming', { actor: 'c' }, [0, 0]]
  ];
  for (const [label, change, expected] of cases) {
    const projection = projectedFixture(), pair = [{ instanceId: 'a', monsterId: 35, declaredName: '' }, { instanceId: 'b', monsterId: 42, declaredName: '' }];
    projection.rounds[0].events = [{ ...base, ...change }];
    for (const side of ['me', 'enemy']) projection.rounds[0].sides[side].participants = pair.map(pet => ({ ...pet }));
    const before = JSON.stringify(projection); freeze(projection);
    const r = await opened(t, { record: freeze(fixture()), data: catalogue, projector: { project: () => projection } });
    const row = nodes(r, 'br-round')[0].children.find(node => node.dataset.row === 'pets');
    assert.deepEqual(Array.from(row.children, cell => cell.children.filter(node => node.className === 'br-switch-separator').length), expected, label);
    for (const cell of row.children) {
      assert.equal(cell.children.filter(node => node.className === 'br-pet-line').length, 2, label + ': preserve both portraits');
      const separator = cell.children.find(node => node.className === 'br-switch-separator');
      if (separator) { assert.equal(separator.textContent, '换场 →'); assert.equal(cell.children[0].dataset.instanceId, 'a'); assert.equal(cell.children[2].dataset.instanceId, 'b'); }
    }
    assert.equal(JSON.stringify(projection), before); assert.equal(r.calls.some(call => call.options.method), false); r.page.onLeave();
  }
  const projection = projectedFixture();
  projection.rounds[0].events = []; projection.rounds[1].events = [base];
  projection.rounds[0].sides.me.participants = [{ instanceId: 'a', monsterId: 35 }, { instanceId: 'b', monsterId: 42 }];
  const r = await opened(t, { record: freeze(fixture()), projector: { project: () => freeze(projection) } });
  assert.equal(nodes(r, 'br-switch-separator').length, 0, 'A switch from another projected round cannot label this round');
});

test('missing, failed and known unavailable icons keep blank slots; source labels never choose image paths', async t => {
  const r = await opened(t, { record: freeze(fixture()), data: catalogue, projector: { project: () => freeze(projectedFixture()) } });
  const actions = nodes(r, 'br-action');
  for (const id of ['wish', 'charge', 'unsafe']) {
    const action = actions.find(n => n.dataset.eventId === id), slot = action.children[0];
    assert.equal(slot.className, 'br-image-slot br-image-skill'); assert.equal(slot.children.length, 0);
    assert.ok(action.textContent.includes(id === 'wish' ? '愿力冲击' : id === 'charge' ? '聚能' : '<img src=x onerror=evil()>'));
  }
  const ordinary = actions.find(n => n.dataset.eventId === 'ordinary'), slot = ordinary.children[0], image = slot.children[0];
  assert.equal(image.src, 'assets/monster/skill/' + encodeURIComponent('规范技能') + '.png');
  assert.equal(image.alt, ''); assert.equal(image.getAttribute('onerror'), null); image.emit('error');
  assert.equal(slot.children.length, 0); assert.match(ordinary.textContent, /规范技能/);
  assert.ok(nodes(r, 'br-image-pet').some(n => n.children[0]?.src === 'assets/monster/images/' + encodeURIComponent('正确头像.png') + '?v=exact'));
  assert.equal(r.all().some(n => n.tagName === 'script'), false);
  assert.ok(r.all().filter(n => n.tagName === 'img').every(n => n.src.startsWith('assets/monster/')));
});

test('charge and eighteen wish types keep icons and tooltips without a fixed category-cost subtitle', async t => {
  const projection=projectedFixture(),base=projection.rounds[0].sides.me.actions[0];
  projection.rounds[0].sides.me.actions=[{...base,event:{...base.event,id:'real-charge',skillId:0,kind:'effect',skillClass:'system',protocolSkillId:'700001000'},energyGain:4},...Array.from({length:18},(_,i)=>({...base,event:{...base.event,id:`wish-${i+1}`,skillId:0,combat:{actionKind:'wishImpact',typeId:i+1}},energyCost:null}))];
  const before=JSON.stringify(projection),r=await opened(t,{record:freeze(fixture()),data:catalogue,projector:{project:()=>freeze(projection)}});
  const charge=nodes(r,'br-action').find(n=>n.dataset.eventId==='real-charge');assert.equal(charge.children[0].children[0].src,'assets/system-actions/charge.webp');assert.equal(charge.dataset.systemAction,'charge');assert.match(charge.textContent,/聚能/);assert.doesNotMatch(charge.textContent,/状态/);assert.equal(charge.children[1].children.filter(n=>n.className==='br-action-meta').length,0);assert.match(charge.title,/状态.*耗能 0.*获得5点能量/);assert.match(charge.textContent,/回能 \+4/);
  for(let type=1;type<=18;type++){
    const action=nodes(r,'br-action').find(n=>n.dataset.eventId===`wish-${type}`);assert.equal(action.children[0].children[0].src,`assets/system-actions/wish-${type}.png`);assert.equal(action.dataset.systemAction,'wishImpact');assert.equal(action.dataset.typeId,String(type));
    assert.match(action.textContent,/愿力冲击/);assert.doesNotMatch(action.textContent,/物攻\/魔攻|耗能 2|威力 80/);assert.equal(action.children[1].children.filter(n=>n.className==='br-action-meta').length,0);assert.match(action.title,/物攻\/魔攻.*耗能 2.*威力 80/);assert.match(action.title,/应对状态：本次威力\+150%.*威力 200/);assert.doesNotMatch(action.textContent,/Wiki 身份未映射/);assert.equal(action.tabIndex,0);
  }
  assert.equal(JSON.stringify(projection),before);assert.equal(r.calls.some(c=>c.options.method),false);
});

test('unknown wish type never borrows pet types or source labels and canonical skill names never create system identity',async t=>{
  for(const typeId of [undefined,null,0,19,'3']){
    const projection=projectedFixture(),action=projection.rounds[0].sides.me.actions[0];action.pet.type_ids=[3];action.pet.attack=999;action.pet.magicAttack=1;action.event={...action.event,skillId:0,label:'火系愿力冲击',combat:{actionKind:'wishImpact',typeId}};
    const r=await opened(t,{record:freeze(fixture()),data:catalogue,projector:{project:()=>freeze(projection)}}),tile=nodes(r,'br-action').find(n=>n.dataset.eventId==='ordinary');
    assert.equal(tile.children[0].children.length,0);assert.equal(tile.dataset.typeId,undefined);assert.equal(tile.children[1].children.filter(n=>n.className==='br-action-meta').length,0);assert.match(tile.title,/属性未确认/);assert.match(tile.title,/物攻\/魔攻/);assert.doesNotMatch(tile.textContent,/火系/);
  }
  const r=await opened(t,{record:freeze(fixture()),data:catalogue,projector:{project:()=>freeze(projectedFixture())}});
  for(const id of ['wish','charge'])assert.equal(nodes(r,'br-action').find(n=>n.dataset.eventId===id).dataset.systemAction,undefined,'catalog/source labels alone are not normalized system identity');
});

test('有效预防 uses ordinary canonical ID 74 naming and icon without cosmetic identity mapping', async t => {
  const projection = projectedFixture(), action = projection.rounds[0].sides.me.actions[0];
  action.event.skillId = 74; action.event.label = '来源别名';
  const r = await opened(t, { record: freeze(fixture()), data: { ...catalogue, getMoves: () => [...catalogue.getMoves(), { id: 74, name: '有效预防' }] }, projector: { project: () => freeze(projection) } });
  const tile = nodes(r, 'br-action').find(n => n.dataset.eventId === 'ordinary');
  assert.match(tile.textContent, /有效预防/); assert.doesNotMatch(tile.textContent, /来源别名|Wiki 身份未映射/);
  assert.equal(tile.children[0].children[0].src, 'assets/monster/skill/' + encodeURIComponent('有效预防') + '.png');
  assert.equal(action.event.skillId, 74); assert.equal(action.event.label, '来源别名'); assert.equal(r.calls.some(c => c.options.method), false);
});

test('malicious canonical avatar URLs fail blank; unknown identity cannot borrow source-name avatar', async t => {
  const projection = projectedFixture(); projection.rounds[0].sides.enemy.participants[0].monsterId = 0;
  const r = await opened(t, { record: fixture(), projector: { project: () => projection }, data: { ...catalogue, getMonsterById: id => id === 35 ? { id, image: '../secret.png' } : null } });
  assert.ok(nodes(r, 'br-image-pet').length > 0); assert.ok(nodes(r, 'br-image-pet').every(n => n.children.length === 0));
  assert.match(main(r).textContent, /身份未映射/);
});

test('missing VM dependency fails explicitly inside modal rather than using a guessed local timeline', async t => {
  const record = fixture(); record.rounds = 15;
  record.events = [{ id: 'skip-without-vm', round: 15, side: 'enemy', actor: 'b', kind: 'skill', phase: 'executed', skillClass: 'ordinary', skillId: 0, protocolSkillId: '700001200' }];
  const before = JSON.stringify(record), r = await opened(t, { record: freeze(record), projector: null });
  assert.match(body(r).textContent, /回合视图组件未加载/); assert.ok(r.btn('关闭')); assert.ok(r.btn('重试')); assert.equal(main(r), undefined);
  assert.equal(nodes(r, 'br-action').length, 0); assert.doesNotMatch(body(r).textContent, /技能身份未知|Wiki 身份未映射|聚能|耗能/);
  assert.equal(JSON.stringify(record), before); assert.equal(r.calls.some(c => c.options.method), false);
});

test('CSS is portal-scoped, theme/zoom-aware and retains two separate narrow columns without obsolete layout', () => {
  const css = fs.readFileSync(path.join(__dirname, '../css/battle-records.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const source = fs.readFileSync(path.join(__dirname, '../js/pages/battle-records.js'), 'utf8');
  assert.match(css, /\.br-modal-root\s*\{[^}]*position:\s*fixed;[^}]*100vw\s*\/\s*var\(--page-zoom, 1\)[^}]*100vh\s*\/\s*var\(--page-zoom, 1\)/);
  assert.match(css, /\.br-modal-root \.br-dialog\s*\{[^}]*background:\s*var\(--bg-primary\)/);
  assert.match(css, /\.br-modal-root \.br-bilateral\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  for (const match of css.matchAll(/\.br-modal-root \.br-bilateral\s*\{([^}]*)\}/g)) if (match[1].includes('grid-template-columns')) assert.match(match[1], /repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.br-modal-root \.br-side-cell\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.br-modal-root \.br-action-content\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /:is\(\.battle-records-page, \.br-modal-root\) \.br-image-slot\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px/);
  assert.doesNotMatch(css, /\.br-turn(?:\s|\{|\.)|!important|br-advanced|br-stale|br-state-caption|br-source-evidence|br-source-turn|br-pet-profile|br-identity-editor|br-mapping-row|br-inference-host|br-chip/);
  assert.doesNotMatch(source, /结算回合|行动明细按需加载|已记录事件|事件数不是回合数|逐回合对战|qualityText|leadText|br-chip/);
  assert.doesNotMatch(source, /renderIdentityMapping|saveMapping|renderInference|eventSource|eventActors|eventIdentities|clearDetailHelpers/);
  assert.doesNotMatch(source, /panels\.detail|showTab\('detail'\)|window\.open|createElement\('dialog'\)|localStorage\.|UserConfig\.|\.innerHTML\s*=/);
});

const nov4StatsPath=process.env.BATTLE_NOV4_UI_STATS||path.resolve(__dirname,'../../actual-stats.json');
const nov4RecordsPath=process.env.BATTLE_HISTORY_AUDIT_RECORDS||path.resolve(__dirname,'../../records-before.json');
const nov4ContextPath=process.env.BATTLE_NOV4_UI_CONTEXT||path.resolve(__dirname,'../../context.json');
test('frozen seven actual battles render R22 history nine, R8 counter-defeat, conservative R23 and independent eight-over-seven environment rates',{
  skip:![nov4StatsPath,nov4RecordsPath,nov4ContextPath].every(file=>fs.existsSync(file))
},async t=>{
  const statsRaw=fs.readFileSync(nov4StatsPath,'utf8'),recordsRaw=fs.readFileSync(nov4RecordsPath,'utf8'),contextRaw=fs.readFileSync(nov4ContextPath,'utf8');
  const context=JSON.parse(contextRaw),catalogPath=path.join(context.backup,'active-catalog.json'),catalogRaw=fs.readFileSync(catalogPath,'utf8'),canonical=freeze(JSON.parse(catalogRaw));
  const actual=freeze(JSON.parse(recordsRaw)),stats=freeze(JSON.parse(statsRaw)),before=JSON.stringify([actual,stats,canonical]),legacy=require('../js/catalog-data.js').toLegacy(canonical),history=require('../js/battle-history-growth.js'),outcomes=require('../js/battle-action-outcomes.js');
  const monsters=new Map(legacy.monsters.map(p=>[p.id,p])),moves=new Map(legacy.moves.map(m=>[m.id,m]));
  assert.equal(monsters.get(202)._trait_id,canonical.monsters.find(p=>p.id===202).trait_id);assert.equal(actual.records.length,7);assert.equal(stats.matchedBattles,7);assert.equal(stats.archetypes.assignmentCount,8);
  const data={getMonsters:()=>legacy.monsters,getMonsterById:id=>monsters.get(id),getMonsterDisplayName:p=>p.localized.zh.name,getMoves:()=>legacy.moves,getMoveName:m=>m.localized.zh.name,getTypes:()=>legacy.types,getTypeObjZh:type=>type.localized.zh};
  const r=await mount(t,{stats,data,historyGrowth:history,actionOutcomes:outcomes,handle:url=>url.includes('/list?')?response({records:actual.records,total:7}):url.endsWith('/revision')?response({revision:stats.revision}):url.includes('/record?')?response(actual.records.find(record=>record.id===new URL(url,'http://isolated.invalid').searchParams.get('id'))):null});
  const trigger=id=>r.all(r.find(n=>n.dataset.recordId===id)).find(n=>n.tagName==='button'&&n.textContent==='查看详情');
  trigger('rkpp:1876469132858231449').click();await tick();const old=actual.records.find(record=>record.id==='rkpp:1876469132858231449'),entry=old.events.find(e=>e.id==='rkpp:action:22:120:9:switch');
  const round22=nodes(r,'br-round').find(n=>n.dataset.round==='22'),historyRow=round22.children.find(n=>n.dataset.row==='history-growth');assert.ok(historyRow);
  const snapshot=r.all(historyRow).find(n=>n.dataset.eventId===entry.id);assert.ok(snapshot);assert.equal(snapshot.dataset.instanceId,'5');assert.equal(snapshot.parentNode.dataset.side,'me');assert.match(snapshot.textContent,/入场时累计 9层/);assert.match(snapshot.title,/已记录.*不表示整场捕获完整/);
  const interrupted=nodes(r,'br-action').find(n=>n.dataset.eventId==='rkpp:action:8:45:1:cast');assert.ok(interrupted);assert.match(interrupted.textContent,/被应对击败/);assert.doesNotMatch(interrupted.textContent,/耗能|回能|伤害/);assert.equal(old.events.find(e=>e.id===interrupted.dataset.eventId).phase,'interrupted');
  const projected=history.project(old,{getMonsterById:data.getMonsterById,getMoves:data.getMoves}).entries.find(e=>e.eventId===entry.id);assert.equal(projected.count,9);assert.equal(projected.evidenceEventIds.length,9);
  r.btn('关闭').click();trigger('rkpp:2306377934505522485').click();await tick();const conservative=nodes(r,'br-action').find(n=>n.dataset.eventId==='rkpp:2306377934505522485:live:23:123:1:cast:1');assert.ok(conservative);assert.match(conservative.textContent,/被打断/);assert.doesNotMatch(conservative.textContent,/被应对击败|耗能|回能|伤害/);
  const newer=actual.records.find(record=>record.id==='rkpp:2306377934505522485'),rawCharge=newer.events.find(e=>e.id===conservative.dataset.eventId);assert.equal(rawCharge.phase,'interrupted');assert.equal(outcomes.interruptionLabel(rawCharge,newer,{getMoves:data.getMoves}),null);
  assert.equal(r.btn('用于伤害计算'),undefined);assert.equal(r.root.handoff,undefined);assert.equal(r.root.location.hash,'');r.btn('关闭').click();r.btn('样本统计').click();await tick();r.btn('敌方样本统计').click();
  const enemy=r.find(n=>n.dataset.brStats==='enemy'),environment=r.find(n=>n.dataset.enemyModule==='environment'),rates=r.all(environment).filter(n=>n.className==='br-environment-rate');
  assert.equal(rates.length,stats.archetypes.environment.length);assert.equal(stats.archetypes.environment.reduce((n,x)=>n+x.battles,0),8);assert.equal(r.all(environment).some(n=>n.tagName==='svg'),false);assert.match(environment.textContent,/去重对战 7 场.*不相加或归一化/);
  for(const bucket of stats.archetypes.environment){const row=rates.find(n=>n.dataset.archetypeId===bucket.id);assert.ok(row);assert.ok(row.textContent.includes(`${bucket.battles} / 7 场 · ${(bucket.rate*100).toFixed(1)}%`));}
  const team=stats.archetypes.teams.find(x=>x.id==='rain'),row=r.all(enemy).find(n=>n.tagName==='tr'&&n.dataset.archetypeId===team.id);row.click();assert.equal(overlay(r).dataset.modalKind,'archetype');const components=nodes(r,'br-archetype-component');assert.equal(components.length,team.components.length);
  for(const part of team.components){const component=components.find(n=>n.dataset.componentMonsterId===String(part.monsterId));assert.ok(component);for(const cls of ['br-member-skill','br-member-nature','br-individual-lines'])assert.equal(r.all(component).filter(n=>n.className===cls).length,1);const lines=r.all(component).filter(n=>n.className.split(' ').includes('br-individual-line'));assert.equal(lines.length,6);
    for(const skill of part.skillUsage.filter(x=>x.casts>0&&(!x.kind||x.kind==='skill'))){const name=moves.get(skill.skillId)?.localized.zh.name;assert.ok(name);assert.ok(component.textContent.includes(name));assert.ok(component.textContent.includes((skill.casts/part.usageTotalCasts*100).toFixed(1)+'%'));}
    for(const choice of part.individualChoices){const line=lines.find(n=>n.dataset.attribute===choice.attribute);assert.ok(line);if(choice.samples>0){assert.equal(choice.samples,choice.selected+choice.unselected);assert.equal(line.dataset.available,'true');assert.equal(line.getAttribute('aria-valuenow'),String(choice.rate*100));}else{assert.equal(line.dataset.available,'false');assert.match(line.textContent,/未探明/);}}
  }
  r.root.document.emit('keydown',{key:'Escape'});assert.equal(overlay(r),undefined);assert.equal(r.tracked.length,0);assert.equal(r.calls.some(c=>c.options.method),false);assert.equal(JSON.stringify([actual,stats,canonical]),before);
  assert.equal(fs.readFileSync(nov4StatsPath,'utf8'),statsRaw);assert.equal(fs.readFileSync(nov4RecordsPath,'utf8'),recordsRaw);assert.equal(fs.readFileSync(catalogPath,'utf8'),catalogRaw);assert.equal(fs.readFileSync(nov4ContextPath,'utf8'),contextRaw);
});
