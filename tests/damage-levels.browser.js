// Run ONLY with parent's isolated native fixture; never a user's app or browser.
async page => {
  const fixture = await page.evaluate(() => window.__damageFixture);
  if (!fixture?.reset_url || fixture.origins?.length !== 2) throw Error('isolated __damageFixture required');
  for (const origin of fixture.origins) {
    const response = await page.request.get(origin + '/__fixture/info');
    if (!response.ok() || !(await response.json()).isolated) throw Error('refusing real profile');
  }
  const checks=[], errors=[];
  const check=(condition,message)=>{if(!condition)throw Error(message);checks.push(message);};
  const onError=error=>errors.push(error.message);page.on('pageerror',onError);
  const ready=async()=>{await page.waitForSelector('#basePower');await page.waitForFunction(()=>UserConfig.getStatus().ready);await page.evaluate(()=>UserConfig.flush());};
  const choose=async(side,id)=>{
    const name=await page.evaluate(id=>RKData.getMonsterDisplayName(RKData.getMonsterById(id)),id);
    await page.locator(`#${side}-search-slot input`).fill('');await page.locator(`#${side}-search-slot input`).fill(name);
    await page.waitForFunction(({side,id})=>DamagePage.getState()[side==='attacker'?'atkPet':'defPet']?.id===id,{side,id});
    await page.locator(`#${side}-search-slot input`).press('Escape');await page.evaluate(()=>UserConfig.flush());
  };
  const actual=side=>page.evaluate(side=>DamagePage.CalcEngine.effectiveLevel(side),side);
  const setSlider=async(side,index)=>{await page.locator(`#${side}-level-slider`).evaluate((el,index)=>{el.value=index;el.dispatchEvent(new Event('input',{bubbles:true}));},index);await page.evaluate(()=>UserConfig.flush());};
  const step=async(side,name)=>{await page.locator(`#${side}-level-${name}`).click();await page.evaluate(()=>UserConfig.flush());};
  const mode=async(side,value)=>{await page.locator(`#${side}-level-mode`).click();await page.locator(`#${side}-level-options [data-mode="${value}"]`).click();};
  const seedLegacy=async()=>{
    await page.evaluate(()=>UserConfig.patch('rk_damage_levels',{619:{extension:'keep',attacker:{slider:99,manual:'43',sideExtension:'keep'},defender:{slider:19,manual:''}}}));
    await page.evaluate(()=>UserConfig.flush());await page.reload();await ready();await choose('defender',619);
  };
  const snapshot=()=>page.evaluate(()=>JSON.stringify({personal:UserConfig.getObject('rk_pet_configs'),skills:UserConfig.getObject('rk_damage_skill_configs'),skill:UserConfig.getObject('rk_damage_view'),team:localStorage.getItem('rk_team_config')}));
  let blockWrites=false;
  const blocker=async route=>{
    if(blockWrites&&route.request().method()==='POST')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'isolated level write failure'})});
    return route.continue();
  };
  try {
    await page.goto(fixture.origins[0]+'/#/damage');await ready();
    await page.evaluate(()=>localStorage.clear());const reset=await page.request.post(fixture.reset_url,{data:{}});check(reset.ok(),'reset only isolated profile');
    await page.reload();await ready();await choose('attacker',619);await choose('defender',619);
    check(await actual('attacker')===99&&await actual('defender')===99,'both special sides default independently to99');
    for(const side of ['attacker','defender']) {
      check(await page.locator(`#${side}-level-controls`).isVisible(),side+' has level controls');
      check(!await page.locator(`.${side}-card .stat-mode-group`).isVisible(),side+' hides only old display radios');
      check(await page.locator(`.${side}-card .iv-btn[data-stat="hp"]`).isVisible(),side+' retains personal IV controls');
      check(await page.locator(`.${side}-card .nature-btn[data-stat="hp"]`).isVisible(),side+' retains personal nature controls');
      check(await page.locator(`#${side}-level-value`).evaluate(el=>el.tagName==='OUTPUT'&&el.tabIndex===-1),side+' has non-clickable grade text');
      const steps=[1,9,19,29,39,49,59,69,79,89,99];
      for(let index=0;index<steps.length;index++){await setSlider(side,index);check(await actual(side)===steps[index],side+' slider exact shortcut '+steps[index]);}
      check(await page.locator(`#${side}-level-increase`).isDisabled(),side+' upper boundary disabled');
      await page.locator(`#${side}-level-value`).click();check(!await page.locator('.damage-level-editor').count(),side+' clicking grade never opens retired modal');
    }
    await page.locator('#basePower').fill('0');await page.locator('#finalPowerManual').fill('321');await page.evaluate(()=>UserConfig.flush());
    await seedLegacy();let before=await snapshot();
    check(await actual('attacker')===43,'old saved manual43 survives cold load');
    check(await page.locator('#attacker-level-value').textContent()==='lv：43','plain text shows remembered43');
    check(await page.locator('#attacker-level-slider').inputValue()==='4','thumb uses near43 point, not stale99');
    check((await page.locator('#attacker-level-slider').getAttribute('aria-valuetext')).startsWith('43级'),'AT announces real effective43');
    await step('attacker','decrease');check(await actual('attacker')===39,'decrement from remembered43 selects39');
    check(await page.evaluate(()=>UserConfig.getObject('rk_damage_levels')[619].attacker.manual===''),'active control removes hidden manual override');
    await seedLegacy();await step('attacker','increase');check(await actual('attacker')===49,'increment from remembered43 selects49');
    await seedLegacy();await page.locator('#attacker-level-slider').press('ArrowRight');await page.evaluate(()=>UserConfig.flush());
    check(await actual('attacker')===49,'keyboard arrow also originates at effective43');
    await seedLegacy();await setSlider('attacker',1);check(await actual('attacker')===9,'drag selects9 over old manual43 immediately');
    check(await actual('defender')===19,'other side stays19');
    check(before===await snapshot(),'level controls write no personal mode, skill or team records');
    check(await page.locator('#basePower').inputValue()==='0'&&await page.locator('#finalPowerManual').inputValue()==='321','zero power and final321 unchanged');
    check(await page.evaluate(()=>{const record=UserConfig.getObject('rk_damage_levels')[619];return record.extension==='keep'&&record.attacker.sideExtension==='keep';}),'unknown fields survive level updates');
    for(const index of [0,1,4,10]) {
      await setSlider('attacker',index);const result=await page.evaluate(()=>DamagePage.CalcEngine.calculate());
      check(result.factorText===((10+.45*result.attackLevel)/41).toFixed(2),'full-precision level factor display '+result.attackLevel);
      check(await page.evaluate(()=>{const r=DamagePage.CalcEngine.calculate();return r.singleHit===BattleMath.normalDamage(r.atkStat,r.skillFinalPower,r.defStat,r.debuffMod,1,r.attackLevel);}), 'single floor formula uses selected level');
    }
    check(await page.evaluate(()=>['attacker','defender'].every(side=>{
      const s=DamagePage.getState(),p=side==='attacker'?'atk':'def',pet=s[p+'Pet'];
      return [...document.querySelectorAll(`.${side}-card .final-stat-item`)].every(el=>+el.querySelector('.stat-value').textContent===RKData.getPetStat(pet,el.dataset.stat,s[p+'Nature'][el.dataset.stat]||0,!!s[p+'IV'][el.dataset.stat],DamagePage.CalcEngine.effectiveLevel(side)));
    })),'all six displayed stats use each side level');
    await setSlider('attacker',4);await page.evaluate(()=>location.hash='/speed');await page.waitForSelector('#tier-fixed');
    await page.evaluate(()=>location.hash='/damage');await ready();check(await actual('attacker')===39&&await actual('defender')===19,'page switch preserves levels');
    await page.reload();await ready();check(await actual('attacker')===39&&await actual('defender')===60,'cold load restores attacker and leaves dummy at60');
    await choose('defender',619);check(await actual('defender')===19,'special defender restores its role record');
    await choose('attacker',202);check(await actual('attacker')===60,'ordinary attacker never inherits special level');
    check(!await page.locator('#attacker-level-controls').isVisible()&&await page.locator('.attacker-card .stat-mode-group').isVisible(),'ordinary species restores radio UI');
    await choose('attacker',619);await page.locator('#swapIcon').click();await page.evaluate(()=>UserConfig.flush());
    check(await actual('attacker')===39&&await actual('defender')===19,'same-species swap retains role-specific levels');
    await page.goto(fixture.origins[1]+'/#/damage');await ready();check(await actual('attacker')===39,'second port restores shared level');await choose('defender',619);
    await page.route('**/api/user-config',blocker);blockWrites=true;
    const committedBefore=await (await page.request.get(fixture.origins[1]+'/api/user-config')).json();
    await page.locator('#attacker-level-increase').click();await page.waitForFunction(()=>!!UserConfig.getStatus().error);
    check(await actual('attacker')===49,'failed save keeps visible draft49');
    const committedAfter=await (await page.request.get(fixture.origins[1]+'/api/user-config')).json();
    check(JSON.stringify(committedBefore.data.rk_damage_levels)===JSON.stringify(committedAfter.data.rk_damage_levels),'failure preserves durable record');
    check(await page.locator('.user-config-status').isVisible(),'save failure visible');
    blockWrites=false;await page.evaluate(()=>UserConfig.retry());await page.evaluate(()=>UserConfig.flush());await page.unroute('**/api/user-config',blocker);
    await page.reload();await ready();check(await actual('attacker')===49,'retry then reload restores49');
    for(const id of [595,616,617])for(const side of ['attacker','defender']) {
      await choose(side,id);before=await snapshot();
      check(await page.locator(`#${side}-level-mode`).evaluate(el=>el.tagName==='BUTTON'),'wolf'+id+' custom mode trigger');
      check(!await page.locator(`select.damage-level-mode`).count(),'no styled native select');
      for(const value of ['final','base']){await mode(side,value);check(await actual(side)===60,value+' mode is60');}
      await mode(side,'ming');check(await actual(side)===99,'Ming mode resets99');await step(side,'decrease');check(await actual(side)===89,'Ming decrement is89');
      await mode(side,'ming');check(await actual(side)===99,'choosing same Ming resets99 again');
      await mode(side,'abu');check(await actual(side)===60,'Abu defaults60');check(await page.locator(`#${side}-level-decrease`).isDisabled(),'Abu lower boundary disabled');
      await step(side,'increase');check(await actual(side)===62,'Abu increment62');await setSlider(side,19);await step(side,'increase');check(await actual(side)===99,'Abu98 to99 endpoint');
      check(before===await snapshot(),'wolf controls write no personal/skill/team records');
    }
    await choose('attacker',595);await mode('attacker','final');
    const owner=page.locator('#attacker-level-mode');await owner.focus();await owner.press('Enter');
    await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowRight');await page.keyboard.press(' ');
    check(await actual('attacker')===99,'menu Enter, Home, arrows and Space select Ming');
    await owner.press(' ');await page.keyboard.press('End');await page.keyboard.press('Enter');check(await actual('attacker')===60,'Space, End, Enter select Abu');
    for(const zoom of [1,1.5,2]) {
      await page.evaluate(zoom=>{document.documentElement.style.zoom=zoom;document.documentElement.style.setProperty('--page-zoom',zoom);},zoom);
      await owner.focus();await owner.press('ArrowDown');check(await page.locator('#attacker-level-options').isVisible(),'keyboard opens CSS options at zoom'+zoom);
      const box=await page.locator('#attacker-level-options').boundingBox(),size=page.viewportSize();
      check(box&&box.x>=-1&&box.y>=-1&&box.x+box.width<=size.width+1&&box.y+box.height<=size.height+1,'options remain in viewport zoom'+zoom);
      await page.keyboard.press('Escape');check(!await page.locator('#attacker-level-options').count(),'Escape closes menu');
    }
    await page.evaluate(()=>{document.documentElement.style.zoom='1';document.documentElement.style.setProperty('--page-zoom','1');});
    await owner.click();await page.locator('#basePower').click();check(!await page.locator('#attacker-level-options').count(),'outside click closes');
    await owner.click();await page.evaluate(()=>{window.__staleLevelChoice=document.querySelector('#attacker-level-options [data-mode="ming"]');});
    await choose('attacker',616);check(!await page.locator('#attacker-level-options').count(),'species switch closes');
    const saved=await actual('attacker');await page.evaluate(()=>{window.__staleLevelChoice.click();delete window.__staleLevelChoice;});check(await actual('attacker')===saved,'removed species option inert');
    await page.locator('#attacker-level-mode').click();await page.evaluate(()=>{window.__staleLevelOwner=document.querySelector('#attacker-level-mode');location.hash='/speed';});await page.waitForSelector('#tier-fixed');
    check(!await page.locator('.damage-level-options').count(),'leaving page removes options');
    await page.evaluate(()=>{window.__staleLevelOwner.click();delete window.__staleLevelOwner;});check(!await page.locator('.damage-level-options').count(),'stale owner cannot reopen');
    await page.evaluate(()=>location.hash='/damage');await ready();await choose('attacker',619);
    await page.locator('#attacker-level-slider').press('Home');await page.evaluate(()=>UserConfig.flush());check(await actual('attacker')===1,'slider Home selects1');
    await page.locator('#attacker-level-slider').press('ArrowRight');await page.evaluate(()=>UserConfig.flush());check(await actual('attacker')===9,'slider first keyboard step9');
    const generic=await page.evaluate(async()=>{
      const state=DamagePage.getState(),original=state.atkPet;
      state.atkPet={...original,id:900077,level_configurable:true,default_level:60,level_min:50,level_max:80,level_step:7};
      await DamagePage.CalcEngine.setLevelPreference('attacker',{slider:60});
      const values=[];for(const id of ['decrease','decrease','increase','increase','increase','increase','increase']){document.getElementById('attacker-level-'+id).click();values.push(DamagePage.CalcEngine.effectiveLevel('attacker'));}
      const plain=document.getElementById('attacker-level-value').tagName==='OUTPUT',disabled=document.getElementById('attacker-level-increase').disabled;
      await UserConfig.flush();state.atkPet=original;await DamagePage.CalcEngine.setLevelPreference('attacker',{slider:9});
      return{values,plain,disabled};
    });
    check(JSON.stringify(generic.values)==='[53,50,53,60,67,74,80]'&&generic.plain&&generic.disabled,'generic DOM controls use exact default-anchored grid and short endpoints');
    await choose('attacker',595);await mode('attacker','ming');await step('attacker','decrease');
    const beforeBattle=await page.evaluate(()=>JSON.stringify(UserConfig.getObject('rk_damage_levels')));
    await page.locator('#attacker-level-mode').click();
    const battle=await page.evaluate(()=>{
      const owner=document.querySelector('#attacker-level-options [data-mode="abu"]');
      const pet={instanceId:'isolated-wolf',monsterId:595,level:43,iv:{},nature:{}};
      BattleRecordsClient.useRecord({version:1,id:'isolated-level-overlay',mode:'pvp',outcome:'win',source:'isolated-test',quality:{roster:{me:true,enemy:false},actions:false,lead:{me:false,enemy:false}},sides:{me:{pets:[pet],before:{},after:{}},enemy:{pets:[],before:{},after:{}}},events:[],issues:[]});
      const ok=DamagePage.CalcEngine.applyBattlePet('attacker','me','isolated-wolf');
      owner.click();return{ok,level:DamagePage.CalcEngine.effectiveLevel('attacker'),closed:!document.querySelector('.damage-level-options')};
    });
    check(battle.ok&&battle.closed&&battle.level===43,'battle overlay closes custom menu and stale option cannot replace snapshot43');
    check(!await page.locator('#attacker-level-mode').isVisible()&&await page.locator('#attacker-level-value').textContent()==='lv：43','battle uses the same non-clickable grade display');
    await step('attacker','decrease');check(await actual('attacker')===42,'battle decrement uses real snapshot43');
    await setSlider('attacker',98);check(await actual('attacker')===99,'battle slider owns level over initial manual field');
    check(beforeBattle===await page.evaluate(()=>JSON.stringify(UserConfig.getObject('rk_damage_levels'))),'battle level edits never persist personal level records');
    await page.locator('.battle-snapshot-exit').click();check(await actual('attacker')===89,'exit restores session wolf level');
    check(errors.length===0,'no browser runtime errors');return {passed:checks.length,checks};
  } finally {blockWrites=false;await page.unroute('**/api/user-config',blocker);page.off('pageerror',onError);}
}
