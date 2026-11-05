'use strict';
// Isolated synthetic DOM only: actual CommonUI/PetDexPage/TeamPage callbacks,
// in-memory fixtures and preference cache. No browser, API, profile or DB IO.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function runtime() {
  const observers = new Set(), memory = new Map(), writes = [];
  let document;
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn, options = false) {
      const capture = options === true || options?.capture === true;
      const list = this.listeners.get(type) || [];
      if (!list.some(x => x.fn === fn && x.capture === capture)) list.push({ fn, capture });
      this.listeners.set(type, list);
    }
    removeEventListener(type, fn, options = false) {
      const capture = options === true || options?.capture === true;
      this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x.fn !== fn || x.capture !== capture));
    }
    count(type) { return (this.listeners.get(type) || []).length; }
    emit(type, values = {}) {
      const event = { type, target: this, button: 0, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
      const chain = []; for (let node = this; node; node = node.parentNode) chain.push(node);
      const invoke = (node, capture) => {
        event.currentTarget = node;
        for (const { fn, capture: c } of [...(node.listeners.get(type) || [])]) if (c === capture) fn.call(node, event);
        if (!capture) node['on' + type]?.call(node, event);
      };
      for (const node of [...chain].reverse()) { invoke(node, true); if (event.stopped) return event; }
      for (const node of chain) { invoke(node, false); if (event.stopped) return event; }
      return event;
    }
  }
  class Element extends Target {
    constructor(tag = 'div') {
      super(); this.tagName = tag; this.nodeType = 1; this.children = []; this.dataset = {}; this.attrs = {};
      this.style = {}; this.className = ''; this.id = ''; this.hidden = false; this.scrollTop = 0; this.clientHeight = 100;
      this.classList = { contains: n => this.className.split(' ').includes(n),
        toggle: (n, force) => { const next = force ?? !this.classList.contains(n); this.className = [...new Set(this.className.split(' ').filter(x => x && x !== n).concat(next ? [n] : []))].join(' '); return next; } };
    }
    get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
    get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
    appendChild(node) { node.remove(); this.children.push(node); node.parentNode = this; return node; }
    remove() { if (this.parentNode?.children) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }
    contains(node) { return node === this || this.children.some(n => n.contains(node)); }
    setAttribute(key, value) {
      this.attrs[key] = String(value);
      if (key === 'id') this.id = String(value);
      if (key === 'class') this.className = String(value);
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      if (key === 'style') for (const item of String(value).split(';')) { const index = item.indexOf(':'); if (index > 0) this.style[item.slice(0, index).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = item.slice(index + 1).trim(); }
    }
    hasAttribute(key) { return key in this.attrs; }
    getAttribute(key) { return this.attrs[key] ?? null; }
    matches(selector) {
      const excluded = selector.match(/:not\((.+)\)$/);
      if (excluded) { if (this.matches(excluded[1])) return false; selector = selector.slice(0, excluded.index); }
      if (selector === '*') return true;
      const tag = selector.match(/^[a-z]+/); if (tag && tag[0] !== this.tagName) return false;
      for (const [, id] of selector.matchAll(/#([\w-]+)/g)) if (this.id !== id) return false;
      for (const [, cls] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(cls)) return false;
      for (const [, key, op, value] of selector.matchAll(/\[([^\]=*]+)(?:(\*?=)"([^"]*)")?\]/g)) {
        const actual = key === 'style' ? Object.entries(this.style).map(([k, v]) => k + ': ' + v).join(';') : this.getAttribute(key);
        if (op === '=' ? actual !== value : op === '*=' ? !actual?.includes(value) : actual == null) return false;
      }
      return true;
    }
    closest(selector) { for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n; return null; }
    querySelectorAll(selector) { return this.children.flatMap(n => [n, ...n.querySelectorAll('*')]).filter(n => selector.split(',').some(s => n.matches(s.trim()))); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    set innerHTML(value) {
      this._html = String(value); this.children.forEach(n => n.parentNode = null); this.children = [];
      const stack = [this];
      for (const token of String(value).matchAll(/<!--[\s\S]*?-->|<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
        if (!token[1]) continue;
        if (token[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        const node = new Element(token[1]);
        for (const [, key, val] of token[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(key, val);
        stack.at(-1).appendChild(node);
        if (!['img', 'input', 'br', 'hr'].includes(node.tagName)) stack.push(node);
      }
    }
    get innerHTML() { return this._html || ''; }
    focus() { document.activeElement = this; }
    click() { return this.emit('click'); }
  }
  document = new Target(); document.children = [];
  document.body = new Element('body'); document.body.parentNode = document; document.children.push(document.body);
  document.activeElement = document.body; document.createElement = tag => new Element(tag);
  document.getElementById = id => document.body.querySelector('#' + id);
  const window = new Target(); window.__getPageZoom = () => 1;
  const monster = Object.freeze({ id: 221, name: '隔离精灵', evolution_stage: '高级形态', base_spd: 80 });
  const skills = Object.freeze([
    Object.freeze({ name: '普通测试技', source: '默认', type: '物攻', element: '火' }),
    Object.freeze({ name: '血脉测试技', source: '血脉', type: '状态', element: '火' })
  ]);
  const moves = skills.map((s, i) => ({ id: i + 1, localized: { zh: { name: s.name } }, energy_cost: 1, power: 60 }));
  const data = {
    PILL_ORDER: [], getMonsterById: id => id === monster.id ? monster : null, getMonsters: () => [monster],
    getMonsterName: m => m.name, getMonsterDisplayName: m => m.name, getMonsterDisplayNameHtml: m => m.name,
    getTotalStats: () => 80, getEffectiveStats: () => 80, getTraitInfo: () => ({ name: '', desc: '' }),
    getWikiData: () => null, getResolvedWikiData: () => ({ skills }), getMoves: () => moves, getTypes: () => [],
    getTypeIcon: () => 'isolated.png', getTypeEn: () => 'Fire', typeBadgeHtml: () => '', buildTraitDetailHtml: () => '',
    buildSkillCardHtml: o => `<div class="detail-skill-item ${o.extraClass}" ${o.extraAttrs} data-skill-energy="${o.energy}"><span class="skill-name">${o.name}</span></div>`
  };
  const context = vm.createContext({ document, window, RKData: data, PetDexFamily: { build() {}, render: () => '' },
    ListingUI: { onStatsChange() {} }, MovesPage: { showMoveDetail() {} }, console,
    localStorage: { getItem: key => memory.get(key) || null, setItem: (key, value) => { writes.push({ key, value }); memory.set(key, value); } },
    getComputedStyle: node => ({ display: node.hidden ? 'none' : node.style.display || 'block', zIndex: node.style.zIndex || '200' }),
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.active = true; observers.add(this); }
      observe(root, options) { this.root = root; this.options = options; }
      disconnect() { this.active = false; observers.delete(this); }
    }, requestAnimationFrame: fn => { fn(); return 1; }, setTimeout() { throw Error('No timer needed for modal gesture'); }
  });
  const common = source('js/common.js'); vm.runInContext(common.slice(common.indexOf('const CommonUI')), context);
  vm.runInContext(source('js/pages/petdex.js'), context);
  // Expose only the existing private callback/state inside this isolated test VM.
  vm.runInContext(source('js/pages/team.js').replace('return { render, togglePet, onLeave };',
    `return { render, togglePet, onLeave, openSkillPicker,
      seed() { petSkills = {221:['血脉测试技']}; detailBloodline = {221:'Fire'}; },
      state: () => JSON.stringify({petSkills, detailBloodline}) };`), context);
  // Actual pre-existing pet Esc/outside handlers; no router/init/application runs.
  const app = source('js/app.js');
  vm.runInContext(app.slice(app.indexOf('  // 关闭模态框'), app.indexOf('  // ===================== 夜间模式')), context);
  const ui = vm.runInContext('CommonUI', context), pet = vm.runInContext('PetDexPage', context), team = vm.runInContext('TeamPage', context);
  const element = (id, parent = document.body, tag = 'div') => { const node = new Element(tag); node.setAttribute('id', id); parent.appendChild(node); return node; };
  const modal = element('pet-modal'); modal.style.display = 'none'; element('pet-modal-body', modal);
  const flush = () => { for (const o of [...observers]) if (o.active) o.fn([]); };
  return { ui, pet, team, element, document, modal, observers, flush, writes, data };
}

const right = node => node.emit('contextmenu', { button: 2 });
const noRootHandlers = r => assert.equal(r.document.count('contextmenu'), 0, 'no global right-click interception');

test('actual alert/confirm content and backdrop right-close once; confirmation remains cancellation', async () => {
  const r = runtime(); let resolved = 0, confirmed = 0;
  const promise = r.ui.showAlert('测试'); promise.then(() => resolved++);
  let overlay = r.document.body.querySelector('.cui-popup-overlay');
  const ok = overlay.querySelector('#cui-popup-ok');
  assert.equal(overlay.count('contextmenu'), 1); assert.equal(right(ok).defaultPrevented, true);
  assert.equal(overlay.isConnected, false); assert.equal(overlay.count('contextmenu'), 0);
  ok.click(); await promise; await Promise.resolve(); assert.equal(resolved, 1);
  r.ui.showConfirm('测试', () => confirmed++); overlay = r.document.body.querySelector('.cui-popup-overlay');
  const cancelledConfirm = overlay.querySelector('#cui-popup-confirm');
  assert.equal(right(overlay).defaultPrevented, true); assert.equal(confirmed, 0); assert.equal(overlay.count('contextmenu'), 0);
  cancelledConfirm.click(); assert.equal(confirmed, 0, 'cancelled/stale confirmation cannot submit');
  r.ui.showConfirm('测试', () => confirmed++); overlay = r.document.body.querySelector('.cui-popup-overlay');
  overlay.querySelector('#cui-popup-confirm').click(); assert.equal(confirmed, 1); assert.equal(overlay.count('contextmenu'), 0);
  assert.equal([...r.observers].filter(o => o.options.attributes).length, 0); noRootHandlers(r);
});

test('actual pet detail right-close captures child filter/input/skill gestures, and reopen/Esc/outside retain lifecycle', () => {
  const r = runtime(), trigger = r.element('trigger', r.document.body, 'button'); trigger.focus();
  for (const surface of ['filter', 'skill', 'input', 'backdrop']) {
    r.pet.showPetDetail(221);
    assert.equal(r.modal.style.display, 'flex'); assert.equal(r.modal.count('contextmenu'), 1);
    const target = surface === 'filter' ? r.modal.querySelector('.detail-skill-filter-btn') :
      surface === 'skill' ? r.modal.querySelector('.detail-skill-item') :
        surface === 'input' ? r.element('inside-input', r.modal, 'input') : r.modal;
    assert.ok(target); const event = right(target);
    assert.equal(event.defaultPrevented, true); assert.equal(r.modal.style.display, 'none'); assert.equal(r.modal.count('contextmenu'), 0);
    if (surface === 'filter') assert.equal(target.dataset.filterState, 'neutral', 'close overrides local right-exclusion only inside modal');
    assert.equal(r.document.activeElement, trigger, 'pre-existing focus behavior is unchanged');
  }
  r.pet.showPetDetail(221); r.pet.showPetDetail(221); assert.equal(r.modal.count('contextmenu'), 1);
  r.document.emit('keydown', { key: 'Escape' }); assert.equal(r.modal.style.display, 'none'); r.flush(); assert.equal(r.modal.count('contextmenu'), 0);
  r.pet.showPetDetail(221); r.modal.click(); r.flush(); assert.equal(r.modal.style.display, 'none'); assert.equal(r.modal.count('contextmenu'), 0);
  r.pet.showPetDetail(221); r.ui.destroyWithin(r.modal); assert.equal(r.modal.count('contextmenu'), 0); noRootHandlers(r);
});

test('actual team picker closes every surface without changing bloodline/skills; reopens/X/done/leave remove only local handlers', () => {
  const r = runtime(); r.team.seed(); const before = r.team.state();
  for (const surface of ['bloodline', 'filter', 'input', 'backdrop']) {
    r.team.openSkillPicker(); const root = r.document.getElementById('team-skill-picker-modal');
    assert.equal(root.count('contextmenu'), 1);
    const target = surface === 'bloodline' ? root.querySelector('.detail-skill-item[data-skill-source="血脉"]') :
      surface === 'filter' ? root.querySelector('.detail-skill-filter-btn') :
        surface === 'input' ? r.element('team-input', root, 'input') : root.querySelector('.team-skill-picker-overlay');
    assert.ok(target); assert.equal(right(target).defaultPrevented, true); assert.equal(root.isConnected, false);
    assert.equal(root.count('contextmenu'), 0); assert.equal(r.team.state(), before);
  }
  r.team.openSkillPicker(); const old = r.document.getElementById('team-skill-picker-modal');
  r.team.openSkillPicker(); const reopened = r.document.getElementById('team-skill-picker-modal');
  assert.notEqual(reopened, old); assert.equal(old.count('contextmenu'), 0); assert.equal(reopened.count('contextmenu'), 1);
  old.querySelector('#team-skill-picker-close').click(); assert.equal(reopened.count('contextmenu'), 1, 'stale callback cannot detach reopened modal');
  reopened.querySelector('#team-skill-picker-close').click(); assert.equal(reopened.count('contextmenu'), 0);
  r.team.openSkillPicker(); const done = r.document.getElementById('team-skill-picker-modal'); done.querySelector('#team-skill-picker-done').click(); assert.equal(done.count('contextmenu'), 0);
  r.team.openSkillPicker(); const leaving = r.document.getElementById('team-skill-picker-modal'), writesBefore = r.writes.length;
  r.team.onLeave(); assert.equal(leaving.count('contextmenu'), 0); assert.equal(leaving.isConnected, false); assert.equal(r.writes.length, writesBefore);
  assert.equal(r.team.state(), before); noRootHandlers(r);
});

test('nested registered modal closes innermost only; helper keeps existing close focus callback and main-page menus intact', () => {
  const r = runtime(), trigger = r.element('focus-return', r.document.body, 'button'), outer = r.element('outer'), inner = r.element('inner', outer);
  const input = r.element('nested-input', inner, 'input'); let outerClosed = 0, innerClosed = 0;
  r.ui.bindModalContextMenu(outer, () => { outerClosed++; outer.remove(); });
  r.ui.bindModalContextMenu(inner, () => { innerClosed++; inner.remove(); trigger.focus(); });
  assert.equal(right(input).defaultPrevented, true); assert.equal(innerClosed, 1); assert.equal(outerClosed, 0); assert.equal(r.document.activeElement, trigger);
  assert.equal(outer.count('contextmenu'), 1); right(outer); assert.equal(outerClosed, 1);
  const skill = r.element('main-skill'), avatar = r.element('main-avatar'), native = r.element('native-input', r.document.body, 'input');
  let skillActions = 0, avatarActions = 0;
  skill.addEventListener('contextmenu', e => { skillActions++; e.preventDefault(); e.stopPropagation(); });
  avatar.addEventListener('contextmenu', e => { avatarActions++; e.preventDefault(); });
  right(skill); right(avatar); assert.equal(skillActions, 1); assert.equal(avatarActions, 1); assert.equal(right(native).defaultPrevented, false);
  const filters = r.element('main-filters'); filters.innerHTML = '<button data-filter-type="物攻"></button>';
  const state = r.ui.FilterExclusion.create(); let changed = 0;
  const disposeFilter = r.ui.FilterExclusion.bind(filters, state, () => changed++);
  assert.equal(right(filters.querySelector('button')).defaultPrevented, true); assert.equal(changed, 1); assert.equal(state.exclude.type.has('物攻'), true);
  disposeFilter(); noRootHandlers(r);
});

test('hide/removal/repeated bind release observers and roots without intercepting stale surfaces', () => {
  const r = runtime(), root = r.element('rebind'); let old = 0, current = 0;
  r.ui.bindModalContextMenu(root, () => old++); const dispose = r.ui.bindModalContextMenu(root, () => current++);
  assert.equal(root.count('contextmenu'), 1); root.style.display = 'none';
  assert.equal(right(root).defaultPrevented, false); r.flush(); assert.equal(root.count('contextmenu'), 0); dispose();
  root.style.display = 'flex'; r.ui.bindModalContextMenu(root, () => current++); root.remove(); r.flush();
  assert.equal(root.count('contextmenu'), 0); assert.equal(old, 0); assert.equal(current, 0);
  assert.equal([...r.observers].filter(o => o.options.attributes).length, 0); noRootHandlers(r);
});
