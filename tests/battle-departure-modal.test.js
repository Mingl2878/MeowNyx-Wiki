'use strict';
// DOM-only chart/lifecycle regression tests. Reuse the isolated harness setup;
// no browser control, third-party package, live API, DB, relay or profile IO.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const setupPath = path.join(__dirname, 'battle-performance-ui.test.js');
const setup = fs.readFileSync(setupPath, 'utf8');
const sandbox = { module: { exports: {} }, require: createRequire(setupPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
vm.runInNewContext(setup.slice(0, setup.indexOf('\ntest(')) + '\nmodule.exports = { runtime, fixture, performanceFixture, catalogue, freeze };', sandbox, { filename: setupPath });
const { runtime, fixture, performanceFixture, catalogue, freeze } = sandbox.module.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = body => ({ ok: true, json: async () => body });
const nodes = (r, cls, host) => r.all(host).filter(node => node.className.split(' ').includes(cls));
const overlay = r => nodes(r, 'br-modal-root')[0];
const body = r => nodes(r, 'br-dialog-body')[0];
const dialog = r => nodes(r, 'br-dialog')[0];
const charts = r => nodes(r, 'br-departure-reason');
const shapes = (r, host = body(r)) => r.all(host).filter(node => ['path', 'circle'].includes(node.tagName));
const legends = (r, host = body(r)) => nodes(r, 'br-departure-legend', host);
async function mount(t, options = {}) {
  const r = runtime({ stats: { ...fixture(performanceFixture()), selfSkills: [] }, data: catalogue, ...options });
  // Native SVG namespace support in this test's local DOM only, not the shared
  // existing harness or production code. Attribute values remain literal text.
  r.root.document.createElementNS = (namespace, tag) => { const node = r.root.document.createElement(tag); node.namespaceURI = namespace; return node; };
  t.after(() => r.page.onLeave()); await tick(); r.btn('样本统计').click(); await tick(); return r;
}
async function opened(t, options = {}) { const r = await mount(t, options); r.btn('精灵详情').click(); return r; }
const count = (monsterId, attribution, totals, averages = {}) => ({ monsterId, attribution, totals, averages });

test('departure text trigger retains native keyboard activation without shared button appearance', async t => {
  const r = await mount(t), trigger = r.btn('精灵详情');
  // A real native type=button supplies Enter/Space click activation; the DOM
  // harness deliberately does not pretend to be a browser keyboard engine.
  assert.equal(trigger.tagName, 'button'); assert.equal(trigger.type, 'button'); assert.equal(trigger.tabIndex, 0);
  assert.equal(trigger.className, 'br-departure-open'); assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(trigger.listeners.keydown, undefined, 'do not double-activate native Enter/Space');
  trigger.focus(); trigger.click(); r.root.document.emit('keydown', { key: 'Escape' }); assert.equal(r.root.document.activeElement, trigger);
  assert.equal(r.btn('刷新数据'),undefined);assert.ok(r.btn('重置筛选').className.includes('btn-secondary')); assert.ok(r.btn('导入 JSON / NDJSON').className.includes('btn-primary'));
  const css = fs.readFileSync(path.join(__dirname, '../css/battle-records.css'), 'utf8');
  const rule = css.match(/:is\(\.battle-records-page, \.br-modal-root\) \.br-departure-open\s*\{([^}]+)\}/)[1];
  for (const declaration of [/all: unset/, /border: 0/, /background: none/, /padding: 0/, /font: inherit/, /cursor: pointer/]) assert.match(rule, declaration);
  assert.match(css, /\.br-departure-open:is\(:hover, :focus-visible\)\s*\{[^}]*text-decoration: underline/);
  assert.match(css, /\.br-departure-open:focus-visible\s*\{[^}]*text-decoration-thickness: 2px/);
  assert.doesNotMatch(css, /\.btn[^{}]*br-departure-open|br-departure-open[^{}]*\.btn/);
});

test('departure text opens one page CSS modal with three reason-first cumulative pies and no extra request', async t => {
  const performance = performanceFixture(), before = JSON.stringify(performance), r = await mount(t, { stats: freeze({ ...fixture(performance), selfSkills: [] }) });
  const calls = r.calls.length, trigger = r.btn('精灵详情'); trigger.focus(); trigger.click();
  assert.equal(overlay(r).parentNode, r.root.document.body); assert.equal(overlay(r).dataset.modalKind, 'departures');
  assert.equal(dialog(r).getAttribute('role'), 'dialog'); assert.equal(dialog(r).getAttribute('aria-modal'), 'true');
  assert.equal(body(r).dataset.br, 'departures'); assert.equal(body(r).getAttribute('aria-label'), '精灵技能使用与离场原因');
  assert.equal(r.root.document.activeElement, r.btn('关闭')); assert.equal(r.calls.length, calls);
  assert.deepEqual(Array.from(charts(r), chart => chart.dataset.reason), ['defeat', 'forced', 'self']);
  assert.deepEqual(Array.from(charts(r), chart => chart.children[0].textContent), ['被击杀', '被迫离场', '自行离场']);
  assert.deepEqual(Array.from(charts(r), chart => chart.dataset.total), ['1', '1', '2']);
  assert.equal(shapes(r).length, 3); assert.ok(shapes(r).every(shape => shape.tagName === 'circle'));
  assert.ok(shapes(r).every(shape => shape.getAttribute('r') === '96' && ['1', '2'].includes(shape.getAttribute('data-count'))));
  for (const svg of r.all(body(r)).filter(n => n.tagName === 'svg')) { assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg'); assert.equal(svg.getAttribute('role'), 'img'); assert.ok(svg.getAttribute('aria-label')); assert.equal(svg.getAttribute('viewBox'), '0 0 200 200'); }
  assert.match(legends(r)[0].textContent, /来源：正确形态 · 1 次 · 100\.0%/);
  assert.match(legends(r)[2].textContent, /当时面对：<img>敌方形态 · 2 次 · 100\.0%/);
  assert.doesNotMatch(body(r).textContent, /原因未知|自身原因|被强制换下/);
  assert.equal(r.all(body(r)).some(n => ['details', 'input', 'select', 'textarea'].includes(n.tagName)), false);assert.ok(r.all(body(r)).filter(n=>n.tagName==='img').every(n=>n.src.startsWith('assets/monster/images/')));assert.equal(r.all(body(r)).filter(n=>n.tagName==='img').length,3);
  trigger.click(); assert.equal(nodes(r, 'br-modal-root').length, 1); assert.equal(r.calls.length, calls);
  assert.equal(JSON.stringify(performance), before); assert.equal(r.calls.some(c => c.options.method || /\/record\?|profile/.test(c.url)), false);
});

test('segments use exact positive backend cumulative counts, merge species per reason, and ignore averages/unknown reasons', async t => {
  const performance = performanceFixture(), row = performance.species[0];
  row.departuresByOpponent = [count(35, 'cause', { defeat: 2, unknown: 800 }, { defeat: 99 }), count(35, 'cause', { defeat: 1 }), count(42, 'cause', { defeat: 1 }), count(42, 'facing', { self: 4, unknown: 999 }, { self: 1000 })];
  const r = await opened(t, { stats: freeze({ ...fixture(performance), selfSkills: [] }) }), groups = charts(r);
  assert.deepEqual(Array.from(groups, group => group.dataset.reason), ['defeat', 'self']);
  assert.deepEqual(Array.from(groups, group => group.dataset.total), ['4', '4']);
  const slices = shapes(r, groups[0]); assert.equal(slices.length, 2); assert.ok(slices.every(slice => slice.tagName === 'path'));
  assert.deepEqual(Array.from(slices, slice => slice.getAttribute('data-count')), ['3', '1']);
  assert.match(slices[0].getAttribute('d'), / A 96 96 0 1 1 /); assert.match(slices[1].getAttribute('d'), / A 96 96 0 0 1 /);
  // A 75% clockwise slice from twelve o'clock ends at nine o'clock.
  const coordinates = slices[0].getAttribute('d').match(/L ([\d.e+-]+) ([\d.e+-]+) A 96 96 0 1 1 ([\d.e+-]+) ([\d.e+-]+)/).slice(1).map(Number);
  for (const [i, value] of [100, 4, 4, 100].entries()) assert.ok(Math.abs(coordinates[i] - value) < 1e-9);
  assert.match(legends(r, groups[0])[0].textContent, /正确形态 · 3 次 · 75\.0%.*敌方形态 · 1 次 · 25\.0%/);
  const original = body(r).textContent, originalShapes = shapes(r), calls = r.calls.length;
  r.btn('场均').click(); assert.equal(body(r).textContent, original); assert.deepEqual(shapes(r), originalShapes); assert.equal(r.calls.length, calls);
  r.btn('关闭').click(); r.btn('精灵详情').click(); assert.equal(body(r).textContent, original);
});

test('cause and facing semantics stay distinct for same species; unknown attribution never borrows identity', async t => {
  const performance = performanceFixture(), row = performance.species[0];
  row.departuresByOpponent = [count(42, 'cause', { defeat: 2, forced: 1 }), count(42, 'facing', { self: 2 }),
    count(42, 'unknown', { defeat: 1 }), count(42, undefined, { defeat: 1 }), count(0, 'cause', { defeat: 1 }), count(999, 'cause', { defeat: 1 }), count(35, 'facing', { defeat: 1 }), count(35, 'cause', { self: 1 })];
  const before = JSON.stringify(performance), r = await opened(t, { stats: freeze({ ...fixture(performance), selfSkills: [] }) });
  const defeat = charts(r)[0], self = charts(r)[2];
  const entries = legends(r, defeat)[0].children;
  assert.equal(defeat.dataset.total, '7');
  assert.deepEqual(Array.from(entries, item => [item.dataset.opponentId, item.dataset.attribution]), [['42', 'cause'], ['0', 'unknown'], ['999', 'cause']]);
  assert.match(entries[0].textContent, /来源：<img>敌方形态 · 2 次/); assert.match(entries[1].textContent, /来源：未确认精灵 · 4 次/); assert.match(entries[2].textContent, /来源：未确认精灵 · 1 次/);
  assert.match(self.textContent, /当时面对.*敌方形态 · 2 次/); assert.doesNotMatch(self.textContent, /来源|强制|被此精灵/);
  assert.match(self.textContent, /当时面对：未确认精灵 · 1 次/);for(const legend of legends(r))for(const item of legend.children){const images=r.all(item).filter(n=>n.tagName==='img');if(item.dataset.opponentId==='0'||item.dataset.opponentId==='999')assert.equal(images.length,0,'unknown attribution/unmapped species cannot borrow an avatar');else assert.ok(images.every(n=>n.src==='assets/monster/images/'+encodeURIComponent('敌方头像.png')));}
  assert.equal(JSON.stringify(performance), before);
});

test('no negative, nonfinite, missing, fractional, string or zero count produces a fake pie', async t => {
  const performance = performanceFixture(), row = performance.species[0];
  row.departuresByOpponent = [null, ...[undefined, null, 0, -1, Infinity, NaN, '2', .5].map(value => count(35, 'cause', { defeat: value, forced: value, unknown: 20 }, { self: 50 })), count(42, 'unknown', { unknown: 99 })];
  const r = await opened(t, { stats: freeze({ ...fixture(performance), selfSkills: [] }) });
  assert.equal(charts(r).length, 0); assert.equal(shapes(r).length, 0); assert.equal(r.all(body(r)).some(n => n.tagName === 'svg'), false);
  assert.match(body(r).textContent, /暂无已确认原因的对手离场明细/);
  const unsafe = performanceFixture(); unsafe.species[0].departuresByOpponent = [count(35, 'cause', { defeat: Number.MAX_SAFE_INTEGER }), count(42, 'cause', { defeat: 1 })];
  const overflow = await opened(t, { stats: { ...fixture(unsafe), selfSkills: [] } }); assert.equal(shapes(overflow).length, 0); assert.match(body(overflow).textContent, /累计次数不可用，未绘制占比/);
});

test('literal malicious labels stay SVG text/legend text, never markup, URLs or attributes', async t => {
  const performance = performanceFixture(), label = '\"><script>alert(1)</script><svg onload="evil()">&';
  const r = await opened(t, { stats: freeze({ ...fixture(performance), selfSkills: [] }), data: { ...catalogue, getMonsterDisplayName: () => label } });
  assert.ok(body(r).textContent.includes(label)); assert.equal(r.all(body(r)).some(n => ['script', 'foreignObject'].includes(n.tagName)), false);assert.ok(r.all(body(r)).filter(n=>n.tagName==='img').every(n=>n.src.startsWith('assets/monster/images/')&&!n.src.includes(label)));
  for (const shape of shapes(r)) { assert.ok(shape.children[0].textContent.includes(label)); assert.equal(shape.children[0].tagName, 'title'); assert.equal(shape.children[0].children.length, 0); }
  for (const node of r.all(body(r))) for (const [key, value] of Object.entries(node.attrs)) { assert.doesNotMatch(key, /^on|href|src/); if (['d', 'fill', 'cx', 'cy', 'r', 'viewBox'].includes(key)) assert.ok(!value.includes(label)); }
});

test('close button/Escape/backdrop focus loop and exact inert/scroll restoration share detail lifecycle', async t => {
  const r = await mount(t), doc = r.root.document, page = nodes(r, 'battle-records-page')[0], trigger = r.btn('精灵详情');
  const preexisting = doc.createElement('aside'); preexisting.inert = true; preexisting.setAttribute('aria-hidden', 'false'); doc.body.append(preexisting);
  r.host.inert = false; page.scrollTop = 231; page.scrollLeft = 9; page.style.setProperty('overflow', 'auto', 'important'); doc.body.style.setProperty('overflow', 'clip');
  trigger.focus(); trigger.click(); const close = r.btn('关闭'), region = body(r);
  assert.equal(r.host.inert, true); assert.equal(r.host.getAttribute('aria-hidden'), 'true'); assert.equal(page.style.getPropertyValue('overflow'), 'hidden');
  close.focus(); assert.equal(doc.emit('keydown', { key: 'Tab', shiftKey: true }).defaultPrevented, true); assert.equal(doc.activeElement, region);
  assert.equal(doc.emit('keydown', { key: 'Tab' }).defaultPrevented, true); assert.equal(doc.activeElement, close);
  region.focus(); assert.equal(doc.emit('keydown', { key: 'PageDown' }).defaultPrevented, undefined); assert.equal(doc.activeElement, region);
  trigger.focus(); assert.equal(doc.activeElement, close); overlay(r).emit('click', { target: dialog(r) }); assert.ok(overlay(r));
  doc.emit('keydown', { key: 'Escape' }); assert.equal(overlay(r), undefined); assert.equal(doc.activeElement, trigger);
  assert.equal(r.host.inert, false); assert.equal(r.host.getAttribute('aria-hidden'), null); assert.equal(preexisting.inert, true); assert.equal(preexisting.getAttribute('aria-hidden'), 'false');
  assert.equal(page.style.getPropertyValue('overflow'), 'auto'); assert.equal(page.style.getPropertyPriority('overflow'), 'important'); assert.equal(page.scrollTop, 231); assert.equal(page.scrollLeft, 9); assert.equal(doc.body.style.getPropertyValue('overflow'), 'clip');
  trigger.click(); overlay(r).emit('click'); assert.equal(overlay(r), undefined); assert.equal(doc.activeElement, trigger);
  trigger.click(); r.btn('关闭').click(); assert.equal(overlay(r), undefined); assert.equal(doc.listeners.keydown.length, 0); assert.equal(doc.listeners.focusin.length, 0);
});

test('responsive SVG uses fixed viewBox and fluid CSS, without resize handlers, chart globals or new dependencies', async t => {
  const r = await opened(t), original = shapes(r), calls = r.calls.length;
  r.root.innerWidth = 320; r.root.document.emit('resize'); assert.deepEqual(shapes(r), original); assert.equal(r.calls.length, calls);
  r.root.innerWidth = 1440; r.root.document.emit('resize'); assert.deepEqual(shapes(r), original);
  const source = fs.readFileSync(path.join(__dirname, '../js/pages/battle-records.js'), 'utf8'), css = fs.readFileSync(path.join(__dirname, '../css/battle-records.css'), 'utf8');
  assert.match(source, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg'/);
  assert.doesNotMatch(source, /echarts|Chart\.|window\.open|showModal\(|\.innerHTML\s*=|localStorage\.|UserConfig\./);
  assert.match(css, /\.br-departure-charts\s*\{[^}]*minmax\(min\(100%, 360px\)/);
  assert.match(css, /\.br-departure-pie\s*\{[^}]*max-width: 100%;[^}]*height: auto;[^}]*aspect-ratio: 1/);
  assert.match(css, /\.br-departure-chart\s*\{[^}]*flex-wrap: wrap/);
});

test('refreshed stats clear stale charts, repaint existing modal and restore focus to replacement trigger', async t => {
  let current = { ...fixture(performanceFixture()), selfSkills: [] }, waitStats = null;
  const r = await opened(t, { handle: url => url.includes('/stats?') ? waitStats ? new Promise(resolve => { waitStats.resolve = resolve; }) : response(current) : null });
  const firstOverlay = overlay(r), oldTrigger = r.btn('精灵详情');
  const next = performanceFixture(); next.species[0].departuresByOpponent = [count(42, 'facing', { self: 7 })]; current = fixture(next); waitStats = {};
  const calls = r.calls.length; r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick();
  assert.equal(overlay(r), firstOverlay); assert.equal(shapes(r).length, 0); assert.equal(body(r).getAttribute('aria-busy'), 'true'); assert.match(body(r).textContent, /正在核对当前统计版本/);
  waitStats.resolve(response(current)); await tick(); assert.equal(overlay(r), firstOverlay); assert.equal(body(r).getAttribute('aria-busy'), 'false');
  assert.equal(charts(r).length, 1); assert.equal(charts(r)[0].dataset.reason, 'self'); assert.equal(charts(r)[0].dataset.total, '7');
  assert.equal(r.calls.slice(calls).filter(c=>c.url.includes('/list?')).length,1);assert.equal(r.calls.slice(calls).filter(c=>c.url.includes('/stats?')).length,1);assert.equal(r.calls.slice(calls).filter(c=>c.url.endsWith('/revision')).length,1); assert.equal(r.calls.some(call => call.options.method || /\/record\?|profile/.test(call.url)), false);
  const newTrigger = r.btn('精灵详情'); assert.notEqual(oldTrigger, newTrigger); r.btn('关闭').click(); assert.equal(r.root.document.activeElement, newTrigger);
  newTrigger.click(); assert.equal(charts(r)[0].dataset.total, '7');
});

test('failed refresh shows modal retry without stale data; removal closes and late responses cannot reopen', async t => {
  let fail = false, current = { ...fixture(performanceFixture()), selfSkills: [] };
  const r = await opened(t, { handle: url => url.includes('/stats?') ? fail ? { ok: false, json: async () => ({ error: '<script>stats failed</script>' }) } : response(current) : null });
  fail = true; r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); assert.equal(shapes(r).length, 0); assert.match(body(r).textContent, /stats failed/); assert.equal(body(r).getAttribute('aria-busy'), 'false');
  assert.equal(r.all(body(r)).some(n => n.tagName === 'script'), false); fail = false;
  r.all(body(r)).find(n => n.tagName === 'button' && n.textContent === '重试').click(); await tick(); assert.equal(charts(r).length, 3);
  current = fixture({ species: [] }); r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); assert.equal(overlay(r), undefined); assert.equal(r.root.document.activeElement, r.btn('我方样本统计'));
  let pending;
  const late = await opened(t, { handle: url => url.includes('/stats?') && pending ? new Promise(resolve => { pending.resolve = resolve; }) : null });
  pending = {}; late.submit(late.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); late.btn('关闭').click(); pending.resolve(response({ ...fixture(performanceFixture()), selfSkills: [] })); await tick(); assert.equal(overlay(late), undefined);
});

test('detail and departure share one overlay and stale detail fetch cannot paint chart modal', async t => {
  let resolveDetail;
  const r = await mount(t, { handle: url => url.includes('/record?') ? new Promise(resolve => { resolveDetail = resolve; }) : null });
  r.btn('查看详情').click(); const get = r.calls.find(c => c.url.includes('/record?'));
  assert.equal(overlay(r).dataset.modalKind, 'detail'); r.btn('精灵详情').click();
  assert.equal(overlay(r).dataset.modalKind, 'departures'); assert.equal(nodes(r, 'br-modal-root').length, 1); assert.equal(get.options.signal.aborted, true);
  const text = body(r).textContent; resolveDetail(response({ id: 'stale', events: [] })); await tick(); assert.equal(body(r).textContent, text);
  r.btn('查看详情').click(); assert.equal(overlay(r).dataset.modalKind, 'detail'); assert.equal(nodes(r, 'br-modal-root').length, 1); assert.equal(charts(r).length, 0);
  resolveDetail(response({ id: 'fresh', events: [] })); await tick(); assert.equal(r.btn('用于伤害计算'),undefined);assert.equal(r.root.handoff,undefined);assert.equal(r.root.location.hash,'');assert.ok(r.find(n=>n.className==='br-rounds'));
});

test('leave removes charts, traps, tooltips and locks; retained stale triggers and remount do not resurrect them', async t => {
  const r = await mount(t), doc = r.root.document, trigger = r.btn('精灵详情');
  nodes(r, 'br-pet-line')[0].focus(); assert.equal(nodes(r, 'br-pet-tooltip').length, 1);
  trigger.click(); assert.equal(nodes(r, 'br-pet-tooltip').length, 0); assert.equal(r.layerBindings.size, 0);
  const calls = r.calls.length; r.page.onLeave();
  assert.equal(overlay(r), undefined); assert.equal(doc.listeners.keydown.length, 0); assert.equal(doc.listeners.focusin.length, 0); assert.equal(r.timers.size, 0); assert.equal(r.layerBindings.size, 0); assert.equal(r.host.getAttribute('aria-hidden'), null);
  trigger.click(); assert.equal(overlay(r), undefined); assert.equal(r.calls.length, calls);
  r.page.render(r.host); await tick(); assert.equal(overlay(r), undefined); trigger.click(); assert.equal(overlay(r), undefined);
  r.btn('精灵详情').click(); assert.equal(charts(r).length, 3);
});
