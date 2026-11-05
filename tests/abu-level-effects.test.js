'use strict';
// Production DamagePage closures, skill icons, radios and level controls; memory-only
// profiles; prefer committed623, with an explicit fixture for isolated pre-data staging.
const test = require('node:test'), assert = require('node:assert/strict');
const { harness, plain } = require('./skill-simulation-fixture.cjs');
const BattleMath = require('../js/battle-math'), PetLevels = require('../js/pet-levels');
const catalog = require('./catalog-read-fixture.cjs').readProjectData('monsters.json');
const DESCRIPTION = '己方精灵每使用1次能耗为3的技能，自己入场前等级+2。在战斗中每提升1级，获得物攻+5%，低于80级时受到伤害+30%。';
const S5_DESCRIPTION = '在战斗中每提升1级，获得物攻+5%，低于80级时受到伤害+30%。';
const abu = { id:623, name:'SuperAbu', localized:{zh:{name:'超能阿布'}}, main_type:{id:8,name:'Dragon'},
  trait:{localized:{zh:{name:'圣龙的守护',description:DESCRIPTION}}}, base_hp:126,base_phy_atk:122,base_phy_def:80,base_mag_atk:45,base_mag_def:100,base_spd:105,
  default_level:60,level_min:60,level_max:99,level_step:2,is_leader_form:true,evolution_members:[623] };
const keys = {hp:'base_hp',attack:'base_phy_atk',defense:'base_phy_def',magic_attack:'base_mag_atk',magic_defense:'base_mag_def',speed:'base_spd'};
function setup(savedProfile, dataOverride = {}) {
  const monsters = plain(catalog.some(p=>p.id===623) ? catalog : [...catalog,abu]);
  const dummy={id:9001,name:'Dummy',main_type:{name:'Normal'},...Object.fromEntries(Object.values(keys).map(k=>[k,100]))};
  const byId=id=>Number(id)===9001?dummy:monsters.find(p=>p.id===Number(id));
  const base=(p,s)=>p?.[keys[s]]||100;
  const h=harness({savedProfile,data:{getMonsters:()=>monsters,getMonsterById:byId,getBaseStat:base,
    getPetStat:(p,s,n,iv,l)=>BattleMath.statFromBase(base(p,s),s,n,iv,l),getMonsterDisplayName:p=>p.localized?.zh?.name||p.name||'Fixture',
    getLeaderBase:p=>byId(p?.leader_of_id)||null,typeBadgeHtml:t=>`<span>${t}</span>`,...dataOverride}});
  h.monsters=monsters; h.state.defPet=dummy;
  for(const side of ['attacker','defender']) {
    h.document.getElementById(side+'Types').insertAdjacentHTML=function(_,html){this.innerHTML+=html;};
    h.page.searchBoxes[side]={input:h.document.createElement(),setValue(){},destroy(){}};
    for(const suffix of ['level-mode','level-controls','level-slider']) h.document.getElementById(side+'-'+suffix).isConnected=true;
  }
  const get=h.document.getElementById.bind(h.document);
  h.document.getElementById=id=>id==='battle-snapshot-panel'?null:get(id);
  const radios=['attack','magic_attack'].map(value=>Object.assign(h.document.createElement(),{value}));
  const query=h.document.querySelectorAll.bind(h.document);
  h.document.querySelectorAll=selector=>selector==='input[name="skillType"]'?radios:query(selector);
  h.page.bindEvents();
  h.choose=(side,id)=>h.page.selectPet(side,byId(id),null,'history');
  h.input=(id,value)=>{const el=get(id);el.value=String(value);el.fire('input');};
  h.radio=type=>radios.find(r=>r.value===type).fire('change');
  h.mode=(side,mode)=>h.page.CalcEngine.setWolfMode(side,mode);
  h.level=(side,value)=>h.page.CalcEngine.setLevelPreference(side,{slider:value});
  h.manualLevel=(side,value)=>h.page.CalcEngine.setLevelPreference(side,{manual:String(value)});
  h.control=(side,suffix)=>get(side+'-level-'+suffix);
  if (!savedProfile) h.choose('attacker',623);
  return h;
}
const savedBuff=h=>h.profile.rk_damage_skill_configs?.[h.state.atkPet.id]?.buff;
const savedOverride=h=>h.profile.rk_damage_skill_configs?.[623]?.abuBuffOverridden;
const snapshot=h=>plain(h.page.skillSnapshot());

