const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function settingsRuntime(initialZoom = '0.7', options = {}) {
  const memory = new Map([['xwiki-default-route', 'damage']]);
  if (initialZoom != null) memory.set('xwiki-max-zoom', initialZoom);
  for (const [key, value] of Object.entries(options.memory || {})) memory.set(key, value);
  const nodes = new Map(), callbacks = new Map(), mode = { maximized: true };
  const reply = { ok: true, data: { ok: true }, malformed: false };
  const writes = [], events = [];
  const style = () => ({ setProperty(key, value) { this[key] = value; } });
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { style: style(), value: '', innerHTML: '', textContent: '', disabled: false,
      listeners: {}, attributes: {}, dataset: {}, hidden: false,
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(key, value) { this.attributes[key] = value; }
    });
    return nodes.get(id);
  };
  const speedButtons = ['include', 'exclude', 'threshold'].map(mode => {
    const button = element('mode-' + mode); button.dataset.speedMode = mode; return button;
  });
  const context = {
    console, document: { documentElement: { style: style() }, body: { style: style() }, getElementById: element,
      querySelectorAll: selector => selector === '#set-effective-speed [data-speed-mode]' ? speedButtons : [] },
    window: { addEventListener(type, fn) { callbacks.set(type, fn); }, dispatchEvent(event) { events.push(event); } },
    CustomEvent: function (type, options) { this.type = type; this.detail = options.detail; },
    localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) },
    fetch: async (url, request) => {
      if (request?.method === 'POST') {
        writes.push(JSON.parse(request.body));
        if (reply.wait) await reply.wait;
        if (reply.reject) throw new Error('network failure');
        return { ok: reply.ok, json: async () => { if (reply.malformed) throw new Error('bad response'); return reply.data; } };
      }
      return { ok: url === '/api/window/state' || options.initialOk !== false, json: async () => url === '/api/window/state' ? { ...mode }
        : options.initialWait ? await options.initialWait : { font_family: '', default_route: 'damage', default_max_zoom: 70, ...options.initialSettings } };
    }
  };
  vm.createContext(context);
  const common = fs.readFileSync(path.join(ROOT, 'js/common.js'), 'utf8');
  vm.runInContext(common.slice(0, common.indexOf('const CommonUI')), context);
  await tick();
  const settings = fs.readFileSync(path.join(ROOT, 'js/pages/settings.js'), 'utf8').replace(
    'return { render: render, onLeave: onLeave };',
    'return { render, onLeave, saveSettings, loadSettings, buildHtml, bindSpeedSettings, speedSettings, getDraft: () => ({ ...settings }), isDirty: () => dirty, updateDraft(value) { Object.assign(settings, value); markDirty(); } };'
  );
  vm.runInContext(settings, context);
  return { memory, nodes, callbacks, mode, reply, writes, events, speedButtons, prefs: context.window.AppPreferences, page: vm.runInContext('SettingsPage', context), context };
}

test('shared 70% zoom restores as 70%, not 100%', async () => {
  const r = await settingsRuntime();
  assert.equal(r.prefs.getMaxZoom(), .7);
  assert.equal(r.prefs.getZoom(), .7);
});

test('one zoom setter synchronizes memory, live zoom and CSS; enforces 50-200%', async () => {
  const r = await settingsRuntime();
  r.prefs.setMaxZoom(1.5);
  assert.equal(r.memory.get('xwiki-max-zoom'), '1.5');
  assert.equal(r.prefs.getZoom(), 1.5);
  assert.equal(r.context.document.documentElement.style['--page-zoom'], 1.5);
  assert.equal(r.prefs.setMaxZoom(.1), .5);
  assert.equal(r.prefs.setMaxZoom(8), 2);
});

test('windowed mode stays 100%, re-maximizing restores committed zoom', async () => {
  const r = await settingsRuntime();
  r.mode.maximized = false; r.callbacks.get('resize')(); await tick();
  r.prefs.setMaxZoom(.8);
  assert.equal(r.prefs.getZoom(), 1);
  assert.equal(r.memory.get('xwiki-max-zoom'), '0.8');
  r.mode.maximized = true; r.callbacks.get('resize')(); await tick();
  assert.equal(r.prefs.getZoom(), .8);
});

