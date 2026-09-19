const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const MathCore = require('../js/battle-math');
const ROOT = path.resolve(__dirname, '..');

function legacyStat(base, stat, nature, iv) {
  const n = nature === 1 ? 1.2 : nature === 2 ? 0.9 : 1;
  const b = base + (iv ? 30 : 0);
  return stat === 'hp'
    ? Math.round(Math.round(Math.round(1.7 * b) + 70) * n) + 100
    : Math.round(Math.round(Math.round(1.1 * b) + 10) * n) + 50;
}

test('shared stat arithmetic exactly preserves all existing rounding steps', () => {
  for (let base = 0; base <= 300; base++) for (const stat of ['hp', 'attack', 'defense', 'magic_attack', 'magic_defense', 'speed']) {
    for (const nature of [0, 1, 2]) for (const iv of [false, true]) {
      assert.equal(MathCore.statFromBase(base, stat, nature, iv), legacyStat(base, stat, nature, iv));
    }
  }
});

test('confirmed special-power tier boundaries are unchanged', () => {
  for (const [diff, power] of [[-999,60],[-1,60],[0,100],[14,100],[15,130],[29,130],[30,140],[44,140],[45,150],[59,150],[60,160],[74,160],[75,170],[89,170],[90,180],[104,180],[105,190],[119,190],[120,194],[134,194],[135,200],[999,200]]) {
    assert.equal(MathCore.differencePower(diff), power, String(diff));
  }
});

test('shared normal damage preserves main-page rounding and combo ordering', () => {
  for (const attack of [60, 99, 170, 277, 513]) for (const power of [0, 1, 63, 125, 399]) {
    for (const defense of [60, 103, 199, 372]) for (const reduction of [1, .3, .5, .75]) for (const combo of [1, 2, 5]) {
      const expected = Math.ceil(Math.ceil(Math.ceil(Math.ceil(attack * power) * 37 / 41) * reduction) / defense) * combo;
      // Match the existing JS coefficient evaluation, including FP multiplication order.
      const legacy = Math.ceil(Math.ceil(Math.ceil(Math.ceil(attack * power) * (37 / 41)) * reduction) / defense) * combo;
      assert.equal(MathCore.normalDamage(attack, power, defense, reduction, combo), legacy);
      assert.ok(Number.isFinite(expected));
    }
  }
});

test('zero power remains zero, including base/final power helpers', () => {
  assert.equal(MathCore.basePower(0), 0);
  assert.equal(MathCore.finalPower(0, 0, 0, 1.25, 2, 100), 0);
  assert.equal(MathCore.normalDamage(200, 0, 100), 0);
});

test('positive and negative BUFF retain asymmetric rules', () => {
  assert.equal(MathCore.buffMultiplier(50), 1.5);
  assert.equal(MathCore.buffMultiplier(-50), 1 / 1.5);
  assert.equal(MathCore.finalPower(100, 20, 25, 1.25, 2, -50), Math.floor(150 * 1.25 * 2 / 1.5));
});

