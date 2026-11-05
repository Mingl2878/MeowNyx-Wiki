'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('../js/skill-simulation.js'), V = require('../js/skill-variants.js');
const { harness, plain, moves } = require('./skill-simulation-fixture.cjs');
const monsters = require('./catalog-read-fixture.cjs').readProjectData('monsters.json');
const fire = monsters.find(p => p.id === 14), blow = moves.find(m => m.id === 113);
const BLANK_BUFF_INPUTS = ['', '   ', '\t', '\n', ' \t\r\n '];
function setup(savedProfile, bind = true) {
  const h = harness({ savedProfile });
  h.RKData.getMonsterById = id => monsters.find(p => p.id === Number(id));
  h.RKData.getMonsters = () => monsters;
  h.RKData.getLeaderBase = p => monsters.find(m => m.id === p?.leader_of_id && !m.is_leader_form) || null;
  h.RKData.getMonsterDisplayName = p => p.localized?.zh?.name || p.name || 'Fixture';
  h.RKData.typeBadgeHtml = type => `<span>${type}</span>`;
  for (const side of ['attacker', 'defender']) {
    h.document.getElementById(side + 'Types').insertAdjacentHTML = function (_, html) { this.innerHTML += html; };
    h.page.searchBoxes[side] = { input: h.document.createElement(), setValue() {}, destroy() {} };
  }
  // Only the battle roster panel DOM is omitted; actual snapshot application,
  // calculation, growth, save guards and exit restoration all run unmodified.
  const get = h.document.getElementById.bind(h.document);
  h.document.getElementById = id => id === 'battle-snapshot-panel' ? null : get(id);
  if (bind) h.page.bindEvents();
  h.choose = id => h.page.selectPet('attacker', h.RKData.getMonsterById(id), null, 'history');
  h.input = (id, value) => { const el = h.document.getElementById(id); el.value = String(value); el.fire('input'); };
  h.growth = () => h.profile.rk_skill_simulation?.['14:113'];
  h.choose(14);
  return h;
}
function saved(record, buff = 20) {
  return {rk_skill_simulation:{'14:113':record}, rk_damage_skill_configs:{14:{buff,basePower:50+20*(record.powerCount||0),currentSkillName:'吹火'}}, rk_damage_selection:{attacker:14}};
}

test('reviewed fire god/blow fire uses one n: 50 => 0, 50+(1*20) => 30, 50+(2*20) => 60', () => {
  assert.equal(fire.localized.zh.name, '烈火战神');
  assert.ok(S.fireAttackEnabled(fire));
  assert.equal(blow.power, 50);
  const original = JSON.stringify({fire, blow});
  let record = {future: {keep: true}};
  for (let n = 0; n <= 4; n++) {
    const result = S.select(blow, fire, n ? 'right' : 'left', record);
    assert.equal(result.values.basePower, 50 + 20 * n);
    assert.equal(result.values.basePowerExpression, n ? `50+(${n}*20)` : '');
    assert.equal(result.fireAttackBonus, 30 * n);
    assert.equal(result.record.powerCount, n);
    assert.equal(result.record.fireAttackCount, n);
    assert.equal(result.record.firePowerDetached, false);
    assert.deepEqual(result.record.future, {keep: true});
    record = result.record;
  }
  const cleared = S.select(blow, fire, 'left', record);
  assert.equal(cleared.values.basePower, 50);
  assert.equal(cleared.record.powerCount, 0);
  assert.equal(cleared.record.fireAttackCount, 0);
  assert.equal(cleared.fireAttackBonus, 0);
  assert.equal(S.select(blow, fire, 'right', cleared.record).fireAttackBonus, 30, 'first right click immediately matches n=1');
  assert.equal(cleared.record.fireBuffOverridden, false);
  assert.equal(S.select(blow, fire, 'middle', record).applied, false);
  assert.equal(JSON.stringify({fire, blow}), original);
});

test('growth is stable-ID/trait scoped, only blow fire triggers, and whitespace alone is harmless', () => {
  const whitespace = structuredClone(fire); whitespace.trait.localized.zh.description = '\n使用火系技能后， 获得双攻永久+30%。\n';
  assert.ok(S.fireAttackEnabled(whitespace));
  for (const pet of [{...fire, id:13}, {id:14}, {...fire, trait:{localized:{zh:{name:'爆燃',description:'使用火系技能后，获得双攻永久+40%。'}}}}]) {
    assert.equal(S.fireAttackEnabled(pet), false);
    const result = S.select(blow, pet, 'right', {});
    assert.equal(result.fireAttackBonus, undefined);
    assert.equal(result.record.firePowerDetached, undefined);
    assert.equal(S.fireAttackBonus(pet, {powerCount:9,fireAttackCount:9}), 0);
  }
  for (const id of [131, 41, 535, 19, 510]) {
    const result = S.select(moves.find(m=>m.id===id), fire, 'right', {});
    assert.equal(result?.fireAttackBonus, undefined, `another skill ${id} cannot trigger growth`);
    assert.equal(result?.record?.fireAttackCount, undefined);
    assert.equal(result?.record?.firePowerDetached, undefined);
  }
});

test('unmarked legacy power-only and mismatched records restore authoritative n without mutation', () => {
  assert.equal(S.fireAttackBonus(fire, {}), 0);
  for (const n of [0,1,2,5,S.MAX_COUNT]) {
    for (const record of [{powerCount:n}, {powerCount:n,fireAttackCount:0}, {powerCount:n,fireAttackCount:7}, {powerCount:n,fireAttackCount:2,firePowerDetached:false}]) {
      record.unknown = {keep:true};
      const before = structuredClone(record);
      assert.equal(S.fireAttackBonus(fire, record), n*30);
      assert.deepEqual(record, before, 'restoration must not backfill or migrate stored records');
      if (n < S.MAX_COUNT) {
        const next = S.select(blow, fire, 'right', record);
        assert.equal(next.values.basePower, 50+(n+1)*20);
        assert.equal(next.record.powerCount, n+1);
        assert.equal(next.record.fireAttackCount, n+1);
        assert.equal(next.record.firePowerDetached, false);
        assert.equal(next.fireAttackBonus, (n+1)*30);
        assert.deepEqual(next.record.unknown, {keep:true});
        assert.deepEqual(record, before);
      }
    }
  }
  assert.equal(S.fireAttackBonus(fire, {fireAttackCount:9}), 0, 'no power count means n=0, not independent fire growth');
});

