import { readWiki, writeWiki } from './lib/wiki-data.js';
const root = 'D:/echoagent/MeowNyx Wiki';
const moves = await Bun.file(`${root}/data/moves.json`).json();
const wiki = readWiki(root);
const skillName = '重组';
const description = '下一次攻击时，额外造成100%幻系伤害，应对防御：改为额外造成300%幻系伤害。';
const learners = ['粉耳星兔', '星云旅者', '银月狼王', '布灵布灵'];
const move = moves.find(item => item.localized?.zh?.name === skillName);
if (!move) throw new Error(`找不到技能：${skillName}`);
move.localized.zh.description = description;

for (const name of learners) {
  const entry = wiki[name];
  if (!entry) throw new Error(`图鉴中找不到精灵：${name}`);
  let skill = entry.skills.find(item => item.name === skillName);
  if (!skill) {
    skill = { name: skillName, element: '幻', type: '状态', source: '技能石', desc: description };
    entry.skills.push(skill);
  } else {
    skill.element = '幻';
    skill.type = '状态';
    skill.source = '技能石';
    skill.desc = description;
  }
}

for (const entry of Object.values(wiki)) {
  for (const skill of entry.skills || []) {
    if (skill.name === skillName) skill.desc = description;
  }
}

await Bun.write(`${root}/data/moves.json`, `${JSON.stringify(moves, null, 2)}\n`);
writeWiki(root, wiki, { allowRemovedSkills: [skillName] });
console.log(`已更新 ${skillName} 效果，并保留 ${learners.length} 只有效学习精灵。`);
