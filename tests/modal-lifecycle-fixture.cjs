'use strict';
// Extend the existing isolated DOM fixture with browser-style queued mutation records.
// No browser, installed DOM package, server, profiles or application startup.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const original = fs.readFileSync(path.join(__dirname, 'popup-right-close.test.js'), 'utf8');
let code = original.slice(original.indexOf('function runtime()'), original.indexOf('\nconst right ='));
code = code.replace('function runtime()', 'function runtime(withoutReleaseFallback = false)');
code = code.replace('  let document;', '  const timers = new Map(); let timerId = 0;\n  let document;');
code = code.replace("setTimeout() { throw Error('No timer needed for modal gesture'); }", 'setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id)');
code = code.replace("const common = source('js/common.js');", `let common = source('js/common.js');
  if (withoutReleaseFallback) common = common.replace(/^[^\\n]*root\\.(?:add|remove)EventListener\\('pointerup'[^\\n]*\\n/gm, '');`);
code = code.replace('  let document;', `  let document;
  let pending = false;
  const delivered = [];
  function mutation(record) {
    let matched = false;
    for (const observer of observers) {
      if (!observer.active || !observer.root) continue;
      const { root, options } = observer;
      if (record.target !== root && !(options.subtree && root.contains(record.target))) continue;
      if (record.type === 'attributes' && (!options.attributes || options.attributeFilter && !options.attributeFilter.includes(record.attributeName))) continue;
      if (record.type === 'childList' && !options.childList) continue;
      observer.records.push(record); matched = true;
    }
    if (matched && !pending) {
      pending = true;
      queueMicrotask(() => {
        pending = false;
        for (const observer of [...observers]) {
          if (!observer.active || !observer.records.length) continue;
          const records = observer.records.splice(0);
          delivered.push(...records);
          observer.fn(records, observer);
        }
      });
    }
  }`);
code = code.replace("this.style = {}; this.className = ''; this.id = ''; this.hidden = false;", `this.style = new Proxy({}, { set: (style, key, value) => {
          style[key] = value; mutation({ type: 'attributes', target: this, attributeName: 'style' }); return true;
        }}); this.className = ''; this.id = ''; this._hidden = false;`);
code = code.replace('    get parentElement()', `    get hidden() { return this._hidden; }
    set hidden(value) { this._hidden = value; mutation({ type: 'attributes', target: this, attributeName: 'hidden' }); }
    get parentElement()`);
code = code.replace('node.parentNode = this; return node;', "node.parentNode = this; mutation({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] }); return node;");
code = code.replace('    remove() { if (this.parentNode?.children) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }', `    remove() {
      const parent = this.parentNode;
      if (parent?.children) { parent.children = parent.children.filter(n => n !== this); this.parentNode = null;
        mutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] }); }
    }`);
code = code.replace("this._html = String(value); this.children.forEach(n => n.parentNode = null); this.children = [];", `this._html = String(value); const removedNodes = [...this.children]; this.children.forEach(n => n.parentNode = null); this.children = [];
      mutation({ type: 'childList', target: this, addedNodes: [], removedNodes });`);
code = code.replace('this.classList = { contains:', 'this.classList = { add: (...names) => names.forEach(n => this.classList.toggle(n, true)), remove: (...names) => names.forEach(n => this.classList.toggle(n, false)), contains:');
code = code.replace("    hasAttribute(key)", `    removeAttribute(key) { delete this.attrs[key]; }
    getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 110, width: 100, height: 100 }; }
    hasAttribute(key)`);
code = code.replace("document.activeElement = document.body;", `document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.querySelector = selector => document.body.querySelector(selector);
  document.activeElement = document.body;`);
code = code.replace("const window = new Target(); window.__getPageZoom = () => 1;", "const window = new Target(); window.__getPageZoom = () => 1;");
code = code.replace("base_spd: 80", "base_spd: 80, image: 'isolated.png'");
code = code.replace("getTypeIcon: () => 'isolated.png',", `getLeaderForms: () => [], getLeaderBase: () => null,
    getBaseStat: () => 80, getPetStat: () => 80, getTypeShortZh: () => '火',
    getTypeIcon: () => 'isolated.png',`);
code = code.replace('constructor(fn) { this.fn = fn; this.active = true; observers.add(this); }', 'constructor(fn) { this.fn = fn; this.active = true; this.records = []; observers.add(this); }');
code = code.replace('disconnect() { this.active = false; observers.delete(this); }', 'disconnect() { this.active = false; this.records = []; observers.delete(this); }');
code = code.replace('observe(root, options) { this.root = root; this.options = options; }', 'observe(root, options) { this.root = root; this.options = options; this.active = true; observers.add(this); }');
code = code.replace("seed() { petSkills = {221:['血脉测试技']}; detailBloodline = {221:'Fire'}; },", `seed() {
        petSkills = {221:['血脉测试技','普通测试技']}; detailBloodline = {221:'Fire'};
        team = [221]; teamMagic = '隔离咕噜球'; petNatures = {221:{attack:1, defense:2}}; petIVs = {221:{hp:true, attack:true}};
        groups = [{id:'isolated', name:'已有配置', ...getCurrentGroupData()}]; activeGroupId = 'isolated';
      }, renderDetail, bindPetImgClick, bindSkillSlotEvents,`);
code = code.replace('state: () => JSON.stringify({petSkills, detailBloodline})', 'state: () => JSON.stringify({...getCurrentGroupData(), groups, activeGroupId})');
code = code.replace("const flush = () => { for (const o of [...observers]) if (o.active) o.fn([]); };", `const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  const evaluate = script => vm.runInContext(script, context);`);
code = code.replace('flush, writes, data };', 'flush, writes, data, delivered, evaluate, timers, runTimers: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); } };');
// Fail loudly if a fixture refactor removes an essential queued-observer hook.
if (!code.includes('observer.records.push(record)') || !code.includes('const flush = async')) throw Error('Mutation fixture hooks missing');
const context = vm.createContext({ require, __dirname, console, queueMicrotask, vm,
  source: file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8') });
vm.runInContext(code + '\nthis.runtime = runtime;', context);
module.exports = { runtime: context.runtime };
