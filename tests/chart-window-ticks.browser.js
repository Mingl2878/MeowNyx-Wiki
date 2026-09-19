// Parent: playwright-cli run-code --filename=tests/chart-window-ticks.browser.js
// ISOLATED browser + read-only/temporary-config fixture only. Never attach a personal
// browser or launch native. This mocks /api/window/state (not AppPreferences) so the
// production resize/fetch/event path is exercised. No persisted settings are needed.
async page => {
  const checks = [], errors = [], writes = [];
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const onError = e => errors.push(e.message);
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  let nativeMaximized = false, holdNext = null, saved;
  const initialViewport = page.viewportSize();
  const apiRoute = async route => {
    const request = route.request();
    if (request.url().split('?')[0].endsWith('/api/window/state')) {
      const value = nativeMaximized, hold = holdNext;
      holdNext = null;
      if (hold) { hold.started(); await hold.promise; }
      return route.fulfill({ json: { maximized: value } });
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push({ url: request.url(), method: request.method() });
      return route.fulfill({ status: 405, json: { ok: false, error: 'read-only chart test' } });
    }
    return route.fallback();
  };
  const setNative = async maximized => {
    nativeMaximized = maximized;
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForFunction(max => AppPreferences.getWindowState().initialized && AppPreferences.isMaximized() === max, maximized);
    await settle();
  };
  const go = async route => {
    await page.evaluate(r => { location.hash = '/' + r; }, route);
    await page.waitForSelector(route === 'chart' ? '#defenseChart' : '#basePower', { state: 'attached' });
    await settle();
  };
  const snapshot = () => page.evaluate(() => {
    const c = Chart.getChart(document.getElementById('defenseChart'));
    const graph = document.querySelector('.chart-container'), g = graph.getBoundingClientRect();
    const toolbar = document.querySelector('.chart-favorites-toolbar').getBoundingClientRect();
    const grid = document.getElementById('chartFavoriteGrid'), f = grid.getBoundingClientRect();
    return { height: graph.clientHeight, max: AppPreferences.isMaximized(), step: c.options.scales.y.ticks.stepSize,
      ticks: c.scales.y.ticks.map(t => t.value), yMax: c.scales.y.max,
      visible: toolbar.bottom <= innerHeight + 1 && f.bottom <= innerHeight + 1 && f.height >= 50,
      fillGap: toolbar.top - g.bottom, footerBottom: f.bottom, viewport: innerHeight,
      correctSize: c.width === graph.clientWidth && c.height === graph.clientHeight,
      data: JSON.stringify(c.data.datasets.map(d => ({ key: d.viewKey, data: d.favoriteMarker ? d.data.map(m => ({ key: m.key, x: m.x, y: m.y, hp: m.hp, damage: m.damage, defense: m.defense })) : d.data }))),
      hidden: JSON.stringify(c.data.datasets.map((d, i) => [d.viewKey, !c.isDatasetVisible(i)])),
      labels: c.data.datasets.filter(d => !d.favoriteMarker && !d.reference).map(d => d.label)
    };
  });
  const checkGrid = (s, label) => {
    check([10, 20, 25, 50].includes(s.step) && s.ticks.length <= 501 && s.ticks.length === s.yMax / s.step + 1
      && s.ticks.every((t, i) => !i || t - s.ticks[i - 1] === s.step), label + ': every actual grid tick uses a permitted step (not autoskipped labels)');
  };
  await page.route('**/api/**', apiRoute);
  page.on('pageerror', onError);
  try {
    await go('damage');
    saved = await page.evaluate(() => {
      window.__chartSizingConfig = window.UserConfig; window.__chartSizingOldStore = window.ChartWorkspace; window.__chartSizingWorkspaceData = {};
      return { storage: { ...localStorage }, state: JSON.parse(JSON.stringify(DamagePage.getState())),
        theme: document.documentElement.getAttribute('data-theme'), maxZoom: AppPreferences.getMaxZoom() };
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await setNative(false);
    await page.evaluate(() => {
      Object.assign(DamagePage.getState(), { atkPet: RKData.getMonsterById(202), defPet: RKData.getMonsterById(327),
        atkIV: {}, atkNature: {}, defIV: {}, defNature: {}, skillType: 'attack', skillAttr: '水',
        basePower: 450, fixedBonus: 0, percentBonus: 0, buff: 0, comboCount: 1 });
      AppPreferences.setMaxZoom(1, false);
      window.UserConfig = { ...window.__chartSizingConfig, getObject: (key, fallback) => key === 'rk_chart_workspace' ? window.__chartSizingWorkspaceData : window.__chartSizingConfig.getObject(key, fallback), patch: async (key, fields) => { if (key !== 'rk_chart_workspace') throw Error('unexpected curve write'); window.__chartSizingWorkspaceData = structuredClone(fields); return true; } };
      localStorage.setItem('rk_fav_pets', '[327,249]'); localStorage.setItem('rk_chart_fav_pets', '[327,249]');
    });
    await page.evaluate(async () => { (0,eval)(await (await fetch('js/chart-workspace.js')).text()); });
    await go('chart');
    await page.waitForFunction(() => !document.getElementById('chartAtkIVBtn').disabled);
    if (await page.evaluate(() => ChartPage.getState().mode !== 'defense')) await page.locator('#chartModeBtn').click();
    if (!await page.evaluate(() => ChartPage.getState().markersVisible)) await page.locator('#chartFavoriteToggle').click();
    await settle();
    check(await page.evaluate(() => !document.getElementById('chartInfo').textContent.includes('头像等效生命仅换算属性')
      && /最终威力：562/.test(document.getElementById('chartInfo').textContent)), 'Water / final-power562 header has no removed trailing sentence');
    check(await page.locator('[data-favorite-key="chart:327"]').getAttribute('title').then(t => /等效生命/.test(t) && /HP：/.test(t) && !/伤害收藏/.test(t) && /逐步取整/.test(t)), 'precise HP/equivalent notes remain with curve-only configuration');
    await page.locator('#chartAtkIVBtn').click(); await page.waitForFunction(() => !document.getElementById('chartAtkIVBtn').disabled);
    await page.locator('#chartAtkNatureBtn').click({ button: 'right' }); await page.waitForFunction(() => !document.getElementById('chartAtkNatureBtn').disabled);
    await page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('defenseChart'));
      c.options.plugins.legend.onClick(null, { datasetIndex: 1 }, { chart: c });
      window.__chartSizingStorageWrites = [];
      window.__chartSizingSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { window.__chartSizingStorageWrites.push(key); return window.__chartSizingSetItem.call(this, key, value); };
    });
    const initialWrites = writes.length, base = await snapshot();
    check(base.height <= 520 && base.visible && base.correctSize, 'native-windowed initial cap and favorites reserved');
    checkGrid(base, 'windowed Water562');
    check(base.labels.every(t => /^攻：[✓×]个体&(?:[✓×]性格|负性格) \/ 防：[✓×]个体&(?:[✓×]性格|负性格)$/.test(t) && !t.includes('√'))
      && base.labels.some(t => t.includes('负性格')), 'compact legends use one slash; absence/negative are distinct');

    // Trigger resize BEFORE its native fetch resolves, without changing viewport.
    let release, started;
    const requestStarted = new Promise(r => { started = r; });
    holdNext = { promise: new Promise(r => { release = r; }), started };
    nativeMaximized = true;
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await requestStarted; await settle();
    check((await snapshot()).height === base.height && !(await snapshot()).max, 'early resize cannot infer maximized from viewport');
    release();
    await page.waitForFunction(() => AppPreferences.isMaximized()); await settle();
    const maximized = await snapshot();
    check(maximized.height > 520 && maximized.visible && maximized.correctSize, 'same viewport: delayed native maximize lifts cap and reserves favorite toolbar/row');
    check(maximized.data === base.data && maximized.hidden === base.hidden, 'native maximize preserves numeric data, viewKeys and hidden comparisons');
    checkGrid(maximized, 'same-viewport maximized');

    await page.setViewportSize({ width: 1440, height: 1800 }); await settle();
    const tall = await snapshot();
    check(tall.height > maximized.height + 500 && tall.visible && tall.viewport - tall.footerBottom < 150, 'tall native-maximized plot fills remaining area without displacing favorites');
    check(tall.step < base.step, 'taller maximized plot chooses more detailed permitted spacing');
    checkGrid(tall, 'tall maximized');
    await setNative(false);
    const tallWindowed = await snapshot();
    check(tallWindowed.height <= 520 && tallWindowed.visible, 'same tall viewport restored native-windowed re-applies cap');
    check(tallWindowed.data === base.data && tallWindowed.hidden === base.hidden, 'restoring window preserves data and comparison visibility');
    await setNative(true);

    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.setAttribute('data-theme', theme); window.dispatchEvent(new CustomEvent('appthemechange')); }, theme);
      await settle();
      const s = await snapshot();
      check(s.data === base.data && s.hidden === base.hidden && JSON.stringify(s.labels) === JSON.stringify(base.labels), theme + ': stable keys/hidden/data/labels');
    }
    for (const zoom of [0.75, 1.5, 2]) {
      await page.evaluate(zoom => AppPreferences.setMaxZoom(zoom, false), zoom); await settle();
      const s = await snapshot();
      check(s.correctSize && s.data === base.data && s.hidden === base.hidden, zoom + ' CSS zoom: layout-pixel canvas, unchanged numerical data/hidden');
      await page.locator('#chartFavoriteToggle').scrollIntoViewIfNeeded();
      check(await page.locator('#chartFavoriteToggle').isVisible(), zoom + ' zoom: favorites remain reachable');
      await page.locator('#defenseChart').scrollIntoViewIfNeeded();
      const point = await page.evaluate(() => {
        const c = Chart.getChart(document.getElementById('defenseChart')), di = c.data.datasets.findIndex(d => d.favoriteMarker);
        const index = c.data.datasets[di].data.findIndex(m => m.key === 'chart:327'), p = c.getDatasetMeta(di).data[index], r = c.canvas.getBoundingClientRect();
        return { x: r.left + p.x * r.width / c.width, y: r.top + p.y * r.height / c.height };
      });
      await page.mouse.move(point.x, point.y); await settle();
      check(await page.evaluate(() => Chart.getChart(document.getElementById('defenseChart')).tooltip.dataPoints?.some(p => p.raw.key === 'chart:327')), zoom + ' zoom: avatar hover uses unchanged hit-testing coordinates');
    }
    await page.evaluate(() => AppPreferences.setMaxZoom(1, false)); await settle();
    await page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('defenseChart')), original = c.resize;
      window.__chartSizingResizeCount = 0;
      c.resize = function(...args) { window.__chartSizingResizeCount++; return original.apply(this, args); };
      for (let i = 0; i < 30; i++) window.dispatchEvent(new Event('resize'));
    });
    await settle(); await page.waitForTimeout(150); await settle();
    check(await page.evaluate(() => window.__chartSizingResizeCount <= 4), 'resize burst coalesces, with no unbounded canvas/flex/observer growth');
    check(writes.length === initialWrites && await page.evaluate(() => window.__chartSizingStorageWrites.length === 0), 'resize/native/theme/zoom previews perform no profile or local-storage writes');

    await page.locator('#chartModeBtn').click(); await page.locator('#chartModeBtn').click(); await settle();
    check((await snapshot()).hidden === base.hidden, 'switching modes and back preserves hidden comparison keys');
    await page.evaluate(async () => { for (const pet of RKData.getMonsters().slice(0,160)) await ChartWorkspace.addPet(pet.id); });
    await settle();
    check(await page.evaluate(() => {
      const grid = document.getElementById('chartFavoriteGrid'), row = grid.getBoundingClientRect();
      const toolbar = document.querySelector('.chart-favorites-toolbar').getBoundingClientRect();
      return AppPreferences.isMaximized() && grid.scrollHeight > grid.clientHeight && grid.clientHeight >= 60
        && row.bottom <= innerHeight + 1 && toolbar.bottom <= innerHeight + 1 && getComputedStyle(grid).overflowY === 'auto';
    }), 'maximized many favorites keep toolbar/rows onscreen and scroll only the bounded grid');
    for (const target of [40, 95]) {
      await page.evaluate(async target => {
        for (const entry of ChartWorkspace.getEntries()) await ChartWorkspace.removePet(entry.id);
        await ChartWorkspace.setControls({atkIV:{attack:false},atkNature:{attack:0},defIV:{defense:true}});
        const s = DamagePage.getState(); s.atkIV = { attack: false }; s.atkNature = { attack: 0 }; s.defNature = {};
        // Calibrate via actual unchanged math, not a hand-picked stat approximation.
        s.basePower = 1; window.dispatchEvent(new Event('appthemechange'));
        for (let power = 1; power <= 1000; power++) {
          const final = BattleMath.finalPower(power, 0, 0, 1.25);
          const maximum = Math.ceil(BattleMath.normalDamage(RKData.getPetStat(s.atkPet, 'attack', 0, false), final, BattleMath.statFromBase(80, 'defense', 0, true)));
          if (maximum > target) break;
          s.basePower = power;
        }
        window.dispatchEvent(new Event('appthemechange'));
      }, target);
      await settle();
      const s = await snapshot();
      check([10, 20].includes(s.step) && s.yMax <= 120, target + ' small range uses 10/20'); checkGrid(s, target + ' range');
    }
    await page.evaluate(() => { DamagePage.getState().basePower = 1e100; window.dispatchEvent(new Event('appthemechange')); }); await settle();
    check(await page.evaluate(() => !Chart.getChart(document.getElementById('defenseChart'))
      && !document.getElementById('chartAxisWarning').hidden && /501.*含0.*50/.test(document.getElementById('chartAxisWarning').textContent)
      && DamagePage.getState().basePower === 1e100), 'extreme input: explicit <=501-tick guard stops allocation without clamping the input');
    await page.evaluate(() => { DamagePage.getState().basePower = 450; window.dispatchEvent(new Event('appthemechange')); }); await settle();
    check(await page.evaluate(() => !!Chart.getChart(document.getElementById('defenseChart')) && document.getElementById('chartAxisWarning').hidden), 'safe input recovers after guard');
    check(errors.length === 0, 'no runtime errors: ' + errors.join('; '));
    return { passed: checks.length, checks };
  } finally {
    page.off('pageerror', onError);
    if (saved) await page.evaluate(old => {
      if (window.__chartSizingSetItem) Storage.prototype.setItem = window.__chartSizingSetItem;
      ChartPage.onLeave(); window.ChartWorkspace?.dispose(); window.ChartWorkspace = window.__chartSizingOldStore; window.UserConfig = window.__chartSizingConfig;
      localStorage.clear(); for (const [key, value] of Object.entries(old.storage)) localStorage.setItem(key, value);
      Object.assign(DamagePage.getState(), old.state);
      AppPreferences.setMaxZoom(old.maxZoom, false);
      if (old.theme == null) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', old.theme);
      for (const key of ['__chartSizingSetItem', '__chartSizingStorageWrites', '__chartSizingConfig', '__chartSizingResizeCount']) delete window[key];
    }, saved);
    await page.unroute('**/api/**', apiRoute);
    if (initialViewport) await page.setViewportSize(initialViewport);
    await page.reload();
  }
}