for(const id of [623,595,616,617]) test(`attacker${id}: physical-only exact level growth, magic removes only own part`,async()=>{
  const h=setup();h.choose('attacker',id);h.input('buff',-20);h.input('percentBonus',7);
  if(id!==623) assert.ok(h.mode('attacker','abu'));
  const original=plain(h.RKData.getMonsterById(id));
  for(const level of [60,62,78,80,99,80,62,60]) {
    assert.ok(await h.level('attacker',level)); const bonus=(level-60)*5;
    h.icon(244).fire('click');
    assert.equal(h.state.skillType,'attack');assert.equal(h.state.buff,-20+bonus,`physical lv${level}`);
    assert.equal(Number(h.document.getElementById('buff').value),-20+bonus);
    assert.equal(h.state.percentBonus,7);assert.equal(savedBuff(h),-20);
    const result=h.page.CalcEngine.calculate(); assert.equal(result.buffPercent,-20+bonus);
    assert.equal(result.atkStat,BattleMath.statFromBase(original.base_phy_atk,'attack',h.state.atkNature.attack||0,!!h.state.atkIV.attack,level));
    h.icon(535).fire('click');assert.equal(h.state.skillType,'magic_attack');assert.equal(h.state.buff,-20);
    assert.equal(h.page.CalcEngine.calculate().buffPercent,-20);assert.equal(savedBuff(h),-20);
    h.radio('attack');assert.equal(h.state.buff,-20+bonus);
    h.radio('magic_attack');assert.equal(h.state.buff,-20);h.icon(245).fire('click');assert.equal(h.state.buff,-20+bonus);
    for(let n=0;n<3;n++){h.page.calculate();h.page.restoreFromState();assert.equal(h.state.buff,-20+bonus);}
  }
  assert.deepEqual(plain(h.RKData.getMonsterById(id)),original,'stats/types/trait/skills stay original');
  assert.equal(h.profile.rk_damage_view.skill.abuBuffOverridden,undefined);
  if(id!==623){assert.equal(h.profile.rk_damage_skill_configs[id].abuBuffOverridden,undefined);assert.equal(h.profile.rk_damage_levels?.[id],undefined);}
});

test('committed factory623 through real RKData retains its full own learning list, original244/245 and exact native effects',async()=>{
  const RKData=await require('./damage-levels-ui-fixture.cjs').realData(),pet=RKData.getMonsterById(623);
  assert.ok(pet,'committed factory must include623');assert.equal(pet.trait.localized.zh.name,'圣龙的守护');assert.equal(pet.trait.localized.zh.description,S5_DESCRIPTION);
  assert.deepEqual(Object.values(keys).map(key=>pet[key]),[126,105,122,45,80,100]);
  assert.equal(pet.learnset_mode,'own');assert.deepEqual([pet.default_level,pet.level_min,pet.level_max,pet.level_step],[60,60,99,2]);
  const original=plain(pet),skills=plain(RKData.getResolvedWikiData(pet).skills);
  for(const id of [244,245]){const move=RKData.getMoves().find(m=>m.id===id);assert.ok(skills.some(s=>s.name===RKData.getMoveName(move)&&s.type==='物攻'),`original skill${id} remains present`);}
  const h=setup(undefined,RKData),attacks=skills.filter(s=>s.type==='物攻'||s.type==='魔攻');
  assert.deepEqual(h.grid.children.map(i=>i.dataset.skillName),attacks.filter(s=>s.source!=='血脉').concat(attacks.filter(s=>s.source==='血脉')).map(s=>s.name));
  h.choose('defender',623);
  for(const level of [60,62,78,80,99]){
    await h.level('attacker',level);await h.level('defender',level);
    for(const id of [244,245]){
      h.icon(id).fire('click');assert.equal(h.state.buff,(level-60)*5);assert.equal(h.state.percentBonus,level<80?30:0);
      assert.equal(h.page.CalcEngine.calculate().buffPercent,(level-60)*5);assert.equal(savedBuff(h),0);
    }
    h.radio('magic_attack');assert.equal(h.state.buff,0);h.radio('attack');assert.equal(h.state.buff,(level-60)*5);
  }
  assert.deepEqual(plain(RKData.getMonsterById(623)),original);assert.deepEqual(plain(RKData.getResolvedWikiData(pet).skills),skills);
});

