const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Identity = require('../js/monster-identity');
const ROOT = path.resolve(__dirname, '..');
const monster = (id, name, form = 'default') => ({ id, localized: { zh: { name } }, form });
const skill = (name, source = '默认') => ({ name, source, type: '物攻', element: '机械', desc: name });
const entry = (...skills) => ({ image: '', skills });

for (const variants of [
  ['权杖-Ⅱ', '权杖_Ⅱ', '权杖-II', '权杖II', ' 权杖－ＩＩ ', '权杖—ⅱ', '权杖\u200b_ii'],
  ['权杖-V', '权杖_Ⅴ', '权杖V', '权杖－ｖ'],
  ['圣剑-X', '圣剑_Ⅹ', '圣剑X', '圣剑 − x']
]) {
  test(`equivalent names: ${variants[0]}`, () => {
    for (const value of variants) assert.equal(Identity.normalizeName(value), Identity.normalizeName(variants[0]));
  });
}

test('alias merge preserves old skills, new skills, sources, and the image', () => {
  const monsters = [monster(434, '圣剑-X')];
  const raw = { '圣剑_X': { image: 'legacy.png', skills: [skill('械斗'), skill('防御')] }, '圣剑-X': entry(skill('拖拉机'), skill('械斗'), skill('械斗', '技能石')) };
  const before = JSON.stringify(raw);
  const index = Identity.createIndex(monsters, raw);
  assert.deepEqual(index.wiki['圣剑-X'].skills.map(s => [s.name, s.source]), [['械斗', '默认'], ['防御', '默认'], ['拖拉机', '默认'], ['械斗', '技能石']]);
  assert.equal(index.wiki['圣剑-X'].monster_id, 434);
  assert.equal(index.wiki['圣剑-X'].image, 'legacy.png');
  assert.equal(index.getByName('圣剑_Ⅹ'), index.getByMonster(monsters[0]));
  assert.deepEqual(Object.keys(index.wiki), ['圣剑-X']);
  assert.equal(JSON.stringify(raw), before, 'inputs must not be mutated');
  assert.deepEqual(Identity.createIndex(monsters, index.wiki).wiki, index.wiki, 'migration must be idempotent');
});

test('stable ID survives renamed display name and retains historical alias', () => {
  const index = Identity.createIndex([monster(434, '新显示名')], { '圣剑-X': { ...entry(skill('械斗')), monster_id: 434 } });
  assert.equal(index.getByName('圣剑-X'), index.getByName('新显示名'));
  assert.deepEqual(Object.keys(index.wiki), ['新显示名']);
  assert.equal(Identity.createIndex([monster(434, '新显示名')], index.wiki).getByName('圣剑-X').skills.length, 1);
});

test('independent forms never collapse', () => {
  const monsters = [monster(1, '形态精灵', '夏天'), monster(2, '形态精灵', '冬天')];
  const index = Identity.createIndex(monsters, { '形态精灵（夏天）': entry(skill('夏')), '形态精灵（冬天）': entry(skill('冬')) });
  assert.equal(index.getByMonster(monsters[0]).skills[0].name, '夏');
  assert.equal(index.getByMonster(monsters[1]).skills[0].name, '冬');
  assert.equal(index.getByName('形态精灵'), null);
  assert.equal(Identity.displayName(monster(3, '原始', 'Original')), '原始');
});

test('name collisions and ID/name conflicts fail rather than guess', () => {
  assert.throws(() => Identity.createIndex([monster(1, '权杖-II'), monster(2, '权杖_Ⅱ')], {}), /冲突/);
  assert.throws(() => Identity.createIndex([monster(1, '甲'), monster(2, '乙')], { '乙': { ...entry(), monster_id: 1 } }), /冲突/);
  assert.throws(() => Identity.createIndex([monster(1, '甲')], { '甲': { ...entry(), monster_id: 2 } }), /不存在/);
});

test('conflicting alias skills fail; object property order is irrelevant', () => {
  const m = [monster(1, '圣剑-X')];
  const s = skill('械斗');
  assert.throws(() => Identity.createIndex(m, { '圣剑_X': entry(s), '圣剑-X': entry({ ...s, desc: '不同效果' }) }), /冲突/);
  const reverse = Object.fromEntries(Object.entries(s).reverse());
  assert.equal(Identity.createIndex(m, { '圣剑_X': entry(s), '圣剑-X': entry(reverse) }).wiki['圣剑-X'].skills.length, 1);
});

test('do not rewrite unrelated legacy skill rows', () => {
  const raw = { '普通精灵': entry(skill('重名'), skill('重名')), '冬季历史基础名': entry(skill('冬')) };
  const index = Identity.createIndex([monster(1, '普通精灵')], raw);
  assert.deepEqual(index.wiki['普通精灵'].skills, raw['普通精灵'].skills);
  assert.deepEqual(index.wiki['冬季历史基础名'], raw['冬季历史基础名']);
});

async function loadRuntime(root = ROOT, overrides = {}) {
  const context = {
    console: { log() {}, error() {} },
    fetch: async file => ({ ok: true, json: async () => file in overrides ? overrides[file] : JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) })
  };
  vm.createContext(context);
  for (const file of ['js/battle-math.js', 'js/monster-identity.js', 'js/data.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  const api = vm.runInContext('RKData', context);
  await api.init();
  return api;
}

test('real data and actual browser data layer restore all three learnsets', async () => {
  const api = await loadRuntime();
  for (const [id, expected] of [[248, 51], [249, 51], [434, 53]]) {
    const m = api.getMonsterById(id);
    // Reviewed recovery baseline: future updates may add skills; removals need review.
    assert.ok(api.getExactWikiData(m).skills.length >= expected, Identity.displayName(m));
    assert.ok(api.getResolvedWikiData(id).skills.length >= expected, Identity.displayName(m));
  }
  assert.ok(api.getResolvedWikiData(434).skills.some(s => s.name === '拖拉机'));
  const moveNames = new Set(api.getMoves().map(m => api.getMoveName(m)));
  for (const m of api.getMonsters().filter(m => !m.hidden)) {
    const wiki = api.getResolvedWikiData(m);
    assert.ok(wiki?.skills?.length, `${Identity.displayName(m)} lacks skills`);
    for (const s of wiki.skills) assert.ok(moveNames.has(s.name), `${Identity.displayName(m)}: unknown ${s.name}`);
  }
});

test('explicit own is respected; explicit inheritance still resolves by ID', async () => {
  const monsters = [
    { ...monster(1, '幼体'), evolution_stage: '基础形态', learnset_mode: 'own' },
    { ...monster(2, '成体'), evolution_stage: '高级形态', evolves_from_id: 1, learnset_mode: 'own' },
    { ...monster(3, '首领'), is_leader_form: true, evolves_from_id: 2, learnset_mode: 'inherit', learnset_inherits_from_id: 2 }
  ];
  const api = await loadRuntime(ROOT, { 'data/monsters.json': monsters, 'data/wiki_monster_data.json': { '幼体': entry(skill('幼体技能')), '成体': entry(skill('成体技能')) } });
  assert.equal(api.getResolvedWikiData(1).skills[0].name, '幼体技能');
  assert.equal(api.getResolvedWikiData(3).skills[0].name, '成体技能');
});

test('bad wiki data fails initialization instead of silently becoming empty', async () => {
  await assert.rejects(loadRuntime(ROOT, { 'data/wiki_monster_data.json': null }), /图鉴数据必须是对象/);
});
