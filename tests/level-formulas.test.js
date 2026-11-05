'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const B = require('../js/battle-math');
const root = path.resolve(__dirname, '..');
const read = name => require('./catalog-read-fixture.cjs').readResource(root, name);
const fields = {hp:'base_hp',attack:'base_phy_atk',magic_attack:'base_mag_atk',defense:'base_phy_def',magic_defense:'base_mag_def',speed:'base_spd'};
const special = {id:619,default_level:99,level_configurable:true,...Object.fromEntries(Object.values(fields).map(k=>[k,100]))};
function legacy(q, stat, iv, nature) {
  const n = nature === 1 ? 1.2 : nature === 2 ? .9 : 1;
  return Math.round((Math.round((stat === 'hp' ? 1.7 : 1.1)*(q+(iv?30:0))) + (stat === 'hp'?70:10))*n)+(stat === 'hp'?100:50);
}
async function dataRuntime() {
  const context = vm.createContext({console:{log(){},error(){}},window:{},fetch:async name=>({ok:true,json:async()=>JSON.parse(read(name))})});
  for(const file of ['js/battle-math.js','js/monster-identity.js','js/data.js'])vm.runInContext(read(file),context);
  await vm.runInContext('RKData.init()',context);
  return {api:vm.runInContext('RKData',context),context};
}

test('formula A: every catalog qualification preserves exact 60-level output for six stats and six IV/nature combinations',()=>{
  const catalog = JSON.parse(read('data/monsters.json'));
  let comparisons=0;
  for(const pet of catalog)for(const [stat,field]of Object.entries(fields))for(const iv of [false,true])for(const nature of [0,1,2]){
    const q=Math.round(pet[field]||0);
    assert.equal(B.statFromBase(q,stat,nature,iv,60),legacy(q,stat,iv,nature),`${pet.id}/${stat}/${iv}/${nature}`);
    comparisons++;
  }
  assert.equal(comparisons,catalog.length*36);
});

test('effective IV is exactly 60 (not displayed 10 or twice-applied 60); level99 sample values',()=>{
  assert.equal(B.statFromBase(100,'hp',0,false,99),457);
  assert.equal(B.statFromBase(100,'hp',0,true,99),531);
  assert.equal(B.statFromBase(100,'hp',1,true,99),617);
  assert.equal(B.statFromBase(100,'attack',0,false,99),209);
  assert.equal(B.statFromBase(100,'attack',0,true,99),254);
  assert.equal(B.statFromBase(100,'attack',1,true,99),295);
  assert.equal(B.statFromBase(100,'hp',0,false,1),163);
  assert.equal(B.statFromBase(100,'speed',0,false,1),111);
});

test('60-level black wizard/dog/shark 108 attribute combinations retain legacy values',async()=>{
  const {api}=await dataRuntime();
  const pets=['黑猫巫师','音速犬','彩蝶鲨'].map(name=>api.getMonsters().find(p=>api.getMonsterName(p)===name));
  assert.ok(pets.every(Boolean));
  let count=0;
  for(const pet of pets)for(const [stat,field] of Object.entries(fields))for(const iv of [false,true])for(const nature of [0,1,2]){
    assert.equal(api.getPetStat(pet,stat,nature,iv),legacy(pet[field],stat,iv,nature));count++;
  }
  assert.equal(count,108);
});

test('level69 coefficient is formed as119/100 before multiplication; exact halves round up',()=>{
  // L69 is the requested half boundary; L8/Q25 also reproduces the binary
  // underestimate on this Node/V8 build (constant evaluation may differ).
  assert.equal(B.statFromBase(25,'speed',0,false,8),75,'R(58*25/100)+60 =75, never74');
  assert.equal(B.statFromBase(120,'attack',0,true,69),239,'R(119*150/100)+10+50');
  assert.equal(B.statFromBase(120,'attack',1,true,69),277,'R((179+10)*1.2)+50');
  assert.equal(B.statFromBase(120,'attack',2,true,69),220,'R((179+10)*.9)+50');
  assert.equal(B.statFromBase(120,'hp',0,true,69),461,'R(188*150/100)+69+10+100');
  // Decimal qualifications also use an exact decimal fraction, not a float halfway guess.
  assert.equal(B.statFromBase(100.5,'attack',0,false,50),161);
});

test('RKData optional level override applies only to configurable species; other pages use special default99',async()=>{
  const {api}=await dataRuntime();
  const ordinary={...special,id:620,level_configurable:false};
  for(const override of [undefined,null,'',1,9,43,60,99])assert.equal(api.getPetLevel(ordinary,override),60);
  assert.equal(api.getPetLevel(null,99),60);
  assert.equal(api.getPetLevel(special),99);
  assert.equal(api.getPetLevel(special,43),43);
  assert.equal(api.getPetLevel(special,0),1);
  assert.equal(api.getPetLevel(special,200),99);
  assert.equal(api.getPetStat(special,'speed',0,false),209);
  assert.equal(api.getPetStat(special,'speed',0,false,1),111);
  assert.equal(api.getPetStat(ordinary,'speed',0,false,99),170);
  assert.equal(api.getPetStat(null,'hp'),0);
});

