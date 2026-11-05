'use strict';
// UI-only tests: no external packages, real profiles, database, relay or filesystem writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/pages/battle-records.js'), 'utf8');
const api = require('../js/pages/battle-records.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const urlEndpoint = url => url.split('/api/battles/')[1].split('?')[0];
const pet = { instanceId: 'p1', monsterId: 35, protocolId: '9001', level: 60 };
const record = { version: 1, id: 'record-1', outcome: 'win', source: '<img src=x onerror=evil()>', quality: { roster: { me: true, enemy: false }, actions: false, lead: { me: true } }, sides: { me: { pets: [pet], lead: 'p1', before: { score: 0 }, after: { score: 1 } }, enemy: { pets: [{ instanceId: 'e1', monsterId: 0, protocolId: '9042', name: '<script>evil()</script>' }] } }, events: [{ id: 'event1', kind: 'skill', phase: 'executed', round: 1, seq: 1, actor: 'e1', side: 'enemy', skillId: 0, protocolSkillId: '7040370' }] };
const stats = { matchedBattles: 1, outcomes: { win: 1, loss: 0, draw: 0, unknown: 0 }, quality: { roster: 0, actions: 0, lead: 0 }, enemy: [], selfSkills: [], teams: [] };

function runtime(custom = {}) {
  let doc;
  class Element {
    constructor(tag) { this.tagName = tag; this.nodeType = 1; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; this.value = ''; this.hidden = false; this.disabled = false; this._text = ''; this.className = ''; this.ownerDocument = doc; }
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
    focus() { if (doc.activeElement !== this) { doc.activeElement?.emit('blur'); doc.activeElement = this; this.emit('focus'); } doc.emit('focusin', { target: this }); }
    get parentElement() { return this.parentNode; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    prepend(...nodes) { for (const node of nodes.reverse()) { node.parentNode = this; this.children.unshift(node); } }
    replaceChildren(...nodes) { this.children.forEach(n => { n.parentNode = null; }); this.children = []; this._text = ''; this.append(...nodes); }
    set textContent(value) { this.children.forEach(n => { n.parentNode = null; }); this.children = []; this._text = String(value); }
    get textContent() { return this._text + this.children.map(n => n.textContent).join(' '); }
    set innerHTML(_) { throw Error('UI must not insert untrusted HTML'); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, values = {}) { const event = { target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...values }; for (const fn of this.listeners[name] || []) fn(event); return event; }
    click() { if (!this.disabled) this.emit('click'); }
    reportValidity() { return true; }
  }
  doc = { createElement: tag => new Element(tag), listeners: {}, addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }, removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== fn); }, emit(name, values = {}) { const event = { preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...values }; for (const fn of [...(this.listeners[name] || [])]) fn(event); return event; } }; doc.documentElement = new Element('html'); doc.body = new Element('body'); doc.activeElement = doc.body;
  const calls = [], tracked = [], selectors = [], layers = [], layerBindings = new Set(), timers = new Map(); let timerId = 0, cleanupCount = 0, inference = null;
  const managedWidgets = new Map();
  const registerCleanup = (owner, cleanup) => { managedWidgets.set(owner, cleanup); return () => managedWidgets.delete(owner); };
  const flushDetachedWidgets = () => { for (const [owner, cleanup] of [...managedWidgets]) if (!owner.isConnected) cleanup(); };
  const localRecord = custom.record || JSON.parse(JSON.stringify(record));
  doc.createElementNS = (namespace, tag) => { const node = doc.createElement(tag); node.namespaceURI = namespace; return node; };
  let localRules = [], rulesRevision = 'r0';
  const root = { BattleHistoryGrowth: custom.historyGrowth, BattleActionOutcomes: custom.actionOutcomes, BattleRuleFamilies: Object.hasOwn(custom, 'ruleFamilies') ? custom.ruleFamilies : fs.existsSync(path.join(__dirname, '../js/battle-rule-families.js')) ? require('../js/battle-rule-families.js') : undefined, BattleTimeFilters: custom.timeFilters || require('../js/battle-time-filters.js'), BattleSystemActions: Object.hasOwn(custom,'systemActions') ? custom.systemActions : require('../js/battle-system-actions.js'), BattleTurnView: Object.hasOwn(custom, 'projector') ? custom.projector : require('../js/battle-turn-view.js'), BattleSpeedInference: custom.speedInference, document: doc, location: { hash: '' }, crypto: { randomUUID: () => 'fixture-id' }, AbortController, URLSearchParams, Date, console,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    listeners: {}, addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }, removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== fn); }, emit(name) { for (const fn of [...(this.listeners[name] || [])]) fn(); },
    BattleRecordsClient: {
      track(promise) { tracked.push(promise); return promise; },
      useRecord(value) { root.handoff = value; },
      renderInference(host, value, saved) { inference = { host, value, saved }; return () => { cleanupCount++; }; }
    },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (custom.handle) { const response = await custom.handle(url, options); if (response) return response; }
      const endpoint = url.split('/api/battles/')[1].split('?')[0]; let body;
      if (endpoint === 'list') body = { records: custom.empty ? [] : [localRecord], total: custom.empty ? 0 : 1 };
      if (endpoint === 'stats') body = custom.stats || stats;
      if (endpoint === 'status') body = { state: 'stopped', received: 0, imported: 0, unsupported: 0 };
      if (endpoint === 'record') body = localRecord;
      if (endpoint === 'rules') { if (options.method === 'PUT') { const payload = JSON.parse(options.body); assert.equal(payload.baseRevision, rulesRevision); localRules = payload.rules; rulesRevision += 'n'; } body = { rules: localRules, revision: rulesRevision }; }
      if (endpoint === 'import') { const parsed = JSON.parse(options.body); Object.assign(localRecord, parsed.records[0]); body = { imported: 1, duplicates: 0, issues: [] }; }
      if (endpoint === 'relay/start') body = { state: 'running', imported: 0 };
      if (endpoint === 'relay/stop') body = { state: 'stopped', imported: 0 };
      return { ok: true, json: async () => body };
    }
  };
  // Intentionally lexical-only globals, as in the actual app. No root.RKData/CommonUI.
  const context = vm.createContext({ ...root, window: root,
    testData: { getMonsters: () => [{ id: 35 }, { id: 42 }], getMonsterById: id => [35, 42].includes(id) ? { id } : null,
      getMonsterDisplayName: p => p.id === 35 ? '已知精灵' : '<img>资料名', getMoves: () => [{ id: 37 }], getMoveName: () => '已知技能', ...custom.data },
    testUI: { registerCleanup,
      positionAnchoredLayer(anchor, layer, matchWidth, options) { layers.push({ anchor, layer, matchWidth, options }); },
      bindAnchoredLayer(anchor, layer, onClose) {
        let active = true;
        const close = () => { if (!active) return; active = false; layerBindings.delete(close); for (const [kind, listener] of listeners) doc.removeEventListener(kind, listener); onClose(); };
        const listeners = [
          ['scroll', event => { if (!layer.contains(event.target)) close(); }],
          ['pointerdown', event => { if (!anchor.contains(event.target) && !layer.contains(event.target)) close(); }],
          ['keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }]
        ];
        layerBindings.add(close); for (const [kind, listener] of listeners) doc.addEventListener(kind, listener);
        return close;
      },
      createSearchBox(opts) {
      const wrapper = doc.createElement('div'), input = doc.createElement('input'); wrapper.append(input);
      const box = { wrapper, input, setValue: (value, item) => { input.value = value; box.selectedItem = item; }, destroy: () => { box.destroyed = true; unregister(); } };
      const unregister = registerCleanup(input, box.destroy);
      selectors.push({ opts, box }); return box;
    } }
  });
  vm.runInContext('const RKData = testData; const CommonUI = testUI;\n' + source, context);
  const page = root.BattleRecordsPage, host = doc.createElement('div'); doc.body.append(host);
  const all = (node = doc.body) => [node, ...node.children.flatMap(all)];
  const find = predicate => all().find(predicate);
  const named = name => find(n => n.name === name);
  const btn = label => find(n => n.tagName === 'button' && n.textContent === label);
  const submit = form => form.emit('submit');
  page.render(host);
  return { root, page, host, calls, tracked, selectors, layers, layerBindings, timers, named, btn, all, find, submit, flushDetachedWidgets, managedWidgets, get inference() { return inference; }, get cleanupCount() { return cleanupCount; } };
}

