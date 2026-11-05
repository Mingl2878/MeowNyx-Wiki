'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const family = require('../js/petdex-family.js');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const pet = (id, name, extra = {}) => ({ id, name, localized: { zh: { name } }, form: 'default', ...extra });
const fixture = () => [
  pet(1, '幼鸟', { form_category: '主形态' }),
  pet(2, '岚鸟', { evolves_from_id: 1, form_category: '主形态' }),
  pet(3, '分支鸟', { evolves_from_id: 1 }),
  pet(4, '远端鸟', { evolves_from_id: 3 }),
  pet(5, '霜翼领主', { is_leader_form: true, leader_of_id: 2, form_category: '主形态' }),
  pet(6, '幼鸟', { main_form_id: 1, form: '春天', form_category: '变体形态' }),
  pet(7, '岚鸟', { main_form_id: 2, form: '春天', evolves_from_id: 6, form_category: '变体形态' }),
  pet(8, '霜翼领主', { main_form_id: 5, form: '春天', leader_of_id: 7, is_leader_form: true, form_category: '变体形态' }),
  pet(9, '仅源成员', { evolution_members: [1, 2, 3], dex_number: 20 }),
  pet(10, '岚鸟', { form: '未归组', main_form_name: 'default', dex_number: 20 }),
  pet(11, '隐藏节点', { hidden: true, evolves_from_id: 1 }),
  pet(12, '缺失来源', { evolves_from_id: 999, leader_of_id: 999, main_form_id: 999 }),
  pet(13, '非法首领旧指针', { is_leader_form: true, evolves_from_id: 2 })
];
const graphIds = graph => graph.nodes.map(n => n.id);
const edgeKeys = graph => graph.edges.map(e => `${e.kind}:${e.from}>${e.to}`);

test('complete upstream/downstream/branch/form/leader family is read-only and exact-ID selected', () => {
  const monsters = fixture(), before = JSON.stringify(monsters), expected = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const selectedId of expected) {
    const graph = family.build(monsters, selectedId);
    assert.deepEqual(graphIds(graph), expected);
    assert.deepEqual(graph.nodes.filter(n => n.selected).map(n => n.id), [selectedId]);
    assert.deepEqual(edgeKeys(graph), ['evolution:1>2', 'evolution:1>3', 'form:1>6', 'leader:2>5', 'form:2>7', 'evolution:3>4', 'form:5>8', 'evolution:6>7', 'leader:7>8']);
  }
  assert.equal(JSON.stringify(monsters), before);
  for (const id of [9, 10, 12, 13]) assert.deepEqual(graphIds(family.build(monsters, id)), [id]);
  assert.deepEqual(graphIds(family.build(monsters, 11)), []);
  assert.deepEqual(graphIds(family.build(monsters, 999)), []);
  monsters.find(m => m.id === 4).evolves_from_id = null;
  assert.ok(!graphIds(family.build(monsters, 2)).includes(4), 'rebuild reads live edited records');
});

test('no arrows or grouping are inferred from ordered members, source IDs, same dex or name', () => {
  const monsters = fixture();
  monsters[0].evolution_members = [9, 10, 12, 2, 1];
  monsters.forEach(m => { m.dex_number = 20; m.source_ref = { id: 'same-source' }; });
  assert.deepEqual(graphIds(family.build(monsters, 1)), [1, 2, 3, 4, 5, 6, 7, 8]);
  const index = family.formIndex(monsters);
  assert.equal(index.parentById.get(7), 2);
  assert.equal(index.parentById.has(10), false);
  monsters[6].main_form_id = 5; // cross-name bad relation must not relocate 岚鸟 under leader
  assert.equal(family.formIndex(monsters).parentById.has(7), false);
});

test('grouping preserves references and sorted root/child order without pulling filtered owners back', () => {
  const monsters = fixture(), index = family.formIndex(monsters), byId = new Map(monsters.map(m => [m.id, m]));
  const sorted = [8, 5, 7, 2, 3, 6, 1].map(id => byId.get(id));
  const grouped = family.groupVisible(sorted, index);
  assert.deepEqual(grouped.map(m => m.id), [5, 8, 2, 7, 3, 1, 6]);
  assert.ok(grouped.every(m => byId.get(m.id) === m));
  assert.deepEqual(family.groupVisible([byId.get(8), byId.get(7)], index).map(m => m.id), [8, 7]);
  assert.deepEqual(family.groupVisible([], index), []);
});

