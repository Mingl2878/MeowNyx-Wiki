'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../js/skill-variants.js');
const M = require('../js/battle-math.js');
const moves = require('../data/moves.json');
const byId = id => moves.find(m => m.id === id);
// Independent expected values for EVERY fixed or retained dynamic supported ID.
const expected = [
  [5,65,1,325,1],[10,100,1,160,1],[35,210,1,40,1],[70,100,1,160,1],
  [277,50,1,50,2],[376,80,1,120,1],[384,40,1,800,1],[474,80,1,120,1],
  [4,95,1,215,1],[9,80,1,180,1],[23,65,1,120,1],[29,30,2,30,4],
  [32,30,3,30,6],[42,80,1,260,1],[51,60,1,90,1],[52,85,1,255,1],
  [53,70,1,210,1],[77,75,1,75,3],[98,80,1,155,1],[132,40,1,160,1],
  [140,55,1,110,1],[188,80,1,160,1],[195,60,1,60,1],[225,105,1,165,1],
  [239,55,1,110,1],[241,170,1,340,1],[262,80,1,120,1],[278,35,2,55,2],
  [303,90,1,180,1],[322,65,1,325,1],[327,25,2,25,3],[331,35,1,350,1],
  [337,35,2,35,6],[340,85,1,170,1],[354,25,1,25,3],[356,70,1,105,1],
  [358,60,1,60,1],[359,75,1,112,1],[369,100,1,160,1],[382,80,1,140,1],
  [394,25,3,25,6],[400,70,1,140,1],[420,20,3,20,5],[431,20,2,20,3],
  [432,70,1,100,1],[434,70,1,160,1],[437,90,1,130,1],[441,45,1,105,1],
  [469,75,1,165,1],[470,80,1,160,1],[501,125,1,185,1],[505,90,1,130,1],
  [506,145,1,95,1],[509,80,1,120,1],[510,70,1,140,1],[519,165,1,115,1],
  [522,135,1,70,1],[527,85,1,135,1],[532,35,1,35,3],[535,90,1,210,1],
  [540,50,1,150,1]
];
const simulation = Object.freeze({ basePower: 0, comboCount: 99, skillType: 'attack', skillAttr: '水', currentSkillName: 'prior',
  fixedBonus: -17, percentBonus: 23.5, buff: -35, debuffPercent: '10+5', defenseMod: '-50', starMeteor: 4,
  finalPowerManual: '0', mode: 0, atkIV: { hp: false }, unknownPersonalField: 'keep' });

