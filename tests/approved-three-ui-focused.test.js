'use strict';
// Approved three UI changes only: execute real render/callbacks in the existing
// synthetic DOM helpers. No browser/native app, network, DB/AppData, settings,
// catalog mutation, build output, backup writes or timer-driven RKPP actions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const tick = () => new Promise(resolve => setImmediate(resolve));

function helper(filename, exports) {
  const file = path.join(__dirname, filename), source = fs.readFileSync(file, 'utf8');
  const boundary = source.indexOf('\ntest(');
  assert.ok(boundary > 0, 'extract helpers without registering the old test suite');
  const box = { module: { exports: {} }, require: createRequire(file), __dirname, console, AbortController, URLSearchParams, setImmediate };
  vm.runInNewContext(source.slice(0, boundary) + '\nmodule.exports = ' + exports + ';', box, { filename: file });
  return box.module.exports;
}
const battleRuntime = helper('battle-records-ui.test.js', 'runtime');
const { runtime: updaterRuntime } = helper('catalog-updater.test.js', '{ runtime }');
const nodes = (r, cls, host) => r.all(host).filter(n => (n.className || '').split(' ').includes(cls));
const images = (r, host) => r.all(host).filter(n => n.tagName === 'img');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const catalog = {
  getMonsters: () => [35, 42].map(id => ({ id })),
  getMonsterById: id => [35, 42].includes(id) ? { id, image: `p${id}.png` } : null,
  getMonsterDisplayName: pet => `精灵${pet.id}`,
  getMoves: () => [{ id: 37 }, { id: 38 }],
  getMoveName: skill => skill.id === 37 ? '均衡技能' : '雷霆技能',
  getTypes: () => [{ id: 3 }], getTypeObjZh: () => '火'
};
function statsFixture() {
  return {
    matchedBattles: 1, outcomes: { win: 1, loss: 0, draw: 0, unknown: 0 },
    selfPerformance: {
      species: [{ monsterId: 35 }, { monsterId: 0 }],
      completeLineups: [{ monsterIds: [35, 35, 42, 777], battles: 1, selfSkills: [
        { monsterId: 35, skillId: 37, casts: 2 }, { monsterId: 35, skillId: 37, casts: 1 },
        { monsterId: 35, skillId: 38, casts: 1 },
        { monsterId: 35, kind: 'wishImpact', typeId: 3, casts: 2 },
        { monsterId: 35, kind: 'wishImpact', casts: 2 },
        { monsterId: 42, skillId: 38, casts: 5 }, { monsterId: 777, skillId: 37, casts: 1 },
        { monsterId: 35, kind: 'charge', casts: 99999 },
        { monsterId: 501, skillId: 37, casts: 99999 }, { skillId: 38, casts: 99999 }
      ] }]
    },
    selfSkills: [{ monsterId: 35, skillId: 38, casts: 88888 }, { monsterId: 0, skillId: 37, casts: 2 }]
  };
}
async function mountBattle(t, options = {}) {
  const stats = options.stats || statsFixture(), before = JSON.stringify(stats);
  const r = battleRuntime({ stats: freeze(stats), data: catalog, ...options });
  t.after(() => { r.page.onLeave(); assert.equal(JSON.stringify(stats), before, 'render does not mutate source statistics'); });
  await tick(); return r;
}
function checkHeading(r, section, id) {
  const heading = section.children[0];
  assert.equal(heading.tagName, 'h4');
  assert.ok(heading.className.split(' ').includes('br-own-skill-heading'));
  assert.equal(heading.children.length, 2);
  assert.ok(heading.children[0].className.split(' ').includes('br-image-pet'), 'avatar precedes the title text in real DOM');
  assert.equal(heading.children[1].textContent, '技能使用', 'do not rename the visible title');
  assert.equal(heading.textContent.trim(), '技能使用');
  assert.match(heading.getAttribute('aria-label'), /：技能使用$/);
  const avatarImages = images(r, heading);
  assert.equal(avatarImages.length, [35, 42].includes(id) ? 1 : 0);
  if (avatarImages.length) assert.equal(avatarImages[0].src, `assets/monster/images/p${id}.png`);
  const layout = nodes(r, 'br-own-skill-layout', section)[0];
  assert.equal(nodes(r, 'br-image-pet', layout || section).filter(n => !heading.contains(n)).length, 0, 'no pet avatar in skill body');
  assert.equal(nodes(r, 'br-skill-owner-line', section).length, 0, 'old per-entry wrapper removed');
  return heading;
}