test('native explicit metadata preserves60..99 grid; real slider and adjacent controls drive BUFF',()=>{
  const h=setup();
  assert.equal(PetLevels.traitHasLevel(h.state.atkPet),false,'split description contains 提升1级, not 等级');
  assert.equal(PetLevels.config({...h.state.atkPet,level_configurable:undefined}).enabled,false,'generic detection is not broadened');
  assert.ok(PetLevels.config(h.state.atkPet).enabled,'original explicit level controls stay enabled');
  assert.ok(PetLevels.config({...abu,level_configurable:undefined}).enabled,'old merged 等级 text keeps generic detection');
  assert.equal(h.control('attacker','controls').hidden,false);
  const slider=h.control('attacker','slider');slider.value='1';slider.fire('input');
  assert.equal(h.page.CalcEngine.effectiveLevel('attacker'),62);assert.equal(h.state.buff,10);
  h.control('attacker','increase').fire('click');assert.equal(h.state.buff,20);
  h.control('attacker','decrease').fire('click');assert.equal(h.state.buff,10);
  slider.fire('keydown',{key:'End'});assert.equal(h.state.buff,195);assert.equal(h.control('attacker','increase').disabled,true);
  slider.fire('keydown',{key:'Home'});assert.equal(h.state.buff,0);assert.equal(h.control('attacker','decrease').disabled,true);
});

for(const manual of [0,-20,17.5,'',' \t\n ']) test(`native literal takeover ${JSON.stringify(manual)} persists across skills/species/navigation/restart`,async()=>{
  const h=setup();await h.level('attacker',80);assert.equal(h.state.buff,100);
  h.input('buff',manual);const value=Number(manual);assert.equal(h.state.buff,value);assert.equal(savedBuff(h),value);assert.equal(savedOverride(h),true);
  const writes=h.writes.length;h.page.calculate();h.page.calculate();assert.equal(h.writes.length,writes);
  for(const id of [535,244,245]){h.icon(id).fire('click');assert.equal(h.state.buff,value);assert.equal(savedOverride(h),true);}
  h.page.restoreFromState();h.choose('attacker',14);h.choose('attacker',623);assert.equal(h.state.buff,value);
  const source=plain(h.profile),r=setup(source);r.page.initDefaultPets();assert.equal(r.state.buff,value);assert.equal(savedOverride(r),true);
  assert.equal(r.page.CalcEngine.effectiveLevel('attacker'),80);assert.deepEqual(source,plain(h.profile));
  r.radio('magic_attack');assert.equal(r.state.buff,value);r.radio('attack');assert.equal(r.state.buff,value);
  await r.level('attacker',62);assert.equal(r.state.buff,value+10);assert.equal(savedOverride(r),false);assert.equal(savedBuff(r),value);
  const r2=setup(r.profile);r2.page.initDefaultPets();assert.equal(r2.state.buff,value+10);assert.equal(savedBuff(r2),value);
});

for(const id of [595,616,617]) test(`wolf${id}: mode exit releases own part, takeover only session, restart never bakes growth`,async()=>{
  const h=setup();h.choose('attacker',id);h.input('buff',-20);h.mode('attacker','abu');await h.level('attacker',80);assert.equal(h.state.buff,80);
  h.mode('attacker','ming');assert.equal(h.state.buff,-20);assert.equal(h.page.CalcEngine.effectiveLevel('attacker'),99);
  h.mode('attacker','abu');await h.level('attacker',99);h.input('buff',0);assert.equal(h.state.buff,0);
  h.choose('attacker',623);h.choose('attacker',id);assert.equal(h.state.buff,0);assert.equal(h.page.CalcEngine.effectiveLevel('attacker'),99);
  h.icon(535).fire('click');h.icon(244).fire('click');assert.equal(h.state.buff,0);
  const r=setup(h.profile);r.page.initDefaultPets();assert.equal(r.state.atkPet.id,id);assert.equal(r.state.buff,0);assert.equal(r.page.CalcEngine.effectiveLevel('attacker'),60);
  assert.equal(h.profile.rk_damage_skill_configs[id].abuBuffOverridden,undefined);assert.equal(h.profile.rk_damage_view.skill.abuBuffOverridden,undefined);
  await h.level('attacker',62);assert.equal(h.state.buff,10);h.mode('attacker','base');assert.equal(h.state.buff,0);
  h.mode('attacker','final');assert.equal(h.state.buff,0);h.mode('attacker','abu');assert.equal(h.state.buff,0);
});

