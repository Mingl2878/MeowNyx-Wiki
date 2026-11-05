'use strict';
// Pure memory UI/service fixtures: no real server, catalog writes, AppData, browser profile or backups.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCatalogUpdater } = require('../js/catalog-updater.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const status = (state = 'idle', extra = {}) => ({ ok: true, state, task_id: state === 'idle' ? '' : 'fixture-task', phase: '', completed: 0, base_revision: 'loaded-r1', current_revision: 'loaded-r1', source_url: 'https://official.example.invalid/catalog', changes: [], candidates: [], remembered_choices: [], automatic_source_changes: 0, issues: [], summary: {}, can_apply: state === 'preview', ...extra });
const review = { severity: 'review', code: 'local_move', entity: 'move', id: 90001, name: '本地技能', message: '保留本地并跳过' };
const change = { entity: 'monster', id: 42, name: '精灵', field: 'base_hp', before: 110, after: 120, kind: 'update' };
const missingField = { severity: 'warning', code: 'invalid_field', entity: 'monster', source_id: 'source-42', name: '鸭吉吉国王', field: 's', message: '字段缺失或非法，保留本地值' };
const evolutionIncomplete = { ...missingField, code: 'evolution_source_incomplete', field: 'evolves_from_id', message: '官方进化来源仅有自引用，保留本地关系' };
const descendants = node => [node, ...node.children.flatMap(descendants)];
const visible = node => !!node && !node.hidden && (!node.parentNode || visible(node.parentNode));
const openDetails = node => { node.open = true; node.emit('toggle'); };
function runtime(initial = status(), custom = {}, options = {}) {
  let doc;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.ownerDocument = doc; this.dataset = {}; this.attrs = {}; this.listeners = {}; this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; }
    get isConnected() { return this === doc.body || !!this.parentNode?.isConnected; }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this._text = ''; this.append(...nodes); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(' '); }
    set innerHTML(_) { throw Error('Catalog UI must only use safe text nodes'); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    emit(name, init = {}) { const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init }; for (const callback of this.listeners[name] || []) callback(event); return event; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    showModal() { assert.equal(this.isConnected, true); this.open = true; this.modal = true; }
    close() { this.open = false; this.emit('close'); }
    click() {
      if (this.disabled) return;
      if (this.type !== 'radio') { this.emit('click'); return; }
      // Native label/pointer/Space activation checks the radio before click,
      // then emits change only if it remains newly checked afterward.
      const wasChecked = this.checked;
      for (const node of descendants(doc.body)) if (node.type === 'radio' && node.name === this.name) node.checked = false;
      this.checked = true; this.emit('click');
      if (!wasChecked && this.checked) this.emit('change');
    }
    scrollIntoView(options) { this.scrollRequest = options; }
    focus(options) { this.focusRequest = options; doc.activeElement = this; }
  }
  doc = { createElement: tag => new Element(tag) }; doc.body = new Element('body');
  const host = doc.createElement('div'); doc.body.append(host);
  const calls = [], confirms = [], timers = new Map(); let timerID = 0, clock = 0, server = clone(initial), reloads = 0;
  const root = { document: doc, AbortController,
    setTimeout(fn, ms) { timers.set(++timerID, { fn, due: clock + ms, ms }); return timerID; },
    clearTimeout(id) { timers.delete(id); },
    confirm(message) { confirms.push(message); return custom.confirm?.(message) ?? true; },
    location: { reload() { reloads++; } },
    UserConfig: { flush: () => custom.userFlush ? custom.userFlush() : Promise.resolve(true) },
    BattleRecordsClient: { flush: () => custom.battleFlush ? custom.battleFlush() : Promise.resolve(true) },
    fetch: async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
      const action = url.split('/').at(-1);
      const override = await custom.handle?.(action, init, server);
      if (override !== undefined) return override;
      if (action === 'check') server = status('checking', { completed: 2, total: 10 });
      if (action === 'cancel') server = status('cancelled');
      if (action === 'apply') server = { ...server, state: 'applying', can_apply: false };
      return { ok: true, json: async () => clone(server) };
    }
  };
  Object.defineProperty(root, 'localStorage', { get() { throw Error('No profile/localStorage access allowed'); } });
  const updater = createCatalogUpdater(root, { pollMs: 100, requestTimeoutMs: 1000, flushTimeoutMs: 1500, ...options });
  const all = (node = host) => [node, ...node.children.flatMap(all)];
  const find = predicate => all().find(predicate);
  const button = action => find(node => node.tagName === 'button' && node.dataset.action === action);
  const advance = async ms => {
    const end = clock + ms;
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!entry) break;
      clock = entry[1].due; timers.delete(entry[0]); entry[1].fn(); await tick();
    }
    clock = end; await tick();
  };
  return { root, updater, host, all, find, button, timers, calls, confirms, advance, get reloads() { return reloads; }, set server(value) { server = clone(value); }, ready: updater.mount(host) };
}


const candidate = { key: 'monster:42:stats.hp', entity: 'monster', id: 42, name: '精灵', field: 'stats.hp', kind: 'update', local_value: 110, source_value: 120, local_available: true, source_available: true };
const memory = { key: candidate.key, entity: candidate.entity, id: 42, name: candidate.name, field: candidate.field, choice: 'local' };
const radio = (r, side, key = candidate.key) => r.find(node => node.type === 'radio' && node.dataset.key === key && node.value === side);
function select(r, side, key = candidate.key) { const item = radio(r, side, key); assert.ok(item); item.click(); }

test('opening reads only same-origin status and no terminal polling, storage or writes', async () => {
  const r = runtime(); await r.ready;
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].url, '/api/catalog/update/status');
  assert.equal(r.calls[0].init.method, 'GET'); assert.equal(r.calls[0].init.credentials, 'same-origin'); assert.equal(r.calls[0].init.redirect, 'error');
  assert.equal(r.timers.size, 0); assert.equal(r.button('apply').disabled, true); assert.equal(r.reloads, 0);
  assert.equal(visible(r.find(n => n.className === 'cu-apply-reason')), false);
  assert.equal(r.button('apply').textContent, '确认并应用');
  assert.doesNotMatch(r.host.textContent, /不提供逐字段|为什么|普通手工值后续仍/);
});

test('radios start unselected, stay mutually exclusive and send only server key plus choice', async () => {
  const r = runtime(status('preview', { candidates: [candidate] })); await r.ready;
  assert.equal(radio(r, 'local').checked, false); assert.equal(radio(r, 'source').checked, false); assert.equal(r.button('apply').disabled, true);
  assert.equal(visible(r.find(n => n.className === 'cu-apply-reason')), false); select(r, 'source'); assert.equal(r.button('apply').disabled, false);
  select(r, 'local'); assert.equal(radio(r, 'source').checked, false); assert.equal(r.calls.length, 1);
  r.button('apply').click(); r.button('apply').click(); await tick();
  assert.deepEqual(r.calls.at(-1).body, { task_id: 'fixture-task', base_revision: 'loaded-r1', acknowledge_reviews: false, choices: [{ key: candidate.key, choice: 'local' }] });
  assert.equal(r.calls.filter(c => c.url.endsWith('/apply')).length, 1); assert.equal(r.reloads, 0); r.updater.unmount();
});

test('partial choices remain drafts across status/remount and unselected items remain visible', async () => {
  const other = { ...candidate, id: 43, key: 'monster:43:stats.hp' };
  const r = runtime(status('preview', { candidates: [candidate, other] })); await r.ready; select(r, 'local');
  await r.updater.mount(r.host); assert.equal(radio(r, 'local').checked, true);
  r.updater.unmount(); await r.updater.mount(r.host); assert.equal(radio(r, 'local').checked, true); assert.equal(radio(r, 'local', other.key).checked, false);
  r.button('apply').click(); await tick(); assert.equal(r.calls.at(-1).body.choices.length, 1); r.updater.unmount();
});

test('unavailable source is disabled while local can be selected; explicit empty values remain selectable', async () => {
  const missing = { ...candidate, field: 'evolution_stage', source_value: null, source_available: false };
  const r = runtime(status('preview', { candidates: [missing] })); await r.ready;
  assert.equal(radio(r, 'source').disabled, true); assert.match(r.host.textContent, /未提供可用源值/);
  select(r, 'source'); assert.equal(r.button('apply').disabled, true);
  select(r, 'local'); assert.equal(r.button('apply').disabled, false);
  const empty = runtime(status('preview', { candidates: [{ ...candidate, source_value: [] }] })); await empty.ready;
  assert.equal(radio(empty, 'source').disabled, false); select(empty, 'source'); assert.equal(empty.button('apply').disabled, false);
});

