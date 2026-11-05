'use strict';
// Isolated UI records and DOM only: no network, relay, database or profile writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../js/pages/battle-records.js');
const source = fs.readFileSync(path.join(__dirname, '../js/pages/battle-records.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const EMPTY_TURN = '没有解析到可确认的行动，不代表未行动';
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function legacyNode(opcode, round) {
  const source = { '1316': 'battle_enter', '131a': 'round_start', '132c': 'battle_finish' }[opcode];
  return { id: `rkpp:${opcode}:${round}`, round, seq: 0, kind: 'note', phase: 'unknown', side: 'unknown', text: `Observed RKPP ${source}; gameplay attribution unavailable.` };
}
function fixture() {
  return {
    version: 1, id: 'actions-isolated', source: 'isolated-test', rounds: 36, outcome: 'unknown',
    sides: { me: { pets: [{ instanceId: 'outgoing', monsterId: 101 }, { instanceId: 'incoming', monsterId: 102 }] }, enemy: { pets: [{ instanceId: 'foe', monsterId: 103 }] } },
    quality: { roster: { me: true, enemy: true }, actions: false, lead: { me: false, enemy: false } },
    events: [legacyNode('1316', 0), ...Array.from({ length: 36 }, (_, i) => legacyNode('131a', i + 1)), legacyNode('132c', 0)]
  };
}
function runtime(record) {
  let doc;
  class Element {
    constructor(tag) { this.tagName = tag; this.nodeType = 1; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.value = ''; this.className = ''; this._text = ''; this.open = false; this.ownerDocument = doc; }
    get style() { return this._style ||= { values: {}, priorities: {}, getPropertyValue(key) { return this.values[key] || ''; }, getPropertyPriority(key) { return this.priorities[key] || ''; }, setProperty(key, value, priority = '') { this.values[key] = value; this.priorities[key] = priority; }, removeProperty(key) { delete this.values[key]; delete this.priorities[key]; } }; }
    get tabIndex() { return this._tabIndex ?? (['button','input','select','textarea','summary'].includes(this.tagName) ? 0 : -1); }
    set tabIndex(value) { this._tabIndex = value; }
    get isConnected() { return this === doc.body || this === doc.documentElement || !!this.parentNode?.isConnected; }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; }
    removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== fn); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) { const selectors = selector.split(',').map(x => x.trim()); return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(node => selectors.some(s => s === '*' || s === node.tagName || s === '[tabindex]' && node._tabIndex !== undefined || s === 'a[href]' && node.tagName === 'a' && node.attrs.href)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getClientRects() { for (let node = this; node; node = node.parentNode) { if (node.hidden || node.inert || node.style.getPropertyValue('display') === 'none') return []; if (node.parentNode?.tagName === 'details' && !node.parentNode.open && node.tagName !== 'summary') return []; } return this.isConnected ? [{}] : []; }
    focus() { doc.activeElement = this; doc.emit('focusin', { target: this }); }
    get parentElement() { return this.parentNode; }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    prepend(...nodes) { for (const node of [...nodes].reverse()) { node.parentNode = this; this.children.unshift(node); } }
    replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
    set textContent(value) { this.children = []; this._text = String(value); }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(' '); }
    set innerHTML(_) { throw Error('Untrusted HTML insertion'); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn({ target: this }); }
  }
  doc = { createElement: tag => new Element(tag), listeners: {}, addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }, removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== fn); }, emit(name, values = {}) { const event = { preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...values }; for (const fn of [...(this.listeners[name] || [])]) fn(event); return event; } }; doc.documentElement = new Element('html'); doc.body = new Element('body'); doc.activeElement = doc.body;
  const calls = [], inference = [];
  const monsters = [{ id: 101, name: '初始精灵' }, { id: 102, name: '换入精灵' }, { id: 103, name: '对手精灵' }, { id: 104, name: '战斗形态' }, { id: 105, name: '对手形态' }];
  const root = { BattleSystemActions: require('../js/battle-system-actions.js'), BattleTurnView: require('../js/battle-turn-view.js'), document: doc, location: { hash: '' }, AbortController, URLSearchParams, Date, console, setTimeout, clearTimeout,
    BattleRecordsClient: {
      async request(url, options = {}) {
        calls.push({ url, options });
        assert.ok(!options.method || options.method === 'GET', 'Rendering may not perform writes');
        const endpoint = url.split('/api/battles/')[1].split('?')[0];
        if (endpoint === 'list') return { records: [record], total: 1 };
        if (endpoint === 'record') return record;
        if (endpoint === 'stats') return { matchedBattles: 1, outcomes: {}, enemy: [], selfSkills: [], teams: [] };
        if (endpoint === 'rules') return { rules: [] };
        if (endpoint === 'status') return { state: 'stopped', imported: 0 };
        throw Error('Unexpected endpoint ' + url);
      },
      renderInference(host, value) { inference.push(value); host.textContent = '隔离推断组件'; return () => {}; },
      useRecord(value) { root.handoff = value; }
    }
  };
  const context = vm.createContext({ ...root, window: root, testData: {
    getMonsters: () => monsters, getMonsterById: id => monsters.find(pet => pet.id === id), getMonsterDisplayName: pet => pet.name,
    getMoves: () => [{ id: 37, name: '规范技能名' }], getMoveName: move => move.name
  } });
  vm.runInContext('const RKData = testData;\n' + source, context);
  const page = root.BattleRecordsPage, host = doc.createElement('main'); doc.body.append(host);
  const all = (node = doc.body) => [node, ...node.children.flatMap(child => all(child))];
  const btn = label => all().find(node => node.tagName === 'button' && node.textContent === label);
  const panel = key => all().find(node => key === 'detail' ? node.dataset.br === 'detail' : node.dataset.brPanel === key);
  const turns = () => all(panel('detail')).filter(node => node.className === 'br-round');
  const rows = () => all(panel('detail')).filter(node => node.className === 'br-action');
  const row = id => rows().find(row => row.dataset.eventId === id);
  page.render(host);
  return { page, root, host, calls, inference, all, btn, panel, turns, rows, row };
}
async function open(t, record) {
  const r = runtime(freeze(record)); t.after(() => r.page.onLeave());
  await tick(); r.btn('查看详情').click(); await tick(); return r;
}

