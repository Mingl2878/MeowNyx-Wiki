'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const helper = require('../js/battle-history-growth.js');
const {toLegacy} = require('../js/catalog-data.js');
const root = path.resolve(__dirname,'..');
const catalog = JSON.parse(fs.readFileSync(path.join(root,'data/catalog.json'),'utf8'));
const options = {catalog};
const {historicalAbu,abuTraitId}=require('./catalog-history-fixture.cjs');
const oldAbuOptions={catalog:historicalAbu(catalog)};
const clone = v => JSON.parse(JSON.stringify(v));
const cast = (id,skillId,seq,side='me',actor='c') => ({id,round:1,seq,kind:'skill',phase:'executed',side,actor,skillId,skillClass:'ordinary'});
const entry = seq => ({id:`entry${seq}`,round:1,seq,execIndex:0,kind:'switch',phase:'executed',side:'me',actor:'a',target:'c',targetSide:'me'});
function record(monsterId=202) {
  return {version:1,id:'history',quality:{actions:false,lead:{me:true,enemy:true}},sides:{
    me:{lead:'c',pets:[{instanceId:'a',monsterId},{instanceId:'c',monsterId:182}]},
    enemy:{lead:'b',pets:[{instanceId:'b',monsterId:1},{instanceId:'d',monsterId:1}]}
  },events:[]};
}
const snapshot = (r,id,opts=options) => helper.project(r,opts).entries.find(s=>s.eventId===id);
function count(s,n,mode='observedPrefix') { assert.equal(s.known,true); assert.equal(s.count,n); assert.equal(s.coverage.mode,mode); }

test('all22 definitions and support notes pinned exactly to Go/canonical registry',()=>{
  const go = fs.readFileSync(path.join(root,'battle_record_growth.go'),'utf8');
  const rows = [...go.matchAll(/^\s*\{"(trait-[^"]+)", "([^"]+)", "([^"]*)", "([^"]*)"\}/gm)]
    .map(([,traitId,name,description,derive])=>({traitId,name,description,derive}));
  assert.deepEqual(helper.rules,rows);
  assert.equal(rows.length,22);
  for(const r of rows) {
    const t=catalog.traits.find(t=>t.id===r.traitId);
    assert.deepEqual([r.name,r.description],[t.name,t.description]);
  }
  const audit=helper.project(record(),options).audit;
  assert.equal(audit.filter(r=>r.supported).length,16);
  assert.equal(audit.filter(r=>r.derive.startsWith('history')).length,13);
  for(const r of audit) assert.ok(r.note);
  for(const name of ['洄游','合拍','光度换算','猫精灵的礼物','花精灵','坚韧铠甲']) {
    const r=audit.find(r=>r.name===name); assert.equal(r.supported,false); assert.equal(r.derive,'');
  }
});

test('13 historical conditions use actual side/skill/category/cost, not config guesses',()=>{
  for(const [monster,skill] of [[202,155],[203,155],[311,187],[337,321],[341,113],[349,343],[545,113],[620,113],[596,155],[623,244]]) {
    const r=record(monster); const use=cast('use',skill,1); use.energyCost=3; r.events=[use,entry(2)];
    // 623's original exact definition remains supported in historical snapshots;
    // today's revised trait is not silently enrolled into that old rule.
    count(snapshot(r,'entry2',monster===623?oldAbuOptions:options),1);
  }
  for(const monster of [477,480]) {
    const r=record(monster); r.events=[{id:'charge',round:1,seq:1,kind:'effect',phase:'executed',side:'enemy',actor:'b',skillClass:'system',protocolSkillId:'700001000'},
      {id:'enemy-switch',round:1,seq:2,kind:'switch',phase:'executed',side:'enemy',actor:'d',target:'b'},entry(3)];
    count(snapshot(r,'entry3'),2);
    r.events[0].label='not-a-charge-name'; count(snapshot(r,'entry3'),2);
    delete r.events[0].protocolSkillId; r.events[0].label='聚能'; count(snapshot(r,'entry3'),1);
    r.quality.actions=true;r.events=[cast('unknown-enemy',0,1,'enemy','b'),entry(3)];
    assert.equal(snapshot(r,'entry3').count,null);assert.equal(snapshot(r,'entry3').coverage.unknownActions,1);
  }
  const r=record(290), target=cast('target',321,1,'enemy','b'), response=cast('response',164,2);
  target.phase='interrupted'; response.skillClass='response'; response.combat={counteredActionId:'target'};
  r.events=[target,response,entry(3)]; count(snapshot(r,'entry3'),1);
  delete response.combat; const s=snapshot(r,'entry3'); assert.equal(s.count,null); assert.equal(s.coverage.unknownActions,1);
  const cost=record(623); cost.events=[cast('dragon',245,1),entry(2)];
  assert.equal(snapshot(cost,'entry2',oldAbuOptions).count,null); // catalog energy_cost=3 is not actual cost evidence
  cost.events[0].energyCost=2; assert.equal(snapshot(cost,'entry2',oldAbuOptions).count,null);
});

