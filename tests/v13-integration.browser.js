// Run only with an isolated browser and a read-only local HTTP server.
async page => {
  const checks=[], errors=[];
  const check=(ok,message)=>{if(!ok)throw Error(message);checks.push(message);};
  const onError=e=>errors.push(e.message);page.on('pageerror',onError);
  const go=async route=>{await page.evaluate(r=>{location.hash='/'+r;},route);await page.waitForTimeout(100);};
  const saved=await page.evaluate(()=>({storage:{...localStorage},zoom:AppPreferences.getMaxZoom()}));
  let fail=true;
  const save=route=>route.fulfill({status:fail?500:200,contentType:'application/json',body:JSON.stringify(fail?{ok:false,error:'simulated'}:{ok:true})});
  await page.route('**/api/settings',async route=>route.request().method()==='POST'?save(route):route.continue());
  try{
    await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>AppPreferences.setMaxZoom(1));
    await go('damage');await page.waitForSelector('#basePower');
    const input=page.locator('#attacker-search-slot input');await input.fill('绒');
    await page.waitForSelector('.autocomplete-item[data-monster-id="459"]');
    check(await page.locator('.autocomplete-dropdown:visible .autocomplete-item').count()===16,'绒 returns all 16 matches, including 绒仙子');
    await page.locator('.autocomplete-item[data-monster-id="459"]').click();
    check(await page.evaluate(()=>DamagePage.getState().atkPet.id===459),'the formerly truncated result can actually be selected');
    check(await page.evaluate(()=>RKData.getMoves().find(m=>RKData.getMoveName(m)==='重击').power===140 && RKData.getMoves().find(m=>RKData.getMoveName(m)==='放晴').energy_cost===1 && RKData.getMoves().find(m=>RKData.getMoveName(m)==='俯冲').power===105),'master data: 重击140 / 放晴1 / 俯冲105 preserved');
    check(await page.evaluate(()=>RKData.getTypeEff('普','地','钢')===.25),'double resistance is a quarter, not a third');
    const calculations=await page.evaluate(()=>{
      const s=DamagePage.getState(),old=JSON.parse(JSON.stringify(s));
      try{
        s.atkPet=RKData.getMonsterById(434);s.defPet=RKData.getMonsterById(602);
        Object.assign(s,{atkNature:{},atkIV:{},defNature:{},defIV:{},skillType:'attack',skillAttr:'火',basePower:100,fixedBonus:0,percentBonus:0,buff:0,comboCount:1,defenseMod:'0',debuffPercent:'0',finalPowerManual:'',starMeteor:2});
        const fire=DamagePage.CalcEngine.calculate();s.skillAttr='幻';const illusion=DamagePage.CalcEngine.calculate();
        const expected=Math.ceil(Math.ceil(Math.ceil(Math.ceil(28*fire.atkStat*(37/41))*1)*fire.starMeteorTypeEff)/fire.defStat);
        return fire.starMeteorTriggered&&fire.starMeteorDamage===expected&&fire.starMeteorTypeEff===RKData.getTypeEff('幻',s.defPet.main_type.name,s.defPet.sub_type.name)&&illusion.starMeteorDamage===0&&BattleMath.DAMAGE_FACTOR===37/41;
      }finally{Object.assign(s,old);}
    });check(calculations,'meteor uses 37/41, actual Illusion matchup and no Illusion-skill trigger');
    await go('settings');await page.waitForSelector('#set-effective-speed [data-speed-mode]');
    await page.evaluate(()=>AppPreferences.setEffectiveIncludeSpeed(true));
    check(await page.locator('#set-effective-speed button').count()===3,'three effective-speed buttons, no radio menu');
    await page.locator('[data-speed-mode="threshold"]').click();
    check(await page.locator('#set-effective-threshold').isVisible(),'threshold mode reveals adjacent slider');
    await page.locator('#set-effective-threshold').fill('95');
    await page.locator('[data-speed-mode="include"]').click();
    check(!await page.locator('#set-effective-threshold').isVisible(),'include mode hides threshold slider');
    await page.locator('[data-speed-mode="threshold"]').click();
    check(await page.locator('#set-effective-threshold').inputValue()==='95','hidden threshold is remembered');
    await page.locator('[data-speed-mode="exclude"]').click();
    check(await page.evaluate(()=>AppPreferences.getEffectiveIncludeSpeed()),'effective-speed draft does not change the live statistic');
    await page.locator('#set-save-btn').click();await page.waitForFunction(()=>document.getElementById('settings-result').textContent.includes('保存失败'));
    check(await page.evaluate(()=>AppPreferences.getEffectiveIncludeSpeed()),'failed save leaves the live statistic intact');
    fail=false;await page.locator('#set-save-btn').click();await page.waitForFunction(()=>!AppPreferences.getEffectiveIncludeSpeed());
    check(await page.evaluate(()=>localStorage.getItem('xwiki-effective-include-speed')==='false'),'successful save commits include-speed=false');
    await go('petdex');await page.waitForSelector('#pet-tbody tr');
    check(await page.evaluate(()=>[...document.querySelectorAll('#pet-tbody tr[data-id]')].every(r=>{const m=RKData.getMonsterById(Number(r.dataset.id));return !m||Number(r.querySelector('[data-stat="effective"]')?.textContent)===RKData.getTotalStats(m)-Math.min(m.base_phy_atk,m.base_mag_atk)-m.base_spd;})),'petdex table uses the committed effective-stat preference');
    await go('settings');await page.waitForSelector('[data-speed-mode="threshold"]');
    await page.locator('[data-speed-mode="threshold"]').click();
    await page.locator('#set-effective-threshold').fill('80');
    check(await page.evaluate(()=>AppPreferences.getEffectiveSpeedPolicy().mode==='exclude'),'threshold draft leaves committed exclude policy intact');
    await page.locator('#set-save-btn').click();await page.waitForFunction(()=>AppPreferences.getEffectiveSpeedPolicy().mode==='threshold');
    await go('petdex');await page.waitForSelector('#pet-tbody tr');
    check(await page.evaluate(()=>[...document.querySelectorAll('#pet-tbody tr[data-id]')].every(r=>{
      const m=RKData.getMonsterById(Number(r.dataset.id));
      const expected=m&&(m.base_hp+Math.max(m.base_phy_atk,m.base_mag_atk)+m.base_phy_def+m.base_mag_def+(m.base_spd>=80?m.base_spd:0));
      return !m||Number(r.querySelector('[data-stat="effective"]')?.textContent)===expected;
    })),'threshold table uses full base speed at or above the saved threshold');
    await go('game-description');await page.waitForSelector('.game-description-entry');
    check(await page.locator('.game-description-entry').count()===54,'new route displays all 54 game descriptions');
    check(await page.evaluate(()=>{const links=[...document.querySelectorAll('.nav-link')].map(e=>e.dataset.route);return links.indexOf('game-description')===links.indexOf('chart')+1 && links.indexOf('updatedata')===links.indexOf('game-description')+1;}),'game-description navigation is exactly between chart and updatedata');
    await go('moves');await page.waitForSelector('#move-list-container');
    const id=await page.evaluate(()=>RKData.getMoves().find(m=>/星陨印记/.test(RKData.getMoveDesc(m)))?.id);
    await page.evaluate(id=>MovesPage.showMoveDetail(RKData.getMoves().find(m=>m.id===id)),id);
    await page.waitForSelector('#move-modal-body .game-glossary-term');
    await page.locator('#move-modal-body .game-glossary-term').first().hover();await page.waitForSelector('.game-glossary-tooltip',{state:'visible'});
    check(await page.locator('.game-glossary-tooltip-body').textContent().then(t=>t.length>10),'real skill description has a working glossary underline and tooltip');
    await page.keyboard.press('Escape');await page.evaluate(()=>{document.getElementById('move-modal').style.display='none';});
    for(const zoom of [1,1.5,2]){
      await page.setViewportSize({width:1920,height:1080});await page.evaluate(z=>AppPreferences.setMaxZoom(z),zoom);
      await go('game-description');
      check(await page.evaluate(()=>{const r=document.getElementById('navbar').getBoundingClientRect();return [...document.querySelectorAll('.nav-link')].every(e=>{const n=e.getBoundingClientRect();return n.top>=r.top-.2&&n.bottom<=r.bottom+.2;});}),`all navigation stays within the header at ${zoom*100}%`);
      await go('chart');await page.waitForSelector('#defenseChart');await page.waitForTimeout(100);
      check(await page.evaluate(()=>{const canvas=document.getElementById('defenseChart'),c=Chart.getChart(canvas),p=canvas.parentElement;return c&&Math.abs(c.width-p.clientWidth)<=1&&Math.abs(c.height-p.clientHeight)<=1;}),`chart entered after external zoom is correctly sized at ${zoom*100}%`);
    }
    check(errors.length===0,'no runtime errors in integrated flow');
    return {passed:checks.length,checks};
  }finally{
    await page.unroute('**/api/settings');page.off('pageerror',onError);
    await page.evaluate(s=>{localStorage.clear();for(const [k,v]of Object.entries(s.storage))localStorage.setItem(k,v);AppPreferences.setMaxZoom(s.zoom);},saved);
    await page.reload();
  }
}
