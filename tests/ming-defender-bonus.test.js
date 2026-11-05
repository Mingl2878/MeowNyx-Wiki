'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {harness,plain}=require('./skill-simulation-fixture.cjs');
const monsters=require('./catalog-read-fixture.cjs').readProjectData('monsters.json');
function setup(profile){
  const h=harness({savedProfile:profile}),dummy=h.state.defPet;
  h.RKData.getMonsterById=id=>Number(id)===9001?dummy:monsters.find(m=>m.id===Number(id));
  h.RKData.getMonsters=()=>monsters;
  h.RKData.getLeaderBase=p=>monsters.find(m=>m.id===p?.leader_of_id&&!m.is_leader_form)||null;
  h.RKData.getMonsterDisplayName=p=>p.localized?.zh?.name||p.name||'Fixture';
  h.RKData.typeBadgeHtml=t=>`<span>${t}</span>`;
  for(const side of ['attacker','defender']){
    h.document.getElementById(side+'Types').insertAdjacentHTML=function(_,html){this.innerHTML+=html;};
    h.page.searchBoxes[side]={input:h.document.createElement(),setValue(){},destroy(){}};
  }
  const get=h.document.getElementById.bind(h.document);
  h.document.getElementById=id=>id==='battle-snapshot-panel'?null:get(id);
  h.page.bindEvents();
  h.choose=(side,id)=>h.page.selectPet(side,h.RKData.getMonsterById(id),null,'history');
  h.input=(id,value)=>{const el=h.document.getElementById(id);el.value=String(value);el.fire('input');};
  h.level=async value=>{assert.equal(await h.page.CalcEngine.setLevelPreference('defender',{manual:String(value)}),true);};
  h.choose('attacker',1);
  return h;
}

test('Mingulong threshold is strictly below80 and follows live defender level',async()=>{
  const h=setup();h.input('percentBonus',11);h.choose('defender',619);
  for(const level of [99,89,80,79,69,1,79,80,89,99]){
    await h.level(level);
    const expected=level<80?40:11;
    assert.equal(h.state.percentBonus,expected,`Lv${level}`);
    assert.equal(Number(h.document.getElementById('percentBonus').value),expected);
    assert.equal(h.page.CalcEngine.calculate().percentBonus,expected);
    assert.equal(h.profile.rk_damage_skill_configs[1].percentBonus,11);
  }
});

test('slider and step controls update percentage without reselection; only real619 is affected',async()=>{
  const h=setup();h.input('percentBonus',7);h.choose('defender',619);
  assert.ok(await h.page.CalcEngine.setLevelPreference('defender',{slider:89}));
  assert.equal(h.state.percentBonus,7);
  assert.ok(await h.page.CalcEngine.stepLevelPreference('defender',-1));
  assert.equal(h.page.CalcEngine.effectiveLevel('defender'),79);assert.equal(h.state.percentBonus,40);
  assert.ok(await h.page.CalcEngine.stepLevelPreference('defender',1));
  assert.equal(h.state.percentBonus,7);
  const unrelated={...h.RKData.getMonsterById(619),id:900099,name:'notMing',default_level:79};
  h.page.selectPet('defender',unrelated,null,'history');
  await h.level(79);assert.equal(h.state.percentBonus,7);
});

test('target change removes only auto40, skills retain it, and manual final power remains independent',async()=>{
  const h=setup();h.input('percentBonus',17);h.input('buff',23);h.input('fixedBonus',9);h.input('finalPowerManual','123');
  h.choose('defender',619);await h.level(79);assert.equal(h.state.percentBonus,40);
  h.icon(41).fire('click');h.icon(535).fire('click');
  assert.equal(h.state.percentBonus,40);assert.equal(h.state.buff,23);assert.equal(h.state.fixedBonus,9);
  assert.equal(h.state.finalPowerManual,'123');assert.equal(h.page.CalcEngine.calculate().skillFinalPower,123);
  assert.equal(h.profile.rk_damage_skill_configs[1].percentBonus,17);
  h.choose('defender',9001);assert.equal(h.state.percentBonus,17);
  h.choose('defender',619);assert.equal(h.state.percentBonus,40);
  h.page.restoreFromState();assert.equal(h.state.percentBonus,40);
});

