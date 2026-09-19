// Isolated browser + read-only server only. Reference endpoints return CSS, not old application data.
async page => {
  const checks=[],errors=[];
  const check=(ok,label)=>{if(!ok)throw new Error(label);checks.push(label);};
  const onError=e=>errors.push(e.message);page.on('pageerror',onError);
  const css={};
  for(const [key,relative] of Object.entries({original:'/__layout/original.css',before:'/__layout/before.css',current:'css/style.css'})){
    const url=await page.evaluate(r=>new URL(r,location.href).href,relative);
    const res=await page.request.get(url);
    if(!res.ok())throw new Error(`Missing CSS reference: ${relative}`);
    // Mirror linked CSS decoding: a BOM left in inline text breaks the initial :root selector.
    css[key]=(await res.text()).replace(/^\uFEFF/,'');
  }
  await page.evaluate(()=>{location.hash='/damage';});
  await page.waitForSelector('#basePower');
  await page.evaluate(()=>{
    const sheet=document.querySelector('link[href*="css/style.css"]');sheet.disabled=true;
    const comparison=document.createElement('style');comparison.id='layout-test-css';document.head.appendChild(comparison);
    const stable=document.createElement('style');stable.id='layout-test-stable';stable.textContent='* { animation: none !important; transition: none !important; }';document.head.appendChild(stable);
  });
  const apply=key=>page.evaluate(text=>{document.getElementById('layout-test-css').textContent=text;document.querySelector('.calc-root.scroll-container').scrollTop=0;},css[key]);
  const capture=()=>page.evaluate(()=>{
    const rect=(node,anchor)=>{const r=node.getBoundingClientRect(),a=anchor.getBoundingClientRect();return{x:r.left-a.left,y:r.top-a.top,w:r.width,h:r.height};};
    const group=selector=>[...document.querySelectorAll(selector)].map(e=>rect(e,e.closest('.card')));
    const label=document.querySelector('.final-power-manual-label'),s=getComputedStyle(label);
    const headers=[...document.querySelectorAll('.attacker-card .card-header,.defender-card .card-header')].flatMap(e=>[rect(e,e.closest('.card')),...[...e.querySelectorAll('label,h3,.search-bar')].map(n=>rect(n,e))]);
    return{stats:group('.attacker-card .final-stat-item,.defender-card .final-stat-item'),statContents:group('.attacker-card .final-stat-item > *,.defender-card .final-stat-item > *'),inputs:group('.skill-card .input-row > .input-group'),headers,
      toolbar:group('.skill-type-row'),footer:group('.skill-card .modifiers'),
      label:{display:s.display,color:s.color,fontSize:s.fontSize,fontWeight:s.fontWeight,textAlign:s.textAlign,cursor:s.cursor},
      rows:[...document.querySelectorAll('.skill-card .input-row')].map(row=>({wrap:getComputedStyle(row).flexWrap,mins:[...row.children].map(n=>getComputedStyle(n).minWidth)}))};
  });
  const close=(a,b)=>{
    if(typeof a==='number')return typeof b==='number'&&Math.abs(a-b)<.2;
    if(a&&typeof a==='object')return b&&Object.keys(a).every(k=>close(a[k],b[k]))&&Object.keys(a).length===Object.keys(b).length;
    return a===b;
  };
  const cases=[];
  try{
    for(const [width,height,zoom] of [[1920,1080,1],[1280,900,1],[1280,900,.8]]){
      await page.setViewportSize({width,height});await page.evaluate(z=>AppPreferences.setMaxZoom(z),zoom);
      await apply('original');const original=await capture();
      await apply('before');const before=await capture();
      await apply('current');const current=await capture();
      const tag=`${width}x${height} @ ${zoom*100}%`;
      check(close(current.stats,original.stats)&&close(current.statContents,original.statContents),`${tag}: both stat panels match original geometry`);
      check(close(current.inputs,original.inputs),`${tag}: skill input positions and widths match original`);
      check(close(current.headers,before.headers),`${tag}: search and title positions are unchanged`);
      check(close(current.toolbar,original.toolbar)&&close(current.footer,original.footer),`${tag}: skill toolbar and coefficient row retain original positions`);
      check(current.rows.every(r=>r.wrap==='nowrap'&&r.mins.every(m=>m==='0px')),`${tag}: three shrinkable skill fields per row`);
      cases.push({tag,original,current});
    }
    for(const theme of ['light','dark']){
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      for(const manual of [false,true]){
        await page.locator('#finalPowerManual').fill(manual?'123':'');
        await apply('before');const before=await capture();
        await apply('current');const current=await capture();
        check(close(current.label,before.label),`${theme}, manual=${manual}: approved final-power label appearance is unchanged`);
      }
    }
    await page.setViewportSize({width:1920,height:1080});await page.evaluate(()=>AppPreferences.setMaxZoom(1));
    check(await page.evaluate(()=>[...document.querySelectorAll('.ext-module')].every(e=>getComputedStyle(e).borderRadius==='12px')),'both left-column modules have 12px corners');
    check(await page.evaluate(()=>{
      const selectors=[...document.getElementById('layout-test-css').sheet.cssRules].filter(r=>r.selectorText).flatMap(r=>r.selectorText.split(',').map(s=>s.trim()));
      return !selectors.some(s=>['.card','.card:hover','.card.selected','.card-grid','.card-name','.card-info'].includes(s))&&selectors.filter(s=>s==='.calc-root .card').length===1;
    }),'global card rules are removed; exactly one scoped card base remains');
    check(await page.evaluate(()=>{
      const rules=[];
      const visit=list=>{for(const rule of list){if(rule.selectorText&&rule.style)rules.push(rule);if(rule.cssRules)visit(rule.cssRules);}};
      for(const sheet of document.styleSheets)if(!sheet.disabled)visit(sheet.cssRules);
      const matching=(element,property)=>rules.filter(r=>element.matches(r.selectorText)&&r.style.getPropertyValue(property));
      return [...document.querySelectorAll('.skill-card .input-row')].every(e=>{
        const declarations=matching(e,'flex-wrap');return declarations.length===1&&declarations[0].style.flexWrap==='nowrap';
      })&&[...document.querySelectorAll('.skill-card .input-group')].every(e=>{
        const declarations=matching(e,'min-width');return declarations.length===1&&declarations[0].style.minWidth==='0px';
      });
    }),'no overridden wrapping/120px rules remain among rules matching skill fields');
    check(await page.evaluate(()=>[...document.querySelectorAll('.attacker-card .final-stat-item,.defender-card .final-stat-item,.skill-card .input-group')].every(e=>{const r=e.getBoundingClientRect(),c=e.closest('.card').getBoundingClientRect();return r.left>=c.left&&r.right<=c.right;})),'standard desktop layout has no clipped stat items or skill fields');
    const routes=['petdex','moves','types','speed','team','damage','chart','updatedata','settings'];
    for(const route of routes){
      await page.evaluate(r=>{location.hash='/'+r;},route);
      await page.waitForTimeout(100);
      check(await page.evaluate(()=>[...document.querySelectorAll('#page-container .card')].every(e=>e.closest('.calc-root'))),`${route}: no card depends on the removed global rule`);
    }
    await page.evaluate(()=>{location.hash='/updatedata';});
    await page.waitForSelector('.ud-tab[data-tab="addPet"]');
    for(const tab of ['addPet','addMove']){
      await page.locator(`.ud-tab[data-tab="${tab}"]`).click();
      check(await page.evaluate(()=>{
        const rows=[...document.querySelectorAll('#ud-tab-content .input-row')];
        const groups=[...document.querySelectorAll('#ud-tab-content .input-group')].filter(e=>!e.style.minWidth);
        return rows.length>0&&groups.length>0&&rows.every(e=>getComputedStyle(e).display==='flex'&&getComputedStyle(e).flexWrap==='wrap')&&groups.every(e=>getComputedStyle(e).minWidth==='120px');
      }),`${tab}: data editor retains its own scoped wrapping form layout`);
    }
    await page.evaluate(()=>{location.hash='/damage';document.documentElement.dataset.theme='light';});
    await page.waitForSelector('#basePower');await page.locator('#finalPowerManual').fill('');
    check(await page.evaluate(()=>[...document.querySelectorAll('.skill-card .input-row')].every(e=>getComputedStyle(e).flexWrap==='nowrap')),'returning from data editor cannot reactivate its wrapping layout on damage page');
    check(errors.length===0,'no runtime errors during layout and route checks');
    return{passed:checks.length,checks,cases:cases.map(c=>c.tag)};
  }finally{
    page.off('pageerror',onError);
    await page.evaluate(()=>{document.querySelector('link[href*="css/style.css"]').disabled=false;document.getElementById('layout-test-css')?.remove();document.getElementById('layout-test-stable')?.remove();});
  }
}