function compactIds(paths, references = false) {
  return paths.flatMap(p => [...p.steps.filter(s => references || !s.reference).map(s => s.node.id), ...compactIds(p.branches.map(b => b.path), references)]);
}
const renderedIds = html => [...html.matchAll(/data-related-id="(\d+)"/g)].map(m => Number(m[1]));

test('compact paths retain shared prefixes once and keep per-form progressions separate', () => {
  const monsters = fixture(), graph = family.build(monsters, 7), paths = family.compact(graph);
  assert.deepEqual(family.compact(graph), paths);
  assert.deepEqual(paths.map(p => p.steps.map(s => s.node.id)), [[1], [6, 7, 8]]);
  assert.deepEqual(paths[0].branches.map(b => b.path.steps.map(s => s.node.id)), [[2, 5], [3, 4]]);
  assert.deepEqual(compactIds(paths).sort((a,b)=>a-b), graphIds(graph));
  assert.deepEqual(edgeKeys(family.build([...monsters].reverse(), 7)), edgeKeys(graph), 'stable source/local ID order');
  assert.deepEqual(family.compact(family.build([...monsters].reverse(), 7)), paths);
  assert.ok(paths[0].branches.every(b => b.edge.kind !== 'form'));
  assert.equal(family.layout, undefined, 'fixed graph placement API removed');
  assert.equal(family.centerSelected, undefined, 'inner scrolling API removed');
});

test('compact rendering terminates cycles without dropping nodes or duplicating selected buttons', () => {
  const monsters = fixture(); monsters[0].evolves_from_id = 4;
  const graph = family.build(monsters, 1), paths = family.compact(graph), html = family.render(graph);
  assert.deepEqual(compactIds(paths).sort((a,b)=>a-b), graphIds(graph));
  assert.ok(compactIds(paths, true).length > compactIds(paths).length, 'back-edge stays a plain reference');
  assert.deepEqual(renderedIds(html).sort((a,b)=>a-b), graphIds(graph));
  assert.equal((html.match(/aria-current="true"/g)||[]).length,1);
  assert.match(html,/data-family-reference-id="1"/);
  assert.doesNotMatch(html, /<img|<svg|<canvas|style=/);
});

test('render is names and arrows only, escapes text, and preserves accessible relationship kinds', () => {
  const monsters = fixture(); monsters[6].localized.zh.name = monsters[1].localized.zh.name = '<岚鸟 "测试">';
  monsters[6].form = '春天<&>'; monsters[6].image = '测试".png';
  const html = family.render(family.build(monsters, 7));
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
  assert.match(html, /data-related-id="7"[^>]*aria-current="true"/);
  assert.doesNotMatch(html, /<岚鸟|<img|<svg|<canvas|src=|style=/);
  assert.match(html, /&lt;岚鸟 &quot;测试&quot;&gt;/);
  assert.match(html, /春天&lt;&amp;&gt;/);
  assert.match(html, /data-family-edge="evolution"/);
  assert.match(html, /data-family-edge="leader"/);
  assert.doesNotMatch(html, /data-family-edge="form"|petdex-family-form-group|petdex-family-legend|petdex-family-current/);
  assert.match(html, /同名形态：/);
  assert.match(html, /首领化/);
  assert.match(html, />⇢<\/span>/);
  assert.match(html, /type="button"/);
  assert.deepEqual(renderedIds(family.render(family.build(monsters, 9))), [9]);
  assert.equal(family.render(family.build(monsters, 999)), '');
});

function realMonsters() { return require('../js/catalog-data.js').toLegacy(JSON.parse(source('data/catalog.json'))).monsters; }

test('real 蓝珠天鹅 fork is shared 乖乖鹄→蓝珠天鹅 prefix with 45-degree upper and lower arrows', () => {
  const monsters = realMonsters(), swan = monsters.find(m => m.localized.zh.name === '蓝珠天鹅');
  const graph = family.build(monsters, swan.id), paths = family.compact(graph), html = family.render(graph);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].steps.map(s => s.node.monster.localized.zh.name), ['乖乖鹄','蓝珠天鹅']);
  assert.deepEqual(paths[0].branches.map(b => b.path.steps[0].node.monster.localized.zh.name), ['翠顶夫人','黑羽夫人']);
  assert.match(html,/data-from-id="179" data-to-id="180"[^>]*>→<\/span>/);
  assert.match(html,/data-from-id="180" data-to-id="181"[^>]*>↗<\/span>/);
  assert.match(html,/data-from-id="180" data-to-id="182"[^>]*>↘<\/span>/);
  assert.deepEqual(renderedIds(html),[179,180,181,182]);
  assert.equal((html.match(/aria-current="true"/g)||[]).length,1);
});

