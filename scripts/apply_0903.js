/**
 * apply_0903.js — 应用 0903 版本更新（精灵种族值/特性/技能/学习面）
 * 用法: node scripts/apply_0903.js
 * 规则: 所有修改先校验旧值，任何不匹配则报错退出、不写入（防改错）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let errors = [];

function readJSON(p) { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); }
function writeJSON(p, data) { fs.writeFileSync(path.join(ROOT, p), JSON.stringify(data, null, 2) + '\n', 'utf8'); }

/* ============ 1. monsters.json 种族值调整 ============ */
const FIELD = { '生命': 'base_hp', '物攻': 'base_phy_atk', '魔攻': 'base_mag_atk', '物防': 'base_phy_def', '魔防': 'base_mag_def', '速度': 'base_spd' };

const STAT_CHANGES = [
  { name: '加油蟹', form: 'Original', changes: { '物攻': [108, 92], '魔攻': [108, 92], '速度': [95, 100] } },
  { name: '加油蟹', form: '单只海葵的样子', changes: { '物攻': [155, 130], '魔攻': [61, 58] } },
  { name: '烈火守护', changes: { '物攻': [117, 79], '魔攻': [49, 13], '物防': [135, 110] } },
  { name: '火羽', changes: { '生命': [94, 78], '物攻': [82, 65], '魔攻': [100, 81], '物防': [72, 61], '魔防': [121, 106] } },
  { name: '卡拉波斯', changes: { '生命': [103, 117], '物攻': [107, 81], '魔攻': [34, 23], '物防': [65, 82], '魔防': [51, 68], '速度': [100, 85] } },
  { name: '声波缇塔', changes: { '物防': [122, 113], '魔防': [92, 85], '速度': [90, 105] } },
  { name: '游蛇魔使', changes: { '生命': [105, 83], '物攻': [110, 112], '速度': [105, 130] } },
  { name: '夜游魔', changes: { '生命': [126, 132], '物攻': [99, 103], '魔攻': [98, 101], '物防': [97, 100], '魔防': [123, 127] } },
  { name: '布克棱岩', changes: { '生命': [120, 130], '物攻': [135, 144], '魔攻': [49, 54], '物防': [159, 168], '魔防': [150, 159] } },
  { name: '迷嶂布莱克', changes: { '生命': [125, 136], '物攻': [139, 148], '魔攻': [52, 57], '物防': [164, 173], '魔防': [154, 163] } },
  { name: '深渊蛙', changes: { '物攻': [130, 143], '魔攻': [51, 60], '物防': [106, 116], '魔防': [78, 87] } },
  { name: '红绒十字', changes: { '生命': [112, 137], '物攻': [47, 42], '魔攻': [122, 108] } },
  { name: '半朽蜜果灵', changes: { '生命': [115, 128], '物攻': [43, 54], '魔攻': [120, 138] } },
  { name: '稻草守护者', changes: { '生命': [116, 128], '物攻': [88, 96], '魔攻': [88, 96], '物防': [112, 121], '魔防': [112, 121] } },
  { name: '克莱因龙', changes: { '生命': [90, 100], '物攻': [45, 50], '魔攻': [122, 131] } },
  { name: '怒目怂猫', changes: { '物攻': [132, 136], '魔攻': [126, 130] } },
  { name: '烟花伯爵', changes: { '生命': [76, 95], '物攻': [44, 55], '魔攻': [111, 129], '物防': [62, 73], '魔防': [97, 111] } },
  { name: '铠甲虫', changes: { '生命': [122, 132], '物攻': [88, 95], '魔攻': [39, 43], '物防': [121, 128], '魔防': [77, 82] } },
  { name: '花衣蝶', changes: { '生命': [122, 132], '物攻': [67, 72], '魔攻': [72, 77], '物防': [84, 89], '魔防': [94, 100] } },
  { name: '炽心勇狮', changes: { '物攻': [51, 62], '魔攻': [111, 126] } },
  { name: '饮雪狂兽', changes: { '物攻': [85, 110], '魔攻': [24, 40] } },
  { name: '徘徊爪爪', changes: { '物攻': [78, 100], '魔攻': [14, 27] } },
  { name: '音速犬', changes: { '物攻': [128, 116], '魔攻': [46, 38] } },
  { name: '风暴战犬', changes: { '物攻': [128, 116], '魔攻': [46, 38] } },
  { name: '春花兔', changes: { '生命': [79, 102], '物攻': [85, 73], '魔攻': [95, 74] } },
  { name: '星光狮', form: '月光能量的样子', changes: { '物攻': [95, 107], '魔攻': [107, 95] } },
  { name: '爵士鹿', changes: { '物防': [108, 120], '魔防': [79, 97] } },
  { name: '波普鹿', changes: { '物攻': [79, 81], '物防': [108, 125], '魔防': [79, 101], '速度': [120, 125] } },
  { name: '巨鼓象', changes: { '物防': [173, 153], '魔防': [80, 56] } },
];

