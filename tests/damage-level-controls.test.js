'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {damageUI,realData}=require('./damage-levels-ui-fixture.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));

test('custom menu keyboard Enter/Space/arrows/Home/End/Escape and repeated Ming selection reset99',()=>{
  const h=damageUI(),a=h.page.CalcEngine,owner=h.node('attacker','level-mode');
  assert.equal(h.key(owner,'Enter').prevented,true);
  assert.equal(owner.getAttribute('aria-expanded'),'true');assert.equal(h.document.activeElement.dataset.mode,'final');
  h.key(h.document.activeElement,'ArrowDown');assert.equal(h.document.activeElement.dataset.mode,'base');
  h.key(h.document.activeElement,'ArrowRight');assert.equal(h.document.activeElement.dataset.mode,'ming');
  h.key(h.document.activeElement,' ');assert.equal(a.effectiveLevel('attacker'),99);assert.equal(h.layer(),null);
  assert.equal(h.document.activeElement,owner);assert.equal(owner.getAttribute('aria-controls'),null);
  h.node('attacker','level-decrease').click();assert.equal(a.effectiveLevel('attacker'),89);
  h.key(owner,' ');assert.equal(h.document.activeElement.dataset.mode,'ming');
  h.key(h.document.activeElement,'Enter');assert.equal(a.effectiveLevel('attacker'),99,'choosing already-selected Ming resets too');
  h.key(owner,'End');assert.equal(h.document.activeElement.dataset.mode,'abu');
  h.key(h.document.activeElement,'Home');assert.equal(h.document.activeElement.dataset.mode,'final');
  h.key(h.document.activeElement,'ArrowUp');assert.equal(h.document.activeElement.dataset.mode,'abu');
  h.key(h.document.activeElement,'ArrowLeft');assert.equal(h.document.activeElement.dataset.mode,'ming');
  h.key(h.document.activeElement,'End');h.key(h.document.activeElement,'Enter');assert.equal(a.effectiveLevel('attacker'),60);
  assert.equal(a.levelRecord('attacker').mode,'abu');
  for(const key of ['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End']) {
    h.key(owner,key);assert.ok(h.layer());const event=h.key(h.document.activeElement,'Escape');assert.equal(event.prevented,true);assert.equal(h.layer(),null);
  }
  assert.equal(h.writes.length,0);
});

test('outside/scroll/resize/zoom and owner cleanup use real CommonUI lifecycle without leaking listeners',()=>{
  const h=damageUI(),owner=h.node('attacker','level-mode');
  const listeners=[h.document.count(),h.window.count()],globals=Object.keys(h.context);
  for(const [target,event] of [[h.document,'pointerdown'],[h.document,'scroll'],[h.window,'resize'],[h.window,'appzoomchange'],[h.document,'keydown']]) {
    owner.click();const old=h.layer(),choice=old.children[2];assert.ok(old);
    target.emit(event,{target:event==='pointerdown'?h.document.body:target,key:'Escape'});
    assert.equal(h.layer(),null);assert.equal(owner.getAttribute('aria-expanded'),'false');
    choice.click();assert.equal(h.page.CalcEngine.effectiveLevel('attacker'),60,'detached choice is inert');
    assert.deepEqual([h.document.count(),h.window.count()],listeners);
  }
  owner.click();h.document.emit('pointerdown',{target:h.layer().children[1]});assert.ok(h.layer(),'inside interaction stays open');
  owner.click();assert.equal(h.layer(),null,'trigger toggles it closed');
  owner.click();h.CommonUI.destroyWithin(h.cards.attacker.card);
  assert.equal(h.layer(),null);assert.equal(owner.count(),0);assert.deepEqual([h.document.count(),h.window.count()],listeners);
  owner.click();assert.equal(h.layer(),null);assert.deepEqual(Object.keys(h.context),globals);
});

test('species change, battle overlay and route leave invalidate old options and stale controls',()=>{
  for(const action of ['species','battle','leave','detached']) {
    const h=damageUI(),a=h.page.CalcEngine,owner=h.node('attacker','level-mode');
    owner.click();const layer=h.layer(),choice=layer.children[2],slider=h.node('attacker','level-slider'),plus=h.node('attacker','level-increase');
    if(action==='species') {h.state.atkPet=h.monsters[0];h.page.levelUI.updateFinalStats('attacker');}
    if(action==='battle') {h.page.battleSides.attacker={level:{slider:60,manual:'43'},iv:{},nature:{}};h.page.levelUI.updateFinalStats('attacker');}
    if(action==='leave') h.page.onLeave();
    if(action==='detached') {h.cards.attacker.card.remove();h.CommonUI.destroyWithin(h.cards.attacker.card);}
    assert.equal(h.layer(),null);assert.equal(layer.isConnected,false);const before=a.effectiveLevel('attacker');
    choice.click();assert.equal(a.effectiveLevel('attacker'),before);assert.equal(h.writes.length,0);
    if(action==='leave'||action==='detached') {
      slider.value=0;slider.emit('input');plus.click();owner.click();assert.equal(a.effectiveLevel('attacker'),before);assert.equal(h.layer(),null);
      assert.equal(slider.count(),0);assert.equal(owner.count(),0);
      h.mount('attacker');h.node('attacker','level-mode').click();assert.ok(h.layer(),'returning mounts working fresh controls');
      h.layer().children[2].click();assert.equal(a.effectiveLevel('attacker'),99);
      slider.emit('input');assert.equal(a.effectiveLevel('attacker'),99,'old DOM cannot mutate new controls');
    }
  }
});

