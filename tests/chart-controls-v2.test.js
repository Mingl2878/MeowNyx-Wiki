'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createStore} = require('../js/chart-workspace.js');
const copy = value => JSON.parse(JSON.stringify(value));
const KEY = 'rk_chart_workspace';
function legacy(revision) {
  const state = createStore({}).defaults();
  if (revision === undefined) delete state.controlsRevision; else state.controlsRevision = revision;
  state.groups = [{id:'ungrouped',name:'未分组',petIds:[3,1],future:{keep:true}},
    {id:'custom',name:'保留',petIds:[1,2],metadata:['unchanged']}];
  state.activeGroupId = 'custom'; state.future = {keep:[1,2]};
  Object.assign(state.controls, {atkIV:{attack:false,magic_attack:false},atkNature:{attack:2,magic_attack:1},
    defIV:{defense:true,magic_defense:true},hpNature:true,doubleLife:true,hpIV:true,future:{keep:7}});
  return state;
}
function fixture(state) {
  let saved = {state:copy(state)}, fail = false;
  const writes = [];
  const root = {UserConfig:{getObject:key=>{assert.equal(key,KEY);return copy(saved);},
    patch:async(key,patch)=>{assert.equal(key,KEY);writes.push(copy(patch));if(fail)return false;saved=copy(patch);return true;}}};
  return {root,store:createStore(root),writes,saved:()=>copy(saved),fail:value=>fail=value};
}

test('missing/older revision resets ONLY curve controls once; groups/selection/metadata and valid v2 choices survive revisits/reload',async()=>{
  for (const revision of [undefined,0,1]) {
    const before=legacy(revision), f=fixture(before);await f.store.init();
    const expected=copy(before);Object.assign(expected.controls,f.store.defaults().controls);expected.controlsRevision=2;
    assert.deepEqual(f.store.getState(),expected);assert.equal(f.writes.length,1);
    assert.deepEqual(f.writes[0],{state:expected});
    await f.store.setControls({atkNature:{attack:1},atkIV:{magic_attack:false},defIV:{defense:true},hpNature:true});
    await f.store.selectGroup('ungrouped');await f.store.selectGroup('custom');
    const chosen=f.store.getState(), count=f.writes.length;
    await f.store.init();const reloaded=createStore(f.root);await reloaded.init();
    assert.deepEqual(reloaded.getState(),chosen);assert.equal(f.writes.length,count);
    assert.equal(chosen.controls.atkNature.attack,1);assert.equal(chosen.controls.hpNature,true);
    assert.deepEqual(chosen.groups,before.groups);assert.deepEqual(chosen.controls.future,before.controls.future);
  }
});

test('failed reset retries exact snapshot with marker, preserving committed bytes and not resetting subsequent choices',async()=>{
  const old=legacy(),f=fixture(old);f.fail(true);
  await assert.rejects(f.store.init(),/未保存/);assert.equal(f.store.getStatus().initialized,false);
  assert.deepEqual(f.saved(),{state:old});assert.equal(f.writes[0].state.controlsRevision,2);
  await assert.rejects(f.store.init(),/未保存/);assert.deepEqual(f.writes[1],f.writes[0]);
  f.fail(false);await f.store.retry();assert.deepEqual(f.writes[2],f.writes[0]);
  await f.store.setControls({atkIV:{attack:false},defIV:{magic_defense:true},hpNature:true});
  const committed=f.saved(),count=f.writes.length;const reload=createStore(f.root);await reload.init();
  assert.deepEqual(reload.getState(),committed.state);assert.equal(f.writes.length,count);
});

test('unknown/future revisions and invalid revision2 controls fail closed with no reset/write',async()=>{
  const mutations=[...[-1,3,99,null,'2',1.5].map(value=>s=>s.controlsRevision=value),
    s=>s.controls.atkNature.attack=2,s=>s.controls.atkNature.magic_attack=-1,
    s=>{s.controls.atkIV.attack=false;s.controls.atkNature.attack=1;},
    s=>{s.controls.atkIV.magic_attack=false;s.controls.atkNature.magic_attack=1;},
    s=>delete s.controls.atkIV.attack,s=>s.controls.hpIV=false,s=>s.controls.doubleLife=true,
    s=>delete s.controls.hpNature,s=>delete s.controls.doubleLife];
  for(const mutate of mutations) {
    const state=createStore({}).defaults();mutate(state);const f=fixture(state);
    await assert.rejects(f.store.init());assert.equal(f.writes.length,0);assert.deepEqual(f.saved(),{state});
  }
});

