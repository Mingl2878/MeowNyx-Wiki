'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const helper=require('../js/battle-action-outcomes.js');
const catalog=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../data/catalog.json'),'utf8'));
const copy=v=>JSON.parse(JSON.stringify(v));
function fixture(skillId=164){
  const victim={id:'original',round:23,seq:123,execIndex:1,kind:'effect',phase:'interrupted',side:'enemy',actor:'v',skillClass:'system',protocolSkillId:'700001000',label:'聚能'};
  const response={id:'response',round:23,seq:123,execIndex:2,kind:'skill',phase:'executed',side:'me',actor:'s',skillId,skillClass:'response',combat:{responseAttempt:true,counteredActionId:'original'}};
  const death={id:'death',round:23,seq:123,execIndex:21,kind:'effect',phase:'executed',side:'enemy',actor:'v',combat:{actionId:'response',leaveReason:'defeat'}};
  return {event:victim,record:{version:1,id:'test',sides:{me:{pets:[{instanceId:'s',monsterId:348}]},enemy:{pets:[{instanceId:'v',monsterId:202},{instanceId:'other',monsterId:1}]}},events:[victim,response,death]}};
}
const label=f=>helper.interruptionLabel(f.event,f.record,catalog);

test('special label only when explicit counter + same-source confirmed defeat + interrupted original',()=>{
  const f=fixture(),before=JSON.stringify(f);assert.equal(label(f),'被应对击败');assert.equal(JSON.stringify(f),before);
  f.record.events.reverse();assert.equal(label(f),'被应对击败');
  f.record.events.push(copy(f.event));assert.equal(label(f),'被应对击败');
  f.event.kind='skill';f.event.skillId=321;delete f.event.protocolSkillId;f.event.skillClass='ordinary';f.record.events=f.record.events.filter(e=>e.id!=='original');f.record.events.push(f.event);assert.equal(label(f),'被应对击败');
  const sw=fixture();sw.record.events[2]={...sw.record.events[2],kind:'switch',actor:'other',target:'v',targetSide:'enemy'};assert.equal(label(sw),'被应对击败');
});

test('all four resolved canonical stable interruptor IDs retain parent default even if lethal',()=>{
  for(const s of helper.interruptors){assert.equal(catalog.skills.find(row=>row.id===s.id).name,s.name);const f=fixture(s.id);assert.equal(label(f),null);f.record.events[1].label='天洪';assert.equal(label(f),null);}
  const f=fixture();f.record.events[1].label='斩断';assert.equal(label(f),'被应对击败'); // labels never decide identity
});

test('unknown/nonlethal/unlinked/wrong-victim/ambiguous/phase cases do not replace default',()=>{
  const changes=[
    f=>delete f.record.events[1].skillId,
    f=>f.record.events[1].skillId=999999,
    f=>delete f.record.events[1].combat.counteredActionId,
    f=>f.record.events[1].combat.counteredActionId='neighbor',
    f=>delete f.record.events[2].combat.actionId,
    f=>f.record.events[2].combat.actionId='neighbor',
    f=>f.record.events[2].combat.leaveReason='forced',
    f=>delete f.record.events[2].combat.leaveReason,
    f=>f.record.events[2].actor='other',
    f=>f.record.events[2].side='me',
    f=>f.record.events[1].phase='interrupted',
    f=>f.record.events[1].skillClass='ordinary',
    f=>f.record.events[1].combat.responseAttempt=false,
    f=>f.record.events[1].side='enemy',
    f=>f.record.events[1].actor='unknown',
    f=>f.record.events[2].seq=123.5,
    f=>delete f.record.events[2].execIndex,
    f=>f.record.events[2].execIndex=1,
    f=>f.event.phase='executed',
    f=>f.event.side='unknown',
    f=>f.event.actor='unknown',
    f=>f.record.events.push({...f.record.events[1],id:'second-response'}),
    f=>f.record.events.push({...f.record.events[2],combat:{leaveReason:'defeat',actionId:'conflict'}}),
    f=>f.record.sides.enemy.pets.push(copy(f.record.sides.enemy.pets[0]))
  ];
  for(const [i,change] of changes.entries()){const f=fixture();change(f);assert.equal(label(f),null,`negative ${i}`);}
  const f=fixture();assert.equal(helper.interruptionLabel(f.event,f.record,{schema_version:999}),null);
  assert.equal(helper.interruptionLabel(copy({...f.event,skillId:123}),f.record,catalog),null);
});