test('exact own-lineup dialog moves each confirmed avatar left of 技能使用 above pie; ordinary/wish icons, counts and percentages survive', async t => {
  const r = await mountBattle(t); r.btn('样本统计').click(); await tick(); r.btn('我方阵容统计').click();
  const trigger = nodes(r, 'br-lineup-select')[0], calls = r.calls.length; trigger.click();
  const modal = nodes(r, 'br-modal-root')[0]; assert.equal(modal.dataset.modalKind, 'own-lineup');
  const roster = nodes(r, 'br-lineup-roster', modal)[0]; assert.equal(roster.children.length, 4, 'duplicate species remains in the roster');
  const usage = nodes(r, 'br-own-skill-usage', modal);
  assert.deepEqual(Array.from(usage, n => n.dataset.skillMonsterId), ['35', '42', '777'], 'one usage aggregate per stable species ID');
  for (const section of usage) checkHeading(r, section, Number(section.dataset.skillMonsterId));
  const section = usage[0], layout = nodes(r, 'br-own-skill-layout', section)[0];
  assert.equal(section.children[1], layout); assert.equal(layout.children[0].tagName, 'svg');
  assert.equal(section.dataset.total, '8');
  const rows = r.all(section).find(n => n.tagName === 'tbody').children;
  assert.deepEqual(Array.from(rows, row => Array.from(row.children, td => td.textContent.trim())), [
    ['均衡技能', '3 次', '37.5%'], ['雷霆技能', '1 次', '12.5%'],
    ['愿力冲击·火', '2 次', '25.0%'], ['愿力冲击·未确认属性', '2 次', '25.0%']
  ]);
  assert.ok(Array.from(rows).every(row => row.children[0].children[0].className === 'br-skill-line'));
  assert.deepEqual(Array.from(images(r, layout), image => image.src), [
    'assets/monster/skill/' + encodeURIComponent('均衡技能') + '.png',
    'assets/monster/skill/' + encodeURIComponent('雷霆技能') + '.png', 'assets/system-actions/wish-3.png'
  ], 'unknown wish type stays blank, never borrows a pet or other type icon');
  const slices = r.all(layout.children[0]).filter(n => n.getAttribute('data-skill-kind'));
  assert.deepEqual(Array.from(slices, n => [n.getAttribute('data-skill-kind'), n.getAttribute('data-skill-id'), n.getAttribute('data-type-id')]), [
    ['skill', '37', null], ['skill', '38', null], ['wishImpact', null, '3'], ['wishImpact', null, '']
  ]);
  assert.match(usage[1].textContent, /雷霆技能 5 次 100\.0%/);
  assert.match(usage[2].textContent, /均衡技能 1 次 100\.0%/);
  assert.doesNotMatch(modal.textContent, /88888|99999/);
  assert.equal(r.calls.length, calls); assert.equal(r.tracked.length, 0);
  r.root.document.emit('keydown', { key: 'Escape' }); assert.equal(nodes(r, 'br-modal-root').length, 0);
  assert.equal(r.root.document.activeElement, trigger);
});

