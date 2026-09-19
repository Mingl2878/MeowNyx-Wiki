// Parent-only browser suite. Run on an isolated profile and read-only/temporary-config server.
// playwright-cli run-code --filename=tests/chart-favorites.browser.js
async page => {
  const checks = [], errors = [];
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const go = async route => {
    await page.locator(`a[data-route="${route}"]`).click();
    await page.waitForSelector(route === 'chart' ? '#defenseChart' : '#basePower', {state:'attached'});
  };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const item = key => page.locator(`[data-favorite-key="${key}"]`);
  const markers = () => page.evaluate(() => Chart.getChart(document.getElementById('defenseChart')).data.datasets.find(d => d.favoriteMarker)?.data.map(m => ({key:m.key,x:m.x,y:m.y,hp:m.hp,damage:m.damage,defense:m.defense})) || []);
  const canvasPoint = key => page.evaluate(key => {
    const canvas = document.getElementById('defenseChart'), c = Chart.getChart(canvas);
    const di = c.data.datasets.findIndex(d => d.favoriteMarker), ds = c.data.datasets[di];
    const point = c.getDatasetMeta(di).data[ds.data.findIndex(m => m.key === key)], rect = canvas.getBoundingClientRect();
    return {x:rect.left + point.x * rect.width/c.width, y:rect.top + point.y * rect.height/c.height};
  }, key);
  const sizeCheck = () => page.evaluate(() => {
    const canvas = document.getElementById('defenseChart'), c = Chart.getChart(canvas), p = canvas.parentElement;
    const s = getComputedStyle(p), px = n => parseFloat(n) || 0;
    return Math.abs(c.width - p.clientWidth + px(s.paddingLeft) + px(s.paddingRight)) <= 1
      && Math.abs(c.height - p.clientHeight + px(s.paddingTop) + px(s.paddingBottom)) <= 1;
  });
  const ready=()=>page.waitForFunction(()=>!document.getElementById('chartAtkIVBtn').disabled);
  let saved;
  try {
    await go('damage');
    saved = await page.evaluate(() => { window.__chartFavOriginal={user:window.UserConfig,store:window.ChartWorkspace};window.__chartFavData={};return {
      storage:Object.fromEntries(['rk_fav_pets','rk_chart_fav_pets','rk_pet_configs'].map(k => [k,localStorage.getItem(k)])),
      state:JSON.parse(JSON.stringify(DamagePage.getState())), zoom:document.documentElement.style.zoom,
      pageZoom:document.documentElement.style.getPropertyValue('--page-zoom')
    };});
    const before = await page.evaluate(() => {
      const s = DamagePage.getState();
      Object.assign(s, {atkPet:RKData.getMonsterById(434),defPet:RKData.getMonsterById(249),
        atkNature:{attack:1},atkIV:{attack:true},defNature:{hp:1,defense:2},defIV:{hp:true,defense:false},
        skillType:'attack',skillAttr:'光',basePower:187,fixedBonus:13,percentBonus:17,buff:20,comboCount:3});
      localStorage.setItem('rk_fav_pets','[249]'); localStorage.setItem('rk_chart_fav_pets','[249,602]');
      localStorage.setItem('rk_pet_configs','{}');
      document.documentElement.style.zoom = '1.5'; document.documentElement.style.setProperty('--page-zoom','1.5');
      window.dispatchEvent(new CustomEvent('appzoomchange'));
      return {state:JSON.stringify(s),a:localStorage.getItem('rk_fav_pets'),configs:localStorage.getItem('rk_pet_configs')};
    });
    await page.evaluate(async()=>{const original=window.UserConfig;window.UserConfig={...original,getObject:(k,f)=>k==='rk_chart_workspace'?window.__chartFavData:original.getObject(k,f),patch:async(k,v)=>{if(k!=='rk_chart_workspace')throw Error('unexpected write');window.__chartFavData=structuredClone(v);return true;}};(0,eval)(await(await fetch('js/chart-workspace.js')).text());});
    await go('chart');await ready(); await settle();
    if (await page.evaluate(() => ChartPage.getState().mode !== 'defense')) await page.locator('#chartModeBtn').click();
    if (!await page.evaluate(() => ChartPage.getState().markersVisible)) await page.locator('#chartFavoriteToggle').click();
    if (await page.locator('#chartDoubleLifeBtn').getAttribute('aria-pressed') !== 'true') await page.locator('#chartDoubleLifeBtn').click();await ready();
    check(await sizeCheck(), 'pre-existing zoom uses unscaled content dimensions');
    check(await page.locator('.chart-favorites-item').count() === 2, 'only two unique curve favorites are displayed');
    check(await page.locator('.chart-origin-dot').count() === 0, 'no source dots');
    check(await page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('defenseChart')), s = DamagePage.getState();
      const di = c.data.datasets.findIndex(d => d.favoriteMarker), ds = c.data.datasets[di];
      const i=ds.data.findIndex(m=>m.key==='chart:249'),m=ds.data[i],point=c.getDatasetMeta(di).data[i];
      const power=BattleMath.finalPower(s.basePower,s.fixedBonus,s.percentBonus,DamagePage.CalcEngine.isSameType(s.atkPet,s.skillAttr)?1.25:1,1,s.buff);
      const damage=Math.ceil(BattleMath.normalDamage(RKData.getPetStat(s.atkPet,'attack',0,true),power,m.defense,1,s.comboCount)*m.effect);
      return m.x===136&&m.hp===455&&m.y===455&&m.damage===damage&&c.scales.y.max>=455
        &&Math.abs(point.$favoriteAnchor.x-c.scales.x.getPixelForValue(136))<.1
        &&Math.abs(point.$favoriteAnchor.y-c.scales.y.getPixelForValue(455))<.1
        &&c.data.datasets.filter(d=>!d.favoriteMarker).every(d=>d.data.every(v=>typeof v==='number'));
    }), 'WAND-V appears once at exact defense/equivalent life; actual damage uses curve-owned IV/nature');
    await page.locator('#defenseChart').scrollIntoViewIfNeeded();
    for (const key of ['chart:249','chart:602']) {
      const p = await canvasPoint(key); await page.mouse.move(p.x,p.y); await settle();
      check(await page.evaluate(key => {
        const c = Chart.getChart(document.getElementById('defenseChart'));
        return c.tooltip.dataPoints?.some(p => p.raw.key === key);
      },key), `displaced ${key} avatar tooltip hit test uses displayed position`);
    }
    let p;
    await item('chart:249').click({button:'middle'});
    check(await item('chart:249').count()===1,'middle click does not cancel favorites');
    check(await page.locator('#chartCritBtn,#chartCritBtnDef').count() === 0 && await page.evaluate(() => !('typeEffect' in ChartPage.getState())), 'manual type controls and their state are removed');
    await page.locator('#chartFavoriteToggle').click();
    check(await page.evaluate(() => Chart.getChart(document.getElementById('defenseChart')).data.datasets.find(d => d.favoriteMarker).hidden), 'marker visibility toggle hides avatars and leaders');
    await page.locator('#chartFavoriteToggle').click();
    await page.locator('#chartModeBtn').click();
    if (await page.evaluate(() => ChartPage.getState().axisSwapped)) await page.locator('#chartSwapAxisBtn').click();
    const power = await page.evaluate(() => {
      const s = DamagePage.getState(), v = ChartPage.getState(), pet = RKData.getMonsterById(249);
      const defStat = v.attackType === 'attack' ? 'defense' : 'magic_defense';
      const hp = RKData.getPetStat(pet,'hp',1,true), def = RKData.getPetStat(pet,defStat,0,true);
      const effect = RKData.getTypeEff(s.skillAttr,pet.main_type.name,pet.sub_type?.name || '');
      for (let power=1;power<=600;power++) {
        const damage = x => BattleMath.normalDamage(BattleMath.statFromBase(x,v.attackType,0,true),BattleMath.finalPower(power,0,0,v.sameType?1.25:1),def)*effect;
        if (damage(80)<hp && damage(200)>=hp) return power;
      }
      throw Error('No visible attack threshold fixture');
    });
    await page.locator('#chartPowerInput').fill(String(power));
    const exactCheck = () => page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('defenseChart')), s = DamagePage.getState(), v = ChartPage.getState();
      const markers = c.data.datasets.find(d => d.favoriteMarker)?.data || [];
      return markers.length > 0 && markers.every(m => {
        const damage = x => BattleMath.normalDamage(BattleMath.statFromBase(v.axisSwapped?v.qualification:x,v.attackType,0,true),BattleMath.finalPower(v.axisSwapped?x:v.power,0,0,v.sameType?1.25:1),m.defense)*m.effect;
        return m.y === m.hp && damage(m.x) >= m.hp && (m.x === 0 || damage(m.x-1) < m.hp);
      });
    });
    check(await exactCheck(), 'attack mode exact integer qualification threshold');
    await page.locator('#chartSwapAxisBtn').click(); check(await exactCheck(), 'swapped mode exact integer power threshold');
    await page.locator('#chartSwapAxisBtn').click(); await page.locator('#chartPowerInput').fill('0');
    check(await item('chart:249').getAttribute('data-favorite-note').then(t => /无法击杀/.test(t)), 'zero power reports no kill, never clamps to fake coordinate');
    await page.locator('#chartModeBtn').click();
    await page.locator('#defenseChart').scrollIntoViewIfNeeded();
    p = await canvasPoint('chart:249'); await page.mouse.click(p.x,p.y,{button:'right'});
    await ready();
    check(await item('chart:249').count()===0,'right-click canvas cancels the clicked curve species');
    await item('chart:602').click({button:'right'});await ready();
    check(await item('chart:602').count()===0,'right-click list cancels only the clicked curve species');
    check(await page.evaluate(old => JSON.stringify(DamagePage.getState()) === old.state && localStorage.getItem('rk_fav_pets') === old.a && localStorage.getItem('rk_pet_configs') === old.configs,before), 'all controls/cancellations leave damage state, A and pet configs untouched');
    await page.evaluate(() => {
      document.documentElement.style.zoom='1.8'; document.documentElement.style.setProperty('--page-zoom','1.8');
      window.dispatchEvent(new CustomEvent('appzoomchange')); window.dispatchEvent(new Event('resize'));
    });
    await settle(); check(await sizeCheck(), 'zoom and resize recompute content size');
    await page.evaluate(async()=>{await ChartWorkspace.addPet(249);});
    check(await page.locator('.chart-favorites-item').count()===1,'workspace notification renders only own favorite');
    await go('damage');
    check(await page.evaluate(() => !Object.values(Chart.instances).some(c => c.canvas?.id === 'defenseChart')), 'leaving destroys chart instance');
    await page.evaluate(() => { FavoritePets.notify(); window.dispatchEvent(new CustomEvent('appzoomchange')); });
    await go('chart'); await settle(); check(await sizeCheck(), 're-entry retains correct sizing after cleanup');
    check(errors.length === 0, `no runtime errors: ${errors.join('; ')}`);
    return {passed:checks.length,checks};
  } finally {
    if (saved) await page.evaluate(old => {
      ChartPage.onLeave();window.ChartWorkspace?.dispose();window.ChartWorkspace=window.__chartFavOriginal.store;window.UserConfig=window.__chartFavOriginal.user;
      for (const [key,value] of Object.entries(old.storage)) {
        if (value === null) localStorage.removeItem(key); else localStorage.setItem(key,value);
      }
      Object.assign(DamagePage.getState(),old.state);
      document.documentElement.style.zoom=old.zoom; document.documentElement.style.setProperty('--page-zoom',old.pageZoom);
      FavoritePets.notify(); window.dispatchEvent(new CustomEvent('appzoomchange'));
    },saved);
    page.off('pageerror',onError);
  }
}
