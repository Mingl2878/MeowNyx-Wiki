'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const file=process.env.BGS_ACTUAL_UI_FIXTURE;
test('latest actual fixture joins default wolf, observed usage, conditional HP and unknown growth without writes',{skip:!file},async t=>{
 const raw=fs.readFileSync(file,'utf8'),p=JSON.parse(raw),before=JSON.stringify(p),hp=path.join(__dirname,'battle-records-ui.test.js'),text=fs.readFileSync(hp,'utf8');
 const box={module:{exports:{}},require:createRequire(hp),__dirname,console,AbortController,URLSearchParams,setImmediate};vm.runInNewContext(text.slice(0,text.indexOf('\ntest('))+'\nmodule.exports=runtime;',box,{filename:hp});
 const data=require('../scripts/lib/catalog-data.js').readLegacy(path.join(__dirname,'..'));
 const r=box.module.exports({stats:p.stats,record:p.record,data:{getMonsters:()=>data.monsters,getMonsterById:id=>data.monsters.find(x=>x.id===id),getMonsterDisplayName:x=>x.localized.zh.name,getMoves:()=>data.moves,getMoveName:x=>x.localized.zh.name,getTypes:()=>data.types,getTypeObjZh:x=>x.localized.zh},handle:async(url,options)=>{
  if(options.method&&options.method!=='GET')throw Error('read-only actual verification must not write');
  if(url.includes('/rules'))return{ok:true,json:async()=>({rules:p.rules,revision:p.revision,defaults:p.rules})};
 }});t.after(()=>r.page.onLeave());await new Promise(resolve=>setImmediate(resolve));
 const cls=(name,host)=>r.all(host).filter(n=>(n.getAttribute('class')||n.className||'').split(' ').includes(name));
 assert.ok(r.btn('时间范围'));assert.doesNotMatch(r.host.textContent,/筛选记录和统计/);r.btn('样本统计').click();await new Promise(resolve=>setImmediate(resolve));
 const own=r.find(n=>n.dataset.brStats==='me'),enemy=r.find(n=>n.dataset.brStats==='enemy');
 const shark=r.all(own).find(n=>n.dataset.performanceMonsterId==='202');assert.ok(shark);const sharkRow=shark.parentNode.parentNode;
 assert.match(sharkRow.children[4].textContent,/场均特性触发/);assert.match(sharkRow.children[4].textContent,/—/);
 cls('br-lineup-select',own)[0].click();const lineupModal=r.find(n=>n.dataset.modalKind==='own-lineup');assert.ok(lineupModal);assert.match(cls('br-own-matchups',lineupModal)[0].textContent,/狼王/);r.root.document.emit('keydown',{key:'Escape'});
 r.btn('敌方样本统计').click();assert.match(cls('br-environment-rate',enemy).find(n=>n.dataset.archetypeId==='wolf').textContent,/狼王.*100\.0%/);assert.equal(cls('br-environment-legend',enemy).length,0);
 const wolf=r.all(enemy).find(n=>n.tagName==='tr'&&n.dataset.archetypeId==='wolf');assert.ok(wolf);wolf.click();
 const memberModal=r.find(n=>n.dataset.modalKind==='archetype');assert.ok(memberModal);const components=cls('br-archetype-component',memberModal);assert.equal(components.length,6);assert.equal(cls('br-archetype-component',enemy).length,0);
 for(const node of components){assert.match(node.textContent,/技能使用率/);assert.doesNotMatch(node.textContent,/初始技能携带|生命个体.*联合分布|\+10/);assert.match(node.textContent,/暂无性格配置样本/);const lines=cls('br-individual-line',node);assert.equal(lines.length,6);assert.ok(lines.every(n=>n.dataset.available==='false'&&n.textContent.includes('未探明')));}
 const team=p.stats.archetypes.teams.find(x=>x.id==='wolf');assert.equal(team.components.reduce((n,x)=>n+x.usageTotalCasts,0),13);
 for(const c of team.components){assert.equal(c.profile.ivConditionalSamples.hp,1);assert.equal(c.profile.natureConditionalSamples.hp,1);assert.equal(Object.values(c.profile.ivDistributions.hp).reduce((n,x)=>n+x,0),1);assert.equal(Object.values(c.profile.natureDistributions.hp).reduce((n,x)=>n+x,0),1);const node=components.find(n=>n.dataset.componentMonsterId===String(c.monsterId));assert.ok(node);for(const s of c.skillUsage){if(s.skillId){const skill=data.moves.find(x=>x.id===s.skillId);assert.ok(skill);assert.ok(node.textContent.includes(skill.localized.zh.name));}assert.ok(node.textContent.includes((s.casts/c.usageTotalCasts*100).toFixed(1)+'%'));}}
 r.root.document.emit('keydown',{key:'Escape'});r.btn('阵容规则').click();const rules=r.find(n=>n.dataset.modalKind==='rules');assert.ok(rules);assert.ok(r.btn('载入内置规则'));assert.equal(r.btn('应用到草稿'),undefined);assert.doesNotMatch(rules.textContent,/按列表从上到下匹配第一个体系/);r.root.document.emit('keydown',{key:'Escape'});
 r.btn('对战列表').click();r.btn('查看详情').click();await new Promise(resolve=>setImmediate(resolve));
 const detail=r.find(n=>n.dataset.modalKind==='detail');assert.ok(detail);const imgs=r.all(detail).filter(n=>n.tagName==='img').map(n=>n.src||n.getAttribute('src'));
 assert.ok(imgs.some(src=>src&&src.includes('assets/system-actions/charge.webp')),'actual charge icon missing');
 assert.equal(r.calls.some(c=>c.options.method&&c.options.method!=='GET'),false);assert.equal(JSON.stringify(p),before);assert.equal(fs.readFileSync(file,'utf8'),raw);
});
