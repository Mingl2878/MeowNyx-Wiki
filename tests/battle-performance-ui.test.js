'use strict';
// Isolated DOM/API tests only. No browser, profile, capture, DB or filesystem writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const harnessPath = path.join(__dirname, 'battle-records-ui.test.js');
const harness = fs.readFileSync(harnessPath, 'utf8');
const sandbox = { module: { exports: {} }, require: createRequire(harnessPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
vm.runInNewContext(harness.slice(0, harness.indexOf('\ntest(')) + '\nmodule.exports = runtime;', sandbox, { filename: harnessPath });
function runtime(options) { return sandbox.module.exports(options); }
const tick = () => new Promise(resolve => setImmediate(resolve));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const nodes = (r, cls, host) => r.all(host).filter(node => node.className.split(' ').includes(cls));
const branch = (r, side = 'me') => r.find(node => node.dataset.brStats === side);
const fixture = performance => ({ matchedBattles: 7, outcomes: { win: 3, loss: 1, draw: 1, unknown: 2 }, quality: { roster: 4, actions: 3, lead: 2 },
  enemy: [{ monsterId: 42, name: '来源名不应取代资料名', carried: 3, carrySamples: 4, appeared: 2, appearSamples: 3, leads: 1, leadSamples: 2,
    skills: [{ skillId: 37, usedBattles: 1, samples: 2, casts: 3 }], profileSamples: 2, unknownProfiles: 1, ivDistributions: { hp: { 0: 1 } }, natureDistributions: { hp: { 0: 1 } } }],
  selfSkills: [{ monsterId: 35, skillId: 37, casts: 3, totalCasts: 4, usedBattles: 1, samples: 2 }], teams: [{ name: '<svg>组合', battles: 2, samples: 4 }], ...(performance === undefined ? {} : { selfPerformance: performance }) });
async function mount(t, options = {}) { const r = runtime(options); t.after(() => r.page.onLeave()); await tick(); r.btn('样本统计').click(); await tick(); return r; }
function performanceFixture() {
  const damage = (actual, estimated = 0, unresolved = 0) => ({ actual, estimated, unresolved });
  return { species: [{ monsterId: 35, carriedBattles: 4, enteredBattles: 2,
    totals: { entries: 3, kills: 2, deaths: 2, attackActions: 7, statusActions: 3, defenseActions: 4,
      attackAttempts: 6, statusAttempts: 2, defenseAttempts: 3, attackCountered: 3, statusCountered: 1, defenseSuccess: 2,
      outgoingAdvantage: 2, outgoingResisted: 1, outgoingUsual: 3, receivedActions: 5, receivedAdvantage: 2, receivedResisted: 1, receivedUsual: 1,
      damageDealt: damage(340, 300, 2), damageReceived: damage(128, 0, 1), departures: { total: 4, defeat: 1, forced: 1, self: 2, unknown: 1 } },
    averages: { entries: .75, kills: .5, deaths: .5, attackActions: 1.75, statusActions: .75, defenseActions: 1,
      attackAttempts: 1.5, statusAttempts: .5, defenseAttempts: .75, attackCountered: .75, statusCountered: .25, defenseSuccess: .5,
      outgoingAdvantage: .5, outgoingResisted: .25, outgoingUsual: .75, receivedActions: 1.25, receivedAdvantage: .5, receivedResisted: .25, receivedUsual: .25,
      damageDealt: damage(85, 75, .5), damageReceived: damage(32, 0, .25), departures: { total: 1, defeat: .25, forced: .25, self: .5, unknown: .25 } },
    attackPerDeath: 3.5, receivedPerDeath: 2.5, attackCounteredRate: .5, statusCounteredRate: .5, defenseSuccessRate: 2 / 3,
    coverage: { completeActionBattles: 1, partialActionBattles: 3, completeRosterBattles: 4, outgoingEffectivenessUnknown: 1, receivedEffectivenessUnknown: 1, unresolvedDepartures: 1 },
    departuresByOpponent: [{ monsterId: 42, attribution: 'facing', totals: { total: 2, defeat: 0, forced: 0, self: 2, unknown: 0 }, averages: { total: .5, defeat: 0, forced: 0, self: .5, unknown: 0 } },
      { monsterId: 35, attribution: 'cause', totals: { total: 2, defeat: 1, forced: 1, voluntary: 0, self: 0, unknown: 0 }, averages: { total: .5, defeat: .25, forced: .25, voluntary: 0, self: 0, unknown: 0 } },
      { monsterId: 0, attribution: 'unknown', totals: { total: 1, defeat: 0, forced: 0, voluntary: 0, self: 0, unknown: 1 }, averages: { total: .25, defeat: 0, forced: 0, voluntary: 0, self: 0, unknown: .25 } }] }],
    completeLineups: [{ monsterIds: [35, 35, 42], selfSkills: [{ monsterId: 35, skillId: 37, casts: 3 }], battles: 7, wins: 3, losses: 1, draws: 1, unknown: 2, knownOutcomes: 5, winRate: .6, averageRounds: 8.25, roundSamples: 4, averageDurationSeconds: 80.6, durationSamples: 3 },
      { monsterIds: [35, 42], selfSkills: [], battles: 2, wins: 0, losses: 0, draws: 0, unknown: 2, knownOutcomes: 0, winRate: null, averageRounds: null, roundSamples: 0, averageDurationSeconds: null, durationSamples: 0 }],
    coverage: { inputRecords: 9, includedBattles: 7, invalidBattles: 1, conflictingBattles: 1, completeLineupBattles: 5, incompleteLineupBattles: 2, unmappedOwnInstances: 1, unattributedDamageEvents: 2, unattributedKills: 1, currentCatalogReference: '<script>catalog-reference</script>' }, issues: [] };
}
const petRow = (r, id = 35) => r.find(node => node.dataset.performanceMonsterId === String(id)).parentNode.parentNode;
const metric = (r, key, row = petRow(r)) => r.all(row).find(node => node.dataset.performanceMetric === key);
const rate = (r, key, row = petRow(r)) => r.all(row).find(node => node.dataset.performanceRate === key);
const terms = (r, column) => r.all(column).filter(node => node.tagName === 'dt').map(node => node.textContent);
const catalogue = { getMonsterById: id => [35, 42, 501].includes(id) ? { id, image: id === 35 ? '本地头像.png?revision=one' : '敌方头像.png' } : null,
  getMonsterDisplayName: pet => pet.id === 35 ? '正确形态' : pet.id === 501 ? '过山车精灵' : '<img>敌方形态' };

test('five columns have exact revised metric ordering without attempts/counters as visible columns', async t => {
  const r = await mount(t, { stats: fixture(performanceFixture()), data: catalogue }), columns = petRow(r).children;
  assert.equal(columns.length, 5);
  assert.deepEqual(Array.from(terms(r, columns[0])), ['携带局数', '登场局数', '进场次数']);
  assert.deepEqual(Array.from(terms(r, columns[1])), ['击杀数', '每死攻击数', '克制伤害次数', '抵抗伤害次数', '通常伤害次数', '伤害总量']);
  assert.deepEqual(Array.from(terms(r, columns[2])), ['攻击次数', '状态次数', '防御次数', '攻击被应对率', '状态被应对率', '防御成功率']);
  assert.deepEqual(Array.from(terms(r, columns[3])), ['受击数', '每死受击数', '克制伤害次数', '抵抗伤害次数', '通常伤害次数', '受击总量']);
  assert.deepEqual(Array.from(terms(r, columns[4])), ['离场总计', '被击杀', '被迫离场', '自行离场']);
  assert.doesNotMatch(petRow(r).textContent, /普通伤害|原因未知|应对次数|被应对次数/);
  for (const key of ['attackAttempts', 'statusAttempts', 'defenseAttempts', 'attackCountered', 'statusCountered', 'defenseSuccess']) assert.equal(metric(r, key), undefined);
  assert.equal(r.btn('精灵详情').getAttribute('aria-haspopup'), 'dialog');
  assert.equal(nodes(r, 'br-performance-table')[0].tabIndex, 0);
});

test('counts use backend totals/averages while all five cumulative ratios and identity stay fixed', async t => {
  const performance = performanceFixture(), before = JSON.stringify(performance);
  const r = await mount(t, { stats: freeze(fixture(performance)), data: catalogue });
  assert.match(petRow(r).textContent, /正确形态.*携带局数 4 登场局数 2/);
  for (const [key, expected] of Object.entries({ entries: '3', kills: '2', attackActions: '7', statusActions: '3', defenseActions: '4', outgoingAdvantage: '2', outgoingResisted: '1', outgoingUsual: '3', receivedActions: '5', total: '4' })) assert.equal(metric(r, key).textContent, expected, key);
  const keys = ['attackPerDeath', 'receivedPerDeath', 'attackCounteredRate', 'statusCounteredRate', 'defenseSuccessRate'];
  const initial = keys.map(key => rate(r, key));
  assert.deepEqual(initial.map(node => node.textContent), ['3.5', '2.5', '50.0%', '50.0%', '66.7%']);
  assert.match(initial[2].title, /累计 3 \/ 6/); assert.match(initial[3].title, /累计 1 \/ 2/); assert.match(initial[4].title, /累计 2 \/ 3/);
  const count = r.calls.length, toggle = r.btn('场均'); toggle.focus(); toggle.click();
  assert.equal(r.root.document.activeElement, toggle); assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  for (const [key, expected] of Object.entries({ entries: '0.75', kills: '0.5', attackActions: '1.75', statusActions: '0.75', defenseActions: '1', outgoingUsual: '0.75', receivedActions: '1.25', total: '1' })) assert.equal(metric(r, key).textContent, expected, key);
  assert.match(petRow(r).textContent, /携带局数 4 登场局数 2/);
  assert.deepEqual(keys.map(key => rate(r, key)), initial); assert.deepEqual(initial.map(node => node.textContent), ['3.5', '2.5', '50.0%', '50.0%', '66.7%']);
  assert.equal(r.calls.length, count); assert.equal(JSON.stringify(performance), before);
  assert.equal(r.calls.some(call => call.options.method || /\/record\?|profile/.test(call.url)), false);
});

test('501 restores entered count and places both authoritative roller rates in fifth column', async t => {
  const performance = performanceFixture(), base = performance.species[0];
  const rollerCoaster = { carriedBattles: 4, successBattles: 2, knownOutcomeBattles: 1, wins: 1, successRate: .5, winRate: 1 };
  base.rollerCoaster = rollerCoaster; performance.species.push({ ...base, monsterId: 501 });
  const before = JSON.stringify(performance), r = await mount(t, { stats: freeze(fixture(performance)), data: catalogue }), rollerRow = petRow(r, 501);
  assert.deepEqual(Array.from(terms(r, rollerRow.children[0])), ['携带局数', '登场局数', '进场次数']);
  assert.deepEqual(Array.from(terms(r, petRow(r, 35).children[0])), ['携带局数', '登场局数', '进场次数']);
  assert.match(rollerRow.children[0].textContent, /登场局数 2/);
  assert.match(rollerRow.children[0].textContent, /携带局数 4/); assert.equal(metric(r, 'entries', rollerRow).textContent, '3');
  assert.equal(rate(r, 'rollerCoasterSuccess'), undefined);
  assert.equal(rate(r, 'rollerCoasterSuccess', rollerRow).textContent, '50.0%'); assert.equal(rate(r, 'rollerCoasterWin', rollerRow).textContent, '100.0%');
  assert.match(rate(r, 'rollerCoasterWin', rollerRow).title, /累计 1 \/ 1/);
  r.btn('场均').click(); assert.equal(rate(r, 'rollerCoasterSuccess', rollerRow).textContent, '50.0%'); assert.equal(rate(r, 'rollerCoasterWin', rollerRow).textContent, '100.0%');
  assert.equal(metric(r, 'entries', rollerRow).textContent, '0.75'); assert.match(rollerRow.children[0].textContent, /携带局数 4/);
  assert.match(rollerRow.children[0].textContent, /登场局数 2/); assert.match(petRow(r, 35).children[0].textContent, /登场局数 2/);
  assert.equal(JSON.stringify(performance), before);
});

test('null, missing and zero-denominator ratios stay unavailable without inventing zero', async t => {
  for (const denominator of [0, null, undefined, -1, Infinity]) {
    const performance = performanceFixture(), row = performance.species[0]; row.monsterId = 501;
    row.totals.deaths = row.totals.attackAttempts = row.totals.statusAttempts = row.totals.defenseAttempts = denominator;
    row.rollerCoaster = { carriedBattles: denominator, successBattles: 0, knownOutcomeBattles: denominator, wins: 0, successRate: 0, winRate: 0 };
    const r = await mount(t, { stats: fixture(performance) });
    for (const node of r.all(petRow(r, 501)).filter(n => n.dataset.performanceRate)) assert.equal(node.textContent, '—');
    r.btn('场均').click(); for (const node of r.all(petRow(r, 501)).filter(n => n.dataset.performanceRate)) assert.equal(node.textContent, '—');
    r.page.onLeave();
  }
  const performance = performanceFixture(), row = performance.species[0]; row.monsterId = 501;
  for (const key of ['attackPerDeath', 'receivedPerDeath', 'attackCounteredRate', 'statusCounteredRate', 'defenseSuccessRate']) row[key] = null;
  row.rollerCoaster = { carriedBattles: 4, successBattles: 0, knownOutcomeBattles: 1, wins: 0, successRate: null, winRate: null };
  const r = await mount(t, { stats: fixture(performance) });
  for (const node of r.all(petRow(r, 501)).filter(n => n.dataset.performanceRate)) assert.equal(node.textContent, '—');
});

test('damage totals still include approved estimates and retain cumulative hover breakdowns', async t => {
  const r = await mount(t, { stats: fixture(performanceFixture()) }), damage = nodes(r, 'br-performance-damage', petRow(r));
  assert.match(damage[0].textContent, /已计 640.*含估 300.*累计缺 2 条/); assert.match(damage[0].title, /累计实际 340；累计估算 300；未解决 2 条伤害事件（不是HP量）/);
  assert.match(damage[0].title, /不是实测/); assert.equal(damage[0].tabIndex, 0); assert.match(damage[0].getAttribute('aria-label'), /未解决 2/);
  assert.match(damage[1].textContent, /已计 128.*累计缺 1 条/);
  r.btn('场均').click(); assert.match(damage[0].textContent, /已计 160.*含估 75.*累计缺 2 条/); assert.match(damage[0].title, /累计实际 340/);
  assert.match(damage[1].textContent, /已计 32.*累计缺 1 条/);
});

test('missing API count/damage fields remain unavailable; no client averaging or missing-to-zero repairs', async t => {
  const performance = performanceFixture(), row = performance.species[0];
  delete row.totals.outgoingUsual; row.totals.receivedUsual = null; row.totals.attackActions = 0;
  delete row.averages.attackActions; delete row.totals.statusActions; row.totals.damageDealt = { estimated: 300, unresolved: 1 };
  row.averages.damageDealt = {}; delete row.averages.departures.total;
  const r = await mount(t, { stats: fixture(performance) });
  assert.equal(metric(r, 'outgoingUsual').textContent, '—'); assert.equal(metric(r, 'receivedUsual').textContent, '—'); assert.equal(metric(r, 'attackActions').textContent, '0'); assert.equal(metric(r, 'statusActions').textContent, '—');
  const damage = nodes(r, 'br-performance-damage', petRow(r))[0]; assert.match(damage.textContent, /已计 —.*含估 300/);
  r.btn('场均').click(); assert.equal(metric(r, 'attackActions').textContent, '—'); assert.equal(metric(r, 'total').textContent, '—'); assert.match(damage.textContent, /已计 —.*含估 —/);
  const absent = await mount(t, { stats: fixture() }); assert.match(branch(absent).textContent, /尚未提供我方表现数据/); assert.equal(absent.btn('场均'), undefined);
});

test('coverage badges, coverage area and long paragraphs are absent from DOM and obsolete CSS is deleted', async t => {
  const performance = performanceFixture(), before = JSON.stringify(performance), r = await mount(t, { stats: freeze(fixture(performance)) });
  assert.equal(nodes(r, 'br-performance-coverage').length, 0);
  assert.doesNotMatch(branch(r).textContent, /部分记录|统计口径与覆盖|仅统计已观察记录|场均以全部携带局数|输入记录|未归属伤害|仅列后端确认完整的精确阵容|catalog-reference/);
  assert.equal(r.all(branch(r)).some(n => n.tagName === 'details' && /我方技能使用/.test(n.textContent)), false);
  assert.equal(nodes(r, 'br-self-skills').length, 0);
  r.btn('精灵详情').click();
  const skills = nodes(r, 'br-own-skill-usage')[0];
  assert.equal(r.all(skills).some(n => n.tagName === 'table'), true);
  assert.match(skills.textContent.replace(/\s+/g, ' '), /已知技能 3 次 100\.0%/);
  assert.doesNotMatch(skills.textContent, /#37/);
  assert.equal(JSON.stringify(performance), before); r.btn('场均').click(); assert.equal(JSON.stringify(performance), before);
  const css = fs.readFileSync(path.join(__dirname, '../css/battle-records.css'), 'utf8');
  assert.doesNotMatch(css, /\.br-performance-coverage|\.br-departures\s*\{|\.br-departure-list|\.br-departure-group/);
});

test('wholly unclassified relationships stay unavailable with coverage retained in the tooltip only', async t => {
  const performance = performanceFixture(), row = performance.species[0];
  for (const prefix of ['outgoing', 'received']) { for (const suffix of ['Advantage', 'Resisted', 'Usual']) { row.totals[prefix + suffix] = 0; row.averages[prefix + suffix] = 0; } row.coverage[prefix + 'EffectivenessUnknown'] = 4; }
  row.totals.damageDealt = { actual: 0, estimated: 0, unresolved: 4 }; row.averages.damageDealt = { actual: 0, estimated: 0, unresolved: 1 };
  const r = await mount(t, { stats: fixture(performance) });
  for (const mode of ['总计', '场均']) { r.btn(mode).click();
    for (const prefix of ['outgoing', 'received']) for (const suffix of ['Advantage', 'Resisted', 'Usual']) {
      const value = metric(r, prefix + suffix); assert.equal(value.textContent, '—'); assert.match(value.title, /累计 4 次行动.*缺失不补为通常伤害/);
    }
    assert.match(nodes(r, 'br-performance-damage', petRow(r))[0].textContent, /已计 0.*累计缺 4 条/);
  }
  const known = performanceFixture(); known.species[0].coverage.outgoingEffectivenessUnknown = 0; known.species[0].totals.outgoingUsual = 0;
  const valid = await mount(t, { stats: fixture(known) }); assert.equal(metric(valid, 'outgoingUsual').textContent, '0');
});

test('lineup table retains backend multiset, known outcomes and minute-second duration without old summary', async t => {
  const performance=freeze(performanceFixture()),before=JSON.stringify(performance),r = await mount(t, { stats: fixture(performance), data: catalogue }), rosters = nodes(r, 'br-lineup-roster', branch(r));
  assert.equal(rosters.length, 2); assert.equal(nodes(r, 'br-pet-line', rosters[0]).length, 3); assert.equal(nodes(r, 'br-pet-line', rosters[1]).length, 2);
  const first = rosters[0].parentNode.parentNode, unknown = rosters[1].parentNode.parentNode;
  assert.equal(first.children[1].textContent, '7'); assert.match(first.textContent, /60\.0%.*已知结果 5 \/ 7 场/);
  assert.deepEqual([performance.completeLineups[0].wins,performance.completeLineups[0].losses,performance.completeLineups[0].draws,performance.completeLineups[0].unknown],[3,1,1,2]);assert.equal(JSON.stringify(performance),before);assert.match(first.textContent,/胜 3 · 负 1 · 平 1 · 未知 2/); assert.match(first.textContent, /8\.25 回合.*回合样本 4 场/); assert.match(first.textContent, /1分钟21秒.*用时样本 3 场/);
  assert.match(unknown.textContent, /已知结果 0 \/ 2 场/); assert.doesNotMatch(unknown.textContent, /0\.0%|0分钟0秒|0 回合/);
  const rowBefore = first.textContent; r.btn('场均').click(); assert.equal(first.textContent, rowBefore);assert.equal(JSON.stringify(performance),before);
});

test('authoritative ratios and averages are not recomputed even when counts would produce other values', async t => {
  const performance = performanceFixture(), row = performance.species[0];
  row.averages.entries = 12.345; row.averages.attackActions = .001; row.attackCounteredRate = .27; row.attackPerDeath = 8.25;
  performance.completeLineups[0].winRate = .33; performance.completeLineups[0].averageDurationSeconds = 0;
  const r = await mount(t, { stats: fixture(performance) }); r.btn('场均').click();
  assert.equal(metric(r, 'entries').textContent, '12.35'); assert.equal(metric(r, 'attackActions').textContent, '<0.01');
  assert.equal(rate(r, 'attackCounteredRate').textContent, '27.0%'); assert.equal(rate(r, 'attackPerDeath').textContent, '8.25');
  const first = nodes(r, 'br-lineup-roster', branch(r))[0].parentNode.parentNode; assert.match(first.textContent, /33\.0%/); assert.match(first.textContent, /0分钟0秒/);
});

test('presentation modes and tooltip cleanup remain memory-only across refresh and remount', async t => {
  const r = await mount(t, { stats: fixture(performanceFixture()), data: catalogue }), pet = nodes(r, 'br-pet-line', petRow(r))[0], calls = r.calls.length;
  pet.focus(); assert.equal(nodes(r, 'br-pet-tooltip').length, 1); assert.equal(r.calls.length, calls);
  r.btn('敌方样本统计').click(); assert.equal(nodes(r, 'br-pet-tooltip').length, 0);
  r.btn('我方样本统计').click(); r.btn('场均').click(); r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick();
  assert.equal(metric(r, 'entries').textContent, '0.75'); assert.equal(r.btn('场均').getAttribute('aria-pressed'), 'true');
  r.page.onLeave(); assert.equal(r.layerBindings.size, 0); assert.equal(r.timers.size, 0);
  r.page.render(r.host); await tick(); assert.equal(metric(r, 'entries').textContent, '0.75');
  const fresh = await mount(t, { stats: fixture(performanceFixture()) }); assert.equal(metric(fresh, 'entries').textContent, '3');
  assert.equal(r.calls.some(call => call.options.method || /\/record\?|profile/.test(call.url)), false);
});

test('unknown identities stay blank and missing arrays are distinct from empty arrays', async t => {
  const performance = performanceFixture(); performance.species[0].monsterId = 999; performance.species[0].name = '正确形态'; performance.species[0].image = 'javascript:bad';
  const r = await mount(t, { stats: fixture(performance), data: catalogue }), identity = r.find(node => node.dataset.performanceMonsterId === '999');
  assert.match(identity.textContent, /未收录精灵 #999/); assert.equal(r.all(identity).some(node => node.tagName === 'img'), false);
  const unavailable = await mount(t, { stats: fixture({}) }); assert.match(branch(unavailable).textContent, /未提供精灵表现明细/); assert.match(branch(unavailable).textContent, /未提供我方阵容明细/);
  const empty = await mount(t, { stats: fixture({ species: [], completeLineups: [] }) }); assert.match(branch(empty).textContent, /暂无可归属的我方精灵样本/); assert.match(branch(empty).textContent, /暂无完整且可确认的我方阵容样本/);
});

test('self starts selected and enemy has exactly the three replacement modules with no global fallbacks', async t => {
  const r = await mount(t, { stats: freeze(fixture()) });
  assert.equal(branch(r).hidden, false); assert.equal(branch(r, 'enemy').hidden, true);
  const calls = r.calls.length; r.btn('敌方样本统计').click();
  assert.deepEqual(Array.from(nodes(r, 'br-enemy-module'), n => n.dataset.enemyModule), ['performance', 'teams', 'environment']);
  const enemy = branch(r, 'enemy').textContent;
  for (const label of ['敌方精灵表现', '敌方阵容统计', '环境统计']) assert.ok(enemy.includes(label));
  assert.doesNotMatch(enemy, /首发样本|观察发生率|自定义敌方队伍组合|<svg>组合|来源声明覆盖/);
  r.btn('我方样本统计').click(); r.btn('敌方样本统计').click(); assert.equal(r.calls.length, calls);
});

test('secondary selection survives refresh/remount but a new runtime starts self', async t => {
  const r = await mount(t, { stats: fixture() }); r.btn('敌方样本统计').click(); r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); assert.equal(branch(r, 'enemy').hidden, false);
  r.page.onLeave(); r.page.render(r.host); await tick(); assert.equal(branch(r, 'enemy').hidden, false); assert.equal(r.btn('敌方样本统计').getAttribute('aria-pressed'), 'true');
  const fresh = await mount(t, { stats: fixture() }); assert.equal(branch(fresh).hidden, false);
});

test('secondary switch stays operable during failed shared queries and retry preserves filters', async t => {
  let fail = false;
  const r = await mount(t, { stats: fixture(), handle: url => fail && url.includes('/stats?') ? { ok: false, json: async () => ({ error: 'stats unavailable' }) } : null });
  r.named('outcome').value = 'unknown'; fail = true; r.submit(r.find(n => n.tagName === 'form' && n.getAttribute('aria-label') === '对战记录共享筛选'));
  r.btn('敌方样本统计').click(); await tick(); assert.equal(r.btn('敌方样本统计').getAttribute('aria-pressed'), 'true'); assert.match(r.host.textContent, /stats unavailable/);
  const calls = r.calls.filter(c => /\/(list|stats)\?/.test(c.url)).slice(-2), queries = calls.map(c => new URL(c.url, 'http://test').searchParams); queries[0].delete('page'); queries[0].delete('pageSize');
  assert.equal(queries[0].toString(), queries[1].toString()); assert.equal(queries[1].get('outcome'), 'unknown');
  fail = false; r.btn('重试').click(); await tick(); assert.equal(branch(r, 'enemy').hidden, false); assert.equal(r.calls.some(c => /\/record\?/.test(c.url) || c.options.method), false);
});
