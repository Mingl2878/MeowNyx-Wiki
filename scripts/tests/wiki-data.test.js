'use strict';
// All data and automatic backups in these tests live under os.tmpdir().
// Run: node --test scripts/tests/wiki-data.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readWiki, readWikiIndex, writeWiki, getBackupDir } = require('../lib/wiki-data.js');

const canonical = '测试机Ⅱ';
const legacy = '测试机-II';
const monster = (id = 1, name = canonical, form = 'default') => ({ id, form, localized: { zh: { name } } });
const skill = (i, source = '默认') => ({ name: `技能${i}`, source, desc: `说明${i}` });
const skills52 = () => Array.from({ length: 52 }, (_, i) => skill(i));
const moves = () => Array.from({ length: 54 }, (_, i) => ({ id: i + 1, localized: { zh: { name: `技能${i}` } } }));
const duplicateWiki = () => ({ [legacy]: { image: 'old.png', skills: skills52() }, [canonical]: { image: 'new.png', skills: [skill(52)] } });

function fixture(t, wiki = duplicateWiki(), monsters = [monster()]) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'meownyx-wiki-data-'));
  const root = path.join(sandbox, 'MeowNyx Wiki');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const put = (filename, value) => fs.writeFileSync(path.join(data, filename), JSON.stringify(value, null, 2) + '\n');
  put('monsters.json', monsters);
  put('moves.json', moves());
  put('wiki_monster_data.json', wiki);
  return { root, data, put, backupDir: getBackupDir(root), file: path.join(data, 'wiki_monster_data.json') };
}

function assertNoWrite(f, action, error) {
  const before = fs.readFileSync(f.file);
  assert.throws(action, error);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
  assert.equal(fs.existsSync(f.backupDir), false);
  assert.deepEqual(fs.readdirSync(f.data).sort(), ['monsters.json', 'moves.json', 'wiki_monster_data.json']);
}

test('legacy 52 + canonical 1 merges on read; aliases resolve without shadowing', t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file);
  const index = readWikiIndex(f.root);
  assert.deepEqual(Object.keys(index.wiki), [canonical]);
  assert.equal(index.wiki[canonical].skills.length, 53);
  assert.equal(index.wiki[canonical].image, 'new.png');
  assert.equal(index.wiki[canonical].monster_id, 1);
  assert.deepEqual(index.wiki[canonical].aliases, [legacy]);
  assert.equal(index.getByName('测试机－ＩＩ'), index.getByMonster(monster()));
  assert.equal(index.getByName(legacy), index.wiki[canonical]);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
});

test('atomic save backs up exact prior bytes outside the project; repeated saves are idempotent', t => {
  const f = fixture(t);
  const original = fs.readFileSync(f.file);
  const result = writeWiki(f.root, readWiki(f.root));
  assert.equal(result.changed, true);
  assert.equal(path.dirname(result.backupPath), path.join(path.dirname(f.root), 'old', 'MeowNyx Wiki-backups', 'data-updates'));
  assert.equal(path.dirname(result.backupPath), f.backupDir);
  assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
  assert.deepEqual(fs.readFileSync(result.backupPath), original);
  assert.equal(readWiki(f.root)[canonical].skills.length, 53);
  const saved = fs.readFileSync(f.file);
  const again = writeWiki(f.root, readWiki(f.root));
  assert.equal(again.changed, false);
  assert.equal(again.backupPath, null);
  assert.deepEqual(fs.readFileSync(f.file), saved);
  assert.equal(fs.readdirSync(path.dirname(result.backupPath)).length, 1);
  assert.equal(fs.readdirSync(f.data).length, 3);
});

test('duplicate skill rows in a single entry remain intact; name+source remain distinct', t => {
  const rows = [skill(0), skill(0), skill(0, '技能石')];
  const f = fixture(t, { [legacy]: { skills: rows } });
  writeWiki(f.root, readWiki(f.root));
  assert.deepEqual(readWiki(f.root)[canonical].skills, rows);
});