test('draft edits do not write preferences before the backend accepts', async () => {
  const r = await settingsRuntime();
  r.page.updateDraft({ default_route: 'chart', default_max_zoom: 150 });
  assert.equal(r.memory.get('xwiki-default-route'), 'damage');
  assert.equal(r.memory.get('xwiki-max-zoom'), '0.7');
  assert.equal(r.prefs.getZoom(), .7);
  assert.equal(r.writes.length, 0);
});

test('failed or malformed settings response leaves all preference caches unchanged', async () => {
  for (const failure of ['http', 'business', 'malformed']) {
    const r = await settingsRuntime();
    r.page.updateDraft({ default_route: 'chart', default_max_zoom: 150 });
    if (failure === 'http') r.reply.ok = false;
    if (failure === 'business') r.reply.data = { ok: false, error: '保存失败' };
    if (failure === 'malformed') r.reply.malformed = true;
    assert.equal(await r.page.saveSettings(), false);
    assert.equal(r.memory.get('xwiki-default-route'), 'damage');
    assert.equal(r.memory.get('xwiki-max-zoom'), '0.7');
    assert.equal(r.prefs.getZoom(), .7);
    assert.equal(r.nodes.get('set-save-btn').disabled, false);
  }
});

test('successful save commits both caches and applies live zoom exactly once', async () => {
  const r = await settingsRuntime();
  r.page.updateDraft({ default_route: 'chart', default_max_zoom: 150 });
  assert.equal(await r.page.saveSettings(), true);
  assert.equal(r.memory.get('xwiki-default-route'), 'chart');
  assert.equal(r.memory.get('xwiki-max-zoom'), '1.5');
  assert.equal(r.prefs.getZoom(), 1.5);
  assert.equal(r.writes.length, 1);
  assert.equal(r.writes[0].default_max_zoom, 150);
});

test('missing zoom memory uses the persisted default without duplicating runtime state', async () => {
  const r = await settingsRuntime(null, { initialSettings: { default_max_zoom: 100 } });
  assert.equal(r.prefs.getZoom(), 1);
  r.prefs.setMaxZoom(1.4); r.callbacks.get('resize')(); await tick();
  assert.equal(r.prefs.getZoom(), 1.4);
});

test('shared skill classifier accepts only physical and magic attacks', async () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/data.js'), 'utf8'), context);
  const api = vm.runInContext('RKData', context);
  for (const category of ['Physical Attack', 'Magic Attack']) assert.equal(api.isAttackMove({ move_category: category }), true);
  for (const category of ['Status', 'Defense', 'Conditional Attack', 'Energy', '', 'Unknown']) assert.equal(api.isAttackMove({ move_category: category }), false);
  assert.equal(api.isAttackMove(null), false);
  assert.equal(api.getMoveCategoryZh({ move_category: 'Defense' }), '防御');
});

test('effective-speed preference commits only after success and all consumers share the formula', async () => {
  const r = await settingsRuntime();
  assert.equal(r.prefs.getEffectiveIncludeSpeed(),true);
  r.page.updateDraft({effective_speed_mode:'exclude'});
  assert.equal(r.prefs.getEffectiveIncludeSpeed(),true);
  r.reply.ok=false; assert.equal(await r.page.saveSettings(),false);
  assert.equal(r.prefs.getEffectiveIncludeSpeed(),true);
  r.reply.ok=true; assert.equal(await r.page.saveSettings(),true);
  assert.equal(r.prefs.getEffectiveIncludeSpeed(),false);
  assert.equal(r.memory.get('xwiki-effective-include-speed'),'false');
  const context={AppPreferences:r.prefs}; vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js/data.js'),'utf8'),context);
  const api=vm.runInContext('RKData',context);
  const pet={base_hp:100,base_phy_atk:110,base_mag_atk:80,base_phy_def:90,base_mag_def:70,base_spd:60};
  assert.equal(api.getEffectiveStats(pet),370);
  r.prefs.setEffectiveIncludeSpeed(true); assert.equal(api.getEffectiveStats(pet),430);
});