test('explicit manual-power provenance alone retains growth; every 113 selection realigns both counts', () => {
  for (const pc of [0,3]) {
    const record = {powerCount:pc,fireAttackCount:7,firePowerDetached:true,unknown:'keep'}, before = {...record};
    assert.equal(S.fireAttackBonus(fire, record), 210);
    const next = S.select(blow, fire, 'right', record);
    assert.equal(next.record.powerCount, pc+1);
    assert.equal(next.record.fireAttackCount, pc+1);
    assert.equal(next.record.firePowerDetached, false);
    assert.equal(next.fireAttackBonus, (pc+1)*30);
    const cleared = S.select(blow, fire, 'left', record);
    assert.equal(cleared.record.powerCount, 0); assert.equal(cleared.record.fireAttackCount, 0);
    assert.equal(cleared.record.firePowerDetached, false); assert.equal(cleared.fireAttackBonus, 0);
    assert.deepEqual(record, before);
  }
});

test('malformed known fields reject before alignment; power n alone controls the growth limit', () => {
  for (const key of ['powerCount','fireAttackCount']) {
    for (const count of [undefined, null, -1, 1.5, '1', false, NaN, Infinity, S.MAX_COUNT+1]) {
      const record = {powerCount:2,fireAttackCount:2,[key]:count}, before = {...record};
      assert.throws(()=>S.fireAttackBonus(fire, record), /范围/);
      for (const side of ['left','right']) assert.throws(()=>S.select(blow, fire, side, record), /范围/);
      assert.deepEqual(record, before);
    }
  }
  for (const marker of [undefined,null,0,1,'true',{},[]]) {
    const record = {powerCount:2,fireAttackCount:2,firePowerDetached:marker}, before = {...record};
    assert.throws(()=>S.fireAttackBonus(fire, record), /标记/);
    assert.throws(()=>S.select(blow, fire, 'right', record), /标记/);
    assert.deepEqual(record, before);
  }
  const nearLimit = {powerCount:S.MAX_COUNT-1,fireAttackCount:2};
  const atLimit = S.select(blow, fire, 'right', nearLimit);
  assert.equal(atLimit.record.fireAttackCount, S.MAX_COUNT);
  assert.equal(atLimit.fireAttackBonus, S.MAX_COUNT*30);
  assert.throws(()=>S.select(blow, fire, 'right', atLimit.record), /范围/);
  const reset = S.select(blow, fire, 'left', atLimit.record);
  assert.equal(reset.fireAttackBonus, 0);
  const staleMirror = S.select(blow, fire, 'right', {powerCount:2,fireAttackCount:S.MAX_COUNT});
  assert.equal(staleMirror.record.fireAttackCount, 3, 'valid stale mirror must not independently overflow');
});

test('real icon events update displayed buff; physical/magic skills keep growth but not blow-fire power', () => {
  const h = setup();
  h.icon(113).fire('click');
  assert.equal(h.state.basePower,50); assert.equal(h.state.buff,0);
  for (let n = 1; n <= 3; n++) {
    h.icon(113).fire('contextmenu');
    assert.equal(h.state.basePower, 50+20*n);
    assert.equal(h.document.getElementById('basePower').value, `50+(${n}*20)`);
    assert.equal(h.state.buff, 30*n);
    assert.equal(Number(h.document.getElementById('buff').value), 30*n);
    assert.equal(h.state.percentBonus, 0);
    assert.equal(h.growth().powerCount, n); assert.equal(h.growth().fireAttackCount, n);
    assert.equal(h.growth().firePowerDetached, false);
    assert.equal(h.profile.rk_damage_skill_configs[14].buff, 0, 'snapshot stores manual component, not derived growth');
    assert.equal(h.profile.rk_damage_view.skill.buff, 0);
  }
  for (const id of [41, 535]) {
    h.icon(id).fire('click');
    const m = moves.find(m=>m.id===id), result = h.page.CalcEngine.calculate();
    assert.equal(h.state.basePower, V.forAttacker(m,fire).left.basePower);
    assert.equal(h.state.skillType, m.move_category==='Magic Attack'?'magic_attack':'attack');
    assert.equal(h.state.buff, 90);
    assert.equal(result.buffMod, 1.9);
    assert.equal(result.skillFinalPower, h.page.CalcEngine.calcFinalPower(h.state.basePower,0,0,fire,h.state.defPet,h.state.skillAttr,90,null));
    assert.equal(h.growth().fireAttackCount, 3);
  }
  h.icon(131).fire('contextmenu');
  assert.equal(h.state.buff, 90, 'another fire skill does not trigger a fourth growth');
  h.icon(113).fire('click');
  assert.equal(h.state.buff,0); assert.equal(h.state.basePower,50);
  assert.equal(h.growth().fireAttackCount,0); assert.equal(h.growth().powerCount,0);
});

test('manual buff before growth survives reset; a later edit replaces the baseline literally', () => {
  const h = setup(); h.input('buff','10+10'); h.input('percentBonus',17);
  h.icon(113).fire('contextmenu'); assert.equal(h.state.buff,50, 'first click adds 30 to independent manual buff');
  h.icon(113).fire('contextmenu');
  assert.equal(h.state.buff,80); assert.equal(h.state.percentBonus,17);
  assert.equal(h.page.skillSnapshot().buff,20);
  h.icon(113).fire('click'); assert.equal(h.state.buff,20, 'reset preserves the original manual20');
  h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
  h.input('buff',100); // A deliberate edit replaces the complete displayed BUFF.
  assert.equal(h.page.skillSnapshot().buff,100);
  assert.equal(h.growth().fireBuffOverridden,true);
  h.icon(535).fire('click'); assert.equal(h.state.buff,100);
  h.icon(113).fire('click');
  assert.equal(h.state.buff,100); assert.equal(h.state.percentBonus,17);
  assert.equal(h.profile.rk_damage_skill_configs[14].buff,100);
  h.icon(113).fire('contextmenu'); assert.equal(h.state.buff,130);
  h.icon(113).fire('contextmenu'); assert.equal(h.state.buff,160);
});

