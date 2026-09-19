'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const BattleMath = require('../js/battle-math.js');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/pages/chart.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function environment() {
  const storage = new Map(), events = new Map(), frames = new Map();
  let serial = 0;
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value))
  };
  const pet = (id, defense, magic_defense, hp, type) => ({ id, defense, magic_defense, hp, attack: 123, magic_attack: 141,
    main_type: { name: type }, sub_type: { name: 'secondary' }, image: `${id}.png` });
  const pets = [pet(1, 111, 121, 130, 'weak'), pet(2, 131, 151, 160, 'resist'), pet(3, 137, 163, 145, 'neutral'), pet(4, 230, 231, 140, 'immune')];
  const state = { atkPet: pets[0], defPet: pets[1], atkNature: { attack: 1 }, atkIV: { attack: true },
    defNature: { defense: 2, hp: 1 }, defIV: { hp: true }, skillType: 'attack', skillAttr: '火',
    basePower: 167, fixedBonus: 13, percentBonus: 17, buff: 21, comboCount: 3 };
  const typeCalls = [];
  const RKData = {
    getBaseStat: (pet, stat) => pet[stat],
    getPetStat: (pet, stat, nature, iv) => BattleMath.statFromBase(pet[stat], stat, nature, iv),
    getMonsterById: id => pets.find(pet => pet.id === Number(id)),
    getMonsterDisplayName: pet => `pet-${pet.id}`,
    getTypeEff: (skill, main, sub) => { typeCalls.push([skill, main, sub]); return ({ weak: 2, resist: 0.5, neutral: 1, immune: 0 })[main]; }
  };
  const parent = { clientWidth: 920, clientHeight: 440 };
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { id, textContent: '', innerHTML: '', parentElement: parent,
      style: {}, dataset: {}, attributes: {}, handlers: {}, classList: { toggle() {} },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(name, cb) { this.handlers[name] = cb; },
      querySelectorAll: () => [], querySelector: () => null,
      getContext: () => ({}), appendChild() {} });
    return nodes.get(id);
  };
  let lastChart;
  class Chart {
    static defaults = { font: {} };
    constructor(ctx, config) { this.config = config; this.data = config.data; this.resizes = []; this.ctx = { save() {}, restore() {} }; lastChart = this; }
    resize(w, h) { this.resizes.push([w, h]); }
    destroy() { this.destroyed = true; }
    update() {}
    getDatasetMeta(i) { return { hidden: this.data.datasets[i].hidden, data: [] }; }
  }
  const context = vm.createContext({ console, localStorage, RKData, BattleMath, Chart,
    DamagePage: { getState: () => state, CalcEngine: { isSameType: () => true } },
    document: { body: {}, documentElement: {}, getElementById: element, querySelector: () => null, querySelectorAll: () => [] },
    CommonUI: { createSearchBox: () => ({ wrapper: {}, input: { disabled:false, placeholder:'' }, dropdown: { style:{} }, destroy() {} }), enabledText: (enabled, label) => `${enabled ? '✓' : '×'}${label}` },
    getComputedStyle: () => ({ fontFamily: 'sans-serif', getPropertyValue: () => '', paddingLeft: '10px', paddingRight: '10px', paddingTop: '5px', paddingBottom: '5px' }),
    requestAnimationFrame: cb => { frames.set(++serial, cb); return serial; },
    cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, cb) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(cb); },
    removeEventListener: (name, cb) => events.get(name)?.delete(cb)
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(root, 'js/favorites.js'), 'utf8'), context);
  // Synchronous fixture adapter only. Real async persistence is tested in chart-workspace.test.js.
  const controls = { atkIV:{attack:true,magic_attack:true},atkNature:{attack:0,magic_attack:0},defIV:{defense:true,magic_defense:true},doubleLife:false };
  context.ChartWorkspace = {
    // These cases exercise saved custom favorites; automatic presets have their
    // own actual-data suite in chart-presets.test.js.
    isPreset:id=>typeof id==='string'&&id.startsWith('preset:'),
    getPresets:()=>[],
    getPreset:()=>{throw Error('No preset source in custom-favorites fixture');},
    getStatus:()=>({initialized:true}),
    getState:()=>({controls,activeGroupId:'ungrouped',groups:[{id:'ungrouped',name:'未分组',petIds:context.FavoritePets.getChartIds()}]}),
    getEntries:()=>context.FavoritePets.getChartIds().map(id=>({id,key:`chart:${id}`})),
    init:async()=>true, subscribe:()=>()=>{},
    setControls:async patch=>{for(const field of ['atkIV','atkNature','defIV'])if(patch[field])Object.assign(controls[field],patch[field]);if('doubleLife'in patch)controls.doubleLife=patch.doubleLife;},
    removePet:async id=>{if(!context.FavoritePets.removeChart(id))throw Error('保存失败');}
  };
  // Instrument only the in-memory test copy; no test hook in production public API.
  vm.runInContext(source.replace('return { render, onLeave, getState:', 'workspaceReady = true; return { test: { view, variants, bindEvents, syncControls, syncBaseline, favoriteAvatarPlugin, sharedDefenderConfiguration, favoriteMarkers, markerTooltip, draw, bindFeatures, cleanupFeatures, renderChart, renderDefenseChart, renderAttackChart, setActive: value => { active = value; } }, render, onLeave, getState:'), context);
  return { api: context.FavoritePets, math: vm.runInContext('ChartFavoriteMath', context), page: vm.runInContext('ChartPage', context),
    state, pets, typeCalls, storage, localStorage, context, events, frames, element, lastChart: () => lastChart,
    set: (key, value) => localStorage.setItem(key, JSON.stringify(value)) };
}