test('revised leader and new ordinary Abu cannot inherit old entry-cost3 derivation by name or family',()=>{
  const before=JSON.stringify(catalog);
  assert.equal(oldAbuOptions.catalog.monsters.find(m=>m.id===623).trait_id,abuTraitId);
  for(const monster of [623,648]) {
    const m=catalog.monsters.find(m=>m.id===monster);
    assert.notEqual(m.trait_id,abuTraitId);
    assert.ok(!helper.rules.some(rule=>rule.traitId===m.trait_id));
    const r=record(monster),use=cast('cost3',245,1);use.energyCost=3;r.events=[use,entry(2)];
    const raw=JSON.stringify(r);
    for(const complete of [false,true]) {
      r.quality.actions=complete;
      assert.deepEqual(helper.project(r,options).entries,[],'unselected exact trait must not produce known entry count or fake zero');
    }
    r.quality.actions=false;assert.equal(JSON.stringify(r),raw);
  }
  assert.equal(JSON.stringify(catalog),before,'historical adapter must not rebind the current catalog');
});

test('frozen strict prefixes: duplicate casts/hits/forms/future actions never back-add',()=>{
  const r=record(200), water=cast('water',155,1), e=entry(2);
  const form={id:'form',round:1,seq:2,execIndex:1,kind:'form',phase:'executed',side:'me',actor:'a',form:{fromMonsterId:200,toMonsterId:202,execIndex:1}};
  r.events=[cast('future',161,3),form,e,water,clone(water),{id:'hit',round:1,seq:1,kind:'damage',phase:'executed',side:'me',actor:'c',hpChange:-1}];
  const before=JSON.stringify(r); const h=helper.project(r,options); const s=h.entries.find(s=>s.eventId===e.id);
  count(s,1); assert.equal(s.monsterId,200); assert.deepEqual(s.evidenceEventIds,['water']); assert.equal(h.entries.length,1); assert.equal(JSON.stringify(r),before);
  form.seq=1; form.execIndex=2; form.form.execIndex=2; water.execIndex=1; r.events=[form,e,water];
  count(snapshot(r,e.id),1); assert.equal(snapshot(r,e.id).monsterId,202);
  r.sides.me.pets[0].monsterId=595; assert.equal(helper.project(r,options).entries.length,0);
});

test('partial absence stays unknown; executed known prefixes exclude charge, stun, preview, interruption',()=>{
  const r=record();r.events=[entry(10)];assert.equal(snapshot(r,'entry10').count,null);
  r.quality.actions=true;count(snapshot(r,'entry10'),0,'completePrefix');r.quality.actions=false;
  r.events=[cast('water',155,1),cast('unknown',0,2),...['preview','interrupted','unknown'].map((phase,i)=>({...cast(`not-${phase}`,155,i+3),phase})),
    {id:'stun',round:1,seq:6,kind:'skill',phase:'executed',side:'me',actor:'c',protocolSkillId:'700001200'},
    {id:'charge',round:1,seq:7,kind:'effect',phase:'executed',side:'me',actor:'c',skillClass:'system',protocolSkillId:'700001000'},
    {id:'wish',round:1,seq:8,kind:'effect',phase:'executed',side:'me',actor:'c',skillClass:'system',combat:{actionKind:'wishImpact',typeId:4}},
    {id:'wish-unknown',round:1,seq:9,kind:'effect',phase:'executed',side:'me',actor:'c',skillClass:'system',combat:{actionKind:'wishImpact'}},entry(10)];
  let s=snapshot(r,'entry10');count(s,2);assert.equal(s.coverage.unknownActions,3);
  r.events[0].seq=10;s=snapshot(r,'entry10');count(s,1);assert.equal(s.coverage.ambiguousOrder,1);
  // Explicit actual combat type overrides canonical type, never current actor type.
  r.events=[{...cast('fire-actual-water',113,1),combat:{typeId:4}},entry(2)];count(snapshot(r,'entry2'),1);
  r.events[0].skillId=180; delete r.events[0].combat; assert.equal(snapshot(r,'entry2').count,null);
});