test('R15 confirmed raw ordinary stun renders only a per-instance note on either side without writes', async t => {
  for (const side of ['enemy', 'me']) {
    const record = fixture(); record.rounds = 16; record.events = [];
    record.sides[side].pets[0].instanceId = '1'; record.sides[side].lead = '1'; record.quality.lead[side] = true;
    const skip = { id: 'rkpp:2306377934505522485:live:15:83:2:cast:1', kind: 'skill', phase: 'executed', skillClass: 'ordinary', skillId: 0,
      round: 15, seq: 83, execIndex: 2, actor: '1', side, protocolSkillId: '700001200' };
    const resource = { ...skip, id: 'resource-fact', kind: 'resource', energyChange: -2, energyAfter: 3, hpAfter: 91, hpMax: 100 };
    record.events.push(resource, skip);
    const before = JSON.stringify(record), r = await open(t, record), round = r.turns().find(row => row.dataset.round === '15');
    const annotations = r.all(round).filter(n => n.dataset.noAction === 'stunSkip');
    assert.equal(annotations.length, 1); assert.equal(annotations[0].dataset.eventId, skip.id);
    assert.equal(annotations[0].dataset.instanceId, '1'); assert.equal(annotations[0].parentNode.dataset.side, side);
    assert.match(annotations[0].textContent, /眩晕 · 未执行行动/);
    assert.doesNotMatch(round.textContent, /技能身份未知|Wiki 身份未映射|聚能|耗能|回能|报告伤害|→/);
    assert.match(round.textContent, /生命 91.*能量 3/);
    assert.equal(r.rows().length, 0); assert.equal(r.all(round).some(n => /br-image-skill|br-action-numbers|br-damage/.test(n.className)), false);
    assert.equal(r.turns().length, 16); assert.equal(r.all(r.turns()[15]).some(n => n.dataset.noAction), false);
    assert.equal(api.eventName(skip), '眩晕 · 未执行行动');
    assert.deepEqual(api.timelineTurns(record).find(row => row.round === 15).events, [resource, skip]);
    r.btn('关闭').click(); assert.equal(r.panel('detail'), undefined); r.btn('查看详情').click(); await tick();
    assert.equal(r.rows().length, 0); assert.match(r.panel('detail').textContent, /眩晕 · 未执行行动/);
    assert.equal(r.btn('用于伤害计算'), undefined); assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, '');
    assert.equal(record.events[1].kind, 'skill'); assert.equal(record.events[1].skillClass, 'ordinary'); assert.equal(record.events[1].skillId, 0);
    assert.equal(JSON.stringify(record), before); assert.ok(r.calls.every(call => !call.options.method)); r.page.onLeave();
  }
});

