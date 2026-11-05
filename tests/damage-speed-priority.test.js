'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../js/damage-speed-priority.js'),'utf8');
const configSource=fs.readFileSync(path.join(__dirname,'../js/user-config.js'),'utf8');
const copy=x=>JSON.parse(JSON.stringify(x)),KEY='rk_damage_view',FIELD='speedPriority';
const upgrades=['rk_damage_skill_configs','rk_damage_view','rk_chart_workspace','rk_damage_levels','rk_skill_simulation'];
function server(data={}) {
  return {data:copy(data),calls:[],fail:false,gate:null,async fetch(url,options={}) {
    const body=options.body&&JSON.parse(options.body);this.calls.push(body);
    if(body?.patch&&this.gate){const gate=this.gate;this.gate=null;await gate;}
    if(this.fail)return{ok:false,json:async()=>({ok:false,error:'isolated disk failure'})};
    for(const [section,fields]of Object.entries(body?.patch||{}))this.data[section]={...this.data[section],...copy(fields)};
    return{ok:true,json:async()=>({ok:true,data:copy(this.data),legacy_imported:true,legacy_imported_keys:Object.fromEntries(upgrades.map(k=>[k,true]))})};
  }};
}
function client(s=null,initial={}) {
  const memory=new Map(Object.entries(initial).map(([k,v])=>[k,typeof v==='string'?v:JSON.stringify(v)])),writes=[];
  const c={console:{warn(){}},setTimeout,clearTimeout,AbortController,addEventListener(){},
    localStorage:{getItem:k=>memory.get(k)??null,setItem(k,v){writes.push({key:k,value:v});memory.set(k,String(v));}}};c.window=c;
  if(s)c.fetch=s.fetch.bind(s);
  vm.createContext(c);if(s)vm.runInContext(configSource,c);vm.runInContext(source,c);
  return{c,api:c.DamageSpeedPriority,memory,writes};
}
const order=(c,legacy)=>Array.from(c.api.read(legacy));

test('legacy history is only a sanitized read fallback, never a startup migration',()=>{
  const c=client(),legacy=[13,13,'488',9001,0,-1,true,'bad',225];
  assert.deepEqual(order(c,legacy),[13,488,225]);assert.deepEqual(legacy,[13,13,'488',9001,0,-1,true,'bad',225]);
  assert.equal(c.writes.length,0);assert.equal(c.api.limit,16);
  for(const bad of [null,{},'bad',[true],[9001],[1,1],Array.from({length:17},(_,i)=>i+1)]){
    c.memory.set(KEY,JSON.stringify({[FIELD]:bad,skill:{buff:20}}));assert.deepEqual(order(c,legacy),[13,488,225]);
  }
  assert.equal(c.writes.length,0);
});

test('first explicit choice seeds legacy order; repeated clicks deduplicate and stored order outranks visible history',async()=>{
  const c=client(null,{[KEY]:{skill:{buff:20,basePower:50},future:{keep:true}}}),legacy=[13,488,225];
  await c.api.record({id:13},legacy);assert.equal(c.writes.length,1,'first confirmation persists even if legacy already starts with this ID');
  await c.api.record({id:488},legacy);assert.deepEqual(order(c,[13,225,488]),[488,13,225]);
  await c.api.record({id:225},legacy);assert.deepEqual(order(c,[]),[225,488,13]);
  const count=c.writes.length;await c.api.record({id:225},legacy);assert.equal(c.writes.length,count);
  assert.deepEqual(JSON.parse(c.memory.get(KEY)),{skill:{buff:20,basePower:50},future:{keep:true},[FIELD]:[225,488,13]});
  assert.deepEqual(legacy,[13,488,225]);
  const returned=c.api.read();returned[0]=999;assert.deepEqual(order(c),[225,488,13],'read returns an isolated copy');
});

test('bounded16 numeric IDs exclude dummy/malformed selections and preserve explicit empty order',async()=>{
  const c=client(null,{[KEY]:{[FIELD]:[]}});
  assert.deepEqual(order(c,[13,488]),[]);
  for(const id of [undefined,null,0,-1,'488',true,1.5,9001,Number.MAX_SAFE_INTEGER+1])assert.equal(await c.api.record({id},[13]),false);
  assert.equal(c.writes.length,0);
  for(let id=1;id<=24;id++)await c.api.record({id},[488]);
  assert.deepEqual(order(c),Array.from({length:16},(_,i)=>24-i));
});

