'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createStore} = require('../js/chart-workspace.js');
const BattleMath = require('../js/battle-math.js');
const source=fs.readFileSync(require.resolve('../js/pages/chart.js'),'utf8');
const math=vm.runInNewContext(source.split('const ChartPage =')[0]+'\nChartFavoriteMath;');
const fixture = initial => {
  const common={evolution_stage:'高级形态',form_category:'主形态',main_type:{name:'Fire'},hp:130,defense:120,magic_defense:140,attack:130,magic_attack:110};
  let pets=[{...common,id:1},{...common,id:2,main_type:{name:'Water'}},{...common,id:3,hidden:true},{...common,id:4,is_leader_form:true},
    {...common,id:5,form_category:'其它形态'},{...common,id:6,evolution_stage:'低级形态'},{...common,id:7,form_category:'无多形态'}, {...common,id:1}];
  let saved=structuredClone(initial||{state:createStore({}).defaults()}), failed=false,writes=0;
  const data={getMonsters:()=>pets,getPetLevel:p=>p.default_level||60,getPetStat:(p,s,n,iv)=>BattleMath.statFromBase(p[s],s,n,iv,p.default_level||60),
    getTypeEff:(_,main)=>main==='Water'?.5:1};
  const root={RKData:data,UserConfig:{getObject:()=>structuredClone(saved),patch:async(_,patch)=>{writes++;if(failed)return false;saved=structuredClone(patch);return true;}}};
  const store=createStore(root);
  return {store,root,data,pets:()=>pets,replace:p=>pets=p,fail:v=>failed=v,writes:()=>writes,saved:()=>structuredClone(saved)};
};

test('legacy false/true doubleLife and negative controls reset once, preserving groups and unknown fields; failed migration retries',async()=>{
  for(const enabled of [false,true]) {
    const old=createStore({}).defaults();delete old.controlsRevision;delete old.controls.hpNature;old.controls.doubleLife=enabled;
    old.controls.atkIV.attack=false;old.controls.defIV.magic_defense=false;old.controls.atkNature.magic_attack=2;
    old.groups[0].petIds=[7,1];old.future={keep:true};
    const f=fixture({state:old});f.fail(true);
    await assert.rejects(f.store.init(),/未保存/);assert.equal(f.store.getStatus().initialized,false);assert.deepEqual(f.saved().state,old);
    f.fail(false);await f.store.retry();const now=f.store.getState();
    assert.equal(now.controlsRevision,2);
    assert.deepEqual(now.controls,createStore({}).defaults().controls);
    assert.deepEqual(now.groups,old.groups);assert.deepEqual(now.future,old.future);
    const count=f.writes();const reload=createStore(f.root);await reload.init();assert.equal(f.writes(),count,'migration is one-time');
  }
});

test('modern HP nature patch mirrors alias; revision2 stale aliases and invalid HP IV/extra defense HP reject',async()=>{
  const state=createStore({}).defaults();state.controls.hpNature=true;state.controls.doubleLife=false;
  const invalid=fixture({state});await assert.rejects(invalid.store.init(),/无效/);assert.equal(invalid.writes(),0);
  state.controls.doubleLife=true;
  const f=fixture({state});await f.store.init();assert.equal(f.store.getState().controls.doubleLife,true);
  await f.store.setControls({doubleLife:false});assert.equal(f.store.getState().controls.hpNature,false);
  await f.store.setControls({hpNature:true,doubleLife:false});assert.equal(f.store.getState().controls.hpNature,true);
  const before=f.saved();await assert.rejects(f.store.setControls({hpIV:false}),/固定开启/);
  await assert.rejects(f.store.setControls({defIV:{hp:false}}),/无效/);assert.deepEqual(f.saved(),before);
});