test('species switches, active startup and repeated restores never clear or double-add persisted growth', () => {
  const h = setup(); h.input('buff',20);
  h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu'); h.icon(535).fire('click');
  const snapshot = plain(h.page.skillSnapshot());
  h.choose(13); assert.equal(h.state.buff,0);
  h.icon(113).fire('contextmenu'); assert.equal(h.state.buff,0);
  assert.equal(h.profile.rk_skill_simulation['13:113'].fireAttackCount,undefined);
  h.choose(14); assert.equal(h.state.buff,80); assert.equal(h.state.currentSkillName,snapshot.currentSkillName);
  assert.equal(h.state.basePower,snapshot.basePower);
  const restarted = setup(plain(h.profile)); restarted.page.initDefaultPets();
  assert.equal(restarted.state.atkPet.id,14); assert.equal(restarted.state.buff,80);
  assert.equal(restarted.state.currentSkillName,snapshot.currentSkillName);
  for (let i=0;i<3;i++) {
    restarted.page.applySkillMemory(14); restarted.page.restoreFromState(); restarted.page.saveSkillConfig(14);
    assert.equal(restarted.state.buff,80); assert.equal(restarted.profile.rk_damage_skill_configs[14].buff,20);
  }
  restarted.icon(113).fire('contextmenu');
  assert.equal(restarted.state.buff,110); assert.equal(restarted.growth().fireAttackCount,3);
  assert.equal(restarted.state.basePower,110);
  restarted.icon(113).fire('click');
  const cleared = setup(restarted.profile); cleared.page.initDefaultPets();
  assert.equal(cleared.state.buff,20); assert.equal(cleared.state.basePower,50);
});

test('first +20/+30 click survives skill/species switches and restart before the second click', () => {
  const h=setup(); h.input('buff',20); h.icon(113).fire('contextmenu');
  assert.equal(h.state.buff,50); assert.equal(h.growth().fireAttackCount,1);
  h.icon(535).fire('click'); assert.equal(h.state.buff,50);
  h.choose(13); h.choose(14); assert.equal(h.state.buff,50);
  const restarted=setup(h.profile); restarted.page.initDefaultPets();
  assert.equal(restarted.state.buff,50); assert.equal(restarted.growth().fireAttackCount,1);
  restarted.page.applySkillMemory(14); restarted.page.restoreFromState();
  assert.equal(restarted.state.buff,50); assert.equal(restarted.page.skillSnapshot().buff,20);
  restarted.icon(113).fire('contextmenu');
  assert.equal(restarted.state.buff,80); assert.equal(restarted.growth().fireAttackCount,2);
  assert.equal(restarted.state.basePower,90);
});

test('manual blow-fire power retains growth through restores, then next explicit113 realigns to resulting n', () => {
  const h=setup(); h.input('buff',20); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
  h.input('basePower',999);
  assert.equal(h.state.basePower,999); assert.equal(h.state.buff,80);
  assert.equal(h.growth().powerCount,0); assert.equal(h.growth().fireAttackCount,2);
  assert.equal(h.growth().firePowerDetached,true);
  h.input('basePower',777); assert.equal(h.state.buff,80);
  h.icon(535).fire('click'); h.choose(13); h.choose(14); assert.equal(h.state.buff,80);
  const restarted=setup(h.profile); restarted.page.initDefaultPets();
  assert.equal(restarted.state.buff,80); assert.equal(restarted.page.skillSnapshot().buff,20);
  restarted.icon(113).fire('contextmenu');
  assert.equal(restarted.state.basePower,70); assert.equal(restarted.state.basePowerExpression,'50+(1*20)');
  assert.equal(restarted.state.buff,50); assert.equal(restarted.growth().powerCount,1);
  assert.equal(restarted.growth().fireAttackCount,1); assert.equal(restarted.growth().firePowerDetached,false);
  restarted.input('basePower',999); restarted.icon(113).fire('click');
  assert.equal(restarted.state.basePower,50); assert.equal(restarted.state.buff,20);
  assert.equal(restarted.growth().fireAttackCount,0); assert.equal(restarted.growth().firePowerDetached,false);
});

test('manual edit materializes currently derived legacy n, not the stale mirror; unrelated edits do not detach', () => {
  const h=setup(saved({powerCount:2,fireAttackCount:8,unknown:'keep'}));
  assert.equal(h.state.buff,80);
  h.input('basePower',555);
  assert.equal(h.growth().powerCount,0); assert.equal(h.growth().fireAttackCount,2);
  assert.equal(h.growth().firePowerDetached,true); assert.equal(h.state.buff,80);
  assert.equal(h.growth().unknown,'keep');
  h.icon(41).fire('click'); h.input('basePower',123);
  assert.equal(h.growth().fireAttackCount,2); assert.equal(h.state.buff,80);
  assert.equal(h.profile.rk_skill_simulation['14:41'].firePowerDetached,undefined);
  h.choose(13); h.icon(113).fire('click'); h.input('basePower',321);
  assert.equal(h.profile.rk_skill_simulation['13:113'].firePowerDetached,undefined);
});

