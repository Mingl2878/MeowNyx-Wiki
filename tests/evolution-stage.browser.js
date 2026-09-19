async page=>{
  const checks=[];const check=(v,s)=>{if(!v)throw Error(s);checks.push(s);};
  await page.evaluate(()=>location.hash='/petdex');await page.waitForSelector('#petdex-search');
  await page.locator('[data-listing-mode="expanded"]').click();
  await page.evaluate(()=>{
    for(const b of document.querySelectorAll('.form-btn')){
      if(b.dataset.form==='high'&&!b.classList.contains('active'))b.click();
      if(b.dataset.form==='leader'&&b.classList.contains('active'))b.click();
    }
  });
  for(const name of ['吸泥鸥','阿米樱','焰米龙']){
    await page.locator('#petdex-search').fill(name);
    check(await page.locator('#pet-table tbody tr[data-id]').count()===0,`${name} excluded by high form filter`);
    await page.locator('.form-btn[data-form="high"]').click();
    check(await page.locator('#pet-table tbody').innerText().then(s=>s.includes(name)),`${name} still selectable with stage filter off`);
    await page.locator('.form-btn[data-form="high"]').click();
  }
  await page.locator('#petdex-search').fill('圣凯布米龙');
  check((await page.locator('#pet-table tbody').innerText()).includes('圣凯布米龙'),'final high form remains visible');
  await page.locator('#petdex-search').fill('');
  await page.locator('.form-btn[data-form="leader"]').click();
  for(const name of ['淤泥乌泽','深渊罗隐']){
    await page.locator('#petdex-search').fill(name);
    check((await page.locator('#pet-table tbody').innerText()).includes(name),`${name} remains in leader filter`);
  }
  await page.evaluate(()=>location.hash='/settings');await page.waitForSelector('#set-effective-speed');
  check(!await page.locator('body').innerText().then(s=>s.includes('速度综合：基础速度达到门槛时计入整项速度')),'redundant explanation removed');
  await page.locator('[data-speed-mode="threshold"]').click();
  check(await page.locator('#set-effective-threshold').isVisible(),'threshold controls remain functional');
  return {passed:checks.length,checks};
}
