/** Pure, explicitly reviewed species-trait presets. See docs/trait-power-defaults.md.
 * No persistence, actor mutation, data loading, or damage calculation occurs here.
 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TraitPowerDefaults = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  // Explicit stable IDs; descriptions are source guards, not text-inference rules.
  const rules = [
  {
    "ids": [
      40,
      41,
      42,
      43,
      44,
      45,
      46,
      47,
      48,
      50,
      51,
      52
    ],
    "trait": "顺风",
    "description": "若先于敌方攻击，本次技能威力+50%。",
    "field": "percentBonus",
    "value": 50,
    "kind": "default",
    "reason": "选中精灵时默认假定先手成立"
  },
  {
    "ids": [
      49,
      53,
      54,
      55
    ],
    "trait": "破空",
    "description": "若先于敌方攻击，本次技能威力+75%。",
    "field": "percentBonus",
    "value": 75,
    "kind": "default",
    "reason": "选中精灵时默认假定先手成立"
  },
  {
    "ids": [
      19,
      20,
      21,
      22,
      23,
      24
    ],
    "trait": "挺起胸脯",
    "description": "携带的能耗为1的技能，威力+50%。",
    "field": "percentBonus",
    "value": 50,
    "kind": "default",
    "reason": "选中精灵时默认应用，不按未知实时能耗判断"
  },
  {
    "ids": [
      25,
      26,
      27,
      28,
      29,
      30
    ],
    "trait": "“国王”的威严",
    "description": "鸭吉吉国王的种族资质大幅增加，能耗为1的技能威力+50%。",
    "field": "percentBonus",
    "value": 50,
    "kind": "default",
    "reason": "选中精灵时默认应用，不按未知实时能耗判断"
  },
  {
    "ids": [
      152,
      153
    ],
    "trait": "勇敢",
    "description": "携带的能耗大于3的技能，威力+40%。",
    "field": "percentBonus",
    "value": 40,
    "kind": "default",
    "reason": "选中精灵时默认应用，不按实时能耗判断"
  },
  {
    "ids": [
      186
    ],
    "trait": "不移",
    "description": "携带的无额外效果的攻击技能，威力+30%。",
    "field": "percentBonus",
    "value": 30,
    "kind": "default",
    "reason": "选中精灵时默认假定技能满足无额外效果条件"
  },
  {
    "ids": [
      203
    ],
    "trait": "水翼飞升",
    "description": "己方精灵每使用1次水系技能，自己入场时获得全技能能耗-1，且能耗为0的技能威力+30%。",
    "field": "percentBonus",
    "value": 30,
    "kind": "default",
    "reason": "用户指定神谕鲨默认30%，不以实时能耗为门槛"
  },
  {
    "ids": [
      168,
      169,
      170,
      171
    ],
    "trait": "电流刺激",
    "description": "携带的攻击技能获得迸发：威力+40。",
    "field": "fixedBonus",
    "value": 40,
    "kind": "default",
    "reason": "选中精灵时默认应用攻击技能迸发固定加成"
  },
  {
    "ids": [
      358,
      359
    ],
    "trait": "向心力",
    "description": "1号和2号位技能获得传动1和威力+30。",
    "field": "fixedBonus",
    "value": 30,
    "kind": "default",
    "reason": "选中精灵时默认假定技能位条件成立"
  },
  {
    "ids": [
      457,
      458,
      459
    ],
    "trait": "绒粉星光",
    "description": "攻击时，若敌方血脉是非本系的系别血脉，技能威力+100%。",
    "field": "percentBonus",
    "value": 100,
    "kind": "default",
    "reason": "选中精灵时默认假定敌方血脉条件成立"
  },
  {
    "ids": [
      460,
      461,
      462
    ],
    "trait": "月光审判",
    "description": "攻击时，若敌方血脉是首领血脉，技能威力+100%。",
    "field": "percentBonus",
    "value": 100,
    "kind": "default",
    "reason": "选中精灵时默认假定首领血脉条件成立"
  },
  {
    "ids": [
      542,
      543,
      544
    ],
    "trait": "冰雪魂魄",
    "description": "天气为暴风雪时，冰系技能威力+100%。",
    "field": "percentBonus",
    "value": 100,
    "kind": "default",
    "reason": "用户确认默认应用，不再按天气或技能属性自动门控"
  },
  {
    "ids": [
      210,
      211
    ],
    "trait": "目空",
    "description": "携带的非光系技能，威力+25%。",
    "field": "percentBonus",
    "value": 25,
    "kind": "nonLight",
    "reason": "仅非光系技能25%；光系关闭为0"
  },
  {
    "ids": [
      212
    ],
    "trait": "夺目",
    "description": "额外获得三个未携带的随机技能，且非光系技能威力+25%。",
    "field": "percentBonus",
    "value": 25,
    "kind": "nonLight",
    "reason": "仅非光系技能25%；光系关闭为0"
  },
  {
    "ids": [
      213,
      214,
      215,
      216,
      217,
      218
    ],
    "trait": "共鸣",
    "description": "携带的「虫鸣」技能威力+20。",
    "field": "fixedBonus",
    "value": 20,
    "kind": "bugCry",
    "reason": "仅虫鸣固定20，其余技能关闭为0"
  },
  {
    "ids": [
      219,
      220
    ],
    "trait": "齐鸣",
    "description": "自己携带的「虫鸣」技能威力+20，己方精灵携带的虫系技能获得巧变：虫鸣。",
    "field": "fixedBonus",
    "value": 20,
    "kind": "bugCry",
    "reason": "仅虫鸣固定20，不模拟全队巧变"
  },
  {
    "ids": [
      428,
      429
    ],
    "trait": "涂鸦",
    "description": "使用非本系技能时威力+50%。",
    "field": "percentBonus",
    "value": 50,
    "kind": "nonOwn",
    "reason": "仅非自身主副属性技能50%，本系关闭为0"
  },
  {
    "ids": [
      603,
      607,
      608
    ],
    "trait": "热成像",
    "description": "若上回合双方有精灵使用火系技能，本回合自己携带的虫系技能威力+100%。",
    "field": "percentBonus",
    "value": 100,
    "kind": "bug",
    "reason": "用户指定虫系技能100%，假定上回合条件成立"
  },
  {
    "ids": [
      604
    ],
    "trait": "冷光源",
    "description": "若上回合双方有精灵使用翼系技能，本回合自己携带的冰系技能威力+100%。",
    "field": "percentBonus",
    "value": 100,
    "kind": "moonFlying",
    "reason": "用户明确覆盖：仅月使鹭纳（旧名月使鸷纳）的翼系技能100%，不是资料中的冰系"
  },
  {
    "ids": [
      509,
      510
    ],
    "trait": "换碟",
    "description": "自己携带的音波弹/音爆/金属噪音/午夜噪音威力提升，且获得巧变：同系别技能。",
    "field": "fixedBonus",
    "value": 0,
    "kind": "disc",
    "reason": "用户指定音波弹15／音爆20／金属噪音20／午夜噪音5，其他0"
  }
];
  const byId = new Map();
  for (const rule of rules) for (const id of rule.ids) {
    if (byId.has(id)) throw new Error('Duplicate trait preset ID: ' + id);
    byId.set(id, rule);
  }
  const types = Object.freeze({
    '普通': 'Normal', '普': 'Normal', '草': 'Grass', '火': 'Fire', '水': 'Water',
    '光': 'Light', '幽': 'Ghost', '幽灵': 'Ghost', '恶': 'Dark', '翼': 'Flying',
    '地': 'Ground', '虫': 'Bug', '萌': 'Cute', '冰': 'Ice', '毒': 'Poison',
    '电': 'Electric', '武': 'Fighting', '幻': 'Illusion', '机械': 'Mechanical', '钢': 'Mechanical', '龙': 'Dragon'
  });
  const english = new Set(Object.values(types));
  const discPower = Object.freeze({ '音波弹': 15, '音爆': 20, '金属噪音': 20, '午夜噪音': 5 });
  function typeEn(value) {
    if (value && typeof value === 'object') value = value.name || value.localized?.zh;
    if (typeof value !== 'string') return null;
    if (english.has(value)) return value;
    if (Object.prototype.hasOwnProperty.call(types, value)) return types[value];
    // Optional public exact normalizer; never query backend/ability services.
    if (typeof root?.RKData?.getTypeEn === 'function') {
      try {
        const normalized = root.RKData.getTypeEn(value);
        if (english.has(normalized)) return normalized;
      } catch (_) { /* Unknown attributes safely have no automatic rule. */ }
    }
    return null;
  }
  function resolve(pet, skillName, skillAttr) {
    if (!pet || (typeof pet.id !== 'number' && typeof pet.id !== 'string')) return null;
    if (typeof pet.id === 'string' && !/^[1-9][0-9]*$/.test(pet.id)) return null;
    const id = Number(pet.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const rule = byId.get(id);
    if (!rule) return null;
    const source = pet.trait?.localized?.zh;
    // No name fallback: renamed species work, copied traits on unknown IDs do not.
    // Moon's explicit gameplay override is encoded in its rule, not a bypass of this guard.
    if (!source || source.name !== rule.trait ||
        String(source.description || '').replace(/\s/g, '') !== String(rule.description).replace(/\s/g, '')) return null;
    let value = rule.value;
    if (rule.kind === 'bugCry') value = skillName === '虫鸣' ? 20 : 0;
    else if (rule.kind === 'disc') value = Object.prototype.hasOwnProperty.call(discPower, skillName) ? discPower[skillName] : 0;
    else if (rule.kind !== 'default') {
      const attr = typeEn(skillAttr);
      if (!attr) return null; // Not a known non-Light/non-own attribute: preserve manual input.
      if (rule.kind === 'nonLight') value = attr === 'Light' ? 0 : 25;
      else if (rule.kind === 'bug') value = attr === 'Bug' ? 100 : 0;
      else if (rule.kind === 'moonFlying') value = attr === 'Flying' ? 100 : 0;
      else if (rule.kind === 'nonOwn') {
        const main = typeEn(pet.main_type);
        const sub = pet.sub_type == null ? null : typeEn(pet.sub_type);
        if (!main || (pet.sub_type != null && !sub)) return null;
        value = attr === main || attr === sub ? 0 : 50;
      }
    }
    return { field: rule.field, value, mode: rule.kind === 'default' ? 'default' : 'dynamic', reason: rule.reason };
  }
  return Object.freeze({ resolve });
});
