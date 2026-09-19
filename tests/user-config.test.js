'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/user-config.js'),'utf8');
const copy=x=>JSON.parse(JSON.stringify(x));
function server(data={}) {
  return { data:copy(data),settings:{},imported:false,flags:{},calls:[],fail:false,bad:false,
    async fetch(url,opts={}) {
      this.calls.push({url,body:opts.body&&JSON.parse(opts.body)});
      if(this.fail)return {ok:false,json:async()=>({ok:false,error:'simulated disk failure'})};
      if(this.bad)return {ok:true,json:async()=>[]};
      const b=opts.body&&JSON.parse(opts.body);
      if(url==='/api/settings'){Object.assign(this.settings,b);return {ok:true,json:async()=>({ok:true})};}
      if(b?.reset_pet_defaults) for(const record of Object.values(this.data.rk_pet_configs||{})) record.mode=0;
      if(b)for(const [key,fields]of Object.entries(b.patch||b.import||{})){
        if(b.import && this.flags[key])continue;
        if(b.import && ['rk_damage_skill_configs','rk_damage_view','rk_chart_workspace'].includes(key))this.flags[key]=true;
        if(!Object.keys(fields).length)continue;
        this.data[key]??={};
        for(const [k,v]of Object.entries(fields)){
          if(b.import&&Object.hasOwn(this.data[key],k))continue;
          if(v===null)delete this.data[key][k];else this.data[key][k]=copy(v);
        }
      }
      if(b?.import&&Object.values(b.import).some(fields=>Object.keys(fields).length))this.imported=true;
      return {ok:true,json:async()=>({ok:true,data:copy(this.data),legacy_imported:this.imported,legacy_imported_keys:copy(this.flags)})};
    }
  };
}
function client(s,legacy={}) {
  const memory=new Map(Object.entries(legacy).map(([k,v])=>[k,JSON.stringify(v)])),close=[];
  const storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v))},events=[];
  const c={localStorage:storage,fetch:s.fetch.bind(s),setTimeout,clearTimeout,AbortController,addEventListener(){},CustomEvent:class {constructor(type,options){this.type=type;this.detail=options?.detail;}},dispatchEvent:e=>events.push(e),__xhmCloseReady:ok=>close.push(ok)};c.window=c;
  vm.createContext(c);vm.runInContext(source,c);
  return {api:c.UserConfig,memory,storage,close,events};
}
test('nonempty legacy records import once; another browser origin receives the shared data',async()=>{
  const s=server(),a=client(s,{rk_pet_configs:{249:{nature:{hp:1},iv:{hp:true}}},rk_speed_pet_priority:{136:[249]}});
  assert.equal(await a.api.init(),true);assert.equal(s.imported,true);assert.equal(s.calls.filter(c=>c.body?.import).length,1);
  const b=client(s);assert.equal(await b.api.init(),true);assert.deepEqual(copy(b.api.getObject('rk_pet_configs')),s.data.rk_pet_configs);
  assert.equal(s.calls.filter(c=>c.body?.import).length,1);
});
test('existing shared values win; empty legacy cache never creates defaults or erases records',async()=>{
  const s=server({rk_pet_configs:{249:{iv:{hp:true}}}}),a=client(s,{rk_pet_configs:{249:{iv:{}},602:{iv:{defense:true}}}});
  await a.api.init();assert.deepEqual(s.data.rk_pet_configs[249],{iv:{hp:true}});assert.ok(s.data.rk_pet_configs[602]);
  const before=JSON.stringify(s.data);await client(s).api.init();assert.equal(JSON.stringify(s.data),before);
  const empty=server();await client(empty).api.init();assert.equal(empty.calls.filter(c=>c.body).length,1);assert.deepEqual(empty.data,{});assert.equal(empty.flags.rk_damage_view,true);
});
test('completed migration does not resurrect deleted entries from stale localStorage',async()=>{
  const s=server({rk_speed_form_overrides:{}});s.imported=true;
  const c=client(s,{rk_speed_form_overrides:{old:249}});await c.api.init();
  assert.deepEqual(copy(c.api.getObject('rk_speed_form_overrides')),{});assert.equal(s.calls.filter(c=>c.body).length,1);assert.ok(s.flags.rk_damage_skill_configs);
});
test('unavailable or malformed API never reports a successful write',async()=>{
  for(const flag of ['fail','bad']){
    const s=server();s[flag]=true;const c=client(s,{rk_pet_configs:{249:{iv:{hp:true}}}});
    assert.equal(await c.api.init(),false);assert.equal(await c.api.patch('rk_pet_configs',{602:{iv:{}}}),false);
    assert.equal(await c.api.flush(),false);assert.equal(s.calls.filter(c=>c.body).length,0);assert.ok(c.api.getStatus().error);
  }
});
test('failed save retains old committed bytes, unsaved draft and a retryable queue',async()=>{
  const s=server({rk_pet_configs:{249:{iv:{hp:false}}}}),c=client(s);await c.api.init();s.fail=true;
  assert.equal(await c.api.patch('rk_pet_configs',{249:{iv:{hp:true}}}),false);
  assert.equal(s.data.rk_pet_configs[249].iv.hp,false);assert.equal(c.api.getObject('rk_pet_configs')[249].iv.hp,true);
  s.fail=false;assert.equal(await c.api.retry(),true);assert.equal(s.data.rk_pet_configs[249].iv.hp,true);assert.equal(c.api.getStatus().pending,0);
});
test('queued field patches preserve other records, form deletion and consecutive writes',async()=>{
  const s=server({rk_pet_configs:{1:{iv:{hp:true}}},rk_speed_form_overrides:{one:249,two:602}}),c=client(s);await c.api.init();
  const calls=[c.api.patch('rk_pet_configs',{2:{nature:{hp:1}}}),c.api.patch('rk_damage_selection',{attacker:30}),c.api.patch('rk_damage_selection',{defender:20}),c.api.patch('rk_speed_form_overrides',{one:null})];
  assert.ok((await Promise.all(calls)).every(Boolean));assert.equal(await c.api.flush(),true);
  assert.equal(Object.keys(s.data.rk_pet_configs).length,2);assert.deepEqual(s.data.rk_damage_selection,{attacker:30,defender:20});assert.deepEqual(s.data.rk_speed_form_overrides,{two:602});
  await c.api.patch('rk_damage_selection',{attacker:31});await c.api.patch('rk_damage_selection',{defender:21});assert.equal(await c.api.flush(),true);
});
test('cache failure does not lose durable settings and reads the committed in-memory copy',async()=>{
  const s=server({rk_damage_selection:{attacker:1}}),c=client(s);await c.api.init();c.storage.setItem=()=>{throw Error('cache disabled')};
  assert.equal(await c.api.patch('rk_damage_selection',{attacker:2}),true);assert.equal(c.api.getObject('rk_damage_selection').attacker,2);assert.equal(c.api.getStatus().cacheWarning,true);
});
test('settings saves participate in close flushing and explicit retry supersedes invalid proposal',async()=>{
  const s=server(),c=client(s);await c.api.init();s.fail=true;
  assert.equal(await c.api.saveSettings({font_family:'bad',default_max_zoom:150}),false);
  assert.equal(await c.api.requestClose(),false);assert.deepEqual(c.close,[false]);
  s.fail=false;assert.equal(await c.api.saveSettings({font_family:'good'}),true);
  assert.equal(await c.api.requestClose(),true);assert.deepEqual(s.settings,{font_family:'good',default_max_zoom:150});assert.deepEqual(c.close,[false,true]);
});
test('malformed legacy JSON blocks migration rather than overwriting it with an empty record',async()=>{
  const s=server(),c=client(s);c.memory.set('rk_pet_configs','{broken');
  assert.equal(await c.api.init(),false);assert.equal(c.memory.get('rk_pet_configs'),'{broken');assert.deepEqual(s.data,{});
});
test('new skill keys upgrade despite legacy_imported, without replacing existing empty records or reviving later deletions',async()=>{
  const s=server({rk_damage_skill_configs:{249:{},434:{basePower:0}},rk_damage_view:{skill:{basePower:0}}});s.imported=true;
  const c=client(s,{rk_damage_skill_configs:{249:{basePower:100},434:{basePower:100},602:{basePower:80}},rk_damage_view:{skill:{basePower:100}},rk_pet_configs:{99:{}}});
  assert.equal(await c.api.init(),true);assert.deepEqual(s.data.rk_damage_skill_configs[249],{});assert.equal(s.data.rk_damage_skill_configs[434].basePower,0);assert.equal(s.data.rk_damage_skill_configs[602].basePower,80);assert.equal(s.data.rk_damage_view.skill.basePower,0);assert.equal(s.data.rk_pet_configs,undefined);
  delete s.data.rk_damage_skill_configs[602];delete s.data.rk_damage_view;
  const stale=client(s,{rk_damage_skill_configs:{602:{basePower:99}},rk_damage_view:{skill:{basePower:99}}});
  assert.equal(await stale.api.init(),true);assert.equal(stale.api.getObject('rk_damage_skill_configs')[602],undefined);assert.deepEqual(copy(stale.api.getObject('rk_damage_view')),{});
  stale.memory.set('rk_damage_view',JSON.stringify({skill:{basePower:777}}));assert.deepEqual(copy(stale.api.getObject('rk_damage_view')),{});
});
test('skill snapshot and per-pet memory participate in visible failure, retry and close flushing',async()=>{
  const s=server({rk_damage_skill_configs:{1:{basePower:100}},rk_damage_view:{skill:{basePower:100}}}),c=client(s);await c.api.init();s.fail=true;
  assert.equal(await c.api.patch('rk_damage_skill_configs',{1:{basePower:0,finalPowerManual:'0'}}),false);
  assert.equal(await c.api.patch('rk_damage_view',{skill:{basePower:0,finalPowerManual:'0'}}),false);
  assert.equal(s.data.rk_damage_skill_configs[1].basePower,100);assert.equal(await c.api.requestClose(),false);
  s.fail=false;assert.equal(await c.api.retry(),true);assert.equal(await c.api.requestClose(),true);
  assert.equal(s.data.rk_damage_view.skill.finalPowerManual,'0');assert.equal(s.data.rk_damage_skill_configs[1].basePower,0);
});
