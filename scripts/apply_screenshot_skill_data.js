/**
 * 根据 D:/echoagent/old 中的技能截图补全技能效果与图鉴学习面。
 * 用法：node scripts/apply_screenshot_skill_data.js [--write]
 * 默认仅校验并输出变更预览；传入 --write 后，所有校验通过才会写入数据文件。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PLACEHOLDER = '技能效果待补充。';
const WRITE = process.argv.includes('--write');
const CATEGORY_TO_TYPE = {
  'Physical Attack': '物攻',
  'Magic Attack': '魔攻',
  Status: '状态',
  Defense: '防御'
};

const { readWiki, writeWiki } = require('./lib/wiki-data.js');
function readJSON(relativePath) {
  if (path.basename(relativePath) === 'wiki_monster_data.json') return readWiki(ROOT);
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function writeJSON(relativePath, data) {
  if (path.basename(relativePath) === 'wiki_monster_data.json') return writeWiki(ROOT, data);
  fs.writeFileSync(path.join(ROOT, relativePath), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function moveName(move) {
  return move.localized && move.localized.zh && move.localized.zh.name;
}

function moveDescription(move) {
  return move.localized && move.localized.zh && move.localized.zh.description;
}

function moveElement(move) {
  return move.move_type && move.move_type.localized && move.move_type.localized.zh;
}

function normalizeNames(names) {
  return [...new Set(names)];
}

// 截图记录的学习者按中文名称去重；截图未包含学习来源，本次新增统一按“技能石”处理。
const SKILLS = [
  {
    name: '重组', element: '幻', category: 'Status', energy: 1, power: null,
    desc: '下一次攻击时，额外造成100%幻系伤害，应对防御：改为额外造成300%幻系伤害。',
    learners: ['粉耳星兔', '星云旅者', '银月狼王', '布灵布灵', '布灵', '布灵'],
    excluded: ['布灵']
  },
  {
    name: '掠影', element: '幽', category: 'Physical Attack', energy: 3, power: 65,
    desc: '造成物伤，若上回合双方有精灵使用火系技能，偷取敌方3能量。',
    learners: ['斑枭', '荆棘电环', '混乱鱿彩', '秩序鱿墨', '银月狼王']
  },
  {
    name: '离魂术', element: '幽', category: 'Status', energy: 3, power: null,
    desc: '偷取敌方2能量，脱离。',
    learners: ['混乱鱿彩', '秩序鱿墨', '半朽蜜果灵', '银月狼王', '摇铃魔偶']
  },
  {
    name: '惊鸿一瞥', element: '翼', category: 'Status', energy: 2, power: null,
    desc: '自己获得连击数+1，迅捷。',
    learners: ['岚鸟', '花魁蜂后', '月使鸷纳']
  },
  {
    name: '月影交错', element: '翼', category: 'Physical Attack', energy: 2, power: 25, combo: 2, correctCombo: true,
    desc: '造成物伤，2连击，若上回合双方有精灵使用幻系技能，本技能获得迅捷。',
    learners: ['叮叮恶魔', '皇家狮鹫（崖间地的样子）', '皇家狮鹫（高山地的样子）', '月使鸷纳']
  },
  {
    name: '暖阳', element: '火', category: 'Physical Attack', energy: 2, power: 70,
    desc: '造成物伤，每使用1次其他火系技能，威力永久+40，使用本技能后重置。',
    learners: ['乌拉塔', '熔岩布丁', '火巨人', '圣凯布米龙'],
    excluded: ['乌拉塔']
  },
  {
    name: '星火', element: '火', category: 'Status', energy: 3, power: null,
    desc: '敌方获得8层灼烧，若上回合双方有精灵使用光系技能，敌方额外获得12层灼烧。',
    learners: ['红绒十字', '烟花伯爵', '圣凯布米龙']
  },
  {
    name: '分光', element: '光', category: 'Status', energy: 1, power: null,
    desc: '自己获得魔攻+20%，己方队伍中精灵每有1个不同的系别，额外获得魔攻+10%。',
    learners: ['格兰球', '绒仙子', '窃光蚊', '智辉章脑']
  },
  {
    name: '汇流', element: '水', category: 'Status', energy: 1, power: null,
    desc: '雨天的回合数延长4回合，应对防御：改为延长8回合。',
    learners: ['卷胡巨獭', '游蛇魔使', '卷毛鸭', '障眼魔', '智辉章脑']
  },
  {
    name: '信息素', element: '虫', category: 'Status', energy: 4, power: null,
    desc: '己方队伍随机获得1次随机奉献；若上回合双方有精灵使用地系技能，额外3次。',
    learners: ['花魁蜂后', '风滚暮虫（金黄的样子）', '风滚暮虫（枯叶的样子）', '未完虫']
  },
  {
    name: '迁飞扩散', element: '虫', category: 'Physical Attack', energy: 3, power: 55,
    desc: '造成物伤，若敌方本回合更换精灵，己方队伍随机获得3次随机奉献。',
    learners: ['芋香巨角蛛', '恶魔红钻', '遁地鼠（枯水期的样子）', '遁地鼠（储水时的样子）', '铠甲虫', '圣凯布米龙', '未完虫']
  },
  {
    name: '奇点', element: '幻', category: 'Magic Attack', energy: 4, power: 60, correctCategory: true,
    desc: '造成魔伤，若上回合双方有精灵使用水系技能，敌方获得4层星陨印记。',
    learners: ['陨星虫', '落陨星兔', '暮星辰', '玳塔']
  },
  {
    name: '引力偏转', element: '幻', category: 'Defense', energy: 2, power: null, correctCategory: true,
    desc: '减伤80%，应对攻击：以魔法伤害触发敌方的星陨效果。',
    learners: ['仪式巨像', '迷迷箱怪', '帅帅魔偶', '玳塔']
  },
  {
    name: '广播', element: '机械', category: 'Magic Attack', energy: 5, power: 140, correctCategory: true,
    desc: '对敌方精灵造成魔法伤害。',
    learners: ['圆号鱼', '噼啪鸟', '音碟吼', '溯源钟', '测风蝉', '摇铃魔偶']
  },
  {
    name: '暴打', element: '恶', category: 'Magic Attack', energy: 3, power: 100, correctCategory: true,
    desc: '对敌方精灵造成魔法伤害。',
    learners: ['蝎子王', '邪眼巨魔', '夜游魔', '障眼魔', '未完虫', '黑手浣熊']
  },
  {
    name: '无风', element: '翼', category: 'Defense', energy: 2, power: null, correctCategory: true,
    desc: '减伤50%，应对攻击：敌方和自己均脱离。',
    learners: ['友爱星飞', '月使鸷纳', '测风蝉']
  },
  {
    name: '掉包', element: '恶', category: 'Status', energy: 2, power: null,
    desc: '敌方的属性增益变为对应的属性减益。',
    learners: ['花影羚羊', '黑羽夫人', '咕德帽帽', '卡拉波斯', '黑手浣熊']
  },
  {
    name: '纺纱', element: '恶', category: 'Status', energy: 4, power: null,
    desc: '敌方获得1层暗涌印记。',
    learners: ['花影羚羊', '里拉鳐', '学院呱呱', '邪眼巨魔', '卡拉波斯']
  },
  {
    name: '回收', element: '幽', category: 'Physical Attack', energy: 3, power: 80,
    desc: '造成物伤，若敌方本回合更换精灵，敌方失去4能量。',
    learners: ['幽冥眼（睁眼的样子）', '幽冥眼（闭眼的样子）', '梦悠悠（穿旧睡衣的样子）', '梦悠悠（穿星星睡衣的样子）', '摇铃魔偶']
  },
  {
    name: '小型打劫', element: '幽', category: 'Status', energy: 2, power: null,
    desc: '敌方队伍中所有精灵失去1能量。',
    learners: ['花影羚羊', '幽影树', '半朽蜜果灵', '摇铃魔偶']
  },
  {
    name: '量子涨落', element: '幻', category: 'Physical Attack', energy: 3, power: 75,
    desc: '造成物伤，若敌方没有星陨印记，则敌方获得3层星陨印记。',
    learners: ['迷迷箱怪', '溯源钟', '银月狼王', '布灵', '布灵布灵'],
    excluded: ['布灵']
  },
  {
    name: '闪光弹', element: '光', category: 'Physical Attack', energy: 2, power: 40,
    desc: '造成物伤，自己脱离。',
    learners: ['棋祈督（白子）', '棋祈督（黑子）', '疾光千兽', '布灵', '布灵布灵', '星光狮（星光能量的样子）', '星光狮（月光能量的样子）'],
    excluded: ['布灵']
  }
];

const UNSUPPORTED_SKILLS = ['凋烂触碰', '午夜躁音', '冰掠镰', '蛊针', '斑毁'];
const errors = [];
const report = { added: 0, updated: 0, skipped: [] };

const moves = readJSON('data/moves.json');
const wiki = readJSON('data/wiki_monster_data.json');
const beforeMoves = clone(moves);
const beforeWiki = clone(wiki);

const movesByName = new Map();
for (const move of moves) {
  const name = moveName(move);
  if (!name) {
    errors.push('moves.json 存在缺少中文名称的条目');
    continue;
  }
  if (movesByName.has(name)) errors.push(`moves.json 中技能名称重复：${name}`);
  movesByName.set(name, move);
}

for (const skill of SKILLS) {
  const move = movesByName.get(skill.name);
  if (!move) {
    errors.push(`moves.json 中找不到技能：${skill.name}`);
    continue;
  }
  if (moveElement(move) !== skill.element) errors.push(`${skill.name} 属性应为 ${skill.element}，实际为 ${moveElement(move)}`);
  if (move.move_category !== skill.category && !Object.hasOwn(skill, 'correctCategory')) errors.push(`${skill.name} 类别应为 ${skill.category}，实际为 ${move.move_category}`);
  if (move.energy_cost !== skill.energy) errors.push(`${skill.name} 能耗应为 ${skill.energy}，实际为 ${move.energy_cost}`);
  if (move.power !== skill.power) errors.push(`${skill.name} 威力应为 ${skill.power}，实际为 ${move.power}`);
  if (Object.hasOwn(skill, 'combo') && move.base_combo !== skill.combo && !Object.hasOwn(skill, 'correctCombo')) errors.push(`${skill.name} 连击应为 ${skill.combo}，实际为 ${move.base_combo}`);
  if (!CATEGORY_TO_TYPE[skill.category]) errors.push(`${skill.name} 具有未映射截图类别：${skill.category}`);
  if (![PLACEHOLDER, skill.desc].includes(moveDescription(move))) errors.push(`${skill.name} 当前描述不是占位或截图确认文本，停止覆盖`);

  const excluded = new Set(skill.excluded || []);
  const learners = normalizeNames(skill.learners);
  const validLearners = learners.filter(name => !excluded.has(name));
  for (const name of excluded) {
    if (wiki[name]) errors.push(`${skill.name} 的排除学习者 ${name} 已存在于图鉴，请人工确认`);
  }
  for (const name of validLearners) {
    if (!wiki[name]) errors.push(`${skill.name} 的学习者 ${name} 不存在于图鉴`);
    else if (!Array.isArray(wiki[name].skills)) errors.push(`${skill.name} 的学习者 ${name} 没有 skills 数组`);
  }
}

for (const name of UNSUPPORTED_SKILLS) {
  const move = movesByName.get(name);
  if (!move) errors.push(`缺图技能在 moves.json 中不存在：${name}`);
  else if (moveDescription(move) !== PLACEHOLDER) errors.push(`缺图技能 ${name} 描述已不是占位，请人工确认`);
}

if (errors.length) {
  console.error(`[FAIL] 前置校验失败（${errors.length} 项），未写入任何文件：`);
  errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

for (const skill of SKILLS) {
  const move = movesByName.get(skill.name);
  if (skill.correctCategory) move.move_category = skill.category;
  if (skill.correctCombo) move.base_combo = skill.combo;
  move.localized.zh.description = skill.desc;
  const element = moveElement(move);
  const type = CATEGORY_TO_TYPE[move.move_category];
  const excluded = new Set(skill.excluded || []);
  const learners = normalizeNames(skill.learners).filter(name => !excluded.has(name));

  for (const name of learners) {
    const entry = wiki[name];
    let linked = entry.skills.find(item => item.name === skill.name);
    if (!linked) {
      linked = { name: skill.name, source: '技能石', type, element, desc: skill.desc };
      entry.skills.push(linked);
      report.added++;
    } else {
      report.updated++;
    }
    linked.element = element;
    linked.type = type;
    linked.desc = skill.desc;
  }

  for (const name of skill.excluded || []) {
    report.skipped.push(`${skill.name} → ${name}（图鉴不存在，已跳过）`);
  }
}

const targetNames = new Set(SKILLS.map(skill => skill.name));
for (const [monsterName, entry] of Object.entries(wiki)) {
  for (const linked of entry.skills || []) {
    if (!targetNames.has(linked.name)) continue;
    const move = movesByName.get(linked.name);
    linked.element = moveElement(move);
    linked.type = CATEGORY_TO_TYPE[move.move_category];
    linked.desc = moveDescription(move);
  }
}

const verificationErrors = [];
for (const skill of SKILLS) {
  const move = movesByName.get(skill.name);
  if (moveDescription(move) !== skill.desc) verificationErrors.push(`${skill.name} 主技能描述未写入截图文本`);
  const expectedType = CATEGORY_TO_TYPE[move.move_category];
  for (const [monsterName, entry] of Object.entries(wiki)) {
    const matches = (entry.skills || []).filter(item => item.name === skill.name);
    if (matches.length > 1) verificationErrors.push(`${monsterName} 的 ${skill.name} 出现 ${matches.length} 条重复学习面`);
    for (const linked of matches) {
      if (linked.element !== moveElement(move) || linked.type !== expectedType || linked.desc !== skill.desc) {
        verificationErrors.push(`${monsterName} 的 ${skill.name} 未正确投影主技能字段`);
      }
    }
  }
}

for (const name of UNSUPPORTED_SKILLS) {
  if (moveDescription(movesByName.get(name)) !== PLACEHOLDER) verificationErrors.push(`缺图技能 ${name} 描述被意外改动`);
}

if (wiki['布灵']) verificationErrors.push('不得创建布灵图鉴条目');
if (wiki['乌拉塔']) verificationErrors.push('不得创建乌拉塔图鉴条目');
const regroupCount = (wiki['布灵布灵']?.skills || []).filter(item => item.name === '重组').length;
if (regroupCount !== 1) verificationErrors.push(`布灵布灵的重组学习面应恰好一条，实际 ${regroupCount}`);

const changedMoveNames = moves.filter((move, index) => JSON.stringify(move) !== JSON.stringify(beforeMoves[index])).map(moveName);
if (changedMoveNames.some(name => !targetNames.has(name))) verificationErrors.push(`非目标主技能被修改：${changedMoveNames.filter(name => !targetNames.has(name)).join('、')}`);
for (const [name, entry] of Object.entries(wiki)) {
  const beforeEntry = beforeWiki[name];
  if (!beforeEntry) verificationErrors.push(`意外新增图鉴精灵：${name}`);
  if (!beforeEntry) continue;
  if ((entry.skills || []).length < (beforeEntry.skills || []).length) verificationErrors.push(`${name} 的学习面被删除`);
  for (let index = 0; index < (beforeEntry.skills || []).length; index++) {
    const oldSkill = beforeEntry.skills[index];
    const current = (entry.skills || [])[index];
    if (!current || current.name !== oldSkill.name) verificationErrors.push(`${name} 的既有技能 ${oldSkill.name} 被删除或重排`);
    else if (oldSkill.source !== current.source) verificationErrors.push(`${name} 的 ${oldSkill.name} 来源被意外修改`);
  }
}

if (verificationErrors.length) {
  console.error(`[FAIL] 内存验证失败（${verificationErrors.length} 项），未写入任何文件：`);
  verificationErrors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

console.log(`[OK] 截图技能：${SKILLS.length} 个；新增学习面：${report.added} 条；更新既有学习面：${report.updated} 条。`);
console.log(`跳过：${report.skipped.join('；')}`);
console.log(`缺少截图并保留占位：${UNSUPPORTED_SKILLS.join('、')}`);
console.log(`将修改主技能：${changedMoveNames.join('、')}`);

if (!WRITE) {
  console.log('Dry run 完成；未写入文件。使用 --write 执行写入。');
  process.exit(0);
}

writeJSON('data/moves.json', moves);
writeJSON('data/wiki_monster_data.json', wiki);
const sourceMoves = fs.readFileSync(path.join(ROOT, 'data/moves.json'));
const sourceWiki = fs.readFileSync(path.join(ROOT, 'data/wiki_monster_data.json'));
console.log(`[OK] 已写入源数据。moves SHA-256=${crypto.createHash('sha256').update(sourceMoves).digest('hex')}`);
console.log(`[OK] 已写入源数据。wiki SHA-256=${crypto.createHash('sha256').update(sourceWiki).digest('hex')}`);
