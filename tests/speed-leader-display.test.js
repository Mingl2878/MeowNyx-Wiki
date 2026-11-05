'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const helper=fs.readFileSync(path.join(__dirname,'../js/speed-leader-display.js'),'utf8');
const userConfig=fs.readFileSync(path.join(__dirname,'../js/user-config.js'),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));
const KEY='rk_speed_form_overrides', GROUP='leader:13:130';
const advanced=(id,speed,name='advanced')=>({id,name,base_spd:speed,evolution_stage:'高级形态'});
const leader=(id,from,speed,name='leader')=>({id,name,base_spd:speed,evolution_stage:'首领形态',is_leader_form:true,leader_of_id:from});
const pets=()=>[advanced(13,130,'火神'),leader(14,13,130,'烈火战神'),advanced(356,120,'爵士鹿'),leader(357,356,125,'波普鹿'),advanced(900,130,'无关同速')];
function runtime(saved={},extra={}){
  const memory=new Map([[KEY,JSON.stringify(saved)]]),writes=[];
  const c={console:{warn(){}},localStorage:{getItem:k=>memory.get(k)||null,setItem(k,v){writes.push({k,v});memory.set(k,v);}},...extra};c.window=c;
  vm.createContext(c);vm.runInContext(helper,c);
  return{c,api:c.SpeedLeaderDisplay,memory,writes};
}
const visible=(r,list)=>[...r.api.visibleIds(list)].sort((a,b)=>a-b);

function server(data={}){
  return{data:clone(data),calls:[],fail:false,gate:null,async fetch(url,options={}){
    const body=options.body&&JSON.parse(options.body);this.calls.push({url,body});
    if(body?.patch&&this.gate){const gate=this.gate;this.gate=null;await gate;}
    if(this.fail)return{ok:false,json:async()=>({ok:false,error:'isolated simulated save failure'})};
    for(const [section,fields]of Object.entries(body?.patch||{})){
      this.data[section]??={};for(const [key,value]of Object.entries(fields)){
        if(value===null)delete this.data[section][key];else this.data[section][key]=clone(value);
      }
    }
    return{ok:true,json:async()=>({ok:true,data:clone(this.data),legacy_imported:true,legacy_imported_keys:Object.fromEntries(['rk_damage_skill_configs','rk_damage_view','rk_chart_workspace','rk_damage_levels','rk_skill_simulation'].map(k=>[k,true]))})};
  }};
}
function native(s,legacy={}){
  const r=runtime(legacy,{fetch:s.fetch.bind(s),setTimeout,clearTimeout,AbortController,addEventListener(){},dispatchEvent(){},CustomEvent:class{}});
  vm.runInContext(userConfig,r.c);
  return r;
}

test('default advanced, exact explicit leader relation, different speed and unrelated same-speed pets remain separate',()=>{
  const r=runtime(),list=pets(),before=JSON.stringify(list);
  assert.deepEqual(visible(r,list),[13,356,357,900]);
  assert.deepEqual([...r.api.preferredIds(list)],[13]);
  assert.equal(r.api.groups(list).length,1);
  assert.equal(JSON.stringify(list),before);assert.equal(r.writes.length,0);
});

test('same-name, evolution members, main-form identity and malformed relations never invent a leader group',()=>{
  const list=[advanced(1,130,'火神'),{...leader(2,999,130,'火神'),evolution_members:[1,2]},
    {...advanced(3,130,'火神'),main_form_id:1},leader(4,1,125),{...leader(5,1,130),hidden:true},
    {...leader(6,1,130),leader_of_id:'1'},leader(7,8,130),{...advanced(8,130),evolution_stage:'基础形态'}];
  const r=runtime();assert.equal(r.api.groups(list).length,0);assert.deepEqual(visible(r,list),list.map(p=>p.id).sort((a,b)=>a-b));
});

test('multiple same-speed leaders share only their explicit advanced group; invalid saved members fall back without writes',async()=>{
  const list=[...pets(),leader(15,13,130)];
  for(const saved of [{[GROUP]:999},{[GROUP]:'not-an-id'},{[GROUP]:true},{[GROUP]:null}]){
    const r=runtime(saved);assert.deepEqual(visible(r,list),[13,356,357,900]);assert.equal(r.writes.length,0);
  }
  for(const value of ['14','+14','014']) {
    const restored=runtime({[GROUP]:value});assert.ok(restored.api.visibleIds(list).has(14));
    assert.ok(!restored.api.visibleIds(list).has(13));assert.equal(restored.writes.length,0);
  }
  const r=runtime();await r.api.recordSearch(list.find(p=>p.id===15),list);
  assert.deepEqual(visible(r,list),[15,356,357,900]);
  await r.api.recordSearch(list[0],list);assert.deepEqual(visible(r,list),[13,356,357,900]);
  const changed=clone(list);changed.find(p=>p.id===14).base_spd=125;
  assert.ok(visible(r,changed).includes(14),'different speed ceases to be suppressed');
});

test('search choice preserves unrelated form fields and ignores old damage/speed priorities',async()=>{
  const original={'same-name|default|130':900,'other|default|60':88};
  const r=runtime(original,{DamagePage:{getState:()=>({searchedPets:[14]})}}),list=pets();
  r.memory.set('rk_speed_pet_priority',JSON.stringify({130:[14]}));
  await r.api.recordSearch(list[1],list);assert.deepEqual(visible(r,list),[14,356,357,900]);
  await r.api.recordSearch(list[0],list);assert.deepEqual(visible(r,list),[13,356,357,900]);
  assert.deepEqual(JSON.parse(r.memory.get(KEY)),{...original,[GROUP]:13});
  const before=r.writes.length;
  await r.api.recordSearch(list[0],list);await r.api.recordSearch(list[3],list);
  assert.equal(r.writes.length,before,'same choice/different speed cause no redundant writes');
});

