'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {readProjectData}=require('./catalog-read-fixture.cjs');
const root=path.resolve(__dirname,'..'),monsters=readProjectData('monsters.json');
test('three reviewed supplements preserve one complete entry per line',()=>{
 for(const [id,count] of [[510,5],[646,6],[647,20]]){
  const m=monsters.find(m=>m.id===id),lines=m._trait_notes.split('\n');assert.equal(lines.length,count);assert.ok(lines.every(line=>line.trim()));
  if(id!==510)for(let i=0;i<count;i++)assert.ok(lines[i].startsWith('点数'+(i+1)));
 }
 const final=monsters.find(m=>m.id===647)._trait_notes.split('\n').at(-1);assert.match(final,/敌方失去百分之二十生命值和二能量$/);
 assert.equal(monsters.find(m=>m.id===510)._trait_notes,'音波弹+15威力\n音爆+20威力\n金属噪音+20威力\n午夜噪音+5威力\n广播+20威力');
});
test('new notes use the same default fold and expansion path as beast flower',()=>{
 const source=fs.readFileSync(path.join(root,'js/pages/petdex.js'),'utf8');
 assert.match(source,/collapsedTraits = new Set\(\[129, 467, 468, 469, 509, 510, 646, 647\]\)/);
 assert.match(source,/collapsible = \[129, 467, 468, 469, 509, 510, 646, 647\]\.includes\(m\.id\)/);
 assert.match(source,/collapsed \? traitDesc\.split\('\\n'\)\[0\]/);
 assert.match(source,/RKData\.traitDescriptionHtml\(visibleDesc, m\.id\)\.replace\(\/\\n\/g, '<br>'\)/);
});