test('individual drafts survive pagination; reactivating a selected radio undoes only that row', async () => {
  const items = Array.from({ length: 93 }, (_, id) => ({ ...candidate, id, key: 'monster:' + id + ':stats.hp', source_available: id !== 32 }));
  const r = runtime(status('preview', { candidates: items })); await r.ready;
  assert.equal(r.all().filter(n => n.className === 'cu-change').length, 30);
  select(r, 'source', items[0].key); select(r, 'local', items[1].key);
  const panel = r.find(n => n.tagName === 'section' && n.textContent.startsWith('差异候选'));
  descendants(panel).find(n => n.dataset.action === 'next').click();
  select(r, 'source', items[32].key); assert.equal(radio(r, 'source', items[32].key).checked, false);
  select(r, 'local', items[32].key);
  descendants(panel).find(n => n.dataset.action === 'previous').click();
  assert.equal(radio(r, 'source', items[0].key).checked, true);
  select(r, 'source', items[0].key); // Same native click event emitted by keyboard Space.
  assert.equal(radio(r, 'source', items[0].key).checked, false);
  assert.equal(radio(r, 'local', items[0].key).checked, false);
  assert.equal(radio(r, 'local', items[1].key).checked, true);
  r.button('apply').click(); await tick();
  assert.deepEqual(r.calls.at(-1).body.choices, [{ key: items[1].key, choice: 'local' }, { key: items[32].key, choice: 'local' }]); r.updater.unmount();
});

test('thousands of differences and memories stay paged, with all values and controls reachable', async () => {
  const items = Array.from({ length: 3000 }, (_, id) => ({ ...candidate, id, key: 'monster:' + id + ':stats.hp', entity: id % 2 ? 'skill' : 'monster' }));
  const r = runtime(status('preview', { candidates: items, remembered_choices: items.map(i => ({ ...memory, key: i.key })) })); await r.ready;
  assert.equal(r.all().filter(n => n.className === 'cu-change').length, 30); assert.ok(r.all().length < 650);
  const panel = r.find(n => n.tagName === 'section' && n.textContent.startsWith('差异候选'));
  descendants(panel).find(n => n.dataset.action === 'next').click(); assert.match(panel.textContent, /2 \/ 100 批/);
  const filter = r.find(n => n.attrs['aria-label'] === '差异分类'); filter.value = 'skill'; filter.emit('change'); assert.match(panel.textContent, /1 \/ 50 批/);
  const operation = r.find(n => n.className === 'cu-operation'); assert.ok(r.all().indexOf(operation) < r.all().indexOf(panel));
  assert.doesNotMatch(css, /position\s*:\s*(?:fixed|sticky)/);
});

test('remembered local rows are managed separately and source automatic changes still require Apply', async () => {
  const r = runtime(status('preview', { remembered_choices: [memory], automatic_source_changes: 1 })); await r.ready;
  assert.equal(r.all().filter(n => n.type === 'radio').length, 0); assert.match(r.host.textContent, /保留本地/); assert.equal(r.button('apply').disabled, false);
  assert.equal(r.calls.filter(c => c.init.method === 'POST').length, 0);
  r.button('apply').click(); await tick(); assert.deepEqual(r.calls.at(-1).body.choices, []); assert.equal(r.reloads, 0); r.updater.unmount();
});

test('remembered policies survive a fresh UI and individual/all clear use current revision', async () => {
  for (const action of ['clear-choice', 'clear-all']) {
    const r = runtime(status('preview', { remembered_choices: [memory], current_revision: 'latest-r2' }), { handle: name => name === 'clear' ? { ok: true, json: async () => status('idle', { current_revision: 'after-clear-r3' }) } : undefined }); await r.ready;
    assert.match(r.host.textContent, /保留本地/); r.button(action).click(); await tick();
    assert.equal(r.calls.at(-1).url, '/api/catalog/update/choices/clear');
    assert.deepEqual(r.calls.at(-1).body, { base_revision: 'latest-r2', ...(action === 'clear-all' ? { all: true } : { keys: [memory.key] }) });
    assert.equal(r.button('apply').disabled, true); assert.equal(r.reloads, 0);
  }
});

test('failed memory clear preserves policies and revision, without pretending success', async () => {
  const r = runtime(status('preview', { remembered_choices: [memory] }), { handle: name => name === 'clear' ? { ok: false, status: 409, json: async () => ({ ok: false, error: '旧版本，未提交' }) } : undefined }); await r.ready;
  r.button('clear-choice').click(); await tick(); assert.match(r.host.textContent, /旧版本，未提交/); assert.match(r.host.textContent, /保留本地/); assert.equal(r.button('apply').disabled, true);
});

test('check progress -> candidate and review -> explicit apply -> no auto reload', async () => {
  const r = runtime(); await r.ready; r.button('check').click(); r.button('check').click(); await tick();
  assert.equal(r.calls.filter(c => c.url.endsWith('/check')).length, 1); assert.match(r.host.textContent, /2 \/ 10/);
  r.server = status('preview', { candidates: [candidate], issues: [review] }); await r.advance(100);
  select(r, 'source'); assert.equal(r.button('apply').disabled, true);
  const checkbox = r.find(n => n.type === 'checkbox'); checkbox.checked = true; checkbox.emit('change'); assert.equal(r.button('apply').disabled, false);
  r.button('apply').click(); await tick(); assert.equal(r.calls.at(-1).body.acknowledge_reviews, true);
  r.server = status('applied', { current_revision: 'new-r2' }); await r.advance(100); assert.equal(r.reloads, 0); assert.equal(r.timers.size, 0);
  assert.match(r.host.textContent, /当前页面仍使用原已载入资料/);
});

test('blocking, stale task/revision, refusal and changed review cannot be bypassed by a radio', async () => {
  for (const extra of [{ issues: [{ ...review, severity: 'blocking' }] }, { can_apply: false }, { current_revision: 'changed' }, { task_id: '' }, { base_revision: '' }]) {
    const r = runtime(status('preview', { candidates: [candidate], ...extra })); await r.ready;
    select(r, 'source'); const checkbox = r.find(n => n.type === 'checkbox'); checkbox.checked = true; checkbox.emit('change');
    r.button('apply').click(); assert.equal(r.button('apply').disabled, true); assert.equal(r.calls.length, 1);
  }
  const r = runtime(status('preview', { candidates: [candidate], issues: [review] })); await r.ready; select(r, 'source');
  const checkbox = r.find(n => n.type === 'checkbox'); checkbox.checked = true; checkbox.emit('change');
  r.server = status('preview', { candidates: [candidate], issues: [review, { ...review, id: 4 }] }); await r.updater.mount(r.host);
  assert.equal(r.button('apply').disabled, true); assert.equal(r.find(n => n.type === 'checkbox').checked, false);
});

test('HTTP, malformed JSON/state/candidates, duplicates and transport loss are explicit failures', async () => {
  const bad = [
    { ok: false, status: 409, json: async () => ({ ok: false, error: '<script>stale</script>' }) },
    { ok: true, json: async () => { throw Error('bad json'); } },
    { ok: true, json: async () => ({ ok: true, state: 'fake-success' }) },
    { ok: true, json: async () => status('preview', { candidates: [candidate, candidate] }) },
    { ok: true, json: async () => status('preview', { candidates: [{ ...candidate, source_available: 'yes' }] }) }
  ];
  for (const response of bad) {
    let fail = false;
    const r = runtime(status('preview', { candidates: [candidate] }), { handle: () => fail ? response : undefined }); await r.ready; select(r, 'source');
    fail = true; await r.updater.mount(r.host); assert.equal(r.button('apply').disabled, true); assert.equal(r.button('check').textContent, '重试检查');
    fail = false; r.button('check').click(); r.button('check').click(); await tick(); assert.equal(r.button('apply').disabled, false);
    assert.equal(r.calls.at(-1).url, '/api/catalog/update/status'); assert.equal(r.calls.length, 3);
    assert.equal(r.button('check').textContent, '检查官方更新'); assert.equal(r.button('status'), undefined);
  }
});

test('check retry recovers an uncertain apply through status without resubmitting writes', async () => {
  for (const outcome of ['applying', 'applied']) {
    const r = runtime(status('preview', { candidates: [candidate], source_baseline_active: true }), { handle: action => {
      if (action === 'apply') throw Error('response lost after server accepted apply');
    } }); await r.ready; select(r, 'source'); r.button('apply').click(); await tick();
    assert.equal(r.button('check').disabled, false); assert.equal(r.button('apply').disabled, true);
    r.server = status(outcome); r.button('check').click(); await tick();
    assert.equal(r.calls.at(-1).url, '/api/catalog/update/status');
    assert.equal(r.calls.filter(call => call.init.method === 'POST').length, 1);
    assert.equal(r.calls.some(call => /\/(?:check|cancel)$/.test(call.url)), false);
    if (outcome === 'applying') { r.server = status('applied'); await r.advance(100); }
    assert.match(r.host.textContent, /应用完成/); assert.equal(r.timers.size, 0); assert.equal(r.reloads, 0); r.updater.unmount();
  }
});

test('automatic active polling recovers transport errors with no status button', async () => {
  let fail = false;
  const r = runtime(status('checking'), { handle: action => { if (fail && action === 'status') throw Error('temporary connection failure'); } }); await r.ready;
  fail = true; await r.advance(100); assert.match(r.host.textContent, /temporary connection failure/);
  assert.equal(r.button('check').disabled, false); assert.equal(r.button('check').textContent, '重试检查'); assert.equal(r.timers.size, 1);
  fail = false; r.server = status('preview', { candidates: [candidate] }); await r.advance(100);
  assert.equal(r.button('check').textContent, '检查官方更新'); assert.equal(r.timers.size, 0);
  select(r, 'source'); assert.equal(r.button('apply').disabled, false);
  assert.ok(r.calls.every(call => call.url.endsWith('/status'))); r.updater.unmount();
});

