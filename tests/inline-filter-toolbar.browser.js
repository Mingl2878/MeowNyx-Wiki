// Parent-only: run-code against the isolated Go fixture and a disposable browser.
// No native app, real profile, build/sync or settings API calls. This script only
// changes DOM zoom/theme and listing modes in that disposable browser.
// Actual route name for the graphdex consumer is /petdex.
async page => {
  const checks = [], errors = [];
  const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const onError = e => errors.push(e.message);
  page.on('pageerror', onError);
  const originalViewport = page.viewportSize();
  const saved = await page.evaluate(() => ({
    hash: location.hash, style: document.documentElement.getAttribute('style'),
    theme: document.documentElement.getAttribute('data-theme'),
    modes: ['petdex','moves'].map(p => [p, localStorage.getItem('xwiki-listing-mode:' + p)])
  }));
  const go = async route => {
    await page.evaluate(route => { location.hash = '/' + route; }, route);
    await page.waitForSelector(route === 'game-description' ? '.game-description-table' : `.listing-controls[data-listing-page="${route}"]`);
  };
  const mode = async value => {
    // DOM activation intentionally does not steal search focus or terminate IME.
    await page.locator(`[data-listing-mode="${value}"]`).evaluate(el => el.click());
    if (value === 'floating') await page.locator('.listing-modes').hover();
  };
  const blur = async () => { await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(0, 0); };
  const panel = () => page.locator('.listing-filter-panel');
  const zoomTheme = async (zoom, theme) => {
    await page.evaluate(({zoom,theme}) => {
      window.__inlineOriginalZoom ||= window.__getPageZoom;
      window.__getPageZoom = () => zoom;
      document.documentElement.style.zoom = zoom;
      document.documentElement.style.setProperty('--page-zoom', zoom);
      document.documentElement.dataset.theme = theme;
      window.dispatchEvent(new Event('appzoomchange'));
    }, {zoom,theme});
  };
  try {
    await page.setViewportSize({width:1440,height:1000});
    await zoomTheme(1, 'light');
    for (const route of ['petdex', 'moves']) {
      await go(route); await mode('expanded');
      const search = page.locator(route === 'petdex' ? '#petdex-search' : '#move-search-input');
      const results = page.locator(route === 'petdex' ? '#pet-tbody' : '#move-list-container');
      await search.fill('');
      const originalResults = await results.textContent();
      await search.focus();
      await search.evaluate(input => {
        window.__inlineNodes = {
          input, slot: input.closest('.listing-search-slot'), panel: document.querySelector('.listing-filter-panel'),
          filters: [...document.querySelector('.listing-filter-panel').children]
        };
        input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true,data:'未'}));
        input.value = 'inline-trial-no-match.*[';
        input.setSelectionRange(3, 7);
        input.dispatchEvent(new InputEvent('input', {bubbles:true,isComposing:true,data:'未'}));
      });
      for (const value of ['collapsed','floating','expanded']) {
        await mode(value);
        check(await search.isVisible(), `${route}/${value}: original search always visible`);
        check(await page.locator('.listing-modes').isVisible(), `${route}/${value}: all modes always visible`);
        check(await page.evaluate(() => {
          const n = window.__inlineNodes;
          return document.activeElement === n.input && n.input.selectionStart === 3 && n.input.selectionEnd === 7 &&
            document.querySelector('.listing-search-slot') === n.slot && n.slot.contains(n.input) &&
            !n.panel.contains(n.input) && n.filters.every(el => el.parentElement === n.panel) &&
            document.querySelectorAll('.listing-search-slot input').length === 1 &&
            document.querySelector('.listing-toolbar').children.length === 2;
        }), `${route}/${value}: focus, selection, original nodes; no clone/spacer`);
        check(await results.textContent() === originalResults, `${route}/${value}: IME does not prematurely filter`);
      }
      await search.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true,data:input.value})));
      check(await results.textContent() !== originalResults, `${route}: original composition handler still runs`);
      await search.fill('');
      check(await results.textContent() === originalResults, `${route}: original input handler restores results`);
      // Existing condition handlers, including moves' delegated panel listener.
      const condition = page.locator(route === 'petdex' ? '#season-buttons [data-season="S2"]' : '[data-filter-season="S2"]');
      await condition.click();
      // Glossary decoration asynchronously wraps text; compare content and retained row nodes, not incidental HTML.
      const conditionState = await condition.getAttribute('class'), filtered = await results.textContent();
      await results.evaluate(el => window.__inlineResultNodes = [...el.children]);
      await mode('floating');
      check(await page.evaluate(() => {
        const {panel,slot} = window.__inlineNodes;
        return panel.parentElement === document.body && slot.parentElement.classList.contains('listing-toolbar');
      }), `${route}: only lower conditions are portalled`);
      await mode('expanded');
      check(await condition.getAttribute('class') === conditionState && await results.textContent() === filtered &&
        await results.evaluate(el => window.__inlineResultNodes.length === el.children.length && window.__inlineResultNodes.every(n => n.parentNode === el)),
        `${route}: condition values/results unchanged by moving same DOM (no fixed counts)`);
      await condition.click();

      await mode('floating'); await blur(); await page.waitForTimeout(110);
      // Keyboard search focus alone does not force open; pointer search does.
      await page.mouse.click(0,0); await search.focus();
      check(!await panel().isVisible(), `${route}: keyboard search focus alone does not open`);
      await search.hover(); await page.waitForTimeout(100);
      check(await panel().isVisible(), `${route}: search hover opens lower popup`);
      await search.click();
      check(await panel().isVisible(), `${route}: clicking search no longer dismisses popup`);
      await blur(); await page.waitForTimeout(110);
      const blank = await page.locator('.listing-controls').boundingBox();
      await page.mouse.move(blank.x+3, blank.y+3);
      check(await panel().isVisible(), `${route}: permanent header blank padding opens popup`);
      await mode('collapsed'); await search.hover();
      check(!await panel().isVisible(), `${route}: collapsed search hover stays closed`);
      await page.mouse.move(blank.x+3, blank.y+3);
      check(!await panel().isVisible(), `${route}: collapsed blank-space hover stays closed`);
      await mode('floating'); await blur(); await page.waitForTimeout(110);
      await page.locator('[data-listing-mode="floating"]').click();
      await page.mouse.move(0,0); await page.waitForTimeout(110);
      check(!await panel().isVisible(), `${route}: mouse-click focus does not pin popup after pointer leaves`);
      await page.locator('.listing-modes').hover();
      check(await panel().isVisible(), `${route}: modes hover opens popup`);
      const listBox = await results.boundingBox();
      await panel().hover(); await page.waitForTimeout(110);
      check(await panel().isVisible(), `${route}: pointer crosses trigger/popup gap safely`);
      await page.locator('.listing-modes').hover(); await page.waitForTimeout(110);
      check(await panel().isVisible(), `${route}: reverse pointer traversal is safe`);
      await page.mouse.move(0,0); await page.waitForTimeout(110);
      check(!await panel().isVisible(), `${route}: 80ms close delay (before old 200ms)`);
      const afterBox = await results.boundingBox();
      check(Math.abs(listBox.y-afterBox.y)<1, `${route}: popup does not displace listing`);
      const floating = page.locator('[data-listing-mode="floating"]');
      await blur(); // The preceding real mouse click may have left this same button focused.
      await floating.focus();
      check(await panel().isVisible(), `${route}: mode focus opens popup`);
      await page.mouse.move(0,0); await page.waitForTimeout(110);
      check(await panel().isVisible(), `${route}: keyboard focus retains popup after pointer leaves`);
      await page.keyboard.press('Tab');
      check(await panel().evaluate(el => el === document.activeElement || el.contains(document.activeElement)), `${route}: Tab enters lower filters`);
      await page.keyboard.press('Shift+Tab');
      check(await floating.evaluate(el => document.activeElement === el), `${route}: Shift+Tab returns to modes`);
      await page.keyboard.press('Escape');
      check(!await panel().isVisible(), `${route}: Escape closes without immediate focus reopening`);
      await page.keyboard.press('Home');
      check(await page.locator('.listing-controls').getAttribute('data-mode') === 'expanded', `${route}: Home selects expanded`);
      await page.keyboard.press('ArrowRight');
      check(await page.locator('.listing-controls').getAttribute('data-mode') === 'collapsed', `${route}: ArrowRight selects collapsed`);
      await page.keyboard.press('End');
      check(await page.locator('.listing-controls').getAttribute('data-mode') === 'floating', `${route}: End selects floating`);

      for (const width of [1440, 1000, 820, 640]) {
        await page.setViewportSize({width,height:1000});
        for (const zoom of [.5,1,1.5,2]) for (const theme of ['light','dark']) {
          await zoomTheme(zoom,theme);
          await mode('collapsed');
          const layout = await search.evaluate(input => {
            const bar=document.querySelector('.listing-toolbar'), modes=bar.querySelector('.listing-modes');
            const a=input.getBoundingClientRect(), b=modes.getBoundingClientRect(), r=bar.getBoundingClientRect();
            return {width:a.width, center:(a.left+a.right-r.left-r.right)/2, barWidth:r.width,
              inside:a.left>=r.left-1 && b.right<=r.right+1 && a.right<=innerWidth+1,
              separate:a.right<=b.left+1 || a.bottom<=b.top+1,
              children:bar.children.length};
          });
          check(layout.inside && layout.separate && layout.children===2, `${route}/${width}/${zoom}/${theme}: no overlap/overflow/spacer`);
          if (layout.barWidth / zoom >= 780) check(Math.abs(layout.width-400*zoom)<1 && Math.abs(layout.center)<1,
            `${route}/${width}/${zoom}/${theme}: original 400px search centered in card`);
          await mode('floating');
          check(await panel().evaluate(el => {
            const p=el.getBoundingClientRect(), b=document.querySelector('.listing-toolbar').getBoundingClientRect();
            return p.top>=b.bottom && p.left>=0 && p.right<=innerWidth+1 && p.bottom<=innerHeight+1;
          }), `${route}/${width}/${zoom}/${theme}: popup below toolbar and inside viewport`);
        }
      }
      await page.setViewportSize({width:1440,height:1000}); await zoomTheme(1,'light');
    }
    await go('petdex'); await mode('collapsed'); await go('moves'); await mode('floating');
    await go('petdex');
    check(await page.locator('.listing-controls').getAttribute('data-mode')==='collapsed','petdex independent mode memory');
    await go('moves');
    check(await page.locator('.listing-controls').getAttribute('data-mode')==='floating','moves independent mode memory');
    for(let i=0;i<5;i++) {
      await mode('floating');
      await page.locator('.listing-modes').hover();
      await go('game-description');
      check(await page.locator('.listing-controls, .listing-modes, body > .listing-filter-floating').count()===0,
        `route cycle ${i}: no game-description controls or orphan portal`);
      await go(i%2?'moves':'petdex');
    }
    check(errors.length===0, `no page errors: ${errors.join('; ')}`);
    return {passed:checks.length,checks};
  } finally {
    await page.evaluate(saved => {
      if(window.__inlineOriginalZoom) window.__getPageZoom=window.__inlineOriginalZoom;
      if(saved.style===null) document.documentElement.removeAttribute('style'); else document.documentElement.setAttribute('style',saved.style);
      if(saved.theme===null) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme',saved.theme);
      for(const [p,v] of saved.modes) { const k='xwiki-listing-mode:'+p; if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v); }
      delete window.__inlineNodes; delete window.__inlineResultNodes;
      location.hash=saved.hash;
    },saved);
    if(originalViewport) await page.setViewportSize(originalViewport);
    page.off('pageerror',onError);
    // Discard this browser context: ListingUI's in-memory mode cache is intentional.
  }
}
