'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { runtime: searchRuntime } = require('./selection-search-fixture.cjs');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const ids = values => Array.from(values, m => m.id);
const pet = (id, extra = {}) => ({ id, localized: { zh: { name: '隔离精灵' + id } }, form: 'default',
  evolution_stage: '高级形态', learnset_mode: 'own', main_type: { name: 'Normal' }, ...extra });
const skill = name => ({ name, source: '默认', type: '物攻', element: '普通' });
function relationFixture() {
  return [
    pet(1, { evolution_members: [3, 2, 1, 3, 999, 4], evolves_from_id: 2 }),
    pet(2, { evolution_members: [2, 5] }),
    pet(3, { evolution_members: [3], evolves_from_id: 2 }),
    pet(4, { evolution_members: [1, 5], hidden: true }),
    pet(5, { evolves_from_id: 1 }), pet(6, { evolves_from_id: 1, evolution_members: [] }),
    pet(379, { localized: { zh: { name: '月亮砣' } }, form: '上弦', dex_number: 377, evolution_members: [379] }),
    pet(380, { localized: { zh: { name: '月亮砣' } }, form: '下弦', dex_number: 377, evolution_members: [380] }),
    pet(621, { localized: { zh: { name: '满月砣' } }, form: '上弦', dex_number: 377, is_leader_form: true,
      evolution_stage: '首领形态', leader_of_id: 379, evolution_members: [621] }),
    pet(622, { localized: { zh: { name: '满月砣' } }, form: '下弦', dex_number: 377, is_leader_form: true,
      evolution_stage: '首领形态', leader_of_id: 380, evolution_members: [622], learnset_mode: 'inherit', learnset_inherits_from_id: 380 }),
    pet(623, { is_leader_form: true, dex_number: 377, evolves_from_id: 379 }),
    pet(624, { is_leader_form: true, leader_of_id: 999 }),
    pet(625, { is_leader_form: true, leader_of_id: 622 }),
    pet(626, { is_leader_form: true, leader_of_id: 379, hidden: true }),
    pet(501)
  ];
}
async function runtime(monsters = relationFixture(), wiki = {}) {
  const nodes = new Map(), memory = new Map(), alerts = [], writes = [];
  const resources = { 'data/monsters.json': monsters, 'data/moves.json': [
    { id: 1, localized: { zh: { name: '普通攻击' } }, move_category: 'Physical Attack', move_type: { name: 'Normal', localized: { zh: '普通' } } },
    { id: 2, localized: { zh: { name: '状态' } }, move_category: 'Status' }
  ], 'data/types.json': [], 'data/wiki_monster_data.json': wiki };
  const context = vm.createContext({ console: { log() {}, error() {}, warn() {} }, window: {},
    document: { getElementById: id => nodes.get(id) || null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { writes.push([key, value]); memory.set(key, value); } },
    alert: value => alerts.push(value), fetch: async file => {
      assert.ok(Object.hasOwn(resources, file), 'fixture-only fetch: ' + file);
      return { ok: true, json: async () => resources[file] };
    },
    CommonUI: { FilterExclusion: { create: () => ({}) }, destroyWithin() {} },
    ListingUI: { mountAttributePriority() {}, monsterTable: mons => mons.map(m => `<tr data-monster-id="${m.id}"></tr>`).join('') }
  });
  for (const file of ['js/battle-math.js', 'js/monster-identity.js', 'js/data.js', 'js/petdex-family.js']) vm.runInContext(source(file), context);
  const api = vm.runInContext('RKData', context); await api.init();
  function page(file, name, exports) {
    const code = source('js/pages/' + file + '.js').replace(/return \{ render, ([^\n]+) \};\s*\}\)\(\);\s*$/, (_, members) => `return { render, ${members}, ${exports} };\n})();`);
    vm.runInContext(code, context); return vm.runInContext(name, context);
  }
  return { api, monsters, context, nodes, memory, alerts, writes, page };
}

