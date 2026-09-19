// Deferred browser regression script. NOT run as part of this change.
// Use via playwright-cli run-code in an isolated test browser after parent loads
// js/listing-ui.js after common.js and css/listing-ui.css after style.css.
async page => {
  const checks = [], errors = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const keys = ['xwiki-listing-mode:petdex', 'xwiki-listing-mode:moves'];
  const original = await page.evaluate(keys => ({
    storage: keys.map(key => [key, localStorage.getItem(key)]), hash: location.hash,
    zoom: window.__getPageZoom?.() || 1, theme: document.documentElement.getAttribute('data-theme')
  }), keys);
  // Installed only in this isolated browser; captures active listeners, not add counts.
  await page.addInitScript(() => {
    const records = [], add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
    const watched = new Set(['appstatspreferenceschange','appfontchange','appzoomchange','resize','scroll','pointerdown','keydown','click']);
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if ((this === document || this === window) && watched.has(type) && !records.some(r => r.target === this && r.type === type && r.listener === listener && r.capture === capture(options))) records.push({ target:this, type, listener, capture:capture(options) });
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
      const i = records.findIndex(r => r.target === this && r.type === type && r.listener === listener && r.capture === capture(options));
      if (i >= 0) records.splice(i, 1);
      return remove.call(this, type, listener, options);
    };
    window.__listingListenerCounts = () => Object.fromEntries([...watched].map(type => [type, records.filter(r => r.type === type).length]));
  });
  const go = async route => {
    await page.evaluate(route => { location.hash = '/' + route; }, route);
    await page.waitForSelector(`.listing-controls[data-listing-page="${route}"]`);
  };
  const mode = async value => {
    await page.locator(`[data-listing-mode="${value}"]`).click();
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(1, 1);
    await page.waitForTimeout(100);
  };
  const chooseStyle = async value => {
    await page.locator(`#move-detail-style [data-style="${value}"]`).click();
  };
  const cleanDetails = async () => page.evaluate(() => {
    for (const name of ['move','pet']) {
      const body = document.getElementById(name + '-modal-body');
      CommonUI.destroyWithin(body); body.innerHTML = '';
      document.getElementById(name + '-modal').style.display = 'none';
    }
  });
  try {
    await page.evaluate(keys => { keys.forEach(key => localStorage.removeItem(key)); location.hash = '/petdex'; }, keys);
    await page.reload();
    await page.waitForFunction(() => typeof ListingUI !== 'undefined' && document.querySelector('.listing-controls'));
    await go('petdex');
    check(await page.locator('.listing-controls').getAttribute('data-mode') === 'expanded', 'petdex starts fully expanded');
    const search = page.locator('#petdex-search');
    await search.fill('a.*[');
    check(await page.locator('#pet-tbody tr').count() === 0, 'regex metacharacters remain literal search text');
    for (const value of ['collapsed', 'floating', 'expanded']) {
      await mode(value);
      check(await page.locator('.listing-modes').isVisible(), `dedicated mode entry remains visible in ${value}`);
      check(await search.inputValue() === 'a.*[', `${value} preserves keyword`);
      check(await search.isVisible(), `${value} keeps search permanently visible`);
      if (value !== 'expanded') check(!await page.locator('.listing-filter-panel').isVisible(), `${value} hides only lower conditions`);
    }
    await search.fill('');
    await page.locator('#season-buttons [data-season="S2"]').click();
    const filteredCount = await page.locator('#pet-tbody tr').count();
    await mode('floating');
    const tableBox = await page.locator('#data-table-wrapper').boundingBox();
    await page.locator('[data-listing-mode="floating"]').hover();
    check(await page.locator('.listing-filter-panel').isVisible(), 'hover modes opens lower filters only');
    const openBox = await page.locator('#data-table-wrapper').boundingBox();
    check(Math.abs(openBox.y - tableBox.y) < 1 && Math.abs(openBox.height - tableBox.height) < 1, 'floating panel does not move or resize the list');
    await page.locator('.listing-filter-panel').hover(); await page.waitForTimeout(100);
    check(await page.locator('.listing-filter-panel').isVisible(), 'moving modes to popup keeps it open');
    await page.mouse.move(1, 1); await page.waitForTimeout(100);
    check(!await page.locator('.listing-filter-panel').isVisible(), 'leave closes after 80ms');
    await search.focus();
    check(!await page.locator('.listing-filter-panel').isVisible(), 'keyboard search focus alone does not open popup');
    await search.hover();
    check(await page.locator('.listing-filter-panel').isVisible(), 'search hover opens floating popup');
    await search.click();
    check(await page.locator('.listing-filter-panel').isVisible(), 'search click preserves floating popup');
    await mode('collapsed'); await search.hover();
    check(!await page.locator('.listing-filter-panel').isVisible(), 'collapsed search hover stays closed');
    await mode('floating');
    await page.locator('[data-listing-mode="floating"]').focus(); await page.keyboard.press('Enter');
    check(await page.locator('.listing-filter-panel').isVisible(), 'keyboard mode activation opens filters');
    await page.keyboard.press('Escape'); check(!await page.locator('.listing-filter-panel').isVisible(), 'Escape closes floating layer');
    await go('moves'); check(await page.locator('.listing-controls').getAttribute('data-mode') === 'expanded', 'moves has independent default mode');
    await mode('collapsed'); await go('petdex');
    check(await page.locator('.listing-controls').getAttribute('data-mode') === 'floating', 'petdex mode remembered on route return');
    check(await page.locator('#pet-tbody tr').count() === filteredCount, 'petdex conditions survive routes and mode changes');
    await go('moves'); check(await page.locator('.listing-controls').getAttribute('data-mode') === 'collapsed', 'moves remembers its independent mode');
    await mode('expanded');
    await page.locator('#move-search-input').fill('a.*['); await mode('floating');
    await page.locator('[data-listing-mode="floating"]').hover();
    check(await page.locator('#move-search-input').inputValue() === 'a.*[', 'moves keeps literal keyword outside floating panel');
    await page.locator('#move-search-input').fill('');
    await page.mouse.move(1,1); await page.waitForTimeout(240);

    // Actual CSS zoom used by this app, without invoking settings writes.
    for (const zoom of [.5, 1, 1.5, 2]) {
      for (const theme of ['light','dark']) {
        await page.evaluate(({zoom,theme}) => {
          window.__listingOriginalZoomGetter ||= window.__getPageZoom;
          window.__getPageZoom = () => zoom;
          document.documentElement.style.zoom = zoom;
          document.documentElement.style.setProperty('--page-zoom', zoom);
          document.documentElement.setAttribute('data-theme', theme);
          window.dispatchEvent(new Event('appzoomchange'));
        }, {zoom,theme});
        await page.locator('[data-listing-mode="floating"]').hover();
        check(await page.locator('#move-filter').isVisible(), `floating filters open at zoom ${zoom}/${theme}`);
        check(await page.locator('#move-filter').evaluate(el => {
          const r=el.getBoundingClientRect(); return r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1;
        }), `floating filters stay within viewport at zoom ${zoom}/${theme}`);
        await page.evaluate(()=>window.dispatchEvent(new Event('appzoomchange')));
        check(!await page.locator('#move-filter').isVisible(), 'zoom event closes instead of detaching popup');
        await page.mouse.move(1,1);
      }
    }
    await page.evaluate(() => {
      window.__getPageZoom = window.__listingOriginalZoomGetter;
      const zoom = window.__getPageZoom(); document.documentElement.style.zoom=zoom; document.documentElement.style.setProperty('--page-zoom',zoom);
    });
    await mode('collapsed');
    const fixture = await page.evaluate(() => {
      // Prefer a real legend skill so default-source regression is observable.
      for (const m of RKData.getMonsters()) {
        const skills = RKData.getResolvedWikiData(m)?.skills || [];
        const legend = skills.find(s => s.source === '传说');
        const first = legend || skills[0];
        const extra = skills.find(s => s.name !== first?.name && RKData.getMoves().some(mv=>RKData.getMoveName(mv)===s.name));
        const move = first && RKData.getMoves().find(mv=>RKData.getMoveName(mv)===first.name);
        if (move && extra && legend) return { moveId:move.id, extra:extra.name };
      }
      throw new Error('Need a real legend learner with a second skill for this regression');
    });
    await page.evaluate(id=>MovesPage.showMoveDetail(RKData.getMoves().find(m=>m.id===id)),fixture.moveId);
    const groupSnapshot = () => page.locator('#move-learners-default .move-detail-section').evaluateAll(sections => sections.map(section => ({
      title: section.querySelector('.move-detail-section-title').textContent,
      cards: [...section.querySelectorAll('.move-detail-monster-card')].map(card => ({identity:card.getAttribute('onclick'),name:card.textContent.trim()}))
    })));
    const defaultGroups = await groupSnapshot();
    check(defaultGroups.some(group => group.title.includes('传说技能')), 'default view retains legend learning group');
    check(JSON.stringify(await page.locator('#move-detail-style button').allTextContents()) === JSON.stringify(['默认','表格']), 'adjacent style buttons contain exactly 默认/表格');
    check(await page.locator('.listing-style-menu, .listing-style-trigger').count() === 0, 'old popup menu is removed, not hidden');
    check(await page.locator('#move-detail-style').evaluate(el => {
      const title = document.getElementById('move-learners-title');
      const a = title.getBoundingClientRect(), b = el.getBoundingClientRect();
      return title.parentElement === el.parentElement && b.left >= a.right && Math.abs((a.top+a.bottom)-(b.top+b.bottom)) < 3;
    }), 'style buttons sit immediately right of the learner title, not the skill name');
    await page.locator('#move-detail-style [data-style="table"]').click();
    const table = page.locator('#move-learners-table table');
    check(JSON.stringify(await table.locator('th').allTextContents()) === JSON.stringify(['精灵','属性','生命','物攻','魔攻','物防','魔防','速度','总种族','有效种族']), 'learner table has exact required columns, no source column');
    const allIds = await table.locator('tbody tr').evaluateAll(rows=>rows.map(r=>r.dataset.monsterId));
    check(new Set(allIds).size === allIds.length, 'multiple learning sources never duplicate an ID row');
    for (const key of ['base_hp','base_phy_atk','base_mag_atk','base_phy_def','base_mag_def','base_spd','total','effective']) {
      await table.locator(`button[data-listing-sort="${key}"]`).click();
      const descending=await table.locator(`td[data-stat="${key}"]`).allTextContents();
      check(descending.every((v,i)=>!i || Number(descending[i-1])>=Number(v)),`${key} first click descending`);
      await table.locator(`button[data-listing-sort="${key}"]`).click();
      const ascending=await table.locator(`td[data-stat="${key}"]`).allTextContents();
      check(ascending.every((v,i)=>!i || Number(ascending[i-1])<=Number(v)),`${key} second click ascending`);
    }
    await page.locator('#multi-skill-search').fill(fixture.extra);
    await page.locator('#multi-skill-dropdown [data-skill]').filter({hasText:fixture.extra}).first().click();
    check(await page.locator('#multi-skill-result .listing-monster-table').count()===1, 'intersection uses table style too');
    await page.locator('#multi-skill-result button[data-listing-sort="base_hp"]').click();
    check(await table.locator('th[data-listing-sort="base_hp"]').getAttribute('aria-sort')==='descending', 'intersection and full list share sort direction');
    await chooseStyle('default');
    check(JSON.stringify(await groupSnapshot())===JSON.stringify(defaultGroups), 'default source order is unchanged by table sorts (independent of glossary wrappers)');
    check(await page.locator('#multi-skill-result .move-detail-monster-grid').count()===1, 'default intersection returns to original cards');
    await chooseStyle('table');
    await page.evaluate(()=>{
      window.__listingOriginalEffective=RKData.getEffectiveStats;
      RKData.getEffectiveStats=m=>7777+Number(m.id);
      window.dispatchEvent(new Event('appstatspreferenceschange'));
    });
    check(await table.locator('tbody tr').evaluateAll(rows=>rows.every(r=>Number(r.querySelector('[data-stat="effective"]').textContent)===7777+Number(r.dataset.monsterId))), 'open detail immediately refreshes via RKData helper');
    check(await page.locator('#multi-skill-selected-list .multi-skill-selected-item').count()===1,'preference refresh does not clear intersection');
    check(await page.evaluate(()=>window.__listingListenerCounts().appstatspreferenceschange)===1, 'one shared statistics preference listener');
    await page.evaluate(()=>{RKData.getEffectiveStats=window.__listingOriginalEffective;window.dispatchEvent(new Event('appstatspreferenceschange'));});
    const tile = page.locator('#multi-skill-selected-list button');
    check(await tile.count() === 1 && await tile.locator('img').count() === 1, 'selected tile retains exactly the skill image');
    check(await tile.locator('.multi-skill-selected-remove, .multi-skill-selected-elem-icon').count() === 0, 'selected tile has no X or attribute icon');
    await tile.locator('img').click();
    check(await page.locator('#multi-skill-selected-list button').count() === 0 && await page.locator('#move-modal').isVisible(), 'left click on tile image removes selection without closing/replacing modal');
    await page.locator('#multi-skill-search').fill(fixture.extra);
    await page.locator('#multi-skill-dropdown [data-skill]').filter({hasText:fixture.extra}).first().click();
    await page.locator('#multi-skill-selected-list button').focus(); await page.keyboard.press('Space');
    check(await page.locator('#multi-skill-selected-list button').count() === 0, 'keyboard Space removes the selected tile');
    check(await page.locator('#multi-skill-search').evaluate(el => el === document.activeElement), 'last removed tile restores focus to search');
    await cleanDetails(); await go('moves');
    const baseline=await page.evaluate(()=>window.__listingListenerCounts());
    for(let i=0;i<5;i++) {
      await page.evaluate(id=>MovesPage.showMoveDetail(RKData.getMoves().find(m=>m.id===id)),fixture.moveId);
      await chooseStyle('table'); await cleanDetails();
      await go('petdex'); await page.locator('[data-listing-mode="floating"]').hover(); await go('moves');
    }
    check(JSON.stringify(await page.evaluate(()=>window.__listingListenerCounts()))===JSON.stringify(baseline), 'route/detail redraw cycles do not accumulate global listeners');
    check(await page.locator('body > .listing-filter-floating').count()===0, 'no orphan floating filter portals remain');
    check(errors.length===0,`no page errors: ${errors.join('; ')}`);
    return {passed:checks.length,checks};
  } finally {
    await page.evaluate(original=>{
      if(window.__listingOriginalEffective) RKData.getEffectiveStats=window.__listingOriginalEffective;
      if(window.__listingOriginalZoomGetter) window.__getPageZoom=window.__listingOriginalZoomGetter;
      document.documentElement.style.zoom=original.zoom; document.documentElement.style.setProperty('--page-zoom',original.zoom);
      if(original.theme) document.documentElement.setAttribute('data-theme',original.theme);
      for(const [key,value] of original.storage) { if(value===null) localStorage.removeItem(key); else localStorage.setItem(key,value); }
      location.hash=original.hash;
    },original);
    page.off('pageerror',onError);
  }
}