test('attack IV and positive nature link atomically for both stats; contradictions/negative/invalid patches never commit',async()=>{
  const f=fixture(createStore({}).defaults());await f.store.init();
  for(const stat of ['attack','magic_attack']) {
    await f.store.setControls({atkIV:{[stat]:false}});
    await f.store.setControls({atkNature:{[stat]:1}});
    assert.equal(f.store.getState().controls.atkIV[stat],true);
    assert.equal(f.store.getState().controls.atkNature[stat],1);
    const old=f.store.getState();f.fail(true);await assert.rejects(f.store.setControls({atkIV:{[stat]:false}}));
    assert.deepEqual(f.store.getState(),old);
    const pending=f.writes.at(-1).state.controls;assert.equal(pending.atkIV[stat],false);assert.equal(pending.atkNature[stat],0);
    f.fail(false);await f.store.retry();
    assert.equal(f.store.getState().controls.atkIV[stat],false);assert.equal(f.store.getState().controls.atkNature[stat],0);
    const before=f.saved(),count=f.writes.length;
    for(const patch of [{atkIV:{[stat]:false},atkNature:{[stat]:1}},
      {atkIV:{[stat]:false},atkNature:{[stat]:2}},{atkNature:{[stat]:-1}},
      {atkIV:{[stat]:0},atkNature:{[stat]:1}},{hpIV:false},{atkNature:null},{atkIV:[]},null])
      await assert.rejects(f.store.setControls(patch));
    assert.equal(f.writes.length,count);assert.deepEqual(f.saved(),before);
    assert.equal(f.store.getStatus().pendingWrite,false);
  }
});

async function queuedFixture(initial) {
  const server={data:{[KEY]:{state:copy(initial)},rk_pet_configs:{'3':{nature:{hp:2},iv:{attack:false}}}},fail:false,requests:[]};
  const storage=new Map([['rk_fav_pets','[7,8]'],['rk_chart_fav_pets','[999]']]),listeners=new Map();
  const c={setTimeout,clearTimeout,AbortController,console,
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
    CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts?.detail;}},
    addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
    removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
    dispatchEvent(event){for(const fn of listeners.get(event.type)||[])fn(event);},
    async fetch(url,options={}) {
      const body=options.body&&JSON.parse(options.body);
      if(body?.patch)server.requests.push(copy(body.patch));
      if(server.fail)return {ok:false,json:async()=>({ok:false,error:'isolated disk failure'})};
      if(body?.patch)for(const [key,fields] of Object.entries(body.patch))server.data[key]={...server.data[key],...copy(fields)};
      return {ok:true,json:async()=>({ok:true,data:copy(server.data),legacy_imported:true,
        legacy_imported_keys:{rk_damage_skill_configs:true,rk_damage_view:true,rk_chart_workspace:true}})};
    }};
  c.window=c;vm.createContext(c);
  vm.runInContext(fs.readFileSync(require.resolve('../js/user-config.js'),'utf8'),c);
  assert.equal(await c.UserConfig.init(),true);
  vm.runInContext(fs.readFileSync(require.resolve('../js/chart-workspace.js'),'utf8'),c);
  return {server,c,storage,store:c.ChartWorkspace};
}

test('real UserConfig reset draft is never adopted until global retry drains queue; marker and protected data survive',async()=>{
  const old=legacy(),e=await queuedFixture(old),personal=copy(e.server.data.rk_pet_configs);
  e.server.fail=true;await assert.rejects(e.store.init());
  assert.equal(e.c.UserConfig.getObject(KEY).state.controlsRevision,2,'queue exposes draft marker');
  assert.equal(e.store.getStatus().initialized,false);assert.deepEqual(e.server.data[KEY].state,old);
  const draft=copy(e.c.UserConfig.getObject(KEY));
  e.server.fail=false;assert.equal(await e.c.UserConfig.retry(),true);
  assert.deepEqual(e.server.data[KEY],draft);assert.deepEqual(copy(e.store.getState()),draft.state);
  assert.equal(e.store.getStatus().pendingWrite,false);
  await e.store.setControls({atkNature:{attack:1},hpNature:true});
  const next=createStore(e.c),count=e.server.requests.length;await next.init();
  assert.equal(next.getState().controls.atkNature.attack,1);assert.equal(e.server.requests.length,count);
  assert.deepEqual(e.server.data.rk_pet_configs,personal);assert.equal(e.storage.get('rk_fav_pets'),'[7,8]');
  assert.equal(e.storage.get('rk_chart_fav_pets'),'[999]');
  assert.ok(e.server.requests.every(patch=>Object.keys(patch).every(key=>key===KEY)));
  e.store.dispose();next.dispose();
});

test('re-created store with queued revision2 draft does not misread its marker as committed',async()=>{
  const old=legacy(),e=await queuedFixture(old);e.server.fail=true;await assert.rejects(e.store.init());
  const next=createStore(e.c);await assert.rejects(next.init());assert.equal(next.getStatus().initialized,false);
  assert.deepEqual(e.server.data[KEY].state,old);
  e.server.fail=false;await next.retry();assert.equal(next.getState().controlsRevision,2);
  assert.equal(e.c.UserConfig.getStatus().pending,0);
  e.store.dispose();next.dispose();
});
