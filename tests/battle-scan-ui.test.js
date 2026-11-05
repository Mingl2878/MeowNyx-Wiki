'use strict';
// Synthetic DOM and in-memory HTTP only: no browser, archive, profile, DB or server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const harnessPath = path.join(__dirname, 'battle-records-ui.test.js');
const source = fs.readFileSync(harnessPath, 'utf8');
const sandbox = { module: { exports: {} }, require: createRequire(harnessPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
// Reuse the existing DOM without registering its tests. The optional hook installs
// the real shared request queue to verify native-close flush, not a mock barrier.
vm.runInNewContext(source.slice(0, source.indexOf('\ntest(')).replace('  page.render(host);', '  custom.installClient?.(root, context);\n  page.render(host);') + '\nmodule.exports = runtime;', sandbox, { filename: harnessPath });
const runtime = sandbox.module.exports;
const clientSource = fs.readFileSync(path.join(__dirname, '../js/battle-records.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = body => ({ ok: true, json: async () => body });
const metadata = (path = 'C:/synthetic/rkpp', scanToken = 'synthetic-only-token') => ({ path, scanToken });
const result = (overrides = {}) => ({ path: 'C:/synthetic/rkpp', files: 2, completed: 2, imported: 1, updated: 1, unchanged: 0, pending: 0, ignored: 0, issues: [], ...overrides });
const scans = r => r.calls.filter(c => c.url === '/api/battles/scan');
const writes = r => scans(r).filter(c => c.options.method === 'POST');
const reads = r => scans(r).filter(c => !c.options.method || c.options.method === 'GET');
const queryCalls = r => r.calls.filter(c => /\/battles\/(list|stats)\?/.test(c.url));
const listCalls = r => queryCalls(r).filter(c=>c.url.includes('/list?'));
const statsCalls = r => queryCalls(r).filter(c=>c.url.includes('/stats?'));
const overlay = r => r.find(n => n.dataset.modalKind === 'scan');
const scanStatus = r => r.find(n => n.dataset.br === 'scan-status');
const typePath = (r, value) => { r.named('scanPath').value = value; r.named('scanPath').emit('input'); };
async function mount(t, custom = {}) { const r = runtime(custom); t.after(() => r.page.onLeave()); await tick(); return r; }
async function open(r) { r.btn('扫描采集记录').click(); await tick(); return overlay(r); }
function poll(r) {
  const next = [...r.timers.entries()][0]; assert.ok(next, 'Expected only the existing relay status timer');
  r.timers.delete(next[0]); next[1]();
}
function installClient(root, context) {
  vm.runInContext(clientSource, context); root.BattleRecordsClient = context.BattleRecordsClient;
}

test('startup, render, reconnect, polling and reopening never scan; path metadata is lazy', async t => {
  let connected = false;
  const r = await mount(t, { handle(url) {
    if (url.endsWith('/scan')) return response(metadata(''));
    if (url.endsWith('/relay/start')) { connected = true; return response({ state: 'running', received: 0, imported: 0, unsupported: 0 }); }
    if (url.endsWith('/relay/stop')) { connected = false; return response({ state: 'stopped', received: 0, imported: 0, unsupported: 0 }); }
    if (url.endsWith('/status')) return response({ state: connected ? 'running' : 'stopped', received: 0, imported: 0, unsupported: 0 });
  } });
  assert.equal(scans(r).length, 0); assert.equal(r.calls.length, 3);assert.equal(r.calls.some(c=>c.url.includes('/stats?')),false);
  assert.equal(r.btn('扫描采集记录').getClientRects().length, 1, 'Entry is visible outside collapsed relay details');
  r.page.render(r.host); await tick(); assert.equal(scans(r).length, 0);
  r.btn('连接中继').click(); await tick(); poll(r); await tick();
  r.btn('停止接入').click(); await tick(); r.btn('连接中继').click(); await tick();
  assert.equal(scans(r).length, 0);
  const queries = queryCalls(r).length;
  await open(r);
  assert.equal(reads(r).length, 1); assert.equal(writes(r).length, 0);
  assert.equal(r.named('scanPath').value, '', 'No production path default');
  assert.equal(r.root.document.activeElement, r.named('scanPath'));
  assert.equal(r.all(overlay(r)).filter(n => n.tagName === 'input').length, 1);
  assert.match(overlay(r).textContent, /只读取 opencode_summary\.csv 摘要，不读取密钥或 PCAP/);
  r.btn('开始扫描').click(); assert.equal(writes(r).length, 0); assert.match(overlay(r).textContent, /请输入/);
  typePath(r, 'C:/synthetic/runs'); r.root.document.emit('keydown', { key: 'Escape' });
  assert.equal(overlay(r), undefined); assert.equal(r.root.document.activeElement, r.btn('扫描采集记录'));
  await open(r); assert.equal(r.named('scanPath').value, 'C:/synthetic/runs');
  assert.equal(reads(r).length, 2); assert.equal(writes(r).length, 0);
  assert.equal(queryCalls(r).length, queries, 'Opening and reading metadata do not refresh data');
  r.btn('关闭').click(); r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick();
  assert.equal(writes(r).length, 0);
});

test('metadata authorization gates start, retries only GET and never exposes or persists the session token', async t => {
  let resolveMetadata;
  const r = await mount(t, { handle(url, options) {
    if (!url.endsWith('/scan')) return null;
    return options.method === 'POST' ? response(result({ imported: 0, updated: 0 })) : new Promise(resolve => { resolveMetadata = resolve; });
  } });
  await open(r); typePath(r, 'C:/synthetic/typed-before-metadata');
  assert.equal(r.btn('开始扫描').disabled, true); r.btn('开始扫描').emit('click'); assert.equal(writes(r).length, 0);
  resolveMetadata(response({ path: 'C:/synthetic/config', scanToken: '' })); await tick();
  assert.match(overlay(r).textContent, /无法读取扫描配置/); assert.equal(r.btn('开始扫描').disabled, true);
  r.btn('重试').click(); await tick(); assert.equal(reads(r).length, 2); assert.equal(writes(r).length, 0);
  resolveMetadata(response(metadata('C:/synthetic/config', 'first-session-token'))); await tick();
  assert.equal(r.named('scanPath').value, 'C:/synthetic/typed-before-metadata'); assert.equal(r.btn('开始扫描').disabled, false);
  assert.doesNotMatch(r.root.document.body.textContent, /first-session-token/);
  r.btn('开始扫描').click(); await tick(); assert.equal(writes(r)[0].options.headers['X-Battle-Scan-Token'], 'first-session-token');
  r.btn('关闭').click(); await open(r); assert.equal(r.btn('开始扫描').disabled, true);
  resolveMetadata(response(metadata('C:/synthetic/config', 'restarted-session-token'))); await tick();
  assert.equal(writes(r).length, 1); r.btn('开始扫描').click(); await tick();
  assert.equal(writes(r)[1].options.headers['X-Battle-Scan-Token'], 'restarted-session-token');
  assert.deepEqual(Object.keys(JSON.parse(writes(r)[1].options.body)), ['path']);
  assert.doesNotMatch(r.root.document.body.textContent, /(?:first|restarted)-session-token/);
});

test('explicit start sends one exact path POST, disables duplicate clicks and refreshes once on changes', async t => {
  let settle;
  const r = await mount(t, { handle(url, options) {
    if (!url.endsWith('/scan')) return null;
    return options.method === 'POST' ? new Promise(resolve => { settle = resolve; }) : response(metadata());
  } });
  await open(r); typePath(r, '  C:/synthetic/runs/run one/opencode_summary.csv  ');
  const before = queryCalls(r).length, button = r.btn('开始扫描');
  button.click(); button.click(); button.emit('click');
  assert.equal(writes(r).length, 1); assert.equal(r.tracked.length, 1);
  assert.deepEqual(JSON.parse(writes(r)[0].options.body), { path: 'C:/synthetic/runs/run one/opencode_summary.csv' });
  assert.equal(writes(r)[0].options.signal, undefined);
  assert.equal(writes(r)[0].options.headers['X-Battle-Scan-Token'], 'synthetic-only-token');
  assert.doesNotMatch(r.root.document.body.textContent, /synthetic-only-token/);
  assert.equal(button.disabled, true); assert.equal(r.named('scanPath').disabled, true);
  assert.match(scanStatus(r).textContent, /正在扫描/);
  const payload = result({ files: 6, completed: 4, imported: 2, updated: 1, unchanged: 1, pending: 2, ignored: 3, issues: ['合成摘要缺失字段'] });
  settle(response(payload)); await tick();
  assert.match(scanStatus(r).textContent, /文件 6 · 已完成对战 4 · 已导入 2 · 已更新 1 · 未变化 1 · 待完成 2 · 已忽略 3/);
  assert.match(overlay(r).textContent, /合成摘要缺失字段/);
  assert.equal(queryCalls(r).length, before + 1);assert.equal(listCalls(r).length,before+1);assert.equal(statsCalls(r).length,0);
  assert.equal(button.disabled, false); assert.equal(r.named('scanPath').disabled, false);
  await tick(); assert.equal(queryCalls(r).length, before + 1);assert.equal(listCalls(r).length,before+1);assert.equal(statsCalls(r).length,0);
  r.btn('关闭').click(); await open(r); assert.equal(writes(r).length, 1);
  assert.equal(r.named('scanPath').value, payload.path, 'Server-confirmed path is remembered');
  assert.equal(queryCalls(r).length, before + 1);assert.equal(listCalls(r).length,before+1);assert.equal(statsCalls(r).length,0);
});

test('root, runs, run directory and CSV paths pass through; unchanged replay never refreshes', async t => {
  let changed = false;
  const r = await mount(t, { handle(url, options) {
    if (!url.endsWith('/scan')) return null;
    return response(options.method === 'POST' ? result({ path: JSON.parse(options.body).path, imported: 0, updated: changed ? 1 : 0, unchanged: changed ? 1 : 2 }) : metadata(''));
  } });
  r.named('outcome').value = 'loss'; r.selectors[0].opts.onSelect({ id: 42 });
  r.submit(r.find(n => n.tagName === 'form' && n.getAttribute('aria-label') === '对战记录共享筛选')); await tick();
  await open(r); const before = queryCalls(r).length;
  for (const value of ['C:/synthetic/rkpp', 'C:/synthetic/rkpp/runs', 'C:/synthetic/rkpp/runs/run1', 'C:/synthetic/rkpp/runs/run1/opencode_summary.csv']) {
    typePath(r, value); r.btn('开始扫描').click(); await tick();
    assert.deepEqual(JSON.parse(writes(r).at(-1).options.body), { path: value });
  }
  assert.equal(queryCalls(r).length, before); assert.match(scanStatus(r).textContent, /已导入 0 · 已更新 0 · 未变化 2/);
  changed = true; r.btn('开始扫描').click(); await tick();
  assert.equal(queryCalls(r).length, before + 1);assert.equal(listCalls(r).length,before+1);assert.equal(statsCalls(r).length,0);
  for (const call of queryCalls(r).slice(-2)) { const query = new URL(call.url, 'http://synthetic.invalid').searchParams; assert.equal(query.get('outcome'), 'loss'); assert.equal(query.get('monsterId'), '42'); }
  assert.equal(r.named('outcome').value, 'loss');
  assert.match(r.find(n => n.dataset.br === 'import-filter-note').textContent, /已保留当前筛选.*若未显示.*时间范围/);
});

test('closed scan modal retains accepted write and page feedback without stale DOM updates', async t => {
  let settle;
  const r = await mount(t, { handle(url, options) {
    if (url.endsWith('/scan')) return options.method === 'POST' ? new Promise(resolve => { settle = resolve; }) : response(metadata('C:/synthetic/runs'));
  } });
  await open(r); r.btn('开始扫描').click();
  const oldOverlay = overlay(r), beforeClose = oldOverlay.textContent, before = queryCalls(r).length;
  r.btn('关闭').click(); await open(r);
  assert.equal(r.btn('开始扫描').disabled, true); assert.match(overlay(r).textContent, /正在扫描/);
  r.btn('开始扫描').emit('click'); assert.equal(writes(r).length, 1);
  r.btn('关闭').click(); settle(response(result())); await tick();
  assert.equal(oldOverlay.textContent, beforeClose, 'Completed write must not mutate detached modal');
  assert.match(scanStatus(r).textContent, /扫描完成/); assert.equal(queryCalls(r).length, before + 1);assert.equal(listCalls(r).length,before+1);assert.equal(statsCalls(r).length,0);
  await open(r); assert.equal(r.btn('开始扫描').disabled, false); assert.equal(writes(r).length, 1);
});

for (const sharedClient of [false, true]) test(`queued scan immediately joins ${sharedClient ? 'real shared' : 'fallback'} close barrier and survives route leave/reopen`, async t => {
  let blockQueries = false, settleScan;
  const heldReads = [];
  const r = await mount(t, { installClient: sharedClient ? installClient : undefined, handle(url, options) {
    if (/\/(list|stats)\?/.test(url) && blockQueries) return new Promise(resolve => heldReads.push(() => resolve(response(url.includes('/list?') ? { records: [], total: 0 } : { matchedBattles: 0 }))));
    if (url.endsWith('/scan')) return options.method === 'POST' ? new Promise(resolve => { settleScan = resolve; }) : response(metadata());
  } });
  r.btn('样本统计').click();await tick();await open(r);
  // Explicit Stats activation makes both list and Stats needed; after metadata
  // is ready, held cohort reads consume both real transport slots.
  blockQueries = true; r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选'));await tick();assert.equal(heldReads.length, 2);
  r.btn('开始扫描').click();
  assert.equal(writes(r).length, 0, 'Both transport slots are occupied; POST is queued');
  let closed = false;
  const flushing = (sharedClient ? r.root.BattleRecordsClient.flush() : Promise.all(r.tracked)).then(value => { closed = true; return value; });
  await tick(); assert.equal(closed, false);
  if (!sharedClient) assert.equal(r.tracked.length, 1, 'Queued fallback write is tracked now, not at fetch');
  const oldPage = r.host.children[0], oldModal = overlay(r), oldModalText = oldModal.textContent;
  r.page.onLeave(); const oldText = oldPage.textContent;
  blockQueries = false; r.page.render(r.host); await open(r);
  assert.equal(r.btn('开始扫描').disabled, true); assert.match(overlay(r).textContent, /正在扫描/);
  heldReads.forEach(resolve => resolve()); await tick();
  assert.equal(writes(r).length, 1); assert.equal(writes(r)[0].options.signal, undefined); assert.equal(closed, false);
  const before = queryCalls(r).length,listBefore=listCalls(r).length,statsBefore=statsCalls(r).length;
  settleScan(response(result())); await flushing; await tick();
  assert.equal(closed, true); assert.equal(r.btn('开始扫描').disabled, false);
  assert.match(scanStatus(r).textContent, /扫描完成/); assert.equal(queryCalls(r).length, before + 2,'opened Stats and list each refresh exactly once');assert.equal(listCalls(r).length,listBefore+1);assert.equal(statsCalls(r).length,statsBefore+1);
  assert.equal(oldPage.textContent, oldText); assert.equal(oldModal.textContent, oldModalText);
  assert.equal(writes(r).length, 1);
});

test('metadata generation guards reject stale closed-modal results and preserve typed path', async t => {
  const pending = [];
  const r = await mount(t, { handle(url) { if (url.endsWith('/scan')) return new Promise(resolve => pending.push(resolve)); } });
  await open(r); const first = overlay(r), firstText = first.textContent;
  r.btn('关闭').click(); await open(r); const current = r.named('scanPath');
  typePath(r, 'C:/synthetic/user-choice');
  pending[0](response(metadata('C:/synthetic/stale-old', 'stale-token'))); await tick();
  assert.equal(current.value, 'C:/synthetic/user-choice'); assert.equal(first.textContent, firstText);
  pending[1](response(metadata('C:/synthetic/stale-new', 'fresh-token'))); await tick();
  assert.equal(current.value, 'C:/synthetic/user-choice'); assert.equal(writes(r).length, 0);
  r.btn('关闭').click(); await open(r); assert.equal(r.named('scanPath').value, 'C:/synthetic/user-choice');
  pending[2](response(metadata())); await tick();
});

test('scan failures and issue messages stay text-safe and visible without automatic retry', async t => {
  const unsafe = '<img src=x onerror=evil()> <script>evil()</script>';
  let fail = true;
  const r = await mount(t, { handle(url, options) {
    if (!url.endsWith('/scan')) return null;
    if (options.method !== 'POST') return response(metadata('C:/synthetic/runs'));
    return fail ? { ok: false, status: 400, json: async () => ({ error: unsafe }) } : response(result({ imported: 0, updated: 0, issues: [{ code: 'fixture', message: unsafe }] }));
  } });
  await open(r); const before = queryCalls(r).length;
  r.btn('开始扫描').click(); await tick();
  assert.match(scanStatus(r).textContent, /<img src=x onerror=evil\(\)>/); assert.equal(r.btn('开始扫描').disabled, false);
  assert.equal(queryCalls(r).length, before); assert.equal(r.all(scanStatus(r)).some(n => ['img', 'script'].includes(n.tagName)), false);
  r.btn('关闭').click(); await open(r); assert.equal(writes(r).length, 1); assert.match(overlay(r).textContent, /<script>evil\(\)<\/script>/);
  fail = false; r.btn('开始扫描').click(); await tick();
  assert.equal(writes(r).length, 2); assert.equal(queryCalls(r).length, before); assert.match(overlay(r).textContent, /<img/);
  assert.equal(r.all(overlay(r)).some(n => ['img', 'script'].includes(n.tagName)), false);
});

test('relay polling establishes baseline and refreshes once only for successful import/update increases', async t => {
  let status = { state: 'running', received: 8450, imported: 4, updated: 2, ignored: 8446, pending: 1, unsupported: 0 };
  const r = await mount(t, { handle(url) { if (url.endsWith('/status')) return response(status); } });
  const before = queryCalls(r).length; assert.equal(before, 1, 'Initial nonzero counters only establish a baseline; Stats is not opened');
  const relay = () => r.find(n => n.className === 'br-relay-status');
  assert.match(relay().textContent, /已接收消息 8450 · 忽略非对战 8446 · 已写入 4（其中更新 2） · 待完成 1 · 不支持 0/);
  status = { ...status, received: 9000, ignored: 8996, pending: 2 }; poll(r); await tick();
  assert.equal(queryCalls(r).length, before);
  status = { ...status, imported: 5, updated: 3, pending: 1 }; poll(r); await tick();
  assert.equal(queryCalls(r).length, before + 1, 'Import and update changes in one status share one refresh');
  poll(r); await tick(); assert.equal(queryCalls(r).length, before + 1, 'Replayed status is a no-op');
  status = { ...status, imported: 0, updated: 0 }; poll(r); await tick(); assert.equal(queryCalls(r).length, before + 1, 'Counter reset does not refresh');
  status = { ...status, imported: 1, updated: 1 }; poll(r); await tick(); assert.equal(queryCalls(r).length, before + 2, 'First successful post-reset write refreshes once');
  assert.equal(scans(r).length, 0); assert.equal(r.calls.some(c => c.options.method), false);
});

test('legacy relay fields, late optional counters and errors never confuse received with success', async t => {
  const unsafe = '<img src=x onerror=evil()> parser failed';
  let status = { state: 'running', received: 8450, imported: 0, unsupported: 2, error: unsafe };
  const r = await mount(t, { handle(url) { if (url.endsWith('/status')) return response(status); } });
  const before = queryCalls(r).length, relay = () => r.find(n => n.className === 'br-relay-status');
  assert.match(relay().textContent, /已写入 0（其中更新 未知）.*待完成 未知.*不支持 2/);
  assert.match(relay().textContent, /接收消息不等于导入成功/); assert.match(relay().textContent, /parser failed/);
  assert.equal(r.all(relay()).some(n => n.tagName === 'img'), false);
  status = { ...status, received: 9999, updated: 0, ignored: 9000, pending: 2 }; poll(r); await tick();
  assert.equal(queryCalls(r).length, before, 'A newly available optional counter establishes its own baseline');
  status = { ...status, imported: 1 }; poll(r); await tick();
  assert.equal(queryCalls(r).length, before + 1);assert.equal(listCalls(r).length,before+1);assert.equal(statsCalls(r).length,0); assert.equal(scans(r).length, 0);
});
