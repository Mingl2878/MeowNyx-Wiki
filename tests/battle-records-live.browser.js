async page => {
  // Actual Go/SQLite API + UI. This fixture is temporary and never a user's DB.
  const origin=page.url().split('/').slice(0,3).join('/'),checks=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const info=await(await page.request.get(origin+'/__fixture/info')).json();if(!info.isolated)throw Error('isolated fixture required');
  await page.goto(origin+'/#/battle-records');await page.waitForSelector('.battle-records-page');
  await page.waitForFunction(()=>document.querySelector('[data-br="query-status"]')?.textContent.includes('已同步列表与统计'));
  const before=await page.evaluate(async()=>{await UserConfig.flush();return JSON.stringify(await(await fetch('/api/user-config')).json());});
  const imported=await page.evaluate(async()=>{
    const side=(pets,lead)=>({pets,lead,before:{score:0},after:{score:10}});
    const pet=(id,instanceId)=>({monsterId:id,instanceId,level:60,iv:{},nature:{}});
    function record(suffix,enemyPets,enemyLead,skill,complete,score){
      return {version:1,id:'isolated-api-'+suffix,source:'isolated-browser-test',mode:'pvp',outcome:suffix==='b'?'loss':'win',startedAt:'2060-01-01T00:00:00Z',endedAt:'2060-01-01T00:02:00Z',
        quality:{roster:{me:true,enemy:complete},actions:complete,lead:{me:true,enemy:true}},sides:{me:side([pet(222,'m')],'m'),enemy:{...side(enemyPets,enemyLead),before:score===null?{}:{score}}},
        events:[{id:'s1',round:1,seq:1,kind:'skill',phase:'executed',side:'me',actor:'m',skillId:37},{id:'s2',round:1,seq:2,kind:'skill',phase:'executed',side:'enemy',actor:enemyLead,skillId:skill},
          {id:'d1',round:1,seq:3,kind:'damage',phase:'executed',side:'enemy',actor:enemyLead,target:'m',targetSide:'me',amount:100},
          {id:'p1',round:1,seq:4,kind:'skill',phase:'preview',side:'enemy',actor:enemyLead,skillId:37}],issues:[]};
    }
    const records=[record('a',[pet(203,'e')],'e',37,true,100),record('b',[pet(203,'e')],'e',41,true,200),record('c',[pet(203,'e'),pet(522,'e2')],'e2',41,true,300),record('d',[pet(203,'e')],'e',37,false,null)];
    window.__actualBattleFixtureRecords=records;
    const response=await fetch('/api/battles/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,records})});
    return {status:response.status,body:await response.json()};
  });
  check(imported.status===200&&imported.body.imported===4,'actual SQLite API imports four isolated normalized battles');
  const query='from=2060-01-01T00%3A00%3A00Z&to=2060-01-02T00%3A00%3A00Z';
  const stats=await(await page.request.get(origin+'/api/battles/stats?'+query)).json();
  const enemy=stats.enemy.find(x=>x.monsterId===203),skill=enemy?.skills.find(x=>x.skillId===37);
  check(stats.matchedBattles===4,'time filter selects actual stored matches');
  check(skill?.usedBattles===1&&skill?.samples===2,'enemy skill incidence counts used1 / appeared-complete2, excludes bench and incomplete');
  check(enemy.carried===3&&enemy.carrySamples===3,'roster statistics use their own complete-roster denominator');
  check(enemy.appeared===2&&enemy.appearSamples===3,'actual appearance is distinct from roster carry');
  const filtered=await(await page.request.get(origin+'/api/battles/list?'+query+'&rankSide=enemy&rankMetric=score&rankMin=150&rankMax=250&pageSize=25')).json();
  const filteredStats=await(await page.request.get(origin+'/api/battles/stats?'+query+'&rankSide=enemy&rankMetric=score&rankMin=150&rankMax=250')).json();
  check(filtered.total===1&&filteredStats.matchedBattles===1&&filtered.records[0].id==='isolated-api-b','actual list and stats share rank/time filters, unknown rank not zero');
  const duplicates=await page.evaluate(async()=>{const r=await fetch('/api/battles/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,records:__actualBattleFixtureRecords})});return {status:r.status,body:await r.json()};});
  check(duplicates.status===200&&duplicates.body.imported===0&&duplicates.body.duplicates===4,'reimport is idempotent, no duplicate casts/matches');
  const bad=await page.evaluate(async()=>{const r=structuredClone(__actualBattleFixtureRecords[0]);r.events[0].skillId=41;const response=await fetch('/api/battles/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,records:[r]})});return response.status;});
  check(bad>=400,'conflicting event overwrite is rejected instead of silently replacing history');
  await page.locator('.battle-records-page').getByRole('button',{name:'刷新数据',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-br="query-status"]')?.textContent.includes('已同步列表与统计')&&document.querySelectorAll('.br-match').length===4);
  const match=page.locator('.br-match').filter({hasText:'isolated-api-a'});
  // IDs may be shown only in details; select by API order if list intentionally uses date+rosters.
  if(await match.count()) await match.getByRole('button',{name:'查看详情',exact:true}).click();
  else {const rows=await(await page.request.get(origin+'/api/battles/list?pageSize=25')).json();const index=rows.records.findIndex(r=>r.id==='isolated-api-a');await page.locator('.br-match').nth(index).getByRole('button',{name:'查看详情',exact:true}).click();}
  await page.waitForSelector('.battle-inference');
  check(await page.locator('.br-turn').count()===1,'actual stored events render turn timeline');
  await page.locator('.battle-inference summary').click();
  const form=page.locator('.battle-inference-form');
  const expectedDamage=await page.evaluate(()=>BattleMath.normalDamage(BattleMath.statFromEffectiveIV(RKData.getBaseStat(RKData.getMonsterById(203),'attack'),'attack',1,42,60),130,200));
  await form.locator('[name=knownStat]').fill('200');await form.locator('[name=damage]').fill(String(expectedDamage));await form.locator('[name=power]').fill('130');
  await form.locator('[name=provenance]').fill('isolated fixture: confirmed damage conditions');await form.locator('[name=confirmed]').check();
  await form.getByRole('button',{name:'分析并保存候选',exact:true}).click();
  await page.waitForFunction(async()=>{const r=await(await fetch('/api/battles/record?id=isolated-api-a')).json();return r.constraints?.length===1;});
  const inferred=await(await page.request.get(origin+'/api/battles/record?id=isolated-api-a')).json();
  const ep=inferred.sides.enemy.pets[0];
  check(ep.iv.attack.candidates.includes(42)&&ep.nature.attack.candidates.includes(1),'inference results persist via actual validated transactional import');
  check(['candidate','unique'].includes(ep.iv.attack.certainty),'candidate uncertainty remains explicit in stored record');
  await page.locator('[data-br-panel="detail"]').getByRole('button',{name:'用于伤害计算',exact:true}).click();
  await page.waitForSelector('#battle-snapshot-panel');
  check(await page.evaluate(()=>BattleRecordsClient.getRecord()?.id==='isolated-api-a'),'actual detail handoff reaches independent damage snapshot');
  check(await page.evaluate(async()=>{await UserConfig.flush();return JSON.stringify(await(await fetch('/api/user-config')).json());})===before,'actual imports, inference and handoff never write personal profile');
  const protectedStatus=await page.request.post(origin+'/api/battles/relay/start',{data:{url:'http://example.com:8765'}});
  check(protectedStatus.status()>=400,'relay rejects non-loopback destination without contacting it');
  return {passed:checks.length,checks};
}
