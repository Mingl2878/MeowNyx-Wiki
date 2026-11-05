'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const api = require('../js/trait-power-defaults.js');
const pets = require('./catalog-read-fixture.cjs').readProjectData('monsters.json');
const get = id => pets.find(p => p.id === id);
const range = (a, b) => Array.from({length: b-a+1}, (_, i) => a+i);
const defaults = [
  [[...range(40,48),50,51,52], 'percentBonus', 50],
  [[49,53,54,55], 'percentBonus', 75],
  [range(19,30), 'percentBonus', 50],
  [[152,153], 'percentBonus', 40], [[186], 'percentBonus', 30],
  [[203], 'percentBonus', 30], [range(168,171), 'fixedBonus', 40],
  [[358,359], 'fixedBonus', 30], [range(457,462), 'percentBonus', 100],
  [range(542,544), 'percentBonus', 100]
];
const dynamicIds = [...range(210,220),428,429,603,604,607,608,509,510];
const approved = new Set([...defaults.flatMap(([ids])=>ids), ...dynamicIds]);
function expect(id, name, attr, field, value, mode='dynamic') {
  const actual = api.resolve(get(id), name, attr);
  assert.ok(actual, 'expected rule for '+id);
  assert.deepEqual(Object.keys(actual).sort(), ['field','value','mode','reason'].sort());
  assert.equal(actual.field, field);
  assert.equal(actual.value, value);
  assert.equal(actual.mode, mode);
  assert.ok(actual.reason.length > 0);
  return actual;
}
for (const [ids, field, value] of defaults) {
  for (const id of ids) test(`explicit default ${id} ${get(id)?.localized.zh.name}`, () => {
    assert.ok(get(id));
    expect(id, '测试技能', 'Light', field, value, 'default');
    // Default mode does not add skill/weather/cost/slot gates. Integration owns event timing.
    expect(id, '', '', field, value, 'default');
  });
}
test('all unregistered catalog entries are null (no fuzzy name/trait inheritance)', () => {
  assert.equal(approved.size, 66);
  for (const pet of pets) if (!approved.has(pet.id)) assert.equal(api.resolve(pet, '虫鸣', '水'), null, `${pet.id} ${pet.localized.zh.name}`);
});
test('explicit manual families, pending exceptions and defender-only modifiers preserve manual values', () => {
  const ids = [
    ...range(394,396),...range(206,209),239,240,290,291,337,338,
    ...range(341,343),...range(349,351),...range(259,261),129,411,412,414,
    452,473,474,469,491,492,618,584,585,606,615,501,202
  ];
  for(const id of ids) {
    assert.ok(get(id), 'missing audit source '+id);
    assert.equal(api.resolve(get(id), '虫鸣', 'Bug'), null, String(id));
  }
});
test('unicorn non-Light is 25 percent, Light is intentional zero', () => {
  for (const id of [210,211,212]) {
    for(const attr of ['Light','光']) expect(id, '天光', attr, 'percentBonus', 0);
    for(const attr of ['Fire','火','水','Water','Mechanical','机械','钢']) expect(id,'未知名字',attr,'percentBonus',25);
    for(const attr of [undefined,null,'','None','无','NotAType']) assert.equal(api.resolve(get(id),'测试',attr),null);
  }
});
test('共鸣/齐鸣 require exact 虫鸣 name, not merely Bug attribute', () => {
  for(const id of range(213,220)) {
    expect(id,'虫鸣','Bug','fixedBonus',20);
    expect(id,'虫鸣','Water','fixedBonus',20); // Skill-name condition, not a type inference.
    for(const name of ['虫击','虫鸣改',undefined,'']) expect(id,name,'Bug','fixedBonus',0);
  }
});
test('涂鸦 checks both own types; subtype must not receive non-own bonus', () => {
  expect(428,'测试','Ghost','percentBonus',0);
  expect(428,'测试','恶','percentBonus',50);
  for(const id of [428,429]) {
    expect(id,'测试','幽','percentBonus',0);
    expect(id,'测试','幽灵','percentBonus',0);
    expect(id,'测试','Water','percentBonus',50);
  }
  expect(429,'测试','Dark','percentBonus',0);
  expect(429,'测试','恶','percentBonus',0);
  assert.equal(api.resolve({...get(429), main_type:null},'测试','水'),null);
  assert.equal(api.resolve({...get(429), sub_type:{name:'Future'}},'测试','水'),null);
});
test('热成像 exact family is Bug-only; Moon override is Flying-only and ID604-only', () => {
  for(const id of [603,607,608]) {
    expect(id,'测试','Bug','percentBonus',100);
    expect(id,'测试','虫','percentBonus',100);
    expect(id,'测试','Fire','percentBonus',0);
  }
  expect(604,'测试','Flying','percentBonus',100);
  expect(604,'测试','翼','percentBonus',100);
  expect(604,'测试','Ice','percentBonus',0);
  assert.match(get(604).trait.localized.zh.description,/冰系/);
  assert.match(api.resolve(get(604),'测试','翼').reason,/用户明确覆盖/);
  for(const id of [606,615]) assert.equal(api.resolve(get(id),'测试','翼'),null);
});
test('换碟 four exact skill values apply to identical confirmed family only', () => {
  for(const id of [509,510]) {
    for(const [name,value] of Object.entries({'音波弹':15,'音爆':20,'金属噪音':20,'午夜噪音':5})) expect(id,name,'Normal','fixedBonus',value);
    for(const name of ['金属噪音改','虫鸣','toString','__proto__','',undefined]) expect(id,name,'Normal','fixedBonus',0);
  }
});
test('stable ID is authoritative; species display rename is safe, copied name/trait is not', () => {
  const pet = structuredClone(get(48));
  pet.localized.zh.name='已改显示名';
  assert.equal(api.resolve(pet,'','').value,50);
  assert.equal(api.resolve({...pet,id:'48'},'','').value,50);
  for(const id of [undefined,null,0,-1,NaN,Infinity,48.1,'048',' 48','48x',999999,{},true]) assert.equal(api.resolve({...pet,id},'',''),null);
  assert.equal(api.resolve({id:48,localized:pet.localized},'',''),null);
  assert.equal(api.resolve({...get(203),id:202},'',''),null);
});
test('source guard detects future contradictory trait text for EVERY registered ID', () => {
  for(const id of approved) {
    const original=get(id);
    assert.ok(api.resolve(original,'虫鸣','水'),String(id));
    for(const key of ['name','description']) {
      const changed=structuredClone(original);
      changed.trait.localized.zh[key]+='（已更新）';
      assert.equal(api.resolve(changed,'虫鸣','水'),null,`${id}/${key}`);
    }
  }
});
test('pure: no input mutation, result objects independent and API frozen', () => {
  assert.ok(Object.isFrozen(api));
  for(const id of approved) {
    const pet=structuredClone(get(id));
    const before=JSON.stringify(pet);
    const first=api.resolve(pet,'虫鸣','水');
    first.value=999;
    const next=api.resolve(pet,'虫鸣','水');
    assert.notEqual(next.value,999);
    assert.equal(JSON.stringify(pet),before);
  }
  assert.equal(api.resolve(null,'',''),null);
});
test('browser export uses optional exact RKData normalizer without dependencies or persistence', () => {
  const code=fs.readFileSync(path.join(__dirname,'../js/trait-power-defaults.js'),'utf8');
  const context={window:{RKData:{getTypeEn: s => s==='canonical-light-alias'?'Light':s}}};
  vm.runInNewContext(code,context);
  assert.equal(typeof context.window.TraitPowerDefaults.resolve,'function');
  assert.equal(context.window.TraitPowerDefaults.resolve(get(211),'','canonical-light-alias').value,0);
  assert.equal(context.window.TraitPowerDefaults.resolve(get(211),'','Unknown'),null);
  context.window.RKData.getTypeEn=()=>{throw Error('not initialized');};
  assert.equal(context.window.TraitPowerDefaults.resolve(get(211),'','Unknown'),null);
  assert.equal(context.window.TraitPowerDefaults.resolve(get(211),'','火').value,25);
  delete context.window.RKData;
  assert.equal(context.window.TraitPowerDefaults.resolve(get(211),'','水').value,25);
});