test('four real seasonal paths preserve corresponding forms without cross-linking or repeating names', () => {
  const monsters = realMonsters(), graph = family.build(monsters, 50), paths = family.compact(graph), html = family.render(graph);
  assert.deepEqual(paths.map(p => p.steps.map(s => s.node.id)), [[40,44,48,49],[41,45,50,53],[42,46,51,54],[43,47,52,55]]);
  assert.ok(paths.every(p => !p.branches.length));
  for (const p of paths) {
    const forms = p.steps.map(s => s.node.monster.form);
    assert.ok(forms.every(f => f === forms[0]), 'no other season slips into this path');
    assert.deepEqual(p.steps.slice(1).map(s => s.edge.kind), ['evolution','evolution','leader']);
  }
  assert.deepEqual(renderedIds(html).sort((a,b)=>a-b),graphIds(graph));
  assert.equal((html.match(/aria-current="true"/g)||[]).length,1);
  assert.match(html, /data-related-id="50"[^>]*aria-current="true"/);
  assert.doesNotMatch(html, /<img|<svg|<canvas|style=/);
});

test('every real family renders every available ID exactly once with one current text marker', () => {
  const monsters = realMonsters();
  for (const selected of monsters.filter(m => !m.hidden)) {
    const graph = family.build(monsters, selected.id), html = family.render(graph);
    assert.deepEqual(renderedIds(html).sort((a,b)=>a-b), graphIds(graph), `family ${selected.id}`);
    assert.equal((html.match(/aria-current="true"/g)||[]).length,1,`current ${selected.id}`);
    assert.equal((html.match(/data-family-edge=/g)||[]).length,graph.edges.filter(e=>e.kind!=='form').length,`arrows ${selected.id}`);
    assert.doesNotMatch(html, /<img|<svg|<canvas|style=|data-family-reference-id=/);
  }
});

test('real detail renderer places compact relations on the right and navigation retains exact form and petdex projection', () => {
  const monsters = fixture(); monsters.forEach(m => { m.base_spd = 60; });
  let buttons = [], currentId = null;
  const modal = { style: {} }, moveModal = { style: {} };
  const body = {
    _html: '', scrollTop: 100,
    set innerHTML(html) {
      this._html = html;
      buttons = [...html.matchAll(/<button[^>]*data-related-id="(\d+)"[^>]*>/g)].map(match => ({ dataset: { relatedId: match[1] }, events: {}, addEventListener(kind, fn) { this.events[kind] = fn; } }));
    },
    get innerHTML() { return this._html; },
    querySelector: () => null,
    querySelectorAll: selector => selector === '[data-related-id]' ? buttons : []
  };
  const displayName = m => m.name + (m.form !== 'default' ? `（${m.form}）` : '');
  const projectedSpeeds = [];
  const RKData = {
    getMonsters: () => monsters, getMonsterById(id) { currentId = id; return monsters.find(m => m.id === id); },
    getMonsterDisplayName: displayName, getMonsterDisplayNameHtml: displayName, getMonsterName: m => m.name,
    getTotalStats(m) { projectedSpeeds.push(m.base_spd); return 0; }, getEffectiveStats: () => 0,
    getTraitInfo: () => ({}), getWikiData: () => null, getResolvedWikiData: () => null,
    getTypes: () => [], getMoves: () => [], buildTraitDetailHtml: () => ''
  };
  const context = vm.createContext({ RKData, PetDexFamily: family,
    window: { AppPreferences: { getTrickRoom: () => true } },
    document: { getElementById: id => ({ 'pet-modal': modal, 'pet-modal-body': body, 'move-modal': moveModal })[id] },
    getComputedStyle: () => ({ zIndex: '200' }), console: { error(...args) { throw new Error(args.join(' ')); } },
    CommonUI: { destroyWithin() {}, SkillPicker: { renderSkillList: () => '', bindFilterEvents() {} } },
    ListingUI: { onStatsChange() {} }
  });
  vm.runInContext(source('js/pages/petdex.js'), context);
  const page = vm.runInContext('PetDexPage', context);
  page.showPetDetail(7, { petdex: true });
  assert.equal(currentId, 7); assert.match(body.innerHTML, /data-related-id="7"[^>]*aria-current="true"/);
  const left = body.innerHTML.slice(body.innerHTML.indexOf('detail-col-1'), body.innerHTML.indexOf('detail-col-2'));
  assert.doesNotMatch(left, /petdex-family/);
  const right = body.innerHTML.slice(body.innerHTML.indexOf('detail-col-3'));
  assert.ok(right.indexOf('petdex-family') > right.indexOf('0.25倍'));
  buttons.find(b => b.dataset.relatedId === '8').events.click();
  assert.equal(currentId, 8); assert.match(body.innerHTML, /data-related-id="8"[^>]*aria-current="true"/);
  assert.equal((body.innerHTML.match(/aria-current="true"/g) || []).length, 1);
  assert.ok(projectedSpeeds.every(speed => speed === 140), 'node navigation preserves the originating petdex projection');
  assert.equal(modal.style.display, 'flex'); assert.equal(modal.style.zIndex, 300); assert.equal(body.scrollTop, 0);
});

