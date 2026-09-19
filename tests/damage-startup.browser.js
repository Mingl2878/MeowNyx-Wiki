// Isolated TestUserConfigBrowserFixture ONLY. Harness sets __damageFixture={origins,reset_url}.
async page => {
  const fixture = await page.evaluate(() => window.__damageFixture);
  if (!fixture?.reset_url || fixture.origins.length !== 2) throw Error('explicit isolated fixture required');
  for (const origin of fixture.origins) {
    const r = await page.request.get(origin + '/__fixture/info');
    if (!r.ok() || !(await r.json()).isolated) throw Error('refusing non-fixture profile writes');
  }
  const checks = [], errors = [];
  const onError = e => errors.push(e.message); page.on('pageerror', onError);
  const check = (ok, text) => { if (!ok) throw Error(text); checks.push(text); };
  const canonical = value => value && typeof value==='object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
  const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const state = () => page.evaluate(() => JSON.parse(JSON.stringify(DamagePage.getState())));
  const ready = async () => { await page.waitForSelector('#basePower'); await page.waitForFunction(() => UserConfig.getStatus().ready); await page.evaluate(() => UserConfig.flush()); };
  const choose = async (side,id) => {
    const name = await page.evaluate(id => RKData.getMonsterDisplayName(RKData.getMonsterById(id)), id);
    await page.locator(`#${side}-search-slot input`).fill('');
    await page.locator(`#${side}-search-slot input`).fill(name);
    await page.waitForFunction(({side,id}) => DamagePage.getState()[side==='attacker'?'atkPet':'defPet']?.id === id, {side,id});
    await page.locator(`#${side}-search-slot input`).press('Escape');
    await page.evaluate(() => UserConfig.flush());
  };
  const go = async route => { await page.evaluate(route => location.hash='/'+route,route); await page.waitForSelector(route==='damage'?'#basePower':'#tier-fixed'); };
  const snapshot = () => page.evaluate(() => UserConfig.getObject('rk_damage_view').skill);
  const keys = ['skillType','skillAttr','basePower','basePowerExpression','fixedBonus','percentBonus','buff','comboCount','debuffPercent','defenseMod','starMeteor','finalPowerManual','currentSkillName'];
  const skill = s => Object.fromEntries(keys.map(k=>[k,s[k]]));
  try {
    await page.goto(fixture.origins[0]+'/#/damage'); await ready();
    await page.evaluate(() => localStorage.clear());
    const reset = await page.request.post(fixture.reset_url,{data:{}}); check(reset.ok(),'isolated profile reset');
    await page.reload(); await ready();
    check((await state()).atkPet===null && (await state()).defPet.id===9001,'fresh startup has no forced 221 and keeps dummy 9001');
    let writes=0; const onRequest=req=>{if(req.method()==='POST'&&req.url().endsWith('/api/user-config'))writes++;};
    page.on('request',onRequest);
    await go('speed'); await go('damage'); await page.reload(); await ready();
    page.off('request',onRequest);check(writes===0,'route render and cold render do not persist defaults or overwrite records');
    await page.locator('#basePower').fill('0');await page.locator('#finalPowerManual').fill('345');await page.evaluate(()=>UserConfig.flush());
    await page.reload();await ready();
    check((await state()).atkPet===null&&(await state()).basePower===0&&(await state()).finalPowerManual==='345','skill snapshot without an attacker survives startup, including nonzero manual power');
    check(await page.evaluate(()=>Object.keys(UserConfig.getObject('rk_damage_skill_configs')).length===0),'unselected skill edits never create a spurious per-pet record');
    await choose('attacker',434);
    check(await page.evaluate(()=>{const s=DamagePage.getState(),d=PetConfiguration.defaults(s.atkPet);return JSON.stringify(s.atkIV)===JSON.stringify(d.iv)&&JSON.stringify(s.atkNature)===JSON.stringify(d.nature);}), 'absent record displays current-form automatic defaults');
    check(await page.evaluate(()=>UserConfig.getObject('rk_pet_configs')[434]===undefined),'selecting automatic pet does not create a personal record');
    await page.locator('.attacker-card .iv-btn[data-stat="hp"]').click();await page.evaluate(()=>UserConfig.flush());
    check(await page.evaluate(()=>{const r=UserConfig.getObject('rk_pet_configs')[434],s=DamagePage.getState();return r.mode===1&&r.iv.hp===false&&Object.keys(r.iv).length===6&&Object.keys(r.nature).length===6&&['attack','magic_attack','defense','magic_defense','speed'].every(k=>r.iv[k]===!!s.atkIV[k]);}),'manual edit snapshots ALL displayed stats in mode1, preserving explicit off');
    await page.evaluate(async()=>{
      await UserConfig.patch('rk_pet_configs',{249:{},602:{mode:0,iv:{hp:false},nature:{hp:2}}});
    });
    await choose('defender',249);check(same((await state()).defIV,{})&&same((await state()).defNature,{}),'existing empty legacy record stays manual, not defaults');
    await page.locator('.defender-card .nature-btn[data-stat="hp"]').click({button:'right'});await page.evaluate(()=>UserConfig.flush());
    check(await page.evaluate(()=>{const r=UserConfig.getObject('rk_pet_configs')[249];return r.mode===1&&r.nature.hp===2&&Object.keys(r.iv).length===6&&Object.values(r.iv).every(v=>v===false);}), 'manual negative nature edit snapshots legacy empty IV choices without inserting defaults');
    await choose('defender',602);
    check(await page.evaluate(()=>{const s=DamagePage.getState(),d=PetConfiguration.defaults(s.defPet);return JSON.stringify(s.defIV)===JSON.stringify(d.iv)&&JSON.stringify(s.defNature)===JSON.stringify(d.nature);}), 'saved numerical mode0 ignores stale maps and regenerates defaults');
    await page.evaluate(()=>localStorage.setItem('rk_team_config',JSON.stringify({activeGroupId:'startup-test',groups:[{id:'startup-test',team:[434],petNatures:{434:{attack:2}},petIVs:{434:{hp:false,attack:false}}}]})));
    await go('speed');await go('damage');await page.locator('#quick-team-grid .quick-pet-item[data-pet-id="434"]').click();await page.evaluate(()=>UserConfig.flush());
    await page.reload();await ready();check((await state()).atkNature.attack===2&&!(await state()).atkIV.hp,'cold startup restores last attacker team source');
    const teamBefore=await page.evaluate(()=>localStorage.getItem('rk_team_config'));
    await page.locator('#resetAttackerBtn').click();await page.evaluate(()=>UserConfig.flush());
    check(await page.evaluate(()=>UserConfig.getObject('rk_pet_configs')[434].mode===0&&UserConfig.getObject('rk_damage_selection').attackerTeam===null),'reset restores automatic mode and detaches the team source');
    check(teamBefore===await page.evaluate(()=>localStorage.getItem('rk_team_config')),'personal reset never modifies teams');
    await page.locator('.attacker-card .iv-btn[data-stat="hp"]').click();await page.evaluate(()=>UserConfig.flush());
    await choose('defender',249);
    await page.locator('.skill-icon-item[data-skill-name="磁暴"]').first().click();
    await page.locator('#skillTypeMagic').check();
    const values={basePower:'0',fixedBonus:'-17',percentBonus:'23',buff:'-35',comboCount:'3',debuffPercent:'10+5',defenseMod:'-50',starMeteor:'4',finalPowerManual:'0'};
    for(const [key,value]of Object.entries(values))await page.locator('#'+key).fill(value);
    await page.evaluate(()=>UserConfig.flush());
    const expected=skill(await state());check(expected.basePower===0&&expected.finalPowerManual==='0'&&expected.currentSkillName==='磁暴','zero base and manual final power plus selected identity are captured');
    check(same(await snapshot(),expected),'last-active snapshot contains ALL skill fields');
    const petMemory=await page.evaluate(()=>UserConfig.getObject('rk_damage_skill_configs')[434]);
    check(same(petMemory,expected),'per-pet skill memory saves complete user edits');
    await go('speed');await go('damage');check((await state()).defPet.id===249&&same(skill(await state()),expected),'route navigation keeps defender and every skill setting');
    writes=0;page.on('request',onRequest);await page.reload();await ready();page.off('request',onRequest);
    check(writes===0,'restoring a saved cold session issues no profile writes');
    check((await state()).atkPet.id===434&&(await state()).defPet.id===9001&&same(skill(await state()),expected),'true reload restores attacker and ALL skill fields but resets only defender');
    for(const [key]of Object.entries(values))check(await page.locator('#'+key).inputValue()===String(expected[key]),'restored DOM '+key);
    check(!(await state()).atkIV.hp,'explicit manual HP off survives reload');
    await page.goto(fixture.origins[1]+'/#/damage');await ready();
    check((await state()).atkPet.id===434&&(await state()).defPet.id===9001&&same(skill(await state()),expected),'cross-origin startup reads shared selection and ALL skill fields');
    await page.evaluate(()=>localStorage.clear());await page.reload();await ready();
    check(same(skill(await state()),expected)&&!(await state()).atkIV.hp,'cleared origin cache cannot erase snapshot or manual pet values');
    // Defender-derived active values must not clobber user memory for the attacker.
    await page.locator('#finalPowerManual').fill('');await page.evaluate(()=>UserConfig.flush());
    const beforeDerived=await page.evaluate(()=>UserConfig.getObject('rk_damage_skill_configs')[434]);
    await choose('defender',501);
    const derived=skill(await state());check(derived.percentBonus!==beforeDerived.percentBonus,'defender selection performs its established automatic arithmetic');
    check(same(await page.evaluate(()=>UserConfig.getObject('rk_damage_skill_configs')[434]),beforeDerived),'defender selection does not snapshot a wrong pet or replace per-pet memory');
    await page.reload();await ready();check(same(skill(await state()),derived),'last-active snapshot is restored independently of per-pet memory');
    await choose('defender',249);
    await page.evaluate(async()=>UserConfig.patch('rk_damage_skill_configs',{249:{skillType:'attack',skillAttr:'普',basePower:81,comboCount:2,currentSkillName:''}}));
    const outgoingMemory=await page.evaluate(()=>UserConfig.getObject('rk_damage_skill_configs')[434]);
    await page.locator('#swapIcon').click();await page.evaluate(()=>UserConfig.flush());
    check(same(await page.evaluate(()=>UserConfig.getObject('rk_damage_skill_configs')[434]),outgoingMemory),'swap never overwrites outgoing per-pet user memory with derived active fields');
    check((await state()).atkPet.id===249&&(await state()).basePower===81&&(await state()).comboCount===2,'swap loads the NEW attacker memory, not outgoing skill fields');
    const failed=async route=>route.request().method()==='POST'?route.fulfill({status:500,contentType:'application/json',body:'{"ok":false,"error":"isolated simulated failure"}'}):route.continue();
    await page.route('**/api/user-config',failed);await page.locator('#basePower').fill('0');
    await page.waitForFunction(()=>!!UserConfig.getStatus().error);
    check(!await page.evaluate(()=>UserConfig.requestClose()),'skill save failure blocks close flush rather than silently saving only localStorage');
    await page.unroute('**/api/user-config',failed);check(await page.evaluate(()=>UserConfig.retry()),'retry commits retained skill queue');
    await page.reload();await ready();check((await state()).atkPet.id===249&&(await state()).basePower===0,'retried zero skill value survives cold restart');
    check(errors.length===0,'no page errors: '+errors.join('; '));
    return {passed:checks.length,checks};
  } finally { page.off('pageerror',onError); }
}