test('ambiguous casts/order/entry cycles fail closed, repeated entry notifications not extra snapshots',()=>{
  const r=record();const a=cast('a',155,1),b=cast('b',155,1);r.events=[a,b,entry(2)];
  assert.equal(snapshot(r,'entry2').count,null);assert.equal(snapshot(r,'entry2').coverage.ambiguousOrder,2);
  a.execIndex=0;b.execIndex=1;r.events=[b,a,entry(2)];count(snapshot(r,'entry2'),2);
  const affirmation={id:'affirm',round:1,seq:3,kind:'resource',phase:'executed',side:'me',actor:'a',stateStage:'entry',stateActive:true};
  r.events.push(affirmation);assert.equal(helper.project(r,options).entries.length,1);
  const conflicting=clone(a);conflicting.skillId=113;r.events.push(conflicting);assert.deepEqual(helper.project(r,options).entries,[]);
});

test('distinct types, explicit cap, changed definitions and unsupported traits do not overclaim',()=>{
  const distinct=record(596);distinct.events=[cast('water1',155,1),cast('water2',161,2),cast('fire',113,3),entry(4)];count(snapshot(distinct,'entry4'),2);
  const capped=record(545);capped.events=Array.from({length:12},(_,i)=>cast(`fire${i}`,113,i+1));capped.events.push(entry(13));count(snapshot(capped,'entry13'),10);
  const changed=clone(catalog);changed.traits.find(t=>t.id===snapshot(capped,'entry13').traitId).description+=' changed';assert.equal(snapshot(capped,'entry13',{catalog:changed}).count,null);
  for(const monster of [381,523,584,574,190,431]){const r=record(monster);r.events=[cast('cast',113,1),entry(2)];assert.equal(snapshot(r,'entry2').count,null);}
  assert.deepEqual(helper.project(capped,{catalog:{schema_version:999}}).entries,[]);
});

test('legacy RKData callback projection requires explicit stable trait identity',()=>{
  const legacy=toLegacy(catalog);
  // Exercise the real parent-owned static projection, not a name/ID test adapter.
  const monsters=new Map(legacy.monsters.map(m=>[m.id,m]));
  assert.equal(monsters.get(202)._trait_id,catalog.monsters.find(m=>m.id===202).trait_id);
  const opts={getMonsterById:id=>monsters.get(id),getMoves:()=>legacy.moves};
  const r=record();r.events=[cast('water',155,1),entry(2)];count(snapshot(r,'entry2',opts),1);
  delete monsters.get(202).trait_id;delete monsters.get(202)._trait_id;assert.equal(helper.project(r,opts).entries.length,0);
  assert.equal(helper.project(r,{getMonsterById:()=>{throw Error('unavailable')},getMoves:()=>legacy.moves}).entries.length,0);
});

test('actual old normalized record R22 displays exactly nine, frozen JSON stays byte-identical',t=>{
  const file=process.env.BATTLE_HISTORY_AUDIT_RECORDS || path.resolve(root,'..','records-before.json');
  if(!fs.existsSync(file)){t.skip('isolated frozen seven-record snapshot unavailable');return;}
  const raw=fs.readFileSync(file),input=JSON.parse(raw),r=input.records.find(r=>r.id==='rkpp:1876469132858231449');assert.ok(r);
  const before=JSON.stringify(r),catalogBefore=JSON.stringify(catalog),h=helper.project(r,options);
  const s=h.entries.find(s=>s.eventId==='rkpp:action:22:120:9:switch');count(s,9);assert.equal(s.unit,'层');
  assert.deepEqual([s.side,s.actor,s.monsterId],['me','5',202]);assert.equal(s.coverage.complete,false);assert.equal(s.evidenceEventIds.length,9);
  for(const id of s.evidenceEventIds){const e=r.events.find(e=>e.id===id);assert.ok(e.round>=13&&e.round<=21);assert.deepEqual([e.actor,e.skillId,e.phase],['2',155,'executed']);}
  assert.equal(h.entries.filter(s=>s.known).length,1);
  assert.equal(JSON.stringify(r),before);assert.equal(JSON.stringify(catalog),catalogBefore);assert.deepEqual(fs.readFileSync(file),raw);assert.equal(r.quality.actions,false);
  t.diagnostic(`frozen7 SHA256=${crypto.createHash('sha256').update(raw).digest('hex')}; old R22 known observed prefix=9`);
});
