'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root,'js/pages/types.js'),'utf8');
const tools = vm.runInNewContext(source.split('const TypesPage =')[0] + '\nTypeTools;');
const plain = x => JSON.parse(JSON.stringify(x));
function fixture() {
  const effects = {A:{X:.5,Y:.5,Z:1},B:{X:.5,Y:1,Z:.5},C:{X:.5,Y:1,Z:.5},X:{X:2,Y:2,Z:1},Y:{X:.5,Y:.5,Z:1},Z:{X:2,Y:.5,Z:1}};
  const create = (id,main,sub,extra={})=>({id,dex_number:1,name:`精灵${id}`,main_type:{name:main},sub_type:sub?{name:sub}:null,evolution_stage:'高级形态',form_category:'主形态',total:100-id,...extra});
  const monsters = [create(1,'X','Y'),create(2,'X','Z'),create(3,'X'),create(4,'Z'),create(5,'X','Y',{hidden:true}),create(6,'X','Y',{is_leader_form:true}),create(7,'X','Y',{evolution_stage:'基础形态'}),create(8,'X','Y',{form_category:'变体形态'}),create(9,'None')];
  monsters.push(monsters[0]);
  return {ALL_TYPES:['A','B','C','X','Y','Z'],getTypeEn:t=>t,getTypeZh:t=>t,getTypeZhFull:t=>t,
    getMonsters:()=>monsters,getTotalStats:m=>m.total,getMonsterDisplayName:m=>m.name,
    getTypeEff:(a,b,c)=>{const e=(effects[a]?.[b]??1)*(c?(effects[a]?.[c]??1):1);return e===4?3:e;}};
}

