const root = 'D:/echoagent/MeowNyx Wiki';
const monsters = await Bun.file(`${root}/data/monsters.json`).json();
const moves = await Bun.file(`${root}/data/moves.json`).json();
const wiki = await Bun.file(`${root}/data/wiki_monster_data.json`).json();
const types = await Bun.file(`${root}/data/types.json`).json();

const byType = new Map(types.map(type => [type.localized.zh, type]));
const byMove = new Map(moves.map(move => [move.localized?.zh?.name, move]));
const sourceNames = { default: '默认', blood: '血脉', learn: '技能石' };
const data = [
  ['布灵布灵',465,['幻','光'],[83,115,40,123,96,125],'旧玩具','己方精灵每使用过1个不同系别的技能，自己入场时获得双攻+10%', {
    default:'双星|量子涨落|天体吸积|叠加态|透射|闪光弹|光刃|透镜实验|放晴|漫反射|猛烈撞击|锐利眼神|防御',
    blood:'念力膨胀|械斗|贪婪|报复|碰爪|羽化加速|缠丝劲|噬心|凋烂触碰|球状闪电|升龙咆哮|冰爪|跺地|虹光冲击|泡沫|火爪|荆棘爪|星星撞击',
    learn:'重组|超维投射|砂糖弹球|爆米花爆破|示弱|生日蛋糕|崩拳|截拳|影袭|破绽|偷袭|取念|晒太阳'
  }],
  ['摇铃魔偶',462,['幽'],[123,46,117,99,131,95],'盗魂铃','初始能量为0，首次入场前敌方每聚能1次，回复5能量（可突破上限），在场时自己回复的能量-4', {
    default:'恐吓|回收|午夜躁音|幽灵爆发|恶作剧|勾魂|嘲弄|小型打劫|报复|音波弹|音爆|摇篮曲|防御',
    blood:'念力膨胀|离子震荡|贪婪|灵媒|魅惑|羽化加速|化劲|噬心|凋烂触碰|触电|升龙咆哮|雪替身|扬沙|虹光冲击|蓄水|引燃|荆棘爪|星星撞击',
    learn:'金属噪音|广播|减压阀|降灵|离魂术|冰冻光线|冰掠镰|冰墙|埋伏|取念|伺机而动|快速移动|热身运动|无畏之心'
  }],
  ['黑手浣熊',460,['恶'],[97,116,110,124,115,120],'翻垃圾桶','入场时自己未携带的技能位置会变为敌方最近使用过的技能，且能耗-2', {
    default:'双星|大爆炸|叠加态|观测者效应|超维投射|毒沼|瘴气喷射|剧毒|毒孢子|倾泻|复写|精神扰乱|取念|借用|晒太阳|应激反应',
    blood:'冥想|械斗|恶能量|勾魂|碰爪|羽化加速|化劲|假寐|凋烂触碰|麻痹|升龙咆哮|雪替身|扬沙|透射|肥皂泡|火爪|荆棘爪|猛烈撞击',
    learn:'趁火打劫|血契|黑手|暴打|限时特惠|恶意逃离|贪婪|假冒|掉包|欺诈契约|纺纱|虚假破产|抓挠|休息回复|防御'
  }],
  ['测风蝉',458,['翼','机械'],[98,98,97,116,84,120],'风速仪','携带的技能每累计行动8，自己获得1层风起印记', {
    default:'龙卷风|电弧|超导|电磁偏转|偷袭|能量刃|突袭|倾泻|取念|晒太阳|咆哮|耀眼|棘刺|有效预防|嗜痛|吓退',
    blood:'针状物|离子震荡|贪婪|报复|甜心续航|羽化加速|化劲|假寐|毒孢子|磁干扰|升龙咆哮|冷风|扬沙|虹光冲击|泡沫|引燃|花香|星星撞击',
    learn:'齿轮扭矩|齿轮切开|微型乒候|广播|相位移动|能量守恒|风矢|俯冲|翼击|飞箭|羽翼庇护|无风|魔法增效|力量增效|防御'
  }],
  ['玳塔',456,['幻'],[127,47,107,72,116,50],'乌龟塔理论','每受到1次攻击伤害，敌方获得3层星陨印记', {
    default:'虫蛊|拟寄生|食腐|掩护|天光|镜像反射|先发制人|魔能爆|突袭|消毒法|取念|缓一缓|嗜痛',
    blood:'星云漩涡|械斗|贪婪|报复|甜心续航|羽翼庇护|化劲|假寐|毒孢子|集中|升龙咆哮|雪替身|泥浆铠甲|折线冲击|肥皂泡|火焰护盾|蜡质膜|休息回复',
    learn:'错乱|针状物|大爆炸|多维击打|奇点|超维投射|心灵洞悉|引力偏转|冥想|拍击|魔法增效|防御|血气'
  }],
  ['未完虫',454,['幽','虫'],[86,102,111,68,100,100],'正模标本','自己队伍中的其他精灵，在力竭1回合后会变为未完虫', {
    default:'惊吓盒子|撞鬼|鬼火|恐吓|幽灵爆发|嘲弄|蛊针|飞断|虫群过境|迁飞扩散|虫击|虫鸣|信息素|力量增效|防御',
    blood:'念力膨胀|离子震荡|贪婪|勾魂|碰爪|羽化加速|缠丝劲|尾后针|毒沼|触电|升龙咆哮|冷风|扬沙|虹光冲击|肥皂泡|火焰箭|荆棘爪|拍击',
    learn:'斑毁|暴打|恶意逃离|假冒|恶作剧|降灵|啄击|羽刃|回旋风暴|虫群智慧|偷袭|垂死反击|突袭|复写|咆哮'
  }],
  ['智辉章脑',453,['光','水'],[112,53,123,87,124,100],'基因编辑','自己携带技能的基础能耗，变为上回合双方使用的技能能耗之和', {
    default:'感电|过载回路|麻痹|加大功率|点亮|水光冲击|打湿|落雨|复写|应激反应|主场优势|摇篮曲|吓退',
    blood:'念力膨胀|金属噪音|贪婪|勾魂|魅惑|羽化加速|化劲|噬心|凋烂触碰|集中|升龙咆哮|雪替身|淤泥表皮|折线冲击|蓄水|引燃|花香|防反',
    learn:'光球|虹光冲击|折射|放晴|分光|甩水|气泡|涌泉|汇流|潮汐|魔法增效|棘刺|防御'
  }],
  ['圣凯布米龙',451,['火','虫'],[79,116,29,120,120,105],'热成像','若上回合双方有精灵使用火系技能，本回合自己携带的虫系技能威力+100%', {
    default:'双星|飞断|翅刃|虫群过境|迁飞扩散|落石|跺地|泥浆铠甲|流星火雨|热身|天火|偷袭|复写',
    blood:'念力膨胀|啮合传递|贪婪|幻象|碰爪|风矢|化劲|尾后针|毒沼|麻痹|升龙咆哮|冰爪|淤泥表皮|透射|泡沫|火焰箭|荆棘爪|防反',
    learn:'啃咬|蛊针|虫击|草虫冲击|虫群智慧|火苗|闪燃|暖阳|火焰切割|星火|晒太阳|力量增效|防御'
  }],
  ['月使鸷纳',448,['翼','冰'],[83,99,100,104,113,115],'冷光源','若上回合双方有精灵使用翼系技能，本回合自己携带的冰系技能威力+100%', {
    default:'啄击|疾风刺|月影交错|回旋风暴|飞箭|飞羽|乘风|惊鸿一瞥|风起|冰锥|冰晶坠|冰锋横扫|瞬间零度|锐利眼神|防御',
    blood:'念力膨胀|离子震荡|贪婪|幻象|魅惑|鹰爪|化劲|假寐|毒孢子|磁干扰|升龙咆哮|霜降|跺地|透射|水弹枪|引燃|花香|星星撞击',
    learn:'双星|多维击打|星链|羽化加速|羽翼庇护|无风|打雪仗|冰掠镰|霜天|埋伏|取念|伺机而动|快速移动|三连破|热身运动|嗜痛'
  }]
];