test('nearby unmapped IDs remain unknown while confirmed no-action naming never uses labels', async t => {
  const record = fixture(); record.events = [
    { id: 'skip', kind: 'skill', phase: 'interrupted', skillClass: 'response', skillId: 0, side: 'enemy', actor: 'foe', round: 15, protocolSkillId: '700001200', label: 'misleading source name' },
    { id: 'nearby-unknown', kind: 'skill', phase: 'executed', skillClass: 'ordinary', skillId: 0, side: 'me', actor: 'outgoing', round: 15, protocolSkillId: '700001201' }
  ];
  const r = await open(t, record);
  assert.equal(r.row('skip'), undefined); assert.match(r.panel('detail').textContent, /眩晕 · 未执行行动/);
  assert.doesNotMatch(r.panel('detail').textContent, /misleading source name/);
  assert.match(r.row('nearby-unknown').textContent, /技能身份未知.*Wiki 身份未映射/);
  assert.doesNotMatch(api.eventName({ ...record.events[0], protocolSkillId: '700001201', label: '' }), /眩晕|未执行行动/);
  assert.match(api.eventName({ ...record.events[0], protocolSkillId: '700001201', label: '眩晕' }), /Wiki 身份未映射/);
});

test('lifecycle classification accepts explicit note metadata or exact legacy ID plus text, never hints', () => {
  for (const [opcode, kind] of [['1316', 'enter'], ['131a', 'round_start'], ['132c', 'finish']]) {
    const event = freeze(legacyNode(opcode, 5));
    assert.equal(api.lifecycleKind(event), kind);
    assert.equal(api.lifecycleKind({ id: 'new-id', kind: 'note', lifecycle: kind }), kind);
    for (const changed of [
      { id: event.id + '-extra' }, { id: `rkpp:${opcode}:05` }, { round: 4 }, { round: '5' }, { round: undefined },
      { text: event.text + ' ' }, { text: event.text.toLowerCase() }, { kind: 'skill' }, { lifecycle: 'unverified' }
    ]) assert.equal(api.lifecycleKind({ ...event, ...changed }), '', JSON.stringify(changed));
  }
  assert.equal(api.lifecycleKind({ kind: 'note', text: 'round_start', id: 'rkpp:131a:1', round: 1 }), '');
  assert.equal(api.lifecycleKind({ kind: 'effect', lifecycle: 'enter', label: 'battle_enter' }), '');
  assert.equal(api.lifecycleKind({ kind: 'note', lifecycle: 'toString' }), '');
});

