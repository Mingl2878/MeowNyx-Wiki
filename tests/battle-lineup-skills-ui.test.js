'use strict';
// Exact-cohort lineup portal regressions. Synthetic DTO/DOM only; no browser,
// network, DB, profiles, catalog mutation or production render substitution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const setupPath = path.join(__dirname, 'battle-performance-ui.test.js');
const setup = fs.readFileSync(setupPath, 'utf8');
const sandbox = { module: { exports: {} }, require: createRequire(setupPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
vm.runInNewContext(setup.slice(0, setup.indexOf('\ntest(')) + '\nmodule.exports = { runtime, fixture, performanceFixture, freeze };', sandbox, { filename: setupPath });
const { runtime, fixture, performanceFixture, freeze } = sandbox.module.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = body => ({ ok: true, json: async () => body });
const nodes = (r, cls, host) => r.all(host).filter(node => node.className.split(' ').includes(cls));
const controls = r => nodes(r, 'br-lineup-select');
const overlay = r => nodes(r,'br-modal-root')[0];
const body = r => nodes(r,'br-dialog-body')[0];
const child = r => nodes(r,'br-own-matchups',body(r))[0];
// Read the actual synthetic roster evidence instead of a removed expanded flag.
const selected = r => {
  if(overlay(r)?.dataset.modalKind!=='own-lineup')return;
  const roster=nodes(r,'br-lineup-roster',body(r))[0];if(!roster)return;
  const ids=Array.from(roster.children,n=>Number(n.children[1].textContent.replace('精灵',''))),key=JSON.stringify(ids.sort((a,b)=>a-b));
  return controls(r).find(n=>n.dataset.lineupKey===key);
};
const apply = r => r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选'));
const idsA = [501, 35, 35, 8, 11, 14], idsB = [501, 35, 42, 8, 11, 14];
function dto(lineups = [idsA, idsB]) {
  const performance = performanceFixture(), base = performance.completeLineups[0];
  performance.completeLineups = lineups.map(monsterIds => ({ ...base, monsterIds, selfSkills: [{ monsterId: 35, skillId: 37, casts: 99999 }] }));
  return { ...fixture(performance), archetypes: { ownMatchups: [
    { monsterIds: [...idsA].reverse(), teams: [{ ...base, id: 'balance', name: '均衡体系', monsterIds: [42], wins: 2, knownOutcomes: 3, winRate: 2 / 3 }] },
    { monsterIds: idsB, teams: [{ ...base, id: 'thunder', name: '雷霆体系', monsterIds: [42], wins: 1, knownOutcomes: 4, winRate: .25 }] }
  ] } };
}
const catalog = { getMonsterById: id => ({ id, image: `pet${id}.png` }), getMonsterDisplayName: pet => `精灵${pet.id}` };
async function mount(t, options = {}) { const r = runtime({ stats: dto(), data: catalog, ...options }); t.after(() => r.page.onLeave()); await tick(); r.btn('样本统计').click();await tick(); return r; }
function bubble(target, type = 'click', values = {}) {
  const chain=[];for(let node=target;node;node=node.parentNode)chain.push(node);
  const event={target,defaultPrevented:false,cancelBubble:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.cancelBubble=true;},...values};
  for(const node of chain){event.currentTarget=node;for(const fn of node.listeners[type]||[])fn(event);if(event.cancelBubble)break;}return event;
}
function choose(r, index = 0) { const node = controls(r)[index]; node.click(); return node; }

test('whole row, each cell, avatar and name open one exact-cohort portal without IO or inline expansion', async t => {
  const stats=freeze(dto()),before=JSON.stringify(stats),r=await mount(t,{stats}),trigger=controls(r)[0],row=trigger.parentNode.parentNode.parentNode,calls=r.calls.length;
  assert.equal(row.tabIndex,0);assert.equal(row.getAttribute('aria-haspopup'),'dialog');assert.equal(row.getAttribute('aria-expanded'),null);assert.equal(nodes(r,'br-own-matchups').length,0);
  for(const target of [row,...row.children,r.all(row).find(n=>n.tagName==='img'),r.all(row).find(n=>n.className==='br-pet-name')]){
    bubble(target);assert.equal(selected(r),trigger);assert.equal(overlay(r).dataset.modalKind,'own-lineup');assert.equal(overlay(r).parentNode,r.root.document.body);assert.equal(r.host.contains(overlay(r)),false);
    assert.match(child(r).textContent,/均衡体系.*66\.7%.*已知结果 3/);assert.doesNotMatch(child(r).textContent,/雷霆体系|99999|技能使用/);assert.equal(nodes(r,'br-lineup-matchups').length,0);
    const old=child(r);bubble(target);assert.equal(nodes(r,'br-modal-root').length,1);assert.equal(old.isConnected,false);r.root.document.emit('keydown',{key:'Escape'});assert.equal(selected(r),undefined);
  }
  assert.equal(r.calls.length,calls);assert.equal(JSON.stringify(stats),before);
});

test('native child control and keyboard open once; Escape folds and detached controls cannot resurrect content', async t => {
  const r=await mount(t),control=controls(r)[0],row=control.parentNode.parentNode.parentNode;
  bubble(control);assert.equal(control.textContent,'查看对局');assert.equal(nodes(r,'br-modal-root').length,1);assert.equal(selected(r),control);r.root.document.emit('keydown',{key:'Escape'});
  row.focus();assert.equal(bubble(row,'keydown',{key:'Enter'}).defaultPrevented,true);assert.equal(selected(r),control);const first=overlay(r);bubble(row,'keydown',{key:'Enter',repeat:true});assert.equal(overlay(r),first);
  r.root.document.emit('keydown',{key:'Escape'});bubble(row,'keydown',{key:' '});assert.equal(selected(r),control);r.root.document.emit('keydown',{key:'Escape'});bubble(control,'keydown',{key:'Enter'});assert.equal(selected(r),undefined,'fake DOM does not fabricate a native key-generated click');
  apply(r);await tick();bubble(row);assert.equal(selected(r),undefined);const current=controls(r)[0];r.page.onLeave();current.click();assert.equal(selected(r),undefined);
});

test('switching rows never mixes same species across distinct initial own multisets', async t => {
  const r=await mount(t),calls=r.calls.length;choose(r);const previous=child(r);choose(r,1);
  assert.equal(previous.isConnected,false);assert.match(child(r).textContent,/雷霆体系.*25\.0%/);assert.doesNotMatch(child(r).textContent,/均衡体系|66\.7%/);assert.equal(selected(r),controls(r)[1]);assert.equal(controls(r)[0].getAttribute('aria-expanded'),null);assert.equal(r.calls.length,calls);assert.equal(r.tracked.length,0);
});

test('malformed IDs cannot open a portal; missing per-lineup matchups never fall back to another or global cohort', async t => {
  const malformed=[[35,35,42],[35,42,42],[1,23],[12,3],['35'],[],[0],[NaN],[1,2,3,4,5,6,7]],r=await mount(t,{stats:dto(malformed)});
  assert.equal(new Set(controls(r).slice(0,4).map(n=>n.dataset.lineupKey)).size,4);for(const node of controls(r).slice(4)){assert.equal(node.disabled,true);node.click();}assert.equal(overlay(r),undefined);
  choose(r);assert.match(child(r).textContent,/未提供此精确阵容/);assert.doesNotMatch(child(r).textContent,/均衡体系|雷霆体系|99999/);const empty=await mount(t,{stats:dto([])});assert.equal(controls(empty).length,0);assert.equal(overlay(empty),undefined);assert.equal(child(empty),undefined);
});

test('selection matches multiset after reorder; removal closes permanently and refresh uses only current cohort data', async t => {
  let current=dto();const r=await mount(t,{handle:url=>url.includes('/stats?')?response(current):null});choose(r);const key=selected(r).dataset.lineupKey;
  current=dto([[...idsB].reverse(),[...idsA].reverse()]);current.archetypes.ownMatchups[0].teams[0].name='更新后的均衡';apply(r);assert.equal(nodes(r,'br-own-matchups').length,0);await tick();
  assert.equal(selected(r),controls(r)[1]);assert.equal(selected(r).dataset.lineupKey,key);assert.match(child(r).textContent,/更新后的均衡/);
  current=dto([idsB]);apply(r);await tick();assert.equal(overlay(r),undefined);current=dto();apply(r);await tick();assert.equal(overlay(r),undefined);
});

test('shared filtering, real failures, retry and late responses preserve correct cohort without selection IO', async t => {
  let pending=null,failure=false;
  const r=await mount(t,{handle:url=>url.includes('/stats?')?pending?new Promise(resolve=>pending.push(resolve)):failure?{ok:false,json:async()=>({error:'real stats error'})}:response(dto()):null});choose(r);const key=selected(r).dataset.lineupKey;
  failure=true;apply(r);await tick();assert.match(r.root.document.body.textContent,/real stats error/);assert.equal(nodes(r,'br-own-matchups').length,0);
  failure=false;r.all(body(r)).find(n=>n.tagName==='button'&&n.textContent==='重试').click();await tick();assert.equal(selected(r).dataset.lineupKey,key);
  pending=[];r.named('outcome').value='win';apply(r);await tick();r.named('outcome').value='loss';apply(r);await tick();assert.equal(pending.length,2);
  const fresh=dto();fresh.archetypes.ownMatchups[0].teams[0].name='最新';pending[1](response(fresh));await tick();pending[0](response(dto()));await tick();assert.match(child(r).textContent,/最新/);
  const list=new URL(r.calls.filter(c=>c.url.includes('/list?')).at(-1).url,'http://test').searchParams,stats=new URL(r.calls.filter(c=>c.url.includes('/stats?')).at(-1).url,'http://test').searchParams;list.delete('page');list.delete('pageSize');assert.equal(list.toString(),stats.toString());assert.equal(stats.get('outcome'),'loss');
  const calls=r.calls.length;choose(r);r.btn('敌方样本统计').click();r.btn('我方样本统计').click();assert.equal(r.calls.length,calls);
  pending=[];apply(r);await tick();r.page.onLeave();const before=r.host.textContent;pending[0](response(dto()));await tick();assert.equal(r.host.textContent,before);assert.equal(overlay(r),undefined);
});

test('obsolete six-card fitting, sizing probes, observers and inline matchup area are removed rather than hidden', () => {
  const js=fs.readFileSync(path.join(__dirname,'../js/pages/battle-records.js'),'utf8'),css=fs.readFileSync(path.join(__dirname,'../css/battle-records.css'),'utf8');
  assert.doesNotMatch(js,/skillLayout|SkillFitting|ResizeObserver|MutationObserver|fonts\.ready|br-skill-measure|br-lineup-matchups/);assert.doesNotMatch(css,/br-skill-card|br-skill-charts|br-skill-measure|br-lineup-skills|br-selected-lineup-roster|br-lineup-matchups/);
});
