// Run with playwright-cli run-code --filename=tests/damage-chart.browser.js
// Use a separate browser profile and isolated temporary-config fixture server only.
async page => {
  const checks = [];
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const go = async route => {
    await page.locator(`a[data-route="${route}"]`).click();
    await page.waitForSelector(route === 'damage' ? '#basePower' : '#chartPowerInput', { state: 'attached' });
    if (route === 'chart') await page.waitForFunction(() => !document.getElementById('chartAtkIVBtn').disabled);
  };
  const choose = async (side, name) => {
    const input = page.locator(`#${side}-search-slot input`);
    await input.fill(''); await input.fill(name);
  };
  const state = () => page.evaluate(() => JSON.parse(JSON.stringify(DamagePage.getState())));
  const chartData = () => page.evaluate(() => Chart.getChart(document.getElementById('defenseChart')).data.datasets.map(d => ({ label: d.label, data: [...d.data], reference: !!d.reference })));
  try {
    await page.waitForSelector('#basePower');
    await page.locator('#skillTypeMagic').check();
    await page.locator('#resetSkillSettingsBtn').click();
    check(await page.evaluate(() => DamagePage.getState().skillType === 'attack' && document.getElementById('skillTypeAttack').checked), 'reset keeps displayed and calculated attack type consistent');

    await choose('attacker', '圣剑-X');
    await page.locator('.skill-icon-item[data-skill-name="磁暴"]').first().click();
    check(await page.evaluate(() => {
      const s = DamagePage.getState(), saved = UserConfig.getObject('rk_damage_skill_configs')[s.atkPet.id];
      return ['basePower','comboCount','skillType','skillAttr','currentSkillName','percentBonus'].every(key => saved[key] === s[key]);
    }), 'skill memory is saved after name/type/element and automatic calculations update');

    await page.evaluate(() => {
      const s = DamagePage.getState();
      s.atkPet = { ...s.atkPet, base_phy_def: 160, base_spd: 50 };
      s.defPet = { ...s.defPet, base_phy_def: 100, base_spd: 200 };
      s.atkNature = {}; s.atkIV = {}; s.defNature = {}; s.defIV = {};
    });
    await page.locator('.skill-icon-item[data-skill-name="鸣沙陷阱"]').first().click();
    check(await page.evaluate(() => {
      const s = DamagePage.getState();
      const diff = RKData.getPetStat(s.atkPet, 'defense', 0, false) - RKData.getPetStat(s.defPet, 'defense', 0, false);
      return s.basePower === BattleMath.differencePower(diff) && s.basePower !== 60;
    }), '鸣沙陷阱 uses physical-defense difference, not speed difference');

    await page.locator('#resetSkillSettingsBtn').click();
    await page.evaluate(() => { DamagePage.getState().skillAttr = '火'; });
    await choose('defender', '机幕方舟');
    check(await page.evaluate(() => DamagePage.CalcEngine.calcTypeEff('火', DamagePage.getState().defPet) > 1 && DamagePage.getState().percentBonus === 25), '机幕方舟 retains its independent 25% overwrite');
    await choose('defender', '权杖-V');
    check((await state()).percentBonus === 0, 'leaving the special defender still resets its overwrite');

    await choose('attacker', '小黑猫');
    await page.evaluate(async () => {
      await UserConfig.patch('rk_pet_configs', {
        434: { nature: { attack: 1, magic_attack: 2 }, iv: { attack: true, magic_attack: false } },
        249: { nature: { defense: 2, magic_defense: 1, hp: 1 }, iv: { defense: true, hp: true } }
      });
      await UserConfig.patch('rk_damage_skill_configs', {
        434: { skillType: 'attack', skillAttr: '火', basePower: 100, comboCount: 1, currentSkillName: '' },
        249: { skillType: 'magic_attack', skillAttr: '钢', basePower: 80, comboCount: 2, currentSkillName: '' }
      });
    });
    await choose('attacker', '圣剑-X'); await choose('defender', '权杖-V');
    const baseline = await state();
    check(baseline.atkIV.attack && baseline.atkNature.attack === 1 && baseline.defNature.defense === 2, 'search selection restores each monster personal nature/IV memory');
    await go('chart');
    check(await page.evaluate(() => document.getElementById('chartAtkIVBtn').classList.contains('active-iv') && document.getElementById('chartAtkNatureBtn').dataset.nature === '0' && document.getElementById('chartIVBtn').classList.contains('active-iv')), 'chart controls use independent defaults rather than damage-page nature');
    check(await page.evaluate(() => {
      const s = DamagePage.getState(), chart = Chart.getChart(document.getElementById('defenseChart'));
      const i = chart.data.labels.indexOf(100);
      const power = BattleMath.finalPower(s.basePower, s.fixedBonus, s.percentBonus, DamagePage.CalcEngine.isSameType(s.atkPet, s.skillAttr) ? 1.25 : 1, 1, s.buff);
      const expected = BattleMath.normalDamage(RKData.getPetStat(s.atkPet,'attack',0,true), power, BattleMath.statFromBase(100,'defense',0,true),1,s.comboCount);
      return chart.data.datasets[0].data[i] === expected;
    }), 'baseline curve uses independent nature and IV in actual calculations');
    const beforeCompare = await state();
    await page.locator('#chartAtkIVBtn').click();
    await page.locator('#chartAtkNatureBtn').click();
    await page.waitForFunction(() => !document.getElementById('chartAtkIVBtn').disabled);
    check(same(await state(), beforeCompare), 'curve comparison never writes back to damage state');
    check((await chartData()).some(d => d.label.includes('性格')), 'nature comparison exists independently of the IV setting');

    const curvesBefore = await chartData();
    await go('damage');
    check(await page.evaluate(() => document.querySelector('input[name="skillType"]:checked').value === DamagePage.getState().skillType), 'damage type remains synchronized after page navigation');
    await page.locator('#debuffPercent').fill('50');
    await page.locator('#defenseMod').fill('100');
    await page.locator('#starMeteor').fill('4');
    await page.locator('#finalPowerManual').fill('400');
    await go('chart');
    check(same(await chartData(), curvesBefore), 'curve continues to exclude reduction, defense adjustment, meteor and manual final power');

    await page.locator('#chartModeBtn').click();
    check(await page.locator('#chartPowerSlider').count() === 0, 'power slider is removed');
    await page.locator('#chartPowerInput').fill('0');
    check((await chartData()).filter(d => !d.reference).every(d => d.data.every(v => v === 0)), 'numeric zero produces zero damage, not fallback 200');
    await page.locator('#chartSwapAxisBtn').click();
    await page.locator('#chartPowerInput').fill('140');
    await page.locator('#chartSwapAxisBtn').click();
    check(await page.locator('#chartPowerInput').inputValue() === '0', 'axis exchange remembers separate power and qualification values');
    await page.locator('#chartPowerInput').fill('250');
    check(await page.locator('#chartCritBtn,#chartCritBtnDef').count() === 0, 'manual effectiveness controls removed in both modes');
    await page.locator('#chartSameTypeBtn').click();
    await page.locator('#chartAtkTypeBtn').click();
    const viewBefore = await page.evaluate(() => ChartPage.getState());
    await go('damage'); await go('chart');
    check(same(await page.evaluate(() => ChartPage.getState()), viewBefore), 'all curve view/comparison settings survive navigation');
    check(await page.locator('#chartPowerInput').inputValue() === '250' && await page.locator('#chartAtkTypeBtn').innerText() === '魔攻', 'restored controls display the retained values');

    await go('damage');
    const beforeSwap = await state();
    await page.locator('#swapIcon').click();
    const afterSwap = await state();
    check(afterSwap.atkPet.id === beforeSwap.defPet.id && afterSwap.defPet.id === beforeSwap.atkPet.id && same(afterSwap.atkIV,beforeSwap.defIV) && same(afterSwap.defIV,beforeSwap.atkIV) && same(afterSwap.atkNature,beforeSwap.defNature) && same(afterSwap.defNature,beforeSwap.atkNature), 'swap exchanges complete monster/nature/IV configurations');
    check(afterSwap.skillType === 'magic_attack' && afterSwap.basePower === 80 && afterSwap.comboCount === 2, 'new attacker receives its own skill memory after swapping');

    await page.evaluate(() => localStorage.setItem('rk_team_config', JSON.stringify({ activeGroupId:'audit', groups:[{id:'audit',team:[434],petNatures:{434:{attack:2}},petIVs:{434:{attack:false}}}]})));
    await go('chart'); await go('damage');
    await page.locator('#quick-team-grid .quick-pet-item[data-pet-id="434"]').click();
    const fromTeam = await state();
    check(fromTeam.atkNature.attack === 2 && !fromTeam.atkIV.attack, 'team avatar uses team configuration on its first click');
    await choose('attacker', '圣剑-X');
    check((await state()).atkNature.attack === 1 && (await state()).atkIV.attack, 'search uses personal memory rather than the team override');

    await page.locator('#resetSkillSettingsBtn').click();
    await page.locator('#basePower').fill('600');
    await go('chart');
    if ((await page.evaluate(() => ChartPage.getState())).mode !== 'defense') await page.locator('#chartModeBtn').click();
    check((await chartData()).some(d => d.reference && d.label === '400伤害参考线'), 'fixed 400 line is named 400伤害参考线');
    check(errors.length === 0, `no browser runtime errors (${errors.join('; ')})`);
    return { passed: checks.length, checks };
  } finally { page.off('pageerror', onError); }
}