test('38 old lifecycle nodes stay unmounted outside 36 rounds; seven same-instance forms remain immutable', async t => {
  const record = fixture();
  record.events.push(...[6, 1, 3, 0, 5, 2, 4].map(i => ({ id: `form-${i}`, kind: 'form', phase: 'executed', round: 2, seq: 7, side: 'me', actor: 'outgoing',
    form: { execIndex: i, fromMonsterId: i % 2 ? 102 : 101, toMonsterId: i % 2 ? 101 : 102, fromBaseId: 'base-a', toBaseId: 'base-b', mappingRevision: 'a'.repeat(64) } })));
  const before = JSON.stringify(record), r = await open(t, record), detail = r.panel('detail');
  assert.equal(r.all(detail).some(node => node.dataset.br === 'lifecycle'), false);
  assert.equal(r.turns().length, 36);
  for (const [i, turn] of r.turns().entries()) {
    assert.equal(turn.children[0].textContent, `回合 ${i + 1}`);
    if (i !== 1) assert.match(turn.textContent, new RegExp(EMPTY_TURN));
    assert.doesNotMatch(turn.textContent, /Observed RKPP|来源证据|补充记录/);
  }
  assert.equal(r.rows().length, 0, 'Forms and lifecycle records are not fabricated skill actions');
  assert.deepEqual(api.timelineTurns(record)[1].events.map(event => event.form.execIndex), [0,1,2,3,4,5,6]);
  assert.equal(JSON.stringify(record), before);
  assert.match(detail.textContent, /对战回合：36回合/);
  assert.doesNotMatch(detail.textContent, /已记录事件|事件数不是回合数|逐回合对战/);
  assert.equal(r.inference.length, 0); assert.equal(r.btn('用于伤害计算'), undefined); assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, '');
  assert.equal(r.root.location.hash, ''); assert.ok(r.calls.every(call => !call.options.method));
});

test('additive execIndex sorts by round and seq first; explicit zero overrides nested form fallback', () => {
  const events = freeze([
    { id: 'later-round', round: 2, seq: 0, execIndex: 0 },
    { id: 'legacy-form', round: 1, seq: 2, form: { execIndex: 3 } },
    { id: 'two', round: 1, seq: 2, execIndex: 2 },
    { id: 'override-zero', round: 1, seq: 2, execIndex: 0, form: { execIndex: 5 } },
    { id: 'missing', round: 1, seq: 2 },
    { id: 'override-one', round: 1, seq: 2, execIndex: 1, form: { execIndex: 0 } },
    { id: 'same-one', round: 1, seq: 2, execIndex: 1 },
    { id: 'earlier-seq', round: 1, seq: 1, execIndex: 999 }, { id: 'unknown-round', seq: 1 }
  ]);
  const before = JSON.stringify(events);
  assert.deepEqual(api.groupedTurns(events).map(turn => turn.events.map(event => event.id)), [
    ['unknown-round'], ['earlier-seq', 'override-zero', 'missing', 'override-one', 'same-one', 'two', 'legacy-form'], ['later-round']
  ]);
  assert.equal(api.executionIndex(events[3]), 0); assert.equal(api.executionIndex(events[4]), null);
  assert.equal(api.executionIndex(events[1]), 3); assert.equal(JSON.stringify(events), before);
});

test('empty-round coverage is authoritative, does not guess total from lifecycle or silently drop other notes', () => {
  const record = fixture();
  record.events.push({ id: 'user-note', kind: 'note', round: 2, text: 'Observed RKPP round_start; user annotation.' });
  const turns = api.timelineTurns(freeze(record));
  assert.equal(turns.length, 36); assert.equal(turns[1].events[0].id, 'user-note');
  assert.equal(turns[35].round, 36); assert.equal(turns[35].events.length, 0);
  assert.deepEqual(api.timelineTurns({ events: [legacyNode('131a', 36)] }), []);
  assert.deepEqual(api.timelineTurns({ rounds: '36', events: [] }), []);
  assert.deepEqual(api.timelineTurns({ rounds: 1000000, events: [] }), [{ round: 1, endRound: 1000000, events: [] }]);
  const sparse = api.timelineTurns({ rounds: 1000000, events: [{ id: 'later', round: 999999, seq: 2, kind: 'skill' }, { id: 'unspecified', kind: 'note' }] });
  assert.equal(sparse[0].round, 0); assert.equal(sparse[1].endRound, 999998); assert.equal(sparse[2].events[0].id, 'later'); assert.equal(sparse[3].round, 1000000);
});

