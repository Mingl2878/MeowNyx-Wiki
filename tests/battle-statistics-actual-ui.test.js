'use strict';
// Optional sanitized statistics export only; never opens a battle database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const statsPath = process.env.XHM_FINAL_UI_STATS;
test('frozen real statistics render current own-species modal and exact-lineup matchup portal without writes', { skip: !statsPath }, async t => {
  const harnessPath = path.join(__dirname, 'battle-records-ui.test.js'), source = fs.readFileSync(harnessPath, 'utf8');
  const box = { module: { exports: {} }, require: createRequire(harnessPath), __dirname, console, AbortController, URLSearchParams, setImmediate };
  vm.runInNewContext(source.slice(0, source.indexOf('\ntest(')) + '\nmodule.exports=runtime;', box, { filename: harnessPath });
  const raw = fs.readFileSync(statsPath, 'utf8'), stats = JSON.parse(raw), before = JSON.stringify(stats);
  // Names are presentation fixtures; actual evidence is the sanitized DTO.
  const r = box.module.exports({ stats, data: { getMonsterById: id => ({ id }), getMonsterDisplayName: pet => '精灵' + pet.id,
    getMoves: () => [...new Set((stats.selfSkills || []).map(row => row.skillId).filter(id => id > 0))].map(id => ({ id })), getMoveName: skill => '技能' + skill.id,
    getTypes: () => Array.from({ length: 18 }, (_, index) => ({ id: index + 1 })), getTypeObjZh: type => '属性' + type.id } });
  t.after(() => r.page.onLeave()); await new Promise(resolve => setImmediate(resolve)); r.btn('样本统计').click(); await new Promise(resolve=>setImmediate(resolve));
  const own = r.find(node => node.dataset.brStats === 'me');
  assert.doesNotMatch(own.textContent, /部分记录|统计口径与覆盖|来源 \/ 数据提示/);
  const lineup = stats.selfPerformance.completeLineups[0];
  if (lineup) {
    const key = JSON.stringify([...lineup.monsterIds].sort((a,b) => a-b)), choice = r.find(node => node.tagName === 'button' && node.dataset.lineupKey === key);
    assert.ok(choice); choice.click();assert.equal(choice.getAttribute('aria-haspopup'),'dialog');assert.equal(choice.getAttribute('aria-expanded'),null);
    const lineupModal=r.find(n=>n.dataset.modalKind==='own-lineup');assert.ok(lineupModal);assert.ok(r.all(lineupModal).some(node=>node.className==='br-own-matchups'));assert.equal(r.all(own).some(node=>node.className==='br-own-matchups'),false);
    const lineupSkills=r.all(lineupModal).filter(n=>n.className==='br-own-skill-usage');for(const usage of lineupSkills){const species=Number(usage.dataset.skillMonsterId),entries=(lineup.selfSkills||[]).filter(x=>x.monsterId===species&&x.casts>0&&(x.kind==='wishImpact'||((!x.kind||x.kind==='skill')&&x.skillId>0)));if(entries.length)assert.equal(Number(usage.dataset.total),entries.reduce((n,x)=>n+x.casts,0));}
    r.root.document.emit('keydown',{key:'Escape'});assert.equal(r.find(n=>n.dataset.modalKind==='own-lineup'),undefined);
  }
  const calls = r.calls.length;
  for (const species of stats.selfPerformance.species) {
    const identity = r.all(own).find(node => node.dataset.performanceMonsterId === String(species.monsterId));
    assert.match(identity.textContent, /登场局数/);
    const trigger = r.all(identity).find(node => node.dataset.departureMonsterId); assert.ok(trigger); trigger.click();
    const modal = r.find(node => node.dataset.modalKind === 'departures'), usage = r.all(modal).find(node => node.className === 'br-own-skill-usage');
    assert.equal(usage.dataset.skillMonsterId, String(species.monsterId));
    const skills = (stats.selfSkills || []).filter(row => row.monsterId === species.monsterId && row.casts > 0 && (row.kind === 'wishImpact' || ((!row.kind || row.kind === 'skill') && row.skillId > 0)));
    if (skills.length) {
      assert.equal(Number(usage.dataset.total), skills.reduce((sum, row) => sum + row.casts, 0));
      assert.ok(r.all(usage).some(node => node.tagName === 'svg')); assert.ok(r.all(usage).some(node => node.tagName === 'table'));
    }
    assert.equal(r.all(modal).some(node => node.dataset.reason === 'voluntary'), false);
    r.root.document.emit('keydown', { key: 'Escape' }); assert.equal(r.find(node => node.dataset.modalKind === 'departures'), undefined);
  }
  assert.equal(r.calls.length, calls); assert.equal(r.calls.some(call => call.options.method || call.url.includes('/record?')), false);
  assert.equal(JSON.stringify(stats), before); assert.equal(fs.readFileSync(statsPath, 'utf8'), raw);
});