test('shared detail rendering and empty exact-lineup usage retain title avatar placement without borrowing unknown identity or global usage', async t => {
  const stats = statsFixture(); stats.selfPerformance.completeLineups[0].selfSkills = [];
  const r = await mountBattle(t, { stats }); r.btn('样本统计').click(); await tick();
  for (const id of [35, 0]) {
    r.find(n => n.dataset.departureMonsterId === String(id)).click();
    const section = nodes(r, 'br-own-skill-usage')[0]; checkHeading(r, section, id);
    assert.match(section.textContent, id === 35 ? /雷霆技能 88888 次 100\.0%/ : /均衡技能 2 次 100\.0%/);
    r.root.document.emit('keydown', { key: 'Escape' });
  }
  r.btn('我方阵容统计').click(); const calls = r.calls.length; nodes(r, 'br-lineup-select')[0].click();
  for (const section of nodes(r, 'br-own-skill-usage')) {
    checkHeading(r, section, Number(section.dataset.skillMonsterId));
    assert.match(section.textContent, /暂无已记录技能使用/);
    assert.equal(r.all(section).some(n => n.tagName === 'svg' || n.tagName === 'tbody'), false);
  }
  assert.doesNotMatch(nodes(r, 'br-modal-root')[0].textContent, /88888/);
  assert.equal(r.calls.length, calls); assert.equal(r.tracked.length, 0);
});

for (const [extension, contentType, payload] of [
  ['json', 'application/json', '[{"id":"synthetic-json"}]'],
  ['ndjson', 'application/x-ndjson', '{"id":"synthetic-ndjson-1"}\n{"id":"synthetic-ndjson-2"}\n'],
  ['jsonl', 'application/x-ndjson', '{"id":"synthetic-jsonl"}\n']
]) test(`导入对局记录 keeps original selector/callback and ${extension} format transport without actual IO`, async t => {
  const r = await mountBattle(t, { handle: url => url === '/api/battles/import' ? { ok: true, json: async () => ({ imported: 1, duplicates: 0, issues: [] }) } : null });
  const button = r.btn('导入对局记录'), file = r.named('battleFile');
  assert.ok(button); assert.equal(r.btn('导入 JSON / NDJSON'), undefined);
  assert.equal(button.dataset.br, 'import'); assert.equal(button.type, 'button');
  assert.equal(button.parentNode.children[1].textContent, '导出对局记录');
  assert.equal(button.parentNode.children[1].dataset.br, 'export-source');
  assert.equal(file.type, 'file'); assert.equal(file.hidden, true);
  assert.equal(file.accept, '.json,.ndjson,.jsonl,application/json,application/x-ndjson');
  let chooserClicks = 0; file.addEventListener('click', () => chooserClicks++);
  const calls = r.calls.length; button.click(); assert.equal(chooserClicks, 1); assert.equal(r.calls.length, calls);
  let finishRead; const chosen = { name: `synthetic.${extension}`, size: Buffer.byteLength(payload), text: () => new Promise(resolve => { finishRead = resolve; }) };
  file.files = [chosen]; file.value = chosen.name; file.emit('change'); assert.equal(button.disabled, true);
  finishRead(payload); await tick();
  const imports = r.calls.filter(call => call.url === '/api/battles/import'); assert.equal(imports.length, 1);
  assert.equal(imports[0].options.method, 'POST'); assert.equal(imports[0].options.headers['Content-Type'], contentType);
  assert.equal(imports[0].options.body, payload, 'raw selected bytes remain unchanged');
  assert.equal(r.tracked.length, 1); assert.equal(button.disabled, false); assert.equal(file.value, '');
  assert.match(r.host.textContent, /导入完成：1 条；重复 0 条/);
  assert.equal(r.calls.some(call => /\/scan|\/relay\/|\/rkpp\/(?:start|stop)/.test(call.url)), false);
});