test('legacy and mismatched profiles restore one n without counter migration or snapshot double counting', () => {
  for (const record of [{powerCount:4}, {powerCount:4,fireAttackCount:0}, {powerCount:4,fireAttackCount:1}, {powerCount:4,fireAttackCount:8}, {powerCount:0,fireAttackCount:9}, {fireAttackCount:9}]) {
    record.unknown='keep';
    const profile=saved(record), original=plain(profile), n=record.powerCount||0;
    const h=setup(profile); h.page.initDefaultPets();
    assert.equal(h.state.buff,20+n*30);
    h.page.applySkillMemory(14); h.page.restoreFromState();
    assert.equal(h.state.buff,20+n*30); assert.deepEqual(plain(h.growth()),record);
    assert.equal(h.writes.filter(w=>w.key==='rk_skill_simulation').length,0,'read/restore never rewrites simulation records');
    h.page.saveSkillConfig(14); assert.equal(h.profile.rk_damage_skill_configs[14].buff,20);
    h.icon(113).fire('contextmenu');
    assert.equal(h.state.buff,20+(n+1)*30);
    assert.equal(h.growth().powerCount,n+1); assert.equal(h.growth().fireAttackCount,n+1);
    assert.equal(h.growth().firePowerDetached,false); assert.equal(h.growth().unknown,'keep');
    assert.deepEqual(profile,original,'in-memory fixture must not modify its supplied saved profile');
  }
});

test('invalid buff draft, growth overflow or changed source cannot partly advance growth', () => {
  const h=setup(); h.icon(113).fire('contextmenu');
  const before=plain(h.page.skillSnapshot()), record=plain(h.growth());
  h.document.getElementById('buff').value='20+'; const writes=h.writes.length;
  h.icon(113).fire('contextmenu');
  assert.deepEqual(plain(h.page.skillSnapshot()),before); assert.deepEqual(plain(h.growth()),record); assert.equal(h.writes.length,writes);
  h.document.getElementById('buff').value=h.state.buff;
  h.growth().powerCount=S.MAX_COUNT;
  h.icon(113).fire('contextmenu'); assert.equal(h.growth().fireAttackCount,record.fireAttackCount); assert.equal(h.writes.length,writes);
  h.growth().powerCount=record.powerCount;
  const old=h.RKData.getMoves;
  h.RKData.getMoves=()=>old().map(m=>m.id===113?{...m,localized:{zh:{...m.localized.zh,description:m.localized.zh.description+'新机制'}}}:m);
  h.page.renderSkillIcons(); h.icon(113).fire('contextmenu');
  assert.deepEqual(plain(h.page.skillSnapshot()),before); assert.deepEqual(plain(h.growth()),record); assert.equal(h.writes.length,writes);
});

test('incomplete buff input keeps last valid total and cannot persist a phantom negative manual buff',()=>{
  const h=setup(); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu'); const writes=h.writes.length;
  h.input('buff','1+');
  assert.equal(h.state.buff,60); assert.equal(h.writes.length,writes);
  assert.equal(h.document.getElementById('buff').attrs['aria-invalid'],'true');
  h.input('fixedBonus',10);
  assert.equal(h.profile.rk_damage_skill_configs[14].buff,0);
  assert.equal(h.growth().fireAttackCount,2);
  const restarted=setup(h.profile); restarted.page.initDefaultPets();
  assert.equal(restarted.state.buff,60);
  restarted.icon(113).fire('click'); assert.equal(restarted.state.buff,0);
  assert.equal(restarted.profile.rk_damage_skill_configs[14].buff,0);
  h.choose(13); assert.equal(h.state.buff,0);
  assert.equal(h.document.getElementById('buff').attrs['aria-invalid'],'false','old draft validation must not leak to another species');
  h.choose(14); assert.equal(h.state.buff,60);
});

test('literal manual boundaries save exactly without hidden compensation; later growth still checks overflow',()=>{
  const h=setup(); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
  h.input('buff',-Number.MAX_SAFE_INTEGER);
  assert.equal(h.state.buff,-Number.MAX_SAFE_INTEGER);
  assert.equal(h.profile.rk_damage_skill_configs[14].buff,-Number.MAX_SAFE_INTEGER);
  const negative=setup(h.profile); negative.page.initDefaultPets();
  assert.equal(negative.state.buff,-Number.MAX_SAFE_INTEGER);
  h.input('buff',Number.MAX_SAFE_INTEGER);
  assert.equal(h.state.buff,Number.MAX_SAFE_INTEGER);
  assert.equal(h.profile.rk_damage_skill_configs[14].buff,Number.MAX_SAFE_INTEGER);
  const restored=setup(h.profile); restored.page.initDefaultPets();
  assert.equal(restored.state.buff,Number.MAX_SAFE_INTEGER);
  const count=restored.growth().fireAttackCount;
  restored.icon(113).fire('contextmenu');
  assert.equal(restored.growth().fireAttackCount,count);
  assert.equal(restored.state.buff,Number.MAX_SAFE_INTEGER);
});

for (const firstSide of ['attacker','defender']) for (const detached of [false,true]) test(`battle snapshot ${firstSide}-first, personal detached=${detached}: isolated counts and restored growth`,()=>{
  const h=setup(); h.input('buff',20); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
  if (detached) h.input('basePower',999);
  const before=plain(h.profile), snapshot=plain(h.page.skillSnapshot()), buff=h.state.buff;
  const record={sides:{me:{pets:[{instanceId:'fire',monsterId:14}]},enemy:{pets:[{instanceId:'other',monsterId:13}]}}};
  h.window.BattleRecordsClient={getRecord:()=>record,getRevision:()=>1,snapshotValues:()=>({iv:{},nature:{},level:60})};
  assert.ok(h.page.CalcEngine.applyBattlePet(firstSide,firstSide==='attacker'?'me':'enemy',firstSide==='attacker'?'fire':'other'));
  assert.ok(h.page.CalcEngine.isBattleSimulation()); assert.equal(h.state.buff,20,'personal growth not imported as battle fact');
  h.icon(113).fire('contextmenu'); assert.equal(h.state.buff,50,'session first click has n=1 and adds 30');
  h.icon(535).fire('click'); assert.equal(h.state.buff,50);
  h.icon(113).fire('contextmenu'); assert.equal(h.state.buff,80,'session second click has n=2 and adds 60');
  h.input('basePower',777); assert.equal(h.state.buff,80,'battle manual-power edit retains only session growth');
  h.icon(535).fire('click'); assert.equal(h.state.buff,80);
  h.icon(113).fire('contextmenu'); assert.equal(h.state.buff,50,'battle next explicit click realigns session n=1');
  assert.deepEqual(plain(h.profile),before,'no battle writes to personal snapshots or counters');
  h.page.CalcEngine.endBattleSimulation();
  assert.equal(h.page.CalcEngine.isBattleSimulation(),false); assert.equal(h.state.buff,buff);
  assert.deepEqual(plain(h.page.skillSnapshot()),snapshot); assert.deepEqual(plain(h.profile),before);
  h.icon(113).fire('contextmenu');
  const n=detached?1:3;
  assert.equal(h.state.buff,20+n*30); assert.equal(h.growth().fireAttackCount,n);
  assert.equal(h.growth().powerCount,n); assert.equal(h.growth().firePowerDetached,false);
});