test('coaster returns no status, defense, other-category or unknown quick cards', async () => {
  const context = { console: { log() {}, error() {} },
    localStorage: { getItem: key => key === 'rk_team_config' ? JSON.stringify({ activeGroupId: 'test', groups: [{ id: 'test', team: [501,434], petSkills: { 501: ['防御','魔法增效','械斗','磁暴','不存在的技能'] } }] }) : null },
    fetch: async file => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(ROOT,file),'utf8')) }) };
  vm.createContext(context);
  for (const file of ['js/battle-math.js','js/monster-identity.js','js/data.js']) vm.runInContext(fs.readFileSync(path.join(ROOT,file),'utf8'),context);
  await vm.runInContext('RKData.init()', context);
  const code = fs.readFileSync(path.join(ROOT,'js/pages/damage.js'),'utf8').replace('return { render, onLeave, getState: () => state, CalcEngine };','return { render, onLeave, getState: () => state, CalcEngine, getCoasterSkills };');
  vm.runInContext(code,context);
  const names = vm.runInContext('DamagePage.getCoasterSkills(RKData.getMonsterById(434)).map(s => s.name)',context);
  assert.deepEqual(Array.from(names), ['械斗','磁暴']);
});

const plain = value => JSON.parse(JSON.stringify(value));
const statsEvents = r => r.events.filter(e => e.type === 'appstatspreferenceschange');

test('new speed mode wins over legacy boolean; missing mode migrates bool; threshold defaults and clamps', async () => {
  for (const [data, expected] of [
    [{}, { mode: 'include', threshold: 80 }],
    [{ effective_include_speed: false }, { mode: 'exclude', threshold: 80 }],
    [{ effective_speed_mode: 'include', effective_include_speed: false }, { mode: 'include', threshold: 80 }],
    [{ effective_speed_mode: 'exclude', effective_include_speed: true }, { mode: 'exclude', threshold: 80 }],
    [{ effective_speed_mode: 'threshold', effective_speed_threshold: 90, effective_include_speed: true }, { mode: 'threshold', threshold: 90 }],
    [{ effective_speed_mode: 'threshold', effective_speed_threshold: 39 }, { mode: 'threshold', threshold: 40 }],
    [{ effective_speed_mode: 'threshold', effective_speed_threshold: 121 }, { mode: 'threshold', threshold: 120 }],
    [{ effective_speed_mode: 'threshold', effective_speed_threshold: 83.6 }, { mode: 'threshold', threshold: 84 }],
    [{ effective_speed_mode: 'threshold', effective_speed_threshold: null }, { mode: 'threshold', threshold: 80 }],
    [{ effective_speed_mode: 'bogus', effective_include_speed: false }, { mode: 'exclude', threshold: 80 }]
  ]) {
    const r = await settingsRuntime('0.7', { initialSettings: data });
    assert.deepEqual(plain(r.prefs.getEffectiveSpeedPolicy()), expected);
    await r.page.loadSettings();
    const draft = r.page.getDraft();
    assert.equal(draft.effective_speed_mode, expected.mode);
    assert.equal(draft.effective_speed_threshold, expected.threshold);
    assert.equal(draft.effective_include_speed, expected.mode === 'include');
  }
});