test('updater renders exact hint immediately right of original title with meaningful aria; mount/remount stays status-read-only', async t => {
  const r = updaterRuntime(); t.after(() => r.updater.unmount()); await r.ready;
  function check() {
    const page = r.find(n => n.className === 'catalog-updater'), heading = page.children[0];
    assert.equal(heading.tagName, 'h3'); assert.equal(heading.className, 'cu-heading');
    assert.equal(heading.children[0].tagName, 'span'); assert.equal(heading.children[0].textContent, '从官方图鉴更新');
    const hint = heading.children[1]; assert.equal(hint.tagName, 'small');
    assert.equal(hint.className, 'cu-feature-hint'); assert.equal(hint.textContent, '该功能尚未完善');
    assert.equal(heading.attrs['aria-label'], '从官方图鉴更新'); assert.equal(heading.attrs['aria-describedby'], hint.id);
    assert.equal(r.all().filter(n => n.id === hint.id).length, 1);
    assert.equal(page.children[1].className, 'cu-operation');
    assert.deepEqual(Array.from(r.find(n => n.className === 'cu-actions').children, n => [n.dataset.action, n.textContent]), [
      ['check', '检查官方更新'], ['apply', '确认并应用'], ['reload', '重新载入资料']
    ]);
  }
  check(); await r.updater.mount(r.host); check();
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls.every(call => call.url === '/api/catalog/update/status' && call.init.method === 'GET'));
  assert.equal(r.timers.size, 0); assert.equal(r.confirms.length, 0); assert.equal(r.reloads, 0);
});

test('CSS directly deletes obsolete row-owner rules; heading-only 28px avatar and 12px muted wrapping updater hint stay narrowly scoped', () => {
  const battleJS = fs.readFileSync(path.join(__dirname, '../js/pages/battle-records.js'), 'utf8');
  const battleCSS = fs.readFileSync(path.join(__dirname, '../css/battle-records.css'), 'utf8');
  const updaterCSS = fs.readFileSync(path.join(__dirname, '../css/catalog-updater.css'), 'utf8');
  const rules = css => Array.from(css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g), match => ({ selector: match[1].trim(), body: match[2] }));
  assert.doesNotMatch(battleJS + battleCSS, /br-skill-owner-line|skillOwnerMonsterId/);
  const headingRules = rules(battleCSS).filter(rule => rule.selector.includes('br-own-skill-heading'));
  assert.equal(headingRules.length, 3);
  assert.ok(headingRules.every(rule => rule.selector.startsWith(':is(.battle-records-page, .br-modal-root) .br-own-skill-usage h4.br-own-skill-heading')));
  assert.match(headingRules[0].body, /display:\s*inline-flex/); assert.match(headingRules[0].body, /align-items:\s*center/);
  for (const rule of headingRules.slice(1)) { assert.match(rule.body, /width:\s*28px/); assert.match(rule.body, /height:\s*28px/); }
  assert.match(headingRules[2].selector, /> \.br-image-pet img$/);
  assert.match(battleCSS, /\.br-skill-line \.br-image-skill\s*\{\s*width:\s*28px;\s*height:\s*28px;/);
  const updaterRules = rules(updaterCSS).filter(rule => /cu-heading|cu-feature-hint/.test(rule.selector));
  assert.equal(updaterRules.length, 2);
  assert.equal(updaterRules[0].selector, '#ud-tab-content .catalog-updater h3.cu-heading');
  assert.match(updaterRules[0].body, /display:\s*inline-flex/); assert.match(updaterRules[0].body, /flex-wrap:\s*wrap/);
  assert.match(updaterRules[0].body, /max-width:\s*100%/);
  assert.equal(updaterRules[1].selector, '#ud-tab-content .catalog-updater h3.cu-heading > .cu-feature-hint');
  assert.match(updaterRules[1].body, /font-size:\s*12px/); assert.match(updaterRules[1].body, /font-weight:\s*normal/);
  assert.match(updaterRules[1].body, /color:\s*var\(--text-secondary\)/);
  assert.ok(updaterRules.every(rule => !/position:\s*(?:absolute|fixed)|white-space:\s*nowrap|!important/.test(rule.body)), 'natural wrap, no global h3 or layout overrides');
});