test('lost check response recovers through check control and terminal server errors can start a new check', async () => {
  let fail = true;
  const r = runtime(status(), { handle: action => { if (fail && action === 'check') throw Error('check response lost'); } }); await r.ready;
  r.button('check').click(); await tick(); assert.equal(r.button('check').disabled, false);
  fail = false; r.server = status('checking'); r.button('check').click(); await tick();
  assert.equal(r.calls.at(-1).url, '/api/catalog/update/status'); assert.equal(r.button('check').disabled, true);
  assert.equal(r.calls.filter(call => call.url.endsWith('/check')).length, 1);
  r.server = status('error', { error: 'source unavailable' }); await r.advance(100);
  assert.match(r.host.textContent, /source unavailable/); assert.equal(r.button('check').disabled, false);
  r.button('check').click(); await tick(); assert.equal(r.calls.filter(call => call.url.endsWith('/check')).length, 2); r.updater.unmount();
});

test('fresh check still requires confirmation before discarding a preview draft', async () => {
  let consent = false;
  const r = runtime(status('preview', { candidates: [candidate] }), { confirm: () => consent }); await r.ready; select(r, 'local');
  r.button('check').click(); await tick(); assert.equal(r.calls.length, 1); assert.equal(radio(r, 'local').checked, true);
  consent = true; r.button('check').click(); await tick(); assert.equal(r.calls.at(-1).url, '/api/catalog/update/check');
  r.server = status('preview', { candidates: [candidate] }); await r.advance(100); assert.equal(radio(r, 'local').checked, false); r.updater.unmount();
});

test('source values and memory keys are inert text, not HTML/paths/executable instructions', async () => {
  const attack = '</pre><img src=x onerror="evil()"><script>evil()</script>';
  const r = runtime(status('preview', { source_url: 'javascript:evil()', candidates: [{ ...candidate, name: attack, local_value: { value: attack }, source_value: attack }], remembered_choices: [{ ...memory, name: attack }], issues: [{ ...review, message: attack }] })); await r.ready;
  assert.ok(r.host.textContent.includes(attack)); assert.ok(r.host.textContent.includes(JSON.stringify({ value: attack }, null, 2)));
  assert.equal(r.all().some(n => ['script', 'img', 'a'].includes(n.tagName)), false);
});

const composite = (field, local, source, extra = {}) => ({ ...candidate, key: 'monster:42:' + field, field, local_value: local, source_value: source, ...extra });
const valueText = (r, key, side) => radio(r, side, key).parentNode.children.find(node => node.tagName === 'pre').textContent;

test('formatted evolution preserves order and resolves local/source names independently without source-ID guessing', async () => {
  const evolution = composite('evolution', { evolution_members: [2, 1], evolves_from_id: 2 }, { evolution_members: [3, 999, 1], evolves_from_id: 1 });
  const identity = composite('identity', { name: '旧名', form: 'default', dex_number: 7 }, { name: '新名', form: 'default', dex_number: 7, source_ref: { provider: 'tencent-compendium', id: '999', identity: 'internal-evidence' } }, { key: 'monster:1:identity', id: 1, name: '旧名' });
  const addition = composite('entity', null, { monster: { id: 3, name: '新成员', form: '上弦的样子' }, learning: { mode: 'own', skills: [] } }, { key: 'monster:new:fixture:entity', id: 3, name: '新成员', kind: 'add' });
  const r = runtime(status('preview', { candidates: [evolution, identity, addition] }));
  const monsters = [{ id: 1, localized: { zh: { name: '旧名' } }, form: 'default' }, { id: 2, localized: { zh: { name: '成员二' } }, form: 'default' }];
  const snapshot = clone(monsters); r.root.RKData = { getMonsters: () => monsters }; await r.ready;
  assert.equal(valueText(r, evolution.key, 'local'), '进化成员：成员二（本地 ID 2）、旧名（本地 ID 1）\n普通前置：成员二（本地 ID 2）');
  assert.equal(valueText(r, evolution.key, 'source'), '进化成员：新成员（上弦的样子）（本地 ID 3）、精灵 ID 999、新名（本地 ID 1）\n普通前置：新名（本地 ID 1）');
  assert.deepEqual(monsters, snapshot); assert.equal(r.calls.length, 1);
  select(r, 'source', evolution.key); r.button('apply').click(); await tick();
  assert.deepEqual(r.calls.at(-1).body.choices, [{ key: evolution.key, choice: 'source' }]); r.updater.unmount();
});

test('formatted leader source and types retain explicit empty, unknown IDs and unavailable-source rules', async () => {
  const leader = composite('leader_form', {}, { leader_of_id: 8, is_leader_form: true });
  const types = composite('type_ids', [1, 77], []);
  const missing = composite('evolution', { evolution_members: [], evolves_from_id: null }, { evolution_members: [8] }, { key: 'monster:43:evolution', id: 43, source_available: false });
  const r = runtime(status('preview', { candidates: [leader, types, missing] }));
  r.root.RKData = { getMonsters: () => [{ id: 8, name: '普通来源', form: 'default' }], getTypes: () => [{ id: 1, name: 'Normal', localized: { zh: '普通' } }] }; await r.ready;
  assert.equal(valueText(r, leader.key, 'local'), '普通来源：无\n是否首领：否');
  assert.equal(valueText(r, leader.key, 'source'), '普通来源：普通来源（本地 ID 8）\n是否首领：是');
  assert.equal(valueText(r, types.key, 'local'), '属性：普通（ID 1）、属性 ID 77');
  assert.equal(valueText(r, types.key, 'source'), '属性：无（空列表）'); assert.equal(radio(r, 'source', types.key).disabled, false);
  assert.equal(valueText(r, missing.key, 'local'), '进化成员：无（空列表）\n普通前置：无');
  assert.match(valueText(r, missing.key, 'source'), /未提供可用源值/); assert.equal(radio(r, 'source', missing.key).disabled, true);
});

test('formatted learning keeps every skill and source in order, including new and unresolved skill IDs', async () => {
  const skills = Array.from({ length: 73 }, (_, index) => ({ skill_id: index % 3 === 0 ? 3 : index % 3 === 1 ? 4 : 999, source: '来源' + index }));
  const learning = composite('learning', { mode: 'inherit', from_id: 8, skills: [] }, { mode: 'own', skills });
  const newSkill = composite('entity', null, { skill: { id: 4, name: '新技能' } }, { key: 'skill:new:fixture:entity', id: 4, entity: 'skill', kind: 'add' });
  const r = runtime(status('preview', { candidates: [learning, newSkill] }));
  r.root.RKData = { getMonsters: () => [{ id: 8, name: '继承对象' }], getMoves: () => [{ id: 3, localized: { zh: { name: '冲撞' } } }] }; await r.ready;
  assert.equal(valueText(r, learning.key, 'local'), '学习模式：继承\n继承目标：继承对象（本地 ID 8）\n技能：无（空列表）');
  const opener = r.find(n => n.dataset.action === 'details' && n.dataset.key === learning.key && n.dataset.side === 'source');
  assert.ok(opener); assert.doesNotMatch(r.host.textContent, /来源72/); opener.click();
  const modal = r.find(n => n.tagName === 'dialog'); assert.ok(modal?.open);
  const content = descendants(modal).find(n => n.tagName === 'pre').textContent;
  assert.match(content, /^学习模式：独立学习\n继承目标：无\n技能：\n1\. 冲撞（ID 3） · 来源：来源0\n2\. 新技能（ID 4） · 来源：来源1\n3\. 技能 ID 999 · 来源：来源2/);
  assert.equal(content.split('\n').length, 76); assert.ok(content.endsWith('73. 冲撞（ID 3） · 来源：来源72'));
});

test('formatted identity foregrounds human fields while preserving all raw evidence as inert secondary text', async () => {
  const attack = '<img src=x onerror="evil()">';
  const source = { name: attack, form: '下弦的样子', dex_number: 238, form_category: '变异形态', main_form_id: 7, aliases: ['历史甲', '历史乙'], source_ref: { provider: 'tencent-compendium', id: '382', identity: 'internal-identity-hash' }, extensions: { future: { important: attack } } };
  const identity = composite('identity', { name: '旧名', form: 'default', dex_number: 238, aliases: [] }, source);
  const r = runtime(status('preview', { candidates: [identity] })); await r.ready;
  const primary = valueText(r, identity.key, 'source');
  for (const line of ['正式名：' + attack, '形态：下弦的样子', '图鉴编号：238', '形态类别：变异形态', '主形态：精灵 ID 7', '别名：历史甲、历史乙', '来源：腾讯图鉴（来源 ID 382）']) assert.ok(primary.includes(line));
  assert.doesNotMatch(primary, /source_ref|internal-identity-hash|extensions/);
  const cell = radio(r, 'source', identity.key).parentNode.parentNode;
  const details = descendants(cell).find(node => node.dataset.action === 'details'); assert.ok(details); details.click();
  const modal = r.find(n => n.tagName === 'dialog');
  assert.ok(modal.textContent.includes(JSON.stringify(source, null, 2))); assert.equal(radio(r, 'source', identity.key).checked, false);
  assert.equal(r.all().some(node => ['img', 'script', 'a'].includes(node.tagName)), false); assert.equal(r.calls.length, 1);
});

