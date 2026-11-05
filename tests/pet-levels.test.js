'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const P = require('../js/pet-levels');
const { readLegacy } = require('../scripts/lib/catalog-data');
test('keyword detection is exact to trait name/description, not species/skill text', () => {
  for (const field of ['name','description']) assert.equal(P.config({trait:{localized:{zh:{[field]:'根据等级改变'}}}}).enabled,true);
  assert.equal(P.config({name:'等级测试',description:'等级',skills:[{description:'等级'}]}).enabled,false);
  assert.equal(P.config({level_configurable:true,default_level:42}).defaultLevel,42);
  assert.deepEqual(P.config({trait:{localized:{zh:{description:'等级'}}}}),{enabled:true,min:1,max:99,step:1,defaultLevel:60});
});
test('range endpoints and exact default anchor produce specified short final intervals', () => {
  assert.deepEqual(P.steps(P.wolfConfig('ming')),[1,9,19,29,39,49,59,69,79,89,99]);
  assert.deepEqual(P.steps(P.wolfConfig('abu')),[60,62,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,99]);
  assert.deepEqual(P.steps({min:10,max:40,defaultLevel:20,step:7}),[10,13,20,27,34,40]);
  assert.deepEqual(P.steps({min:60,max:60,defaultLevel:60,step:2}),[60]);
  for(const value of [{min:0,max:99,defaultLevel:60,step:2},{min:30,max:29,defaultLevel:30,step:2},{min:1,max:99,defaultLevel:100,step:1},{min:1,max:99,defaultLevel:60,step:0}]) assert.throws(()=>P.steps(value));
});
test('legacy Minggu preferences retain exact old shortcut grid',()=> {
  assert.deepEqual(P.steps(P.config({id:619,level_configurable:true,default_level:99})),P.LEGACY_STEPS);
});
test('wolf family follows explicit edges and not member lists, names, or dex coincidence',()=> {
  const monsters=[{id:595,evolves_from_id:617},{id:617,evolves_from_id:616},{id:616},{id:88,name:'银月狼王',evolution_members:[595]},{id:89,leader_of_id:595},{id:90,main_form_id:617}];
  assert.deepEqual(monsters.filter(m=>P.isWolf(m,monsters)).map(m=>m.id),[595,617,616,89,90]);
  const actual=readLegacy(require('node:path').join(__dirname,'..')).monsters;
  assert.deepEqual(actual.filter(m=>P.isWolf(m,actual)).map(m=>m.id).sort((a,b)=>a-b),[595,616,617]);
});