test('speed policy getters return snapshots; legacy setters preserve threshold and persist=false never writes caches', async () => {
  const r = await settingsRuntime();
  const before = [...r.memory], start = statsEvents(r).length;
  r.prefs.setEffectiveSpeedPolicy('threshold', 94, false);
  assert.deepEqual([...r.memory], before);
  assert.equal(statsEvents(r).length, start + 1);
  assert.equal(r.prefs.getEffectiveIncludeSpeed(), false);
  const snapshot = r.prefs.getEffectiveSpeedPolicy(); snapshot.mode = 'exclude'; snapshot.threshold = 40;
  assert.deepEqual(plain(r.prefs.getEffectiveSpeedPolicy()), { mode: 'threshold', threshold: 94 });
  r.prefs.setEffectiveSpeedPolicy('threshold', 94, false);
  assert.equal(statsEvents(r).length, start + 1, 'unchanged policy does not refresh consumers');
  r.prefs.setEffectiveIncludeSpeed(true, false);
  assert.deepEqual(plain(r.prefs.getEffectiveSpeedPolicy()), { mode: 'include', threshold: 94 });
  assert.deepEqual([...r.memory], before);
  r.prefs.setEffectiveIncludeSpeed(false);
  assert.deepEqual(plain(r.prefs.getEffectiveSpeedPolicy()), { mode: 'exclude', threshold: 94 });
  assert.equal(r.memory.get('xwiki-effective-speed-mode'), 'exclude');
  assert.equal(r.memory.get('xwiki-effective-speed-threshold'), '94');
});

test('effective formula counts the entire BASE speed at equality, never final speed or excess above threshold', async () => {
  const r = await settingsRuntime(), context = { AppPreferences: r.prefs };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/data.js'), 'utf8'), context);
  const api = vm.runInContext('RKData', context);
  for (const threshold of [40, 80, 120]) {
    for (const mode of ['include', 'exclude', 'threshold']) {
      r.prefs.setEffectiveSpeedPolicy(mode, threshold);
      for (const speed of [threshold - 1, threshold, threshold + 1]) {
        const pet = { base_hp: 100, base_phy_atk: 110, base_mag_atk: 80, base_phy_def: 90, base_mag_def: 70, base_spd: speed, speed: 999, final_spd: 999 };
        const counts = mode === 'include' || mode === 'threshold' && speed >= threshold;
        assert.equal(api.getEffectiveStats(pet), 370 + (counts ? speed : 0));
        assert.equal(api.getTotalStats(pet), 450 + speed, 'total stats ignore policy');
      }
    }
  }
  assert.equal(api.getEffectiveStats({}), 0);
  context.AppPreferences = { getEffectiveIncludeSpeed: () => false };
  assert.equal(api.getEffectiveStats({ base_hp: 100, base_mag_atk: 110, base_spd: 80 }), 210);
  delete context.AppPreferences;
  assert.equal(api.getEffectiveStats({ base_hp: 100, base_mag_atk: 110, base_spd: 80 }), 290);
});

test('three exclusive native buttons show only threshold slider and retain hidden threshold without committing', async () => {
  const r = await settingsRuntime();
  const html = r.page.buildHtml();
  assert.equal((html.match(/data-speed-mode=/g) || []).length, 3);
  assert.ok(html.includes('包含速度') && html.includes('不包含速度') && html.includes('速度综合'));
  assert.match(html, /id="set-effective-threshold-control" hidden/);
  assert.match(html, /type="range" id="set-effective-threshold" min="40" max="120" step="1" value="80"/);
  assert.doesNotMatch(html, /name="effective-speed"/);
  r.page.bindSpeedSettings();
  const before = [...r.memory], events = statsEvents(r).length;
  r.speedButtons[2].listeners.click();
  const slider = r.nodes.get('set-effective-threshold'), control = r.nodes.get('set-effective-threshold-control');
  assert.equal(control.hidden, false);
  slider.value = '97'; slider.listeners.input();
  assert.equal(r.nodes.get('set-effective-threshold-value').textContent, 97);
  for (const index of [0, 1, 2]) {
    r.speedButtons[index].listeners.click();
    assert.equal(control.hidden, index !== 2);
    assert.equal(r.page.getDraft().effective_speed_threshold, 97);
    assert.equal(slider.value, 97);
    assert.deepEqual(r.speedButtons.map(b => b.attributes['aria-pressed']), [0, 1, 2].map(i => String(i === index)));
  }
  assert.deepEqual([...r.memory], before); assert.equal(statsEvents(r).length, events);
  assert.deepEqual(plain(r.prefs.getEffectiveSpeedPolicy()), { mode: 'include', threshold: 80 });
});

