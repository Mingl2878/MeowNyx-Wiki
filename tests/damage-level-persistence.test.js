'use strict';
// Actual UserConfig queue + DamagePage, with an in-memory fake transport only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {damageUI}=require('./damage-levels-ui-fixture.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
async function setup() {
  const initial={rk_damage_levels:{619:{metadata:{keep:true},attacker:{slider:99,manual:'43',extension:'attacker'},defender:{slider:19,manual:'',extension:'defender'}},77:{attacker:{slider:60,manual:''}}},rk_pet_configs:{619:{mode:1,iv:{hp:false},nature:{hp:2}}},rk_damage_skill_configs:{619:{basePower:0,finalPowerManual:'0'}},rk_damage_view:{skill:{basePower:0}},rk_damage_selection:{attacker:619,defender:619}};
  const server={data:clone(initial),fail:false,writes:[],gate:null};
  const store=new Map(),close=[];
  const context={localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value)},setTimeout,clearTimeout,AbortController,addEventListener(){},__xhmCloseReady:ok=>close.push(ok),async fetch(_url,options={}) {
    const body=options.body&&JSON.parse(options.body);
    if(body){server.writes.push(body);if(server.gate)await server.gate;if(server.fail)return{ok:false,json:async()=>({ok:false,error:'isolated failed save'})};
      for(const [key,fields]of Object.entries(body.patch||{}))server.data[key]={...server.data[key],...clone(fields)};
    }
    return{ok:true,json:async()=>({ok:true,data:clone(server.data),legacy_imported:true,legacy_imported_keys:Object.fromEntries(['rk_damage_skill_configs','rk_damage_view','rk_chart_workspace','rk_damage_levels','rk_skill_simulation'].map(k=>[k,true]))})};
  }};
  context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/user-config.js'),'utf8'),context);
  const UserConfig=context.UserConfig;assert.equal(await UserConfig.init(),true);
  const h=damageUI({UserConfig});h.state.atkPet=h.monsters[3];h.state.defPet=h.monsters[3];h.page.levelUI.updateFinalStats('attacker');h.page.levelUI.updateFinalStats('defender');
  return{h,api:h.page.CalcEngine,UserConfig,server,initial,close};
}
test('loading old manual memory is read-only; failed control save keeps visible draft and retry/close flush',async()=>{
  const {h,api,UserConfig,server,initial,close}=await setup();
  assert.equal(api.effectiveLevel('attacker'),43);assert.equal(server.writes.length,0);assert.deepEqual(server.data,initial);
  server.fail=true;
  assert.equal(await api.stepLevelPreference('attacker',1),false);assert.equal(api.effectiveLevel('attacker'),49);
  assert.equal(h.node('attacker','level-value').textContent,'lv：49');assert.equal(api.levelRecord('attacker').manual,'');
  assert.deepEqual(server.data,initial);assert.match(UserConfig.getStatus().error,/isolated failed save/);
  assert.equal(await UserConfig.requestClose(),false);assert.deepEqual(close,[false]);
  // A second side and another active change must merge the current queued draft.
  assert.equal(await api.setLevelPreference('defender',{slider:29}),false);
  assert.equal(await api.stepLevelPreference('attacker',1),false);assert.equal(api.effectiveLevel('attacker'),59);
  server.fail=false;assert.equal(await UserConfig.retry(),true);assert.equal(await UserConfig.flush(),true);
  assert.equal(await UserConfig.requestClose(),true);assert.deepEqual(close,[false,true]);
  assert.equal(server.data.rk_damage_levels[619].attacker.slider,59);assert.equal(server.data.rk_damage_levels[619].attacker.manual,'');
  assert.equal(server.data.rk_damage_levels[619].defender.slider,29);
  assert.equal(server.data.rk_damage_levels[619].attacker.extension,'attacker');assert.equal(server.data.rk_damage_levels[619].defender.extension,'defender');
  assert.deepEqual(server.data.rk_damage_levels[619].metadata,{keep:true});assert.deepEqual(server.data.rk_damage_levels[77],initial.rk_damage_levels[77]);
  for(const key of Object.keys(initial).filter(key=>key!=='rk_damage_levels'))assert.deepEqual(server.data[key],initial[key]);
  assert.ok(server.writes.every(body=>Object.keys(body.patch).join()==='rk_damage_levels'));
  const restored=damageUI({memory:server.data});restored.state.atkPet=restored.monsters[3];
  assert.equal(restored.page.CalcEngine.effectiveLevel('attacker'),59);assert.equal(restored.writes.length,0);
});
test('in-flight consecutive +/- uses pending effective levels and preserves later updates to the other side',async()=>{
  const {api,UserConfig,server,initial}=await setup();let release;
  server.gate=new Promise(resolve=>{release=resolve;});
  const one=api.stepLevelPreference('attacker',-1);assert.equal(api.effectiveLevel('attacker'),39);
  const two=api.stepLevelPreference('attacker',-1);assert.equal(api.effectiveLevel('attacker'),29);
  const three=api.stepLevelPreference('defender',1);assert.equal(api.effectiveLevel('defender'),29);
  assert.deepEqual(server.data,initial);
  server.gate=null;release();assert.deepEqual(await Promise.all([one,two,three]),[true,true,true]);assert.equal(await UserConfig.flush(),true);
  assert.equal(server.data.rk_damage_levels[619].attacker.slider,29);assert.equal(server.data.rk_damage_levels[619].defender.slider,29);
  assert.equal(server.data.rk_damage_levels[619].attacker.extension,'attacker');assert.equal(server.data.rk_damage_levels[619].defender.extension,'defender');
});
