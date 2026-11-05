'use strict';
// Deterministic DOM/event coverage of the actual closures. No browser geometry,
// real server/profile, source writes or external dependencies are involved.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const PetLevels = require('../js/pet-levels'), BattleMath = require('../js/battle-math');
const root = path.resolve(__dirname, '..'), source = file => fs.readFileSync(path.join(root, file), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const editor = source('js/pages/updatedata.js');
const {damageUI} = require('./damage-levels-ui-fixture.cjs');

test('both wolf menus use custom CSS buttons, floating four-option listboxes and plain grade output', () => {
  const h=damageUI();
  for(const side of ['attacker','defender']) {
    h.state[side==='attacker'?'atkPet':'defPet']=h.monsters[2];h.page.levelUI.updateFinalStats(side);
    const html=h.page.levelUI.buildLevelControls(side);
    assert.match(html,new RegExp(`<button type="button" class="damage-level-mode" id="${side}-level-mode"`));
    assert.doesNotMatch(html,/<select|<option|aria-haspopup="dialog"|level-button/);
    assert.equal(h.node(side,'level-value').tagName,'OUTPUT');
    assert.equal(h.node(side,'level-value').getAttribute('tabindex'),null);
    assert.equal(h.node(side,'level-value').count(),0);
    h.node(side,'level-mode').click();
    assert.deepEqual(h.layer(side).children.map(n=>[n.dataset.mode,n.textContent]),[['final','属性值'],['base','种族值'],['ming','冥古龙'],['abu','阿布']]);
    assert.equal(h.layer(side).getAttribute('role'),'listbox');
    assert.ok(h.layer(side).children.every(n=>n.tagName==='BUTTON'&&n.getAttribute('role')==='option'));
    h.key(h.document.activeElement,'Escape');assert.equal(h.layer(side),null);
    assert.match(html,/type="range" min="0" max="10" step="1"/);
    for(const name of ['decrease','increase'])assert.match(h.node(side,'level-'+name).getAttribute('aria-label'),/等级.*档/);
  }
});

test('wolf DOM switches base/final/simulation visibility and exact values without user-config writes', async () => {
  const h=damageUI(),a=h.page.CalcEngine;
  const before=clone(h.memory);
  for(const wolf of h.monsters.slice(0,3)) for(const side of ['attacker','defender']) {
    h.state[side==='attacker'?'atkPet':'defPet']=wolf;
    for(const mode of ['base','final','ming','abu']) {
      assert.equal(a.setWolfMode(side,mode),true);
      assert.equal(h.node(side,'level-mode').hidden,false);assert.equal(h.node(side,'level-mode').textContent,{base:'种族值',final:'属性值',ming:'冥古龙',abu:'阿布'}[mode]);
      assert.equal(h.cards[side].group.hidden,true);
      assert.equal(h.node(side,'level-controls').hidden,!['ming','abu'].includes(mode));
      assert.equal(h.renderedModes.filter(entry=>entry.side===side).at(-1).mode,mode==='base'?'base':'final');
      if(['ming','abu'].includes(mode)) {
        const defaults=mode==='ming'?99:60;
        assert.equal(h.node(side,'level-value').textContent,'lv：'+defaults);
        const grid=mode==='ming'?[1,9,19,29,39,49,59,69,79,89,99]:[60,62,64,66,68,70,72,74,76,78,80,82,84,86,88,90,92,94,96,98,99];
        assert.equal(h.node(side,'level-slider').max,grid.length-1);
        for(const level of grid) {
          assert.equal(await a.setLevelPreference(side,{slider:level}),true);
          assert.equal(h.node(side,'level-value').textContent,'lv：'+level);
          assert.equal(h.node(side,'level-slider').value,grid.indexOf(level));
          for(const item of h.cards[side].items) assert.equal(item.nodes['.stat-value'].textContent,BattleMath.statFromBase(100,item.dataset.stat,0,false,level));
        }
        assert.equal(await a.setLevelPreference(side,{manual:70}),false);
        a.setWolfMode(side,mode);assert.equal(a.effectiveLevel(side),defaults,'re-entering mode resets its exact default');
      }
    }
  }
  assert.deepEqual(h.memory,before);assert.equal(h.writes.length,0);
});

test('generic range buttons follow the configured grid and endpoints; ordinary controls survive', async () => {
  const h=damageUI(),a=h.page.CalcEngine;
  h.state.atkPet=h.monsters[4];h.page.levelUI.updateFinalStats('attacker');
  assert.equal(h.node('attacker','level-mode').hidden,true);assert.equal(h.node('attacker','level-controls').hidden,false);
  assert.equal(h.cards.attacker.group.hidden,true);assert.equal(h.node('attacker','level-value').textContent,'lv：60');
  assert.deepEqual(clone(a.levelSteps('attacker')),[50,53,60,67,74,80]);
  for(const [name,levels] of [['decrease',[53,50]],['increase',[53,60,67,74,80]]])for(const level of levels) {
    h.node('attacker','level-'+name).click();assert.equal(a.effectiveLevel('attacker'),level);
    assert.equal(h.node('attacker','level-value').textContent,'lv：'+level);
  }
  assert.equal(h.node('attacker','level-increase').disabled,true);
  const count=h.writes.length;h.node('attacker','level-increase').click();assert.equal(h.writes.length,count);
  h.key(h.node('attacker','level-slider'),'Home');assert.equal(a.effectiveLevel('attacker'),50);
  assert.equal(h.node('attacker','level-decrease').disabled,true);
  h.key(h.node('attacker','level-slider'),'End');assert.equal(a.effectiveLevel('attacker'),80);
  assert.equal(h.memory.rk_damage_levels[619].attacker.manual,'43');assert.ok(h.writes.every(w=>w.key==='rk_damage_levels'));
  h.state.atkPet=h.monsters[3];h.page.levelUI.updateFinalStats('attacker');assert.equal(a.effectiveLevel('attacker'),43);
  h.state.atkPet=h.monsters[5];h.page.levelUI.updateFinalStats('attacker');
  assert.equal(a.effectiveLevel('attacker'),60);assert.equal(h.cards.attacker.group.hidden,false);assert.equal(h.node('attacker','level-controls').hidden,true);
});
test('remembered43 stays untouched with a near43 thumb until +/- or slider takes ownership', () => {
  for(const [control,key,expected] of [['level-decrease',null,39],['level-increase',null,49],['level-slider','ArrowLeft',39],['level-slider','ArrowRight',49],['level-slider','input',9]]) {
    const h=damageUI(),a=h.page.CalcEngine;h.state.atkPet=h.monsters[3];h.page.levelUI.updateFinalStats('attacker');
    assert.equal(a.effectiveLevel('attacker'),43);assert.equal(h.node('attacker','level-value').textContent,'lv：43');
    assert.equal(h.node('attacker','level-slider').value,4);assert.match(h.node('attacker','level-slider').getAttribute('aria-valuetext'),/^43级/);
    assert.equal(h.writes.length,0);const node=h.node('attacker',control);
    if(key==='input'){node.value=1;node.emit('input');}else if(key)h.key(node,key);else node.click();
    assert.equal(a.effectiveLevel('attacker'),expected);assert.equal(a.levelRecord('attacker').manual,'');
    assert.equal(h.node('attacker','level-value').textContent,'lv：'+expected);
    assert.equal(h.memory.rk_damage_levels[619].attacker.extra,'keep');assert.equal(h.memory.rk_damage_levels[619].defender.slider,19);
  }
});

test('battle level overlay suppresses wolf menu and rejects mode changes without writing', async () => {
  const h=damageUI(),a=h.page.CalcEngine;
  h.page.battleSides.attacker={level:{slider:37,manual:''},iv:{},nature:{}};
  h.page.levelUI.updateFinalStats('attacker');
  assert.equal(h.node('attacker','level-mode').hidden,true);assert.equal(h.node('attacker','level-value').textContent,'lv：37');
  assert.equal(a.setWolfMode('attacker','ming'),false);assert.equal(a.effectiveLevel('attacker'),37);
  h.node('attacker','level-increase').click();assert.equal(a.effectiveLevel('attacker'),38);
  h.node('attacker','level-decrease').click();assert.equal(a.effectiveLevel('attacker'),37);
  const slider=h.node('attacker','level-slider');slider.value=41;slider.emit('input');assert.equal(a.effectiveLevel('attacker'),42);
  assert.equal(h.page.battleSides.attacker.unknownLevel,true);assert.equal(h.page.battleSides.attacker.level.manual,'');
  assert.equal(h.writes.length,0);
});

function editorUI(pet={id:77}, changes={}, response={ok:true}) {
  const elements=new Map(),requests=[];let click;
  const get=id=>{if(!elements.has(id))elements.set(id,{value:'0',checked:false,textContent:'',innerHTML:''});return elements.get(id);};
  const context=vm.createContext({PetLevels,document:{getElementById:id=>id==='ud-save-btn'?{addEventListener:(_event,fn)=>{click=fn;}}:get(id)},window:{confirm:()=>true},m:pet,RKData:{getCatalogRevision:()=> 'fixture-r1'},editorTypeSel:new Set(['Normal']),editorSkillList:[],originalSkillList:'[]',skillsLoaded:false,editorFormCategory:'无多形态',editorEvolvesFromID:null,originalPredecessor:null,editorLeaderOfID:null,originalLeaderBase:null,getEvoValue:()=> '基础形态',fetch:async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return{ok:response.ok,json:async()=>response};}});
  const helperStart=editor.indexOf('  function editorLevelSettings('),helperEnd=editor.indexOf('  function renderEditorForm(',helperStart);
  assert.ok(helperStart>=0&&helperEnd>helperStart);vm.runInContext(editor.slice(helperStart,helperEnd)+'\nthis.initialLevels=editorLevelSettings(m);this.markup=levelSettingsHtml(initialLevels);',context);
  for(const [key,value] of Object.entries(context.initialLevels)) {const el=get('ud-level-'+key);if(key==='enabled')el.checked=value;else el.value=String(value);}
  for(const [key,value] of Object.entries(changes)) {const el=get('ud-level-'+key);if(key==='enabled')el.checked=value;else el.value=String(value);}
  const marker="document.getElementById('ud-save-btn').addEventListener('click', async () => {",start=editor.indexOf(marker),end=editor.indexOf('\n\n    // 重置',start);
  assert.ok(start>=0&&end>start);vm.runInContext(editor.slice(start,end),context);
  return {requests,elements,context,save:()=>click(),result:()=>get('ud-save-result')};
}

