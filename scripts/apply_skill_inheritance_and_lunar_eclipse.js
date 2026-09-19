/**
 * 应用全库学习面继承规则、新月鸷与月蚀传说专属。
 * 用法：node scripts/apply_skill_inheritance_and_lunar_eclipse.js [--write]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const WRITE = process.argv.includes('--write');
const CATEGORY_TO_TYPE = { 'Physical Attack': '物攻', 'Magic Attack': '魔攻', Status: '状态', Defense: '防御' };
const LUNAR_ECLIPSE_DESC = '造成物伤，若敌方生命低于50%，本次技能能耗-3。';

const { readWiki, writeWiki } = require('./lib/wiki-data.js');
function readJSON(file) { return path.basename(file) === 'wiki_monster_data.json' ? readWiki(ROOT) : JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); }
function writeJSON(file, value) { if (path.basename(file) === 'wiki_monster_data.json') return writeWiki(ROOT, value, { allowRemovedSkills: ['月蚀'] }); fs.writeFileSync(path.join(ROOT, file), JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function nameOf(monster) { return monster.localized?.zh?.name || ''; }
function displayName(monster) { return monster.form && monster.form !== 'default' && monster.form !== 'Original' ? `${nameOf(monster)}（${monster.form}）` : nameOf(monster); }
function wikiFor(monster, wiki) { return wiki[displayName(monster)] || null; }

const monsters = readJSON('data/monsters.json');
const moves = readJSON('data/moves.json');
const wiki = readJSON('data/wiki_monster_data.json');
const types = readJSON('data/types.json');
const before = { monsters: clone(monsters), moves: clone(moves), wiki: clone(wiki) };
const errors = [];
const byId = new Map();
const children = new Map();
const byName = new Map();
for (const monster of monsters) {
  if (byId.has(monster.id)) errors.push(`重复精灵 ID：${monster.id}`);
  byId.set(monster.id, monster);
  if (!byName.has(nameOf(monster)) || monster.form === 'default') byName.set(nameOf(monster), monster);
  if (monster.evolves_from_id != null) {
    const list = children.get(monster.evolves_from_id) || [];
    list.push(monster.id);
    children.set(monster.evolves_from_id, list);
  }
}
for (const monster of monsters) if (monster.evolves_from_id != null && !byId.has(monster.evolves_from_id)) errors.push(`${nameOf(monster)} 的上游不存在`);
const typeByZh = new Map(types.map(type => [type.localized?.zh, type]));
const moveByName = new Map();
for (const move of moves) {
  const name = move.localized?.zh?.name;
  if (!name || moveByName.has(name)) errors.push(`技能名称异常：${name || '(空)'}`);
  moveByName.set(name, move);
}

const moonbird = byName.get('新月鸷');
const moonpigeon = byName.get('月辉鸠');
const moonEnvoy = byName.get('月使鸷纳');
const illusion = typeByZh.get('幻');
if (!illusion) errors.push('找不到幻系类型');
if (moonbird) errors.push('新月鸷已存在，停止重复新增');
if (!moonpigeon || !moonEnvoy) errors.push('缺少月辉鸠或月使鸷纳');
if (monsters.some(monster => monster.dex_number === 446)) errors.push('图鉴号 446 已被占用');
if (!wiki['月使鸷纳']?.skills?.length) errors.push('月使鸷纳缺少可复制学习面');
const eclipse = moveByName.get('月蚀');
if (!eclipse || eclipse.id !== 5932 || eclipse.move_type?.localized?.zh !== '幻' || eclipse.move_category !== 'Physical Attack' || eclipse.energy_cost !== 5 || eclipse.power !== 130) errors.push('月蚀基础字段异常');
const wolf = wiki['银月狼王'];
if (!wolf?.skills) errors.push('银月狼王缺少图鉴学习面');
if ((wolf?.skills || []).filter(skill => skill.name === '月蚀').length !== 1) errors.push('银月狼王月蚀条目不唯一');
if (errors.length) {
  console.error(`[FAIL] 前置校验失败（${errors.length}项），未写入：`);
  errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

const newMoonId = Math.max(...monsters.map(monster => monster.id)) + 1;
const wing = typeByZh.get('翼');
const ice = typeByZh.get('冰');
const newMoon = {
  base_hp: 50, base_mag_atk: 60, base_mag_def: 68, base_phy_atk: 59, base_phy_def: 62, base_spd: 69,
  default_legacy_type: clone(wing), dex_number: 446, evolution_chain_name: '新月鸷', evolution_stage: '基础形态', evolves_from_id: null,
  form: 'default', form_category: '无多形态', id: newMoonId, image: '', is_leader_form: false, leader_potential: false,
  localized: { zh: { name: '新月鸷' } }, main_form_name: '', main_type: clone(wing), sub_type: clone(ice), preferred_attack_style: 'Magic',
  trait: { localized: { zh: { name: '冷光源', description: '若上回合双方有精灵使用翼系技能，本回合自己携带的冰系技能威力+100%' } } },
  learnset_mode: 'inherit', learnset_inherits_from_id: moonEnvoy.id
};
monsters.push(newMoon);
byId.set(newMoon.id, newMoon);
byName.set('新月鸷', newMoon);
wiki['新月鸷'] = { image: '', skills: clone(wiki['月使鸷纳'].skills) };
moonpigeon.evolves_from_id = newMoon.id;
moonpigeon.evolution_chain_name = '新月鸷';
moonpigeon.learnset_mode = 'inherit';
moonpigeon.learnset_inherits_from_id = moonEnvoy.id;
moonEnvoy.evolution_chain_name = '新月鸷';

// 月蚀是银月狼王唯一的传说专属技能。
eclipse.localized.zh.description = LUNAR_ECLIPSE_DESC;
for (const entry of Object.values(wiki)) {
  for (const skill of entry.skills || []) {
    if (skill.name !== '月蚀') continue;
    skill.element = '幻';
    skill.type = '物攻';
    skill.desc = LUNAR_ECLIPSE_DESC;
    skill.source = '传说';
  }
}

// 建立修改后的进化子图。
children.clear();
for (const monster of monsters) {
  if (monster.evolves_from_id == null) continue;
  const list = children.get(monster.evolves_from_id) || [];
  list.push(monster.id);
  children.set(monster.evolves_from_id, list);
}
function reachableHighForms(monster) {
  const result = [];
  const queue = [...(children.get(monster.id) || [])];
  const seen = new Set([monster.id]);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const child = byId.get(id);
    if (!child) continue;
    if (child.evolution_stage === '高级形态' && !child.is_leader_form) result.push(child);
    queue.push(...(children.get(id) || []));
  }
  return result;
}
function nearestHighParent(monster) {
  let current = monster;
  const seen = new Set([monster.id]);
  while (current?.evolves_from_id != null) {
    current = byId.get(current.evolves_from_id);
    if (!current || seen.has(current.id)) return null;
    seen.add(current.id);
    if (current.evolution_stage === '高级形态' && !current.is_leader_form) return current;
  }
  return null;
}
let inherited = 0;
let own = 0;
for (const monster of monsters) {
  // 新月鸷、月辉鸠已有显式指定，保持不覆盖。
  if (monster.learnset_mode === 'inherit' && monster.learnset_inherits_from_id != null) { inherited++; continue; }
  // 地区形态和非首领高级形态拥有独立技能组。
  if (!monster.is_leader_form && (monster.evolution_stage === '高级形态' || monster.form_category === '主形态' || monster.form_category === '变体形态')) {
    monster.learnset_mode = 'own';
    delete monster.learnset_inherits_from_id;
    own++;
    continue;
  }
  if (monster.is_leader_form || monster.evolution_stage === '首领形态') {
    const source = nearestHighParent(monster);
    if (source) {
      monster.learnset_mode = 'inherit';
      monster.learnset_inherits_from_id = source.id;
      inherited++;
    } else {
      monster.learnset_mode = 'own';
      delete monster.learnset_inherits_from_id;
      own++;
    }
    continue;
  }
  const candidates = reachableHighForms(monster);
  const source = candidates.length === 1 ? candidates[0] : candidates.find(candidate => candidate.form_category === '主形态');
  if (source) {
    monster.learnset_mode = 'inherit';
    monster.learnset_inherits_from_id = source.id;
    inherited++;
  } else {
    monster.learnset_mode = 'own';
    delete monster.learnset_inherits_from_id;
    own++;
  }
}

const verificationErrors = [];
const knownMoves = new Map(moves.map(move => [move.localized?.zh?.name, move]));
for (const monster of monsters) {
  if (monster.learnset_mode !== 'own' && monster.learnset_mode !== 'inherit') verificationErrors.push(`${nameOf(monster)} 缺少合法 learnset_mode`);
  if (monster.learnset_mode === 'inherit') {
    const source = byId.get(monster.learnset_inherits_from_id);
    if (!source || source.id === monster.id) verificationErrors.push(`${nameOf(monster)} 的继承来源无效`);
    const seen = new Set([monster.id]);
    let current = monster;
    while (current.learnset_mode === 'inherit') {
      current = byId.get(current.learnset_inherits_from_id);
      if (!current || seen.has(current.id)) { verificationErrors.push(`${nameOf(monster)} 的继承链循环或断裂`); break; }
      seen.add(current.id);
    }
  }
  const entry = wikiFor(monster, wiki);
  if (entry?.skills) {
    for (const skill of entry.skills) {
      if (!knownMoves.has(skill.name)) verificationErrors.push(`${displayName(monster)} 引用不存在技能：${skill.name}`);
    }
  }
}
if (wiki['新月鸷']?.skills === wiki['月使鸷纳']?.skills) verificationErrors.push('新月鸷学习面未深拷贝');
if (eclipse.localized.zh.description !== LUNAR_ECLIPSE_DESC) verificationErrors.push('月蚀描述未更新');
const eclipseLearners = [];
for (const [pet, entry] of Object.entries(wiki)) for (const skill of entry.skills || []) if (skill.name === '月蚀') eclipseLearners.push([pet, skill]);
if (eclipseLearners.length !== 1 || eclipseLearners[0][0] !== '银月狼王' || eclipseLearners[0][1].source !== '传说') verificationErrors.push('月蚀传说专属学习面异常');
if (verificationErrors.length) {
  console.error(`[FAIL] 内存验证失败（${verificationErrors.length}项），未写入：`);
  verificationErrors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}
console.log(`[OK] 学习面模式：inherit=${inherited}，own=${own}；新增新月鸷 id=${newMoonId}；月蚀已设为银月狼王传说专属。`);
if (!WRITE) { console.log('Dry run 完成；未写入。使用 --write 执行写入。'); process.exit(0); }
writeJSON('data/monsters.json', monsters);
writeJSON('data/moves.json', moves);
writeJSON('data/wiki_monster_data.json', wiki);
for (const file of ['monsters.json', 'moves.json', 'wiki_monster_data.json']) {
  const content = fs.readFileSync(path.join(ROOT, 'data', file));
  console.log(`[OK] ${file} SHA-256=${crypto.createHash('sha256').update(content).digest('hex')}`);
}