test('formatter needs no RKData, accepts flat new skill candidates and falls back losslessly for unknown shapes', async () => {
  const learning = composite('learning', { mode: 'own', skills: [] }, { mode: 'inherit', from_id: 700, skills: [{ skill_id: 11, source: '传说' }, { skill_id: 12, source: '默认' }] });
  const newSkill = composite('entity', null, { id: 11, name: '新增主技能' }, { key: 'skill:new:flat:entity', id: 11, entity: 'skill', kind: 'add' });
  const unknown = composite('evolution', { future_members: ['must', 'remain'] }, { future_members: ['new'] }, { key: 'monster:43:evolution', id: 43 });
  const r = runtime(status('preview', { candidates: [learning, newSkill, unknown] })); await r.ready;
  assert.equal(r.root.RKData, undefined);
  assert.match(valueText(r, learning.key, 'source'), /继承目标：精灵 ID 700/);
  assert.match(valueText(r, learning.key, 'source'), /新增主技能（ID 11） · 来源：传说\n2\. 技能 ID 12 · 来源：默认/);
  assert.equal(valueText(r, unknown.key, 'local'), JSON.stringify(unknown.local_value, null, 2));
});

test('stale loaded catalog names are not presented as names of the current preview snapshot', async () => {
  const evolution = composite('evolution', { evolution_members: [9] }, { evolution_members: [9, 10] });
  const addition = composite('entity', null, { monster: { id: 10, name: '本次明确新增' } }, { key: 'monster:new:fresh:entity', id: 10, entity: 'monster', kind: 'add' });
  const r = runtime(status('preview', { candidates: [evolution, addition] }));
  r.root.RKData = { getCatalogRevision: () => 'older-loaded-revision', getMonsters: () => [{ id: 9, name: '已过期名称' }] }; await r.ready;
  assert.equal(valueText(r, evolution.key, 'local'), '进化成员：精灵 ID 9\n普通前置：无');
  assert.match(valueText(r, evolution.key, 'source'), /本次明确新增（本地 ID 10）/); assert.doesNotMatch(r.host.textContent, /已过期名称/);
});

test('browser lexical RKData is available even when it is not a window property', async () => {
  const evolution = composite('evolution', { evolution_members: [] }, { evolution_members: [9] });
  const r = runtime(status('preview', { candidates: [evolution] })); await r.ready; r.updater.unmount();
  const context = vm.createContext({ globalThis: r.root });
  vm.runInContext('const RKData = { getMonsters: () => [{id:9, localized:{zh:{name:"全局词法名字"}}}] };', context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/catalog-updater.js'), 'utf8'), context);
  await r.root.CatalogUpdater.mount(r.host);
  assert.equal(r.root.RKData, undefined); assert.match(valueText(r, evolution.key, 'source'), /全局词法名字（本地 ID 9）/); r.root.CatalogUpdater.unmount();
});

test('removed controls and description paragraphs do not exist in any task state', async () => {
  const labels = ['刷新任务状态', '取消本次任务', '批量选择本地', '取消本次选择', '批量选择可用源'];
  const descriptions = ['尚未选择；未选项保持本地且不会记忆。', '重新载入前等待其他页面保存。', '默认只确认本次来源变化；勾选“以后也采用此侧”才记住长期策略。未选项不处理，检查不会改写资料。', '固定官方来源：'];
  for (const state of ['idle', 'checking', 'preview', 'applying', 'applied', 'cancelled', 'error']) {
    const r = runtime(status(state, { source_baseline_active: true, candidates: [candidate] })); await r.ready;
    for (const action of ['status', 'cancel', 'select-local', 'reset-choices', 'select-source']) assert.equal(r.button(action), undefined);
    for (const text of [...labels, ...descriptions]) assert.equal(r.host.textContent.includes(text), false);
    assert.equal(r.find(n => n.className === 'cu-source'), undefined);
    assert.equal(r.all().filter(n => n.className === 'cu-actions').length, 1, 'no empty batch toolbar');
    for (const action of ['check', 'apply', 'reload']) assert.ok(visible(r.button(action)));
    r.updater.unmount();
  }
  const code = fs.readFileSync(path.join(__dirname, '../js/catalog-updater.js'), 'utf8');
  for (const text of [...labels, ...descriptions, 'statusBtn', 'cancelBtn', 'sourceBtn', 'localBtn', 'resetBtn', 'chooseAll', 'clearDraft']) assert.equal(code.includes(text), false);
  assert.doesNotMatch(code, /function cancel\(/); assert.doesNotMatch(css, /\.cu-source\b/);
});

test('unmount only cleans observation; remount discovers task and never duplicates polling', async () => {
  const r = runtime(status('checking')); await r.ready; assert.equal(r.timers.size, 1);
  r.updater.unmount(); assert.equal(r.timers.size, 0); await r.advance(500);
  assert.equal(r.calls.length, 1); assert.equal(r.calls.some(call => call.url.endsWith('/cancel')), false);
  r.server = status('preview'); await r.updater.mount(r.host); assert.equal(r.calls.length, 2); assert.equal(r.timers.size, 0);
  r.server = status('checking'); await r.updater.mount(r.host); await r.updater.mount(r.host); assert.equal(r.timers.size, 1); r.updater.unmount();
});

test('returning during an old in-flight response re-queries after it completes', async () => {
  let release, once = true;
  const r = runtime(status('preview'), { handle: action => {
    if (action === 'status' && once) { once = false; return new Promise(resolve => { release = resolve; }); }
  } }); await tick();
  r.updater.unmount(); const remount = r.updater.mount(r.host);
  release({ ok: true, json: async () => status('checking') }); await remount;
  assert.equal(r.calls.filter(call => call.url.endsWith('/status')).length, 2);
  assert.match(r.host.textContent, /差异预览/); assert.equal(r.timers.size, 0);
});

test('a request finishing off-page never restarts the UI polling timer', async () => {
  let release;
  const r = runtime(status('checking'), { handle: () => new Promise(resolve => { release = resolve; }) }); await tick();
  r.updater.unmount(); release({ ok: true, json: async () => status('checking') }); await r.ready; assert.equal(r.timers.size, 0);
});

test('close flush cancels checking and waits for applying without a cancel or auto reload', async () => {
  const checking = runtime(status('checking')); await checking.ready; checking.updater.unmount();
  assert.equal(await checking.updater.flush(), true);
  assert.equal(checking.calls.at(-1).url, '/api/catalog/update/cancel'); assert.equal(checking.timers.size, 0);
  const applying = runtime(status('applying')); await applying.ready; applying.updater.unmount();
  const flush = applying.updater.flush(); await tick();
  applying.server = status('applied'); await applying.advance(100);
  assert.equal(await flush, true); assert.equal(applying.calls.some(call => call.url.endsWith('/cancel')), false);
  assert.equal(applying.reloads, 0); assert.equal(applying.timers.size, 0);
});

test('close flush is bounded on applying and reports false on query/cancel errors', async () => {
  const r = runtime(status('applying'), {}, { flushTimeoutMs: 250 }); await r.ready; r.updater.unmount();
  const flush = r.updater.flush(); await tick(); await r.advance(250);
  assert.equal(await flush, false); assert.equal(r.timers.size, 0);
  for (const failAction of ['status', 'cancel']) {
    let fail = false;
    const x = runtime(status('checking'), { handle: action => fail && action === failAction ? { ok: false, json: async () => ({ ok: false, error: 'fixture error' }) } : undefined });
    await x.ready; x.updater.unmount(); fail = true; assert.equal(await x.updater.flush(), false); assert.equal(x.timers.size, 0);
  }
});

test('reload waits for both successful flushes and confirmation; never reloads on save failure or cancel', async () => {
  for (const failure of ['user', 'battle', 'reject', 'missing', 'cancel']) {
    const r = runtime(status('applied'), {
      userFlush: () => failure === 'reject' ? Promise.reject(Error('fixture save rejected')) : Promise.resolve(failure !== 'user'),
      battleFlush: () => Promise.resolve(failure !== 'battle'), confirm: () => failure !== 'cancel'
    }); await r.ready;
    if (failure === 'missing') delete r.root.UserConfig;
    assert.equal(await r.updater.reload(), false); assert.equal(r.reloads, 0);
    assert.equal(r.calls.some(call => call.init.method === 'POST'), false);
  }
  let userDone, battleDone;
  const r = runtime(status('applied'), { userFlush: () => new Promise(resolve => { userDone = resolve; }), battleFlush: () => new Promise(resolve => { battleDone = resolve; }) }); await r.ready;
  const reload = r.updater.reload(); await tick(); assert.equal(r.reloads, 0); assert.equal(r.confirms.length, 0);
  userDone(true); await tick(); assert.equal(r.reloads, 0); battleDone(true); assert.equal(await reload, true);
  assert.equal(r.reloads, 1); assert.match(r.confirms[0], /丢弃尚未提交的手工表单草稿/); assert.equal(r.timers.size, 0);
});

test('reload cannot interrupt a remote active task and hung save wait is bounded', async () => {
  const r = runtime(status('checking')); await r.ready; assert.equal(await r.updater.reload(), false); assert.equal(r.reloads, 0); r.updater.unmount();
  const x = runtime(status('applied'), { userFlush: () => new Promise(() => {}) }, { flushTimeoutMs: 250 }); await x.ready;
  const reload = x.updater.reload(); await tick(); await x.advance(250); assert.equal(await reload, false); assert.equal(x.reloads, 0); assert.equal(x.timers.size, 0);
});

test('request timeout is visible and retryable, without assuming a cancelled server write', async () => {
  const r = runtime(status(), { handle: () => new Promise(() => {}) }, { requestTimeoutMs: 50 }); await tick(); await r.advance(50); await r.ready;
  assert.match(r.host.textContent, /尚不能确认服务端结果/); assert.equal(r.button('check').disabled, false); assert.equal(r.button('check').textContent, '重试检查'); assert.equal(r.calls[0].init.signal.aborted, true); assert.equal(r.timers.size, 0);
});

const pageSource = fs.readFileSync(path.join(__dirname, '../js/pages/updatedata.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../css/catalog-updater.css'), 'utf8');
const editorMarker = "document.getElementById('ud-save-btn').addEventListener('click', async () => {";
function callback(marker, endMarker) {
  const start = pageSource.indexOf(marker); const end = pageSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start); return pageSource.slice(start, end);
}
async function manualSave(kind, revision, response = { ok: true }) {
  const requests = [], elements = new Map(); let click;
  const result = { innerHTML: '', textContent: '' };
  const context = {
    document: { getElementById(id) {
      if (id.endsWith('-result')) return result;
      if (['ud-save-btn', 'ud-addpet-save', 'ud-addmove-save'].includes(id)) return { addEventListener: (_, fn) => { click = fn; } };
      if (!elements.has(id)) elements.set(id, { value: id.endsWith('-name') ? 'fixture' : '0' }); return elements.get(id);
    } }, window: { confirm: () => true }, m: { id: 42 }, editorTypeSel: new Set(['Normal']), editorSkillList: [], originalSkillList: '[]', skillsLoaded: false,
    readEditorLevelSettings: () => ({ enabled: false, default: 60, min: 1, max: 99, step: 1 }), initialLevels: { enabled: false, default: 60, min: 1, max: 99, step: 1 },
    editorFormCategory: '无多形态', editorEvolvesFromID: null, originalPredecessor: null, editorLeaderOfID: null, originalLeaderBase: null, addPetTypeSel: new Set(), addPetFormCategory: '无多形态', addPetMainFormName: '', addPetEvolvesFromID: null, addPetSkillList: [], addMoveTypeSel: new Set(), addMoveCatValue: '物攻', getEvoValue: () => '基础形态',
    fetch: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return { ok: response.ok, json: async () => response }; }
  };
  if (revision !== undefined) context.RKData = { getCatalogRevision: () => revision };
  const code = kind === 'editor' ? callback(editorMarker, '\n\n    // 重置') : kind === 'pet' ? callback("document.getElementById('ud-addpet-save').addEventListener('click', async () => {", '\n  }\n\n  // ─── Tab 4') : callback("saveBtn.addEventListener('click', async () => {", '\n  }\n\n  function onLeave');
  if (kind === 'move') context.saveBtn = { addEventListener: (_, fn) => { click = fn; } };
  vm.runInNewContext(code, context); await click(); return { requests, result };
}

