// Parent-run function. Writes ONLY to the explicitly verified isolated Go fixture.
async page => {
 const fixture=await page.evaluate(()=>window.__damageFixture);
 if(!fixture?.origins?.length)throw Error('Explicit isolated fixture required');
 for(const origin of fixture.origins){
  if(!await page.evaluate(o=>['127.0.0.1','localhost','[::1]'].includes(new URL(o).hostname),origin))throw Error('Loopback required');
  const response=await page.request.get(origin+'/__fixture/info');if(!response.ok()||!(await response.json()).isolated)throw Error('Refusing real profile writes');
 }
 const checks=[],errors=[];const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
 const error=e=>errors.push(e.message);page.on('pageerror',error);
 const ready=async()=>{await page.waitForSelector('#basePower');await page.waitForFunction(()=>UserConfig.getStatus().ready);await page.evaluate(()=>UserConfig.flush());};
 const state=()=>page.evaluate(()=>JSON.parse(JSON.stringify(DamagePage.getState())));
 const choose=async id=>{const name=await page.evaluate(id=>RKData.getMonsterDisplayName(RKData.getMonsterById(id)),id);await page.locator('#attacker-search-slot input').fill('');await page.locator('#attacker-search-slot input').fill(name);await page.waitForFunction(id=>DamagePage.getState().atkPet?.id===id,id);await page.locator('#attacker-search-slot input').press('Escape');await page.evaluate(()=>UserConfig.flush());};
 const inject=async()=>{await page.evaluate(()=>{RKData.getResolvedWikiData=()=>({skills:RKData.getMoves().filter(RKData.isAttackMove).map(m=>({name:RKData.getMoveName(m),type:RKData.getMoveCategoryZh(m),element:m.move_type.localized.zh,source:'普通'}))});location.hash='/speed';});await page.waitForSelector('#tier-fixed');await page.evaluate(()=>location.hash='/damage');await ready();};
 const icon=name=>page.locator(`.skill-icon-item[data-skill-name="${name}"]`).first();
 const click=async(name,button='left')=>{await icon(name).click({button});await page.evaluate(()=>UserConfig.flush());return state();};
 try{
  await page.goto(fixture.origins[0]+'/#/damage');await ready();await choose(202);await inject();
  await page.locator('#percentBonus').fill('30');await page.locator('#buff').fill('40');await page.locator('#finalPowerManual').fill('');
  let s=await click('迫近攻击');check(s.basePower===90,'left resets fixed own power');
  s=await click('迫近攻击','right');check(s.basePower===135&&s.basePowerExpression==='90+(1*45)','first permanent increment expression');
  s=await click('迫近攻击','right');check(s.basePower===180&&s.basePowerExpression==='90+(2*45)','second increment');
  check(s.percentBonus===30&&s.buff===40,'growth preserves independent percent/buff');
  check((await icon('迫近攻击').getAttribute('title')).includes('效果：')&&!(await icon('迫近攻击').getAttribute('title')).includes('右键'),'hover source evidence without operation explanation');
  const record=await page.evaluate(()=>UserConfig.getObject('rk_skill_simulation')['202:41']);check(record.powerCount===2,'pair key stored');
  await choose(249);await choose(202);s=await state();check(s.basePower===180&&s.percentBonus===30,'switch restores growth and percent without implicit left');
  await page.reload();await ready();s=await state();check(s.basePowerExpression==='90+(2*45)'&&s.percentBonus===30,'real reload restores exact expression and percent');await inject();
  s=await click('迫近攻击','right');check(s.basePower===225,'reload retains increment counter');
  s=await click('吹火','right');check(s.currentSkillName==='吹火','other skill selected');
  check(await page.evaluate(()=>UserConfig.getObject('rk_skill_simulation')['202:41'].powerCount===3),'unrelated pair preserved');
  s=await click('山火');s=await click('山火','right');s=await click('山火','right');check(s.basePower===60&&s.basePowerExpression==='15*2^(2)','exponent means powers of two');
  s=await click('乘胜追击');s=await click('乘胜追击','right');check(s.basePower===40&&s.comboCount===2,'permanent combo does not multiply source power');
  s=await click('孢子爆散');s=await click('孢子爆散','right');check(s.basePower===30&&s.comboCount===4,'combo plus two');
  s=await click('友谊满溢');s=await click('友谊满溢','right');s=await click('友谊满溢','middle');check(s.basePower===180,'friend middle applies counter to cumulative value');
  s=await click('友谊满溢','middle');check(s.basePower===180,'repeat middle not compounding');
  s=await click('友谊满溢','right');check(s.basePower===110,'right resumes normal growth branch');
  s=await click('试飞');s=await click('试飞','right');s=await click('试飞','right');s=await click('试飞','middle');check(s.basePower===40&&s.comboCount===3,'trial separate two power events and one combo');
  s=await click('魔能爆');check(s.skillInputKind==='energy'&&s.skillInputValue==='10'&&s.basePower===211,'energy input not literal power');
  check(await page.locator('#skill-power-input-label').innerText()==='当前能量','energy label');
  check((await icon('魔能爆').locator('.skill-icon-power').innerText()).trim()==='?','magic icon remains unknown');
  for(const[n,power]of [46,71,91,111,136,156,166,181,191,201,211].entries()){
   await page.locator('#basePower').fill(String(n));s=await state();check(s.basePower===power&&s.skillInputValue===String(n),'energy '+n+' -> '+power);
  }
  await page.locator('#basePower').fill('6');await page.evaluate(()=>UserConfig.flush());
  check(await page.evaluate(()=>UserConfig.getObject('rk_skill_simulation')['202:35'].energy===6),'manual energy persisted by pair');
  for(const invalid of ['11','-1','2.5','1,2']){await page.locator('#basePower').fill(invalid);check(await page.locator('#basePower').getAttribute('aria-invalid')==='true','invalid energy '+invalid);check((await state()).basePower===166,'invalid energy retains derived value');}
  await page.reload();await ready();s=await state();check(s.skillInputValue==='6'&&s.basePower===166,'reload discards invalid draft, restores energy6');await inject();
  s=await click('彗星');await page.locator('#basePower').fill('77/100');await page.evaluate(()=>UserConfig.flush());s=await state();check(s.basePower===200&&s.skillInputValue==='77/100','comet full-loss bands not continuous194');
  for(const invalid of ['77/','1/0','101/100','-1/100','1/2,3']){await page.locator('#basePower').fill(invalid);check(await page.locator('#basePower').getAttribute('aria-invalid')==='true','invalid ratio '+invalid);check((await state()).basePower===200,'invalid ratio retains state');}
  s=await click('彗星','right');check(s.skillInputValue==='77/100','both comet buttons recover stored ratio');
  s=await click('驱赶');check(s.skillInputKind==='power'&&s.skillInputValue===''&&s.basePower===90,'ordinary skill restores power field');
  await page.locator('#basePower').fill('2^10000');check(await page.locator('#basePower').getAttribute('aria-invalid')==='true','overflow marked invalid');check((await state()).basePower===90,'overflow cannot silently save infinity');
  for(const id of [568,569]){
   await choose(id);s=await click('友谊满溢');check(s.basePowerExpression==='70+90','Garl '+id+' friend fixedleft');s=await click('友谊满溢','right');check(s.basePowerExpression===(id===568?'90+110':'110+130'),'Garl '+id+' friend fixedright');s=await click('试飞','right');check(s.basePower===20&&s.comboCount===2,'Garl '+id+' trial exempt');
  }
  await choose(202);await click('迫近攻击','right');const last=await state();await page.evaluate(()=>UserConfig.flush());
  if(fixture.origins[1]){await page.goto(fixture.origins[1]+'/#/damage');await ready();s=await state();check(s.basePowerExpression===last.basePowerExpression&&s.percentBonus===30,'second origin shares counters/snapshot/percent');}
  check(errors.length===0,'no page errors: '+errors.join(';'));return {passed:checks.length,checks};
 }finally{page.off('pageerror',error);}
}