test('real UserConfig exposes queued priority immediately and preserves every sibling setting',async()=>{
  const initial={[KEY]:{skill:{buff:20},future:{preserve:true}},rk_speed_form_overrides:{'leader:13:130':14},rk_speed_pet_priority:{130:[13,14]},rk_pet_configs:{488:{mode:1}}};
  const s=server(initial),c=client(s);assert.equal(await c.c.UserConfig.init(),true);
  assert.deepEqual(order(c,[13,488]),[13,488]);assert.equal(s.calls.filter(Boolean).length,0);
  let release;s.gate=new Promise(resolve=>{release=resolve;});
  const first=c.api.record({id:488},[13,488]);assert.deepEqual(order(c,[13]),[488,13]);
  const second=c.api.record({id:225},[13,488]);assert.deepEqual(order(c,[13]),[225,488,13]);
  release();assert.deepEqual(await Promise.all([first,second]),[true,true]);assert.equal(await c.c.UserConfig.flush(),true);
  assert.deepEqual(s.data,{...initial,[KEY]:{...initial[KEY],[FIELD]:[225,488,13]}});
  assert.deepEqual(s.calls.filter(b=>b?.patch).map(b=>b.patch),[{[KEY]:{[FIELD]:[488,13]}},{[KEY]:{[FIELD]:[225,488,13]}}]);
  const restarted=client(s,{[KEY]:{[FIELD]:[13]}});await restarted.c.UserConfig.init();
  assert.deepEqual(order(restarted,[13]),[225,488,13],'durable order wins over stale cache and visible history');
});

test('failed native save retains newest draft and original skill until existing retry/flush succeeds',async()=>{
  const initial={[KEY]:{skill:{buff:-20},[FIELD]:[13]},rk_speed_form_overrides:{'leader:13:130':14}};
  const s=server(initial),c=client(s);await c.c.UserConfig.init();s.fail=true;
  assert.equal(await c.api.record({id:488},[13]),false);assert.deepEqual(order(c,[13]),[488,13]);assert.deepEqual(s.data,initial);
  assert.equal(await c.c.UserConfig.flush(),false);assert.ok(c.c.UserConfig.getStatus().error);
  assert.equal(await c.api.record({id:225},[13]),false);assert.deepEqual(order(c),[225,488,13]);
  s.fail=false;assert.equal(await c.c.UserConfig.retry(),true);assert.equal(await c.c.UserConfig.flush(),true);
  assert.deepEqual(s.data,{...initial,[KEY]:{...initial[KEY],[FIELD]:[225,488,13]}});
});

test('static fallback patches latest sibling data and retains only a failed draft, not a successful stale shadow',async()=>{
  const c=client(null,{[KEY]:{skill:{basePower:70}}});await c.api.record({id:488},[13]);
  c.memory.set(KEY,JSON.stringify({skill:{basePower:90},[FIELD]:[225],future:'keep'}));
  assert.deepEqual(order(c),[225]);await c.api.record({id:595});
  assert.deepEqual(JSON.parse(c.memory.get(KEY)),{skill:{basePower:90},[FIELD]:[595,225],future:'keep'});
  const before=c.memory.get(KEY),set=c.c.localStorage.setItem;c.c.localStorage.setItem=()=>{throw Error('isolated write failure');};
  assert.equal(await c.api.record({id:488}),false);assert.deepEqual(order(c),[488,595,225]);assert.equal(c.memory.get(KEY),before);
  c.c.localStorage.setItem=set;assert.equal(await c.api.record({id:13}),true);assert.deepEqual(order(c),[13,488,595,225]);
  c.memory.set(KEY,'{');assert.equal(await c.api.record({id:595},[13]),false);assert.equal(c.memory.get(KEY),'{','corrupt sibling data is never erased to save the new order');
});

test('index loads independent priority once before both consumers, with the leader helper retained',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  assert.equal((html.match(/src="js\/damage-speed-priority\.js/g)||[]).length,1);
  const at=html.indexOf('src="js/damage-speed-priority.js');
  assert.ok(at>html.indexOf('src="js/user-config.js'));
  assert.ok(at<html.indexOf('src="js/pages/speed.js'));assert.ok(at<html.indexOf('src="js/pages/damage.js'));
  assert.ok(html.includes('src="js/speed-leader-display.js'));
});
