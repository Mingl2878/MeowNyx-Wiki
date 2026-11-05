'use strict';
// Read-only by default. --write-audit writes ONLY docs/skill-variants-audit.md.
// Never reads/writes AppData, runtime, learnsets, backups, or personal configuration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const variants = require(path.join(root, 'js/skill-variants.js'));
const simulation = require(path.join(root, 'js/skill-simulation.js'));
const moves = require('./lib/catalog-data.js').readDataFile(root, 'moves.json');
// Hash the read-only compatibility projection, not a retired duplicate file.
const raw = JSON.stringify(moves);
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
const simulated = moves.filter(m => simulation.kind(m, null));
const runtimeBranch = (r, side) => {
  const m=moves.find(m=>m.id===r.id), k=simulation.kind(m,null);
  if (!k) return branch(r[side]);
  if(k==='energy')return side==='left'?'当前能量10 → 211威力':'当前能量0 → 46威力';
  if(k==='hp-ratio')return '恢复保存的当前/最大生命；默认100/100；240−10×floor(20×失血比例)';
  if(r.id===113)return side==='left'?'恢复源基础威力/初始连击；烈火战神14清双攻累计及手动接管标记，保留字面手工BUFF':'永久威力次数n+1，每次+20；仅烈火战神14恢复自动双攻并以手工BUFF为基线加n×30：50→0、50+(1*20)→30%、50+(2*20)→60%；切技能保留';
  if(side==='left')return `恢复源基础威力/初始连击，清零该精灵该技能次数`;
  if(k==='double')return '翻倍次数+1；源威力*2^(次数)';
  if(k==='combo')return `连击累计次数+1，每次+${simulation.COMBO[r.id][1]}连击；单击威力不变`;
  if(k==='trial')return '威力次数+1，每次+10；中键另增1连击';
  if(k==='friend')return '威力次数+1，每次+20且退出应对；中键对当前累积威力×2，不复乘';
  return `永久威力次数+1，每次+${simulation.POWER[r.id]}`;
};
const runtimeReason=r=>simulation.kind(moves.find(m=>m.id===r.id),null)?'显式用户事件模拟由 SkillSimulation 接管，以下静态历史分支不参与此技能运行时选择；不推断实战历史。':r.reason;
const sections = [
  '# 技能左右键预设：完整审阅记录',
  '',
  '本文件由 `node scripts/audit_skill_variants.js --write-audit` 从已逐条审阅的 ID/描述注册表导出；该脚本不自动推断新技能。默认只读，`--check` 检查本文件是否与当前注册表完全一致。',
  '',
  `- 静态审阅基线全量 ${result.total} 条（运行时模拟接管见下节）；supported ${result.counts.supported}（固定双档 ${fixed.length}、单侧固定档 ${partial.length}、保留动态公式 ${dynamic.length}），ordinary ${result.counts.ordinary}，base-only（左右同基础） ${result.counts['base-only']}，non-attack ${result.counts['non-attack']}。未审阅 ${result.unreviewed.length}。`,
  `- 当前技能兼容投影（JSON.stringify）SHA-256：\`${crypto.createHash('sha256').update(raw).digest('hex')}\`。`,
  '- 审阅范围是规范化 catalog.json 的全部技能兼容投影（含 5931–5962 范围中实际存在的 ID）；仅无规范资料的旧 fixture 兼容 moves.json，不是第二套真实源。不是只检查示例或非空旧辅助字段；每条的全文证据、原因、左右结果均在下表。',
  '',
  '## 边界与交互',
  '',
  '- 静态预设只选择技能名称、物/魔类型、系别、单击基础威力和连击数。独立更新威力与连击，不累计上次点击结果，不改固定加成、BUFF、减伤、防御修正、星陨、手动最终威力或精灵 mode 0/1；百分比仅保留下述已有机幕方舟关联规则。',
  '- 基础、血脉、过山车三组共用事务。先更新完整技能字段及表达式与既有动态公式，再调用原技能快照/每精灵记忆保存入口。同属性的左右键切档不重置手动百分比，普通防守方不清零独立修正；仅在对机幕方舟切换到不同技能属性时，复用已有25%/0自动覆盖，避免保留过时加成。普通精灵重新选中仍恢复保存的手动百分比。批准的特性默认只在选中时覆盖，动态特性在技能/属性变化时应用；机幕方舟覆盖优先，但不把派生值写回每精灵手动记忆。',
  '- 静态注册表分类保留原审阅基线；下列 SkillSimulation 接管项优先于旧静态分支。其余普通技能仍左基础/右无预设，其余 base-only 两键初始。灾厄仅右180，不自动切换自伤目标。非攻击不进入图标。',
  '- 右键仅在伤害页技能图标上阻止菜单；不安装全局监听，不触及曲线页独立收藏。图标原生title/aria-label只显示名称、源威力/连击、效果全文，不显示左右键说明；成功选择只更新高亮和输入框，不在快捷卡片下追加说明。仅未应用/失败情况保留必要提示。Enter/空格为左键，Shift+Enter/空格为右键。',
  '- “条件成立”是手动选择的假设，不是自动检查天气、血量、位置或上回合记录；不篡改对应游戏状态。选择分支有额外条件时，两键不可能表达全部子状态，未成立时的原始威力明确列在原因中。',
  '- supported 仅指列出的威力/连击范围，并不宣称完整技能机制已实现。虫击、草虫冲击未实现无视抵抗；下注不结算自伤；撒花不回血；透镜实验不替换技能；轮班不执行传动；友谊满溢现为明确三键累计，详见新增模拟表；不自动从实战推断历史。',
  '- 治疗、属性增减益、印记、能耗、先手、下次攻击增益均不变成当前攻击威力。技能“使用次数+1”不冒充连击+1。',
  '- 用户明确授权快捷威力近似：穿膛65/325、背袭40/800、色散80/120，按普通威力流水线一次计算；不另乘伤害倍率。铁蒺藜、感电两键均基础。双联脉冲50威力，左1连击/右2连击。',
  '- 用户指定试算：吨位压制、以重制重100/160，砂糖弹球80/120；魔能爆现由能量0—10输入映射替代旧210/40；图标仍显示?，不把这些值写回主资料。',
  '- 旧 counter_power_multiplier / alt_power_total 不参与运行时判断。连续爪击/追打/散手是连击变化；撕咬源威力20不动，删除旧 alt_power_total=150 字段而不替换成100。草虫冲击以75+90=165为准，旧130不采用。',
  '- 叠浪和试飞的 base_combo 为空，但全文明确初始3连击/2连击；注册表按审阅 ID 填入，不用宽泛正则解析未知效果。',
  '- 百分比预设是已完成技能自身条件加成的基础威力：按 BattleMath.basePower(power, 0, percent) 四舍五入，扇风75×1.5→113；再将用户固定/百分比修正交给原 BattleMath 流水线。龙卷风70×1.5→105。',
  '- 鸣沙陷阱 phy_def_diff、闪击 speed_diff 双键继续现有自动差值逻辑，随攻守属性改变重算；审计中的60只是源表初始值，不是最终固化威力。',
  '- 注册表绑定精确 ID、名称、全文描述、类别、属性、源威力/连击/公式；新增或变化的条目降级未审阅，不使用 regex 猜机制。旧辅助字段变化不影响语义。源描述、learnset 不改。',
  '',
  '## 显式模拟输入与累计（优先于静态基线）',
  '',
  `- ${simulated.length} 个精确ID接入模拟；保存 rk_skill_simulation[精灵ID:技能ID]，含powerCount/comboCount/energy/hpRatio/counterMode。仅主动左键重置当前对，恢复/切页/重启不重置。`,
  '- 烈火战神14＋吹火113特例：威力与双攻共用powerCount次数n（0—1000000整数）：50→自动BUFF0、50+(1*20)→30%、50+(2*20)→60%，此后n×30个百分点，不连乘1.3。每次显式右键先使n+1，再将fireAttackCount同步为n；左键吹火两者清0，其他技能只保留当前双攻、不触发。旧powerCount-only与未标记的不匹配记录均按powerCount派生，包含powerCount=0但fireAttackCount>0；读取不修改/回填旧记录，只有显式选择时同步。特性/技能原文变化停止自动应用。',
  '- 手动修改吹火基础威力只重置powerCount，并以firePowerDetached:true明确保留当时fireAttackCount对应的双攻（不从不匹配旧镜像取值）；没有BUFF接管时此标记允许恢复fireAttackCount×30，切技能/精灵/重启仍保留。下一次显式吹火选择按重置后的n重新对齐两者并写firePowerDetached:false；独立手工BUFF不清。该可选标记仅允许14:113的非null布尔值，未标记旧记录不猜测手工编辑历史。',
  '- 手输有效BUFF优先接管：14:113写fireBuffOverridden:true、显示派生分量归0，输入字面数值成为新手工基线，不保存“输入−旧增长”的隐藏负补偿。两次右键60→切其他技能→手输0或清空BUFF→左键吹火仍0；手输−60则保留−60。切技能/页/精灵/重启不撤销接管；仅下一次显式吹火左/右键清标记并按正常n×30重启自动分量（n2时直接右键为手工值+90，先左后右为手工值+30）。手工20在增长前设置，归零后仍20；不回填、迁移或猜测清除旧负值记录。fireBuffOverridden仅允许精确14:113的非null布尔值，屏蔽增长仍校验所有已知字段；源审核保护不放宽。',
  '- 双攻派生分量进入现有增减益buff，不写技能percentBonus；技能/活动快照仅存手工buff，未接管时恢复计数分量一次，接管时保持字面基线。BUFF空串/纯空格/制表符/换行按手工0，输入事件接管但不强制将输入框改写为0；仅BUFF上下文归一化，不放松通用表达式及基础威力解析。计算/恢复读取不写接管标记，空白读取也不保留旧派生跟踪而反推出负补偿。未触发input的DOM空白在吹火左右键预检中以手工0计算，先验证计数/数值，再提交状态与保存；n2直接右键为90，左键为0。战报临时计数和接管标记独立，不读个人标记作为战报事实、不写个人/编队，攻/守任一入口均在退出后还原进入前完整值与派生分量。非空非法BUFF草稿（如1+）/越界不覆盖最后有效值、标记、计数、保存值；吹火左右键也拒绝此类草稿。',
  '- 威力增长显示源威力+(次数*步长)，翻倍显示源威力*2^(次数)，安全解析器把^当指数，不使用eval/Function。越界、除零、逗号和任意代码拒绝；无效输入不覆盖有效配置。',
  '- 魔能爆能量0—10对应46/71/91/111/136/156/166/181/191/201/211。彗星当前/最大生命以完整5%失血档扣10：77/100为200；不自动扣自己的生命。',
  '- 友谊满溢普通精灵：左70并归零，右每次+20并退出应对，中键对当前累计基础×2且不累乘。试飞：左20×2归零，右每次威力+10，中键每次连击+1，两个次数独立。',
  '- 白/黑加尔568/569例外优先：友谊沿既有固定加法表达式，试飞仍20×2，不采用普通三键增长；其他已确认加尔选择规则不变。',
  '- 排除给全技能、某类技能、相邻技能加威力的技能效果；不推断额外受击/使用/击败事件，右键只代表用户确认已发生一次。',
  '- 快照skillInputKind为power/energy/hp-ratio，skillInputValue保存输入，数值basePower始终是换算后的威力。界面只改变原输入标签，不重新布局技能卡片。',
  '',
  '| ID | 技能 | 左键 | 右键/其他 |',
  '| --- | --- | --- | --- |',
  ...simulated.map(m=>{const r=result.rows.find(r=>r.id===m.id);return `| ${m.id} | ${cell(r.name)} | ${cell(runtimeBranch(r,'left'))} | ${cell(runtimeBranch(r,'right'))} |`;}),
  '',
  '## 加尔／黑化加尔：固定表达式',
  '',
  '- 只对已审阅的真正选择攻击触发（501、506、508、510、519、522、526、535、544），不以技能说明提到“选择技能”就触发。试飞538仍按用户要求两键初始20×2，不猜永久增长或多次释放。',
  '- 黑化加尔569重复同一选择；加尔568追加另一选择。固定覆盖：黑化加尔友谊70+90/110+130，驱赶90+90/210+210，撒花95+95/145+145；加尔友谊70+90/90+110，驱赶90+70/90+210，撒花95+95/95+145。',
  '- 吹散65+65、冰裂70+70、蹦跶95+95均不改变即时威力的选择效果。下注、透镜实验、轮班沿既有已审阅选择条件成立档；黑化加尔重复该档，加尔按所点档再加另一档。不自动执行驱散、回血、替换、传动或自伤。',
  '- 数字basePower保存求和结果，basePowerExpression保存显示加法（例如90+90）；仅显示表达式而不生成两次伤害。固定加成、BUFF、本系、抵抗、连击和星陨沿现有一次释放流程，忽略分次取整差异。',
  '- 普通精灵不应用加尔双释放；本节加尔固定表达式反复点击不累计。表达式与每精灵及活动技能快照一起持久化，手动改数值/切普通技能/动态差值重算时清理旧表达式，恢复时校验表达式与数字和相同。',
  '',
  '| 精灵 | 技能 | 左键 | 右键 |',
  '| --- | --- | --- | --- |',
  ...[568,569].flatMap(pet=>[501,506,508,510,519,522,526,535,544,538].map(id=>{const d=variants.forAttacker(moves.find(m=>m.id===id),pet);const show=p=>p ? (p.basePowerExpression || p.basePower)+' × '+p.comboCount : '不自动填入';return '| '+pet+' | '+d.name+' | '+show(d.left)+' | '+show(d.right)+' |';})),
  '',
  '## Supported 清单（单击威力 × 连击）',
  '',
  '| ID | 技能 | 左键 | 右键 | 范围 |',
  '| --- | --- | --- | --- | --- |',
  ...result.rows.filter(r => r.disposition === 'supported').map(r => `| ${r.id} | ${cell(r.name)} | ${cell(runtimeBranch(r,'left'))} | ${cell(runtimeBranch(r,'right'))} | ${cell(runtimeReason(r))} |`),
  '',
  '## 原基础档分类（运行时显式模拟已在上表列明）',
  '',
  ...basics.map(r => `- **${r.id} ${r.name}**：${runtimeBranch(r,'left')}；${runtimeBranch(r,'right')}；${runtimeReason(r)}`),
  '',
  '## 全量逐条证据（所有分类）',
  '',
  '| ID | 技能 | 分类 | 左键 | 右键 | 原因/适用范围 | 源描述全文证据 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...result.rows.map(r => `| ${r.id} | ${cell(r.name)} | ${r.disposition} | ${cell(runtimeBranch(r,'left'))} | ${cell(runtimeBranch(r,'right'))} | ${cell(runtimeReason(r))} | ${cell(r.evidence)} |`),
  '',
  '## 验证入口与安全限制',
  '',
  '- `node --test tests/skill-variants.test.js tests/skill-variants-damage.test.js tests/skill-variants-expression.test.js`：纯模块全量分类/固定分支/取整/安全降级；VM 隔离验证真实伤害页渲染、左右事务、表达式与数值一致、快照和 mode 不变，成功重置通知只刷新个人来源配置。',
  '- `node --test tests/skill-simulation*.test.js`及`tests/skill-simulation.browser.js`覆盖新三键、输入映射、实际DOM闭包、记录隔离、重载及百分比记忆。',
  '- `node --test tests/fire-attack-growth.test.js`：同一n的0/30/60映射、旧错位只读恢复、手改威力分离、字面BUFF接管与负值保留、空串/空格/制表符/换行按手工0、未触发input的DOM空白与计算读取无标记写入、原始手工20归零、接管后左右键、新旧标记组合、跨技能/页/精灵/重启恢复、双向战报隔离、非空非法草稿及输入边界、失败预检无部分状态/保存修改；另以spy验证速度首领偏好只从显式搜索选择调用。全部使用内存fixture。`go test . -run ^TestSkillSimulation`以临时目录验证计数/两种手改标记、精确14:113键、未知字段、部分保存、失败重试及启动不迁移。',
  '- `node scripts/audit_skill_variants.js --check`：只读核对全量审阅和本文档。',
  '- `tests/skill-variants.browser.js` 与 `tests/skill-variants-expression.browser.js`：提供给父任务在 Go 隔离 fixture 中运行；先验证 __fixture/info 的 isolated 标记，拒绝非 fixture 的任何个人配置写入。后者覆盖真实重载、切换端口、清缓存、切换精灵、手改清理表达式；本文生成不表示浏览器测试已执行。',
  '- 不运行真实应用，不访问真实 AppData；不构建、不改 dist/native、不进行 Git 操作。',
  ''
];
const content = sections.join('\n');
const target = path.join(root, 'docs/skill-variants-audit.md');
if (args.includes('--write-audit')) fs.writeFileSync(target, content);
if (args.includes('--check') && fs.readFileSync(target, 'utf8') !== content) throw Error('Audit document is stale; review and regenerate explicitly');
console.log(JSON.stringify({ total: result.total, counts: result.counts, fixed: fixed.length, partial: partial.length, dynamic: dynamic.length, simulationCount: simulated.length, unreviewed: result.unreviewed }, null, 2));
