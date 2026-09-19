const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const common = read('js/common.js');
class Pill {
  constructor(dimension, value) {
    this.attributes = { ['data-filter-' + dimension]: value }; this.dataset = {};
    this.listeners = {}; this.children = []; this.classes = new Set();
    this.classList = { toggle: (key, value) => value ? this.classes.add(key) : this.classes.delete(key) };
  }
  hasAttribute(key) { return key in this.attributes; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  querySelector() { return this.children[0] || null; }
  appendChild(child) { this.children.push(child); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  removeEventListener(type, fn) { if (this.listeners[type] === fn) delete this.listeners[type]; }
  send(type, extra = {}) {
    const event = { button: 0, key: '', shiftKey: false, repeat: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    this.listeners[type]?.(event); return event;
  }
}
function runtime() {
  const context = vm.createContext({ document: { createElement: () => ({ setAttribute() {} }) } });
  const start = common.indexOf('  const FilterExclusion =');
  const end = common.indexOf('  const SkillPicker =', start);
  vm.runInContext(common.slice(start, end) + '\nglobalThis.filters = FilterExclusion;', context);
  return context.filters;
}
test('left/right toggle neutral/include/exclude mutually exclusively', () => {
  const F = runtime(), s = F.create();
  F.toggle(s, 'type', '状态'); assert.ok(s.include.type.has('状态'));
  F.toggle(s, 'type', '状态', true); assert.ok(!s.include.type.has('状态')); assert.ok(s.exclude.type.has('状态'));
  F.toggle(s, 'type', '状态', true); assert.equal(F.hasSelection(s), false);
  F.toggle(s, 'type', '状态', true); F.toggle(s, 'type', '状态'); assert.ok(!s.exclude.type.size);
  F.toggle(s, 'type', '状态'); assert.equal(F.hasSelection(s), false);
});
test('includes are OR within dimension and AND between dimensions; exclusions remove union', () => {
  const F = runtime(), s = F.create();
  for (const type of ['物攻', '魔攻']) F.toggle(s, 'type', type);
  F.toggle(s, 'elem', '水'); F.toggle(s, 'energy', '10+', true);
  F.toggle(s, 'season', 'S1', true);
  assert.ok(F.matches(s, { type: '魔攻', elem: '水', energy: 9, season: 'S2' }));
  for (const row of [{ type: '状态', elem: '水', energy: 9, season: 'S2' }, { type: '魔攻', elem: '火', energy: 9, season: 'S2' }, { type: '魔攻', elem: '水', energy: 10, season: 'S2' }, { type: '魔攻', elem: '水', energy: 9, season: 'S1' }]) assert.equal(F.matches(s, row), false);
});
test('energy zero, 10+ and original power buckets retain exact boundaries', () => {
  const F = runtime(), s = F.create();
  F.toggle(s, 'energy', '0'); assert.ok(F.matches(s, { energy: 0 }));
  assert.equal(F.matches(s, { energy: null }), false);
  F.toggle(s, 'energy', '0'); F.toggle(s, 'power', '40', true);
  for (const value of [21, 30, 40]) assert.equal(F.matches(s, { power: value }), false);
  for (const value of [0, 20, 41, null]) assert.ok(F.matches(s, { power: value }));
  F.toggle(s, 'power', '140+', true); assert.equal(F.matches(s, { power: 140 }), false);
  assert.ok(F.matches(s, { power: 139 }));
});
test('search + exclusions never mutate master moves or source data', () => {
  const F = runtime(), s = F.create(); const moves = JSON.parse(read('data/moves.json'));
  const before = JSON.stringify(moves);
  F.toggle(s, 'type', 'Status', true);
  const keyword = '状态';
  const expected = moves.filter(m => m.move_category !== 'Status' && (m.localized.zh.name + m.localized.zh.description).includes(keyword));
  const actual = moves.filter(m => (m.localized.zh.name + m.localized.zh.description).includes(keyword))
    .filter(m => F.matches(s, { type: m.move_category }));
  assert.deepEqual(actual.map(m => m.id), expected.map(m => m.id)); assert.equal(JSON.stringify(moves), before);
});
test('button exclusion is unmistakable by minus, strike class and accessible state', () => {
  const F = runtime(), s = F.create(), button = new Pill('type', '状态'); let calls = 0;
  F.bind({ querySelectorAll: () => [button] }, s, () => calls++);
  assert.equal(button.getAttribute('role'), 'button'); assert.equal(button.getAttribute('tabindex'), '0');
  button.send('contextmenu'); assert.ok(button.classes.has('filter-excluded'));
  assert.equal(button.children[0].textContent, '−'); assert.equal(button.children[0].hidden, false);
  assert.match(button.getAttribute('aria-label'), /已排除/); assert.equal(button.getAttribute('aria-pressed'), 'mixed');
  button.send('contextmenu'); assert.equal(button.children[0].hidden, true); assert.equal(calls, 2);
  assert.match(read('css/listing-ui.css'), /filter-excluded[\s\S]*text-decoration: line-through/);
});
test('Enter/Space include, shifted variants exclude, repeat suppressed and handlers cleaned', () => {
  const F = runtime(), s = F.create(), button = new Pill('elem', '水'); let calls = 0;
  const cleanup = F.bind({ querySelectorAll: () => [button] }, s, () => calls++);
  for (const key of ['Enter', ' ']) {
    const e = button.send('keydown', { key }); assert.ok(e.prevented && e.stopped); assert.ok(s.include.elem.has('水'));
    button.send('keydown', { key, shiftKey: true }); assert.ok(s.exclude.elem.has('水')); assert.ok(!s.include.elem.size);
    button.send('keydown', { key, shiftKey: true }); assert.equal(F.hasSelection(s), false);
  }
  button.send('keydown', { key: 'Enter', repeat: true }); assert.equal(calls, 6);
  cleanup(); assert.equal(Object.keys(button.listeners).length, 0);
});
test('bindings only target value pills, do not install global context menu or pointer handlers', () => {
  const F = runtime(), s = F.create(); let selector;
  F.bind({ querySelectorAll: value => { selector = value; return []; } }, s, () => {});
  assert.ok(!selector.includes('data-sort-key'));
  const helper = common.slice(common.indexOf('  const FilterExclusion ='), common.indexOf('  const SkillPicker ='));
  assert.ok(!helper.includes("document.addEventListener")); assert.ok(!helper.includes("'mousedown'"));
  assert.ok(!helper.includes('localStorage')); assert.ok(!helper.includes('UserConfig'));
});
test('monster details opt in explicitly while shared team callers stay unchanged', () => {
  assert.match(read('js/pages/petdex.js'), /bindFilterEvents\(body, undefined, \{ allowExclusion: true \}\)/);
  assert.match(common, /if \(options.allowExclusion === true\)/);
  assert.ok(!read('js/pages/team.js').includes('allowExclusion'));
  assert.match(common, /const filterState = FilterExclusion.create\(\)/);
  assert.match(common, /container.id === 'pet-modal-body'/);
});
test('display ID passed to central card renderer; variable-power detail uses shared helper', () => {
  assert.match(common, /power: power, moveId: moveId/);
  const moves = read('js/pages/moves.js');
  assert.match(moves, /power: mv.power, moveId: mv.id/);
  assert.match(moves, /RKData.isVariablePowerMove\(mv\) \? '\?' : mv.power/);
});
test('source group counts and learnset rendering unaffected by display filtering', () => {
  const source = common.slice(common.indexOf('    function renderSkillList'), common.indexOf('    return { renderFilterBar'));
  const emitted = []; const context = vm.createContext({ RKData: { buildSkillCardHtml: opts => { emitted.push(opts); return '<div>skill</div>'; } } });
  vm.runInContext(source + '\nglobalThis.render = renderSkillList', context);
  const skills = [{ name: 'a', type: '状态', element: '水', source: '默认' }, { name: 'a', type: '状态', element: '水', source: '技能石' }, { name: 'b', type: '物攻', element: '水', source: '默认' }];
  const before = JSON.stringify(skills), html = context.render(skills, [], {});
  assert.equal(emitted.length, 3); assert.equal(JSON.stringify(skills), before);
  assert.match(html, /默认 <span class="detail-skill-count">2/);
  assert.match(html, /技能石 <span class="detail-skill-count">1/);
});
