// Parent-owned isolated browser only. Do not run against a personal profile.
// Run after parent synchronizes current source to the served app and reloads.
// No absolute timing assertions: returned samples are a performance record.
// Source instrumentation lives entirely in this evaluation's private closures.
async page => {
  await page.evaluate(() => { location.hash = '/petdex'; });
  await page.waitForSelector('#petdex-search');
  try {
    return await page.evaluate(async () => {
      const checks = [], check = (ok, text) => { if (!ok) throw Error(text); checks.push(text); };
      const settle = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
      const sources = await Promise.all(['js/pages/petdex.js', 'js/game-glossary.js'].map(async file => {
        const response = await fetch(file, {cache:'no-store'}); if (!response.ok) throw Error(`Missing ${file}`);
        const code = await response.text();
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
        return {file, code, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('')};
      }));
      check(sources[0].code.includes('function reconcileRows('), 'served source contains the keyed renderer (not stale dist)');
      check(sources[1].code.includes('function decorateRoots('), 'served source contains the incremental glossary');
      const metrics = { builtRows: 0, tokenizes: 0, walks: 0, queued: 0, frames: 0 };
      const petCode = sources[0].code.replace("const row = document.createElement('tr');", "metrics.builtRows++; const row = document.createElement('tr');")
        .replace('return { render, toggleTrait, toggleForm, showPetDetail };', 'return { render, toggleTrait, toggleForm, showPetDetail, cache: () => tableView?.rows, getFilteredMonsters, state };');
      const dex = new Function('metrics', `${petCode}\nreturn PetDexPage;`)(metrics);
      const glossaryCode = sources[1].code
        .replace('const parts = matcher.tokenize(text.nodeValue);', 'metrics.tokenizes++; const parts = matcher.tokenize(text.nodeValue);')
        .replace('const walker = doc.createTreeWalker(region,', 'metrics.walks++; const walker = doc.createTreeWalker(region,')
        .replace('pending.add(root);', 'metrics.queued++; pending.add(root);')
        .replace('frame = null;\n      const roots', 'metrics.frames++; frame = null;\n      const roots');
      const facade = {document, fetch: window.fetch.bind(window), MutationObserver, requestAnimationFrame: window.requestAnimationFrame.bind(window),
        cancelAnimationFrame: window.cancelAnimationFrame.bind(window), setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
        getComputedStyle: window.getComputedStyle.bind(window), CommonUI};
      const glossary = new Function('window', 'metrics', `${glossaryCode}\nreturn window.GameGlossary;`)(facade, metrics);
      const originalGlossary = window.GameGlossary;
      const container = document.querySelector('.petdex-page-layout').parentElement;
      const originalData = JSON.stringify(RKData.getMonsters());
      const oldTrick = AppPreferences.getTrickRoom(), oldPolicy = AppPreferences.getEffectiveSpeedPolicy();
      // Track only listeners registered by this fixture, and restore prototypes
      // in finally. Nothing is exposed as a global production diagnostic hook.
      const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
      const listeners = [], capture = opts => typeof opts === 'boolean' ? opts : !!opts?.capture;
      EventTarget.prototype.addEventListener = function(type, fn, opts) {
        if ((this === window || this === document || this.tagName === 'TBODY' || this.tagName === 'TR') &&
            !listeners.some(r => r.target === this && r.type === type && r.fn === fn && r.capture === capture(opts))) listeners.push({target:this,type,fn,capture:capture(opts)});
        return add.call(this,type,fn,opts);
      };
      EventTarget.prototype.removeEventListener = function(type, fn, opts) {
        const i = listeners.findIndex(r => r.target === this && r.type === type && r.fn === fn && r.capture === capture(opts));
        if(i >= 0) listeners.splice(i,1); return remove.call(this,type,fn,opts);
      };
      let fixtureHost = null;
      try {
        originalGlossary?.destroy();
        AppPreferences.setTrickRoom(false, false); AppPreferences.setEffectiveSpeedPolicy('include',80,false);
        await glossary.init(); dex.render(container); await settle();
        const rows = () => Array.from(document.querySelectorAll('#pet-tbody > tr[data-id]'));
        const highButton = () => document.querySelector('#form-buttons [data-form="high"]');
        const initial = rows(), initialIds = initial.map(r => r.dataset.id);
        const initialById = new Map(initial.map(r => [r.dataset.id, r]));
        const samples = [];
        const expand = async label => {
          const before = {...metrics}, start = performance.now(); highButton().click(); const syncMs = performance.now() - start;
          await settle(); samples.push({label,syncMs,settledMs:performance.now()-start,rowCount:rows().length,
            builtRows:metrics.builtRows-before.builtRows,tokenizes:metrics.tokenizes-before.tokenizes,walks:metrics.walks-before.walks,queued:metrics.queued-before.queued,frames:metrics.frames-before.frames});
        };
        await expand('cold all forms');
        const allRows = rows(), allIds = allRows.map(r => r.dataset.id), identities = new Map(allRows.map(r => [r.dataset.id,r]));
        check(allRows.length > initial.length && new Set(allIds).size === allRows.length, 'all forms adds all eligible unique IDs, no truncation');
        check(initial.every(r => identities.get(r.dataset.id) === r), 'initial 203-style subset survives first expansion by DOM identity');
        const decorated = new Map(allRows.flatMap(row => { const term = row.querySelector('.game-glossary-term'); return term ? [[row.dataset.id,term]] : []; }));
        const steady = {...metrics};
        for (let i=0;i<10;i++) {
          highButton().click(); await settle();
          check(JSON.stringify(rows().map(r=>r.dataset.id)) === JSON.stringify(initialIds), `toggle ${i}: subset order restored`);
          await expand(`warm ${i+1}`);
          check(rows().every((r,j)=>r === identities.get(allIds[j])), `toggle ${i}: complete row order/identity retained`);
          check(dex.cache().size === allRows.length, `toggle ${i}: cache bounded to visited catalogue IDs`);
        }
        check(metrics.builtRows === steady.builtRows, 'warm toggles build zero new rows');
        check(metrics.walks === steady.walks && metrics.tokenizes === steady.tokenizes, 'warm decorated row reinsertion walks/tokenizes zero descriptions');
        check([...decorated].every(([id,term])=>identities.get(id).contains(term)), 'word/tooltip anchor node identities retained');
        check(!listeners.some(r=>r.target.tagName==='TR'), 'no row event listeners');
        check(listeners.filter(r=>r.target.tagName==='TBODY'&&r.type==='click').length===1, 'one delegated tbody click handler');
        check(JSON.stringify(rows().map(r=>Number(r.dataset.id))) === JSON.stringify(dex.getFilteredMonsters().map(m=>m.id)), 'all rows match current filter policy, no pagination');
        const wrapper = document.getElementById('data-table-wrapper'); wrapper.scrollTop=wrapper.scrollHeight;
        check(wrapper.scrollTop>0 && rows().at(-1).isConnected, 'last full-content row remains reachable'); wrapper.scrollTop=0;

        const targetId = [...decorated.keys()].find(id=>initialById.has(id));
        check(!!targetId, 'a retained high-form row contains a glossary word');
        const anchor = decorated.get(targetId); anchor.scrollIntoView({block:'center'}); await settle(); anchor.focus({preventScroll:true}); await settle();
        const popup = () => document.querySelector('.game-glossary-tooltip:not([hidden])');
        check(!!popup() && anchor.getAttribute('aria-describedby')===popup().id, 'keyboard focus opens anchored accessible word tooltip');
        anchor.click(); check(!!popup() && document.getElementById('pet-modal').style.display!=='flex', 'word click does not trigger delegated row detail');
        // Hide only a style: must dismiss, but must never walk descriptions.
        const walks = metrics.walks; identities.get(targetId).style.display='none'; await settle();
        check(!popup() && metrics.walks===walks, 'visibility mutation dismisses without glossary scans');
        identities.get(targetId).style.removeProperty('display'); anchor.blur(); anchor.focus(); await settle();
        check(!!popup(), 'same reused word reopens');
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        check(!popup(), 'Escape still dismisses');
        anchor.blur(); anchor.focus(); await settle();
        highButton().click(); await settle();
        if (popup()) {
          const rect = anchor.getBoundingClientRect(), box = popup().getBoundingClientRect();
          check(box.left>=0 && box.right<=innerWidth+1 && Math.abs(box.top-rect.bottom)<400, 'retained tooltip is repositioned, not left at a stale row');
        }
        highButton().click(); await settle(); glossary.close();

        const traitRow = document.querySelector('#pet-tbody tr[data-id="129"]');
        const traitControl = traitRow?.querySelector('[data-petdex-action="trait"]');
        check(!!traitControl, 'special multi-line trait fixture exists');
        const traitText=traitRow.cells[3].textContent, unrelated=identities.get(targetId);
        traitControl.click(); await settle();
        check(traitRow===document.querySelector('#pet-tbody tr[data-id="129"]') && traitRow.cells[3].textContent!==traitText && unrelated===identities.get(targetId), 'trait delegation updates only changed cell while keeping rows');
        const formControl = document.querySelector('#pet-tbody [data-petdex-action="form"]'), formRow=formControl.closest('tr');
        const beforeForms=rows().length; formControl.click(); await settle();
        check(formRow.isConnected && rows().length>beforeForms, 'form delegation expands variants without replacing the main row');
        formRow.querySelector('[data-petdex-action="form"]').click(); await settle();
        check(rows().length===beforeForms, 'regional collapse preserves the original row set');

        const builtBeforeStats=metrics.builtRows, traitWalks=metrics.walks;
        AppPreferences.setTrickRoom(true,false);
        document.querySelector('#pet-table th[data-sort="base_spd"]').click(); await settle();
        check(document.querySelector('#pet-table th[data-sort="base_spd"]').textContent==='速度（梦境）', 'petdex shows dream-speed label');
        let last=Infinity;
        check(rows().every((r,i)=>{const raw=RKData.getMonsterById(Number(r.dataset.id)), speed=Number(r.querySelector('[data-stat="base_spd"]').textContent); const ok=speed===200-raw.base_spd&&speed<=last&&r.cells[0].textContent===String(i+1);last=speed;return ok;}), 'current projection, numeric order and displayed ranks remain exact');
        for(const mode of ['exclude','threshold','include']) {
          AppPreferences.setEffectiveSpeedPolicy(mode,80,false); await settle();
          check(rows().every(r=>{const m=RKData.getMonsterById(Number(r.dataset.id));return Number(r.querySelector('[data-stat="effective"]').textContent)===RKData.getEffectiveStats({...m,base_spd:200-m.base_spd});}), `effective policy ${mode} uses live projected values`);
        }
        check(metrics.builtRows===builtBeforeStats && metrics.walks===traitWalks, 'stats/sort do not rebuild rows or walk unchanged traits');
        check(JSON.stringify(RKData.getMonsters())===originalData, 'no master source data mutated');

        // External editing and nested descriptions, including detached same-text
        // replacement, without ever mutating the real catalogue fixture.
        fixtureHost=document.createElement('div'); container.appendChild(fixtureHost);
        const desc=document.createElement('div'); desc.className='detail-trait-desc'; desc.textContent='中毒印记'; fixtureHost.appendChild(desc); await settle();
        check(desc.querySelector('.game-glossary-term')?.textContent==='中毒印记', 'longest word match in new description');
        desc.remove(); await settle(); desc.textContent='中毒印记'; fixtureHost.appendChild(desc); await settle();
        check(desc.querySelectorAll('.game-glossary-term').length===1, 'detached same-text raw edit decorates again');
        const editor=document.createElement('div'); editor.contentEditable='true'; editor.className='detail-trait-desc'; editor.textContent='灼烧'; fixtureHost.appendChild(editor); await settle();
        check(!editor.querySelector('.game-glossary-term'), 'editable text remains untouched'); editor.contentEditable='false'; await settle();
        check(editor.querySelector('.game-glossary-term')?.textContent==='灼烧', 'eligibility change processes newly noneditable text');
        const word=desc.querySelector('.game-glossary-term');
        check(glossary.decorate(fixtureHost)===0 && desc.querySelector('.game-glossary-term')===word && !fixtureHost.querySelector('.game-glossary-term .game-glossary-term'), 'idempotence retains decorated word nodes');
        fixtureHost.remove(); fixtureHost=null;

        const memory=[];
        for(let cycle=0;cycle<5;cycle++) {
          const oldCache=dex.cache(); CommonUI.destroyWithin(container); container.replaceChildren(); await settle();
          check(oldCache.size===0 && dex.cache()==null, `exit ${cycle}: strong cache and page reference released`);
          check(!listeners.some(r=>r.target.tagName==='TBODY'), `exit ${cycle}: delegated handler released`);
          dex.render(container); await settle(); memory.push({cycle,cache:dex.cache().size,globalListeners:listeners.filter(r=>r.target===document||r.target===window).length});
        }
        check(memory.every(r=>r.cache===memory[0].cache&&r.globalListeners===memory[0].globalListeners), 'reentry has bounded cache/listener counts, no accumulation');
        return {passed:checks.length,checks,sourceSnapshots:sources.map(({file,sha256,code})=>({file,sha256,bytes:new TextEncoder().encode(code).length})),
          rows:{high:initial.length,all:allRows.length},samples,memory,metrics,note:'Wall-clock values are observations, not absolute pass thresholds. Original glossary/page are restored in finally.'};
      } finally {
        fixtureHost?.remove(); glossary.destroy(); CommonUI.destroyWithin(container); container.replaceChildren();
        AppPreferences.setTrickRoom(oldTrick,false); AppPreferences.setEffectiveSpeedPolicy(oldPolicy.mode,oldPolicy.threshold,false);
        EventTarget.prototype.addEventListener=add; EventTarget.prototype.removeEventListener=remove;
        await originalGlossary?.init(); PetDexPage.render(container);
      }
    });
  } finally { await page.reload(); }
}