test('single attack includes only exactly quarter resistance, with stable IDs',()=>{
  const data=fixture(),before=JSON.stringify(data.getMonsters());
  const model=tools.build(data,'attack',['A']);
  assert.deepEqual(plain(model.monsters.map(m=>m.id)),[1,8]);
  assert.equal(model.monsters.every(m=>m.effects[0].value===.25),true);
  assert.deepEqual(plain(model.resistanceCounts),[{value:.25,count:2}]);
  assert.equal(tools.resistanceTitle(model),'x0.25倍 抵抗精灵（共2只）');
  assert.ok(tools.text(model,true).includes('\nx0.25倍 抵抗精灵（共2只）\n'));
  const empty=tools.build(data,'attack',['X']);
  assert.deepEqual(plain(empty.resistanceCounts),[]);
  assert.equal(tools.resistanceTitle(empty),'x0.25倍 抵抗精灵（共0只）');
  assert.equal(JSON.stringify(data.getMonsters()),before);
  assert.equal(new Set(model.monsters.map(m=>m.id)).size,model.monsters.length);
});
test('multiple attacks must each be resisted; mixed and all-quarter are not multiplied',()=>{
  const model=tools.build(fixture(),'attack',['A','B']);
  assert.deepEqual(plain(model.monsters.map(m=>m.id)),[1,2,3,8]);
  assert.deepEqual(plain(model.monsters[0].effects.map(e=>e.value)),[.25,.5]);
  assert.deepEqual(plain(model.monsters[1].effects.map(e=>e.value)),[.5,.25]);
  assert.deepEqual(plain(model.monsters[2].effects.map(e=>e.value)),[.5,.5]);
  assert.ok(!model.monsters.some(m=>m.id===4)); // [1,.5] fails even though product <= .5
  assert.deepEqual(plain(model.resistanceCounts),[{value:.5,count:1},{value:.25,count:3}]);
  assert.equal(model.resistanceCounts.reduce((sum,c)=>sum+c.count,0),model.monsters.length);
  assert.equal(tools.resistanceTitle(model),'抵抗精灵（共4只丨1只×0.5丨3只×0.25）');
});
test('three selected attacks count mixed quarters once and all halves only in the half bucket',()=>{
  const model=tools.build(fixture(),'attack',['A','B','C']);
  assert.deepEqual(plain(model.monsters.map(m=>m.id)),[1,2,3,8]);
  assert.deepEqual(plain(model.monsters.map(m=>m.effects.map(e=>e.value))),[[.25,.5,.5],[.5,.25,.25],[.5,.5,.5],[.25,.5,.5]]);
  assert.deepEqual(plain(model.resistanceCounts),[{value:.5,count:1},{value:.25,count:3}]);
  const allQuarter=tools.build(fixture(),'attack',['B','C']);
  assert.deepEqual(plain(allQuarter.monsters.find(m=>m.id===2).effects.map(e=>e.value)),[.25,.25]);
  assert.deepEqual(plain(allQuarter.resistanceCounts),[{value:.5,count:4},{value:.25,count:1}]);
});
test('nineteen-monster title and per-attack copy lines match the approved formatting',()=>{
  const data=fixture();
  const create=(id,sub)=>({id,name:id===1?'白发路路':`精灵${id}`,main_type:{name:'X'},sub_type:sub?{name:sub}:null,total:100-id});
  data.getMonsters=()=>[...Array.from({length:17},(_,i)=>create(i+1)),create(18,'Y'),create(19,'Z')];
  data.getTypeZhFull=t=>({A:'光',B:'水',C:'地'})[t]||t;
  const model=tools.build(data,'attack',['A','B','C']),right=tools.text(model,true);
  assert.deepEqual(plain(model.resistanceCounts),[{value:.5,count:17},{value:.25,count:2}]);
  assert.equal(tools.resistanceTitle(model),'抵抗精灵（共19只丨17只×0.5丨2只×0.25）');
  assert.ok(right.includes('\n抵抗精灵（共19只丨17只×0.5丨2只×0.25）\n'));
  assert.ok(right.split('\n').includes('白发路路；光×0.5；水×0.5；地×0.5'));
  assert.equal(tools.monsterLabel(model.monsters[0]),'白发路路；光×0.5；水×0.5；地×0.5');
  assert.equal(tools.mapping(model.monsters[0].effects),'光×0.5；水×0.5；地×0.5');
  assert.doesNotMatch(right,/含×|[：:]×/);
});
test('forty-monster title uses count-first segments and the exact vertical separator in page and copy',()=>{
  const data=fixture();
  data.getMonsters=()=>Array.from({length:40},(_,i)=>({id:i+1,name:`精灵${i+1}`,main_type:{name:'X'},
    sub_type:i===38?{name:'Y'}:i===39?{name:'Z'}:null,total:100-i}));
  const model=tools.build(data,'attack',['A','B']);
  const title='抵抗精灵（共40只丨38只×0.5丨2只×0.25）';
  assert.deepEqual(plain(model.resistanceCounts),[{value:.5,count:38},{value:.25,count:2}]);
  assert.equal(tools.resistanceTitle(model),title);
  assert.ok(tools.text(model,true).split('\n').includes(title));
});
test('multi-attack titles omit empty buckets without changing eligibility',()=>{
  const data=fixture(),monsters=data.getMonsters();
  for(const [ids,counts,title] of [
    [[3],[{value:.5,count:1}],'抵抗精灵（共1只丨1只×0.5）'],
    [[2],[{value:.25,count:1}],'抵抗精灵（共1只丨1只×0.25）'],
    [[4],[],'抵抗精灵（共0只）']
  ]) {
    data.getMonsters=()=>monsters.filter(m=>ids.includes(m.id));
    const model=tools.build(data,'attack',['A','B']);
    assert.deepEqual(plain(model.resistanceCounts),counts);
    assert.equal(tools.resistanceTitle(model),title);
  }
});
for(const [values,redSegments] of [[[.25],1],[[.5,.5],0],[[.25,.5],1],[[.25,.25],2],[[.25,.5,.5],1],[[.25,.25,.5],2],[[.25,.25,.25],3]]) {
  test(`outer ring has exact ordered red segments for ${values}`,()=>{
    const ring=tools.ring(values.map(value=>({value})));
    assert.equal((ring.match(/ring-red/g)||[]).length,redSegments);
    values.forEach((value,i)=>assert.ok(ring.includes(`${value===.25?'var(--type-tools-ring-red)':'var(--type-tools-ring-neutral)'} ${i*360/values.length}deg ${(i+1)*360/values.length}deg`)));
  });
}
test('clipboard classifications use the same arrays and never include monsters on left copy',()=>{
  const model=tools.build(fixture(),'attack',['A','B']);
  const left=tools.text(model,false),right=tools.text(model,true);
  for(const c of model.categories)assert.ok(left.includes(`${c.title} (${c.items.length})：${c.items.map(e=>e.label).join('、')||'—'}`));
  assert.doesNotMatch(left,/精灵[0-9]|ID:/);
  assert.match(right,/精灵1；A×0.25；B×0.5/);
  assert.match(right,/精灵2；A×0.5；B×0.25/);
  assert.ok(right.includes('\n抵抗精灵（共4只丨1只×0.5丨3只×0.25）\n'));
  assert.doesNotMatch(right,/含×|[：:]×/);
  assert.equal((right.match(/精灵1；/g)||[]).length,1);
  assert.doesNotMatch(right,/<img|<div|conic-gradient|\[ID:|\d×|不将不同技能的倍率相乘/);
  assert.doesNotMatch(left,/不将不同技能的倍率相乘|\d×/);
});
test('defense preserves capped score classifications; right copy does not invent species lists',()=>{
  const model=tools.build(fixture(),'defense',['X','Y']);
  assert.equal(model.categories.find(c=>c.key==='triple').items.some(t=>t.type==='X'),true);
  assert.equal(model.categories.find(c=>c.key==='quarter').items.some(t=>t.type==='Y'),true);
  assert.equal(model.categories.find(c=>c.key==='neutral').items.some(t=>t.type==='Z'),true);
  assert.equal(model.grid.find(t=>t.type==='X').value,3);
  assert.equal(model.grid.find(t=>t.type==='Y').value,.25);
  assert.equal(model.monsters.length,0);
  assert.equal(tools.text(model,true),tools.text(model,false));
});
test('selection canonicalization removes duplicates/unknowns but retains selected order',()=>{
  const model=tools.build(fixture(),'attack',['B','A','B','unknown']);
  assert.deepEqual(plain(model.selected.map(s=>s.type)),['B','A']);
  assert.deepEqual(plain(model.monsters[0].effects.map(e=>e.type)),['B','A']);
  assert.match(tools.text(tools.build(fixture(),'attack',[]),true),/未选择\n请选择属性/);
});
test('path encoding preserves version query, encodes names, escapes HTML and blocks schemes/traversal',()=>{
  assert.equal(tools.imagePath('assets/monster/images/火 A.png?v=123'),'assets/monster/images/%E7%81%AB%20A.png?v=123');
  assert.equal(tools.imagePath('assets/%E7%81%AB.png?v=2'),'assets/%E7%81%AB.png?v=2');
  for(const value of ['https://bad.test/x.png','javascript:alert(1)','//host/x','assets/../x','assets/%2e%2e/x'])assert.equal(tools.imagePath(value),'');
  assert.equal(tools.escape('<"&\'>'),'&lt;&quot;&amp;&#39;&gt;');
});
test('actual RKData matrix: all single and paired attacks obey exact per-attack rules without modifying sources',async()=>{
  const files=['data/monsters.json','data/moves.json','data/types.json','data/wiki_monster_data.json'];
  const original=new Map(files.map(f=>[f,require('./catalog-read-fixture.cjs').readResource(root, f)]));
  // Keep the source-byte immutability assertion on the actual authoritative file(s).
  const sourceFiles=fs.existsSync(path.join(root,'data/catalog.json'))?['data/catalog.json']:files;
  const sourceBefore=new Map(sourceFiles.map(f=>[f,fs.readFileSync(path.join(root,f),'utf8')]));
  const context=vm.createContext({console,MonsterIdentity:require('../js/monster-identity.js'),fetch:async f=>({ok:true,json:async()=>JSON.parse(original.get(f))})});
  vm.runInContext(fs.readFileSync(path.join(root,'js/data.js'),'utf8')+'\nglobalThis.api=RKData;',context);
  await context.api.init();
  const data=context.api;
  const before=JSON.stringify(data.getMonsters());
  for(let a=0;a<data.ALL_TYPES.length;a++)for(let b=a;b<data.ALL_TYPES.length;b++) {
    const selection=a===b?[data.ALL_TYPES[a]]:[data.ALL_TYPES[a],data.ALL_TYPES[b]];
    const model=tools.build(data,'attack',selection);
    const expected=tools.pool(data).filter(m=>{
      if(!m.main_type?.name||m.main_type.name==='None')return false;
      const values=selection.map(t=>data.getTypeEff(t,m.main_type.name,m.sub_type?.name));
      return selection.length===1?values[0]===.25:values.every(v=>v<=.5);
    });
    assert.deepEqual(plain(model.monsters.map(m=>String(m.id)).sort()),plain(expected.map(m=>String(m.id)).sort()), 'same result membership');
    assert.ok(model.monsters.every(m=>m.effects.length===selection.length));
    const effects=expected.map(m=>selection.map(t=>data.getTypeEff(t,m.main_type.name,m.sub_type?.name)));
    const half=effects.filter(values=>values.every(v=>v===.5)).length;
    const quarter=effects.filter(values=>values.includes(.25)).length;
    assert.deepEqual(plain(model.resistanceCounts),[{value:.5,count:half},{value:.25,count:quarter}].filter(c=>c.count));
    assert.equal(half+quarter,model.monsters.length,'exclusive count buckets cover each eligible monster once');
    assert.doesNotMatch(tools.resistanceTitle(model),/含/);
    if(selection.length===1)assert.equal(tools.resistanceTitle(model),`x0.25倍 抵抗精灵（共${expected.length}只）`);
  }
  assert.equal(JSON.stringify(data.getMonsters()),before);
  for(const [f,content] of original)assert.equal(require('./catalog-read-fixture.cjs').readResource(root, f),content);
  for(const [f,content] of sourceBefore)assert.equal(fs.readFileSync(path.join(root,f),'utf8'),content);
});
test('clipboard/lifecycle are locally bound; no persistence or global contextmenu/middle handlers',()=>{
  assert.match(source,/CommonUI\.registerCleanup\(owner,dispose\)/);
  assert.match(source,/return \{render,onLeave\}/);
  assert.doesNotMatch(source,/localStorage|UserConfig|addEventListener\(['"]auxclick/);
  assert.match(source,/listen\(button,'contextmenu'/);
  assert.doesNotMatch(source,/listen\((?:window|document),'(?:contextmenu|click|keydown)'/);
  assert.match(source,/await navigator\.clipboard\.writeText\(payload\)/);
});