test('compact family stretches against the centered right-column parent and left-aligns title plus paths', () => {
  const base = source('css/style.css'), css = source('css/petdex-family.css');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const familyRules = rules.filter(match => match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim() === '.petdex-family');
  assert.equal(familyRules.length, 1, 'edit the original section rule rather than layering corrective overrides');
  assert.match(base, /\.detail-col-3\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*align-items:\s*center/);
  assert.match(base, /\.detail-col-3 \.detail-matchup\s*\{\s*width:\s*100%/);
  assert.match(familyRules[0][2], /align-self:\s*stretch\s*;/, 'auto-width section reaches both edges of its flex column');
  assert.match(familyRules[0][2], /text-align:\s*left\s*;/, 'title and wrapped text inherit left alignment');
  assert.doesNotMatch(css, /(?:justify-content|justify-items|text-align|align-self):\s*(?:center|end|flex-end)|margin-(?:left|inline-start):|padding-(?:left|inline-start):/);
  const html = family.render(family.build(fixture(), 7));
  assert.match(html, /^<section class="petdex-family"[^>]*><div class="detail-section-title">进化与形态<\/div><div class="petdex-family-paths">/);
  assert.doesNotMatch(html, /style=|<img|<svg|<canvas/);
});

test('resources are registered, old under-image relation code is removed, and new graph follows right-column matchup', () => {
  const html = source('index.html'), code = source('js/pages/petdex.js'), css = source('css/petdex-family.css');
  assert.ok(html.indexOf('js/petdex-family.js') < html.indexOf('js/pages/petdex.js'));
  assert.match(html, /css\/petdex-family\.css/);
  assert.doesNotMatch(code, /detail-relations|getFormGroupKey|getEvolutionMembers\(/);
  const left = code.slice(code.indexOf('<div class="detail-col-1">'), code.indexOf('<div class="detail-col-2">'));
  assert.doesNotMatch(left, /buildRelationsHtml/);
  const right = code.slice(code.indexOf('<div class="detail-col-3">'), code.indexOf('${skillsHtml ?'));
  assert.ok(right.indexOf('buildRelationsHtml(m)') > right.indexOf('resist025Html'));
  assert.match(code, /showPetDetail\(Number\(button\.dataset\.relatedId\), \{ petdex \}\)/);
  assert.doesNotMatch(code, /centerSelected/);
  assert.doesNotMatch(css, /\.calc-root|\.search-dropdown|\.detail-col-[123]|position:\s*absolute|overflow:\s*(?:auto|scroll|hidden)|(?:^|[;{]\s*)(?:max-)?height:|border:\s*[^0]|border-radius:|box-shadow:|background:/);
  assert.doesNotMatch(source('js/petdex-family.js') + css, /petdex-family-(?:canvas|scroll|lines|form-group|legend|current)|function layout|<svg|<img/);
  assert.match(css, /flex-wrap:\s*wrap/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /\.petdex-family-node\.is-selected\s*\{[^}]*color:[^}]*font-weight:\s*700/);
  assert.match(css, /:focus-visible/);
  const c = vm.createContext({}); vm.runInContext(source('js/petdex-family.js'), c);
  assert.equal(typeof c.PetDexFamily.build, 'function');
});