test('canvas pointer coordinates remove CSS zoom for hover and context menus', () => {
  const e = environment(), chart = { width:200, height:100, canvas:{getBoundingClientRect:()=>({left:20,top:30,width:300,height:150})} };
  assert.deepEqual(plain(e.math.pointerPosition(chart,{clientX:170,clientY:105})),{x:100,y:50});
  assert.deepEqual(plain(e.math.pointerPosition(chart,{native:{touches:[{clientX:20,clientY:30}]}})),{x:0,y:0});
  assert.equal(e.math.pointerPosition(chart,{}),null);
});

test('A/B storage is fresh, deduplicated and only B can be written; A cannot be removed', () => {
  const e = environment();
  e.set('rk_fav_pets', [2, '1', 2, null, -1, 'x', {}]);
  e.set('rk_chart_fav_pets', [1, 3, 3]);
  assert.deepEqual(plain(e.api.getDamageIds()), [2, 1]);
  assert.deepEqual(plain(e.api.getUnion()), [
    { id: 2, fromDamage: true, fromChart: false }, { id: 1, fromDamage: true, fromChart: true }, { id: 3, fromDamage: false, fromChart: true }
  ]);
  const beforeA = e.localStorage.getItem('rk_fav_pets');
  assert.equal(e.api.removeChart(1), true);
  assert.deepEqual(plain(e.api.getUnion().find(e=>e.id===1)), { id:1, fromDamage:true, fromChart:false });
  assert.equal(e.api.removeChart(3), true);
  assert.equal(e.api.addChart('4'), true);
  assert.equal(e.api.addChart({ id: 5 }), false);
  assert.equal(e.localStorage.getItem('rk_fav_pets'), beforeA);
  e.set('rk_fav_pets', []);
  assert.equal(e.api.getUnion()[0].fromDamage, false);
  assert.equal(e.api.removeChart(1), true);
});

test('notify, unsubscribe, cross-window storage and corrupt/unavailable storage', () => {
  const e = environment();
  let calls = 0;
  const unsubscribe = e.api.subscribe(() => calls++);
  e.api.notify(); e.api.addChart(1);
  assert.equal(calls, 2);
  for (const callback of e.events.get('storage')) callback({ key: 'rk_pet_configs' });
  assert.equal(calls, 3);
  unsubscribe(); e.api.notify();
  assert.equal(calls, 3);
  e.storage.set('rk_fav_pets', '{invalid'); e.set('rk_chart_fav_pets', {});
  assert.deepEqual(plain(e.api.getUnion()), []);
  e.localStorage.setItem = () => { throw Error('denied'); };
  assert.equal(e.api.addChart(4), false);
  e.localStorage.getItem = () => { throw Error('denied'); };
  assert.deepEqual(plain(e.api.getUnion()), []);
});

test('avatar markup escapes names and path characters without global image state', () => {
  const e = environment();
  const html = e.api.avatarHTML({ image: 'a"猫.png' }, '<name>');
  assert.match(html, /%22/); assert.match(html, /&lt;name&gt;/); assert.match(html, /loading="lazy"/);
  assert.equal(e.api.avatarUrl({image:'智辉章脑.png?v=123'}), 'assets/monster/images/'+encodeURIComponent('智辉章脑.png')+'?v=123');
  assert.doesNotMatch(e.api.avatarUrl({image:'图.png?v=123'}), /%3Fv/);
});

