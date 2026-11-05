'use strict';
// Synthetic DTO/DOM only: the own skill pie now lives in the species modal,
// paired with an always-visible name/count/share table instead of six cards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const setupPath = path.join(__dirname, 'battle-performance-ui.test.js');
const setup = fs.readFileSync(setupPath, 'utf8');
const sandbox = { module: { exports: {} }, require: createRequire(setupPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
vm.runInNewContext(setup.slice(0, setup.indexOf('\ntest(')) + '\nmodule.exports = { runtime, fixture, performanceFixture, catalogue, freeze };', sandbox, { filename: setupPath });
const { runtime, fixture, performanceFixture, catalogue, freeze } = sandbox.module.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const nodes = (r, cls, host) => r.all(host).filter(node => (node.getAttribute('class') || node.className).split(' ').includes(cls));
const section = r => nodes(r, 'br-own-skill-usage')[0];
const shapes = (r, host = section(r)) => r.all(host).filter(node => ['circle', 'path'].includes(node.tagName));
const normal = (skillId, casts, extra = {}) => ({ monsterId: 35, skillId, casts, ...extra });
const wish = (typeId, casts, extra = {}) => normal(0, casts, { kind: 'wishImpact', typeId, ...extra });
const typeData = { getTypes: () => [{ id: 8, localized: { zh: '龙' } }, { id: 11, localized: { zh: '火' } }], getTypeObjZh: type => type.localized.zh };
function skillStats(selfSkills, performance = performanceFixture()) {
  performance.completeLineups[0].selfSkills = [normal(37, 99999)];
  return { ...fixture(performance), selfSkills };
}
async function mount(t, selfSkills, options = {}) {
  const r = runtime({ ...options, stats: options.stats || skillStats(selfSkills), data: { ...catalogue, ...typeData, ...options.data } });
  t.after(() => r.page.onLeave()); await tick(); r.btn('样本统计').click(); await tick(); r.btn('精灵详情').click(); return r;
}

test('own modal uses this initial species only, left SVG/right permanent percentage table, before causal pies', async t => {
  const stats = freeze(skillStats([normal(37, 3), normal(37, 500, { monsterId: 501 }), normal(37, 900, { monsterId: 999 })]));
  const before = JSON.stringify(stats), r = await mount(t, [], { stats });
  assert.equal(section(r).dataset.skillMonsterId, '35'); assert.equal(section(r).dataset.total, '3');
  const layout = nodes(r, 'br-own-skill-layout')[0]; assert.equal(layout.children[0].tagName, 'svg'); assert.equal(layout.children[1].className.includes('br-own-skill-table'), true);
  assert.deepEqual(Array.from(r.all(layout).filter(n => n.tagName === 'th'), n => n.textContent), ['技能名称', '释放次数', '占比']);
  assert.match(layout.children[1].textContent, /已知技能 3 次 100\.0%/); assert.doesNotMatch(section(r).textContent, /500|900|99999|#37/);
  const body = nodes(r, 'br-dialog-body')[0]; assert.ok(body.children.indexOf(section(r)) < body.children.indexOf(nodes(r, 'br-departure-charts')[0]));
  assert.equal(r.all(section(r)).some(n => n.hidden), false); assert.equal(JSON.stringify(stats), before);
});

test('ordinary skills and explicit wish types merge independently; charge never enters the cast denominator', async t => {
  const skills = [normal(37,2), normal(37,1,{kind:'skill'}), normal(38,1,{kind:''}), wish(8,1), wish(8,1,{skillId:37}), wish(11,1), wish(null,1), normal(0,900,{kind:'system',label:'聚能'}), normal(0,800), normal(37,500,{kind:'charge'}), normal(38,400,{kind:'passive'})];
  skills.forEach(row => Object.assign(row, { totalCasts: 9999, usedBattles: 500, samples: 900, amount: 123456, hits: 100 }));
  const r = await mount(t, skills, { data: { getMoves: () => [{id:37},{id:38}], getMoveName: move => move.id === 37 ? '主技能甲' : '主技能乙' } });
  assert.equal(section(r).dataset.total, '8'); assert.deepEqual(Array.from(shapes(r), n => n.getAttribute('data-count')), ['3','1','2','1','1']);
  for (const label of [/主技能甲 3 次 37\.5%/, /主技能乙 1 次 12\.5%/, /愿力冲击·龙 2 次 25\.0%/, /愿力冲击·火 1 次 12\.5%/, /愿力冲击·未确认属性 1 次 12\.5%/]) assert.match(section(r).textContent, label);
  assert.doesNotMatch(section(r).textContent, /聚能|9999|123456/);
  const original = section(r).textContent, pies = shapes(r), calls = r.calls.length; r.btn('场均').click(); assert.equal(section(r).textContent, original); assert.deepEqual(shapes(r), pies); assert.equal(r.calls.length, calls);
  assert.equal(r.find(n => n.dataset.performanceMetric === 'statusActions').textContent, '0.75');
});

test('unknown wish types never derive from species types, neighboring data or ordinary skill identity', async t => {
  const r = await mount(t, [wish(null,1), wish(undefined,1), wish('8',1), wish(0,1), wish(19,1), wish(Infinity,1), wish(1.5,1), wish(8,1)], { data: { getMonsterById: id => ({ id, type_ids: [11] }), getMoveName: () => '不应借用' } });
  assert.equal(shapes(r).length, 2); assert.match(section(r).textContent, /愿力冲击·未确认属性 7 次 87\.5%/); assert.match(section(r).textContent, /愿力冲击·龙 1 次 12\.5%/); assert.doesNotMatch(section(r).textContent, /火|不应借用/);
  const missing = await mount(t, [wish(8,1)], { data: { getTypes: () => [] } }); assert.match(section(missing).textContent, /愿力冲击·未确认属性/);
});

test('all eighteen explicit type IDs use the localized helper without display IDs', async t => {
  const types = Array.from({length:18}, (_,i) => ({id:i+1, localized:{zh:'属性'+(i+1)}}));
  const r = await mount(t, types.map(type => wish(type.id,1)), { data: { getTypes: () => types } });
  assert.equal(shapes(r).length, 18); for (const type of types) assert.ok(section(r).textContent.includes('愿力冲击·'+type.localized.zh)); assert.doesNotMatch(section(r).textContent, /#\d+/);
});

test('invalid counts and identity cannot produce fake zero pies; unsafe cumulative sums are unavailable', async t => {
  const invalid = [undefined,null,0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'2',.5];
  const rows = [null,...invalid.flatMap(casts => [normal(37,casts),wish(8,casts)]),...invalid.map(skillId=>normal(skillId,2)),normal(37,2,{kind:null}),normal(37,2,{kind:'future'}),normal(37,2,{monsterId:'35'})];
  for (const selfSkills of [rows, undefined, null, []]) { const r = await mount(t,selfSkills); assert.equal(shapes(r).length,0); assert.match(section(r).textContent,/暂无已记录技能使用/); assert.doesNotMatch(section(r).textContent,/0%|NaN|Infinity/); }
  for (const entries of [[normal(37,Number.MAX_SAFE_INTEGER),normal(38,1)],[normal(37,Number.MAX_SAFE_INTEGER),normal(37,1)],[wish(8,Number.MAX_SAFE_INTEGER),wish(8,1)]]) {
    const r = await mount(t,entries); assert.equal(shapes(r).length,0); assert.match(section(r).textContent,/累计次数不可用/); assert.doesNotMatch(section(r).textContent,/%|NaN|Infinity/);
  }
  const single = await mount(t,[wish(8,2),wish(8,3)]); assert.equal(shapes(single)[0].tagName,'circle'); assert.match(shapes(single)[0].textContent,/5 次 · 100\.0%/);
});

test('canonical and type labels are literal safe text; SVG geometry never incorporates hostile labels', async t => {
  const label = '\"><script>bad()</script><svg onload="evil()">&';
  const r = await mount(t,[normal(37,1),wish(8,1)],{data:{getMoveName:()=>label,getTypeObjZh:()=>label}});
  assert.ok(section(r).textContent.includes(label)); assert.equal(r.all(section(r)).some(n=>['script','foreignObject'].includes(n.tagName)),false);
  for (const node of shapes(r)) { assert.equal(node.namespaceURI,'http://www.w3.org/2000/svg'); assert.equal(node.children[0].tagName,'title'); assert.equal(node.children[0].children.length,0); }
  for (const node of r.all(section(r))) for (const [key,value] of Object.entries(node.attrs)) { assert.doesNotMatch(key,/^on|href/); if (['d','fill','cx','cy','r','viewBox'].includes(key)) assert.equal(value.includes(label),false); }
});

test('responsive left/right CSS retains percentages without fitting probes or resize observers', async t => {
  const r = await mount(t,[normal(37,3),wish(8,1)]), before = section(r).textContent, old = shapes(r), calls=r.calls.length;
  r.root.innerWidth=220; r.root.document.emit('resize'); assert.equal(section(r).textContent,before); assert.deepEqual(shapes(r),old); assert.equal(r.calls.length,calls);
  const css=fs.readFileSync(path.join(__dirname,'../css/battle-records.css'),'utf8'), source=fs.readFileSync(path.join(__dirname,'../js/pages/battle-records.js'),'utf8');
  assert.match(css,/\.br-own-skill-layout\s*\{[^}]*grid-template-columns: minmax\(120px, 220px\) minmax\(0, 1fr\)/);
  assert.match(css,/\.br-own-skill-table[^{}]*td:last-child\s*\{[^}]*white-space: nowrap/);
  assert.doesNotMatch(source,/ResizeObserver|MutationObserver|skillLayout|SkillFitting/); assert.doesNotMatch(css,/br-skill-card|br-skill-measure/);
});

test('shared refresh replaces modal skill data; errors, removal, close and leave reject stale responses', async t => {
  let current=skillStats([normal(37,2)]), fail=false, pending=null;
  const r=await mount(t,[],{handle:url=>url.includes('/stats?')?pending?new Promise(resolve=>pending.push(resolve)):{ok:!fail,json:async()=>fail?{error:'query failed'}:current}:null});
  const old=section(r); current=skillStats([wish(11,4)]); r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); assert.equal(old.isConnected,false); assert.equal(section(r).dataset.total,'4');
  fail=true; r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); assert.equal(section(r),undefined); assert.match(r.root.document.body.textContent,/query failed/);
  fail=false; r.btn('重试').click(); await tick(); assert.equal(section(r).dataset.total,'4');
  pending=[]; r.named('outcome').value='win';r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); r.named('outcome').value='loss';r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); pending[1]({ok:true,json:async()=>skillStats([normal(37,6)])}); await tick(); pending[0]({ok:true,json:async()=>skillStats([normal(37,99)])}); await tick(); assert.equal(section(r).dataset.total,'6');
  pending=[]; r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选')); await tick(); r.btn('关闭').click(); pending[0]({ok:true,json:async()=>current}); await tick(); assert.equal(section(r),undefined);
  pending=null; r.btn('精灵详情').click(); r.page.onLeave(); assert.equal(section(r),undefined); assert.equal(r.tracked.length,0);
  r.page.render(r.host); await tick(); assert.equal(section(r),undefined,'remount must not reopen a closed modal');
});
