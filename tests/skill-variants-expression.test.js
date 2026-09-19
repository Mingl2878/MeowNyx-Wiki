'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const V=require('../js/skill-variants.js'),moves=require('../data/moves.json');
const byId=id=>moves.find(m=>m.id===id);
const fixed={568:{510:['70+90','90+110'],535:['90+70','90+210'],506:['95+95','95+145']},569:{510:['70+90','110+130'],535:['90+90','210+210'],506:['95+95','145+145']}};
for(const [pet,entries]of Object.entries(fixed))for(const[id,expressions]of Object.entries(entries))test(`${pet}/${id} fixed additive display, one numeric release`,()=>{
  let state={atkPet:{id:Number(pet)},basePower:9999,comboCount:77,buff:35,starMeteor:4,fixedBonus:3,percentBonus:7,finalPowerManual:'0',mode:1};
  for(let repeat=0;repeat<3;repeat++)for(const [i,side]of ['left','right'].entries()){
    const next=V.select(state,byId(Number(id)),side).state;
    assert.equal(next.basePowerExpression,expressions[i]);assert.equal(next.basePower,expressions[i].split('+').reduce((s,n)=>s+Number(n),0));
    assert.equal(next.comboCount,1);for(const key of ['buff','starMeteor','fixedBonus','percentBonus','finalPowerManual','mode'])assert.equal(next[key],state[key]);
    assert.ok(V.tooltip(byId(Number(id)),state.atkPet).includes(expressions[i]));state=next;
  }
});
for(const [id,lp,rp]of [[501,125,185],[519,165,115],[522,135,70],[508,65,65],[526,70,70],[544,110,110]])test(`reviewed choice ${id} repeats same branch for black / other branch for white`,()=>{
  for(const petId of [568,569])for(const[side,a,b]of [['left',lp,rp],['right',rp,lp]]){
    const r=V.select({atkPet:{id:petId}},byId(id),side).state;
    assert.equal(r.basePowerExpression,a+'+'+(petId===569?a:b));assert.equal(r.basePower,a+(petId===569?a:b));
    assert.equal(r.comboCount,1);
  }
});
test('all base-only rows both buttons restore identical original source power and initial combos',()=>{
  const rows=V.audit(moves).rows.filter(r=>r.disposition==='base-only');assert.equal(rows.length,52);
  for(const row of rows)for(const petId of [568,569,202]){
    const seed={atkPet:{id:petId},basePower:99999,basePowerExpression:'1+99998',comboCount:22};
    const l=V.select(seed,byId(row.id),'left'),r=V.select(seed,byId(row.id),'right');
    assert.equal(l.applied,true);assert.deepEqual(l.state,r.state,row.name);assert.equal(l.state.basePower,byId(row.id).power);
    assert.equal(l.state.basePowerExpression,'');assert.equal(l.state.comboCount,row.left.comboCount);
  }
});
test('ordinary users and non-choice mentions cannot trigger Garl effects',()=>{
  for(const petId of [202,0,567])for(const id of [506,510,535])assert.equal(V.select({atkPet:{id:petId}},byId(id),'left').state.basePowerExpression,'');
  for(const petId of [568,569])for(const id of [4,322,538])assert.equal(V.select({atkPet:{id:petId}},byId(id),'left').state.basePowerExpression,'');
  const m=moves.find(m=>m.localized.zh.name==='做好事');if(m)assert.equal(V.select({atkPet:{id:569}},m,'left').state.basePowerExpression,'');
  const changed={...byId(535),power:123};assert.equal(V.forAttacker(changed,569).reviewed,false);assert.equal(V.select({atkPet:{id:569}},changed,'left').state.basePowerExpression,'');
});
test('expression validation rejects stale sums, non-sums, injection and unsafe numbers',()=>{
  assert.equal(V.powerExpression('90+90',180),'90+90');
  for(const [text,n]of [['90+90',181],['90+90;alert(1)',180],['1*180',180],['-90+90',0],['1e2+1',101],['9007199254740992+1',9007199254740992],['1+'.repeat(100)+'1',101]])assert.equal(V.powerExpression(text,n),'');
});
test('unknown formula icons stay ? with numeric selection presets, source data not changed',()=>{
  for(const[id,l,r]of [[10,100,160],[70,100,160],[376,80,120],[35,210,40]]){
    assert.equal(V.describe(byId(id)).displayPower,'?');assert.equal(V.select({},byId(id),'left').state.basePower,l);assert.equal(V.select({},byId(id),'right').state.basePower,r);
  }
  assert.equal(byId(10).power,0);assert.equal(byId(35).power,1);
});
