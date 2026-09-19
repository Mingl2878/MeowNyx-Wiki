// Parent-only Playwright run-code function. Use a NEW disposable context, never
// attach to an existing browser session. In-memory RKData fixture + DOM zoom only;
// no settings/team API writes, no reset_url invocation, no real profile/native app.
// Harness: window.__damageFixture={origins,reset_url}, __profileOtherOrigin.
async page => {
  const fixture = await page.evaluate(() => window.__damageFixture);
  const origin = await page.evaluate(() => location.origin);
  if (!fixture?.reset_url || !Array.isArray(fixture.origins) || !fixture.origins.includes(origin)) throw Error('Explicit isolated fixture base URL required');
  for (const base of fixture.origins) {
    const response = await page.request.get(base + '/__fixture/info');
    if (!response.ok() || !(await response.json()).isolated) throw Error('Refusing non-isolated fixture');
  }
  const other = await page.evaluate(() => window.__profileOtherOrigin);
  if (other && !fixture.origins.includes(await page.evaluate(value => new URL(value).origin, other))) throw Error('Unrecognized other fixture origin');
  const checks = [], errors = [];
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const viewport = page.viewportSize();
  const saved = await page.evaluate(() => ({hash:location.hash,style:document.documentElement.getAttribute('style'),theme:document.documentElement.getAttribute('data-theme')}));
  const originalTable = '#move-learners-table', intersection = '#multi-skill-result';
  const header = (scope=originalTable) => page.locator(`${scope} [data-listing-priority]`);
  const popup = () => page.locator('.listing-priority-popup');
  const rows = scope => page.locator(`${scope} tbody tr`).evaluateAll(nodes => nodes.map(node=>Number(node.dataset.monsterId)));
  // Glossary decoration wraps text asynchronously. Compare semantic identities,
  // source titles and their ordering, not incidental serialized markup.
  const groups = () => page.locator('#move-learners-default .move-detail-section').evaluateAll(sections=>sections.map(section=>({
    title:section.querySelector('.move-detail-section-title').textContent,
    cards:[...section.querySelectorAll('.move-detail-monster-card')].map(card=>({identity:card.getAttribute('onclick'),name:card.textContent.trim()}))
  })));
  const open = async (scope=originalTable) => {
    try { await header(scope).click({timeout:5000}); }
    catch(error) { throw Error(error.message+'\n'+JSON.stringify(await header(scope).evaluate(el=>{
      const r=el.getBoundingClientRect(),s=getComputedStyle(el),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
      return {zoom:window.__getPageZoom(),viewport:[innerWidth,innerHeight],rect:r.toJSON(),style:{position:s.position,left:s.left,width:s.width},hit:hit?.outerHTML,scrolls:[...document.querySelectorAll('.listing-table-scroll')].map(e=>({left:e.scrollLeft,w:e.clientWidth,sw:e.scrollWidth})),headers:[...el.closest('thead').querySelectorAll('th')].map(e=>({text:e.textContent,rect:e.getBoundingClientRect().toJSON()}))};
    }))); }
    await popup().waitFor({state:'visible'});
  };
  const choose = async (type,scope=originalTable) => { await open(scope); await popup().locator(`[data-priority-type="${type}"]`).click(); };
  const zoom = async value => page.evaluate(value => {
    window.__getPageZoom=()=>value;
    document.documentElement.style.zoom=value;
    document.documentElement.style.setProperty('--page-zoom',value);
    window.dispatchEvent(new Event('appzoomchange'));
  },value);
  let data;
  try {
    await page.evaluate(() => { location.hash='/moves'; });
    await page.waitForSelector('#move-search-input');
    await page.waitForFunction(() => typeof UserConfig === 'undefined' || UserConfig.getStatus().ready);
    await page.setViewportSize({width:1440,height:1000});
    data = await page.evaluate(() => {
      const original = Object.fromEntries(['getMonsters','getMoves','resolveSkillSource','getResolvedWikiData'].map(key=>[key,RKData[key]]));
      const moves = original.getMoves().filter(m=>!['聚能','愿力冲击'].includes(RKData.getMoveName(m))).slice(0,2);
      if (moves.length!==2) throw Error('Two real skill records required');
      const names=moves.map(RKData.getMoveName);
      const monsters=original.getMonsters().slice(0,6).map((m,i)=>({...m,
        is_leader_form:false,evolves_from_id:null,form:'default',
        base_hp:[100,20,80,90,10,80][i],
        main_type:{name:[ 'Water','Fire','Water','Water','Fire','Fire' ][i]},
        sub_type:[2,5].includes(i)?{name:'Fire'}:null,
        learnset_mode:i===3?'inherit':'own'
      }));
      if(monsters.length!==6) throw Error('Six real monster identities required');
      monsters[3].learnset_inherits_from_id=monsters[1].id;
      const skills = [
        [{name:names[0],source:'默认'}],
        [{name:names[0],source:'默认'},{name:names[0],source:'技能石'},{name:names[1],source:'血脉'}],
        [{name:names[0],source:'传说'},{name:names[1],source:'默认'}], [],
        [{name:names[1],source:'默认'}],
        [{name:names[0],source:'血脉'},{name:names[1],source:'默认'}]
      ];
      RKData.getMonsters=()=>monsters;
      RKData.getMoves=()=>moves;
      RKData.resolveSkillSource=m=>{
        const index=monsters.findIndex(item=>item.id===m.id), source=index===3?1:index;
        return {sourceMonster:monsters[source],wiki:{skills:skills[source]}};
      };
      RKData.getResolvedWikiData=m=>RKData.resolveSkillSource(m).wiki;
      const records=[], add=EventTarget.prototype.addEventListener, remove=EventTarget.prototype.removeEventListener;
      const capture=options=>typeof options==='boolean'?options:!!options?.capture;
      const watched=target=>target===document || target===window || target===document.fonts;
      EventTarget.prototype.addEventListener=function(type,fn,options) {
        if(watched(this)&&!records.some(r=>r.target===this&&r.type===type&&r.fn===fn&&r.capture===capture(options))) records.push({target:this,type,fn,capture:capture(options)});
        return add.call(this,type,fn,options);
      };
      EventTarget.prototype.removeEventListener=function(type,fn,options) {
        const i=records.findIndex(r=>r.target===this&&r.type===type&&r.fn===fn&&r.capture===capture(options));
        if(i>=0)records.splice(i,1);
        return remove.call(this,type,fn,options);
      };
      window.__attributeTest={original,zoom:window.__getPageZoom,monsters,snapshot:JSON.stringify(monsters),
        storage:JSON.stringify({...localStorage}),listenerCount:()=>records.length,
        restoreListeners:()=>{EventTarget.prototype.addEventListener=add;EventTarget.prototype.removeEventListener=remove;}};
      MovesPage.showMoveDetail(moves[0]);
      return {ids:monsters.map(m=>Number(m.id)),moveId:moves[0].id,extra:names[1]};
    });
    await zoom(1);
    const defaultGroups = await groups();
    for(const label of ['自学技能','传说技能','血脉学习','技能石']) check(defaultGroups.some(group=>group.title.includes(label)),`source group retained: ${label}`);
    await page.locator('#move-detail-style [data-style="table"]').click();
    const ids = indexes => indexes.map(i=>data.ids[i]);
    await choose('Fire');
    check(same(await rows(originalTable),ids([1,2,5,0])),'pin works before any numeric sort; original source tie order preserved');
    await choose('Fire');
    check(same(await rows(originalTable),ids([0,1,2,5])),'cancel without sort restores original unique source order');
    await page.locator('#multi-skill-search').fill(data.extra);
    await page.locator('#multi-skill-dropdown [data-skill]').filter({hasText:data.extra}).first().click();
    await page.locator(`${originalTable} button[data-listing-sort="base_hp"]`).click();
    check(same(await rows(originalTable),ids([0,2,5,1])),'numeric sort precedes pin; original sources ID-dedup');
    check(same(await rows(intersection),ids([3,2,5,1])),'intersection preserves inherited form and excludes own form lacking skill');
    const baseline=await page.evaluate(()=>window.__attributeTest.listenerCount());
    await open();
    check(await popup().locator('button').count()===18,'exactly 18 native type buttons; no None/Leader');
    check(await popup().locator('[data-priority-type="None"], [data-priority-type="Leader"]').count()===0,'no bloodline-only entries');
    check(await popup().evaluate(el=>{
      const buttons=[...el.querySelectorAll('button')], ys=[...new Set(buttons.map(b=>Math.round(b.getBoundingClientRect().top)))];
      return ys.length===3 && ys.every(y=>buttons.filter(b=>Math.round(b.getBoundingClientRect().top)===y).length===6);
    }),'bloodline-style 3 rows of 6 icons');
    check(await popup().evaluate(el=>Number(getComputedStyle(el).zIndex)>Number(getComputedStyle(document.getElementById('move-modal')).zIndex)),'picker above actual move modal stack');
    await popup().locator('[data-priority-type="Fire"]').click();
    check(same(await rows(originalTable),ids([2,5,1,0])),'main OR secondary matches pinned; tied rows stable; same row set');
    check(same(await rows(intersection),ids([2,5,1,3])),'pin coordinated into intersection');
    for(const scope of [originalTable,intersection]) check(await header(scope).getAttribute('data-listing-priority')==='Fire' && await header(scope).locator('.listing-priority-indicator').count()===1,`${scope}: small active header indication`);
    check(await page.evaluate(()=>document.activeElement===document.querySelector('#move-learners-table [data-listing-priority]')),'selection restores replacement header focus');
    await page.locator(`${intersection} button[data-listing-sort="base_hp"]`).click();
    check(same(await rows(originalTable),ids([1,2,5,0])) && same(await rows(intersection),ids([1,2,5,3])),'intersection numeric ascending sort preserves coordinated pin');
    await choose('Fire',intersection);
    check(same(await rows(originalTable),ids([1,2,5,0])) && same(await rows(intersection),ids([1,2,5,3])),'same-type selection cancels pin without filtering');
    check(await header().getAttribute('data-listing-priority')==='','cancel clears both headers');
    await page.locator(`${originalTable} button[data-listing-sort="base_hp"]`).click();
    check(same(await rows(originalTable),ids([0,2,5,1])),'unpin restores numeric order');
    await choose('Illusion');
    check(same(await rows(originalTable),ids([0,2,5,1])),'absent type pins nothing without dropping rows');
    await choose('Fire');
    await page.locator('#move-detail-style [data-style="default"]').click();
    check(same(await groups(),defaultGroups),'default grouped cards unaffected by pin/sort');
    check(await page.locator('#multi-skill-result .move-detail-monster-card').count()===4,'default intersection remains cards, including inherited identity');
    await page.locator('#move-detail-style [data-style="table"]').click();
    check(await header().getAttribute('data-listing-priority')==='Fire','same detail retains pin through style switch');
    check(await page.evaluate(()=>JSON.stringify(window.__attributeTest.monsters)===window.__attributeTest.snapshot && JSON.stringify({...localStorage})===window.__attributeTest.storage),'no monster type/source or persisted team/bloodline mutation');
    check(!await page.locator('#pet-modal').isVisible(),'type selection never opens monster detail');
    await open(); await page.keyboard.press('Escape');
    check(await popup().count()===0 && await header().evaluate(el=>el===document.activeElement),'Escape closes and restores header focus');
    await header().focus(); await page.keyboard.press('Enter');
    check(await popup().isVisible(),'native Enter opens picker');
    await page.keyboard.press('Space');
    check(await header().getAttribute('data-listing-priority')==='','native Space on selected type cancels');
    for(const event of ['resize','appzoomchange','appfontchange']) {
      await open(); await page.evaluate(event=>window.dispatchEvent(new Event(event)),event);
      check(await popup().count()===0,`${event} closes picker`);
    }
    await open(); await page.evaluate(()=>document.fonts.dispatchEvent(new Event('loadingdone')));
    check(await popup().count()===0,'font loading completion closes picker');
    await open(); await page.locator('.move-detail-skill-name').click();
    check(await popup().count()===0,'outside pointer closes picker');
    await open(); await page.locator('#move-modal-body').evaluate(el=>el.dispatchEvent(new Event('scroll')));
    check(await popup().count()===0,'modal scrolling closes picker');
    await open(); await popup().evaluate(el=>el.dispatchEvent(new Event('scroll')));
    check(await popup().count()===1,'scroll inside picker does not dismiss');
    await page.keyboard.press('Escape');
    // Portal positioning at both horizontal extremes and near bottom. Moving
    // only this header in the isolated DOM also tests transformed modal clipping.
    for(const width of [1440,640,360]) for(const value of [.5,1,1.5,2]) {
      await page.setViewportSize({width,height:1000}); await zoom(value);
      for(const edge of ['left','right']) {
        await header().evaluate((el,edge)=>{
          el.style.position='fixed'; el.style[edge]='10px';
          el.style.top=`${innerHeight*.7/(window.__getPageZoom?.()||1)}px`; el.style.zIndex='1';
        },edge);
        // This artificial fixed-position anchor can overlap neighboring sticky
        // headers; activate via the real keyboard path (pointer clicks were
        // exercised above with normal table geometry).
        await header().focus(); await page.keyboard.press('Enter'); await popup().waitFor({state:'visible'});
        check(await popup().evaluate(el=>{
          const r=el.getBoundingClientRect(); return r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1;
        }),`${width}/${value}/${edge}: popup inside viewport`);
        check(await popup().evaluate(el=>{
          const b=el.querySelector('button').getBoundingClientRect();
          return el.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2));
        }),`${width}/${value}/${edge}: picker hit target above modal`);
        await page.keyboard.press('Escape');
        await header().evaluate(el=>el.removeAttribute('style'));
      }
    }
    await page.setViewportSize({width:1440,height:1000}); await zoom(1);
    for(let i=0;i<8;i++) {
      await open(); await page.evaluate(()=>window.dispatchEvent(new Event('appstatspreferenceschange')));
      check(await popup().count()===0,`rerender ${i}: no orphan popup`);
      check(await page.evaluate(()=>window.__attributeTest.listenerCount())===baseline,`rerender ${i}: no accumulated global/font listeners`);
    }
    await open(); await page.evaluate(()=>document.getElementById('move-modal').style.display='none');
    await popup().waitFor({state:'detached'});
    check(await page.evaluate(()=>window.__attributeTest.listenerCount())===baseline,'modal hide observer disposes all popup listeners');
    await page.evaluate(id=>MovesPage.showMoveDetail(RKData.getMoves().find(m=>m.id===id)),data.moveId);
    check(await header().getAttribute('data-listing-priority')==='','new detail starts unpinned');
    await open(); await page.evaluate(()=>CommonUI.destroyWithin(document.getElementById('move-modal-body')));
    check(await popup().count()===0,'owner destruction removes portal immediately');
    check(errors.length===0,`no page errors: ${errors.join('; ')}`);
    return {passed:checks.length,checks};
  } finally {
    await page.evaluate(saved=>{
      const test=window.__attributeTest;
      if(test) {
        const body=document.getElementById('move-modal-body'); CommonUI.destroyWithin(body); body.innerHTML='';
        document.getElementById('move-modal').style.display='none';
        Object.assign(RKData,test.original); window.__getPageZoom=test.zoom; test.restoreListeners();
        delete window.__attributeTest;
      }
      if(saved.style===null)document.documentElement.removeAttribute('style');else document.documentElement.setAttribute('style',saved.style);
      if(saved.theme===null)document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',saved.theme);
      location.hash=saved.hash;
    },saved);
    if(viewport) await page.setViewportSize(viewport);
    page.off('pageerror',onError);
    // Discard this context. Do not reuse it for parent parallel browser work.
  }
}