test('HP0 leader form/heal and causal neighbors never manufacture death or counter edges',()=>{
  const f=fixture();f.record.events=f.record.events.slice(0,2);
  const damage={id:'damage',round:23,seq:123,execIndex:20,kind:'damage',phase:'executed',side:'me',actor:'s',target:'v',targetSide:'enemy',hpChange:-319,hpAfter:0,combat:{actionId:'response',hpBefore:319}};
  f.record.events.push(damage,{id:'form',round:23,seq:123,execIndex:21,kind:'form',phase:'executed',side:'enemy',actor:'v',form:{fromMonsterId:202,toMonsterId:203,execIndex:21}},
    {id:'heal',round:23,seq:123,execIndex:22,kind:'heal',phase:'executed',side:'enemy',actor:'v',target:'v',targetSide:'enemy',hpAfter:500});
  assert.equal(label(f),null);
  // Even definite death and nearby damage are insufficient without an explicit
  // death actionId. Likewise target information never replaces counteredActionId.
  const linked=fixture();delete linked.record.events[2].combat.actionId;linked.record.events.push(damage);assert.equal(label(linked),null);
  const neighbor=fixture();delete neighbor.record.events[1].combat.counteredActionId;neighbor.record.events[1].target='v';neighbor.record.events[1].targetSide='enemy';assert.equal(label(neighbor),null);
  const stun=fixture();stun.event.kind='skill';stun.event.protocolSkillId='700001200';stun.event.skillClass='ordinary';assert.equal(label(stun),null);
});

test('legacy pure getMoves callback resolves stable source IDs',()=>{
  const f=fixture();const moves=catalog.skills.map(s=>({id:s.id,localized:{zh:{name:s.name}}}));
  assert.equal(helper.interruptionLabel(f.event,f.record,{getMoves:()=>moves}),'被应对击败');
  assert.equal(helper.interruptionLabel(f.event,f.record,{getMoves:()=>{throw Error('unavailable')}}),null);
});

test('actual frozen7 R23 charge + Tianhong lacks explicit links and stays default',t=>{
  const file=process.env.BATTLE_HISTORY_AUDIT_RECORDS||path.resolve(__dirname,'../../records-before.json');
  if(!fs.existsSync(file)){t.skip('isolated frozen normalized snapshots unavailable');return;}
  const raw=fs.readFileSync(file),records=JSON.parse(raw).records;
  const r=records.find(r=>r.id==='rkpp:2306377934505522485'),event=r.events.find(e=>e.id==='rkpp:2306377934505522485:live:23:123:1:cast:1');assert.ok(event);
  assert.equal(event.phase,'interrupted');const response=r.events.find(e=>e.id==='rkpp:2306377934505522485:live:23:123:2:cast:405');assert.equal(response.skillId,164);assert.equal(response.combat?.counteredActionId,undefined);
  const before=JSON.stringify(records);assert.equal(helper.interruptionLabel(event,r,catalog),null);
  const specials=[];
  for(const record of records)for(const e of record.events.filter(e=>e.phase==='interrupted')) if(helper.interruptionLabel(e,record,catalog)) specials.push([record.id,e.id]);
  assert.deepEqual(specials,[['rkpp:1876469132858231449','rkpp:action:8:45:1:cast']]);
  const old=records.find(r=>r.id==='rkpp:1876469132858231449'),source=old.events.find(e=>e.id==='rkpp:action:8:45:2:cast'),death=old.events.find(e=>e.id==='rkpp:action:8:45:25:faint');
  assert.deepEqual([source.skillId,source.combat.counteredActionId],[303,'rkpp:action:8:45:1:cast']);
  assert.deepEqual([death.actor,death.side,death.combat.leaveReason,death.combat.actionId],['6','me','defeat',source.id]);
  assert.equal(JSON.stringify(records),before);assert.deepEqual(fs.readFileSync(file),raw);
  t.diagnostic('R23: interrupted charge, response164, damage links to response, confirmed defeat; counteredActionId and defeat.actionId missing. No special label asserted.');
});
