// Synthetic upgrade regression; never reads a real WebView/profile. Same isolated fixture as damage-startup.browser.js.
async page => {
  const fixture=await page.evaluate(()=>window.__damageFixture);
  if(!fixture?.reset_url)throw Error('explicit fixture required');
  const origin=fixture.origins[0];
  const info=await page.request.get(origin+'/__fixture/info');
  if(!info.ok()||!(await info.json()).isolated)throw Error('refusing non-fixture writes');
  const checks=[],check=(ok,text)=>{if(!ok)throw Error(text);checks.push(text);};
  await page.goto(origin+'/#/damage');await page.waitForSelector('#basePower');await page.evaluate(()=>UserConfig.flush());
  await page.evaluate(()=>localStorage.clear());
  check((await page.request.post(fixture.reset_url,{data:{}})).ok(),'synthetic fixture reset');
  // Complete OLD migration only. Leave the new per-key flags unset.
  const seed=await page.request.post(origin+'/api/user-config',{data:{
    import:{rk_pet_configs:{202:{iv:{},nature:{}}}},
    patch:{rk_damage_selection:{attacker:202,attackerTeam:null},rk_damage_skill_configs:{1000:{}}}
  }});
  const seeded=await seed.json();check(seeded.ok&&seeded.legacy_imported,'old all-key import flag is true');
  const legacy={basePower:150,fixedBonus:0,percentBonus:0,buff:200,comboCount:1,debuffPercent:'0',defenseMod:'0',starMeteor:0,finalPowerManual:'',skillType:'magic_attack',skillAttr:'水',currentSkillName:'天洪'};
  await page.evaluate(legacy=>{
    const records={202:legacy};
    for(let i=0;i<28;i++)records[1000+i]={...legacy,basePower:i,debuffPercent:String(i),defenseMod:String(-i),currentSkillName:''};
    localStorage.setItem('rk_damage_skill_configs',JSON.stringify(records));
  },legacy);
  await page.reload();await page.waitForSelector('#basePower');await page.waitForFunction(()=>UserConfig.getStatus().ready);
  check(await page.evaluate(()=>!UserConfig.getStatus().error&&UserConfig.getStatus().pending===0),'legacy string parameters do not block upgrade');
  const data=(await(await page.request.get(origin+'/api/user-config')).json()).data;
  check(Object.keys(data.rk_damage_skill_configs).length===29,'all 29 synthetic legacy skill records are retained');
  check(Object.keys(data.rk_damage_skill_configs[1000]).length===0,'existing shared empty skill record wins over legacy');
  check(data.rk_damage_skill_configs[1027].debuffPercent==='27'&&data.rk_damage_skill_configs[1027].defenseMod==='-27','numeric-string legacy fields preserve their representation');
  const verify=()=>page.evaluate(legacy=>{
    const s=DamagePage.getState();
    return s.atkPet.id===202&&s.defPet.id===9001&&Object.entries(legacy).every(([k,v])=>s[k]===v)
      &&document.getElementById('basePower').value==='150'&&document.getElementById('buff').value==='200'
      &&document.getElementById('skillTypeMagic').checked;
  },legacy);
  check(await verify(),'saved attacker 202 and complete legacy 天洪 settings restore without a view snapshot');
  check(!data.rk_damage_view,'restoring legacy memory does not silently write a last-active snapshot');
  await page.goto(fixture.origins[1]+'/#/damage');await page.waitForSelector('#basePower');await page.waitForFunction(()=>UserConfig.getStatus().ready);
  check(await verify(),'new origin restores attacker and legacy skill memory from shared file');
  await page.evaluate(()=>localStorage.clear());await page.reload();await page.waitForSelector('#basePower');
  check(await verify(),'legacy memory remains available after clearing cache');
  return {passed:checks.length,checks};
}
