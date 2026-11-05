const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = file => require('./catalog-read-fixture.cjs').readResource(root, file);
const plain = value => JSON.parse(JSON.stringify(value));

async function dexRuntime() {
  const prefs = { enabled: false, policy: { mode: 'include', threshold: 80 }, getTrickRoom() { return this.enabled; }, getEffectiveSpeedPolicy() { return this.policy; } };
  const c = vm.createContext({ window: { AppPreferences: prefs }, AppPreferences: prefs, console: {log(){},error(){}},
    fetch: async file => ({ ok: true, json: async () => JSON.parse(source(file)) }) });
  for (const file of ['js/battle-math.js','js/monster-identity.js','js/data.js','js/listing-ui.js','js/petdex-family.js']) vm.runInContext(source(file), c);
  const data = vm.runInContext('RKData', c); await data.init();
  vm.runInContext(source('js/pages/petdex.js').replace('return { render, toggleTrait, toggleForm, showPetDetail };',
    'return { render, toggleTrait, toggleForm, showPetDetail, projectMonster, getEffectiveRank, getFilteredMonsters, state };'), c);
  return { prefs, data, dex: vm.runInContext('PetDexPage', c), list: vm.runInContext('ListingUI', c) };
}

test('trick room uses displayed speed in all three effective policies; ordinary helpers remain unchanged', async () => {
  const r = await dexRuntime(), dog = r.data.getMonsters().find(m => r.data.getMonsterName(m) === '音速犬');
  const before = JSON.stringify(r.data.getMonsters());
  assert.equal(dog.base_spd, 120); assert.equal(r.data.getTotalStats(dog), 542);
  r.prefs.enabled = true;
  const projected = r.dex.projectMonster(dog);
  assert.notEqual(projected, dog); assert.equal(projected.base_spd, 80);
  assert.equal(r.data.getTotalStats(projected), 502);
  for (const [mode, original, expected] of [['include',504,464],['exclude',384,384],['threshold',504,464]]) {
    r.prefs.policy = { mode, threshold: 80 };
    assert.equal(r.data.getEffectiveStats(dog), original);
    assert.equal(r.data.getEffectiveStats(projected), expected);
  }
  assert.equal(JSON.stringify(r.data.getMonsters()), before);
  r.prefs.enabled = false;
  assert.equal(r.dex.projectMonster(dog), dog);
  assert.equal(r.data.getTotalStats(r.dex.projectMonster(dog)), 542);
});

test('projection is exact without clamping and preserves nested type/identity objects', async () => {
  const r = await dexRuntime();
  const m = Object.freeze({ id: 1, base_spd: 220, main_type: Object.freeze({name:'Water'}), sub_type: Object.freeze({name:'Flying'}) });
  const p = r.dex.projectMonster(m, true);
  assert.equal(p.base_spd, -20); assert.equal(p.id, m.id); assert.equal(p.main_type, m.main_type); assert.equal(p.sub_type,m.sub_type);
  assert.equal(r.dex.projectMonster({...m,base_spd:100},true).base_spd,100);
});

test('petdex filtering preserves ID set, stages, hidden rules, seasons and dual-type intersection', async () => {
  const r = await dexRuntime();
  for (const types of [[], ['Water'], ['Water','Flying']]) for (const forms of [[],['high'],['leader']]) {
    r.dex.state.activeTypes = new Set(types); r.dex.state.activeForms = new Set(forms);
    r.dex.state.sortKey = 'dex_number';
    r.prefs.enabled = false; const ids = r.dex.getFilteredMonsters().map(m=>m.id);
    r.prefs.enabled = true; assert.deepEqual(plain(r.dex.getFilteredMonsters().map(m=>m.id)), plain(ids));
  }
  r.dex.state.activeTypes = new Set(); r.dex.state.activeForms = new Set();
  r.dex.state.activeSeasons = new Set(['S1']);
  r.prefs.enabled = false; const ids = r.dex.getFilteredMonsters().map(m=>m.id);
  r.prefs.enabled = true; assert.deepEqual(plain(r.dex.getFilteredMonsters().map(m=>m.id)),plain(ids));
});

test('all projected numeric sorting and rank pools match independently calculated current catalogue', async () => {
  const r = await dexRuntime(), snapshot = JSON.stringify(r.data.getMonsters());
  const keys = ['base_hp','base_phy_atk','base_mag_atk','base_phy_def','base_mag_def','base_spd'];
  const value = (m,key) => {
    const speed=200-(m.base_spd||0), values=keys.map(k=>k==='base_spd'?speed:(m[k]||0));
    const total=values.reduce((a,b)=>a+b,0);
    if(key==='total')return total;
    if(key==='effective')return total-Math.min(m.base_phy_atk||0,m.base_mag_atk||0)-((r.prefs.policy.mode==='exclude'||r.prefs.policy.mode==='threshold'&&speed<80)?speed:0);
    return key==='base_spd'?speed:(m[key]||0);
  };
  for(const mode of ['include','exclude','threshold']) {
    r.prefs.policy={mode,threshold:80}; r.prefs.enabled=true;
    for(const key of ['base_spd','total','effective']) {
      r.dex.state.sortKey=key; r.dex.state.sortAsc=false;
      const actual=r.dex.getFilteredMonsters();
      for(let i=1;i<actual.length;i++) assert.ok(value(r.data.getMonsterById(actual[i-1].id),key)>=value(r.data.getMonsterById(actual[i].id),key));
    }
    for(const m of r.data.getMonsters().filter(m=>!m.hidden&&['高级形态','首领形态'].includes(m.evolution_stage))) {
      const pool=r.data.getMonsters().filter(p=>!p.hidden&&(p.evolution_stage==='高级形态'||m.evolution_stage==='首领形态'&&p.evolution_stage==='首领形态'));
      pool.sort((a,b)=>value(b,'effective')-value(a,'effective'));
      assert.deepEqual(plain(r.dex.getEffectiveRank(m,true)),{rank:pool.findIndex(p=>p.id===m.id)+1,count:pool.length});
      const rawPool=r.data.getMonsters().filter(p=>!p.hidden&&(p.evolution_stage==='高级形态'||m.evolution_stage==='首领形态'&&p.evolution_stage==='首领形态'));
      rawPool.sort((a,b)=>r.data.getEffectiveStats(b)-r.data.getEffectiveStats(a));
      // Raw detail callers do not opt into projection; keep catalogue tie order.
      assert.equal(r.dex.getEffectiveRank(m,false).rank,rawPool.findIndex(p=>p.id===m.id)+1);
    }
  }
  assert.equal(JSON.stringify(r.data.getMonsters()),snapshot);
});