function translateCategory(category) {
  return ({ 'Physical Attack': '物攻', 'Magic Attack': '魔攻', Status: '状态', Defense: '防御' })[category] || '状态';
}
for (const [name, dex, elements, stats, traitName, traitDesc, groups] of data) {
  if (monsters.some(item => item.localized?.zh?.name === name)) throw new Error(`${name} 已存在。`);
  const [hp, phyAtk, magAtk, phyDef, magDef, spd] = stats;
  const main = byType.get(elements[0]);
  const sub = elements[1] ? byType.get(elements[1]) : null;
  if (!main || (elements[1] && !sub)) throw new Error(`${name} 的属性无效。`);
  monsters.push({
    base_hp: hp, base_mag_atk: magAtk, base_mag_def: magDef, base_phy_atk: phyAtk, base_phy_def: phyDef, base_spd: spd,
    default_legacy_type: main, dex_number: dex, evolution_chain_name: '', evolution_stage: '高级形态', evolves_from_id: null,
    form: 'default', form_category: '无多形态', id: Math.max(...monsters.map(item => item.id)) + 1, image: '',
    is_leader_form: false, leader_potential: false, localized: { zh: { name } }, main_form_name: '', main_type: main,
    preferred_attack_style: phyAtk > magAtk ? 'Physical' : magAtk > phyAtk ? 'Magic' : 'Both', sub_type: sub,
    trait: { localized: { zh: { name: traitName, description: traitDesc } } }
  });
  const skills = [];
  for (const [group, names] of Object.entries(groups)) {
    for (const skillName of names.split('|')) {
      const move = byMove.get(skillName);
      skills.push({
        name: skillName,
        element: move?.move_type?.localized?.zh || '普通',
        type: translateCategory(move?.move_category),
        source: sourceNames[group],
        desc: move?.localized?.zh?.description || '技能效果待补充。'
      });
    }
  }
  wiki[name] = { image: '', skills };
}
await Bun.write(`${root}/data/monsters.json`, `${JSON.stringify(monsters, null, 2)}\n`);
await Bun.write(`${root}/data/wiki_monster_data.json`, `${JSON.stringify(wiki, null, 2)}\n`);
console.log(`已新增 ${data.length} 只精灵，共 ${data.reduce((count, entry) => count + Object.values(entry[6]).join('|').split('|').length, 0)} 条技能关联。`);
