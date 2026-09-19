import { readWiki, writeWiki } from './lib/wiki-data.js';
const root = 'D:/echoagent/MeowNyx Wiki';
const moves = await Bun.file(`${root}/data/moves.json`).json();
const wiki = readWiki(root);
const types = await Bun.file(`${root}/data/types.json`).json();
const typeByName = new Map(types.map(type => [type.localized.zh, type]));
const known = new Set(moves.map(move => move.localized?.zh?.name));
const newMoves = [
  ['闪光弹','光',2,40], ['凋烂触碰','毒',1,60],
  ['回收','幽',3,80], ['午夜躁音','幽',4,20], ['小型打劫','幽',2,null], ['广播','机械',5,140], ['冰掠镰','冰',3,null],
  ['观测者效应','幻',3,null], ['暴打','恶',3,100], ['掉包','恶',2,null],
  ['微型乒候','机械',3,75], ['无风','翼',2,null],
  ['奇点','幻',4,60], ['引力偏转','幻',2,null],
  ['蛊针','虫',0,40], ['迁飞扩散','虫',3,55], ['信息素','虫',4,null], ['斑毁','恶',2,80],
  ['分光','光',1,null], ['汇流','水',1,null],
  ['暖阳','火',2,70], ['星火','火',3,null],
  ['月影交错','翼',2,25], ['惊鸿一瞥','翼',2,null]
];
let nextId = Math.max(...moves.map(move => move.id)) + 1;
for (const [name, element, energy, power] of newMoves) {
  if (known.has(name)) continue;
  const type = typeByName.get(element);
  if (!type) throw new Error(`未知属性：${element}`);
  const isStatus = power == null;
  moves.push({
    id: nextId++,
    move_type: type,
    localized: { zh: { name, description: '技能效果待补充。' } },
    move_category: isStatus ? 'Status' : 'Physical Attack',
    energy_cost: energy,
    power,
    base_combo: null,
    counter_power_multiplier: null,
    alt_power_total: null,
    alt_condition_zh: null,
    power_formula: null,
    statuses: []
  });
}
const currentMoves = new Map(moves.map(move => [move.localized?.zh?.name, move]));
for (const monster of Object.values(wiki)) {
  for (const skill of monster.skills || []) {
    const move = currentMoves.get(skill.name);
    if (move?.localized?.zh?.description) skill.desc = move.localized.zh.description;
  }
}
await Bun.write(`${root}/data/moves.json`, `${JSON.stringify(moves, null, 2)}\n`);
writeWiki(root, wiki);
console.log(`已补充 ${newMoves.filter(([name]) => !known.has(name)).length} 个截图可确认的技能基础条目。`);
