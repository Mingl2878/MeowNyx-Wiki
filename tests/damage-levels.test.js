'use strict';
// Actual damage closure, in-memory profile only; no native app or personal files.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const math = require('../js/battle-math');
const PetLevels = require('../js/pet-levels');
const source = fs.readFileSync(path.join(__dirname, '../js/pages/damage.js'), 'utf8');
const clone = x => JSON.parse(JSON.stringify(x));
function harness(initial = {}, fail = false) {
  const committed = clone(initial), drafts = {}, writes = [], reads = [];
  const UserConfig = {
    getObject: (key, fallback = {}) => clone({...fallback, ...committed[key], ...drafts[key]}),
    patch(key, fields) {
      writes.push({key, fields:clone(fields)}); drafts[key] = {...drafts[key], ...clone(fields)};
      if (!fail) { committed[key] = {...committed[key], ...drafts[key]}; delete drafts[key]; }
      return Promise.resolve(!fail);
    },
    retry() { for(const key of Object.keys(drafts)) { committed[key] = {...committed[key], ...drafts[key]}; delete drafts[key]; } }
  };
  const special = {id:619, name:'冥古龙', default_level:99, level_configurable:true, main_type:{name:'None'}};
  const ordinary = {id:202, name:'普通精灵', main_type:{name:'Water'}};
  const wolves = [{id:616,name:'诅咒狼灵'},{id:617,name:'新月狼灵',evolves_from_id:616},{id:595,name:'银月狼王',evolves_from_id:617}].map(p=>({...p,main_type:{name:'Normal'}}));
  const monsters = [special, ordinary, ...wolves];
  const RKData = {ALL_TYPES:[], getTypeZhFull:x=>x, getTypeZh:x=>x, getTypeEn:x=>x,
    getTypeEff:()=>1, getBaseStat:()=>100, getTypeIcon:()=>'', getMonsterDisplayName:p=>p.name,
    getMonsters:()=>monsters, getMoves:()=>[], getPetStat(p,stat,nature,iv,level) { reads.push({id:p.id,stat,level}); return math.statFromBase(100,stat,nature,iv,PetLevels.config(p).enabled||PetLevels.isWolf(p,monsters)?level:60); }};
  const context = vm.createContext({ RKData, PetLevels, BattleMath:math, SkillSimulation:require('../js/skill-simulation'), window:{UserConfig,addEventListener(){}},
    localStorage:{getItem(){return null;}}, CommonUI:{StatBox:{refreshValues(){}}},
    document:{getElementById(){return null;},querySelector(){return null;}}, setTimeout, clearTimeout });
  vm.runInContext(source.replace('return { render, onLeave, getState: () => state, CalcEngine };',
    'return { render, onLeave, getState: () => state, CalcEngine, updateSpecialPower };') + '\nthis.page=DamagePage;', context);
  const page = context.page, state = page.getState();
  Object.assign(state,{atkPet:special,defPet:special,atkIV:{},atkNature:{},defIV:{},defNature:{}});
  return {page,state,api:page.CalcEngine,UserConfig,committed,drafts,writes,reads,special,ordinary,wolves,RKData};
}
test('independent side defaults and every shortcut have exact levels', async()=>{
  const h=harness(), a=h.api;
  assert.deepEqual(clone(a.LEVEL_STEPS),[1,9,19,29,39,49,59,69,79,89,99]);
  assert.equal(a.effectiveLevel('attacker'),99);assert.equal(a.effectiveLevel('defender'),99);
  for(const value of a.LEVEL_STEPS){await a.setLevelPreference('attacker',{slider:value});assert.equal(a.effectiveLevel('attacker'),value);assert.equal(a.effectiveLevel('defender'),99);}
  assert.ok(h.writes.every(w=>w.key==='rk_damage_levels'));
});
test('legacy manual survives reads but a slider immediately replaces it; all side/record fields survive', async()=>{
  const h=harness({rk_damage_levels:{619:{extension:'keep',attacker:{slider:99,manual:'43',extra:{keep:true}},defender:{slider:29,manual:60}},77:{attacker:{slider:60,manual:''}}}}), a=h.api;
  assert.equal(a.effectiveLevel('attacker'),43);assert.equal(h.writes.length,0);
  await a.setLevelPreference('attacker',{slider:9});
  assert.equal(a.effectiveLevel('attacker'),9);assert.equal(h.committed.rk_damage_levels[619].attacker.manual,'');
  assert.deepEqual(h.committed.rk_damage_levels[619].attacker.extra,{keep:true});
  assert.equal(a.effectiveLevel('defender'),60);assert.equal(h.committed.rk_damage_levels[619].extension,'keep');
  assert.deepEqual(h.committed.rk_damage_levels[77],{attacker:{slider:60,manual:''}});
  // The compatibility API still accepts old records; the next control wins.
  await a.setLevelPreference('attacker',{manual:43});assert.equal(a.effectiveLevel('attacker'),43);
  await a.setLevelPreference('attacker',{slider:19,manual:43});assert.equal(a.effectiveLevel('attacker'),19);
  const before=JSON.stringify(h.committed);
  for(const manual of [-1,0,100,1.5,'043',null])assert.equal(await a.setLevelPreference('attacker',{manual}),false);
  assert.equal(await a.setLevelPreference('attacker',{slider:11}),false);
  assert.equal(JSON.stringify(h.committed),before);
});
test('adjacent levels originate at the effective off-grid43, never at its stale stored slider',async()=>{
  for(const [record,direction,expected] of [[{slider:99,manual:'43'},-1,39],[{slider:1,manual:'43'},1,49],[{slider:43,manual:''},-1,39],[{slider:43,manual:''},1,49]]) {
    const h=harness({rk_damage_levels:{619:{attacker:record}}});
    assert.equal(h.api.effectiveLevel('attacker'),43);assert.equal(h.writes.length,0);
    assert.equal(await h.api.stepLevelPreference('attacker',direction),true);
    assert.equal(h.api.effectiveLevel('attacker'),expected);assert.equal(h.api.levelRecord('attacker').manual,'');
  }
  const h=harness();assert.equal(await h.api.stepLevelPreference('attacker',1),false);
  await h.api.setLevelPreference('attacker',{slider:1});assert.equal(await h.api.stepLevelPreference('attacker',-1),false);
  assert.equal(await h.api.stepLevelPreference('attacker',0),false);
});
test('failure keeps draft separate, retry commits, reload restores without writes', async()=>{
  const h=harness({rk_damage_levels:{619:{attacker:{slider:99,manual:''}}}},true);
  assert.equal(await h.api.setLevelPreference('attacker',{manual:43}),false);
  assert.equal(h.api.effectiveLevel('attacker'),43);
  assert.equal(h.committed.rk_damage_levels[619].attacker.manual,'');
  h.UserConfig.retry();const next=harness(h.committed);
  assert.equal(next.api.effectiveLevel('attacker'),43);assert.equal(next.writes.length,0);
});
test('ordinary never inherits a special level; side-specific levels remain at their roles on swaps',async()=>{
  const h=harness();await h.api.setLevelPreference('attacker',{manual:43});await h.api.setLevelPreference('defender',{slider:9});
  h.state.atkPet=h.ordinary;assert.equal(h.api.effectiveLevel('attacker'),60);
  assert.equal(await h.api.setLevelPreference('attacker',{manual:99}),false);
  [h.state.atkPet,h.state.defPet]=[h.state.defPet,h.state.atkPet];
  assert.equal(h.api.effectiveLevel('attacker'),43);assert.equal(h.api.effectiveLevel('defender'),60);
  h.state.defPet=h.special;assert.equal(h.api.effectiveLevel('defender'),9);
});
test('all engine stats receive side level; damage and meteor get attacker factor, display only rounds',async()=>{
  const h=harness(); h.state.starMeteor=4;h.state.skillAttr='Water';
  await h.api.setLevelPreference('defender',{manual:19});
  for(const level of [1,9,60,99]){
    await h.api.setLevelPreference('attacker',{manual:level});h.reads.length=0;
    const r=h.api.calculate();
    assert.equal(r.attackLevel,level);assert.equal(r.factorText,((10+.45*level)/41).toFixed(2));
    assert.equal(r.singleHit,math.normalDamage(r.atkStat,r.skillFinalPower,r.defStat,r.debuffMod,1,level));
    assert.equal(r.starMeteorDamage,math.starMeteorDamage(r.starMeteorBase,r.atkStat,r.defStat,r.buffMod,r.starMeteorTypeEff,r.debuffMod,level));
    assert.equal(h.reads.find(v=>v.stat==='attack').level,level);
    assert.ok(h.reads.filter(v=>v.stat==='defense'||v.stat==='hp').every(v=>v.level===19));
    assert.ok(h.api.buildSteps(r).join('\n').includes(r.factorText));
  }
  h.state.atkPet=h.ordinary;assert.equal(h.api.calculate().factorText,'0.9');
});
test('level changes do not write IV/nature mode, team data or skill configs; zero/manual expressions untouched',async()=>{
  const h=harness({rk_pet_configs:{619:{mode:1,iv:{hp:false},nature:{hp:2}}},rk_damage_skill_configs:{619:{basePower:0}},rk_damage_view:{skill:{basePower:0}}});
  Object.assign(h.state,{basePower:0,basePowerExpression:'',finalPowerManual:'0',currentSkillName:'手动测试'});
  const before=clone(h.committed);await h.api.setLevelPreference('attacker',{slider:1});
  assert.equal(h.api.calculate().singleHit,0);
  assert.equal(h.state.basePower,0);assert.equal(h.state.finalPowerManual,'0');assert.equal(h.state.currentSkillName,'手动测试');
  for(const key of Object.keys(before))assert.deepEqual(h.committed[key],before[key]);
});
test('dynamic speed and physical-defense powers read both configured levels without persisting skills', async()=>{
  const h=harness();await h.api.setLevelPreference('attacker',{manual:'43'});await h.api.setLevelPreference('defender',{manual:'9'});
  for(const [formula,stat]of [['speed_diff','speed'],['phy_def_diff','defense']]){
    const move={power_formula:formula};h.RKData.getMoves=()=>[move];h.RKData.getMoveName=()=>formula;h.state.currentSkillName=formula;
    h.reads.length=0;h.page.updateSpecialPower();
    assert.deepEqual(h.reads.map(v=>[v.stat,v.level]),[[stat,43],[stat,9]]);
    const expected=math.differencePower(math.statFromBase(100,stat,0,false,43)-math.statFromBase(100,stat,0,false,9));
    assert.equal(h.state.basePower,expected);
  }
  assert.ok(h.writes.every(w=>w.key==='rk_damage_levels'));
});
test('all three wolf forms get four independent modes and exact reset/default slider behavior', async()=>{
  const h=harness(),a=h.api;
  for(const wolf of h.wolves) {
    h.state.atkPet=wolf; h.state.defPet=wolf;
    assert.equal(a.effectiveLevel('attacker'),60);
    assert.equal(a.setWolfMode('attacker','ming'),true);assert.equal(a.effectiveLevel('attacker'),99);
    for(const slider of a.levelSteps('attacker')) { await a.setLevelPreference('attacker',{slider});assert.equal(a.effectiveLevel('attacker'),slider); }
    await a.setLevelPreference('attacker',{slider:9});
    a.setWolfMode('attacker','abu');assert.equal(a.effectiveLevel('attacker'),60);
    assert.deepEqual(clone(a.levelSteps('attacker')),[60,62,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,99]);
    assert.equal(await a.setLevelPreference('attacker',{slider:61}),false);
    for(const slider of a.levelSteps('attacker')) { await a.setLevelPreference('attacker',{slider});assert.equal(a.effectiveLevel('attacker'),slider); }
    assert.equal(a.effectiveLevel('defender'),60);
    a.setWolfMode('attacker','ming');assert.equal(a.effectiveLevel('attacker'),99,'each entry resets, never restores9');
    await a.setLevelPreference('attacker',{slider:19});a.setWolfMode('attacker','base');assert.equal(a.effectiveLevel('attacker'),60);assert.equal(h.state.atkStatMode,'base');
    a.setWolfMode('attacker','final');assert.equal(a.effectiveLevel('attacker'),60);
    assert.equal(await a.setLevelPreference('attacker',{slider:99}),false);
    a.setWolfMode('defender','ming');assert.equal(a.effectiveLevel('attacker'),60);assert.equal(a.effectiveLevel('defender'),99);
    const result=a.calculate();assert.equal(result.attackLevel,60);assert.equal(result.defStat,math.statFromBase(100,'defense',0,false,99));
  }
  assert.equal(h.writes.length,0,'wolf simulation never writes personal/team/skill or generic level memory');
});
test('trait-triggered controls use configured range, default and step; writes retain species and side',async()=>{
  const h=harness(),a=h.api;
  h.state.atkPet={id:77,name:'测试',main_type:{name:'Normal'},trait:{localized:{zh:{description:'按等级提升'}}},default_level:60,level_min:50,level_max:99,level_step:2};
  assert.equal(a.effectiveLevel('attacker'),60);
  assert.deepEqual(clone(a.levelSteps('attacker')),[50,52,54,56,58,60,62,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,99]);
  assert.equal(await a.setLevelPreference('attacker',{manual:49}),false);
  assert.equal(await a.setLevelPreference('attacker',{slider:62}),true);assert.equal(a.effectiveLevel('attacker'),62);
  assert.equal(a.effectiveLevel('defender'),99);
  assert.equal(h.committed.rk_damage_levels[77].attacker.slider,62);
  const result=a.calculate();assert.equal(result.attackLevel,62);assert.equal(result.atkStat,math.statFromBase(100,'attack',0,false,62));
});
test('UI uses a custom anchored menu, plain grades and adjacent controls with no dead manual editor',()=>{
  assert.doesNotMatch(source,/openLevelEditor|closeLevelEditor|damage-level-(?:editor|button|input|form|clear|confirm)|window\.prompt\(/);
  assert.doesNotMatch(source,/<select[^>]*damage-level-mode/);
  assert.match(source,/CommonUI\.positionAnchoredLayer\(owner, layer\)/);
  assert.match(source,/CommonUI\.bindAnchoredLayer\(owner, layer/);
  assert.match(source,/CommonUI\.registerCleanup\?\.\(owner, dispose\)/);
  assert.match(source,/buildLevelControls\('attacker'\)/);assert.match(source,/buildLevelControls\('defender'\)/);
  const css=fs.readFileSync(path.join(__dirname,'../css/damage-levels.css'),'utf8');
  assert.match(css,/\.damage-level-controls\[hidden\]/);assert.match(css,/\.damage-level-options\s*\{/);
  assert.doesNotMatch(css,/damage-level-(?:editor|button|input|form|clear|confirm)|is-manual/);
  assert.match(source,/return \{ render, onLeave, getState: \(\) => state, CalcEngine \};/);
});
