'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const common = fs.readFileSync(require.resolve('../js/common.js'), 'utf8');
const chart = fs.readFileSync(require.resolve('../js/pages/chart.js'), 'utf8');
const math = vm.runInNewContext(chart.split('const ChartPage =')[0] + '\nChartFavoriteMath;');
const settle = () => new Promise(r => setImmediate(r));

function runtime() {
  const requests = [], events = [], writes = [], listeners = new Map();
  const context = {
    document: { documentElement: { style: { setProperty() {} } }, body: { style: {} } },
    localStorage: { getItem: () => null, setItem: (...args) => writes.push(args) },
    CustomEvent: function(type, init) { this.type = type; this.detail = init.detail; },
    fetch: (url, options) => {
      if (url === '/api/settings') return Promise.reject(new Error('isolated fixture'));
      return new Promise(resolve => requests.push({ url, options, resolve }));
    },
    addEventListener: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
    },
    dispatchEvent: e => events.push(e)
  };
  context.window = context;
  vm.runInNewContext(common, context);
  return { requests, events, writes, listeners, prefs: context.AppPreferences, context,
    ui: vm.runInNewContext(common.slice(common.indexOf('const CommonUI')) + '\nCommonUI;', {}),
    resize: () => listeners.get('resize').forEach(cb => cb()),
    reply: (index, maximized, ok = true) => requests[index].resolve({ ok, json: async () => ({ maximized }) })
  };
}

test('native state snapshots initialize once, are read-only, and only actual state changes notify', async () => {
  const r = runtime();
  assert.deepEqual(JSON.parse(JSON.stringify(r.prefs.getWindowState())), { maximized: false, initialized: false });
  assert.equal(r.listeners.get('resize').length, 1);
  assert.ok(Object.isFrozen(r.prefs.getWindowState()));
  r.reply(0, false); await settle();
  assert.equal(r.prefs.getWindowState().initialized, true);
  const initial = r.prefs.getWindowState();
  r.resize(); r.reply(1, false); await settle();
  assert.equal(r.events.filter(e => e.type === 'appwindowstatechange').length, 1);
  r.resize(); r.reply(2, true); await settle();
  assert.equal(r.prefs.isMaximized(), true);
  assert.equal(initial.maximized, false, 'detached stored snapshot does not mutate');
  r.resize(); r.reply(3, true); await settle();
  r.resize(); r.reply(4, false); await settle();
  assert.deepEqual(r.events.filter(e => e.type === 'appwindowstatechange').map(e => e.detail.maximized), [false, true, false]);
  assert.equal(r.writes.length, 0, 'native changes never persist profiles or settings');
  assert.ok(r.requests.every(r => r.url === '/api/window/state' && r.options.cache === 'no-store'));
});

test('resize before fetch result coalesces one follow-up and ignores stale state; failures retain last known value', async () => {
  const r = runtime();
  for (let i = 0; i < 20; i++) r.resize();
  assert.equal(r.requests.length, 1);
  r.reply(0, true); await settle();
  assert.equal(r.requests.length, 2);
  assert.equal(r.prefs.getWindowState().initialized, false);
  assert.equal(r.events.length, 0, 'obsolete response must not change zoom or native state');
  r.reply(1, false); await settle();
  assert.equal(r.prefs.isMaximized(), false);
  r.resize(); r.reply(2, true, false); await settle();
  assert.equal(r.prefs.isMaximized(), false);
  r.resize(); r.reply(3, 'true'); await settle();
  assert.equal(r.prefs.isMaximized(), false, 'malformed response is not truthy-maximized');
  assert.equal(r.events.length, 1);
});

test('allowed grid increments have no height ceiling; <=100 ranges use only 10/20', () => {
  for (const height of [0, 80, 120, 300, 440, 700, 1400, 3000, NaN]) {
    for (const maximum of [0, 1, 99, 100, 112, 455, 562, 909, 1200, 5000, 24038]) {
      const axis = math.yAxis(maximum, height);
      assert.ok([10, 20, 25, 50].includes(axis.step));
      if (maximum <= 100) assert.ok(axis.step <= 20);
      assert.equal(axis.guarded, false);
      assert.ok(axis.tickCount <= 501 && axis.max >= maximum * 1.04);
    }
  }
  assert.ok(math.yAxis(562, 1300).step < math.yAxis(562, 300).step);
});

test('precise guard: max 501 ticks including zero and 4% headroom, no fallback above 50', () => {
  assert.equal(math.yAxis(25000 / 1.04, 300).tickCount, 501);
  for (const maximum of [25001 / 1.04, 1e10, Number.MAX_VALUE, Infinity, NaN, -Infinity]) {
    const axis = math.yAxis(maximum, 300);
    assert.equal(axis.guarded, true);
    assert.equal(axis.max, null);
    assert.equal(axis.tickCount, 0);
    assert.equal(axis.step, 50);
    assert.match(axis.reason, /501.*含0.*50/);
  }
  assert.equal(math.yAxis(5000, 1e10).step, 50, 'bounded allocation beats overly detailed tall-plot request');
});

test('enabled-text helper emits checkmarks only, leaving label and genuine roots untouched', () => {
  const r = runtime();
  assert.equal(r.ui.enabledText(true, '个体'), '✓个体');
  assert.equal(r.ui.enabledText(false, '个体'), '×个体');
  assert.equal(r.ui.enabledText(true, '√9'), '✓√9', 'no global root replacement');
  assert.ok(!common.includes("'√个体'"));
});