for (const manual of [0,-60,-17.5,20]) test(`exact reported sequence: right twice, other skill, manual${manual}, left blow fire stays literal`,()=>{
  const h=setup();
  h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
  assert.equal(h.state.buff,60);
  h.icon(535).fire('click'); h.input('buff',manual);
  assert.equal(h.state.buff,manual); assert.equal(h.page.skillSnapshot().buff,manual);
  assert.equal(h.profile.rk_damage_skill_configs[14].buff,manual);
  assert.equal(h.profile.rk_damage_view.skill.buff,manual);
  assert.equal(h.growth().powerCount,2); assert.equal(h.growth().fireAttackCount,2);
  assert.equal(h.growth().fireBuffOverridden,true);
  h.icon(41).fire('click'); h.page.restoreFromState(); h.choose(13); h.choose(14);
  assert.equal(h.state.buff,manual); assert.equal(h.growth().fireBuffOverridden,true);
  const restarted=setup(h.profile); restarted.page.initDefaultPets();
  assert.equal(restarted.state.buff,manual); assert.equal(restarted.page.skillSnapshot().buff,manual);
  for (let i=0;i<3;i++) { restarted.page.applySkillMemory(14); restarted.page.restoreFromState(); restarted.page.saveSkillConfig(14); }
  assert.equal(restarted.state.buff,manual); assert.equal(restarted.growth().fireBuffOverridden,true);
  restarted.icon(113).fire('click');
  assert.equal(restarted.state.buff,manual); assert.equal(restarted.state.basePower,50);
  assert.equal(restarted.growth().powerCount,0); assert.equal(restarted.growth().fireAttackCount,0);
  assert.equal(restarted.growth().fireBuffOverridden,false);
  restarted.icon(113).fire('contextmenu');
  assert.equal(restarted.state.buff,manual+30); assert.equal(restarted.page.skillSnapshot().buff,manual);
});

test('right immediately after takeover resumes full new n on the explicit manual baseline',()=>{
  const h=setup(); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
  h.icon(535).fire('click'); h.input('buff','-10-10');
  assert.equal(h.state.buff,-20); assert.equal(h.growth().fireBuffOverridden,true);
  h.icon(113).fire('contextmenu');
  assert.equal(h.state.basePower,110); assert.equal(h.state.buff,70, '-20 plus resulting n3×30, not +30 or hidden -60');
  assert.equal(h.growth().powerCount,3); assert.equal(h.growth().fireAttackCount,3);
  assert.equal(h.growth().fireBuffOverridden,false); assert.equal(h.page.skillSnapshot().buff,-20);
  h.icon(113).fire('click'); assert.equal(h.state.buff,-20);
});

test('manual power detach and manual BUFF override remain independent until explicit113 selection',()=>{
  for (const first of ['power','buff']) {
    const h=setup(); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
    if (first==='power') { h.input('basePower',999); h.input('buff',-10); }
    else { h.input('buff',-10); h.input('basePower',999); }
    assert.equal(h.growth().firePowerDetached,true); assert.equal(h.growth().fireBuffOverridden,true);
    assert.equal(h.state.buff,-10); assert.equal(h.page.skillSnapshot().buff,-10);
    const restarted=setup(h.profile); restarted.page.initDefaultPets();
    assert.equal(restarted.state.buff,-10); assert.equal(restarted.state.basePower,999);
    restarted.icon(113).fire('contextmenu');
    assert.equal(restarted.state.basePower,70); assert.equal(restarted.state.buff,20);
    assert.equal(restarted.growth().firePowerDetached,false); assert.equal(restarted.growth().fireBuffOverridden,false);
  }
});

test('invalid drafts before and after takeover never change tracker, counters, saved baseline or writes',()=>{
  for (const overridden of [false,true]) for (const draft of ['-', '1+', '1/0', '2^100', String(Number.MAX_SAFE_INTEGER+1)]) {
    const h=setup(); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
    if (overridden) h.input('buff',-20);
    const profile=plain(h.profile), record=plain(h.growth()), snapshot=plain(h.page.skillSnapshot()), writes=h.writes.length;
    h.input('buff',draft);
    assert.equal(h.document.getElementById('buff').attrs['aria-invalid'],'true',JSON.stringify(draft));
    assert.deepEqual(plain(h.page.skillSnapshot()),snapshot); assert.deepEqual(plain(h.growth()),record);
    assert.deepEqual(plain(h.profile),profile); assert.equal(h.writes.length,writes);
    for (const event of ['click','contextmenu']) {
      h.icon(113).fire(event);
      assert.deepEqual(plain(h.page.skillSnapshot()),snapshot); assert.deepEqual(plain(h.growth()),record);
      assert.deepEqual(plain(h.profile),profile); assert.equal(h.writes.length,writes);
    }
    // Another valid field cannot bake an invalid BUFF draft into the snapshot.
    h.input('fixedBonus',8); assert.equal(h.profile.rk_damage_skill_configs[14].buff,snapshot.buff);
    h.page.restoreFromState(); h.icon(113).fire('click');
    assert.equal(h.state.buff,overridden?-20:0,'old tracker survives rejected draft, then resets normally');
  }
});

