/**
 * 按 BWiki 资源文件名中的图鉴号批量导入444–464头像和立绘。
 * 443诅咒狼灵、465布灵布灵保留既有资源，不覆盖。
 * 用法：node scripts/import_bwiki_numbered_assets.js [--write]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, '..', 'old', 'bwiki');
const WRITE = process.argv.includes('--write');
const DEXES = Array.from({ length: 21 }, (_, index) => index + 444);
const PRESERVED = new Set([443, 465]);

const { readWiki, writeWiki } = require('./lib/wiki-data.js');
function readJSON(file) { return path.basename(file) === 'wiki_monster_data.json' ? readWiki(ROOT) : JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); }
function writeJSON(file, value) { if (path.basename(file) === 'wiki_monster_data.json') return writeWiki(ROOT, value); fs.writeFileSync(path.join(ROOT, file), JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function nameOf(monster) { return monster.localized?.zh?.name || ''; }
function displayName(monster) { return monster.form && monster.form !== 'default' && monster.form !== 'Original' ? `${nameOf(monster)}（${monster.form}）` : nameOf(monster); }

const mons = readJSON('data/monsters.json');
const wiki = readJSON('data/wiki_monster_data.json');
const beforeMons = clone(mons);
const beforeWiki = clone(wiki);
const errors = [];
const manifest = [];
for (const dex of DEXES) {
  const matches = mons.filter(monster => monster.dex_number === dex);
  if (matches.length !== 1) { errors.push(`图鉴号${dex} 映射精灵数为${matches.length}`); continue; }
  const monster = matches[0];
  const name = nameOf(monster);
  const key = displayName(monster);
  const avatar = path.join(SOURCE, '精灵头像', `精灵图鉴 - 洛克王国世界WIKI_BWIKI_哔哩哔哩-${String(dex).padStart(2, '0')}.png`);
  const art = path.join(SOURCE, '精灵立绘', `${dex}.png`);
  const avatarDest = path.join(ROOT, 'assets', 'monster', 'images', `${key}.png`);
  const artDest = path.join(ROOT, 'assets', 'monster', 'images', 'wiki', `${key}.png`);
  if (!fs.existsSync(avatar) || !fs.existsSync(art)) errors.push(`图鉴号${dex} 缺少头像或立绘源文件`);
  if (monster.image) errors.push(`${name} 已有头像字段：${monster.image}`);
  if (fs.existsSync(avatarDest) || fs.existsSync(artDest)) errors.push(`${name} 目标资源已存在`);
  if (wiki[key]?.image) errors.push(`${key} 已有Wiki立绘字段`);
  manifest.push({ dex, monster, name, key, avatar, art, avatarDest, artDest });
}
for (const dex of PRESERVED) {
  const monster = mons.find(item => item.dex_number === dex);
  if (!monster || !monster.image) errors.push(`保留图鉴号${dex} 缺少既有头像字段`);
  const key = monster && displayName(monster);
  if (!key || !wiki[key]?.image) errors.push(`保留图鉴号${dex} 缺少既有Wiki立绘字段`);
}
if (errors.length) {
  console.error(`[FAIL] 前置校验失败（${errors.length}项），未写入：`);
  errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

const python = `from pathlib import Path\nfrom PIL import Image\nitems = ${JSON.stringify(manifest.map(item => [item.avatar, item.art, item.avatarDest, item.artDest]), null, 2)}\nfor avatar, art, avatar_dest, art_dest in items:\n a=Image.open(avatar).convert('RGBA'); assert a.size==(128,128), (avatar,a.size); a.save(avatar_dest, 'PNG')\n b=Image.open(art).convert('RGBA'); assert b.size==(1024,1024), (art,b.size); b.resize((480,480),Image.Resampling.LANCZOS).save(art_dest, 'PNG')\n print(avatar_dest, art_dest)\n`;
if (!WRITE) {
  console.log(`[OK] 将导入${manifest.length}只精灵（图鉴号444–464）的头像和立绘，保留443/465。`);
  manifest.forEach(item => console.log(`  ${item.dex} ${item.key}`));
  console.log('Dry run 完成；未写入。使用 --write 执行写入。');
  process.exit(0);
}
const result = spawnSync('uv', ['run', '--with', 'pillow', 'python', '-c', python], { cwd: ROOT, encoding: 'utf8' });
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status || 1);
}
for (const item of manifest) {
  item.monster.image = `${item.key}.png`;
  if (!wiki[item.key]) wiki[item.key] = { image: '', skills: [] };
  wiki[item.key].image = `assets/monster/images/wiki/${item.key}.png`;
}
const verificationErrors = [];
for (const item of manifest) {
  if (!fs.existsSync(item.avatarDest) || !fs.existsSync(item.artDest)) verificationErrors.push(`${item.key} 资源未生成`);
  if (item.monster.image !== `${item.key}.png` || wiki[item.key]?.image !== `assets/monster/images/wiki/${item.key}.png`) verificationErrors.push(`${item.key} 图片字段错误`);
}
for (const dex of PRESERVED) {
  const before = beforeMons.find(item => item.dex_number === dex);
  const after = mons.find(item => item.dex_number === dex);
  const key = displayName(after);
  if (after.image !== before.image || wiki[key]?.image !== beforeWiki[key]?.image) verificationErrors.push(`保留图鉴号${dex} 被意外修改`);
}
for (const before of beforeMons) {
  const after = mons.find(item => item.id === before.id);
  if (!after) verificationErrors.push(`既有精灵丢失：${nameOf(before)}`);
  else if (!DEXES.includes(before.dex_number) && JSON.stringify(after) !== JSON.stringify(before)) verificationErrors.push(`非目标精灵被修改：${nameOf(before)}`);
}
if (verificationErrors.length) {
  console.error(`[FAIL] 内存验证失败（${verificationErrors.length}项），未写入JSON：`);
  verificationErrors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}
writeJSON('data/monsters.json', mons);
writeJSON('data/wiki_monster_data.json', wiki);
console.log(`[OK] 已导入${manifest.length}只精灵资源，保留443/465。`);
for (const file of ['monsters.json', 'wiki_monster_data.json']) console.log(`[OK] ${file} SHA-256=${crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'data', file))).digest('hex')}`);