test('configuration ignores all damage and personal inputs, even old source-shaped entries', () => {
  const e=environment(), shared={iv:{hp:true,defense:true},nature:{hp:1,defense:0}};
  const poison=new Proxy({}, {get(){throw Error('personal data read');}});
  for(const entry of [{id:1,fromDamage:true},{id:2,fromChart:true}]) {
    const config=e.math.configuration(entry,poison,poison,shared,poison,()=>{throw Error('resolver read');});
    assert.deepEqual(plain(config.iv),shared.iv);assert.deepEqual(plain(config.nature),shared.nature);
    config.iv.hp=false;assert.equal(shared.iv.hp,true);
  }
});

test('one atomic double-life projection and selected defense IV; no source HP inheritance', async () => {
  const e = environment(), t = e.page.test, before = plain(e.state);
  t.bindEvents();
  assert.deepEqual(plain(t.sharedDefenderConfiguration()), {iv:{hp:false,defense:true,magic_defense:true},nature:{hp:0,defense:0,magic_defense:0}});
  e.element('chartIVBtn').handlers.click(); await new Promise(setImmediate);
  assert.equal(t.sharedDefenderConfiguration().iv.defense, false);
  assert.equal(t.sharedDefenderConfiguration().iv.magic_defense, true);
  t.view.mode = 'attack'; t.view.attackType = 'magic_attack';
  e.element('chartIVBtn').handlers.click(); await new Promise(setImmediate);
  assert.equal(t.sharedDefenderConfiguration().iv.magic_defense, false);
  for (const enabled of [true, false, true]) {
    e.element('chartDoubleLifeBtn').handlers.click(); await new Promise(setImmediate);
    const shared = t.sharedDefenderConfiguration();
    assert.equal(shared.iv.hp, enabled); assert.equal(shared.nature.hp, enabled ? 1 : 0);
    e.element('chartDoubleLifeBtn').handlers.contextmenu({ preventDefault() {} });
    assert.deepEqual(plain(t.sharedDefenderConfiguration()), plain(shared));
  }
  assert.deepEqual(plain(e.state), before);
  assert.equal('defNature' in t.view.overrides, false);
  assert.equal('hp' in t.view.overrides.defIV, false);
});

test('minimum integer uses exact rounding, includes odd/out-of-range points and bounded failure', () => {
  const e = environment();
  assert.equal(e.math.minimumInteger(101, x => x).x, 101);
  assert.equal(e.math.minimumInteger(701, x => x).x, 701);
  assert.equal(e.math.minimumInteger(0, x => x).x, 0);
  assert.equal(e.math.minimumInteger(1, () => 0).x, null);
  let calls = 0;
  e.math.minimumInteger(5000, x => { calls++; return x; });
  assert.ok(calls < 50);
  for (const nature of [0, 1, 2]) for (const iv of [false, true]) for (const effect of [0.25, 0.5, 1, 2, 4]) {
    const damage = x => BattleMath.normalDamage(BattleMath.statFromBase(x, 'attack', nature, iv), 187, 227) * effect;
    const expected = Array.from({ length: 10001 }, (_, x) => x).find(x => damage(x) >= 389);
    assert.equal(e.math.minimumInteger(389, damage).x, expected);
  }
});

test('defense markers use curve species only, odd defense and per-pet type; damage profiles cannot affect them', () => {
  const e=environment();e.set('rk_fav_pets',[1,2]);e.set('rk_chart_fav_pets',[2,3,4]);
  const t=e.page.test,markers=t.favoriteMarkers(e.state);
  assert.deepEqual(plain(markers.map(m=>m.key)),['chart:2','chart:3','chart:4']);
  const power=BattleMath.finalPower(167,13,17,1.25,1,21);
  const expected=Math.ceil(BattleMath.normalDamage(BattleMath.statFromBase(123,'attack',0,true),power,BattleMath.statFromBase(131,'defense',0,true),1,3)*.5);
  assert.equal(markers[0].damage,expected);assert.equal(markers[0].x,131);
  assert.equal(markers[0].hp,BattleMath.statFromBase(160,'hp',0,false));
  e.state.atkIV={};e.state.atkNature={attack:2};e.state.defIV={hp:true};e.state.defNature={hp:2,defense:2};
  e.set('rk_pet_configs',{2:{iv:{hp:true},nature:{hp:1}}});
  assert.deepEqual(plain(t.favoriteMarkers(e.state)),plain(markers));
  t.view.doubleLife=true;t.view.overrides.defIV.defense=false;
  const changed=t.favoriteMarkers(e.state);assert.notEqual(changed[0].hp,markers[0].hp);assert.equal(changed[2].damage,0);
  e.state.skillType='magic_attack';assert.equal(t.favoriteMarkers(e.state)[1].x,163);
});

