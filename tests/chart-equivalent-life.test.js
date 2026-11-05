'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const BattleMath = require('../js/battle-math.js');
const PetConfiguration = require('../js/pet-configuration.js');
const source = fs.readFileSync(require.resolve('../js/pages/chart.js'), 'utf8');
const math = vm.runInNewContext(source.split('const ChartPage =')[0] + '\nChartFavoriteMath;');
const plain = value => JSON.parse(JSON.stringify(value));

test('equivalent life is a continuous type-only reference; neutral HP is unchanged', () => {
  assert.equal(math.equivalentLife(455, .5).y, 910);
  assert.equal(math.equivalentLife(455, 1).y, 455);
  assert.equal(math.equivalentLife(455, 2).y, 227.5);
  for (const hp of [1, 2, 100, 101, 360, 455, 601]) for (const effect of [.25, .5, 1, 2, 3]) {
    assert.equal(math.equivalentLife(hp, effect).y, hp / effect);
  }
});

test('actual damage includes type before final floor; integer neutral output is not a survival oracle', () => {
  // Raw neutral 1.8: type2 gives floor(3.6)=3, not floor(1.8)*2=2.
  const attack = 41, power = 1, defense = 37 / 1.8;
  const neutral = BattleMath.normalDamage(attack, power, defense);
  assert.equal(neutral, 1);
  assert.equal(BattleMath.normalDamage(attack, power, defense, 1, 1, 60, 2), 3);
  assert.notEqual(neutral * 2, 3);
  // Combos floor each hit first, not the total. HP/E alone cannot capture this.
  assert.equal(BattleMath.normalDamage(41, 1, 20, 1, 3, 60, .5), 0);
  assert.equal(Math.floor(BattleMath.normalDamageRaw(41, 1, 20, 1, 60, .5) * 3), 2);
  for (const effect of [.25, .5, 1, 2, 3]) for (const combo of [1, 3]) {
    for (let q = 80; q <= 200; q++) {
      const d = BattleMath.statFromBase(q, 'defense', 0, true);
      const expected = Number(BigInt(253 * 317 * 37 * (effect * 4)) / BigInt(41 * d * 4)) * combo;
      assert.equal(BattleMath.normalDamage(253, 317, d, 1, combo, 60, effect), expected);
    }
  }
});

test('immune targets never emit infinity and invalid values never become plot coordinates', () => {
  for (const effect of [0, -1, NaN, Infinity]) assert.equal(math.equivalentLife(455, effect).y, null);
  assert.match(math.equivalentLife(455, 0).reason, /属性免疫.*无法击杀/);
  assert.equal(math.equivalentLife(NaN, 1).y, null);
});

test('curve configuration ignores automatic, manual and active-slot personal records entirely', () => {
  const shared={iv:{defense:true,hp:false},nature:{hp:0}};
  const poison=new Proxy({}, {get(){throw Error('personal read');}});
  const result=math.configuration({id:327,fromDamage:true},poison,poison,shared,poison,()=>{throw Error('resolver');});
  assert.deepEqual(plain(result.iv),{...shared.iv,hp:true});assert.deepEqual(plain(result.nature),shared.nature);
});

test('adaptive nice ticks follow available plot height and maximum, with display-only headroom', () => {
  assert.equal(math.yAxis(100, 380).step, 10);
  assert.equal(math.yAxis(100, 120).step, 20);
  assert.equal(math.yAxis(112, 300).step, 10);
  assert.equal(math.yAxis(600, 440).step, 50);
  assert.equal(math.yAxis(600, 700).step, 25);
  assert.equal(math.yAxis(1200, 440).step, 50);
  for (const height of [120, 250, 400, 700]) for (const maximum of [0, 97, 112, 455, 600, 909, 5000]) {
    const axis = math.yAxis(maximum, height);
    assert.ok(Number.isFinite(axis.max) && axis.max > maximum);
    assert.ok([10, 20, 25, 50].includes(axis.step));
    assert.ok(axis.tickCount <= 501);
    assert.ok(Math.abs(axis.max / axis.step - Math.round(axis.max / axis.step)) < 1e-8);
  }
});

