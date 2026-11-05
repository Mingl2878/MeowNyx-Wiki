'use strict';
// Actual SettingsPage render/events/save path, isolated in-memory DOM and transport.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../js/pages/settings.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function runtime(initial = {}, { failedLoad = false } = {}) {
  const nodes = new Map(), writes = [], calls = [], cache = new Map();
  const reply = { ok: true, wait: null };
  function element(tag = 'div') {
    return { tagName: tag, style: {}, value: '', checked: false, disabled: false, hidden: false, dataset: {}, listeners: {}, textContent: '', _html: '',
      addEventListener(type, fn) { this.listeners[type] = fn; }, removeAttribute(key) { delete this[key]; }, setAttribute() {},
      get innerHTML() { return this._html || this.textContent; }, set innerHTML(value) { this._html = value; },
      async emit(type) { return this.listeners[type]?.({ target: this }); }
    };
  }
  const document = { getElementById: id => nodes.get(id) || null, querySelectorAll: () => [], createElement: element, addEventListener() {}, removeEventListener() {} };
  const container = element();
  Object.defineProperty(container, 'innerHTML', { get() { return this._html; }, set(html) {
    this._html = html; nodes.clear();
    for (const match of html.matchAll(/<(input|select|button|div)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const node = element(match[1]), attrs = match[2];
      node.checked = /(?:^|\s)checked(?:\s|$)/.test(attrs); node.hidden = /(?:^|\s)hidden(?:\s|$)/.test(attrs);
      node.value = /\bvalue="([^"]*)"/.exec(attrs)?.[1] || ''; nodes.set(match[3], node);
    }
  }});
  const window = { addEventListener() {}, removeEventListener() {}, UserConfig: {
    async saveSettings(proposal) { writes.push(JSON.parse(JSON.stringify(proposal))); if (reply.wait) await reply.wait; return reply.ok; },
    getStatus: () => ({ ready: true, error: 'synthetic readonly failure' }), getSettingsResult: () => ({ ok: true })
  }};
  const context = vm.createContext({ window, document, console: { error() {} }, localStorage: { setItem(k, v) { cache.set(k, v); } },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: !failedLoad, json: async () => url === '/api/fonts' ? { fonts: [] } : { ...initial } }; }
  });
  vm.runInContext(source, context);
  const page = vm.runInContext('SettingsPage', context); page.render(container); await tick();
  return { page, container, nodes, writes, calls, reply, cache, node: id => nodes.get(id) };
}

for (const initial of [{}, { rkpp_autostart: false, close_to_background: false }, { rkpp_autostart: true, close_to_background: true }]) {
  test('actual settings checkboxes load ' + JSON.stringify(initial) + ' without a startup write', async () => {
    const r = await runtime(initial);
    assert.equal(r.node('set-rkpp-autostart').checked, initial.rkpp_autostart === true);
    assert.equal(r.node('set-close-to-background').checked, initial.close_to_background === true);
    assert.equal(r.node('set-close-legacy-row').hidden, initial.close_to_background === true);
    assert.match(r.container.innerHTML, /启动软件时自动启动RKPP并且连接/);
    assert.match(r.container.innerHTML, /关闭窗口之后放在后台而不是关闭/);
    assert.equal(r.writes.length, 0); assert.equal(r.calls.some(call => call.options?.method), false);
    r.page.onLeave();
  });
}

test('explicit false save preserves unknown preferences and old minimize; failed save/re-entry retain checkbox drafts', async () => {
  const r = await runtime({ rkpp_autostart: true, close_to_background: true, close_behavior: 'minimize', custom_future_field: { nested: 'keep' }, window_width: 960 });
  for (const id of ['set-rkpp-autostart', 'set-close-to-background']) { const node = r.node(id); node.checked = false; await node.emit('change'); }
  assert.equal(r.node('set-close-legacy-row').hidden, false); assert.match(r.container.innerHTML, /data-val="minimize">最小化到任务栏/);
  assert.equal(r.writes.length, 0); r.reply.ok = false;
  await r.node('set-save-btn').emit('click');
  assert.match(r.node('settings-result').textContent, /保存失败/); assert.equal(r.node('set-save-btn').disabled, false);
  assert.equal(r.cache.size, 0); r.page.onLeave(); r.page.render(r.container);
  assert.equal(r.node('set-rkpp-autostart').checked, false); assert.equal(r.node('set-close-to-background').checked, false);
  r.reply.ok = true; await r.node('set-save-btn').emit('click');
  const patch = r.writes.at(-1); assert.equal(patch.rkpp_autostart, false); assert.equal(patch.close_to_background, false);
  assert.equal(patch.close_behavior, 'minimize'); assert.equal(patch.window_width, 960); assert.deepEqual(patch.custom_future_field, { nested: 'keep' });
  assert.equal(r.calls.filter(call => call.url === '/api/settings').length, 1, 're-entry keeps existing loaded data/save pipeline');
  r.page.onLeave();
});

test('settings save snapshots booleans; older completion does not clear a newer false draft', async () => {
  const r = await runtime(); let resolve; r.reply.wait = new Promise(done => { resolve = done; });
  r.node('set-rkpp-autostart').checked = true; await r.node('set-rkpp-autostart').emit('change');
  const saving = r.node('set-save-btn').emit('click'); assert.equal(r.writes.length, 1); assert.equal(r.writes[0].rkpp_autostart, true);
  r.node('set-rkpp-autostart').checked = false; await r.node('set-rkpp-autostart').emit('change');
  await r.node('set-save-btn').emit('click'); assert.equal(r.writes.length, 1, 'in-flight save is not duplicated');
  resolve(); await saving; assert.equal(r.node('settings-dirty-hint').style.display, 'block');
  assert.equal(r.node('set-rkpp-autostart').checked, false); r.reply.wait = null;
  await r.node('set-save-btn').emit('click'); assert.equal(r.writes[1].rkpp_autostart, false); assert.equal(r.node('settings-dirty-hint').style.display, 'none');
  r.page.onLeave();
});

test('read-only load failure renders unchecked defaults and never automatically saves', async () => {
  const r = await runtime({}, { failedLoad: true });
  assert.equal(r.node('set-rkpp-autostart').checked, false); assert.equal(r.node('set-close-to-background').checked, false);
  r.page.onLeave(); r.page.render(r.container); assert.equal(r.writes.length, 0);
});
