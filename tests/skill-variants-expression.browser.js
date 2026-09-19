// Run only via parent's isolated Go fixture; no real profile or native launch.
async page => {
  const fixture=await page.evaluate(()=>window.__damageFixture);
  if(!fixture?.origins?.length)throw Error('Explicit isolated fixture required');
  for(const origin of fixture.origins){
    const hostname=await page.evaluate(origin=>new URL(origin).hostname,origin);
    if(!['127.0.0.1','localhost','[::1]'].includes(hostname))throw Error('Loopback fixture required');
    const response=await page.request.get(origin+'/__fixture/info');
    if(!response.ok()||!(await response.json()).isolated)throw Error('Refusing non-fixture profile writes');
  }
  const checks=[],errors=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const onError=e=>errors.push(e.message);page.on('pageerror',onError);
  const ready=async()=>{await page.waitForSelector('#basePower');await page.waitForFunction(()=>UserConfig.getStatus().ready);await page.evaluate(()=>UserConfig.flush());};
  const state=()=>page.evaluate(()=>JSON.parse(JSON.stringify(DamagePage.getState())));
  const saved=()=>page.evaluate(()=>UserConfig.getObject('rk_damage_view').skill);
  const route=async r=>{await page.evaluate(r=>location.hash='/'+r,r);await page.waitForSelector(r==='damage'?'#basePower':'#tier-fixed');};
  const installIcons=async()=>{
    // In-memory fixture learnset only. Master moves, source data and learning relationships never written.
    await page.evaluate(()=>{RKData.getResolvedWikiData=()=>({skills:RKData.getMoves().filter(RKData.isAttackMove).map(m=>({name:RKData.getMoveName(m),type:RKData.getMoveCategoryZh(m),element:m.move_type.localized.zh,source:'普通'}))});});
    await route('speed');await route('damage');
  };
  const choose=async id=>{
    const name=await page.evaluate(id=>RKData.getMonsterDisplayName(RKData.getMonsterById(id)),id);
    await page.locator('#attacker-search-slot input').fill('');await page.locator('#attacker-search-slot input').fill(name);
    await page.waitForFunction(id=>DamagePage.getState().atkPet?.id===id,id);
    await page.locator('#attacker-search-slot input').press('Escape');await page.evaluate(()=>UserConfig.flush());
  };
  const icon=name=>page.locator('.skill-icon-group').filter({has:page.locator('.skill-icon-group-title',{hasText:'基础技能'})}).locator(`.skill-icon-item[data-skill-name="${name}"]`).first();
  const expression=async(expected,label)=>{
    const s=await state(),sum=expected.split('+').reduce((n,v)=>n+Number(v),0);
    check(await page.locator('#basePower').inputValue()===expected,label+' expression input');
    check(s.basePower===sum&&s.basePowerExpression===expected&&s.comboCount===1,label+' numeric sum, one combo');
    await page.evaluate(()=>UserConfig.flush());
    const memory=await page.evaluate(()=>UserConfig.getObject('rk_damage_skill_configs')[DamagePage.getState().atkPet.id]);
    const active=await saved();
    check(memory.basePowerExpression===expected&&memory.basePower===sum,label+' per-pet file memory');
    check(active.basePowerExpression===expected&&active.basePower===sum,label+' active snapshot');
  };
  try{
    await page.goto(fixture.origins[0]+'/#/damage');await ready();await choose(569);await installIcons();
    for(const[pet,name,left,right]of [
      [569,'友谊满溢','70+90','110+130'],[569,'驱赶','90+90','210+210'],[569,'撒花','95+95','145+145'],
      [568,'友谊满溢','70+90','90+110'],[568,'驱赶','90+70','90+210'],[568,'撒花','95+95','95+145']
    ]){
      await choose(pet);
      for(const [key,value]of Object.entries({fixedBonus:'7',percentBonus:'9',buff:'15',starMeteor:'4',finalPowerManual:'0'}))await page.locator('#'+key).fill(value);
      const configs=await page.evaluate(()=>JSON.stringify(UserConfig.getObject('rk_pet_configs')));
      for(const[button,expected]of [['left',left],['right',right],['right',right],['left',left]]){
        await icon(name).click({button});await expression(expected,pet+' '+name+' '+button);
        const s=await state();check(s.fixedBonus===7&&s.percentBonus===9&&s.buff===15&&s.starMeteor===4&&s.finalPowerManual==='0','independent fields retained');
      }
      check(await page.evaluate(()=>JSON.stringify(UserConfig.getObject('rk_pet_configs')))===configs,'presets do not edit mode0/1');
    }
    // Snapshot recovery must read from the actual isolated backend, not a test-injected VM state.
    await choose(569);await icon('驱赶').click({button:'right'});await expression('210+210','black before reload');
    await page.reload();await ready();await expression('210+210','fresh page reload');
    if(fixture.origins.length>1){
      await page.goto(fixture.origins[1]+'/#/damage');await ready();await expression('210+210','second origin');
    }
    await page.evaluate(()=>localStorage.clear());await page.reload();await ready();await expression('210+210','cache-clear real reload');
    await installIcons();
    await choose(568);await icon('友谊满溢').click({button:'right'});await expression('90+110','white own memory');
    await choose(569);await expression('210+210','black recovered without white leak');
    await choose(568);await expression('90+110','white recovered without black leak');
    await page.locator('#basePower').fill('77');await page.evaluate(()=>UserConfig.flush());
    check((await state()).basePowerExpression===''&&(await saved()).basePowerExpression==='','manual numeric edit clears expression');
    await page.reload();await ready();check(await page.locator('#basePower').inputValue()==='77','manual number reload does not revive expression');
    await installIcons();await choose(569);await icon('驱赶').click();await icon('爆冲').click();
    check((await state()).basePower===65&&(await state()).basePowerExpression==='','normal skill clears expression');
    await icon('驱赶').click();await icon('闪击').click();check((await state()).basePowerExpression==='','dynamic power clears expression');
    for(const[name,n,combo]of [['试飞',20,2],['感电',60,1],['铁蒺藜',85,1]]){
      await icon(name).click({button:'right'});const s=await state();
      check(s.basePower===n&&s.comboCount===combo&&s.basePowerExpression==='',name+' base-only remains base on Garl');
    }
    for(const[name,n]of [['吹散',65],['冰裂',70],['蹦跶',110]]){await icon(name).click({button:'right'});await expression(n+'+'+n,name+' equal-power choice');}
    await choose(202);await icon('驱赶').click();check((await state()).basePower===90&&(await state()).basePowerExpression==='','non-Garl original preset');
    // The expression is display-only. One summed calculation must match both normal and meteor components.
    await choose(569);await icon('驱赶').click();await page.locator('#finalPowerManual').fill('');await page.locator('#starMeteor').fill('4');
    const before=await page.evaluate(()=>{const r=DamagePage.CalcEngine.calculate();return r&&{total:r.totalDamage,normal:r.normalDamage,meteor:r.starMeteorDamage,power:r.skillFinalPower};});
    await page.locator('#basePower').fill('180');
    const after=await page.evaluate(()=>{const r=DamagePage.CalcEngine.calculate();return r&&{total:r.totalDamage,normal:r.normalDamage,meteor:r.starMeteorDamage,power:r.skillFinalPower};});
    check(before!==null&&JSON.stringify(before)===JSON.stringify(after),'summed expression is one release including meteor');
    check(errors.length===0,'no page errors: '+errors.join('; '));
    return {passed:checks.length,checks};
  }finally{page.off('pageerror',onError);}
}