test('editor renders complete native level settings and omits unchanged config while preserving loaded revision', async () => {
  for(const pet of [{id:77},{id:619,level_configurable:true,default_level:99},{id:88,trait:{localized:{zh:{description:'等级变化'}}}}]) {
    const h=editorUI(pet);assert.match(h.context.markup,/手动开启（特性含“等级”时自动开启）/);
    for(const field of ['default','min','max','step'])assert.match(h.context.markup,new RegExp(`id="ud-level-${field}"`));
    await h.save();assert.equal(h.requests.length,1);assert.equal(h.requests[0].body.base_revision,'fixture-r1');
    assert.equal(Object.hasOwn(h.requests[0].body,'level_controls'),false);assert.equal(Object.hasOwn(h.requests[0].body,'skillList'),false);
  }
});

test('editor sends one complete changed level policy, rejects invalid ranges before requests and keeps failure visible', async () => {
  const changed={enabled:true,default:60,min:50,max:99,step:2};
  const h=editorUI({id:77},changed);await h.save();assert.deepEqual(h.requests[0].body.level_controls,changed);
  assert.equal(h.requests[0].url,'/api/edit/monster');
  for(const changes of [{min:0},{max:100},{default:0},{step:0},{step:99},{step:1.5},{min:61,default:60},{min:70,max:69},{min:''},{default:100}]) {
    const bad=editorUI({id:77},changes);await bad.save();assert.equal(bad.requests.length,0,JSON.stringify(changes));assert.match(bad.result().textContent,/无效等级范围/);
  }
  const failed=editorUI({id:77},changed,{ok:false,error:'fixture revision conflict'});await failed.save();
  assert.match(failed.result().textContent,/fixture revision conflict/);assert.equal(failed.elements.get('ud-level-step').value,'2');
});

