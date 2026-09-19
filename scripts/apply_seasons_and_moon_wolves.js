/**
 * 应用技能赛季、微型乒候→微型斥候迁移，以及银月狼王前置形态。
 * 用法：node scripts/apply_seasons_and_moon_wolves.js [--write]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const WRITE = process.argv.includes('--write');
const S2 = `焚尽 清洗 色散 铁蒺藜 减压阀 排气 相位移动 微型斥候 过山车 冷凝 寒潮 守护咒 踏雷 重金属粉尘 毒肽 疾风涡轮 飞箭 俯冲 加油 撞鬼 入梦 骗局 杂耍 假冒 叠加态 天体吸积`.split(' ');
const S3 = `吹散 急中生智 同频 友谊满溢 缓一缓 养分回流 甜蜜陷阱 撒花 丰收 补觉 花火 暖气 焚身 野火 焚尽 叠浪 沉溺 清洗 点亮 透镜实验 色散 六自由度 蒸汽进行曲 轮班 锁芯 铁蒺藜 减压阀 排气 相位移动 微型斥候 过山车 绞轮 扬尘 沙石阵 冷凝 寒潮 冰裂 雪原狩猎 打喷嚏 龙守望 守护咒 惊雷 通电 踏雷 毒誓 溶解 过敏原 重金属粉尘 毒肽 振翅 拟寄生 马步 驱赶 疾风涡轮 远行 试飞 超声波 飞箭 俯冲 拆礼物 委屈 可爱 转圈圈 蹦跶 加油 耍赖 做好事 魔镜 撞鬼 入梦 吃独食 骗局 限时特惠 纺纱 血契 困兽 下注 杂耍 假冒 许愿池 星痕 叠加态 天体吸积 薄纱环`.split(' ');
const S4_IDS = new Set(Array.from({ length: 30 }, (_, index) => 5931 + index));
const ERRONEOUS_MOVE = '微型乒候';
const CANONICAL_MOVE = '微型斥候';

const { readWiki, writeWiki } = require('./lib/wiki-data.js');
function readJSON(file) { return path.basename(file) === 'wiki_monster_data.json' ? readWiki(ROOT) : JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); }
function writeJSON(file, value) { if (path.basename(file) === 'wiki_monster_data.json') return writeWiki(ROOT, value, { allowRemovedSkills: [ERRONEOUS_MOVE] }); fs.writeFileSync(path.join(ROOT, file), JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function monsterName(monster) { return monster.localized?.zh?.name || ''; }

const monsters = readJSON('data/monsters.json');
const moves = readJSON('data/moves.json');
const wiki = readJSON('data/wiki_monster_data.json');
const types = readJSON('data/types.json');
const before = { monsters: clone(monsters), moves: clone(moves), wiki: clone(wiki) };
const errors = [];
const byMoveName = new Map();
for (const move of moves) {
  const name = move.localized?.zh?.name;
  if (!name || byMoveName.has(name)) errors.push(`技能名称异常：${name || '(空)'}`);
  byMoveName.set(name, move);
}
for (const name of [...S2, ...S3]) if (!byMoveName.has(name)) errors.push(`赛季清单中找不到技能：${name}`);
const s2Set = new Set(S2);
const s3Set = new Set(S3);
for (const name of s2Set) if (!s3Set.has(name)) errors.push(`S2 技能不在 S3 原清单中：${name}`);
const wrong = byMoveName.get(ERRONEOUS_MOVE);
const canonical = byMoveName.get(CANONICAL_MOVE);
if (!wrong || wrong.id !== 5946) errors.push(`找不到错误技能 ${ERRONEOUS_MOVE}`);
if (!canonical || canonical.id !== 489) errors.push(`找不到既有技能 ${CANONICAL_MOVE}`);
const wolf = monsters.find(monster => monsterName(monster) === '银月狼王');
if (!wolf || wolf.id !== 595 || wolf.dex_number !== 445) errors.push('银月狼王基线异常');
for (const [name, dex] of [['诅咒狼灵', 443], ['新月狼灵', 444]]) {
  if (monsters.some(monster => monsterName(monster) === name)) errors.push(`${name} 已存在`);
  if (monsters.some(monster => monster.dex_number === dex)) errors.push(`图鉴号 ${dex} 已存在`);
  if (wiki[name]) errors.push(`${name} 已存在 Wiki 条目`);
}
const ghost = types.find(type => type.localized?.zh === '幽');
const illusion = types.find(type => type.localized?.zh === '幻');
if (!ghost || !illusion) errors.push('缺少幽或幻类型');
if (errors.length) {
  console.error(`[FAIL] 前置校验失败（${errors.length}项），未写入：`);
  errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

// S2 优先于 S3；其余本次新增技能为 S4；所有剩余主技能为 S1。
for (const move of moves) {
  const name = move.localized.zh.name;
  move.season = s2Set.has(name) ? 'S2' : s3Set.has(name) ? 'S3' : S4_IDS.has(move.id) ? 'S4' : 'S1';
}

// 迁移所有学习面并删除错误的主技能记录。
for (const entry of Object.values(wiki)) {
  for (const skill of entry.skills || []) {
    if (skill.name !== ERRONEOUS_MOVE) continue;
    skill.name = CANONICAL_MOVE;
    skill.element = canonical.move_type.localized.zh;
    skill.type = ({ 'Physical Attack': '物攻', 'Magic Attack': '魔攻', Status: '状态', Defense: '防御' })[canonical.move_category];
    skill.desc = canonical.localized.zh.description;
  }
}
const wrongIndex = moves.findIndex(move => move.localized?.zh?.name === ERRONEOUS_MOVE);
moves.splice(wrongIndex, 1);

let nextId = Math.max(...monsters.map(monster => monster.id)) + 1;
const wolfTrait = clone(wolf.trait);
const wolfSkills = wiki['银月狼王']?.skills;
const wolfSpec = [
  { name: '诅咒狼灵', dex: 443, stats: [69, 77, 31, 77, 59, 78], stage: '基础形态', parent: null },
  { name: '新月狼灵', dex: 444, stats: [92, 103, 41, 102, 78, 104], stage: '基础形态', parent: '诅咒狼灵' }
];
const byName = new Map(monsters.map(monster => [monsterName(monster), monster]));
for (const spec of wolfSpec) {
  const [hp, phyAtk, magAtk, phyDef, magDef, spd] = spec.stats;
  const parentId = spec.parent ? byName.get(spec.parent).id : null;
  const monster = {
    base_hp: hp, base_mag_atk: magAtk, base_mag_def: magDef, base_phy_atk: phyAtk, base_phy_def: phyDef, base_spd: spd,
    default_legacy_type: clone(ghost), dex_number: spec.dex, evolution_chain_name: '诅咒狼灵', evolution_stage: spec.stage, evolves_from_id: parentId,
    form: 'default', form_category: '无多形态', id: nextId++, image: '', is_leader_form: false, leader_potential: false,
    localized: { zh: { name: spec.name } }, main_form_name: '', main_type: clone(ghost), sub_type: clone(illusion), preferred_attack_style: 'Physical',
    trait: clone(wolfTrait), learnset_mode: 'inherit', learnset_inherits_from_id: wolf.id
  };
  monsters.push(monster);
  byName.set(spec.name, monster);
}
wolf.evolves_from_id = byName.get('新月狼灵').id;
wolf.evolution_chain_name = '诅咒狼灵';
wolf.learnset_mode = 'own';
delete wolf.learnset_inherits_from_id;

const verificationErrors = [];
const names = new Set();
const ids = new Set();
for (const monster of monsters) {
  if (ids.has(monster.id)) verificationErrors.push(`重复内部 ID：${monster.id}`);
  ids.add(monster.id);
  if (monster.form === 'default' && names.has(monsterName(monster))) verificationErrors.push(`重复默认精灵名称：${monsterName(monster)}`);
  if (monster.form === 'default') names.add(monsterName(monster));
  if (!['S1', 'S2', 'S3', 'S4'].includes(monster.learnset_mode === undefined ? 'S1' : 'S1')) { /* placeholder to keep data-loop local */ }
}
const moveNames = new Set();
for (const move of moves) {
  const name = move.localized?.zh?.name;
  if (moveNames.has(name)) verificationErrors.push(`迁移后技能名称重复：${name}`);
  moveNames.add(name);
  if (!['S1', 'S2', 'S3', 'S4'].includes(move.season)) verificationErrors.push(`${name} 缺少有效赛季`);
}
if (moveNames.has(ERRONEOUS_MOVE)) verificationErrors.push('微型乒候未删除');
if (!moveNames.has(CANONICAL_MOVE) || byMoveName.get(CANONICAL_MOVE).season !== 'S2') verificationErrors.push('微型斥候赛季或主技能异常');
for (const [pet, entry] of Object.entries(wiki)) {
  for (const skill of entry.skills || []) {
    if (skill.name === ERRONEOUS_MOVE) verificationErrors.push(`${pet} 仍引用微型乒候`);
  }
}
const curse = byName.get('诅咒狼灵');
const newMoon = byName.get('新月狼灵');
if (!curse || !newMoon || newMoon.evolves_from_id !== curse.id || wolf.evolves_from_id !== newMoon.id) verificationErrors.push('银月狼王进化链错误');
for (const monster of [curse, newMoon]) {
  if (!monster || monster.learnset_mode !== 'inherit' || monster.learnset_inherits_from_id !== wolf.id) verificationErrors.push(`${monster?.localized?.zh?.name || '狼灵'} 学习面继承错误`);
}
if (verificationErrors.length) {
  console.error(`[FAIL] 内存验证失败（${verificationErrors.length}项），未写入：`);
  verificationErrors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}
const seasonCounts = moves.reduce((counts, move) => { counts[move.season]++; return counts; }, { S1: 0, S2: 0, S3: 0, S4: 0 });
console.log(`[OK] 技能赛季：S1=${seasonCounts.S1} S2=${seasonCounts.S2} S3=${seasonCounts.S3} S4=${seasonCounts.S4}。`);
console.log('[OK] 微型乒候已迁移为微型斥候；已新增诅咒狼灵→新月狼灵→银月狼王。');
if (!WRITE) { console.log('Dry run 完成；未写入。使用 --write 执行写入。'); process.exit(0); }
writeJSON('data/monsters.json', monsters);
writeJSON('data/moves.json', moves);
writeJSON('data/wiki_monster_data.json', wiki);
for (const file of ['monsters.json', 'moves.json', 'wiki_monster_data.json']) {
  console.log(`[OK] ${file} SHA-256=${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'data', file))).digest('hex')}`);
}