test('filter query uses one normalized contract, preserves zero and excludes inactive rank drafts', () => {
  const query = api.filterQuery({ from: '2026-10-28T00:00:00Z', to: '2026-10-29T00:00:00Z', outcome: 'unknown', monsterId: '35', teamRuleId: 'team-1', rankSide: 'enemy', rankMetric: 'score', rankMin: '0', rankMax: '100', tier: 'ignored' });
  assert.equal(query.get('from'), '2026-10-28T00:00:00.000Z'); assert.equal(query.get('rankMin'), '0'); assert.equal(query.has('tier'), false);
  assert.equal(api.filterQuery({ rankMetric: '', rankMin: 'bad' }).toString(), '');
  assert.throws(() => api.filterQuery({ from: 'bad' }));
  assert.throws(() => api.filterQuery({ from: '2026-10-29', to: '2026-10-28' }));
  assert.throws(() => api.filterQuery({ rankMetric: 'rank', rankMin: '0', rankMax: '', rankSide: 'me' }));
  assert.throws(() => api.filterQuery({ rankMetric: 'score', rankMin: '2', rankMax: '1', rankSide: 'me' }));
});
test('unknown denominator never becomes zero percent; unknown evidence never neutral', () => {
  assert.match(api.ratio(0, 0), /无有效样本/); assert.match(api.ratio(0, 2), /0\.0%/);
  assert.equal(api.evidenceText(null, 'nature'), '未知');
  assert.match(api.evidenceText({ certainty: 'direct', value: 0 }, 'nature'), /中性/);
  assert.match(api.evidenceText({ certainty: 'candidate', value: 0, candidates: [0, 60] }, 'iv'), /未确认/);
  assert.equal(api.evidenceText({ certainty: 'unknown', value: 60 }, 'iv'), '未知');
});
test('turn grouping preserves preview and damage events, sorts a copy, never treats casts as growth', () => {
  const events = [{ id: 'a', round: 2, seq: 1, kind: 'skill' }, { id: 'b', round: 1, seq: 3, kind: 'damage' }, { id: 'c', round: 1, seq: 1, phase: 'preview' }, { id: 'u' }];
  assert.deepEqual(api.groupedTurns(events).map(g => g.events.map(e => e.id)), [['u'], ['c', 'b'], ['a']]);
  assert.deepEqual(events.map(e => e.id), ['a', 'b', 'c', 'u']);
  const base = { kind: 'growth', phase: 'executed', side: 'me', actor: 'p1', skillId: 37, trigger: 'declared rule' };
  const groups = api.confirmedGrowth({ sides: { me: { pets: [pet] } }, events: [base, { ...base, stacks: 2 }, { ...base, actor: 'unknown' }, { ...base, trigger: '' }, { ...base, phase: 'preview' }, { ...base, kind: 'skill' }] });
  assert.equal(groups.length, 1); assert.equal(groups[0].events.length, 2);
});
test('growth uses latest cumulative stacks then increments confirmed missing-counter events, never sums counters', () => {
  const base = { kind: 'growth', phase: 'executed', round: 1, side: 'me', actor: 'p1', skillId: 37, trigger: 'explicit rule' };
  const run = events => api.confirmedGrowth({ sides: { me: { pets: [pet] } }, events })[0];
  const events = [1, 2, 3].map((stacks, i) => ({ ...base, seq: i + 1, stacks }));
  assert.equal(run(events).count, 3);
  assert.equal(run([...events, { ...base, seq: 4 }, { ...base, seq: 5 }]).count, 5);
  assert.equal(run([{ ...base, seq: 3 }, { ...base, seq: 1, stacks: 8 }, { ...base, seq: 2, stacks: 0 }]).count, 1);
  const unknown = run([{ ...base, seq: 1 }, { ...base, seq: 2 }]); assert.equal(unknown.count, 2); assert.equal(unknown.hasExplicitCounter, false);
  assert.equal(run([...events, { ...base, seq: 4, kind: 'skill' }, { ...base, seq: 5, phase: 'preview', stacks: 99 }]).count, 3);
});
test('initially empty, lexical CommonUI reused, no automatic capture/import or persistence', async () => {
  const r = runtime({ empty: true }); await tick();
  assert.match(r.host.textContent, /还没有对战记录/); assert.equal(r.tracked.length, 0);
  assert.equal(r.calls.every(call => !call.options.method), true); assert.equal(r.timers.size, 0);
  assert.equal(r.selectors.length, 1); assert.equal(r.root.RKData, undefined);
  assert.match(r.selectors[0].opts.search('42')[0].name, /&lt;img&gt;/);
  r.page.onLeave(); assert.ok(r.selectors.every(s => s.box.destroyed));
});
test('shared list/stat filter query, explicit ID not typed name, and failure retains controls', async () => {
  let fail = false;
  const r = runtime({ handle: async url => fail && url.includes('/stats?') ? { ok: false, json: async () => ({ error: 'fixture offline' }) } : null }); await tick();
  r.named('outcome').value = 'loss'; r.selectors[0].opts.onSelect({ id: 42 });
  const filterForm = r.find(n => n.tagName === 'form' && n.attrs['aria-label'] === '对战记录共享筛选');
  r.submit(filterForm); await tick(); assert.equal(r.calls.some(c=>c.url.includes('/stats?')), false); r.btn('样本统计').click(); await tick();
  const queryCalls = r.calls.filter(c => /\/(list|stats)\?/.test(c.url)).slice(-2);
  const list = new URL(queryCalls[0].url, 'http://local').searchParams; list.delete('page'); list.delete('pageSize');
  assert.equal(list.toString(), new URL(queryCalls[1].url, 'http://local').searchParams.toString()); assert.equal(list.get('monsterId'), '42');
  fail = true; r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick();
  assert.match(r.host.textContent, /fixture offline/); assert.equal(r.named('outcome').value, 'loss'); assert.ok(r.btn('应用筛选')); assert.ok(r.btn('重试'));
  fail = false; r.btn('重试').click(); await tick(); assert.equal(r.find(n=>n.dataset.brPanel==='stats').textContent.includes('fixture offline'),false); assert.match(r.host.textContent,/1 场匹配/); r.page.onLeave();
});
test('detail escapes imported identity text, excludes source evidence and refresh preserves filters', async () => {
  const r = runtime(); await tick(); r.named('outcome').value = 'win';
  r.submit(r.find(n => n.tagName === 'form' && n.attrs['aria-label'] === '对战记录共享筛选')); await tick();
  r.btn('查看详情').click(); await tick();
  const detail = () => r.find(n => n.dataset.br === 'detail');
  assert.match(detail().textContent, /<script>evil\(\)<\/script>/);
  assert.doesNotMatch(detail().textContent, /7040370|配置、映射与来源证据|来源 \/ 数据提示/);
  assert.doesNotMatch(r.host.textContent, /尚未通过真实对战验证/); assert.doesNotMatch(r.host.textContent, /首发未知/);
  assert.equal(r.inference, null); assert.equal(r.all().some(n => n.tagName === 'script'), false);
  r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); assert.equal(r.named('outcome').value, 'win');
  assert.equal(r.inference, null); assert.equal(r.cleanupCount, 0);
  assert.equal(r.btn('用于伤害计算'), undefined); assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, '');
  assert.equal(r.calls.some(c => c.options.method), false); r.page.onLeave();
});
test('unmapped monster and skill records mount no editing controls and never trigger POST', async () => {
  const r = runtime(), before = JSON.stringify(record); await tick(); r.btn('查看详情').click(); await tick();
  const detail = r.find(n => n.dataset.br === 'detail');
  assert.equal(r.btn('确认本记录精灵映射'), undefined); assert.equal(r.btn('确认本记录技能映射'), undefined);
  assert.equal(r.all(detail).some(n => ['input', 'select', 'textarea', 'details'].includes(n.tagName)), false);
  assert.equal(r.selectors.length, 1); assert.equal(r.inference, null);
  assert.equal(r.tracked.length, 0); assert.equal(r.calls.some(c => c.options.method), false);
  assert.equal(r.btn('用于伤害计算'), undefined); assert.equal(r.root.handoff, undefined); assert.equal(r.root.location.hash, '');
  assert.equal(record.sides.enemy.pets[0].monsterId, 0); assert.equal(record.events[0].skillId, 0);
  assert.equal(record.events[0].protocolSkillId, '7040370'); assert.equal(JSON.stringify(record), before); r.page.onLeave();
});
test('native file import has size guards, retry controls and a tracked mutation', async () => {
  let fail = true;
  const r = runtime({ handle: async (url, opts) => url.endsWith('/import') && fail ? { ok: false, json: async () => ({ error: 'import retry' }) } : null }); await tick();
  const file = r.named('battleFile'); file.files = [{ size: 8 * 1024 * 1024 + 1, name: 'large.json', text: () => { throw Error('must not read oversized file'); } }]; file.emit('change'); await tick();
  assert.match(r.host.textContent, /8 MiB/); assert.equal(r.tracked.length, 0);
  file.files = [{ size: 100, name: 'record.ndjson', text: async () => JSON.stringify({ version: 1, records: [record] }) }]; file.emit('change'); await tick();
  assert.match(r.host.textContent, /import retry/); assert.equal(r.btn('导入 JSON / NDJSON').disabled, false);
  fail = false; r.btn('重试').click(); await tick(); assert.equal(r.tracked.length, 2);
  assert.equal(r.calls.filter(c => c.options.method === 'POST').at(-1).options.headers['Content-Type'], 'application/x-ndjson'); assert.match(r.host.textContent, /导入完成/); r.page.onLeave();
});
test('fallback queue caps transport at two, drops superseded queued GETs and suppresses aborted completions', async () => {
  const pending = []; let inFlight = 0, peak = 0;
  const r = runtime({ handle: (url, options) => /\/(list|stats)\?/.test(url) ? new Promise(resolve => {
    inFlight++; peak = Math.max(peak, inFlight); pending.push({ url, options, resolve(body) { inFlight--; resolve({ ok: true, json: async () => body }); } });
  }) : null });
  await tick(); r.btn('样本统计').click(); await tick();
  r.named('outcome').value = 'loss'; r.submit(r.find(n => n.tagName === 'form' && n.attrs['aria-label'] === '对战记录共享筛选'));
  r.named('outcome').value = 'win'; r.submit(r.find(n => n.tagName === 'form' && n.attrs['aria-label'] === '对战记录共享筛选'));
  await tick(); assert.equal(pending.length, 2); assert.equal(peak, 2);
  assert.ok(pending.every(item => item.options.signal.aborted));
  for (const item of pending.slice(0, 2)) item.resolve(item.url.includes('/list?') ? { records: [record], total: 1 } : stats);
  await tick(); assert.equal(pending.length, 4); assert.ok(pending.slice(2).every(item => item.url.includes('outcome=win')));
  assert.equal(r.calls.some(call => call.url.includes('outcome=loss')), false, 'superseded queued cohort never reaches the network');
  for (const item of pending.slice(2)) item.resolve(item.url.includes('/list?') ? { records: [], total: 0 } : stats);
  await tick(); assert.match(r.host.textContent, /没有符合条件的记录/);
  r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); r.page.onLeave(); const before = r.host.textContent, calls = r.calls.length;
  for (const item of pending.slice(4)) item.resolve(item.url.includes('/list?') ? { records: [record], total: 1 } : stats);
  await tick(); assert.equal(r.host.textContent, before); assert.equal(r.calls.length, calls); assert.equal(r.timers.size, 0); assert.equal(peak, 2);
  assert.ok(r.calls.filter(c => c.options.signal).every(c => c.options.signal.aborted));
});
test('manual relay only; start/stop writes tracked and leave never launches or stops capture', async () => {
  const r = runtime(); await tick(); r.btn('连接中继').click(); await tick();
  assert.equal(r.tracked.length, 1); assert.equal(r.timers.size, 1);
  r.btn('停止接入').click(); await tick(); assert.equal(r.tracked.length, 2); assert.equal(r.timers.size, 0);
  const before = r.calls.length; r.page.onLeave(); assert.equal(r.calls.length, before);
});
test('rules wait for a successful read and retain new drafts across a failed save/retry', async () => {
  let failRead = true, failWrite = true;
  const r = runtime({ handle: async (url, opts) => url.endsWith('/rules') && ((!opts.method && failRead) || (opts.method === 'PUT' && failWrite)) ? { ok: false, json: async () => ({ error: 'rules retry' }) } : null });
  await tick(); r.btn('样本统计').click(); r.btn('敌方样本统计').click(); r.btn('阵容规则').click(); assert.equal(r.btn('保存规则').disabled, true); assert.equal(r.tracked.length, 0);
  failRead = false; r.btn('重试').click(); await tick(); assert.equal(r.btn('保存规则').disabled, false);
  r.named('ruleName').value = 'my rule'; r.named('ruleName').emit('input'); r.selectors[1].opts.onSelect({ id: 35 });
  const form = r.find(n => n.tagName === 'form' && n.className.includes('br-rule-form'));
  r.submit(form); r.btn('保存规则').click(); await tick(); assert.match(r.root.document.body.textContent, /rules retry/); assert.equal(r.named('ruleName').value, 'my rule');
  failWrite = false; r.btn('重试').click(); await tick(); assert.equal(r.named('ruleName').value, 'my rule');
  const written = JSON.parse(r.calls.filter(c => c.options.method === 'PUT').at(-1).options.body);
  assert.equal(written.rules[0].name, 'my rule'); assert.deepEqual(written.rules[0].monsterIds, [35]); assert.equal(r.tracked.length, 2);
  r.page.onLeave();
});
test('refresh and reopen cannot revive removed mapping or inference UI', async () => {
  const r = runtime({ handle: (url, options) => { assert.notEqual(options.method, 'POST'); return null; } });
  await tick(); r.btn('查看详情').click(); await tick();
  r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); r.btn('关闭').click(); r.btn('查看详情').click(); await tick();
  assert.equal(r.selectors.length, 1); assert.equal(r.inference, null); assert.equal(r.tracked.length, 0);
  const detail = r.find(n => n.dataset.br === 'detail');
  assert.doesNotMatch(detail.textContent, /显式身份映射|确认本记录|条件推断组件|配置、映射与来源证据/);
  assert.equal(r.all(detail).some(n => ['input', 'select', 'textarea', 'details'].includes(n.tagName)), false);
  r.page.onLeave(); assert.ok(r.selectors.every(s => s.box.destroyed));
});
test('leave during a pending mutation does not cancel commit or redraw; live timer is cleared', async () => {
  let resolveWrite;
  const r = runtime({ handle: (url, options) => url.endsWith('/relay/start') && options.method === 'POST' ? new Promise(resolve => { resolveWrite = resolve; }) : null });
  await tick(); r.btn('连接中继').click(); await tick(); assert.equal(r.tracked.length, 1);
  const write = r.calls.find(c => c.options.method === 'POST'); assert.equal(write.options.signal, undefined);
  r.page.onLeave(); const old = r.host.textContent;
  resolveWrite({ ok: true, json: async () => ({ state: 'running', imported: 1 }) }); await tick();
  assert.equal(r.host.textContent, old); assert.equal(r.timers.size, 0);
  const live = runtime(); await tick(); live.btn('连接中继').click(); await tick(); assert.equal(live.timers.size, 1);
  live.page.onLeave(); assert.equal(live.timers.size, 0);
});
test('CSS selectors are page-scoped, no snapshot rules, no browser data persistence', () => {
  const css = fs.readFileSync(path.join(__dirname, '../css/battle-records.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selector] of css.matchAll(/([^{}]+)\{/g)) {
    if (/^@(media|container)\b/.test(selector.trim())) continue;
    assert.ok(selector.trim().startsWith(':is(.battle-records-page, .br-modal-root) ') || selector.trim().startsWith('.battle-records-page ') || selector.trim().startsWith('.br-modal-root ') || ['.battle-records-page', '.br-modal-root'].includes(selector.trim()), selector);
  }
  assert.doesNotMatch(source, /localStorage\.|UserConfig\.|sessionStorage\.|\.innerHTML\s*=/);
  assert.doesNotMatch(css, /\.battle-snapshot-panel\s*\{|!important/);
});

test('time panel is nav-right, S4W8 local season intervals are exclusive and initial filters remain unrestricted', async t => {
  const time = require('../js/battle-time-filters.js'), now = new Date(2026, 10, 2, 21);
  const r = runtime({timeFilters:{...time,seasons:()=>time.seasons(now)}}); t.after(()=>r.page.onLeave()); await tick();
  const query = call => new URL(call.url,'http://test').searchParams;
  assert.ok(r.calls.filter(c=>/\/(list|stats)\?/.test(c.url)).every(c=>!query(c).has('from')&&!query(c).has('rankMin')));
  const toggle=r.btn('时间范围'), nav=toggle.parentNode, panel=r.find(n=>n.id==='br-filter-panel');
  assert.equal(nav.tagName,'nav');assert.equal(nav.children.at(-1),toggle);assert.match(nav.children[0].textContent,/对战列表.*样本统计/);
  assert.equal(panel.hidden,true);assert.equal(r.named('rankSide'),undefined);assert.equal(r.named('rankMetric'),undefined);assert.equal(r.named('tier'),undefined);
  assert.doesNotMatch(r.host.textContent,/筛选记录与统计|筛选记录和统计/);
  toggle.click();assert.equal(panel.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.deepEqual(r.all(panel).filter(n=>n.dataset.season).map(n=>n.dataset.season),['1','2','3','4']);assert.equal(r.btn('S5'),undefined);
  r.btn('S4').click();await tick();assert.equal(r.all(panel).filter(n=>n.dataset.week).length,8);
  const bounds=time.bounds(4);for(const call of r.calls.filter(c=>c.url.includes('/list?')).slice(-1)){assert.equal(query(call).get('from'),bounds.from);assert.equal(query(call).get('to'),bounds.to);assert.equal(query(call).get('toExclusive'),'true');}
  assert.equal(r.named('from'),undefined);assert.equal(r.named('to'),undefined);assert.equal(r.btn('清除全部时间'),undefined);assert.equal(r.btn('刷新数据'),undefined);assert.equal(r.calls.some(c=>c.url.includes('/stats?')),false);
  r.btn('第8周').click();await tick();assert.equal(query(r.calls.filter(c=>c.url.includes('/list?')).at(-1)).get('from'),time.bounds(4,8).from);
  r.root.document.emit('keydown',{key:'Escape'});assert.equal(panel.hidden,true);assert.equal(r.root.document.activeElement,toggle);
  toggle.click();assert.equal(r.btn('第8周').getAttribute('aria-pressed'),'true');r.root.document.emit('pointerdown',{target:r.host});assert.equal(panel.hidden,true);
  toggle.click();r.named('rankMin').focus();r.root.emit('resize');assert.equal(panel.hidden,true);assert.equal(r.root.document.activeElement,toggle);assert.equal(r.root.listeners.resize.length,0);
  toggle.click();r.btn('样本统计').focus();assert.equal(panel.hidden,true);assert.equal(r.root.document.listeners.pointerdown.length,1,'only mounted CSS menu listener remains');
  toggle.click();r.btn('重置筛选').click();await tick();assert.ok(r.calls.filter(c=>c.url.includes('/list?')).slice(-1).every(c=>!query(c).has('from')&&!query(c).has('toExclusive')));
  r.page.onLeave();assert.equal(panel.hidden,true);assert.equal(r.root.document.listeners.pointerdown.length,0);
});

test('current season future weeks are disabled; rank crossing uses exact indexed stops and only applies explicitly', async t => {
  const time=require('../js/battle-time-filters.js'),now=new Date(2026,8,10,4,0);
  const r=runtime({timeFilters:{...time,seasons:()=>time.seasons(now)}});t.after(()=>r.page.onLeave());await tick();r.btn('时间范围').click();r.btn('S4').click();await tick();
  const weeks=r.all().filter(n=>n.dataset.week);assert.equal(weeks[0].disabled,false);assert.ok(weeks.slice(1).every(n=>n.disabled));
  const low=r.named('rankMin'),high=r.named('rankMax'),unlimited=r.named('rankUnlimited'),form=r.find(n=>n.id==='br-filter-panel');
  assert.equal(low.parentNode,high.parentNode);assert.equal(low.parentNode.className,'br-rank-track');const count=r.calls.length;low.value='99';low.emit('input');assert.equal(unlimited.checked,false);assert.equal(low.getAttribute('aria-valuetext'),'99000');assert.equal(high.getAttribute('aria-valuetext'),'100000');
  high.value='1';high.emit('input');assert.equal(low.getAttribute('aria-valuetext'),'1000');assert.equal(high.getAttribute('aria-valuetext'),'1000');
  low.value='0';low.emit('input');assert.equal(low.getAttribute('aria-valuetext'),'1');assert.equal(high.value,'1');assert.equal(r.calls.length,count,'no per-pixel requests');
  r.submit(form);await tick();r.btn('样本统计').click();await tick();for(const call of r.calls.filter(c=>/\/(list|stats)\?/.test(c.url)).slice(-2)){const q=new URL(call.url,'http://test').searchParams;assert.equal(q.get('rankSide'),'enemy');assert.equal(q.get('rankMetric'),'rank');assert.equal(q.get('rankMin'),'1');assert.equal(q.get('rankMax'),'1000');}
  unlimited.checked=true;unlimited.emit('change');r.submit(form);await tick();assert.equal(new URL(r.calls.filter(c=>c.url.includes('/stats?')).at(-1).url,'http://test').searchParams.has('rankMetric'),false);
});

test('queued writes enter close barrier immediately and survive leave while queued GETs are cancelled', async t => {
  const pending=[];let resolveWrite;
  const r=runtime({handle:(url,options)=>!options.method?new Promise(resolve=>pending.push(()=>resolve({ok:true,json:async()=>url.includes('/list?')?{records:[],total:0}:{rules:[],revision:'version-q'}}))):url.endsWith('/relay/start')?new Promise(resolve=>{resolveWrite=resolve;}):null});t.after(()=>r.page.onLeave());
  r.btn('连接中继').click();assert.equal(r.tracked.length,1);assert.equal(r.calls.length,2);r.page.onLeave();const before=r.host.textContent;
  pending.forEach(resolve=>resolve());await tick();assert.ok(resolveWrite);assert.equal(r.calls.filter(call=>urlEndpoint(call.url)==='status').length,0);assert.ok(r.calls.filter(call=>call.options.signal).every(call=>call.options.signal.aborted));
  resolveWrite({ok:true,json:async()=>({state:'running',imported:1})});await r.tracked[0];await tick();assert.equal(r.host.textContent,before);assert.equal(r.timers.size,0);
});