/* ============ 2. 特性调整 ============ */
// 2a. 描述文本全局替换（不影响效果，所有持有者）
const TRAIT_TEXT_REPLACE = [
  { trait: '地脉馈赠', from: '每放1次地系技能', to: '每使用1次地系技能' },
  { trait: '鼓气', from: '获得攻防+20%', to: '获得双攻和双防+20%' },
  { trait: '三鼓作气', from: '获得攻防永久+20%', to: '获得双攻和双防永久+20%' },
  { trait: '展翅', from: '若后于对手行动', to: '若后于敌方行动' },
  { trait: '大雪球', from: '对手获得4层冻结', to: '敌方获得4层冻结' },
  { trait: '上锁', from: '对手本回合使用的技能', to: '敌方本回合使用的技能' },
];
// 2b. 效果变更（整段替换）
const TRAIT_SET = [
  { monster: '怒目怂猫', trait: '威慑', desc: '打断敌方技能时，获得双攻+30%，被打断的技能进入2回合冷却。' },
  { monster: '蹦蹦果', trait: '高浓生物碱', desc: '使用草系技能时，敌方获得3层中毒。' },
];

/* ============ 3. moves.json 技能调整 ============ */
const MOVE_EDITS = [
  { name: '超声波', descFrom: '自己获得全技能威力+30，选择：本次能耗-1或应对防御时改为全技能威力永久+50。',
    descTo: '自己获得全技能威力+20，选择：本次能耗-1或应对防御时改为全技能威力永久+20。' },
  { name: '远程访问', cost: [2, 1] },
  { name: '暗箱操作', descFrom: '自己获得双攻和双防-100%，应对防御：改为敌方获得双攻和双防-100%。',
    descTo: '自己获得双攻和双防-50%，应对防御：改为敌方获得双攻和双防-120%。' },
  { name: '撕咬', power: [30, 20] },
  { name: '趁火打劫', power: [35, 40] },
  { name: '流星火雨', power: [75, 85], descFrom: '威力永久+75', descTo: '威力永久+85' },
  { name: '蓄能轰击', power: [130, 120], descFrom: '每使用1次普通系技能', descTo: '每使用1次其他普通系技能' },
  { name: '四维降解', power: [100, 110] },
  { name: '草虫冲击', power: [80, 75], descFrom: '本次威力+50且无视敌方系别抵抗', descTo: '本次威力+90且无视敌方系别抵抗' },
  { name: '赤子之心', descFrom: '全技能能耗永久-3', descTo: '全技能能耗永久-2' },
  { name: '雪原狩猎', power: [80, 85], descFrom: '本次技能威力+50%', descTo: '本次技能威力+50' },
  { name: '轴承支撑', cost: [3, 6], descFrom: '主动：本技能被动额外-1能耗', descTo: '主动：本技能被动永久额外-1能耗' },
  { name: '孢子爆散', combo: [null, 2], descFrom: '造成物伤，1连击', descTo: '造成物伤，2连击' },
  { name: '超导', power: [95, 90], descFrom: '迸发：本技能能耗-1', descTo: '迸发：本技能能耗-2' },
  { name: '截拳', descFrom: '应对状态：额外造成打断，回复该技能能耗的能量', descTo: '应对状态：造成打断，回复被打断技能能耗的能量' },
  { name: '毒雾', descFrom: '将敌方所有增益，转化成中毒', descTo: '将敌方所有增益，转化为相同层数的中毒' },
  { name: '撒娇', descFrom: '自己获得萌化：威力永久+10', descTo: '自己获得萌化：全技能威力永久+10' },
  { name: '吨位压制', descFrom: '敌方体重越低，威力越高', descTo: '敌方体重越低，本次技能威力越高' },
  { name: '星痕', descFrom: '若对手有印记', descTo: '若敌方有印记' },
  { name: '薄纱环', descFrom: '选择：对手随机获得1种负面印记或自己随机获得1种正面印记', descTo: '选择：敌方随机获得1种负面印记或自己随机获得1种正面印记' },
];

