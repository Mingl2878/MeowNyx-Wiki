'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { project } = require('../js/battle-turn-view.js');
const data = require('../scripts/lib/catalog-data.js').readLegacy(path.resolve(__dirname, '..'));
const options = { getMonsterById: id => data.monsters.find(p => p.id === id), getMoveById: id => data.moves.find(m => m.id === id) };
const freeze = x => { if(x && typeof x==='object' && !Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x; };
const pet = (instanceId,monsterId=1) => ({instanceId,monsterId});
const record = (events=[],me=[pet('a'),pet('b')],enemy=[pet('a'),pet('b')],rounds=3) => ({rounds,quality:{actions:false},sides:{me:{pets:me},enemy:{pets:enemy}},events});
const resource = (id,x={}) => ({id,round:1,seq:1,execIndex:0,kind:'resource',phase:'executed',side:'me',actor:'a',...x});
const initial = (side,actor,x={}) => resource('initial:'+side+':'+actor,{round:0,seq:0,side,actor,stateStage:'initial',...x});
const cast = (id,x={}) => ({id,round:1,seq:1,execIndex:0,kind:'skill',phase:'executed',skillClass:'ordinary',side:'me',actor:'a',skillId:74,energyCost:1,...x});
const state = (v,r=1,side='me',id='a') => v.rounds.find(t=>t.round===r).teamStates[side].find(s=>s.pet.instanceId===id);
const run = r => project(r,options);

test('catalog and former special traits never supply default HP or energy',()=>{
 for(const id of [1,65,158,238,393,538,325,597,549]){
  const r=record([], [pet('a',id)]),v=run(r);
  assert.equal(state(v).hp,undefined);assert.equal(state(v).energy,undefined);
  assert.equal(v.rounds[0].sides.me.endState.pet,null);
 }
});
test('source initial values cover both benches and no unknown round is created',()=>{
 const r=record([initial('me','a',{hpAfter:100,hpMax:100,energyAfter:0,stateActive:true}),initial('enemy','b',{hpAfter:45,hpMax:90,energyAfter:15,stateActive:false})]);
 const v=run(r);assert.equal(v.rounds.length,3);assert.equal(state(v).energy,0);assert.equal(state(v,3,'enemy','b').energy,15);assert.equal(state(v,3,'enemy','b').hp,45);assert.equal(v.rounds[0].sides.enemy.endState.pet,null);
});
test('normal costs are displayed but never subtracted from source state',()=>{
 const v=run(record([initial('me','a',{hpAfter:100,energyAfter:10}),cast('cost',{energyCost:8})]));
 assert.equal(v.rounds[0].sides.me.actions[0].energyCost,8);assert.equal(state(v).energy,10);
});
test('charge, robbery, friendship and forest notifications do not invent numeric updates',()=>{
 const r=record([initial('me','a',{hpAfter:10,hpMax:100,energyAfter:0,stateActive:true}),initial('me','b',{hpAfter:10,hpMax:100,energyAfter:0}),initial('enemy','b',{hpAfter:100,energyAfter:10}),
 cast('charge',{kind:'effect',skillClass:'system',protocolSkillId:'700001000',label:'聚能',energyCost:0}),cast('robbery',{seq:2,skillId:5940}),cast('grass',{seq:3,skillId:data.moves.find(m=>m.move_type.id===2).id}),
 {id:'friendship',round:1,seq:4,execIndex:0,kind:'effect',phase:'executed',side:'me',actor:'a',skillClass:'passive',label:'特性通知：友谊之果'}], [pet('a',549),pet('b',538)]);
 const v=run(r);assert.equal(state(v,3).energy,0);assert.equal(state(v,3,'me','b').hp,10);assert.equal(state(v,3,'enemy','b').energy,10);
});
test('explicit delta-only updates apply once to known active and bench values',()=>{
 const v=run(record([initial('me','a',{hpAfter:10,hpMax:100,energyAfter:0}),initial('enemy','b',{hpAfter:100,energyAfter:10}),resource('delta',{hpChange:30,energyChange:5}),resource('bench',{side:'enemy',actor:'b',energyChange:-1})]));
 assert.equal(state(v).hp,40);assert.equal(state(v).energy,5);assert.equal(state(v,3,'enemy','b').energy,9);
});
test('explicit result wins over delta without double application',()=>{
 const v=run(record([initial('me','a',{hpAfter:100,energyAfter:10}),resource('sync',{hpAfter:85,hpChange:-15,energyAfter:7,energyChange:-3})]));
 assert.equal(state(v).hp,85);assert.equal(state(v).energy,7);
});
test('unknown baselines stay unknown for deltas, underflow is not guessed as zero',()=>{
 let v=run(record([resource('delta',{hpChange:5,energyChange:5})]));assert.equal(state(v).hp,null);assert.equal(state(v).energy,null);
 v=run(record([initial('me','a',{hpAfter:5,energyAfter:5}),resource('underflow',{hpChange:-10,energyChange:-10})]));assert.equal(state(v).hp,null);assert.equal(state(v).energy,null);
});
test('source zero and above-normal-cap values remain exact across rounds',()=>{
 const v=run(record([initial('me','a',{hpAfter:0,energyAfter:15}),resource('gain',{energyChange:5})]));assert.equal(state(v,3).hp,0);assert.equal(state(v,3).energy,20);
});
test('interruption itself changes nothing but actual resource expenditure still applies',()=>{
 const v=run(record([initial('me','a',{hpAfter:100,energyAfter:10}),cast('interrupted',{phase:'interrupted',energyCost:8}),resource('actual',{energyChange:-2})]));assert.equal(state(v).energy,8);
});
test('switching and first entry never reset or halve previously recorded values',()=>{
 const v=run(record([initial('me','a',{hpAfter:100,energyAfter:10,stateActive:true}),initial('me','b',{hpAfter:75,energyAfter:6}),
 {id:'in',round:1,seq:2,execIndex:0,kind:'switch',phase:'executed',side:'me',actor:'b',target:'a'},
 {id:'out',round:2,seq:3,execIndex:0,kind:'switch',phase:'executed',side:'me',actor:'a',target:'b'},
 {id:'again',round:3,seq:4,execIndex:0,kind:'switch',phase:'executed',side:'me',actor:'b',target:'a'}], [pet('a'),pet('b',325)]));
 assert.equal(state(v,3,'me','b').hp,75);assert.equal(state(v,3,'me','b').energy,6);
});
test('same-entry source delta is applied only once before and after supply',()=>{
 const supply={id:'rkpp:action:1:2:0:supply:b',round:1,seq:2,execIndex:0,kind:'effect',phase:'executed',side:'me',actor:'b',label:'补位通知',text:'同一既有实例的 supply_pet 通知；不增加初始队员。'};
 const entry=resource('entry',{actor:'b',seq:2,stateStage:'entry',energyChange:2,stateActive:true});
 for(const pair of [[supply,entry],[entry,supply]]){
  const v=run(record([initial('me','b',{hpAfter:70,energyAfter:3}),...pair]));assert.equal(state(v,3,'me','b').energy,5);assert.equal(v.rounds[0].sides.me.replacements[0].energy,5);
 }
});
test('duplicate IDs replay once and conflicting declarations reject',()=>{
 const e=resource('delta',{energyChange:2});let r=record([initial('me','a',{energyAfter:3}),e,{...e}]);assert.equal(state(run(r)).energy,5);
 assert.throws(()=>run(record([e,{...e,energyChange:3}])),/冲突/);
});
test('source records and earlier snapshots stay immutable and isolated',()=>{
 const r=freeze(record([initial('me','a',{hpAfter:100,energyAfter:10}),resource('late',{round:2,hpAfter:50,energyAfter:5})])), before=JSON.stringify(r);
 const a=run(r),b=run(r);state(a).energy=1;assert.equal(state(a,2).energy,5);assert.equal(state(b).energy,10);assert.equal(JSON.stringify(r),before);
});
test('real enriched fixture remains identical with and without catalog options', {skip:!process.env.BATTLE_TEAM_STATE_FIXTURE},()=>{
 const raw=JSON.parse(fs.readFileSync(process.env.BATTLE_TEAM_STATE_FIXTURE,'utf8')),r=freeze(raw.records?raw.records[0]:raw);
 const a=project(r),b=run(r);assert.equal(a.rounds.length,36);
 for(let i=0;i<a.rounds.length;i++)for(const side of ['me','enemy']){
  assert.deepEqual(a.rounds[i].teamStates[side],b.rounds[i].teamStates[side]);
  for(const s of a.rounds[i].teamStates[side]){assert.ok(Number.isInteger(s.hp));assert.ok(Number.isInteger(s.energy));}
 }
 const wind=a.rounds.find(t=>t.round===5).sides.me.actions.find(a=>a.event.skillId===351);assert.equal(wind.energyCost,0);
});
