'use strict';
// Identity-only frontend tests. In-memory records/DOM/API; no profiles, DB,
// relay, capture, network, fixtures on disk or filesystem writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../js/pages/battle-records.js');
const source = fs.readFileSync(path.join(__dirname, '../js/pages/battle-records.js'), 'utf8');
const revision = 'a'.repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function fixture() {
  const pets = side => Array.from({ length: 6 }, (_, i) => ({
    instanceId: `${side}-${i}`, monsterId: 101, protocolId: `conf-${side}-${i}`,
    protocolBaseId: 'base-original', mappingRevision: revision, name: '不可信来源名', level: 60
  }));
  return {
    version: 1, id: 'identity-isolated', source: 'isolated-test', rounds: 36, outcome: 'win',
    sides: { me: { pets: pets('me') }, enemy: { pets: pets('enemy') } },
    quality: { roster: { me: true, enemy: true }, actions: false, lead: { me: false, enemy: false } },
    events: [
      { id: 'skill', kind: 'skill', phase: 'preview', round: 4, seq: 1, side: 'enemy', actor: 'enemy-0' },
      ...[6, 2, 0, 4, 1, 5, 3].map(i => ({
        id: `form-${i}`, kind: 'form', phase: 'executed', round: 2, seq: 7, side: 'me', actor: 'me-0',
        form: { fromBaseId: i % 2 ? 'base-frost' : 'base-original', toBaseId: i % 2 ? 'base-original' : 'base-frost',
          fromMonsterId: i % 2 ? 102 : 101, toMonsterId: i % 2 ? 101 : 102, mappingRevision: revision, execIndex: i }
      })),
      { id: 'end', kind: 'note', phase: 'unknown', round: 0, seq: 20, text: '来源结算备注' }
    ]
  };
}

