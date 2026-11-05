// Run only with the parent's isolated browser + temporary profile fixture.
// Settings writes are intercepted; no real user configuration is modified.
async page => {
  const checks = [], errors = [];
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const onError = e => errors.push(e.message); page.on('pageerror', onError);
  const shared = await page.evaluate(async () => await (await fetch('/api/settings')).json());
  Object.assign(shared, { trick_room: false, effective_speed_mode: 'include', effective_include_speed: true, effective_speed_threshold: 80 });
  let reject = false;
  const intercept = async route => {
    if (route.request().method() !== 'POST') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(shared)});
    if (!reject) Object.assign(shared, route.request().postDataJSON());
    return route.fulfill({status:reject?500:200,contentType:'application/json',body:JSON.stringify(reject?{ok:false,error:'trick-room simulated failure'}:{ok:true})});
  };
  await page.route('**/api/settings', intercept);
  const go = async route => { await page.evaluate(r => location.hash='/'+r,route); await page.waitForSelector(route==='settings'?'#set-trick-room':'#petdex-search'); };
  const data = async () => await page.evaluate(() => {
    const raw = RKData.getMonsters().find(m=>RKData.getMonsterName(m)==='音速犬');
    const row = document.querySelector(`#pet-tbody tr[data-id="${raw.id}"]`);
    return { id:raw.id, rawSpeed:raw.base_spd, rawTotal:RKData.getTotalStats(raw), rawEffective:RKData.getEffectiveStats(raw),
      speed:Number(row?.querySelector('[data-stat="base_spd"]')?.textContent),total:Number(row?.querySelector('[data-stat="total"]')?.textContent),effective:Number(row?.querySelector('[data-stat="effective"]')?.textContent)};
  });
  const showDog = async () => {
    await go('petdex');
    await page.evaluate(() => { document.querySelectorAll('.form-btn.active').forEach(b=>b.click()); });
    await page.locator('#petdex-search').fill('音速犬');
    await page.waitForSelector('#pet-tbody tr[data-id]');
  };
  try {
    await page.reload(); await go('petdex');
    const snapshot = await page.evaluate(()=>JSON.stringify(RKData.getMonsters()));
    await showDog(); const original=await data();
    check(original.speed===120&&original.total===542&&original.effective===504,'off: original dog qualifications/total/effective unchanged');
    await go('settings');
    check(!await page.locator('#set-trick-room').isChecked(),'checkbox defaults off');
    check(await page.locator('#set-trick-room').evaluate(el=>el.closest('#set-effective-speed')!==null&&el.parentElement.textContent==='霞光梦境'),'checkbox is next to speed options and labelled 霞光梦境');
    await page.locator('#set-trick-room').check();
    check(await page.evaluate(()=>!AppPreferences.getTrickRoom()&&localStorage.getItem('xwiki-trick-room')==='false'),'checking only changes draft, not live/cache');
    reject=true;await page.locator('#set-save-btn').click();
    await page.waitForFunction(()=>document.querySelector('#settings-result').textContent.includes('保存失败'));
    check(await page.evaluate(()=>!AppPreferences.getTrickRoom()&&localStorage.getItem('xwiki-trick-room')==='false'),'failed backend save preserves runtime and cache');
    await showDog();check((await data()).speed===120,'failed save does not transform rendered petdex');
    reject=false;await go('settings');await page.locator('#set-save-btn').click();
    await page.waitForFunction(()=>AppPreferences.getTrickRoom()===true);
    check(shared.trick_room===true,'successful save persists bool');
    check(await page.evaluate(()=>localStorage.getItem('xwiki-trick-room')==='true'),'successful save updates compatible cache');
    await showDog();const projected=await data();
    check(projected.speed===80&&projected.total===502&&projected.effective===464,'on: dog shows 80 / 502 / 464');
    check(projected.rawSpeed===120&&projected.rawTotal===542&&projected.rawEffective===504,'shared RKData remains raw for other pages');
    check(await page.locator('#pet-table th[data-sort="base_spd"]').textContent()==='速度（梦境）','enabled projection visibly marked in speed heading');
    for(const [mode,e] of [['exclude',384],['threshold',464],['include',464]]) {
      await page.evaluate(mode=>AppPreferences.setEffectiveSpeedPolicy(mode,80,false),mode);
      check((await data()).effective===e,`${mode}: petdex uses displayed speed in effective-stat policy`);
    }
    const id=projected.id;
    await page.locator(`#pet-tbody tr[data-id="${id}"]`).click();
    check(await page.locator('[data-detail-stat="速度"] .detail-stat-val').textContent()==='80','detail opened from petdex projects speed');
    check(await page.locator('[data-detail-stat="速度"] .detail-stat-label').textContent()==='速度（霞光梦境）','detail uses the full dream label without renaming stored trick_room');
    check((await page.locator('.detail-stats-total').textContent()).startsWith('464'),'petdex detail effective sum projected');
    check(await page.evaluate(id=>{
      const m=RKData.getMonsterById(id), pool=RKData.getMonsters().filter(p=>!p.hidden&&(p.evolution_stage==='高级形态'||m.evolution_stage==='首领形态'&&p.evolution_stage==='首领形态'));
      pool.sort((a,b)=>RKData.getEffectiveStats({...b,base_spd:200-b.base_spd})-RKData.getEffectiveStats({...a,base_spd:200-a.base_spd}));
      return document.querySelector('.detail-stats-rank').textContent.trim()===`#${pool.findIndex(p=>p.id===id)+1}/${pool.length}`;
    },id),'detail ranking preserves original stage pool using projected values');
    await page.evaluate(()=>AppPreferences.setTrickRoom(false,false));
    check(await page.locator('[data-detail-stat="速度"] .detail-stat-val').textContent()==='120','live off refreshes open detail without rebuilding skills');
    await page.evaluate(()=>AppPreferences.setTrickRoom(true,false));
    await page.evaluate(id=>PetDexPage.showPetDetail(id),id);
    check(await page.locator('[data-detail-stat="速度"] .detail-stat-val').textContent()==='120','detail invoked by speed/skill learner callers remains raw');
    check((await page.locator('.detail-stats-total').textContent()).startsWith('504'),'non-petdex detail effective values remain raw');
    await page.evaluate(()=>document.getElementById('pet-modal').style.display='none');
    check(await page.evaluate(snapshot=>JSON.stringify(RKData.getMonsters())===snapshot,snapshot),'all catalogue values and nested identities unchanged');
    await page.evaluate(()=>localStorage.setItem('xwiki-trick-room','false'));await page.reload();await showDog();
    check(await page.evaluate(()=>AppPreferences.getTrickRoom()),'reload takes saved server setting over stale local cache');
    check((await data()).speed===80,'reload restores petdex projection');
    await page.locator('#petdex-search').fill('');
    await page.locator('#pet-table th[data-sort="base_spd"]').click();
    check(await page.evaluate(()=>{
      const rows=[...document.querySelectorAll('#pet-tbody tr[data-id]')];const values=rows.map(r=>Number(r.querySelector('[data-stat="base_spd"]').textContent));
      return values.every((v,i)=>!i||values[i-1]>=v);
    }),'speed descending sort uses transformed qualification');
    await go('settings');await page.locator('#set-reset-btn').click();
    await page.waitForFunction(()=>AppPreferences.getTrickRoom()===false);
    check(shared.trick_room===false,'restore application defaults saves false');
    await showDog();check((await data()).total===542,'reset restores original petdex total');
    check(errors.length===0,'no runtime errors');
    return {passed:checks.length,checks};
  } finally {
    page.off('pageerror',onError);
    await page.unroute('**/api/settings',intercept);
    await page.reload();
  }
}