test('all save failures keep speed caches/events unchanged; accepted retry commits one policy event', async () => {
  for (const failure of ['http', 'business', 'malformed', 'network']) {
    const r = await settingsRuntime();
    r.page.updateDraft({ effective_speed_mode: 'threshold', effective_speed_threshold: 93 });
    const before = [...r.memory], eventCount = statsEvents(r).length;
    if (failure === 'http') r.reply.ok = false;
    if (failure === 'business') r.reply.data = { ok: false, error: 'not saved' };
    if (failure === 'malformed') r.reply.malformed = true;
    if (failure === 'network') r.reply.reject = true;
    assert.equal(await r.page.saveSettings(), false);
    assert.deepEqual([...r.memory], before); assert.equal(statsEvents(r).length, eventCount);
    assert.deepEqual(plain(r.prefs.getEffectiveSpeedPolicy()), { mode: 'include', threshold: 80 });
    assert.equal(r.page.getDraft().effective_speed_threshold, 93);
    assert.equal(r.page.isDirty(), true);
    Object.assign(r.reply, { ok: true, data: { ok: true }, malformed: false, reject: false });
    assert.equal(await r.page.saveSettings(), true);
    assert.deepEqual(plain(r.prefs.getEffectiveSpeedPolicy()), { mode: 'threshold', threshold: 93 });
    assert.equal(statsEvents(r).length, eventCount + 1);
    assert.equal(r.memory.get('xwiki-effective-speed-mode'), 'threshold');
    assert.equal(r.memory.get('xwiki-effective-speed-threshold'), '93');
    assert.equal(r.writes[1].effective_include_speed, false);
  }
});

test('save snapshots commit submitted policy only and keep newer drafts dirty; late startup cannot overwrite it', async () => {
  let finishLoad, finishSave;
  const r = await settingsRuntime('0.7', { initialWait: new Promise(resolve => { finishLoad = resolve; }) });
  r.page.updateDraft({ effective_speed_mode: 'threshold', effective_speed_threshold: 90 });
  r.reply.wait = new Promise(resolve => { finishSave = resolve; });
  const saving = r.page.saveSettings();
  assert.equal(await r.page.saveSettings(), false, 'parallel saves are blocked');
  r.page.updateDraft({ effective_speed_mode: 'exclude', effective_speed_threshold: 100 });
  finishSave(); assert.equal(await saving, true);
  assert.deepEqual(plain(r.prefs.getEffectiveSpeedPolicy()), { mode: 'threshold', threshold: 90 });
  assert.equal(r.page.isDirty(), true); assert.equal(r.page.getDraft().effective_speed_threshold, 100);
  finishLoad({ effective_speed_mode: 'include', effective_speed_threshold: 80 }); await tick();
  assert.deepEqual(plain(r.prefs.getEffectiveSpeedPolicy()), { mode: 'threshold', threshold: 90 });
});

test('save failure still rolls back only the submitted font draft and protects newer font edits', async () => {
  const r = await settingsRuntime();
  const fonts = []; r.context.window.applyAppFont = async family => { fonts.push(family); return { applied: true }; };
  r.page.updateDraft({ font_family: 'saved-font' }); assert.equal(await r.page.saveSettings(), true);
  r.page.updateDraft({ font_family: 'failed-font', effective_speed_mode: 'threshold' }); r.reply.ok = false;
  assert.equal(await r.page.saveSettings(), false); assert.equal(fonts.at(-1), 'saved-font');
  assert.equal(r.page.getDraft().font_family, 'saved-font');
  let finish; r.reply.wait = new Promise(resolve => { finish = resolve; });
  r.page.updateDraft({ font_family: 'older-font' }); const saving = r.page.saveSettings();
  r.page.updateDraft({ font_family: 'newer-font' }); finish(); assert.equal(await saving, false);
  assert.equal(r.page.getDraft().font_family, 'newer-font'); assert.equal(fonts.length, 1);
});

