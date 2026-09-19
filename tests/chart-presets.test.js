'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createStore } = require('../js/chart-workspace.js');
const rootDir = path.join(__dirname, '..');
const dataset = JSON.parse(fs.readFileSync(path.join(rootDir, 'data/monsters.json'), 'utf8').replace(/^\uFEFF/, ''));
const dataContext = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(rootDir, 'js/data.js'), 'utf8'), dataContext);
const order = Array.from(vm.runInContext('RKData.PILL_ORDER', dataContext));
function fixture(initial) {
  let pets = structuredClone(dataset), saved = initial ? structuredClone(initial) : {state:createStore({}).defaults()}, writes = 0, fail = false;
  const root = { RKData: { PILL_ORDER: order, getMonsters: () => pets },
    UserConfig: { getObject: () => structuredClone(saved), patch: async (_, patch) => {
      writes++; if (fail) return false; saved = structuredClone(patch); return true;
    } } };
  return { root, store: createStore(root), writes: () => writes, saved: () => structuredClone(saved),
    pets: () => pets, replace: value => { pets = value; }, fail: value => { fail = value; } };
}
const expected = (pets, type) => [...new Set(pets.filter(p => !p.hidden && p.evolution_stage === '高级形态'
  && !p.is_leader_form && ['主形态', '无多形态'].includes(p.form_category)
  && (p.main_type?.name === type || p.sub_type?.name === type)).map(p => p.id))];
for (const type of order) test(`actual ${type} dataset membership: main/sub, advanced main only, stable IDs`, async () => {
  const f=fixture(); await f.store.init(); const before=JSON.stringify(f.pets());
  await f.store.selectGroup('preset:'+type);
  const ids=f.store.getEntries().map(e=>e.id);
  assert.deepEqual(ids, expected(dataset,type));
  assert.equal(new Set(ids).size,ids.length);
  assert.equal(JSON.stringify(f.pets()),before);
  assert.deepEqual(f.saved().state.groups,[{id:'ungrouped',name:'未分组',petIds:[]}]);
  assert.deepEqual(f.store.getEntries().map(e=>e.key),ids.map(id=>'chart:'+id));
  assert.equal(f.saved().state.activeGroupId,'preset:'+type);
});

test('exactly 18 descriptors use actual PILL_ORDER, full names, no extra pseudo-types', () => {
  const f=fixture(), list=f.store.getPresets();
  assert.deepEqual(list.map(p=>p.type),order); assert.equal(list.length,18);
  assert.equal(list.find(p=>p.type==='Normal').name,'所有普通系精灵');
  assert.equal(list.find(p=>p.type==='Mechanical').name,'所有机械系精灵');
  assert.ok(list.every(p=>p.readonly && !['None','Leader'].includes(p.type)));
});

test('each read derives fresh membership, matches sub type, dedups and excludes hidden/base/variant/leader', async () => {
  const f=fixture(); await f.store.init();
  const common={evolution_stage:'高级形态',form_category:'主形态',main_type:{name:'Water'},sub_type:{name:'Fire'}};
  f.replace([{...common,id:700001},{...common,id:700001},{...common,id:700002,form_category:'变体形态'},
    {...common,id:700003,evolution_stage:'基础形态'},{...common,id:700004,hidden:true},
    {...common,id:700005,is_leader_form:true},{...common,id:700006,form_category:'无多形态'},
    {...common,id:9001,evolution_stage:'木桩'},{...common,id:700007,form_category:null}]);
  await f.store.selectGroup('preset:Fire');
  assert.deepEqual(f.store.getEntries().map(e=>e.id),[700001,700006]);
  const before=f.writes(); f.pets().push({...common,id:700008});
  assert.deepEqual(f.store.getEntries().map(e=>e.id),[700001,700006,700008]);
  assert.equal(f.writes(),before,'derived refresh does not write snapshot');
});

test('readonly mutation guards run before persistence; same-named custom group and all union unaffected', async () => {
  const f=fixture(); await f.store.init();
  const custom=await f.store.createGroup('所有火系精灵'); await f.store.addPet(249);
  await f.store.selectGroup('preset:Fire'); const before=f.saved(), writes=f.writes();
  const actions=[()=>f.store.removePet(249),()=>f.store.addPet(327),()=>f.store.addPet(327,custom),
    ()=>f.store.movePet(249,custom),()=>f.store.movePet(249,'preset:Fire',custom),
    ()=>f.store.renameGroup('preset:Fire','改名'),()=>f.store.orderGroup('preset:Fire',-1),
    ()=>f.store.deleteGroup('preset:Fire')];
  for(const action of actions) await assert.rejects(action,/只读/);
  assert.equal(f.writes(),writes); assert.deepEqual(f.saved(),before); assert.equal(f.store.getStatus().pendingWrite,false);
  await f.store.selectGroup('all'); assert.deepEqual(f.store.getEntries().map(e=>e.id),[249]);
});