/* ============ 4. wiki_monster_data.json 新增学习面 ============ */
/* 来源规则: 更新说明中标注"(XX级时习得)"的 → '默认'(基础学习面)，其余 → '技能石' */
const CATEGORY_TO_TYPE = { 'Physical Attack': '物攻', 'Magic Attack': '魔攻', 'Status': '状态', 'Defense': '防御' };
const LEARNSET_ADD = [
  ['加固', ['鸭吉吉（蓬松的样子）', '鸭吉吉（急急急鸭）', '鸭吉吉（燃了鸭）'], '技能石'],
  ['热身运动', ['鸭吉吉（紧实的样子）', '鸭吉吉（等一等鸭）', '鸭吉吉（起来鸭）'], '技能石'],
  ['血气', ['卡拉波斯'], '技能石'],
  ['地刺', ['蝎子王'], '技能石'],
  ['嘲弄', ['梦悠悠（穿旧睡衣的样子）', '梦悠悠（穿星星睡衣的样子）'], '技能石'],
  ['洗礼', ['深蓝鲸'], '技能石'],
  ['蒸汽进行曲', ['声波缇塔'], '技能石'],
  ['入梦', ['半朽蜜果灵'], '技能石'],
  ['追打', ['梦想三三'], '技能石'],
  ['叠势', ['绅士鸡'], '技能石'],
  ['回旋踢', ['针叶巡林'], '默认'],
  ['芳香诱引', ['怒目怂猫'], '技能石'],
  ['超导加速', ['星云旅者'], '技能石'],
  ['试飞', ['夜游魔'], '技能石'],
  ['加油', ['珀尔鼬'], '技能石'],
  ['轮班', ['立方人'], '技能石'],
  ['吹散', ['格兰球'], '技能石'],
  ['撒花', ['蒲公英娃娃'], '技能石'],
  ['后发制人', ['森巨人'], '技能石'],
  ['守护咒', ['克莱因龙'], '技能石'],
  ['俯冲猛击', ['圣羽翼王'], '技能石'],
  ['捧杀', ['红绒十字'], '技能石'],
  ['毒液渗透', ['古啦多'], '默认'],
  ['惊雷', ['荆棘电环'], '技能石'],
  ['电弧', ['星光狮（月光能量的样子）'], '技能石'],
  ['掩护', ['风滚暮虫（枯叶的样子）', '风滚暮虫（金黄的样子）'], '技能石'],
];

/* ==================== 执行 ==================== */
const monsters = readJSON('data/monsters.json');
const moves = readJSON('data/moves.json');
const wiki = readJSON('data/wiki_monster_data.json');
const monsterName = m => m.localized?.zh?.name || '';

console.log('==== 种族值调整 ====');
STAT_CHANGES.forEach(sc => {
  let targets = monsters.filter(m => monsterName(m) === sc.name);
  if (sc.form) targets = targets.filter(m => m.form === sc.form);
  if (targets.length === 0) { errors.push('种族值: 找不到精灵 ' + sc.name + (sc.form ? '(' + sc.form + ')' : '')); return; }
  targets.forEach(m => {
    Object.entries(sc.changes).forEach(([zh, pair]) => {
      const f = FIELD[zh];
      if (m[f] !== pair[0]) { errors.push('种族值: ' + monsterName(m) + '(id=' + m.id + ') ' + zh + ' 期望旧值' + pair[0] + '，实际' + m[f]); return; }
      m[f] = pair[1];
      console.log('  ' + monsterName(m) + '(id=' + m.id + ') ' + zh + ': ' + pair[0] + ' -> ' + pair[1]);
    });
  });
});