for (const event of ['click','contextmenu']) test(`empty and whitespace BUFF take over as manual0; other skills then blow ${event} work`,()=>{
  for (const blank of BLANK_BUFF_INPUTS) for (const overridden of [false,true]) {
    const h=setup(); h.input('buff',20);
    h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
    assert.equal(h.state.buff,80);
    h.icon(535).fire('click');
    if (overridden) h.input('buff',-20);
    h.input('buff',blank);
    assert.equal(h.document.getElementById('buff').value,blank,'no forced typing0 into the UI');
    assert.equal(h.document.getElementById('buff').attrs['aria-invalid'],'false');
    assert.equal(h.state.buff,0); assert.equal(h.page.skillSnapshot().buff,0);
    assert.equal(h.profile.rk_damage_skill_configs[14].buff,0); assert.equal(h.profile.rk_damage_view.skill.buff,0);
    assert.equal(h.growth().powerCount,2); assert.equal(h.growth().fireAttackCount,2);
    assert.equal(h.growth().fireBuffOverridden,true);
    const writes=h.writes.length;
    h.page.calculate(); h.page.calculate();
    assert.equal(h.writes.length,writes,'ordinary reads do not rewrite takeover markers or snapshots');
    h.icon(41).fire('click'); assert.equal(h.state.buff,0,'another skill keeps manual0');
    h.icon(113).fire(event);
    const n=event==='click'?0:3;
    assert.equal(h.state.basePower,50+20*n); assert.equal(h.state.buff,30*n);
    assert.equal(Number(h.document.getElementById('buff').value),30*n);
    assert.equal(h.growth().powerCount,n); assert.equal(h.growth().fireAttackCount,n);
    assert.equal(h.growth().fireBuffOverridden,false);
    assert.equal(h.page.skillSnapshot().buff,0); assert.equal(h.profile.rk_damage_skill_configs[14].buff,0);
  }
});

test('clearing BUFF survives immediate reload, skill/species restores and independent profiles without old growth',()=>{
  for (const blank of BLANK_BUFF_INPUTS) {
    const h=setup(); h.choose(13); h.input('buff',-15); h.choose(14);
    h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu'); h.icon(535).fire('click');
    h.input('buff',blank);
    const profile=plain(h.profile), restarted=setup(profile); restarted.page.initDefaultPets();
    assert.equal(restarted.state.buff,0); assert.equal(restarted.growth().fireBuffOverridden,true);
    assert.equal(restarted.growth().powerCount,2); assert.equal(restarted.growth().fireAttackCount,2);
    assert.equal(restarted.writes.filter(w=>w.key==='rk_skill_simulation').length,0,'reload does not rewrite markers');
    restarted.choose(13); assert.equal(restarted.state.buff,-15,'other species manual negative is untouched');
    restarted.choose(14); restarted.page.applySkillMemory(14); restarted.page.restoreFromState();
    assert.equal(restarted.state.buff,0); assert.equal(restarted.page.skillSnapshot().buff,0);
    assert.deepEqual(plain(profile),plain(h.profile),'independent fixture/profile copy does not mutate its source');
    restarted.icon(113).fire('contextmenu'); assert.equal(restarted.state.buff,90);
    restarted.icon(113).fire('click'); assert.equal(restarted.state.buff,0);
    assert.equal(restarted.profile.rk_damage_skill_configs[13].buff,-15);
  }
});

for (const event of ['click','contextmenu']) test(`direct DOM blank without input event then ${event} discards old derived BUFF atomically`,()=>{
  for (const blank of BLANK_BUFF_INPUTS) for (const readFirst of [false,true]) {
    const h=setup(); h.input('buff',20);
    h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu'); h.icon(535).fire('click');
    const profile=plain(h.profile), growth=plain(h.growth()), writes=h.writes.length;
    h.document.getElementById('buff').value=blank;
    if (readFirst) {
      h.page.calculate(); h.page.calculate();
      assert.equal(h.state.buff,0); assert.equal(h.page.skillSnapshot().buff,0,'read cannot invent manual -60');
      assert.deepEqual(plain(h.growth()),growth); assert.deepEqual(plain(h.profile),profile);
      assert.equal(h.writes.length,writes,'a calculated read never persists the manual override marker');
      assert.equal(h.document.getElementById('buff').value,blank);
    }
    h.icon(113).fire(event);
    const n=event==='click'?0:3;
    assert.equal(h.state.basePower,50+20*n); assert.equal(h.state.buff,30*n);
    assert.equal(h.growth().powerCount,n); assert.equal(h.growth().fireAttackCount,n);
    assert.equal(h.growth().fireBuffOverridden,false);
    assert.equal(h.page.skillSnapshot().buff,0); assert.equal(h.profile.rk_damage_view.skill.buff,0);
    assert.equal(h.profile.rk_damage_skill_configs[14].buff,0,'no zero-minus-old60 compensation');
    const restarted=setup(h.profile); restarted.page.initDefaultPets();
    assert.equal(restarted.state.buff,30*n); assert.equal(restarted.page.skillSnapshot().buff,0);
  }
});

test('blank normalization is BUFF-only: generic parser and power/energy/HP input still reject blanks',()=>{
  for (const blank of BLANK_BUFF_INPUTS) {
    assert.throws(()=>S.evaluate(blank),/表达式/);
    for (const kind of ['power','energy','hp-ratio']) assert.throws(()=>S.input(kind,blank));
    const h=setup(); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
    const before=plain(h.state), profile=plain(h.profile), writes=h.writes.length;
    h.input('basePower',blank);
    assert.equal(h.document.getElementById('basePower').attrs['aria-invalid'],'true');
    assert.deepEqual(plain(h.state),before); assert.deepEqual(plain(h.profile),profile); assert.equal(h.writes.length,writes);
    h.choose(13); h.input('buff',blank); assert.equal(h.state.buff,0,'BUFF blank rule also works for other species');
  }
});

