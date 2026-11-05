'use strict';
// Focused synthetic-only regression: real page/client, deterministic 500ms clock,
// in-memory HTTP/Blob. No GUI/WebView/RKPP/DB/AppData/settings writes or launches.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const harnessPath = path.join(__dirname, 'battle-records-ui.test.js');
const harnessSource = fs.readFileSync(harnessPath, 'utf8');
const clientSource = fs.readFileSync(path.join(__dirname, '../js/battle-records.js'), 'utf8');
const box = { module: { exports: {} }, require: createRequire(harnessPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
vm.runInNewContext(harnessSource.slice(0, harnessSource.indexOf('\ntest(')).replace('  page.render(host);', '  custom.install?.(root, context);\n  page.render(host);') + '\nmodule.exports = runtime;', box, { filename: harnessPath });
const runtime = box.module.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const ok = body => ({ ok: true, status: 200, json: async () => body });
const relay = state => ({ state, received: 0, imported: 0, updated: 0, ignored: 0, pending: 0, unsupported: 0 });
const status = (state, connected = false) => ({ state, connected, owned: state !== 'stopped', sessionToken: 'synthetic-session' });
const raw = '{ "BattleID":18446744073709551615, "metadata": {"v":1}, "rows":[1,2] }';
const sourceStatus = overrides => ({ available: true, count: 1, bytes: Buffer.byteLength(raw), complete: true, issues: [], ...overrides });
function downloadResponse(format, overrides = {}) {
  const bytes = format === 'json' ? `[\n${raw}\n]` : raw + '\n';
  const headers = new Map(Object.entries({ 'Content-Disposition': `attachment; filename="battle-source-events.${format}"`, 'Content-Length': String(Buffer.byteLength(bytes)), 'X-Battle-Source-Count': '1', 'X-Battle-Source-Complete': 'true', ...overrides }));
  return { ok: true, status: 200, headers: { get: name => headers.get(name) ?? null }, json: async () => { throw Error('raw success must not be JSON parsed'); }, blob: async () => new Blob([bytes]) };
}
function clock() {
  let now = Date.parse('2026-11-05T04:00:00Z'), serial = 0; const timers = new Map();
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  return { Date: FakeDate, timers, setTimeout(fn, delay = 0) { const id = ++serial; timers.set(id, { fn, at: now + delay, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    async advance(ms) { const end = now + ms; let steps = 0; while (true) { const next = [...timers.entries()].filter(([,v]) => v.at <= end).sort((a,b) => a[1].at - b[1].at || a[0] - b[0])[0]; if (!next) break; assert.ok(++steps < 200, 'bounded fake timer callbacks'); now = next[1].at; timers.delete(next[0]); next[1].fn(); await tick(); } now = end; await tick(); },
    delays() { return [...timers.values()].map(v => v.at - now).sort((a,b) => a-b); }
  };
}
async function mount(t, handle = () => null, custom = {}) {
  const fake = clock(), urls = [], revoked = [], bindings = [], anchors = [];
  const r = runtime({ ...custom, handle(url, options) { if (url === '/api/rkpp/status') return handle(url, options) || ok(status('stopped')); return handle(url, options); }, install(root, context) {
    Object.assign(root, { URL: { createObjectURL(blob) { urls.push(blob); return 'blob:synthetic-' + urls.length; }, revokeObjectURL(url) { revoked.push(url); } }, Blob, Date: fake.Date, setTimeout: fake.setTimeout, clearTimeout: fake.clearTimeout });
    Object.assign(context, { Blob, Date: fake.Date, setTimeout: fake.setTimeout, clearTimeout: fake.clearTimeout });
    context.testUI.bindModalContextMenu = (surface, close) => { const fn = event => { event.preventDefault(); event.stopPropagation(); close(); }; surface.addEventListener('contextmenu', fn, true); const dispose = () => surface.removeEventListener('contextmenu', fn, true); bindings.push({ surface, dispose }); return dispose; };
    const create = root.document.createElement; root.document.createElement = tag => { const node = create(tag); if (tag === 'a') { const click = node.click.bind(node); node.click = () => { anchors.push({ href: node.href, download: node.download }); click(); }; } return node; };
    vm.runInContext(clientSource, context); root.BattleRecordsClient = context.BattleRecordsClient;
  } });
  Object.assign(r, { fake, urls, revoked, bindings, anchors }); t.after(() => r.page.onLeave()); await tick(); return r;
}
const runtimeHost = r => r.find(n => n.className === 'br-runtime-status');
const exportModal = r => r.find(n => n.dataset.modalKind === 'export-source');
const reads = r => r.calls.filter(c => c.url === '/api/rkpp/status');
const writes = r => r.calls.filter(c => c.options.method && c.options.method !== 'GET');
const sourceCalls = r => r.calls.filter(c => c.url.includes('/battles/source/'));

test('start -> receiver stopped -> runtime starting -> connected automatically at real 500ms, then both normal 2500ms GETs', async t => {
  let phase = 'stopped', polls = 0;
  const r = await mount(t, (url) => {
    if (url === '/api/rkpp/start') { phase = 'starting'; return ok(status('starting')); }
    if (url === '/api/rkpp/status') { if (phase === 'starting' && ++polls >= 2) phase = 'running'; return ok(status(phase, phase === 'running')); }
    if (url === '/api/battles/status') return ok(relay(phase === 'running' ? 'running' : 'stopped'));
  });
  assert.equal(r.fake.timers.size, 0); r.btn('启动').click(); await tick();
  assert.match(runtimeHost(r).textContent, /启动中.*接入尚未连接/); assert.deepEqual(r.fake.delays(), [500, 20000]);
  const baseline = reads(r).length; await r.fake.advance(499); assert.equal(reads(r).length, baseline);
  await r.fake.advance(1); assert.equal(reads(r).length, baseline + 1); assert.match(runtimeHost(r).textContent, /启动中/);
  await r.fake.advance(500); assert.match(runtimeHost(r).textContent, /运行中.*接入已连接/); assert.deepEqual(r.fake.delays(), [2500]);
  assert.equal(writes(r).length, 1); assert.equal(writes(r)[0].url, '/api/rkpp/start');
  const allReads = r.calls.length; await r.fake.advance(2499); assert.equal(r.calls.length, allReads); await r.fake.advance(1); assert.equal(r.calls.length, allReads + 2);
  assert.equal(sourceCalls(r).length, 0); assert.equal(r.calls.some(c => c.url.includes('/scan')), false);
});

test('stop progress polls even stopped receiver, reaches final stopped state without repeated POST', async t => {
  let phase = 'running';
  const r = await mount(t, url => {
    if (url === '/api/rkpp/stop') { phase = 'stopping'; return ok(status('stopping')); }
    if (url === '/api/rkpp/status') { if (phase === 'stopping') phase = 'stopped'; return ok(status(phase, phase === 'running')); }
    if (url === '/api/battles/status') return ok(relay(phase === 'running' ? 'running' : 'stopped'));
  });
  r.btn('停止').click(); await tick(); assert.deepEqual(r.fake.delays(), [500, 20000]); await r.fake.advance(500);
  assert.match(runtimeHost(r).textContent, /已停止.*接入尚未连接/); assert.equal(r.fake.timers.size, 0); assert.equal(r.btn('启动').disabled, false); assert.equal(r.btn('停止').disabled, true); assert.equal(writes(r).length, 1);
});

test('remount of backend starting retains original 20s deadline, reads do not renew it, and timeout is fixed until safe GET retry', async t => {
  let phase = 'starting';
  const r = await mount(t, url => url === '/api/rkpp/status' ? ok(status(phase, phase === 'running')) : url === '/api/battles/status' ? ok(relay('stopped')) : null);
  await r.fake.advance(5000); r.page.render(r.host); await tick(); assert.deepEqual(r.fake.delays(), [500, 15000]);
  await r.fake.advance(14999); assert.doesNotMatch(runtimeHost(r).textContent, /超时/); await r.fake.advance(1);
  assert.match(runtimeHost(r).textContent, /状态确认超时（20秒）/); assert.equal(r.fake.timers.size, 0); const count = reads(r).length; await r.fake.advance(5000); assert.equal(reads(r).length, count); assert.equal(writes(r).length, 0);
  phase = 'running'; r.btn('刷新状态').click(); await tick(); assert.match(runtimeHost(r).textContent, /接入已连接/); assert.equal(writes(r).length, 0);
});

test('operation deadline includes delayed start response, late timeout result cannot paint or issue receiver GET', async t => {
  let settle;
  const r = await mount(t, url => url === '/api/rkpp/start' ? new Promise(resolve => { settle = resolve; }) : null);
  r.btn('启动').click(); await tick(); await r.fake.advance(20000); assert.match(runtimeHost(r).textContent, /超时/);
  const oldText = runtimeHost(r).textContent, count = r.calls.length; settle(ok(status('running', true))); await tick();
  assert.equal(runtimeHost(r).textContent, oldText); assert.equal(r.calls.length, count); assert.equal(writes(r).length, 1); assert.equal(r.fake.timers.size, 0);
});

test('failed current status never advertises connected, auto retries nothing and exposes only safe GET retry', async t => {
  let fail = false;
  const r = await mount(t, url => {
    if (url === '/api/rkpp/start') { fail = true; return ok(status('starting')); }
    if (url === '/api/rkpp/status') return fail ? { ok: false, status: 503, json: async () => ({ error: '当前合成服务错误' }) } : ok(status('stopped'));
  });
  r.btn('启动').click(); await tick(); await r.fake.advance(500); assert.match(runtimeHost(r).textContent, /当前合成服务错误/); assert.doesNotMatch(runtimeHost(r).textContent, /接入已连接/);
  assert.equal(r.fake.timers.size, 0); const before = r.calls.length; await r.fake.advance(30000); assert.equal(r.calls.length, before);
  r.btn('重试').click(); await tick(); assert.equal(writes(r).length, 1); assert.equal(r.calls.at(-1).options.method, 'GET');
});

test('runtime error status is terminal; already connected then receiver GET failure removes stale connected label', async t => {
  let mode = 'error';
  const r = await mount(t, url => {
    if (url === '/api/rkpp/status') return ok(mode === 'error' ? { ...status('error', true), error: '合成启动失败' } : status('running', true));
    if (url === '/api/battles/status') return mode === 'receiver-failure' ? { ok: false, status: 500, json: async () => ({ error: '合成接收失败' }) } : ok(relay('running'));
  });
  assert.match(runtimeHost(r).textContent, /合成启动失败/); assert.doesNotMatch(runtimeHost(r).textContent, /接入已连接/); assert.equal(r.fake.timers.size, 0);
  mode = 'running'; r.btn('刷新状态').click(); await tick(); assert.match(runtimeHost(r).textContent, /接入已连接/);
  mode = 'receiver-failure'; await r.fake.advance(2500); assert.doesNotMatch(runtimeHost(r).textContent, /接入已连接/); assert.match(r.host.textContent, /合成接收失败/); assert.equal(r.fake.timers.size, 0);
});

test('busy in-flight status reschedules lifecycle without parallel duplicate GET; leave aborts reads/timers and blocks late paint', async t => {
  let hold = false, settle; const r = await mount(t, url => {
    if (url === '/api/rkpp/status') return hold ? new Promise(resolve => { settle = resolve; }) : ok(status('starting'));
  });
  hold = true; await r.fake.advance(500); const count = reads(r).length;
  r.btn('刷新状态').click(); await r.fake.advance(1000); assert.equal(reads(r).length, count); assert.ok(r.fake.delays().includes(500));
  const old = r.host.children[0]; r.page.onLeave(); const oldText = old.textContent; assert.equal(r.fake.timers.size, 0);
  assert.equal(reads(r).at(-1).options.signal.aborted, true); settle(ok(status('running', true))); await tick(); assert.equal(old.textContent, oldText); assert.equal(r.fake.timers.size, 0);
});

for (const format of ['json', 'ndjson']) test(`${format} chooser exports all opaque raw source bytes, ignoring filters, with safe Blob anchor and deferred cleanup`, async t => {
  const r = await mount(t, url => {
    if (url === '/api/battles/source/status') return ok(sourceStatus({ complete: false, issues: ['合成来源有已知遗漏'] }));
    if (url.startsWith('/api/battles/source/export?')) return downloadResponse(format, { 'X-Battle-Source-Complete': 'false' });
  });
  assert.equal(sourceCalls(r).length, 0); r.named('outcome').value = 'loss'; r.submit(r.find(n => n.tagName === 'form' && n.getAttribute('aria-label') === '对战记录共享筛选')); await tick();
  const controls = r.btn('导入 JSON / NDJSON').parentNode; assert.equal(controls.children[1].textContent, '导出对局记录');
  r.btn('导出对局记录').click(); await tick(); assert.match(exportModal(r).textContent, /不受.*筛选影响/); assert.match(exportModal(r).textContent, /合成来源有已知遗漏/);
  assert.ok(exportModal(r).textContent.includes('导出为转换成战报前的RKPP源事件，包含账号标识等个人信息，请勿直接公开。不会自动上传。'));
  r.btn(format.toUpperCase()).click(); await tick(); const request = sourceCalls(r).at(-1);
  assert.equal(request.url, '/api/battles/source/export?format=' + format); assert.equal(request.options.method, 'GET'); assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.redirect, 'error'); assert.equal(request.options.cache, 'no-store');
  assert.equal(r.urls.length, 1); assert.equal(await r.urls[0].text(), format === 'json' ? `[\n${raw}\n]` : raw + '\n'); assert.equal(r.anchors[0].download, 'battle-source-events.' + format);
  assert.match(exportModal(r).textContent, /不代表全部旧战报原事件完整/); assert.equal(writes(r).length, 0); assert.equal(r.revoked.length, 0);
  r.page.onLeave(); await r.fake.advance(999); assert.equal(r.revoked.length, 0); await r.fake.advance(1); assert.deepEqual(r.revoked, ['blob:synthetic-1']); assert.equal(r.fake.timers.size, 0);
});

test('empty/absent archive explicitly explains no reverse conversion; never normalized export or auto scan', async t => {
  const r = await mount(t, url => url === '/api/battles/source/status' ? ok(sourceStatus({ available: false, count: 0, bytes: 0 })) : null);
  r.btn('导出对局记录').click(); await tick(); assert.match(exportModal(r).textContent, /暂无转换前事件；旧战报不会反推，可扫描已有RKPP采集记录补导/);
  assert.equal(r.btn('JSON').disabled, true); r.btn('JSON').emit('click'); await tick(); assert.equal(sourceCalls(r).length, 1); assert.equal(r.urls.length, 0); assert.equal(writes(r).length, 0); assert.equal(r.calls.some(c => c.url.includes('/scan')), false);
});

test('export close/leave aborts metadata and downloads; late results cannot paint, trigger anchor or leak URL', async t => {
  let settle; const r = await mount(t, url => url === '/api/battles/source/status' ? ok(sourceStatus()) : url.startsWith('/api/battles/source/export?') ? new Promise(resolve => { settle = resolve; }) : null);
  r.btn('导出对局记录').click(); await tick(); r.btn('NDJSON').click(); await tick(); const old = exportModal(r), oldText = old.textContent;
  old.emit('contextmenu'); assert.equal(exportModal(r), undefined); assert.equal(sourceCalls(r).at(-1).options.signal.aborted, true); assert.equal(old.listeners.contextmenu.length, 0);
  settle(downloadResponse('ndjson')); await tick(); assert.equal(old.textContent, oldText); assert.equal(r.anchors.length, 0); assert.equal(r.urls.length, 0);
  let metadata; const q = await mount(t, url => url === '/api/battles/source/status' ? new Promise(resolve => { metadata = resolve; }) : null); q.btn('导出对局记录').click(); await tick(); const stale = exportModal(q), text = stale.textContent; q.page.onLeave(); metadata(ok(sourceStatus())); await tick(); assert.equal(stale.textContent, text); assert.equal(sourceCalls(q).at(-1).options.signal.aborted, true);
});

test('raw export enforces 64MiB, rejects redirects/failures without fallback, and safe filename ignores traversal', async t => {
  let response = downloadResponse('json', { 'Content-Length': String(64 * 1024 * 1024 + 1) });
  const r = await mount(t, url => url === '/api/battles/source/status' ? ok(sourceStatus()) : url.startsWith('/api/battles/source/export?') ? response : null);
  r.btn('导出对局记录').click(); await tick(); r.btn('JSON').click(); await tick(); assert.match(exportModal(r).textContent, /64 MiB/); assert.equal(r.urls.length, 0);
  response = downloadResponse('json', { 'Content-Disposition': 'attachment; filename="../../bad.json"' }); r.btn('重试').click(); await tick(); assert.equal(r.anchors[0].download, 'rkpp-source-events.json');
  assert.equal(writes(r).length, 0); assert.equal(sourceCalls(r).filter(c => c.url.includes('/export?')).length, 2);
});

test('zero-event export response after nonempty metadata reports archive empty without downloading []', async t => {
  const r = await mount(t, url => url === '/api/battles/source/status' ? ok(sourceStatus()) : url.startsWith('/api/battles/source/export?') ? downloadResponse('json', { 'X-Battle-Source-Count': '0' }) : null);
  r.btn('导出对局记录').click(); await tick(); r.btn('JSON').click(); await tick();
  assert.match(exportModal(r).textContent, /暂无转换前事件；旧战报不会反推/); assert.equal(r.urls.length, 0); assert.equal(r.btn('JSON').disabled, true); assert.equal(writes(r).length, 0);
});

function clientHarness() {
  const pending = []; let active = 0, peak = 0;
  const context = { module: { exports: {} }, require: () => require('../js/battle-math.js'), Blob, AbortController, console,
    fetch: (url, options) => new Promise((resolve, reject) => { active++; peak = Math.max(peak, active); pending.push({ url, options, resolve(response) { active--; resolve(response); }, reject(error) { active--; reject(error); } }); }) };
  vm.runInNewContext(clientSource, context); return { api: context.module.exports, pending, get peak() { return peak; } };
}

test('opaque export is queued with existing maximum two transports, tracked immediately, and queued abort is read-only', async () => {
  const h = clientHarness(), a = h.api.request('/held-a'), b = h.api.request('/held-b'), abort = new AbortController();
  const exporting = h.api.exportSourceEvents('json', { signal: abort.signal, method: 'POST', redirect: 'follow' });
  const rejected = assert.rejects(exporting, { name: 'AbortError' }); let flushed = false; const flush = h.api.flush().then(result => { flushed = true; return result; }); await tick();
  assert.equal(flushed, false); assert.equal(h.pending.length, 2); abort.abort(); await rejected; assert.equal(await flush, false);
  h.pending[0].resolve(ok({})); h.pending[1].resolve(ok({})); await Promise.all([a,b]); await tick();
  const next = h.api.exportSourceEvents('ndjson', { method: 'POST', redirect: 'follow' }); await tick(); const job = h.pending.at(-1); assert.equal(job.options.method, 'GET'); assert.equal(job.options.redirect, 'error'); assert.equal(job.options.credentials, 'same-origin');
  job.resolve(downloadResponse('ndjson')); const result = await next; assert.equal(await result.blob.text(), raw + '\n'); assert.equal(h.peak, 2);
  assert.equal(h.pending.filter(job => job.url.includes('/export?')).length, 1);
});

test('streamed raw bytes retain uint64 and whitespace; streaming over-limit cancels without returning truncated output', async () => {
  const h = clientHarness(), bytes = Buffer.from(`[\n${raw}\n]`), chunks = [bytes.subarray(0, 13), bytes.subarray(13)];
  let released = 0, cancelled = 0, index = 0;
  const promise = h.api.exportSourceEvents('json'); await tick(); h.pending[0].resolve({ ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }, cancel: async () => { cancelled++; }, releaseLock: () => { released++; } }) }, json: async () => { throw Error('do not parse success source'); } });
  const result = await promise; assert.equal(await result.blob.text(), bytes.toString()); assert.equal(released, 1); assert.equal(cancelled, 0);
  const oversized = h.api.exportSourceEvents('ndjson'); const rejected = assert.rejects(oversized, /64 MiB/); await tick(); h.pending.at(-1).resolve({ ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: false, value: { byteLength: 64 * 1024 * 1024 + 1 } }), cancel: async () => { cancelled++; }, releaseLock: () => { released++; } }) } });
  await rejected; assert.equal(cancelled, 1); assert.equal(released, 2);
});

