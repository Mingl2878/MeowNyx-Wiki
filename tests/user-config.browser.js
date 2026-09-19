// Requires TestUserConfigBrowserFixture, never the real application/profile.
// Parent sets window.__profileOtherOrigin to the second origin from fixture ready.json.
async page => {
  const checks=[];const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const origin=await page.evaluate(()=>location.origin),other=await page.evaluate(()=>window.__profileOtherOrigin);
  for(const url of [origin,other]){
    if(!url||url===undefined)throw Error('Two explicit fixture origins required');
    const response=await page.request.get(url+'/__fixture/info');
    if(!response.ok()||(await response.json()).isolated!==true)throw Error('Refusing writes outside isolated profile fixture');
  }
  const data=async url=>(await(await page.request.get((url||origin)+'/api/user-config')).json()).data;
  const ready=async()=>{await page.waitForSelector('#basePower');await page.waitForFunction(()=>UserConfig.getStatus().ready);check(await page.evaluate(()=>UserConfig.flush()),'shared profile ready with no pending write');};
  const go=async name=>{await page.evaluate(n=>location.hash='/'+n,name);await page.waitForSelector(name==='damage'?'#basePower':'#tier-fixed');};
  const failRoute=async route=>route.request().method()==='POST'?route.fulfill({status:500,contentType:'application/json',body:'{"ok":false,"error":"测试：模拟保存失败"}'}):route.continue();
  try {
    await page.evaluate(()=>{
      localStorage.setItem('rk_pet_configs',JSON.stringify({249:{nature:{hp:1},iv:{hp:true}},602:{nature:{},iv:{magic_defense:true}}}));
      localStorage.setItem('rk_speed_pet_priority',JSON.stringify({136:[249]}));
      localStorage.setItem('rk_speed_form_overrides',JSON.stringify({'测试形态|default|136':249}));
      localStorage.setItem('rk_speed_view',JSON.stringify({iv:false,nature:false,negNature:true,showMonsters:true,fixed:-20,percent:20,search:'',searchDisplay:'',selectedCol:'base',selectedSpeed:136}));
    });
    await page.reload();await ready();
    let saved=await data();
    check(saved.rk_pet_configs[249].nature.hp===1&&saved.rk_pet_configs[602].iv.magic_defense===true,'legacy monster records migrated to shared file');
    check(saved.rk_speed_pet_priority[136][0]===249&&saved.rk_speed_form_overrides['测试形态|default|136']===249,'speed priorities and forms migrated');
    await page.locator('#attacker-search-slot input').fill('圣剑-X');await page.locator('#defender-search-slot input').fill('权杖-V');
    await page.waitForFunction(()=>DamagePage.getState().defPet.id===249);await page.evaluate(()=>UserConfig.flush());
    check(await page.evaluate(()=>DamagePage.getState().defNature.hp===1&&DamagePage.getState().defIV.hp===true),'same pet restores its saved nature and IV');
    await page.locator('.defender-card .iv-btn[data-stat="hp"]').click();await page.evaluate(()=>UserConfig.flush());
    saved=await data();
    check(saved.rk_pet_configs[249].iv.hp===false&&saved.rk_pet_configs[602].iv.magic_defense===true,'personal edit persists one ID without erasing other monsters');
    check(saved.rk_damage_selection.attacker===434&&saved.rk_damage_selection.defender===249,'last attacker and defender persisted');
    await go('speed');
    check(await page.locator('#tier-fixed').inputValue()==='0'&&await page.locator('#tier-percent').inputValue()==='0','speed page ignores retired persistent view');
    await page.locator('#tier-fixed').fill('50');await page.locator('#tier-percent').fill('0');
    await page.locator('#tier-search').fill('绒仙子');await page.waitForFunction(()=>UserConfig.getObject('rk_speed_pet_priority',{})[102]?.includes(459)||document.getElementById('tier-search').value==='绒仙子');
    await page.locator('#tier-search').fill('');
    await page.locator('.tier-btn[data-col="base"]').first().click();await page.evaluate(()=>UserConfig.flush());
    saved=await data();
    check(!saved.rk_speed_view,'temporary speed controls do not create a shared view section');
    await go('damage');await go('speed');
    check(await page.locator('#tier-fixed').inputValue()==='50','same-process navigation retains memory-only speed view');
    await page.goto(other+'/#/damage');await ready();
    check(await page.evaluate(()=>DamagePage.getState().atkPet.id===434&&DamagePage.getState().defPet.id===9001),'another origin restores attacker but starts defender at training dummy');
    await page.locator('#defender-search-slot input').fill('权杖-V');
    check(await page.evaluate(()=>DamagePage.getState().defPet.id===249&&!DamagePage.getState().defIV.hp&&DamagePage.getState().defNature.hp===1),'explicit defender selection reads retained personal configuration');
    await go('speed');
    check(await page.locator('#tier-fixed').inputValue()==='0'&&await page.locator('#tier-percent').inputValue()==='0','fresh origin resets temporary speed view');
    const before=await data(other);
    await page.route('**/api/user-config',failRoute);await page.evaluate(()=>UserConfig.patch('rk_speed_pet_priority',{'136':[434,249]}));
    await page.waitForFunction(()=>UserConfig.getStatus().error.length>0);
    check(await page.locator('.user-config-status').isVisible()&&JSON.stringify((await data(other)).rk_speed_pet_priority)===JSON.stringify(before.rk_speed_pet_priority),'save failure is visible and leaves committed priority file unchanged');
    check(!await page.evaluate(()=>UserConfig.flush()),'failed pending save prevents successful close flush');
    await page.unroute('**/api/user-config',failRoute);await page.locator('.user-config-status button').click();
    await page.waitForFunction(()=>!UserConfig.getStatus().error&&UserConfig.getStatus().pending===0);
    check((await data(other)).rk_speed_pet_priority[136][0]===434,'retry commits retained priority draft');
    await page.evaluate(()=>localStorage.clear());await page.goto(other+'/#/damage');await page.reload();await ready();
    check(await page.evaluate(()=>DamagePage.getState().defPet.id===9001),'cold reload keeps the training dummy');
    await page.locator('#defender-search-slot input').fill('权杖-V');
    check(await page.evaluate(()=>DamagePage.getState().defPet.id===249&&!DamagePage.getState().defIV.hp),'clearing browser cache does not clear the shared personal file');
    await go('speed');check(await page.locator('#tier-fixed').inputValue()==='0','fresh startup uses speed defaults regardless of browser cache');
    await page.evaluate(()=>{window.__profileClosed=null;window.__xhmCloseReady=ok=>{window.__profileClosed=ok;};});
    await page.evaluate(()=>{void UserConfig.patch('rk_speed_pet_priority',{'136':[249,434]});});
    check(await page.evaluate(()=>UserConfig.requestClose()),'close handshake waits for queued writes');
    check(await page.evaluate(()=>window.__profileClosed===true)&&(await data(other)).rk_speed_pet_priority[136][0]===249,'close callback succeeds only after committed priority is readable');
    return {passed:checks.length,checks};
  }finally{await page.unroute('**/api/user-config',failRoute);}
}
