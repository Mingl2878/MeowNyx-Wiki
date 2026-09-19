// Deferred browser regression. NOT run as part of the authorized Node-only change.
// Run through playwright-cli run-code in a disposable context after the parent loads
// css/team-speed-features.css and integrates RKData stats preferences / dual resistance.
// Never use the user's regular browser profile. No screenshots/builds/data files are written.
async page => {
  const checks = [], errors = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const originalViewport = page.viewportSize();
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const saved = await page.evaluate(() => ({ hash: location.hash, storage: { ...localStorage } }));
  const windowRoute = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ maximized: true }) });
  await page.route('**/api/window/state', windowRoute);
  await page.addInitScript(() => {
    const watched = new Set(['resize', 'appzoomchange', 'appfontchange', 'appstatspreferenceschange', 'loadingdone']);
    const records = [];
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (watched.has(type) && (this === window || this === document || this === document.fonts) &&
        !records.some(r => r.target === this && r.type === type && r.listener === listener && r.capture === capture(options))) {
        records.push({ target: this, type, listener, capture: capture(options) });
      }
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
      const index = records.findIndex(r => r.target === this && r.type === type && r.listener === listener && r.capture === capture(options));
      if (index >= 0) records.splice(index, 1);
      return remove.call(this, type, listener, options);
    };
    window.__teamSpeedListeners = () => Object.fromEntries([...watched].map(type => [type, records.filter(r => r.type === type).length]));
  });
  const settle = () => page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const go = async route => {
    await page.evaluate(route => { location.hash = '/' + route; }, route);
    await page.waitForSelector(route === 'team' ? '#team-search' : '#speed-tier-table', { state: 'attached' });
    await settle();
  };
  const assertOffense = async label => {
    const result = await page.evaluate(() => {
      const config = JSON.parse(localStorage.getItem('rk_team_config'));
      const group = config.groups.find(g => g.id === config.activeGroupId);
      const moves = new Map(RKData.getMoves().map(m => [m.localized?.zh?.name, m]));
      const entries = [...new Set(group.team.filter(Boolean))].map(id => {
        const types = new Set((group.petSkills[id] || []).map(name => moves.get(name)).filter(RKData.isAttackMove).map(m => m.move_type?.name).filter(t => RKData.PILL_ORDER.includes(t)));
        return [...types];
      });
      const problems = [];
      for (const target of RKData.PILL_ORDER) {
        const effects = entries.map(types => types.map(type => RKData.getTypeEff(type, target)));
        const strong = effects.filter(values => values.some(v => v >= 2)).length;
        const resisted = effects.filter(values => !values.some(v => v >= 2) && values.some(v => v <= .5)).length;
        for (const [mode, value] of [['attack-strong', strong], ['attack-resisted', resisted], ['attack-net', strong - resisted]]) {
          const item = document.querySelector(`[data-summary="${mode}"] [data-type="${target}"]`);
          if (!item || Number(item.querySelector('.team-defense-score').textContent.replace('×', '')) !== value) problems.push(mode + ':' + target);
          if (mode === 'attack-net' && value !== 0 && !item.classList.contains(value > 0 ? 'attack-positive' : 'attack-risk')) problems.push('sign:' + target);
        }
      }
      return { problems, count: document.querySelectorAll('.team-attack-summary [data-type]').length };
    });
    check(result.count === 54 && result.problems.length === 0, label + ': all three 18-type summaries match carried master attacks');
  };
  const assertCapacity = async label => {
    const result = await page.evaluate(() => {
      const problems = [], capacities = [];
      for (const strip of document.querySelectorAll('.speed-avatar-strip')) {
        const width = parseFloat(getComputedStyle(strip).width);
        const capacity = Number(strip.dataset.capacity);
        capacities.push(capacity);
        if (capacity !== Math.max(0, Math.floor(width / 34))) problems.push('capacity');
        const avatars = [...strip.querySelectorAll('.speed-tier-avatar')];
        if (avatars.length > capacity || avatars.length * 34 > width + .01) problems.push('overflow');
        for (const avatar of avatars) {
          const style = getComputedStyle(avatar);
          if (Math.abs(parseFloat(style.width) - 32) > .05 || Math.abs(parseFloat(style.marginLeft) + parseFloat(style.marginRight) - 2) > .05) problems.push('crushed avatar: '+style.width);
        }
      }
      return { problems, max: Math.max(0, ...capacities) };
    });
    check(result.problems.length === 0, label + ': actual unscaled column capacity, no squeezed/overflowing avatars '+JSON.stringify(result.problems.slice(0,3)));
    return result.max;
  };
  try {
    const fixture = await page.evaluate(() => {
      const all = RKData.getMonsters(), moves = new Map(RKData.getMoves().map(m => [m.localized?.zh?.name, m]));
      for (const m of all.filter(m => m.evolution_stage === '高级形态' && !m.hidden && !m.is_leader_form)) {
        const leader = all.find(l => l.is_leader_form && l.dex_number === m.dex_number);
        if (!leader) continue;
        const learned = (RKData.getResolvedWikiData(m)?.skills || []).filter(s => s.source !== '血脉').map(s => moves.get(s.name)).filter(RKData.isAttackMove);
        const groups = new Map();
        for (const move of learned) {
          const type = move.move_type?.name;
          if (!RKData.PILL_ORDER.includes(type)) continue;
          if (!groups.has(type)) groups.set(type, []);
          if (!groups.get(type).includes(move)) groups.get(type).push(move);
        }
        const sameType = [...groups.values()].find(g => g.length >= 2);
        const other = sameType && learned.find(move => move.move_type?.name !== sameType[0].move_type?.name);
        if (!sameType || !other) continue;
        const partner = all.find(p => p.id !== m.id && !p.hidden && !p.is_leader_form && p.evolution_stage === '高级形态');
        const names = [sameType[0], sameType[1], other].map(move => move.localized.zh.name);
        const group = { id: 'team-speed-test', name: 'team-speed test', team: [m.id, partner.id], selectedDetailId: m.id, petSkills: { [m.id]: names, [partner.id]: [names[0]] }, petNatures: {}, petIVs: {}, detailBloodline: {}, leaderFormId: {} };
        localStorage.setItem('rk_team_config', JSON.stringify({ groups: [group], activeGroupId: group.id }));
        localStorage.setItem('xwiki-theme', 'light');
        location.hash = '/team';
        return { id: m.id, partner: partner.id, leader: leader.id, names };
      }
      throw new Error('No suitable master-data team fixture');
    });
    await page.reload();
    await page.waitForSelector('.team-attack-summary');
    await settle();
    check(await page.locator('.team-attack-summary .attack-positive').first().evaluate(el => getComputedStyle(el).color) === 'rgb(21, 128, 61)', 'new stylesheet is loaded and positive offense is green');
    await assertOffense('initial duplicate/type/member fixture');
    await page.locator('.detail-skill-slot:has(.detail-skill-slot-remove[data-slot="0"])').hover();
    await page.locator('.detail-skill-slot-remove[data-slot="0"]').click();
    await assertOffense('skill removed from slot');
    await page.locator('#detail-pet-img-clickable').click();
    await page.evaluate(name => {
      const item = [...document.querySelectorAll('#team-skill-picker-modal .detail-skill-item')].find(el => el.dataset.skillName === name);
      if (!item || item.classList.contains('skill-disabled')) throw new Error('Fixture attack unexpectedly unavailable');
      item.click();
    }, fixture.names[0]);
    await assertOffense('skill equipped while picker remains open');
    const stats = await page.evaluate(() => {
      const total = document.querySelector('#team-skill-picker-modal .detail-stats-total');
      const body = document.querySelector('.team-skill-picker-body');
      body.scrollTop = 100;
      const scroll = body.scrollTop;
      const original = RKData.getEffectiveStats;
      try {
        RKData.getEffectiveStats = m => original(m) - (m.base_spd || 0);
        window.dispatchEvent(new Event('appstatspreferenceschange'));
        const modal = document.getElementById('team-skill-picker-modal'), id = Number(modal.dataset.petId);
        const pool = RKData.getMonsters();
        const rank = [...pool].sort((a, b) => RKData.getEffectiveStats(b) - RKData.getEffectiveStats(a)).findIndex(m => m.id === id) + 1;
        return total.textContent === `${RKData.getEffectiveStats(RKData.getMonsterById(id))}#${rank}/${pool.length}` && body.scrollTop === scroll;
      } finally { RKData.getEffectiveStats = original; window.dispatchEvent(new Event('appstatspreferenceschange')); }
    });
    check(stats, 'stats preference event updates open ranking in-place, retains full ranking pool and picker scroll');
    await page.locator('#team-skill-picker-done').click();
    await page.locator('#bloodline-btn').click();
    await page.locator('.bloodline-hdropdown-item[data-value="Leader"]').click();
    await page.locator('#leader-form-trigger').click();
    await page.locator(`.leader-form-dropdown-item[data-lf-id="${fixture.leader}"]`).click();
    await assertOffense('leader form switch');
    check(await page.evaluate(id => {
      const name = RKData.getMonsterDisplayName(RKData.getMonsterById(id));
      return [...document.querySelectorAll('.team-attack-summary [title]')].some(el => el.title.includes(name));
    }, fixture.leader), 'tooltip sources use current leader-form identity');
    await page.locator(`.team-slot[data-pet-id="${fixture.partner}"]`).click({ button: 'right' });
    await assertOffense('member removed');
    await page.locator('#team-reset-btn').click();
    await assertOffense('team reset');
    await page.locator('#team-reset-btn').click();
    await assertOffense('team restored');

    await go('speed');
    const capacities = [];
    for (const width of [1920, 1280, 960, 720, 420]) {
      await page.setViewportSize({ width, height: 900 });
      for (const zoom of [.7, 1, 1.5]) {
        await page.evaluate(zoom => AppPreferences.setMaxZoom(zoom), zoom);
        await page.waitForFunction(zoom => window.__getPageZoom() === zoom, zoom);
        await settle();
        capacities.push(await assertCapacity(`width ${width}, zoom ${zoom}`));
      }
    }
    check(Math.max(...capacities) > 13 && new Set(capacities).size > 2, 'capacity is continuous with layout, not a fixed 7/13 rule');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      AppPreferences.setMaxZoom(1);
      document.querySelector('.speed-responsive').style.fontFamily = 'monospace';
      window.dispatchEvent(new Event('appfontchange'));
    });
    await settle();
    await assertCapacity('font change');
    for (const id of ['tier-negnature-btn', 'tier-iv-btn', 'tier-nature-btn', 'tier-monsters-btn', 'tier-monsters-btn', 'tier-nature-btn', 'tier-iv-btn', 'tier-negnature-btn']) {
      await page.locator('#' + id).click();
      await settle();
      await assertCapacity('toggle ' + id);
    }
    const stable = await page.evaluate(async () => {
      const table = document.getElementById('speed-tier-table'), first = table.firstChild;
      let mutations = 0;
      const observer = new MutationObserver(records => { mutations += records.length; });
      observer.observe(table, { childList: true, subtree: true });
      for (const type of ['resize', 'appfontchange', 'appzoomchange']) window.dispatchEvent(new Event(type));
      await new Promise(resolve => setTimeout(resolve, 120));
      observer.disconnect();
      return table.firstChild === first && mutations === 0;
    });
    check(stable, 'unchanged layout events neither rebuild the table nor trigger an avatar redraw loop');
    const excluded = await page.evaluate(() => {
      const pet = RKData.getMonsters().find(m => !m.hidden && m.base_spd && m.base_spd < 40);
      return { id: pet.id, name: RKData.getMonsterDisplayName(pet) };
    });
    await page.locator('#tier-search').scrollIntoViewIfNeeded(); await settle();
    await page.locator('#tier-search').fill(excluded.name);
    const excludedOption = page.locator(`.autocomplete-item[data-monster-id="${excluded.id}"]`);
    if (await excludedOption.isVisible()) await excludedOption.click(); // exact-name selection may already have rebuilt the row
    await settle();
    check(await page.locator(`tr.tier-highlight .speed-tier-avatar[data-pet-id="${excluded.id}"]`).count() === 1, 'search injects a filtered-out speed/pet ahead of viewport slicing');
    const variant = await page.evaluate(() => {
      const pet = RKData.getMonsters().find(m => !m.hidden && m.form_category === '变体形态' && m.base_spd);
      return { id: pet.id, name: RKData.getMonsterDisplayName(pet) };
    });
    await page.locator('#tier-search').scrollIntoViewIfNeeded(); await settle();
    await page.locator('#tier-search').fill(variant.name);
    const variantOption = page.locator(`.autocomplete-item[data-monster-id="${variant.id}"]`);
    if (await variantOption.isVisible()) await variantOption.click();
    await settle();
    check(await page.locator(`tr.tier-highlight .speed-tier-avatar[data-pet-id="${variant.id}"]`).count() === 1, 'searched variant remains visible with form override and priority');
    const before = await page.evaluate(() => window.__teamSpeedListeners());
    for (let i = 0; i < 4; i++) { await go('team'); await go('speed'); }
    check(JSON.stringify(await page.evaluate(() => window.__teamSpeedListeners())) === JSON.stringify(before), 'route re-entry does not accumulate window/font/preference listeners');
    await assertCapacity('re-entry');
    check(await page.locator(`tr.tier-highlight .speed-tier-avatar[data-pet-id="${variant.id}"]`).count() === 1, 'search/form selection survives leaving and re-entering speed page');
    check(errors.length === 0, 'no browser runtime errors');
    return { checks };
  } finally {
    page.off('pageerror', onError);
    await page.unroute('**/api/window/state', windowRoute);
    await page.evaluate(saved => {
      localStorage.clear();
      for (const [key, value] of Object.entries(saved.storage)) localStorage.setItem(key, value);
      location.hash = saved.hash;
    }, saved);
    if (originalViewport) await page.setViewportSize(originalViewport);
    await page.reload();
  }
}