test('all existing manual save/add APIs send loaded base_revision, static legacy fixtures can omit it', async () => {
  for (const kind of ['editor', 'pet', 'move']) {
    const r = await manualSave(kind, 'loaded-r1'); assert.equal(r.requests[0].body.base_revision, 'loaded-r1');
    const empty = await manualSave(kind, null); assert.equal(empty.requests[0].body.base_revision, null);
    const legacy = await manualSave(kind); assert.equal(Object.hasOwn(legacy.requests[0].body, 'base_revision'), false);
    assert.match(r.result.textContent, /重新载入资料/);
    if (kind === 'editor') {
      for (const field of ['skillList', 'evolves_from_id', 'leader_of_id', 'evolution_members']) assert.equal(Object.hasOwn(r.requests[0].body, field), false);
    }
  }
});

test('manual conflicts render server errors as text and do not claim saved or refresh', async () => {
  for (const kind of ['editor', 'pet', 'move']) {
    const r = await manualSave(kind, 'old', { ok: false, error: '<img onerror=evil()> stale revision' });
    assert.match(r.result.textContent, /<img onerror=evil\(\)> stale revision/); assert.match(r.result.textContent, /重新载入后再编辑/);
    assert.doesNotMatch(r.result.innerHTML, /onerror|保存成功|添加成功/);
  }
});

test('browser scripts parse and expose the integration interfaces without starting requests', () => {
  const root = { fetch() { throw Error('No request before mount'); } };
  const context = vm.createContext({ window: root, globalThis: root });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/catalog-updater.js'), 'utf8'), context);
  vm.runInContext(pageSource, context);
  assert.equal(typeof root.CatalogUpdater.mount, 'function'); assert.equal(typeof root.CatalogUpdater.flush, 'function');
  assert.equal(vm.runInContext('typeof UpdateDataPage.onLeave', context), 'function');
});