test('copy is a normal independent snapshot, create and switching from presets remain supported', async () => {
  const f=fixture(); await f.store.init(); await f.store.selectGroup('preset:Fire');
  const members=f.store.getEntries().map(e=>e.id), controls=f.store.getState().controls;
  const copy=await f.store.copyGroup('preset:Fire','火系副本');
  assert.match(copy,/^g_/); assert.equal(f.store.isPreset(copy),false);
  assert.deepEqual(f.store.getState().groups.find(g=>g.id===copy).petIds,members);
  f.replace([]); assert.deepEqual(f.store.getEntries().map(e=>e.id),members);
  await f.store.removePet(members[0]); assert.ok(!f.store.getEntries().some(e=>e.id===members[0]));
  await f.store.selectGroup('preset:Fire'); assert.deepEqual(f.store.getEntries(),[]);
  const newId=await f.store.createGroup('空组'); assert.equal(f.store.getState().activeGroupId,newId);
  assert.deepEqual(f.store.getState().controls,controls);
});

test('preset controls persist and reload without data freeze or custom group contamination', async () => {
  const f=fixture(); await f.store.init(); await f.store.selectGroup('preset:Mechanical');
  await f.store.setControls({doubleLife:true,defIV:{defense:false}});
  const reloaded=createStore(f.root); await reloaded.init();
  assert.equal(reloaded.getState().activeGroupId,'preset:Mechanical');
  assert.equal(reloaded.getState().controls.doubleLife,true);
  assert.equal(reloaded.getState().controls.defIV.defense,false);
  assert.deepEqual(reloaded.getEntries().map(e=>e.id),expected(dataset,'Mechanical'));
  assert.equal(reloaded.getState().groups.length,1);
});

test('failed selection and retry keep committed groups and controls, then commit reserved preset ID', async () => {
  const f=fixture(); await f.store.init(); const before=f.store.getState(); f.fail(true);
  await assert.rejects(()=>f.store.selectGroup('preset:Fire'),/未保存/);
  assert.deepEqual(f.store.getState(),before); assert.equal(f.store.getStatus().pendingWrite,true);
  f.fail(false); await f.store.retry(); assert.equal(f.store.getState().activeGroupId,'preset:Fire');
  assert.deepEqual(f.store.getState().groups,before.groups); assert.deepEqual(f.store.getState().controls,before.controls);
});

test('failed copy preserves preset and committed groups; retry creates precisely one independent group', async () => {
  const f=fixture(); await f.store.init(); await f.store.selectGroup('preset:Water');
  const before=f.store.getState(); f.fail(true); await assert.rejects(()=>f.store.copyGroup('preset:Water','副本'));
  assert.deepEqual(f.store.getState(),before); f.fail(false); await f.store.retry();
  assert.equal(f.store.getState().groups.length,2); assert.match(f.store.getState().activeGroupId,/^g_/);
});

test('unknown preset selection and persisted stale IDs fail safely without overwriting storage', async () => {
  const f=fixture(); await f.store.init(); const before=f.saved(), writes=f.writes();
  await assert.rejects(()=>f.store.selectGroup('preset:Stale'),/不存在/);
  assert.equal(f.writes(),writes); assert.deepEqual(f.saved(),before); assert.equal(f.store.getStatus().pendingWrite,false);
  const stale=structuredClone(before); stale.state.activeGroupId='preset:Stale';
  const bad=fixture(stale); await assert.rejects(()=>bad.store.init(),/不存在/);
  assert.equal(bad.writes(),0); assert.deepEqual(bad.saved(),stale);
});

test('reserved preset namespace cannot be persisted as custom group IDs', () => {
  const f=fixture(), state=f.store.defaults();
  state.groups.push({id:'preset:Fire',name:'冒充预设',petIds:[249]});
  assert.throws(()=>f.store.validate(state),/无效/);
});

test('source absence never creates a fake empty membership or writes a selection', async () => {
  const f=fixture(); await f.store.init(); delete f.root.RKData;
  const writes=f.writes(); await assert.rejects(()=>f.store.selectGroup('preset:Fire'),/尚未加载/);
  assert.equal(f.writes(),writes);
});
