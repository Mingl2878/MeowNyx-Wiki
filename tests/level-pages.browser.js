// Run only by the parent on an isolated browser + temporary-config fixture.
async page => {
  const checks=[],errors=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const onError=e=>errors.push(e.message);page.on('pageerror',onError);
  const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const go=async route=>{await page.evaluate(r=>{location.hash='/'+r;},route);await page.waitForSelector(route==='speed'?'#speed-tier-table':'#defenseChart',{state:'attached'});await settle();};
  let saved;
  try{
    await go('speed');
    check(await page.evaluate(()=>{
      const p=RKData.getMonsterById(619);
      return p?.level_configurable===true&&RKData.getPetLevel(p)===99&&p.base_spd===70;
    }),'special619 has level99 default and approved speed qualification70');
    const ming='#speed-tier-table tr[data-row-key="pet:619"]';
    check(await page.locator(ming).count()===1,'speed has one dedicated stable619 row');
    check(await page.locator(ming+' .speed-row-label').textContent()==='70 · Lv99','speed selector initially99');
    check(await page.evaluate(()=>{
      const row=document.querySelector('#speed-tier-table tr[data-row-key="pet:619"]'),rows=[...row.parentElement.children],index=rows.indexOf(row);
      return rows.findIndex(r=>r.dataset.rowKey==='105:60')<index&&index<rows.findIndex(r=>r.dataset.rowKey==='100:60')&&row.dataset.baseSpeed==='70';
    }),'dedicated Ming row is pinned between105 and100 with real base70');
    check(await page.evaluate(()=>[49,44,40].every(base=>!document.querySelector(`#speed-tier-table tr[data-row-key="${base}:60"]`))&&!!document.querySelector('#speed-tier-table tr[data-row-key="50:60"]')),'default49/44/40 tiers absent while50 remains');
    await page.evaluate(()=>{
      const row=document.querySelector('#speed-tier-table tr[data-row-key="pet:619"]');
      window.__speedLevelFixture={row,lower:row.querySelector('[data-level-step="-1"]'),source:JSON.stringify(RKData.getMonsterById(619)),bubbles:0};
      const fixture=window.__speedLevelFixture;
      fixture.parent=row.closest('.speed-tier-table-wrap');
      fixture.listener=e=>{if(e.target.closest('.speed-level-step'))fixture.bubbles++;};
      for(const type of ['click','keydown','keyup'])fixture.parent.addEventListener(type,fixture.listener);
    });
    await page.locator('#tier-negnature-btn').click();
    await page.locator('#tier-fixed').fill('30');await page.locator('#tier-percent').fill('20');
    await page.locator(ming+' [data-col="iv"]').click();
    const grid=[1,9,19,29,39,49,59,69,79,89,99];
    for(const direction of [-1,1])for(const level of direction<0?[...grid].reverse():grid){
      if(Number(await page.locator(ming).getAttribute('data-level'))!==level)await page.locator(ming+` [data-level-step="${direction}"]`).press(level%20===9?'Enter':'Space');
      check(await page.evaluate(level=>{
        const row=document.querySelector('#speed-tier-table tr[data-row-key="pet:619"]'),f=window.__speedLevelFixture;
        if(row!==f.row||row.querySelector('[data-level-step="-1"]')!==f.lower||row.dataset.level!==String(level)||row.querySelector('.speed-row-label').textContent!==`70 · Lv${level}`)return false;
        if(document.querySelectorAll('#speed-tier-table tr[data-row-key="pet:619"]').length!==1)return false;
        const rows=[...row.parentElement.children],index=rows.indexOf(row);
        if(!(rows.findIndex(r=>r.dataset.rowKey==='105:60')<index&&index<rows.findIndex(r=>r.dataset.rowKey==='100:60'))||row.dataset.baseSpeed!=='70')return false;
        if(!row.querySelector('[data-col="iv"]').classList.contains('tier-selected'))return false;
        if(row.querySelector('[data-level-step="-1"]').disabled!==(level===1)||row.querySelector('[data-level-step="1"]').disabled!==(level===99))return false;
        const variants={negNature:[false,2],base:[false,0],iv:[true,0],ivNature:[true,1]};
        const threshold=BattleMath.basePower(BattleMath.statFromBase(70,'speed',0,true,level),30,20);
        for(const [key,[iv,n]]of Object.entries(variants)){
          const expected=BattleMath.statFromBase(70,'speed',n,iv,level),cell=row.querySelector(`[data-col="${key}"]`);
          if(Number(cell.textContent)!==(key==='iv'?BattleMath.basePower(expected,30,20):expected))return false;
          const ordinary=document.querySelector('#speed-tier-table tr[data-row-key="70:60"]');
          if(ordinary){const other=ordinary.querySelector(`[data-col="${key}"]`),regular=BattleMath.statFromBase(70,'speed',n,iv,60);if(Number(other.textContent)!==regular||other.classList.contains('tier-grayed')!==(regular<threshold))return false;}
        }
        return f.bubbles===0&&JSON.stringify(RKData.getMonsterById(619))===f.source;
      },level),`single speed row level${level} direction${direction}: retained DOM, all formulas, selected bonuses, comparisons, boundaries and isolated events`);
    }
    await page.locator(ming+' [data-level-step="-1"]').press('Enter');
    check(await page.evaluate(()=>document.activeElement===window.__speedLevelFixture.lower),'keyboard focus remains on stable level button after rerender');
    await page.locator('#tier-search').fill('冥古龙');await page.locator('#tier-fixed').fill('31');
    check(await page.locator(ming).getAttribute('data-level')==='89','search rerender retains chosen level89');
    await page.locator('#tier-fixed').fill('0');await page.locator('#tier-percent').fill('0');
    await page.locator('#tier-negnature-btn').click();
    await page.evaluate(()=>{
      const f=window.__speedLevelFixture;
      for(const type of ['click','keydown','keyup'])f.parent.removeEventListener(type,f.listener);
      delete window.__speedLevelFixture;
    });
    check(await page.evaluate(()=>{
      const ordinary=document.querySelector('#speed-tier-table tr[data-level="60"][data-base-speed="100"]');
      return ordinary&&Number(ordinary.querySelector('[data-col="base"]').textContent)===170;
    }),'ordinary qualification100 row retains speed170');
    check(await page.locator('#speed-tier-table tr[data-level="60"] [data-pet-id="619"]').count()===0,'special never appears beneath ordinary60 computed columns');
    check(await page.evaluate(()=>{
      for(const iv of [false,true])for(const n of [0,1,2]){
        const p=RKData.getMonsterById(619);
        if(RKData.getPetStat(p,'speed',n,iv)!==BattleMath.statFromBase(70,'speed',n,iv,99))return false;
      }return true;
    }),'all level99 speed nature/IV combinations use common formula');
    for(const base of [49,44,40]){
      const pet=await page.evaluate(base=>{const p=RKData.getMonsters().find(m=>!m.hidden&&m.base_spd===base);return p&&{id:p.id,name:RKData.getMonsterDisplayName(p)};},base);
      check(!!pet,`catalog has a searchable${base} fixture`);
      await page.locator('#tier-search').fill(pet.name);
      await page.locator(`.autocomplete-dropdown [data-monster-id="${pet.id}"]`).click();await settle();
      check(await page.locator(`#speed-tier-table tr[data-row-key="${base}:60"]`).count()===1,`explicit search temporarily restores${base}`);
      check(await page.locator(`#speed-tier-table tr[data-row-key="${base}:60"] [data-pet-id="${pet.id}"]`).count()===1,`searched low-speed${base} avatar is not cutoff`);
      await page.locator('#tier-search').fill('');await settle();
      check(await page.locator(`#speed-tier-table tr[data-row-key="${base}:60"]`).count()===0,`clearing immediately removes temporary${base}`);
    }
    saved=await page.evaluate(()=>{
      window.__levelPagesStore=window.ChartWorkspace;
      const state=structuredClone(DamagePage.getState());
      const controls={atkIV:{attack:true,magic_attack:true},atkNature:{attack:0,magic_attack:0},defIV:{defense:true,magic_defense:true},hpNature:true,doubleLife:true};
      window.ChartWorkspace={getStatus:()=>({initialized:true}),init:async()=>true,subscribe:()=>()=>{},isPreset:()=>false,getPresets:()=>[],getEntries:()=>[{id:619,key:'chart:619'},{id:249,key:'chart:249'}],getState:()=>({activeGroupId:'ungrouped',groups:[{id:'ungrouped',name:'test',petIds:[619,249]}],controls})};
      Object.assign(DamagePage.getState(),{atkPet:RKData.getMonsterById(619),defPet:RKData.getMonsterById(619),skillType:'attack',skillAttr:'普',basePower:100,fixedBonus:0,percentBonus:0,buff:0,comboCount:1});
      // Renderer-consumer fixture only; real controls are joined in chart-level-formulas.test.js.
      // Supply the actual level API, not nonexistent state.atkLevel/defLevel fields.
      window.__levelPagesEffectiveLevel=DamagePage.CalcEngine.effectiveLevel;
      DamagePage.CalcEngine.effectiveLevel=side=>side==='attacker'?43:9;
      return state;
    });
    await go('chart');await page.waitForFunction(()=>!document.getElementById('chartAtkIVBtn').disabled && !!Chart.getChart(document.getElementById('defenseChart')));
    if(await page.evaluate(()=>ChartPage.getState().mode!=='defense'))await page.locator('#chartModeBtn').click();
    await settle();
    check(await page.evaluate(()=>{
      const c=Chart.getChart(document.getElementById('defenseChart'));
      const attack=BattleMath.statFromBase(RKData.getBaseStat(RKData.getMonsterById(619),'attack'),'attack',0,true,43);
      return c.data.datasets[0].data.every((d,i)=>d===BattleMath.normalDamage(attack,100,BattleMath.statFromBase(Number(c.data.labels[i]),'defense',0,true,99),1,1,43));
    }),'defense curve uses effective attacker43 for both stat and coefficient, while virtual defender retains default99');
    check(await page.evaluate(()=>{
      const c=Chart.getChart(document.getElementById('defenseChart')),m=c.data.datasets.find(d=>d.favoriteMarker).data.find(m=>m.id===619);
      const p=RKData.getMonsterById(619),hp=RKData.getPetStat(p,'hp',1,true),defense=RKData.getPetStat(p,'defense',0,true),attack=BattleMath.statFromBase(RKData.getBaseStat(p,'attack'),'attack',0,true,43);
      const effect=DamagePage.CalcEngine.calcTypeEff(DamagePage.getState().skillAttr,p);
      return m.hp===hp&&m.defense===defense&&m.effect===effect&&m.y===hp/effect&&m.damage===BattleMath.normalDamage(attack,100,defense,1,1,43,effect);
    }),'special marker keeps defender default99 and curve-owned HP controls, with effective attacker43');
    check(await page.evaluate(()=>{
      const c=Chart.getChart(document.getElementById('defenseChart')),m=c.data.datasets.find(d=>d.favoriteMarker).data.find(m=>m.id===249);
      return m.hp===455&&m.defense===BattleMath.statFromBase(136,'defense',0,true,60)&&m.defenseMismatch;
    }),'ordinary favorite keeps level60 and warns when compared with a level99 virtual defense');
    const mingHP=await page.evaluate(()=>RKData.getPetStat(RKData.getMonsterById(619),'hp',1,true));
    check(await page.locator('[data-favorite-key="chart:619"]').getAttribute('title').then(s=>/① .* = /.test(s)&&s.includes('Lv43')&&s.includes('45 × 43')&&s.includes(` ÷ ${mingHP} `)&&!/中性未取整参考|配置来源/.test(s)),'tooltip contains concise real-level six steps without retired explanatory paragraphs');
    await page.locator('#chartModeBtn').click();await settle();
    if(await page.evaluate(()=>ChartPage.getState().sameType))await page.locator('#chartSameTypeBtn').click();
    for(const swapped of [false,true]){
      if(await page.evaluate(()=>ChartPage.getState().axisSwapped)!==swapped)await page.locator('#chartSwapAxisBtn').click();
      await page.locator('#chartPowerInput').fill(swapped?'120':'450');await settle();
      check(await page.evaluate(()=>{
        const c=Chart.getChart(document.getElementById('defenseChart')),v=ChartPage.getState();
        return c.data.datasets[0].data.every((d,i)=>{
          const x=Number(c.data.labels[i]),a=BattleMath.statFromBase(v.axisSwapped?v.qualification:x,'attack',0,true,43),p=BattleMath.finalPower(v.axisSwapped?x:v.power,0,0,v.sameType?1.25:1);
          const defense=RKData.getPetStat(RKData.getMonsterById(619),'defense',0,true);
          return d===BattleMath.normalDamage(a,p,defense,1,1,43,1);
        });
      }),`${swapped?'power':'qualification'} axis uses effective level43 attributes and coefficient`);
      check(await page.evaluate(()=>{
        const c=Chart.getChart(document.getElementById('defenseChart')),v=ChartPage.getState(),markers=c?.data.datasets.find(d=>d.favoriteMarker)?.data || [];
        return markers.length===2 && markers.every(m=>{
          if(m.x===null)return false;
          const damage=x=>BattleMath.normalDamage(BattleMath.statFromBase(v.axisSwapped?v.qualification:x,'attack',0,true,43),BattleMath.finalPower(v.axisSwapped?x:v.power,0,0,v.sameType?1.25:1),m.defense,1,1,43,m.effect);
          return m.damage===damage(v.axisSwapped?v.power:v.qualification)&&damage(m.x)>=m.hp&&(m.x===0||damage(m.x-1)<m.hp);
        });
      }),`${swapped?'power':'qualification'} marker current damage and integer minimum independently verified with final floor`);
    }
    await go('speed');
    check(await page.locator('#speed-tier-table tr[data-row-key="pet:619"]').getAttribute('data-level')==='89','speed page reentry retains session-only level89 after chart calculations');
    check(await page.locator('#speed-tier-table tr[data-row-key="pet:619"] .speed-row-label').textContent()==='70 · Lv89','reentered speed row keeps label and selected-level formulas');
    check(errors.length===0,'no browser errors');
    return {suite:'level-pages',passed:checks.length,checks};
  } finally {
    await page.evaluate(()=>{const f=window.__speedLevelFixture;if(f){for(const type of ['click','keydown','keyup'])f.parent.removeEventListener(type,f.listener);delete window.__speedLevelFixture;}});
    if(saved)await page.evaluate(state=>{Object.assign(DamagePage.getState(),state);DamagePage.CalcEngine.effectiveLevel=window.__levelPagesEffectiveLevel;delete window.__levelPagesEffectiveLevel;ChartPage.onLeave();window.ChartWorkspace=window.__levelPagesStore;delete window.__levelPagesStore;},saved);
    page.off('pageerror',onError);
  }
}
