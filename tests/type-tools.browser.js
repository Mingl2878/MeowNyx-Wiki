// Run only in the parent's isolated browser fixture. No real clipboard/settings writes.
// Compatible with the repository's `async page => {...}` browser-suite loader.
async page => {
  const checks=[];
  const check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  await page.evaluate(()=>location.hash='/types');
  await page.waitForSelector('.type-tools-copy');
  const original=await page.evaluate(()=>{
    const html=document.documentElement;
    window.__typeToolsTest={descriptor:Object.getOwnPropertyDescriptor(navigator,'clipboard'),calls:[],failure:false,defer:false,pending:null,
      theme:html.getAttribute('data-theme'),zoom:html.style.zoom,font:html.style.getPropertyValue('--app-font-family'),data:JSON.stringify(RKData.getMonsters())};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
      const t=window.__typeToolsTest;t.calls.push(text);
      if(t.failure)throw Error('isolated clipboard denial');
      if(t.defer)await new Promise(resolve=>{t.pending=resolve;});
    }}});
    return {viewport:{width:innerWidth,height:innerHeight}};
  });
  const clear=async()=>{
    while(await page.locator('#type-grid .active').count())await page.locator('#type-grid .active').first().click();
  };
  const select=async types=>{await clear();for(const type of types)await page.locator(`#type-grid [data-type="${type}"]`).click();};
  const waitCopied=async()=>{await page.waitForFunction(()=>document.querySelector('.type-tools-copy')?.textContent==='✓ 已复制');};
  try {
    await page.locator('#mode-attack').click();
    await select(['Normal']);
    const first=await page.evaluate(()=>{
      const model=TypeTools.build(RKData,'attack',['Normal']);
      return {ids:model.monsters.map(m=>String(m.id)),rendered:[...document.querySelectorAll('[data-monster-id]')].map(e=>e.dataset.monsterId),
        quarter:model.monsters.every(m=>m.effects[0].value===.25),header:document.querySelector('.type-tools-resistance .tq-cat-header').textContent,
        expected:TypeTools.resistanceTitle(model),size:document.querySelector('.type-tools-avatar')?.getBoundingClientRect().width};
    });
    check(first.ids.length>0,'real normal-type single selection has quarter resistors');
    check(JSON.stringify(first.ids)===JSON.stringify(first.rendered)&&first.quarter,'single selection renders exactly quarter resistant stable IDs');
    check(first.header===first.expected,'resistance heading uses structured result counts');
    check(new Set(first.ids).size===first.ids.length,'no duplicate species IDs');
    check(await page.locator('.type-tools-copy').count()===1,'one locally scoped copy button adjacent to toggle');
    check(await page.evaluate(()=>getComputedStyle(document.querySelector('.type-tools-avatar')).width==='42px'),'type-tools stylesheet is linked and ring has expected size');
    await page.locator('.type-tools-copy').click();await waitCopied();
    check(await page.evaluate(()=>window.__typeToolsTest.calls.at(-1)===TypeTools.text(TypeTools.build(RKData,'attack',['Normal']),false)),'left clipboard equals attribute-only structured result');
    check(await page.evaluate(()=>!window.__typeToolsTest.calls.at(-1).includes('[ID:')),'left clipboard has no species identifiers or names list');
    await page.locator('.type-tools-copy').click({button:'right'});await waitCopied();
    check(await page.evaluate(()=>window.__typeToolsTest.calls.at(-1)===TypeTools.text(TypeTools.build(RKData,'attack',['Normal']),true)),'right clipboard appends exact current species mapping');
    check(await page.evaluate(()=>!/<img|<div|conic-gradient|\[ID:|\d×|各进攻属性独立判断/.test(window.__typeToolsTest.calls.at(-1))),'clipboard has no markup, IDs, suffix multipliers or extra explanation');
    check(await page.locator('.type-tools-status').innerText()==='','successful copy has no explanatory status text');

    const examples=await page.evaluate(()=>{
      const types=RKData.ALL_TYPES.map(RKData.getTypeEn),out={};
      outer:for(let a=0;a<types.length;a++)for(let b=a+1;b<types.length;b++){
        const selected=[types[a],types[b]],model=TypeTools.build(RKData,'attack',selected);
        for(const m of model.monsters){const n=m.effects.filter(e=>e.value===.25).length;if(!out[n])out[n]={selected,id:m.id,values:m.effects.map(e=>e.value)};}
        if(out[0]&&out[1]&&out[2])break outer;
      }
      outer:for(let a=0;a<types.length;a++)for(let b=a+1;b<types.length;b++)for(let c=b+1;c<types.length;c++){
        const selected=[types[a],types[b],types[c]],model=TypeTools.build(RKData,'attack',selected);
        const m=model.monsters.find(m=>m.effects.filter(e=>e.value===.25).length===1);
        if(m){out.third={selected,id:m.id,values:m.effects.map(e=>e.value)};break outer;}
      }
      return out;
    });
    for(const key of ['0','1','2','third']){
      check(!!examples[key],`real data contains resistance ring fixture ${key}`);
      const example=examples[key];await select(example.selected);
      const row=await page.evaluate(({selected,id})=>{
        const model=TypeTools.build(RKData,'attack',selected),m=model.monsters.find(m=>m.id===id),el=document.querySelector(`[data-monster-id="${id}"]`);
        return {exists:!!el,actual:el?.style.getPropertyValue('--type-tools-ring'),expected:TypeTools.ring(m.effects),aria:el?.getAttribute('aria-label'),title:el?.title,label:TypeTools.monsterLabel(m),
          innerBackground:getComputedStyle(el.querySelector('.type-tools-avatar-inner')).backgroundColor,
          radius:getComputedStyle(el).borderRadius,ids:[...document.querySelectorAll('[data-monster-id]')].map(n=>n.dataset.monsterId),expectedIDs:model.monsters.map(m=>String(m.id))};
      },example);
      check(row.exists&&row.actual===row.expected,`ordered ${key} red arc matches exact effect values`);
      check(row.title===row.label&&row.aria===row.label,`hover and accessibility list each selected attack multiplier (${key})`);
      check(row.radius==='50%'&&row.innerBackground!=='rgba(0, 0, 0, 0)',`ring is circular and confined outside opaque avatar (${key})`);
      check(JSON.stringify(row.ids)===JSON.stringify(row.expectedIDs),`rendered resistance pool matches model (${key})`);
      await page.locator('.type-tools-copy').click({button:'right'});await waitCopied();
      check(await page.evaluate(selected=>window.__typeToolsTest.calls.at(-1)===TypeTools.text(TypeTools.build(RKData,'attack',selected),true),example.selected),`right copy preserves all per-attack values (${key})`);
    }

    await select(['Fire','Water']);
    await page.locator('#mode-defense').click();await select(['Ground','Mechanical']);
    const defense=await page.evaluate(()=>({
      ids:[...document.querySelectorAll('[data-category]')].map(e=>e.dataset.category),
      species:document.querySelectorAll('[data-monster-id]').length,
      grid:[...document.querySelectorAll('.tc-result-item')].map(e=>e.title),
      model:TypeTools.build(RKData,'defense',['Ground','Mechanical']).grid.map(e=>({label:e.label,value:e.value}))
    }));
    check(JSON.stringify(defense.ids)===JSON.stringify(['triple','double','half','quarter','neutral']),'defense retains all five relationship sections');
    check(defense.species===0,'defense does not invent a species list');
    check(defense.model.every((e,i)=>defense.grid[i].includes(`合计：×${e.value}`)),'defense grid and classification use normalized same model, not raw 4x');
    await page.locator('.type-tools-copy').click({button:'right'});await waitCopied();
    check(await page.evaluate(()=>window.__typeToolsTest.calls.at(-1)===TypeTools.text(TypeTools.build(RKData,'defense',['Ground','Mechanical']),false)),'right defense copy has same existing attribute classification only');
    await page.locator('#mode-attack').click();
    check(await page.evaluate(()=>JSON.stringify([...document.querySelectorAll('#type-grid .active')].map(e=>e.dataset.type).sort())===JSON.stringify(['Fire','Water'])),'switching defense to attack restores independent selection');
    await page.locator('#mode-defense').click();
    check(await page.evaluate(()=>JSON.stringify([...document.querySelectorAll('#type-grid .active')].map(e=>e.dataset.type).sort())===JSON.stringify(['Ground','Mechanical'])),'switching attack to defense restores independent selection');

    // No new persisted state: remount only the page, just like app onLeave/render.
    const before=await page.evaluate(()=>window.__typeToolsTest.calls.length);
    await page.evaluate(()=>{
      const container=document.querySelector('.type-tools-page').parentElement;
      window.__typeToolsTest.old=document.querySelector('.type-tools-copy');
      TypesPage.onLeave();TypesPage.render(container);
      window.__typeToolsTest.old.click();
      window.__typeToolsTest.old.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
    });
    check(await page.evaluate(()=>window.__typeToolsTest.calls.length)===before,'detached page clipboard hooks removed');
    check(await page.evaluate(()=>document.querySelector('#mode-defense').classList.contains('active')&&document.querySelectorAll('#type-grid .active').length===2),'mode and selections survive re-entry in memory');
    await page.locator('.type-tools-copy').focus();await page.keyboard.press('Shift+Enter');await waitCopied();
    check(await page.evaluate(()=>window.__typeToolsTest.calls.length)===before+1,'Shift+Enter copies once without duplicate native click');
    await page.keyboard.press('Space');await waitCopied();
    check(await page.evaluate(()=>window.__typeToolsTest.calls.length)===before+2,'Space copies once as left click');
    await page.keyboard.press('Shift+Space');await waitCopied();
    check(await page.evaluate(()=>window.__typeToolsTest.calls.length)===before+3,'Shift+Space copies once as right click');
    check(await page.evaluate(()=>{
      const outside=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});
      document.querySelector('#select-hint').dispatchEvent(outside);return !outside.defaultPrevented;
    }),'context menu suppression is scoped to copy button only');
    const beforeMiddle=await page.evaluate(()=>window.__typeToolsTest.calls.length);
    await page.locator('.type-tools-copy').click({button:'middle'});
    check(await page.evaluate(()=>window.__typeToolsTest.calls.length)===beforeMiddle,'middle button does not copy');
    await page.evaluate(()=>window.__typeToolsTest.failure=true);
    await page.locator('.type-tools-copy').click();
    await page.waitForFunction(()=>document.querySelector('.type-tools-status').dataset.state==='error');
    check(await page.locator('.type-tools-status').innerText().then(s=>s.includes('复制失败')),'denied clipboard shows visible failure, never success');
    check(await page.locator('.type-tools-copy').innerText()==='复制','failure clears previous success label');
    await page.evaluate(()=>window.__typeToolsTest.failure=false);
    await page.locator('.type-tools-copy').click();await waitCopied();
    check(await page.locator('.type-tools-status').innerText()==='','successful retry clears error without adding explanation');

    await page.locator('#mode-attack').click();await select(['Normal']);
    const images=await page.evaluate(()=>[...document.querySelectorAll('.type-tools-avatar img')].map(img=>img.getAttribute('src')));
    check(images.length>0&&images.every(src=>!src.includes('%3Fv%3D')&&!src.includes(' ')),'encoded image paths retain real version query and no raw spaces');
    for(const theme of ['light','dark'])for(const font of ['Arial','Microsoft YaHei'])for(const zoom of [1,1.5,2]){
      await page.setViewportSize({width:1000,height:800});
      await page.evaluate(({theme,font,zoom})=>{
        document.documentElement.setAttribute('data-theme',theme);document.documentElement.style.setProperty('--app-font-family',font);document.documentElement.style.zoom=String(zoom);
        window.dispatchEvent(new Event('appfontchange'));window.dispatchEvent(new Event('appzoomchange'));
      },{theme,font,zoom});
      await page.waitForTimeout(100);
      const layout=await page.evaluate(()=>{
        const p=document.querySelector('.type-tools-page'),toggle=p.querySelector('.tq-toggle-bar').getBoundingClientRect(),button=p.querySelector('.type-tools-copy').getBoundingClientRect(),inner=p.querySelector('.type-tools-avatar-inner');
        return {overflow:p.scrollWidth>p.clientWidth+2,overlap:button.left<toggle.right-1&&button.top<toggle.bottom-1&&button.bottom>toggle.top+1,bg:getComputedStyle(inner).backgroundColor,ring:getComputedStyle(p.querySelector('.type-tools-avatar')).backgroundImage};
      });
      check(!layout.overflow,`no page horizontal overflow: ${theme}/${font}/${zoom}`);
      check(!layout.overlap,`mode/copy do not overlap: ${theme}/${font}/${zoom}`);
      check(layout.bg!=='rgba(0, 0, 0, 0)'&&layout.ring.includes('conic-gradient'),`opaque center and visible ring: ${theme}/${font}/${zoom}`);
    }
    await page.evaluate(()=>{
      document.documentElement.style.zoom='1';document.documentElement.setAttribute('data-theme','light');
      window.__typeToolsTest.defer=true;
    });
    await page.locator('.type-tools-copy').click();
    await page.waitForFunction(()=>!!window.__typeToolsTest.pending);
    await page.evaluate(()=>{const parent=document.querySelector('.type-tools-page').parentElement;TypesPage.onLeave();TypesPage.render(parent);window.__typeToolsTest.pending();});
    await page.waitForTimeout(30);
    check(await page.locator('.type-tools-copy').innerText()==='复制','late clipboard completion cannot mutate remounted page');
    check(await page.evaluate(()=>JSON.stringify(RKData.getMonsters())===window.__typeToolsTest.data),'all source monster records unchanged by UI/copy/tests');
    return {passed:checks.length,checks};
  } catch(error) {
    throw Error('After '+(checks.at(-1)||'initialization')+': '+error.message);
  } finally {
    await page.evaluate(()=>{
      const state=window.__typeToolsTest;if(!state)return;
      const container=document.querySelector('.type-tools-page')?.parentElement;
      TypesPage.onLeave();
      const html=document.documentElement;
      if(state.theme==null)html.removeAttribute('data-theme');else html.setAttribute('data-theme',state.theme);
      html.style.zoom=state.zoom;html.style.setProperty('--app-font-family',state.font);
      if(state.descriptor)Object.defineProperty(navigator,'clipboard',state.descriptor);else delete navigator.clipboard;
      delete window.__typeToolsTest;
      if(container)TypesPage.render(container);
    });
    await page.setViewportSize(original.viewport);
  }
}