test('dynamic membership uses exact current operating damage, same eligible pool, strict damage<HP and fresh context',async()=>{
  const f=fixture();await f.store.init();
  let power=0, hpNature=false, attackIV=true;
  f.store.setSurvivalContextProvider(()=>{
    const context={mode:'attack',atkPet:f.pets()[0],attackType:'attack',qualification:120,power,sameType:1,hpNature,skillAttr:'Fire'};
    const values={atkIV:attackIV,atkNature:0,defIV:true,defNature:0};
    return pet=>math.operatingPoint(context,pet,values,f.data,BattleMath);
  });
  const expected=()=>{
    const eligible=f.pets().filter(p=>!p.hidden&&!p.is_leader_form&&p.evolution_stage==='高级形态'&&['主形态','无多形态'].includes(p.form_category));
    const attack=BattleMath.statFromBase(120,'attack',0,attackIV);
    return [...new Set(eligible.filter(p=>BattleMath.normalDamage(attack,power,f.data.getPetStat(p,'defense',0,true),1,1,60,f.data.getTypeEff('Fire',p.main_type.name))<f.data.getPetStat(p,'hp',hpNature?1:0,true)).map(p=>p.id))];
  };
  await f.store.selectGroup('preset:Survivors');const writes=f.writes();
  const memberships=[];
  for(const p of [0,490,700,1000])for(const n of [false,true])for(const iv of [true,false]) {
    power=p;hpNature=n;attackIV=iv;
    const ids=f.store.getEntries().map(e=>e.id);assert.deepEqual(ids,expected());memberships.push(ids.join(','));
  }
  assert.ok(new Set(memberships).size>=3);assert.equal(f.writes(),writes);
  assert.deepEqual(f.saved().state.groups,[{id:'ungrouped',name:'未分组',petIds:[]}]);
  f.store.setSurvivalContextProvider(()=>pet=>({hp:100,damage:pet.id===2?99:100}));
  assert.deepEqual(f.store.getEntries().map(e=>e.id),[2],'equal HP is kill, not survivor');
});

test('missing/invalid/recursive context is explicitly unavailable, never fake empty list or saved bad snapshot',async()=>{
  const f=fixture();await f.store.init();const before=f.saved(),writes=f.writes();
  await assert.rejects(f.store.selectGroup('preset:Survivors'),/上下文不可用/);
  await assert.rejects(f.store.importPreset('preset:Survivors','ungrouped'),/上下文不可用/);
  await assert.rejects(f.store.copyGroup('preset:Survivors','bad'),/上下文不可用/);
  for(const provider of [()=>null,()=>()=>({hp:NaN,damage:10}),()=>()=>({hp:100,damage:-1}),()=>()=>f.store.getPreset('preset:Survivors')]) {
    f.store.setSurvivalContextProvider(provider);assert.throws(()=>f.store.getPreset('preset:Survivors'),/不可用|递归/);
  }
  assert.deepEqual(f.saved(),before);assert.equal(f.writes(),writes);assert.equal(f.store.getStatus().pendingWrite,false);
  const saved=createStore({}).defaults();saved.activeGroupId='preset:Survivors';const cold=fixture({state:saved});await cold.store.init();
  assert.throws(()=>cold.store.getEntries(),/上下文不可用/);assert.equal(cold.writes(),0,'cold unavailable selection remains intact');
});

test('import appends current snapshot in order, dedups stable IDs, preserves members and retries exact failed snapshot',async()=>{
  const f=fixture();await f.store.init();const target=await f.store.createGroup('自建');await f.store.addPet(99);await f.store.addPet(7);
  let include=true;f.store.setSurvivalContextProvider(()=>p=>({hp:100,damage:include&&p.id!==2?99:100}));
  const before=f.saved();f.fail(true);await assert.rejects(f.store.importPreset('preset:Survivors',target),/未保存/);
  assert.deepEqual(f.saved(),before);assert.deepEqual(f.store.getState(),before.state);
  await assert.rejects(f.store.addPet(101),/先重试/);
  include=false;f.replace([]);f.fail(false);await f.store.retry();
  assert.deepEqual(f.store.getEntries().map(e=>e.id),[99,7,1],'retry uses the accepted snapshot, not changed source');
  assert.equal(f.store.getState().activeGroupId,target);
  await f.store.importPreset('preset:Survivors',target);assert.deepEqual(f.store.getEntries().map(e=>e.id),[99,7,1],'empty live preset never removes saved members');
});

