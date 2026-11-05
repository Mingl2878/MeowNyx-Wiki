'use strict';
// Reusable in-memory DOM/runtime for actual SpeedPage rendering, isolated from player data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const fixturePet = (id, name, base_spd, extra = {}) => ({ id, localized: { zh: { name } }, base_spd, evolution_stage: '高级形态', ...extra });
function fixtures() {
  // Isolated from the concurrently updated catalog, including a same-base generic99.
  return [
    fixturePet(1, '普通同速', 70), fixturePet(2, '另一同速', 70),
    fixturePet(619, '冥古龙', 70, { default_level: 99, level_configurable: true, evolution_stage: '待定' }),
    fixturePet(800, '通用等级', 103, { default_level: 89, level_configurable: true }),
    fixturePet(801, '低速搜索', 33, { evolution_stage: '初级形态' }),
    fixturePet(3, '形态测试', 70, { form_category: '主形态', form: '原始' }),
    fixturePet(4, '形态测试', 70, { form_category: '变体形态', form: '地区', main_form_name: '原始' }),
    fixturePet(802, '通用同速等级', 70, { default_level: 99, level_configurable: true })
  ];
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// Deterministic DOM/event fixture, not a browser substitute. Parses the production
// table, models actual node reuse/focus/disabled controls and bubbling. Native
// Enter/Space defaults are explicitly simulated by press(), separately from handlers.
const decode = s => s.replace(/&(lt|gt|amp|quot|#39);/g, (_, key) => ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" }[key]));
const dataKey = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class Element {
  constructor(doc, tag) { this.doc = doc; this.tagName = tag; this.childNodes = []; this.parentElement = null; this.attrs = {}; this.dataset = {}; this.style = {}; this.events = new Map(); this.value = ''; this._text = ''; }
  get children() { return this.childNodes.filter(n => n.tagName !== '#text'); }
  get isConnected() { return this.doc.syntheticLayout && this.doc.body.contains(this); }
  // Opt-in synthetic metrics exercise production capacity/slicing, not browser layout/CSS.
  get offsetWidth() { return this.textContent.length * 8; }
  get clientWidth() { return 300; }
  get classList() { return { add: name => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(' '); }, remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); } }; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 34, width: 300, height: 34 }; }
  scrollIntoView() { this.scrolledIntoView = true; }
  get className() { return this.attrs.class || ''; }
  set className(value) { this.attrs.class = value; }
  get id() { return this.attrs.id || ''; }
  set id(value) { this.attrs.id = value; }
  get disabled() { return 'disabled' in this.attrs; }
  set disabled(value) { if (value) this.attrs.disabled = ''; else delete this.attrs.disabled; }
  get textContent() { return this.tagName === '#text' ? this._text : this.childNodes.map(n => n.textContent).join(''); }
  set textContent(value) { this.clear(); const text = new Element(this.doc, '#text'); text._text = String(value); this.appendChild(text); }
  get innerHTML() { return this.childNodes.map(n => n.outerHTML).join(''); }
  get outerHTML() {
    if (this.tagName === '#text') return this._text;
    const attrs = { ...this.attrs, ...Object.fromEntries(Object.entries(this.dataset).map(([k, v]) => ['data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), v])) };
    const start = `<${this.tagName}${Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>`;
    return ['input', 'col', 'img', 'br'].includes(this.tagName) ? start : `${start}${this.innerHTML}</${this.tagName}>`;
  }
  set innerHTML(html) {
    this.clear(); const stack = [this];
    for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) { stack.pop(); continue; }
      if (token.startsWith('<!--')) continue;
      if (token.startsWith('<')) {
        const tag = token.match(/^<([\w-]+)/)[1], element = new Element(this.doc, tag);
        for (const m of token.slice(tag.length + 1, -1).matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) element.setAttribute(m[1], decode(m[2] || ''));
        stack.at(-1).appendChild(element);
        if (!['input', 'col', 'img', 'br'].includes(tag)) stack.push(element);
      } else {
        const text = new Element(this.doc, '#text'); text._text = decode(token); stack.at(-1).appendChild(text);
      }
    }
  }
  setAttribute(key, value) { if (key.startsWith('data-')) this.dataset[dataKey(key.slice(5))] = String(value); else this.attrs[key] = String(value); }
  getAttribute(key) { return key.startsWith('data-') ? this.dataset[dataKey(key.slice(5))] ?? null : this.attrs[key] ?? null; }
  clear() { for (const n of [...this.childNodes]) n.remove(); }
  remove() {
    if (!this.parentElement) return;
    if (this.contains(this.doc.activeElement)) this.doc.activeElement = null;
    const list = this.parentElement.childNodes; list.splice(list.indexOf(this), 1); this.parentElement = null;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) { node.remove(); const i = before ? this.childNodes.indexOf(before) : this.childNodes.length; assert.ok(i >= 0); this.childNodes.splice(i, 0, node); node.parentElement = this; return node; }
  contains(node) { return this === node || this.childNodes.some(n => n.contains(node)); }
  matches(selector) {
    if (selector.endsWith(':last-child')) { if (this.parentElement?.children.at(-1) !== this) return false; selector = selector.replace(':last-child', ''); }
    if (selector.includes(':not(:disabled)')) { if (this.disabled) return false; selector = selector.replace(':not(:disabled)', ''); }
    const tag = selector.match(/^[\w-]+/); if (tag && this.tagName !== tag[0]) return false;
    for (const m of selector.matchAll(/\.([\w-]+)/g)) if (!this.className.split(/\s+/).includes(m[1])) return false;
    for (const m of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) { const value = this.getAttribute(m[1]); if (value === null || (m[2] !== undefined && value !== m[2])) return false; }
    return this.tagName !== '#text';
  }
  querySelectorAll(selector) {
    const columnLabel = /^tr > :nth-child\((\d+)\) \.speed-column-label$/.exec(selector);
    if (columnLabel) return this.querySelectorAll('tr').flatMap(row => row.children[Number(columnLabel[1]) - 1]?.querySelectorAll('.speed-column-label') || []);
    const parts = selector.trim().split(/\s+/), match = n => {
      if (!n.matches(parts.at(-1))) return false;
      let parent = n.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) { while (parent && !parent.matches(parts[i])) parent = parent.parentElement; if (!parent) return false; parent = parent.parentElement; }
      return true;
    };
    return this.children.flatMap(n => [...(match(n) ? [n] : []), ...n.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  addEventListener(type, fn) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(fn); }
  dispatch(type, extra = {}) {
    const e = { type, target: this, cancelBubble: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; }, ...extra };
    // Capture the original propagation path, even when rendering updates the DOM.
    const parents = []; for (let n = this; n; n = n.parentElement) parents.push(n);
    for (const n of parents) { e.currentTarget = n; for (const fn of n.events.get(type) || []) fn.call(n, e); n['on' + type]?.(e); if (e.cancelBubble) break; }
    return e;
  }
  click() { if (!this.disabled) return this.dispatch('click'); }
  focus() { if (!this.disabled) this.doc.activeElement = this; }
}
function runtime(pets = fixtures(), memory = new Map(), userConfig = false, leaderDisplay = null, bridge = {}) {
  const writes = [], reads = [], damageReads = [];
  let search;
  freeze(pets);
  const doc = { activeElement: null, syntheticLayout: Number.isFinite(bridge.avatarWidth), createElement: tag => new Element(doc, tag), getElementById: id => doc.body.querySelectorAll('[id]').find(n => n.id === id), querySelectorAll: selector => doc.body.querySelectorAll(selector) };
  doc.body = doc.createElement('body'); const container = doc.createElement('div'); doc.body.appendChild(container);
  const allowRead = key => { reads.push(key); assert.ok(['rk_speed_pet_priority', 'rk_speed_form_overrides', 'rk_searched_pets', 'rk_damage_view'].includes(key), `forbidden read ${key}`); };
  const readKey = key => { allowRead(key); return memory.get(key) || null; };
  const rawDamageState = { searchedPets: [2, 4], atkLevel: 1, defLevel: 43 };
  const damageState = () => new Proxy(bridge.DamagePage?.getState() || rawDamageState, { get(target, key) {
    damageReads.push(key); assert.equal(key, 'searchedPets', 'never read damage levels, personal stats or other state'); return target[key];
  } });
  const window = { addEventListener() {}, removeEventListener() {} };
  if (leaderDisplay && leaderDisplay !== 'shared') window.SpeedLeaderDisplay = leaderDisplay;
  if (bridge.UserConfig) window.UserConfig = {
    getObject(key, fallback) { allowRead(key); return bridge.UserConfig.getObject(key, fallback); },
    patch(key, value) { writes.push(key); return bridge.UserConfig.patch(key, value); }
  };
  else if (userConfig) window.UserConfig = { getObject(key, fallback) { const value = readKey(key); return value ? JSON.parse(value) : fallback; }, patch(key, value) { writes.push(key); memory.set(key, JSON.stringify({ ...JSON.parse(memory.get(key) || '{}'), ...value })); return Promise.resolve(true); } };
  const context = vm.createContext({ console, window, document: doc,
    localStorage: { getItem: readKey, setItem(key, value) { writes.push(key); memory.set(key, value); } },
    DamagePage: { getState: damageState },
    getComputedStyle: element => ({ width: element.className === 'speed-avatar-strip' ? String(bridge.avatarWidth) + 'px' : '48px', paddingLeft: '8px', paddingRight: '8px' }),
    CommonUI: { createSearchBox(options) { search = options; return { input: doc.createElement('input'), wrapper: doc.createElement('div'), setValue() {} }; }, monsterRenderItem: format => format },
    fetch() { throw Error('This speed fixture must not load canonical or player data'); }
  });
  window.localStorage = context.localStorage;
  if (bridge.DamageSpeedPriority) window.DamageSpeedPriority = bridge.DamageSpeedPriority;
  else vm.runInContext(read('js/damage-speed-priority.js'), context);
  if (leaderDisplay === 'shared') vm.runInContext(read('js/speed-leader-display.js'), context);
  for (const file of ['js/battle-math.js', 'js/pet-levels.js', 'js/data.js']) vm.runInContext(read(file), context);
  const data = vm.runInContext('RKData', context); data.getMonsters = () => pets;
  vm.runInContext(read('js/pages/speed.js').replace('return { render, onLeave };', 'return { render, onLeave, renderTierTable, calcSpeedStat, levelRows, getSpeedLevel, getState:()=>tierState, getLayout:()=>layoutState };'), context);
  const api = vm.runInContext('SpeedPage', context); api.render(container);
  return { api, data, pets, doc, memory, reads, writes, damageReads, container, display: window.SpeedLeaderDisplay, node: id => doc.getElementById(id),
    get search() { return search; }, get table() { return doc.getElementById('speed-tier-table'); },
    get rows() { return this.table.querySelectorAll('tbody tr'); },
    row(key = 'pet:619') { return this.rows.find(row => row.dataset.rowKey === key); },
    button(direction) { return this.row().querySelector(`[data-level-step="${direction}"]`); },
    click(key, col) { const cell = this.row(key)?.querySelector(`[data-col="${col}"]`); assert.ok(cell, `${key}:${col}`); cell.click(); },
    step(direction) { this.button(direction).click(); },
    level(level) { while (api.getState().mingSpeedLevel !== level) this.step(api.getState().mingSpeedLevel < level ? 1 : -1); },
    press(element, key) { element.focus(); const down = element.dispatch('keydown', { key }); if (key === 'Enter' && !down.defaultPrevented) element.click(); const up = element.dispatch('keyup', { key }); if (key === ' ' && !down.defaultPrevented && !up.defaultPrevented) element.click(); return { down, up }; },
    pools() { return new Map(this.rows.map((row, i) => [row.dataset.rowKey, Array.from(api.getLayout().rowPets[i], pet => pet.id)])); }
  };
}

module.exports = { runtime, fixtures, fixturePet };