test('attack mode exact minima in both axes, zero/immune/outside conditions and HP ordinate', () => {
  const e = environment(); e.set('rk_chart_fav_pets', [3, 4]);
  const v = e.page.test.view; v.mode = 'attack'; v.power = 277;
  for (const swap of [false, true]) for (const atk of ['attack', 'magic_attack']) {
    v.axisSwapped = swap; v.attackType = atk;
    const m = e.page.test.favoriteMarkers(e.state)[0];
    const damage = x => BattleMath.normalDamage(BattleMath.statFromBase(swap ? v.qualification : x, atk,
      0, true), BattleMath.finalPower(swap ? x : v.power, 0, 0, 1),
      BattleMath.statFromBase(e.pets[2][atk === 'attack' ? 'defense' : 'magic_defense'], atk === 'attack' ? 'defense' : 'magic_defense', 0, true));
    assert.equal(m.y, m.hp); assert.ok(damage(m.x) >= m.hp);
    assert.ok(m.x === 0 || damage(m.x - 1) < m.hp);
    const previous = plain(e.page.test.favoriteMarkers(e.state));
    Object.assign(e.state, { buff: 90, comboCount: 10, fixedBonus: 99, starMeteor: 100, defenseMod: 80, finalPowerManual: 999 });
    assert.deepEqual(plain(e.page.test.favoriteMarkers(e.state)), previous);
  }
  v.axisSwapped = false; v.power = 1;
  assert.ok(e.page.test.favoriteMarkers(e.state)[0].x > 200);
  v.power = 0;
  assert.match(e.page.test.favoriteMarkers(e.state)[0].reason, /威力为零/);
  assert.match(e.page.test.favoriteMarkers(e.state)[1].reason, /属性免疫/);
});

test('draw preserves numeric ordinary datasets, isolates scatter/tooltips, explicitly resizes and cleans lifecycle', () => {
  const e = environment(); e.set('rk_chart_fav_pets', [3, 4]);
  const t = e.page.test;
  t.setActive(true); t.bindFeatures();
  const draw = () => t.draw(e.element('defenseChart'), [80, 82, 200], [{ key: 'baseline', label: '+个体 / ✓性格 / 物防+个体', data: [300, 280, 100] }],
    { threshold: 400, step: 5, xTitle: '防御资质' });
  draw();
  const c = e.lastChart();
  assert.deepEqual(plain(c.data.datasets[0].data), [300, 280, 100]);
  const scatter = c.data.datasets.find(ds => ds.favoriteMarker);
  assert.equal(scatter.type, 'scatter'); assert.equal(scatter.data[0].x, 137);
  assert.equal(scatter.data.length, 1); // out-of-range immune pet is not clamped
  assert.equal(c.config.options.scales.x.type, 'linear');
  assert.equal(c.config.options.responsive, false);
  assert.deepEqual(c.resizes[0], [900, 430]);
  const labels = c.config.options.plugins.tooltip.callbacks.label({ dataset: scatter, raw: scatter.data[0] });
  for (const field of ['HP', '伤害', '剩余HP', '能否扛住', '实际属性克制', '配置来源']) assert.ok(labels.some(line => line.includes(field)));
  for (const cb of [...e.frames.values()]) cb(); e.frames.clear();
  for (const event of ['resize', 'appzoomchange']) for (const cb of e.events.get(event)) cb();
  assert.equal(e.frames.size, 1);
  for (const cb of [...e.frames.values()]) cb(); e.frames.clear();
  assert.equal(c.resizes.length, 3);
  t.view.markersVisible = false; draw();
  assert.equal(e.lastChart().data.datasets.find(ds => ds.favoriteMarker).hidden, true);
  e.page.onLeave();
  assert.equal(e.lastChart().destroyed, true);
  assert.equal(e.frames.size, 0);
  for (const event of ['resize', 'appzoomchange', 'appwindowstatechange', 'appfontchange', 'appthemechange']) assert.equal(e.events.get(event).size, 0);
});

test('ordinary curves stay neutral in defense and use actual target type in attack without changing rounding', () => {
  const e = environment(), t = e.page.test, v = t.view, s = e.state;
  t.setActive(true);
  for (const effect of [1, 2, 0.5]) {
    e.context.RKData.getTypeEff = () => effect;
    v.mode = 'defense';
    t.renderDefenseChart(e.element('defenseChart'), s);
    let c = e.lastChart();
    const power = BattleMath.finalPower(s.basePower, s.fixedBonus, s.percentBonus, 1.25, 1, s.buff);
    assert.deepEqual(plain(c.data.datasets[0].data), Array.from({ length: 61 }, (_, i) => Math.ceil(
      BattleMath.normalDamage(e.context.RKData.getPetStat(s.atkPet, 'attack', 0, true), power,
        BattleMath.statFromBase(80 + i * 2, 'defense', 0, true), 1, 3))));
    v.mode = 'attack';
    for (const swap of [false, true]) {
      v.axisSwapped = swap;
      t.renderAttackChart(e.element('defenseChart'), s); c = e.lastChart();
      assert.deepEqual(plain(c.data.datasets[0].data), plain(c.data.labels).map(x =>
        BattleMath.normalDamage(BattleMath.statFromBase(swap ? v.qualification : x, 'attack', 0, true),
          BattleMath.finalPower(swap ? x : v.power, 0, 0, 1), e.context.RKData.getPetStat(s.defPet, 'defense', 0, true)) * effect));
    }
  }
  e.page.onLeave();
});

