/**
 * 新增拖拉机、麦芒及对应技能石学习面。
 * 用法：node scripts/add_tractor_and_wheat.js [--write]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const WRITE = process.argv.includes('--write');
const CATEGORY_TO_TYPE = { 'Physical Attack': '物攻', 'Magic Attack': '魔攻', Status: '状态', Defense: '防御' };
const SPECS = [
  {
    name: '拖拉机', element: '机械', category: 'Physical Attack', energy: 3, power: 85, combo: 1,
    desc: '造成物伤，位于1号位时，先手+1。传动1。',
    learners: ['声波缇塔', '立方人', '圣剑-X', '胡桃王子']
  },
  {
    name: '麦芒', element: '草', category: 'Physical Attack', energy: 5, power: 105, combo: null,
    desc: '造成物伤，若上回合双方有精灵使用萌系技能，自己回复7能量。',
    learners: ['卡瓦重（沙地附近的样子）', '卡瓦重（草地附近的样子）', '鳗尾兽', '森巨人']
  }
];

const { readWiki, writeWiki } = require('./lib/wiki-data.js');
function readJSON(file) { return path.basename(file) === 'wiki_monster_data.json' ? readWiki(ROOT) : JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); }
function writeJSON(file, value) { if (path.basename(file) === 'wiki_monster_data.json') return writeWiki(ROOT, value); fs.writeFileSync(path.join(ROOT, file), JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

const moves = readJSON('data/moves.json');
const wiki = readJSON('data/wiki_monster_data.json');
const types = readJSON('data/types.json');
const beforeMoves = clone(moves);
const beforeWiki = clone(wiki);
const errors = [];
const byName = new Map();
const ids = new Set();
for (const move of moves) {
  const name = move.localized?.zh?.name;
  if (!name || byName.has(name)) errors.push(`技能名称异常：${name || '(空)'}`);
  if (ids.has(move.id)) errors.push(`技能 ID 重复：${move.id}`);
  byName.set(name, move);
  ids.add(move.id);
}
const typeByZh = new Map(types.map(type => [type.localized?.zh, type]));
for (const spec of SPECS) {
  if (byName.has(spec.name)) errors.push(`${spec.name} 已存在于主技能表`);
  if (!typeByZh.get(spec.element)) errors.push(`${spec.name} 属性不存在：${spec.element}`);
  for (const learner of spec.learners) {
    const entry = wiki[learner];
    if (!entry || !Array.isArray(entry.skills)) errors.push(`${spec.name} 学习者图鉴无效：${learner}`);
    else if (entry.skills.some(skill => skill.name === spec.name)) errors.push(`${learner} 已有 ${spec.name}`);
  }
}
if (errors.length) {
  console.error(`[FAIL] 前置校验失败（${errors.length}项），未写入：`);
  errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

let nextId = Math.max(...moves.map(move => move.id)) + 1;
for (const spec of SPECS) {
  const move = {
    id: nextId++,
    move_type: clone(typeByZh.get(spec.element)),
    localized: { zh: { name: spec.name, description: spec.desc } },
    move_category: spec.category,
    energy_cost: spec.energy,
    power: spec.power,
    base_combo: spec.combo,
    counter_power_multiplier: null,
    alt_power_total: null,
    alt_condition_zh: null,
    power_formula: null,
    statuses: [],
    season: 'S4'
  };
  moves.push(move);
  byName.set(spec.name, move);
  const type = CATEGORY_TO_TYPE[move.move_category];
  for (const learner of spec.learners) {
    wiki[learner].skills.push({
      name: spec.name,
      source: '技能石',
      type,
      element: move.move_type.localized.zh,
      desc: move.localized.zh.description
    });
  }
}

const verificationErrors = [];
for (const spec of SPECS) {
  const move = byName.get(spec.name);
  if (!move || move.move_type.localized?.zh !== spec.element || move.move_category !== spec.category || move.energy_cost !== spec.energy || move.power !== spec.power || move.base_combo !== spec.combo || move.localized.zh.description !== spec.desc || move.season !== 'S4') verificationErrors.push(`${spec.name} 主技能字段错误`);
  for (const learner of spec.learners) {
    const rows = wiki[learner].skills.filter(skill => skill.name === spec.name);
    if (rows.length !== 1) verificationErrors.push(`${learner} 的 ${spec.name} 学习面数量为 ${rows.length}`);
    else if (rows[0].source !== '技能石' || rows[0].type !== '物攻' || rows[0].element !== spec.element || rows[0].desc !== spec.desc) verificationErrors.push(`${learner} 的 ${spec.name} 学习面字段错误`);
  }
}
const changedNames = moves.filter((move, index) => index >= beforeMoves.length || JSON.stringify(move) !== JSON.stringify(beforeMoves[index])).map(move => move.localized.zh.name);
if (changedNames.some(name => !SPECS.some(spec => spec.name === name))) verificationErrors.push(`非目标主技能被修改：${changedNames.join('、')}`);
for (const [name, entry] of Object.entries(wiki)) {
  const old = beforeWiki[name];
  if (!old) verificationErrors.push(`意外新增图鉴条目：${name}`);
  if (!old) continue;
  const expectedAdd = SPECS.filter(spec => spec.learners.includes(name)).length;
  if (entry.skills.length !== old.skills.length + expectedAdd) verificationErrors.push(`${name} 学习面数量变化异常`);
  for (let i = 0; i < old.skills.length; i++) {
    if (entry.skills[i].name !== old.skills[i].name || entry.skills[i].source !== old.skills[i].source) verificationErrors.push(`${name} 既有学习面被重排或改来源`);
  }
}
if (verificationErrors.length) {
  console.error(`[FAIL] 内存验证失败（${verificationErrors.length}项），未写入：`);
  verificationErrors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}
console.log(`[OK] 将新增拖拉机(id=${Math.max(...beforeMoves.map(move => move.id)) + 1})、麦芒(id=${Math.max(...beforeMoves.map(move => move.id)) + 2})，各4条技能石学习面。`);
if (!WRITE) { console.log('Dry run 完成；未写入。使用 --write 执行写入。'); process.exit(0); }
writeJSON('data/moves.json', moves);
writeJSON('data/wiki_monster_data.json', wiki);
for (const file of ['moves.json', 'wiki_monster_data.json']) {
  console.log(`[OK] ${file} SHA-256=${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'data', file))).digest('hex')}`);
}
