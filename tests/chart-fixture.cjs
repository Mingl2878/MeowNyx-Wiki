'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const BattleMath = require('../js/battle-math.js');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/pages/chart.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function environment({ data, damage } = {}) {
  const storage = new Map(), events = new Map(), frames = new Map();
  let serial = 0;
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value))
  };
  const pet = (id, defense, magic_defense, hp, type) => ({ id, defense, magic_defense, hp, attack: 123, magic_attack: 141,
    main_type: { name: type }, sub_type: { name: 'secondary' }, image: `${id}.png` });
  const pets = [pet(1, 111, 121, 130, 'weak'), pet(2, 131, 151, 160, 'resist'), pet(3, 137, 163, 145, 'neutral'), pet(4, 230, 231, 140, 'immune')];
  const state = damage ? damage.getState() : { atkPet: pets[0], defPet: pets[1], atkNature: { attack: 1 }, atkIV: { attack: true },
    defNature: { defense: 2, hp: 1 }, defIV: { hp: true }, skillType: 'attack', skillAttr: '火',
    basePower: 167, fixedBonus: 13, percentBonus: 17, buff: 21, comboCount: 3 };
  const typeCalls = [];
  const RKData = data || {
    getBaseStat: (pet, stat) => pet[stat],
    getPetLevel: pet => pet?.level_configurable ? pet.default_level || 99 : 60,
    getPetStat: (pet, stat, nature, iv, level) => BattleMath.statFromBase(pet[stat], stat, nature, iv, level ?? (pet?.level_configurable ? pet.default_level || 99 : 60)),
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
    isDatasetVisible(i) { return !this.data.datasets[i].hidden; }
    setDatasetVisibility(i, visible) { this.data.datasets[i].hidden = !visible; }
    getDatasetMeta(i) { return { hidden: this.data.datasets[i].hidden, data: [] }; }
  }
  const context = vm.createContext({ console, localStorage, RKData, BattleMath, Chart,
    DamagePage: damage || { getState: () => state, CalcEngine: { isSameType: () => true } },
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
  const controls = { atkIV:{attack:true,magic_attack:true},atkNature:{attack:0,magic_attack:0},defIV:{defense:true,magic_defense:true},hpNature:false,doubleLife:false };
  context.ChartWorkspace = {
    // These cases exercise saved custom favorites; automatic presets have their
    // own actual-data suite in chart-presets.test.js.
    isPreset:id=>typeof id==='string'&&id.startsWith('preset:'),
    getPresets:()=>[], setSurvivalContextProvider() {},
    getPreset:()=>{throw Error('No preset source in custom-favorites fixture');},
    getStatus:()=>({initialized:true}),
    getState:()=>({controls,activeGroupId:'ungrouped',groups:[{id:'ungrouped',name:'未分组',petIds:context.FavoritePets.getChartIds()}]}),
    getEntries:()=>context.FavoritePets.getChartIds().map(id=>({id,key:`chart:${id}`})),
    init:async()=>true, subscribe:()=>()=>{},
    setControls:async patch=>{for(const field of ['atkIV','atkNature','defIV'])if(patch[field])Object.assign(controls[field],patch[field]);if('hpNature'in patch)controls.hpNature=controls.doubleLife=patch.hpNature;},
    removePet:async id=>{if(!context.FavoritePets.removeChart(id))throw Error('保存失败');}
  };
  // Instrument only the in-memory test copy; no test hook in production public API.
  vm.runInContext(source.replace('return { render, onLeave, getState:', 'workspaceReady = true; applyWorkspace(); return { test: { syncWorkspaceStatus, renderGroups, presetAvailability, requirePreset, view, variants, operatingContext, survivalContext, currentEntries, renderFavorites, bindEvents, syncControls, syncBaseline, favoriteAvatarPlugin, sharedDefenderConfiguration, favoriteMarkers, markerTooltip, draw, bindFeatures, cleanupFeatures, renderChart, renderDefenseChart, renderAttackChart, setActive: value => { active = value; } }, render, onLeave, getState:'), context);
  return { api: context.FavoritePets, math: vm.runInContext('ChartFavoriteMath', context), page: vm.runInContext('ChartPage', context),
    state, pets, typeCalls, storage, localStorage, context, events, frames, element, lastChart: () => lastChart,
    set: (key, value) => localStorage.setItem(key, JSON.stringify(value)) };
}

module.exports = { environment, source, root, plain };
