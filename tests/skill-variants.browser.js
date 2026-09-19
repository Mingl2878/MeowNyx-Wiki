// Parent-run browser function. Requires explicit Go TestUserConfigBrowserFixture.
// No real application launch. Every write (including localStorage) follows verified isolation.
// Harness supplies window.__damageFixture={origins:[...],reset_url:...} before invocation.
async page => {
  const fixture=await page.evaluate(()=>window.__damageFixture);
  if(!fixture?.origins?.length)throw Error('Explicit isolated fixture required');
  for(const origin of fixture.origins){
    const hostname=await page.evaluate(origin=>new URL(origin).hostname,origin);
    if(!['127.0.0.1','localhost','[::1]'].includes(hostname))throw Error('Loopback fixture required');
    const response=await page.request.get(origin+'/__fixture/info');
    if(!response.ok()||!(await response.json()).isolated)throw Error('Refusing non-fixture profile writes');
  }
  const checks=[],errors=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const onError=e=>errors.push(e.message);page.on('pageerror',onError);
  const canonical=x=>x&&typeof x==='object'?Array.isArray(x)?x.map(canonical):Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
  const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
  const ready=async()=>{await page.waitForSelector('#basePower');await page.waitForFunction(()=>UserConfig.getStatus().ready);await page.evaluate(()=>UserConfig.flush());};
  const snapshot=()=>page.evaluate(()=>UserConfig.getObject('rk_damage_view').skill);
  const state=()=>page.evaluate(()=>JSON.parse(JSON.stringify(DamagePage.getState())));
  const go=async route=>{await page.evaluate(route=>location.hash='/'+route,route);await page.waitForSelector(route==='damage'?'#basePower':'#tier-fixed');};
  const choose=async id=>{
    const name=await page.evaluate(id=>RKData.getMonsterDisplayName(RKData.getMonsterById(id)),id);
    await page.locator('#attacker-search-slot input').fill('');await page.locator('#attacker-search-slot input').fill(name);
    await page.waitForFunction(id=>DamagePage.getState().atkPet?.id===id,id);
    await page.locator('#attacker-search-slot input').press('Escape');await page.evaluate(()=>UserConfig.flush());
  };
  const injectIcons=async()=>{
    // In-memory fixture-only learnset, never saved to Wiki. Real renderer and real master moves.
    await page.evaluate(()=>{
      RKData.getResolvedWikiData=()=>({skills:RKData.getMoves().filter(RKData.isAttackMove).map(m=>({name:RKData.getMoveName(m),type:RKData.getMoveCategoryZh(m),element:m.move_type.localized.zh,source:m.id===420?'血脉':'普通'}))});
      localStorage.setItem('rk_team_config',JSON.stringify({activeGroupId:'variant-fixture',groups:[{id:'variant-fixture',team:[501,434],petSkills:{501:['驱赶','撕咬','散手','乘胜追击']}}]}));
    });
    await go('speed');await go('damage');
  };
  const icon=(name,group)=>page.locator('.skill-icon-group').filter({has:page.locator('.skill-icon-group-title',{hasText:group})}).locator(`.skill-icon-item[data-skill-name="${name}"]`).first();
  try{
    await page.goto(fixture.origins[0]+'/#/damage');await ready();
    check(await page.evaluate(()=>{const a=SkillVariants.audit(RKData.getMoves());return a.total===579&&!a.unreviewed.length;}),'all 579 runtime moves reviewed');
    await choose(434);await injectIcons();
    const values={fixedBonus:'-17',percentBonus:'23.5',buff:'-35',debuffPercent:'10+5',defenseMod:'-50',starMeteor:'4',finalPowerManual:'0'};
    for(const[k,v]of Object.entries(values))await page.locator('#'+k).fill(v);
    await page.evaluate(()=>UserConfig.flush());
    for(const mode of [0,1]){
      await page.evaluate(async mode=>UserConfig.patch('rk_pet_configs',{434:{mode,iv:{hp:false,attack:true},nature:{attack:2},fixtureUnknown:'keep'}}),mode);
      const profileBefore=await page.evaluate(()=>UserConfig.getObject('rk_pet_configs'));
      for(const[name,group,lp,lc,rp,rc]of [
        ['吨位压制','基础技能',100,1,160,1],['以重制重','基础技能',100,1,160,1],
        ['砂糖弹球','基础技能',80,1,120,1],['魔能爆','基础技能',210,1,40,1],
        ['穿膛','基础技能',65,1,325,1],['背袭','基础技能',40,1,800,1],['色散','基础技能',80,1,120,1],
        ['双联脉冲','基础技能',50,1,50,2],['驱赶','基础技能',90,1,210,1],['驱赶','过山车技能',90,1,210,1],
        ['爆冲','基础技能',65,1,325,1],['筛管奔流','基础技能',80,1,155,1],
        ['疾风刺','基础技能',25,1,25,3],['撕咬','血脉技能',20,3,20,5],['撕咬','过山车技能',20,3,20,5],
        ['埋伏','基础技能',30,3,30,6],['连续爪击','基础技能',30,2,30,4],['追打','基础技能',75,1,75,3],
        ['散手','基础技能',35,2,35,6],['散手','过山车技能',35,2,35,6],['磁暴','基础技能',70,1,100,1],
        ['草虫冲击','基础技能',75,1,165,1],['扇风','基础技能',75,1,112,1],['引雷','基础技能',35,2,55,2]
      ]){
        const el=icon(name,group);
        check((await el.getAttribute('title')).includes('左键：')&&(await el.getAttribute('aria-label')).includes('右键：'),name+' accessible two-button help');
        await el.click();let s=await state();check(s.basePower===lp&&s.comboCount===lc,name+' left '+group);
        await el.click({button:'right'});await el.click({button:'right'});s=await state();
        check(s.basePower===rp&&s.comboCount===rc&&s.currentSkillName===name,name+' right repeat does not compound '+group);
        for(const[k,v]of Object.entries(values))check(String(s[k])===v,name+' preserves '+k);
        await page.evaluate(()=>UserConfig.flush());const saved=await snapshot();
        check(saved.basePower===rp&&saved.comboCount===rc&&saved.currentSkillName===name,name+' complete snapshot');
        check(same(saved,await page.evaluate(()=>UserConfig.getObject('rk_damage_skill_configs')[434])),name+' personal skill memory');
        await el.click();s=await state();check(s.basePower===lp&&s.comboCount===lc,name+' right→left resets both fields');
      }
      check(same(profileBefore,await page.evaluate(()=>UserConfig.getObject('rk_pet_configs'))),'mode '+mode+' profile never altered by presets');
    }
    // A fixed enemy-target counter is safe even when its ordinary self-hit cannot be automated.
    const disaster=icon('灾厄','基础技能');
    const beforeSelf=await state();await disaster.click();
    check(same(beforeSelf,await state()),'self-hit left does not silently attack the selected enemy');
    await disaster.click({button:'right'});
    check((await state()).basePower===180&&(await state()).comboCount===1,'explicit enemy-target counter fills180x1');
    await page.evaluate(()=>UserConfig.flush());
    // User explicitly wants base-only rows to select the same original power on both buttons.
    const bases=await page.evaluate(()=>SkillVariants.audit(RKData.getMoves()).rows.filter(r=>r.disposition==='base-only').map(r=>({name:r.name,power:r.left.basePower,combo:r.left.comboCount})));
    check(bases.length===52,'52 explicit base-only rows');
    for(const item of bases){
      const el=icon(item.name,'基础技能');
      for(const button of ['left','right']){
        await el.click({button});const selected=await state();
        check(selected.basePower===item.power&&selected.comboCount===item.combo,item.name+' '+button+' base-only');
      }
    }
    for(const name of ['吨位压制','以重制重','砂糖弹球','魔能爆'])check((await icon(name,'基础技能').locator('.skill-icon-power').innerText()).trim()==='?',name+' unknown icon retained');
    for(const[name,combo]of [['叠浪',3],['试飞',2]]){await icon(name,'基础技能').click();check((await state()).comboCount===combo,name+' null base_combo resolved from reviewed text');}
    await icon('钢钻','基础技能').click();check((await state()).basePower===0,'zero base power not replaced by fallback');
    await page.evaluate(()=>UserConfig.flush());const expected=await snapshot();
    await page.reload();await ready();check(same(expected,await snapshot()),'reload keeps selected name, zero base, combo and all manual fields');
    await choose(249);await choose(434);check((await state()).basePower===0&&(await state()).currentSkillName==='钢钻','per-pet memory restored after attacker switch');
    // Attacker switching retains the existing defender-derived percent auto-rule.
    // Compare the new active snapshot, not the pre-switch user percent.
    const sharedExpected=await snapshot();
    if(fixture.origins.length>1){await page.goto(fixture.origins[1]+'/#/damage');await ready();check(same(sharedExpected,await snapshot()),'shared snapshot restored on second isolated origin');}
    check(errors.length===0,'no browser page errors: '+errors.join('; '));
    return {passed:checks.length,checks};
  }finally{page.off('pageerror',onError);}
}