test('shared mutation barrier retains one explicit start then stop across remount-style consumers without retries', async () => {
  const h = clientHarness(), start = h.api.startRKPP(), stop = h.api.stopRKPP(); await tick(); assert.equal(h.pending.length, 1); assert.equal(h.pending[0].url, '/api/rkpp/status');
  let closed = false; const flush = h.api.flush().then(result => { closed = true; return result; }); h.pending[0].resolve(ok(status('stopped'))); await tick();
  assert.equal(h.pending[1].url, '/api/rkpp/start'); assert.equal(closed, false); h.pending[1].resolve(ok(status('starting'))); await tick(); assert.equal(h.pending[2].url, '/api/rkpp/stop'); assert.equal(closed, false);
  h.pending[2].resolve(ok(status('stopped'))); await Promise.all([start,stop]); assert.equal(await flush, true); assert.equal(h.pending.length, 3); assert.ok(h.peak <= 2);
});

test('all four narrow statistic headings have exact warning; every generic battle modal binds and releases right-close helper', async t => {
  const r = await mount(t);
  r.btn('样本统计').click(); await tick(); const warnings = r.all().filter(n => n.className === 'br-own-stats-warning');
  assert.equal(warnings.length, 4); assert.ok(warnings.every(n => n.textContent === '目前技能、个体、性格的统计还有问题，勉强可以参考'));
  assert.deepEqual(Array.from(warnings, n => n.parentNode.children[0].textContent).sort(), ['我方精灵统计', '我方阵容统计', '敌方精灵统计', '敌方阵容统计'].sort());
  for (const label of ['导出对局记录', '扫描采集记录', '阵容规则']) { r.btn(label).click(); await tick(); const binding = r.bindings.at(-1); assert.ok(binding.surface.isConnected); binding.surface.emit('contextmenu'); assert.equal(binding.surface.isConnected, false); assert.equal(binding.surface.listeners.contextmenu.length, 0); }
  r.btn('对战列表').click(); r.btn('查看详情').click(); await tick(); const detail = r.bindings.at(-1); detail.surface.emit('contextmenu'); assert.equal(detail.surface.isConnected, false); assert.equal(detail.surface.listeners.contextmenu.length, 0);
});
