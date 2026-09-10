/**
 * 根据 old/立方人 文本资料新增 No.466 果实立方人。
 * 用法：node scripts/add_fruit_cube_person.js [--write]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const WRITE = process.argv.includes('--write');
const NAME = '果实立方人';
const DEX = 466;
const CATEGORY_TO_TYPE = { 'Physical Attack': '物攻', 'Magic Attack': '魔攻', Status: '状态', Defense: '防御' };
const GROUPS = {
  '默认': ['拆卸', '钢铁洪流', '主轴', '拖拉机', '杠杆置换', '轴承支撑', '飞叶', '藤绞', '顶端优势', '麦芒', '酶浓度调整', '蜡质膜', '有效预防'],
  '血脉': ['反击拳', '械斗', '扬沙', '幻象', '星云漩涡', '折线冲击', '风矢', '冷风', '拍击', '升龙咆哮', '集中', '等价交换', '徒长', '引燃', '蓄水', '毒孢子', '假寐', '甜心续航'],
  '技能石': ['能量守恒', '相位移动', '孢子', '见招拆招', '垂死反击', '防御', '血气', '嗜痛', '晒太阳', '复写', '跺地', '淤泥表皮']
};

function readJSON(file) { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); }
function writeJSON(file, value) { fs.writeFileSync(path.join(ROOT, file), JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function moveName(move) { return move.localized?.zh?.name; }
function skillCard(move, source) {
  const type = CATEGORY_TO_TYPE[move.move_category];
  if (!type || !move.move_type?.localized?.zh || !move.localized?.zh?.description) throw new Error(`技能字段不完整：${moveName(move)}`);
  return { name: moveName(move), source, type, element: move.move_type.localized.zh, desc: move.localized.zh.description };
}

const monsters = readJSON('data/monsters.json');
const moves = readJSON('data/moves.json');
const wiki = readJSON('data/wiki_monster_data.json');
const types = readJSON('data/types.json');
const beforeMonsters = clone(monsters);
const beforeWiki = clone(wiki);
const errors = [];
const byMoveName = new Map();
for (const move of moves) {
  const name = moveName(move);
  if (!name || byMoveName.has(name)) errors.push(`技能名称异常：${name || '(空)'}`);
  byMoveName.set(name, move);
}
const allSkills = Object.values(GROUPS).flat();
if (new Set(allSkills).size !== allSkills.length) errors.push('果实立方人学习面存在重复技能名');
for (const name of allSkills) if (!byMoveName.has(name)) errors.push(`主技能表缺少：${name}`);
const mechanical = types.filter(type => type.localized?.zh === '机械');
const grass = types.filter(type => type.localized?.zh === '草');
if (mechanical.length !== 1 || grass.length !== 1) errors.push('机械或草属性对象不唯一');
if (monsters.some(monster => monster.localized?.zh?.name === NAME)) errors.push(`${NAME} 已存在`);
if (monsters.some(monster => monster.dex_number === DEX)) errors.push(`图鉴号 ${DEX} 已存在`);
if (wiki[NAME]) errors.push(`${NAME} Wiki 条目已存在`);
for (const file of ['assets/monster/images/果实立方人.png', 'assets/monster/images/wiki/果实立方人.png', 'assets/monster/trait/秋收.png']) {
  if (!fs.existsSync(path.join(ROOT, file))) errors.push(`缺少资源：${file}`);
}
if (errors.length) {
  console.error(`[FAIL] 前置校验失败（${errors.length}项），未写入：`);
  errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

const [hp, phyAtk, magAtk, phyDef, magDef, spd] = [105, 132, 50, 120, 98, 95];
const id = Math.max(...monsters.map(monster => monster.id)) + 1;
monsters.push({
  base_hp: hp, base_mag_atk: magAtk, base_mag_def: magDef, base_phy_atk: phyAtk, base_phy_def: phyDef, base_spd: spd,
  default_legacy_type: clone(mechanical[0]), dex_number: DEX, evolution_chain_name: '', evolution_stage: '高级形态', evolves_from_id: null,
  form: 'default', form_category: '无多形态', id, image: '果实立方人.png', is_leader_form: false, leader_potential: false,
  localized: { zh: { name: NAME } }, main_form_name: '', main_type: clone(mechanical[0]), sub_type: clone(grass[0]), preferred_attack_style: 'Physical',
  trait: { localized: { zh: { name: '秋收', description: '处于草系环境中时，机械系技能威力+50%。' } } },
  learnset_mode: 'own'
});
const skills = [];
for (const [source, names] of Object.entries(GROUPS)) for (const name of names) skills.push(skillCard(byMoveName.get(name), source));
wiki[NAME] = { image: 'assets/monster/images/wiki/果实立方人.png', skills };

const verificationErrors = [];
const created = monsters[monsters.length - 1];
if (created.id !== id || created.dex_number !== DEX || created.base_hp + created.base_phy_atk + created.base_mag_atk + created.base_phy_def + created.base_mag_def + created.base_spd !== 600) verificationErrors.push('果实立方人 ID/编号/种族值错误');
if (created.main_type.localized?.zh !== '机械' || created.sub_type?.localized?.zh !== '草' || created.evolution_stage !== '高级形态' || created.evolves_from_id !== null || created.learnset_mode !== 'own') verificationErrors.push('果实立方人属性或形态字段错误');
if (created.trait.localized?.zh?.name !== '秋收' || created.trait.localized?.zh?.description !== '处于草系环境中时，机械系技能威力+50%。') verificationErrors.push('秋收特性错误');
const entry = wiki[NAME];
if (!entry || entry.image !== 'assets/monster/images/wiki/果实立方人.png' || entry.skills.length !== 43) verificationErrors.push('果实立方人 Wiki 条目错误');
for (const [source, names] of Object.entries(GROUPS)) {
  const actual = entry.skills.filter(skill => skill.source === source);
  if (actual.length !== names.length) verificationErrors.push(`${source} 技能数错误`);
  for (const name of names) {
    const card = actual.find(skill => skill.name === name);
    const move = byMoveName.get(name);
    if (!card || card.element !== move.move_type.localized.zh || card.type !== CATEGORY_TO_TYPE[move.move_category] || card.desc !== move.localized.zh.description) verificationErrors.push(`${name} 学习面投影错误`);
  }
}
if (new Set(entry.skills.map(skill => skill.name)).size !== entry.skills.length) verificationErrors.push('果实立方人学习面重复');
for (let i = 0; i < beforeMonsters.length; i++) if (JSON.stringify(monsters[i]) !== JSON.stringify(beforeMonsters[i])) verificationErrors.push(`既有精灵被修改：index ${i}`);
for (const [name, old] of Object.entries(beforeWiki)) if (JSON.stringify(wiki[name]) !== JSON.stringify(old)) verificationErrors.push(`既有 Wiki 条目被修改：${name}`);
if (verificationErrors.length) {
  console.error(`[FAIL] 内存验证失败（${verificationErrors.length}项），未写入：`);
  verificationErrors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}
console.log(`[OK] 将新增 ${NAME}(No.${DEX}, id=${id})，默认/血脉/技能石=13/18/12。`);
if (!WRITE) { console.log('Dry run 完成；未写入。使用 --write 执行写入。'); process.exit(0); }
writeJSON('data/monsters.json', monsters);
writeJSON('data/wiki_monster_data.json', wiki);
for (const file of ['monsters.json', 'wiki_monster_data.json']) console.log(`[OK] ${file} SHA-256=${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'data', file))).digest('hex')}`);