test('alias merge de-duplicates only matching name+source and preserves other sources', t => {
  const f = fixture(t, { [legacy]: { skills: [skill(0)] }, [canonical]: { skills: [skill(0), skill(0, '血脉')] } });
  const wiki = readWiki(f.root);
  assert.equal(wiki[canonical].skills.length, 2);
  writeWiki(f.root, wiki);
  assert.equal(readWiki(f.root)[canonical].skills.length, 2);
});

test('proposed alias skill conflict stops before backup or write', t => {
  const f = fixture(t, { [canonical]: { skills: [skill(0)] } });
  const proposal = readWiki(f.root);
  proposal[legacy] = { skills: [{ ...skill(0), desc: '冲突' }] };
  assertNoWrite(f, () => writeWiki(f.root, proposal), /冲突/);
});

test('existing alias conflict cannot be bypassed by submitting only the canonical key', t => {
  const f = fixture(t, { [legacy]: { skills: [skill(0)] }, [canonical]: { skills: [{ ...skill(0), desc: '冲突' }] } });
  assert.throws(() => readWiki(f.root), /冲突/);
  assertNoWrite(f, () => writeWiki(f.root, { [canonical]: { skills: [skill(0)] } }), /冲突/);
});

test('conflicting alias identity IDs stop without a write', t => {
  const f = fixture(t, { [canonical]: { skills: [skill(0)] } }, [monster(), monster(2, '另一只')]);
  const proposal = readWiki(f.root);
  proposal['另一只'] = { monster_id: 2, aliases: [legacy], skills: [skill(1)] };
  assertNoWrite(f, () => writeWiki(f.root, proposal), /冲突/);
});

test('unknown skill references in recognized or legacy entries are rejected', t => {
  for (const name of [canonical, '未识别旧名']) {
    const f = fixture(t, { [canonical]: { skills: [skill(0)] } });
    const proposal = readWiki(f.root);
    proposal[name] = { skills: [{ name: '不存在的技能' }] };
    assertNoWrite(f, () => writeWiki(f.root, proposal), /不存在或无效技能/);
  }
});

test('empty, missing skills, and deleted entries cannot silently wipe a nonempty learnset', t => {
  for (const entry of [{ skills: [] }, {}, null]) {
    const f = fixture(t, { [canonical]: { skills: [skill(0)] } });
    const proposal = entry === null ? {} : { [canonical]: entry };
    assertNoWrite(f, () => writeWiki(f.root, proposal), /不可意外清空或删除/);
  }
});

test('explicit canonical allowEmpty permits intentional emptying and deletion', t => {
  for (const proposal of [{ [canonical]: { skills: [] } }, {}]) {
    const f = fixture(t, { [legacy]: { skills: [skill(0)] } });
    const result = writeWiki(f.root, proposal, { allowEmpty: [canonical] });
    assert.equal(result.changed, true);
    assert.equal(readWiki(f.root)[canonical]?.skills?.length || 0, 0);
    assert.ok(fs.existsSync(result.backupPath));
  }
});

test('partial intentional migration deletions are not silently re-added', t => {
  const f = fixture(t, { [canonical]: { skills: [skill(0), skill(1)] } });
  const proposal = readWiki(f.root);
  proposal[canonical].skills = [skill(1)];
  // Simulate an intentional wrong-master-skill deletion before wiki save.
  f.put('moves.json', moves().filter(move => move.localized.zh.name !== '技能0'));
  assertNoWrite(f, () => writeWiki(f.root, proposal), /既有技能将丢失/);
  writeWiki(f.root, proposal, { allowRemovedSkills: ['技能0'] });
  assert.deepEqual(readWiki(f.root)[canonical].skills, [skill(1)]);
});

test('a partial replacement cannot silently discard 52 old skills', t => {
  const f = fixture(t);
  assertNoWrite(f, () => writeWiki(f.root, { [canonical]: { skills: [skill(52)] } }), /既有技能将丢失/);
});

