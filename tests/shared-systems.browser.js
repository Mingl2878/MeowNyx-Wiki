// Run via playwright-cli in a separate temporary browser, never the user's regular profile.
async page => {
  const checks = [], errors = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const onError = e => errors.push(e.message);
  page.on('pageerror', onError);
  let maximized = true, rejectSave = true;
  const sharedSettings = { default_route: 'damage', default_max_zoom: 70, window_maximized: true, font_family: '', effective_speed_mode: 'include', effective_speed_threshold: 80, effective_include_speed: true };
  const settingsRoute = async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sharedSettings) });
    if (!rejectSave) Object.assign(sharedSettings, route.request().postDataJSON());
    return route.fulfill({ status: rejectSave ? 500 : 200, contentType: 'application/json', body: JSON.stringify(rejectSave ? {ok:false,error:'模拟保存失败'} : {ok:true}) });
  };
  const windowRoute = route => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify({maximized}) });
  await page.route('**/api/settings', settingsRoute);
  await page.route('**/api/window/state', windowRoute);
  await page.addInitScript(() => {
    localStorage.setItem('xwiki-max-zoom', '1.9');
    localStorage.setItem('xwiki-default-route', 'team');
    localStorage.setItem('xwiki-theme', 'light');
    const records = [];
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    const watched = new Set(['scroll','resize','appzoomchange','pointerdown','keydown','click']);
    const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if ((this === window || this === document) && watched.has(type) && !records.some(r=>r.target===this && r.type===type && r.listener===listener && r.capture===capture(options))) records.push({target:this,type,listener,capture:capture(options)});
      return add.call(this,type,listener,options);
    };
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
      const i=records.findIndex(r=>r.target===this && r.type===type && r.listener===listener && r.capture===capture(options));
      if(i>=0) records.splice(i,1);
      return remove.call(this,type,listener,options);
    };
    window.__listenerSummary = () => Object.fromEntries([...watched].map(type=>[type,records.filter(r=>r.type===type).length]));
  });
  const go = async route => {
    await page.locator(`a[data-route="${route}"]`).click();
    await page.waitForSelector(route==='damage'?'#basePower':route==='chart'?'#chartPowerInput':'#team-search',{state:'attached'});
  };
  try {
    await page.evaluate(() => { location.hash = '/damage'; });
    await page.reload();
    await page.waitForSelector('#basePower');
    await page.waitForFunction(()=>window.__getPageZoom()===0.7);
    check(await page.evaluate(async()=>{await window.appPreferencesReady;return AppPreferences.getZoom()===.7 && localStorage.getItem('xwiki-max-zoom')==='0.7' && localStorage.getItem('xwiki-default-route')==='damage';}),'shared startup route/70% zoom replace stale per-port cache');
    maximized=false;
    await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
    await page.waitForFunction(()=>window.__getPageZoom()===1);
    check(await page.evaluate(()=>AppPreferences.getMaxZoom()===.7),'windowed mode uses 100% without losing maximized memory');
    maximized=true;
    await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
    await page.waitForFunction(()=>window.__getPageZoom()===.7);
    check(true,'re-maximizing restores 70%');
    await page.evaluate(()=>AppPreferences.setMaxZoom(1));

    await page.locator('#resetAttackerBtn').click();
    // Reset now selects automatic defaults, not an all-off record. Set the
    // desired four-IV/two-nature simulation explicitly before testing limits.
    for(const stat of ['hp','defense','attack','magic_attack','magic_defense','speed']) {
      const desired=['hp','defense','attack','magic_attack'].includes(stat);
      if(await page.evaluate(stat=>!!DamagePage.getState().atkIV[stat],stat)!==desired)
        await page.locator(`.attacker-card .iv-btn[data-stat="${stat}"]`).click();
    }
    for(const stat of ['attack','speed']) if(await page.evaluate(stat=>DamagePage.getState().atkNature[stat],stat)!==1) await page.locator(`.attacker-card .nature-btn[data-stat="${stat}"]`).click();
    check(await page.locator('.attacker-card .btn-disabled').count()===0,'free simulation does not show false disabled hints');
    check(await page.evaluate(()=>Object.values(DamagePage.getState().atkIV).filter(v=>v===true).length===4),'free simulation remains unrestricted');
    await page.locator('#finalPowerManual').fill('123');
    const lightManual=await page.locator('#finalPower').evaluate(e=>getComputedStyle(e).color);
    await page.locator('#theme-toggle').click();
    check(await page.locator('#finalPower').evaluate(e=>getComputedStyle(e).color)===lightManual,'manual-power warning color survives dark mode');
    check(await page.locator('.final-power-manual-label').evaluate(e=>getComputedStyle(e).color)===lightManual,'manual-power label also preserves its warning color');
    check(await page.locator('.skill-icon-name').first().evaluate(e=>getComputedStyle(e).color)==='rgb(160, 160, 184)','skill labels follow the dark text token');
    check(await page.evaluate(()=>getComputedStyle(document.body,'::-webkit-scrollbar').width)==='6px','one shared scrollbar width is used');

    await page.locator('#skillAttrBtn').click();
    check(await page.locator('#skillAttrDropdown').evaluate(e=>getComputedStyle(e).display)==='flex','shared positioning preserves the attribute popup layout');
    await page.keyboard.press('Escape');
    check(await page.locator('#skillAttrDropdown').count()===0,'Escape closes the attribute popup');
    await page.setViewportSize({width:1280,height:600});
    await page.locator('#skillAttrBtn').click();
    await page.evaluate(()=>{const s=document.querySelector('.calc-root.scroll-container');s.scrollBy(0,50);s.dispatchEvent(new Event('scroll'));});
    check(await page.locator('#skillAttrDropdown').count()===0,'scrolling closes the attribute popup instead of detaching it');
    await page.locator('#skillAttrBtn').click();
    await page.evaluate(()=>AppPreferences.setMaxZoom(1.1));
    check(await page.locator('#skillAttrDropdown').count()===0,'zoom changes close anchored popups');
    await page.evaluate(()=>AppPreferences.setMaxZoom(1));

    await go('chart');
    await page.waitForTimeout(200); // CSS color transitions must settle before comparison.
    const beforeColor=await page.locator('#chartAtkIVBtn').evaluate(e=>getComputedStyle(e).backgroundColor);
    await page.locator('#chartAtkIVBtn').click();
    await page.waitForTimeout(200);
    check(await page.locator('#chartAtkIVBtn').evaluate(e=>getComputedStyle(e).backgroundColor)!==beforeColor,'dark-mode active and inactive buttons are visibly different');
    check(await page.evaluate(()=>{const c=Chart.getChart(document.getElementById('defenseChart'));return c.options.plugins.legend.labels.color==='#a0a0b8' && c.options.scales.x.ticks.color==='#a0a0b8';}),'canvas legend and axes follow the dark palette');
    const viewBefore=await page.evaluate(()=>ChartPage.getState());
    await page.locator('#theme-toggle').click();
    check(await page.evaluate(()=>Chart.getChart(document.getElementById('defenseChart')).options.scales.x.ticks.color)==='#6b7280','theme change refreshes the existing chart immediately');
    check(same(await page.evaluate(()=>ChartPage.getState()),viewBefore),'theme refresh does not change curve settings');
    await page.evaluate(()=>{const s=document.querySelector('.chart-page');s.scrollTop=s.scrollHeight;});
    check(await page.evaluate(()=>{const s=document.querySelector('.chart-page'),r=s.getBoundingClientRect(),b=document.getElementById('chartControls').getBoundingClientRect();return b.bottom<=r.bottom && b.bottom<=innerHeight;}),'bottom chart controls are reachable at 1280x600');
    await page.setViewportSize({width:1280,height:900});

    const listenersBefore=await page.evaluate(()=>window.__listenerSummary());
    for(let i=0;i<4;i++){
      await go('damage');await page.locator('#attacker-search-slot input').fill('权杖');await go('chart');
    }
    check(same(await page.evaluate(()=>window.__listenerSummary()),listenersBefore),'route changes do not accumulate global widget listeners');
    await page.evaluate(()=>{const host=document.createElement('div');document.body.appendChild(host);const box=CommonUI.createSearchBox({});host.appendChild(box.wrapper);box.input.value='权杖';box.input.dispatchEvent(new Event('input'));host.remove();});
    await page.waitForFunction(expected=>JSON.stringify(window.__listenerSummary())===JSON.stringify(expected),listenersBefore);
    check(true,'detached search widgets are cleaned after local DOM redraws');
    await go('team');
    check(await page.locator('#team-search').evaluate(e=>getComputedStyle(e).maxWidth)==='none','team search is no longer capped by calculator-only CSS');

    await go('damage');
    await page.evaluate(()=>localStorage.setItem('rk_team_config',JSON.stringify({activeGroupId:'audit',groups:[{id:'audit',team:[501,434],petSkills:{501:['防御','魔法增效','械斗','磁暴','不存在的技能']}}]})));
    await page.locator('#attacker-search-slot input').fill('圣剑-X');
    check(await page.evaluate(()=>{const title=[...document.querySelectorAll('.skill-icon-group-title')].find(e=>e.textContent==='过山车技能');const names=[...title.parentElement.querySelectorAll('.skill-icon-item')].map(e=>e.dataset.skillName);return JSON.stringify(names)===JSON.stringify(['械斗','磁暴']);}),'coaster quick cards contain only physical/magic attacks');

    await page.evaluate(()=>{localStorage.setItem('xwiki-default-route','damage');AppPreferences.setMaxZoom(1);location.hash='/settings';});
    await page.waitForSelector('#set-save-btn');
    await page.locator('#set-route-grid [data-route="chart"]').click();
    await page.locator('#set-zoom').fill('150');
    check(await page.evaluate(()=>localStorage.getItem('xwiki-default-route')==='damage' && localStorage.getItem('xwiki-max-zoom')==='1' && AppPreferences.getZoom()===1),'settings drafts do not alter committed preferences');
    await page.locator('#set-save-btn').click();
    await page.waitForFunction(()=>document.getElementById('settings-result').textContent.includes('保存失败'));
    check(await page.evaluate(()=>localStorage.getItem('xwiki-default-route')==='damage' && localStorage.getItem('xwiki-max-zoom')==='1' && AppPreferences.getZoom()===1),'failed save preserves route, zoom memory and live zoom');
    rejectSave=false;
    await page.locator('#set-save-btn').click();
    await page.waitForFunction(()=>AppPreferences.getZoom()===1.5);
    check(await page.evaluate(()=>localStorage.getItem('xwiki-default-route')==='chart' && localStorage.getItem('xwiki-max-zoom')==='1.5'),'successful save synchronizes preference caches and live zoom');
    await page.evaluate(()=>AppPreferences.setMaxZoom(1));
    await go('damage');
    check(errors.length===0,`no browser runtime errors (${errors.join('; ')})`);
    return {passed:checks.length,checks};
  } finally {
    page.off('pageerror',onError);
    await page.unroute('**/api/settings',settingsRoute);
    await page.unroute('**/api/window/state',windowRoute);
  }
}
