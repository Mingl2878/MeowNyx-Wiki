// Isolated browser + read-only server. /__layout/before.css is the pre-fix CSS with the 15px regression.
async page => {
  const checks = [], cases = [], errors = [];
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const viewport = page.viewportSize();
  const css = {};
  for (const [name, relative] of Object.entries({ before: '/__layout/before.css', current: 'css/style.css' })) {
    const response = await page.request.get(await page.evaluate(r => new URL(r, location.href).href, relative));
    if (!response.ok()) throw new Error(`Missing CSS reference: ${relative}`);
    // Linked CSS strips a UTF-8 BOM; inline style text must do the same or :root will not match.
    css[name] = (await response.text()).replace(/^\uFEFF/, '');
  }
  await page.evaluate(() => { location.hash = '/damage'; });
  await page.waitForSelector('#basePower');
  for (const side of ['attacker', 'defender']) {
    const input = page.locator(`#${side}-search-slot input`);
    await input.fill(''); await input.fill('智辉章脑');
  }
  await page.waitForFunction(() => DamagePage.getState().atkPet?.id === 602 && DamagePage.getState().defPet?.id === 602);
  const saved = await page.evaluate(() => {
    const saved = { zoom: AppPreferences.getMaxZoom(), theme: document.documentElement.dataset.theme, font: document.documentElement.style.getPropertyValue('--app-font-family'), bodyFont: document.body.style.fontFamily };
    document.querySelector('link[href*="css/style.css"]').disabled = true;
    const style = document.createElement('style'); style.id = 'dual-header-css'; document.head.appendChild(style);
    const stable = document.createElement('style'); stable.id = 'dual-header-stable'; stable.textContent = '* { animation: none !important; transition: none !important; }'; document.head.appendChild(stable);
    const probe = document.createElement('div'); probe.id = 'dual-header-probe'; probe.style.cssText = 'position:fixed;left:-10000px;';
    probe.innerHTML = `<div class="detail-attr-header">${CommonUI.StatBox.buildModeRadio('dual-probe')}</div>`;
    document.body.appendChild(probe);
    return saved;
  });
  const apply = name => page.evaluate(text => { document.getElementById('dual-header-css').textContent = text; }, css[name]);
  const measure = () => page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = (node, anchor) => {
      const r = node.getBoundingClientRect(), a = anchor.getBoundingClientRect();
      return [r.left - a.left, r.top - a.top, r.width, r.height];
    };
    const geometry = selector => [...document.querySelectorAll(selector)].map(e => rect(e, e.closest('.card')));
    return {
      headers: [...document.querySelectorAll('.stats-header-with-button')].map(e => {
        const mode = e.querySelector('.stats-title-row'), types = e.querySelector('.type-container'), radio = e.querySelector('.radio-group');
        const a = mode.getBoundingClientRect(), b = types.getBoundingClientRect(), r = e.getBoundingClientRect();
        const badges = [...types.querySelectorAll('.type-badge')].map(n => n.getBoundingClientRect());
        const scale = r.width / parseFloat(getComputedStyle(e).width);
        return {
          gap: getComputedStyle(radio).gap, width: r.width, modeWidth: a.width,
          required: a.width + b.width + parseFloat(getComputedStyle(e).columnGap) * scale,
          sameLine: Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) < .2,
          twoBadges: badges.length === 2,
          badgesInRow: badges.length === 2 && Math.abs(badges[0].top - badges[1].top) < .2,
          contained: a.left >= r.left - .2 && a.right <= b.left + .2 && b.right <= r.right + .2
            && badges.every(n => n.left >= b.left - .2 && n.right <= b.right + .2),
          font: getComputedStyle(radio).fontFamily,
          diagnostic: { viewport: innerWidth, zoom: AppPreferences.getZoom(), types: b.width, label: types.querySelector('label').getBoundingClientRect().width, badges: badges.map(r=>r.width), parents: [e.closest('.card-body'),e.closest('.card'),e.closest('.calc-col'),e.closest('.main-content'),e.closest('.container')].map(n=>[getComputedStyle(n).width,getComputedStyle(n).padding,getComputedStyle(n).borderWidth]) }
        };
      }),
      unaffected: {
        search: geometry('.attacker-card .card-header, .defender-card .card-header, .card-header .search-bar'),
        skill: geometry('.skill-card .input-group, .skill-type-row, .skill-card .modifiers'),
        stats: [...document.querySelectorAll('.final-stat-item')].map(e => rect(e, e.closest('.final-stats-grid'))),
        defaultGap: getComputedStyle(document.querySelector('.skill-type-row .radio-group')).gap,
        otherPageModeGap: getComputedStyle(document.querySelector('#dual-header-probe .radio-group')).gap
      }
    };
  });
  const close = (a, b) => typeof a === 'number' ? typeof b === 'number' && Math.abs(a - b) < .2
    : a && typeof a === 'object' ? b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => close(a[k], b[k])) : a === b;
  const valid = measurement => measurement.headers.length === 2 && measurement.headers.every(h => h.gap === '10px' && h.sameLine && h.twoBadges && h.badgesInRow && h.contained);
  let boundaryHeaders;
  try {
    await page.evaluate(() => AppPreferences.setMaxZoom(1));
    await apply('current');
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.attacker-card')).borderTopWidth === '1px'
      && getComputedStyle(document.documentElement).getPropertyValue('--nav-height').trim() === '52px'
      && !!getComputedStyle(document.documentElement).getPropertyValue('--border').trim()), 'inline comparison CSS preserves root variables and the real card border');
    for (const font of ['system-ui, sans-serif', '"Microsoft YaHei", sans-serif']) {
      await page.evaluate(f => { document.documentElement.style.setProperty('--app-font-family', f); document.body.style.fontFamily = f; }, font);
      await page.evaluate(() => document.fonts.ready);
      for (const [width, height, zoom] of [[1920,1080,1],[1280,900,1],[1600,1000,1.25],[1920,1080,1.5],[1280,900,.8]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(z => AppPreferences.setMaxZoom(z), zoom);
        await apply('before'); const before = await measure();
        await apply('current'); const current = await measure();
        const label = `${font}, ${width}x${height} @ ${zoom * 100}%`;
        check(valid(current), `${label}: both dual-type headers, badges and controls fit on one line`);
        check(close(before.unaffected, current.unaffected), `${label}: searches, skill fields, stat grid and other radio groups unchanged`);
        cases.push(label);
      }
      // Derive a real viewport at the original wrapping boundary; do not resize cards or force nowrap.
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() => AppPreferences.setMaxZoom(1));
      await apply('current'); const baseline = await measure();
      const h = baseline.headers[0];
      const width = Math.round(1280 + 3 * (h.required + 2.5 - h.width));
      await page.setViewportSize({ width, height: 900 });
      await apply('before'); const broken = await measure();
      check(broken.headers.every(h => h.gap === '15px' && !h.sameLine), `${font}, width=${width}: original 15px regression reproduced on both sides`);
      await apply('current'); const fixed = await measure();
      boundaryHeaders = fixed.headers;
      check(valid(fixed), `${font}, width=${width}: same viewport fits after compact-gap fix`);
      check(close(broken.unaffected, fixed.unaffected), `${font}, width=${width}: boundary fix does not rearrange other components`);
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      for (const mode of ['base', 'final']) {
        await page.locator(`input[name="atkStatMode"][value="${mode}"]`).check();
        await page.locator(`input[name="defStatMode"][value="${mode}"]`).check();
        const snapshot = await measure();
        check(valid(snapshot), `${theme}/${mode}: dual-type header stays on one line${valid(snapshot) ? '' : ' ' + JSON.stringify({before: boundaryHeaders, after: snapshot.headers})}`);
      }
    }
    check(await page.evaluate(() => {
      const rules = [...document.getElementById('dual-header-css').sheet.cssRules].filter(r => r.selectorText && r.style);
      return [...document.querySelectorAll('.stats-title-row .radio-group')].every(e => {
        const matching = rules.filter(r => e.matches(r.selectorText));
        return matching.filter(r => r.style.getPropertyValue('gap')).length === 1
          && matching.filter(r => r.style.getPropertyValue('--radio-group-gap')).length === 1;
      });
    }), 'one gap definition and one scoped parameter, no competing or hidden gap rules');
    const parameter = css.current.match(/\.stats-title-row \.stat-mode-group\s*\{[^}]*\}/)?.[0];
    check(!!parameter, 'compact parameter has one explicit component owner');
    const withoutParameter = css.current.replace(parameter, '');
    for (const text of [parameter + '\n' + withoutParameter, withoutParameter + '\n' + parameter]) {
      await page.evaluate(s => { document.getElementById('dual-header-css').textContent = s; }, text);
      check(valid(await measure()), 'moving the parameter before or after shared styles cannot change header spacing');
    }
    check(errors.length === 0, 'no browser runtime errors');
    return { passed: checks.length, checks, cases };
  } finally {
    page.off('pageerror', onError);
    await page.evaluate(s => {
      document.querySelector('link[href*="css/style.css"]').disabled = false;
      for (const id of ['dual-header-css', 'dual-header-stable', 'dual-header-probe']) document.getElementById(id)?.remove();
      document.documentElement.dataset.theme = s.theme;
      if (s.font) document.documentElement.style.setProperty('--app-font-family', s.font);
      else document.documentElement.style.removeProperty('--app-font-family');
      document.body.style.fontFamily = s.bodyFont;
      AppPreferences.setMaxZoom(s.zoom);
    }, saved);
    if (viewport) await page.setViewportSize(viewport);
  }
}
