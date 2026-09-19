// Targeted suite; run with playwright-cli run-code on an ISOLATED profile + read-only
// or temporary-config server. No personal profile/AppData. Parent owns broad suites.
async page => {
  const checks = [], errors = [];
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const onError = e => errors.push(e.message);
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const go = async route => {
    await page.evaluate(r => { location.hash = '/' + r; }, route);
    await page.waitForSelector(route === 'chart' ? '#defenseChart' : '#basePower', { state: 'attached' });
    await settle();
  };
  const item = key => page.locator(`[data-favorite-key="${key}"]`);
  const ordinary = () => page.evaluate(() => JSON.stringify(Chart.getChart(document.getElementById('defenseChart')).data.datasets.filter(d => !d.favoriteMarker && !d.reference).map(d => d.data)));
  const point = key => page.evaluate(key => {
    const canvas = document.getElementById('defenseChart'), c = Chart.getChart(canvas);
    const di = c.data.datasets.findIndex(d => d.favoriteMarker), ds = c.data.datasets[di];
    const p = c.getDatasetMeta(di).data[ds.data.findIndex(m => m.key === key)], rect = canvas.getBoundingClientRect();
    return { x: rect.left + p.x * rect.width / c.width, y: rect.top + p.y * rect.height / c.height };
  }, key);
  const ready=()=>page.waitForFunction(()=>!document.getElementById('chartAtkIVBtn').disabled);
  let saved;
  const windowStateRoute = route => route.fulfill({ json: { maximized: false } });
  await page.route('**/api/window/state', windowStateRoute);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForFunction(() => AppPreferences.getWindowState().initialized && !AppPreferences.isMaximized());
  page.on('pageerror', onError);
  try {
    await go('damage');
    saved = await page.evaluate(() => {
      window.__chartTestUserConfig = window.UserConfig;window.__chartTestStore=window.ChartWorkspace;window.__chartEquivalentData={};
      return { storage: { ...localStorage }, state: JSON.parse(JSON.stringify(DamagePage.getState())), zoom: document.documentElement.style.zoom,
        pageZoom: document.documentElement.style.getPropertyValue('--page-zoom') };
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      const s = DamagePage.getState();
      Object.assign(s, { atkPet: RKData.getMonsterById(202), defPet: RKData.getMonsterById(327), atkIV: {}, atkNature: {}, defIV: {}, defNature: {},
        skillType: 'attack', skillAttr: '水', basePower: 400, fixedBonus: 0, percentBonus: 0, buff: 0, comboCount: 1 });
      // In-memory fixture only, including shared config reads; no server writes.
      window.UserConfig = { ...window.__chartTestUserConfig,getObject:(k,f)=>k==='rk_chart_workspace'?window.__chartEquivalentData:window.__chartTestUserConfig.getObject(k,f),patch:async(k,v)=>{if(k!=='rk_chart_workspace')throw Error('unexpected write');window.__chartEquivalentData=structuredClone(v);return true;} };
      localStorage.setItem('rk_fav_pets', '[327,249]'); localStorage.setItem('rk_chart_fav_pets', '[327,249]');
      document.documentElement.style.zoom = '1'; document.documentElement.style.setProperty('--page-zoom', '1');
    });
    await page.evaluate(async()=>{(0,eval)(await(await fetch('js/chart-workspace.js')).text());});
    await go('chart');await ready();
    if (await page.evaluate(() => ChartPage.getState().mode !== 'defense')) await page.locator('#chartModeBtn').click();
    if (!await page.evaluate(() => ChartPage.getState().markersVisible)) await page.locator('#chartFavoriteToggle').click();
    check(await page.locator('#chartCritBtn,#chartCritBtnDef').count() === 0, 'manual type controls absent');
    check(await page.evaluate(() => !('typeEffect' in ChartPage.getState()) && !/克制\/抵抗/.test(document.getElementById('chartInfo').textContent)), 'no hidden manual factor or header multiplier');
    check(await page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('defenseChart')), m = c.data.datasets.find(d => d.favoriteMarker).data.find(m => m.key === 'chart:327');
      return m.pet.base_hp === 112 && m.pet.base_phy_atk === 91 && m.pet.base_mag_atk === 190 && m.effect === 0.5 && m.x === 69 && c.scales.x.min <= 69
        && m.y === m.hp * 2 - 1 && m.damage < m.hp && m.y > m.referenceDamage && !m.defenseMismatch
        && c.options.scales.y.title.text.includes('等效生命');
    }), 'real Water202 / Dragon327: actual resistance, raw x69, surviving equivalent life above neutral reference');
    check(await item('chart:327').getAttribute('title').then(t => !/伤害收藏/.test(t) && /逐步取整/.test(t) && /剩余HP/.test(t)), 'curve-only tooltip retains exact-rounding precision and HP information');
    check(await page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('defenseChart')), m = c.data.datasets.find(d => d.favoriteMarker).data.find(m => m.key === 'chart:249');
      const p = RKData.getMonsterById(249);
      return m.hp === RKData.getPetStat(p, 'hp', 0, false);
    }), 'all curve favorites use independent shared curve defaults');
    await page.evaluate(() => { DamagePage.getState().skillAttr = '光'; window.dispatchEvent(new Event('appthemechange')); });
    const baseline = await ordinary();
    await page.locator('#chartDoubleLifeBtn').click();await ready();
    check(await page.evaluate(() => {
      const m = Chart.getChart(document.getElementById('defenseChart')).data.datasets.find(d => d.favoriteMarker).data.find(m => m.key === 'chart:249');
      return m.hp === 455 && m.effect === 1 && m.y === 455 && m.x === 136;
    }), 'neutral B249 double life stays exactly HP455 / y455 / raw x136');
    check(await ordinary() === baseline, 'equivalent-life and double-life display do not alter shared reference curves');
    await page.locator('#chartFavoriteToggle').click();
    check(await page.evaluate(() => {
      const b = document.getElementById('chartFavoriteToggle'), c = Chart.getChart(document.getElementById('defenseChart'));
      return b.textContent.trim() === '' && !!b.querySelector('svg') && b.title === b.getAttribute('aria-label') && b.title.includes('显示')
        && c.data.datasets.find(d => d.favoriteMarker).hidden && document.querySelectorAll('.chart-favorites-item').length === 2;
    }), 'eye-off SVG changes accessible label, hides only plot avatars, retains favorite list');
    await page.locator('#chartFavoriteToggle').click();
    for (const target of [100, 600]) {
      await page.evaluate(async target => {
        const s = DamagePage.getState(), attack = RKData.getPetStat(s.atkPet, 'attack', 0, true);
        for(const entry of ChartWorkspace.getEntries())await ChartWorkspace.removePet(entry.id);
        s.basePower = Math.round(target * BattleMath.statFromBase(80, 'defense', 0, true) / (attack * BattleMath.DAMAGE_FACTOR));
        window.dispatchEvent(new Event('appthemechange'));
      }, target);
      await settle();
      check(await page.evaluate(target => {
        const c = Chart.getChart(document.getElementById('defenseChart')), step = c.options.scales.y.ticks.stepSize;
        return (target === 100 ? [10, 20].includes(step) : [10, 20, 25, 50].includes(step))
          && c.scales.y.ticks.length <= 501 && c.scales.y.max >= Math.max(...c.data.datasets[0].data)
          && c.scales.y.ticks.every((t, i, all) => !i || t.value - all[i - 1].value === step);
      }, target), `rendered ${target}-range ticks use adaptive nice spacing, not fixed 50`);
    }
    await page.evaluate(async () => {DamagePage.getState().basePower=400;await ChartWorkspace.addPet(327);await ChartWorkspace.addPet(249);});
    const samples = [];
    for (const height of [760, 1000, 1800]) {
      await page.setViewportSize({ width: 1440, height }); await settle();
      const geometry = await page.evaluate(() => {
        const graph = document.querySelector('.chart-container'), grid = document.getElementById('chartFavoriteGrid'), toolbar = document.querySelector('.chart-favorites-toolbar');
        const c = Chart.getChart(document.getElementById('defenseChart')), b = graph.getBoundingClientRect();
        const search = document.getElementById('chartFavoriteSearch').getBoundingClientRect(), eye = document.getElementById('chartFavoriteToggle').getBoundingClientRect(), t = toolbar.getBoundingClientRect();
        const avatars = [...grid.children].map(n => n.getBoundingClientRect()), g = grid.getBoundingClientRect();
        return { height: graph.clientHeight, visible: t.bottom <= innerHeight && avatars.every(r => r.bottom <= innerHeight),
          toolbarCentered: Math.abs((search.left + eye.right) / 2 - (t.left + t.right) / 2) < 2,
          rowCentered: Math.abs((avatars[0].left + avatars.at(-1).right) / 2 - (g.left + g.right) / 2) < 2,
          correctSize: Math.abs(c.width - graph.clientWidth) <= 1 && Math.abs(c.height - graph.clientHeight) <= 1,
          ticks: c.scales.y.ticks.map(t => t.value), maxData: Math.max(...c.data.datasets.flatMap(d => d.favoriteMarker ? d.data.map(m => m.y) : d.data)), max: c.scales.y.max,
          top: b.top, bottom: b.bottom };
      });
      samples.push(geometry);
      check(geometry.height >= 180 && geometry.height <= 520 && geometry.visible && geometry.correctSize, `${height}px viewport: bounded graph and favorite toolbar/row visible`);
      check(geometry.toolbarCentered && geometry.rowCentered, `${height}px viewport: toolbar and avatar row centered`);
      check(geometry.ticks.length <= 501 && geometry.max > geometry.maxData, `${height}px viewport: bounded ticks and unclipped numeric data`);
    }
    check(samples[2].height === 520, 'very tall but native-windowed viewport keeps the 520 layout-pixel cap');
    await page.evaluate(async()=>{for(const p of RKData.getMonsters().slice(0,160))await ChartWorkspace.addPet(p.id);});
    await page.setViewportSize({ width: 1100, height: 900 }); await settle();
    check(await page.evaluate(() => {
      const g = document.getElementById('chartFavoriteGrid'), r = g.getBoundingClientRect();
      return g.scrollHeight > g.clientHeight && getComputedStyle(g).overflowY === 'auto' && g.clientHeight >= 60 && r.bottom <= innerHeight;
    }), 'many favorites scroll internally while a row remains visible');
    await page.evaluate(async()=>{for(const e of ChartWorkspace.getEntries())await ChartWorkspace.removePet(e.id);await ChartWorkspace.addPet(327);await ChartWorkspace.addPet(249);});
    for (const zoom of [1, 1.5, 2]) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(z => {
        document.documentElement.style.zoom = String(z); document.documentElement.style.setProperty('--page-zoom', String(z));
        window.dispatchEvent(new CustomEvent('appzoomchange'));
      }, zoom);
      await settle(); await page.locator('#defenseChart').scrollIntoViewIfNeeded();
      for (const key of ['chart:249', 'chart:327']) {
        const p = await point(key); await page.mouse.move(p.x, p.y); await settle();
        check(await page.evaluate(key => Chart.getChart(document.getElementById('defenseChart')).tooltip.dataPoints?.some(p => p.raw.key === key), key), `${zoom} zoom ${key}: displaced-avatar hover hits correctly`);
      }
      check(await item('chart:327').count()===1, `${zoom} zoom: only one target avatar`);
    }
    let p = await point('chart:327'); await page.mouse.click(p.x, p.y, { button: 'middle' });
    check(await item('chart:327').count() === 1, 'middle click does not remove B');
    p = await point('chart:327'); await page.mouse.click(p.x, p.y, { button: 'right' });
    await ready();check(await item('chart:327').count()===0&&await item('chart:249').count()===1,'zoom-correct right click removes only clicked curve species');
    await page.setViewportSize({ width: 1000, height: 480 }); await settle();
    await page.locator('#chartFavoriteToggle').scrollIntoViewIfNeeded();
    check(await page.evaluate(() => {
      const page = document.querySelector('.chart-page'), g = document.querySelector('.chart-container');
      return page.scrollHeight > page.clientHeight && g.clientHeight >= 180 && page.scrollWidth <= page.clientWidth + 1;
    }), 'short zoomed window scroll fallback preserves a usable plot without horizontal overflow');
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1'; document.documentElement.style.setProperty('--page-zoom', '1');
      window.dispatchEvent(new CustomEvent('appzoomchange'));
    });
    await page.setViewportSize({ width: 1440, height: 1000 }); await settle();
    await page.evaluate(() => { DamagePage.getState().skillAttr = '水'; window.dispatchEvent(new Event('appthemechange')); });
    await page.locator('#chartModeBtn').click();
    check(await page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('defenseChart')), s = DamagePage.getState(), v = ChartPage.getState();
      const first = c.data.labels[0], effect = RKData.getTypeEff(s.skillAttr, s.defPet.main_type.name, s.defPet.sub_type?.name || '');
      return c.data.datasets[0].data[0] === BattleMath.normalDamage(BattleMath.statFromBase(v.axisSwapped ? v.qualification : first, v.attackType, 0, true),
        BattleMath.finalPower(v.axisSwapped ? first : v.power, 0, 0, v.sameType ? 1.25 : 1), RKData.getPetStat(s.defPet, 'defense', 0, true)) * effect;
    }), 'attack baseline automatically uses selected Dragon target resistance, with original rounding');
    // With independent attack IV enabled, 600 already kills this target below
    // x=80 (correctly omitted from visible markers). Use an in-range test case.
    await page.locator('#chartPowerInput').fill('200');
    for (const swap of [false, true]) {
      if (swap) await page.locator('#chartSwapAxisBtn').click();
      check(await page.evaluate(() => {
        const c = Chart.getChart(document.getElementById('defenseChart')), v = ChartPage.getState();
        const markers = c.data.datasets.find(d => d.favoriteMarker)?.data || [];
        return markers.length > 0 && markers.every(m => {
          const damage = x => BattleMath.normalDamage(BattleMath.statFromBase(v.axisSwapped ? v.qualification : x, v.attackType, 0, true),
            BattleMath.finalPower(v.axisSwapped ? x : v.power, 0, 0, v.sameType ? 1.25 : 1), m.defense) * m.effect;
          return m.y === m.hp && damage(m.x) >= m.hp && (m.x === 0 || damage(m.x - 1) < m.hp);
        });
      }), `attack ${swap ? 'power' : 'qualification'} markers retain exact integer minima`);
    }
    check(errors.length === 0, `no runtime errors: ${errors.join('; ')}`);
    return { passed: checks.length, checks };
  } finally {
    page.off('pageerror', onError);
    if (saved) await page.evaluate(old => {
      ChartPage.onLeave();window.ChartWorkspace?.dispose();window.ChartWorkspace=window.__chartTestStore;window.UserConfig = window.__chartTestUserConfig; delete window.__chartTestUserConfig;
      localStorage.clear(); for (const [key, value] of Object.entries(old.storage)) localStorage.setItem(key, value);
      Object.assign(DamagePage.getState(), old.state);
      document.documentElement.style.zoom = old.zoom; document.documentElement.style.setProperty('--page-zoom', old.pageZoom);
    }, saved);
    await page.unroute('**/api/window/state', windowStateRoute);
    await page.reload();
  }
}