test('ordinary and dynamic imports serialize with edits; copy snapshots remain independently editable',async()=>{
  const f=fixture();await f.store.init();const id=await f.store.createGroup('target');
  await Promise.all([f.store.addPet(99),f.store.importPreset('preset:Fire',id),f.store.addPet(88),f.store.importPreset('preset:Fire',id)]);
  assert.deepEqual(f.store.getEntries().map(e=>e.id),[99,1,7,88]);
  f.store.setSurvivalContextProvider(()=>()=>({hp:1,damage:0}));
  await f.store.importPreset('preset:Survivors',id);assert.deepEqual(f.store.getEntries().map(e=>e.id),[99,1,7,88,2]);
  await f.store.selectGroup('preset:Survivors');const copy=await f.store.copyGroup('preset:Survivors','snapshot');
  assert.ok(copy.startsWith('g_'));assert.deepEqual(f.store.getEntries().map(e=>e.id),[1,2,7]);
  f.replace([]);assert.deepEqual(f.store.getEntries().map(e=>e.id),[1,2,7]);
  await f.store.removePet(2);assert.deepEqual(f.store.getEntries().map(e=>e.id),[1,7]);
  await assert.rejects(f.store.importPreset('preset:Fire','preset:Survivors'),/只读/);
  assert.equal(f.store.getPresets().filter(p=>p.type).length,18);
  assert.deepEqual(f.store.getPresets().find(p=>p.dynamic),{id:'preset:Survivors',name:'斩杀预设',readonly:true,dynamic:true});
});

test('survivor availability reports full 99/100/101 counts; all store entry points enforce cap, then recover without stale cache',async()=>{
  const f=fixture();await f.store.init();const common=f.pets()[0];
  f.replace(Array.from({length:151},(_,i)=>({...common,id:i+1})));
  let count=99,calls=0;
  const evaluator=pet=>{calls++;return {hp:100,damage:pet.id<=count?99:100};};
  f.store.setSurvivalContextProvider(()=>evaluator);
  assert.equal(f.store.getPresets().length,20);assert.equal(calls,0,'descriptors never derive recursively');
  for(const n of [99,100,101,151,100,0,101,99]) {
    count=n;
    const availability=f.store.getPresetAvailability('preset:Survivors');
    assert.deepEqual(availability,{disabled:n>100,label:n>100?'不可斩杀精灵过多':'斩杀预设',
      count:n,reason:n>100?'不可斩杀精灵过多':''});
    if(n>100) {
      const before=f.saved(),writes=f.writes();
      assert.throws(()=>f.store.getPreset('preset:Survivors'),/不可斩杀精灵过多/);
      assert.throws(()=>f.store.getEntries(),/不可斩杀精灵过多/,'active preset fails explicitly');
      for(const action of [()=>f.store.selectGroup('preset:Survivors'),()=>f.store.copyGroup('preset:Survivors','too many'),
        ()=>f.store.importPreset('preset:Survivors','ungrouped')]) await assert.rejects(action,/不可斩杀精灵过多/);
      assert.equal(f.writes(),writes);assert.deepEqual(f.saved(),before);
    } else {
      await f.store.selectGroup('preset:Survivors');
      assert.equal(f.store.getEntries().length,n);assert.equal(f.store.getPreset('preset:Survivors').petIds.length,n);
    }
  }
  f.store.setSurvivalContextProvider(null);
  const unavailable=f.store.getPresetAvailability('preset:Survivors');
  assert.equal(unavailable.disabled,true);assert.equal(unavailable.count,null);assert.match(unavailable.reason,/上下文不可用/);
  assert.throws(()=>f.store.getEntries(),/上下文不可用/);
  f.store.setSurvivalContextProvider(()=>evaluator);assert.equal(f.store.getPresetAvailability('preset:Survivors').count,99);
  f.pets().splice(0,20);assert.equal(f.store.getPresetAvailability('preset:Survivors').count,79,'in-place catalog mutations invalidate results');
  f.replace([]);assert.deepEqual(f.store.getPresetAvailability('preset:Survivors'),{
    disabled:false,label:'斩杀预设',count:0,reason:''});
});

test('availability never reuses cached valid membership after data/evaluator errors or recursion',async()=>{
  const f=fixture();await f.store.init();let invalid=false;
  f.store.setSurvivalContextProvider(()=>p=>({hp:100,damage:invalid?NaN:0}));
  assert.equal(f.store.getPresetAvailability('preset:Survivors').count,3);invalid=true;
  assert.equal(f.store.getPresetAvailability('preset:Survivors').count,null);
  invalid=false;assert.equal(f.store.getPresetAvailability('preset:Survivors').count,3);
  f.store.setSurvivalContextProvider(()=>()=>f.store.getPreset('preset:Survivors'));
  assert.match(f.store.getPresetAvailability('preset:Survivors').reason,/递归/);
  assert.equal(f.store.getPresets().length,20);
  delete f.root.RKData;assert.match(f.store.getPresetAvailability('preset:Fire').reason,/尚未加载/);
});