for(const id of [623,595,616,617]) test(`defender${id}: threshold<80, original baseline40 is not mistaken for temporary40`,async()=>{
  const h=setup();h.choose('attacker',1);h.input('percentBonus',40);h.input('buff',13);h.choose('defender',id);
  if(id!==623)h.mode('defender','abu');
  for(const level of [60,62,78,80,99,78,80]){
    await h.level('defender',level);assert.equal(h.state.percentBonus,level<80?30:40);
    assert.equal(h.state.buff,13);h.icon(244).fire('click');assert.equal(h.page.skillSnapshot().percentBonus,40);
    assert.equal(h.profile.rk_damage_skill_configs[1].percentBonus,40);assert.equal(h.profile.rk_damage_view.skill.percentBonus,40);
  }
  if(id===623){await h.manualLevel('defender',79);assert.equal(h.state.percentBonus,30);await h.manualLevel('defender',80);assert.equal(h.state.percentBonus,40);}
  else {h.mode('defender','ming');await h.level('defender',79);assert.equal(h.state.percentBonus,40);h.mode('defender','abu');assert.equal(h.state.percentBonus,30);h.mode('defender','base');assert.equal(h.state.percentBonus,40);}
  h.choose('defender',9001);assert.equal(h.state.percentBonus,40);
});

test('received bonus uses defender only, simultaneous different modes and40→30→normal restore',async()=>{
  const h=setup();h.choose('attacker',595);h.choose('defender',616);h.input('percentBonus',11);h.input('buff',-5);
  h.mode('attacker','abu');await h.level('attacker',99);assert.equal(h.state.buff,190);assert.equal(h.state.percentBonus,11);
  h.mode('defender','ming');await h.level('defender',79);assert.equal(h.state.percentBonus,40);assert.equal(h.state.buff,190);
  h.mode('defender','abu');assert.equal(h.state.percentBonus,30);assert.equal(h.state.buff,190);
  h.mode('attacker','ming');await h.level('attacker',79);assert.equal(h.state.buff,-5);assert.equal(h.state.percentBonus,30);
  h.mode('defender','final');assert.equal(h.state.percentBonus,11);
  h.choose('defender',619);await h.manualLevel('defender',79);assert.equal(h.state.percentBonus,40);
  h.choose('defender',623);assert.equal(h.state.percentBonus,30);h.choose('defender',9001);assert.equal(h.state.percentBonus,11);
});

test('attacker approved trait and JMFZ type25 keep priority through Abu/Ming target transitions',async()=>{
  const h=setup();h.window.TraitPowerDefaults=require('../js/trait-power-defaults');h.choose('attacker',203);h.choose('defender',623);assert.equal(h.state.percentBonus,30);
  h.input('percentBonus',19);await h.level('defender',62);assert.equal(h.state.percentBonus,30);
  h.choose('defender',619);await h.manualLevel('defender',79);assert.equal(h.state.percentBonus,40);
  h.choose('defender',501);assert.equal(h.state.percentBonus,0);
  h.RKData.getTypeEff=()=>2; // CalcEngine destructured getTypeEff; use its public calculator entry for this branch.
  const original=h.page.CalcEngine.calcTypeEff;h.page.CalcEngine.calcTypeEff=()=>2;
  h.page.checkJmfzBonus();assert.equal(h.state.percentBonus,25);h.page.CalcEngine.calcTypeEff=original;
  h.choose('defender',623);assert.equal(h.state.percentBonus,30);h.choose('defender',9001);assert.equal(h.state.percentBonus,30,'approved attacker trait restored');
  assert.equal(h.profile.rk_damage_skill_configs[203].percentBonus,19);
});

for(const id of [623,595]) for(const overridden of [false,true]) test(`invalid drafts atomically block${id} level/mode/skill actions (override=${overridden})`,async()=>{
  const h=setup();h.choose('attacker',id);if(id!==623)h.mode('attacker','abu');await h.level('attacker',80);
  if(overridden)h.input('buff',-20);
  for(const draft of ['1+','-','1/0','2^100',String(Number.MAX_SAFE_INTEGER+1)]){
    const state=plain(h.state),profile=plain(h.profile),before=snapshot(h),writes=h.writes.length,level=h.page.CalcEngine.effectiveLevel('attacker');
    h.input('buff',draft);assert.deepEqual(plain(h.state),state);assert.deepEqual(plain(h.profile),profile);
    assert.equal(await h.level('attacker',62),false);h.icon(244).fire('click');h.icon(535).fire('click');h.radio('magic_attack');
    if(id!==623)assert.equal(h.mode('attacker','final'),false);
    assert.deepEqual(plain(h.state),state);assert.deepEqual(snapshot(h),before);assert.deepEqual(plain(h.profile),profile);assert.equal(h.writes.length,writes);
    assert.equal(h.page.CalcEngine.effectiveLevel('attacker'),level);
    h.page.restoreFromState();
  }
  h.input('buff',Number.MAX_SAFE_INTEGER);const profile=plain(h.profile),level=h.page.CalcEngine.effectiveLevel('attacker');
  assert.equal(await h.level('attacker',99),false);assert.equal(h.state.buff,Number.MAX_SAFE_INTEGER);assert.equal(h.page.CalcEngine.effectiveLevel('attacker'),level);assert.deepEqual(plain(h.profile),profile);
});