test('startup settings promise replaces stale per-port route/zoom/speed caches with shared values', async () => {
  let finish;
  const r = await settingsRuntime('1.9', {
    memory: { 'xwiki-default-route': 'damage', 'xwiki-effective-speed-mode': 'exclude', 'xwiki-effective-speed-threshold': '110' },
    initialWait: new Promise(resolve => { finish = resolve; })
  });
  const ready = r.context.window.appPreferencesReady;
  assert.equal(typeof ready.then, 'function');
  assert.equal(r.memory.get('xwiki-default-route'), 'damage');
  finish({ default_route: 'team', default_max_zoom: 80, effective_speed_mode: 'threshold', effective_speed_threshold: 90 });
  await ready;
  assert.equal(r.memory.get('xwiki-default-route'), 'team');
  assert.equal(r.memory.get('xwiki-max-zoom'), '0.8');
  assert.equal(r.prefs.getMaxZoom(), .8); assert.equal(r.prefs.getZoom(), .8);
  assert.deepEqual(plain(r.prefs.getEffectiveSpeedPolicy()), { mode: 'threshold', threshold: 90 });
});

test('failed startup GET resolves readiness without replacing the fallback cache', async () => {
  const r = await settingsRuntime('.9', { initialOk: false, initialSettings: { default_route: 'team', default_max_zoom: 150 } });
  assert.equal(await r.context.window.appPreferencesReady, null);
  assert.equal(r.memory.get('xwiki-default-route'), 'damage');
  assert.equal(r.memory.get('xwiki-max-zoom'), '.9');
  assert.equal(r.prefs.getMaxZoom(), .9);
});

test('Ctrl-wheel and Ctrl-0 preview now, persist through UserConfig once, cache only accepted writes', async () => {
  const r = await settingsRuntime(), writes = []; let finish;
  r.context.window.UserConfig = { saveSettings(proposal) { writes.push(proposal); return new Promise(resolve => { finish = resolve; }); } };
  const wheel = r.callbacks.get('wheel'), key = r.callbacks.get('keydown');
  let prevented = 0;
  const wheelEvent = { ctrlKey: true, deltaY: -1, preventDefault() { prevented++; } };
  const first = wheel(wheelEvent);
  assert.equal(r.prefs.getZoom(), .8); assert.equal(r.memory.get('xwiki-max-zoom'), '0.7');
  assert.deepEqual(plain(writes), [{ default_max_zoom: 80 }]);
  finish(true); assert.equal(await first, true);
  assert.equal(r.memory.get('xwiki-max-zoom'), '0.8');
  const rejected = wheel(wheelEvent); assert.equal(r.prefs.getZoom(), .9);
  finish(false); assert.equal(await rejected, false); assert.equal(r.memory.get('xwiki-max-zoom'), '0.8');
  const reset = key({ ctrlKey: true, key: '0', preventDefault() { prevented++; } });
  assert.equal(r.prefs.getZoom(), 1); finish(true); await reset;
  assert.equal(r.memory.get('xwiki-max-zoom'), '1');
  assert.deepEqual(plain(writes), [{ default_max_zoom: 80 }, { default_max_zoom: 90 }, { default_max_zoom: 100 }]);
  assert.equal(prevented, 3); assert.equal(r.writes.length, 0, 'no untracked direct settings POST');
  r.prefs.setMaxZoom(1.2, false); assert.equal(writes.length, 3, 'runtime commit never queues a recursive save');
  r.mode.maximized = false; r.callbacks.get('resize')(); await tick();
  wheel(wheelEvent); assert.equal(writes.length, 3, 'windowed wheel stays disabled');
});

test('standalone zoom shortcuts retain cache fallback when UserConfig is absent', async () => {
  const r = await settingsRuntime();
  await r.callbacks.get('wheel')({ ctrlKey: true, deltaY: -1, preventDefault() {} });
  assert.equal(r.memory.get('xwiki-max-zoom'), '0.8');
  await r.callbacks.get('keydown')({ ctrlKey: true, code: 'Digit0', preventDefault() {} });
  assert.equal(r.memory.get('xwiki-max-zoom'), '1');
});

