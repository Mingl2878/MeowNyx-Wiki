import { readWiki, writeWiki } from './lib/wiki-data.js';
const root = 'D:/echoagent/MeowNyx Wiki';

const monsterFile = `${root}/data/monsters.json`;
const movesFile = `${root}/data/moves.json`;

const ghost = {
  id: 15,
  localized: { zh: '幽' },
  name: 'Ghost',
  resistant_to: ['Poison', 'Bug', 'Fighting', 'Normal'],
  vulnerable_to: ['Ghost', 'Light', 'Dark']
};
const illusion = {
  id: 18,
  localized: { zh: '幻' },
  name: 'Illusion',
  resistant_to: ['Illusion', 'Fighting'],
  vulnerable_to: ['Ghost', 'Bug']
};

const monster = {
  base_hp: 115,
  base_mag_atk: 51,
  base_mag_def: 98,
  base_phy_atk: 128,
  base_phy_def: 128,
  base_spd: 130,
  default_legacy_type: ghost,
  dex_number: 445,
  evolution_chain_name: '',
  evolution_stage: '高级形态',
  evolves_from_id: null,
  form: 'default',
  form_category: '无多形态',
  id: 595,
  image: '银月狼王.png',
  is_leader_form: false,
  leader_potential: false,
  localized: { zh: { name: '银月狼王' } },
  main_form_name: '',
  main_type: ghost,
  preferred_attack_style: 'Physical',
  sub_type: illusion,
  trait: {
    localized: {
      zh: {
        name: '铭记于月亮',
        description: '获得自己击败的精灵的特性，每次攻击后自己失去5%生命。'
      }
    }
  }
};

const elementTypes = {
  '幽': { id: 15, name: 'Ghost' },
  '幻': { id: 18, name: 'Illusion' }
};

const missingMoves = [
  { id: 5931, name: '量子涨落', element: '幻', type: 'Physical Attack', energy: 3, power: 75, combo: null, desc: '技能效果待补充。' },
  { id: 5932, name: '月蚀', element: '幻', type: 'Physical Attack', energy: 5, power: 130, combo: null, desc: '技能效果待补充。' },
  { id: 5933, name: '重组', element: '幻', type: 'Status', energy: 1, power: null, combo: null, desc: '技能效果待补充。' },
  { id: 5934, name: '掠影', element: '幽', type: 'Physical Attack', energy: 3, power: 65, combo: null, desc: '技能效果待补充。' },
  { id: 5935, name: '离魂术', element: '幽', type: 'Status', energy: 3, power: null, combo: null, desc: '技能效果待补充。' }
].map(move => ({
  id: move.id,
  move_type: { ...elementTypes[move.element], localized: { zh: move.element } },
  localized: { zh: { name: move.name, description: move.desc } },
  move_category: move.type,
  energy_cost: move.energy,
  power: move.power,
  base_combo: move.combo,
  counter_power_multiplier: null,
  alt_power_total: null,
  alt_condition_zh: null,
  power_formula: null,
  statuses: []
}));

const wikiSkills = [
  ['量子涨落', '幻', '物攻', '默认'],
  ['跌落', '恶', '物攻', '默认'],
  ['困兽', '恶', '物攻', '默认'],
  ['极限撕裂', '恶', '物攻', '默认'],
  ['贪婪', '恶', '状态', '默认'],
  ['地刺', '地', '物攻', '默认'],
  ['岩脉崩毁', '地', '物攻', '默认'],
  ['泥浆铠甲', '地', '状态', '默认'],
  ['先发制人', '普通', '物攻', '默认'],
  ['见招拆招', '普通', '物攻', '默认'],
  ['气势一击', '普通', '物攻', '默认'],
  ['当头棒喝', '普通', '物攻', '默认'],
  ['偷袭', '普通', '物攻', '默认'],
  ['吞噬', '普通', '物攻', '默认'],
  ['借用', '普通', '状态', '默认'],

  ['星云漩涡', '幻', '物攻', '血脉'],
  ['械斗', '机械', '物攻', '血脉'],
  ['恶能量', '恶', '物攻', '血脉'],
  ['勾魂', '幽', '状态', '血脉'],
  ['碰爪', '萌', '物攻', '血脉'],
  ['风矢', '翼', '物攻', '血脉'],
  ['缠丝劲', '武', '物攻', '血脉'],
  ['噬心', '虫', '物攻', '血脉'],
  ['毒沼', '毒', '物攻', '血脉'],
  ['球状闪电', '电', '物攻', '血脉'],
  ['升龙咆哮', '龙', '魔攻', '血脉'],
  ['冰爪', '冰', '物攻', '血脉'],
  ['跺地', '地', '物攻', '血脉'],
  ['折线冲击', '光', '物攻', '血脉'],
  ['泡沫', '水', '物攻', '血脉'],
  ['火焰箭', '火', '物攻', '血脉'],
  ['荆棘爪', '草', '物攻', '血脉'],
  ['星星撞击', '普通', '魔攻', '血脉'],

  ['粒子对撞', '幻', '物攻', '技能石'],
  ['双星', '幻', '物攻', '技能石'],
  ['天体吸积', '幻', '物攻', '技能石'],
  ['月蚀', '幻', '物攻', '传说'],
  ['叠加态', '幻', '状态', '技能石'],
  ['重组', '幻', '状态', '技能石'],
  ['诡刺', '幽', '物攻', '技能石'],
  ['惊吓盒子', '幽', '物攻', '技能石'],
  ['掠影', '幽', '物攻', '技能石'],
  ['坟场搏击', '幽', '物攻', '技能石'],
  ['撞鬼', '幽', '物攻', '技能石'],
  ['离魂术', '幽', '状态', '技能石'],
  ['力量增效', '普通', '状态', '技能石'],
  ['防御', '普通', '防御', '技能石']
];

const monsters = await Bun.file(monsterFile).json();
if (monsters.some(item => item.localized?.zh?.name === monster.localized.zh.name)) {
  throw new Error('银月狼王已存在于 monsters.json。');
}
monsters.push(monster);
await Bun.write(monsterFile, `${JSON.stringify(monsters, null, 2)}\n`);

const moves = await Bun.file(movesFile).json();
const moveByName = new Map(moves.map(item => [item.localized?.zh?.name, item]));
for (const move of missingMoves) {
  if (!moveByName.has(move.localized.zh.name)) moves.push(move);
}
await Bun.write(movesFile, `${JSON.stringify(moves, null, 2)}\n`);

const movesAfterUpdate = new Map(moves.map(item => [item.localized?.zh?.name, item]));
const wikiSkillsWithDesc = wikiSkills.map(([name, element, type, source]) => ({
  name,
  element,
  type,
  source,
  desc: movesAfterUpdate.get(name)?.localized?.zh?.description || '技能效果待补充。'
}));
const wikiData = readWiki(root);
if (wikiData['银月狼王']) throw new Error('银月狼王已存在于 wiki_monster_data.json。');
wikiData['银月狼王'] = {
  image: 'assets/monster/images/银月狼王.png',
  skills: wikiSkillsWithDesc
};
writeWiki(root, wikiData);

console.log('已新增银月狼王，以及 5 个缺失技能基础条目。');