console.log('==== 特性调整 ====');
TRAIT_TEXT_REPLACE.forEach(t => {
  let count = 0;
  monsters.forEach(m => {
    const tr = m.trait && m.trait.localized && m.trait.localized.zh;
    if (tr && tr.name === t.trait && tr.description && tr.description.includes(t.from)) {
      tr.description = tr.description.split(t.from).join(t.to);
      count++;
    }
  });
  console.log('  ' + t.trait + ': 文本替换 ' + count + ' 处');
  if (count === 0) errors.push('特性文本: ' + t.trait + ' 未找到待替换文本 "' + t.from + '"');
});
TRAIT_SET.forEach(t => {
  const targets = monsters.filter(m => monsterName(m) === t.monster);
  if (targets.length === 0) { errors.push('特性: 找不到精灵 ' + t.monster); return; }
  targets.forEach(m => {
    const tr = m.trait && m.trait.localized && m.trait.localized.zh;
    if (!tr || tr.name !== t.trait) { errors.push('特性: ' + monsterName(m) + '(id=' + m.id + ') 特性不是 ' + t.trait); return; }
    console.log('  ' + monsterName(m) + '(id=' + m.id + ')【' + t.trait + '】→ ' + t.desc);
    tr.description = t.desc;
  });
});

console.log('==== 技能调整 ====');
MOVE_EDITS.forEach(me => {
  const targets = moves.filter(x => x.localized && x.localized.zh && x.localized.zh.name === me.name);
  if (targets.length === 0) { errors.push('技能: moves.json 中找不到 ' + me.name); return; }
  targets.forEach(x => {
    const zh = x.localized.zh;
    if (me.power) {
      if (x.power !== me.power[0]) errors.push('技能: ' + me.name + ' power 期望旧值' + me.power[0] + '，实际' + x.power);
      else { x.power = me.power[1]; console.log('  ' + me.name + ' 威力: ' + me.power[0] + ' -> ' + me.power[1]); }
    }
    if (me.combo) {
      if (x.base_combo !== me.combo[0]) errors.push('技能: ' + me.name + ' combo 期望旧值' + me.combo[0] + '，实际' + x.base_combo);
      else { x.base_combo = me.combo[1]; console.log('  ' + me.name + ' 连击: ' + me.combo[0] + ' -> ' + me.combo[1]); }
    }
    if (me.cost) {
      if (x.energy_cost !== me.cost[0]) errors.push('技能: ' + me.name + ' cost 期望旧值' + me.cost[0] + '，实际' + x.energy_cost);
      else { x.energy_cost = me.cost[1]; console.log('  ' + me.name + ' 能耗: ' + me.cost[0] + ' -> ' + me.cost[1]); }
    }
    if (me.descFrom) {
      if (!zh.description || !zh.description.includes(me.descFrom)) errors.push('技能: ' + me.name + ' 描述中未找到 "' + me.descFrom + '"，当前: "' + zh.description + '"');
      else { zh.description = zh.description.split(me.descFrom).join(me.descTo); console.log('  ' + me.name + ' 描述已更新'); }
    }
  });
});

console.log('==== 新增学习面 ====');
const moveByName = {};
moves.forEach(x => { const n = x.localized && x.localized.zh && x.localized.zh.name; if (n && !moveByName[n]) moveByName[n] = x; });
LEARNSET_ADD.forEach(triple => {
  const skillName = triple[0], petNames = triple[1], sourceVal = triple[2] || '技能石';
  const mv = moveByName[skillName];
  if (!mv) { errors.push('学习面: moves.json 中找不到技能 ' + skillName); return; }
  petNames.forEach(pn => {
    const entry = wiki[pn];
    if (!entry) { errors.push('学习面: wiki_monster_data.json 中找不到 "' + pn + '"'); return; }
    if (!Array.isArray(entry.skills)) { errors.push('学习面: "' + pn + '" 无 skills 数组'); return; }
    if (entry.skills.some(s => s.name === skillName)) { console.log('  ' + pn + ' 已有【' + skillName + '】，跳过'); return; }
    const type = CATEGORY_TO_TYPE[mv.move_category] || mv.move_category;
    const element = (mv.move_type && mv.move_type.localized && mv.move_type.localized.zh) || '';
    entry.skills.push({ name: skillName, source: sourceVal, type: type, element: element, desc: (mv.localized && mv.localized.zh && mv.localized.zh.description) || '' });
    console.log('  ' + pn + ' +【' + skillName + '】(' + type + '/' + element + ')');
  });
});

if (errors.length) {
  console.error('\n[FAIL] 发现 ' + errors.length + ' 个问题，未写入任何文件：');
  errors.forEach(e => console.error('  - ' + e));
  process.exit(1);
}
writeJSON('data/monsters.json', monsters);
writeJSON('data/moves.json', moves);
writeJSON('data/wiki_monster_data.json', wiki);
console.log('\n[OK] 全部校验通过，已写入 monsters.json / moves.json / wiki_monster_data.json');