test('data relation helpers are read-only, ordered, asymmetric, live and never parent/dex/name closures', async () => {
  const r = await runtime(), { api } = r, before = JSON.stringify(r.monsters);
  assert.deepEqual(ids(api.getEvolutionMembers(1)), [3, 2, 1, 4]);
  assert.deepEqual(ids(api.getEvolutionMembers(api.getMonsterById(2))), [2, 5]);
  assert.deepEqual(ids(api.getEvolutionMembers(3)), [3]);
  for (const id of [5, 6, 999]) assert.deepEqual(ids(api.getEvolutionMembers(id)), []);
  assert.equal(JSON.stringify(r.monsters), before);
  api.getMonsterById(1).evolution_members = [];
  assert.deepEqual(ids(api.getEvolutionMembers(1)), []);
  api.getMonsterById(1).evolution_members = [5, 2];
  assert.deepEqual(ids(api.getEvolutionMembers(1)), [5, 2], 'new field values are read without an init/cache rebuild');
});

test('upper/lower moon leader pairings never swap by dex and absent/invalid sources stay absent', async () => {
  const { api } = await runtime();
  assert.deepEqual(ids(api.getLeaderForms(379)), [621, 626]);
  assert.deepEqual(ids(api.getLeaderForms(380)), [622]);
  assert.equal(api.getLeaderBase(621).id, 379); assert.equal(api.getLeaderBase(622).id, 380);
  for (const id of [379, 623, 624, 625, 999]) assert.equal(api.getLeaderBase(id), null);
  assert.deepEqual(ids(api.getLeaderForms(621)), []);
  api.getMonsterById(621).leader_of_id = 380;
  assert.deepEqual(ids(api.getLeaderForms(379)), [626]);
  assert.equal(api.getLeaderBase(621).id, 380, 'explicit current field is authoritative');
});

test('shared selector separates direct leader candidates from source members and applies filters/callback rules', async () => {
  const { api } = await runtime(), h = searchRuntime(api.getMonsters());
  Object.assign(h.RKData, { getLeaderBase: api.getLeaderBase, getLeaderForms: api.getLeaderForms });
  const picked = [], box = h.box({ onSelect: m => picked.push(m.id), filter: m => m.id !== 622 });
  box.setValue(api.getMonsterDisplayName(api.getMonsterById(379)), api.getMonsterById(379));
  box.input.click(); assert.deepEqual(h.ids(box), [621]); assert.match(box.dropdown.innerHTML, /首领化/);
  assert.deepEqual(picked, []);
  h.pick(box, 621); box.input.click(); assert.deepEqual(h.ids(box), [379]);
  assert.match(box.dropdown.innerHTML, /普通来源/); assert.deepEqual(picked, [621]);
  h.pick(box, 379); assert.deepEqual(picked, [621, 379]);
  box.setValue(api.getMonsterDisplayName(api.getMonsterById(380)), api.getMonsterById(380));
  box.input.click(); assert.deepEqual(h.ids(box), [], 'extraFilter applies to leader candidates too');
  box.setValue(api.getMonsterDisplayName(api.getMonsterById(623)), api.getMonsterById(623));
  box.input.click(); assert.deepEqual(h.ids(box), [], 'old ordinary pointer cannot impersonate leader source');
});