test('formula B precise levels, type, reduction, combo and meteor use one final floor',()=>{
  for(const level of [1,9,19,29,39,49,59,60,69,79,89,99]){
    assert.equal(B.damageFactor(level),(1000+45*level)/4100);
    for(const effect of [.25,.5,1,2,3])for(const reduction of [.3,.5,1])for(const combo of [1,2,7]){
      const numerator=BigInt(202*562*(1000+45*level)*(effect*4)*Math.round(reduction*10));
      const expected=Number(numerator/BigInt(4100*231*4*10))*combo;
      assert.equal(B.normalDamage(202,562,231,reduction,combo,level,effect),expected);
      const meteor=BigInt(88*202*(1000+45*level)*(effect*4)*Math.round(reduction*10)*12);
      assert.equal(B.starMeteorDamage(88,202,231,1.2,effect,reduction,level),Number(meteor/BigInt(4100*231*4*10*10)));
    }
  }
  assert.equal(B.DAMAGE_FACTOR,B.damageFactor(60));
  assert.equal(B.starMeteorDamage(88,202,231,1,.5),34,'old ceil example35 is now34');
});

test('floor boundaries use exact rational coefficient, decimal modifiers and scientific inputs',()=>{
  assert.equal(B.normalDamage(41,1,37),1);
  assert.equal(B.normalDamage(4100,1,1045,1,1,1),1);
  assert.equal(B.normalDamage(4100,1,5455,1,1,99),1);
  assert.equal(B.normalDamage(41,.1,3.7),1);
  assert.equal(B.normalDamage(41,1e-7,3.7e-6),1);
  assert.equal(B.normalDamage(41,1,37.000000001),0);
  assert.equal(B.normalDamage(41,1,36.999999999),1);
  assert.equal(B.normalDamage(41,1,20,1,3,60,.5),0,'floor each hit, not combo total');
  assert.equal(B.normalDamage(99,0,50,1,7,99),0);
  assert.equal(B.normalDamage(99,500,50,1,7,99,0),0);
  assert.equal(B.starMeteorDamage(0,99,50,1,1,1,99),0);
});

test('non-damage power results round halves upward, including fan75+50%',()=>{
  assert.equal(B.basePower(75,0,50),113);
  assert.equal(B.finalPower(75,0,50),113);
  assert.equal(B.finalPower(10,0,0,1.25),13);
  assert.equal(B.basePower(0),0);
});

function speedRuntime(){
  const pets=[{id:1,base_spd:70,evolution_stage:'高级形态',name:'ordinary'}, {...special,base_spd:70,name:'special'}, {id:621,default_level:99,level_configurable:true,base_spd:103,name:'specialOdd'}];
  const table={innerHTML:'',querySelectorAll:()=>[],isConnected:false};
  const context=vm.createContext({BattleMath:B,window:{},localStorage:{getItem:()=>null},document:{getElementById:id=>id==='speed-tier-table'?table:null},RKData:{
    getMonsters:()=>pets,getPetLevel:pet=>pet?.level_configurable?pet.default_level:60,
    getMonsterName:pet=>pet.name,getMonsterDisplayName:pet=>pet.name
  }});
  // This suite verifies formulas/projection; speed-levels.test.js exercises the
  // unmodified DOM reconciler and delegated events on a deterministic DOM.
  vm.runInContext(read('js/pages/speed.js').replace('syncTierTable(table, html);','table.innerHTML = html;').replace('return { render, onLeave };','return { renderTierTable, calcSpeedStat, applyBonus, levelRows, getState:()=>tierState, getLayout:()=>layoutState };'),context);
  return {api:vm.runInContext('SpeedPage',context),pets,table};
}

test('speed tiers use shared A and round bonuses; ordinary tier values are unchanged',()=>{
  const {api}=speedRuntime();
  for(const q of [40,85,100,115,125,200])for(const iv of [false,true])for(const n of [0,1,2]){
    assert.equal(api.calcSpeedStat(q,iv,n),legacy(q,'speed',iv,n));
    assert.equal(api.calcSpeedStat(q,iv,n,99),B.statFromBase(q,'speed',n,iv,99));
  }
  api.getState().percent=50;
  assert.equal(api.applyBonus(111),167,'166.5 becomes167, not166');
});

test('one Ming species speed row uses every selected legacy level without falsifying qualification or ordinary60 pool',()=>{
  const {api,pets,table}=speedRuntime();api.renderTierTable();
  assert.match(table.innerHTML,/70 · Lv99/);
  assert.match(table.innerHTML,/103 · Lv99/);
  assert.ok(!table.innerHTML.includes('data-level="60" data-base-speed="103"'),'special-only qualification does not add an ordinary tier');
  for(const level of [1,9,19,29,39,49,59,69,79,89,99,60]){
    api.getState().mingSpeedLevel=level;api.getState().search='special';api.renderTierTable();
    assert.equal((table.innerHTML.match(/data-row-key="pet:619"/g)||[]).length,1);
    const rows=JSON.parse(JSON.stringify(api.levelRows([70],pets)));
    assert.deepEqual(rows,[{base:103,level:99,key:'103:99'},{base:70,level,key:'pet:619'},{base:70,level:60,key:'70:60'}]);
    const pools=JSON.parse(JSON.stringify(api.getLayout().rowPets));
    assert.deepEqual(pools.map(p=>p.map(m=>m.id)),[[621],[619],[1]]);
    const row=table.innerHTML.match(/<tr[^>]*data-row-key="pet:619"[^>]*>(.*?)<\/tr>/s)[1];
    assert.ok(row.includes(`70 · Lv${level}`));
    for(const [col,iv,nature] of [['base',false,0],['iv',true,0],['ivNature',true,1]]){
      const value=Number(row.match(new RegExp(`data-col="${col}"[^>]*><span class="speed-column-label">(\\d+)<`))[1]);
      assert.equal(value,B.statFromBase(70,'speed',nature,iv,level));
    }
    assert.match(table.innerHTML,new RegExp(`<tr class="tier-highlight" data-level="${level}" data-base-speed="70" data-row-key="pet:619"`));
    assert.doesNotMatch(table.innerHTML,/<tr class="tier-highlight"[^>]*data-row-key="70:60"/);
  }
});
