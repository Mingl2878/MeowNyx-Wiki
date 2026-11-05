// Parent-run only; no browser launch. All writes remain in the explicit isolated fixture/in-memory adapter.
async page => {
  const fixture = await page.evaluate(() => window.__damageFixture);
  if (!fixture?.reset_url || !fixture.origins?.length) throw Error('Explicit isolated fixture required');
  for (const origin of fixture.origins) {
    const r = await page.request.get(origin + '/__fixture/info');
    if (!r.ok() || (await r.json()).isolated !== true) throw Error('Refusing real profile');
  }
  const checks = [], errors = [], check = (value, label) => { if (!value) throw Error(label); checks.push(label); };
  const onError = e => errors.push(e.message); page.on('pageerror', onError);
  const ready = () => page.waitForFunction(() => ChartWorkspace.getStatus().initialized && !document.getElementById('chartAtkIVBtn')?.disabled);
  const click = async id => { await page.locator('#' + id).click(); await ready(); };
  const rebuild = async () => { await page.evaluate(() => { window.dispatchEvent(new Event('appthemechange')); }); await ready(); };
  const rows = () => page.evaluate(() => { const c = Chart.getChart(document.getElementById('defenseChart')); return c.data.datasets.filter(d => d.damageConfig).map(d => ({ cfg: d.damageConfig, hidden: d.hidden, key: d.viewKey })); });
  let saved = false;
  try {
    await page.goto(fixture.origins[0] + '/#/damage'); await page.waitForFunction(() => RKData.isLoaded && UserConfig.getStatus().ready);
    await page.evaluate(async () => {
      await UserConfig.flush(); ChartPage.onLeave();
      window.__twelveView = { user: window.UserConfig, store: window.ChartWorkspace, storage: { ...localStorage }, damage: { ...DamagePage.getState() }, monsters: RKData.getMonsters, byId: RKData.getMonsterById };
      const f = window.__twelveView; f.writes = 0; f.saved = { state: ChartWorkspace.defaults() }; f.saved.state.groups[0].petIds = [249, 327];
      window.UserConfig = { ...f.user, getObject: (key, fallback) => key === 'rk_chart_workspace' ? structuredClone(f.saved) : f.user.getObject(key, fallback), patch: async (key, value) => { if (key !== 'rk_chart_workspace') throw Error('Unexpected write'); f.writes++; f.saved = structuredClone(value); return true; } };
      (0, eval)(await (await fetch('js/chart-workspace.js')).text());
      Object.assign(DamagePage.getState(), { atkPet: RKData.getMonsterById(202), defPet: RKData.getMonsterById(249), skillType: 'attack', skillAttr: 'Water', basePower: 430, fixedBonus: 0, percentBonus: 0, buff: 0, comboCount: 1 });
      location.hash = '/chart';
    }); saved = true; await ready();
    if (await page.evaluate(() => ChartPage.getState().mode !== 'defense')) await click('chartModeBtn');
    await click('chartAtkIVBtn'); await click('chartAtkNatureBtn');
    check(await page.evaluate(() => ChartWorkspace.getState().controls.atkIV.attack && ChartWorkspace.getState().controls.atkNature.attack === 1), 'nature-on automatically enables IV');
    await click('chartAtkIVBtn');
    check(await page.evaluate(() => ChartWorkspace.getState().controls.atkNature.attack === 0), 'IV-off clears nature');
    await page.locator('#chartAtkNatureBtn').click({ button: 'right' });
    check(await page.locator('#chartAtkNatureBtn').getAttribute('data-nature') === '0', 'right click has no negative nature path');
    await click('chartAtkNatureBtn'); await click('chartIVBtn'); await click('chartDoubleLifeBtn');
    let r = await rows(); check(r.length === 1 && !r[0].hidden && r[0].cfg.hpNature, 'all-on still defaults to a single selected curve');
    await click('chartAllBtn');
    r = await rows(); check(r.length === 12 && r.filter(d => !d.hidden).length === 1 && !r[11].hidden, 'explicit ALL: twelve actual datasets, only selected visible');
    check(new Set(r.map(d => JSON.stringify(d.cfg))).size === 12, 'twelve unique legal configurations');
    const inspect = () => page.evaluate(() => {
      const c = Chart.getChart(document.getElementById('defenseChart')), s = DamagePage.getState(), v = ChartPage.getState();
      const visible = c.data.datasets.filter((d, i) => d.damageConfig && c.isDatasetVisible(i));
      for (const node of document.querySelectorAll('#chartFavoriteGrid [data-chart-favorite]')) {
        const pet = RKData.getMonsterById(Number(node.dataset.chartFavorite));
        const lines = node.title.split('\n');
        if (lines[0] !== RKData.getMonsterDisplayName(pet)) throw Error('Missing tooltip name');
        if (lines.length !== (visible.length === 1 ? 7 : visible.length + 1)) throw Error('Tooltip line count');
        if (visible.length === 1) {
          const cfg = visible[0].damageConfig, hp = RKData.getPetStat(pet, 'hp', cfg.hpNature ? 1 : 0, true);
          const atk = v.mode === 'defense' ? s.skillType : v.attackType, def = atk === 'attack' ? 'defense' : 'magic_defense';
          const attack = v.mode === 'defense' ? RKData.getPetStat(s.atkPet, atk, cfg.atkNature, cfg.atkIV) : BattleMath.statFromBase(v.qualification, atk, cfg.atkNature, cfg.atkIV, RKData.getPetLevel(s.atkPet));
          const power = v.mode === 'defense' ? BattleMath.finalPower(s.basePower, s.fixedBonus, s.percentBonus, DamagePage.CalcEngine.isSameType(s.atkPet, s.skillAttr) ? 1.25 : 1, 1, s.buff) : BattleMath.finalPower(v.power, 0, 0, v.sameType ? 1.25 : 1);
          const damage = BattleMath.normalDamage(attack, power, RKData.getPetStat(pet, def, 0, cfg.defIV), 1, v.mode === 'defense' ? s.comboCount : 1, RKData.getPetLevel(s.atkPet), RKData.getTypeEff(s.skillAttr, pet.main_type?.name || '', pet.sub_type?.name || ''));
          if (node.dataset.survival !== (damage >= hp ? 'kill' : 'survive') || !lines[6].includes(`÷ ${hp} (`) || !lines[6].includes((damage / hp * 100).toFixed(2) + '%')) throw Error('Per-line HP/damage mismatch');
          if (!lines.slice(1).every((line, i) => line.startsWith('①②③④⑤⑥'[i]))) throw Error('Six numbered lines required');
        } else {
          if (node.dataset.survival !== 'neutral' || lines.slice(1).some(line => !line.includes('⑥') || /[①②③④⑤]/.test(line))) throw Error('Multi tooltip or neutral border');
        }
        if (/配置来源|剩余HP|能否扛住|真实坐标|以下数值/.test(node.title)) throw Error('Retired tooltip content');
      }
      return visible.length;
    });
    check(await inspect() === 1, 'initial selected curve retains six-step tooltip and exact borders');
    await page.evaluate(() => { const c = Chart.getChart(document.getElementById('defenseChart')); c.data.datasets.forEach((d, i) => { if (d.damageConfig && !c.isDatasetVisible(i)) c.options.plugins.legend.onClick({}, { datasetIndex: i }, { chart: c }); }); });
    check(await inspect() === 12, 'manually revealing twelve curves gives twelve ⑥ rows and neutral borders');
    await page.evaluate(() => { const c = Chart.getChart(document.getElementById('defenseChart')); c.data.datasets.forEach((d, i) => { if (d.damageConfig && i !== 11) c.options.plugins.legend.onClick({}, { datasetIndex: i }, { chart: c }); }); });
    check(await inspect() === 1, 'single selected curve exact tooltip and red/green borders');
    await page.evaluate(() => { const c = Chart.getChart(document.getElementById('defenseChart')); c.options.plugins.legend.onClick({}, { datasetIndex: 0 }, { chart: c }); });
    check(await inspect() === 2, 'two visible curves show only two ⑥ rows; hidden ten excluded');
    await page.evaluate(() => { const c = Chart.getChart(document.getElementById('defenseChart')); c.options.plugins.legend.onClick({}, { datasetIndex: 11 }, { chart: c }); });
    check(await inspect() === 1, 'comparison-only line uses its neutral HP nature rather than current ON button');
    check(await page.evaluate(() => !Chart.getChart(document.getElementById('defenseChart')).data.datasets.some(d => d.reference)), 'defense mode has no fixed reference dataset');
    await page.evaluate(() => { const c = Chart.getChart(document.getElementById('defenseChart')); c.options.plugins.legend.onClick({}, { datasetIndex: 0 }, { chart: c }); });
    check(await inspect() === 0, 'no visible curves: name only and neutral borders');
    for (const mode of ['defense', 'attack']) {
      if (await page.evaluate(() => ChartPage.getState().mode) !== mode) await click('chartModeBtn');
      for (const [atkIV, atkNature] of [[false, 0], [true, 0], [true, 1]]) for (const defIV of [false, true]) for (const hpNature of [false, true]) {
        await page.evaluate(async values => { await ChartWorkspace.setControls({ atkIV: { attack: values.atkIV }, atkNature: { attack: values.atkNature }, defIV: { defense: values.defIV }, hpNature: values.hpNature }); }, { atkIV, atkNature, defIV, hpNature }); await ready();
        r = await rows(); const full = atkIV && atkNature === 1 && defIV && hpNature;
        check(r.length === 1 && !r[0].hidden, `${mode} subset ${atkIV}/${atkNature}/${defIV}/${hpNature} defaults to one`);
        check(await page.locator('#chartAllBtn').isVisible() === !!full, 'ALL visibility follows eligibility');
        if (full) {
          await click('chartAllBtn'); r = await rows();
          check(r.length === 12 && r.filter(d => !d.hidden).length === 1 && !r[11].hidden, `${mode} explicit ALL offers twelve, only selected visible`);
          await click('chartAllBtn'); r = await rows();
          check(r.length === 1 && !r[0].hidden, `${mode} ALL off returns to selected line`);
        }
      }
    }
    if (await page.evaluate(() => ChartPage.getState().mode !== 'defense')) await click('chartModeBtn');
    await page.evaluate(() => {
      const f = window.__twelveView;
      f.synthetic = Array.from({ length: 100 }, (_, i) => ({ ...f.byId(249), id: 800000 + i, hidden: false, is_leader_form: false, evolution_stage: '高级形态', form_category: '主形态' }));
      RKData.getMonsters = () => f.synthetic;
      RKData.getMonsterById = id => f.synthetic.find(p => p.id === Number(id)) || f.byId(id);
      DamagePage.getState().basePower = 0;
    }); await rebuild(); await click('chartGroupPresets');
    check(await page.locator('#chartPresetPicker .bloodline-hdropdown-row').count() === 3 && await page.locator('#chartPresetPicker .bloodline-hdropdown-item').count() === 18, '18 icons stay 3x6');
    check(await page.locator('#chartPresetPicker .chart-preset-dynamic-row > .chart-preset-dynamic').count() === 2, 'Survivors and Favorites share one dynamic row');
    check(await page.evaluate(() => { const buttons = [...document.querySelectorAll('#chartPresetPicker .chart-preset-dynamic-row > button')]; const [a, b] = buttons.map(n => n.getBoundingClientRect()); return buttons.map(n => n.textContent).join('/') === '斩杀预设/收藏预设' && Math.abs(a.top-b.top) < 1 && Math.abs(a.width-b.width) < 1 && b.left >= a.right; }), 'current preset names in equal horizontal buttons');
    await page.locator('[data-preset-id="preset:Survivors"]').click(); await ready();
    check(await page.locator('#chartFavoriteGrid [data-chart-favorite]').count() === 100, 'exactly 100 survivors allowed');
    await page.evaluate(() => window.__twelveView.synthetic.push({ ...window.__twelveView.synthetic[0], id: 800100 })); await rebuild();
    check(await page.locator('#chartFavoriteGrid [data-chart-favorite]').count() === 0 && await page.locator('#chartGroupCopy').isDisabled(), '101 blocks active markers and copy');
    check((await page.locator('#chartFavoriteStatus').textContent()).includes('不可斩杀精灵过多'), 'active blocked reason displayed');
    await page.locator('#chartGroupSelect').selectOption('ungrouped'); await ready();
    await click('chartGroupPresets');
    const survivor = page.locator('[data-preset-id="preset:Survivors"]');
    check(!await survivor.isDisabled() && await survivor.textContent() === '斩杀预设', 'over-cap picker entry stays enabled with normal name');
    const beforeFeedback = await page.evaluate(() => { window.__twelveView.feedbackChart = Chart.getChart(document.getElementById('defenseChart')); return { state: JSON.stringify(ChartWorkspace.getState()), writes: window.__twelveView.writes }; });
    await survivor.click();
    check(await survivor.textContent() === '不可斩杀精灵过多' && await survivor.getAttribute('data-feedback') === 'over-limit', 'over-cap click shows temporary feedback');
    check(await page.evaluate(before => JSON.stringify(ChartWorkspace.getState()) === before.state && window.__twelveView.writes === before.writes && Chart.getChart(document.getElementById('defenseChart')) === window.__twelveView.feedbackChart && !ChartWorkspace.getStatus().pendingWrite && !document.getElementById('chartWorkspaceStatus').textContent && !document.getElementById('chartWorkspaceRetry').offsetParent, beforeFeedback), 'feedback keeps group/chart unchanged with no writes or failed-save/retry state');
    await page.waitForFunction(() => { const b = document.querySelector('[data-preset-id="preset:Survivors"]'); return b?.textContent === '斩杀预设' && !b.hasAttribute('data-feedback'); }, null, { timeout: 4000 });
    check(!await survivor.isDisabled(), 'feedback restores normal enabled entry after two-second timer');
    await page.keyboard.press('End'); await page.keyboard.press('Enter'); await ready();
    check(await page.evaluate(() => ChartWorkspace.getState().activeGroupId) === 'preset:Favorites', 'keyboard End selects final Favorites entry');
    await page.locator('#chartGroupSelect').selectOption('ungrouped'); await ready(); await click('chartGroupManage');
    check(await page.locator('#chartGroupImportPreset option[value="preset:Survivors"]').isDisabled(), 'manager import option disabled at 101');
    await page.evaluate(() => { window.__twelveView.synthetic.pop(); }); await rebuild();
    await page.locator('#chartGroupImportPreset').selectOption('preset:Survivors');
    check(!await page.locator('#chartGroupImport').isDisabled(), 'import recovers at 100');
    await click('chartGroupImport');
    const copied = await page.evaluate(() => ChartWorkspace.getState().groups[0].petIds.slice());
    await page.evaluate(() => { window.__twelveView.synthetic.push({ ...window.__twelveView.synthetic[0], id: 800100 }); }); await rebuild();
    check(JSON.stringify(await page.evaluate(() => ChartWorkspace.getState().groups[0].petIds)) === JSON.stringify(copied), 'over-cap live source never changes own imported copy');
    await page.evaluate(() => {
      const f = window.__twelveView; f.synthetic = [ { ...f.byId(202), evolution_stage: '基础形态' }, { ...f.byId(249), evolution_stage: '中级形态' }, { ...f.byId(327), evolution_stage: '高级形态' } ];
      localStorage.setItem('rk_fav_pets', '[202,249,327,202,99999999]'); FavoritePets.notify();
    }); await click('chartGroupPresets'); await page.locator('[data-preset-id="preset:Favorites"]').click(); await ready();
    check(await page.evaluate(() => JSON.stringify(ChartWorkspace.getEntries().map(e => e.id))) === '[202,249,327]', 'Favorites keeps valid stages and original dedup order');
    check(await page.locator('#chartGroupRename').isDisabled() && await page.locator('#chartFavoriteSearch input').isDisabled(), 'Favorites read-only controls');
    await page.locator('[data-chart-favorite="202"]').click({ button: 'right' });
    check(await page.locator('[data-chart-favorite="202"]').count() === 1, 'readonly favorite right click cannot remove');
    await page.evaluate(() => { localStorage.setItem('rk_fav_pets', '[327,202]'); FavoritePets.notify(); });
    check(await page.locator('#chartFavoriteGrid [data-chart-favorite]').count() === 2, 'Favorites updates live');
    await page.locator('#chartGroupSelect').selectOption('ungrouped'); await ready();
    await page.locator('#chartGroupImportPreset').selectOption('preset:Favorites'); await click('chartGroupImport');
    const imported = await page.evaluate(() => ChartWorkspace.getState().groups[0].petIds.slice());
    await page.evaluate(() => { localStorage.setItem('rk_fav_pets', '[]'); FavoritePets.notify(); });
    check(JSON.stringify(await page.evaluate(() => ChartWorkspace.getState().groups[0].petIds)) === JSON.stringify(imported), 'Favorites import is an independent snapshot');
    check(errors.length === 0, 'no browser runtime errors: ' + errors.join('; '));
    return { passed: checks.length, checks };
  } finally {
    page.off('pageerror', onError);
    if (saved) await page.evaluate(() => {
      ChartPage.onLeave(); ChartWorkspace.dispose(); const f = window.__twelveView;
      window.ChartWorkspace = f.store; window.UserConfig = f.user; RKData.getMonsters = f.monsters; RKData.getMonsterById = f.byId;
      localStorage.clear(); for (const [k, v] of Object.entries(f.storage)) localStorage.setItem(k, v);
      Object.assign(DamagePage.getState(), f.damage); delete window.__twelveView;
    });
    await page.reload();
  }
}
