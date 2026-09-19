'use strict';
// Read-only by default. --write-audit writes ONLY docs/skill-variants-audit.md.
// Never reads/writes AppData, runtime, learnsets, backups, or personal configuration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const variants = require(path.join(root, 'js/skill-variants.js'));
const raw = fs.readFileSync(path.join(root, 'data/moves.json'), 'utf8');
const moves = JSON.parse(raw);
const result = variants.audit(moves);
if (result.unreviewed.length) throw Error('Unreviewed/changed move IDs: ' + result.unreviewed.join(', '));
if (new Set(moves.map(m => m.id)).size !== moves.length) throw Error('Duplicate move IDs');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--write-audit' && arg !== '--check')) throw Error('Use --check or --write-audit only');
const cell = value => String(value ?? '').replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
const branch = p => p ? `${p.basePower} × ${p.comboCount}（${p.label}）` : '不自动填入；保留当前值';
const fixed = result.rows.filter(r => r.disposition === 'supported' && !r.dynamic && r.left && r.right);
const partial = result.rows.filter(r => r.disposition === 'supported' && (!r.left || !r.right));
const dynamic = result.rows.filter(r => r.dynamic);
const basics = result.rows.filter(r => r.disposition === 'base-only');
const sections = [
  '# 技能左右键预设：完整审阅记录',
  '',
  '本文件由 `node scripts/audit_skill_variants.js --write-audit` 从已逐条审阅的 ID/描述注册表导出；该脚本不自动推断新技能。默认只读，`--check` 检查本文件是否与当前注册表完全一致。',
  '',
  `- 全量 ${result.total} 条；supported ${result.counts.supported}（固定双档 ${fixed.length}、单侧固定档 ${partial.length}、保留动态公式 ${dynamic.length}），ordinary ${result.counts.ordinary}，base-only（左右同基础） ${result.counts['base-only']}，non-attack ${result.counts['non-attack']}。未审阅 ${result.unreviewed.length}。`,
  `- 当前源表 SHA-256：\`${crypto.createHash('sha256').update(raw).digest('hex')}\`。`,
  '- 审阅范围是整份 moves.json（含 5931–5962 范围中实际存在的 ID），不是只检查示例或非空旧辅助字段。每条的全文证据、原因、左右结果均在下表。',
  '',
  '## 边界与交互',
  '',
  '- 预设只选择技能名称、物/魔类型、系别、单击基础威力和连击数。独立更新威力与连击，不累计上次点击结果，不改固定加成、BUFF、减伤、防御修正、星陨、手动最终威力或精灵 mode 0/1；百分比仅保留下述已有机幕方舟关联规则。',
  '- 基础、血脉、过山车三组共用事务。先更新完整技能字段及表达式与既有动态公式，再调用原技能快照/每精灵记忆保存入口。同属性的左右键切档不重置手动百分比，普通防守方不清零独立修正；仅在对机幕方舟切换到不同技能属性时，复用已有25%/0自动覆盖，避免保留过时加成。原有精灵切换行为不变。',
  '- 普通技能保留左键初始、右键无预设。52条 base-only 为用户明确要求：左右键均载入源基础威力及初始连击，不推算历史、血量、层数、相邻技能或额外效果。源0/1占位可手动修改。灾厄依然仅右键180，左键不自动切换自伤目标。非攻击不进入攻击图标。',
  '- 右键仅在伤害页技能图标上阻止菜单；不安装全局监听，不触及曲线页独立收藏。图标保留原生 title 与 aria-label；成功选择只更新高亮和输入框，不在快捷卡片下追加说明。仅未应用/失败情况保留必要提示。Enter/空格为左键，Shift+Enter/空格为右键。',
  '- “条件成立”是手动选择的假设，不是自动检查天气、血量、位置或上回合记录；不篡改对应游戏状态。选择分支有额外条件时，两键不可能表达全部子状态，未成立时的原始威力明确列在原因中。',
  '- supported 仅指列出的威力/连击范围，并不宣称完整技能机制已实现。虫击、草虫冲击未实现无视抵抗；下注不结算自伤；撒花不回血；透镜实验不替换技能；轮班不执行传动；友谊满溢双键仅零历史基准，左键不提前增加使用后的永久威力，右键初始70×2；真实累计威力仍手动。',
  '- 治疗、属性增减益、印记、能耗、先手、下次攻击增益均不变成当前攻击威力。技能“使用次数+1”不冒充连击+1。',
  '- 用户明确授权快捷威力近似：穿膛65/325、背袭40/800、色散80/120，按普通威力流水线一次计算；不另乘伤害倍率。铁蒺藜、感电两键均基础。双联脉冲50威力，左1连击/右2连击。',
  '- 用户指定试算：吨位压制、以重制重100/160，砂糖弹球80/120，魔能爆210/40；图标仍显示?，不把这些值写回主资料。',
  '- 旧 counter_power_multiplier / alt_power_total 不参与运行时判断。连续爪击/追打/散手是连击变化；撕咬源威力20不动，删除旧 alt_power_total=150 字段而不替换成100。草虫冲击以75+90=165为准，旧130不采用。',
  '- 叠浪和试飞的 base_combo 为空，但全文明确初始3连击/2连击；注册表按审阅 ID 填入，不用宽泛正则解析未知效果。',
  '- 百分比预设是已完成技能自身条件加成的基础威力：按 BattleMath.basePower(power, 0, percent) 向下取整，扇风75×1.5→112（不是旧113）；再将用户固定/百分比修正交给原 BattleMath 流水线。龙卷风70×1.5→105。',
  '- 鸣沙陷阱 phy_def_diff、闪击 speed_diff 双键继续现有自动差值逻辑，随攻守属性改变重算；审计中的60只是源表初始值，不是最终固化威力。',
  '- 注册表绑定精确 ID、名称、全文描述、类别、属性、源威力/连击/公式；新增或变化的条目降级未审阅，不使用 regex 猜机制。旧辅助字段变化不影响语义。源描述、learnset 不改。',
  '',
  '## 加尔／黑化加尔：固定表达式',
  '',
  '- 只对已审阅的真正选择攻击触发（501、506、508、510、519、522、526、535、544），不以技能说明提到“选择技能”就触发。试飞538仍按用户要求两键初始20×2，不猜永久增长或多次释放。',
  '- 黑化加尔569重复同一选择；加尔568追加另一选择。固定覆盖：黑化加尔友谊70+90/110+130，驱赶90+90/210+210，撒花95+95/145+145；加尔友谊70+90/90+110，驱赶90+70/90+210，撒花95+95/95+145。',
  '- 吹散65+65、冰裂70+70、蹦跶110+110均不改变即时威力的选择效果。下注、透镜实验、轮班沿既有已审阅选择条件成立档；黑化加尔重复该档，加尔按所点档再加另一档。不自动执行驱散、回血、替换、传动或自伤。',
  '- 数字basePower保存求和结果，basePowerExpression保存显示加法（例如90+90）；仅显示表达式而不生成两次伤害。固定加成、BUFF、本系、抵抗、连击和星陨沿现有一次释放流程，忽略分次取整差异。',
  '- 普通精灵不应用双释放；反复点击不累计。表达式与每精灵及活动技能快照一起持久化，手动改数值/切普通技能/动态差值重算时清理旧表达式，恢复时校验表达式与数字和相同。',
  '',
  '| 精灵 | 技能 | 左键 | 右键 |',
  '| --- | --- | --- | --- |',
  ...[568,569].flatMap(pet=>[501,506,508,510,519,522,526,535,544,538].map(id=>{const d=variants.forAttacker(moves.find(m=>m.id===id),pet);const show=p=>p ? (p.basePowerExpression || p.basePower)+' × '+p.comboCount : '不自动填入';return '| '+pet+' | '+d.name+' | '+show(d.left)+' | '+show(d.right)+' |';})),
  '',
  '## Supported 清单（单击威力 × 连击）',
  '',
  '| ID | 技能 | 左键 | 右键 | 范围 |',
  '| --- | --- | --- | --- | --- |',
  ...result.rows.filter(r => r.disposition === 'supported').map(r => `| ${r.id} | ${cell(r.name)} | ${cell(branch(r.left))} | ${cell(branch(r.right))} | ${cell(r.reason)} |`),
  '',
  '## 双键基础档清单（不推算变化条件）',
  '',
  ...basics.map(r => `- **${r.id} ${r.name}**：${branch(r.left)}；${r.reason}`),
  '',
  '## 全量逐条证据（所有分类）',
  '',
  '| ID | 技能 | 分类 | 左键 | 右键 | 原因/适用范围 | 源描述全文证据 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...result.rows.map(r => `| ${r.id} | ${cell(r.name)} | ${r.disposition} | ${cell(branch(r.left))} | ${cell(branch(r.right))} | ${cell(r.reason)} | ${cell(r.evidence)} |`),
  '',
  '## 验证入口与安全限制',
  '',
  '- `node --test tests/skill-variants.test.js tests/skill-variants-damage.test.js tests/skill-variants-expression.test.js`：纯模块全量分类/固定分支/取整/安全降级；VM 隔离验证真实伤害页渲染、左右事务、表达式与数值一致、快照和 mode 不变，成功重置通知只刷新个人来源配置。',
  '- `node scripts/audit_skill_variants.js --check`：只读核对全量审阅和本文档。',
  '- `tests/skill-variants.browser.js` 与 `tests/skill-variants-expression.browser.js`：提供给父任务在 Go 隔离 fixture 中运行；先验证 __fixture/info 的 isolated 标记，拒绝非 fixture 的任何个人配置写入。后者覆盖真实重载、切换端口、清缓存、切换精灵、手改清理表达式；本文生成不表示浏览器测试已执行。',
  '- 不运行真实应用，不访问真实 AppData；不构建、不改 dist/native、不进行 Git 操作。',
  ''
];
const content = sections.join('\n');
const target = path.join(root, 'docs/skill-variants-audit.md');
if (args.includes('--write-audit')) fs.writeFileSync(target, content);
if (args.includes('--check') && fs.readFileSync(target, 'utf8') !== content) throw Error('Audit document is stale; review and regenerate explicitly');
console.log(JSON.stringify({ total: result.total, counts: result.counts, fixed: fixed.length, partial: partial.length, dynamic: dynamic.length, unreviewed: result.unreviewed }, null, 2));