test('explicit learning own/inherit are independent of leader and evolution relations; invalid inherit cannot fall back', async () => {
  const mons = relationFixture(), wiki = {};
  for (const m of mons) wiki[m.localized.zh.name + (m.form === 'default' ? '' : `（${m.form}）`)] = { monster_id: m.id, skills: [skill('技能' + m.id)] };
  const { api } = await runtime(mons, wiki);
  assert.equal(api.resolveSkillSource(621).reason, 'explicit-own');
  assert.equal(api.getResolvedWikiData(621).skills[0].name, '技能621');
  assert.equal(api.resolveSkillSource(622).sourceMonster.id, 380);
  assert.equal(api.getResolvedWikiData(622).skills[0].name, '技能380');
  api.getMonsterById(621).evolution_members = [380, 622]; api.getMonsterById(621).leader_of_id = 380;
  assert.equal(api.getResolvedWikiData(621).skills[0].name, '技能621');
  api.getMonsterById(622).learnset_inherits_from_id = null;
  assert.equal(api.resolveSkillSource(622).reason, 'invalid-explicit-source'); assert.equal(api.getResolvedWikiData(622), null);
  api.getMonsterById(622).learnset_inherits_from_id = 999;
  assert.equal(api.getResolvedWikiData(622), null);
});

test('legacy records lacking learning mode keep an explicitly isolated edge fallback, never member/leader inheritance', async () => {
  const monsters = [pet(31, { learnset_mode: undefined, evolution_stage: '基础形态', evolution_members: [31, 32] }), pet(32),
    pet(33, { learnset_mode: undefined, is_leader_form: true, leader_of_id: 32, evolution_members: [33, 32] }),
    pet(34, { learnset_mode: undefined, evolution_stage: '基础形态' }), pet(35, { evolves_from_id: 34 }),
    pet(36, { learnset_mode: 'future-mode', evolution_stage: '基础形态' }), pet(37, { evolves_from_id: 36 })];
  const wiki = Object.fromEntries(monsters.map(m => [m.localized.zh.name, { monster_id: m.id, skills: [skill('技能' + m.id)] }]));
  const { api } = await runtime(monsters, wiki);
  assert.equal(api.resolveSkillSource(31).sourceMonster.id, 31);
  assert.equal(api.resolveSkillSource(33).sourceMonster.id, 33);
  assert.equal(api.resolveSkillSource(34).sourceMonster.id, 35);
  assert.equal(api.resolveSkillSource(34).reason, 'unique-high-descendant');
  assert.equal(api.resolveSkillSource(36).sourceMonster.id, 36);
  assert.equal(api.resolveSkillSource(36).reason, 'unknown-mode-own-fallback');
});

test('pet detail alone uses complete explicit graph, without source-member guesses or leader cross-pairing', async () => {
  const r = await runtime(), page = r.page('petdex', 'PetDexPage', 'buildRelationsHtml');
  let html = page.buildRelationsHtml(r.api.getMonsterById(1));
  assert.deepEqual([...html.matchAll(/data-related-id="(\d+)"/g)].map(m => +m[1]), [2, 1, 5, 6, 3], 'compact flow lists actual ancestor before its branches');
  assert.match(html, /data-family-edge="evolution" data-from-id="2" data-to-id="1"/);
  assert.match(html, /data-family-edge="evolution" data-from-id="2" data-to-id="3"/);
  assert.doesNotMatch(html, /data-family-edge="evolution" data-from-id="1" data-to-id="3"/);
  assert.match(html, /data-related-id="1"[^>]*aria-current="true"/);
  r.api.getMonsterById(3).evolves_from_id = 1;
  html = page.buildRelationsHtml(r.api.getMonsterById(1));
  assert.match(html, /data-family-edge="evolution" data-from-id="1" data-to-id="3"/);
  html = page.buildRelationsHtml(r.api.getMonsterById(621));
  assert.match(html, /data-family-edge="leader" data-from-id="379" data-to-id="621"/);
  assert.match(html, /data-related-id="621"[^>]*aria-current="true"/);
  assert.doesNotMatch(html, /data-related-id="380"|data-related-id="623"|data-related-id="625"/);
  html = page.buildRelationsHtml(r.api.getMonsterById(623));
  assert.deepEqual([...html.matchAll(/data-related-id="(\d+)"/g)].map(m => +m[1]), [623], 'isolated relation presentation is only its name');
  assert.doesNotMatch(html, /data-family-edge=/);
  assert.deepEqual(ids(r.api.getEvolutionMembers(1)), [3, 2, 1, 4], 'shared flat source members unchanged');
});

