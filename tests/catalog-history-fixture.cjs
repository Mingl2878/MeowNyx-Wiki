'use strict';
// Test-local approved historical prototypes. No source/backups or production data
// are changed; graduation must not disable the old placeholder/definition guards.
const clone = value => JSON.parse(JSON.stringify(value));
const mingulongTraitId = 'trait-e6337fff38ccbd5fe07994daac0d1075';
const abuTraitId = 'trait-2d62e65c758af0457fe3fcdc3054ae81';
function historicalMingulong(catalog) {
  const c = clone(catalog);
  c.monsters[c.monsters.findIndex(m => m.id === 619)] = {
    id: 619, name: '冥古龙', dex_number: 0, type_ids: [8,15], trait_id: mingulongTraitId,
    stats: {hp:118,phy_atk:128,phy_def:81,mag_atk:42,mag_def:63,speed:70}, images: {},
    form: 'default', form_category: '无多形态', evolution_stage: '待定', evolution_members: [619],
    default_level: 99, level_configurable: true, placeholder: true,
    data_note: '历史用户授权等级测试占位；正式形态、特性名称、图片和学习面待补。'
  };
  c.learnsets[c.learnsets.findIndex(l => l.monster_id === 619)] = {monster_id:619,mode:'own',skills:[]};
  return c;
}
function historicalAbu(catalog) {
  const c = clone(catalog);
  c.monsters.find(m => m.id === 623).trait_id = abuTraitId;
  return c;
}
module.exports = {historicalMingulong, historicalAbu, mingulongTraitId, abuTraitId};