test('UserConfig settings failure preserves runtime/caches/font rollback; successful retry commits once', async () => {
  const r = await settingsRuntime(); const queued = [], fonts = []; let accepted = false;
  r.context.window.UserConfig = { saveSettings: async proposal => { queued.push(proposal); return accepted; }, getStatus: () => ({ error: 'shared disk unavailable' }) };
  r.context.window.applyAppFont = async family => { fonts.push(family); return { applied: true }; };
  r.page.updateDraft({ font_family: 'draft-font', default_route: 'team', default_max_zoom: 150, effective_speed_mode: 'threshold', effective_speed_threshold: 95 });
  const before = [...r.memory];
  assert.equal(await r.page.saveSettings(), false);
  assert.deepEqual([...r.memory], before); assert.equal(r.prefs.getMaxZoom(), .7);
  assert.equal(r.prefs.getEffectiveSpeedPolicy().mode, 'include');
  assert.equal(fonts.at(-1), ''); assert.match(r.nodes.get('settings-result').textContent, /shared disk unavailable/);
  assert.equal(r.nodes.get('set-save-btn').disabled, false); assert.equal(r.page.isDirty(), true);
  accepted = true; assert.equal(await r.page.saveSettings(), true);
  assert.equal(r.memory.get('xwiki-default-route'), 'team'); assert.equal(r.memory.get('xwiki-max-zoom'), '1.5');
  assert.deepEqual(plain(r.prefs.getEffectiveSpeedPolicy()), { mode: 'threshold', threshold: 95 });
  assert.equal(queued.length, 2, 'one queue entry per save, never another for setMaxZoom');
  assert.equal(r.writes.length, 0, 'no fallback POST when wrapper exists');
});

test('real UserConfig queue preserves direct /api/settings interception and tracks shortcut writes in flush', async () => {
  const r = await settingsRuntime(), root = r.context.window;
  root.localStorage = r.context.localStorage;
  root.fetch = async (url, request) => url === '/api/user-config'
    ? { ok: true, json: async () => ({ ok: true, data: {}, legacy_imported: true }) }
    : r.context.fetch(url, request);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/user-config.js'), 'utf8'), r.context);
  assert.equal(await root.UserConfig.init(), true);
  r.page.updateDraft({ default_route: 'team', default_max_zoom: 120, effective_speed_mode: 'threshold', effective_speed_threshold: 88 });
  r.reply.ok = false;
  assert.equal(await r.page.saveSettings(), false);
  assert.equal(r.memory.get('xwiki-default-route'), 'damage'); assert.equal(root.UserConfig.getStatus().pending, 1);
  r.reply.ok = true;
  assert.equal(await r.page.saveSettings(), true);
  assert.equal(r.writes.length, 2); assert.equal(r.memory.get('xwiki-default-route'), 'team');
  assert.equal(await root.UserConfig.flush(), true);
  let finish; r.reply.wait = new Promise(resolve => { finish = resolve; });
  const shortcut = r.callbacks.get('wheel')({ ctrlKey: true, deltaY: -1, preventDefault() {} });
  assert.equal(root.UserConfig.getStatus().pending, 1);
  assert.equal(r.prefs.getZoom(), 1.3); assert.equal(r.memory.get('xwiki-max-zoom'), '1.2');
  finish(); assert.equal(await shortcut, true); assert.equal(await root.UserConfig.flush(), true);
  assert.equal(r.memory.get('xwiki-max-zoom'), '1.3');
  assert.deepEqual(r.writes[2], { default_max_zoom: 130 });
});

test('late startup zoom response cannot overwrite an intervening accepted settings commit', async () => {
  let finish;
  const r = await settingsRuntime('0.7', { initialWait: new Promise(resolve => { finish = resolve; }) });
  r.page.updateDraft({ default_max_zoom: 140 });
  assert.equal(await r.page.saveSettings(), true);
  finish({ default_max_zoom: 80 }); await r.context.window.appPreferencesReady;
  assert.equal(r.prefs.getMaxZoom(), 1.4); assert.equal(r.memory.get('xwiki-max-zoom'), '1.4');
});