test('blank input and direct DOM blank cannot bypass malformed growth guards or partially commit a failed icon action',()=>{
  for (const [key,value] of [['powerCount',null],['fireAttackCount',-1],['firePowerDetached','true'],['fireBuffOverridden','true']]) {
    for (const blank of BLANK_BUFF_INPUTS) for (const inputEvent of [false,true]) {
      const h=setup(); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
      h.growth()[key]=value;
      const before=plain(h.state), snapshot=plain(h.page.skillSnapshot()), profile=plain(h.profile), writes=h.writes.length;
      if (inputEvent) h.input('buff',blank); else h.document.getElementById('buff').value=blank;
      for (const event of ['click','contextmenu']) {
        h.icon(113).fire(event);
        assert.deepEqual(plain(h.state),before); assert.deepEqual(plain(h.page.skillSnapshot()),snapshot);
        assert.deepEqual(plain(h.profile),profile); assert.equal(h.writes.length,writes);
      }
    }
  }
  const h=setup(); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
  h.growth().powerCount=S.MAX_COUNT;
  const before=plain(h.state), profile=plain(h.profile), writes=h.writes.length;
  h.document.getElementById('buff').value=''; h.icon(113).fire('contextmenu');
  assert.deepEqual(plain(h.state),before); assert.deepEqual(plain(h.profile),profile); assert.equal(h.writes.length,writes);
  h.document.getElementById('buff').value=String(h.state.buff); h.icon(113).fire('click');
  assert.equal(h.state.buff,0,'failed blank preflight must not clear the old tracker before later valid reset');
});

for (const firstSide of ['attacker','defender']) test(`battle ${firstSide}-first blank BUFF left/right remain session-only and restore personal state`,()=>{
  for (const blank of ['', ' \t\n ']) for (const inputEvent of [false,true]) for (const event of ['click','contextmenu']) for (const personalOverride of [false,true]) {
    const h=setup(); h.input('buff',20); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
    if (personalOverride) h.input('buff',-20);
    const profile=plain(h.profile), snapshot=plain(h.page.skillSnapshot()), buff=h.state.buff, writes=h.writes.length;
    const record={sides:{me:{pets:[{instanceId:'fire',monsterId:14}]},enemy:{pets:[{instanceId:'other',monsterId:13}]}}};
    h.window.BattleRecordsClient={getRecord:()=>record,getRevision:()=>1,snapshotValues:()=>({iv:{},nature:{},level:60})};
    for (const side of [firstSide,firstSide==='attacker'?'defender':'attacker']) {
      assert.ok(h.page.CalcEngine.applyBattlePet(side,side==='attacker'?'me':'enemy',side==='attacker'?'fire':'other'));
    }
    assert.equal(h.state.buff,personalOverride?-20:20);
    h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu'); h.icon(535).fire('click');
    if (inputEvent) {
      h.input('buff',blank); assert.equal(h.state.buff,0); assert.equal(h.page.skillSnapshot().buff,0);
      h.page.calculate(); h.icon(41).fire('click');
    } else h.document.getElementById('buff').value=blank;
    h.icon(113).fire(event);
    const n=event==='click'?0:3;
    assert.equal(h.state.buff,n*30); assert.equal(h.state.basePower,50+n*20); assert.equal(h.page.skillSnapshot().buff,0);
    assert.deepEqual(plain(h.profile),profile); assert.equal(h.writes.length,writes);
    h.page.CalcEngine.endBattleSimulation();
    assert.equal(h.state.buff,buff); assert.deepEqual(plain(h.page.skillSnapshot()),snapshot);
    assert.deepEqual(plain(h.profile),profile); assert.equal(h.writes.length,writes);
    h.icon(113).fire('click'); assert.equal(h.state.buff,personalOverride?-20:20,'personal tracker and literal baseline restore exactly');
  }
});

test('override marker validates known fields even while growth is suppressed and restores without mutation',()=>{
  const record={powerCount:2,fireAttackCount:7,firePowerDetached:true,fireBuffOverridden:true,future:'keep'};
  const before=structuredClone(record);
  assert.equal(S.fireAttackBonus(fire,record),0); assert.deepEqual(record,before);
  for (const key of ['powerCount','fireAttackCount']) for (const value of [null,-1,1.5,S.MAX_COUNT+1]) {
    const malformed={...record,[key]:value};
    assert.throws(()=>S.fireAttackBonus(fire,malformed),/范围/);
    for (const side of ['left','right']) assert.throws(()=>S.select(blow,fire,side,malformed),/范围/);
  }
  for (const value of [undefined,null,0,1,'true',{},[]]) {
    const malformed={...record,fireBuffOverridden:value};
    assert.throws(()=>S.fireAttackBonus(fire,malformed),/标记/);
    for (const side of ['left','right']) assert.throws(()=>S.select(blow,fire,side,malformed),/标记/);
  }
  for (const side of ['left','right']) {
    const result=S.select(blow,fire,side,record), n=side==='left'?0:3;
    assert.equal(result.record.fireBuffOverridden,false); assert.equal(result.record.firePowerDetached,false);
    assert.equal(result.record.powerCount,n); assert.equal(result.record.fireAttackCount,n);
    assert.equal(result.fireAttackBonus,n*30); assert.equal(result.record.future,'keep');
  }
  const h=setup(saved(record,-60)); h.page.initDefaultPets();
  assert.equal(h.state.buff,-60); assert.deepEqual(plain(h.growth()),record);
  assert.equal(h.writes.filter(w=>w.key==='rk_skill_simulation').length,0);
});

