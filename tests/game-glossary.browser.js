// Integration suite for a disposable browser page served from the project HTTP root.
// Intentionally NOT executed by this change. Parent agent may run after loading integration.
// Compatible with the repository's playwright-cli `run-code` async page => ... convention.
// If integration is not yet loaded, inject only the three new assets into this test page.
async page => {
  const checks = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const viewport = page.viewportSize();
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const term = () => page.locator('#game-glossary-test-host .detail-skill-desc .game-glossary-term').first();
  const popup = () => page.locator('.game-glossary-tooltip');
  try {
    await page.waitForFunction(() => typeof CommonUI !== 'undefined');
    await page.evaluate(() => {
      const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
      const records = [];
      const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
      const test = window.__gameGlossaryTest = {
        records, add, remove, font: document.body.style.fontFamily,
        theme: document.documentElement.getAttribute('data-theme'), parentClicks: 0
      };
      EventTarget.prototype.addEventListener = function (type, fn, options) {
        if ((this === window || this === document) && !records.some(r => r.target === this && r.type === type && r.fn === fn && r.capture === capture(options))) records.push({ target: this, type, fn, capture: capture(options) });
        return add.call(this, type, fn, options);
      };
      EventTarget.prototype.removeEventListener = function (type, fn, options) {
        const i = records.findIndex(r => r.target === this && r.type === type && r.fn === fn && r.capture === capture(options));
        if (i >= 0) records.splice(i, 1);
        return remove.call(this, type, fn, options);
      };
      test.count = () => records.length;
    });
    if (!await page.evaluate(() => !!window.GameGlossary)) await page.addScriptTag({ url: 'js/game-glossary.js' });
    if (!await page.evaluate(() => !!window.GameDescriptionPage)) await page.addScriptTag({ url: 'js/pages/game-description.js' });
    if (!await page.locator('link[href$="game-glossary.css"]').count()) await page.addStyleTag({ url: 'css/game-glossary.css' });
    await page.evaluate(async () => { await Promise.all([GameGlossary.init(), GameGlossary.init()]); });
    const baseline = await page.evaluate(() => window.__gameGlossaryTest.count());
    await page.setViewportSize({ width: 1100, height: 650 });
    await page.evaluate(() => {
      const host = document.createElement('section'); host.id = 'game-glossary-test-host';
      host.style.cssText = 'position:fixed;inset:65px 16px 16px;z-index:10000;overflow:auto;padding:16px;background:var(--bg-card);color:var(--text-primary)';
      document.body.appendChild(host);
      GameDescriptionPage.render(host);
    });
    check(await page.locator('#game-glossary-test-host .game-description-entry').count() === 54, 'page renders all 54 entries');
    check(await page.locator('#game-glossary-test-host button').count() === 0, 'no fake association buttons');
    check(await page.locator('#game-glossary-test-host select, #game-glossary-test-host label').count() === 0, 'no category filter or standalone search label');
    check(JSON.stringify(await page.locator('#game-glossary-test-host thead th').allTextContents()) === JSON.stringify(['名称','类别','属性','效果']), 'table has the four requested columns');
    await page.locator('#game-glossary-test-host input').fill('水系');
    check(JSON.stringify(await page.locator('#game-glossary-test-host .game-description-name').allTextContents()) === JSON.stringify(['湿润印记','雨天']), 'plain search spans category boundaries and attribute/body');
    await page.locator('#game-glossary-test-host input').fill('不存在的词条');
    check(await page.locator('#game-glossary-test-host .game-description-empty').count() === 1, 'empty result is explicit');
    await page.locator('#game-glossary-test-host input').fill('');
    check(await page.locator('#game-glossary-test-host .game-description-list').evaluate(el => {
      el.scrollTop = el.scrollHeight;
      return el.scrollHeight > el.clientHeight && el.scrollTop > 0;
    }), 'all entries are reachable in the scrollable list');

    await page.evaluate(() => {
      const host = document.getElementById('game-glossary-test-host');
      GameDescriptionPage.onLeave(); CommonUI.destroyWithin(host); host.replaceChildren();
      const title = document.createElement('h2'); title.className = 'detail-skill-name'; title.textContent = '中毒印记'; host.append(title);
      for (const selector of GameGlossary.descriptionSelectors) {
        const el = document.createElement('div'); el.className = selector.slice(1);
        el.style.cssText = 'padding:6px;line-height:1.8';
        el.textContent = '<img src=x onerror=alert(1)> 中毒印记 / 中毒 / 印记';
        el.onclick = () => { window.__gameGlossaryTest.parentClicks++; };
        host.append(el);
      }
      const input = document.createElement('textarea'); input.className = 'detail-trait-desc'; input.value = '中毒印记'; host.append(input);
      const editable = document.createElement('div'); editable.className = 'detail-trait-desc'; editable.contentEditable = 'true'; editable.textContent = '中毒印记'; host.append(editable);
      const table = document.createElement('table'); const th = document.createElement('th'); th.className = 'detail-skill-desc'; th.textContent = '中毒印记'; table.append(th); host.append(table);
      const outside = document.createElement('button'); outside.id = 'game-glossary-test-outside'; outside.textContent = '外部按钮'; host.append(outside);
    });
    await page.waitForFunction(() => document.querySelectorAll('#game-glossary-test-host .game-glossary-term').length === 18);
    check(await term().textContent() === '中毒印记', 'longest match wins in dynamically rendered descriptions');
    check(await page.evaluate(() => {
      const host = document.getElementById('game-glossary-test-host');
      const before = host.textContent;
      return GameGlossary.decorate(host) === 0 && GameGlossary.decorate(host) === 0 && host.textContent === before &&
        host.querySelectorAll('img, .game-glossary-term .game-glossary-term, th .game-glossary-term, [contenteditable] .game-glossary-term, .detail-skill-name .game-glossary-term').length === 0 &&
        host.querySelector('textarea').value === '中毒印记';
    }), 'safe literal DOM insertion, idempotence, and name/header/editor exclusions');

    await term().hover(); await popup().waitFor({ state: 'visible' });
    check(await popup().locator('.game-glossary-tooltip-title').textContent() === '中毒印记', 'hover shows the correct term');
    check(await popup().locator('.game-glossary-term').count() === 0, 'tooltip never recursively decorates');
    await popup().hover(); await page.waitForTimeout(260);
    check(await popup().isVisible(), 'pointer can cross into and read the tooltip');
    await page.keyboard.press('Escape');
    check(!await popup().isVisible(), 'Escape dismisses');
    await term().focus(); await popup().waitFor({ state: 'visible' });
    check(await term().getAttribute('aria-describedby') === 'game-glossary-tooltip', 'keyboard focus exposes an accessible description');
    await page.locator('#game-glossary-test-outside').click();
    check(!await popup().isVisible(), 'outside click/focus dismisses without blocking editing');
    await term().click();
    check(await page.evaluate(() => window.__gameGlossaryTest.parentClicks) === 0, 'term click does not open the parent skill or toggle trait');
    await page.keyboard.press('Escape');

    await page.locator('#game-glossary-test-outside').hover();
    await term().hover();
    await page.evaluate(() => document.querySelector('.game-glossary-tooltip').dispatchEvent(new Event('scroll')));
    check(await popup().isVisible(), 'scrolling inside the tooltip remains possible');
    await page.evaluate(() => document.getElementById('game-glossary-test-host').dispatchEvent(new Event('scroll')));
    check(!await popup().isVisible(), 'outside scroll dismisses the anchored layer');
    // Moving out first guarantees a fresh pointerover after a dismissal.
    const reopen = async () => { await page.locator('#game-glossary-test-outside').hover(); await term().hover(); await popup().waitFor({ state: 'visible' }); };
    await reopen(); await page.evaluate(() => window.dispatchEvent(new Event('appzoomchange')));
    check(!await popup().isVisible(), 'application zoom changes dismiss');
    await reopen(); await page.setViewportSize({ width: 1000, height: 600 });
    await popup().waitFor({ state: 'hidden' });
    check(!await popup().isVisible(), 'window resize dismisses');
    await reopen();
    check(await popup().evaluate(el => Number(getComputedStyle(el).zIndex) > 10000 && Number(getComputedStyle(el).zIndex) < 99999), 'tooltip is above detail/picker and below edit/confirm overlays');
    await page.evaluate(() => {
      const layer = document.querySelector('.game-glossary-tooltip');
      layer.querySelector('.game-glossary-tooltip-body').textContent = '超长正文，中毒印记。'.repeat(600);
      CommonUI.positionAnchoredLayer(document.querySelector('#game-glossary-test-host .game-glossary-term'), layer);
    });
    check(await popup().evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && el.scrollHeight > el.clientHeight;
    }), 'long content clamps to viewport and is internally scrollable');
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.body.style.fontFamily = 'monospace'; });
    check(await popup().evaluate(el => getComputedStyle(el).fontFamily === getComputedStyle(document.body).fontFamily && getComputedStyle(el).backgroundColor === getComputedStyle(document.getElementById('game-glossary-test-host')).backgroundColor), 'tooltip follows application theme and font');
    await page.evaluate(() => {
      const overlay = document.createElement('div'); overlay.className = 'cui-popup-overlay'; overlay.id = 'game-glossary-test-editor'; document.body.append(overlay);
    });
    await popup().waitFor({ state: 'hidden' });
    check(true, 'opening an edit/confirm overlay closes the glossary');
    await page.evaluate(() => document.getElementById('game-glossary-test-editor').remove());
    await reopen();
    await term().evaluate(el => { el.style.display = 'none'; });
    await popup().waitFor({ state: 'hidden' }); check(true, 'hidden anchor dismisses');
    await page.evaluate(() => document.querySelector('#game-glossary-test-host .game-glossary-term').style.removeProperty('display'));
    await reopen(); await term().evaluate(el => el.remove());
    await popup().waitFor({ state: 'hidden' }); check(true, 'removed anchor dismisses and cleans anchored listeners');

    await page.evaluate(async () => {
      const host = document.getElementById('game-glossary-test-host');
      for (let i = 0; i < 8; i++) {
        const el = document.createElement('div'); el.className = 'detail-skill-desc'; el.textContent = '中毒印记'; host.replaceChildren(el);
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        GameGlossary.decorate(host); await GameGlossary.init();
      }
    });
    await page.waitForFunction(expected => window.__gameGlossaryTest.count() === expected, baseline);
    check(true, 're-renders/init calls do not accumulate global listeners');
    check(errors.length === 0, `no runtime errors: ${errors.join('; ')}`);
    return { passed: checks.length, checks, note: 'Standalone fixture; parent still owns route/navigation loading integration.' };
  } finally {
    await page.evaluate(() => {
      window.GameGlossary?.close(); window.GameDescriptionPage?.onLeave();
      const host = document.getElementById('game-glossary-test-host');
      if (host) { CommonUI.destroyWithin(host); host.remove(); }
      document.getElementById('game-glossary-test-editor')?.remove();
      const test = window.__gameGlossaryTest;
      if (test) {
        EventTarget.prototype.addEventListener = test.add; EventTarget.prototype.removeEventListener = test.remove;
        document.body.style.fontFamily = test.font;
        if (test.theme == null) document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', test.theme);
        delete window.__gameGlossaryTest;
      }
    });
    if (viewport) await page.setViewportSize(viewport);
    page.off('pageerror', onError);
  }
}
