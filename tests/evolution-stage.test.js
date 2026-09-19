const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const monsters=JSON.parse(fs.readFileSync(path.join(root,'data/monsters.json'),'utf8'));
const byId=new Map(monsters.map(m=>[m.id,m]));

test('reviewed pre-evolutions are not mislabeled high: source metadata, not a page blacklist',()=>{
  for(const [id,name,child] of [[197,'阿米樱',198],[436,'吸泥鸥',437],[608,'焰米龙',603]]){
    const m=byId.get(id),next=byId.get(child);
    assert.equal(m.localized.zh.name,name);assert.equal(m.evolution_stage,'基础形态');
    assert.equal(next.evolves_from_id,id);assert.notEqual(next.dex_number,m.dex_number);
    assert.equal(m.learnset_mode,'own','classification must not replace independent learning sets');
  }
  assert.equal(byId.get(198).evolution_stage,'首领形态');
  assert.equal(byId.get(437).evolution_stage,'首领形态');
  assert.equal(byId.get(603).evolution_stage,'高级形态');
  assert.equal(byId.get(198).learnset_inherits_from_id,197);
  assert.equal(byId.get(437).learnset_inherits_from_id,436);
});

test('runtime high filter uses corrected source classification and keeps all IDs/own learnsets',async()=>{
  const context={console:{log(){},error(){}},fetch:async f=>({ok:true,json:async()=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'))})};
  vm.createContext(context);
  for(const file of ['js/battle-math.js','js/monster-identity.js','js/data.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
  const api=vm.runInContext('RKData',context);await api.init();
  const high=api.getMonsters().filter(m=>m.evolution_stage==='高级形态'&&!m.hidden);
  for(const id of [197,436,608]){
    assert.ok(!high.some(m=>m.id===id));
    assert.equal(api.getMonsterById(id).id,id);
    assert.ok(api.getExactWikiData(id)?.skills?.length||api.getExactWikiData(api.getMonsterById(id))?.skills?.length);
  }
  assert.ok(high.some(m=>m.id===603));
});

test('removed speed explanation does not remove threshold input or alter policy semantics',()=>{
  const code=fs.readFileSync(path.join(root,'js/pages/settings.js'),'utf8');
  assert.ok(!code.includes('速度综合：基础速度达到门槛时计入整项速度'));
  assert.ok(code.includes('set-effective-threshold'));assert.ok(code.includes("'速度综合'"));
});
