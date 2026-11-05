'use strict';
// Deterministic DOM/events for the real shared selector and anchored-layer lifecycle.
// No browser, dependencies, network, filesystem writes or real profile access.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function runtime(monsters) {
  let document;
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type, props = {}) {
      const e = { target: this, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
      for (const fn of [...(this.listeners.get(type) || [])]) fn.call(this, e);
      return e;
    }
    count() { return [...this.listeners.values()].reduce((n, list) => n + list.size, 0); }
  }
  class Element extends Target {
    constructor(tag = 'div') {
      super(); this.tagName = tag; this.children = []; this.parentNode = null; this.style = {}; this.dataset = {}; this.value = ''; this.className = '';
      this.classList = { contains: n => this.className.split(' ').includes(n), toggle: (n, yes) => { const s = new Set(this.className.split(' ')); if (yes) s.add(n); else s.delete(n); this.className = [...s].join(' '); } };
    }
    get parentElement() { return this.parentNode; }
    get isConnected() { return this === document.body || !!this.parentNode?.isConnected; }
    appendChild(node) { node.remove(); node.parentNode = this; this.children.push(node); return node; }
    insertBefore(node, sibling) { node.remove(); node.parentNode = this; this.children.splice(this.children.indexOf(sibling), 0, node); }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    setAttribute(key, value) { this[key] = value; }
    getBoundingClientRect() { return { left: 20, right: 620, top: 100, bottom: 140, width: 600, height: 40 }; }
    set innerHTML(html) {
      this.html = html; this.children.forEach(c => { c.parentNode = null; }); this.children = [];
      for (const m of html.matchAll(/<div class="autocomplete-item" data-(monster|item)-id="([^"]+)"/g)) {
        const item = new Element(); item.className = 'autocomplete-item'; item.dataset[m[1] + 'Id'] = m[2]; this.appendChild(item);
        // Nested text target exercises delegated clicks, rather than only root-item clicks.
        item.appendChild(new Element('span'));
      }
    }
    get innerHTML() { return this.html || ''; }
    querySelectorAll(selector) { return this.children.flatMap(c => [...(c.classList.contains(selector.slice(1)) ? [c] : []), ...c.querySelectorAll(selector)]); }
    closest(selector) { return this.classList.contains(selector.slice(1)) ? this : this.parentNode?.closest(selector); }
    scrollIntoView() {}
    focus() { if (document.activeElement === this) return; document.activeElement?.emit('blur'); document.activeElement = this; this.emit('focus'); }
    click() { if (this.tagName === 'input') this.focus(); const e = this.emit('click'); for (let p = this.parentNode; p && !e.stopped; p = p.parentNode) p.emit('click', e); }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; this.emit('select'); }
  }
  document = new Target(); document.body = new Element('body'); document.createElement = tag => new Element(tag);
  const window = new Target(); window.innerWidth = 1200; window.innerHeight = 800; window.__getPageZoom = () => 1;
  const timers = new Map(); let nextTimer = 0;
  const RKData = { getMonsters: () => monsters, getMonsterById: id => monsters.find(m => Number(m.id) === id),
    getMonsterName: m => m.localized?.zh?.name || m.name, getMonsterDisplayName: m => m.displayName || m.localized?.zh?.name || m.name };
  const context = vm.createContext({ document, window, RKData, getComputedStyle: el => ({ position: 'static', display: el.style.display || 'block' }),
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id) });
  const source = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('const CommonUI')), context);
  const api = vm.runInContext('CommonUI', context);
  return { document, window, RKData, api, timers,
    box(opts = {}) { const box = api.createSearchBox(opts); document.body.appendChild(box.wrapper); return box; },
    type(box, value) { box.input.value = value; box.input.emit('input'); },
    ids: box => box.dropdown.style.display === 'none' ? [] : box.dropdown.querySelectorAll('.autocomplete-item').map(e => Number(e.dataset.monsterId)),
    pick(box, id) { const item = box.dropdown.querySelectorAll('.autocomplete-item').find(e => e.dataset.monsterId === String(id)); if (!item) throw Error('Missing candidate ' + id); item.children[0].click(); },
    key(box, key, props = {}) { const e = document.emit('keydown', { target: box.input, key, ...props }); if (!e.stopped) box.input.emit('keydown', { key, ...props }); },
    runTimers() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } }
  };
}
module.exports = { runtime };