test('actual RKData with shared policy applies generic and wolf levels but never reads damage memory', async () => {
  const readResource=require('./catalog-read-fixture.cjs').readResource;
  const context=vm.createContext({console:{log(){},error(){}},window:{},fetch:async name=>({ok:true,json:async()=>JSON.parse(readResource(root,name))})});
  for(const file of ['js/battle-math.js','js/monster-identity.js','js/pet-levels.js','js/data.js'])vm.runInContext(source(file),context);
  await vm.runInContext('RKData.init()',context);const data=vm.runInContext('RKData',context);
  for(const id of [595,616,617]) {const pet=data.getMonsterById(id);assert.ok(pet);assert.equal(data.getPetLevel(pet),60);assert.equal(data.getPetLevel(pet,99),99);}
  const generic={id:900001,base_spd:100,trait:{localized:{zh:{name:'等级变化'}}},default_level:60,level_min:50,level_max:80,level_step:7};
  assert.equal(data.getPetLevel(generic),60);assert.equal(data.getPetLevel(generic,74),74);
  assert.equal(data.getPetStat(generic,'speed',0,false,74),BattleMath.statFromBase(100,'speed',0,false,74));
  const unrelated={id:900002,name:'银月狼王',default_level:99,evolution_members:[595]};assert.equal(data.getPetLevel(unrelated,99),60);
  assert.equal(data.getPetLevel(data.getMonsterById(619)),99);
});

test('layout selectors remain scoped and required module loads before dependent consumers', () => {
  const css=source('css/damage-levels.css'),html=source('index.html');
  for(const selector of ['.damage-level-mode[hidden]','.damage-level-value','.damage-level-controls[hidden]'])assert.ok(css.includes(selector));
  assert.match(css,/\.damage-level-mode\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
  assert.doesNotMatch(css,/\.calc-root\s+\.input-(?:row|group)|\.stats-header-with-button\s*\{|\.stats-title-row\s*\{/);
  assert.match(editor,/#ud-tab-content \.input-row\s*\{[^}]*flex-wrap:\s*wrap/);
  for(const script of ['js/data.js','js/pages/damage.js','js/pages/updatedata.js'])assert.ok(html.indexOf('js/pet-levels.js')<html.indexOf(script));
});
