'use strict';
// Focused root-source render/callback proof. In-memory API only; production
// catalog/default rules are read-only. No app, relay, network or data writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const harnessPath = path.join(__dirname, 'battle-archetypes-ui.test.js');
const harness = fs.readFileSync(harnessPath, 'utf8');
const box = { module: { exports: {} }, require: createRequire(harnessPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
vm.runInNewContext(harness.slice(0, harness.indexOf('\ntest(')) + '\nmodule.exports={runtime,dto,catalog,freeze};', box, { filename: harnessPath });
const { runtime, dto, catalog, freeze } = box.module.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const nodes = (r, cls, host) => r.all(host).filter(node => node.className.split(' ').includes(cls));
const branch = (r, key) => r.find(node => node.dataset.brStats === key);
const response = body => ({ ok: true, json: async () => body });
const warning = '目前技能个体性格的统计还有问题，勉强可以参考';
async function mount(t, options = {}) {
  const stats = options.stats || dto(), before = JSON.stringify(stats);
  const r = runtime({ stats: freeze(stats), data: catalog, ...options });
  t.after(() => { assert.equal(JSON.stringify(stats), before); r.page.onLeave(); });
  await tick(); assert.equal(r.calls.some(call => call.url.includes('/stats?')), false);
  r.btn('样本统计').click(); await tick();
  return r;
}

test('four independent named modules preserve old species IDs; own warnings only, environment remains inside enemy lineup', async t => {
  const r = await mount(t), nav = nodes(r, 'br-stats-tabs')[0];
  const names = ['我方精灵统计', '我方阵容统计', '敌方精灵统计', '敌方阵容统计'];
  const keys = ['me', 'me-lineups', 'enemy', 'enemy-lineups'];
  assert.deepEqual(Array.from(nav.children, n => n.textContent), names);
  assert.equal(branch(r, 'me').id, 'br-stats-me'); assert.equal(branch(r, 'enemy').id, 'br-stats-enemy');
  assert.equal(nodes(r, 'br-own-stats-warning').length, 2);
  for (const key of keys) {
    const host = branch(r, key), alerts = nodes(r, 'br-own-stats-warning', host);
    assert.equal(alerts.length, key.startsWith('me') ? 1 : 0);
    for (const alert of alerts) {
      assert.equal(alert.tagName, 'small'); assert.equal(alert.textContent, warning);
      assert.equal(alert.parentNode.children[0].textContent, host.getAttribute('aria-label'));
    }
  }
  assert.ok(nodes(r, 'br-performance-table', branch(r, 'me')).length);
  assert.equal(nodes(r, 'br-lineup-row', branch(r, 'me')).length, 0);
  assert.equal(nodes(r, 'br-performance-table', branch(r, 'me-lineups')).length, 0);
  assert.equal(nodes(r, 'br-lineup-row', branch(r, 'me-lineups')).length, 2);
  assert.equal(nodes(r, 'br-archetype-row', branch(r, 'enemy')).length, 0);
  const environment = r.find(n => n.dataset.enemyModule === 'environment');
  assert.equal(environment.parentNode, branch(r, 'enemy-lineups'));
  assert.match(environment.textContent, /敌方环境统计.*去重对战 10 场/);
  assert.deepEqual(Array.from(nodes(r, 'br-environment-rate'), n => n.textContent), ['均衡体系 4 / 10 场 · 40.0%', '雷霆体系 4 / 10 场 · 40.0%', '其他 2 / 10 场 · 20.0%']);
  const calls = r.calls.length;
  keys.forEach((key, index) => {
    r.btn(names[index]).click();
    assert.equal(branch(r, key).hidden, false);
    assert.equal(nav.children[index].getAttribute('aria-pressed'), 'true');
    assert.ok(keys.filter(k => k !== key).every(k => branch(r, k).hidden));
  });
  assert.equal(r.calls.length, calls); assert.equal(r.tracked.length, 0);
  assert.equal(r.calls.some(c => c.options.method), false);
});

test('all real default team core names occupy a separate first row and every normalized anyOf group keeps its own members and avatars', async t => {
  const project = path.join(__dirname, '..');
  const source = require('../scripts/lib/catalog-data.js').readLegacy(project);
  const defaults = JSON.parse(fs.readFileSync(path.join(project, 'data/default-battle-rules.json'), 'utf8'));
  const normalized = require('../js/battle-rule-families.js').normalizeRules(defaults, source.monsters);
  const data = { getMonsters: () => source.monsters, getMonsterById: id => source.monsters.find(p => p.id === id),
    getMonsterDisplayName: p => p.localized.zh.name, getMoves: () => source.moves, getMoveName: s => s.localized.zh.name };
  const stats = dto(); stats.archetypes.teams = normalized.map(rule => ({ ...stats.archetypes.teams[0], ...rule }));
  // A second independent OR must not be silently flattened into the first one.
  const wolf = stats.archetypes.teams.find(team => team.id === 'wolf');
  wolf.anyOf = [...wolf.anyOf, [35, 42]];
  const r = await mount(t, { stats, data, handle: url => url.endsWith('/rules') ? response({ rules: normalized, sourceRules: defaults, revision: 'fixture-rules' }) : null });
  r.btn('敌方阵容统计').click();
  const cores = nodes(r, 'br-archetype-core', branch(r, 'enemy-lineups'));
  assert.equal(cores.length, normalized.length);
  for (const [index, core] of cores.entries()) {
    const team = stats.archetypes.teams[index];
    assert.equal(core.children[0].tagName, 'strong'); assert.equal(core.children[0].textContent, team.name);
    assert.equal(core.children[0].children.length, 0);
    const groups = r.all(core).filter(n => n.dataset.coreAnyGroup !== undefined);
    assert.equal(groups.length, (team.anyOf || []).length, team.name);
    groups.forEach((group, i) => {
      assert.equal(group.dataset.coreAnyGroup, String(i));
      const roster = nodes(r, 'br-lineup-roster', group)[0];
      assert.deepEqual(Array.from(roster.children, n => n.textContent.trim()), team.anyOf[i].map(id => data.getMonsterDisplayName(data.getMonsterById(id))));
      assert.equal(r.all(roster).filter(n => n.tagName === 'img').length, team.anyOf[i].length);
    });
  }
  const wolfCore = cores.find(core => core.children[0].textContent === wolf.name);
  assert.match(wolfCore.textContent, /任选组（组间全部满足）/);
  assert.ok(wolfCore.textContent.includes('卡瓦重'), 'wolf alternative core must include 卡瓦重');
  const picker = r.selectors[0];
  const everyCandidate = picker.opts.search('');
  assert.equal(everyCandidate.length, source.monsters.length, 'full currently selected root catalog remains searchable');
  for (const p of source.monsters) {
    const candidate = everyCandidate.find(item => item.id === p.id);
    assert.ok(candidate, `catalog species ${p.id} omitted`);
    if (p.image && !/[\\:#\x00-\x1f]/.test(p.image)) assert.ok(candidate.icon.startsWith('assets/monster/images/'), `avatar ${p.id}`);
  }
  assert.equal(r.calls.some(c => c.options.method), false);
});

test('explicit normalized empty alternatives never merge source-rule branches; omitted legacy fields alone use loaded normalized rule', async t => {
  const rules = [{ id: 'balance', name: '已载入规则', monsterIds: [42], anyOf: [[35, 8]] }];
  const stats = dto(); stats.archetypes.teams = [
    { ...stats.archetypes.teams[0], anyOf: [] },
    { ...stats.archetypes.teams[0], name: '旧字段兼容' }
  ];
  const r = await mount(t, { stats, handle: url => url.endsWith('/rules') ? response({ rules, sourceRules: [{ ...rules[0], anyOf: [[35, 8, 501]] }], revision: 'fixture-rules' }) : null });
  r.btn('敌方阵容统计').click();
  const cores = nodes(r, 'br-archetype-core', branch(r, 'enemy-lineups'));
  assert.equal(r.all(cores[0]).filter(n => n.dataset.coreAnyGroup !== undefined).length, 0);
  const group = r.all(cores[1]).find(n => n.dataset.coreAnyGroup === '0');
  assert.ok(group); assert.match(group.textContent, /精灵35.*精灵8/); assert.doesNotMatch(group.textContent, /精灵501/);
  assert.equal(r.calls.some(c => c.options.method), false);
});

test('own exact-lineup skill entries show confirmed owner avatar, preserve duplicate species aggregate and never fall back to opponent/global usage', async t => {
  const stats = dto(), lineup = stats.selfPerformance.completeLineups[0];
  lineup.selfSkills = [
    { monsterId: 35, skillId: 37, casts: 2 }, { monsterId: 35, skillId: 37, casts: 1 },
    { monsterId: 42, skillId: 38, casts: 5 }, { skillId: 38, casts: 99999 },
    { monsterId: 0, skillId: 37, casts: 99999 }, { monsterId: 501, skillId: 38, casts: 99999 }
  ];
  stats.selfSkills = [{ monsterId: 35, skillId: 38, casts: 88888 }];
  const r = await mount(t, { stats }); r.btn('我方阵容统计').click();
  const row = nodes(r, 'br-lineup-row', branch(r, 'me-lineups'))[0], calls = r.calls.length;
  row.emit('keydown', { key: 'Enter', target: row });
  const modal = nodes(r, 'br-modal-root')[0]; assert.equal(modal.dataset.modalKind, 'own-lineup');
  const roster = nodes(r, 'br-lineup-roster', modal)[0]; assert.equal(roster.children.length, 3);
  const usage = nodes(r, 'br-own-skill-usage', modal); assert.equal(usage.length, 2, 'one aggregate per confirmed species, not invented per-instance split');
  const entries = nodes(r, 'br-skill-owner-line', modal); assert.equal(entries.length, 2);
  for (const entry of entries) {
    const id = Number(entry.dataset.skillOwnerMonsterId), images = r.all(entry).filter(n => n.tagName === 'img');
    assert.equal(images[0].src, `assets/monster/images/p${id}.png`);
    assert.ok(entry.getAttribute('aria-label').startsWith(`精灵${id}：`));
    assert.equal(images.length, 2, 'caster avatar and skill icon are separate');
  }
  assert.match(usage[0].textContent, /均衡技能 3 次 100\.0%/);
  assert.match(usage[1].textContent, /雷霆技能 5 次 100\.0%/);
  assert.doesNotMatch(modal.textContent, /88888|99999/);
  assert.equal(r.calls.length, calls); assert.equal(r.tracked.length, 0);
  r.root.document.emit('keydown', { key: 'Escape' }); assert.equal(nodes(r, 'br-modal-root').length, 0);
  assert.equal(r.root.document.activeElement, row);
});

test('new battle CSS uses natural-flow title/core/owner layout and leaves modal sizing and legend declarations unchanged', () => {
  const css = fs.readFileSync(path.join(__dirname, '../css/battle-records.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.br-archetype-core\s*\{\s*display:\s*grid;\s*gap:\s*8px;/);
  assert.match(css, /\.br-archetype-core > strong\s*\{\s*display:\s*block;/);
  assert.match(css, /\.br-own-stats-warning\s*\{[^}]*font-size:\s*11px/);
  assert.match(css, /\.br-skill-owner-line > \.br-image-pet\s*\{\s*width:\s*28px;\s*height:\s*28px;/);
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/br-archetype-core|br-own-stats/.test(rule[1]) || /\.br-skill-owner-line\s*$/.test(rule[1])) assert.doesNotMatch(rule[2], /(?:^|;)\s*(?:position:\s*(absolute|fixed)|(?:min-|max-)?height:\s*\d)/);
  }
  assert.match(css, /\.br-dialog\s*\{\s*width:\s*min\(1080px,\s*100%\)/);
  assert.match(css, /\.br-member-dialog\s*\{\s*width:\s*min\(1120px,\s*100%\)/);
  assert.match(css, /\.br-member-legend li\s*\{\s*display:\s*flex;\s*gap:\s*6px/);
});