test('direct DOM blank reads do not persist marker or create negative compensation; explicit action owns zero',async()=>{
  for(const blank of ['', ' \t\n '])for(const readFirst of [false,true]){
    const h=setup();await h.level('attacker',80);h.document.getElementById('buff').value=blank;
    const before=plain(h.profile),writes=h.writes.length;
    if(readFirst){h.page.calculate();h.page.calculate();assert.equal(h.state.buff,0);assert.equal(snapshot(h).buff,0);assert.deepEqual(plain(h.profile),before);assert.equal(h.writes.length,writes);}
    h.icon(535).fire('click');h.icon(244).fire('click');assert.equal(h.state.buff,0);assert.equal(savedBuff(h),0);assert.equal(savedOverride(h),true);
    await h.level('attacker',62);assert.equal(h.state.buff,10);assert.equal(savedBuff(h),0);
  }
});

test('blank read remains suspended through re-render without treating ordinary reads as explicit takeover',async()=>{
  const h=setup();await h.level('attacker',80);const profile=plain(h.profile),writes=h.writes.length;
  h.document.getElementById('buff').value='';h.page.calculate();h.page.restoreFromState();
  assert.equal(h.state.buff,0);assert.equal(savedOverride(h),false);assert.deepEqual(plain(h.profile),profile);assert.equal(h.writes.length,writes);
  h.icon(244).fire('click');assert.equal(h.state.buff,0);assert.equal(savedBuff(h),0);assert.equal(savedOverride(h),true);
  await h.level('attacker',80);assert.equal(h.state.buff,100);assert.equal(savedBuff(h),0);
});

test('source guard requires native stable identity and exact reviewed trait, unrelated level traits never borrow effect',async()=>{
  for(const changed of [ {...abu,id:9876}, {...abu,trait:{localized:{zh:{name:'圣龙的守护',description:DESCRIPTION+'新机制'}}}}, {...abu,trait:{localized:{zh:{name:'其它',description:DESCRIPTION}}}} ]){
    const h=setup();h.page.selectPet('attacker',plain(changed),null,'history');await h.level('attacker',80);assert.equal(h.state.buff,0);
    h.page.selectPet('defender',plain(changed),null,'history');await h.level('defender',62);assert.equal(h.state.percentBonus,0);
  }
  const h=setup();h.state.atkPet.trait.localized.zh.description=' \n'+DESCRIPTION+'\t';await h.level('attacker',80);assert.equal(h.state.buff,100);
});

