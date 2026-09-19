async page=>{
 const checks=[],check=(v,s)=>{if(!v)throw Error(s);checks.push(s);},origin=await page.evaluate(()=>location.origin);
 const info=await(await page.request.get(origin+'/__fixture/info')).json();if(!info.isolated)throw Error('Refuse real profile');
 const data=async()=>(await(await page.request.get(origin+'/api/user-config')).json()).data;
 const go=async r=>{await page.evaluate(r=>location.hash='/'+r,r);await page.waitForSelector(r==='settings'?'#set-clear-pet-configs':r==='chart'?'#chartGroupManage':r==='game-description'?'.game-description-page':'#basePower');};
 const fail=async route=>{let body;try{body=route.request().postDataJSON()}catch(_){}if(body?.clear_pet_configs)return route.fulfill({status:500,json:{ok:false,error:'isolated clear failure'}});return route.continue();};
 await page.evaluate(()=>{window.__clearConfirm=window.confirm;});
 try{
  await page.request.post(origin+'/api/settings',{data:{default_route:'game-description'}});
  const settings=await(await page.request.get(origin+'/api/settings')).json();check(settings.default_route==='petdex','legacy glossary startup setting falls back to petdex');
  await page.evaluate(()=>UserConfig.patch('rk_pet_configs',{'569':{mode:0,future:'kept'},'249':{mode:1,iv:{hp:true},nature:{hp:1}}}));
  await page.locator('#attacker-search-slot input').fill('黑化加尔');await page.locator('#attacker-search-slot input').press('Escape');await page.locator('.skill-icon-item[data-skill-name="驱赶"]').first().click({button:'right'});await page.evaluate(()=>UserConfig.flush());
  check(await page.locator('#basePower').inputValue()==='210+210','skill preset and expression still apply');check(await page.locator('#skill-variant-notice').count()===0,'successful quick skill selection no longer adds explanation strip');
  await go('chart');await page.waitForFunction(()=>document.getElementById('chartAtkIVBtn')?.disabled===false);await page.evaluate(()=>ChartWorkspace.setControls({doubleLife:true}));await page.evaluate(()=>UserConfig.flush());
  await go('settings');const before=await data();
  check(await page.locator('#set-route-grid [data-route="game-description"]').count()===0,'settings startup options exclude glossary');
  check(await page.locator('.nav-link[data-route="game-description"]').count()===1,'glossary navigation stays available');
  check(!(await page.locator('#page-container').innerText()).includes('恢复自动默认规则，不清空技能记忆'),'requested explanatory paragraph removed');
  check(JSON.stringify(await data())===JSON.stringify(before),'opening settings does not clear anything');
  await page.evaluate(()=>window.confirm=()=>false);await page.locator('#set-clear-pet-configs').click();check(JSON.stringify(await data())===JSON.stringify(before),'clear cancellation preserves all data');
  await page.route('**/api/user-config',fail);await page.evaluate(()=>window.confirm=()=>true);await page.locator('#set-clear-pet-configs').click();await page.waitForFunction(()=>UserConfig.getStatus().error.length>0);
  check(JSON.stringify(await data())===JSON.stringify(before),'failed clear preserves durable data');check(!await page.evaluate(()=>UserConfig.flush()),'failed clear remains pending for retry');
  await page.unroute('**/api/user-config',fail);await page.locator('.user-config-status button').click();await page.waitForFunction(()=>!UserConfig.getStatus().error&&UserConfig.getStatus().pending===0);
  const after=await data(),ids=await page.evaluate(()=>RKData.getMonsters().map(p=>p.id));
  check(ids.length>600&&ids.every(id=>after.rk_pet_configs[id]?.mode===1),'clear includes unconfigured species and dummy');
  check(Object.values(after.rk_pet_configs).every(r=>['hp','attack','magic_attack','defense','magic_defense','speed'].every(k=>r.iv[k]===false&&r.nature[k]===0)),'six IVs and natures explicitly unselected');
  check(after.rk_pet_configs[569].future==='kept','unknown personal metadata retained');
  for(const key of Object.keys(before).filter(k=>k!=='rk_pet_configs'))check(JSON.stringify(before[key])===JSON.stringify(after[key]),'clear preserves '+key);
  check((await page.locator('#pet-defaults-result').innerText()).includes('全部设为不选择'),'retry reports clear not defaults');
  await go('damage');check(await page.evaluate(()=>Object.values(DamagePage.getState().atkIV).every(v=>v===false)&&Object.values(DamagePage.getState().atkNature).every(v=>v===0)),'active personal source reflects clear');
  await page.reload();await page.waitForSelector('#basePower');await page.waitForFunction(()=>UserConfig.getStatus().ready);check(await page.evaluate(()=>DamagePage.getState().atkPet?.id===569&&!DamagePage.getState().atkIV.hp&&!DamagePage.getState().defIV.hp),'restart does not repopulate automatic IVs including dummy');
  check(await page.locator('#basePower').inputValue()==='210+210','clear preserves skill expression after restart');
  await go('settings');await page.evaluate(()=>window.confirm=()=>true);await page.locator('#set-reset-pet-defaults').click();await page.waitForFunction(()=>UserConfig.getStatus().pending===0);await go('damage');check(await page.evaluate(()=>DamagePage.getState().atkIV.hp===true),'separate restore-defaults operation still restores auto policy');
  await page.locator('.nav-link[data-route="game-description"]').click();await page.waitForSelector('.game-description-table');check(await page.locator('.game-description-table tbody tr').count()===54,'glossary page itself remains intact');
  return {passed:checks.length,checks};
 }finally{await page.unroute('**/api/user-config',fail);await page.evaluate(()=>{if(window.__clearConfirm){window.confirm=window.__clearConfirm;delete window.__clearConfirm;}});}
}
