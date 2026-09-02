/**
 * data.js — 数据加载与管理层
 * 负责从本地 JSON 加载精灵、技能、属性数据，并提供查询接口
 */
const RKData = (function () {
  let monsters = [];
  let moves = [];
  let types = [];
  let wikiData = {};    // wiki monster name -> { image, skills }
  let typeMap = {};      // name -> type object
  let typeZhMap = {};    // zh name -> type object
  let loaded = false;

  /** 属性中文名映射（与 types.json 的 localized.zh 一致） */
  const TYPE_ZH = {
    'Normal': '普', 'Grass': '草', 'Fire': '火', 'Water': '水',
    'Electric': '电', 'Light': '光', 'Dark': '恶', 'Dragon': '龙',
    'Mechanical': '钢', 'Ice': '冰', 'Ground': '地', 'Flying': '翼',
    'Ghost': '幽', 'Poison': '毒', 'Bug': '虫', 'Fighting': '武',
    'Cute': '萌', 'Leader': '首领', 'Illusion': '幻',
    'None': '无'
  };

  /** 属性单字简称（用于 pill 按钮等紧凑显示） */
  const TYPE_SHORT_ZH = {
    'Normal': '普', 'Grass': '草', 'Fire': '火', 'Water': '水',
    'Light': '光', 'Ground': '地', 'Ice': '冰', 'Dragon': '龙',
    'Electric': '电', 'Poison': '毒', 'Bug': '虫', 'Fighting': '武',
    'Flying': '翼', 'Cute': '萌', 'Ghost': '幽', 'Dark': '恶',
    'Mechanical': '钢', 'Illusion': '幻',
    'None': '无'
  };

  /** 中文属性名 → 英文属性名（含简称和全称，用于图标路径和克制计算） */
  const ZH_TO_EN = {
    '普': 'Normal', '普通': 'Normal', '草': 'Grass', '火': 'Fire', '水': 'Water',
    '电': 'Electric', '光': 'Light', '恶': 'Dark', '龙': 'Dragon',
    '钢': 'Mechanical', '机械': 'Mechanical', '冰': 'Ice', '地': 'Ground',
    '翼': 'Flying', '幽': 'Ghost', '毒': 'Poison', '虫': 'Bug', '武': 'Fighting',
    '萌': 'Cute', '幻': 'Illusion',
    '无': 'None', '无属性': 'None'
  };

  /** 所有属性简称列表（用于按钮等UI） */
  const ALL_TYPES = ['普','草','火','水','光','地','冰','龙','电','毒','虫','武','翼','萌','幽','恶','钢','幻'];

  /** 属性 pill 按钮排列顺序（英文属性名） */
  const PILL_ORDER = [
    'Normal', 'Grass', 'Fire', 'Water', 'Light', 'Ground',
    'Ice', 'Dragon', 'Electric', 'Poison', 'Bug', 'Fighting',
    'Flying', 'Cute', 'Ghost', 'Dark', 'Mechanical', 'Illusion'
  ];

  /** 属性简称 → 全称 */
  const TYPE_ZH_FULL = { '普': '普通', '钢': '机械', '无': '无属性' };

  /** 获取精灵中文名（不含形态） */
  function getMonsterName(m) {
    return m.localized?.zh?.name || '';
  }

  /** 获取精灵显示名（含形态后缀） */
  function getMonsterDisplayName(m) {
    const name = m.localized?.zh?.name || '';
    const form = m.form || '';
    if (form && form !== 'default' && form !== 'Original') {
      return `${name}（${form}）`;
    }
    return name;
  }

  /** 获取精灵显示名 HTML（形态后缀灰色小字） */
  function getMonsterDisplayNameHtml(m) {
    const name = m.localized?.zh?.name || '';
    const form = m.form || '';
    if (form && form !== 'default' && form !== 'Original') {
      return `${name}<span class="pet-form-suffix">（${form}）</span>`;
    }
    return name;
  }

  /** 获取技能中文名 */
  function getMoveName(mv) {
    return mv.localized?.zh?.name || '';
  }

  /** 获取技能中文描述 */
  function getMoveDesc(mv) {
    if (mv.localized && mv.localized.zh && mv.localized.zh.description) return mv.localized.zh.description;
    return mv.localized?.zh?.description || '';
  }

  /** 获取属性中文名 */
  function getTypeZh(typeName) {
    return TYPE_ZH[typeName] || typeName;
  }

  /** 获取属性图标路径（接受中文或英文名称，"无"属性使用普通系图标） */
  function getTypeIcon(typeName) {
    if (!typeName) return '';
    const en = ZH_TO_EN[typeName] || typeName;
    if (en === 'None') return `assets/icons/type/normal.png`;
    return `assets/icons/type/${en.toLowerCase()}.png`;
  }

  /** 生成属性徽章 HTML（图标+文字） */
  function typeBadgeHtml(typeName) {
    if (!typeName) return '';
    const zh = getTypeZh(typeName);
    const icon = getTypeIcon(typeName);
    return `<span class="type-badge type-${typeName}"><img src="${icon}" class="type-badge-icon" alt="${zh}">${zh}</span>`;
  }

  /** 获取属性单字简称 */
  function getTypeShortZh(typeName) {
    return TYPE_SHORT_ZH[typeName] || typeName;
  }

  /** 从属性对象获取中文名 */
  function getTypeObjZh(typeObj) {
    if (!typeObj) return null;
    if (typeObj.localized && typeObj.localized.zh) return typeObj.localized.zh;
    return getTypeZh(typeObj.name);
  }

  /** 中文属性名 → 英文属性名 */
  function getTypeEn(zhName) {
    return ZH_TO_EN[zhName] || zhName;
  }

  /** 属性简称 → 全称 */
  function getTypeZhFull(t) {
    return TYPE_ZH_FULL[t] || t;
  }

  /** 多属性克制计算（支持双属性复合，接受中文或英文名称） */
  function getTypeEff(atkType, defType1, defType2) {
    const atkEn = ZH_TO_EN[atkType] || atkType;
    const def1En = ZH_TO_EN[defType1] || defType1;
    let m1 = getEffectiveness(atkEn, def1En);
    if (!defType2) return m1;
    const def2En = ZH_TO_EN[defType2] || defType2;
    let m2 = getEffectiveness(atkEn, def2En);
    const product = m1 * m2;
    if (Math.abs(product - 4.0) < 0.01) return 3.0;
    if (Math.abs(product - 0.25) < 0.01) return 1/3;
    return product;
  }

  /** 获取精灵基础种族值 */
  function getBaseStat(pet, stat) {
    const map = { attack: 'base_phy_atk', magic_attack: 'base_mag_atk', defense: 'base_phy_def', magic_defense: 'base_mag_def', hp: 'base_hp', speed: 'base_spd' };
    return Math.floor(pet[map[stat]] || 0);
  }

  /** 计算精灵最终属性值 */
  function getPetStat(pet, stat, nature, iv) {
    if (!pet) return 0;
    const base = getBaseStat(pet, stat);
    const ivVal = iv ? 10 : 0;
    const natureMod = nature === 1 ? 1.2 : nature === 2 ? 0.9 : 1.0;
    if (stat === 'hp') {
      return Math.round(Math.round(Math.round(1.7 * (base + 3 * ivVal)) + 70) * natureMod) + 100;
    }
    return Math.round(Math.round(Math.round(1.1 * (base + 3 * ivVal)) + 10) * natureMod) + 50;
  }

  /** 初始化：加载所有数据 */
  async function init() {
    if (loaded) return;
    try {
      const [monRes, moveRes, typeRes, wikiRes] = await Promise.all([
        fetch('data/monsters.json').then(r => r.json()),
        fetch('data/moves.json').then(r => r.json()),
        fetch('data/types.json').then(r => r.json()),
        fetch('data/wiki_monster_data.json').then(r => r.json()).catch(() => ({}))
      ]);
      monsters = Array.isArray(monRes) ? monRes : (monRes.data || []);
      moves = Array.isArray(moveRes) ? moveRes : (moveRes.data || []);
      types = Array.isArray(typeRes) ? typeRes : (typeRes.data || []);
      wikiData = wikiRes || {};

      // 图片缓存击穿：为所有精灵图片 URL 附加会话级版本参数。
      // 即使 WebView2 残留旧缓存（如头像替换前的旧图），URL 变化后也会强制重新加载。
      const _imgVer = 'v=' + Date.now();
      monsters.forEach(m => { if (m.image) m.image = m.image + '?' + _imgVer; });
      Object.values(wikiData).forEach(wd => { if (wd && wd.image) wd.image = wd.image + '?' + _imgVer; });

      // 构建属性映射
      types.forEach(t => {
        typeMap[t.name] = t;
        const zh = getTypeZh(t.name);
        typeZhMap[zh] = t;
      });

      // 添加"无属性"类型（仅木桩使用，不克制任何属性，也不被任何属性克制）
      if (!typeMap['None']) {
        const noneType = {
          id: 0, name: 'None',
          localized: { zh: '无' },
          vulnerable_to: [],
          resistant_to: []
        };
        types.push(noneType);
        typeMap['None'] = noneType;
        typeZhMap['无'] = noneType;
      }

      // 添加自定义"木桩"精灵（全属性100，无属性）
      if (!monsters.find(m => m.id === 9001)) {
        monsters.push({
          id: 9001,
          hidden: true,
          name: 'WoodDummy',
          form: 'default',
          main_type: { id: 0, name: 'None', localized: { zh: '无' }, vulnerable_to: [], resistant_to: [] },
          sub_type: null,
          default_legacy_type: { id: 0, name: 'None', localized: { zh: '无' }, vulnerable_to: [], resistant_to: [] },
          leader_potential: false,
          is_leader_form: false,
          preferred_attack_style: 'Physical',
          localized: { zh: { name: '木桩' } },
          base_hp: 100, base_phy_atk: 100, base_mag_atk: 100, base_phy_def: 100, base_mag_def: 100, base_spd: 100,
          evolves_from_id: null, dex_number: 0,
          trait: { localized: { zh: { name: '无', description: '木桩没有特性。' } }, description: '木桩没有特性。' },
          image: '',
          icon: 'assets/icons/type/normal.png'
        });
      }

      loaded = true;
      console.log(`[RKData] 加载完成: ${monsters.length} 精灵, ${moves.length} 技能, ${types.length} 属性, ${Object.keys(wikiData).length} wiki数据`);
    } catch (err) {
      console.error('[RKData] 数据加载失败:', err);
      throw err;
    }
  }

  /** 获取所有精灵 */
  function getMonsters() { return monsters; }

  /** 获取所有技能 */
  function getMoves() { return moves; }

  /** 获取所有属性 */
  function getTypes() { return types; }

  /** 按ID获取精灵 */
  function getMonsterById(id) {
    return monsters.find(m => m.id === id);
  }

  /** 按名称搜索精灵 */
  function searchMonsters(keyword) {
    if (!keyword) return monsters;
    const kw = keyword.toLowerCase();
    return monsters.filter(m =>
      getMonsterName(m).toLowerCase().includes(kw)
    );
  }

  /** 按属性筛选精灵 */
  function filterMonstersByType(typeName) {
    if (!typeName || typeName === 'all') return monsters;
    return monsters.filter(m =>
      (m.main_type && m.main_type.name === typeName) ||
      (m.sub_type && m.sub_type.name === typeName)
    );
  }

  /** 获取属性克制倍率 */
  function getEffectiveness(atkType, defType) {
    if (!atkType || !defType) return 1.0;
    const defTypeObj = typeMap[defType];
    if (!defTypeObj) return 1.0;
    if (defTypeObj.vulnerable_to && defTypeObj.vulnerable_to.includes(atkType)) return 2.0;
    if (defTypeObj.resistant_to && defTypeObj.resistant_to.includes(atkType)) return 0.5;
    return 1.0;
  }

  /** 计算精灵总种族值 */
  function getTotalStats(m) {
    return (m.base_hp || 0) + (m.base_phy_atk || 0) + (m.base_mag_atk || 0) +
           (m.base_phy_def || 0) + (m.base_mag_def || 0) + (m.base_spd || 0);
  }

  /** 计算有效种族值 = 总种族值 - min(物攻, 魔攻) */
  function getEffectiveStats(m) {
    return getTotalStats(m) - Math.min(m.base_phy_atk || 0, m.base_mag_atk || 0);
  }

  /** 获取wiki精灵数据（图片+技能） */
  function getWikiData(name) {
    if (!name) return null;
    // 直接查找
    if (wikiData[name]) return wikiData[name];
    // 回退：去掉形态后缀（如"霜翼领主（冬天的样子）"→"霜翼领主"）
    const parenIdx = name.search(/[（(]/);
    if (parenIdx > 0) {
      const baseName = name.substring(0, parenIdx).trim();
      if (wikiData[baseName]) return wikiData[baseName];
    }
    return null;
  }

  /** 技能类型 → 图标文件名 */
  const SKILL_TYPE_ICON_MAP = {
    '物攻': 'physical-attack',
    '魔攻': 'magic-attack',
    '防御': 'defense',
    '状态': 'status',
    '条件攻击': 'conditional-attack',
    '能量': 'energy'
  };

  /**
   * 构建技能卡片 HTML（技能列表/图鉴详情/配队技能选择 共用）
   * @param {object} opts
   * @param {string} opts.name      技能名称
   * @param {string} opts.desc      技能描述
   * @param {string} opts.type      技能类型（物攻/魔攻/状态/防御…）
   * @param {string} opts.element   技能属性（普通/草/火…）
   * @param {number|null} opts.energy  能耗
   * @param {number|null} opts.power   威力（可选）
   * @param {string} opts.extraClass   额外 CSS class（如 'skill-equipped'）
   * @param {string} opts.extraAttrs   额外 data 属性（如 'data-skill-name="xxx"'）
   * @param {string} opts.extraHtml    额外 HTML（如折射说明）
   * @returns {string} HTML
   */
  function buildSkillCardHtml(opts) {
    const { name, desc, type, element, energy, power, extraClass, extraAttrs, extraHtml } = opts;
    const elemIcon = element ? getTypeIcon(element) : '';
    const elemIconHtml = element ? `<img src="${elemIcon}" class="detail-skill-elem-icon" alt="${element}">` : '';
    const typeIconName = SKILL_TYPE_ICON_MAP[type] || '';
    const typeIconHtml = typeIconName ? `<img src="assets/icons/move-sub/${typeIconName}.png" class="detail-skill-type-icon" alt="${type}">` : '';

    // 右侧标签：有威力显示威力，否则显示类型
    const hasPower = power != null && power > 0;
    const rightBadge = hasPower
      ? `<span class="detail-skill-tag detail-skill-power">${typeIconHtml}${power}</span>`
      : `<span class="detail-skill-tag type-${type || ''}">${typeIconHtml}${type || ''}</span>`;

    return `
      <div class="detail-skill-item ${extraClass || ''}" data-skill-type="${type || ''}" data-skill-elem="${element || ''}" data-skill-energy="${energy != null ? energy : ''}" ${extraAttrs || ''}>
        <img src="assets/monster/skill/${name}.png" class="detail-skill-icon" alt="${name}" loading="lazy" onerror="this.style.display='none'">
        <div class="detail-skill-body">
          <div class="detail-skill-header">
            <span class="detail-skill-name-line">${elemIconHtml}<span class="detail-skill-name">${name}</span></span>
            <span class="detail-skill-tags">
              ${energy != null ? `<span class="detail-skill-tag detail-skill-energy"><img src="assets/icons/move-sub/energy.png" class="detail-skill-type-icon" alt="能耗">${energy}</span>` : ''}
              ${rightBadge}
            </span>
          </div>
          ${desc ? `<span class="detail-skill-desc">${desc}</span>` : ''}
          ${extraHtml || ''}
        </div>
      </div>`;
  }

  /**
   * 提取精灵特性的中文名和描述
   * @param {object} m  精灵对象
   * @returns {{ name: string, desc: string }}
   */
  function getTraitInfo(m) {
    if (!m || !m.trait) return { name: '', desc: '' };
    const zh = m.trait.localized && m.trait.localized.zh;
    return {
      name: (zh && zh.name) || '',
      desc: (zh && zh.description) || ''
    };
  }

  /**
   * 构建特性图标 HTML
   * @param {string} traitName       特性名称
   * @param {object} [opts]
   * @param {string} [opts.className]  CSS class（默认 'trait-name-icon'）
   * @param {string} [opts.fallback]   图标加载失败时的回退 src（默认隐藏）
   * @returns {string} HTML
   */
  function traitIconHtml(traitName, opts) {
    opts = opts || {};
    if (!traitName) return '';
    const cls = opts.className || 'trait-name-icon';
    const onerror = opts.fallback
      ? `this.src='${opts.fallback}';this.onerror=null;`
      : `this.style.display='none';this.onerror=null;`;
    return `<img src="assets/monster/trait/${traitName}.png" class="${cls}" alt="${traitName}" loading="lazy" onerror="${onerror}">`;
  }

  /**
   * 构建特性详情 HTML（图鉴详情弹窗 / 技能选择弹窗 共用）
   * @param {string} traitName
   * @param {string} traitDesc
   * @returns {string} HTML
   */
  function buildTraitDetailHtml(traitName, traitDesc) {
    if (!traitName) return '';
    return `
      <div class="detail-trait-box">
        <div class="detail-trait-head">
          ${traitIconHtml(traitName, { className: 'detail-trait-icon', fallback: 'assets/icons/type/light.png' })}
          <span><span class="detail-trait-name">${traitName}${traitDesc ? ':' : ''}</span>${traitDesc ? ` <span class="detail-trait-desc">${traitDesc}</span>` : ''}</span>
        </div>
      </div>`;
  }

  return {
    init,
    getMonsters, getMoves, getTypes,
    getMonsterById, searchMonsters, filterMonstersByType,
    getEffectiveness, getTypeEff, getTotalStats, getEffectiveStats,
    getBaseStat, getPetStat,
    getMonsterName, getMonsterDisplayName, getMonsterDisplayNameHtml, getMoveName, getMoveDesc,
    getTypeZh, getTypeShortZh, getTypeEn, getTypeZhFull, getTypeObjZh,
    getTypeIcon, typeBadgeHtml,
    getWikiData,
    buildSkillCardHtml,
    getTraitInfo, traitIconHtml, buildTraitDetailHtml,
    TYPE_ZH, TYPE_SHORT_ZH, ZH_TO_EN, ALL_TYPES, TYPE_ZH_FULL, PILL_ORDER,
    get isLoaded() { return loaded; }
  };
})();