for(const first of ['attacker','defender'])for(const id of [623,595,616,617])for(const override of [false,true])test(`trial${first}-first species${id} override${override}: both sides isolate and restore`,async()=>{
  const h=setup();h.choose('attacker',id);h.choose('defender',id);h.input('buff',-20);h.input('percentBonus',11);
  if(id!==623){h.mode('attacker','abu');h.mode('defender','ming');}
  await h.level('attacker',80);if(id!==623)await h.level('defender',79);else await h.level('defender',78);
  if(override){h.input('buff',0);h.input('percentBonus',17);}
  const before=plain(h.state),profile=plain(h.profile),snap=snapshot(h),writes=h.writes.length;
  const record={sides:{me:{pets:[{instanceId:'a',monsterId:id,level:79}]},enemy:{pets:[{instanceId:'d',monsterId:id,level:79}]}}},original=plain(record);
  h.window.BattleRecordsClient={getRecord:()=>record,getRevision:()=>1,snapshotValues:p=>({iv:{attack:31},nature:{},level:p.level})};
  for(const side of [first,first==='attacker'?'defender':'attacker'])assert.ok(h.page.CalcEngine.applyBattlePet(side,side==='attacker'?'me':'enemy',side==='attacker'?'a':'d'));
  const baseline=override?0:-20;
  assert.equal(h.state.buff,id===623?baseline+95:baseline,'native snapshot derives level; wolf snapshot ignores personal mode');
  assert.equal(h.state.percentBonus,id===623?30:(override?17:11));
  for(const level of [60,62,78,79,80,99]){
    await h.manualLevel('attacker',level);await h.manualLevel('defender',level);
    assert.equal(h.state.buff,id===623?baseline+(level-60)*5:baseline);
    assert.equal(h.state.percentBonus,id===623&&level<80?30:(override?17:11));
    h.icon(535).fire('click');assert.equal(h.state.buff,baseline);h.icon(244).fire('click');
  }
  h.input('buff','');h.icon(244).fire('click');assert.equal(h.state.buff,0);h.input('buff',-10);h.icon(535).fire('click');h.icon(244).fire('click');assert.equal(h.state.buff,-10);
  assert.deepEqual(plain(h.profile),profile);assert.equal(h.writes.length,writes);assert.deepEqual(record,original);
  h.page.CalcEngine.endBattleSimulation();assert.deepEqual(plain(h.state),before);assert.deepEqual(snapshot(h),snap);assert.deepEqual(plain(h.profile),profile);
  // Re-entry must not reuse a trial takeover or stale derived tracker.
  h.page.CalcEngine.applyBattlePet('attacker','me','a');assert.equal(h.state.buff,id===623?baseline+95:baseline);
  h.page.CalcEngine.endBattleSimulation();assert.deepEqual(plain(h.state),before);
});

test('trial defender-first unsnapped native level is temporary and no personal/team writes escape',async()=>{
  const h=setup();await h.level('attacker',80);const before=plain(h.profile),state=plain(h.state);
  const record={sides:{enemy:{pets:[{instanceId:'d',monsterId:623}]}}};h.window.BattleRecordsClient={getRecord:()=>record,getRevision:()=>1,snapshotValues:()=>({iv:{},nature:{},level:79})};
  h.page.CalcEngine.applyBattlePet('defender','enemy','d');await h.level('attacker',62);assert.equal(h.state.buff,10);assert.equal(h.page.CalcEngine.effectiveLevel('attacker'),62);
  assert.deepEqual(plain(h.profile),before);h.page.CalcEngine.endBattleSimulation();assert.deepEqual(plain(h.state),state);assert.equal(h.page.CalcEngine.effectiveLevel('attacker'),80);
});

for(const first of ['attacker','defender']) test(`trial${first}-first target threshold restores trial manual, never personal percent`,async()=>{
  const h=setup();h.input('percentBonus',11);await h.level('attacker',80);h.input('buff',-20);
  const profile=plain(h.profile),before=plain(h.state);
  const record={sides:{me:{pets:[{instanceId:'a',monsterId:623}]},enemy:{pets:[{instanceId:'d',monsterId:623}]}}};
  h.window.BattleRecordsClient={getRecord:()=>record,getRevision:()=>1,snapshotValues:()=>({iv:{},nature:{},level:79})};
  for(const side of [first,first==='attacker'?'defender':'attacker'])h.page.CalcEngine.applyBattlePet(side,side==='attacker'?'me':'enemy',side==='attacker'?'a':'d');
  h.input('percentBonus',17);assert.equal(h.state.percentBonus,17);
  await h.manualLevel('defender',78);assert.equal(h.state.percentBonus,30);await h.manualLevel('defender',80);assert.equal(h.state.percentBonus,17);
  h.input('percentBonus',40);await h.manualLevel('defender',79);assert.equal(h.state.percentBonus,30);await h.manualLevel('defender',80);assert.equal(h.state.percentBonus,40);
  assert.deepEqual(plain(h.profile),profile);h.page.CalcEngine.endBattleSimulation();assert.deepEqual(plain(h.state),before);
});

test('wolf modes for different IDs and sides keep independent session levels and overrides',async()=>{
  const h=setup();
  for(const [index,id] of [595,616,617].entries()){
    h.choose('attacker',id);h.choose('defender',id);h.input('buff',-10-index);h.mode('attacker','abu');h.mode('defender','ming');
    await h.level('attacker',80+index*2);await h.level('defender',79-index*10);
    if(index!==1)h.input('buff',index);
  }
  for(const [index,id] of [595,616,617].entries()){
    h.choose('attacker',id);h.choose('defender',id);
    assert.equal(h.page.CalcEngine.effectiveLevel('attacker'),80+index*2);assert.equal(h.page.CalcEngine.effectiveLevel('defender'),79-index*10);
    assert.equal(h.state.buff,index===1?99:index);assert.equal(h.state.percentBonus,40);
  }
  assert.equal(h.profile.rk_damage_levels,undefined);assert.equal(h.profile.rk_team_config,undefined);
});

