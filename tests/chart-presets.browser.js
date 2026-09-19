// Runnable by playwright-cli run-code. Requires ONLY the isolated Go fixture;
// parent sets window.__damageFixture={origins:[...,...],reset_url:...}.
// No native launch; canonical API writes below are refused outside the fixture.
async page => {
  const fixture = await page.evaluate(() => window.__damageFixture);
  if (!fixture?.reset_url || fixture.origins?.length !== 2) throw Error('Explicit isolated fixture required');
  for (const origin of fixture.origins) {
    const r=await page.request.get(origin+'/__fixture/info');
    if (!r.ok() || (await r.json()).isolated!==true) throw Error('Refusing non-fixture configuration writes');
  }
  const checks=[], errors=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const onError=e=>errors.push(e.message); page.on('pageerror',onError);
  const viewport=page.viewportSize();
  const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const ready=async()=>{
    await page.waitForSelector('#chartGroupPresets');
    await page.waitForFunction(()=>ChartWorkspace.getStatus().initialized && !document.getElementById('chartGroupPresets').disabled);
    await page.evaluate(()=>UserConfig.flush()); await settle();
  };
  const file=async()=>{const r=await page.request.get(fixture.origins[0]+'/api/user-config');return (await r.json()).data.rk_chart_workspace.state;};
  const ids=()=>page.locator('#chartFavoriteGrid [data-chart-favorite]').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.chartFavorite)));
  const state=()=>page.evaluate(()=>ChartWorkspace.getState());
  const render=async()=>{
    await page.evaluate(()=>{ChartPage.onLeave();CommonUI.destroyWithin(document.getElementById('page-container'));ChartPage.render(document.getElementById('page-container'));});await ready();
  };
  const expected=type=>page.evaluate(type=>[...new Set(RKData.getMonsters().filter(p=>!p.hidden&&p.evolution_stage==='高级形态'&&!p.is_leader_form&&['主形态','无多形态'].includes(p.form_category)&&(p.main_type?.name===type||p.sub_type?.name===type)).map(p=>p.id))],type);
  const select=async type=>{
    await page.locator('#chartGroupPresets').click();
    await page.locator(`[data-preset-id="preset:${type}"]`).click();await ready();
    await page.waitForFunction(id=>ChartWorkspace.getState().activeGroupId===id,'preset:'+type);
  };
  const windowRoute=route=>route.fulfill({json:{maximized:true}});
  const failRoute=route=>route.request().method()==='POST'?route.fulfill({status:500,json:{ok:false,error:'isolated simulated preset save failure'}}):route.continue();
  let original, sourceSnapshot;
  try {
    await page.goto(fixture.origins[0]+'/#/damage');
    await page.waitForFunction(()=>typeof ChartWorkspace!=='undefined'&&UserConfig.getStatus().ready&&RKData.isLoaded);
    await page.evaluate(()=>UserConfig.flush());
    original=await page.evaluate(()=>UserConfig.getObject('rk_chart_workspace',{}));
    sourceSnapshot=await page.evaluate(async()=>(await fetch('data/monsters.json')).text());
    await page.evaluate(async()=>{
      ChartPage.onLeave(); ChartWorkspace.dispose();
      await UserConfig.patch('rk_chart_workspace',{state:ChartWorkspace.defaults()});
      (0,eval)(await(await fetch('js/chart-workspace.js')).text());
      const s=DamagePage.getState();Object.assign(s,{atkPet:RKData.getMonsterById(202),defPet:RKData.getMonsterById(9001),skillType:'magic_attack',skillAttr:'水',basePower:150,basePowerExpression:'',buff:200,comboCount:1,fixedBonus:0,percentBonus:0});
      location.hash='/chart';
    });await ready();
    const custom=await page.evaluate(async()=>{const id=await ChartWorkspace.createGroup('所有火系精灵');await ChartWorkspace.addPet(249);return id;});await ready();
    const savedGroups=(await state()).groups;
    const order=await page.evaluate(()=>RKData.PILL_ORDER.slice());
    check(order.length===18,'actual data defines exactly18 ordinary types');
    await page.locator('#chartGroupPresets').click();
    check(await page.locator('#chartPresetPicker .bloodline-hdropdown-row').count()===3,'bloodline style three rows without None/Leader row');
    check(await page.locator('#chartPresetPicker button').count()===18,'six icons per row, all18 types');
    check(same(await page.locator('#chartPresetPicker button').evaluateAll(ns=>ns.map(n=>n.dataset.presetId)),order.map(t=>'preset:'+t)),'actual PILL_ORDER drives picker order');
    check(await page.locator('[data-preset-id="preset:Normal"]').getAttribute('aria-label')==='所有普通系精灵','Normal uses full Chinese name');
    check(await page.locator('[data-preset-id="preset:Mechanical"]').getAttribute('aria-label')==='所有机械系精灵','Mechanical uses full Chinese name');
    await page.keyboard.press('ArrowRight');
    check(await page.evaluate(()=>document.activeElement.dataset.presetId)==='preset:Grass','right arrow moves one column');
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(()=>document.activeElement.dataset.presetId)==='preset:Dragon','down arrow moves one row');
    await page.keyboard.press('Escape');
    check(await page.locator('#chartPresetPicker').count()===0&&await page.locator('#chartGroupPresets').evaluate(n=>n===document.activeElement),'Escape destroys layer and returns focus');
    for (const type of order) {
      await select(type);
      check(same(await ids(),await expected(type)),type+' UI derives current actual dataset, includes secondary type, excludes non-main/non-high/hidden/leader');
      const persisted=await file();
      check(persisted.activeGroupId==='preset:'+type&&same(persisted.groups,savedGroups),type+' backend accepts selection but never persists derived member IDs');
    }
    await select('Fire');
    check(await page.evaluate(()=>{
      const c=Chart.getChart(document.getElementById('defenseChart'));
      const markers=c?.data.datasets.find(d=>d.favoriteMarker)?.data||[];
      const ids=new Set(ChartWorkspace.getEntries().map(e=>e.id));
      return markers.length>0&&markers.every(m=>ids.has(m.id)&&m.key==='chart:'+m.id&&Number.isFinite(m.x)&&Number.isFinite(m.y));
    }),'preset uses ordinary precise marker identity/coordinates, no duplicate configurations or invalid boundary values');
    await page.locator('#chartGroupManage').click();
    for(const id of ['chartGroupRename','chartGroupUp','chartGroupDown','chartGroupDelete','chartGroupMove','chartGroupMoveTarget']) check(await page.locator('#'+id).isDisabled(),id+' visibly disabled for read-only preset');
    check(await page.locator('#chartGroupCreate').isEnabled()&&await page.locator('#chartGroupCopy').isEnabled(),'new and copy stay enabled');
    check(await page.locator('#chartFavoriteSearch input').isDisabled(),'preset search is disabled instead of silently adding to ungrouped');
    const before=await file();
    const first=page.locator('#chartFavoriteGrid [data-chart-favorite]').first();
    await first.click({button:'right'}); await first.focus(); await page.keyboard.press('Delete');await settle();
    check(same(await file(),before)&&!await page.locator('#chartWorkspaceRetry').isVisible(),'right-click/Delete on presets does not enqueue writes or failed retries');
    const guard=await page.evaluate(async(custom)=>{
      const s=ChartWorkspace.getState(), actions=[()=>ChartWorkspace.addPet(327),()=>ChartWorkspace.addPet(327,custom),()=>ChartWorkspace.removePet(249),()=>ChartWorkspace.movePet(249,custom),()=>ChartWorkspace.renameGroup(s.activeGroupId,'错误')];
      let refused=0;for(const action of actions){try{await action();}catch(e){if(e.message.includes('只读'))refused++;}}
      return {refused,pending:ChartWorkspace.getStatus().pendingWrite};
    },custom);
    check(guard.refused===5&&!guard.pending,'store guards defend preset edits before persistence, including same-name custom destination');
    check(same(await file(),before),'same-named custom group never changed by read-only attempts');
    // Proof that a re-entry derives from current data rather than frozen saved IDs.
    const oldIds=await ids();
    await page.evaluate(()=>{window.__presetOriginalMonsters=RKData.getMonsters;const old=RKData.getMonsters(),remove=ChartWorkspace.getEntries()[0].id;RKData.getMonsters=()=>old.filter(p=>p.id!==remove);});
    await render();check(same(await ids(),oldIds.slice(1)),'re-entry refreshes membership when the loaded data changes');
    check(same((await file()).groups,savedGroups),'derived refresh does not write master data or membership');
    await page.evaluate(()=>{RKData.getMonsters=window.__presetOriginalMonsters;delete window.__presetOriginalMonsters;});await render();
    check(same(await ids(),oldIds),'restoring live source restores automatic members without migration');
    // Copy creates a normal editable snapshot, not another preset or multi-config avatar.
    if(!await page.locator('#chartGroupManager').isVisible())await page.locator('#chartGroupManage').click();
    await page.locator('#chartGroupName').fill('火系独立副本');await page.locator('#chartGroupCopy').click();await ready();
    const copied=await state();check(copied.activeGroupId.startsWith('g_')&&same(copied.groups.find(g=>g.id===copied.activeGroupId).petIds,oldIds),'copy uses generated custom ID and current member snapshot');
    check(await page.locator('#chartFavoriteSearch input').isEnabled(),'copy re-enables ordinary membership editing');
    await page.locator('#chartFavoriteGrid [data-chart-favorite]').first().click({button:'right'});await ready();
    check((await ids()).length===oldIds.length-1,'copied ordinary group is editable');
    await select('Fire');check(same(await ids(),oldIds),'editing copied group leaves automatic preset intact');
    await page.locator('#chartGroupSelect').selectOption('all');await ready();
    const current=await state();check(same(await ids(),[...new Set(current.groups.flatMap(g=>g.petIds))]),'all view union includes only saved custom groups');
    await select('Mechanical');await page.locator('#chartDoubleLifeBtn').click();await ready();
    const committed=await file();check(committed.controls.doubleLife===true,'control save works while reserved preset is selected');
    await page.reload();await ready();check((await state()).activeGroupId==='preset:Mechanical'&&(await state()).controls.doubleLife,'actual backend reload preserves preset and controls');
    await page.goto(fixture.origins[1]+'/#/chart');await ready();
    check((await state()).activeGroupId==='preset:Mechanical','second origin loads preset from shared backend');
    await page.evaluate(()=>localStorage.clear());await page.reload();await ready();
    check((await state()).activeGroupId==='preset:Mechanical','cache removal does not erase saved preset selection');
    // Reject stale/reserved IDs at the actual Go boundary without damaging state.
    const valid=await file();
    const stale=JSON.parse(JSON.stringify(valid));stale.activeGroupId='preset:Obsolete';
    const bad=await page.request.post(fixture.origins[0]+'/api/user-config',{data:{patch:{rk_chart_workspace:{state:stale}}}});
    check(!bad.ok()&&same(await file(),valid),'backend rejects stale preset ID and preserves committed state');
    const collision=JSON.parse(JSON.stringify(valid));collision.groups.push({id:'preset:Fire',name:'冒充',petIds:[]});
    const badGroup=await page.request.post(fixture.origins[0]+'/api/user-config',{data:{patch:{rk_chart_workspace:{state:collision}}}});
    check(!badGroup.ok()&&same(await file(),valid),'backend rejects reserved custom group namespace');
    // Failed save is not optimistic selection; retry uses the original reserved ID.
    await page.route('**/api/user-config',failRoute);
    await page.locator('#chartGroupPresets').click();await page.locator('[data-preset-id="preset:Water"]').click();
    await page.waitForFunction(()=>document.getElementById('chartWorkspaceStatus').textContent.includes('未保存'));
    check((await state()).activeGroupId==='preset:Mechanical'&&same(await file(),valid),'failed save leaves committed selection and groups');
    await page.unroute('**/api/user-config',failRoute);await page.locator('#chartWorkspaceRetry').click();await ready();
    check((await file()).activeGroupId==='preset:Water','retry commits the requested preset with no member freeze');
    // Keyboard and edge positioning in real zoomed layout (native-state fixture override only).
    await page.route('**/api/window/state',windowRoute);
    for(const width of [1280,420])for(const zoom of [1,1.5,2]) {
      await page.setViewportSize({width,height:900});
      await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
      await page.waitForFunction(()=>AppPreferences.getWindowState().initialized&&AppPreferences.isMaximized());
      await page.evaluate(z=>AppPreferences.setMaxZoom(z,false),zoom);await settle();
      await page.locator('#chartGroupPresets').scrollIntoViewIfNeeded();await page.locator('#chartGroupPresets').focus();await page.keyboard.press('ArrowDown');
      const bounds=await page.locator('#chartPresetPicker').evaluate(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,w:innerWidth,h:innerHeight,overflow:n.scrollWidth>n.clientWidth+1};});
      check(bounds.left>=0&&bounds.right<=bounds.w+1&&bounds.top>=0&&bounds.bottom<=bounds.h+1&&!bounds.overflow,width+' @'+zoom+' picker fits viewport without horizontal clipping');
      await page.keyboard.press('End');check(await page.evaluate(()=>document.activeElement.dataset.presetId)==='preset:Illusion','End reaches final type at '+width+'/'+zoom);
      await page.keyboard.press('Escape');check(await page.locator('#chartPresetPicker').count()===0,'Escape cleanup at '+width+'/'+zoom);
    }
    await page.locator('#chartGroupPresets').click();await page.evaluate(()=>window.dispatchEvent(new Event('appfontchange')));
    check(await page.locator('#chartPresetPicker').count()===0,'font change closes anchored picker');
    await page.locator('#chartGroupPresets').click();await page.evaluate(()=>ChartPage.onLeave());
    check(await page.locator('#chartPresetPicker').count()===0,'route leave cleans anchored layer');
    check(await page.evaluate(async()=>(await fetch('data/monsters.json')).text())===sourceSnapshot,'master dataset bytes remain unchanged across reload and selection');
    check(errors.length===0,'no browser runtime errors');
    return {passed:checks.length,checks};
  } finally {
    await page.unroute('**/api/user-config',failRoute);await page.unroute('**/api/window/state',windowRoute);
    if(original)await page.evaluate(async original=>{
      ChartPage.onLeave();if(window.__presetOriginalMonsters){RKData.getMonsters=window.__presetOriginalMonsters;delete window.__presetOriginalMonsters;}
      await UserConfig.retry();await UserConfig.patch('rk_chart_workspace',{state:original.state||ChartWorkspace.defaults()});await UserConfig.flush();
    },original);
    page.off('pageerror',onError);if(viewport)await page.setViewportSize(viewport);
  }
}
