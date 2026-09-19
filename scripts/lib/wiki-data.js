'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createIndex } = require('../../js/monster-identity.js');

// root is the project directory; tests pass isolated temporary roots.
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readMonsters(file) {
  const monsters = readJSON(path.join(path.dirname(file), 'monsters.json'));
  if (!Array.isArray(monsters)) throw new Error('monsters.json 必须是数组');
  return monsters;
}

function readWikiIndex(root) {
  const file = path.resolve(root, 'data', 'wiki_monster_data.json');
  return createIndex(readMonsters(file), readJSON(file));
}

function readWiki(root) {
  return readWikiIndex(root).wiki;
}

function validateSkills(wiki, moves) {
  if (!Array.isArray(moves)) throw new Error('moves.json 必须是数组');
  const names = new Set(moves.map(move => move?.localized?.zh?.name).filter(Boolean));
  for (const [name, entry] of Object.entries(wiki)) {
    if (entry.skills != null && !Array.isArray(entry.skills)) throw new Error(`${name} 的 skills 必须是数组`);
    for (const skill of entry.skills || []) {
      if (!skill || typeof skill.name !== 'string' || !names.has(skill.name)) {
        throw new Error(`${name} 引用不存在或无效技能：${skill?.name}`);
      }
    }
  }
}

// Re-read dependencies on every save: callers may have just added/renamed monsters
// or migrated moves. Validate the proposal, not the old skills against new moves.
// Destructive changes must be explicit: allowEmpty names whole monsters;
// allowRemovedSkills names reviewed skill removals/renames/source migrations.
function prepareWiki(root, value, { allowEmpty = [], allowRemovedSkills = [] } = {}) {
  const file = path.resolve(root, 'data', 'wiki_monster_data.json');
  if (!Array.isArray(allowEmpty) || allowEmpty.some(name => typeof name !== 'string')) {
    throw new Error('allowEmpty 必须是明确允许清空的规范名称数组');
  }
  if (!Array.isArray(allowRemovedSkills) || allowRemovedSkills.some(name => typeof name !== 'string')) {
    throw new Error('allowRemovedSkills 必须是明确允许移除或迁移的技能名称数组');
  }
  const previousBytes = fs.readFileSync(file);
  const monsters = readMonsters(file);
  const previous = createIndex(monsters, JSON.parse(previousBytes.toString('utf8')));
  const index = createIndex(monsters, value);
  validateSkills(index.wiki, readJSON(path.join(path.dirname(file), 'moves.json')));
  const allowed = new Set(allowEmpty);
  const allowedSkills = new Set(allowRemovedSkills);
  const skillKey = skill => JSON.stringify([skill.name, skill.source || '默认']);
  for (const [name, entry] of Object.entries(previous.wiki)) {
    if (!entry.skills?.length) continue;
    const next = entry.monster_id != null
      ? index.getByMonster({ id: entry.monster_id })
      : index.getByName(name);
    if (!next?.skills?.length && !allowed.has(name)) {
      throw new Error(`${name} 的非空学习面不可意外清空或删除；有意清空请显式传入 allowEmpty`);
    }
    const nextKeys = new Set((next?.skills || []).map(skillKey));
    const removed = entry.skills.filter(skill => !nextKeys.has(skillKey(skill)) && !allowedSkills.has(skill.name));
    if (removed.length && !allowed.has(name)) {
      throw new Error(`${name} 的既有技能将丢失：${removed.map(skill => `${skill.name}（${skill.source || '默认'}）`).join('、')}；有意迁移请显式传入 allowRemovedSkills`);
    }
  }
  return { wiki: index.wiki, previousBytes, content: JSON.stringify(index.wiki, null, 2) + '\n' };
}

// Keep backups outside the project, beside it under old/<project>-backups.
// For this workspace: D:/echoagent/old/MeowNyx Wiki-backups/data-updates.
function getBackupDir(root) {
  const requestedRoot = path.resolve(root);
  const sourceRoot = path.resolve(__dirname, '../..');
  const sourceRelative = path.relative(sourceRoot, requestedRoot);
  // --root dist/app still belongs to this project, not a new backup location.
  const belongsToSource = !sourceRelative || (!path.isAbsolute(sourceRelative) && sourceRelative !== '..' && !sourceRelative.startsWith(`..${path.sep}`));
  const project = belongsToSource ? sourceRoot : requestedRoot;
  const directory = path.join(path.dirname(project), 'old', `${path.basename(project)}-backups`, 'data-updates');
  const relative = path.relative(project, directory);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('备份目录不得位于项目内部，请调整项目与 old 目录的位置');
  }
  return directory;
}

function writeWiki(root, value, options = {}) {
  const file = path.resolve(root, 'data', 'wiki_monster_data.json');
  const prepared = prepareWiki(root, value, options);
  const content = Buffer.from(prepared.content, 'utf8');
  if (content.equals(prepared.previousBytes)) return { wiki: prepared.wiki, changed: false, backupPath: null };

  // Individual-file atomic replacement, not a transaction across moves/monsters/wiki.
  // Never unlink the original as a rename fallback (including on Windows).
  const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${suffix}.tmp`);
  const backupDir = getBackupDir(root);
  const backupPath = path.join(backupDir, `${path.basename(file)}.${suffix}.bak`);
  let fd;
  let tempCreated = false;
  try {
    fd = fs.openSync(temp, 'wx', fs.statSync(file).mode);
    tempCreated = true;
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (!fs.readFileSync(file).equals(prepared.previousBytes)) throw new Error('图鉴文件在保存前已变化，停止覆盖');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(backupPath, prepared.previousBytes, { flag: 'wx' });
    fs.renameSync(temp, file);
    tempCreated = false;
    return { wiki: prepared.wiki, changed: true, backupPath };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (tempCreated) fs.unlinkSync(temp);
  }
}

module.exports = { readWiki, readWikiIndex, writeWiki, prepareWiki, validateSkills, getBackupDir };