async function settingsRuntime({initial={}, memory={}, deferred}={}) {
  const cache=new Map(Object.entries(memory)), nodes=new Map(), events=[],writes=[];
  const style=()=>({setProperty(){}});
  const node=id=>{if(!nodes.has(id))nodes.set(id,{style:style(),value:'',checked:false,textContent:'',innerHTML:'',listeners:{},addEventListener(t,f){this.listeners[t]=f;},setAttribute(){}});return nodes.get(id);};
  const reply={ok:true,body:{ok:true}};
  const c=vm.createContext({console, document:{documentElement:{style:style()},body:{style:style()},getElementById:node,querySelectorAll:()=>[]},
    window:{addEventListener(){},dispatchEvent(e){events.push(e);}},CustomEvent:function(type,options){this.type=type;this.detail=options.detail;},
    localStorage:{getItem:k=>cache.get(k)??null,setItem:(k,v)=>cache.set(k,String(v))},
    fetch:async(url,request)=>{
      if(request?.method==='POST'){writes.push(JSON.parse(request.body));return {ok:reply.ok,json:async()=>reply.body};}
      return {ok:true,json:async()=>url==='/api/window/state'?{maximized:false}:deferred?await deferred:{default_max_zoom:100,...initial}};
    }});
  const common=source('js/common.js'); vm.runInContext(common.slice(0,common.indexOf('const CommonUI')),c);
  if(!deferred)await c.window.appPreferencesReady;
  vm.runInContext(source('js/pages/settings.js').replace('return { render: render, onLeave: onLeave };',
    'return { saveSettings, loadSettings, buildHtml, bindSpeedSettings, defaults: DEFAULT_SETTINGS, draft: settings, resetDraft() { Object.assign(settings, DEFAULT_SETTINGS); } };'),c);
  return {c,prefs:c.window.AppPreferences,page:vm.runInContext('SettingsPage',c),cache,nodes,node,events,reply,writes};
}

test('startup shared bool wins stale cache; missing field defaults false; stale async startup cannot undo new save',async()=>{
  for(const [initial,cache,expected] of [[{},'true',false],[{trick_room:true},'false',true],[{trick_room:false},'true',false]]) {
    const r=await settingsRuntime({initial,memory:{'xwiki-trick-room':cache}});
    assert.equal(r.prefs.getTrickRoom(),expected);assert.equal(r.cache.get('xwiki-trick-room'),String(expected));
  }
  let resolve;const deferred=new Promise(r=>resolve=r);
  const r=await settingsRuntime({deferred});r.prefs.setTrickRoom(true);
  resolve({trick_room:false});await r.c.window.appPreferencesReady;
  assert.equal(r.prefs.getTrickRoom(),true);
});

test('checkbox edits draft only, failure preserves runtime/cache, success commits snapshot with other fields',async()=>{
  const r=await settingsRuntime();r.page.bindSpeedSettings();
  r.node('set-trick-room').listeners.change({target:{checked:true}});
  assert.equal(r.page.draft.trick_room,true);assert.equal(r.prefs.getTrickRoom(),false);
  r.page.draft.extra_backend_field='preserved';r.reply.ok=false;
  assert.equal(await r.page.saveSettings(),false);assert.equal(r.prefs.getTrickRoom(),false);assert.equal(r.cache.get('xwiki-trick-room'),'false');
  r.reply.ok=true;assert.equal(await r.page.saveSettings(),true);
  assert.equal(r.prefs.getTrickRoom(),true);assert.equal(r.cache.get('xwiki-trick-room'),'true');assert.equal(r.writes.at(-1).extra_backend_field,'preserved');
  assert.ok(r.events.some(e=>e.type==='appstatspreferenceschange'&&e.detail.trickRoom===true));
  r.page.resetDraft();assert.equal(r.page.draft.trick_room,false);assert.equal(r.prefs.getTrickRoom(),true);
  assert.equal(await r.page.saveSettings(),true);assert.equal(r.prefs.getTrickRoom(),false);
});

test('get/set normalization and nonpersisting updates; old settings UI gains one CSS-styled checkbox',async()=>{
  const r=await settingsRuntime();r.prefs.setTrickRoom(true,false);
  assert.equal(r.cache.get('xwiki-trick-room'),'false');assert.equal(r.prefs.getTrickRoom(),true);
  r.prefs.setTrickRoom('false');assert.equal(r.prefs.getTrickRoom(),false);
  const html=r.page.buildHtml();assert.match(html,/<label class="settings-trick-room"><input type="checkbox" id="set-trick-room"/);
  assert.ok(!/id="set-trick-room"[^>]*style=/.test(html));assert.equal(r.page.defaults.trick_room,false);
});