test('page keeps all manual tabs, cleans observer, removes misleading overwrite copy and scopes layout', () => {
  for (const tab of ['home', 'editor', 'addPet', 'addMove']) assert.ok(pageSource.includes(`data-tab="${tab}"`));
  assert.match(pageSource, /function onLeave\(\) \{ window\.CatalogUpdater\?\.unmount\(\)/);
  assert.match(pageSource, /return \{ render, onLeave \}/);
  assert.doesNotMatch(pageSource, /前往 GitHub 下载|覆盖本地 <code>data\/|GITHUB_URL|离线更新工具/);
  assert.match(pageSource, /#ud-tab-content \.input-row/); assert.match(pageSource, /#ud-tab-content \.input-group/);
  assert.doesNotMatch(pageSource, /\.calc-root \.input-(?:row|group)\s*\{/);
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].flatMap(match => match[1].trim().split(',').map(s => s.trim()));
  assert.ok(selectors.every(selector => selector.startsWith('#ud-page ') || selector.startsWith('#ud-tab-content ')));
  assert.match(pageSource, /value="\$\{escapeText\(val/);
});

const rememberToggle = (r, key = candidate.key) => r.find(n => n.dataset.rememberKey === key);
test('shipped baseline defaults local and source decisions to revision acknowledgements only', async () => {
  for (const side of ['local', 'source']) {
    const r = runtime(status('preview', { source_baseline_active: true, candidates: [candidate] })); await r.ready;
    assert.equal(visible(r.find(n => n.className === 'cu-notice')), false); assert.equal(rememberToggle(r).checked, false); assert.equal(rememberToggle(r).disabled, true);
    select(r, side); assert.equal(rememberToggle(r).disabled, false); r.button('apply').click(); await tick();
    assert.deepEqual(r.calls.at(-1).body.choices, [{ key: candidate.key, choice: side, acknowledge_only: true }]); r.updater.unmount();
  }
});
test('permanent preference is explicit per-row and does not affect unselected or other rows', async () => {
  const other = { ...candidate, key: 'monster:43:stats.hp', id: 43 };
  const r = runtime(status('preview', { source_baseline_active: true, candidates: [candidate, other] })); await r.ready;
  select(r, 'local'); rememberToggle(r).checked = true; rememberToggle(r).emit('change'); select(r, 'source', other.key);
  await r.updater.mount(r.host); assert.equal(rememberToggle(r).checked, true); assert.equal(rememberToggle(r, other.key).checked, false);
  r.button('apply').click(); await tick(); assert.deepEqual(r.calls.at(-1).body.choices, [{ key: candidate.key, choice: 'local', acknowledge_only: false }, { key: other.key, choice: 'source', acknowledge_only: true }]); r.updater.unmount();
});
test('row undo and new task clear permanent draft; reselected rows default to revision-only', async () => {
  const other = { ...candidate, key: 'monster:43:stats.hp', id: 43 };
  const r = runtime(status('preview', { source_baseline_active: true, candidates: [candidate, other] })); await r.ready;
  select(r, 'local', other.key); rememberToggle(r, other.key).checked = true; rememberToggle(r, other.key).emit('change');
  select(r, 'source'); rememberToggle(r).checked = true; rememberToggle(r).emit('change'); select(r, 'source');
  assert.equal(rememberToggle(r).checked, false); assert.equal(rememberToggle(r).disabled, true);
  assert.equal(rememberToggle(r, other.key).checked, true); assert.equal(radio(r, 'local', other.key).checked, true);
  select(r, 'local'); assert.equal(rememberToggle(r).checked, false);
  rememberToggle(r).checked = true; rememberToggle(r).emit('change'); r.server = status('preview', { source_baseline_active: true, task_id: 'second', candidates: [candidate] }); await r.updater.mount(r.host);
  assert.equal(rememberToggle(r).checked, false); assert.equal(radio(r, 'local').checked, false);
  select(r, 'source'); r.button('apply').click(); await tick(); assert.equal(r.calls.at(-1).body.choices[0].acknowledge_only, true); r.updater.unmount();
});
test('protected source revision displays inert evidence without enabling source override', async () => {
  const item = { ...candidate, kind: 'source_review', source_available: false, source_value: null, source_revision: { available: true, value: '<unsafe>95' } };
  const r = runtime(status('preview', { source_baseline_active: true, candidates: [item] })); await r.ready;
  assert.equal(radio(r, 'source').disabled, true); assert.match(r.host.textContent, /涉及受保护规则/);
  const details = r.find(n => n.tagName === 'details' && n.textContent === '本次来源证据'); assert.ok(details); openDetails(details); assert.match(details.textContent, /<unsafe>95/);
  assert.equal(r.all().some(n => n.tagName === 'unsafe'), false); select(r, 'local'); r.button('apply').click(); await tick(); assert.equal(r.calls.at(-1).body.choices[0].acknowledge_only, true); r.updater.unmount();
});
test('invalid baseline flag is rejected instead of silently selecting legacy permanent policies', async () => {
  const r = runtime(status('preview', { source_baseline_active: 'yes', candidates: [candidate] })); await r.ready;
  assert.match(r.host.textContent, /来源基线状态异常/); assert.equal(r.button('apply').disabled, true);
});

const candidatePanel = r => r.find(n => n.className === 'cu-panel' && n.textContent.startsWith('差异候选'));
const pageCandidates = (r, action) => descendants(candidatePanel(r)).find(n => n.dataset.action === action).click();
const filterCandidates = (r, entity) => { const filter = r.find(n => n.attrs['aria-label'] === '差异分类'); filter.value = entity; filter.emit('change'); };
const remember = (r, key = candidate.key) => { const input = rememberToggle(r, key); input.checked = true; input.emit('change'); };
const detailsButton = (r, key = candidate.key, side = 'source', heading) => r.find(n => n.dataset.action === 'details' && n.dataset.key === key && n.dataset.side === side && (!heading || n.dataset.heading === heading));
const modal = r => r.find(n => n.tagName === 'dialog');
const batchItems = () => Array.from({ length: 67 }, (_, id) => ({ ...candidate, id, entity: id % 2 ? 'skill' : 'monster', key: 'fixture:' + id, source_available: ![5, 32, 66].includes(id) }));
const applyBody = choices => ({ task_id: 'fixture-task', base_revision: 'loaded-r1', acknowledge_reviews: false, choices });

test('primary actions share exactly one row, bulk actions another, without obsolete copy or layout', async () => {
  for (const mode of ['idle', 'checking', 'preview', 'applying', 'applied', 'cancelled', 'error']) {
    const r = runtime(status(mode, { source_baseline_active: true, candidates: [candidate], automatic_source_changes: 7 })); await r.ready;
    const main = r.button('check').parentNode, bulk = r.button('select-all').parentNode;
    assert.equal(main, r.button('apply').parentNode); assert.equal(main, r.button('reload').parentNode);
    assert.deepEqual(main.children.map(n => n.textContent), ['检查官方更新', '确认并应用', '重新载入资料']);
    assert.notEqual(main, bulk); assert.deepEqual(bulk.children.map(n => n.textContent), ['全选', '反选', '取消选择', '记忆已选项']);
    assert.equal(bulk.attrs['aria-label'], '全部候选项（跨分类与分页）');
    if (mode === 'preview') {
      select(r, 'source'); assert.equal(rememberToggle(r).attrs['aria-label'], '精灵 · 42 · 精灵 · 生命 · 记忆此项');
    }
    assert.doesNotMatch(r.host.textContent, /请先检查官方更新|待选 \d|本次已选|本次选择 \d|已记忆来源待应用|以后也采用此侧/);
    assert.ok(r.all().every(n => !String(n.attrs['aria-label'] || '').includes('以后也采用此侧')));
    assert.equal(r.find(n => n.className === 'cu-summary'), undefined);
    r.updater.unmount();
  }
  const code = fs.readFileSync(path.join(__dirname, '../js/catalog-updater.js'), 'utf8');
  for (const removed of ['cu-summary', 'cu-reload-area', 'cu-confirm-actions', 'reloadArea', 'summary.textContent']) {
    assert.equal(code.includes(removed), false); assert.equal(css.includes(removed), false);
  }
  assert.match(css, /\.cu-actions\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
});

test('global all crosses pages and filters, preserves same-side memory and valid unavailable-source local choices', async () => {
  const items = batchItems(); items[4].source_value = []; // Explicit empty is valid.
  const r = runtime(status('preview', { source_baseline_active: true, candidates: items, remembered_choices: [memory] })); await r.ready;
  select(r, 'source', items[0].key); remember(r, items[0].key);
  select(r, 'local', items[1].key); remember(r, items[1].key);
  select(r, 'local', items[5].key); remember(r, items[5].key);
  filterCandidates(r, 'skill'); pageCandidates(r, 'next');
  r.button('select-all').click(); r.button('select-all').click();
  assert.equal(r.calls.length, 1); assert.equal(r.confirms.length, 0);
  assert.equal(radio(r, 'source', items[61].key).checked, true);
  filterCandidates(r, '');
  assert.equal(rememberToggle(r, items[0].key).checked, true, 'unchanged explicit source retains its memory');
  assert.equal(rememberToggle(r, items[1].key).checked, false, 'local-to-source bulk replacement cannot inherit memory');
  assert.equal(rememberToggle(r, items[4].key).checked, false, 'new explicit-empty selection remains one-time');
  assert.equal(radio(r, 'local', items[5].key).checked, true); assert.equal(rememberToggle(r, items[5].key).checked, true);
  const expected = new Map([[items[0].key, { key: items[0].key, choice: 'source', acknowledge_only: false }], [items[1].key, { key: items[1].key, choice: 'source', acknowledge_only: true }], [items[5].key, { key: items[5].key, choice: 'local', acknowledge_only: false }]]);
  for (const item of items) if (item.source_available && !expected.has(item.key)) expected.set(item.key, { key: item.key, choice: 'source', acknowledge_only: true });
  r.button('apply').click(); await tick();
  assert.deepEqual(r.calls.at(-1).body, applyBody([...expected.values()]));
  assert.equal(r.calls.filter(c => c.init.method === 'POST').length, 1); assert.equal(r.reloads, 0); r.updater.unmount();
});

test('global inversion clears selected source and local instead of swapping sides, and selects only available unselected rows', async () => {
  const items = batchItems(), r = runtime(status('preview', { source_baseline_active: true, candidates: items })); await r.ready;
  for (const [index, side] of [[0, 'source'], [1, 'local'], [5, 'local']]) { select(r, side, items[index].key); remember(r, items[index].key); }
  filterCandidates(r, 'skill'); pageCandidates(r, 'next'); r.button('invert-selection').click(); filterCandidates(r, '');
  for (const index of [0, 1, 5]) {
    assert.equal(radio(r, 'local', items[index].key).checked, false); assert.equal(radio(r, 'source', items[index].key).checked, false);
    assert.equal(rememberToggle(r, items[index].key).checked, false); assert.equal(rememberToggle(r, items[index].key).disabled, true);
  }
  assert.equal(r.calls.length, 1); assert.equal(radio(r, 'source', items[2].key).checked, true); assert.equal(rememberToggle(r, items[2].key).checked, false);
  r.button('apply').click(); await tick();
  assert.deepEqual(r.calls.at(-1).body, applyBody(items.filter(i => i.source_available && ![0, 1, 5].includes(i.id)).map(i => ({ key: i.key, choice: 'source', acknowledge_only: true }))));
  r.updater.unmount();
});

test('cancel selection clears only drafts, never saved policies or automatic source changes', async () => {
  const items = batchItems(), r = runtime(status('preview', { source_baseline_active: true, candidates: items, remembered_choices: [memory], automatic_source_changes: 1 })); await r.ready;
  r.button('select-all').click(); r.button('remember-selected').click();
  filterCandidates(r, 'skill'); pageCandidates(r, 'next'); r.button('clear-selection').click();
  assert.equal(r.calls.length, 1); assert.match(r.find(n => n.className === 'cu-memories').textContent, /保留本地/);
  assert.equal(r.all().some(n => n.type === 'radio' && n.checked), false);
  assert.equal(r.all().some(n => n.dataset.rememberKey && n.checked), false);
  assert.equal(r.button('clear-selection').disabled, true); assert.equal(r.button('remember-selected').disabled, true);
  assert.equal(r.button('apply').disabled, false, 'saved source changes still require explicit application');
  filterCandidates(r, ''); select(r, 'local', items[0].key);
  assert.equal(rememberToggle(r, items[0].key).checked, false);
  r.button('apply').click(); await tick();
  assert.deepEqual(r.calls.at(-1).body, applyBody([{ key: items[0].key, choice: 'local', acknowledge_only: true }]));
  assert.equal(r.calls.some(c => c.url.includes('choices/clear')), false); r.updater.unmount();
});

test('remember selected marks only current valid local/source drafts across pages and filters and sends full acknowledgement payload', async () => {
  const items = batchItems(), r = runtime(status('preview', { source_baseline_active: true, candidates: items })); await r.ready;
  select(r, 'local', items[0].key); select(r, 'source', items[1].key); select(r, 'local', items[5].key);
  pageCandidates(r, 'next'); select(r, 'local', items[35].key);
  pageCandidates(r, 'next'); select(r, 'source', items[63].key);
  filterCandidates(r, 'monster'); r.button('remember-selected').click(); r.button('remember-selected').click();
  assert.equal(r.calls.length, 1); assert.equal(r.confirms.length, 0);
  assert.equal(rememberToggle(r, items[0].key).checked, true); assert.equal(rememberToggle(r, items[2].key).checked, false); assert.equal(rememberToggle(r, items[2].key).disabled, true);
  filterCandidates(r, ''); assert.equal(rememberToggle(r, items[1].key).checked, true); assert.equal(rememberToggle(r, items[5].key).checked, true);
  r.button('apply').click(); await tick();
  assert.deepEqual(r.calls.at(-1).body, applyBody([[0, 'local'], [1, 'source'], [5, 'local'], [35, 'local'], [63, 'source']].map(([index, choice]) => ({ key: items[index].key, choice, acknowledge_only: false }))));
  assert.equal(r.calls.filter(c => c.init.method === 'POST').length, 1); r.updater.unmount();
});

test('empty or entirely unavailable candidates cannot acquire drafts; explicit null, empty list and empty text remain available', async () => {
  for (const candidates of [[], [{ ...candidate, source_available: false, local_available: false }]]) {
    const r = runtime(status('preview', { source_baseline_active: true, candidates })); await r.ready;
    for (const action of ['select-all', 'invert-selection', 'clear-selection', 'remember-selected']) r.button(action).click();
    assert.equal(r.button('apply').disabled, true); assert.equal(r.button('remember-selected').disabled, true); assert.equal(r.calls.length, 1);
    assert.equal(r.all().some(n => n.type === 'radio' && n.checked), false);
  }
  const items = [null, [], ''].map((value, index) => ({ ...candidate, key: 'empty:' + index, source_value: value }));
  const r = runtime(status('preview', { source_baseline_active: true, candidates: items })); await r.ready;
  r.button('select-all').click(); r.button('apply').click(); await tick();
  assert.deepEqual(r.calls.at(-1).body, applyBody(items.map(i => ({ key: i.key, choice: 'source', acknowledge_only: true })))); r.updater.unmount();
});

test('invalidated selections lose their memory draft, not silently resurrecting it when availability returns', async () => {
  for (const side of ['local', 'source']) {
    const r = runtime(status('preview', { source_baseline_active: true, candidates: [candidate] })); await r.ready;
    select(r, side); r.button('remember-selected').click();
    r.server = status('preview', { source_baseline_active: true, candidates: [{ ...candidate, [side + '_available']: false }] }); await r.updater.mount(r.host);
    assert.equal(radio(r, side).checked, false); assert.equal(rememberToggle(r).checked, false);
    assert.equal(r.button('remember-selected').disabled, true);
    r.server = status('preview', { source_baseline_active: true, candidates: [candidate] }); await r.updater.mount(r.host);
    select(r, side); r.button('apply').click(); await tick();
    assert.deepEqual(r.calls.at(-1).body, applyBody([{ key: candidate.key, choice: side, acknowledge_only: true }])); r.updater.unmount();
  }
});

test('bulk controls remain guarded during stale previews, transport failure, active states and a pending check', async () => {
  for (const value of [status('preview', { current_revision: 'stale' }), status('checking'), status('applying'), status('idle')]) {
    const r = runtime({ ...value, source_baseline_active: true, candidates: [candidate] }); await r.ready;
    for (const action of ['select-all', 'invert-selection', 'clear-selection', 'remember-selected']) { assert.equal(r.button(action).disabled, true); r.button(action).emit('click'); }
    assert.equal(r.button('apply').disabled, true); assert.equal(r.calls.length, 1); r.updater.unmount();
  }
  let release;
  const r = runtime(status('preview', { source_baseline_active: true, candidates: [candidate] }), { handle: action => action === 'check' ? new Promise(resolve => { release = resolve; }) : undefined }); await r.ready;
  select(r, 'local'); r.button('check').click(); await tick();
  for (const action of ['select-all', 'invert-selection', 'clear-selection', 'remember-selected']) { assert.equal(r.button(action).disabled, true); r.button(action).emit('click'); }
  release({ ok: false, status: 500, json: async () => ({ ok: false, error: 'fixture failure' }) }); await tick();
  assert.equal(radio(r, 'local').checked, true); assert.equal(rememberToggle(r).checked, false);
  for (const action of ['select-all', 'invert-selection', 'clear-selection', 'remember-selected']) assert.equal(r.button(action).disabled, true);
  assert.equal(r.calls.filter(c => c.init.method === 'POST').length, 1); r.updater.unmount();
});

test('bulk selection and memory cannot acknowledge reviews or bypass an apply blocker', async () => {
  for (const severity of ['review', 'blocking']) {
    const r = runtime(status('preview', { source_baseline_active: true, candidates: [candidate], issues: [{ ...review, severity }] })); await r.ready;
    r.button('select-all').click(); r.button('remember-selected').click(); r.button('apply').click();
    assert.equal(r.find(n => n.className === 'cu-review').children[0].checked, false);
    assert.equal(r.button('apply').disabled, true); assert.equal(r.calls.length, 1);
    assert.match(r.find(n => n.className === 'cu-apply-reason').textContent, severity === 'review' ? /勾选审阅确认/ : /阻断/);
    r.updater.unmount();
  }
});

const longLearning = () => ({ mode: 'own', skills: Array.from({ length: 73 }, (_, index) => ({ skill_id: 1000 + index, source: '完整来源' + index, extensions: { detail: '完整技能内容' + index } })) });
const longCandidate = () => composite('learning', { mode: 'own', skills: [] }, longLearning());

test('restored3case full added monster/trait/learning and learnset payloads remain complete behind details', async () => {
  for (const learningKey of ['learning', 'learnset']) {
    const attack = '</pre><img src=x onerror="evil()"><script>evil()</script>';
    const items = [408, 409, 410].map(id => ({ ...candidate, key: 'monster:new:fixture-' + id + ':entity', id, name: '恢复测试' + id, field: 'entity', kind: 'add', local_value: null, source_value: {
      monster: { id, name: '恢复测试' + id, form: 'default', type_ids: [3], extensions: { keep: attack } },
      trait: { name: 'fixture特性', description: attack }, [learningKey]: longLearning()
    } }));
    const before = clone(items), r = runtime(status('preview', { source_baseline_active: true, candidates: items }));
    r.root.RKData = { getCatalogRevision: () => 'loaded-r1', getTypes: () => [{ id: 3, localized: { zh: 'fixture属性' } }] }; await r.ready;
    assert.doesNotMatch(r.host.textContent, /完整来源72|完整技能内容72|onerror/);
    for (const item of items) {
      assert.equal(valueText(r, item.key, 'local'), '不新增，保持本地');
      assert.equal(valueText(r, item.key, 'source'), '正式名：恢复测试' + item.id + '\n本地 ID：' + item.id + '\n属性：fixture属性（ID 3）');
      const opener = detailsButton(r, item.key); assert.equal(opener.textContent, '详情'); opener.focus(); opener.click();
      const dialog = modal(r); assert.equal(dialog.modal, true); assert.equal(dialog.attrs['aria-modal'], 'true');
      assert.match(dialog.children[0].textContent, new RegExp('恢复测试' + item.id + '.*源值'));
      assert.equal(descendants(dialog).find(n => n.tagName === 'pre').textContent, JSON.stringify(item.source_value, null, 2));
      assert.ok(dialog.textContent.includes(JSON.stringify(attack).slice(1, -1))); assert.ok(dialog.textContent.includes('完整来源72')); assert.ok(dialog.textContent.includes('完整技能内容72'));
      assert.equal(radio(r, 'source', item.key).checked, false); assert.equal(rememberToggle(r, item.key).checked, false);
      assert.equal(r.calls.length, 1); assert.equal(r.button('apply').disabled, true);
      assert.equal(r.all().some(n => ['script', 'img', 'a'].includes(n.tagName)), false);
      r.button('close-details').click(); assert.equal(modal(r), undefined); assert.equal(r.root.document.activeElement, opener);
    }
    assert.deepEqual(items, before); assert.equal(r.confirms.length, 0); assert.equal(r.reloads, 0); r.updater.unmount();
  }
});

test('long formatted learning modal retains both every friendly skill and unabridged raw extension evidence', async () => {
  const item = longCandidate(), r = runtime(status('preview', { source_baseline_active: true, candidates: [item] }));
  r.root.RKData = { getCatalogRevision: () => 'older-revision', getMoves: () => [{ id: 1000, name: '过期技能名' }] }; await r.ready;
  const opener = detailsButton(r, item.key); opener.click();
  const pres = descendants(modal(r)).filter(n => n.tagName === 'pre');
  assert.equal(pres.length, 2); assert.match(pres[0].textContent, /1\. 技能 ID 1000 · 来源：完整来源0/);
  assert.match(pres[0].textContent, /73\. 技能 ID 1072 · 来源：完整来源72$/);
  assert.equal(pres[1].textContent, JSON.stringify(item.source_value, null, 2)); assert.doesNotMatch(modal(r).textContent, /过期技能名/);
  assert.equal(opener.parentNode.tagName, 'div', 'details cannot activate a surrounding radio label');
  assert.equal(r.calls.length, 1); assert.equal(r.all().some(n => n.type === 'radio' && n.checked), false);
  const event = modal(r).emit('cancel'); assert.equal(event.defaultPrevented, true); assert.equal(modal(r), undefined);
  assert.equal(r.root.document.activeElement, opener); r.updater.unmount();
});

test('long plain, unknown-object and protected evidence are inert untruncated text with no extra request', async () => {
  const attack = '<svg onload="evil()"><a href="javascript:evil()">末尾</a></svg>';
  for (const shape of ['plain', 'unknown', 'protected']) {
    const content = (attack + '\n').repeat(150) + '完整末尾';
    const value = shape === 'plain' ? content : { unknown_future_shape: { value: content, extra: ['never', 'omit'] } };
    const item = { ...candidate, source_value: value, ...(shape === 'protected' ? { kind: 'source_review', source_available: false, source_value: null, source_revision: value } : {}) };
    const r = runtime(status('preview', { source_baseline_active: true, candidates: [item] })); await r.ready;
    assert.doesNotMatch(r.host.textContent, /完整末尾/); detailsButton(r).click();
    const body = descendants(modal(r)).find(n => n.className === 'cu-detail-body');
    assert.equal(body.children[0].textContent, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    assert.equal(body.tabIndex, 0); assert.equal(r.all().some(n => ['script', 'svg', 'img', 'a'].includes(n.tagName)), false);
    assert.equal(radio(r, 'source').checked, false); assert.equal(radio(r, 'source').disabled, shape === 'protected');
    assert.equal(r.calls.length, 1); modal(r).emit('cancel'); assert.equal(modal(r), undefined); r.updater.unmount();
  }
});

test('modal close and Escape preserve an existing explicit local or source decision and its memory', async () => {
  for (const side of ['local', 'source']) {
    const item = longCandidate(), r = runtime(status('preview', { source_baseline_active: true, candidates: [item] })); await r.ready;
    select(r, side, item.key); remember(r, item.key);
    const opener = detailsButton(r, item.key); opener.focus(); opener.click();
    assert.equal(r.root.document.activeElement, r.button('close-details'));
    r.button('close-details').click(); assert.equal(r.root.document.activeElement, opener);
    opener.click(); modal(r).emit('cancel'); assert.equal(r.root.document.activeElement, opener);
    assert.equal(radio(r, side, item.key).checked, true); assert.equal(rememberToggle(r, item.key).checked, true); assert.equal(r.calls.length, 1);
    r.button('apply').click(); await tick(); assert.deepEqual(r.calls.at(-1).body, applyBody([{ key: item.key, choice: side, acknowledge_only: false }])); r.updater.unmount();
  }
});

test('details close on unmount and detached controls cannot reopen old content after remount', async () => {
  const item = longCandidate(), r = runtime(status('preview', { source_baseline_active: true, candidates: [item] })); await r.ready;
  const oldButton = detailsButton(r, item.key); oldButton.click(); assert.ok(modal(r));
  r.updater.unmount(); assert.equal(modal(r), undefined); oldButton.click(); assert.equal(modal(r), undefined);
  r.server = status('preview', { source_baseline_active: true, task_id: 'new-task', candidates: [{ ...item, source_value: { ...longLearning(), extra: '新内容' } }] }); await r.updater.mount(r.host);
  oldButton.click(); assert.equal(modal(r), undefined); detailsButton(r, item.key).click(); assert.match(modal(r).textContent, /新内容/);
  r.updater.unmount(); assert.equal(modal(r), undefined); assert.equal(r.timers.size, 0);
});

test('changing filter or page dismisses details and cannot reuse detached evidence controls', async () => {
  const item = longCandidate(), others = Array.from({ length: 31 }, (_, id) => ({ ...candidate, id, key: 'page-fixture:' + id, entity: 'skill' }));
  const r = runtime(status('preview', { source_baseline_active: true, candidates: [item, ...others] })); await r.ready;
  let oldButton = detailsButton(r, item.key); oldButton.click(); pageCandidates(r, 'next');
  assert.equal(modal(r), undefined); oldButton.click(); assert.equal(modal(r), undefined);
  pageCandidates(r, 'previous'); oldButton = detailsButton(r, item.key); oldButton.click(); filterCandidates(r, 'skill');
  assert.equal(modal(r), undefined); oldButton.click(); assert.equal(modal(r), undefined); assert.equal(r.calls.length, 1); r.updater.unmount();
});

test('pending checks immediately dismiss modal and changed task, stale revision or unavailable value never revive it', async () => {
  for (const outcome of ['task', 'revision', 'availability', 'error']) {
    let release;
    const item = longCandidate(), r = runtime(status('preview', { source_baseline_active: true, candidates: [item] }), { handle: action => action === 'check' ? new Promise(resolve => { release = resolve; }) : undefined }); await r.ready;
    const oldButton = detailsButton(r, item.key); oldButton.click(); r.button('check').click();
    assert.equal(modal(r), undefined); oldButton.emit('click'); assert.equal(modal(r), undefined); await tick();
    const extra = outcome === 'task' ? { task_id: 'next-task' } : outcome === 'revision' ? { current_revision: 'new-current' } : outcome === 'availability' ? { candidates: [{ ...item, source_available: false }] } : {};
    release(outcome === 'error' ? { ok: false, status: 409, json: async () => ({ ok: false, error: '状态未确认' }) } : { ok: true, json: async () => status('preview', { source_baseline_active: true, candidates: [item], ...extra }) }); await tick();
    assert.equal(modal(r), undefined); oldButton.emit('click'); assert.equal(modal(r), undefined);
    if (outcome === 'revision' || outcome === 'error') { const freshButton = detailsButton(r, item.key); assert.equal(freshButton.disabled, true); freshButton.emit('click'); assert.equal(modal(r), undefined); }
    assert.equal(r.calls.filter(c => c.init.method === 'POST').length, 1); r.updater.unmount();
  }
});

test('flush, reload and apply all discard open details before pending work without modifying choices', async () => {
  for (const action of ['flush', 'reload', 'apply']) {
    const item = longCandidate(), r = runtime(status('preview', { source_baseline_active: true, candidates: [item] }), { confirm: () => action !== 'reload' }); await r.ready;
    select(r, 'source', item.key); detailsButton(r, item.key).click();
    const result = action === 'apply' ? r.button('apply').click() : r.updater[action]();
    assert.equal(modal(r), undefined); if (action !== 'apply') await result; else await tick();
    assert.equal(modal(r), undefined); assert.equal(r.reloads, 0);
    if (action === 'apply') assert.deepEqual(r.calls.at(-1).body, applyBody([{ key: item.key, choice: 'source', acknowledge_only: true }]));
    else { assert.equal(radio(r, 'source', item.key).checked, true); assert.equal(r.calls.some(c => c.init.method === 'POST'), false); }
    r.updater.unmount();
  }
});

test('modal styles are themed and viewport bounded, keep close separate and wrap full scrollable text', () => {
  assert.match(css, /\.cu-detail-modal\s*\{[^}]*width:\s*min\(900px,\s*calc\(100vw \/ var\(--page-zoom, 1\) - 32px\)\)[^}]*max-height:\s*calc\(100vh \/ var\(--page-zoom, 1\) - 32px\)/);
  assert.match(css, /\.cu-detail-header h4\s*\{[^}]*max-height:\s*calc\(25vh \/ var\(--page-zoom, 1\)\)/);
  assert.match(css, /\.cu-detail-modal\s*\{[^}]*color:\s*var\(--text-primary\)[^}]*background:\s*var\(--bg-card\)/);
  assert.match(css, /\.cu-detail-modal\[open\]\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
  assert.match(css, /\.cu-detail-body\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/);
  assert.match(css, /\.cu-detail-header\s*\{[^}]*flex:\s*0 0 auto/);
  assert.match(css, /\.catalog-updater pre\s*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(css, /line-clamp|text-overflow:\s*ellipsis/);
});