test('changing reviewed native trait removes the prior own component on the next skill action',async()=>{
  const h=setup();h.input('buff',-20);await h.level('attacker',80);assert.equal(h.state.buff,80);
  h.state.atkPet.trait.localized.zh.description=DESCRIPTION+'未知修订';h.icon(244).fire('click');assert.equal(h.state.buff,-20);assert.equal(savedBuff(h),-20);
  h.choose('defender',623);assert.equal(h.state.percentBonus,0);h.icon(535).fire('click');assert.equal(h.state.buff,-20);
});

test('fire growth/blank takeover and Abu growth stay separate across species and target modes',async()=>{
  const h=setup();h.choose('attacker',14);h.icon(113).fire('contextmenu');h.icon(113).fire('contextmenu');assert.equal(h.state.buff,60);
  h.choose('defender',595);h.mode('defender','abu');assert.equal(h.state.percentBonus,30);assert.equal(h.state.buff,60);
  h.icon(535).fire('click');h.input('buff','');h.icon(113).fire('click');assert.equal(h.state.buff,0);
  h.choose('attacker',623);await h.level('attacker',80);assert.equal(h.state.buff,100);assert.equal(h.state.percentBonus,30);
  h.choose('attacker',14);assert.equal(h.state.buff,0);h.icon(113).fire('contextmenu');assert.equal(h.state.buff,30);
  h.mode('defender','ming');await h.level('defender',79);assert.equal(h.state.percentBonus,40);assert.equal(h.state.buff,30);
  h.choose('attacker',623);assert.equal(h.state.buff,100);assert.equal(savedBuff(h),0);assert.equal(h.profile.rk_damage_skill_configs[14].buff,0);
});

for(const [version,description] of [['old',DESCRIPTION],['S5',S5_DESCRIPTION]]){
  test(`native623 ${version} exact reviewed description accepts both existing effects and whitespace policy`,async()=>{
    for(const text of [description,' \n'+description+'\t']){
      const h=setup();h.state.atkPet.trait.localized.zh.description=text;
      h.input('buff',-20);h.input('percentBonus',11);h.choose('defender',623);
      for(const level of [60,62,78,79,80,99]){
        await h.manualLevel('attacker',level);await h.manualLevel('defender',level);h.icon(245).fire('click');
        assert.equal(h.state.buff,-20+(level-60)*5);assert.equal(h.state.percentBonus,level<80?30:11);
        assert.equal(savedBuff(h),-20);assert.equal(snapshot(h).percentBonus,11);
        h.radio('magic_attack');assert.equal(h.state.buff,-20);h.radio('attack');
      }
    }
  });
  test(`native623 ${version} tampered full text/name/identity rejects and withdraws only prior component`,async()=>{
    const changedTraits=[
      {name:'圣龙的守护',description:description+'未知修订'},
      {name:'圣龙的守护',description:description.replace('+5%','+6%')},
      {name:'圣龙的守护',description:description.replace('+30%','+40%')},
      {name:'圣龙的守护',description:description.slice(0,-1)},
      {name:'圣龙的守护 ',description},
      {name:'圣龙的心愿',description}
    ];
    for(const trait of changedTraits){
      const h=setup();h.state.atkPet.trait.localized.zh.description=description;
      h.input('buff',-20);h.input('percentBonus',11);await h.level('attacker',80);h.choose('defender',623);
      assert.equal(h.state.buff,80);assert.equal(h.state.percentBonus,30);
      h.state.atkPet.trait.localized.zh=plain(trait);h.icon(245).fire('click');
      assert.equal(h.state.buff,-20,'only native derived100 is removed');assert.equal(savedBuff(h),-20);
      h.choose('defender',623);assert.equal(h.state.percentBonus,11,'temporary30 releases the original manual11');
      assert.equal(snapshot(h).percentBonus,11);h.radio('magic_attack');h.radio('attack');assert.equal(h.state.buff,-20);
    }
    for(const id of [648,9876,'623']){
      const h=setup(),changed={...plain(h.state.atkPet),id,trait:{localized:{zh:{name:'圣龙的守护',description}}}};
      h.page.selectPet('attacker',changed,null,'history');await h.level('attacker',80);assert.equal(h.state.buff,0);
      h.page.selectPet('defender',changed,null,'history');await h.level('defender',62);assert.equal(h.state.percentBonus,0);
    }
  });
}

