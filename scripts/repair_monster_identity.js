/**
 * Normalize wiki identities without deleting skills. Dry run by default.
 * node scripts/repair_monster_identity.js [--write] [--root <project directory>]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { displayName } = require('../js/monster-identity.js');
const { readWikiIndex, prepareWiki, writeWiki } = require('./lib/wiki-data.js');

function repair(root, { write = false, log = console.log } = {}) {
  const file = path.join(root, 'data', 'wiki_monster_data.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const index = readWikiIndex(root);
  // The dry run uses the exact same preflight as write, including move references.
  const prepared = prepareWiki(root, index.wiki);
  const aliases = [];
  let identified = 0;
  for (const [name, entry] of Object.entries(raw)) {
    const monster = index.getMonster(name);
    if (!monster) continue; // Unknown legacy base-name keys are deliberately left alone.
    const canonical = displayName(monster);
    if (name !== canonical) {
      aliases.push({ alias: name, canonical, monster_id: monster.id });
      log(`[ALIAS] ${name} → ${canonical} (#${monster.id})`);
    }
    if (entry.monster_id !== monster.id) identified++;
  }
  const changed = !Buffer.from(prepared.content).equals(prepared.previousBytes);
  log(`[OK] 别名键 ${aliases.length} 个；待补 ID ${identified} 个；规范条目 ${Object.keys(index.wiki).length} 个。`);
  if (!write) {
    log(changed ? 'Dry run 完成；未写入。使用 --write 保存规范数据（保留全部技能）。' : 'Dry run 完成；数据已规范，未写入。');
    return { changed, aliases };
  }
  const result = writeWiki(root, index.wiki);
  log(result.changed ? `[OK] 已保存；备份：${result.backupPath}` : '[OK] 数据已规范，无需写入。');
  return { ...result, aliases };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let root = path.join(__dirname, '..');
    let write = false;
    while (args.length) {
      const arg = args.shift();
      if (arg === '--write') write = true;
      else if (arg === '--root' && args[0] && !args[0].startsWith('--')) root = path.resolve(args.shift());
      else throw new Error(`未知或不完整参数：${arg}`);
    }
    repair(root, { write });
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { repair };