test('damage reports and actual HP/energy deltas stay distinct; irrelevant cells use em dash with explicit zeros preserved', () => {
  assert.equal(api.eventNumbers({ kind: 'damage', amount: 642, hpChange: -340, hpAfter: 0 }), '报告伤害 642 · 生命实际变化 -340 · 剩余生命 0');
  assert.equal(api.eventNumbers({ kind: 'heal', amount: 90, hpChange: 40, hpAfter: 100 }), '治疗 90 · 生命实际变化 +40 · 剩余生命 100');
  assert.equal(api.eventNumbers({ kind: 'resource', energyChange: -2, energyAfter: 0 }), '能量变化 -2 · 剩余能量 0');
  assert.equal(api.eventNumbers({ kind: 'resource', energyChange: 0, energyAfter: 10, hpChange: 0, hpAfter: 0 }), '生命实际变化 0 · 剩余生命 0 · 能量变化 0 · 剩余能量 10');
  assert.equal(api.eventNumbers({ kind: 'growth', amount: 1, stacks: 0 }), '变化量 1 · 累计计数 0');
  assert.equal(api.eventNumbers({ kind: 'effect', stacks: 2 }), '层数 2');
  assert.equal(api.eventNumbers({ kind: 'damage', amount: 0 }), '报告伤害 0');
  assert.equal(api.eventNumbers({ kind: 'damage', hpChange: -340 }), '报告伤害未提供 · 生命实际变化 -340');
  assert.equal(api.eventNumbers({ kind: 'heal', amount: null }), '治疗量未提供');
  for (const kind of ['skill', 'effect', 'note', 'switch', 'weather', 'order', 'resource']) {
    assert.equal(api.eventNumbers({ kind }), '—');
    assert.equal(api.eventNumbers({ kind, amount: '0', hpChange: null, energyAfter: '10' }), '—');
  }
});

test('known actions render canonical names, interrupted phase, non-cast effects, damage, resource and correct switch direction safely', async t => {
  const record = fixture(), base = { round: 1, seq: 10, side: 'me', actor: 'outgoing', phase: 'executed' };
  const unsafe = '<img src=x onerror=evil()>', effect = '<script>evil()</script>';
  record.events.push(
    { ...base, id: 'cast', execIndex: 0, kind: 'skill', skillClass: 'ordinary', skillId: 37, label: '来源别名不能覆盖规范名', target: 'foe', targetSide: 'enemy' },
    { ...base, id: 'interrupt', execIndex: 1, kind: 'skill', phase: 'interrupted', skillId: 37, protocolSkillId: 'runtime-interrupted' },
    { ...base, id: 'reported', execIndex: 2, kind: 'damage', amount: 642, hpChange: -340, hpAfter: 0, target: 'foe', targetSide: 'enemy' },
    { ...base, id: 'restored', execIndex: 3, kind: 'heal', amount: 50, hpChange: 50, hpAfter: 110 },
    { ...base, id: 'energy', execIndex: 4, kind: 'resource', skillClass: 'system', energyChange: -2, energyAfter: 0, label: '能量恢复' },
    { ...base, id: 'passive', execIndex: 5, kind: 'effect', skillClass: 'passive', label: effect, protocolSkillId: 'unmapped-passive' },
    { ...base, id: 'response', execIndex: 6, kind: 'skill', skillClass: 'response', label: unsafe, protocolSkillId: 'unmapped-response' },
    { ...base, id: 'unknown', execIndex: 7, kind: 'effect', skillClass: 'unknown', label: '仅有配置标签', protocolSkillId: 'unmapped-unknown' },
    { ...base, id: 'switched', execIndex: 8, kind: 'switch', actor: 'incoming', target: 'outgoing', targetSide: 'me' },
    { ...base, id: 'initial', execIndex: 9, kind: 'switch', actor: 'incoming' },
    { ...base, id: 'system', execIndex: 10, kind: 'effect', skillClass: 'system', label: '系统指令' },
    { ...base, id: 'legacy-cast', execIndex: 11, kind: 'skill', skillId: 37 }
  );
  const before = JSON.stringify(record), r = await open(t, record);
  assert.equal(r.turns().length, 36); assert.equal(r.rows().length, 5);
  assert.equal(r.all(r.row('cast')).find(n => n.className === 'br-skill-name').textContent, '规范技能名');
  assert.doesNotMatch(r.row('cast').textContent, /来源别名不能覆盖规范名|初始精灵/);
  assert.match(r.row('interrupt').textContent, /规范技能名.*被打断/);
  assert.doesNotMatch(r.row('interrupt').textContent, /耗能|回能|伤害/);
  assert.match(r.row('response').textContent, /<img src=x onerror=evil\(\)>.*应对/);
  assert.equal(r.row('passive'), undefined); assert.equal(r.row('reported'), undefined); assert.equal(r.row('energy'), undefined);
  assert.match(r.row('system').textContent, /系统指令/); assert.doesNotMatch(r.row('system').textContent, /系统行动/);
  assert.match(r.row('legacy-cast').textContent, /规范技能名/);
  assert.ok(r.all(r.turns()[0]).some(n => n.className === 'br-switch-separator' && n.textContent === '换场 →'));
  assert.equal(r.all().some(node => node.tagName === 'script'), false);
  const images = r.all().filter(node => node.tagName === 'img');
  assert.ok(images.length > 0);
  assert.ok(images.every(node => node.src === 'assets/monster/skill/' + encodeURIComponent('规范技能名') + '.png' && node.parentNode.className === 'br-image-slot br-image-skill' && !node.attrs.onerror));
  assert.equal(r.all(r.panel('detail')).some(n => ['input', 'select', 'textarea', 'table', 'details'].includes(n.tagName)), false);
  assert.equal(r.btn('确认本记录技能映射'), undefined); assert.equal(r.inference.length, 0);
  assert.equal(record.events.find(e => e.id === 'response').skillId, undefined);
  assert.equal(JSON.stringify(record), before); assert.ok(r.calls.every(call => !call.options.method));
});