test('zoom-aware shared anchoring clamps the floating options to synthetic viewport edges',()=>{
  const h=damageUI(),owner=h.node('attacker','level-mode');
  for(const zoom of [1,1.5,2])for(const [left,top] of [[20,10],[970,660]]) {
    h.window.zoom=zoom;owner.rect={left,top,right:left+80,bottom:top+30,width:80,height:30};owner.click();
    const layer=h.layer(),box=layer.getBoundingClientRect();
    const x=parseFloat(layer.style.left)*zoom,y=parseFloat(layer.style.top)*zoom;
    assert.equal(layer.style.position,'fixed');assert.ok(x>=7.99&&y>=7.99);
    assert.ok(x+box.width<=h.window.innerWidth-7.99);assert.ok(y+box.height<=h.window.innerHeight-7.99);
    h.key(h.document.activeElement,'Escape');
  }
});

test('all real catalog wolf forms use exact adjacent grids, side/species session isolation and real stats',async()=>{
  const RKData=await realData(),h=damageUI({RKData}),a=h.page.CalcEngine,before=clone(h.memory);
  for(const id of [595,616,617])for(const side of ['attacker','defender']) {
    const pet=RKData.getMonsterById(id);h.state[side==='attacker'?'atkPet':'defPet']=pet;h.page.levelUI.updateFinalStats(side);
    for(const mode of ['ming','abu']) {
      h.node(side,'level-mode').click();h.layer(side).children.find(n=>n.dataset.mode===mode).click();
      const steps=clone(a.levelSteps(side));h.key(h.node(side,'level-slider'),'Home');
      assert.equal(a.effectiveLevel(side),steps[0]);assert.equal(h.node(side,'level-decrease').disabled,true);
      for(const level of steps.slice(1)) {h.node(side,'level-increase').click();assert.equal(a.effectiveLevel(side),level);}
      assert.equal(h.node(side,'level-increase').disabled,true);
      for(const level of steps.slice(0,-1).reverse()) {h.node(side,'level-decrease').click();assert.equal(a.effectiveLevel(side),level);}
      const selected=steps[2];h.node(side,'level-slider').value=2;h.node(side,'level-slider').emit('input');
      assert.equal(a.effectiveLevel(side),selected);
      for(const item of h.cards[side].items)assert.equal(item.nodes['.stat-value'].textContent,RKData.getPetStat(pet,item.dataset.stat,0,false,selected));
    }
  }
  h.state.atkPet=RKData.getMonsterById(595);a.setWolfMode('attacker','ming');await a.setLevelPreference('attacker',{slider:39});
  h.state.atkPet=RKData.getMonsterById(616);assert.equal(a.effectiveLevel('attacker'),64,'different species keeps its Abu level');
  h.state.atkPet=RKData.getMonsterById(595);assert.equal(a.effectiveLevel('attacker'),39);
  h.state.defPet=h.state.atkPet;assert.equal(a.effectiveLevel('defender'),64,'same species defender is independent');
  h.page.onLeave();h.mount('attacker');assert.equal(a.effectiveLevel('attacker'),39,'route cleanup keeps session records');
  const fresh=damageUI({RKData});assert.equal(fresh.page.CalcEngine.effectiveLevel('attacker'),60,'new session resets modes');
  assert.deepEqual(h.memory,before);assert.equal(h.writes.length,0);
});

test('battle snapshot manual value is retained until controls act, including singleton generic grid boundaries',()=>{
  const h=damageUI(),a=h.page.CalcEngine;
  h.page.battleSides.attacker={level:{slider:60,manual:'43'},iv:{},nature:{}};h.page.levelUI.updateFinalStats('attacker');
  assert.equal(h.node('attacker','level-value').textContent,'lv：43');h.node('attacker','level-decrease').click();
  assert.equal(a.effectiveLevel('attacker'),42);assert.equal(h.page.battleSides.attacker.level.manual,'');assert.equal(h.writes.length,0);
  h.page.battleSides.attacker=null;h.state.atkPet={id:333,level_configurable:true,level_min:60,level_max:60,default_level:60,level_step:7};h.page.levelUI.updateFinalStats('attacker');
  assert.deepEqual(clone(a.levelSteps('attacker')),[60]);assert.equal(h.node('attacker','level-decrease').disabled,true);assert.equal(h.node('attacker','level-increase').disabled,true);
  h.node('attacker','level-decrease').click();h.node('attacker','level-increase').click();assert.equal(h.writes.length,0);
});
