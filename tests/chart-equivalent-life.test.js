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

test('ceil-after-effect threshold: resistance differs from naive HP/E by one; neutral is identity', () => {
  assert.equal(math.equivalentLife(455, 0.5).y, 909);
  assert.equal(Math.ceil(909 * 0.5), 455);
  assert.equal(Math.ceil(908 * 0.5), 454);
  assert.equal(math.equivalentLife(455, 1).y, 455);
  assert.equal(math.equivalentLife(455, 2).y, 228);
  for (const hp of [1, 2, 3, 100, 101, 360, 455, 601]) {
    for (const effect of [0.1, 0.25, 0.5, 1, 2, 3]) {
      const t = math.equivalentLife(hp, effect).y;
      assert.equal(t, Math.floor((hp - 1) / effect) + 1);
      assert.ok(Math.ceil(t * effect) >= hp);
      assert.ok(t === 0 || Math.ceil((t - 1) * effect) < hp);
      for (const combo of [1, 2, 3, 7]) for (let hit = 0; hit <= t + 2; hit++) {
        const neutral = hit * combo;
        assert.equal(neutral < t, Math.ceil(neutral * effect) < hp);
      }
    }
  }
});

test('equivalent-life inequality respects every shared step-rounding operation, not a continuous inverse', () => {
  for (const effect of [0.25, 0.5, 1, 2, 3]) for (const combo of [1, 3]) {
    for (const hp of [101, 360, 455]) for (const nature of [0, 1, 2]) {
      const threshold = math.equivalentLife(hp, effect).y;
      for (let x = 80; x <= 200; x++) {
        const defense = BattleMath.statFromBase(x, 'defense', nature, true);
        const neutral = BattleMath.normalDamage(253, 317, defense, 1, combo);
        assert.equal(neutral < threshold, Math.ceil(neutral * effect) < hp);
      }
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
  assert.deepEqual(plain(result.iv),shared.iv);assert.deepEqual(plain(result.nature),shared.nature);
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
  const data = JSON.parse(fs.readFileSync(require.resolve('../data/monsters.json'), 'utf8'));
  const pets = [202, 327].map(id => data.find(p => p.id === id));
  const s = { atkPet: pets[0], defPet: pets[1], atkIV: {}, atkNature: {}, defIV: {}, defNature: {},
    skillType: 'attack', skillAttr: 'Water', basePower: 400, fixedBonus: 0, percentBonus: 0, buff: 0, comboCount: 1 };
  const field = { hp: 'base_hp', attack: 'base_phy_atk', magic_attack: 'base_mag_atk', defense: 'base_phy_def', magic_defense: 'base_mag_def' };
  const RKData = { getBaseStat: (p, stat) => p[field[stat]], getMonsterById: id => pets.find(p => p.id === id), getMonsterDisplayName: p => p.name,
    getPetStat: (p, stat, nature, iv) => BattleMath.statFromBase(p[field[stat]], stat, nature, iv), getTypeEff: () => 0.5 };
  const context = { RKData, BattleMath, PetConfiguration, localStorage: { getItem: () => '{}' },
    ChartWorkspace: { getEntries: () => [{ id: 327, key: 'chart:327' }] },
    DamagePage: { getState: () => s, CalcEngine: { isSameType: () => true } } };
  context.window = context;
  const t = vm.runInNewContext(source.replace('return { render, onLeave, getState:', 'workspaceReady = true; return { favoriteMarkers, markerTooltip, view, render, onLeave, getState:') + '\nChartPage;', context);
  return { t, s, RKData };
}

test('Water202 vs Dragon327 uses curve-only configuration and exact type-equivalent life', () => {
  const {t,s}=fixture(); const [b]=t.favoriteMarkers(s);
  assert.equal(t.favoriteMarkers(s).length,1);assert.equal(b.effect,.5);assert.equal(b.x,69);
  assert.equal(b.hp,BattleMath.statFromBase(112,'hp'));assert.equal(b.y,b.hp*2-1);
  assert.equal(b.defenseMismatch,false);assert.equal(math.defenseMinimum([b]),68);
  const old=plain(b);
  s.defIV={defense:false,hp:true};s.defNature={hp:2,defense:2};s.atkIV={};s.atkNature={attack:2};
  assert.deepEqual(plain(t.favoriteMarkers(s)[0]),old);
  for(const enabled of [true,false]) {
    t.view.doubleLife=enabled;t.view.overrides.defIV.defense=enabled;
    const m=t.favoriteMarkers(s)[0],tip=t.markerTooltip(m).join(String.fromCharCode(10));
    assert.equal(m.defenseMismatch,false);assert.equal(m.hp,BattleMath.statFromBase(112,'hp',enabled?1:0,enabled));
    assert.match(tip,new RegExp('HP：'+m.hp));assert.match(tip,new RegExp('伤害：'+m.damage));
    assert.match(tip,new RegExp('剩余HP：'+Math.max(0,m.hp-m.damage)));
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