test('avatar resources are capped, reused, pruned and handlers released on leave', () => {
  const e = environment(), allocated = [];
  e.context.Image = class {
    constructor(w, h) { this.width = w; this.height = h; allocated.push(this); }
  };
  for (let id = 10; id < 80; id++) e.pets.push({ ...e.pets[2], id, image: `${id}.png` });
  e.set('rk_chart_fav_pets', e.pets.slice(4).map(p => p.id));
  e.page.test.setActive(true);
  const draw = () => e.page.test.draw(e.element('defenseChart'), [80, 200], [{ key: 'baseline', label: '+个体 / ✓性格 / 物防+个体', data: [1, 1] }], { threshold: 400 });
  draw(); assert.equal(allocated.length, 64);
  draw(); assert.equal(allocated.length, 64);
  e.set('rk_chart_fav_pets', [79]); draw();
  assert.equal(allocated.length, 65);
  assert.ok(allocated.slice(0, 64).every(image => image.onload === null && image.onerror === null));
  e.page.onLeave();
  assert.ok(allocated.every(image => image.onload === null && image.onerror === null));
});

test('content size is unscaled and removes padding without reading visual rect; removed UI stays removed', () => {
  const e = environment();
  const size = e.math.contentSize({ clientWidth: 801, clientHeight: 403,
    getBoundingClientRect() { throw Error('visual dimensions must not be used'); } },
    { paddingLeft: '10px', paddingRight: '11px', paddingTop: '2px', paddingBottom: '3px' });
  assert.deepEqual(plain(size), { width: 780, height: 398 });
  assert.doesNotMatch(source, /chartCritBtn|typeEffect|chartHPIVBtn|chartHPNatureBtn|chartMagicIVBtn|chart-origin-dot|chartResetCompareBtn|不计|不叠加|伤害页基准|还原基准|markerIV|markerHPNature|chart-favorites-settings|chartAttackControls|chartAtkIVBtn2|data-remove-favorite/);
  assert.doesNotMatch(source, /clearComparisons|rk_pet_configs|PetConfiguration|\bs\.atkIV|\bs\.defNature|FavoritePets\.getEntries|FavoritePets\.getUnion/);
  const css = fs.readFileSync(path.join(root, 'css/chart-features.css'), 'utf8');
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g);
  assert.ok(selectors.every(block => block.split(',').every(selector => selector.trim().startsWith('.chart-favorites') || /^\.chart-preset-picker(?:\s|$)/.test(selector.trim()) || /^\.chart-page(?:\s|\.chart-window-maximized\b)/.test(selector.trim()))));
  assert.doesNotMatch(css, /width:\s*106px|chart-favorites-item\s*\{[^}]*padding/);
  assert.match(source, /chart-favorites-item quick-pet-item/);
  assert.match(source, /chart-favorites-avatar quick-pet-img-wrapper/);
});

test('right click removes clicked curve species while leaving damage favorites alone', async () => {
  const e=environment();e.set('rk_fav_pets',[2]);e.set('rk_chart_fav_pets',[2,3]);
  const t=e.page.test;t.bindFeatures();await new Promise(setImmediate);
  const grid=e.element('chartFavoriteGrid');
  grid.handlers.mousedown({button:1,preventDefault(){}});assert.deepEqual(plain(e.api.getChartIds()),[2,3]);
  grid.handlers.contextmenu({preventDefault(){},target:{closest:()=>({dataset:{chartFavorite:'2',favoriteKey:'chart:2'}})}});
  await new Promise(setImmediate);
  assert.deepEqual(plain(e.api.getChartIds()),[3]);assert.equal(e.localStorage.getItem('rk_fav_pets'),'[2]');
  t.cleanupFeatures();
});

