/**
 * 审计学习面继承元数据与月蚀传说专属。
 * 用法：node scripts/audit_skill_sources.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const monsters = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/monsters.json'), 'utf8'));
const moves = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/moves.json'), 'utf8'));
const wiki = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/wiki_monster_data.json'), 'utf8'));
const byId = new Map(monsters.map(monster => [monster.id, monster]));
const errors = [];
let inheritCount = 0;
let ownCount = 0;

function nameOf(monster) {
  return monster.localized?.zh?.name || `#${monster.id}`;
}
function displayName(monster) {
  return monster.form && monster.form !== 'default' && monster.form !== 'Original' ? `${nameOf(monster)}（${monster.form}）` : nameOf(monster);
}

for (const monster of monsters) {
  if (!['own', 'inherit'].includes(monster.learnset_mode)) {
    errors.push(`${displayName(monster)} 缺少合法 learnset_mode`);
    continue;
  }
  if (monster.learnset_mode === 'own') {
    ownCount++;
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
  const exactWiki = wiki[displayName(current)];
  const sourceWiki = exactWiki || wiki[nameOf(current)];
  if (!sourceWiki?.skills?.length) errors.push(`${displayName(monster)} 的最终来源 ${displayName(current)} 缺少学习面`);
}

const newMoon = monsters.find(monster => nameOf(monster) === '新月鸷');
const pigeon = monsters.find(monster => nameOf(monster) === '月辉鸠');
const envoy = monsters.find(monster => nameOf(monster) === '月使鸷纳');
if (!newMoon || !pigeon || !envoy || newMoon.dex_number !== 446 || pigeon.evolves_from_id !== newMoon.id || envoy.evolves_from_id !== pigeon.id) {
  errors.push('新月鸷 → 月辉鸠 → 月使鸷纳 进化链错误');
}
if (newMoon?.learnset_inherits_from_id !== envoy?.id || pigeon?.learnset_inherits_from_id !== envoy?.id) {
  errors.push('新月鸷或月辉鸠未显式继承月使鸷纳学习面');
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
console.log(`[OK] 新月鸷链与月蚀传说专属均通过验证。`);
console.log(`monsters SHA-256=${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'data/monsters.json'))).digest('hex')}`);