test('old and S5 exact text yield byte-identical full calculation results at fixed approved qualifications',async()=>{
  const results=[];
  for(const description of [DESCRIPTION,S5_DESCRIPTION]){
    const h=setup(undefined,{getTypeZh:x=>x==='Dragon'?'龙':x});h.state.atkPet.trait.localized.zh.description=description;
    h.input('buff',-20);h.input('percentBonus',11);h.choose('defender',623);
    h.state.atkIV={attack:true,magic_attack:true};h.state.atkNature={};
    h.state.defIV={hp:true,defense:true,magic_defense:true};h.state.defNature={};
    for(const [key,value] of Object.entries({fixedBonus:0,debuffPercent:0,defenseMod:0,starMeteor:0,finalPowerManual:'',comboCount:1}))h.input(key,value);
    const rows=[];
    for(const level of [60,62,78,79,80,99]){
      await h.manualLevel('attacker',level);await h.manualLevel('defender',level);
      for(const id of [244,245]){
        h.icon(id).fire('click');const result=plain(h.page.CalcEngine.calculate());
        const buff=-20+(level-60)*5,percent=level<80?30:11;
        const stat=q=>Math.round((2*level+100)*(q+30)/200)+60;
        const base=id===244?60:100,basePower=Math.round(base*(100+percent)/100);
        const finalPower=Math.round(basePower*1.25*(buff>=0?1+buff/100:1/(1-buff/100)));
        assert.equal(result.atkStat,stat(105),'unchanged formula A and approved phyatk105');
        assert.equal(result.defStat,stat(122),'unchanged formula A and approved phydef122');
        assert.equal(result.defHP,Math.round((2*level+50)*(126+30)/100)+level+110);
        assert.equal(result.buffPercent,buff);assert.equal(result.percentBonus,percent);
        assert.equal(result.skillBasePower,basePower);assert.equal(result.skillFinalPower,finalPower);
        const singleHit=Number(BigInt(stat(105))*BigInt(finalPower)*BigInt(1000+45*level)/BigInt(4100*stat(122)));
        assert.equal(result.singleHit,singleHit,'exact formula B rational coefficient with final-only floor');
        assert.equal(result.totalDamage,singleHit);assert.equal(result.attackLevel,level);
        rows.push(result);
      }
    }
    results.push(rows);
  }
  assert.deepEqual(results[1],results[0],'full result objects differ in no formula/rounding/rate field');
  console.log('ABU_EXACT_TEXT_PARITY '+JSON.stringify(results[0].filter(r=>r.basePower===100).map(r=>({level:r.attackLevel,buff:r.buffPercent,received:r.percentBonus,atk:r.atkStat,def:r.defStat,finalPower:r.skillFinalPower,singleHit:r.singleHit}))));
});

test('actual ordinary阿布648 圣龙的心愿 never borrows native623 growth or received30',async()=>{
  const h=setup(),ordinary=h.RKData.getMonsterById(648);assert.ok(ordinary,'audited plan assigns ordinary阿布648, not647');
  assert.equal(ordinary.localized.zh.name,'阿布');assert.equal(ordinary.trait.localized.zh.name,'圣龙的心愿');
  assert.equal(ordinary.trait.localized.zh.description,'己方精灵每使用1次能耗为3的技能，自己入场前等级+2。低于80级时受到伤害+30%。');
  const original=plain(ordinary);h.choose('attacker',648);h.input('buff',-20);h.input('percentBonus',11);h.choose('defender',648);
  for(const level of [60,62,78,79,80,99]){
    await h.manualLevel('attacker',level);await h.manualLevel('defender',level);h.icon(245).fire('click');
    assert.equal(h.state.buff,-20);assert.equal(h.state.percentBonus,11);assert.equal(h.page.CalcEngine.calculate().buffPercent,-20);
    assert.equal(h.profile.rk_damage_skill_configs[648].abuBuffOverridden,undefined);
  }
  assert.deepEqual(plain(h.RKData.getMonsterById(648)),original,'ordinary metadata stays untouched; no entry-cost simulation');
});