test('WAND-V has one curve avatar at HP455/defense136 regardless of damage favorite/profile', () => {
  const e=environment(),t=e.page.test;
  const real=JSON.parse(fs.readFileSync(path.join(root,'data/monsters.json'),'utf8')).find(p=>p.id===249);
  e.pets.push({...e.pets[2],id:249,hp:real.base_hp,defense:real.base_phy_def,magic_defense:real.base_mag_def});
  e.set('rk_fav_pets',[249]);e.set('rk_chart_fav_pets',[249]);e.set('rk_pet_configs',{249:{iv:{hp:true},nature:{hp:2}}});
  t.view.doubleLife=true;const markers=t.favoriteMarkers(e.state);
  assert.equal(markers.length,1);assert.equal(markers[0].key,'chart:249');
  assert.equal(markers[0].hp,455);assert.equal(markers[0].x,136);assert.equal(markers[0].y,455);
  t.setActive(true);t.draw(e.element('defenseChart'),[80,200],[{key:'baseline',label:'fixture',data:[20,10]}],{threshold:400});
  assert.equal(e.lastChart().data.datasets.find(d=>d.favoriteMarker).data.length,1);
  assert.ok(e.lastChart().config.options.scales.y.max>455);e.page.onLeave();
});

test('actual-value legends keep all comparison combinations and stable visibility keys', () => {
  const e = environment(), t = e.page.test;
  t.view.overrides.atkIV.attack = false;
  t.view.overrides.atkNature.attack = 2;
  t.view.overrides.defIV.defense = false;
  const rows = t.variants();
  assert.equal(rows.length, 8); assert.equal(new Set(rows.map(r => r.label)).size, 8);
  for (const row of rows) {
    assert.doesNotMatch(row.label, /当前配置|对比：/);
    const side = (iv, n) => `${iv ? '✓' : '×'}个体&${n === 1 ? '✓性格' : n === 2 ? '负性格' : '×性格'}`;
    assert.equal(row.label, `攻：${side(row.values.atkIV, row.values.atkNature)} / 防：${side(row.values.defIV, row.values.defNature)}`);
    assert.equal(row.label.split('/').length, 2);
    assert.doesNotMatch(row.label, /√/);
    assert.equal(row.values.defNature, 0, 'curve defense nature never inherits personal nature');
  }
  t.setActive(true); t.renderDefenseChart(e.element('defenseChart'), e.state);
  const chart = e.lastChart(), ds = chart.data.datasets[1];
  t.view.hidden[ds.viewKey] = false;
  t.renderDefenseChart(e.element('defenseChart'), e.state);
  assert.equal(e.lastChart().data.datasets.find(d => d.viewKey === ds.viewKey).hidden, false);
  assert.equal(e.lastChart().data.datasets[2].hidden, true);
  e.page.onLeave();
});

test('avatar layout displaces presentation only, separates overlap, honors edges and recomputes after resize', () => {
  const e = environment(), t = e.page.test;
  const markers = [ {key:'A:249',x:136,y:455,fromDamage:true}, {key:'B:249',x:136,y:455,fromChart:true} ];
  const before = plain(markers), points = [{},{}], meta = {data:points,_sorted:true};
  const chart = { data:{datasets:[{favoriteMarker:true,data:markers}]}, getDatasetMeta:()=>meta,
    chartArea:{left:0,right:600,top:0,bottom:500},
    scales:{x:{getPixelForValue:x=>x*2},y:{getPixelForValue:y=>500-y}} };
  const plugin = t.favoriteAvatarPlugin([], {}); plugin.afterUpdate(chart);
  assert.deepEqual(plain(markers), before);
  assert.deepEqual(plain(points[0].$favoriteAnchor), {x:272,y:45});
  assert.deepEqual(plain(points[1].$favoriteAnchor), {x:272,y:45});
  assert.ok(Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y) >= 36);
  assert.equal(meta._sorted, false, 'hit testing scans the displaced elements, not sorted raw x values');
  chart.chartArea = {left:0,right:130,top:0,bottom:100};
  plugin.afterUpdate(chart);
  assert.ok(points.every(p=>p.x>=16&&p.x<=114&&p.y>=16&&p.y<=84));
  assert.ok(Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y) >= 36);
  assert.deepEqual(plain(markers), before);
  const anchors = Array.from({length:64},()=>({x:200,y:200}));
  const placements = e.math.avatarPositions(anchors,{left:0,right:900,top:0,bottom:430});
  assert.equal(new Set(placements.map(p=>`${p.x}:${p.y}`)).size,64);
});

test('curve never consults personal defaults, merged favorites or damage nature/IV getters', () => {
  const e=environment(),t=e.page.test;e.set('rk_chart_fav_pets',[3]);
  e.context.UserConfig={getObject(){throw Error('profile read');}};
  for(const field of ['atkIV','atkNature','defIV','defNature'])Object.defineProperty(e.state,field,{get(){throw Error(field+' read');}});
  t.syncBaseline();assert.equal(t.favoriteMarkers(e.state).length,1);assert.equal(t.variants()[0].values.atkNature,0);
  t.view.overrides.atkNature.attack=2;t.view.doubleLife=true;e.state.atkPet=e.pets[2];t.syncBaseline();
  assert.equal(t.view.overrides.atkNature.attack,2);assert.equal(t.view.doubleLife,true);
});

