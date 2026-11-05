'use strict';
// Actual runtime client plus actual battle-page action events; synthetic HTTP/DOM only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const clientSource = fs.readFileSync(require.resolve('../js/battle-records.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = body => ({ ok: true, status: 200, json: async () => body });
const failure = (status, error) => ({ ok: false, status, json: async () => ({ error }) });
const runtimeStatus = extra => ({ state: 'stopped', owned: false, connected: false, relayState: 'stopped', sessionToken: 'synthetic-rkpp-session', ...extra });
function client(fetch) {
  const box = { module: { exports: {} }, require: () => require('../js/battle-math.js'), fetch, AbortController };
  vm.runInNewContext(clientSource, box); return box.module.exports;
}
function transport() {
  const jobs = []; let active = 0, peak = 0;
  const api = client((url, options) => new Promise(resolve => {
    active++; peak = Math.max(peak, active);
    jobs.push({ url, options, resolve(body) { active--; resolve(response(body)); }, fail(status, error) { active--; resolve(failure(status, error)); } });
  }));
  return { api, jobs, get active() { return active; }, get peak() { return peak; } };
}

test('RKPP methods get an in-memory session then POST fixed URLs with credentials and no arbitrary command/body', async () => {
  const h = transport(), start = h.api.startRKPP({ url: 'http://remote.invalid', command: 'forbidden' }); await tick();
  assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].url, '/api/rkpp/status'); assert.equal(h.jobs[0].options.method, 'GET');
  h.jobs[0].resolve(runtimeStatus()); await tick(); assert.equal(h.jobs.length, 2);
  const post = h.jobs[1]; assert.equal(post.url, '/api/rkpp/start'); assert.equal(post.options.method, 'POST');
  assert.deepEqual(JSON.parse(post.options.body), {}); assert.equal(post.options.headers['X-RKPP-Session-Token'], 'synthetic-rkpp-session');
  for (const job of h.jobs) { assert.equal(job.options.credentials, 'same-origin'); assert.equal(job.options.cache, 'no-store'); assert.equal(job.options.redirect, 'error'); }
  assert.equal(post.options.signal, undefined); post.resolve(runtimeStatus({ state: 'running', owned: true, connected: true })); await start;
  const stop = h.api.stopRKPP(); await tick(); assert.equal(h.jobs.length, 3, 'cached session does not need another GET');
  assert.equal(h.jobs[2].url, '/api/rkpp/stop'); h.jobs[2].resolve(runtimeStatus()); await stop; assert.equal(await h.api.flush(), true);
});

test('prerequisite GET and ordered start/stop share max-two queue, and both mutations are tracked before a slot frees', async () => {
  const h = transport(), first = h.api.request('/api/battles/list'), second = h.api.request('/api/battles/stats');
  const start = h.api.startRKPP(), stop = h.api.stopRKPP(); let closed = false;
  const flush = h.api.flush().then(result => { closed = true; return result; }); await tick(); assert.equal(closed, false); assert.equal(h.jobs.length, 2);
  h.jobs[0].resolve({}); await tick(); assert.equal(h.jobs[2].url, '/api/rkpp/status'); assert.equal(closed, false);
  h.jobs[2].resolve(runtimeStatus()); await tick(); assert.equal(h.jobs[3].url, '/api/rkpp/start'); assert.equal(h.jobs.some(job => job.url.endsWith('/stop')), false);
  h.jobs[3].resolve(runtimeStatus({ state: 'running', owned: true, connected: true })); await start; await tick();
  assert.equal(h.jobs[4].url, '/api/rkpp/stop'); assert.equal(closed, false); h.jobs[4].resolve(runtimeStatus()); await stop;
  assert.equal(await flush, true); h.jobs[1].resolve({}); await Promise.all([first, second]); assert.equal(h.peak, 2);
});

test('missing session and guarded HTTP failure do not retry/start or acknowledge a successful mutation', async () => {
  const h = transport(), start = h.api.startRKPP(); const rejected = assert.rejects(start, /会话尚未就绪/); const flush = h.api.flush(); await tick();
  h.jobs[0].resolve({ state: 'stopped' }); await rejected; assert.equal(await flush, false); assert.equal(h.jobs.length, 1);
  const retry = h.api.startRKPP(), guarded = assert.rejects(retry, /synthetic forbidden/); const retryFlush = h.api.flush(); await tick();
  h.jobs[1].resolve(runtimeStatus()); await tick(); h.jobs[2].fail(403, 'synthetic forbidden'); await guarded;
  assert.equal(await retryFlush, false); await tick(); assert.equal(h.jobs.length, 3, 'no automatic retry'); assert.equal(await h.api.flush(), true);
});