function fixture() {
  const data = require('./catalog-read-fixture.cjs').readProjectData('monsters.json');
  const pets = [202, 327].map(id => data.find(p => p.id === id));
  const s = { atkPet: pets[0], defPet: pets[1], atkIV: {}, atkNature: {}, defIV: {}, defNature: {},
    skillType: 'attack', skillAttr: 'Water', basePower: 400, fixedBonus: 0, percentBonus: 0, buff: 0, comboCount: 1 };
  const field = { hp: 'base_hp', attack: 'base_phy_atk', magic_attack: 'base_mag_atk', defense: 'base_phy_def', magic_defense: 'base_mag_def' };
  const RKData = { getPetLevel: () => 60, getBaseStat: (p, stat) => p[field[stat]], getMonsterById: id => pets.find(p => p.id === id), getMonsterDisplayName: p => p.name,
    getPetStat: (p, stat, nature, iv) => BattleMath.statFromBase(p[field[stat]], stat, nature, iv), getTypeEff: () => 0.5 };
  const context = { RKData, BattleMath, PetConfiguration, localStorage: { getItem: () => '{}' },
    ChartWorkspace: { getEntries: () => [{ id: 327, key: 'chart:327' }] },
    DamagePage: { getState: () => s, CalcEngine: { isSameType: () => true } } };
  context.window = context;
  const t = vm.runInNewContext(source.replace('return { render, onLeave, getState:', 'workspaceReady = true; return { favoriteMarkers, markerTooltip, view, render, onLeave, getState:') + '\nChartPage;', context);
  return { t, s, RKData };
}

test('Water202 vs Dragon327 uses curve-only configuration and exact type-equivalent life', () => {
  const {t,s,RKData}=fixture(); const [b]=t.favoriteMarkers(s);
  assert.equal(t.favoriteMarkers(s).length,1);assert.equal(b.effect,.5);assert.equal(b.x,69);
  assert.equal(b.hp,BattleMath.statFromBase(112,'hp',0,true));assert.equal(b.y,b.hp*2);
  assert.equal(b.defenseMismatch,false);assert.equal(math.defenseMinimum([b]),68);
  const old=plain(b);
  s.defIV={defense:false,hp:true};s.defNature={hp:2,defense:2};s.atkIV={};s.atkNature={attack:2};
  assert.deepEqual(plain(t.favoriteMarkers(s)[0]),old);
  for(const enabled of [true,false]) {
    t.view.hpNature=enabled;t.view.overrides.defIV.defense=enabled;
    const m=t.favoriteMarkers(s)[0];
    const tip=math.tooltipLines({mode:'defense',atkPet:s.atkPet,attackType:s.skillType,skillAttr:s.skillAttr,basePower:s.basePower,fixedBonus:0,percentBonus:0,buff:0,comboCount:1,sameType:1.25},m.pet,[{damageConfig:{atkIV:true,atkNature:0,defIV:enabled,defNature:0,hpNature:enabled}}],RKData,BattleMath).join(String.fromCharCode(10));
    assert.equal(m.defenseMismatch,false);assert.equal(m.hp,BattleMath.statFromBase(112,'hp',enabled?1:0,true));
    assert.match(tip,new RegExp('÷ '+m.hp+' '));assert.match(tip,new RegExp('⑥ 伤害占比 = '+m.damage));
    assert.doesNotMatch(tip,/剩余HP|能否扛住|配置来源/);
  }
});

test('odd-x interpolation is not an exact integer survival oracle', () => {
  let found = false;
  for (let power = 1; power <= 2000; power++) {
    const damage = x => BattleMath.normalDamage(168, power, BattleMath.statFromBase(x, 'defense', 0, true));
    const interpolated = (damage(68) + damage(70)) / 2, hp = damage(69);
    if (interpolated < hp) {
      assert.ok(damage(69) >= hp);
      assert.ok(interpolated < math.equivalentLife(hp, 1).y);
      found = true; break;
    }
  }
  assert.ok(found, 'tooltip warning about sampling has a concrete rounding counterexample');
});