test('real bundled Chart.js keeps parsed coordinates and hits displaced distinct-species avatars', () => {
  const e = environment(), t = e.page.test;
  e.pets.push({...e.pets[2],id:5}); e.set('rk_fav_pets',[3]); e.set('rk_chart_fav_pets',[3,5]);
  t.setActive(true);
  t.draw(e.element('defenseChart'), [80,200], [{key:'baseline',label:'fixture',data:[50,20]}], {threshold:400});
  const config = e.lastChart().config, RealChart = require('../js/chart.umd.min.js');
  // Headless BasicPlatform + no-op drawing surface; no browser, filesystem or user profile.
  const canvas = {width:900,height:430};
  const ctx = new Proxy({canvas, measureText:text=>({width:String(text).length*7}), getLineDash:()=>[]}, {
    get(target,key) { return key in target ? target[key] : () => {}; }
  });
  canvas.getContext = () => ctx;
  const chart = new RealChart(canvas, {...config,platform:RealChart.BasicPlatform});
  try {
    const di = chart.data.datasets.findIndex(d=>d.favoriteMarker), ds = chart.data.datasets[di], meta = chart.getDatasetMeta(di);
    assert.equal(ds.data.length,2); assert.equal(meta._sorted,false);
    assert.deepEqual(plain(meta._parsed.map(p=>({x:p.x,y:p.y}))), plain(ds.data.map(m=>({x:m.x,y:m.y}))));
    assert.equal(ds.data[0].y,ds.data[1].y);
    for (const [i,point] of meta.data.entries()) {
      const hits = chart.getElementsAtEventForMode({x:point.x,y:point.y,native:true},'nearest',{axis:'xy',intersect:true},false);
      assert.ok(hits.some(h=>h.datasetIndex===di&&h.index===i),ds.data[i].key);
      assert.ok(!hits.some(h=>h.datasetIndex===di&&h.index!==i),'no same-point hit ambiguity');
    }
    const raw = plain(ds.data.map(m=>({key:m.key,x:m.x,y:m.y})));
    chart.resize(450,300);
    assert.deepEqual(plain(ds.data.map(m=>({key:m.key,x:m.x,y:m.y}))),raw);
    assert.ok(Math.hypot(meta.data[0].x-meta.data[1].x,meta.data[0].y-meta.data[1].y)>=36);
    chart.setDatasetVisibility(di,false);chart.update();
    const point=meta.data[0];
    assert.ok(chart.getElementsAtEventForMode({x:point.x,y:point.y,native:true},'nearest',{intersect:true},false).every(h=>h.datasetIndex!==di));
  } finally { chart.destroy(); e.page.onLeave(); }
});

test('all eight shared comparisons retain true formulas in defense and both attack axes', () => {
  const e = environment(), t = e.page.test, s = e.state;
  t.setActive(true);
  t.view.overrides.atkIV.attack = false;
  t.view.overrides.atkNature.attack = 2;
  t.view.overrides.defIV.defense = false;
  for (const mode of ['defense', 'attack']) for (const swapped of [false, true]) {
    t.view.mode = mode; t.view.axisSwapped = swapped;
    if (mode === 'defense') t.renderDefenseChart(e.element('defenseChart'), s);
    else t.renderAttackChart(e.element('defenseChart'), s);
    const chart = e.lastChart(), rows = t.variants();
    assert.equal(rows.length, 8);
    for (const [i, row] of rows.entries()) {
      const v = row.values;
      const expected = plain(chart.data.labels).map(x => {
        const attack = mode === 'defense' ? e.context.RKData.getPetStat(s.atkPet, 'attack', v.atkNature, v.atkIV)
          : BattleMath.statFromBase(swapped ? t.view.qualification : x, 'attack', v.atkNature, v.atkIV);
        const defense = mode === 'defense' ? BattleMath.statFromBase(x, 'defense', v.defNature, v.defIV)
          : e.context.RKData.getPetStat(s.defPet, 'defense', v.defNature, v.defIV);
        const power = mode === 'defense' ? BattleMath.finalPower(s.basePower, s.fixedBonus, s.percentBonus, 1.25, 1, s.buff)
          : BattleMath.finalPower(swapped ? x : t.view.power, 0, 0, t.view.sameType ? 1.25 : 1);
        const neutral = BattleMath.normalDamage(attack, power, defense, 1, mode === 'defense' ? s.comboCount : 1);
        return mode === 'defense' ? Math.ceil(neutral) : neutral * 0.5;
      });
      assert.deepEqual(plain(chart.data.datasets[i].data), expected, `${mode}/${swapped}/${row.key}`);
    }
  }
  e.page.onLeave();
});

