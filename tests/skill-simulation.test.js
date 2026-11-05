'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../js/skill-simulation.js'),moves=require('./catalog-read-fixture.cjs').readProjectData('moves.json');
const move=id=>moves.find(m=>m.id===id),pet={id:202};
for(const [id,increment]of Object.entries(S.POWER))test(`fixed permanent own power ${id}: independent past events`,()=>{
 let r={unknown:'preserve'};const base=move(+id).power;
 for(let n=1;n<=4;n++){const result=S.select(move(+id),pet,'right',r);r=result.record;assert.equal(result.values.basePower,base+n*increment);assert.equal(result.values.basePowerExpression,`${base}+(${n}*${increment})`);assert.equal(r.unknown,'preserve');}
 const reset=S.select(move(+id),pet,'left',r);assert.equal(reset.values.basePower,base);assert.equal(reset.record.powerCount,0);
});
for(const id of [131,464])test(`double ${id} uses exponent, safe overflow rejection`,()=>{
 const base=move(id).power;let r={};for(let n=1;n<=8;n++){const next=S.select(move(id),pet,'right',r);r=next.record;assert.equal(next.values.basePower,base*2**n);assert.equal(next.values.basePowerExpression,`${base}*2^(${n})`);}
 assert.throws(()=>S.select(move(id),pet,'right',{powerCount:53}),/范围/);
});
for(const[id,[initial,step]]of Object.entries(S.COMBO))test(`combo growth ${id} does not amplify power`,()=>{
 const m=move(+id);let r={};for(let n=1;n<5;n++){const out=S.select(m,pet,'right',r);r=out.record;assert.equal(out.values.comboCount,initial+n*step);assert.equal(out.values.basePower,m.power);}
 assert.equal(S.select(m,pet,'left',r).values.comboCount,initial);
});
test('energy exact lookup and unknown source stays untouched',()=>{
 assert.equal(move(35).power,1);
 for(let n=0;n<=10;n++)assert.equal(S.input('energy',String(n)).basePower,S.ENERGY[n]);
 assert.equal(S.select(move(35),pet,'left').values.skillInputValue,'10');assert.equal(S.select(move(35),pet,'right').values.basePower,46);
 for(const value of ['11','-1','1.5','1,2','1+2','NaN',''])assert.throws(()=>S.input('energy',value));
});
test('HP ratio exact full 5% loss bands, not continuous scale or floating boundary',()=>{
 assert.equal(S.input('hp-ratio','77/100').basePower,200);
 for(let lost=0;lost<=100;lost++)assert.equal(S.input('hp-ratio',`${100-lost}/100`).basePower,240-10*Math.floor(lost/5));
 assert.equal(S.input('hp-ratio','308/400').basePower,200);
 assert.equal(S.select(move(19),pet,'right',{hpRatio:'77/100',extra:1}).values.basePower,200);
 for(const s of ['77/','1/0','-1/2','3/2','1.5/2','1/2,3','1/2/3','Infinity/2','1/9007199254740992'])assert.throws(()=>S.input('hp-ratio',s));
});
test('friend three keys: middle does not compound, next right clears counter mode',()=>{
 let out=S.select(move(510),pet,'right',{});assert.equal(out.values.basePower,90);
 out=S.select(move(510),pet,'middle',out.record);assert.equal(out.values.basePower,180);assert.equal(out.record.powerCount,1);
 out=S.select(move(510),pet,'middle',out.record);assert.equal(out.values.basePower,180);
 out=S.select(move(510),pet,'right',out.record);assert.equal(out.values.basePower,110);assert.equal(out.record.counterMode,false);
 out=S.select(move(510),pet,'left',out.record);assert.equal(out.values.basePower,70);assert.equal(out.record.powerCount,0);
});
test('trial power and combo counters are independent, no alternating inference',()=>{
 let r={};for(const key of ['right','right','middle','middle','right'])r=S.select(move(538),pet,key,r).record;
 const out=S.select(move(538),pet,'middle',r);assert.equal(out.values.basePower,50);assert.equal(out.values.comboCount,5);
 const reset=S.select(move(538),pet,'left',out.record);assert.equal(reset.values.basePower,20);assert.equal(reset.values.comboCount,2);
});
test('Garl friend and trial remain exempt; all/type/neighbour skill effects excluded',()=>{
 for(const p of [568,569])for(const id of [510,538])assert.equal(S.select(move(id),{id:p},'right',{}),null);
 for(const id of [375,539,518])assert.equal(S.kind(move(id),pet),null);
});
test('safe parser supports right associative powers without eval or commas/calls',()=>{
 assert.equal(S.evaluate('15*2^(3)'),120);assert.equal(S.evaluate('2^3^2'),512);assert.equal(S.evaluate('90+(3*45)'),225);assert.equal(S.evaluate('70+90'),160);
 assert.equal(S.evaluate('-2^2'),-4);assert.equal(S.evaluate('2^-2'),.25);
 for(const s of ['(1,2)','alert(1)','1;2','1/0','2^10000','0/0','1..2','1 2','Infinity','NaN','globalThis.x=1','2**3'])assert.throws(()=>S.evaluate(s),s);
 assert.throws(()=>S.select(move(41),pet,'right',{powerCount:-1}));assert.throws(()=>S.select(move(41),pet,'right',{powerCount:S.MAX_COUNT}));
});
