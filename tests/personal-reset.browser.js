async page=>{
 const checks=[],check=(v,s)=>{if(!v)throw Error(s);checks.push(s);},origin=await page.evaluate(()=>location.origin);
 const info=await(await page.request.get(origin+'/__fixture/info')).json();if(info.isolated!==true)throw Error('Refuse real profile');
 const data=async()=>(await(await page.request.get(origin+'/api/user-config')).json()).data;
 const go=async route=>{await page.evaluate(r=>location.hash='/'+r,route);await page.waitForSelector(route==='settings'?'#set-reset-pet-defaults':'#basePower');};
 await page.evaluate(()=>UserConfig.patch('rk_pet_configs',{'434':{mode:1,iv:{hp:false,attack:false},nature:{hp:2},future:'untouched'},'249':{mode:1,iv:{hp:false},nature:{hp:2}},'602':{mode:0,iv:{hp:false},nature:{}}}));
 await page.locator('#attacker-search-slot input').fill('圣剑-X');await page.locator('#attacker-search-slot input').press('Escape');await page.locator('#defender-search-slot input').fill('权杖-V');await page.locator('#defender-search-slot input').press('Escape');await page.evaluate(()=>UserConfig.flush());
 check(await page.evaluate(()=>!DamagePage.getState().atkIV.hp&&!DamagePage.getState().defIV.hp),'artificial personal configuration selected');
 const before=await data();await go('settings');check(JSON.stringify(await data())===JSON.stringify(before),'opening settings does not reset any record');
 await page.evaluate(()=>{window.__resetOriginalConfirm=window.confirm;window.confirm=()=>false;});await page.locator('#set-reset-pet-defaults').click();check(JSON.stringify(await data())===JSON.stringify(before),'cancel leaves all settings untouched');
 const fail=async route=>{let body;try{body=route.request().postDataJSON()}catch(_){}if(body?.reset_pet_defaults)return route.fulfill({status:500,contentType:'application/json',body:'{"ok":false,"error":"isolated reset failure"}'});return route.continue();};
 try{
  await page.route('**/api/user-config',fail);await page.evaluate(()=>{window.confirm=()=>true;});await page.locator('#set-reset-pet-defaults').click();await page.waitForFunction(()=>UserConfig.getStatus().error.length>0);
  check(JSON.stringify(await data())===JSON.stringify(before),'failed reset preserves saved bytes semantically');
  check(!await page.evaluate(()=>UserConfig.flush()),'pending failed reset blocks successful flush');
  check(!(await page.locator('#pet-defaults-result').innerText()).includes('已恢复自动默认'),'failure does not report success');
 }finally{await page.unroute('**/api/user-config',fail);}
 await page.locator('.user-config-status button').click();await page.waitForFunction(()=>!UserConfig.getStatus().error&&UserConfig.getStatus().pending===0);
 const after=await data();check(Object.values(after.rk_pet_configs).every(r=>r.mode===0),'retry restores every personal record to automatic mode');
 check((await page.locator('#pet-defaults-result').innerText()).includes('已恢复自动默认'),'successful retry also refreshes settings result');
 check(after.rk_pet_configs[434].future==='untouched','future fields retained');check(after.rk_pet_configs[434].iv.hp===false,'historical manual snapshot not erased; mode0 resolver owns defaults');
 for(const key of Object.keys(before).filter(k=>k!=='rk_pet_configs'))check(JSON.stringify(before[key])===JSON.stringify(after[key]),'unrelated group preserved: '+key);
 await go('damage');check(await page.evaluate(()=>DamagePage.getState().atkIV.hp&&DamagePage.getState().defIV.hp),'active personal sides adopt defaults on return without changing pets');
 check(await page.evaluate(()=>DamagePage.getState().atkPet.id===434&&DamagePage.getState().defPet.id===249),'reset is not pet selection or cold restart');
 await page.evaluate(()=>{window.confirm=window.__resetOriginalConfirm;delete window.__resetOriginalConfirm;});
 return {passed:checks.length,checks};
}