test('empty startup does not invent or remember an attacker and still renders favorite controls', () => {
  const e = environment(); e.state.atkPet = null; e.set('rk_chart_fav_pets', [3]);
  e.page.test.setActive(true); e.page.test.renderChart();
  assert.equal(e.lastChart(), undefined);
  assert.equal(e.state.atkPet, null);
  assert.match(e.element('chartInfo').textContent, /请在.*设置精灵/);
  assert.match(e.element('chartFavoriteGrid').innerHTML, /请先设置攻守精灵/);
  assert.match(e.element('chartFavoriteToggle').innerHTML, /<svg/);
  e.page.onLeave();
});

test('extreme range pauses chart allocation with an explicit warning and recovers without changing inputs', () => {
  const e = environment(), t = e.page.test;
  t.setActive(true);
  const draw = data => t.draw(e.element('defenseChart'), [80, 200], [{ key: 'baseline', label: 'fixture', data }], { threshold: 400 });
  draw([562, 200]);
  const chart = e.lastChart(), values = [1e100, 200];
  draw(values);
  assert.equal(e.lastChart(), chart, 'no new Chart (and no tick allocation) on unsafe range');
  assert.equal(chart.destroyed, true);
  assert.equal(e.element('chartAxisWarning').hidden, false);
  assert.equal(e.element('defenseChart').hidden, true);
  assert.match(e.element('chartAxisWarning').textContent, /暂停绘图.*501/);
  assert.deepEqual(values, [1e100, 200]);
  draw([562, 200]);
  assert.notEqual(e.lastChart(), chart);
  assert.equal(e.element('chartAxisWarning').hidden, true);
  assert.equal(e.element('defenseChart').hidden, false);
  e.page.onLeave();
});

test('bundled Chart.js retains EVERY grid tick at 10/20/25/50 even when labels are blank', () => {
  const e = environment(), t = e.page.test, RealChart = require('../js/chart.umd.min.js');
  t.setActive(true);
  for (const maximum of [100, 562, 909, 24038]) {
    t.draw(e.element('defenseChart'), [80, 200], [{ key: 'baseline', label: 'fixture', data: [maximum, 1] }], { threshold: 400 });
    const canvas = { width: 900, height: 430 };
    const ctx = new Proxy({ canvas, measureText: text => ({ width: String(text).length * 7 }), getLineDash: () => [] }, {
      get(target, key) { return key in target ? target[key] : () => {}; }
    });
    canvas.getContext = () => ctx;
    const chart = new RealChart(canvas, { ...e.lastChart().config, platform: RealChart.BasicPlatform });
    try {
      const step = chart.options.scales.y.ticks.stepSize, ticks = chart.scales.y.ticks;
      assert.ok([10, 20, 25, 50].includes(step));
      assert.equal(ticks.length, chart.scales.y.max / step + 1);
      assert.ok(ticks.length <= 501);
      ticks.forEach((tick, i) => { if (i) assert.equal(tick.value - ticks[i - 1].value, step); });
      if (maximum === 24038) assert.ok(ticks.some(t => t.label === ''), 'label thinning must NOT remove grid lines');
    } finally { chart.destroy(); }
  }
  e.page.onLeave();
});

test('legend defaults are curve-owned and changes never derive from damage profiles', () => {
  const e=environment(),t=e.page.test;
  assert.equal(t.variants()[0].label,'攻：✓个体&×性格 / 防：✓个体&×性格');
  e.state.atkIV={};e.state.atkNature={attack:1};e.state.defNature={defense:2};
  assert.equal(t.variants()[0].label,'攻：✓个体&×性格 / 防：✓个体&×性格');
  t.view.overrides.atkNature.attack=2;assert.match(t.variants().at(-1).label,/负性格/);
});

test('chart reads initialized native state on mount and releases its one state-event listener on leave', () => {
  const e = environment(), t = e.page.test, toggles = [];
  e.context.AppPreferences = { isMaximized: () => true };
  e.context.document.querySelector = selector => selector === '.chart-page'
    ? { classList: { toggle: (...args) => toggles.push(args) } } : null;
  t.setActive(true); t.bindFeatures();
  assert.deepEqual(toggles[0], ['chart-window-maximized', true]);
  assert.equal(e.events.get('appwindowstatechange').size, 1);
  t.cleanupFeatures(); t.bindFeatures();
  assert.equal(e.events.get('appwindowstatechange').size, 1);
  e.page.onLeave();
  assert.equal(e.events.get('appwindowstatechange').size, 0);
});
