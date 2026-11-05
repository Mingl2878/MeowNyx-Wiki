'use strict';
// Isolated deterministic DOM/events; runs the real DamagePage and CommonUI
// closures, with optional real RKData. No native/browser/profile access.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const PetLevels = require('../js/pet-levels'), BattleMath = require('../js/battle-math');
const stats = ['hp', 'attack', 'magic_attack', 'defense', 'magic_defense', 'speed'];
function damageUI(options = {}) {
  let document;
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type, props = {}) {
      const event = Object.hasOwn(props, 'prevented') ? props : {target: this, prevented: false, stopped: false, preventDefault() {this.prevented = true;}, stopPropagation() {this.stopped = true;}, ...props};
      for (const fn of [...(this.listeners.get(type) || [])]) fn.call(this, event);
      return event;
    }
    count() { return [...this.listeners.values()].reduce((n, fns) => n + fns.size, 0); }
  }
  class Element extends Target {
    constructor(tag = 'div') {
      super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.style = {}; this.dataset = {}; this.attrs = {};
      this.hidden = false; this.disabled = false; this.value = ''; this.className = ''; this.textContent = ''; this.nodes = {};
      this.classList = {contains: name => this.className.split(' ').includes(name), toggle: (name, on) => {const names = new Set(this.className.split(' ')); on ? names.add(name) : names.delete(name); this.className = [...names].join(' ');}};
    }
    get isConnected() { return this === document.body || !!this.parentNode?.isConnected; }
    appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    contains(child) { return this === child || this.children.some(node => node.contains(child)); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; }
    querySelector(selector) { return this.nodes[selector] || this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) { return this.nodes[selector] || this.children.flatMap(node => [...(selector.startsWith('.') ? node.classList.contains(selector.slice(1)) : selector === 'button' && node.tagName === 'BUTTON') ? [node] : [], ...node.querySelectorAll(selector)]); }
    getBoundingClientRect() {
      if (this.rect) return this.rect;
      const zoom = window.__getPageZoom(), width = Math.min(120 * zoom, parseFloat(this.style.maxWidth || 100000) * zoom), height = Math.min(140 * zoom, parseFloat(this.style.maxHeight || 100000) * zoom);
      return {left: 20, top: 100, right: 20 + width, bottom: 100 + height, width, height};
    }
    focus() { document.activeElement = this; }
    click() { if (this.disabled) return; this.focus(); const event = this.emit('click'); for (let p = this.parentNode; p && !event.stopped; p = p.parentNode) p.emit('click', event); }
  }
  const elements = new Map(), cards = {}, writes = [], renderedModes = [];
  document = new Target(); document.body = new Element('body'); document.createElement = tag => new Element(tag);
  document.getElementById = id => elements.get(id)?.isConnected ? elements.get(id) : find(document.body, id);
  function find(node, id) { if (node.id === id) return node; for (const child of node.children) {const found = find(child, id); if (found) return found;} return null; }
  document.querySelectorAll = () => [];
  document.querySelector = selector => {
    const side = selector.includes('attacker') || selector.includes('atkStatMode') ? 'attacker' : 'defender';
    return selector.includes('StatMode') ? cards[side]?.radio : selector.endsWith('-card') ? cards[side]?.card : null;
  };
  const window = new Target(); window.innerWidth = 1000; window.innerHeight = 700; window.zoom = 1; window.__getPageZoom = () => window.zoom;
  const memory = clone(options.memory || {rk_damage_levels: {619: {attacker: {slider: 99, manual: '43', extra: 'keep'}, defender: {slider: 19, manual: ''}}}});
  const fixtures = [{id:616}, {id:617,evolves_from_id:616}, {id:595,evolves_from_id:617}, {id:619,level_configurable:true,default_level:99}, {id:77,trait:{localized:{zh:{description:'依等级变化'}}},level_min:50,level_max:80,level_step:7,default_level:60}, {id:20}].map(p => ({...p, name:'fixture-' + p.id, main_type:{name:'Normal'}}));
  const RKData = options.RKData || {getMonsters:()=>fixtures,getMonsterById:id=>fixtures.find(p=>p.id===id),getMoves:()=>[],ALL_TYPES:[],getTypeZh:x=>x,getTypeZhFull:x=>x,getTypeEn:x=>x,getBaseStat:()=>100,getPetStat:(_p,stat,nature,iv,level)=>BattleMath.statFromBase(100,stat,nature,iv,level)};
  const monsters = options.RKData ? [616,617,595,619].map(id=>RKData.getMonsterById(id)).concat(fixtures.slice(4)) : fixtures;
  const UserConfig = options.UserConfig || {getObject:(key,fallback={})=>clone(memory[key] || fallback),patch:(key,value)=>{writes.push({key,value:clone(value)});memory[key]={...memory[key],...clone(value)};return Promise.resolve(true);}};
  window.UserConfig = UserConfig;
  const context = vm.createContext({PetLevels,BattleMath,RKData,document,window,localStorage:{getItem:()=>null},SkillSimulation:require('../js/skill-simulation'),setTimeout,clearTimeout,getComputedStyle:el=>({display:el.style.display || 'block'})});
  const common = source('js/common.js'); vm.runInContext(common.slice(common.indexOf('const CommonUI')),context);
  const CommonUI = vm.runInContext('CommonUI', context);
  CommonUI.StatBox.refreshValues = (card,pet,_nature,_iv,mode) => renderedModes.push({side:Object.keys(cards).find(side=>cards[side].card===card),id:pet.id,mode});
  const damage = source('js/pages/damage.js'), marker = 'return { render, onLeave, getState: () => state, CalcEngine };';
  if (!damage.includes(marker)) throw Error('Lost public test anchor');
  vm.runInContext(damage.replace(marker,'return { render, onLeave, getState: () => state, CalcEngine, levelUI: {buildLevelControls, syncLevelControls, bindLevelControls, updateFinalStats}, battleSides };')+'\nthis.page=DamagePage;',context);
  const page = context.page, state = page.getState();
  Object.assign(state,{atkPet:monsters[2],defPet:monsters[5],atkIV:{},atkNature:{},defIV:{},defNature:{}});
  function mount(side) {
    cards[side]?.card.remove();
    const card = new Element(), group = new Element(), radio = new Element(); radio.closest = () => group;
    document.body.appendChild(card); card.appendChild(group); group.appendChild(radio);
    const items = stats.map(stat => {const item = new Element(); item.dataset = {stat}; item.nodes['.stat-value'] = new Element(); return item;});
    card.nodes['.final-stat-item'] = items; cards[side] = {card,radio,group,items};
    // Materialize controls from production markup, checking their real tag/attrs.
    const markup = page.levelUI.buildLevelControls(side); let controls;
    for (const match of markup.matchAll(/<(button|input|output|div)\b([^>]*)>/g)) {
      const node = new Element(match[1]), attrs = match[2];
      for (const attr of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {node.setAttribute(attr[1],attr[2]); if (['id','class','value','min','max','step','type'].includes(attr[1])) node[attr[1]==='class'?'className':attr[1]] = attr[2];}
      node.hidden = /\bhidden\b/.test(attrs);
      if (node.id.endsWith('level-controls')) {controls=node;card.appendChild(node);} else (controls || card).appendChild(node);
      elements.set(node.id,node);
    }
    page.levelUI.bindLevelControls(side); page.levelUI.updateFinalStats(side);
  }
  mount('attacker'); mount('defender');
  function key(node,key,extra={}) {
    const event = document.emit('keydown',{target:node,key,...extra});
    if (!event.stopped) {node.emit('keydown',event); for(let p=node.parentNode;p&&!event.stopped;p=p.parentNode)p.emit('keydown',event);}
    return event;
  }
  return {page,state,monsters,RKData,window,document,CommonUI,writes,memory,elements,cards,renderedModes,mount,key,context,
    node:(side,id)=>elements.get(`${side}-${id}`), layer:(side='attacker')=>document.getElementById(`${side}-level-options`)};
}
async function realData() {
  const readResource = require('./catalog-read-fixture.cjs').readResource;
  const context = vm.createContext({console:{log(){},error(){}},window:{},fetch:async name=>({ok:true,json:async()=>JSON.parse(readResource(root,name))})});
  for(const file of ['js/battle-math.js','js/monster-identity.js','js/pet-levels.js','js/data.js'])vm.runInContext(source(file),context);
  await vm.runInContext('RKData.init()',context); return vm.runInContext('RKData',context);
}
module.exports = {damageUI,realData};