test('team returns leaders to explicit ordinary ID, rejects stale cross-pair choices without rewriting saved config', async () => {
  const r = await runtime(), page = r.page('team', 'TeamPage', 'getTeamDisplayMonster, selectSearchMonster, applyGroupData, getCurrentGroupData, search: () => searchKeyword');
  const saved = { team: [379, 380], detailBloodline: { 379: 'Leader', 380: 'Leader' }, leaderFormId: { 379: 622, 380: 621 },
    petNatures: { 379: { hp: 1 } }, petIVs: { 379: { hp: true } }, petSkills: { 379: ['保留技能'] } };
  page.applyGroupData(saved); const before = JSON.stringify(saved);
  assert.equal(page.getTeamDisplayMonster(379).id, 379); assert.equal(page.getTeamDisplayMonster(380).id, 380);
  assert.equal(JSON.stringify(saved), before); assert.equal(r.writes.length, 0);
  saved.leaderFormId[379] = 621; assert.equal(page.getTeamDisplayMonster(379).id, 621);
  saved.leaderFormId[379] = null; assert.equal(page.getTeamDisplayMonster(379).id, 379);
  page.selectSearchMonster(r.api.getMonsterById(621)); assert.equal(page.search(), '月亮砣（上弦）');
  page.selectSearchMonster(r.api.getMonsterById(622)); assert.equal(page.search(), '月亮砣（下弦）');
  page.selectSearchMonster(r.api.getMonsterById(623)); assert.equal(page.search(), '月亮砣（下弦）');
  assert.deepEqual(r.alerts, ['普通来源不可用']); assert.equal(r.writes.length, 0);
  assert.deepEqual(plain(page.getCurrentGroupData().petNatures), saved.petNatures);
  assert.deepEqual(plain(page.getCurrentGroupData().petIVs), saved.petIVs);
  assert.deepEqual(plain(page.getCurrentGroupData().petSkills), saved.petSkills);
});

test('real team leader dropdown returns to ordinary without touching individual/skill data and rejects a changed pair', async () => {
  const r = await runtime();
  const page = r.page('team', 'TeamPage', 'bindLeaderFormSelect, getTeamDisplayMonster, getCurrentGroupData, configure(g) { groups = [g]; activeGroupId = g.id; applyGroupData(g); }');
  const makeNode = () => ({ style: {}, dataset: {}, events: {}, children: [],
    addEventListener(type, fn) { this.events[type] = fn; },
    click() { this.events.click?.call(this, { stopPropagation() {} }); },
    getBoundingClientRect: () => ({ bottom: 30, left: 10 }),
    remove() { r.nodes.delete(this.id); }, querySelectorAll() { return this.children; } });
  const trigger = makeNode(); r.nodes.set('leader-form-trigger', trigger);
  r.context.document.createElement = () => {
    const node = makeNode();
    Object.defineProperty(node, 'innerHTML', { set(html) {
      this.children = [...html.matchAll(/data-lf-id="([^"]*)"/g)].map(match => {
        const child = makeNode(); child.dataset.lfId = match[1]; return child;
      });
    } });
    return node;
  };
  r.context.document.body = { appendChild(node) { r.nodes.set(node.id, node); } };
  r.context.setTimeout = () => 1; // No global document handler is needed for this local click test.
  const saved = { id: 'fixture', selectedDetailId: 379, team: [379], detailBloodline: { 379: 'Leader' },
    leaderFormId: { 379: 621 }, petNatures: { 379: { hp: 1 } }, petIVs: { 379: { hp: true } }, petSkills: { 379: ['保留'] } };
  page.configure(saved); page.bindLeaderFormSelect(); trigger.click();
  let menu = r.nodes.get('leader-form-dropdown');
  assert.deepEqual(menu.children.map(n => n.dataset.lfId), ['', '621']);
  menu.children[0].click();
  assert.equal(page.getTeamDisplayMonster(379).id, 379); assert.equal(page.getCurrentGroupData().leaderFormId[379], null);
  assert.equal(r.writes.length, 1);
  const accepted = JSON.parse(r.memory.get('rk_team_config')).groups[0];
  for (const key of ['petNatures', 'petIVs', 'petSkills']) assert.deepEqual(accepted[key], saved[key]);
  trigger.click(); menu = r.nodes.get('leader-form-dropdown');
  r.api.getMonsterById(621).leader_of_id = 380;
  menu.children[1].click();
  assert.equal(page.getTeamDisplayMonster(379).id, 379); assert.equal(r.writes.length, 1);
  assert.deepEqual(r.alerts, ['首领形态不可用']);
});

