'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {harness,plain}=require('./skill-simulation-fixture.cjs');
test('actual rendered icons: independent persisted counters, restore does not simulate a left click',()=>{
 const h=harness();h.icon(41).fire('contextmenu');h.icon(41).fire('contextmenu');
 assert.equal(h.state.basePower,180);assert.equal(h.state.basePowerExpression,'90+(2*45)');
 assert.equal(h.profile.rk_skill_simulation['1:41'].powerCount,2);
 h.icon(113).fire('contextmenu');assert.equal(h.profile.rk_skill_simulation['1:41'].powerCount,2);
 h.icon(41).fire('contextmenu');assert.equal(h.state.basePower,225);
 const restored=harness({savedProfile:h.profile});restored.page.applySkillMemory(1);
 assert.equal(restored.state.basePowerExpression,'90+(3*45)');restored.icon(41).fire('contextmenu');assert.equal(restored.state.basePower,270);
 restored.state.atkPet={id:202};restored.icon(41).fire('contextmenu');assert.equal(restored.state.basePower,135);
 assert.equal(restored.profile.rk_skill_simulation['1:41'].powerCount,4);assert.equal(restored.profile.rk_skill_simulation['202:41'].powerCount,1);
 restored.icon(41).fire('click');assert.equal(restored.profile.rk_skill_simulation['202:41'].powerCount,0);assert.equal(restored.profile.rk_skill_simulation['1:41'].powerCount,4);
});
test('actual middle event is restricted to button1 and explicit friend/trial; Garl unaffected',()=>{
 const h=harness();h.icon(510).fire('contextmenu');h.icon(510).fire('auxclick',{button:1});assert.equal(h.state.basePower,180);
 h.icon(510).fire('auxclick',{button:1});assert.equal(h.state.basePower,180);
 h.icon(510).fire('contextmenu');assert.equal(h.state.basePower,110);
 h.icon(538).fire('click');h.icon(538).fire('auxclick',{button:1});h.icon(538).fire('contextmenu');assert.equal(h.state.basePower,30);assert.equal(h.state.comboCount,3);
 const before=plain(h.page.skillSnapshot()),writes=h.writes.length;h.icon(538).fire('auxclick',{button:2});assert.deepEqual(plain(h.page.skillSnapshot()),before);assert.equal(h.writes.length,writes);
 h.state.atkPet={id:569};h.icon(510).fire('contextmenu');assert.equal(h.state.basePowerExpression,'110+130');h.icon(538).fire('contextmenu');assert.equal(h.state.basePower,20);assert.equal(h.state.comboCount,2);
});
test('energy/ratio labels and saved inputs remain distinct from derived base power',()=>{
 const h=harness();h.icon(35).fire('click');assert.equal(h.state.skillInputKind,'energy');assert.equal(h.state.skillInputValue,'10');assert.equal(h.state.basePower,211);
 assert.equal(h.document.getElementById('skill-power-input-label').textContent,'当前能量');
 const input=h.document.getElementById('basePower');input.value='6';assert.equal(h.page.readPowerInput(),true);h.page.calculate();h.page.saveSkillConfig(1);assert.equal(h.state.basePower,166);
 const other=harness({savedProfile:h.profile});other.page.applySkillMemory(1);assert.equal(other.document.getElementById('basePower').value,'6');assert.equal(other.state.basePower,166);
 input.value='1,2';assert.equal(h.page.readPowerInput(),false);assert.equal(h.state.basePower,166);
 h.icon(19).fire('click');input.value='77/100';assert.equal(h.page.readPowerInput(),true);h.page.calculate();assert.equal(h.state.basePower,200);assert.equal(h.state.skillInputValue,'77/100');
 h.icon(535).fire('click');assert.equal(h.state.skillInputKind,'power');assert.equal(h.state.skillInputValue,'');assert.equal(h.state.basePower,90);
});
test('percent manual memory survives ordinary defender checks and special defender overlay',()=>{
 const h=harness();h.state.percentBonus=30;h.document.getElementById('percentBonus').value=30;h.page.saveSkillConfig(1);
 h.page.checkJmfzBonus();assert.equal(h.state.percentBonus,30);
 h.state.defPet.id=501;h.RKData.getTypeEff=()=>2; // CalcEngine uses captured destructured mock=1, so special default0 here.
 h.page.checkJmfzBonus();assert.equal(h.state.percentBonus,0);
 h.icon(41).fire('contextmenu');assert.equal(h.profile.rk_damage_skill_configs[1].percentBonus,30,'derived special value never replaces saved manual');
 h.state.defPet.id=9001;h.page.checkJmfzBonus();assert.equal(h.state.percentBonus,30);
 h.page.applySkillMemory(1);h.page.checkJmfzBonus();assert.equal(h.state.percentBonus,30);
});
test('tooltip is source description rather than button instructions; invalid draft never poisons snapshots',()=>{
 const h=harness();h.icon(131).fire('contextmenu');assert.equal(h.state.basePowerExpression,'15*2^(1)');
 assert.match(h.icon(131).attrs.title,/基础威力：15/);assert.doesNotMatch(h.icon(131).attrs.title,/左键|右键/);
 assert.match(h.icon(35).attrs.title,/基础威力：\?/);
 const input=h.document.getElementById('basePower'),before=plain(h.page.skillSnapshot());input.value='2^10000';h.page.calculate();assert.deepEqual(plain(h.page.skillSnapshot()),before);
});
test('trait integration: selection defaults, dynamic attributes and manual persistence priorities',()=>{
 const h=harness();const pets=require('./catalog-read-fixture.cjs').readProjectData('monsters.json'),Trait=require('../js/trait-power-defaults.js');
 h.window.TraitPowerDefaults=Trait;
 h.state.atkPet=pets.find(p=>p.id===203);h.state.percentBonus=17;h.document.getElementById('percentBonus').value=17;
 h.page.applyTraitPowerDefaults(true);assert.equal(h.state.percentBonus,30);
 h.state.percentBonus=11;h.document.getElementById('percentBonus').value=11;h.page.applyTraitPowerDefaults(false);assert.equal(h.state.percentBonus,11,'non-dynamic default does not reapply each skill event');
 h.state.atkPet=pets.find(p=>p.trait?.localized?.zh?.name==='祈愿');
 // Pick an explicit non-Light trait without assuming display-name spelling.
 h.state.atkPet=pets.find(p=>{const a=Trait.resolve(p,'驱赶','武'),b=Trait.resolve(p,'驱赶','光');return a?.value===25&&a.mode==='dynamic'&&b?.value===0;});assert.ok(h.state.atkPet);
 h.state.skillAttr='武';h.page.applyTraitPowerDefaults(true);assert.equal(h.state.percentBonus,25);
 h.state.skillAttr='光';h.page.applyTraitPowerDefaults(false);assert.equal(h.state.percentBonus,0);
 h.state.skillAttr='武';h.page.applyTraitPowerDefaults(false);h.state.defPet.id=501;h.page.checkJmfzBonus();assert.equal(h.state.percentBonus,0,'special defender overlay wins');
 h.state.defPet.id=9001;h.page.checkJmfzBonus();assert.equal(h.state.percentBonus,25,'leaving special defender restores dynamic trait');
});
test('changed source never applies an old fixed-ID increment or writes its counters',()=>{
 const h=harness();h.icon(41).fire('contextmenu');
 const records=plain(h.profile.rk_skill_simulation),snap=plain(h.page.skillSnapshot());
 const oldGet=h.RKData.getMoves;
 h.RKData.getMoves=()=>oldGet().map(m=>m.id===41?{...m,localized:{...m.localized,zh:{...m.localized.zh,description:m.localized.zh.description+'（新机制未审阅）'}}}:m);
 h.page.renderSkillIcons();const writes=h.writes.length;
 h.icon(41).fire('contextmenu');
 assert.deepEqual(plain(h.page.skillSnapshot()),snap);
 assert.deepEqual(plain(h.profile.rk_skill_simulation),records);
 assert.equal(h.writes.length,writes);
 assert.match(h.document.getElementById('skill-variant-notice').title,/未审阅/);
});
test('partial HP ratio draft 77/ preserves last valid value in active and per-pet saves',()=>{
 const h=harness();h.icon(19).fire('click');const input=h.document.getElementById('basePower');
 input.value='77/100';h.page.calculate();h.page.saveSkillConfig(1);
 input.value='77/';assert.equal(h.page.readPowerInput(),false);h.page.calculate();
 assert.equal(h.state.basePower,200);assert.equal(h.state.skillInputValue,'77/100');
 // Even a later independent modifier edit serializes state, not the invalid DOM draft.
 h.page.saveSkillConfig(1);
 assert.equal(h.profile.rk_damage_view.skill.basePower,200);
 assert.equal(h.profile.rk_damage_view.skill.skillInputValue,'77/100');
 assert.equal(h.profile.rk_damage_skill_configs[1].skillInputValue,'77/100');
});
