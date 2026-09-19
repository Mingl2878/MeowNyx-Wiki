'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../js/chart-workspace.js');
function fixture(initial = {}, legacy = [249, 249, 327]) {
  let saved = structuredClone(initial), failed = false, draft = null, writes = 0;
  const values = new Map([['rk_chart_fav_pets', JSON.stringify(legacy)], ['rk_fav_pets', '[202,434]'], ['rk_pet_configs', '{"249":{"iv":{"hp":true}}}']]);
  const reads = [], root = { localStorage: { getItem(k) { reads.push(k); return values.get(k) ?? null; }, setItem(k,v) { values.set(k,v); } },
    UserConfig: { getObject(k) { assert.equal(k, 'rk_chart_workspace'); return structuredClone(draft || saved); },
      async patch(k, patch) { assert.equal(k, 'rk_chart_workspace'); writes++; if (failed) { draft = structuredClone(patch); return false; } saved = structuredClone(patch); draft = null; return true; } } };
  return { root, store: createStore(root), values, reads, saved: () => saved, writes: () => writes, fail: value => { failed = value; } };
}

test('imports only old chart favorites once with independent defaults; A and personal records never read', async () => {
  const e = fixture(); await e.store.init();
  assert.deepEqual(e.store.getEntries().map(e=>e.id), [249,327]);
  assert.deepEqual(e.reads, ['rk_chart_fav_pets']);
  assert.deepEqual(e.store.getState().controls, { atkIV: {attack:true,magic_attack:true}, atkNature:{attack:0,magic_attack:0}, defIV:{defense:true,magic_defense:true},doubleLife:false });
  assert.equal(e.saved().state.legacyImported, true);
  await e.store.removePet(249); await e.store.removePet(327);
  const next = createStore(e.root); await next.init();
  assert.deepEqual(next.getEntries(), []);
  assert.equal(e.values.get('rk_fav_pets'), '[202,434]');
  assert.equal(e.values.get('rk_chart_fav_pets'), '[249,249,327]');
});

test('existing intentionally empty state is not mistaken for absent migration', async () => {
  const empty = createStore({}).defaults();
  const e = fixture({ state: empty }); await e.store.init();
  assert.deepEqual(e.store.getEntries(), []); assert.deepEqual(e.reads, []); assert.equal(e.writes(), 0);
});

test('CRUD, group copy uses independent member arrays but a single shared control configuration', async () => {
  const e = fixture(); await e.store.init();
  const one = await e.store.createGroup('甲'); await e.store.addPet(249); await e.store.addPet(249);
  const two = await e.store.copyGroup(one, '乙');
  await e.store.addPet(434);
  const groups = e.store.getState().groups;
  assert.deepEqual(groups.find(g=>g.id===one).petIds,[249]);
  assert.deepEqual(groups.find(g=>g.id===two).petIds,[249,434]);
  await e.store.selectGroup('all');
  assert.deepEqual(e.store.getEntries().map(e=>e.id),[249,327,434]);
  assert.equal(new Set(e.store.getEntries().map(e=>e.key)).size,3);
  await e.store.renameGroup(two, '<分组>'); await e.store.orderGroup(two,-1);
  assert.deepEqual(e.store.getState().groups.map(g=>g.name), ['未分组','<分组>','甲']);
  await e.store.orderGroup(two,1); assert.equal(e.store.getState().groups[2].id,two);
  await e.store.setControls({atkIV:{attack:false}, atkNature:{magic_attack:2}, doubleLife:true});
  await e.store.selectGroup(one); const controls = e.store.getState().controls;
  await e.store.selectGroup(two); assert.deepEqual(e.store.getState().controls,controls);
  assert.equal(Object.hasOwn(e.store.getState().groups[1],'controls'),false);
});

test('move removes source membership only, copy membership remains; remove globally removes one species', async () => {
  const e = fixture(); await e.store.init();
  const a = await e.store.copyGroup('ungrouped','A');
  const b = await e.store.createGroup('B');
  await e.store.movePet(249,b,a);
  let groups=e.store.getState().groups;
  assert.deepEqual(groups.find(g=>g.id==='ungrouped').petIds,[249,327]);
  assert.deepEqual(groups.find(g=>g.id===a).petIds,[327]);
  assert.deepEqual(groups.find(g=>g.id===b).petIds,[249]);
  await e.store.removePet(249);
  assert.ok(e.store.getState().groups.every(g=>!g.petIds.includes(249)));
  assert.equal(e.values.get('rk_fav_pets'),'[202,434]');
});