test('active and per-pet snapshots never bake the low-level target into startup or another attacker',async()=>{
  const h=setup();h.input('percentBonus',12);h.choose('defender',619);await h.level(79);h.icon(41).fire('click');
  assert.equal(h.state.percentBonus,40);
  assert.equal(h.page.skillSnapshot().percentBonus,12);
  assert.equal(h.profile.rk_damage_view.skill.percentBonus,12);
  assert.equal(h.profile.rk_damage_skill_configs[1].percentBonus,12);
  const restarted=setup(plain(h.profile));restarted.page.initDefaultPets();
  assert.equal(restarted.state.defPet.id,9001);assert.equal(restarted.state.percentBonus,12);
  restarted.choose('defender',619);assert.equal(restarted.state.percentBonus,40);
  restarted.choose('attacker',13);assert.equal(restarted.state.percentBonus,40);
  restarted.choose('defender',9001);assert.equal(restarted.state.percentBonus,0,'new attacker uses own manual value');
});

test('attacker trait defaults and JMFZ override retain original priority and manual memory',async()=>{
  const h=setup();h.window.TraitPowerDefaults=require('../js/trait-power-defaults.js');
  h.profile.rk_damage_skill_configs[203]={percentBonus:9};h.choose('attacker',203);
  assert.equal(h.state.percentBonus,30);
  h.choose('defender',619);await h.level(79);assert.equal(h.state.percentBonus,40);
  h.choose('defender',501);assert.equal(h.state.percentBonus,0,'existing fixture target effectiveness is1');
  h.choose('defender',619);assert.equal(h.state.percentBonus,40);
  h.choose('defender',9001);assert.equal(h.state.percentBonus,30,'restore approved attacker default, not forced0');
  assert.equal(h.profile.rk_damage_skill_configs[203].percentBonus,9);
});

test('manual replacement remains manual; next level event reapplies40 without adding or erasing it',async()=>{
  const h=setup();h.input('percentBonus',5);h.choose('defender',619);await h.level(79);
  h.input('percentBonus',19);assert.equal(h.state.percentBonus,19);
  await h.level(69);assert.equal(h.state.percentBonus,40);
  h.icon(41).fire('click');assert.equal(h.profile.rk_damage_skill_configs[1].percentBonus,19);
  await h.level(89);assert.equal(h.state.percentBonus,19);
});

test('skill reset while low-level target is present reapplies40 without saving it as a manual value',async()=>{
  const h=setup();h.input('percentBonus',5);h.choose('defender',619);await h.level(79);
  h.document.getElementById('resetSkillSettingsBtn').fire('click');
  assert.equal(h.state.percentBonus,40);
  assert.equal(h.profile.rk_damage_skill_configs[1].percentBonus,5,'automatic setter preserves explicitly remembered manual field');
  h.choose('defender',9001);assert.equal(h.state.percentBonus,5);
});

test('fire god attack growth and low-level Ming target percentage remain separate',async()=>{
  const h=setup();h.choose('attacker',14);h.choose('defender',619);await h.level(79);
  h.icon(113).fire('click');h.icon(113).fire('contextmenu');
  assert.equal(h.state.buff,30);assert.equal(h.state.percentBonus,40);
  h.icon(113).fire('contextmenu');assert.equal(h.state.buff,60);assert.equal(h.state.percentBonus,40);
  h.icon(535).fire('click');assert.equal(h.state.buff,60);assert.equal(h.state.percentBonus,40);
  await h.level(89);assert.equal(h.state.buff,60);assert.equal(h.state.percentBonus,0);
});

test('battle target uses snapshot level and restores prior manual percentages without personal writes',async()=>{
  const h=setup();h.input('percentBonus',11);
  const profile=plain(h.profile),record={sides:{enemy:{pets:[{instanceId:'ming',monsterId:619}]}}};
  h.window.BattleRecordsClient={getRecord:()=>record,getRevision:()=>1,snapshotValues:()=>({iv:{},nature:{},level:79})};
  assert.ok(h.page.CalcEngine.applyBattlePet('defender','enemy','ming'));
  assert.equal(h.page.CalcEngine.effectiveLevel('defender'),79);assert.equal(h.state.percentBonus,40);
  await h.level(80);assert.equal(h.state.percentBonus,11);
  await h.level(79);assert.equal(h.state.percentBonus,40);h.icon(41).fire('click');
  assert.deepEqual(plain(h.profile),profile);
  h.page.CalcEngine.endBattleSimulation();assert.equal(h.state.percentBonus,11);
  assert.deepEqual(plain(h.profile),profile);
});