test('entire shipped 579-entry list has explicit matching semantic evidence and a disposition', () => {
  const a = V.audit(moves);
  assert.equal(a.total, 579);
  assert.deepEqual(a.counts, { supported: 62, ordinary: 244, 'manual-only': 0, 'base-only': 52, 'non-attack': 221 });
  assert.deepEqual(a.unreviewed, []);
  assert.equal(new Set(a.rows.map(r => r.id)).size, 579);
  assert.deepEqual(a.rows.filter(r => r.disposition === 'supported').map(r => r.id), [...expected.map(r => r[0]),425].sort((a,b)=>a-b));
  for (const row of a.rows) {
    assert.ok(row.reason.length > 10, row.name);
    assert.equal(row.evidence, byId(row.id).localized.zh.description);
    assert.match(V.tooltip(byId(row.id)), /左键：[\s\S]*右键：/);
    if (row.disposition === 'non-attack') assert.equal(row.left, null);
    if (!['supported','base-only'].includes(row.disposition)) assert.equal(row.right, null);
  }
});
for (const [id, lp, lc, rp, rc] of expected) {
  test(`${id} ${byId(id).localized.zh.name}: complete two-button transaction, repeat and right→left`, () => {
    const move = byId(id);
    const l = V.select(simulation, move, 'left', '测试系');
    const r = V.select(l.state, move, 'right', '测试系');
    assert.equal(l.applied, true); assert.equal(r.applied, true);
    assert.deepEqual([l.state.basePower,l.state.comboCount,r.state.basePower,r.state.comboCount], [lp,lc,rp,rc]);
    assert.deepEqual(V.select(r.state, move, 'right', '测试系').state, r.state);
    assert.deepEqual(V.select(r.state, move, 'left', '测试系').state, l.state);
    assert.equal(r.state.currentSkillName, move.localized.zh.name);
    assert.equal(r.state.skillType, move.move_category === 'Magic Attack' ? 'magic_attack' : 'attack');
    assert.equal(r.state.skillAttr, '测试系');
    for (const key of Object.keys(simulation).filter(k => !['basePower','comboCount','skillType','skillAttr','currentSkillName'].includes(k))) {
      assert.deepEqual(r.state[key], simulation[key], key);
    }
  });
}
test('legacy total/counter helpers are never consulted, even via accessors', () => {
  for (const move of moves) {
    const poison = { ...move };
    for (const key of ['counter_power_multiplier','alt_power_total','alt_condition_zh']) {
      Object.defineProperty(poison,key,{ get() { throw Error('stale helper read: '+key); } });
    }
    assert.deepEqual(V.describe(poison),V.describe(move));
    for (const side of ['left','right']) assert.deepEqual(V.select(simulation,poison,side),V.select(simulation,move,side));
  }
  assert.equal(Object.hasOwn(byId(420),'alt_power_total'),false);
  assert.equal(byId(420).power,20); assert.equal(byId(535).power,70);
  assert.equal(byId(469).alt_power_total,130); // Source data intentionally NOT rewritten.
});
test('fractional percent presets follow BattleMath floor, never stale nearest rounding', () => {
  assert.equal(V.describe(byId(359)).right.basePower,M.basePower(75,0,50));
  assert.notEqual(V.describe(byId(359)).right.basePower,Math.round(75*1.5));
  assert.equal(V.describe(byId(356)).right.basePower,M.basePower(70,0,50));
  const p=V.select(simulation,byId(359),'right').state;
  assert.equal(M.basePower(p.basePower,p.fixedBonus,p.percentBonus),Math.floor((112-17)*1.235));
});
test('explicit base-only requests are repeatable base values; disaster self-target remains unavailable', () => {
  for (const id of [493,2,6,299,516,538,180,182,536]) {
    assert.equal(V.describe(byId(id)).disposition,'base-only');
    const r=V.select(simulation,byId(id),'right');
    assert.equal(r.applied,true); assert.equal(r.state.basePower, byId(id).power);
    assert.deepEqual(r.state,V.select(simulation,byId(id),'left').state);
  }
  assert.equal(V.select(simulation,byId(425),'left').applied,false);
  const response=V.select(simulation,byId(425),'right');
  assert.equal(response.applied,true);
  assert.equal(response.state.basePower,180);assert.equal(response.state.comboCount,1);
  assert.deepEqual(V.select(response.state,byId(425),'right').state,response.state);
  assert.equal(V.select(response.state,byId(425),'left').state,response.state,'unsupported self-hit keeps the current simulation untouched');
  assert.equal(V.describe(byId(516)).left.comboCount,3);
  assert.equal(V.describe(byId(538)).left.comboCount,2);
  assert.equal(V.select(simulation,byId(435),'left').state.basePower,0);
  for(const id of [10,70,376,35]) assert.equal(V.describe(byId(id)).displayPower,'?');
  assert.match(V.describe(byId(510)).reason,/无累计/);
  assert.match(V.describe(byId(469)).reason,/无视抵抗未实现/);
});
test('new or changed descriptions fail closed, never regex-guess attack effects', () => {
  const m=byId(420);
  for (const changed of [ {...m,id:987654}, {...m,power:99}, {...m,base_combo:12}, {...m,localized:{zh:{...m.localized.zh,description:'应对状态：威力变为100倍。'}}} ]) {
    assert.equal(V.describe(changed).reviewed,false);
    assert.equal(V.select(simulation,changed,'right').applied,false);
  }
  assert.equal(V.select(simulation,null,'right').state,simulation);
  const mutated=V.describe(m);mutated.right.basePower=9999;
  assert.equal(V.describe(m).right.basePower,20);
});
test('pure UMD works without DOM, localStorage or CommonJS in browser realm', () => {
  const box=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/skill-variants.js'),'utf8'),box);
  assert.equal(typeof box.SkillVariants.select,'function');
  assert.equal(box.SkillVariants.describe(byId(535)).right.basePower,210);
});