test('delete transfers members to ungrouped with dedup and preserves other groups', async () => {
  const e = fixture(); await e.store.init(); const a = await e.store.copyGroup('ungrouped','A');
  await e.store.addPet(434); await e.store.deleteGroup(a);
  assert.equal(e.store.getState().activeGroupId,'ungrouped');
  assert.deepEqual(e.store.getEntries().map(e=>e.id),[249,327,434]);
  await assert.rejects(e.store.deleteGroup('ungrouped'));
});

test('failed writes preserve committed groups, selection and controls; subsequent save can retry safely', async () => {
  const e=fixture(); await e.store.init(); const a=await e.store.createGroup('A');
  const old=e.store.getState(); e.fail(true);
  await assert.rejects(e.store.selectGroup('all'),/未保存/); assert.deepEqual(e.store.getState(),old);
  await assert.rejects(e.store.setControls({doubleLife:true})); assert.deepEqual(e.store.getState(),old);
  await assert.rejects(e.store.deleteGroup(a)); assert.deepEqual(e.store.getState(),old);
  e.fail(false); await e.store.retry(); await e.store.setControls({doubleLife:true});
  assert.equal(e.saved().state.controls.doubleLife,true); assert.equal(e.store.getState().groups.length,2);
});

test('failed first migration cannot be adopted from UserConfig optimistic draft on retry', async () => {
  const e=fixture(); e.fail(true); await assert.rejects(e.store.init());
  assert.equal(e.store.getStatus().initialized,false); assert.deepEqual(e.store.getEntries(),[]);
  await assert.rejects(e.store.init()); assert.equal(e.writes(),2);
  e.fail(false); await e.store.init(); assert.equal(e.writes(),3); assert.equal(e.store.getStatus().initialized,true);
});

test('concurrent saves serialize from committed state without lost members', async () => {
  const e=fixture(); await e.store.init();
  await Promise.all([e.store.addPet(600),e.store.addPet(601),e.store.setControls({doubleLife:true})]);
  assert.deepEqual(e.store.getEntries().map(e=>e.id),[249,327,600,601]);
  assert.equal(e.store.getState().controls.doubleLife,true);
});

test('localStorage fallback only when UserConfig absent; canonical failures never fall back', async () => {
  const e=fixture(); const local=createStore({localStorage:e.root.localStorage}); await local.init();
  await local.removePet(249); const again=createStore({localStorage:e.root.localStorage}); await again.init();
  assert.deepEqual(again.getEntries().map(e=>e.id),[327]);
  e.fail(true); await assert.rejects(e.store.init());
  assert.deepEqual(JSON.parse(e.values.get('rk_chart_workspace')).state.groups[0].petIds,[327]);
});

test('invalid schema, duplicate species within a group, unsafe IDs and corrupt legacy are not overwritten', async () => {
  for (const alter of [s=>{s.version=2;},s=>{s.groups[0].petIds=[249,249];},s=>{s.groups[0].id='__proto__';},s=>{s.controls.atkNature.attack=3;}]) {
    const s=createStore({}).defaults(); alter(s); const e=fixture({state:s});
    await assert.rejects(e.store.init()); assert.equal(e.writes(),0);
  }
  const e=fixture(); e.values.set('rk_chart_fav_pets','{broken'); await assert.rejects(e.store.init()); assert.equal(e.writes(),0);
});

test('state snapshots cannot mutate store and empty names/invalid pet IDs reject', async () => {
  const e=fixture(); await e.store.init();
  const s=e.store.getState(); s.groups[0].petIds.length=0;
  assert.equal(e.store.getEntries().length,2);
  await assert.rejects(e.store.createGroup(' ')); await assert.rejects(e.store.addPet(-1));
  await assert.rejects(e.store.renameGroup('ungrouped','change'));
});
