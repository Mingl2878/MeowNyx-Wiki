'use strict';
// Contract-focused deterministic UI tests. No browser control, Go, raw DB,
// production catalog/profile data, real network or persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const setupPath = path.join(__dirname, 'battle-performance-ui.test.js');
const setup = fs.readFileSync(setupPath, 'utf8');
const box = { module: { exports: {} }, require: createRequire(setupPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
vm.runInNewContext(setup.slice(0, setup.indexOf('\ntest(')) + '\nmodule.exports={runtime,performanceFixture,freeze};', box, {filename:setupPath});
const {runtime,performanceFixture,freeze}=box.module.exports;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=body=>({ok:true,json:async()=>body});
const error=(message,status=500)=>({ok:false,status,json:async()=>({error:message})});
const nodes=(r,cls,host)=>r.all(host).filter(n=>(n.getAttribute('class')||n.className).split(' ').includes(cls));
const branch=(r,side='enemy')=>r.find(n=>n.dataset.brStats===side);
const modal=r=>nodes(r,'br-modal-root')[0];
const buttons=(r,label,host)=>r.all(host).filter(n=>n.tagName==='button'&&n.textContent===label);
const rules=r=>nodes(r,'br-rule');
const writes=r=>r.calls.filter(c=>c.options.method==='PUT');
const catalog={getMonsters:()=>[35,42,501,8].map(id=>({id})),getMonsterById:id=>({id,image:`p${id}.png`}),getMonsterDisplayName:pet=>`精灵${pet.id}`,getMoves:()=>[{id:37},{id:38}],getMoveName:skill=>skill.id===37?'均衡技能':'雷霆技能'};
const summary={battles:4,wins:1,losses:2,draws:0,unknown:1,knownOutcomes:3,winRate:1/3,averageRounds:8.5,roundSamples:2,averageDurationSeconds:79.8,durationSamples:3};
function component(id,skillId) { return {monsterId:id,carried:4,samples:4,rate:1,usageTotalCasts:8,skillUsage:[{monsterId:id,skillId,casts:3},{monsterId:id,kind:'wishImpact',casts:5}],skills:[{skillId:999,carried:777777,samples:777777,rate:1}],profile:{profileSamples:4,ivSamples:{hp:2},natureSamples:{hp:2},ivDistributions:{hp:{60:2}},natureDistributions:{hp:{1:2}}},natureSamples:4,natureConfigurations:[{label:'生命正性格 · 其余未探明',battles:1,partial:true},{label:'未探明',battles:3,unknown:true}],individualChoices:[{attribute:'hp',selected:2,unselected:1,samples:3,unknown:1,rate:2/3}],lifeProfileSamples:1,lifeProfileUnknown:3,lifeProfiles:[{iv:60,nature:0,battles:1,rate:1}]}; }
function dto() {
  const selfPerformance=performanceFixture(), base=selfPerformance.species[0];
  selfPerformance.species.push({...base,monsterId:501,rollerCoaster:{carriedBattles:4,successBattles:2,knownOutcomeBattles:1,wins:1,successRate:.5,winRate:1}});
  const enemyPerformance={species:[{...base,monsterId:501,carryRate:.3,winRate:.75,carryOccurrences:3,carrySamples:10,wins:3,knownOutcomeBattles:4,rollerCoaster:{carriedBattles:4,successBattles:1,knownOutcomeBattles:1,wins:0,successRate:.25,winRate:0}}]};
  const balance={...summary,id:'balance',name:'均衡体系',monsterIds:[42],excludedMonsterIds:[8],other:false,teammates:[{monsterId:35,carried:3,samples:4,rate:.75},{monsterId:501,carried:1,samples:4,rate:.25}],components:[component(42,37)]};
  const thunder={...summary,id:'thunder',name:'雷霆体系',monsterIds:[42,8],excludedMonsterIds:[],other:false,teammates:[],components:[{...component(42,38),lifeProfiles:[{iv:60,nature:1,battles:1,rate:1}]}]};
  const other={...summary,battles:2,id:'__other__',name:'其他',other:true,monsterIds:[],excludedMonsterIds:[],teammates:[],components:[]};
  return {matchedBattles:10,outcomes:{win:1,loss:2,draw:0,unknown:7},selfPerformance,enemyPerformance,selfSkills:[{monsterId:35,skillId:37,casts:2},{monsterId:501,skillId:38,casts:4}],enemy:[{monsterId:42,skills:[{skillId:38,casts:777777}],ivDistributions:{hp:{0:777777}}}],archetypes:{samples:10,unknownBattles:2,teams:[balance,thunder,other],environment:[{id:'balance',name:'均衡体系',battles:4,samples:10,rate:.4},{id:'thunder',name:'雷霆体系',battles:4,samples:10,rate:.4},{id:'__other__',name:'其他',other:true,battles:2,samples:10,rate:.2}],ownMatchups:[]}};
}
async function mount(t,options={}) { const r=runtime({stats:dto(),data:catalog,...options});t.after(()=>r.page.onLeave());await tick();r.btn('样本统计').click();await tick();r.btn('敌方样本统计').click();return r; }
function openRules(r) { r.btn('阵容规则').click();return modal(r); }
function stage(r,name,include,exclude=[]) { r.named('ruleName').value=name;r.named('ruleName').emit('input');for(const id of include)r.selectors[1].opts.onSelect({id});for(const id of exclude)r.selectors[2].opts.onSelect({id});r.submit(nodes(r,'br-rule-form')[0]); }
function clickRow(r,id) { const row=r.find(n=>n.dataset.archetypeId===id&&n.tagName==='tr');assert.ok(row, `missing archetype ${id}`);row.click();return row; }
const modalBody=r=>nodes(r,'br-dialog-body')[0];
const options=r=>Array.from(r.named('teamRuleId').parentNode.children[1].children);
const apply=r=>r.submit(r.find(n=>n.tagName==='form'&&n.getAttribute('aria-label')==='对战记录共享筛选'));
function server(initial=[]) { let revision='rev-1', saved=initial, fail=false, wait=null;return {get saved(){return saved;},get revision(){return revision;},set fail(value){fail=value;},set wait(value){wait=value;},bump(){revision+='x';},handle(url,opts){if(!url.endsWith('/rules'))return null;if(!opts.method)return response({rules:saved,revision});const payload=JSON.parse(opts.body);if(fail)return error('write offline');if(payload.baseRevision!==revision)return error('规则版本冲突，请重新读取',409);const commit=()=>{saved=payload.rules;revision+='n';return response({rules:saved,revision});};return wait?new Promise(resolve=>wait.push(()=>resolve(commit()))):commit();}}; }

test('enemy exactly three modules; common five columns, no entered/details trigger, 501 rates in final column',async t=>{
  const stats=freeze(dto()),before=JSON.stringify(stats),r=await mount(t,{stats}),enemy=branch(r);
  assert.deepEqual(Array.from(enemy.children,n=>n.dataset.enemyModule),['performance','teams','environment']);
  const identity=r.all(enemy).find(n=>n.dataset.performanceMonsterId==='501'),row=identity.parentNode.parentNode;
  assert.equal(row.children.length,5);assert.deepEqual(Array.from(r.all(row.children[0]).filter(n=>n.tagName==='dt'),n=>n.textContent),['携带局数','进场次数','携带率','精灵胜率']);
  assert.doesNotMatch(row.children[0].textContent,/登场局数|精灵详情|过山车/);assert.equal(r.all(row).some(n=>n.dataset.departureMonsterId),false);
  assert.match(row.children[0].textContent,/携带率 30\.0% 精灵胜率 75\.0%/);assert.match(row.children[4].textContent,/过山车成功率 25\.0%.*成功过山车后的胜率 0\.0%/);
  assert.match(r.all(row).find(n=>n.dataset.performanceRate==='carryRate').title,/累计 3 \/ 10/);
  assert.doesNotMatch(enemy.textContent,/主动切换|首发样本|观察发生率|来源声明覆盖|777777/);
  const calls=r.calls.length;buttons(r,'场均',enemy)[0].click();assert.equal(r.all(row).find(n=>n.dataset.performanceMetric==='entries').textContent,'0.75');assert.match(row.children[0].textContent,/30\.0%.*75\.0%/);
  assert.equal(buttons(r,'场均',branch(r,'me'))[0].getAttribute('aria-pressed'),'true');assert.equal(r.calls.length,calls);assert.equal(JSON.stringify(stats),before);
});

test('own all species include 501 entered label and first-column plaintext details, no voluntary summary',async t=>{
  const r=await mount(t),own=branch(r,'me');r.btn('我方样本统计').click();
  const identities=r.all(own).filter(n=>n.dataset.performanceMonsterId);
  for(const identity of identities){assert.match(identity.textContent,/登场局数 2.*精灵详情/);assert.equal(r.all(identity).find(n=>n.dataset.departureMonsterId).className,'br-departure-open');}
  const roller=identities.find(n=>n.dataset.performanceMonsterId==='501').parentNode.parentNode;assert.doesNotMatch(roller.children[0].textContent,/过山车成功率/);assert.match(roller.children[4].textContent,/过山车成功率 50\.0%/);assert.doesNotMatch(own.textContent,/主动切换/);
  r.all(roller.children[0]).find(n=>n.dataset.departureMonsterId).click();assert.match(nodes(r,'br-own-skill-usage')[0].textContent,/雷霆技能 4 次 100\.0%/);assert.doesNotMatch(nodes(r,'br-own-skill-usage')[0].textContent,/均衡技能/);
});

test('enemy member portal keeps same-species usage in its cohort; rates divide casts, not battle occurrences or initial loadouts',async t=>{
  const r=await mount(t),calls=r.calls.length,row=clickRow(r,'balance'),child=modalBody(r);
  assert.equal(modal(r).dataset.modalKind,'archetype');assert.match(nodes(r,'br-dialog')[0].textContent,/均衡体系 · 成员配置/);
  assert.equal(row.getAttribute('aria-haspopup'),'dialog');assert.equal(row.getAttribute('aria-expanded'),null);assert.equal(nodes(r,'br-archetype-components').length,0);
  assert.match(child.textContent,/均衡技能 · 3 次 · 37\.5%/);assert.doesNotMatch(child.textContent,/雷霆技能|777777|双生命/);
  assert.match(child.textContent,/愿力冲击·属性未确认 · 5 次 · 62\.5%/);assert.doesNotMatch(child.textContent,/初始技能携带|已知配招|联合分布|60：2 场/);
  assert.ok(r.all(nodes(r,'br-member-skill')[0]).some(n=>n.tagName==='svg'));assert.ok(r.all(child).some(n=>n.tagName==='img'&&n.src.includes(encodeURIComponent('均衡技能'))));
  const old=nodes(r,'br-archetype-component')[0];clickRow(r,'thunder');assert.equal(old.isConnected,false);assert.match(modalBody(r).textContent,/雷霆技能 · 3 次 · 37\.5%/);assert.doesNotMatch(modalBody(r).textContent,/均衡技能|777777|双生命|联合分布/);
  const thunder=r.find(n=>n.dataset.archetypeId==='thunder'&&n.tagName==='tr');thunder.emit('keydown',{key:' ',target:thunder});assert.equal(nodes(r,'br-modal-root').length,1);
  r.root.document.emit('keydown',{key:'Escape'});assert.equal(modal(r),undefined);assert.equal(r.root.document.activeElement,thunder);assert.equal(old.isConnected,false);
  assert.equal(r.calls.length,calls);assert.equal(r.tracked.length,0);
});

test('zero recorded skill samples stay unavailable, and deprecated joint life never mounts',async t=>{
  const stats=dto(),part=stats.archetypes.teams[0].components[0];part.skillUsage=[];part.usageTotalCasts=0;
  const row=stats.enemyPerformance.species[0];row.carrySamples=0;row.knownOutcomeBattles=0;row.carryRate=0;row.winRate=0;
  const r=await mount(t,{stats});clickRow(r,'balance');const child=modalBody(r),skill=nodes(r,'br-member-skill')[0];assert.match(skill.textContent,/暂无有效技能执行样本/);assert.equal(r.all(skill).some(n=>n.tagName==='svg'),false);assert.doesNotMatch(child.textContent,/联合|双生命|0\.0%|777777/);
  const enemy=branch(r);assert.equal(r.all(enemy).find(n=>n.dataset.performanceRate==='carryRate').textContent,'—');assert.equal(r.all(enemy).find(n=>n.dataset.performanceRate==='winRate').textContent,'—');
});

test('environment renders independent multilabel rates above 100 percent without changing distinct totals or normalizing a pie',async t=>{
  const stats=dto();stats.archetypes.environment[0]={id:'balance',name:'均衡体系',battles:8,samples:10,rate:.8};stats.archetypes.environment[1]={id:'thunder',name:'雷霆体系',battles:7,samples:10,rate:.7};
  const before=JSON.stringify(stats),r=await mount(t,{stats}),rows=nodes(r,'br-environment-rate'),environment=r.find(n=>n.dataset.enemyModule==='environment');
  assert.deepEqual(Array.from(rows,n=>n.textContent),['均衡体系 8 / 10 场 · 80.0%','雷霆体系 7 / 10 场 · 70.0%','其他 2 / 10 场 · 20.0%']);
  assert.match(environment.textContent,/去重对战 10 场.*不相加或归一化/);assert.equal(r.all(environment).some(n=>n.tagName==='svg'),false);assert.equal(nodes(r,'br-environment-chart').length,0);assert.equal(JSON.stringify(stats),before);
  const zero=dto();zero.archetypes.samples=0;const empty=await mount(t,{stats:zero});assert.match(branch(empty).textContent,/暂无有效环境样本/);assert.equal(nodes(empty,'br-environment-rate').length,0);
  const malformed=dto();malformed.archetypes.environment[0].rate=null;const partial=await mount(t,{stats:malformed});assert.deepEqual(Array.from(nodes(partial,'br-environment-rate'),n=>n.dataset.archetypeId),['thunder','__other__']);assert.doesNotMatch(r.find(n=>n.dataset.enemyModule==='environment').textContent,/40\.0%/);
});

test('enemy row selection, known-result ME winrate and backend teammate order are presentation-only',async t=>{
  const r=await mount(t),row=r.find(n=>n.dataset.archetypeId==='balance'&&n.tagName==='tr');assert.equal(row.children.length,6);assert.match(row.children[3].textContent,/33\.3%.*已知结果 3 \/ 4/);assert.match(row.children[4].textContent,/8\.5 回合/);assert.match(row.children[5].textContent,/1分钟20秒/);
  assert.match(row.children[1].textContent,/精灵35 75\.0%.*精灵501 25\.0%/);const calls=r.calls.length;
  row.focus();row.emit('keydown',{key:'Enter',target:row});assert.equal(modal(r).dataset.modalKind,'archetype');const first=modal(r);row.emit('keydown',{key:'Enter',repeat:true,target:row});assert.equal(modal(r),first);modal(r).emit('click',{target:nodes(r,'br-dialog')[0]});assert.equal(modal(r),first);modal(r).emit('click');assert.equal(modal(r),undefined);assert.equal(r.root.document.activeElement,row);assert.equal(r.calls.length,calls);
});

test('rules exist only in heading modal: stable local IDs, includes/excludes and add/delete/reorder are drafts until explicit PUT',async t=>{
  const storage=server(),r=await mount(t,{handle:(...args)=>storage.handle(...args)});assert.equal(r.btn('队伍规则'),undefined);assert.equal(r.named('ruleName'),undefined);assert.equal(writes(r).length,0);
  openRules(r);stage(r,'先包含35排除42',[35],[42]);assert.equal(writes(r).length,0);const first=rules(r)[0].dataset.ruleId;
  r.btn('新增规则').click();stage(r,'后包含42',[42]);const second=rules(r)[1].dataset.ruleId;assert.notEqual(first,second);assert.equal(writes(r).length,0);
  buttons(r,'上移',rules(r)[1])[0].click();assert.deepEqual(Array.from(rules(r),n=>n.dataset.ruleId),[second,first]);assert.equal(writes(r).length,0);
  r.btn('保存规则').click();await tick();assert.equal(writes(r).length,1);assert.equal(JSON.parse(writes(r)[0].options.body).baseRevision,'rev-1');assert.deepEqual(storage.saved.map(rule=>rule.id),[second,first]);assert.deepEqual(storage.saved[1].monsterIds,[35]);assert.deepEqual(storage.saved[1].excludedMonsterIds,[42]);assert.equal(storage.saved[1].name,'先包含35排除42');
  assert.deepEqual(options(r).map(n=>n.value),['',second,first,'__other__']);assert.equal(r.tracked.length,1);
  buttons(r,'删除规则',rules(r)[0])[0].click();assert.equal(writes(r).length,1);r.btn('关闭').click();openRules(r);assert.equal(rules(r).length,1);r.btn('保存规则').click();await tick();assert.deepEqual(storage.saved.map(rule=>rule.id),[first]);
});

test('editing rule preserves its ID and rejects overlap or missing required members without writes',async t=>{
  const storage=server([{id:'persisted',name:'旧名字',monsterIds:[35],excludedMonsterIds:[42]}]);const r=await mount(t,{handle:(...args)=>storage.handle(...args)});openRules(r);
  buttons(r,'编辑规则',rules(r)[0])[0].click();r.named('ruleName').value='新名字';r.named('ruleName').emit('input');r.selectors[2].opts.onSelect({id:35});assert.match(modal(r).textContent,/不能同时要求包含和排除/);assert.equal(writes(r).length,0);
  r.btn('保存规则').click();await tick();assert.equal(storage.saved[0].id,'persisted');assert.equal(storage.saved[0].name,'新名字');assert.deepEqual(storage.saved[0].excludedMonsterIds,[42]);
  r.btn('新增规则').click();r.named('ruleName').value='没有核心';r.named('ruleName').emit('input');r.btn('保存规则').click();assert.match(modal(r).textContent,/至少一个核心/);assert.equal(writes(r).length,1);
});

test('save failure and stale revision preserve draft content/order; reloading version never silently commits or installs presets',async t=>{
  const storage=server([{id:'a',name:'原始',monsterIds:[35],excludedMonsterIds:[]}]);const r=await mount(t,{handle:(...args)=>storage.handle(...args)});openRules(r);buttons(r,'编辑规则',rules(r)[0])[0].click();stage(r,'本地修改',[],[]);
  storage.fail=true;r.btn('保存规则').click();await tick();assert.match(modal(r).textContent,/write offline/);assert.equal(rules(r)[0].dataset.ruleId,'a');assert.equal(r.named('ruleName').value,'本地修改');assert.equal(storage.saved[0].name,'原始');
  storage.fail=false;storage.bump();r.btn('重试').click();await tick();assert.match(modal(r).textContent,/版本冲突/);assert.equal(storage.saved[0].name,'原始');assert.equal(JSON.parse(writes(r).at(-1).options.body).baseRevision,'rev-1');
  const count=writes(r).length;r.btn('重新读取规则版本（保留草稿）').click();await tick();assert.equal(writes(r).length,count);assert.match(modal(r).textContent,/保留本地草稿/);assert.match(rules(r)[0].textContent,/本地修改/);assert.equal(r.named('ruleName').value,'本地修改');
  assert.equal(r.btn('保存规则').disabled,true); r.btn('保存规则').click(); await tick(); assert.equal(writes(r).length,count);
  r.btn('核对用本地草稿整体替换').click(); assert.match(modal(r).textContent,/整体替换.*显示顺序/); assert.equal(writes(r).length,count);
  r.btn('确认整体替换，并保存').click();await tick();assert.equal(storage.saved[0].name,'本地修改');assert.equal(JSON.parse(writes(r).at(-1).options.body).baseRevision,'rev-1x');
});

test('close/reopen during pending rule write does not abort or duplicate commit; focus/inert/scroll restore, save refreshes classification',async t=>{
  const storage=server(),pending=[];storage.wait=pending;const r=await mount(t,{handle:(...args)=>storage.handle(...args)}),page=nodes(r,'battle-records-page')[0];page.scrollTop=125;openRules(r);stage(r,'显式规则',[35]);r.btn('保存规则').click();await tick();
  assert.equal(writes(r).length,1);assert.equal(writes(r)[0].options.signal,undefined);assert.equal(r.tracked.length,1);assert.equal(r.btn('保存规则').disabled,true);
  r.root.document.emit('keydown',{key:'Escape'});assert.equal(modal(r),undefined);assert.equal(r.host.inert,undefined);assert.equal(page.scrollTop,125);assert.equal(r.root.document.activeElement,r.btn('阵容规则'));
  openRules(r);assert.equal(r.btn('保存规则').disabled,true);r.btn('保存规则').click();assert.equal(writes(r).length,1);const calls=r.calls.length;pending[0]();await tick();assert.match(modal(r).textContent,/规则已保存/);assert.equal(r.btn('保存规则').disabled,false);assert.equal(r.calls.filter(c=>c.url.includes('/list?')).length,2);assert.equal(r.calls.filter(c=>c.url.includes('/stats?')).length,2);assert.equal(r.calls.slice(calls).some(c=>c.options.method),false);assert.equal(storage.saved.length,1);
  r.btn('关闭').click();assert.equal(r.root.document.listeners.keydown.length,0);assert.equal(r.root.document.listeners.focusin.length,0);
});

test('leave during pending rules write retains client barrier but forbids late UI repaint',async t=>{
  const storage=server(),pending=[];storage.wait=pending;const r=await mount(t,{handle:(...args)=>storage.handle(...args)});openRules(r);stage(r,'离页保存',[35]);r.btn('保存规则').click();await tick();const write=writes(r)[0];r.page.onLeave();const before=r.host.textContent;pending[0]();await tick();assert.equal(write.options.signal,undefined);assert.equal(storage.saved[0].name,'离页保存');assert.equal(r.host.textContent,before);assert.equal(modal(r),undefined);assert.equal(r.tracked.length,1);
});

test('shared-filter refresh handles region-specific failures, ignores late cohorts and closes an invalid own modal',async t=>{
  let pending=null,fail=false,current=dto();const r=await mount(t,{handle:url=>url.includes('/stats?')?pending?new Promise(resolve=>pending.push(resolve)):fail?error('classification unavailable'):response(current):null});
  clickRow(r,'balance');fail=true;apply(r);await tick();assert.equal(nodes(r,'br-archetype-component').length,0);assert.match(r.all().map(n=>n.textContent).join(' '),/classification unavailable/);assert.ok(r.btn('查看详情'),'stats failure cannot erase successful list');
  fail=false;buttons(r,'重试',r.find(n=>n.dataset.brPanel==='stats'))[0].click();await tick();assert.match(modalBody(r).textContent,/均衡技能/);
  pending=[];r.named('outcome').value='loss';apply(r);await tick();r.named('outcome').value='win';apply(r);await tick();assert.equal(pending.length,2);const fresh=dto();fresh.archetypes.teams[0].components[0].skillUsage=[{skillId:38,casts:8}];pending[1](response(fresh));await tick();pending[0](response(dto()));await tick();
  if(!modal(r))clickRow(r,'balance');assert.match(modalBody(r).textContent,/雷霆技能/);assert.doesNotMatch(modalBody(r).textContent,/均衡技能/);
  const list=new URL(r.calls.filter(c=>c.url.includes('/list?')).at(-1).url,'http://test').searchParams,stat=new URL(r.calls.filter(c=>c.url.includes('/stats?')).at(-1).url,'http://test').searchParams;list.delete('page');list.delete('pageSize');assert.equal(list.toString(),stat.toString());assert.equal(stat.get('outcome'),'win');
  pending=null;r.btn('关闭').click();r.btn('我方样本统计').click();r.btn('精灵详情').click();current=dto();current.selfPerformance.species=[];apply(r);await tick();assert.equal(modal(r),undefined);
});

test('rule picker widgets are mounted lazily, destroyed on close and recreated without losing stable drafts', async t => {
  const r = await mount(t); r.flushDetachedWidgets(); assert.equal(r.selectors.length, 1); assert.equal(r.selectors[0].box.destroyed, undefined);
  openRules(r); r.flushDetachedWidgets(); const first = r.selectors.slice(-3); assert.ok(first.every(picker => !picker.box.destroyed && picker.box.input.isConnected));
  stage(r, '保留草稿', [35], [42]); const id = rules(r)[0].dataset.ruleId; const calls = r.calls.length;
  r.btn('关闭').click(); assert.ok(first.every(picker => picker.box.destroyed)); r.flushDetachedWidgets();
  openRules(r); r.flushDetachedWidgets(); const next = r.selectors.slice(-3); assert.ok(next.every(picker => !picker.box.destroyed && picker.box.input.isConnected)); assert.notEqual(first[0].box, next[0].box);
  assert.equal(rules(r)[0].dataset.ruleId, id); assert.equal(r.named('ruleName').value, '保留草稿');
  const before = modal(r).textContent; first[0].opts.onSelect({id:8}); assert.equal(modal(r).textContent, before, 'old widget cannot alter a reopened editor');
  next[0].opts.onSelect({id:8}); r.submit(nodes(r, 'br-rule-form')[0]); assert.match(rules(r)[0].textContent, /精灵8/); assert.equal(r.calls.length, calls);
  r.page.onLeave(); assert.ok(r.selectors.every(picker => picker.box.destroyed)); assert.equal(r.managedWidgets.size, 0);
});

test('initial rule-read failures preserve new staged local IDs and rule access remains available when stats also fail', async t => {
  let failRules = true;
  const r = await mount(t, { handle: (url, options) => url.includes('/stats?') ? error('statistics offline') : url.endsWith('/rules') && !options.method ? failRules ? error('rules offline') : response({rules:[{id:'remote',name:'已有规则',monsterIds:[42],excludedMonsterIds:[]}],revision:'read-r2'}) : null });
  assert.match(r.host.textContent, /statistics offline/); assert.ok(r.btn('阵容规则')); openRules(r); assert.equal(r.btn('保存规则').disabled, true);
  stage(r, '等待时新增', [35]); const id = rules(r)[0].dataset.ruleId; assert.equal(writes(r).length, 0);
  assert.match(modal(r).textContent, /rules offline/, 'draft edits must not hide a real read failure');
  failRules = false; buttons(r, '重试', modal(r))[0].click(); await tick();
  assert.deepEqual(Array.from(rules(r),node=>node.dataset.ruleId), ['remote',id]); assert.equal(r.named('ruleName').value,'等待时新增'); assert.equal(writes(r).length,0);
  r.btn('关闭').click(); r.page.onLeave();
  // Independently exercise a pending first GET completing after local staging.
  let resolveRead;
  const pending = runtime({stats:dto(),data:catalog,handle:(url,options)=>url.endsWith('/rules')&&!options.method?new Promise(resolve=>{resolveRead=resolve;}):null});t.after(()=>pending.page.onLeave());await tick();pending.btn('样本统计').click();await tick();pending.btn('敌方样本统计').click();openRules(pending);
  stage(pending, '等待完成', [35]); const localId=rules(pending)[0].dataset.ruleId;
  resolveRead(response({rules:[{id:'remote',name:'已有规则',monsterIds:[42],excludedMonsterIds:[]}],revision:'read-r2'}));await tick();
  assert.deepEqual(Array.from(rules(pending),node=>node.dataset.ruleId),['remote',localId]);assert.equal(pending.named('ruleName').value,'等待完成');assert.equal(writes(pending).length,0);assert.ok(id);
});

test('legacy profile-only DTO stays unavailable; new nature buckets include unknown/partial labels and individual bars exclude unknown', async t => {
  for(const missing of [undefined,null]) {
    const unavailable=dto(),part=unavailable.archetypes.teams[0].components[0];part.natureSamples=missing;part.natureConfigurations=missing;part.individualChoices=missing;
    const r=await mount(t,{stats:unavailable});clickRow(r,'balance');const body=modalBody(r),lines=nodes(r,'br-individual-line');
    assert.equal(r.all(body).some(n=>n.tagName==='table'),false);assert.match(body.textContent,/暂无性格配置样本/);assert.equal(lines.length,6);assert.ok(lines.every(n=>n.dataset.available==='false'&&n.textContent.includes('未探明')));assert.doesNotMatch(body.textContent,/60：2|正性格：2|已知 0|0\.0%/);
  }
  const stats=freeze(dto()),before=JSON.stringify(stats),r=await mount(t,{stats});clickRow(r,'balance');const nature=nodes(r,'br-member-nature')[0],lines=nodes(r,'br-individual-line');
  assert.match(nature.textContent,/生命正性格 · 其余未探明 · 1 个 · 25\.0%.*未探明 · 3 个 · 75\.0%/);assert.equal(r.all(nature).filter(n=>n.tagName==='svg').length,1);
  assert.deepEqual(Array.from(lines,n=>n.dataset.attribute),['hp','attack','magicAttack','defense','magicDefense','speed']);
  const hp=lines[0];assert.equal(hp.dataset.available,'true');assert.equal(hp.getAttribute('role'),'meter');assert.match(hp.textContent,/66\.7%/);assert.match(hp.title,/2 \/ 3.*确认未选 1.*未知 1（不参与分母）/);
  assert.ok(r.all(hp).some(n=>n.className==='detail-stat-track'));assert.equal(r.all(hp).find(n=>n.className==='detail-stat-fill').style.getPropertyValue('width'),`${2/3*100}%`);assert.equal(lines.slice(1).every(n=>n.textContent.includes('未探明')),true);assert.equal(JSON.stringify(stats),before);
});

test('synthetic Other filter applies shared queries, survives rule option rebuilds and is never persisted', async t => {
  const r=await mount(t),select=r.named('teamRuleId');
  assert.equal(options(r).filter(option=>option.value==='__other__').length,1);assert.equal(options(r).find(option=>option.value==='__other__').textContent,'其他');
  select.value='__other__';r.submit(r.find(node=>node.tagName==='form'&&node.getAttribute('aria-label')==='对战记录共享筛选'));await tick();
  for(const call of r.calls.filter(call=>/\/(list|stats)\?/.test(call.url)).slice(-2))assert.equal(new URL(call.url,'http://test').searchParams.get('teamRuleId'),'__other__');
  openRules(r);stage(r,'真实用户规则',[35]);r.btn('保存规则').click();await tick();
  assert.equal(select.value,'__other__');assert.equal(options(r).filter(option=>option.value==='__other__').length,1);assert.equal(options(r).find(option=>option.value==='__other__').textContent,'其他');
  const payload=JSON.parse(writes(r)[0].options.body);assert.equal(payload.rules.length,1);assert.notEqual(payload.rules[0].id,'__other__');
  r.btn('关闭').click();r.page.onLeave();r.page.render(r.host);await tick();assert.equal(r.named('teamRuleId').value,'__other__');assert.equal(writes(r).length,1);
});

test('concurrent server additions cannot be erased by reload plus ordinary Save; explicit adopt preserves server order', async t => {
  const a={id:'a',name:'服务器原A',monsterIds:[35],excludedMonsterIds:[]},b={id:'b',name:'并发新增B',monsterIds:[42],excludedMonsterIds:[8]};
  const storage=server([a]),r=await mount(t,{handle:(...args)=>storage.handle(...args)});openRules(r);buttons(r,'编辑规则',rules(r)[0])[0].click();stage(r,'本地修改A',[],[]);
  storage.saved.push(b);storage.bump();r.btn('保存规则').click();await tick();assert.match(modal(r).textContent,/版本冲突/);
  r.btn('重新读取规则版本（保留草稿）').click();await tick();const writesBefore=writes(r).length;
  const conflict=nodes(r,'br-rule-conflict')[0];assert.match(conflict.textContent,/最新服务器规则.*服务器原A.*并发新增B/);assert.match(rules(r)[0].textContent,/本地修改A/);
  assert.equal(r.btn('保存规则').disabled,true);r.btn('保存规则').click();await tick();assert.equal(writes(r).length,writesBefore);assert.deepEqual(storage.saved.map(rule=>rule.id),['a','b']);
  r.btn('关闭').click();openRules(r);assert.equal(r.btn('保存规则').disabled,true);assert.match(nodes(r,'br-rule-conflict')[0].textContent,/并发新增B/);
  r.btn('采用服务器版本（放弃本地草稿）').click();assert.equal(writes(r).length,writesBefore);assert.match(modal(r).textContent,/确认放弃全部本地未保存编辑、增删和排序/);assert.match(rules(r)[0].textContent,/本地修改A/);
  r.btn('确认放弃本地草稿，采用服务器版本').click();assert.deepEqual(Array.from(rules(r),node=>node.dataset.ruleId),['a','b']);assert.equal(r.named('ruleName').value,'服务器原A');assert.equal(writes(r).length,writesBefore);
  r.btn('保存规则').click();await tick();assert.deepEqual(storage.saved.map(rule=>rule.id),['a','b']);assert.equal(JSON.parse(writes(r).at(-1).options.body).baseRevision,'rev-1x');
});

test('explicit full replacement warns about concurrent deletions/order, rechecks draft and remote versions, and stays tracked on close', async t => {
  const a={id:'a',name:'旧A',monsterIds:[35],excludedMonsterIds:[]},b={id:'b',name:'远端新增B',monsterIds:[42],excludedMonsterIds:[]};
  const storage=server([a]),r=await mount(t,{handle:(...args)=>storage.handle(...args)});openRules(r);buttons(r,'编辑规则',rules(r)[0])[0].click();stage(r,'本地A',[],[]);
  storage.saved.unshift(b);storage.bump();r.btn('保存规则').click();await tick();r.btn('重新读取规则版本（保留草稿）').click();await tick();
  r.btn('核对用本地草稿整体替换').click();assert.match(modal(r).textContent,/将删除的服务器规则：远端新增B/);assert.match(modal(r).textContent,/显示顺序/);const firstConfirmation=r.btn('确认整体替换，并保存'),before=writes(r).length;
  r.named('ruleName').value='再次修改A';r.named('ruleName').emit('input');firstConfirmation.click();assert.equal(writes(r).length,before);assert.match(modal(r).textContent,/草稿已变化/);
  r.btn('核对用本地草稿整体替换').click();storage.bump();r.btn('确认整体替换，并保存').click();await tick();assert.deepEqual(storage.saved.map(rule=>rule.id),['b','a']);assert.match(modal(r).textContent,/版本冲突/);
  r.btn('重新读取规则版本（保留草稿）').click();await tick();r.btn('核对用本地草稿整体替换').click();const pending=[];storage.wait=pending;r.btn('确认整体替换，并保存').click();await tick();assert.equal(writes(r).at(-1).options.signal,undefined);assert.equal(JSON.parse(writes(r).at(-1).options.body).baseRevision,'rev-1xx');
  r.btn('关闭').click();pending[0]();await tick();assert.deepEqual(storage.saved.map(rule=>rule.id),['a']);assert.equal(storage.saved[0].name,'再次修改A');assert.equal(r.tracked.length,writes(r).length);
});

test('remote display-order changes never rebase a local reorder without conflict resolution', async t => {
  const originals=[{id:'a',name:'A',monsterIds:[35],excludedMonsterIds:[]},{id:'b',name:'B',monsterIds:[42],excludedMonsterIds:[]},{id:'c',name:'C',monsterIds:[8],excludedMonsterIds:[]}];
  const storage=server(originals),r=await mount(t,{handle:(...args)=>storage.handle(...args)});openRules(r);buttons(r,'上移',rules(r)[2])[0].click();
  storage.saved.reverse();storage.bump();r.btn('保存规则').click();await tick();r.btn('重新读取规则版本（保留草稿）').click();await tick();
  assert.deepEqual(Array.from(rules(r),node=>node.dataset.ruleId),['a','c','b']);assert.equal(r.btn('保存规则').disabled,true);const before=writes(r).length;r.btn('保存规则').click();assert.equal(writes(r).length,before);assert.deepEqual(storage.saved.map(rule=>rule.id),['c','b','a']);
  const rows=nodes(r,'br-rule-conflict')[0].querySelector('tbody').children;assert.deepEqual(Array.from(rows,node=>node.children[1].textContent),['C','B','A']);
});

test('whole rule edits preserve original ID; normalized required/alternative groups survive save/reopen without family expansion', async t => {
  const original={id:'stable-rule',name:'服务器规则',monsterIds:[35],excludedMonsterIds:[8],anyOf:[[42,501],[777]]};
  const storage=server([original]),r=await mount(t,{handle:(...args)=>storage.handle(...args)});openRules(r);
  assert.equal(r.btn('应用到草稿'),undefined);assert.doesNotMatch(modal(r).textContent,/按列表从上到下匹配第一个体系/);
  const card=rules(r)[0],avatar=r.all(card).find(n=>n.tagName==='img');card.emit('click',{target:avatar});assert.equal(r.named('ruleName').value,'服务器规则');
  r.named('ruleName').value='原ID修改';r.named('ruleName').emit('input');r.selectors[1].opts.onSelect({id:42});
  r.btn('保存规则').click();await tick();assert.equal(storage.saved.length,1);assert.equal(storage.saved[0].id,'stable-rule');assert.deepEqual(storage.saved[0].monsterIds,[35,777,42]);assert.equal(storage.saved[0].anyOf,undefined);assert.deepEqual(storage.saved[0].excludedMonsterIds,[8]);
  r.btn('关闭').click();openRules(r);rules(r)[0].emit('click',{target:rules(r)[0].children[0]});assert.equal(r.named('ruleName').value,'原ID修改');assert.equal(nodes(r,'br-any-group').length,0);
  r.btn('新增规则').click();r.named('ruleName').value='任选规则';r.named('ruleName').emit('input');r.btn('新增任选组').click();const any=r.selectors.at(-1);any.opts.onSelect({id:35});any.opts.onSelect({id:42});
  r.btn('新增任选组').click();any.opts.onSelect({id:501});r.selectors.at(-2).opts.onSelect({id:8});r.btn('保存规则').click();await tick();
  assert.equal(storage.saved.length,2);assert.deepEqual(storage.saved[1].monsterIds,[501]);assert.deepEqual(storage.saved[1].anyOf,[[35,42]]);assert.deepEqual(storage.saved[1].excludedMonsterIds,[8]);assert.notEqual(storage.saved[1].id,'stable-rule');
});

test('growth averages on both sides stay after self departures and before 501 rates, null never becomes zero', async t => {
  const stats=dto();stats.growth={me:[{monsterId:501,trait:{name:'特性',samples:2,unknown:3,total:100,average:1.25},skills:[{skillId:37,name:'均衡技能',unit:'每层+20威力',samples:0,unknown:5,average:null},{skillId:538,name:'双支',branch:'power',samples:2,unknown:0,total:99,average:2.5},{skillId:538,name:'双支',branch:'hits',samples:2,unknown:0,average:0}]}],enemy:[{monsterId:501,trait:{samples:0,unknown:1,average:null},skills:[{skillId:38,name:'雷霆技能',samples:1,unknown:0,average:20}]}]};
  const before=JSON.stringify(stats),r=await mount(t,{stats});
  for(const side of ['me','enemy']){
    const identity=r.all(branch(r,side)).find(n=>n.dataset.performanceMonsterId==='501'),last=identity.parentNode.parentNode.children[4],labels=r.all(last).filter(n=>n.tagName==='dt').map(n=>n.textContent);
    assert.ok(labels.indexOf('自行离场')<labels.indexOf('场均特性触发'));assert.ok(labels.indexOf('场均特性触发')<labels.indexOf('过山车成功率'));
    const values=r.all(last).filter(n=>n.dataset.growthKind);const text=Array.from(values,n=>n.textContent);if(side==='me')assert.match(values[1].title,/每层\+20威力/);
    assert.deepEqual(text,side==='me'?['1.25','—','2.5','0']:['—','20']);buttons(r,'场均',branch(r,side))[0].click();assert.deepEqual(Array.from(values,n=>n.textContent),text);buttons(r,'总计',branch(r,side))[0].click();assert.deepEqual(Array.from(values,n=>n.textContent),text);
  }
  assert.equal(JSON.stringify(stats),before);
});

const defaultRuleFixture=()=>Array.from({length:15},(_,index)=>({id:`builtin-${index+1}`,name:`内置规则${index+1}`,monsterIds:[35],excludedMonsterIds:[8],anyOf:[[42,501]]}));
const withDefaults=(storage,defaults)=>async(url,options)=>{
  const result=await storage.handle(url,options);if(!result?.ok)return result;
  return response({...await result.json(),defaults});
};

test('existing custom rules survive startup; builtin replacement needs confirmation then explicit CAS save in original order',async t=>{
  const defaults=freeze(defaultRuleFixture()),before=JSON.stringify(defaults),custom={id:'saved-custom',name:'已有自定义',monsterIds:[42],excludedMonsterIds:[]};
  const storage=server([custom]),r=await mount(t,{handle:withDefaults(storage,defaults)});openRules(r);
  assert.equal(writes(r).length,0);assert.deepEqual(storage.saved,[custom]);assert.deepEqual(Array.from(rules(r),n=>n.dataset.ruleId),['saved-custom']);
  assert.equal(r.btn('载入内置规则').hidden,false);const calls=r.calls.length;r.btn('载入内置规则').click();
  assert.match(modal(r).textContent,/替换当前草稿，尚未保存/);assert.deepEqual(Array.from(rules(r),n=>n.dataset.ruleId),['saved-custom']);assert.equal(r.calls.length,calls);
  r.btn('确认替换当前草稿').click();assert.deepEqual(Array.from(rules(r),n=>n.dataset.ruleId),defaults.map(rule=>rule.id));assert.equal(r.named('ruleName').value,defaults[0].name);assert.equal(writes(r).length,0);assert.deepEqual(storage.saved,[custom]);
  assert.deepEqual(options(r).map(n=>n.value),['','saved-custom','__other__'],'unsaved defaults never change applied filter options');
  r.btn('关闭').click();openRules(r);assert.equal(rules(r).length,15);r.btn('保存规则').click();await tick();assert.equal(writes(r).length,1);
  const payload=JSON.parse(writes(r)[0].options.body);assert.equal(payload.baseRevision,'rev-1');assert.deepEqual(payload.rules,defaults);assert.deepEqual(storage.saved,defaults);assert.equal(JSON.stringify(defaults),before);
});

test('builtin confirmation is invalidated by editing, switching, close/reopen and cancellation; old services hide the entry',async t=>{
  for(const operation of ['typing','switch','close','cancel','new']){
    const storage=server([{id:'custom',name:'自定义',monsterIds:[35],excludedMonsterIds:[]}]),r=await mount(t,{handle:withDefaults(storage,freeze(defaultRuleFixture()))});openRules(r);
    r.btn('载入内置规则').click();const stale=r.btn('确认替换当前草稿');assert.ok(stale);
    if(operation==='typing'){r.named('ruleName').value='未保存';r.named('ruleName').emit('input');}
    if(operation==='switch')rules(r)[0].click();
    if(operation==='close'){r.btn('关闭').click();openRules(r);}
    if(operation==='cancel')r.btn('取消载入').click();
    if(operation==='new')r.btn('新增规则').click();
    assert.equal(r.btn('确认替换当前草稿'),undefined);stale.click();assert.deepEqual(Array.from(rules(r),n=>n.dataset.ruleId),['custom'],operation);assert.equal(writes(r).length,0);
  }
  const legacy=await mount(t);openRules(legacy);assert.equal(legacy.btn('载入内置规则').hidden,true);
});

test('loading builtin drafts cannot bypass remote CAS conflict review or cancel an existing write',async t=>{
  const defaults=freeze(defaultRuleFixture()),storage=server([{id:'custom',name:'自定义',monsterIds:[35],excludedMonsterIds:[]}]),r=await mount(t,{handle:withDefaults(storage,defaults)});openRules(r);
  storage.saved.push({id:'remote',name:'并发新增',monsterIds:[42],excludedMonsterIds:[]});storage.bump();
  r.btn('载入内置规则').click();r.btn('确认替换当前草稿').click();r.btn('保存规则').click();await tick();assert.match(modal(r).textContent,/版本冲突/);assert.equal(storage.saved.length,2);
  r.btn('重新读取规则版本（保留草稿）').click();await tick();assert.equal(r.btn('保存规则').disabled,true);
  r.btn('载入内置规则').click();r.btn('确认替换当前草稿').click();assert.equal(r.btn('保存规则').disabled,true);assert.equal(writes(r).length,1);
  r.btn('核对用本地草稿整体替换').click();assert.match(modal(r).textContent,/将删除的服务器规则：自定义；并发新增/);
  const pending=[];storage.wait=pending;r.btn('确认整体替换，并保存').click();await tick();assert.equal(writes(r).length,2);assert.equal(r.btn('载入内置规则').disabled,true);r.btn('载入内置规则').click();assert.equal(r.btn('确认替换当前草稿'),undefined);
  r.btn('关闭').click();pending[0]();await tick();assert.deepEqual(storage.saved,defaults);assert.equal(JSON.parse(writes(r).at(-1).options.body).baseRevision,'rev-1x');assert.equal(r.tracked.length,2);
});

test('component missing denominators and deprecated profile conditional markers cannot manufacture skill or configuration evidence',async t=>{
  for(const total of [undefined,null,0]){
    const stats=dto(),part=stats.archetypes.teams[0].components[0];part.usageTotalCasts=total;part.skillUsage=[{skillId:37,casts:0},{kind:'charge',casts:100},{kind:'stunSkip',casts:100}];part.profile.ivConditionalSamples={hp:1};part.profile.natureConditionalSamples={hp:1};part.individualChoices=[{attribute:'hp',selected:0,unselected:0,samples:0,unknown:4,rate:0}];
    const r=await mount(t,{stats});clickRow(r,'balance');const child=modalBody(r);assert.match(child.textContent,/暂无有效技能执行样本/);assert.doesNotMatch(child.textContent,/0\.0%|聚能|眩晕|联合|按\+10个体前提唯一/);assert.equal(nodes(r,'br-individual-line')[0].dataset.available,'false');
    clickRow(r,'thunder');assert.match(modalBody(r).textContent,/雷霆技能/);assert.doesNotMatch(modalBody(r).textContent,/均衡技能|按\+10个体前提唯一/);
  }
});
