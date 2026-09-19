/**
 * 根据 D:/echoagent/old/初始形态 截图导入九只精灵。
 * 用法：node scripts/add_initial_forms.js [--write]
 * 默认 dry-run；仅在全部校验通过且传入 --write 后写入。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const WRITE = process.argv.includes('--write');
const WIND_TRAIT_DESC = '携带的技能每累计传动8，自己获得1层风起印记';

const ENTRIES = [
  { name: '月辉鸠', dex: 447, elements: ['翼', '冰'], stats: [66, 79, 80, 83, 90, 92], source: '月使鸷纳', stage: '基础形态', chain: '月辉鸠' },
  { name: '热团团', dex: 449, elements: ['火', '虫'], stats: [48, 69, 18, 72, 72, 63], source: '圣凯布米龙', stage: '基础形态', chain: '热团团' },
  { name: '焰米龙', dex: 450, elements: ['火', '虫'], stats: [63, 92, 23, 96, 96, 84], source: '圣凯布米龙', stage: '高级形态', chain: '热团团', parent: '热团团' },
  { name: '章脑丸', dex: 452, elements: ['光', '水'], stats: [89, 42, 99, 69, 99, 80], source: '智辉章脑', stage: '基础形态', chain: '章脑丸' },
  { name: '斑鱼', dex: 455, elements: ['幻'], stats: [101, 37, 85, 58, 93, 40], source: '玳塔', stage: '基础形态', chain: '斑鱼' },
  { name: '量风碗', dex: 457, elements: ['翼', '机械'], stats: [78, 79, 77, 93, 67, 96], source: '测风蝉', stage: '基础形态', chain: '量风碗', traitDesc: WIND_TRAIT_DESC },
  { name: '小浣蛋', dex: 459, elements: ['恶'], stats: [78, 93, 88, 99, 92, 96], source: '黑手浣熊', stage: '基础形态', chain: '小浣蛋' },
  { name: '幽铃', dex: 461, elements: ['幽'], stats: [99, 37, 93, 80, 105, 76], source: '摇铃魔偶', stage: '基础形态', chain: '幽铃' },
  { name: '布灵', dex: 464, elements: ['幻', '光'], stats: [66, 92, 32, 98, 77, 100], source: '布灵布灵', stage: '基础形态', chain: '布灵' }
];

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
function monsterName(monster) {
  return monster.localized && monster.localized.zh && monster.localized.zh.name;
}
function countBySource(skills) {
  return ['默认', '血脉', '技能石'].map(source => skills.filter(skill => skill.source === source).length).join('/');
}

const monsters = readJSON('data/monsters.json');
const moves = readJSON('data/moves.json');
const wiki = readJSON('data/wiki_monster_data.json');
const types = readJSON('data/types.json');
const before = { monsters: clone(monsters), wiki: clone(wiki) };
const errors = [];
const byName = new Map();
const byId = new Map();
for (const monster of monsters) {
  const name = monsterName(monster);
  if (!name) errors.push('monsters.json 中存在缺少中文名称的精灵');
  // 现有数据允许同名的不同形态；本次只对新增名称和图鉴号做唯一性断言。
  else if (!byName.has(name) || monster.form === 'default') byName.set(name, monster);
  if (byId.has(monster.id)) errors.push(`monsters.json id 重复：${monster.id}`);
  else byId.set(monster.id, monster);
}
const typeByName = new Map(types.map(type => [type.localized?.zh, type]));
const moveByName = new Map();
for (const move of moves) {
  const name = move.localized?.zh?.name;
  if (!name) errors.push('moves.json 存在缺少中文名称的技能');
  else if (moveByName.has(name)) errors.push(`moves.json 技能名称重复：${name}`);
  else moveByName.set(name, move);
}

for (const entry of ENTRIES) {
  if (byName.has(entry.name)) errors.push(`${entry.name} 已存在于 monsters.json`);
  if (monsters.some(monster => monster.dex_number === entry.dex)) errors.push(`图鉴号 ${entry.dex} 已存在`);
  if (wiki[entry.name]) errors.push(`${entry.name} 已存在于 wiki_monster_data.json`);
  const sourceMonster = byName.get(entry.source);
  const sourceWiki = wiki[entry.source];
  if (!sourceMonster) errors.push(`找不到学习面来源精灵：${entry.source}`);
  if (!sourceWiki || !Array.isArray(sourceWiki.skills) || sourceWiki.skills.length === 0) errors.push(`${entry.source} 缺少可复制的图鉴学习面`);
  for (const element of entry.elements) if (!typeByName.get(element)) errors.push(`${entry.name} 的属性不存在：${element}`);
  if (entry.parent && !ENTRIES.some(candidate => candidate.name === entry.parent)) errors.push(`${entry.name} 的上游不在本次新增列表：${entry.parent}`);
}
if (byName.get('测风蝉')?.trait?.localized?.zh?.name !== '风速仪') errors.push('测风蝉特性不是风速仪，停止同步特性文案');

if (errors.length) {
  console.error(`[FAIL] 前置校验失败（${errors.length} 项），未写入任何文件：`);
  errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

let nextId = Math.max(...monsters.map(monster => monster.id)) + 1;
for (const entry of ENTRIES) {
  const sourceMonster = byName.get(entry.source);
  const [hp, phyAtk, magAtk, phyDef, magDef, spd] = entry.stats;
  const mainType = typeByName.get(entry.elements[0]);
  const subType = entry.elements[1] ? typeByName.get(entry.elements[1]) : null;
  const trait = clone(sourceMonster.trait);
  if (entry.traitDesc) trait.localized.zh.description = entry.traitDesc;
  const parentId = entry.parent ? byName.get(entry.parent).id : null;
  const monster = {
    base_hp: hp,
    base_mag_atk: magAtk,
    base_mag_def: magDef,
    base_phy_atk: phyAtk,
    base_phy_def: phyDef,
    base_spd: spd,
    default_legacy_type: clone(mainType),
    dex_number: entry.dex,
    evolution_chain_name: entry.chain,
    evolution_stage: entry.stage,
    evolves_from_id: parentId,
    form: 'default',
    form_category: '无多形态',
    id: nextId++,
    image: '',
    is_leader_form: false,
    leader_potential: false,
    localized: { zh: { name: entry.name } },
    main_form_name: '',
    main_type: clone(mainType),
    preferred_attack_style: magAtk > phyAtk ? 'Magic' : phyAtk > magAtk ? 'Physical' : 'Both',
    sub_type: subType ? clone(subType) : null,
    trait
  };
  monsters.push(monster);
  byName.set(entry.name, monster);
  byId.set(monster.id, monster);
  wiki[entry.name] = { image: '', skills: clone(wiki[entry.source].skills) };
}

function connect(childName, parentName, chain) {
  const child = byName.get(childName);
  const parent = byName.get(parentName);
  child.evolves_from_id = parent.id;
  child.evolution_chain_name = chain;
  parent.evolution_chain_name = chain;
}
connect('月使鸷纳', '月辉鸠', '月辉鸠');
connect('焰米龙', '热团团', '热团团');
connect('圣凯布米龙', '焰米龙', '热团团');
connect('智辉章脑', '章脑丸', '章脑丸');
connect('玳塔', '斑鱼', '斑鱼');
connect('测风蝉', '量风碗', '量风碗');
connect('黑手浣熊', '小浣蛋', '小浣蛋');
connect('摇铃魔偶', '幽铃', '幽铃');
connect('布灵布灵', '布灵', '布灵');
byName.get('测风蝉').trait.localized.zh.description = WIND_TRAIT_DESC;

const verificationErrors = [];
for (const entry of ENTRIES) {
  const monster = byName.get(entry.name);
  const sourceMonster = byName.get(entry.source);
  const sourceSkills = wiki[entry.source].skills;
  const skills = wiki[entry.name]?.skills;
  if (!monster || !skills) { verificationErrors.push(`${entry.name} 未正确新增`); continue; }
  if (monster.dex_number !== entry.dex || monster.base_hp !== entry.stats[0] || monster.base_phy_atk !== entry.stats[1] || monster.base_mag_atk !== entry.stats[2] || monster.base_phy_def !== entry.stats[3] || monster.base_mag_def !== entry.stats[4] || monster.base_spd !== entry.stats[5]) verificationErrors.push(`${entry.name} 六维或图鉴号错误`);
  if (monster.main_type.localized?.zh !== entry.elements[0] || (entry.elements[1] ? monster.sub_type?.localized?.zh !== entry.elements[1] : monster.sub_type !== null)) verificationErrors.push(`${entry.name} 属性错误`);
  if (skills === sourceSkills || JSON.stringify(skills) !== JSON.stringify(sourceSkills)) verificationErrors.push(`${entry.name} 学习面未独立完整复制 ${entry.source}`);
  if (new Set(skills.map(skill => skill.name)).size !== skills.length) verificationErrors.push(`${entry.name} 学习面存在重复技能`);
  // 本任务按用户要求逐项复制指定高级形态的完整学习面；即使来源学习面存在历史字段漂移，初始形态也必须与该高级形态保持完全一致。
}
for (const [child, parent] of [['月使鸷纳', '月辉鸠'], ['焰米龙', '热团团'], ['圣凯布米龙', '焰米龙'], ['智辉章脑', '章脑丸'], ['玳塔', '斑鱼'], ['测风蝉', '量风碗'], ['黑手浣熊', '小浣蛋'], ['摇铃魔偶', '幽铃'], ['布灵布灵', '布灵']]) {
  if (byName.get(child).evolves_from_id !== byName.get(parent).id) verificationErrors.push(`${child} 未正确连接至 ${parent}`);
}
if (byName.get('测风蝉').trait.localized?.zh?.description !== WIND_TRAIT_DESC || byName.get('量风碗').trait.localized?.zh?.description !== WIND_TRAIT_DESC) verificationErrors.push('风速仪特性文案未同步');
for (const monster of monsters) {
  const seen = new Set();
  let cursor = monster;
  while (cursor && cursor.evolves_from_id != null) {
    if (seen.has(cursor.id)) { verificationErrors.push(`检测到进化循环：${monsterName(monster)}`); break; }
    seen.add(cursor.id);
    cursor = byId.get(cursor.evolves_from_id);
    if (!cursor) { verificationErrors.push(`${monsterName(monster)} 存在悬空 evolves_from_id`); break; }
  }
}
for (const old of before.monsters) {
  const current = byId.get(old.id);
  const name = monsterName(old);
  const allowed = new Set(['月使鸷纳', '圣凯布米龙', '智辉章脑', '玳塔', '测风蝉', '黑手浣熊', '摇铃魔偶', '布灵布灵']);
  if (JSON.stringify(current) !== JSON.stringify(old) && !allowed.has(name)) verificationErrors.push(`非白名单既有精灵被修改：${name}`);
}
for (const name of Object.keys(before.wiki)) {
  if (JSON.stringify(wiki[name]) !== JSON.stringify(before.wiki[name])) verificationErrors.push(`既有图鉴学习面被修改：${name}`);
}

if (verificationErrors.length) {
  console.error(`[FAIL] 内存验证失败（${verificationErrors.length} 项），未写入任何文件：`);
  verificationErrors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}
console.log(`[OK] 将新增 ${ENTRIES.length} 只初始/中间形态，并复制独立学习面。`);
for (const entry of ENTRIES) console.log(`  ${entry.name} ← ${entry.source}：${countBySource(wiki[entry.name].skills)}`);
console.log(`[OK] 将同步测风蝉与量风碗风速仪文案，并建立 9 条确认进化边。`);
if (!WRITE) {
  console.log('Dry run 完成；未写入文件。使用 --write 执行写入。');
  process.exit(0);
}
writeJSON('data/monsters.json', monsters);
writeJSON('data/wiki_monster_data.json', wiki);
console.log(`[OK] 已写入源数据。monsters SHA-256=${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'data/monsters.json'))).digest('hex')}`);
console.log(`[OK] 已写入源数据。wiki SHA-256=${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'data/wiki_monster_data.json'))).digest('hex')}`);