const harnessPath = path.join(__dirname, 'battle-records-ui.test.js');
const harnessSource = fs.readFileSync(harnessPath, 'utf8');
const harnessBox = { module: { exports: {} }, require: createRequire(harnessPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
vm.runInNewContext(harnessSource.slice(0, harnessSource.indexOf('\ntest(')) + '\nmodule.exports=runtime;', harnessBox, { filename: harnessPath });
async function mounted(t, handle) {
  const r = harnessBox.module.exports({ handle }); await tick(); r.page.onLeave();
  r.root.BattleRecordsClient = client((...args) => r.root.fetch(...args)); r.page.render(r.host); await tick();
  t.after(() => r.page.onLeave()); return r;
}
const mutations = r => r.calls.filter(call => call.options.method === 'POST');
const receiver = extra => ({ state: 'stopped', received: 0, imported: 0, updated: 0, ignored: 0, pending: 0, unsupported: 0, ...extra });

test('actual 启动 event launches server runtime, ignores manual URL, claims connected only from runtime, then 停止 calls stop API', async t => {
  let current = runtimeStatus(), relay = receiver(), resolveStart;
  const r = await mounted(t, (url, options) => {
    if (url === '/api/rkpp/status') return response(current);
    if (url === '/api/rkpp/start') return new Promise(resolve => { resolveStart = () => { current = runtimeStatus({ state: 'running', owned: true, connected: false, relayState: 'connecting' }); relay = receiver({ state: 'connecting' }); resolve(response(current)); }; });
    if (url === '/api/rkpp/stop') { current = runtimeStatus(); relay = receiver(); return response(current); }
    if (url === '/api/battles/status') return response(relay);
  });
  assert.equal(mutations(r).length, 0); assert.equal(r.named('relayURL').value, 'http://127.0.0.1:18765');
  r.named('relayURL').value = 'http://127.0.0.1:19999'; r.named('relayURL').reportValidity = () => false;
  r.btn('启动').click(); r.btn('启动').click(); await tick(); assert.equal(mutations(r).length, 1);
  assert.equal(mutations(r)[0].url, '/api/rkpp/start'); assert.equal(mutations(r)[0].options.headers['X-RKPP-Session-Token'], current.sessionToken);
  assert.deepEqual(JSON.parse(mutations(r)[0].options.body), {}); assert.equal(r.btn('停止').disabled, true);
  resolveStart(); await r.root.BattleRecordsClient.flush(); await tick();
  assert.match(r.host.textContent, /接入尚未连接/); assert.doesNotMatch(r.host.textContent, /接入已连接/);
  current = runtimeStatus({ state: 'running', owned: true, connected: true, relayState: 'running' }); relay = receiver({ state: 'running' });
  r.btn('刷新状态').click(); await tick(); assert.match(r.host.textContent, /接入已连接/);
  assert.equal(r.btn('启动').disabled, true); r.btn('停止').click(); await r.root.BattleRecordsClient.flush(); await tick();
  assert.deepEqual(Array.from(mutations(r), call => call.url), ['/api/rkpp/start', '/api/rkpp/stop']); assert.equal(r.btn('启动').disabled, false);
});

test('manual existing relay connection retains original URL API; stop of an external runtime only sends runtime stop', async t => {
  let current = runtimeStatus({ state: 'running', owned: false }), relay = receiver();
  const r = await mounted(t, (url, options) => {
    if (url === '/api/rkpp/status') return response(current);
    if (url === '/api/battles/status') return response(relay);
    if (url === '/api/battles/relay/start') { relay = receiver({ state: 'running' }); return response(relay); }
    if (url === '/api/rkpp/stop') { current = runtimeStatus({ state: 'running', owned: false }); relay = receiver(); return response(current); }
  });
  assert.equal(r.btn('停止').disabled, false, 'external runtime is stoppable by disconnect, not browser kill');
  r.named('relayURL').value = 'http://127.0.0.1:19999'; r.btn('连接中继').click(); await tick();
  assert.equal(mutations(r)[0].url, '/api/battles/relay/start'); assert.deepEqual(JSON.parse(mutations(r)[0].options.body), { url: 'http://127.0.0.1:19999' });
  r.btn('停止').click(); await r.root.BattleRecordsClient.flush(); await tick();
  assert.equal(mutations(r)[1].url, '/api/rkpp/stop'); assert.equal(mutations(r).some(call => call.url === '/api/battles/relay/stop'), false);
});

test('runtime action failure remains visible and leaving does not abort or paint a late mutation', async t => {
  let resolveStart, fail = true;
  const r = await mounted(t, (url, options) => {
    if (url === '/api/rkpp/status') return response(runtimeStatus());
    if (url === '/api/rkpp/start') return fail ? failure(500, 'synthetic runtime failure') : new Promise(resolve => { resolveStart = resolve; });
    if (url === '/api/battles/status') return response(receiver());
  });
  r.btn('启动').click(); await tick(); assert.match(r.host.textContent, /synthetic runtime failure/); assert.equal(r.btn('启动').disabled, false);
  fail = false; r.btn('启动').click(); await tick(); const pendingPost = mutations(r).at(-1); const flush = r.root.BattleRecordsClient.flush();
  r.page.onLeave(); const before = r.host.textContent; assert.equal(pendingPost.options.signal, undefined);
  resolveStart(response(runtimeStatus({ state: 'running', owned: true, connected: true }))); assert.equal(await flush, true); await tick();
  assert.equal(r.host.textContent, before); assert.equal(mutations(r).length, 2);
});