test('damage team avatar and coaster lookup use the correct explicit ordinary form, never first same-dex', async () => {
  const r = await runtime(), page = r.page('damage', 'DamagePage', 'renderQuickTeam, getCoasterSkills');
  const group = { id: 'isolated', team: [379, 501, 380], detailBloodline: { 379: 'Leader', 380: 'Leader' },
    petSkills: { 501: ['普通攻击', '状态'] } };
  const raw = JSON.stringify({ activeGroupId: group.id, groups: [group] }); r.memory.set('rk_team_config', raw);
  const grid = { innerHTML: '', querySelectorAll: () => [] }; r.nodes.set('quick-team-grid', grid);
  page.renderQuickTeam();
  assert.deepEqual([...grid.innerHTML.matchAll(/data-pet-id="(\d+)"/g)].map(m => +m[1]), [379, 621, 501, 380, 622]);
  assert.deepEqual(Array.from(page.getCoasterSkills(r.api.getMonsterById(621)), s => s.name), []);
  assert.deepEqual(Array.from(page.getCoasterSkills(r.api.getMonsterById(622)), s => s.name), ['普通攻击']);
  assert.deepEqual(Array.from(page.getCoasterSkills(r.api.getMonsterById(623))), []);
  assert.equal(r.memory.get('rk_team_config'), raw); assert.equal(r.writes.length, 0);
});

test('move learner collapse needs a direct ordinary edge, independent own leaders remain in single/intersection views', async () => {
  const monsters = [pet(1, { evolution_members: [1, 2, 3] }), pet(2, { evolution_members: [2, 3] }),
    pet(3, { evolves_from_id: 2, evolution_members: [3, 2] }),
    pet(4, { is_leader_form: true, leader_of_id: 1, evolution_members: [4], evolves_from_id: 1 }),
    pet(5, { is_leader_form: true, leader_of_id: 2, learnset_mode: 'inherit', learnset_inherits_from_id: 2 })];
  const wiki = Object.fromEntries(monsters.map(m => [m.localized.zh.name, { monster_id: m.id, skills: [skill('共同技能'), skill('交集技能')] }]));
  const r = await runtime(monsters, wiki), page = r.page('moves', 'MovesPage', 'deduplicateByEvolution, getMoveLearners, updateMultiSkillResult, configure() { multiSkillSelected = ["交集技能"]; detailStyle = "table"; }');
  assert.deepEqual(ids(page.deduplicateByEvolution(monsters.filter(m => !m.hidden).map(monster => ({ monster }))).map(i => i.monster)), [1, 3, 4, 5]);
  assert.deepEqual(ids(page.getMoveLearners('共同技能').selfLearnDedup.map(i => i.monster)), [1, 3, 4]);
  const result = { innerHTML: '', querySelector: () => null }; r.nodes.set('multi-skill-result', result);
  page.configure(); page.updateMultiSkillResult('共同技能');
  assert.deepEqual([...result.innerHTML.matchAll(/data-monster-id="(\d+)"/g)].map(m => +m[1]), [1, 3, 4]);
});
