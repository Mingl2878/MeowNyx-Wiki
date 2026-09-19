// Isolated Playwright page only. No real profile writes or native app launches.
// Groups, single-species views, independent controls, failed saves, exact markers,
// native window sizing/ticks and zoom hit testing. Parent may run via playwright-cli.
async page => {
  const checks = [], errors = [];
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const onError = e => errors.push(e.message);
  let saved, maximized = false;
  const viewport = page.viewportSize();
  const settle = async () => { await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))); };
  const ready = async () => {
    await page.waitForFunction(() => !document.getElementById('chartAtkIVBtn')?.disabled && !document.getElementById('chartWorkspaceStatus')?.textContent);
    await settle();
  };
  const route = async route => {
    const r = route.request();
    if (r.url().split('?')[0].endsWith('/api/window/state')) return route.fulfill({json:{maximized}});
    if (!['GET','HEAD'].includes(r.method())) return route.fulfill({status:405,json:{ok:false,error:'isolated curve suite'}});
    return route.fallback();
  };
  const render = async () => {
    await page.evaluate(() => { ChartPage.onLeave(); CommonUI.destroyWithin(document.getElementById('page-container')); ChartPage.render(document.getElementById('page-container')); });
    await ready();
  };
  const state = () => page.evaluate(() => ChartWorkspace.getState());
  const ids = () => page.locator('#chartFavoriteGrid [data-chart-favorite]').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.chartFavorite)));
  const markers = () => page.evaluate(() => {
    const c=Chart.getChart(document.getElementById('defenseChart'));
    return c?.data.datasets.find(d=>d.favoriteMarker)?.data.map(m=>({id:m.id,key:m.key,x:m.x,y:m.y,hp:m.hp,damage:m.damage,defense:m.defense})) || [];
  });
  const chooseGroup = async id => { await page.locator('#chartGroupSelect').selectOption(id); await ready(); };
  const clickSave = async id => { await page.locator('#'+id).click(); await ready(); };
  const manager = async () => { if (!await page.locator('#chartGroupManager').isVisible()) await page.locator('#chartGroupManage').click(); };
  const snapshot = () => page.evaluate(() => {
    const c=Chart.getChart(document.getElementById('defenseChart')), box=document.querySelector('.chart-container'), grid=document.getElementById('chartFavoriteGrid');
    return {height:box.clientHeight, width:box.clientWidth, canvas:c.width===box.clientWidth&&c.height===box.clientHeight,
      gridBottom:grid.getBoundingClientRect().bottom, viewport:innerHeight, max:AppPreferences.isMaximized(),
      step:c.options.scales.y.ticks.stepSize,ticks:c.scales.y.ticks.map(t=>t.value),maximum:c.scales.y.max,
      data:JSON.stringify(c.data.datasets.map(d=>({key:d.viewKey,data:d.favoriteMarker?d.data.map(m=>({id:m.id,x:m.x,y:m.y,damage:m.damage})):d.data}))) };
  });
  await page.route('**/api/**',route); page.on('pageerror',onError);
  try {
    await page.waitForFunction(()=>typeof DamagePage!=='undefined'&&typeof RKData!=='undefined');
    saved=await page.evaluate(()=>{
      window.__independentSaved={config:window.UserConfig,workspace:window.ChartWorkspace,confirm:window.confirm};
      return {storage:{...localStorage},state:JSON.parse(JSON.stringify(DamagePage.getState())),hash:location.hash,maxZoom:AppPreferences.getMaxZoom(),theme:document.documentElement.getAttribute('data-theme')};
    });
    await page.setViewportSize({width:1440,height:1100});
    await page.evaluate(()=>{
      ChartPage.onLeave();
      window.__curveTest={saved:{},writes:0,fail:false,hold:false,release:null};
      const original=window.UserConfig;
      window.UserConfig={...original,
        getObject(key,fallback){if(key==='rk_chart_workspace')return structuredClone(window.__curveTest.saved);return original.getObject(key,fallback);},
        async patch(key,patch){
          if(key!=='rk_chart_workspace')throw Error('unexpected curve write '+key);
          const test=window.__curveTest;test.writes++;
          if(test.hold)await new Promise(r=>test.release=r);
          if(test.fail)return false;
          test.saved=structuredClone(patch);return true;
        }
      };
      localStorage.setItem('rk_fav_pets','[202,434,249]');
      localStorage.setItem('rk_chart_fav_pets','[249,327,249]');
      localStorage.setItem('rk_pet_configs','{"249":{"iv":{"hp":true},"nature":{"hp":2}}}');
      Object.assign(DamagePage.getState(),{atkPet:RKData.getMonsterById(202),defPet:RKData.getMonsterById(9001),skillType:'magic_attack',skillAttr:'水',
        basePower:450,fixedBonus:0,percentBonus:0,buff:0,comboCount:1,atkIV:{},atkNature:{magic_attack:2},defIV:{},defNature:{magic_defense:2,hp:2}});
      AppPreferences.setMaxZoom(1,false);
    });
    // Reinstantiate only the new store in this isolated page, never mutate a real profile.
    await page.evaluate(async()=>{ (0,eval)(await (await fetch('js/chart-workspace.js')).text()); });
    await render();
    check(JSON.stringify(await ids())==='[249,327]','only B legacy migrates; A-only pets absent and duplicate species removed');
    check((await state()).legacyImported===true,'migration committed even with one legacy source');
    check(await page.locator('[data-favorite-source]').count()===0,'no A/B provenance UI remains');
    const originalMarkers=await markers();
    check(originalMarkers.length===2&&new Set(originalMarkers.map(m=>m.id)).size===2,'one marker per curve species');
    check((await state()).controls.atkIV.magic_attack && !(await state()).controls.atkNature.magic_attack && (await state()).controls.defIV.magic_defense,'independent attack/defense IV defaults on, nature neutral');
    await clickSave('chartDoubleLifeBtn');
    const wand=(await markers()).find(m=>m.id===249);
    check(wand.hp===455,'shared double-life computes WAND-V HP455 without personal overrides');
    await page.locator('#chartAtkNatureBtn').click({button:'right'});await ready();
    check((await state()).controls.atkNature.magic_attack===2,'curve negative nature cycle persists');
    const controlsBefore=(await state()).controls, markersBefore=await markers();
    await page.evaluate(()=>{
      Object.assign(DamagePage.getState(),{atkIV:{magic_attack:true},atkNature:{magic_attack:1},defIV:{hp:true,magic_defense:true},defNature:{hp:1,magic_defense:1}});
      localStorage.setItem('rk_fav_pets','[1,2,3]');localStorage.setItem('rk_pet_configs','{}');FavoritePets.notify();
    });await render();
    check(JSON.stringify(await markers())===JSON.stringify(markersBefore),'changing damage favorites and nature/IV does not change markers');
    check(JSON.stringify((await state()).controls)===JSON.stringify(controlsBefore),'damage changes do not reset curve controls');
    await page.evaluate(()=>{DamagePage.getState().atkPet=RKData.getMonsterById(249);DamagePage.getState().defPet=RKData.getMonsterById(327);});await render();
    check(JSON.stringify((await state()).controls)===JSON.stringify(controlsBefore),'species changes never clear curve control choices');
    check(await page.locator('#chartInfo').textContent().then(t=>t.includes('权杖')),'attack species still comes from damage page');
    await manager();
    await page.locator('#chartGroupName').fill('测试一');await clickSave('chartGroupCreate');
    const first=(await state()).activeGroupId;check((await ids()).length===0,'new group initially empty');
    // Search selection exercises the real shared search widget.
    await page.locator('#chartFavoriteSearch input').fill('权杖');
    await page.waitForSelector('.autocomplete-item',{state:'visible'});
    const option=page.locator('.autocomplete-item').filter({hasText:'权杖-V'}).first();await option.click();await ready();
    check(JSON.stringify(await ids())==='[249]','search adds species to active group, not damage favorites');
    await page.locator('#chartGroupName').fill('复制组');await clickSave('chartGroupCopy');
    const copied=(await state()).activeGroupId;
    check(JSON.stringify(await ids())==='[249]'&&copied!==first,'copy group retains members without extra configurations');
    await page.locator('#chartGroupName').fill('重命名<&>');await clickSave('chartGroupRename');
    check((await state()).groups.find(g=>g.id===copied).name==='重命名<&>','rename safely preserves literal special characters');
    await clickSave('chartGroupUp');check((await state()).groups[1].id===copied,'group order up persists');
    await clickSave('chartGroupDown');check((await state()).groups[2].id===copied,'group order down persists');
    await chooseGroup('all');check(JSON.stringify(await ids())==='[249,327]','all groups deduplicate overlapping membership');
    check((await markers()).length===2,'all groups do not draw duplicate species avatars');
    await chooseGroup(copied);
    await page.locator('[data-chart-favorite="249"]').click();
    await page.locator('#chartGroupMoveTarget').selectOption(first);await clickSave('chartGroupMove');
    check((await ids()).length===0,'move removes source membership');
    check((await state()).groups.find(g=>g.id==='ungrouped').petIds.includes(249),'move preserves unrelated overlapping membership');
    check((await state()).groups.find(g=>g.id===first).petIds.filter(id=>id===249).length===1,'move into existing membership deduplicates');
    await page.evaluate(async()=>{await ChartWorkspace.addPet(434);});await ready();
    await page.evaluate(()=>window.confirm=()=>false);await page.locator('#chartGroupDelete').click();await settle();
    check((await state()).groups.some(g=>g.id===copied),'delete cancellation keeps group');
    await page.evaluate(()=>window.confirm=()=>true);await clickSave('chartGroupDelete');
    check(!(await state()).groups.some(g=>g.id===copied)&&(await state()).groups[0].petIds.includes(434),'delete confirmation moves members to ungrouped without deleting species');
    const beforeFailure=await state();
    await page.evaluate(()=>window.__curveTest.fail=true);
    await page.locator('#chartDoubleLifeBtn').click();
    await page.waitForSelector('#chartWorkspaceRetry',{state:'visible'});
    check(JSON.stringify(await state())===JSON.stringify(beforeFailure),'failed control save does not optimistically alter current UI configuration');
    check(await page.locator('#chartWorkspaceStatus').textContent().then(t=>t.includes('未保存')),'failure is visible and retry offered');
    await page.evaluate(()=>window.__curveTest.fail=false);await clickSave('chartWorkspaceRetry');
    check((await state()).controls.doubleLife!==beforeFailure.controls.doubleLife,'retry applies successful control save');
    await page.evaluate(()=>{window.__curveTest.hold=true;});
    const previous=(await state()).activeGroupId;await page.locator('#chartGroupSelect').selectOption(first);
    await page.waitForFunction(()=>!!window.__curveTest.release);
    check((await state()).activeGroupId===previous,'in-flight save keeps committed active group');
    check(await page.locator('#chartGroupCreate').isDisabled(),'pending save prevents overlapping UI mutations');
    await page.evaluate(()=>{window.__curveTest.hold=false;window.__curveTest.release();});await ready();
    check((await state()).activeGroupId===first,'active group changes only after save succeeds');
    await chooseGroup('all');
    const beforeRemove=await ids();await page.locator('[data-chart-favorite="249"]').click({button:'middle'});await settle();
    check(JSON.stringify(await ids())===JSON.stringify(beforeRemove),'middle click never removes curve favorite');
    await page.locator('[data-chart-favorite="249"]').click({button:'right'});await ready();
    check(!(await ids()).includes(249)&&(await state()).groups.every(g=>!g.petIds.includes(249)),'right click removes only clicked species globally from curve groups');
    check(await page.evaluate(()=>localStorage.getItem('rk_fav_pets'))==='[1,2,3]','all group operations preserve damage favorites');
    const beforeReload=await state();
    await page.evaluate(async()=>{ChartPage.onLeave();(0,eval)(await(await fetch('js/chart-workspace.js')).text());});await render();
    check(JSON.stringify(await state())===JSON.stringify(beforeReload),'recreated store restores groups/active selection/controls and does not revive old B');
    await manager();await page.locator('#chartGroupManage').click();
    await page.evaluate(()=>{Object.assign(DamagePage.getState(),{atkPet:RKData.getMonsterById(202),defPet:RKData.getMonsterById(9001),basePower:450});});await render();
    const preEye=await ids();await page.locator('#chartFavoriteToggle').click();await settle();
    check(JSON.stringify(await ids())===JSON.stringify(preEye),'eye hides graph annotation only, not list');
    await page.locator('#chartFavoriteToggle').click();await settle();
    maximized=false;await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await page.waitForFunction(()=>AppPreferences.getWindowState().initialized&&!AppPreferences.isMaximized());await settle();
    const normal=await snapshot();check(normal.height<=520&&normal.canvas,'windowed height cap and layout-pixel canvas retained');
    maximized=true;await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await page.waitForFunction(()=>AppPreferences.isMaximized());await settle();
    const max=await snapshot();check(max.height>normal.height&&max.gridBottom<=max.viewport+1,'native maximize expands chart and leaves group/favorite rows visible');
    check([10,20,25,50].includes(max.step)&&max.ticks.every((n,i)=>!i||n-max.ticks[i-1]===max.step),'allowed y-axis tick spacing retained');
    check(max.data===normal.data,'maximizing does not alter numeric data');
    for(const zoom of [1.5,2]) {
      await page.evaluate(z=>AppPreferences.setMaxZoom(z,false),zoom);await settle();
      check((await snapshot()).canvas,zoom+' zoom uses unscaled content canvas sizing');
      await page.locator('#defenseChart').scrollIntoViewIfNeeded();
      const pos=await page.evaluate(()=>{
        const c=Chart.getChart(document.getElementById('defenseChart')),i=c.data.datasets.findIndex(d=>d.favoriteMarker),p=c.getDatasetMeta(i).data[0],r=c.canvas.getBoundingClientRect();
        return {x:r.left+p.x*r.width/c.width,y:r.top+p.y*r.height/c.height,id:c.data.datasets[i].data[0].id};
      });await page.mouse.move(pos.x,pos.y);await settle();
      check(await page.evaluate(id=>Chart.getChart(document.getElementById('defenseChart')).tooltip.dataPoints?.some(p=>p.raw.id===id),pos.id),zoom+' zoom avatar tooltip hit is correct');
    }
    check(errors.length===0,'no browser runtime errors');
    return {passed:checks.length,checks};
  } finally {
    if(saved)await page.evaluate(saved=>{
      ChartPage.onLeave();window.ChartWorkspace?.dispose();window.UserConfig=window.__independentSaved.config;window.ChartWorkspace=window.__independentSaved.workspace;window.confirm=window.__independentSaved.confirm;
      localStorage.clear();for(const[k,v]of Object.entries(saved.storage))localStorage.setItem(k,v);
      Object.assign(DamagePage.getState(),saved.state);document.documentElement.setAttribute('data-theme',saved.theme||'light');AppPreferences.setMaxZoom(saved.maxZoom,false);
      delete window.__independentSaved;delete window.__curveTest;
    },saved);
    page.off('pageerror',onError);await page.unroute('**/api/**',route);if(viewport)await page.setViewportSize(viewport);
  }
}
