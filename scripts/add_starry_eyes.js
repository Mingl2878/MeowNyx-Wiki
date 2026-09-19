/**
 * 根据 D:/echoagent/old/星星眼 截图及用户确认信息新增星星眼。
 * 用法：node scripts/add_starry_eyes.js [--write]
 * 默认仅进行 dry-run；全部前置与内存校验通过后，--write 才写入。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const WRITE = process.argv.includes('--write');
const CATEGORY_TO_TYPE = {
  'Physical Attack': '物攻',
  'Magic Attack': '魔攻',
  Status: '状态',
  Defense: '防御'
};
const STAR_NAME = '星星眼';
const STAR_DEX = 463;
const OBSERVER_NAME = '观测者效应';
const OBSERVER_DESC = '自己脱离，更换入场的精灵以月陨星状态登场。';
const NIGHT_SKY_NAME = '仰望夜空';
const NIGHT_SKY_DESC = '自己获得魔攻和魔防+70%。';

const GROUPS = {
  '默认': ['错乱', '大爆炸', '星痕', '针状物', '许愿池', '四维降解', NIGHT_SKY_NAME, OBSERVER_NAME, '冥想', '许愿星', '魔法增效', '防御', '防反'],
  '血脉': ['超维投射', '离子震荡', '等价交换', '幻象', '飞吻', '风矢', '缠丝劲', '噬心', '毒孢子', '麻痹', '升龙咆哮', '冷风', '淤泥表皮', '虹光冲击', '肥皂泡', '引燃', '徒长', '星星撞击'],
  '技能石': ['引力偏转', '恐吓', '虚化', '热砂', '陨石', '钧势', '刺盾', '遁地', '阻断', '借用', '锐利眼神', '吓退', '无畏之心']
};

const { readWiki, writeWiki } = require('./lib/wiki-data.js');
function readJSON(relativePath) {
  if (path.basename(relativePath) === 'wiki_monster_data.json') return readWiki(ROOT);
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function writeJSON(relativePath, value) {
  if (path.basename(relativePath) === 'wiki_monster_data.json') return writeWiki(ROOT, value);
  fs.writeFileSync(path.join(ROOT, relativePath), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function moveName(move) {
  return move.localized && move.localized.zh && move.localized.zh.name;
}

function elementName(move) {
  return move.move_type && move.move_type.localized && move.move_type.localized.zh;
}

function skillCard(move, source) {
  const type = CATEGORY_TO_TYPE[move.move_category];
  if (!type) throw new Error(`${moveName(move)} 缺少类别映射：${move.move_category}`);
  const element = elementName(move);
  const desc = move.localized && move.localized.zh && move.localized.zh.description;
  if (!element || !desc) throw new Error(`${moveName(move)} 缺少属性或中文描述`);
  return { name: moveName(move), source, type, element, desc };
}

const errors = [];
const monsters = readJSON('data/monsters.json');
const moves = readJSON('data/moves.json');
const wiki = readJSON('data/wiki_monster_data.json');
const types = readJSON('data/types.json');
const before = { monsters: clone(monsters), moves: clone(moves), wiki: clone(wiki) };

const illusionType = types.filter(type => type.localized?.zh === '幻');
if (illusionType.length !== 1) errors.push(`幻系类型记录应唯一，实际 ${illusionType.length} 条`);
const illusion = illusionType[0];

if (monsters.some(monster => monster.localized?.zh?.name === STAR_NAME)) errors.push(`${STAR_NAME} 已存在于 monsters.json`);
if (monsters.some(monster => monster.dex_number === STAR_DEX)) errors.push(`图鉴号 ${STAR_DEX} 已存在于 monsters.json`);
if (wiki[STAR_NAME]) errors.push(`${STAR_NAME} 已存在于 wiki_monster_data.json`);

const moveByName = new Map();
for (const move of moves) {
  const name = moveName(move);
  if (!name) {
    errors.push('moves.json 中存在缺少中文名称的记录');
    continue;
  }
  if (moveByName.has(name)) errors.push(`moves.json 中技能名称重复：${name}`);
  moveByName.set(name, move);
}

const allSkills = Object.values(GROUPS).flat();
if (new Set(allSkills).size !== allSkills.length) errors.push(`${STAR_NAME} 三组学习面中存在重复技能名`);
if (moveByName.has(NIGHT_SKY_NAME)) errors.push(`${NIGHT_SKY_NAME} 已存在于 moves.json，停止新增以避免重复`);
for (const name of allSkills.filter(name => name !== NIGHT_SKY_NAME)) {
  if (!moveByName.has(name)) errors.push(`${STAR_NAME} 学习技能不存在：${name}`);
}

const observer = moveByName.get(OBSERVER_NAME);
if (!observer) errors.push(`找不到 ${OBSERVER_NAME}`);
else if (observer.energy_cost !== 3 || observer.move_category !== 'Status' || observer.power !== null) {
  errors.push(`${OBSERVER_NAME} 现有能耗/类别/威力不符合确认基线`);
}

if (errors.length) {
  console.error(`[FAIL] 前置校验失败（${errors.length} 项），未写入任何文件：`);
  errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

const maxMoveId = Math.max(...moves.map(move => move.id));
moves.push({
  id: maxMoveId + 1,
  move_type: clone(illusion),
  localized: { zh: { name: NIGHT_SKY_NAME, description: NIGHT_SKY_DESC } },
  move_category: 'Status',
  energy_cost: 2,
  power: null,
  base_combo: null,
  counter_power_multiplier: null,
  alt_power_total: null,
  alt_condition_zh: null,
  power_formula: null,
  statuses: []
});
moveByName.set(NIGHT_SKY_NAME, moves[moves.length - 1]);

observer.move_type = clone(illusion);
observer.localized.zh.description = OBSERVER_DESC;

const maxMonsterId = Math.max(...monsters.map(monster => monster.id));
monsters.push({
  base_hp: 116,
  base_mag_atk: 120,
  base_mag_def: 71,
  base_phy_atk: 97,
  base_phy_def: 116,
  base_spd: 85,
  default_legacy_type: clone(illusion),
  dex_number: STAR_DEX,
  evolution_chain_name: '',
  evolution_stage: '高级形态',
  evolves_from_id: null,
  form: 'default',
  form_category: '无多形态',
  id: maxMonsterId + 1,
  image: '',
  is_leader_form: false,
  leader_potential: false,
  localized: { zh: { name: STAR_NAME } },
  main_form_name: '',
  main_type: clone(illusion),
  preferred_attack_style: 'Magic',
  sub_type: null,
  trait: {
    localized: {
      zh: {
        name: '宇宙之眼',
        description: '敌方每有1层星陨印记，自己获得物防+10%。'
      }
    }
  }
});

const starSkills = [];
for (const [source, names] of Object.entries(GROUPS)) {
  for (const name of names) starSkills.push(skillCard(moveByName.get(name), source));
}
wiki[STAR_NAME] = { image: '', skills: starSkills };

for (const entry of Object.values(wiki)) {
  for (const linked of entry.skills || []) {
    if (linked.name !== OBSERVER_NAME) continue;
    linked.element = elementName(observer);
    linked.type = CATEGORY_TO_TYPE[observer.move_category];
    linked.desc = observer.localized.zh.description;
  }
}

const verificationErrors = [];
const addedMonster = monsters[monsters.length - 1];
if (addedMonster.id !== maxMonsterId + 1 || addedMonster.dex_number !== STAR_DEX || addedMonster.localized.zh.name !== STAR_NAME) verificationErrors.push('星星眼主精灵 ID、图鉴号或名称错误');
if (addedMonster.base_hp + addedMonster.base_phy_atk + addedMonster.base_mag_atk + addedMonster.base_phy_def + addedMonster.base_mag_def + addedMonster.base_spd !== 605) verificationErrors.push('星星眼六维总和不是 605');
if (addedMonster.main_type.localized.zh !== '幻' || addedMonster.sub_type !== null || addedMonster.preferred_attack_style !== 'Magic') verificationErrors.push('星星眼属性或攻击偏好错误');
if (addedMonster.trait.localized.zh.name !== '宇宙之眼' || addedMonster.trait.localized.zh.description !== '敌方每有1层星陨印记，自己获得物防+10%。') verificationErrors.push('星星眼特性错误');

const star = wiki[STAR_NAME];
if (!star || !Array.isArray(star.skills) || star.skills.length !== 44) verificationErrors.push('星星眼学习面总数应为 44');
for (const [source, names] of Object.entries(GROUPS)) {
  const actual = star.skills.filter(skill => skill.source === source);
  if (actual.length !== names.length) verificationErrors.push(`星星眼 ${source} 技能数应为 ${names.length}，实际 ${actual.length}`);
  for (const name of names) {
    const skill = actual.find(item => item.name === name);
    const move = moveByName.get(name);
    if (!skill) verificationErrors.push(`星星眼缺少 ${source} 技能：${name}`);
    else if (skill.element !== elementName(move) || skill.type !== CATEGORY_TO_TYPE[move.move_category] || skill.desc !== move.localized.zh.description) verificationErrors.push(`星星眼的 ${name} 未正确投影主技能数据`);
  }
}
if (new Set(star.skills.map(skill => skill.name)).size !== star.skills.length) verificationErrors.push('星星眼学习面存在重复技能');
const nightSky = moveByName.get(NIGHT_SKY_NAME);
if (!nightSky || elementName(nightSky) !== '幻' || nightSky.move_category !== 'Status' || nightSky.energy_cost !== 2 || nightSky.power !== null || nightSky.base_combo !== null || nightSky.localized.zh.description !== NIGHT_SKY_DESC) verificationErrors.push('仰望夜空基础数据错误');
if (elementName(observer) !== '幻' || observer.move_category !== 'Status' || observer.energy_cost !== 3 || observer.localized.zh.description !== OBSERVER_DESC) verificationErrors.push('观测者效应基础数据错误');
for (const [monsterName, entry] of Object.entries(wiki)) {
  for (const linked of entry.skills || []) {
    if (linked.name !== OBSERVER_NAME) continue;
    if (linked.element !== '幻' || linked.type !== '状态' || linked.desc !== OBSERVER_DESC) verificationErrors.push(`${monsterName} 的观测者效应未同步为确认数据`);
  }
}

const changedMoveNames = moves.filter((move, index) => index >= before.moves.length || JSON.stringify(move) !== JSON.stringify(before.moves[index])).map(moveName);
if (changedMoveNames.some(name => ![NIGHT_SKY_NAME, OBSERVER_NAME].includes(name))) verificationErrors.push(`非白名单主技能被修改：${changedMoveNames.join('、')}`);
for (let index = 0; index < before.monsters.length; index++) {
  if (JSON.stringify(monsters[index]) !== JSON.stringify(before.monsters[index])) verificationErrors.push(`既有精灵被修改：index ${index}`);
}
for (const [name, entry] of Object.entries(before.wiki)) {
  const current = wiki[name];
  if (!current) verificationErrors.push(`既有图鉴精灵被删除：${name}`);
  else if (name !== STAR_NAME) {
    for (let index = 0; index < (entry.skills || []).length; index++) {
      const oldSkill = entry.skills[index];
      const currentSkill = current.skills[index];
      if (!currentSkill || currentSkill.name !== oldSkill.name || currentSkill.source !== oldSkill.source) verificationErrors.push(`${name} 的既有学习面被删除、重排或来源改动`);
    }
  }
}

if (verificationErrors.length) {
  console.error(`[FAIL] 内存验证失败（${verificationErrors.length} 项），未写入任何文件：`);
  verificationErrors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

console.log(`[OK] 将新增 ${STAR_NAME}(No.${STAR_DEX})，技能组 默认/血脉/技能石 = 13/18/13。`);
console.log(`[OK] 将新增 ${NIGHT_SKY_NAME}(id=${maxMoveId + 1})，并同步 ${OBSERVER_NAME} 为幻系/状态/3费。`);
if (!WRITE) {
  console.log('Dry run 完成；未写入文件。使用 --write 执行写入。');
  process.exit(0);
}

writeJSON('data/monsters.json', monsters);
writeJSON('data/moves.json', moves);
writeJSON('data/wiki_monster_data.json', wiki);
console.log(`[OK] 已写入源数据。monsters SHA-256=${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'data/monsters.json'))).digest('hex')}`);
console.log(`[OK] 已写入源数据。moves SHA-256=${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'data/moves.json'))).digest('hex')}`);
console.log(`[OK] 已写入源数据。wiki SHA-256=${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'data/wiki_monster_data.json'))).digest('hex')}`);
