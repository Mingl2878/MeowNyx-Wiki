'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),copy=v=>JSON.parse(JSON.stringify(v));
function profile(data){const calls=[];return {calls,getObject:(k,f={})=>copy(data[k]||f),patch(k,fields){calls.push([k,copy(fields)]);data[k]??={};for(const[a,v]of Object.entries(fields)){if(v===null)delete data[k][a];else data[k][a]=copy(v)}return Promise.resolve(true)}}}
function sandbox(data){const UserConfig=profile(data);const c={UserConfig,localStorage:{getItem(){throw Error('legacy cache not authoritative')},setItem(){throw Error('must use shared file')}},RKData:{},console};c.window=c;vm.createContext(c);return {c,UserConfig}}
test('speed view ignores former persistent state; priority order alone remains shared',()=>{
  const data={rk_speed_view:{iv:false,nature:false,negNature:true,showMonsters:false,fixed:-20,percent:0,search:'权杖-v',searchDisplay:'权杖-V',selectedCol:'negNature',selectedSpeed:136},rk_speed_pet_priority:{136:[249]},rk_speed_form_overrides:{foo:249}};
  const {c,UserConfig}=sandbox(data);let src=fs.readFileSync(path.join(root,'js/pages/speed.js'),'utf8');src=src.replace('return { render, onLeave };','return { render, onLeave, test: {tierState, recordPetSearch, setFormOverride, getPetPriority} };');vm.runInContext(src,c);const p=vm.runInContext('SpeedPage',c).test;
  assert.equal(p.tierState.iv,true);assert.equal(p.tierState.fixed,0);assert.equal(p.tierState.search,'');assert.equal(p.tierState.selectedSpeed,null);assert.equal(UserConfig.calls.length,0);
  p.tierState.iv=false;p.tierState.fixed=20;p.tierState.selectedCol='base';
  assert.equal(UserConfig.calls.length,0);assert.equal(data.rk_speed_view.fixed,-20);
  p.recordPetSearch({id:434,base_spd:136});assert.deepEqual(data.rk_speed_pet_priority[136],[434,249]);
  assert.deepEqual(copy(p.getPetPriority(136)),[434,249]);
});
test('damage personal config writes one stable-ID record and never clears unrelated saved pets',async()=>{
  const data={rk_pet_configs:{249:{iv:{hp:true},nature:{hp:1}},602:{iv:{magic_defense:true},nature:{hp:2}}}};
  const {c,UserConfig}=sandbox(data);let src=fs.readFileSync(path.join(root,'js/pages/damage.js'),'utf8');src=src.replace('return { render, onLeave, getState: () => state, CalcEngine };','return { render, onLeave, getState: () => state, CalcEngine, test: {loadPetConfig,savePetConfig,readSelection,saveSelection} };');vm.runInContext(src,c);const p=vm.runInContext('DamagePage',c).test;
  assert.equal(p.loadPetConfig(249).nature.hp,1);const before=copy(data.rk_pet_configs[602]);p.savePetConfig(249,{hp:2},{hp:false});await Promise.resolve();
  assert.deepEqual(data.rk_pet_configs[602],before);assert.equal(UserConfig.calls[0][0],'rk_pet_configs');assert.equal(data.rk_pet_configs[249].mode,1);assert.equal(data.rk_pet_configs[249].iv.hp,false);assert.equal(data.rk_pet_configs[249].nature.hp,2);assert.equal(Object.keys(data.rk_pet_configs[249].iv).length,6);
  p.saveSelection({attacker:249,attackerTeam:'group-1'});p.saveSelection({defender:602,defenderTeam:null});
  assert.deepEqual(copy(p.readSelection()),{attacker:249,attackerTeam:'group-1',defender:602});
});
