// Parent-run playwright-cli run-code; no browser launch. Refuses non-isolated APIs.
async page => {
  const fixture=await page.evaluate(()=>window.__damageFixture);
  if(!fixture?.reset_url||!fixture.origins?.length)throw Error('Explicit isolated fixture required');
  for(const origin of fixture.origins){const r=await page.request.get(origin+'/__fixture/info');if(!r.ok()||(await r.json()).isolated!==true)throw Error('Refusing real profile');}
  const checks=[],errors=[],check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),onError=e=>errors.push(e.message);
  page.on('pageerror',onError);
  const ready=async()=>{await page.waitForSelector('#chartAtkIVBtn');await page.waitForFunction(()=>ChartWorkspace.getStatus().initialized&&!document.getElementById('chartAtkIVBtn')?.disabled);await page.evaluate(()=>UserConfig.flush());};
  const state=()=>page.evaluate(()=>ChartWorkspace.getState());
  const file=async()=>{const r=await page.request.get(fixture.origins[0]+'/api/user-config');return(await r.json()).data.rk_chart_workspace.state;};
  const rebuild=async()=>{await page.evaluate(()=>{ChartPage.onLeave();ChartPage.render(document.getElementById('page-container'));});await ready();};
  const failRoute=route=>route.request().method()==='POST'?route.fulfill({status:500,json:{ok:false,error:'isolated chart import failure'}}):route.continue();
  // Independent oracle: don't call the production ChartFavoriteMath helper.
  const verify=()=>page.evaluate(()=>{
    const c=Chart.getChart(document.getElementById('defenseChart')),v=ChartPage.getState(),s=DamagePage.getState();
    if(!c)throw Error('Missing chart');
    const visible=c.data.datasets.filter((d,i)=>!d.reference&&!d.favoriteMarker&&d.type!=='scatter'&&c.isDatasetVisible(i));
    const rows=[...document.querySelectorAll('#chartFavoriteGrid [data-chart-favorite]')];
    for(const node of rows){
      const pet=RKData.getMonsterById(Number(node.dataset.chartFavorite));let expected='neutral';
      if(visible.length===1){
        const cfg=visible[0].damageConfig,atk=v.mode==='defense'?s.skillType:v.attackType,def=atk==='attack'?'defense':'magic_defense';
        const attack=v.mode==='defense'?RKData.getPetStat(s.atkPet,atk,cfg.atkNature,cfg.atkIV):BattleMath.statFromBase(v.qualification,atk,cfg.atkNature,cfg.atkIV,RKData.getPetLevel(s.atkPet));
        const power=v.mode==='defense'?BattleMath.finalPower(s.basePower,s.fixedBonus,s.percentBonus,DamagePage.CalcEngine.isSameType(s.atkPet,s.skillAttr)?1.25:1,1,s.buff):BattleMath.finalPower(v.power,0,0,v.sameType?1.25:1);
        const hp=RKData.getPetStat(pet,'hp',cfg.hpNature?1:0,true),defense=RKData.getPetStat(pet,def,cfg.defNature,cfg.defIV);
        const damage=BattleMath.normalDamage(attack,power,defense,1,v.mode==='defense'?s.comboCount:1,RKData.getPetLevel(s.atkPet),RKData.getTypeEff(s.skillAttr,pet.main_type?.name||'',pet.sub_type?.name||''));
        expected=damage>=hp?'kill':'survive';
        const marker=c.data.datasets.find(d=>d.favoriteMarker)?.data.find(m=>m.id===pet.id);
        if(marker&&(marker.survival!==expected||marker.visibleResult.damage!==damage||marker.visibleResult.hp!==hp))throw Error('Canvas marker exact damage mismatch');
      }
      if(node.dataset.survival!==expected)throw Error('Grid survival mismatch');
      const color=getComputedStyle(node.querySelector('.chart-favorites-avatar > img, .chart-favorites-avatar > .quick-pet-initial')).borderTopColor;
      if(expected==='kill'&&color!=='rgb(220, 38, 38)')throw Error('Missing red ring');
      if(expected==='survive'&&color!=='rgb(22, 163, 74)')throw Error('Missing green ring');
      if(expected==='neutral'&&['rgb(220, 38, 38)','rgb(22, 163, 74)'].includes(color))throw Error('Non-neutral ring');
    }
    return {visible:visible.length,rows:rows.length,configs:visible.map(d=>d.damageConfig)};
  });
  const legend=async index=>page.evaluate(index=>{const c=Chart.getChart(document.getElementById('defenseChart'));c.options.plugins.legend.onClick({}, {datasetIndex:index},{chart:c});},index);
  let original;
  try{
    await page.goto(fixture.origins[0]+'/#/damage');await page.waitForFunction(()=>RKData.isLoaded&&UserConfig.getStatus().ready);
    await page.evaluate(()=>UserConfig.flush());original=await page.evaluate(()=>UserConfig.getObject('rk_chart_workspace',{}));
    await page.evaluate(async()=>{
      ChartPage.onLeave();ChartWorkspace.dispose();const legacy=ChartWorkspace.defaults();delete legacy.controls.hpNature;delete legacy.controlsRevision;
      window.__survivalCatalog=RKData.getMonsters;
      const eligible=RKData.getMonsters().filter(p=>!p.hidden&&!p.is_leader_form&&p.evolution_stage==='高级形态'&&['主形态','无多形态'].includes(p.form_category)).slice(0,100);
      RKData.getMonsters=()=>eligible;
      legacy.controls.doubleLife=false;legacy.controls.atkIV.attack=false;legacy.controls.atkNature.attack=2;legacy.controls.defIV.defense=false;legacy.groups[0].petIds=[249,327,202];
      await UserConfig.patch('rk_chart_workspace',{state:legacy});
      (0,eval)(await(await fetch('js/chart-workspace.js')).text());
      Object.assign(DamagePage.getState(),{atkPet:RKData.getMonsterById(202),defPet:RKData.getMonsterById(249),skillType:'attack',skillAttr:'水',basePower:430,basePowerExpression:'',fixedBonus:0,percentBonus:0,buff:0,comboCount:1});
      location.hash='/chart';
    });await ready();
    let saved=await file();check(saved.controls.hpNature===false&&saved.controls.doubleLife===false,'legacy false migrates to nature false');
    check(saved.controlsRevision===2&&saved.controls.atkIV.attack===true&&saved.controls.atkNature.attack===0&&saved.controls.defIV.defense===false,'migration performs one-time curve-button reset');
    let result=await verify();check(result.rows===3&&result.visible===1&&result.configs[0].atkNature===0&&result.configs[0].atkIV&&!result.configs[0].defIV,'selected curve alone visible, exact grid/canvas rings');
    check(await page.locator('#chartDoubleLifeBtn').textContent()==='生命性格','defender second button is HP nature only');
    await page.evaluate(async()=>ChartWorkspace.setControls({atkNature:{attack:1},defIV:{defense:true}}));await ready();
    const beforeNature=await page.evaluate(()=>{const c=Chart.getChart(document.getElementById('defenseChart'));return {data:c.data.datasets.filter((d,i)=>d.damageConfig&&c.isDatasetVisible(i)).map(d=>d.data),markers:c.data.datasets.find(d=>d.favoriteMarker).data.map(m=>({id:m.id,hp:m.hp,damage:m.damage,y:m.y}))};});
    await page.locator('#chartDoubleLifeBtn').click();await ready();
    const afterNature=await page.evaluate(()=>{const c=Chart.getChart(document.getElementById('defenseChart'));return {data:c.data.datasets.filter((d,i)=>d.damageConfig&&c.isDatasetVisible(i)).map(d=>d.data),markers:c.data.datasets.find(d=>d.favoriteMarker).data.map(m=>({id:m.id,hp:m.hp,damage:m.damage,y:m.y}))};});
    check(same(beforeNature.data,afterNature.data)&&afterNature.markers.every(m=>{const b=beforeNature.markers.find(p=>p.id===m.id);return b&&m.hp>b.hp&&m.y>b.y&&m.damage===b.damage;}),'HP nature changes HP/markers but not damage');
    check(await page.evaluate(()=>(()=>{const c=Chart.getChart(document.getElementById('defenseChart'));return c.data.datasets.filter(d=>d.damageConfig).every(d=>d.label.endsWith(d.damageConfig.hpNature?'✓生命性格':'×生命性格'));})()),'legend reports current HP nature, not an unrelated defense-nature flag');
    await page.locator('#chartAllBtn').click();await ready();
    check((await verify()).visible===1,'explicit ALL starts with only the selected full configuration visible');
    check(await page.evaluate(()=>{const c=Chart.getChart(document.getElementById('defenseChart'));return c.data.datasets.filter(d=>d.damageConfig).length===12&&c.data.datasets.filter((d,i)=>d.damageConfig&&c.isDatasetVisible(i)).every(d=>d.damageConfig.atkIV&&d.damageConfig.atkNature===1&&d.damageConfig.defIV&&d.damageConfig.hpNature);}), 'all twelve options exist, other eleven are initially hidden');
    const selected=await page.evaluate(()=>{const c=Chart.getChart(document.getElementById('defenseChart'));return c.data.datasets.findIndex((d,i)=>d.damageConfig&&c.isDatasetVisible(i));});
    await legend(selected);check((await verify()).visible===0,'zero visible damage curves neutral');
    await legend(0);check((await verify()).visible===1,'comparison-only line drives exact per-species colors');
    await legend(selected);check((await verify()).visible===2,'multiple visible damage curves neutral');
    await page.locator('#chartDoubleLifeBtn').click();await ready();check((await verify()).visible===1,'configuration change resets to selected line rather than baseline');
    await page.locator('#chartFavoriteGrid [data-chart-favorite]').first().click();check((await verify()).visible===1,'grid rebuild retains current ring states');
    await page.locator('#chartModeBtn').click();await ready();await page.locator('#chartPowerInput').fill('430');await ready();
    check((await verify()).visible===1,'attack qualification sweep uses current remembered qualification and power');
    await page.locator('#chartSwapAxisBtn').click();await ready();await page.locator('#chartPowerInput').fill('140');await ready();
    check((await verify()).visible===1,'power sweep uses remembered power and updated fixed qualification');
    await page.locator('#chartModeBtn').click();await ready();
    await page.locator('#chartGroupPresets').click();
    check(await page.locator('#chartPresetPicker .bloodline-hdropdown-row').count()===3&&await page.locator('#chartPresetPicker .bloodline-hdropdown-item').count()===18,'18-type picker keeps three rows of six');
    check(await page.locator('#chartPresetPicker [data-preset-id="preset:Survivors"]').textContent()==='斩杀预设','dynamic preset separate clear text item');
    await page.locator('[data-preset-id="preset:Survivors"]').click();await ready();
    const snapshot=await page.evaluate(()=>ChartWorkspace.getEntries().map(e=>e.id));check(snapshot.length>0,'dynamic preset has actual current survivors');
    const dynamicCorrect=await page.evaluate(()=>{
      const v=ChartPage.getState(),s=DamagePage.getState(),c=ChartWorkspace.getState().controls,atk=s.skillType,def=atk==='attack'?'defense':'magic_defense';
      const attack=RKData.getPetStat(s.atkPet,atk,c.atkNature[atk],c.atkIV[atk]);
      const power=BattleMath.finalPower(s.basePower,s.fixedBonus,s.percentBonus,DamagePage.CalcEngine.isSameType(s.atkPet,s.skillAttr)?1.25:1,1,s.buff);
      const expected=[...new Set(RKData.getMonsters().filter(p=>!p.hidden&&!p.is_leader_form&&p.evolution_stage==='高级形态'&&['主形态','无多形态'].includes(p.form_category)).filter(p=>BattleMath.normalDamage(attack,power,RKData.getPetStat(p,def,0,c.defIV[def]),1,s.comboCount,RKData.getPetLevel(s.atkPet),RKData.getTypeEff(s.skillAttr,p.main_type?.name||'',p.sub_type?.name||''))<RKData.getPetStat(p,'hp',v.hpNature?1:0,true)).map(p=>p.id))];
      return JSON.stringify(expected)===JSON.stringify(ChartWorkspace.getEntries().map(e=>e.id));
    });check(dynamicCorrect,'dynamic membership exactly matches independent current-damage oracle');
    const groups=(await state()).groups;check(same((await file()).groups,groups)&&groups.length===1,'dynamic builtin persists selection only, no frozen IDs');
    await page.evaluate(()=>{DamagePage.getState().basePower=0;});await rebuild();
    const zero=await page.evaluate(()=>ChartWorkspace.getEntries().map(e=>e.id));check(zero.length>snapshot.length,'parameter change refreshes dynamic membership without recursion');
    check(same((await file()).groups,groups),'dynamic refresh never persists membership');
    await page.locator('#chartGroupSelect').selectOption('ungrouped');await ready();
    await page.locator('#chartGroupManage').click();await page.locator('#chartGroupImportPreset').selectOption('preset:Survivors');
    const beforeImport=await file();await page.route('**/api/user-config',failRoute);await page.locator('#chartGroupImport').click();
    await page.waitForFunction(()=>ChartWorkspace.getStatus().pendingWrite&&!document.getElementById('chartWorkspaceRetry').hidden);
    check(same(await file(),beforeImport)&&same(await state(),beforeImport),'failed import preserves committed group and UI');
    await page.evaluate(()=>{DamagePage.getState().basePower=1000;});
    await page.unroute('**/api/user-config',failRoute);await page.locator('#chartWorkspaceRetry').click();await ready();
    const expected=[...new Set([...beforeImport.groups[0].petIds,...zero])];
    check(same((await file()).groups[0].petIds,expected),'retry appends exact failed snapshot in original order with stable-ID dedup');
    await page.locator('#chartGroupImport').click();await ready();check(same((await file()).groups[0].petIds,expected),'later smaller dynamic import never deletes existing members');
    await page.evaluate(async()=>{const id=await ChartWorkspace.copyGroup('preset:Survivors','动态快照');if(!id.startsWith('g_'))throw Error('copy failed');});await ready();
    check((await state()).groups.length===2,'existing copyGroup retains normal editable snapshot behavior');
    check(errors.length===0,'no browser runtime errors');
    return {passed:checks.length,checks};
  }finally{
    await page.unroute('**/api/user-config',failRoute);
    if(original)await page.evaluate(async original=>{ChartPage.onLeave();if(window.__survivalCatalog){RKData.getMonsters=window.__survivalCatalog;delete window.__survivalCatalog;}await UserConfig.retry();await UserConfig.patch('rk_chart_workspace',{state:original.state||ChartWorkspace.defaults()});await UserConfig.flush();},original);
    page.off('pageerror',onError);
  }
}