test('source guards and malformed records block automatic growth and invalid takeover writes',()=>{
  for (const changed of ['trait','move','species']) {
    const h=setup(); h.icon(113).fire('contextmenu');
    if (changed==='trait') h.state.atkPet={...fire,trait:{localized:{zh:{name:'爆燃',description:'未知机制'}}}};
    if (changed==='move') h.RKData.getMoves=()=>moves.map(m=>m.id===113?{...m,power:51}:m);
    if (changed==='species') h.choose(13);
    const before=plain(h.growth()); h.input('buff',-5);
    assert.equal(h.state.buff,-5); assert.equal(h.page.skillSnapshot().buff,-5);
    assert.deepEqual(plain(h.growth()),before,'unreviewed sources and other species cannot set14:113 marker');
  }
  const h=setup(); h.icon(113).fire('contextmenu'); h.growth().fireBuffOverridden='true';
  const profile=plain(h.profile), writes=h.writes.length;
  h.input('buff',0);
  assert.equal(h.state.buff,30); assert.deepEqual(plain(h.profile),profile); assert.equal(h.writes.length,writes);
});

test('unmarked historical negative manual records are never guessed away or migrated',()=>{
  const profile=saved({powerCount:2,fireAttackCount:2},-60), h=setup(profile);
  h.page.initDefaultPets(); assert.equal(h.state.buff,0); assert.equal(h.page.skillSnapshot().buff,-60);
  assert.equal(h.growth().fireBuffOverridden,undefined);
  assert.equal(h.writes.filter(w=>w.key==='rk_skill_simulation').length,0);
  h.icon(113).fire('click'); assert.equal(h.state.buff,-60,'legacy negative could be intentional; no heuristic reset');
});

for (const firstSide of ['attacker','defender']) for (const personalOverride of [false,true]) test(`battle ${firstSide}-first manual takeover, personal override=${personalOverride}: no personal writes`,()=>{
  const h=setup(); h.input('buff',20); h.icon(113).fire('contextmenu'); h.icon(113).fire('contextmenu');
  if (personalOverride) { h.icon(535).fire('click'); h.input('buff',-10); }
  const before=plain(h.profile), snapshot=plain(h.page.skillSnapshot()), buff=h.state.buff, writes=h.writes.length;
  const record={sides:{me:{pets:[{instanceId:'fire',monsterId:14}]},enemy:{pets:[{instanceId:'other',monsterId:13}]}}};
  h.window.BattleRecordsClient={getRecord:()=>record,getRevision:()=>1,snapshotValues:()=>({iv:{},nature:{},level:60})};
  assert.ok(h.page.CalcEngine.applyBattlePet(firstSide,firstSide==='attacker'?'me':'enemy',firstSide==='attacker'?'fire':'other'));
  const baseline=personalOverride?-10:20;
  assert.equal(h.state.buff,baseline);
  const secondSide=firstSide==='attacker'?'defender':'attacker';
  assert.ok(h.page.CalcEngine.applyBattlePet(secondSide,secondSide==='attacker'?'me':'enemy',secondSide==='attacker'?'fire':'other'));
  assert.equal(h.state.buff,baseline,'second roster selection must not import personal growth or its override marker');
  h.icon(113).fire('contextmenu'); assert.equal(h.state.buff,baseline+30,'personal override is not imported into session counts');
  h.icon(113).fire('contextmenu'); h.icon(535).fire('click'); h.input('buff',0);
  assert.equal(h.state.buff,0); assert.equal(h.page.skillSnapshot().buff,0);
  h.page.restoreFromState(); h.icon(41).fire('click'); assert.equal(h.state.buff,0);
  h.icon(113).fire('contextmenu'); assert.equal(h.state.buff,90,'session n3 resumes over session manual0');
  h.input('buff',-60); h.icon(113).fire('click'); assert.equal(h.state.buff,-60);
  assert.deepEqual(plain(h.profile),before); assert.equal(h.writes.length,writes);
  h.page.CalcEngine.endBattleSimulation();
  assert.equal(h.state.buff,buff); assert.deepEqual(plain(h.page.skillSnapshot()),snapshot);
  assert.deepEqual(plain(h.profile),before); assert.equal(h.writes.length,writes);
  h.icon(113).fire('click'); assert.equal(h.state.buff,baseline);
});

test('speed leader explicit-choice hook handles searches but not generic selection or automatic restoration',()=>{
  const h=setup(undefined,false), calls=[];
  h.window.SpeedLeaderDisplay={recordSearch:(pet,list)=>calls.push([pet.id,list])};
  const selects=[];
  h.CommonUI.monsterRenderItem=()=>()=>'';
  h.CommonUI.createSearchBox=options=>{ selects.push(options.onSelect); return {input:h.document.createElement(),wrapper:h.document.createElement(),setValue(){},destroy(){}}; };
  h.page.initSearchDropdown('attacker-search-slot','attacker'); h.page.initSearchDropdown('defender-search-slot','defender');
  h.page.bindEvents();
  selects[0](fire); selects[1](monsters.find(p=>p.id===13));
  for (const side of ['attacker','defender']) {
    const input=h.page.searchBoxes[side].input;
    input.value='incomplete'; input.fire('input',{target:input});
    input.value=h.RKData.getMonsterDisplayName(fire); input.fire('input',{target:input});
  }
  assert.deepEqual(calls.map(c=>c[0]),[14,13,14,14]); assert.ok(calls.every(c=>c[1]===monsters));
  const count=calls.length;
  h.choose(13); h.choose(14); h.page.initDefaultPets(); h.page.restoreFromState();
  const record={sides:{me:{pets:[{instanceId:'fire',monsterId:14}]}}};
  h.window.BattleRecordsClient={getRecord:()=>record,getRevision:()=>1,snapshotValues:()=>({iv:{},nature:{},level:60})};
  h.page.CalcEngine.applyBattlePet('attacker','me','fire'); h.page.CalcEngine.endBattleSimulation();
  assert.equal(calls.length,count,'direct generic selection, startup, restore and battle selection never invoke explicit-choice preference hook');
  delete h.window.SpeedLeaderDisplay; assert.doesNotThrow(()=>selects[0](fire),'shared module remains optional');
});
