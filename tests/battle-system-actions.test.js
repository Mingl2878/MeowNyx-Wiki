'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const api=require('../js/battle-system-actions.js'),root=path.resolve(__dirname,'..');
test('confirmed stun skip is a pure exact protocol exclusion, never ordinary/system action metadata',()=>{
 const base={kind:'skill',phase:'executed',skillClass:'ordinary',skillId:0,protocolSkillId:'700001200'};
 for(const phase of ['executed','interrupted'])for(const skillClass of [undefined,'','unknown','ordinary','response'])for(const skillId of [undefined,0]){
  const event=Object.freeze({...base,phase,skillClass,skillId,label:'not an identity source'}),before=JSON.stringify(event);
  assert.equal(api.isStunSkip(event),true);assert.equal(api.isNoAction(event),true);assert.equal(api.resolve(event),null);assert.equal(JSON.stringify(event),before);
 }
 for(const patch of [
  {protocolSkillId:700001200},{protocolSkillId:'0700001200'},{protocolSkillId:'700001201'},{protocolSkillId:'7000012000'},{protocolSkillId:'700001200\n'},{protocolSkillId:undefined,label:'眩晕'},
  {protocolSkillId:'700001199',label:'眩晕 · 未执行行动'},{skillId:37},{skillId:'0'},{skillId:null},{skillId:-1},
  ...['damage','resource','effect','note',undefined].map(kind=>({kind})),
  ...['passive','system',null,'other'].map(skillClass=>({skillClass})),
  ...['preview','selected','unknown',undefined].map(phase=>({phase}))
 ])assert.equal(api.isNoAction({...base,...patch}),false,JSON.stringify(patch));
 for(const value of [undefined,null,0,'700001200'])assert.equal(api.isNoAction(value),false);
 assert.equal(api.resolve({...base,combat:{actionKind:'wishImpact',typeId:8}}),null,'A skip cannot acquire wish metadata from contradictory combat flags');
 assert.equal(api.metadata('stunSkip'),null,'No fabricated category, power or energy cost for a non-action');
});
test('system actions have reviewed metadata without fabricated ordinary skill ids',()=>{
 const c=api.resolve({kind:'effect',skillClass:'system',protocolSkillId:'700001000',phase:'executed'});
 assert.equal(c.name,'聚能');assert.equal(c.energyCost,0);assert.equal(c.category,'status');assert.equal(c.description,'获得5点能量。');assert.equal(c.power,null);assert.equal(c.skillId,undefined);
 const w=api.metadata('wishImpact',8);assert.equal(w.energyCost,2);assert.equal(w.power,80);assert.equal(w.counterPower,200);assert.equal(w.categoryLabel,'物攻/魔攻');assert.match(w.description,/双攻更高/);assert.match(w.description,/威力\+150%/);
 assert.equal(api.resolve({kind:'skill',skillId:113,label:'愿力冲击'}),null);assert.equal(api.resolve({kind:'damage',protocolSkillId:'700001000'}),null);
 assert.equal(api.resolve({kind:'effect',skillClass:'system',protocolSkillId:'700001000',combat:{actionKind:'wishImpact'}}),null);
});
test('all eighteen typed wish icons and charge are delivered as actual validated images',()=>{
 const charge=fs.readFileSync(path.join(root,api.metadata('charge').icon));assert.equal(charge.toString('ascii',0,4),'RIFF');assert.equal(charge.toString('ascii',8,12),'WEBP');
 const icons=new Set();for(let id=1;id<=18;id++){
  const x=api.resolve({kind:'skill',combat:{actionKind:'wishImpact',typeId:id}});assert.equal(x.typeId,id);assert.equal(x.icon,`assets/system-actions/wish-${id}.png`);icons.add(x.icon);
  const bytes=fs.readFileSync(path.join(root,x.icon));assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),128);assert.equal(bytes.readUInt32BE(20),128);
 }assert.equal(icons.size,18);
 for(const value of [null,undefined,0,19,-1,'8',1.5,NaN])assert.equal(api.metadata('wishImpact',value).icon,null);
});
test('wish physical or magic display uses only verified current values and keeps ties unknown',()=>{
 assert.equal(api.metadata('wishImpact',8,{attack:900,magicAttack:1}).category,'adaptive');
 assert.equal(api.metadata('wishImpact',8,{statsVerified:true,attack:200,magicAttack:120}).category,'physical');
 assert.equal(api.metadata('wishImpact',8,{statsVerified:true,attack:120,magicAttack:200}).category,'magic');
 assert.equal(api.metadata('wishImpact',8,{statsVerified:true,attack:200,magicAttack:200}).category,'adaptive');
 assert.equal(api.metadata('wishImpact',8,{statsVerified:true,attack:Infinity,magicAttack:200}).category,'adaptive');
 const first=api.metadata('charge');first.energyCost=99;assert.equal(api.metadata('charge').energyCost,0);
});
test('runtime index loads the new pure helpers before battle page',()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 for(const script of ['js/battle-system-actions.js','js/battle-time-filters.js']){
  assert.ok(html.indexOf(script)>=0);assert.ok(html.indexOf(script)<html.indexOf('js/pages/battle-records.js'));
 }
});
