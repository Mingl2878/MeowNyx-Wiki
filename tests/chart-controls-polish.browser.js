// Parent-only suite: isolated profile + read-only/temporary-config server. Never personal storage.
async page => {
  const checks=[], errors=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const onError=e=>errors.push(e.message);page.on('pageerror',onError);
  const go=async route=>{await page.evaluate(r=>location.hash='/'+r,route);await page.waitForSelector(route==='chart'?'#defenseChart':'#basePower',{state:'attached'});};
  const item=key=>page.locator(`[data-favorite-key="${key}"]`);
  const markers=()=>page.evaluate(()=>Chart.getChart(document.getElementById('defenseChart')).data.datasets.find(d=>d.favoriteMarker)?.data.map(m=>({key:m.key,hp:m.hp,y:m.y,defense:m.defense,damage:m.damage,x:m.x}))||[]);
  const ordinary=()=>page.evaluate(()=>JSON.stringify(Chart.getChart(document.getElementById('defenseChart')).data.datasets.filter(d=>!d.favoriteMarker&&!d.reference).map(d=>d.data)));
  const ready=()=>page.waitForFunction(()=>!document.getElementById('chartAtkIVBtn').disabled);
  let saved,storagePatched=false;
  try {
    await go('damage');
    saved=await page.evaluate(()=>{window.__chartControlsOriginal={user:window.UserConfig,store:window.ChartWorkspace};window.__chartControlsData={};window.__chartControlsFail=false;return {storage:{...localStorage},state:JSON.parse(JSON.stringify(DamagePage.getState())),zoom:AppPreferences.getMaxZoom(),theme:document.documentElement.dataset.theme};});
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>AppPreferences.setMaxZoom(1,false));
    const source=await page.evaluate(()=>{
      const s=DamagePage.getState();Object.assign(s,{atkPet:RKData.getMonsterById(434),defPet:RKData.getMonsterById(602),atkIV:{},atkNature:{},defIV:{},defNature:{hp:2},favPets:[602,249],skillType:'attack',skillAttr:'光',basePower:187,fixedBonus:0,percentBonus:0,buff:0,comboCount:1});
      localStorage.setItem('rk_fav_pets','[602,249]');localStorage.setItem('rk_chart_fav_pets','[434,249]');
      localStorage.setItem('rk_pet_configs',JSON.stringify({249:{iv:{hp:true},nature:{hp:2,defense:2}}}));
      return {state:JSON.stringify(s),a:localStorage.getItem('rk_fav_pets'),configs:localStorage.getItem('rk_pet_configs')};
    });
    await page.evaluate(async()=>{const original=window.UserConfig;window.UserConfig={...original,getObject:(k,f)=>k==='rk_chart_workspace'?window.__chartControlsData:original.getObject(k,f),patch:async(k,v)=>{if(k!=='rk_chart_workspace')throw Error('unexpected write');if(window.__chartControlsFail)return false;window.__chartControlsData=structuredClone(v);return true;}};(0,eval)(await(await fetch('js/chart-workspace.js')).text());});
    await go('chart');await ready();
    if(await page.evaluate(()=>ChartPage.getState().mode!=='defense'))await page.locator('#chartModeBtn').click();
    if(!await page.evaluate(()=>ChartPage.getState().markersVisible))await page.locator('#chartFavoriteToggle').click();
    check(await page.evaluate(()=>{
      const groups=[...document.querySelectorAll('#chartControls .chart-control-group')];
      return groups.length===2&&groups[0].textContent.replace(/\s/g,'')==='攻击方：个体性格'
        &&groups[1].textContent.replace(/\s/g,'')==='防守方：防御双生命'
        &&!document.querySelector('#chartHPIVBtn,#chartHPNatureBtn,#chartMagicIVBtn,.chart-favorites-settings,#chartAttackControls,#chartAtkIVBtn2')
        &&!('markerIV' in ChartPage.getState())&&!('markerHPNature' in ChartPage.getState());
    }),'exactly one attacker pair and one defender pair; removed controls/state stay removed');
    check(await page.locator('#chartIVBtn').getAttribute('aria-pressed')==='true','defense IV defaults on independently of damage A');
    check(await page.locator('#chartDoubleLifeBtn').getAttribute('aria-pressed')==='false','double life starts off without inheriting A negative HP nature');
    check(await page.locator('.chart-favorites-item').count()===2&&await item('chart:249').count()===1&&await item('A:249').count()===0,'curve species only, overlap never duplicates avatars');
    check(await page.locator('.chart-origin-dot').count()===0,'source dots removed');
    let before=await markers();const curve=await ordinary();
    await page.locator('#chartIVBtn').click();await ready();let after=await markers();
    check(after.find(m=>m.key==='chart:434').defense<before.find(m=>m.key==='chart:434').defense&&await ordinary()!==curve,'defense toggle changes B and ordinary comparison together');
    check(JSON.stringify(after.filter(m=>m.key.startsWith('A:')))===JSON.stringify(before.filter(m=>m.key.startsWith('A:'))),'damage-source markers remain absent');
    await page.locator('#chartIVBtn').click();await ready();
    before=await markers();await page.locator('#chartDoubleLifeBtn').click({button:'right'});await ready();
    check(JSON.stringify(await markers())===JSON.stringify(before),'right-click cannot introduce negative or partial life configuration');
    await page.locator('#chartDoubleLifeBtn').click();await ready();after=await markers();
    check(after.find(m=>m.key==='chart:249').hp===455&&after.find(m=>m.key==='chart:249').y===455&&after.find(m=>m.key==='chart:249').x===136,'double life atomically gives WAND-V HP455 at defense136');
    check(JSON.stringify(after.filter(m=>m.key.startsWith('A:')))===JSON.stringify(before.filter(m=>m.key.startsWith('A:'))),'double life does not introduce damage-source avatars');
    await page.locator('#chartDoubleLifeBtn').click();await ready();
    check(JSON.stringify(await markers())===JSON.stringify(before),'double life off removes both HP IV and positive nature together');
    await page.locator('#chartDoubleLifeBtn').click();await ready();
    before=await markers();await page.locator('#chartAtkIVBtn').click();await ready();after=await markers();
    check(after.find(m=>m.key==='chart:434').damage!==before.find(m=>m.key==='chart:434').damage&&after.find(m=>m.key==='chart:434').hp===before.find(m=>m.key==='chart:434').hp,'curve target HP unchanged while curve attack IV affects damage');
    await page.locator('#chartAtkNatureBtn').click({button:'right'});await ready();
    check(await page.locator('#chartAtkNatureBtn').getAttribute('data-nature')==='2','attacker negative nature preserved');
    await page.locator('#chartIVBtn').click();await ready();
    check(await page.evaluate(()=>{
      const c=Chart.getChart(document.getElementById('defenseChart')),rows=c.data.datasets.filter(d=>!d.favoriteMarker&&!d.reference);
      return rows.length===8&&new Set(rows.map(d=>d.label)).size===8&&rows.every(d=>/^攻：[✓×]个体&(?:[✓×]性格|负性格) \/ 防：[✓×]个体&(?:[✓×]性格|负性格)$/.test(d.label)&&!d.label.includes('√'));
    }),'eight comparison combinations have unambiguous actual IV/nature/defense legends');
    check(await page.evaluate(()=>{
      const c=Chart.getChart(document.getElementById('defenseChart')),index=1;
      const label=c.legend.legendItems.find(i=>i.datasetIndex===index),wasVisible=c.isDatasetVisible(index);
      c.options.plugins.legend.onClick({},label,c.legend);
      const key=c.data.datasets[index].viewKey;
      window.__chartLegendFixture={key,hidden:wasVisible};
      return c.isDatasetVisible(index)!==wasVisible;
    }),'legend toggles retain dataset visibility semantics');
    await page.locator('#chartFavoriteToggle').click();
    await page.locator('#chartFavoriteToggle').click();
    check(await page.evaluate(()=>{
      const c=Chart.getChart(document.getElementById('defenseChart')),f=window.__chartLegendFixture;
      const i=c.data.datasets.findIndex(d=>d.viewKey===f.key);
      return c.isDatasetVisible(i)===!f.hidden;
    }),'legend state survives chart rebuilds');
    // Restore neutral attacker and selected physical defense for the next mode.
    await page.locator('#chartAtkIVBtn').click();await ready();await page.locator('#chartAtkNatureBtn').click({button:'right'});await ready();await page.locator('#chartIVBtn').click();await ready();
    await page.evaluate(()=>window.__chartControlNodes=[...document.querySelectorAll('#chartControls button')]);
    await page.locator('#chartModeBtn').click();
    check(await page.evaluate(()=>window.__chartControlNodes.every(n=>n.isConnected)&&document.querySelectorAll('#chartControls button').length===4),'mode switch reuses four shared controls without manual type-effect controls');
    check(await page.evaluate(()=>document.getElementById('chartInfo').textContent.includes('参考生命：'+RKData.getPetStat(DamagePage.getState().defPet,'hp',1,true))),'double life also drives ordinary reference HP');
    if(await page.locator('#chartAtkTypeBtn').innerText()==='物攻')await page.locator('#chartAtkTypeBtn').click();
    check(await page.locator('#chartIVBtn').getAttribute('aria-pressed')==='true'&&await page.locator('#chartIVBtn').getAttribute('title').then(t=>t.includes('魔防')),'same defense button now targets magical IV, default on');
    await page.locator('#chartIVBtn').click();await ready();
    check(await page.locator('#chartIVBtn').getAttribute('aria-pressed')==='false','magical IV can be toggled independently by the same control');
    await page.locator('#chartAtkTypeBtn').click();
    check(await page.locator('#chartIVBtn').getAttribute('aria-pressed')==='true','physical IV selection retained across attack-type switch');
    await page.locator('#chartModeBtn').click();
    const view=await page.evaluate(()=>JSON.stringify({overrides:ChartPage.getState().overrides,doubleLife:ChartPage.getState().doubleLife}));
    await page.evaluate(()=>{ChartPage.onLeave();ChartPage.render(document.getElementById('page-container'));});await ready();
    check(await page.evaluate(old=>JSON.stringify({overrides:ChartPage.getState().overrides,doubleLife:ChartPage.getState().doubleLife})===old,view),'shared selections survive leaving and returning');
    for(const theme of ['light','dark'])for(const zoom of [1,1.5,2]){
      await page.evaluate(({theme,zoom})=>{document.documentElement.dataset.theme=theme;AppPreferences.setMaxZoom(zoom,false);window.dispatchEvent(new CustomEvent('appthemechange'));},{theme,zoom});
      await page.locator('#chartFavoriteGrid').scrollIntoViewIfNeeded();
      await page.mouse.move(0,0); // Measure resting source borders, not the shared A hover accent.
      const valid=await page.evaluate(()=>[...document.querySelectorAll('.chart-favorites-item')].every(item=>{
        const image=item.querySelector('.quick-pet-img-wrapper > img, .quick-pet-initial'),i=getComputedStyle(item),a=getComputedStyle(image);
        const expected=getComputedStyle(document.documentElement).getPropertyValue('--border').trim();
        const probe=document.createElement('span');probe.style.color=expected;document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();
        return i.width==='50px'&&a.width==='44px'&&a.height==='44px'&&a.borderWidth==='2px'&&a.borderRadius==='6px'
          &&parseFloat(i.padding)===0&&parseFloat(i.borderWidth)===0&&a.borderColor===color;
      }));
      check(valid,`${theme} ${zoom*100}%: 44px avatars / 50px items, shared default borders without provenance`);
      check(await page.evaluate(()=>{const p=document.querySelector('.chart-page'),r=document.getElementById('chartControls').getBoundingClientRect();return p.scrollWidth<=p.clientWidth+1&&[...document.querySelectorAll('#chartControls button')].filter(n=>n.offsetParent).every(n=>{const b=n.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1;});}),`${theme} ${zoom*100}%: controls fit without horizontal overflow`);
    }
    await page.evaluate(()=>AppPreferences.setMaxZoom(1,false));
    await item('chart:249').click({button:'middle'});
    check(await item('chart:249').count()===1,'middle click never removes B');
    await item('chart:249').click({button:'right'});await ready();
    check(await item('chart:249').count()===0,'right click removes the curve species only');
    await page.evaluate(()=>window.__chartControlsFail=true);
    await item('chart:434').click({button:'right'});
    await page.waitForSelector('#chartWorkspaceRetry',{state:'visible'});
    check(await item('chart:434').count()===1&&await page.locator('#chartWorkspaceStatus').textContent().then(t=>t.includes('未保存')),'failed group save retains avatar and reports failure');
    await page.evaluate(()=>window.__chartControlsFail=false);await page.locator('#chartWorkspaceRetry').click();await ready();
    check(await item('chart:434').count()===0,'retry completes pending removal');
    await page.evaluate(async()=>{await ChartWorkspace.addPet(434);});await ready();
    await item('chart:434').focus();await page.keyboard.press('Delete');await ready();
    check(await item('chart:434').count()===0,'Delete remains accessible curve cancellation');
    check(await page.evaluate(old=>JSON.stringify(DamagePage.getState())===old.state&&localStorage.getItem('rk_fav_pets')===old.a&&localStorage.getItem('rk_pet_configs')===old.configs,source),'controls and avatars never write damage state/A/configs');
    check(errors.length===0,`no browser runtime errors: ${errors.join('; ')}`);
    return {passed:checks.length,checks};
  } finally {
    if(storagePatched)await page.evaluate(()=>{Storage.prototype.setItem=window.__chartSetItem;delete window.__chartSetItem;});
    page.off('pageerror',onError);
    if(saved)await page.evaluate(old=>{
      ChartPage.onLeave();window.ChartWorkspace?.dispose();window.ChartWorkspace=window.__chartControlsOriginal.store;window.UserConfig=window.__chartControlsOriginal.user;
      localStorage.clear();for(const[k,v]of Object.entries(old.storage))localStorage.setItem(k,v);
      Object.assign(DamagePage.getState(),old.state);AppPreferences.setMaxZoom(old.zoom,false);document.documentElement.dataset.theme=old.theme;
      delete window.__chartLegendFixture;delete window.__chartControlNodes;
    },saved);
    await page.reload();
  }
}