test('effect kind and passive/system class never turn into skill casts merely because an ID or label exists', () => {
  assert.equal(api.recordCountsText({ rounds: 36 }), '对战回合：36回合');
  assert.doesNotMatch(api.recordCountsText({ rounds: 36 }), /事件：未知/);
  assert.match(api.eventName({ kind: 'effect', skillId: 37 }), /^效果 · /);
  assert.equal(api.eventName({ kind: 'resource', label: '能量同步' }), '资源 / 状态 · 能量同步');
  assert.doesNotMatch(api.eventName({ kind: 'effect', skillClass: 'system', label: '聚能', protocolSkillId: '700001000' }), /身份未映射/);
  assert.match(api.eventName({ kind: 'skill', skillClass: 'passive', label: '配置被动' }), /^效果（被动，不计技能释放）/);
  assert.match(api.eventName({ kind: 'skill', skillClass: 'system', label: '配置系统' }), /^效果（系统，不计技能释放）/);
  assert.match(api.eventName({ kind: 'resource', skillClass: 'system', skillId: 37 }), /^资源 \/ 状态（系统，不计技能释放）/);
  assert.match(api.eventName({ kind: 'skill', skillClass: 'unknown', label: '疑似技能' }), /类别未确认.*Wiki 身份未映射/);
  const base = { round: 1, side: 'me', actor: 'outgoing', kind: 'growth', trigger: 'explicit', phase: 'executed' };
  assert.deepEqual(api.confirmedGrowth({ sides: fixture().sides, events: [
    { ...base, phase: 'interrupted' }, { ...base, kind: 'skill' }, { ...base, kind: 'effect', skillClass: 'passive' }, { ...base, kind: 'resource', skillClass: 'system' }
  ] }), []);
});

test('metadata lifecycle records stay in immutable raw data without handoff and mount no source tables or unknown actions', async t => {
  const record = fixture(); record.events = [{ id: 'metadata-start', round: 1, kind: 'note', lifecycle: 'round_start' }];
  const r = await open(t, record);
  assert.equal(r.rows().length, 0); assert.equal(r.turns().length, 36);
  assert.equal(r.all(r.panel('detail')).some(node => node.dataset.br === 'lifecycle' || node.tagName === 'table'), false);
  assert.ok(r.turns().every(turn => turn.textContent.includes(EMPTY_TURN)));
  assert.equal(r.btn('用于伤害计算'), undefined); assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, ''); assert.equal(record.events.length, 1);
});

