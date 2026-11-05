/**
 * 审计学习面继承元数据与月蚀传说专属。
 * 用法：node scripts/audit_skill_sources.js
 */
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { monsters, moves, wiki: rawWiki } = require('./lib/catalog-data.js').readLegacy(ROOT);
const { createIndex } = require('../js/monster-identity.js');
const wikiIndex = createIndex(monsters, rawWiki);
const wiki = wikiIndex.wiki;
const byId = new Map(monsters.map(monster => [monster.id, monster]));
const moveNames = new Set(moves.map(move => move.localized?.zh?.name));
const errors = [];
let inheritCount = 0;
let ownCount = 0;

function nameOf(monster) {
  return monster.localized?.zh?.name || `#${monster.id}`;
}
function displayName(monster) {
  return monster.form && monster.form !== 'default' && monster.form !== 'Original' ? `${nameOf(monster)}（${monster.form}）` : nameOf(monster);
}

function checkLearnset(monster, owner) {
  // Keep the same exact-ID-first / legacy winter base-name fallback as RKData.
  const entry = wikiIndex.getByMonster(owner) || wikiIndex.getByName(nameOf(owner));
  if (!entry?.skills?.length) {
    // Explicit user-requested level-test placeholder, not a general exemption for
    // accidentally emptied existing species. No invented or inherited moves.
    if (monster.id === 619 && owner.id === 619 && nameOf(monster) === '冥古龙'
      && monster.data_status === 'placeholder' && entry?.monster_id === 619
      && Array.isArray(entry.skills) && entry.skills.length === 0) return;
    errors.push(`${displayName(monster)} 的学习面来源 ${displayName(owner)} 缺少学习面`);
    return;
  }
  for (const skill of entry.skills) {
    if (!skill || typeof skill.name !== 'string' || !moveNames.has(skill.name)) {
      errors.push(`${displayName(monster)} 的学习面引用不存在或无效技能：${skill?.name}`);
    }
  }
}

for (const monster of monsters) {
  if (!['own', 'inherit'].includes(monster.learnset_mode)) {
    errors.push(`${displayName(monster)} 缺少合法 learnset_mode`);
    continue;
  }
  if (monster.learnset_mode === 'own') {
    ownCount++;
    checkLearnset(monster, monster);
    continue;
  }
  inheritCount++;
  const seen = new Set([monster.id]);
  let current = monster;
  while (current.learnset_mode === 'inherit') {
    const source = byId.get(current.learnset_inherits_from_id);
    if (!source) {
      errors.push(`${displayName(monster)} 的来源 ID ${current.learnset_inherits_from_id} 不存在`);
      break;
    }
    if (seen.has(source.id)) {
      errors.push(`${displayName(monster)} 的继承链循环`);
      break;
    }
    seen.add(source.id);
    current = source;
  }
  if (current.learnset_mode !== 'own') errors.push(`${displayName(monster)} 的继承链未终止于 own 学习面`);
  else checkLearnset(monster, current);
}

const newMoon = byId.get(615);
const pigeon = byId.get(606);
const envoy = byId.get(604);
for (const [pet, currentName, oldName] of [[newMoon, '新月鹭', '新月鸷'], [pigeon, '月辉鹭', '月辉鸠'], [envoy, '月使鹭纳', '月使鸷纳']]) {
  if (!pet || nameOf(pet) !== currentName || wikiIndex.getByName(oldName)?.monster_id !== pet.id) errors.push(`${currentName}正式名或旧名别名绑定丢失`);
}
if (!newMoon || !pigeon || !envoy || newMoon.dex_number !== 446 || pigeon.evolves_from_id !== newMoon.id || envoy.evolves_from_id !== pigeon.id) {
  errors.push('新月鹭 → 月辉鹭 → 月使鹭纳 进化链错误');
}
if (newMoon?.learnset_inherits_from_id !== envoy?.id || pigeon?.learnset_inherits_from_id !== envoy?.id) {
  errors.push('新月鹭或月辉鹭未显式继承月使鹭纳学习面');
}

const eclipse = moves.filter(move => move.localized?.zh?.name === '月蚀');
if (eclipse.length !== 1 || eclipse[0].localized.zh.description !== '造成物伤，若敌方生命低于50%，本次技能能耗-3。') {
  errors.push('月蚀主技能效果错误');
}
const learners = [];
for (const [pet, entry] of Object.entries(wiki)) {
  for (const skill of entry.skills || []) if (skill.name === '月蚀') learners.push([pet, skill]);
}
if (learners.length !== 1 || learners[0][0] !== '银月狼王' || learners[0][1].source !== '传说') {
  errors.push('月蚀未成为银月狼王唯一传说专属技能');
}

if (errors.length) {
  console.error(`[FAIL] 学习面审计失败（${errors.length}项）`);
  errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}
console.log(`[OK] 学习面审计通过：inherit=${inheritCount}，own=${ownCount}。`);
console.log(`[OK] 新月鹭链、历史别名与月蚀传说专属均通过验证。`);
console.log(`monsters projection SHA-256=${crypto.createHash('sha256').update(JSON.stringify(monsters)).digest('hex')}`);