// Same minimal DOM contract as the existing battle-records-ui tests; text-only
// insertion is enforced, and every API request is served here or rejected.
function runtime(record) {
  let doc;
  class Element {
    constructor(tag) { this.tagName = tag; this.nodeType = 1; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.value = ''; this.className = ''; this._text = ''; this.ownerDocument = doc; }
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
  const monsters = [
    { id: 101, localized: { zh: { name: '同名精灵' } }, form: 'Original' },
    { id: 102, localized: { zh: { name: '同名精灵' } }, form: '霜形态' },
    { id: 103, localized: { zh: { name: '<img onerror=evil()>' } }, form: '地区形态' }
  ];
  const root = { BattleTurnView: require('../js/battle-turn-view.js'), document: doc, location: { hash: '' }, AbortController, URLSearchParams, Date, console, setTimeout, clearTimeout,
    BattleRecordsClient: {
      async request(url, options = {}) {
        calls.push({ url, options });
        assert.ok(!options.method || options.method === 'GET', 'Rendering must not perform writes');
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
    getMonsters: () => monsters, getMonsterById: id => monsters.find(pet => pet.id === id), getMoves: () => [],
    getMonsterDisplayName: pet => pet.localized.zh.name + (pet.form === 'Original' ? '' : `（${pet.form}）`)
  } });
  // Production RKData is a lexical global, not necessarily a window property.
  vm.runInContext('const RKData = testData;\n' + source, context);
  const page = root.BattleRecordsPage, host = doc.createElement('main'); doc.body.append(host);
  const all = (node = doc.body) => [node, ...node.children.flatMap(child => all(child))];
  const btn = label => all().find(node => node.tagName === 'button' && node.textContent === label);
  const panel = key => all().find(node => key === 'detail' ? node.dataset.br === 'detail' : node.dataset.brPanel === key);
  page.render(host);
  return { page, root, host, calls, inference, all, btn, panel };
}

test('round counts use only bounded authoritative rounds, not event count or largest round', () => {
  const events = freeze(Array.from({ length: 172 }, (_, i) => ({ round: i + 1 })));
  assert.deepEqual(api.recordCounts({ rounds: 36, events }), { rounds: 36, events: 172 });
  assert.equal(api.recordCountsText({ rounds: 36, events }), '对战回合：36回合');
  for (const rounds of [undefined, null, 0, -1, 1.5, '36', NaN, Infinity, 1000001]) {
    assert.deepEqual(api.recordCounts({ rounds, events }), { rounds: null, events: 172 });
    assert.match(api.recordCountsText({ rounds, events }), /对战回合：未知/);
  }
  for (const rounds of [1, 1000000]) assert.equal(api.recordCounts({ rounds }).rounds, rounds);
  assert.deepEqual(api.recordCounts({ rounds: 36, events: [] }), { rounds: 36, events: 0 });
  assert.deepEqual(api.recordCounts({}), { rounds: null, events: null });
  assert.deepEqual(api.recordCounts(null), { rounds: null, events: null });
});

test('elapsed time uses only nonnegative normalized integer seconds, preserving zero and missing boundaries', () => {
  const base = freeze({ rounds: 36, startedAt: '2026-11-01T12:00:00Z', finishedAt: '2026-11-01T12:03:45Z', events: [{ round: 283, timestamp: '2026-11-01T12:06:00Z' }] });
  for (const [durationSeconds, expected] of [[0, '0分钟0秒'], [1, '0分钟1秒'], [59, '0分钟59秒'], [60, '1分钟0秒'], [61, '1分钟1秒'], [3601, '60分钟1秒']]) {
    const record = freeze({ ...base, durationSeconds }), before = JSON.stringify(record);
    assert.equal(api.recordCountsText(record), `对战回合：36回合；对战用时：${expected}`);
    assert.equal(JSON.stringify(record), before);
  }
  for (const durationSeconds of [undefined, null, '', '0', '60', false, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(api.recordCountsText({ ...base, durationSeconds }), '对战回合：36回合', String(durationSeconds));
  }
  assert.equal(api.recordCountsText({ durationSeconds: 0 }), '对战回合：未知；对战用时：0分钟0秒');
  assert.equal(api.recordCountsText(null), '对战回合：未知');
});

test('form transitions resolve exactly both canonical IDs and never base IDs or names', () => {
  const names = new Map([[101, '同名精灵'], [102, '同名精灵（霜形态）']]);
  const name = id => names.get(id) || '身份未映射';
  const form = freeze({ fromMonsterId: 101, toMonsterId: 102, fromBaseId: '102', toBaseId: '101', name: '来源名', conf_id: '103' });
  assert.equal(api.formChangeText(form, name), '同名精灵 → 同名精灵（霜形态）');
  assert.equal(api.formChangeText({ fromMonsterId: 0, toMonsterId: 102, fromBaseId: '101' }, name), '身份未映射 → 同名精灵（霜形态）');
  assert.equal(api.formChangeText({ fromMonsterId: 101, toMonsterId: 0, toBaseId: '102' }, name), '同名精灵 → 身份未映射');
  assert.equal(api.formChangeText(null, name), '身份未映射 → 身份未映射');
});

test('identity evidence labels exact base/revision fields without conf_id fallback', () => {
  const pet = freeze({ protocolBaseId: '00042', mappingRevision: revision, protocolId: 'not-the-base', conf_id: 'do-not-use', name: 'never-map-me' });
  assert.equal(api.identityEvidenceText(pet), `初始 baseID（protocolBaseId）：00042 · 映射版本（mappingRevision / canonical SHA-256）：${revision}`);
  assert.equal(api.formEvidenceText({ fromBaseId: '00042', toBaseId: '0042', mappingRevision: revision }), `baseID：00042 → 0042 · 映射版本（mappingRevision / canonical SHA-256）：${revision}`);
  assert.equal(api.identityEvidenceText({ protocolId: '101', conf_id: '102' }), '初始 baseID（protocolBaseId）：未知 · 映射版本（mappingRevision / canonical SHA-256）：未知');
  assert.equal(api.formEvidenceText(null), 'baseID：未知 → 未知 · 映射版本（mappingRevision / canonical SHA-256）：未知');
});

test('events sort round then seq then execIndex and ties preserve source order without mutation', () => {
  const events = freeze([
    { id: 'r2', round: 2, seq: 0, form: { execIndex: 0 } },
    { id: 'f2', round: 1, seq: 2, kind: 'form', form: { execIndex: 2 } },
    { id: 'f1', round: 1, seq: 2, kind: 'form', form: { execIndex: 1 } },
    { id: 'legacy-a', round: 1, seq: 2, kind: 'skill' },
    { id: 'zero', round: 1, seq: 2, kind: 'form', form: { execIndex: 0 } },
    { id: 'legacy-b', round: 1, seq: 2, kind: 'damage' },
    { id: 'f1-tie', round: 1, seq: 2, kind: 'form', form: { execIndex: 1 } },
    { id: 'seq-first', round: 1, seq: 1, form: { execIndex: 1000000000 } },
    { id: 'unknown', kind: 'note' }
  ]);
  const before = JSON.stringify(events);
  assert.deepEqual(api.groupedTurns(events).map(turn => turn.events.map(event => event.id)), [
    ['unknown'], ['seq-first', 'legacy-a', 'zero', 'legacy-b', 'f1', 'f1-tie', 'f2'], ['r2']
  ]);
  assert.equal(JSON.stringify(events), before);
  assert.deepEqual(api.groupedTurns(undefined), []);
});

test('form execution does not become confirmed growth', () => {
  const record = fixture();
  for (const event of record.events) { event.trigger = 'not-growth'; event.stacks = 99; }
  assert.deepEqual(api.confirmedGrowth(freeze(record)), []);
});

test('compact detail preserves initial 6v6 roster and all form evidence in immutable raw data without damage handoff', async t => {
  const record = freeze(fixture()), before = JSON.stringify(record), r = runtime(record);
  t.after(() => r.page.onLeave()); await tick();
  assert.match(r.panel('list').textContent, /对战回合：36回合/);
  r.btn('查看详情').click(); await tick();
  const detail = r.panel('detail');
  assert.match(detail.textContent, /对战回合：36回合/);
  assert.equal(r.all(detail).some(node => ['br-pet-profile', 'br-source-turn', 'br-advanced'].includes(node.className)), false);
  assert.equal(r.all(detail).some(node => ['input', 'select', 'textarea', 'table', 'details'].includes(node.tagName)), false);
  assert.doesNotMatch(detail.textContent, /protocolBaseId|mappingRevision|来源结算备注|配置、映射与来源证据/);
  const forms = api.timelineTurns(record).find(turn => turn.round === 2).events;
  assert.deepEqual(forms.map(event => event.form.execIndex), [0,1,2,3,4,5,6]);
  assert.equal(record.sides.me.pets.length, 6); assert.equal(record.sides.enemy.pets.length, 6);
  assert.equal(r.inference.length, 0); assert.equal(r.btn('用于伤害计算'), undefined);
  assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, '');
  assert.equal(JSON.stringify(record), before); assert.ok(r.calls.every(call => !call.options.method));
});

test('missing rounds and unknown identity stay unknown; malicious imported and canonical names stay text', async t => {
  const record = fixture(); delete record.rounds;
  record.sides.me.pets[0] = { instanceId: 'me-0', monsterId: 0, protocolId: '103', name: '<script>evil()</script>' };
  record.events = [
    { id: 'unknown-form', kind: 'form', phase: 'unknown', round: 36, seq: 0, side: 'me', actor: 'me-0', form: { fromMonsterId: 0, toMonsterId: 103, fromBaseId: '101', toBaseId: '<img src=x>', execIndex: 0 } },
    { id: 'unknown-cast', kind: 'skill', phase: 'executed', round: 36, seq: 1, side: 'me', actor: 'me-0' },
    { id: 'known-cast', kind: 'skill', phase: 'executed', round: 36, seq: 2, side: 'enemy', actor: 'enemy-0' }
  ];
  record.sides.enemy.pets[0].monsterId = 103;
  const before = JSON.stringify(record), r = runtime(freeze(record)); t.after(() => r.page.onLeave()); await tick();
  r.btn('查看详情').click(); await tick();
  const detail = r.panel('detail');
  assert.match(detail.textContent, /对战回合：未知/);
  const round = r.all(detail).find(n => n.className === 'br-round'), row = round.children.find(n => n.dataset.row === 'pets');
  assert.match(row.children[0].textContent, /身份未映射.*<script>evil\(\)<\/script>/);
  assert.doesNotMatch(row.children[0].textContent, /地区形态/);
  assert.match(row.children[1].textContent, /<img onerror=evil\(\)>（地区形态）/);
  assert.doesNotMatch(detail.textContent, /baseID：101|protocolBaseId|<img src=x>/);
  assert.equal(r.btn('确认本记录精灵映射'), undefined); assert.equal(r.inference.length, 0);
  assert.equal(r.all().some(node => ['script', 'img'].includes(node.tagName)), false);
  assert.equal(JSON.stringify(record), before); assert.equal(r.calls.some(call => call.options.method), false);
});

test('pure identity helpers remain exposed but advanced renderers and hooks are removed', () => {
  assert.match(source, /note\(recordCountsText\(record\)\)/);
  assert.match(source, /formChangeText\(event\.form\)/);
  for (const name of ['identityEvidenceText', 'formChangeText', 'formEvidenceText', 'eventName', 'eventNumbers', 'groupedTurns']) assert.equal(typeof api[name], 'function');
  assert.doesNotMatch(source, /renderInference|saveMapping|renderIdentityMapping|br-pet-profile|br-source-evidence|br-advanced/);
  assert.doesNotMatch(source, /localStorage\.|sessionStorage\.|UserConfig\.|\.innerHTML\s*=/);
});
