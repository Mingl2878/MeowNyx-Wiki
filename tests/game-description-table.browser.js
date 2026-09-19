// Isolated browser/temporary profile only; compares real petdex and glossary geometry.
async page => {
  const checks=[],errors=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const onError=e=>errors.push(e.message);page.on('pageerror',onError);
  const saved=await page.evaluate(()=>({zoom:AppPreferences.getMaxZoom(),theme:document.documentElement.dataset.theme,font:document.body.style.fontFamily,fontVar:document.documentElement.style.getPropertyValue('--app-font-family')}));
  const go=async route=>{await page.evaluate(r=>location.hash='/'+r,route);await page.waitForSelector(route==='petdex'?'#petdex-search':'.game-description-table');};
  const input=()=>page.locator('.game-description-search');
  const metrics=selector=>page.locator(selector).evaluate(el=>{
    const s=getComputedStyle(el),r=el.getBoundingClientRect();
    return {w:r.width,h:r.height,padding:s.padding,border:s.borderWidth,radius:s.borderRadius,font:s.fontFamily,size:s.fontSize,line:s.lineHeight,bg:s.backgroundColor,color:s.color};
  });
  try {
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>AppPreferences.setMaxZoom(1));
    await go('game-description');await input().fill('');
    check(await page.locator('.game-description-entry').count()===54,'all 54 entries render as table rows');
    check(JSON.stringify(await page.locator('.game-description-table thead th').allTextContents())===JSON.stringify(['名称','类别','属性','效果']),'exact four-column order');
    check(await page.locator('.game-description-page select, .game-description-page label, .game-description-page article').count()===0,'no category selector, standalone search label or old card list');
    check(await page.evaluate(()=>{
      const expected=GameGlossary.getEntries();
      return [...document.querySelectorAll('.game-description-entry')].every((row,i)=>row.tagName==='TR'&&JSON.stringify([...row.cells].map((c,k)=>k===2?c.getAttribute('aria-label'):c.textContent))===JSON.stringify([expected[i].name,expected[i].category,expected[i].attribute||'无属性',expected[i].description]));
    }),'all original names/categories/attribute semantics/effect bodies remain unchanged');
    check(await page.locator('.game-description-attribute img').count()===54,'all 54 attribute cells use icons without visible attribute text');
    check(await page.evaluate(()=>[...document.querySelectorAll('.game-description-entry')].every(row=>{
      const entry=GameGlossary.getEntries().find(e=>e.id===row.dataset.glossaryId),cell=row.cells[2],img=cell.querySelector('img');
      const expected=GameDescriptionPage.attributeIcon(entry.attribute);
      return cell.textContent===''&&img.getAttribute('src')===expected.src&&img.getAttribute('alt')===''&&cell.title.includes(entry.attribute||'无属性');
    })),'icons use shared mapping; None uses normal icon but retains None label');
    await input().fill('水系');check(JSON.stringify(await page.locator('.game-description-name').allTextContents())===JSON.stringify(['湿润印记','雨天']),'search spans different categories');
    await input().fill('天气');check(await page.locator('.game-description-entry').count()===4,'category text remains searchable without a category filter');
    await input().fill('不存在的词条');check(await page.locator('.game-description-empty').getAttribute('colspan')==='4','empty result occupies all four columns');
    await input().fill('');
    await input().evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='雨天';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));});
    check(await page.locator('.game-description-entry').count()===54,'IME composition does not prematurely filter');
    await input().evaluate(el=>el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
    check(await page.locator('.game-description-name').textContent()==='雨天','IME completion filters immediately');
    await input().fill('');
    for(const font of ['system-ui, sans-serif','Microsoft YaHei, sans-serif'])for(const theme of ['light','dark'])for(const zoom of [1,1.5,2]){
      await page.evaluate(({font,theme,zoom})=>{document.body.style.fontFamily=font;document.documentElement.style.setProperty('--app-font-family',font);document.documentElement.dataset.theme=theme;AppPreferences.setMaxZoom(zoom);},{font,theme,zoom});
      await go('petdex');await page.locator('[data-listing-mode="expanded"]').click();await page.mouse.move(0,0);await page.waitForTimeout(180);
      const searchRef=await metrics('#petdex-search');
      const tableRef=await page.locator('#pet-table').evaluate(t=>{const th=getComputedStyle(t.querySelector('th')),td=getComputedStyle(t.querySelector('td')),wrap=getComputedStyle(t.parentElement);return {font:getComputedStyle(t).fontSize,padding:td.padding,header:th.backgroundColor,border:wrap.borderWidth,radius:wrap.borderRadius,bg:wrap.backgroundColor};});
      await go('game-description');await page.mouse.move(0,0);await page.waitForTimeout(180);
      const actual=await metrics('.game-description-search');
      check(Object.keys(searchRef).every(k=>typeof searchRef[k]==='number'?Math.abs(actual[k]-searchRef[k])<.3:actual[k]===searchRef[k]),`${font}/${theme}/${zoom*100}% search geometry and styling match petdex`);
      check(await page.locator('.game-description-table').evaluate((t,ref)=>{const th=getComputedStyle(t.querySelector('th')),td=getComputedStyle(t.querySelector('td')),wrap=getComputedStyle(t.parentElement);return getComputedStyle(t).fontSize===ref.font&&td.padding===ref.padding&&th.backgroundColor===ref.header&&wrap.borderWidth===ref.border&&wrap.borderRadius===ref.radius&&wrap.backgroundColor===ref.bg;},tableRef),`${font}/${theme}/${zoom*100}% table shares petdex appearance`);
      check(await page.evaluate(()=>{
        const scroller=document.querySelector('.game-description-list');
        const rows=[...document.querySelectorAll('.game-description-entry')];
        return scroller.scrollHeight>scroller.clientHeight&&rows.every(r=>[...r.cells].every(c=>c.scrollWidth<=c.clientWidth+1))&&getComputedStyle(rows[0].lastElementChild).whiteSpace==='pre-wrap'&&getComputedStyle(rows[0].lastElementChild).textAlign==='left';
      }),`${font}/${theme}/${zoom*100}% effects wrap completely without clipping`);
    }
    await page.setViewportSize({width:960,height:700});await page.evaluate(()=>AppPreferences.setMaxZoom(2));
    await input().fill('');
    await page.locator('.game-description-list').evaluate(el=>{el.scrollTop=el.scrollHeight;el.scrollLeft=el.scrollWidth;});
    check(await page.evaluate(()=>{const scroller=document.querySelector('.game-description-list'),last=scroller.querySelector('tbody tr:last-child').getBoundingClientRect(),r=scroller.getBoundingClientRect(),th=scroller.querySelector('thead th').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&last.bottom<=r.bottom+2&&Math.abs(th.top-r.top)<=3&&scroller.scrollLeft>0;}),'narrow 200% view scrolls internally, keeps header sticky and reaches last row/effect column');
    const scroll=await page.locator('.game-description-list').evaluate(el=>({top:el.scrollTop,left:el.scrollLeft}));
    await go('petdex');await go('game-description');
    check(await page.locator('.game-description-list').evaluate((el,s)=>Math.abs(el.scrollTop-s.top)<1&&Math.abs(el.scrollLeft-s.left)<1,scroll),'vertical and horizontal positions survive page navigation');
    await input().fill('雨天');await go('petdex');await go('game-description');
    check(await input().inputValue()==='雨天'&&await page.locator('.game-description-entry').count()===1,'query and filtered rows survive navigation');
    check(errors.length===0,'no browser runtime errors');
    return {passed:checks.length,checks};
  }finally{
    page.off('pageerror',onError);
    await page.evaluate(s=>{AppPreferences.setMaxZoom(s.zoom);document.documentElement.dataset.theme=s.theme;document.body.style.fontFamily=s.font;document.documentElement.style.setProperty('--app-font-family',s.fontVar);},saved);
  }
}
