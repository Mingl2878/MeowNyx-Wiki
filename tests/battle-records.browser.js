async page => {
  // Execute with the existing isolated browser fixture, NEVER a real user profile.
  // All /api/battles traffic is intercepted in this window; no actual DB, import,
  // relay, inference writes, capture or UserConfig mutation is performed.
  const origin = page.url().split('/').slice(0,3).join('/');
  const info = await (await page.request.get(origin + '/__fixture/info')).json();
  if (info.isolated !== true) throw Error('Isolated fixture required');
  const checks = [], errors = [], check = (value, label) => { if (!value) throw Error(label); checks.push(label); };
  const onError = error => errors.push(error.message); page.on('pageerror', onError);
  const viewport = page.viewportSize();
  await page.evaluate(() => {
    const original = { fetch: window.fetch, inference: window.BattleRecordsClient.renderInference, useRecord: window.BattleRecordsClient.useRecord, hash: location.hash };
    const f = window.__battleRecordsFixture = {
      original, calls: [], records: [], rules: [], failStats: false, failImport: false, failRules: false,
      relay: { state: 'stopped', received: 0, imported: 0, unsupported: 0 }, inferenceCalls: 0, inferenceDisposed: 0, handoff: null,
      record: { version: 1, id: 'browser-test-1', source: '<img src=x onerror="window.__brXss=1">', mode: 'unknown', outcome: 'win', startedAt: '2026-10-28T01:00:00Z',
        quality: { roster: { me: true, enemy: false }, actions: false, lead: { me: true, enemy: false } },
        sides: { me: { pets: [{ instanceId: 'me-1', monsterId: 35, protocolId: '90035', level: 60, iv: { attack: { value: 0, certainty: 'direct' } }, nature: { speed: { certainty: 'candidate', candidates: [0, 1] } } }], lead: 'me-1', before: { score: 0 }, after: { score: 2 } },
          enemy: { pets: [{ instanceId: 'enemy-1', monsterId: 0, protocolId: '934', name: '<script>window.__brXss=1</script>', level: null }], before: {}, after: {} } },
        events: [
          { id: 's1', round: 1, seq: 1, kind: 'skill', phase: 'executed', side: 'me', actor: 'me-1', skillId: 37 },
          { id: 'd1', round: 1, seq: 2, kind: 'damage', phase: 'executed', side: 'me', actor: 'me-1', target: 'enemy-1', targetSide: 'enemy', amount: 25 },
          { id: 'p1', round: 1, seq: 3, kind: 'skill', phase: 'preview', side: 'enemy', actor: 'enemy-1', protocolSkillId: '7040370', skillId: 0 },
          { id: 'g1', round: 2, seq: 1, kind: 'growth', phase: 'executed', side: 'me', actor: 'me-1', skillId: 37, trigger: 'fixture: explicit confirmed rule', stacks: 2 },
          { id: 'g2', round: 2, seq: 2, kind: 'growth', phase: 'unknown', side: 'me', actor: 'me-1', trigger: '', stacks: 3 }
        ], issues: ['fixture <b>must stay text</b>'] }
    };
    const copy = value => JSON.parse(JSON.stringify(value));
    window.fetch = async (url, options = {}) => {
      const parsed = new URL(url, location.href);
      if (!parsed.pathname.startsWith('/api/battles/')) return original.fetch(url, options);
      f.calls.push({ path: parsed.pathname, query: parsed.search, method: options.method || 'GET', body: options.body || null });
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const name = parsed.pathname.slice('/api/battles/'.length);
      const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (name === 'list') {
        const outcome = parsed.searchParams.get('outcome');
        const records = f.records.filter(r => !outcome || r.outcome === outcome);
        return response({ records, total: f.largeList ? 51 : records.length, page: Number(parsed.searchParams.get('page')), pageSize: Number(parsed.searchParams.get('pageSize')) });
      }
      if (name === 'stats') {
        if (f.failStats) return response({ error: 'fixture statistics offline' }, 503);
        return response({ matchedBattles: f.records.length, outcomes: { win: f.records.length, loss: 0, draw: 0, unknown: 0 }, quality: { roster: 0, actions: 0, lead: 0 },
          enemy: f.records.length ? [{ monsterId: 35, carried: 0, carrySamples: 0, appeared: 1, appearSamples: 2, leads: 1, leadSamples: 3, unknownProfiles: 2, profileSamples: 2,
            ivDistributions: { attack: { '0': 1 } }, natureDistributions: {}, skills: [{ skillId: 37, usedBattles: 1, samples: 2, casts: 3 }] }] : [],
          selfSkills: f.records.length ? [{ monsterId: 35, skillId: 37, casts: 3, totalCasts: 4, usedBattles: 1, samples: 2 }] : [], teams: f.rules.map(r => ({ ...r, battles: 0, samples: 0 })), issues: [] });
      }
      if (name === 'record') return response(f.records.find(r => r.id === parsed.searchParams.get('id')) || f.record);
      if (name === 'rules') {
        if (options.method === 'PUT') { if (f.failRules) return response({ error: 'fixture rules offline' }, 503); f.rules = JSON.parse(options.body).rules; }
        return response({ rules: f.rules });
      }
      if (name === 'import') {
        if (f.failImport) return response({ error: 'fixture import offline' }, 503);
        const payload = JSON.parse(options.body); f.records = copy(payload.records || [payload]);
        return response({ imported: 1, duplicates: 0, issues: ['fixture source declaration only'] });
      }
      if (name === 'status') return response(f.relay);
      if (name === 'relay/start') { f.relay = { ...f.relay, state: 'running', url: JSON.parse(options.body).url }; return response(f.relay); }
      if (name === 'relay/stop') { f.relay.state = 'stopped'; return response(f.relay); }
      return response({ error: 'Unexpected fixture request' }, 500);
    };
    window.BattleRecordsClient.renderInference = (host, record, callback) => {
      f.inferenceCalls++; host.textContent = 'fixture inference bridge';
      f.saveInference = () => callback(copy(record));
      return () => { f.inferenceDisposed++; };
    };
    window.BattleRecordsClient.useRecord = record => { f.handoff = copy(record); };
    location.hash = '/battle-records';
  });
  const root = page.locator('.battle-records-page');
  const ready = () => page.waitForFunction(() => document.querySelector('[data-br="query-status"]')?.textContent.includes('已同步列表与统计'));
  const tab = async label => { await root.locator('.br-tabs').getByRole('button', { name: label, exact: true }).click(); };
  const selectMonster = async (label, id) => {
    const search = root.getByRole('textbox', { name: label, exact: true });
    await search.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await search.fill(String(id));
    // Let scroll-close notifications from bringing a below-fold input into view
    // settle, then explicitly reopen its anchored list as a user can do.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await search.click();
    await page.locator(`.autocomplete-item[data-item-id="${id}"]:visible`).click();
  };
  try {
    await root.waitFor(); await ready();
    check(await root.locator('[data-br="list"]').innerText().then(t => t.includes('还没有对战记录')), 'empty by default, no seeded matches');
    check(await page.evaluate(() => __battleRecordsFixture.calls.every(c => c.method === 'GET')), 'no startup mutations or relay start');
    check(await root.locator('input[name="rankMin"]').isHidden() && await root.locator('input[name="rankMax"]').isHidden() && await root.locator('input[name="tier"]').isHidden(), 'inactive rank fields are visually hidden, not just disabled');
    check(await root.innerText().then(t => t.includes('尚未通过真实对战验证')), 'current-game verification disclaimer prominent');
    const payload = await page.evaluate(() => JSON.stringify({ version: 1, records: [__battleRecordsFixture.record] }));
    await page.evaluate(payload => {
      const transfer = new DataTransfer(); transfer.items.add(new File([payload], 'fixture.json', {type:'application/json'}));
      const input = document.querySelector('.battle-records-page input[type="file"]'); input.files = transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    }, payload); await ready();
    await root.getByRole('button', { name: '查看详情', exact: true }).waitFor();
    check(await root.locator('.br-match').count() === 1, 'native file picker import displays accepted record');
    check(await root.locator('.br-match').innerText().then(t => t.includes('赛前 积分 0') && t.includes('首发未知')), 'list includes both rosters, score zero and unknown lead');
    check(await root.locator('script,img').count() === 0 && await page.evaluate(() => !window.__brXss), 'imported source/names do not create executable markup');

    await root.locator('select[name="outcome"]').selectOption('win');
    await root.locator('select[name="rankMetric"]').selectOption('score');
    check(await root.locator('input[name="rankMin"]').isVisible() && await root.locator('input[name="tier"]').isHidden(), 'score filter reveals only matching inputs');
    await root.locator('input[name="rankMin"]').fill('0');
    await selectMonster('筛选精灵（双方任意）', 35);
    await root.getByRole('button', { name: '应用筛选', exact: true }).click(); await ready();
    check(await page.evaluate(() => {
      const calls = __battleRecordsFixture.calls;
      const list = new URLSearchParams(calls.filter(c => c.path.endsWith('/list')).at(-1).query);
      const stats = new URLSearchParams(calls.filter(c => c.path.endsWith('/stats')).at(-1).query);
      list.delete('page'); list.delete('pageSize'); return list.toString() === stats.toString() && list.get('monsterId') === '35' && list.get('rankMin') === '0';
    }), 'shared filter query, explicit Wiki ID, zero lower bound');
    await page.evaluate(() => { __battleRecordsFixture.failStats = true; });
    await root.getByRole('button', { name: '刷新数据', exact: true }).click();
    await root.locator('[data-br-panel="list"]').getByText('fixture statistics offline', { exact: true }).waitFor();
    check(await root.locator('select[name="outcome"]').inputValue() === 'win', 'failed request retains applied filter controls');
    await page.evaluate(() => { __battleRecordsFixture.failStats = false; });
    await root.locator('[data-br-panel="list"]').getByRole('button', { name: '重试', exact: true }).click(); await ready();
    await tab('样本统计');
    const statsText = await root.locator('[data-br-panel="stats"]').innerText();
    check(statsText.includes('无有效样本') && statsText.includes('1 / 2 · 50.0%') && statsText.includes('3 / 4 · 75.0%'), 'metrics show distinct denominators; unknown is not zero');
    check(statsText.includes('不是携带率') && statsText.includes('含未知配置 2 场'), 'observed enemy skill incidence and unknown configuration coverage labelled');
    await root.locator('.br-profile summary').click();
    check(await root.locator('.br-profile').innerText().then(t => t.includes('未知：1 场') && t.includes('未知：2 场')), 'per-stat unknown distributions remain explicit');

    await tab('对战列表'); await root.getByRole('button', { name: '查看详情', exact: true }).click();
    await root.locator('.br-inference-host').waitFor();
    check(await root.locator('.br-turn').count() === 2, 'timeline grouped by turn');
    const detail = root.locator('[data-br-panel="detail"]');
    check(await detail.innerText().then(t => t.includes('伤害 25') && t.includes('预览（不计统计）') && t.includes('技能释放不是成长')), 'timeline distinguishes action/damage/preview and growth evidence');
    check(await detail.locator('.br-identity-editor').count() === 1, 'unmapped protocol IDs have explicit current-record editor');
    await page.evaluate(() => __battleRecordsFixture.saveInference()); await ready();
    check(await root.locator('select[name="outcome"]').inputValue() === 'win' && await page.evaluate(() => __battleRecordsFixture.inferenceDisposed > 0), 'inference save refreshes detail/list/stats without resetting filters and disposes old helper');
    const beforeMapping = await page.evaluate(() => __battleRecordsFixture.calls.filter(c => c.path.endsWith('/import')).length);
    await detail.getByRole('button', { name: '确认本记录精灵映射', exact: true }).click();
    check(await page.evaluate(n => __battleRecordsFixture.calls.filter(c => c.path.endsWith('/import')).length === n, beforeMapping), 'no guessed identity without explicit selection');
    await selectMonster('映射实例 enemy-1 的 Wiki 精灵', 35);
    await detail.getByRole('button', { name: '确认本记录精灵映射', exact: true }).click();
    await page.waitForFunction(() => __battleRecordsFixture.records[0].sides.enemy.pets[0].monsterId === 35);
    await detail.getByLabel('Wiki 技能（对应协议 7040370）').waitFor();
    await detail.getByLabel('Wiki 技能（对应协议 7040370）').selectOption('37');
    await detail.getByRole('button', { name: '确认本记录技能映射', exact: true }).click();
    await page.waitForFunction(() => __battleRecordsFixture.records[0].events.find(e => e.id === 'p1').skillId === 37);
    await detail.getByLabel('Wiki 技能（对应协议 7040370）').waitFor({state:'detached'});
    check(await page.evaluate(() => {
      const imports = __battleRecordsFixture.calls.filter(c => c.path.endsWith('/import'));
      const saved = JSON.parse(imports.at(-1).body).records;
      return saved.length === 1 && saved[0].id === 'browser-test-1' && saved[0].events.find(e => e.id === 'p1').protocolSkillId === '7040370';
    }), 'manual species/skill mapping uses canonical import for one record, preserving protocol ID');

    await tab('队伍规则');
    await root.locator('input[name="ruleName"]').fill('fixture <b>contains-all</b>');
    await selectMonster('添加规则成员（Wiki ID）', 35);
    await page.evaluate(() => { __battleRecordsFixture.failRules = true; });
    await root.getByRole('button', { name: '保存规则', exact: true }).click();
    await root.getByText('fixture rules offline', { exact: true }).waitFor();
    check(await root.locator('input[name="ruleName"]').inputValue() === 'fixture <b>contains-all</b>', 'failed rule save preserves draft');
    await page.evaluate(() => { __battleRecordsFixture.failRules = false; });
    await root.locator('[data-br-panel="rules"]').getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => __battleRecordsFixture.rules.length === 1);
    check(await page.evaluate(() => __battleRecordsFixture.rules[0].monsterIds.join(',') === '35'), 'contains-all rule saves stable Wiki IDs');
    await ready();

    await root.locator('.br-relay > summary').click();
    await root.locator('input[name="relayURL"]').fill('http://127.0.0.1:19001');
    await root.getByRole('button', { name: '连接中继', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.br-relay-status')?.textContent.includes('中继已连接'));
    await root.getByRole('button', { name: '停止接入', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.br-relay-status')?.textContent.includes('已停止'));
    check(await page.evaluate(() => __battleRecordsFixture.calls.filter(c => c.path.endsWith('/relay/start')).length === 1), 'relay starts only on explicit button, stops manually');

    await tab('对战列表'); await page.evaluate(() => { __battleRecordsFixture.largeList = true; });
    await root.getByRole('button', { name: '刷新数据', exact: true }).click(); await ready();
    await root.getByRole('button', { name: '下一页', exact: true }).click(); await ready();
    check(await page.evaluate(() => new URLSearchParams(__battleRecordsFixture.calls.filter(c => c.path.endsWith('/list')).at(-1).query).get('page') === '2'), 'paged list navigates without losing filters');
    for (const width of [1440, 760, 420]) {
      await page.setViewportSize({ width, height: 900 });
      check(await root.evaluate(el => el.scrollWidth <= el.clientWidth + 2), 'page-scoped layout avoids horizontal overflow at ' + width);
    }
    await root.getByRole('button', { name: '查看详情', exact: true }).click();
    await detail.getByRole('button', { name: '用于伤害计算', exact: true }).waitFor();
    // Do not navigate the real damage page here (its configuration is unrelated).
    // Native onLeave and exact handoff are exercised separately by parent integration.
    const callsBeforeLeave = await page.evaluate(() => { BattleRecordsPage.onLeave(); return __battleRecordsFixture.calls.length; });
    await page.waitForTimeout(2700);
    check(await page.evaluate(n => __battleRecordsFixture.calls.length === n, callsBeforeLeave), 'onLeave stops status polling and creates no capture actions');
    check(errors.length === 0, 'no browser errors: ' + errors.join('; '));
    return { passed: checks.length, checks };
  } catch(error) {
    const detail = await page.evaluate(() => ({ text:document.querySelector('.battle-records-page')?.innerText.slice(-4500), calls:window.__battleRecordsFixture?.calls.slice(-5) }));
    error.message += '\nFixture diagnostic: '+JSON.stringify(detail); throw error;
  } finally {
    page.off('pageerror', onError);
    await page.evaluate(() => {
      BattleRecordsPage.onLeave();
      const f = window.__battleRecordsFixture;
      if (f) {
        window.fetch = f.original.fetch; window.BattleRecordsClient.renderInference = f.original.inference; window.BattleRecordsClient.useRecord = f.original.useRecord;
        CommonUI.destroyWithin(document.getElementById('page-container'));
        document.getElementById('page-container').replaceChildren();
        delete window.__battleRecordsFixture; delete window.__brXss;
      }
    });
    if (viewport) await page.setViewportSize(viewport);
  }
}
