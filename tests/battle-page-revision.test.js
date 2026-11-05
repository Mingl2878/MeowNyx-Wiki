'use strict';
// Nov4 UI contracts, isolated synthetic DTOs and in-memory HTTP only. No browser,
// profile, catalog write, DB, relay connection or production helper substitution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const harnessPath = path.join(__dirname, 'battle-archetypes-ui.test.js');
const source = fs.readFileSync(harnessPath, 'utf8');
const box = { module: { exports: {} }, require: createRequire(harnessPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
vm.runInNewContext(source.slice(0, source.indexOf('\ntest(')) + '\nmodule.exports={runtime,dto,catalog,freeze};', box, {filename:harnessPath});
const { runtime, dto, catalog, freeze } = box.module.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = body => ({ok:true,json:async()=>body});
const failure = message => ({ok:false,status:500,json:async()=>({error:message})});
const nodes = (r, cls, host) => r.all(host).filter(n=>n.className.split(' ').includes(cls));
const modal = r => nodes(r,'br-modal-root')[0];
const body = r => nodes(r,'br-dialog-body')[0];
const apply = r => r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选'));
const statsCalls = r => r.calls.filter(c=>c.url.includes('/stats?'));
const revisionCalls = r => r.calls.filter(c=>c.url.endsWith('/revision'));
const statsPanel = r => r.find(n=>n.dataset.brPanel==='stats');
const count = r => nodes(r,'br-stat-tiles')[0]?.children[0].children[0].textContent;
const openStats = async r => { r.btn('样本统计').click(); await tick(); };
async function mounted(t, options={}) { const r=runtime({stats:freeze(dto()),data:catalog,...options});t.after(()=>r.page.onLeave());await tick();return r; }

function revisionServer(extra) {
  let version='version-1';
  return { get version(){return version;},bump(){version+='n';}, handle(url,options){if(url.endsWith('/revision'))return response({revision:version});return extra?.(url,options)||null;} };
}

test('list renders independently; Stats is lazy, one pending load is shared, and revision-qualified cache survives route re-entry',async t=>{
  let resolveStats;
  const server=revisionServer(url=>url.includes('/stats?')?new Promise(resolve=>{resolveStats=resolve;}):null);
  const r=await mounted(t,{handle:(...args)=>server.handle(...args)});
  assert.ok(r.btn('查看详情'));assert.equal(statsCalls(r).length,0);assert.equal(revisionCalls(r).length,0);
  await openStats(r);assert.equal(statsCalls(r).length,1);assert.equal(revisionCalls(r).length,1);assert.equal(statsPanel(r).getAttribute('aria-busy'),'true');
  r.btn('样本统计').click();await tick();assert.equal(statsCalls(r).length,1,'repeat tab activation cannot duplicate pending Stats');
  r.btn('对战列表').click();assert.ok(r.btn('查看详情'),'pending Stats never gates list');
  resolveStats(response(freeze({...dto(),revision:server.version})));await tick();assert.equal(revisionCalls(r).length,2);assert.equal(statsPanel(r).getAttribute('aria-busy'),'false');assert.equal(count(r),'10');
  await openStats(r);assert.equal(statsCalls(r).length,1);assert.equal(revisionCalls(r).length,3,'reuse must recheck the server revision');
  r.btn('对战列表').click();r.page.onLeave();r.page.render(r.host);await tick();assert.equal(statsCalls(r).length,1);assert.ok(r.btn('查看详情'));assert.equal(modal(r),undefined);
  await openStats(r);assert.equal(statsCalls(r).length,1);assert.equal(count(r),'10');assert.equal(revisionCalls(r).length,4);assert.equal(r.tracked.length,0);
});

test('cache key includes normalized shared filters, server revision and catalog revision, never only selected UI entry',async t=>{
  let catalogRevision='catalog-1',serial=0;
  const server=revisionServer(url=>url.includes('/stats?')?response({...dto(),matchedBattles:++serial,revision:server.version}):null);
  const r=await mounted(t,{data:{...catalog,getCatalogRevision:()=>catalogRevision},handle:(...args)=>server.handle(...args)});
  await openStats(r);assert.equal(count(r),'1');
  r.named('outcome').value='loss';apply(r);await tick();assert.equal(count(r),'2');assert.equal(statsCalls(r).length,2);
  r.named('outcome').value='';apply(r);await tick();assert.equal(count(r),'1');assert.equal(statsCalls(r).length,2,'same normalized filter reuses its own cohort');
  server.bump();r.btn('对战列表').click();await openStats(r);assert.equal(statsCalls(r).length,3);assert.equal(count(r),'3');
  catalogRevision='catalog-2';r.btn('对战列表').click();await openStats(r);assert.equal(statsCalls(r).length,4);assert.equal(count(r),'4');
  for(const call of statsCalls(r)){const q=new URL(call.url,'http://fixture').searchParams;assert.equal(q.has('page'),false);assert.equal(q.has('pageSize'),false);}
});

test('revision changing around Stats retries a fresh cohort and does not cache the stale response',async t=>{
  const versions=['version-old','version-new','version-new','version-new'];let serial=0;
  const r=await mounted(t,{handle:url=>url.endsWith('/revision')?response({revision:versions.shift()||'version-new'}):url.includes('/stats?')?response({...dto(),matchedBattles:++serial,revision:serial===1?'version-old':'version-new'}):null});
  await openStats(r);assert.equal(statsCalls(r).length,2);assert.equal(count(r),'2');assert.equal(statsPanel(r).getAttribute('aria-busy'),'false');
  r.btn('对战列表').click();await openStats(r);assert.equal(statsCalls(r).length,2);assert.equal(count(r),'2');
});

test('legacy missing revision and mismatched Stats revision bypass caching instead of pretending qualified reuse',async t=>{
  for(const mode of ['missing','mismatch']){
    const r=await mounted(t,{handle:url=>url.endsWith('/revision')?response(mode==='missing'?undefined:{revision:'version-current'}):url.includes('/stats?')?response({...dto(),revision:mode==='mismatch'?'version-other':undefined}):null});
    await openStats(r);const requests=mode==='missing'?1:3;assert.equal(statsCalls(r).length,requests);if(mode==='mismatch'){assert.match(statsPanel(r).textContent,/数据持续变化/);assert.equal(count(r),undefined);assert.equal(statsPanel(r).getAttribute('aria-busy'),'false');assert.ok(r.btn('查看详情'));}r.btn('对战列表').click();await openStats(r);assert.equal(statsCalls(r).length,requests*2,mode+' cannot qualify a cache entry');assert.equal(r.tracked.length,0);
  }
});

test('list and Stats failures stay in their own regions; retries do not perform writes or lose the other successful region',async t=>{
  let badList=false,badStats=false;
  const server=revisionServer(url=>url.includes('/list?')&&badList?failure('list unavailable'):url.includes('/stats?')&&badStats?failure('stats unavailable'):null);
  const r=await mounted(t,{handle:(...args)=>server.handle(...args)});await openStats(r);assert.equal(count(r),'10');
  badList=true;apply(r);await tick();assert.match(r.find(n=>n.dataset.brPanel==='list').textContent,/list unavailable/);assert.equal(count(r),'10');assert.doesNotMatch(statsPanel(r).textContent,/list unavailable/);
  badList=false;badStats=true;server.bump();apply(r);await tick();assert.ok(r.btn('查看详情'));assert.match(statsPanel(r).textContent,/stats unavailable/);assert.doesNotMatch(r.find(n=>n.dataset.brPanel==='list').textContent,/stats unavailable/);
  badStats=false;r.all(statsPanel(r)).find(n=>n.tagName==='button'&&n.textContent==='重试').click();await tick();assert.equal(count(r),'10');assert.equal(r.tracked.length,0);assert.equal(r.calls.some(c=>c.options.method),false);
});

test('successful import invalidates cached Stats without eagerly fetching it from the list view',async t=>{
  const server=revisionServer(),r=await mounted(t,{handle:(...args)=>server.handle(...args)});await openStats(r);r.btn('对战列表').click();
  const file=r.named('battleFile');file.files=[{size:32,name:'isolated.ndjson',text:async()=>JSON.stringify({version:1,records:[{version:1,id:'isolated-import',sides:{},events:[]}]})}];file.emit('change');await tick();
  assert.equal(statsCalls(r).length,1);assert.equal(r.tracked.length,1);assert.equal(r.calls.filter(c=>c.options.method==='POST').length,1);assert.match(r.host.textContent,/导入完成/);
  await openStats(r);assert.equal(statsCalls(r).length,2,'successful mutation invalidates even if a legacy server keeps the same revision');
});

test('scan metadata never scans; only positive imported/updated scan results invalidate Stats, and closing preserves the tracked write',async t=>{
  let result={files:1,completed:1,imported:0,updated:0,unchanged:1},resolveScan;
  const server=revisionServer((url,options)=>url.endsWith('/scan')?options.method?new Promise(resolve=>{resolveScan=resolve;}):response({path:'C:/isolated-fixture',scanToken:'synthetic-token'}):null);
  const r=await mounted(t,{handle:(...args)=>server.handle(...args)});await openStats(r);r.btn('对战列表').click();r.btn('扫描采集记录').click();await tick();
  assert.equal(r.calls.some(c=>c.url.endsWith('/scan')&&c.options.method),false);r.btn('开始扫描').click();await tick();assert.equal(r.tracked.length,1);const write=r.calls.find(c=>c.url.endsWith('/scan')&&c.options.method);assert.equal(write.options.signal,undefined);assert.equal(write.options.headers['X-Battle-Scan-Token'],'synthetic-token');
  r.btn('关闭').click();resolveScan(response(result));await r.tracked[0];await tick();await openStats(r);assert.equal(statsCalls(r).length,1,'unchanged scan preserves the qualified cache');
  r.btn('对战列表').click();r.btn('扫描采集记录').click();await tick();r.btn('开始扫描').click();await tick();assert.equal(r.tracked.length,2);r.btn('关闭').click();result={...result,updated:1,unchanged:0};resolveScan(response(result));await r.tracked[1];await tick();assert.equal(statsCalls(r).length,1);await openStats(r);assert.equal(statsCalls(r).length,2);
});

test('relay baseline, received messages, resets and replay preserve cache; only successful-write counter increases invalidate',async t=>{
  let status={state:'stopped',received:10,imported:5,updated:2,ignored:10};
  const server=revisionServer(url=>url.endsWith('/status')?response({...status}):null),r=await mounted(t,{handle:(...args)=>server.handle(...args)});await openStats(r);r.btn('对战列表').click();
  const check=async(expected,change)=>{Object.assign(status,change);r.btn('刷新状态').click();await tick();await openStats(r);assert.equal(statsCalls(r).length,expected);r.btn('对战列表').click();};
  await check(1,{received:20,ignored:20});await check(1,{imported:0,updated:0});await check(1,{received:0});await check(2,{imported:1});await check(2,{received:100,imported:1});await check(3,{updated:1});
  assert.equal(r.tracked.length,0);assert.equal(r.calls.some(c=>c.options.method),false);
});

test('explicit CAS rule save invalidates Stats; local draft changes never invalidate or auto-PUT',async t=>{
  const server=revisionServer(),r=await mounted(t,{handle:(...args)=>server.handle(...args)});await openStats(r);r.btn('敌方样本统计').click();r.btn('阵容规则').click();
  r.named('ruleName').value='新草稿';r.named('ruleName').emit('input');r.selectors.at(-3).opts.onSelect({id:35});r.submit(nodes(r,'br-rule-form')[0]);
  assert.equal(r.calls.some(c=>c.options.method==='PUT'),false);assert.equal(statsCalls(r).length,1);r.btn('保存规则').click();await tick();assert.equal(r.tracked.length,1);assert.equal(statsCalls(r).length,2);
  const payload=JSON.parse(r.calls.find(c=>c.options.method==='PUT').options.body);assert.equal(payload.baseRevision,'r0');assert.deepEqual(payload.rules[0].monsterIds,[35]);
});

test('own-lineup row opens a portal for the exact initial multiset, local skills and matching cohort; never an inline expanded area',async t=>{
  const stats=dto();stats.archetypes.ownMatchups=[{monsterIds:[42,35,35],teams:[{...stats.archetypes.teams[0],name:'仅精确三只阵容'}]},{monsterIds:[35,42],teams:[{...stats.archetypes.teams[1],name:'仅精确两只阵容'}]}];
  stats.selfSkills=[{monsterId:35,skillId:38,casts:999999}];stats.selfPerformance.completeLineups[1].selfSkills=[{monsterId:35,skillId:38,casts:2}];
  const before=JSON.stringify(stats),r=await mounted(t,{stats:freeze(stats)});await openStats(r);const rows=nodes(r,'br-lineup-row'),calls=r.calls.length;
  assert.equal(rows.length,2);rows[0].focus();rows[0].click();assert.equal(modal(r).dataset.modalKind,'own-lineup');assert.equal(modal(r).parentNode,r.root.document.body);assert.equal(r.host.contains(modal(r)),false);
  assert.equal(rows[0].getAttribute('aria-haspopup'),'dialog');assert.equal(rows[0].getAttribute('aria-expanded'),null);assert.equal(nodes(r,'br-lineup-matchups').length,0);assert.equal(body(r).children[0].children.length,3,'duplicate species preserve initial multiplicity');
  assert.match(body(r).textContent,/仅精确三只阵容.*均衡技能 3 次 100\.0%/);assert.doesNotMatch(body(r).textContent,/仅精确两只阵容|雷霆技能|999999/);assert.ok(r.all(body(r)).some(n=>n.tagName==='img'&&n.src.includes(encodeURIComponent('均衡技能'))));
  r.root.document.emit('keydown',{key:'Escape'});assert.equal(modal(r),undefined);assert.equal(r.root.document.activeElement,rows[0]);
  rows[1].emit('keydown',{key:'Enter',target:rows[1]});assert.equal(modal(r).dataset.modalKind,'own-lineup');assert.match(body(r).textContent,/仅精确两只阵容.*雷霆技能 2 次 100\.0%/);assert.doesNotMatch(body(r).textContent,/仅精确三只阵容|均衡技能|999999/);
  modal(r).emit('click');assert.equal(modal(r),undefined);assert.equal(r.calls.length,calls);assert.equal(r.tracked.length,0);assert.equal(JSON.stringify(stats),before);r.page.onLeave();assert.equal(r.root.document.listeners.keydown.length,0);assert.equal(r.root.document.listeners.focusin.length,0);
});

test('loaded and staged family predicates deduplicate equivalent families, promote single-any, preserve alternative avatars and normalize only on staging',async t=>{
  const monsters=[{id:10,image:'10.png'},{id:11,evolves_from_id:10,image:'11.png'},{id:12,leader_of_id:11,image:'12.png'},{id:20,image:'20.png'},{id:21,evolves_from_id:20,image:'21.png'},{id:30,image:'30.png'},{id:40,main_form_id:30,evolution_members:[30],image:'40.png'}];
  const original={id:'stable-family',name:'完整原规则',monsterIds:[10,11,12],excludedMonsterIds:[20,21],anyOf:[[10,11],[30,40],[40,30]]};let saved=[original],revision='rules-family';
  const r=await mounted(t,{data:{...catalog,getMonsters:()=>monsters,getMonsterById:id=>monsters.find(x=>x.id===Number(id))},handle:(url,options)=>url.endsWith('/rules')?options.method?(saved=JSON.parse(options.body).rules,response({rules:saved,revision:revision+='n'})):response({rules:saved,revision}):null});
  await openStats(r);r.btn('敌方样本统计').click();r.btn('阵容规则').click();const card=nodes(r,'br-rule')[0];
  assert.doesNotMatch(card.textContent,/·#|#10|#11|#12|精灵10|精灵11|精灵20/);assert.match(card.textContent,/精灵12.*精灵30.*精灵40.*精灵21/);assert.ok(r.all(card).some(n=>n.tagName==='img'&&n.src.endsWith('/30.png')));assert.ok(r.all(card).some(n=>n.tagName==='img'&&n.src.endsWith('/40.png')));assert.equal(r.calls.some(c=>c.options.method),false);
  r.btn('保存规则').click();await tick();assert.deepEqual(saved,[{id:'stable-family',name:'完整原规则',monsterIds:[12],excludedMonsterIds:[21],anyOf:[[30,40]]}]);
  r.btn('新增规则').click();r.named('ruleName').value='分步新规则';r.named('ruleName').emit('input');r.btn('新增任选组').click();const any=r.selectors.at(-1);any.opts.onSelect({id:10});assert.equal(nodes(r,'br-any-group').length,1);assert.match(nodes(r,'br-any-group')[0].textContent,/精灵10/);
  any.opts.onSelect({id:30});assert.match(nodes(r,'br-any-group')[0].textContent,/精灵10.*精灵30/);r.btn('新增任选组').click();any.opts.onSelect({id:11});any.opts.onSelect({id:12});r.btn('保存规则').click();await tick();
  assert.equal(saved.length,2);assert.deepEqual(saved[1].monsterIds,[12]);assert.equal(saved[1].anyOf,undefined,'required family makes its containing alternative redundant');assert.deepEqual(saved[1].excludedMonsterIds,[]);assert.equal(r.tracked.length,2);
});

test('three filter fields share the compact CSS row; picker uses safe icon/name candidates, inside-box clear and draft-only selection',async t=>{
  const monsters=[{id:35,image:'正确头像.png?v=one'},{id:42,image:'../unsafe.png'}];
  const r=await mounted(t,{data:{...catalog,getMonsters:()=>monsters,getMonsterById:id=>monsters.find(x=>x.id===Number(id)),getMonsterDisplayName:p=>p.id===35?'正确名字':'<img>安全文本'}});
  const grid=nodes(r,'br-filter-grid')[0];assert.equal(grid.children.length,3);assert.match(grid.textContent,/对战结果.*精灵.*敌方阵容体系/);
  const selector=r.selectors[0],candidate=selector.opts.search('35')[0];assert.equal(candidate.name,'正确名字');assert.equal(candidate.icon,'assets/monster/images/'+encodeURIComponent('正确头像.png')+'?v=one');assert.doesNotMatch(candidate.name,/·#|#35/);
  const unsafe=selector.opts.search('42')[0];assert.equal(unsafe.name,'&lt;img&gt;安全文本');assert.equal(unsafe.icon,'');assert.equal(r.all().some(n=>n.tagName==='script'),false);
  const calls=r.calls.length;selector.opts.onSelect(candidate);assert.equal(selector.box.input.value,'正确名字');assert.equal(selector.box.selectedItem.name,'正确名字');
  const clear=r.all(selector.box.wrapper).find(n=>n.getAttribute('aria-label')==='清空精灵');assert.ok(clear);assert.equal(clear.parentNode,selector.box.wrapper);assert.equal(clear.hidden,false);assert.equal(r.btn('清除精灵'),undefined);assert.equal(r.calls.length,calls);
  apply(r);await tick();assert.equal(new URL(r.calls.filter(c=>c.url.includes('/list?')).at(-1).url,'http://fixture').searchParams.get('monsterId'),'35');assert.equal(statsCalls(r).length,0);
  clear.click();assert.equal(selector.box.input.value,'');assert.equal(clear.hidden,true);assert.equal(r.root.document.activeElement,selector.box.input);assert.equal(r.calls.filter(c=>c.url.includes('/list?')).length,2,'clearing is still only a draft');
  const team=r.named('teamRuleId');assert.equal(team.tagName,'button');assert.equal(team.getAttribute('aria-haspopup'),'listbox');team.click();const menu=team.parentNode.children[1];assert.equal(menu.hidden,false);const other=menu.children.find(n=>n.value==='__other__');other.click();assert.equal(team.value,'__other__');assert.equal(menu.hidden,true);assert.equal(r.root.document.activeElement,team);
  r.named('outcome').value='loss';r.named('rankMin').value='3';r.named('rankMin').emit('input');r.btn('重置筛选').click();await tick();const query=new URL(r.calls.filter(c=>c.url.includes('/list?')).at(-1).url,'http://fixture').searchParams;assert.equal(query.has('monsterId'),false);assert.equal(query.has('teamRuleId'),false);assert.equal(query.has('outcome'),false);assert.equal(query.has('rankMin'),false);
  const css=fs.readFileSync(path.join(__dirname,'../css/battle-records.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');assert.match(css,/\.br-filter-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);assert.doesNotMatch(css,/\.br-archetype-components\s*\{|\.br-lineup-matchups\s*\{/);
});

test('valid member pies exclude charge/stun; known-zero individual samples render zero while missing/inconsistent values stay unavailable',async t=>{
  const stats=dto(),part=stats.archetypes.teams[0].components[0];
  part.skillUsage=[{skillId:37,casts:3},{kind:'wishImpact',typeId:3,casts:5},{kind:'charge',casts:200},{kind:'stunSkip',casts:100}];part.usageTotalCasts=8;
  part.individualChoices=[{attribute:'hp',selected:2,unselected:1,samples:3,unknown:9,rate:2/3},{attribute:'attack',selected:0,unselected:4,samples:4,unknown:10,rate:0},{attribute:'magicAttack',selected:1,unselected:0,samples:1,unknown:3,rate:1},{attribute:'defense',selected:2,unselected:1,samples:4,unknown:0,rate:.5},{attribute:'speed',unselected:1,samples:1,unknown:3,rate:0}];
  const before=JSON.stringify(stats),r=await mounted(t,{stats:freeze(stats)});await openStats(r);r.btn('敌方样本统计').click();r.find(n=>n.tagName==='tr'&&n.dataset.archetypeId==='balance').click();
  const skill=nodes(r,'br-member-skill')[0],lines=nodes(r,'br-individual-line');assert.match(skill.textContent,/均衡技能 · 3 次 · 37\.5%/);assert.match(skill.textContent,/愿力冲击.*5 次 · 62\.5%/);assert.doesNotMatch(skill.textContent,/聚能|眩晕|200|100 次/);
  assert.equal(r.all(skill).filter(n=>n.tagName==='path').reduce((sum,n)=>sum+Number(n.getAttribute('data-count')),0),8);assert.ok(r.all(skill).some(n=>n.tagName==='img'&&n.src==='assets/system-actions/wish-3.png'));
  assert.deepEqual(Array.from(lines,n=>n.dataset.available),['true','true','true','false','false','false']);assert.deepEqual(Array.from(lines,n=>n.getAttribute('aria-valuenow')),[String(2/3*100),'0','100',null,null,null]);
  assert.match(lines[0].title,/2 \/ 3.*未知 9（不参与分母）/);assert.match(lines[1].textContent,/0\.0%/);assert.match(lines[2].textContent,/100\.0%/);assert.ok(lines.slice(3).every(n=>n.textContent.includes('未探明')));assert.equal(JSON.stringify(stats),before);assert.equal(r.tracked.length,0);
});

test('statistics refresh clears stale modal cohort while pending and closing forbids late reopening',async t=>{
  let pending=false,resolveStats;
  const server=revisionServer(url=>pending&&url.includes('/stats?')?new Promise(resolve=>{resolveStats=resolve;}):null),r=await mounted(t,{handle:(...args)=>server.handle(...args)});await openStats(r);
  const row=nodes(r,'br-lineup-row')[0];row.click();assert.match(body(r).textContent,/均衡技能/);pending=true;r.named('outcome').value='loss';apply(r);await tick();
  assert.equal(body(r).getAttribute('aria-busy'),'true');assert.doesNotMatch(body(r).textContent,/均衡技能|雷霆技能/);const detached=body(r);r.root.document.emit('keydown',{key:'Escape'});assert.equal(modal(r),undefined);
  resolveStats(response({...dto(),revision:server.version}));await tick();assert.equal(modal(r),undefined);assert.match(detached.textContent,/正在核对/);assert.equal(detached.isConnected,false);assert.equal(r.tracked.length,0);
});

test('fifteen existing user rules retain IDs, content and display order on startup and cancelled builtin replacement',async t=>{
  const existing=freeze(Array.from({length:15},(_,i)=>({id:`existing-${i+1}`,name:`玩家已保存${i+1}`,monsterIds:[35],excludedMonsterIds:[8],anyOf:[[42,501]]}))),defaults=freeze(Array.from({length:15},(_,i)=>({id:`default-${i+1}`,name:`内置${i+1}`,monsterIds:[42],excludedMonsterIds:[]}))),before=JSON.stringify(existing);
  const r=await mounted(t,{handle:(url,options)=>url.endsWith('/rules')&&!options.method?response({rules:existing,defaults,revision:'rules-existing-15'}):null});await openStats(r);r.btn('敌方样本统计').click();r.btn('阵容规则').click();
  assert.deepEqual(Array.from(nodes(r,'br-rule'),n=>n.dataset.ruleId),existing.map(x=>x.id));assert.equal(r.calls.some(c=>c.options.method),false);r.btn('载入内置规则').click();assert.deepEqual(Array.from(nodes(r,'br-rule'),n=>n.dataset.ruleId),existing.map(x=>x.id));r.btn('取消载入').click();r.btn('关闭').click();
  assert.equal(JSON.stringify(existing),before);assert.equal(r.calls.some(c=>c.options.method),false);assert.equal(r.tracked.length,0);
});
