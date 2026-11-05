'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {readProjectData}=require('./catalog-read-fixture.cjs');const root=path.resolve(__dirname,'..'),monsters=readProjectData('monsters.json');
const context=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(root,'js/data.js'),'utf8'),context);const data=vm.runInContext('RKData',context);
test('only cloud dolphin stage and approved inherited notes are aligned',()=>{
 const m=id=>monsters.find(x=>x.id===id);assert.equal(m(649).evolution_stage,'初级形态');assert.equal(m(649).season,'S4');
 for(const [lower,higher]of [[509,510],[467,469],[468,469]]){
  assert.equal(m(lower)._trait_notes,m(higher)._trait_notes);assert.equal(m(lower).trait.localized.zh.description,m(higher).trait.localized.zh.description);
  assert.equal(m(lower).evolution_stage,'基础形态');
 }
});
test('reviewed dice labels show every existing type icon, not result labels',()=>{
 for(const [id,count]of [[646,6],[647,18]]){
  const m=monsters.find(x=>x.id===id),before=JSON.stringify(m),trait=data.getTraitInfo(m),html=data.buildTraitDetailHtml(trait.name,trait.desc,id);
  assert.equal((html.match(/class="trait-point-type-icon"/g)||[]).length,count);
  assert.ok(html.includes('assets/icons/type/grass.png'));assert.ok(html.includes('assets/icons/type/light.png'));assert.ok(html.includes('assets/icons/type/fighting.png'));
  assert.equal(JSON.stringify(m),before);
  if(id===647){assert.ok(html.includes('点数1（大失败）'));assert.ok(html.includes('点数20(大成功）'));}
  assert.equal((data.buildTraitDetailHtml(trait.name,trait.desc,999999).match(/trait-point-type-icon/g)||[]).length,0);
 }
});
test('dice icons safely escape other text and are used in all trait surfaces',()=>{
 const text='点数1（草）<script>x</script> 光 草 武\n点数20（大成功）';const html=data.traitDescriptionHtml(text,647);
 assert.equal((html.match(/trait-point-type-icon/g)||[]).length,1);assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes(' 光 草 武'));assert.ok(html.includes('大成功'));
 const pet=fs.readFileSync(path.join(root,'js/pages/petdex.js'),'utf8'),team=fs.readFileSync(path.join(root,'js/pages/team.js'),'utf8');
 assert.ok(pet.includes('RKData.traitDescriptionHtml(visibleDesc, m.id)'));assert.ok(pet.includes('RKData.buildTraitDetailHtml(traitName, traitDesc, m.id)'));assert.ok(team.includes('RKData.buildTraitDetailHtml(traitName, traitDesc, m.id)'));
});
