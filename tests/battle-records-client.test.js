'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const math = require('../js/battle-math.js'), client = require('../js/battle-records.js');
const evidence = (value, certainty = 'direct') => ({ value, certainty });
const pet = () => ({ instanceId:'enemy-1', monsterId:203, level:60, iv:{}, nature:{} });
const condition = changes => ({ id:'c1',side:'enemy',instanceId:'enemy-1',stat:'attack',kind:'damageDealt',knownStat:211,power:170,damage:160,level:60,reduction:1,effectiveness:1,samePriority:false,modifiersKnown:true,before:false,provenance:'isolated verified conditions',round:1,...changes });
const record = () => ({ version:1,id:'isolated-test',mode:'pvp',outcome:'win',sides:{me:{pets:[]},enemy:{pets:[pet()]}},events:[],constraints:[] });

test('exact IV API keeps boolean callers bit-identical; no clamping malformed snapshot IV',()=>{
  for(const base of [0,1,25,99,100,119,150]) for(const stat of ['hp','attack']) for(const nature of [0,1,2]) for(const level of [1,8,59,60,69,99]) for(const iv of [false,true])
    assert.equal(math.statFromBase(base,stat,nature,iv,level),math.statFromEffectiveIV(base,stat,nature,iv?60:0,level));
  assert.notEqual(math.statFromEffectiveIV(150,'attack',1,42),math.statFromBase(150,'attack',1,true));
  for(const invalid of [-1,61,42.5,NaN,Infinity,'42',true]) assert.ok(Number.isNaN(math.statFromEffectiveIV(100,'hp',0,invalid)));
});
test('snapshot only applies direct/unique values including genuine zero; unknown/candidate remain unknown',()=>{
  const p=pet();p.iv={hp:evidence(0),attack:{certainty:'candidate',value:60,candidates:[42,60]}};p.nature={hp:evidence(0,'unique')};
  const v=client.snapshotValues(p);assert.deepEqual(v.iv,{hp:0});assert.deepEqual(v.nature,{hp:0});assert.equal(v.unknown.length,10);
  assert.deepEqual(client.candidates(p,'attack','iv'),[42,60]);p.iv.attack.candidates.push('60',-1,80,42);assert.deepEqual(client.candidates(p,'attack','iv'),[42,60]);
  assert.equal(client.snapshotValues({...p,level:null}).level,null);
});
test('session handoff clones values and never mutates source; no browser storage needed',()=>{
  client.clearRecord();let calls=0;const off=client.subscribe(()=>calls++),r=record();client.useRecord(r);r.sides.enemy.pets[0].monsterId=999;
  assert.equal(client.getRecord().sides.enemy.pets[0].monsterId,203);const got=client.getRecord();got.id='changed';assert.equal(client.getRecord().id,'isolated-test');
  off();client.clearRecord();assert.equal(calls,1);assert.equal(client.getRecord(),null);
  assert.throws(()=>client.useRecord({version:2,id:'bad',sides:{}}));
});
test('joint IV/nature enumeration keeps observed true pair and respects exact single-hit floor',()=>{
  const p=pet(), actual=math.statFromEffectiveIV(100,'attack',1,42), damage=math.normalDamage(actual,170,211);
  const found=client.inferStat(p,'attack',[condition({damage})],100);
  assert.ok(found.pairs.some(x=>x.iv===42&&x.nature===1));
  assert.ok(found.pairs.every(x=>math.normalDamage(x.value,170,211)===damage));
  assert.equal(found.iv.certainty,found.iv.candidates.length===1?'unique':'candidate');
});
test('direct evidence constrains inference, no overwrite of direct values; zero retained',()=>{
  const p=pet();p.iv.attack=evidence(0);const actual=math.statFromEffectiveIV(100,'attack',1,0);
  const c=condition({power:10000,knownStat:1,damage:math.normalDamage(actual,10000,1)});
  const f=client.inferStat(p,'attack',[c],100);assert.ok(f.pairs.every(x=>x.iv===0));assert.equal(f.nature.value,1);
  const r=record();r.sides.enemy.pets=[p];r.constraints=[c];const out=client.analyzeRecord(r,{getMonsterById:()=>({}),getBaseStat:()=>100});
  assert.equal(out.sides.enemy.pets[0].iv.attack.certainty,'direct');assert.equal(out.sides.enemy.pets[0].nature.attack.value,1);assert.deepEqual(r.sides.enemy.pets[0].nature,{});
});
test('received damage uses attacker level separately from target level',()=>{
  const p={...pet(),level:99}, defense=math.statFromEffectiveIV(100,'defense',0,42,99);
  const c=condition({stat:'defense',kind:'damageReceived',knownStat:220,power:130,damage:math.normalDamage(220,130,defense,0.5,1,60),reduction:0.5});
  const f=client.inferStat(p,'defense',[c],100);assert.ok(f.pairs.some(x=>x.iv===42&&x.nature===0));
});
test('same-speed ties do not eliminate candidates in either order',()=>{
  const p=pet(),known=math.statFromEffectiveIV(100,'speed',0,42),c=condition({stat:'speed',kind:'speedOrder',samePriority:true,knownStat:known});
  for(const before of [true,false]) {const f=client.inferStat(p,'speed',[{...c,before}],100);assert.ok(f.pairs.some(x=>x.iv===42&&x.nature===0));}
});
test('incomplete/invalid conditions fail closed and conflicting evidence does not save a guess',()=>{
  const p=pet();
  for(const patch of [{modifiersKnown:false},{knownStat:0},{power:NaN},{damage:-1},{damage:1.1},{level:99},{reduction:0},{effectiveness:5}])
    assert.throws(()=>client.inferStat(p,'attack',[condition(patch)],100));
  assert.throws(()=>client.inferStat({...p,level:null},'attack',[condition()],100));
  assert.throws(()=>client.inferStat(p,'speed',[condition({stat:'speed',kind:'speedOrder',samePriority:false})],100));
  assert.throws(()=>client.inferStat(p,'attack',[condition({damage:0,power:10000})],100),/冲突/);
});
test('unmapped species is not identified by name, and inference does not use cached or current calculator parameters',()=>{
  const r=record();r.sides.enemy.pets[0].name='神谕鲨';r.sides.enemy.pets[0].monsterId=0;r.constraints=[condition()];
  const result=client.analyzeRecord(r,{getMonsterById:()=>null,getBaseStat:()=>{throw Error('must not access guessed species');}});
  assert.deepEqual(result,r);
});
test('write barrier waits pending mutation and reports in-flight failure',async()=>{
  let done;const p=client.track(new Promise(resolve=>{done=resolve;}));let finished=false;const flush=client.flush().then(x=>{finished=true;return x;});
  await Promise.resolve();assert.equal(finished,false);done();await p;assert.equal(await flush,true);
  let reject;client.track(new Promise((_,r)=>{reject=r;}));const failing=client.flush();reject(Error('test failure'));assert.equal(await failing,false);
  assert.equal(await client.flush(),true);
});
