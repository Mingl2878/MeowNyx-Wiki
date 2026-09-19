// Run only with the parent's disposable Go fixture/browser context. Does not
// write master skills, learnsets, settings or a real personal profile.
async page => {
  const info = await page.request.get(await page.evaluate(() => location.origin) + '/__fixture/info');
  if (!info.ok() || !(await info.json()).isolated) throw Error('Isolated fixture required');
  const checks = [], errors = []; const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const initial = await page.evaluate(() => ({hash:location.hash, moves:JSON.stringify(RKData.getMoves()), wiki:JSON.stringify(RKData.getResolvedWikiData(RKData.getMonsterById(249)))}));
  const goMoves = async () => { await page.evaluate(() => location.hash='/moves'); await page.waitForSelector('#move-search-input'); await page.locator('[data-listing-mode="expanded"]').click(); };
  const pill = (dim, value) => page.locator(`#move-filter [data-filter-${dim}="${value}"]`);
  const displayedIds = () => page.locator('#move-list-container [data-move-id]').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.moveId)));
  const clear = async () => {
    await page.evaluate(() => {
      document.querySelectorAll('#move-filter [data-filter-state="include"]').forEach(el=>el.click());
      document.querySelectorAll('#move-filter [data-filter-state="exclude"]').forEach(el=>el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2})));
      const input=document.querySelector('#move-search-input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelectorAll('#move-filter [data-sort-key].active').forEach(el=>{let n=0;while(el.classList.contains('active')&&n++<3)el.click();});
    });
  };
  const assertState = async (button, state, label) => check(await button.getAttribute('data-filter-state')===state,label);
  const detailCounts = () => page.locator('#pet-modal-body .detail-skill-group').evaluateAll(groups=>groups.map(g=>({title:g.querySelector('.detail-skill-group-title').textContent, total:g.querySelectorAll('.detail-skill-item').length})));
  try {
    await goMoves(); await clear();
    const baseline = await displayedIds(); check(baseline.length>500,'skill baseline populated');
    await pill('type','状态').click({button:'right'});
    await assertState(pill('type','状态'),'exclude','right click excludes status');
    check(await pill('type','状态').isVisible(),'excluded button remains visible');
    check(await pill('type','状态').locator('.filter-exclusion-mark').isVisible(),'visible minus badge');
    check(await pill('type','状态').evaluate(el=>{const p=el.getBoundingClientRect(),m=el.querySelector('.filter-exclusion-mark').getBoundingClientRect();return m.top>=p.top&&m.bottom<=p.bottom&&m.left>=p.left&&m.right<=p.right;}),'exclusion badge stays inside pill and is not clipped by nowrap row');
    check((await pill('type','状态').getAttribute('aria-label')).includes('已排除'),'accessible exclusion label');
    check(await pill('type','状态').evaluate(el=>getComputedStyle(el).textDecorationLine.includes('line-through')),'strike is not color-only');
    check(await page.locator('#move-list-container [data-skill-type="状态"]').count()===0,'status cards excluded');
    await page.locator('#move-search-input').fill('状态');
    check(await page.evaluate(()=>[...document.querySelectorAll('#move-list-container [data-move-id]')].every(el=>{const m=RKData.getMoves().find(m=>m.id===Number(el.dataset.moveId));return m.move_category!=='Status'&&(RKData.getMoveName(m)+RKData.getMoveDesc(m)).includes('状态');})),'plain search and exclusion intersect');
    await page.locator('#move-search-input').fill('');
    await pill('type','状态').click({button:'right'});check(same(await displayedIds(),baseline),'second right restores baseline');
    await pill('type','物攻').click();await pill('type','魔攻').click();
    check(await page.locator('#move-list-container [data-skill-type="物攻"]').count()>0 && await page.locator('#move-list-container [data-skill-type="魔攻"]').count()>0,'type includes OR, not single selection');
    await pill('elem','水').click();
    check(await page.evaluate(()=>[...document.querySelectorAll('#move-list-container [data-move-id]')].every(el=>['物攻','魔攻'].includes(el.dataset.skillType)&&el.dataset.skillElem==='水')),'dimensions AND');
    await pill('type','物攻').click({button:'right'});
    await assertState(pill('type','物攻'),'exclude','include changes directly to exclude');
    check(await page.locator('#move-list-container [data-skill-type="物攻"]').count()===0,'exclude cannot remain included');
    await clear();
    for(const [dim,value] of [['type','状态'],['elem','水'],['energy','10+'],['power','140+'],['season','S1']]) {
      const button=pill(dim,value);await button.focus();await button.press('Shift+Enter');
      await assertState(button,'exclude',`${dim} Shift+Enter excludes`);
      if(dim==='type')check(await button.evaluate(el=>{const s=getComputedStyle(el);return s.outlineStyle==='solid'&&parseFloat(s.outlineWidth)>=2;}),'keyboard focus uses existing theme accent variable');
      await button.press('Shift+Space');await assertState(button,'neutral',`${dim} Shift+Space restores`);
      await button.press('Enter');await assertState(button,'include',`${dim} Enter includes`);
      await button.press('Space');await assertState(button,'neutral',`${dim} Space restores`);
    }
    await pill('energy','10+').click({button:'right'});await pill('power','140+').click({button:'right'});await pill('season','S1').click({button:'right'});
    const ids=await displayedIds(); const expected=await page.evaluate(()=>RKData.getMoves().filter(m=>!['聚能','愿力冲击'].includes(RKData.getMoveName(m))&&!(m.energy_cost!=null&&m.energy_cost>=10)&&!(m.power!=null&&m.power>=140)&&(m.season||'S1')!=='S1').map(m=>m.id));
    check(same(ids,expected),'exclusion union retains original energy/power/season semantics');
    await page.locator('#move-filter [data-sort-key="power"]').click({button:'right'});
    check(same(await displayedIds(),ids),'right sort heading is not exclusion');
    await page.locator('#move-filter [data-sort-key="power"]').click();
    check(await page.evaluate(()=>{const powers=[...document.querySelectorAll('#move-list-container [data-move-id]')].map(el=>RKData.getMoves().find(m=>m.id===Number(el.dataset.moveId)).power||0);return powers.every((v,i)=>!i||powers[i-1]>=v);}), 'sort still works with exclusions');
    await page.evaluate(()=>location.hash='/petdex');await page.waitForSelector('#petdex-search');await goMoves();
    await assertState(pill('season','S1'),'exclude','page switch retains in-memory exclusion');
    await clear();
    // Filtering while deeply scrolled preserves the scroll anchor via a spacer.
    const scroll=page.locator('.move-scroll-wrapper');await scroll.evaluate(el=>el.scrollTop=600);const y=await scroll.evaluate(el=>el.scrollTop);
    await pill('type','状态').click({button:'right'});check(Math.abs(await scroll.evaluate(el=>el.scrollTop)-y)<2,'skill list scroll anchor preserved');await clear();
    await page.locator('[data-listing-mode="floating"]').click();
    await page.locator('#move-search-input').hover();
    await pill('type','状态').click({button:'right'});
    await assertState(pill('type','状态'),'exclude','ported floating pill still excludes');
    await pill('type','状态').click({button:'right'});
    await page.locator('[data-listing-mode="expanded"]').click();
    for(const id of [10,70,376,35]) {
      const card=page.locator(`#move-list-container [data-move-id="${id}"]`);
      check(await card.locator('.detail-skill-power').textContent()==='?',`variable skill ${id} list power stays ?`);
      await page.evaluate(id=>MovesPage.showMoveDetail(RKData.getMoves().find(m=>m.id===id)),id);
      check((await page.locator('#move-modal .move-detail-skill-tag').allTextContents()).includes('?'),`variable skill ${id} detail power stays ?`);
      await page.evaluate(()=>document.getElementById('move-modal').style.display='none');
    }
    // The actual monster modal opts in, not the team/shared default consumer.
    await page.evaluate(()=>PetDexPage.showPetDetail(249));await page.waitForSelector('#pet-modal-body .detail-skill-filter');
    const counts=await detailCounts(), total=await page.locator('#pet-modal-body .detail-skill-item').count();
    const status=page.locator('#pet-modal-body [data-filter-type="状态"]');
    check(await status.count()===1,'real monster has a status filter');
    await status.click({button:'right'});check(await page.locator('#pet-modal').isVisible(),'pill context menu does not close monster modal');
    check(await page.locator('#pet-modal-body .detail-skill-item[data-skill-type="状态"]:visible').count()===0,'monster status skills hidden');
    check(same(await detailCounts(),counts),'source labels and learning counts unchanged');
    check(await page.locator('#pet-modal-body .detail-skill-item').count()===total,'no skill or source row removed');
    await status.press('Enter');await assertState(status,'include','monster keyboard include replaces exclusion');
    check(await page.evaluate(()=>[...document.querySelectorAll('#pet-modal-body .detail-skill-item')].filter(el=>el.style.display!=='none').every(el=>el.dataset.skillType==='状态')),'monster include filters cards');
    await status.press('Space');await assertState(status,'neutral','native Space not double-toggled');
    await page.evaluate(()=>document.querySelectorAll('#pet-modal-body [data-filter-type]').forEach(el=>el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}))));
    check(await page.locator('#pet-modal-body .detail-skill-group:visible').count()===0,'empty source groups collapse');
    check(same(await detailCounts(),counts),'collapsed group counts unchanged');
    await page.evaluate(()=>PetDexPage.showPetDetail(249));
    check(await page.locator('#pet-modal-body .filter-excluded').count()===0,'new monster detail resets exclusions');
    check(await page.locator('#pet-modal-body .detail-skill-item:visible').count()===total,'new detail restores every skill');
    const scrollStable=await page.evaluate(async()=>{
      const body=document.getElementById('pet-modal-body');body.scrollTop=600;const y=body.scrollTop;
      body.querySelectorAll('[data-filter-type]').forEach(el=>el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2})));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return Math.abs(body.scrollTop-y)<2;
    });check(scrollStable,'monster detail retains scroll position even when all source groups collapse');
    check(await page.evaluate(()=>{
      const host=document.createElement('div');host.innerHTML=CommonUI.SkillPicker.renderFilterBar([{type:'状态',element:'水'}]);
      CommonUI.SkillPicker.bindFilterEvents(host);
      const button=host.querySelector('[data-filter-type]');
      const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2});button.dispatchEvent(event);
      return !event.defaultPrevented&&!button.classList.contains('filter-excluded')&&!button.hasAttribute('data-filter-state');
    }),'non-opted shared/team filters remain include-only');
    await page.evaluate(()=>document.getElementById('pet-modal').style.display='none');
    check(await page.evaluate(initial=>JSON.stringify(RKData.getMoves())===initial.moves&&JSON.stringify(RKData.getResolvedWikiData(RKData.getMonsterById(249)))===initial.wiki,initial),'master and resolved learning data unchanged');
    await pill('type','状态').click({button:'right'});
    await page.reload();await page.waitForSelector('#move-search-input');
    await assertState(pill('type','状态'),'neutral','full reload resets temporary exclusions');
    check(same(await displayedIds(),baseline),'reload restores complete skill list with no permanent hidden skills');
    check(errors.length===0,'no page errors');
    return {passed:checks.length,checks};
  } finally {
    await page.evaluate(()=>{for(const id of ['pet-modal','move-modal']){const el=document.getElementById(id);if(el)el.style.display='none';}});
    if(await page.locator('#move-filter').count())await clear();
    await page.evaluate(hash=>location.hash=hash,initial.hash);
    page.off('pageerror',onError);
  }
}
