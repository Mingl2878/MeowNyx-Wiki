'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const userSource=fs.readFileSync(require.resolve('../js/user-config.js'),'utf8');
const chartSource=fs.readFileSync(require.resolve('../js/chart-workspace.js'),'utf8');
const copy=x=>JSON.parse(JSON.stringify(x));
async function fixture(){
  const server={data:{},fail:false};
  const storage=new Map([['rk_chart_fav_pets','[249,327]']]), listeners=new Map();
  const c={setTimeout,clearTimeout,AbortController,console,
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},
    CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts?.detail;}},
    addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
    removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
    dispatchEvent(e){for(const fn of listeners.get(e.type)||[])fn(e);},
    async fetch(url,options={}){
      if(server.fail)return {ok:false,json:async()=>({ok:false,error:'disk failure'})};
      const body=options.body&&JSON.parse(options.body);
      if(body?.patch)for(const [key,fields]of Object.entries(body.patch))server.data[key]={...server.data[key],...copy(fields)};
      return {ok:true,json:async()=>({ok:true,data:copy(server.data),legacy_imported:true,legacy_imported_keys:{rk_damage_skill_configs:true,rk_damage_view:true,rk_chart_workspace:true}})};
    }
  };c.window=c;vm.createContext(c);vm.runInContext(userSource,c);assert.equal(await c.UserConfig.init(),true);
  vm.runInContext(chartSource,c);
  return {server,c,store:c.ChartWorkspace,user:c.UserConfig,listeners};
}

test('real UserConfig global retry adopts committed curve state and prevents draft overwrite',async()=>{
  const e=await fixture();await e.store.init();const id=await e.store.createGroup('before');
  const old=copy(e.store.getState());e.server.fail=true;
  await assert.rejects(e.store.renameGroup(id,'after'),/未保存/);
  assert.equal(e.user.getObject('rk_chart_workspace').state.groups.find(g=>g.id===id).name,'after','UserConfig exposes pending draft');
  assert.deepEqual(copy(e.store.getState()),old,'store refuses draft adoption');
  await assert.rejects(e.store.addPet(434),/先重试/);
  assert.equal(e.server.data.rk_chart_workspace.state.groups.find(g=>g.id===id).name,'before');
  e.server.fail=false;assert.equal(await e.user.retry(),true);
  assert.equal(e.store.getState().groups.find(g=>g.id===id).name,'after');
  assert.equal(e.store.getStatus().pendingWrite,false);assert.equal(e.store.getStatus().error,'');
  await e.store.addPet(434);
  assert.equal(e.server.data.rk_chart_workspace.state.groups.find(g=>g.id===id).name,'after','next operation preserves retried data');
  assert.deepEqual(e.server.data.rk_chart_workspace.state.groups.find(g=>g.id===id).petIds,[434]);
});

test('first migration pendingInitial clears after global retry, not duplicated or resurrected',async()=>{
  const e=await fixture();e.server.fail=true;await assert.rejects(e.store.init());
  assert.equal(e.store.getStatus().initialized,false);assert.deepEqual(copy(e.store.getEntries()),[]);
  e.server.fail=false;await e.user.retry();
  assert.equal(e.store.getStatus().initialized,true);assert.deepEqual(copy(e.store.getEntries().map(e=>e.id)),[249,327]);
  await e.store.removePet(249);await e.store.init();assert.deepEqual(copy(e.store.getEntries().map(e=>e.id)),[327]);
});

test('curve adoption waits for whole queue to drain then reconciles even when last key was another group',async()=>{
  const e=await fixture();await e.store.init();e.server.fail=true;
  await assert.rejects(e.store.setControls({doubleLife:true}));
  await e.user.patch('rk_damage_selection',{attacker:202});
  assert.equal(e.store.getState().controls.doubleLife,false);
  e.server.fail=false;await e.user.retry();
  assert.equal(e.store.getState().controls.doubleLife,true);
  assert.equal(e.user.getStatus().pending,0);assert.equal(e.store.getStatus().pendingWrite,false);
});

test('curve retry button uses real UserConfig queue without pretending failed draft succeeded',async()=>{
  const e=await fixture();await e.store.init();e.server.fail=true;
  await assert.rejects(e.store.setControls({atkNature:{attack:2}}));
  await assert.rejects(e.store.retry());assert.equal(e.store.getState().controls.atkNature.attack,0);
  e.server.fail=false;await e.store.retry();assert.equal(e.store.getState().controls.atkNature.attack,2);
  assert.equal(e.user.getStatus().pending,0);assert.equal(e.server.data.rk_chart_workspace.state.controls.atkNature.attack,2);
  e.store.dispose();assert.equal(e.listeners.get('userconfigchange').size,0);
});