test('unapproved learning-source changes are also treated as removal', t => {
  const f = fixture(t, { [canonical]: { skills: [skill(0)] } });
  const proposal = { [canonical]: { skills: [skill(0, '血脉')] } };
  assertNoWrite(f, () => writeWiki(f.root, proposal), /既有技能将丢失/);
  writeWiki(f.root, proposal, { allowRemovedSkills: ['技能0'] });
  assert.equal(readWiki(f.root)[canonical].skills[0].source, '血脉');
});

test('malformed JSON in any dependency fails without changing existing wiki bytes', t => {
  for (const filename of ['wiki_monster_data.json', 'monsters.json', 'moves.json']) {
    const f = fixture(t);
    const proposal = readWiki(f.root);
    fs.writeFileSync(path.join(f.data, filename), '{invalid json');
    if (filename !== 'moves.json') assert.throws(() => readWiki(f.root), SyntaxError);
    assertNoWrite(f, () => writeWiki(f.root, proposal), SyntaxError);
  }
});

test('writes resolve against latest disk monsters and moves, including newly added monsters', t => {
  const f = fixture(t, { [canonical]: { skills: [skill(0)] } });
  const proposal = readWiki(f.root);
  const renamed = '改名测试机Ⅱ';
  f.put('monsters.json', [monster(1, renamed), monster(2, '新增机Ⅱ')]);
  // Persisted ID in the proposal keeps the entry attached after a display-name change.
  proposal['新增机-II'] = { skills: [skill(53)] };
  writeWiki(f.root, proposal);
  const saved = readWiki(f.root);
  assert.equal(saved[renamed].monster_id, 1);
  assert.equal(saved['新增机Ⅱ'].monster_id, 2);
  assert.equal(saved[canonical], undefined);
  f.put('moves.json', moves().filter(move => move.localized.zh.name !== '技能53'));
  const before = fs.readFileSync(f.file);
  assert.throws(() => writeWiki(f.root, saved), /不存在或无效技能/);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('unknown winter base-name keys are preserved and not attached to the winter form', t => {
  const winter = monster(1, '冰兔', '冬日');
  const legacyEntry = { image: 'legacy.png', skills: [skill(0), skill(0)] };
  const f = fixture(t, { '冰兔': legacyEntry, '冰兔（冬日）': { skills: [skill(1)] } }, [winter]);
  writeWiki(f.root, readWiki(f.root));
  const index = readWikiIndex(f.root);
  assert.deepEqual(index.wiki['冰兔'], legacyEntry);
  assert.deepEqual(index.getByMonster(winter).skills, [skill(1)]);
});

test('backup failure leaves original unchanged and cleans temporary file', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(path.dirname(f.root), 'old'), 'block external backup directory');
  const before = fs.readFileSync(f.file);
  assert.throws(() => writeWiki(f.root, readWiki(f.root)));
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.readdirSync(f.data).length, 3);
});

test('standalone repair defaults to dry run; --write only touches an isolated temp root', t => {
  const f = fixture(t);
  const script = path.resolve(__dirname, '../repair_monster_identity.js');
  const before = fs.readFileSync(f.file);
  const dry = spawnSync(process.execPath, [script, '--root', f.root], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\[ALIAS\]/);
  assert.match(dry.stdout, /Dry run/);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
  assert.equal(fs.existsSync(f.backupDir), false);
  const saved = spawnSync(process.execPath, [script, '--root', f.root, '--write'], { encoding: 'utf8' });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(readWiki(f.root)[canonical].skills.length, 53);
  assert.equal(fs.existsSync(f.backupDir), true);
  assert.equal(fs.existsSync(path.join(f.root, 'backups')), false);
});

test('dist/app backups use the source project external backup directory', () => {
  const project = path.resolve(__dirname, '../..');
  assert.equal(getBackupDir(path.join(project, 'dist', 'app')), getBackupDir(project));
  assert.equal(getBackupDir(project), path.join(path.dirname(project), 'old', `${path.basename(project)}-backups`, 'data-updates'));
});

test('backup resolver rejects a layout that would put old inside the project', t => {
  const f = fixture(t);
  assert.throws(() => getBackupDir(path.join(path.dirname(f.root), 'old')), /备份目录不得位于项目内部/);
});