async function runtime() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '0', checked: false, textContent: '', innerHTML: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [] });
    return elements.get(id);
  };
  const context = {
    console: { log() {}, error() {} }, localStorage: { getItem: () => null },
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null },
    window: {}, fetch: async file => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) })
  };
  vm.createContext(context);
  for (const file of ['js/battle-math.js', 'js/monster-identity.js', 'js/data.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context);
  await vm.runInContext('RKData.init()', context);
  const code = fs.readFileSync(path.join(ROOT, 'js/pages/damage.js'), 'utf8').replace(
    'return { render, onLeave, getState: () => state, CalcEngine };',
    'return { render, onLeave, getState: () => state, CalcEngine, probe: { setSkillType, resetSkillSettings, updateSpecialPower, petConfiguration } };'
  );
  vm.runInContext(code, context);
  return { api: vm.runInContext('RKData', context), page: vm.runInContext('DamagePage', context), element };
}

const pet = (id, overrides = {}) => ({ id, localized: { zh: { name: `测试${id}` } }, main_type: { name: 'Normal' },
  base_hp: 100, base_phy_atk: 100, base_mag_atk: 150, base_phy_def: 100, base_mag_def: 100, base_spd: 100, ...overrides });

test('RKData is a thin adapter to shared stat arithmetic', async () => {
  const { api } = await runtime();
  for (const stat of ['hp', 'attack', 'defense', 'magic_attack', 'magic_defense', 'speed']) {
    assert.equal(api.getPetStat(pet(1), stat, 1, true), MathCore.statFromBase(api.getBaseStat(pet(1), stat), stat, 1, true));
  }
});

test('鸣沙陷阱 uses final physical-defense difference; 闪击 uses final speed difference', async () => {
  const { page, api } = await runtime();
  const s = page.getState();
  s.atkPet = pet(1, { base_phy_def: 160, base_spd: 50 });
  s.defPet = pet(2, { base_phy_def: 100, base_spd: 200 });
  s.atkIV = { defense: true }; s.atkNature = { defense: 1 }; s.defIV = {}; s.defNature = {};
  s.currentSkillName = '鸣沙陷阱'; page.probe.updateSpecialPower();
  const diff = api.getPetStat(s.atkPet, 'defense', 1, true) - api.getPetStat(s.defPet, 'defense', 0, false);
  assert.equal(s.basePower, MathCore.differencePower(diff));
  assert.notEqual(s.basePower, 60);
  s.currentSkillName = '闪击'; page.probe.updateSpecialPower();
  assert.equal(s.basePower, 60);
  s.currentSkillName = '不存在的技能'; s.basePower = 123; page.probe.updateSpecialPower();
  assert.equal(s.basePower, 123, 'ordinary/manual power must remain editable');
});

test('skill-type setter updates internal state and both radio buttons', async () => {
  const { page, element } = await runtime();
  page.probe.setSkillType('magic_attack');
  assert.equal(page.getState().skillType, 'magic_attack');
  assert.equal(element('skillTypeMagic').checked, true);
  assert.equal(element('skillTypeAttack').checked, false);
  page.probe.setSkillType('attack');
  assert.equal(page.getState().skillType, 'attack');
  assert.equal(element('skillTypeMagic').checked, false);
  assert.equal(element('skillTypeAttack').checked, true);
});

test('meteor uses exact shared coefficient and separate rounded buff/type stages', () => {
  assert.equal(MathCore.DAMAGE_FACTOR, 37 / 41);
  for (const type of [3, 2, 1, .5, .25]) {
    const expected = Math.ceil(Math.ceil(Math.ceil(Math.ceil(73 * 217 * (37 / 41)) * 1.2) * type * .8) / 193);
    assert.equal(MathCore.starMeteorDamage(73, 217, 193, 1.2, type, .8), expected);
  }
});

test('meteor only triggers on non-Illusion attacks and has its own Illusion effectiveness', async () => {
  const { page, api } = await runtime();
  const s = page.getState();
  Object.assign(s, { atkPet: pet(1), defPet: pet(2,{main_type:{name:'Ground'},sub_type:{name:'Mechanical'}}), atkIV:{},atkNature:{},defIV:{},defNature:{}, skillType:'attack',skillAttr:'普',basePower:100,fixedBonus:0,percentBonus:0,buff:0,comboCount:1,defenseMod:'0',debuffPercent:'0',finalPowerManual:'',starMeteor:2 });
  let r = page.CalcEngine.calculate();
  assert.equal(r.typeEff, .25);
  assert.equal(r.starMeteorTypeEff, api.getTypeEff('幻','Ground','Mechanical'));
  assert.notEqual(r.typeEff, r.starMeteorTypeEff);
  assert.equal(r.starMeteorDamage, MathCore.starMeteorDamage(28,r.atkStat,r.defStat,1,r.starMeteorTypeEff,1));
  assert.match(page.CalcEngine.buildSteps(r).join(''), /0\.9/);
  s.skillAttr='幻'; r=page.CalcEngine.calculate();
  assert.equal(r.starMeteorTriggered,false); assert.equal(r.starMeteorDamage,0);
  assert.equal(s.starMeteor,2,'the calculator does not consume the input by recalculating');
});

test('meteor wording distinguishes resistance from weakness without changing arithmetic', async () => {
  const { page } = await runtime(), engine = page.CalcEngine;
  const s = page.getState();
  Object.assign(s, { atkPet: pet(1), defPet: pet(2), atkNature:{}, atkIV:{}, defNature:{}, defIV:{}, skillType:'attack',skillAttr:'普',basePower:100,fixedBonus:0,percentBonus:0,buff:0,comboCount:1,defenseMod:'0',debuffPercent:'0',finalPowerManual:'',starMeteor:4 });
  const base = engine.calculate();
  for (const eff of [.25, .5, 1, 2, 3]) {
    const damage = MathCore.starMeteorDamage(88, 202, 231, 1, eff, 1);
    const result = {...base, atkStat:202,defStat:231,starMeteorTypeEff:eff,starMeteorDamage:damage,totalDamage:100+damage};
    const frozen = JSON.stringify(result);
    const text = engine.buildSteps(result).find(line=>line.includes('星陨追加伤害')).replace(/<[^>]*>/g,'').trim();
    if (eff === .5) assert.equal(text, '星陨追加伤害 = 4层星陨印记（幻系，基础威力88） × (202 ÷ 231) × 0.9 × 幻系抵抗0.5 = 35');
    if (eff !== 1) assert.match(text, new RegExp('幻系'+(eff < 1 ? '抵抗' : '克制')+eff));
    else assert.doesNotMatch(text, /幻系克制|幻系抵抗/);
    assert.equal(JSON.stringify(result), frozen);
  }
});

test('damage page still includes mitigation, defense changes, manual power and star meteor', async () => {
  const { page } = await runtime();
  const s = page.getState();
  Object.assign(s, { atkPet: pet(1), defPet: pet(2), atkIV: {}, atkNature: {}, defIV: {}, defNature: {},
    skillType: 'attack', skillAttr: '火', basePower: 100, fixedBonus: 0, percentBonus: 0, buff: 0, comboCount: 1,
    defenseMod: '0', debuffPercent: '0', finalPowerManual: '', starMeteor: 0 });
  assert.equal(page.CalcEngine.calculate().totalDamage, 91);
  s.debuffPercent = '50'; assert.equal(page.CalcEngine.calculate().totalDamage, 46);
  s.debuffPercent = '0'; s.defenseMod = '100'; assert.equal(page.CalcEngine.calculate().totalDamage, 46);
  s.defenseMod = '0'; s.finalPowerManual = '400'; assert.equal(page.CalcEngine.calculate().totalDamage, 361);
  s.finalPowerManual = ''; s.starMeteor = 2; assert.equal(page.CalcEngine.calculate().totalDamage, 117);
});
