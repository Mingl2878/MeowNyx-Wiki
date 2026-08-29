/**
 * damage.js — 伤害计算器页面（重构版）
 * 模块化架构：状态管理 / 计算引擎 / UI渲染 / 事件处理 / 扩展模块占位
 * 核心计算公式与原版完全一致
 */
const DamagePage = (function () {
  const { ALL_TYPES, getTypeZhFull, getTypeEff, getBaseStat, getPetStat, getTypeIcon } = RKData;

  /* ============================================================
   * 1. 状态管理层
   * ============================================================ */
  const state = {
    atkPet: null, defPet: null,
    atkNature: {}, atkIV: { attack: true, magic_attack: true },
    defNature: {}, defIV: { hp: true },
    skillType: 'attack',
    skillAttr: '普',
    basePower: 100, fixedBonus: 0, percentBonus: 0,
    buff: 0, comboCount: 1,
    debuffPercent: '0',    // 减伤百分比（纯数字，如 70 = 减伤70%）
    defenseMod: '0',       // 防御修正（如 d70 = 防御+70%, d-70 = 防御-70%）
    starMeteor: 0,         // 星陨印记层数
    finalPowerManual: '',  // 手动输入的最终威力（空字符串=自动计算）
    calcHistory: [],       // 计算历史记录
    favPets: [],           // 收藏的精灵
    searchedPets: [],      // 搜索过的精灵ID列表（历史）
    activeQuickTab: 'team' // 快捷模块当前标签: team/history/fav
  };

  /* 速度差威力技能：闪击 / 鸣沙陷阱 */
  const SPEED_BASED_SKILLS = ['闪击', '鸣沙陷阱'];
  function calcSpeedBasedPower(diff) {
    if (diff < 0) return 60;
    if (diff < 15) return 100;
    if (diff < 30) return 130;
    if (diff < 45) return 140;
    if (diff < 60) return 150;
    if (diff < 75) return 160;
    if (diff < 90) return 170;
    if (diff < 105) return 180;
    if (diff < 120) return 190;
    if (diff < 135) return 194;
    return 200;
  }
  function updateSpeedBasedPower() {
    if (!SPEED_BASED_SKILLS.includes(state.currentSkillName)) return;
    const atk = state.atkPet;
    const def = state.defPet;
    if (!atk || !def) return;
    const atkSpd = getPetStat(atk, 'speed', state.atkNature.speed || 0, state.atkIV.speed || false);
    const defSpd = getPetStat(def, 'speed', state.defNature.speed || 0, state.defIV.speed || false);
    const diff = atkSpd - defSpd;
    const power = calcSpeedBasedPower(diff);
    const input = document.getElementById('basePower');
    if (input) { input.value = power; state.basePower = power; }
  }

  const extState = {
    specialPower: {},      // 特殊技能威力计算模块
    specialStack: {},      // 特殊伤害叠加模块
    favorites: [],         // 收藏精灵快捷输入模块
    history: [],           // 历史记录显示模块
    skillIcons: {},        // 技能图标模块
    calcHistory: [],       // 计算历史记录
    favPets: [],           // 收藏的精灵
    searchedPets: [],      // 搜索过的精灵ID列表（历史）
    activeQuickTab: 'team' // 快捷模块当前标签: team/history/fav
  };

  let initialized = false;  // 是否已初始化过（用于跨页面切换时保留数据）

  // 技能使用记忆：最近使用的技能名排在前面
  let skillUsageOrder = [];
  try {
    const saved = localStorage.getItem('rk_skill_usage_order');
    if (saved) skillUsageOrder = JSON.parse(saved);
  } catch (e) {}
  function saveSkillUsageOrder() {
    try { localStorage.setItem('rk_skill_usage_order', JSON.stringify(skillUsageOrder)); } catch (e) {}
  }

  // 属性显示模式：'final' = 属性值, 'base' = 种族值
  state.atkStatMode = 'final';
  state.defStatMode = 'final';

  /* ============================================================
   * 2. 数据适配层
   * ============================================================ */
  function getPetTypes(pet) {
    if (!pet) return [];
    const types = [];
    if (pet.main_type) types.push(pet.main_type.name);
    if (pet.sub_type) types.push(pet.sub_type.name);
    return types;
  }
  function getPetName(pet) { return RKData.getMonsterDisplayName(pet); }

  /* ============================================================
   * 3. 计算引擎层（公式与原版完全一致，勿改）
   * ============================================================ */
  const CalcEngine = {
    /** 计算技能基础威力 */
    calcBasePower(basePower, fixedBonus, percentBonus) {
      return Math.floor((basePower + fixedBonus) * (1 + percentBonus / 100));
    },

    /** 判断本系加成 */
    isSameType(atkPet, skillAttr) {
      if (!atkPet) return false;
      const skillAttrFull = getTypeZhFull(skillAttr);
      const petTypes = getPetTypes(atkPet).map(t => getTypeZhFull(RKData.getTypeZh(t)));
      return petTypes.includes(skillAttrFull);
    },

    /** 属性克制系数 */
    calcTypeEff(skillAttr, defPet) {
      if (!defPet) return 1.0;
      const defTypes = getPetTypes(defPet);
      return getTypeEff(skillAttr, defTypes[0] || '', defTypes[1] || '');
    },

    /** buff 修正系数 */
    calcBuffMod(buffPercent) {
      if (buffPercent >= 0) return 1 + buffPercent / 100;
      return 1 / (1 + Math.abs(buffPercent) / 100);
    },

    /** 减伤百分比解析 → debuffMod */
    parseDebuffPercent(val) {
      const num = parseFloat(val) || 0;
      return (100 - num) / 100;
    },

    /** 防御修正解析 → defenseMod
     *  正值: 防御 × (1 + num%)
     *  负值: 防御 ÷ (1 + |num|%)  ← 不是 × (1 - |num|%)
     */
    parseDefenseMod(val) {
      const num = parseFloat(val) || 0;
      if (num >= 0) return 1 + num / 100;
      return 1 / (1 + Math.abs(num) / 100);
    },

    /** 星陨伤害计算： a² + 24a - 24 */
    calcStarMeteorBase(a) {
      return a * a + 24 * a - 24;
    },

    /** 计算最终威力 */
    calcFinalPower(basePower, fixedBonus, percentBonus, atkPet, defPet, skillAttr, buffPercent, manual) {
      if (manual !== null && manual !== '') return parseInt(manual) || 0;
      const skillBasePower = this.calcBasePower(basePower, fixedBonus, percentBonus);
      const sameTypeBonus = this.isSameType(atkPet, skillAttr) ? 1.25 : 1.0;
      const typeEff = this.calcTypeEff(skillAttr, defPet);
      const buffMod = this.calcBuffMod(buffPercent);
      return Math.floor(skillBasePower * sameTypeBonus * typeEff * buffMod);
    },

    /** 主计算函数：返回完整结果 */
    calculate() {
      const atk = state.atkPet;
      const def = state.defPet;
      if (!atk || !def) return null;

      const skillType = state.skillType;
      const skillTypeName = skillType === 'attack' ? '物攻' : '魔攻';
      const basePower = state.basePower;
      const fixedBonus = state.fixedBonus;
      const percentBonus = state.percentBonus;
      const buffPercent = state.buff;
      const comboCount = state.comboCount;

      // 拆分后的减伤百分比和防御修正
      const debuffPercentVal = state.debuffPercent || '0';
      const defenseModVal = state.defenseMod || '0';
      const debuffMod = this.parseDebuffPercent(debuffPercentVal);
      const defenseMod = this.parseDefenseMod(defenseModVal);
      const hasDefenseMod = defenseMod !== 1;
      const hasDebuffMod = debuffMod !== 1;

      const skillBasePower = this.calcBasePower(basePower, fixedBonus, percentBonus);
      const skillAttr = state.skillAttr;
      const skillAttrFull = getTypeZhFull(skillAttr);
      const isSameType = this.isSameType(atk, skillAttr);
      const sameTypeBonus = isSameType ? 1.25 : 1.0;
      const typeEff = this.calcTypeEff(skillAttr, def);
      const buffMod = this.calcBuffMod(buffPercent);

      const atkStatKey = skillType;
      const defStatKey = skillType === 'attack' ? 'defense' : 'magic_defense';
      const atkStat = getPetStat(atk, atkStatKey, state.atkNature[atkStatKey] || 0, state.atkIV[atkStatKey] || false);
      const defBaseStat = getPetStat(def, defStatKey, state.defNature[defStatKey] || 0, state.defIV[defStatKey] || false);
      const defStat = Math.round(defBaseStat * defenseMod);

      const isManual = state.finalPowerManual !== '' && state.finalPowerManual !== null;
      const skillFinalPower = this.calcFinalPower(basePower, fixedBonus, percentBonus, atk, def, skillAttr, buffPercent, isManual ? state.finalPowerManual : null);

      // 普通伤害计算
      const dmg1 = Math.ceil(skillFinalPower * atkStat);
      const dmg2 = Math.ceil(dmg1 * (37 / 41));
      const dmg3 = Math.ceil(dmg2 * debuffMod);
      const singleHit = Math.ceil(dmg3 / defStat);
      let totalDamage = singleHit * comboCount;

      // 星陨伤害：仅在非手动最终威力时计算
      let starMeteorDamage = 0;
      const starMeteorLayers = state.starMeteor || 0;
      if (!isManual && starMeteorLayers > 0) {
        const starBase = this.calcStarMeteorBase(starMeteorLayers);
        // 幻属性伤害，受攻击力、防御力、buff、抗性、减伤影响
        const starTypeEff = this.calcTypeEff('幻', def);
        const starDmg1 = Math.ceil(starBase * atkStat);
        const starDmg2 = Math.ceil(starDmg1 * (37 / 41));
        const starDmg3 = Math.ceil(starDmg2 * starTypeEff * debuffMod);
        const starSingleHit = Math.ceil(starDmg3 / defStat);
        starMeteorDamage = starSingleHit * comboCount;
        totalDamage += starMeteorDamage;
      }

      const defHP = getPetStat(def, 'hp', state.defNature.hp || 0, state.defIV.hp || false);
      const remainingHP = Math.max(0, defHP - totalDamage);
      const damagePercent = (totalDamage / defHP * 100);

      return {
        atkName: getPetName(atk), defName: getPetName(def),
        skillTypeName, skillAttrFull,
        atkStat, defStat, defBaseStat, defStatKey,
        skillBasePower, skillFinalPower,
        isSameType, sameTypeBonus, typeEff, buffMod,
        debuffMod, defenseMod, hasDefenseMod, hasDebuffMod,
        singleHit, totalDamage, comboCount,
        starMeteorDamage, starMeteorLayers,
        defHP, remainingHP, damagePercent,
        atkIVText: state.atkIV[atkStatKey] ? '√个体' : '×个体',
        atkNatureText: state.atkNature[atkStatKey] === 1 ? '+性格' : state.atkNature[atkStatKey] === 2 ? '-性格' : '×性格',
        defIVText: state.defIV[defStatKey] ? '√个体' : '×个体',
        defNatureText: state.defNature[defStatKey] === 1 ? '+性格' : state.defNature[defStatKey] === 2 ? '-性格' : '×性格',
        hpIVText: state.defIV.hp ? '√个体' : '×个体',
        hpNatureText: state.defNature.hp === 1 ? '+性格' : state.defNature.hp === 2 ? '-性格' : '×性格',
        basePower, fixedBonus, percentBonus, buffPercent,
        isManual
      };
    },

    /** 构建计算过程文本 */
    buildSteps(r) {
      const defStatName = r.defStatKey === 'defense' ? '物防' : '魔防';
      const steps = [];

      steps.push(`① ${r.atkName}${r.skillTypeName} = <span class="highlight">${r.atkStat}</span> (${r.atkIVText}&${r.atkNatureText})`);

      if (r.hasDefenseMod) {
        steps.push(`② ${r.defName}${defStatName} = ${r.defBaseStat} × ${r.defenseMod.toFixed(2)} = <span class="highlight">${r.defStat}</span> (${r.defIVText}&${r.defNatureText})`);
      } else {
        steps.push(`② ${r.defName}${defStatName} = <span class="highlight">${r.defStat}</span> (${r.defIVText}&${r.defNatureText})`);
      }

      let powerText = r.skillBasePower.toString();
      if (r.fixedBonus !== 0 || r.percentBonus !== 0) {
        powerText = r.percentBonus !== 0 ? `(${r.basePower} + ${r.fixedBonus}) × ${(1 + r.percentBonus / 100).toFixed(2)} = ${r.skillBasePower}` : `${r.basePower} + ${r.fixedBonus} = ${r.skillBasePower}`;
      }
      const step3 = `③ 技能基础威力 = ${powerText}，技能属性 = <span class="highlight">${r.skillAttrFull}</span>`;

      if (r.isManual) {
        steps.push(`<span class="step-blocked" style="color:#888;">${step3}</span>`);
        steps.push(`④ 技能最终威力 = <span class="highlight">${r.skillFinalPower}</span> <span style="font-size:0.8em;color:#888;">（手动输入）</span>`);
      } else {
        steps.push(step3);
        let parts = [`${r.skillBasePower}`];
        if (r.isSameType) parts.push('本系1.25');
        if (r.typeEff !== 1.0) parts.push(`克制${r.typeEff}`);
        if (r.buffPercent !== 0) {
          if (r.buffPercent >= 0) parts.push(`BUFF${r.buffMod.toFixed(2)}`);
          else parts.push(`BUFF÷${(1 / r.buffMod).toFixed(2)}`);
        }
        if (parts.length > 1) {
          steps.push(`④ 技能最终威力 = ${parts.join(' × ')} = <span class="highlight">${r.skillFinalPower}</span>`);
        } else {
          steps.push(`④ 技能最终威力 = <span class="highlight">${r.skillFinalPower}</span>`);
        }
      }

      let dmgParts = [`${r.skillFinalPower} × (${r.atkStat} ÷ ${r.defStat})`, '0.9'];
      if (r.hasDebuffMod) dmgParts.push(`减伤${r.debuffMod.toFixed(2)}`);
      if (r.comboCount > 1) dmgParts.push(`${r.comboCount}连击`);
      let step5Left = dmgParts.join(' × ');
      let step5Right = `= <span class="danger-text">${r.totalDamage}</span>`;
      if (r.starMeteorDamage > 0) {
        step5Right = `= <span class="danger-text">${r.totalDamage - r.starMeteorDamage}</span> + <span class="danger-text">${r.starMeteorDamage}</span>(${r.starMeteorLayers}层星陨印记) = <span class="danger-text">${r.totalDamage}</span>`;
      }
      steps.push(`⑤ 最终伤害 = ${step5Left} ${step5Right}`);
      steps.push(`⑥ 伤害占比 = ${r.totalDamage} ÷ ${r.defHP} (${r.hpIVText}&${r.hpNatureText}) = <span class="highlight">${r.damagePercent.toFixed(2)}%</span>`);

      return steps;
    }
  };

  /* ============================================================
   * 4. UI 渲染层
   * ============================================================ */

  function buildFinalStatItems(side, stats) {
    return CommonUI.StatBox.buildHTML(side, stats);
  }

  function buildAttackerCard() {
    return `
      <div class="card attacker-card">
        <div class="card-header">
          <div class="header-left">
            <label>精灵:</label>
            <div id="attacker-search-slot"></div>
          </div>
          <div class="header-right">
            <h3>攻击方 <img id="swapIcon" src="assets/icons/ui/icon_attacker.png" alt="交换攻守方" class="title-icon swap-icon" title="点击交换攻守方" style="cursor:pointer;"></h3>
          </div>
        </div>
        <div class="card-body">
          <div class="stats-section">
            <div class="stats-header-with-button">
              <div class="stats-title-row">
                ${CommonUI.StatBox.buildModeRadio('atk')}
                <button id="resetAttackerBtn" class="reset-stats-btn" title="重置所有性格和个体">↻</button>
              </div>
              <div class="type-container">
                <label>精灵属性:</label>
                <div id="attackerTypes" class="type-badges"></div>
              </div>
            </div>
            <div class="final-stats-grid">
              ${buildFinalStatItems('attacker', ['hp','defense','attack','magic_defense','magic_attack','speed'])}
            </div>
          </div>
        </div>
      </div>`;
  }

  function buildDefenderCard() {
    return `
      <div class="card defender-card">
        <div class="card-header">
          <div class="header-left">
            <h3><img id="swapIconDef" src="assets/icons/ui/icon_defender.png" alt="防守方" class="title-icon swap-icon" title="点击交换攻守方" style="cursor:pointer;"> 防守方</h3>
            <label>精灵:</label>
            <div id="defender-search-slot"></div>
          </div>
        </div>
        <div class="card-body">
          <div class="stats-section">
            <div class="stats-header-with-button">
              <div class="stats-title-row">
                ${CommonUI.StatBox.buildModeRadio('def')}
                <button id="resetDefenderBtn" class="reset-stats-btn" title="重置所有性格和个体">↻</button>
              </div>
              <div class="type-container">
                <label>精灵属性:</label>
                <div id="defenderTypes" class="type-badges"></div>
              </div>
            </div>
            <div class="final-stats-grid">
              ${buildFinalStatItems('defender', ['hp','defense','attack','magic_defense','magic_attack','speed'])}
            </div>
          </div>
        </div>
      </div>`;
  }

  function buildSkillCard() {
    return `
      <div class="card skill-card">
        <div class="card-body">
          <div class="skill-section">
            <div class="skill-type-row">
              <div class="radio-group">
                <label class="radio-label"><input type="radio" id="skillTypeAttack" name="skillType" value="attack" checked><span>物攻</span></label>
                <label class="radio-label"><input type="radio" id="skillTypeMagic" name="skillType" value="magic_attack"><span>魔攻</span></label>
              </div>
              <div id="skillAttrPicker" class="skill-attr-picker">
                <button id="skillAttrBtn" class="skill-attr-btn" title="点击选择技能属性">
                  <img id="skillAttrIcon" src="assets/icons/type/normal.png" class="skill-attr-icon" alt="普">
                  <span id="skillAttrText">普</span>
                </button>
              </div>
            </div>
          </div>
          <div class="skill-section">
            <div class="input-row">
              <div class="input-group">
                <label class="accent-label">基础威力:</label>
                <input type="number" id="basePower" value="100" min="0">
              </div>
              <div class="input-group">
                <label class="accent-label">威力固定加成:</label>
                <input type="number" id="fixedBonus" value="0">
              </div>
              <div class="input-group">
                <label class="accent-label">威力百分比加成:</label>
                <div class="input-with-suffix">
                  <input type="number" id="percentBonus" value="0">
                  <span class="suffix">%</span>
                </div>
              </div>
            </div>
          </div>
          <div class="skill-section">
            <div class="input-row">
              <div class="input-group">
                <label class="accent-label">增减益buff:</label>
                <div class="input-with-suffix">
                  <input type="number" id="buff" value="0">
                  <span class="suffix">%</span>
                </div>
              </div>
              <div class="input-group">
                <label class="combo-label">连击数:</label>
                <input type="number" id="comboCount" value="1" min="1">
              </div>
              <div class="input-group">
                <label class="star-meteor-label">星陨印记:</label>
                <input type="number" id="starMeteor" value="0" min="0" placeholder="层数">
              </div>
            </div>
          </div>
          <div class="skill-section">
            <div class="input-row">
              <div class="input-group">
                <label class="defense-mod-label">防守方增减益:</label>
                <div class="input-with-suffix">
                  <input type="number" id="defenseMod" value="0" placeholder="">
                  <span class="suffix">%</span>
                </div>
              </div>
              <div class="input-group">
                <label class="debuff-percent-label">减伤百分比:</label>
                <div class="input-with-suffix">
                  <input type="number" id="debuffPercent" value="0" min="0" max="100">
                  <span class="suffix">%</span>
                </div>
              </div>
              <div class="input-group">
                <label class="final-power-manual-label">最终威力:</label>
                <input type="number" id="finalPowerManual" class="final-power-manual-input" value="" min="0" placeholder="">
              </div>
            </div>
          </div>
          <div class="skill-section modifiers">
            <div class="modifier-item">
              <span class="modifier-label">本系加成:</span>
              <span id="sameTypeBonus" class="modifier-value">未触发</span>
            </div>
            <div class="modifier-item">
              <span class="modifier-label">属性克制:</span>
              <span id="typeEffectiveness" class="modifier-value">×1.0</span>
            </div>
            <div class="modifier-item">
              <span class="modifier-label" id="finalPowerLabel">最终威力:</span>
              <span id="finalPower" class="modifier-value accent-bold">100</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  function buildResultCard() {
    return `
      <div class="card result-card">
        <div class="card-body result-body">
          <div class="damage-display">
            <p id="damageValue" class="damage-value">0</p>
            <p id="damagePercent" class="damage-percent">0.0%</p>
            <p id="remainingHP" class="remaining-hp">剩余生命: — / —</p>
          </div>
          <div class="process-header">
            <h4 class="process-title">计算过程</h4>
            <div class="process-buttons">
              <button id="copyProcessBtn" class="process-copy-btn" title="复制计算过程">
                <img src="assets/icons/ui/icon_copy.png" alt="复制" class="button-icon"> 复制
              </button>
            </div>
          </div>
          <div class="calculation-process">
            <div id="calculationSteps" class="process-steps">
              <p class="process-step">请选择精灵和技能进行计算</p>
            </div>
          </div>
        </div>
      </div>`;
  }

  /* ===== 扩展模块占位 UI ===== */

  function buildSpecialPowerModule() {
    return `
      <div class="card ext-module" id="ext-special-power">
        <div class="card-header">
          <h3><img src="assets/icons/ui/icon_skill.png" alt="特殊技能威力" class="title-icon"> 特殊技能威力计算</h3>
        </div>
        <div class="card-body">
          <p class="ext-placeholder">该模块正在开发中，后续将支持特殊技能的威力计算。</p>
        </div>
      </div>`;
  }

  function buildSpecialStackModule() {
    return `
      <div class="card ext-module" id="ext-special-stack">
        <div class="card-header">
          <h3><img src="assets/icons/ui/icon_result.png" alt="特殊伤害叠加" class="title-icon"> 特殊伤害叠加</h3>
        </div>
        <div class="card-body">
          <p class="ext-placeholder">该模块正在开发中，后续将支持多段伤害叠加计算。</p>
        </div>
      </div>`;
  }

  function buildQuickAccessModule() {
    return `
      <div class="card ext-module" id="ext-quick-access">
        <div class="card-body">
          <div class="quick-section">
            <div class="quick-section-title">编队</div>
            <div id="quick-team-grid" class="quick-pet-grid"></div>
          </div>
          <div class="quick-section">
            <div class="quick-section-title">历史</div>
            <div id="quick-history-grid" class="quick-pet-grid quick-history-grid"></div>
          </div>
          <div class="quick-section">
            <div class="quick-section-title">收藏</div>
            <div id="quick-fav-grid" class="quick-pet-grid"></div>
          </div>
        </div>
      </div>`;
  }

  function buildSkillIconModule() {
    return `
      <div class="card ext-module" id="ext-skill-icons">
        <div class="card-body">
          <div id="skill-icons-grid" class="skill-icons-grid"></div>
        </div>
      </div>`;
  }

  /* 过山车技能：队伍含机幕方舟时，当前精灵可使用编队上一只精灵的4个技能 */
  function getCoasterSkills(pet) {
    if (!pet) return [];
    let teamData = null;
    try {
      const raw = localStorage.getItem('rk_team_config');
      if (!raw) return [];
      const saved = JSON.parse(raw);
      const group = saved.groups && saved.groups.find(g => g.id === saved.activeGroupId);
      if (!group || !Array.isArray(group.team)) return [];
      teamData = group;
    } catch (e) { return []; }

    const team = teamData.team;
    // 检查队伍是否携带机幕方舟 (id=501)
    if (!team.includes(501)) return [];

    // 找到当前精灵在编队中的位置（通过 dex_number 匹配，含首领形态）
    const petDex = pet.dex_number;
    let idx = -1;
    for (let i = 0; i < team.length; i++) {
      const teamPet = RKData.getMonsterById(team[i]);
      if (teamPet && teamPet.dex_number === petDex) { idx = i; break; }
    }
    // 编队第一只不受影响
    if (idx <= 0) return [];

    // 上一只精灵
    const prevPetId = team[idx - 1];
    if (!prevPetId) return [];

    // 获取上一只精灵的技能配置
    const skills = (teamData.petSkills || {})[prevPetId] || [];
    const validSkills = skills.filter(s => s);
    if (validSkills.length === 0) return [];

    // 将技能名转换为 wiki 技能对象格式
    return validSkills.map(skillName => {
      const mv = RKData.getMoves().find(m => RKData.getMoveName(m) === skillName);
      const type = mv ? (mv.move_category === 'Physical Attack' ? '物攻' : mv.move_category === 'Magic Attack' ? '魔攻' : '物攻') : '物攻';
      const element = mv && mv.move_type ? (mv.move_type.localized?.zh || '普通') : '普通';
      return { name: skillName, source: '过山车', type: type, element: element };
    }).filter(s => s.type === '物攻' || s.type === '魔攻');
  }

  /* 技能图标模块：显示攻击方可携带的攻击技能，点击填入威力和属性 */
  function renderSkillIcons() {
    const grid = document.getElementById('skill-icons-grid');
    if (!grid) return;
    const pet = state.atkPet;
    if (!pet) { grid.innerHTML = '<p class="ext-placeholder">请先选择攻击方精灵</p>'; return; }

    const petName = getPetName(pet);
    const wiki = RKData.getWikiData(petName) || RKData.getWikiData(RKData.getMonsterName(pet));
    if (!wiki || !wiki.skills) { grid.innerHTML = '<p class="ext-placeholder">未找到技能数据</p>'; return; }

    // 筛选物攻和魔攻技能
    const attackSkills = wiki.skills.filter(s => s.type === '物攻' || s.type === '魔攻');
    if (attackSkills.length === 0) { grid.innerHTML = '<p class="ext-placeholder">无攻击技能</p>'; return; }

    // 分为基础技能和血脉技能
    const baseSkills = attackSkills.filter(s => s.source !== '血脉');
    const bloodlineSkills = attackSkills.filter(s => s.source === '血脉');

    // 按使用记忆排序：最近使用的排最前
    const sortByUsage = (arr) => arr.slice().sort((a, b) => {
      const ia = skillUsageOrder.indexOf(a.name);
      const ib = skillUsageOrder.indexOf(b.name);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    // 构建 moves name -> power 映射
    const moveMap = {};
    RKData.getMoves().forEach(mv => {
      const name = RKData.getMoveName(mv);
      if (name) moveMap[name] = mv;
    });

    // 生成单个技能图标的 HTML
    function buildSkillIconHtml(skill) {
      const mv = moveMap[skill.name];
      const power = mv ? (mv.power || 0) : 0;
      const combo = mv && mv.base_combo ? mv.base_combo : 1;
      const iconSrc = `assets/monster/skill/${skill.name}.png`;
      const typeIcon = RKData.getTypeIcon(skill.element);
      return `<div class="skill-icon-item" data-skill-name="${skill.name}" data-power="${power}" data-combo="${combo}" data-skill-type="${skill.type}" data-skill-element="${skill.element}" title="${skill.name} (${skill.type}/${skill.element}) 威力:${power}${combo > 1 ? ' ' + combo + '连击' : ''}">
        <div class="skill-icon-img-box">
          <img src="${iconSrc}" alt="${skill.name}" loading="lazy" onerror="this.style.visibility='hidden'">
          <span class="skill-icon-power">${power || '?'} </span>
          <img src="${typeIcon}" class="skill-icon-type" alt="${skill.element}" loading="lazy">
        </div>
        <span class="skill-icon-name">${skill.name}</span>
      </div>`;
    }

    // 生成分组 HTML
    let html = '';

    // 过山车技能：队伍含机幕方舟时，可使用编队上一只精灵的4个技能
    const coasterSkills = getCoasterSkills(pet);
    if (coasterSkills.length > 0) {
      html += `<div class="skill-icon-group"><div class="skill-icon-group-title">过山车技能</div><div class="skill-icons-subgrid">${coasterSkills.map(buildSkillIconHtml).join('')}</div></div>`;
    }

    if (baseSkills.length > 0) {
      html += `<div class="skill-icon-group"><div class="skill-icon-group-title">基础技能</div><div class="skill-icons-subgrid">${sortByUsage(baseSkills).map(buildSkillIconHtml).join('')}</div></div>`;
    }
    if (bloodlineSkills.length > 0) {
      html += `<div class="skill-icon-group"><div class="skill-icon-group-title">血脉技能</div><div class="skill-icons-subgrid">${sortByUsage(bloodlineSkills).map(buildSkillIconHtml).join('')}</div></div>`;
    }
    grid.innerHTML = html;

    // 点击技能图标 → 填入威力和属性
    grid.querySelectorAll('.skill-icon-item').forEach(item => {
      item.addEventListener('click', () => {
        const power = parseInt(item.dataset.power) || 0;
        const combo = parseInt(item.dataset.combo) || 1;
        const skillType = item.dataset.skillType; // 物攻 / 魔攻
        const element = item.dataset.skillElement; // 中文全称如 普通/草/火

        // 设置基础威力
        const basePowerInput = document.getElementById('basePower');
        basePowerInput.value = power;
        state.basePower = power;

        // 设置连击数
        const comboInput = document.getElementById('comboCount');
        comboInput.value = combo;
        state.comboCount = combo;

        // 设置技能类型（物攻/魔攻）
        if (skillType === '物攻') {
          document.getElementById('skillTypeAttack').checked = true;
          state.skillType = 'attack';
        } else {
          document.getElementById('skillTypeMagic').checked = true;
          state.skillType = 'magic_attack';
        }

        // 设置技能属性（中文全称 → 简称）
        const en = RKData.getTypeEn(element);
        const short = RKData.getTypeShortZh(en);
        state.skillAttr = short;
        updateSkillAttrButton();

        // 高亮选中的技能图标
        grid.querySelectorAll('.skill-icon-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');

        // 更新使用记忆：将此技能移到最前
        const skillName = item.dataset.skillName;
        state.currentSkillName = skillName;
        skillUsageOrder = skillUsageOrder.filter(n => n !== skillName);
        skillUsageOrder.unshift(skillName);
        saveSkillUsageOrder();
        // 重新排序 DOM（在各组内排序）
        document.querySelectorAll('.skill-icons-subgrid').forEach(subGrid => {
          const items = Array.from(subGrid.querySelectorAll('.skill-icon-item'));
          items.sort((a, b) => {
            const ia = skillUsageOrder.indexOf(a.dataset.skillName);
            const ib = skillUsageOrder.indexOf(b.dataset.skillName);
            if (ia === -1 && ib === -1) return 0;
            if (ia === -1) return 1;
            if (ib === -1) return -1;
            return ia - ib;
          });
          items.forEach(i => subGrid.appendChild(i));
        });

        checkSameType();
        checkJmfzBonus();
        updateSpeedBasedPower();
        updateTypeEffectiveness();
        updateFinalPower();
        calculate();
      });
    });
  }

  /* ============================================================
   * 5. 页面渲染入口
   * ============================================================ */
  function render(container) {
    container.innerHTML = `
      <div class="calc-root scroll-container">
        <div class="container">
          <div class="main-content">
            <div class="calc-col">
              ${buildQuickAccessModule()}
              ${buildSkillIconModule()}
            </div>
            <div class="calc-col">
              ${buildAttackerCard()}
              ${buildSkillCard()}
            </div>
            <div class="calc-col">
              ${buildDefenderCard()}
              ${buildResultCard()}
            </div>
          </div>
        </div>
      </div>
    `;

    initAttributeButtons();
    initProcessToggle();
    loadFavPets();
    loadSearchedPets();
    renderTeamAvatars('attacker');
    renderTeamAvatars('defender');
    initSearchDropdown('attacker-search-slot', 'attacker');
    initSearchDropdown('defender-search-slot', 'defender');
    bindEvents();
    initQuickAccess();
    if (!initialized) {
      initDefaultPets();
      initialized = true;
    } else {
      restoreFromState();
    }
  }

  /* 从已有 state 恢复 UI（页面切换回来时不重置数据） */
  function restoreFromState() {
    // 恢复搜索框文本
    if (state.atkPet) {
      searchBoxes.attacker.setValue(getPetName(state.atkPet));
      onAttackerSelected();
      syncModifierButtons('attacker');
    }
    if (state.defPet) {
      searchBoxes.defender.setValue(getPetName(state.defPet));
      onDefenderSelected();
      syncModifierButtons('defender');
    }
    // 恢复技能类型
    if (state.skillType === 'magic_attack') {
      document.getElementById('skillTypeMagic').checked = true;
    } else {
      document.getElementById('skillTypeAttack').checked = true;
    }
    // 恢复技能属性按钮
    updateSkillAttrButton();
    // 恢复技能设置输入框
    document.getElementById('basePower').value = state.basePower;
    document.getElementById('fixedBonus').value = state.fixedBonus;
    document.getElementById('percentBonus').value = state.percentBonus;
    document.getElementById('buff').value = state.buff;
    document.getElementById('comboCount').value = state.comboCount;
    document.getElementById('debuffPercent').value = state.debuffPercent || '0';
    document.getElementById('defenseMod').value = state.defenseMod || '0';
    document.getElementById('starMeteor').value = state.starMeteor || 0;
    document.getElementById('finalPowerManual').value = state.finalPowerManual || '';
    checkSameType();
    updateTypeEffectiveness();
    updateFinalPower();
    calculate();
    renderSkillIcons();
  }

  /* ============================================================
   * 6. 精灵搜索下拉框
   * ============================================================ */
  const searchBoxes = {};

  function initSearchDropdown(slotId, side) {
    const sb = CommonUI.createSearchBox({
      placeholder: '选择或搜索精灵',
      limit: 10,
      filter: (m) => !m.is_leader_form,
      onSelect: (pet) => {
        if (side === 'attacker') {
          state.atkPet = pet;
          // 尝试从 localStorage 读取已保存的性格/个体配置
          const saved = loadPetConfig(pet.id);
          state.atkNature = saved.nature || {};
          state.atkIV = saved.iv || {};
          onAttackerSelected();
          syncModifierButtons('attacker');
        } else {
          state.defPet = pet;
          const saved = loadPetConfig(pet.id);
          state.defNature = saved.nature || {};
          state.defIV = saved.iv || {};
          onDefenderSelected();
          syncModifierButtons('defender');
        }
      },
      renderItem: CommonUI.monsterRenderItem()
    });
    searchBoxes[side] = sb;
    document.getElementById(slotId).appendChild(sb.wrapper);
  }

  /* 性格/个体配置保存到 localStorage */
  function savePetConfig(petId, nature, iv) {
    try {
      const raw = localStorage.getItem('rk_pet_configs');
      const configs = raw ? JSON.parse(raw) : {};
      configs[petId] = { nature, iv };
      localStorage.setItem('rk_pet_configs', JSON.stringify(configs));
    } catch (e) {}
  }

  function loadPetConfig(petId) {
    try {
      const raw = localStorage.getItem('rk_pet_configs');
      if (!raw) return {};
      const configs = JSON.parse(raw);
      return configs[petId] || {};
    } catch (e) { return {}; }
  }

  /* ============================================================
   * 7. 默认精灵 & 组队头像
   * ============================================================ */
  function initDefaultPets() {
    const atkPet = RKData.getMonsterById(221);
    if (atkPet) {
      state.atkPet = atkPet;
      state.atkNature = {};
      state.atkIV = { attack: false, magic_attack: true, defense: false, magic_defense: false, hp: false, speed: false };
      searchBoxes.attacker.setValue(getPetName(atkPet));
      onAttackerSelected();
      syncModifierButtons('attacker');
    }
    const defPet = RKData.getMonsterById(9001);
    if (defPet) {
      state.defPet = defPet;
      state.defNature = {};
      state.defIV = {};
      searchBoxes.defender.setValue(getPetName(defPet), defPet);
      onDefenderSelected();
      syncModifierButtons('defender');
    }
  }

  function renderTeamAvatars(side) {
    const container = document.getElementById(`${side}TeamAvatars`);
    if (!container) return;

    let teamData = null;
    try {
      const raw = localStorage.getItem('rk_team_config');
      if (!raw) return;
      const saved = JSON.parse(raw);
      const group = saved.groups && saved.groups.find(g => g.id === saved.activeGroupId);
      if (!group || !Array.isArray(group.team)) return;
      teamData = group;
    } catch (e) { return; }

    const team = teamData.team;
    const petNatures = teamData.petNatures || {};
    const petIVs = teamData.petIVs || {};

    let html = '';
    for (let i = 0; i < 6; i++) {
      const petId = team[i];
      if (petId) {
        const pet = RKData.getMonsterById(petId);
        if (pet) {
          const name = getPetName(pet);
          const imgUrl = pet.image ? `assets/monster/images/${pet.image}` : '';
          html += `<div class="team-avatar filled" data-side="${side}" data-pet-id="${petId}" title="${name} - 点击导入">
            ${imgUrl ? `<img src="${imgUrl}" alt="${name}" loading="lazy">` : `<span>${name.charAt(0)}</span>`}
          </div>`;
          continue;
        }
      }
      html += `<div class="team-avatar empty" title="未放置精灵"></div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.team-avatar.filled').forEach(el => {
      el.addEventListener('click', () => importFromTeam(side, parseInt(el.dataset.petId), teamData));
    });
  }

  function importFromTeam(side, petId, teamData) {
    const pet = RKData.getMonsterById(petId);
    if (!pet) return;

    const natureData = (teamData.petNatures || {})[petId] || {};
    const ivData = (teamData.petIVs || {})[petId] || {};

    const nature = {};
    ['attack', 'magic_attack', 'defense', 'magic_defense', 'hp', 'speed'].forEach(stat => {
      if (natureData[stat] === 1) nature[stat] = 1;
      else if (natureData[stat] === 2) nature[stat] = 2;
    });

    const iv = {};
    ['attack', 'magic_attack', 'defense', 'magic_defense', 'hp', 'speed'].forEach(stat => {
      iv[stat] = !!ivData[stat];
    });

    const name = getPetName(pet);
    if (side === 'attacker') {
      state.atkPet = pet; state.atkNature = nature; state.atkIV = iv;
      searchBoxes.attacker.setValue(name);
      onAttackerSelected();
    } else {
      state.defPet = pet; state.defNature = nature; state.defIV = iv;
      searchBoxes.defender.setValue(name);
      onDefenderSelected();
    }
    syncModifierButtons(side);
  }

  /* ============================================================
   * 8. 修正按钮 & 同步
   * ============================================================ */
  function syncModifierButtons(side) {
    const nature = side === 'attacker' ? state.atkNature : state.defNature;
    const iv = side === 'attacker' ? state.atkIV : state.defIV;
    const rootEl = document.querySelector(`.${side}-card`);
    CommonUI.StatBox.syncButtons(rootEl, nature, iv);
  }

  function handleModifierClick(e, leftClick = true) {
    const btn = e.target.closest('.nature-btn, .iv-btn');
    if (!btn) return;
    e.preventDefault();

    const side = btn.dataset.type;
    const stat = btn.dataset.stat;
    const isNature = btn.classList.contains('nature-btn');
    const s = side === 'attacker' ? state.atkNature : state.defNature;
    const sIV = side === 'attacker' ? state.atkIV : state.defIV;

    if (isNature) {
      const cur = s[stat] || 0;
      if (leftClick) { s[stat] = cur === 1 ? 0 : 1; }
      else { s[stat] = cur === 2 ? 0 : 2; }
    } else {
      sIV[stat] = !sIV[stat];
    }

    syncModifierButtons(side);
    const mode = side === 'attacker' ? state.atkStatMode : state.defStatMode;
    updateFinalStats(side);
    updateSpeedBasedPower();
    calculate();
    // 保存性格/个体配置
    const pet = side === 'attacker' ? state.atkPet : state.defPet;
    if (pet) {
      const nature = side === 'attacker' ? state.atkNature : state.defNature;
      const iv = side === 'attacker' ? state.atkIV : state.defIV;
      savePetConfig(pet.id, nature, iv);
    }
  }

  function resetModifiers(side) {
    if (side === 'attacker') { state.atkNature = {}; state.atkIV = {}; }
    else { state.defNature = {}; state.defIV = {}; }
    syncModifierButtons(side);
  }

  function resetSkillSettings() {
    document.getElementById('skillTypeAttack').checked = true;
    state.skillAttr = '普';
    updateSkillAttrButton();
    document.getElementById('basePower').value = 100;
    document.getElementById('fixedBonus').value = 0;
    document.getElementById('percentBonus').value = 0;
    document.getElementById('buff').value = 0;
    document.getElementById('comboCount').value = 1;
    document.getElementById('debuffPercent').value = '0';
    document.getElementById('defenseMod').value = '0';
    document.getElementById('starMeteor').value = 0;
    document.getElementById('finalPowerManual').value = '';
    state.debuffPercent = '0';
    state.defenseMod = '0';
    state.starMeteor = 0;
    state.finalPowerManual = '';
    state.currentSkillName = '';
    checkSameType();
    updateTypeEffectiveness();
    updateFinalPower();
    calculate();
  }

  function swapPokemons() {
    const atkVal = searchBoxes.attacker.getValue();
    const defVal = searchBoxes.defender.getValue();
    searchBoxes.attacker.setValue(defVal);
    searchBoxes.defender.setValue(atkVal);
    const tempPet = state.atkPet;
    state.atkPet = state.defPet;
    state.defPet = tempPet;
    onAttackerSelected();
    onDefenderSelected();
  }

  /* ============================================================
   * 9. 精灵选中 & 属性更新
   * ============================================================ */
  function onAttackerSelected() {
    const pet = state.atkPet;
    if (!pet) return;

    updateTypeBadges('attacker', pet);
    updateFinalStats('attacker');

    const atk = getBaseStat(pet, 'attack');
    const mag = getBaseStat(pet, 'magic_attack');
    if (atk > mag) document.getElementById('skillTypeAttack').checked = true;
    else if (mag > atk) document.getElementById('skillTypeMagic').checked = true;

    checkSameType();
    updateSpeedBasedPower();
    updateFinalPower();
    calculate();
    renderSkillIcons();
    addSearchedPet(pet);
    updateAllRoleMarks();
  }

  function onDefenderSelected() {
    const pet = state.defPet;
    if (!pet) return;

    updateTypeBadges('defender', pet);
    updateFinalStats('defender');

    checkJmfzBonus();
    updateSpeedBasedPower();
    updateTypeEffectiveness();
    calculate();
    addSearchedPet(pet);
    updateAllRoleMarks();
  }

  function updateTypeBadges(side, pet) {
    const container = document.getElementById(`${side}Types`);
    container.innerHTML = '';
    const types = getPetTypes(pet);
    types.forEach(type => {
      container.insertAdjacentHTML('beforeend', RKData.typeBadgeHtml(type));
    });
  }

  function updateFinalStats(side) {
    const pet = state[side === 'attacker' ? 'atkPet' : 'defPet'];
    if (!pet) return;
    const nature = side === 'attacker' ? state.atkNature : state.defNature;
    const iv = side === 'attacker' ? state.atkIV : state.defIV;
    const mode = side === 'attacker' ? state.atkStatMode : state.defStatMode;
    const rootEl = document.querySelector(`.${side}-card`);
    CommonUI.StatBox.refreshValues(rootEl, pet, nature, iv, mode);
  }

  function checkSameType() {
    const pet = state.atkPet;
    const el = document.getElementById('sameTypeBonus');
    if (!pet) { el.textContent = '未触发'; el.classList.remove('triggered'); return; }
    const isSame = CalcEngine.isSameType(pet, state.skillAttr);
    if (isSame) { el.textContent = '已触发'; el.classList.add('triggered'); }
    else { el.textContent = '未触发'; el.classList.remove('triggered'); }
  }

  /* 机幕方舟特殊规则：被克制时威力加成默认25% */
  function checkJmfzBonus() {
    const defender = state.defPet;
    if (!defender) return;
    const input = document.getElementById('percentBonus');
    if (!input) return;
    const isJmfz = defender.id === 501;
    const typeEff = CalcEngine.calcTypeEff(state.skillAttr, defender);
    if (isJmfz && typeEff > 1) {
      input.value = 25;
      state.percentBonus = 25;
    } else {
      input.value = 0;
      state.percentBonus = 0;
    }
  }

  // 切换种族值/属性值显示
  function setStatMode(side, mode) {
    const key = side === 'attacker' ? 'atkStatMode' : 'defStatMode';
    state[key] = mode;
    updateFinalStats(side);
  }

  function showBaseStats(side) {
    const rootEl = document.querySelector(`.${side}-card`);
    if (rootEl) CommonUI.StatBox.showBaseValues(rootEl);
  }

  function showFinalStats(side) {
    updateFinalStats(side);
  }

  function updateTypeEffectiveness() {
    const defender = state.defPet;
    const el = document.getElementById('typeEffectiveness');
    el.classList.remove('success', 'danger', 'accent');
    if (!defender) { el.textContent = '×1.0'; return; }
    const mult = CalcEngine.calcTypeEff(state.skillAttr, defender);
    el.textContent = `×${mult}`;
    el.classList.add('accent');
  }

  function updateFinalPower() {
    const manualVal = (document.getElementById('finalPowerManual').value || '').trim();
    const fpEl = document.getElementById('finalPower');
    // 需要在手动模式下变灰的元素列表
    const dimLabels = document.querySelectorAll('.skill-card .accent-label, .skill-card .defense-mod-label, .skill-card .star-meteor-label');
    const sameTypeEl = document.getElementById('sameTypeBonus');
    const typeEffEl = document.getElementById('typeEffectiveness');
    const fpLabel = document.querySelector('.final-power-manual-label');
    if (manualVal !== '') {
      fpEl.textContent = parseInt(manualVal) || 0;
      // 最终威力标签和数值变红
      if (fpLabel) fpLabel.classList.add('manual-active');
      fpEl.classList.add('manual-active');
      const fpModLabel = document.getElementById('finalPowerLabel');
      if (fpModLabel) fpModLabel.classList.add('manual-active');
      // 其他相关 label 变灰
      dimLabels.forEach(l => l.classList.add('dimmed'));
      if (sameTypeEl) sameTypeEl.classList.add('dimmed');
      if (typeEffEl) typeEffEl.classList.add('dimmed');
      return;
    }
    // 恢复原色
    if (fpLabel) fpLabel.classList.remove('manual-active');
    fpEl.classList.remove('manual-active');
    const fpModLabel = document.getElementById('finalPowerLabel');
    if (fpModLabel) fpModLabel.classList.remove('manual-active');
    dimLabels.forEach(l => l.classList.remove('dimmed'));
    if (sameTypeEl) sameTypeEl.classList.remove('dimmed');
    if (typeEffEl) typeEffEl.classList.remove('dimmed');
    const basePower = parseInt(document.getElementById('basePower').value) || 0;
    const fixedBonus = parseInt(document.getElementById('fixedBonus').value) || 0;
    const percentBonus = parseFloat(document.getElementById('percentBonus').value) || 0;
    const buffPercent = parseFloat(document.getElementById('buff').value) || 0;
    const power = CalcEngine.calcBasePower(basePower, fixedBonus, percentBonus);

    const sameTypeBonus = CalcEngine.isSameType(state.atkPet, state.skillAttr) ? 1.25 : 1.0;
    const typeEff = CalcEngine.calcTypeEff(state.skillAttr, state.defPet);
    const buffMod = CalcEngine.calcBuffMod(buffPercent);

    const finalPower = Math.floor(power * sameTypeBonus * typeEff * buffMod);
    fpEl.textContent = finalPower;
  }

  /* ============================================================
   * 10. 主计算 & 结果渲染
   * ============================================================ */
  function calculate() {
    const atk = state.atkPet;
    const def = state.defPet;
    const stepsEl = document.getElementById('calculationSteps');

    // 同步输入到 state
    state.basePower = parseInt(document.getElementById('basePower').value) || 0;
    // 速度差技能：在 calculate 时重新计算威力
    if (SPEED_BASED_SKILLS.includes(state.currentSkillName)) {
      updateSpeedBasedPower();
    }
    state.fixedBonus = parseInt(document.getElementById('fixedBonus').value) || 0;
    state.percentBonus = parseFloat(document.getElementById('percentBonus').value) || 0;
    state.buff = parseFloat(document.getElementById('buff').value) || 0;
    state.comboCount = parseInt(document.getElementById('comboCount').value) || 1;
    state.debuffPercent = (document.getElementById('debuffPercent').value || '0').trim();
    state.defenseMod = (document.getElementById('defenseMod').value || '0').trim();
    state.starMeteor = parseInt(document.getElementById('starMeteor').value) || 0;
    state.finalPowerManual = (document.getElementById('finalPowerManual').value || '').trim();

    if (!atk || !def) {
      stepsEl.innerHTML = '<p class="process-step">请选择精灵和技能进行计算</p>';
      document.getElementById('damageValue').textContent = '0';
      document.getElementById('damagePercent').textContent = '0.0%';
      document.getElementById('remainingHP').textContent = '剩余生命: — / —';
      return;
    }

    const r = CalcEngine.calculate();
    if (!r) return;

    document.getElementById('damageValue').textContent = r.totalDamage;
    document.getElementById('damagePercent').textContent = `${r.damagePercent.toFixed(2)}%`;
    document.getElementById('remainingHP').textContent = `剩余生命: ${r.remainingHP} (${(r.remainingHP / r.defHP * 100).toFixed(2)}%)`;

    if (state.finalPowerManual === '') {
      document.getElementById('finalPower').textContent = r.skillFinalPower;
    }

    const steps = CalcEngine.buildSteps(r);
    stepsEl.innerHTML = steps.map(s => `<p class="process-step">${s}</p>`).join('');
    window._calcStepsText = steps.filter(s => !s.includes('step-blocked')).map(s => s.replace(/<[^>]*>/g, '')).join('\n');
  }

  /* ============================================================
   * 11. 属性按钮初始化 & 事件绑定
   * ============================================================ */
  function initAttributeButtons() {
    const btn = document.getElementById('skillAttrBtn');
    if (!btn) return;
    updateSkillAttrButton();
    btn.addEventListener('click', () => {
      const existing = document.getElementById('skillAttrDropdown');
      if (existing) { existing.remove(); return; }
      openSkillAttrPicker();
    });
  }

  function openSkillAttrPicker() {
    const btn = document.getElementById('skillAttrBtn');
    if (!btn) return;
    const current = state.skillAttr;

    const dropdown = document.createElement('div');
    dropdown.id = 'skillAttrDropdown';
    dropdown.className = 'skill-attr-dropdown';

    const renderItem = (type) => {
      const icon = getTypeIcon(type);
      const isActive = type === current;
      return `<div class="skill-attr-dropdown-item ${isActive ? 'active' : ''}" data-type="${type}" title="${type}">
        <img src="${icon}" class="skill-attr-dropdown-icon" alt="${type}" loading="lazy">
      </div>`;
    };

    let html = '';
    for (let i = 0; i < ALL_TYPES.length; i += 6) {
      html += '<div class="skill-attr-dropdown-row">';
      html += ALL_TYPES.slice(i, i + 6).map(renderItem).join('');
      html += '</div>';
    }
    dropdown.innerHTML = html;

    const rect = btn.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = Math.max(8, rect.left) + 'px';

    document.body.appendChild(dropdown);

    dropdown.querySelectorAll('.skill-attr-dropdown-item').forEach(el => {
      el.addEventListener('click', () => {
        state.skillAttr = el.dataset.type;
        updateSkillAttrButton();
        checkSameType();
        checkJmfzBonus();
        updateTypeEffectiveness();
        updateFinalPower();
        calculate();
        dropdown.remove();
      });
    });

    // 点击外部关闭
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        dropdown.remove();
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
  }

  function updateSkillAttrButton() {
    const iconEl = document.getElementById('skillAttrIcon');
    const textEl = document.getElementById('skillAttrText');
    if (iconEl) iconEl.src = getTypeIcon(state.skillAttr);
    if (textEl) textEl.textContent = state.skillAttr;
  }

  function bindEvents() {
    const atkInput = searchBoxes.attacker.input;
    const defInput = searchBoxes.defender.input;

    atkInput.addEventListener('click', function() { this.select(); });
    defInput.addEventListener('click', function() { this.select(); });

    atkInput.addEventListener('input', function(e) {
      const name = e.target.value.trim();
      const pet = RKData.getMonsters().find(m => getPetName(m) === name);
      if (pet) { state.atkPet = pet; onAttackerSelected(); }
    });
    defInput.addEventListener('input', function(e) {
      const name = e.target.value.trim();
      const pet = RKData.getMonsters().find(m => getPetName(m) === name);
      if (pet) { state.defPet = pet; onDefenderSelected(); }
    });

    // 交换攻守方图标：点击交换 + hover时切换图标
    const atkIconSrc = 'assets/icons/ui/icon_attacker.png';
    const defIconSrc = 'assets/icons/ui/icon_defender.png';
    const swapIconAtk = document.getElementById('swapIcon');
    const swapIconDef = document.getElementById('swapIconDef');
    if (swapIconAtk) {
      swapIconAtk.addEventListener('click', swapPokemons);
      swapIconAtk.addEventListener('mouseenter', () => { swapIconAtk.src = defIconSrc; });
      swapIconAtk.addEventListener('mouseleave', () => { swapIconAtk.src = atkIconSrc; });
    }
    if (swapIconDef) {
      swapIconDef.addEventListener('click', swapPokemons);
      swapIconDef.addEventListener('mouseenter', () => { swapIconDef.src = atkIconSrc; });
      swapIconDef.addEventListener('mouseleave', () => { swapIconDef.src = defIconSrc; });
    }

    // 种族值/属性值切换
    document.querySelectorAll('input[name="atkStatMode"]').forEach(radio => {
      radio.addEventListener('change', () => setStatMode('attacker', radio.value));
    });
    document.querySelectorAll('input[name="defStatMode"]').forEach(radio => {
      radio.addEventListener('change', () => setStatMode('defender', radio.value));
    });

    document.querySelectorAll('input[name="skillType"]').forEach(radio => {
      radio.addEventListener('change', () => {
        state.skillType = document.querySelector('input[name="skillType"]:checked').value;
        calculate();
      });
    });

    ['basePower','fixedBonus','percentBonus','comboCount','buff','debuffPercent','defenseMod','starMeteor','finalPowerManual'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => { updateFinalPower(); calculate(); });
    });

    document.querySelector('.attacker-card').addEventListener('click', e => handleModifierClick(e));
    document.querySelector('.attacker-card').addEventListener('contextmenu', e => handleModifierClick(e, false));
    document.querySelector('.defender-card').addEventListener('click', e => handleModifierClick(e));
    document.querySelector('.defender-card').addEventListener('contextmenu', e => handleModifierClick(e, false));

    document.getElementById('resetAttackerBtn').addEventListener('click', () => {
      resetModifiers('attacker'); updateFinalStats('attacker'); calculate();
    });
    document.getElementById('resetDefenderBtn').addEventListener('click', () => {
      resetModifiers('defender'); updateFinalStats('defender'); calculate();
    });
  }

  /* ============================================================
   * 12. 计算过程折叠 & 复制
   * ============================================================ */
  function initProcessToggle() {
    const copyBtn = document.getElementById('copyProcessBtn');
    if (!copyBtn) return;

    let isCopied = false;
    const originalHTML = copyBtn.innerHTML;
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isCopied) {
        copyBtn.innerHTML = originalHTML;
        copyBtn.style.background = '';
        copyBtn.style.color = '';
        isCopied = false;
        return;
      }
      try {
        if (window._calcStepsText) {
          await navigator.clipboard.writeText(window._calcStepsText);
          isCopied = true;
          copyBtn.innerHTML = '<img src="assets/icons/ui/icon_copy.png" alt="复制" class="button-icon"> ✓ 已复制';
          copyBtn.style.background = '#4caf50';
          copyBtn.style.color = '#fff';
        }
      } catch (err) { console.error('复制失败:', err); }
    });
    document.addEventListener('click', e => {
      if (isCopied && !copyBtn.contains(e.target)) {
        copyBtn.innerHTML = originalHTML;
        copyBtn.style.background = '';
        copyBtn.style.color = '';
        isCopied = false;
      }
    });
  }

  /* ============================================================
   * 14. 快捷访问模块：编队 / 历史 / 收藏
   * ============================================================ */
  function initQuickAccess() {
    renderQuickTeam();
    renderQuickHistory();
    renderQuickFav();
    const favGrid = document.getElementById('quick-fav-grid');
    if (favGrid) bindFavDropZone(favGrid);
  }

  /* 记录搜索过的精灵 */
  function addSearchedPet(pet) {
    if (!pet) return;
    const id = pet.id;
    // 木桩不加入历史记录
    if (id === 9001) return;
    // 去重后放到最前
    state.searchedPets = state.searchedPets.filter(pid => pid !== id);
    state.searchedPets.unshift(id);
    if (state.searchedPets.length > 16) state.searchedPets = state.searchedPets.slice(0, 16);
    saveSearchedPets();
    renderQuickHistory();
  }

  /* 生成单个精灵头像 HTML */
  function buildPetAvatarHtml(petId, options = {}) {
    const pet = RKData.getMonsterById(petId);
    if (!pet) return '';
    const name = getPetName(pet);
    let imgUrl = pet.image ? `assets/monster/images/${pet.image}` : '';
    // 木桩没有头像，使用普属性图标
    if (!imgUrl && pet.id === 9001) {
      imgUrl = 'assets/icons/type/normal.png';
    }
    const isFav = state.favPets.includes(petId);
    const favMark = '';
    // 角色标记：攻击方/防守方
    let roleMark = '';
    if (state.atkPet && state.atkPet.id === petId) {
      roleMark += '<span class="quick-pet-role-mark atk"></span>';
    }
    if (state.defPet && state.defPet.id === petId) {
      roleMark += '<span class="quick-pet-role-mark def"></span>';
    }
    const title = options.title || `${name} - 左键攻方/右键守方/中键收藏`;
    return `<div class="quick-pet-item" data-pet-id="${petId}" title="${title}" draggable="true">
      <div class="quick-pet-img-wrapper">
        ${imgUrl ? `<img src="${imgUrl}" alt="${name}" loading="lazy">` : `<span class="quick-pet-initial">${name.charAt(0)}</span>`}
        ${roleMark}
        ${favMark}
      </div>
      <span class="quick-pet-name">${name}</span>
    </div>`;
  }

  /* 绑定头像点击事件：左键攻方，右键守方，双击收藏 */
  function bindAvatarClicks(container) {
    const teamData = container._teamData || null;
    const tPetNatures = teamData ? (teamData.petNatures || {}) : {};
    const tPetIVs = teamData ? (teamData.petIVs || {}) : {};

    function getNatureForPet(petId) {
      // 优先从编队配置读取
      if (tPetNatures[petId]) {
        const n = {};
        ['attack','magic_attack','defense','magic_defense','hp','speed'].forEach(stat => {
          if (tPetNatures[petId][stat] === 1) n[stat] = 1;
          else if (tPetNatures[petId][stat] === 2) n[stat] = 2;
        });
        return n;
      }
      // 否则从 localStorage 读取
      const saved = loadPetConfig(petId);
      return saved.nature || {};
    }
    function getIvForPet(petId) {
      if (tPetIVs[petId]) {
        const iv = {};
        ['attack','magic_attack','defense','magic_defense','hp','speed'].forEach(stat => {
          iv[stat] = !!tPetIVs[petId][stat];
        });
        return iv;
      }
      const saved = loadPetConfig(petId);
      return saved.iv || {};
    }

    container.querySelectorAll('.quick-pet-item').forEach(el => {
      el.addEventListener('click', () => {
        const petId = parseInt(el.dataset.petId);
        const pet = RKData.getMonsterById(petId);
        if (!pet) return;
        const name = getPetName(pet);
        state.atkPet = pet;
        state.atkNature = getNatureForPet(petId);
        state.atkIV = getIvForPet(petId);
        searchBoxes.attacker.setValue(name);
        onAttackerSelected();
        syncModifierButtons('attacker');
        updateAllRoleMarks();
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const petId = parseInt(el.dataset.petId);
        const pet = RKData.getMonsterById(petId);
        if (!pet) return;
        const name = getPetName(pet);
        state.defPet = pet;
        state.defNature = getNatureForPet(petId);
        state.defIV = getIvForPet(petId);
        searchBoxes.defender.setValue(name);
        onDefenderSelected();
        syncModifierButtons('defender');
        updateAllRoleMarks();
      });
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          const petId = parseInt(el.dataset.petId);
          toggleFavPet(petId, el);
        }
      });
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) e.preventDefault();
      });
      // 拖拽：设置 dataTransfer
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/pet-id', el.dataset.petId);
        e.dataTransfer.effectAllowed = 'move';
      });
    });
  }

  /* 更新所有快捷头像上的角色标记（攻方/守方） */
  function updateAllRoleMarks() {
    const atkId = state.atkPet ? state.atkPet.id : null;
    const defId = state.defPet ? state.defPet.id : null;
    document.querySelectorAll('.quick-pet-item').forEach(el => {
      const wrapper = el.querySelector('.quick-pet-img-wrapper');
      if (!wrapper) return;
      const petId = parseInt(el.dataset.petId);
      // 移除旧标记
      wrapper.querySelectorAll('.quick-pet-role-mark').forEach(m => m.remove());
      // 添加新标记
      let mark = '';
      if (atkId === petId) {
        mark += '<span class="quick-pet-role-mark atk"></span>';
      }
      if (defId === petId) {
        mark += '<span class="quick-pet-role-mark def"></span>';
      }
      if (mark) {
        wrapper.insertAdjacentHTML('beforeend', mark);
      }
    });
  }

  /* 绑定收藏区 drop 事件 */
  function bindFavDropZone(container) {
    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      container.classList.add('drag-over');
    });
    container.addEventListener('dragleave', () => {
      container.classList.remove('drag-over');
    });
    container.addEventListener('drop', (e) => {
      e.preventDefault();
      container.classList.remove('drag-over');
      const petId = parseInt(e.dataTransfer.getData('text/pet-id'));
      if (petId) {
        if (!state.favPets.includes(petId)) {
          state.favPets.push(petId);
          saveFavPets();
        }
        renderQuickFav();
        // 更新源元素的星标
        const srcEl = document.querySelector(`.quick-pet-item[data-pet-id="${petId}"]`);
        if (srcEl) {
          const wrapper = srcEl.querySelector('.quick-pet-img-wrapper');
          if (wrapper && !wrapper.querySelector('.quick-pet-fav-mark')) {
            wrapper.insertAdjacentHTML('beforeend', '<span class="quick-pet-fav-mark">★</span>');
          }
        }
      }
    });
  }

  /* 切换精灵收藏状态 */
  function toggleFavPet(petId, el) {
    const idx = state.favPets.indexOf(petId);
    if (idx >= 0) {
      state.favPets.splice(idx, 1);
    } else {
      state.favPets.push(petId);
    }
    saveFavPets();
    // 更新当前元素的星标
    if (el) {
      const wrapper = el.querySelector('.quick-pet-img-wrapper');
      if (wrapper) {
        const existing = wrapper.querySelector('.quick-pet-fav-mark');
        if (state.favPets.includes(petId) && !existing) {
          wrapper.insertAdjacentHTML('beforeend', '<span class="quick-pet-fav-mark">★</span>');
        } else if (!state.favPets.includes(petId) && existing) {
          existing.remove();
        }
      }
    }
    // 如果当前在收藏标签页，重新渲染
    renderQuickFav();
  }

  function renderQuickTeam() {
    const container = document.getElementById('quick-team-grid');
    if (!container) return;
    let teamData = null;
    try {
      const raw = localStorage.getItem('rk_team_config');
      if (!raw) { container.innerHTML = '<p class="ext-placeholder">未找到编队数据</p>'; return; }
      const saved = JSON.parse(raw);
      const group = saved.groups && saved.groups.find(g => g.id === saved.activeGroupId);
      if (!group || !Array.isArray(group.team)) { container.innerHTML = '<p class="ext-placeholder">未找到编队数据</p>'; return; }
      teamData = group;
    } catch (e) { container.innerHTML = '<p class="ext-placeholder">编队数据解析失败</p>'; return; }

    const team = teamData.team;
    const leaderFormIds = teamData.leaderFormId || {};
    const petNatures = teamData.petNatures || {};
    const petIVs = teamData.petIVs || {};
    let html = '';
    for (let i = 0; i < team.length; i++) {
      const petId = team[i];
      if (!petId) continue;
      html += buildPetAvatarHtml(petId);
      // 如果选择了首领血脉，显示所有首领形态头像
      const bl = (teamData.detailBloodline || {})[petId] || '';
      if (bl === 'Leader') {
        const pet = RKData.getMonsterById(petId);
        if (pet) {
          // 找到所有同 dex_number 的首领形态
          const leaderForms = RKData.getMonsters().filter(m =>
            m.dex_number === pet.dex_number && m.is_leader_form
          ).sort((a, b) => a.id - b.id);
          leaderForms.forEach(lf => {
            html += buildPetAvatarHtml(lf.id, { title: `${getPetName(lf)} (首领形态) - 左键攻方/右键守方/双击收藏` });
          });
        }
      }
    }
    container.innerHTML = html || '<p class="ext-placeholder">编队为空</p>';
    bindAvatarClicks(container);

    // 存储编队数据供 importFromTeam 使用
    container._teamData = teamData;
  }

  function renderQuickHistory() {
    const container = document.getElementById('quick-history-grid');
    if (!container) return;
    if (state.searchedPets.length === 0) {
      container.innerHTML = '<p class="ext-placeholder">暂无历史，搜索选择精灵后会自动记录</p>';
      return;
    }
    let html = '';
    state.searchedPets.forEach(petId => {
      html += buildPetAvatarHtml(petId);
    });
    container.innerHTML = html;
    bindAvatarClicks(container);
  }

  function renderQuickFav() {
    const container = document.getElementById('quick-fav-grid');
    if (!container) return;
    if (state.favPets.length === 0) {
      container.innerHTML = '<p class="ext-placeholder">暂无收藏，中键点击头像或拖拽到此处可收藏精灵</p>';
      return;
    }
    let html = '';
    state.favPets.forEach(petId => {
      html += buildPetAvatarHtml(petId);
    });
    container.innerHTML = html;
    bindAvatarClicks(container);
  }

  function saveFavPets() {
    try { localStorage.setItem('rk_fav_pets', JSON.stringify(state.favPets)); } catch (e) {}
  }

  function loadFavPets() {
    try {
      const raw = localStorage.getItem('rk_fav_pets');
      if (raw) {
        const parsed = JSON.parse(raw);
        state.favPets = Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {}
  }

  function saveSearchedPets() {
    try { localStorage.setItem('rk_searched_pets', JSON.stringify(state.searchedPets)); } catch (e) {}
  }

  function loadSearchedPets() {
    try {
      const raw = localStorage.getItem('rk_searched_pets');
      if (raw) {
        const parsed = JSON.parse(raw);
        state.searchedPets = Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {}
  }

  /* ============================================================
   * 对外接口
   * ============================================================ */
  return { render, getState: () => state, getExtState: () => extState, CalcEngine };
})();