test('timeline actors and targets use immutable current-form identities before/after transitions and reversion', async t => {
  const record = fixture(), base = { round: 2, seq: 10, side: 'me', actor: 'outgoing', phase: 'executed', kind: 'skill', skillId: 37 };
  const transition = { ...base, kind: 'form', skillId: 0, form: { fromMonsterId: 101, toMonsterId: 104, execIndex: 99 } };
  // Deliberately shuffled source order. Top-level execIndex overrides nested
  // form99; reversion uses only legacy form.execIndex6.
  record.events.push(
    { ...base, id: 'current-after', execIndex: 2 },
    { ...base, id: 'current-reverted', execIndex: 7, targetSide: 'enemy', target: 'foe' },
    { ...transition, id: 'current-reversion', form: { fromMonsterId: 104, toMonsterId: 101, execIndex: 6 } },
    { ...base, id: 'current-target', execIndex: 4, targetSide: 'enemy', target: 'foe' },
    { ...transition, id: 'current-transition', execIndex: 1 },
    { ...base, id: 'current-before', execIndex: 0, targetSide: 'enemy', target: 'foe' },
    { ...transition, id: 'current-enemy-transition', side: 'enemy', actor: 'foe', execIndex: 3, form: { fromMonsterId: 103, toMonsterId: 105 } },
    { ...base, id: 'current-switch', kind: 'switch', skillId: 0, execIndex: 5, actor: 'incoming', targetSide: 'me', target: 'outgoing' },
    { ...base, id: 'current-later-round', round: 3, seq: 0, execIndex: 0, targetSide: 'enemy', target: 'foe' },
    { ...base, id: 'current-earlier-seq', seq: 9, execIndex: 100 }
  );
  const before = JSON.stringify(record), r = await open(t, record);
  const pets = r.turns()[1].children.find(n => n.dataset.row === 'pets');
  const me = pets.children[0].textContent, enemy = pets.children[1].textContent;
  assert.match(me, /初始精灵/); assert.match(me, /战斗形态/); assert.match(me, /换入精灵/); assert.doesNotMatch(me, /对手形态/);
  assert.equal(enemy, '', 'A target/form record alone cannot invent a visible active participant');
  for (const action of r.rows()) assert.doesNotMatch(action.textContent, /初始精灵|战斗形态|对手形态/);
  const laterPets = r.turns()[2].children.find(n => n.dataset.row === 'pets').children[0];
  assert.match(laterPets.textContent, /初始精灵/); assert.doesNotMatch(laterPets.textContent, /战斗形态/);
  assert.equal(r.all(r.panel('detail')).filter(node => node.className === 'br-pet-profile').length, 0);
  assert.equal(r.inference.length, 0); assert.equal(r.btn('用于伤害计算'), undefined); assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, '');
  assert.equal(record.sides.me.pets[0].monsterId, 101); assert.equal(record.sides.enemy.pets[0].monsterId, 103);
  assert.equal(JSON.stringify(record), before); assert.ok(r.calls.every(call => !call.options.method));
});

test('unmapped current forms stay unknown for actor and target; preview and another side never change identity', async t => {
  const record = fixture(); record.sides.enemy.pets.push({ instanceId: 'outgoing', monsterId: 103 });
  const base = { round: 1, seq: 1, side: 'me', actor: 'outgoing', phase: 'executed', kind: 'skill', skillId: 37 };
  const form = { ...base, kind: 'form', skillId: 0 };
  record.events.push(
    { ...form, id: 'unknown-established', execIndex: 0, form: { fromMonsterId: 101, toMonsterId: 104 } },
    { ...form, id: 'unknown-preview', execIndex: 1, phase: 'preview', form: { fromMonsterId: 104, toMonsterId: 105 } },
    { ...base, id: 'unknown-before', execIndex: 2, targetSide: 'enemy', target: 'outgoing' },
    { ...form, id: 'unknown-transition', execIndex: 3, form: { fromMonsterId: 104, toMonsterId: 0, toBaseId: '101' } },
    { ...base, id: 'unknown-actor', execIndex: 4, targetSide: 'enemy', target: 'outgoing' },
    { ...base, id: 'unknown-target', execIndex: 5, side: 'enemy', targetSide: 'me', target: 'outgoing' },
    { ...form, id: 'unknown-missing-id', execIndex: 6, form: { fromMonsterId: 0, toBaseId: '101' } },
    { ...base, id: 'unknown-switch', execIndex: 7, kind: 'switch', skillId: 0, actor: 'incoming', target: 'outgoing' },
    { ...form, id: 'unknown-recover', execIndex: 8, form: { fromMonsterId: 0, toMonsterId: 101 } },
    { ...base, id: 'unknown-recovered', execIndex: 9 }
  );
  const before = JSON.stringify(record), r = await open(t, record);
  const pets = r.turns()[0].children.find(n => n.dataset.row === 'pets');
  assert.match(pets.children[0].textContent, /战斗形态/); assert.match(pets.children[0].textContent, /身份未映射/); assert.match(pets.children[0].textContent, /初始精灵/);
  assert.doesNotMatch(pets.children[0].textContent, /对手形态/);
  assert.match(pets.children[1].textContent, /对手精灵/); assert.doesNotMatch(pets.children[1].textContent, /身份未映射|战斗形态/);
  assert.equal(r.all(r.panel('detail')).some(n => n.className.includes('br-identity-editor')), false);
  assert.equal(JSON.stringify(record), before); assert.equal(r.inference.length, 0);
  assert.equal(r.btn('用于伤害计算'), undefined); assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, ''); assert.ok(r.calls.every(call => !call.options.method));
});

