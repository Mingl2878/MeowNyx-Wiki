'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {harness,plain}=require('./skill-simulation-fixture.cjs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/pages/damage.js'),'utf8');
test('retired skill usage sort and cache access are deleted, not bypassed or commented',()=>{
 assert.doesNotMatch(source,/skillUsageOrder|sortByUsage|saveSkillUsageOrder|rk_skill_usage_order/);
 assert.match(source,/baseSkills\.map\(buildSkillIconHtml\)/);assert.match(source,/bloodlineSkills\.map\(buildSkillIconHtml\)/);
});
test('all source-group node positions survive left/right/middle skill transactions',()=>{
 const h=harness();h.storage.set('rk_skill_usage_order','["魔能爆","迫近攻击","试飞"]');
 const original=h.groups.map(g=>({group:g,children:g.children.slice()}));
 for(const [id,event,extra]of [[41,'click',{}],[41,'contextmenu',{}],[35,'click',{}],[35,'contextmenu',{}],[538,'click',{}],[538,'contextmenu',{}],[538,'auxclick',{button:1}],[510,'click',{}],[510,'contextmenu',{}],[510,'auxclick',{button:1}],[420,'contextmenu',{}]]){
  h.icon(id).fire(event,extra);for(const row of original)assert.deepEqual(row.group.children,row.children,`ordering changed for ${id}`);
 }
 assert.equal(h.storage.get('rk_skill_usage_order'),'["魔能爆","迫近攻击","试飞"]');
 assert.equal(h.profile.rk_skill_simulation['1:41'].powerCount,1);
 assert.equal(h.profile.rk_skill_simulation['1:538'].powerCount,1);assert.equal(h.profile.rk_skill_simulation['1:538'].comboCount,1);
 const order=original.map(g=>g.children.map(i=>i.dataset.skillName));h.page.renderSkillIcons();assert.deepEqual(h.groups.map(g=>g.children.map(i=>i.dataset.skillName)),order);
});
test('reduction values keep original meaning, expression support and profile source separate',()=>{
 const h=harness();for(const p of [50,60,70,80,90])assert.ok(Math.abs(h.page.CalcEngine.parseDebuffPercent(String(p))-(100-p)/100)<1e-12);
 assert.equal(h.page.CalcEngine.parseDebuffPercent('50+10'),.4);assert.equal(h.page.CalcEngine.parseDebuffPercent('0'),1);
 assert.match(source,/const choices = \[50, 60, 70, 80, 90\]/);assert.match(source,/new Event\('input', \{ bubbles: true \}\)/);
 assert.match(source,/CommonUI\.bindAnchoredLayer\(input, layer/);assert.match(source,/CommonUI\.registerCleanup\?\.\(input/);
 assert.match(source,/if \(!layer\.isConnected \|\| !input\.isConnected\) return/);
});