test('real UserConfig makes newer cross-page search visible before saves complete and persists only group key',async()=>{
  const s=server({[KEY]:{'form|default|130':77},rk_pet_configs:{13:{mode:1}},rk_damage_levels:{619:{attacker:{slider:79}}}}),r=native(s),list=pets();
  assert.equal(await r.c.UserConfig.init(),true);const before=clone(s.data);
  let release;s.gate=new Promise(resolve=>{release=resolve;});
  const damageSearch=r.api.recordSearch(list[1],list);
  assert.ok(r.api.visibleIds(list).has(14),'optimistic choice is synchronous');
  const speedSearch=r.api.recordSearch(list[0],list);
  assert.ok(r.api.visibleIds(list).has(13));assert.ok(!r.api.visibleIds(list).has(14));
  release();assert.deepEqual(await Promise.all([damageSearch,speedSearch]),[true,true]);
  assert.equal(await r.c.UserConfig.flush(),true);
  assert.deepEqual(s.data,{...before,[KEY]:{...before[KEY],[GROUP]:13}});
  const writes=s.calls.filter(c=>c.body?.patch);
  assert.deepEqual(writes.map(c=>c.body.patch),[{[KEY]:{[GROUP]:14}},{[KEY]:{[GROUP]:13}}]);
  const restarted=native(s,{[GROUP]:14});await restarted.c.UserConfig.init();
  assert.ok(restarted.api.visibleIds(list).has(13),'stale local cache cannot override durable latest choice');
});

test('failed choice keeps the latest draft and existing save retry/close protection, without touching other settings',async()=>{
  const s=server({[KEY]:{[GROUP]:13,'form|default|130':77},future:{keep:true}}),r=native(s),list=pets();
  await r.c.UserConfig.init();const before=clone(s.data);s.fail=true;
  assert.equal(await r.api.recordSearch(list[1],list),false);
  assert.deepEqual(s.data,before);assert.ok(r.api.visibleIds(list).has(14));
  assert.equal(await r.c.UserConfig.flush(),false);assert.ok(r.c.UserConfig.getStatus().error);
  assert.equal(await r.api.recordSearch(list[0],list),false);
  assert.ok(r.api.visibleIds(list).has(13),'newer selection wins while prior save failed');
  s.fail=false;assert.equal(await r.c.UserConfig.retry(),true);assert.deepEqual(s.data,before);
});

test('storage fallback remains session-correct on failure and does not shadow later stored choices after success',async()=>{
  const r=runtime(),list=pets();const set=r.c.localStorage.setItem;
  r.c.localStorage.setItem=()=>{throw Error('isolated storage failure');};
  assert.equal(await r.api.recordSearch(list[1],list),false);assert.ok(r.api.visibleIds(list).has(14));
  r.c.localStorage.setItem=set;assert.equal(await r.api.recordSearch(list[0],list),true);
  r.memory.set(KEY,JSON.stringify({[GROUP]:14}));assert.ok(r.api.visibleIds(list).has(14));
});

test('latest search choice outranks advanced default through both page directions, clears and restarts',async()=>{
  const list=pets(),s=server({[KEY]:{'other|default|50':77}}),r=native(s);
  await r.c.UserConfig.init();
  const chosen=api=>[...api.visibleIds(list)].filter(id=>id===13||id===14);
  assert.deepEqual(chosen(r.api),[13],'no valid selection is the only default case');
  await r.api.recordSearch(list[1],list);assert.deepEqual(chosen(r.api),[14],'damage selected leader');
  await r.api.recordSearch(list[0],list);assert.deepEqual(chosen(r.api),[13],'speed selected advanced later');
  await r.api.recordSearch(list[1],list);assert.deepEqual(chosen(r.api),[14],'newest damage search wins again');
  const writes=s.calls.filter(c=>c.body?.patch).length;
  r.c.DamagePage={getState:()=>({searchedPets:[]})};
  r.memory.set('rk_searched_pets',JSON.stringify([13]));
  r.memory.set('rk_speed_pet_priority',JSON.stringify({130:[13]}));
  for(let i=0;i<5;i++)assert.deepEqual(chosen(r.api),[14],'clear/reentry/default evaluation cannot overwrite a valid choice');
  assert.equal(s.calls.filter(c=>c.body?.patch).length,writes,'read/default paths never save another choice');
  const restarted=native(s,{[GROUP]:13});await restarted.c.UserConfig.init();
  assert.deepEqual(chosen(restarted.api),[14],'stored leader must outrank default on the first render after restart');
  assert.deepEqual(s.data[KEY],{'other|default|50':77,[GROUP]:14});
});

test('actual catalog pairs match confirmed display rules and remain unmodified',()=>{
  const list=require('./catalog-read-fixture.cjs').readProjectData('monsters.json'),before=JSON.stringify(list),r=runtime();
  const ids=r.api.visibleIds(list);assert.ok(ids.has(13));assert.ok(!ids.has(14));
  for(const id of [8,10,70,71,356,357])assert.ok(ids.has(id),`different-speed member ${id}`);
  assert.equal(JSON.stringify(list),before);
});

test('shared choice module is loaded once after UserConfig and before both page consumers',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  assert.equal((html.match(/src="js\/speed-leader-display\.js/g)||[]).length,1);
  const at=html.indexOf('src="js/speed-leader-display.js');
  assert.ok(at>html.indexOf('src="js/user-config.js'));
  assert.ok(at<html.indexOf('src="js/pages/speed.js'));assert.ok(at<html.indexOf('src="js/pages/damage.js'));
});