test('passive/system protocol IDs never prompt an ordinary-skill mapping', async t => {
  const record = fixture(); record.events.push(
    { id: 'passive-only', round: 1, kind: 'effect', phase: 'executed', side: 'me', actor: 'outgoing', skillClass: 'passive', protocolSkillId: 'trait-runtime', label: '特性' },
    { id: 'system-only', round: 1, kind: 'resource', phase: 'executed', side: 'me', actor: 'outgoing', skillClass: 'system', protocolSkillId: 'energy-runtime', label: '聚能' }
  );
  const r = await open(t, record);
  assert.equal(r.all(r.panel('detail')).filter(node => node.className.includes('br-identity-editor')).length, 0);
  assert.equal(r.btn('确认本记录技能映射'), undefined);
  assert.equal(r.row('passive-only'), undefined); assert.equal(r.row('system-only'), undefined);
  assert.doesNotMatch(r.panel('detail').textContent, /trait-runtime|energy-runtime/);
  assert.ok(r.calls.every(call => !call.options.method));
});

test('all unmapped classes and shared IDs remain read-only without advanced mapping controls', async t => {
  const record = fixture(), base = { round: 1, kind: 'skill', phase: 'executed', side: 'me', actor: 'outgoing' };
  record.events.push(
    { ...base, id: 'map-legacy', protocolSkillId: 'legacy' },
    { ...base, id: 'map-empty', protocolSkillId: 'empty', skillClass: '' },
    { ...base, id: 'map-ordinary', protocolSkillId: 'ordinary', skillClass: 'ordinary' },
    { ...base, id: 'map-response', protocolSkillId: 'response', skillClass: 'response' },
    { ...base, id: 'map-unknown', protocolSkillId: 'unknown', skillClass: 'unknown' },
    { ...base, id: 'map-shared', protocolSkillId: 'shared' },
    { ...base, id: 'map-shared-passive', protocolSkillId: 'shared', kind: 'effect', skillClass: 'passive' },
    { ...base, id: 'map-shared-system', protocolSkillId: 'shared', kind: 'resource', skillClass: 'system' }
  );
  const before = JSON.stringify(record), r = await open(t, record);
  assert.equal(r.all(r.panel('detail')).filter(node => node.className === 'br-mapping-row').length, 0);
  assert.equal(r.all(r.panel('detail')).some(n => ['input', 'select', 'textarea'].includes(n.tagName)), false);
  assert.equal(r.btn('确认本记录技能映射'), undefined); assert.equal(r.inference.length, 0);
  assert.equal(r.rows().length, 6, 'Ordinary/response/legacy cards remain distinct from passive/system resource records');
  assert.equal(r.btn('用于伤害计算'), undefined); assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, '');
  for (const event of record.events.filter(event => event.protocolSkillId)) assert.equal(event.skillId, undefined);
  assert.equal(JSON.stringify(record), before); assert.ok(r.calls.every(call => !call.options.method));
});
