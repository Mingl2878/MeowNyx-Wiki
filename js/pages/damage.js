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
  const SKILL_DEFAULTS = Object.freeze({
    skillType: 'attack', skillAttr: '普', basePower: 100, basePowerExpression: '', fixedBonus: 0,
    percentBonus: 0, buff: 0, comboCount: 1, debuffPercent: '0',
    defenseMod: '0', starMeteor: 0, finalPowerManual: '', currentSkillName: ''
  });
  const state = {
    ...SKILL_DEFAULTS,
    atkPet: null, defPet: null,
    atkNature: {}, atkIV: { attack: true, magic_attack: true },
    defNature: {}, defIV: { hp: true },
    favPets: [],           // 收藏的精灵
    searchedPets: []       // 搜索过的精灵ID列表（历史）
  };

  /* 安全表达式求值：支持 + - * / ( )，如 "30+40+50" → 120。
     非法字符或除零等异常时返回 fallback */
  function evalExpr(str, fallback) {
    const s = String(str == null ? '' : str).trim();
    if (s === '') return fallback;
    if (/^[+-]?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    if (!/^[0-9+\-*/().\s]+$/.test(s)) return fallback;
    try {
      const val = Function('"use strict"; return (' + s + ')')();
      return (typeof val === 'number' && isFinite(val)) ? val : fallback;
    } catch (e) { return fallback; }
  }
  // Display companion only: numerical basePower remains the single-release sum.
  // Recompute from the actual input on each calculation; never reuse a stale expression.
  function normalizePowerExpression(text, total) {
    if (typeof text !== 'string' || text.length > 128 || !/^[0-9]+(?:[+][0-9]+)+$/.test(text)) return '';
    const terms = text.split('+').map(Number), sum = terms.reduce((a,b) => a+b,0);
    return terms.every(Number.isSafeInteger) && Number.isSafeInteger(sum) && sum === Number(total) ? text : '';
  }
  function updateSpecialPower() {
    const move = RKData.getMoves().find(m => RKData.getMoveName(m) === state.currentSkillName);
    const stat = move?.power_formula === 'speed_diff' ? 'speed'
      : move?.power_formula === 'phy_def_diff' ? 'defense' : null;
    if (!stat || !state.atkPet || !state.defPet) return;
    const attackValue = getPetStat(state.atkPet, stat, state.atkNature[stat] || 0, !!state.atkIV[stat]);
    const defenseValue = getPetStat(state.defPet, stat, state.defNature[stat] || 0, !!state.defIV[stat]);
    const power = BattleMath.differencePower(attackValue - defenseValue);
    state.basePower = power;
    state.basePowerExpression = '';
    const input = document.getElementById('basePower');
    if (input) input.value = power;
  }

  function setSkillType(type) {
    state.skillType = type === 'magic_attack' ? 'magic_attack' : 'attack';
    const attack = document.getElementById('skillTypeAttack');
    const magic = document.getElementById('skillTypeMagic');
    if (attack) attack.checked = state.skillType === 'attack';
    if (magic) magic.checked = state.skillType === 'magic_attack';
  }

  let initialized = false;  // 是否已初始化过（用于跨页面切换时保留数据）
  let pageScrollTop = 0;
  let copyOutsideClick = null;
  let closeSkillPicker = null;
  let skillNoticeTimer = null;

  function showSkillNotice(text, detail) {
    clearTimeout(skillNoticeTimer);
    let notice = document.getElementById('skill-variant-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'skill-variant-notice';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      document.getElementById('ext-skill-icons')?.appendChild(notice);
    }
    notice.textContent = text;
    notice.title = detail || text;
    skillNoticeTimer = setTimeout(() => notice.remove(), 5000);
  }

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
      return BattleMath.basePower(basePower, fixedBonus, percentBonus);
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
      return BattleMath.buffMultiplier(buffPercent);
    },

    /** 减伤百分比解析 → debuffMod（支持 + - * / 表达式） */
    parseDebuffPercent(val) {
      const num = evalExpr(String(val).replace(/^d/i, ''), 0);
      return (100 - num) / 100;
    },

    /** 防御修正解析 → defenseMod（支持 + - * / 表达式，可带 d 前缀）
     *  正值: 防御 × (1 + num%)
     *  负值: 防御 ÷ (1 + |num|%)  ← 不是 × (1 - |num|%)
     */
    parseDefenseMod(val) {
      const num = evalExpr(String(val).replace(/^d/i, ''), 0);
      if (num >= 0) return 1 + num / 100;
      return 1 / (1 + Math.abs(num) / 100);
    },

    /** 星陨伤害计算： a² + 24a - 24 */
    calcStarMeteorBase(a) {
      return a * a + 24 * a - 24;
    },

    /** 计算最终威力 */
    calcFinalPower(basePower, fixedBonus, percentBonus, atkPet, defPet, skillAttr, buffPercent, manual) {
      if (manual !== null && manual !== '') return Math.round(evalExpr(manual, 0));
      const sameTypeBonus = this.isSameType(atkPet, skillAttr) ? 1.25 : 1.0;
      const typeEff = this.calcTypeEff(skillAttr, defPet);
      return BattleMath.finalPower(basePower, fixedBonus, percentBonus, sameTypeBonus, typeEff, buffPercent);
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
      const singleHit = BattleMath.normalDamage(atkStat, skillFinalPower, defStat, debuffMod);
      let totalDamage = singleHit * comboCount;

      // 非幻系攻击触发；追加伤害为幻系，使用相同37/41系数，但不叠本系/普通威力加成/连击。
      let starMeteorDamage = 0;
      let starMeteorBase = 0;
      const starMeteorLayers = state.starMeteor || 0;
      const starMeteorTriggered = starMeteorLayers > 0 && RKData.getTypeEn(skillAttr) !== 'Illusion';
      const starMeteorTypeEff = RKData.getTypeEff('Illusion', def.main_type?.name, def.sub_type?.name);
      if (starMeteorTriggered) {
        starMeteorBase = this.calcStarMeteorBase(starMeteorLayers);
        starMeteorDamage = BattleMath.starMeteorDamage(starMeteorBase, atkStat, defStat, buffMod, starMeteorTypeEff, debuffMod);
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
        starMeteorDamage, starMeteorLayers, starMeteorBase, starMeteorTypeEff, starMeteorTriggered,
        defHP, remainingHP, damagePercent,
        atkIVText: state.atkIV[atkStatKey] ? '✓个体' : '×个体',
        atkNatureText: state.atkNature[atkStatKey] === 1 ? '✓性格' : state.atkNature[atkStatKey] === 2 ? '负性格' : '×性格',
        defIVText: state.defIV[defStatKey] ? '✓个体' : '×个体',
        defNatureText: state.defNature[defStatKey] === 1 ? '✓性格' : state.defNature[defStatKey] === 2 ? '负性格' : '×性格',
        hpIVText: state.defIV.hp ? '✓个体' : '×个体',
        hpNatureText: state.defNature.hp === 1 ? '✓性格' : state.defNature.hp === 2 ? '负性格' : '×性格',
        basePower, basePowerExpression: normalizePowerExpression(state.basePowerExpression, basePower), fixedBonus, percentBonus, buffPercent,
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

      const displayedBase = r.basePowerExpression || r.basePower;
      let powerText = r.basePowerExpression ? `${displayedBase} = ${r.skillBasePower}` : r.skillBasePower.toString();
      if (r.fixedBonus !== 0 || r.percentBonus !== 0) {
        powerText = r.percentBonus !== 0 ? `(${displayedBase} + ${r.fixedBonus}) × ${(1 + r.percentBonus / 100).toFixed(2)} = ${r.skillBasePower}` : `${displayedBase} + ${r.fixedBonus} = ${r.skillBasePower}`;
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
      const normalDamage = r.totalDamage - r.starMeteorDamage;
      if (r.starMeteorDamage > 0) {
        steps.push(`⑤ 普通伤害 = ${dmgParts.join(' × ')} = <span class="danger-text">${normalDamage}</span>`);
        let starParts = [`${r.starMeteorLayers}层星陨印记（幻系，基础威力${r.starMeteorBase}）`, `(${r.atkStat} ÷ ${r.defStat})`, '0.9'];
        if (r.buffPercent !== 0) {
          if (r.buffPercent >= 0) starParts.push(`BUFF${r.buffMod.toFixed(2)}`);
          else starParts.push(`BUFF÷${(1 / r.buffMod).toFixed(2)}`);
        }
        if (r.starMeteorTypeEff !== 1.0) starParts.push(`幻系${r.starMeteorTypeEff < 1 ? '抵抗' : '克制'}${r.starMeteorTypeEff}`);
        if (r.hasDebuffMod) starParts.push(`减伤${r.debuffMod.toFixed(2)}`);
        steps.push(`　星陨追加伤害 = ${starParts.join(' × ')} = <span class="danger-text">${r.starMeteorDamage}</span>`);
        steps.push(`　最终伤害 = ${normalDamage} + ${r.starMeteorDamage} = <span class="danger-text">${r.totalDamage}</span>`);
      } else {
        steps.push(`⑤ 最终伤害 = ${dmgParts.join(' × ')} = <span class="danger-text">${r.totalDamage}</span>`);
      }
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
      <div class="card attacker-card" data-stat-policy="free">
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
      <div class="card defender-card" data-stat-policy="free">
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
              <button id="resetSkillSettingsBtn" class="reset-stats-btn" title="重置技能计算参数">↻</button>
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
                <input type="text" id="basePower" autocomplete="off" value="100">
              </div>
              <div class="input-group">
                <label class="accent-label">威力固定加成:</label>
                <input type="text" id="fixedBonus" autocomplete="off" value="0">
              </div>
              <div class="input-group">
                <label class="accent-label">威力百分比加成:</label>
                <div class="input-with-suffix">
                  <input type="text" id="percentBonus" autocomplete="off" value="0">
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
                  <input type="text" id="buff" autocomplete="off" value="0">
                  <span class="suffix">%</span>
                </div>
              </div>
              <div class="input-group">
                <label class="combo-label">连击数:</label>
                <input type="text" id="comboCount" autocomplete="off" value="1">
              </div>
              <div class="input-group">
                <label class="star-meteor-label">星陨印记:</label>
                <input type="text" id="starMeteor" autocomplete="off" value="0" placeholder="层数">
              </div>
            </div>
          </div>
          <div class="skill-section">
            <div class="input-row">
              <div class="input-group">
                <label class="defense-mod-label">防守方增减益:</label>
                <div class="input-with-suffix">
                  <input type="text" id="defenseMod" autocomplete="off" value="0" placeholder="">
                  <span class="suffix">%</span>
                </div>
              </div>
              <div class="input-group">
                <label class="debuff-percent-label">减伤百分比:</label>
                <div class="input-with-suffix">
                  <input type="text" id="debuffPercent" autocomplete="off" value="0">
                  <span class="suffix">%</span>
                </div>
              </div>
              <div class="input-group">
                <label class="final-power-manual-label">最终威力:</label>
                <input type="text" id="finalPowerManual" autocomplete="off" class="final-power-manual-input" value="" placeholder="">
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

    // 先按主技能表过滤；状态、防御、其他类别及未知技能都不进入攻击快捷卡片。
    const byName = new Map(RKData.getMoves().map(move => [RKData.getMoveName(move), move]));
    return validSkills.map(name => byName.get(name)).filter(RKData.isAttackMove).map(move => ({
      name: RKData.getMoveName(move), source: '过山车', type: RKData.getMoveCategoryZh(move),
      element: move.move_type?.localized?.zh || '普通'
    }));
  }

  /* 技能图标模块：显示攻击方可携带的攻击技能，点击填入威力和属性 */
  function renderSkillIcons() {
    const grid = document.getElementById('skill-icons-grid');
    if (!grid) return;
    const pet = state.atkPet;
    if (!pet) { grid.innerHTML = '<p class="ext-placeholder">请先选择攻击方精灵</p>'; return; }

    const wiki = RKData.getResolvedWikiData(pet);

    // 空基础技能表不能隐藏过山车组；三组共用同一预设入口。
    const attackSkills = (wiki?.skills || []).filter(s => s.type === '物攻' || s.type === '魔攻');

    // 传说攻击技能与普通攻击技能一并显示；仅血脉技能单独分组。
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
    const moveMap = Object.create(null);
    RKData.getMoves().forEach(mv => {
      const name = RKData.getMoveName(mv);
      if (name) moveMap[name] = mv;
    });

    // 生成单个技能图标的 HTML
    function buildSkillIconHtml(skill) {
      const mv = moveMap[skill.name];
      const variant = SkillVariants.forAttacker(mv, state.atkPet);
      const power = variant.showUnknownPower ? '?' : (variant.left?.basePowerExpression ?? variant.left?.basePower ?? mv?.power ?? 0);
      const escape = value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
      const help = escape(SkillVariants.tooltip(mv, state.atkPet));
      const iconSrc = `assets/monster/skill/${encodeURIComponent(skill.name)}.png`;
      const typeIcon = RKData.getTypeIcon(skill.element);
      return `<div class="skill-icon-item${skill.name === state.currentSkillName ? ' selected' : ''}" data-skill-name="${escape(skill.name)}" data-skill-type="${escape(skill.type)}" data-skill-element="${escape(skill.element)}" role="button" tabindex="0" aria-label="${help}" title="${help}">
        <div class="skill-icon-img-box">
          <img src="${escape(iconSrc)}" alt="${escape(skill.name)}" loading="lazy" onerror="this.style.visibility='hidden'">
          <span class="skill-icon-power">${power} </span>
          <img src="${escape(typeIcon)}" class="skill-icon-type" alt="${escape(skill.element)}" loading="lazy">
        </div>
        <span class="skill-icon-name">${escape(skill.name)}</span>
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
    grid.innerHTML = html || '<p class="ext-placeholder">无攻击技能</p>';

    // Both buttons and all source groups share one atomic skill selection.
    // Same-attribute presets preserve user inputs. Only an actual attribute
    // change against the existing special defender refreshes its bound auto-bonus.
    grid.querySelectorAll('.skill-icon-item').forEach(item => {
      const select = side => {
        const move = moveMap[item.dataset.skillName];
        const element = SkillVariants.describe(move).element;
        const short = RKData.getTypeShortZh(RKData.getTypeEn(element));
        const previousAttribute = RKData.getTypeEn(state.skillAttr);
        const result = SkillVariants.select(state, move, side, short);
        if (!result.applied) {
          showSkillNotice(item.dataset.skillName + '：未应用；请查看提示并手动设置。', result.notice);
          return; // No value, highlight, usage order, snapshot, or profile writes.
        }
        Object.assign(state, result.state);
        document.getElementById('basePower').value = state.basePowerExpression || state.basePower;
        document.getElementById('comboCount').value = state.comboCount;
        setSkillType(state.skillType);
        updateSkillAttrButton();
        grid.querySelectorAll('.skill-icon-item').forEach(i => i.classList.toggle('selected', i.dataset.skillName === state.currentSkillName));

        // 更新使用记忆：将此技能移到最前
        const skillName = item.dataset.skillName;
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
        if (state.defPet?.id === 501 && previousAttribute !== RKData.getTypeEn(state.skillAttr)) checkJmfzBonus();
        updateSpecialPower();
        updateTypeEffectiveness();
        updateFinalPower();
        calculate();
        saveSkillConfig(state.atkPet && state.atkPet.id);
        // Successful selection is already reflected in inputs/highlight. Do not
        // append explanatory power text beneath quick cards or keep an older warning.
        clearTimeout(skillNoticeTimer);
        document.getElementById('skill-variant-notice')?.remove();
      };
      item.addEventListener('click', () => select('left'));
      item.addEventListener('contextmenu', event => {
        event.preventDefault();
        select('right');
      });
      item.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        select(event.shiftKey ? 'right' : 'left');
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
    const scroller = document.querySelector('.calc-root.scroll-container');
    if (scroller) scroller.scrollTop = pageScrollTop;
  }

  /* 从已有 state 恢复 UI（页面切换回来时不重置数据） */
  function restoreFromState() {
    // 切页只还原显示，不执行“换精灵”的重置、记忆加载或特性覆盖。
    for (const side of ['attacker', 'defender']) {
      const pet = side === 'attacker' ? state.atkPet : state.defPet;
      if (!pet) continue;
      searchBoxes[side].setValue(getPetName(pet), pet);
      updateTypeBadges(side, pet);
      updateFinalStats(side);
      syncModifierButtons(side);
    }
    writeSkillInputs();
    checkSameType();
    updateTypeEffectiveness();
    updateFinalPower();
    calculate();
    renderSkillIcons();
    updateAllRoleMarks();
  }

  /* ============================================================
   * 6. 精灵搜索下拉框
   * ============================================================ */
  const searchBoxes = {};

  function initSearchDropdown(slotId, side) {
    const sb = CommonUI.createSearchBox({
      placeholder: '选择或搜索精灵',
      limit: 10,
      onSelect: pet => selectPet(side, pet),
      renderItem: CommonUI.monsterRenderItem()
    });
    searchBoxes[side] = sb;
    document.getElementById(slotId).appendChild(sb.wrapper);
  }

  /* Shared file only: failed writes remain in UserConfig's visible retry/close queue. */
  const STAT_KEYS = ['attack', 'magic_attack', 'defense', 'magic_defense', 'hp', 'speed'];
  function savePetConfig(petId, nature, iv, mode = 1) {
    const previous = loadPetConfig(petId) || {};
    const record = { ...previous, mode,
      nature: { ...(previous.nature || {}), ...Object.fromEntries(STAT_KEYS.map(k => [k, nature[k] || 0])) },
      iv: { ...(previous.iv || {}), ...Object.fromEntries(STAT_KEYS.map(k => [k, !!iv[k]])) } };
    void window.UserConfig.patch('rk_pet_configs', { [petId]: record }).then(ok => {
      if (ok && typeof FavoritePets !== 'undefined') FavoritePets.notify();
    });
  }

  function loadPetConfig(petId) {
    return window.UserConfig.getObject('rk_pet_configs', {})[petId];
  }

/* 技能设置记忆入口：有记忆则应用；从未保存过则清空（不沿用上一个精灵的参数） */
  function applySkillMemory(petId) {
    const skillCfg = loadSkillConfig(petId);
    if (skillCfg) {
      applySkillConfig(skillCfg);
    } else {
      resetSkillSettings();
      renderSkillIcons(); // 清除上个精灵的技能选中高亮
    }
  }
  const SKILL_CONFIG_KEYS = ['basePower','basePowerExpression','fixedBonus','percentBonus','buff','comboCount',
    'debuffPercent','defenseMod','starMeteor','finalPowerManual'];
  function skillSnapshot() {
    return Object.fromEntries(Object.keys(SKILL_DEFAULTS).map(key => [key, state[key]]));
  }
  function saveActiveSkill() {
    void window.UserConfig.patch('rk_damage_view', {
      skill: { ...window.UserConfig.getObject('rk_damage_view', {}).skill, ...skillSnapshot() }
    });
  }
  function saveSkillConfig(petId) {
    if (petId) void window.UserConfig.patch('rk_damage_skill_configs', {
      [petId]: { ...loadSkillConfig(petId), ...skillSnapshot() }
    });
    // Also remember edits made without an attacker. This is NOT per-pet memory.
    saveActiveSkill();
  }
  function loadSkillConfig(petId) {
    return petId ? window.UserConfig.getObject('rk_damage_skill_configs', {})[petId] || null : null;
  }
  function writeSkillInputs() {
    state.basePowerExpression = normalizePowerExpression(state.basePowerExpression, state.basePower);
    SKILL_CONFIG_KEYS.forEach(key => {
      const el = document.getElementById(key);
      if (el) el.value = key === 'basePower' ? state.basePowerExpression || state.basePower : state[key];
    });
    setSkillType(state.skillType);
    updateSkillAttrButton();
  }

  function applySkillConfig(cfg) {
    // 目标精灵缺少的旧字段使用默认值，绝不继承上一只精灵的残留。
    Object.assign(state, SKILL_DEFAULTS);
    for (const key of Object.keys(SKILL_DEFAULTS)) {
      if (cfg?.[key] == null) continue;
      if (cfg[key] === '' && !['finalPowerManual', 'currentSkillName', 'basePowerExpression'].includes(key)) continue;
      state[key] = cfg[key];
    }
    writeSkillInputs();
    checkSameType();
    updateTypeEffectiveness();
    updateFinalPower();
    calculate();
  }

  function petConfiguration(petId, teamData = null) {
    const saved = teamData
      ? { nature: teamData.petNatures?.[petId] || {}, iv: teamData.petIVs?.[petId] || {} }
      : loadPetConfig(petId);
    return PetConfiguration.resolve(RKData.getMonsterById(petId), saved);
  }

  let selectionTeams = { attacker: null, defender: null };
  function readSelection() {
    return window.UserConfig.getObject('rk_damage_selection', {});
  }
  function saveSelection(fields) {
    void window.UserConfig.patch('rk_damage_selection', fields);
  }
  function selectionTeam(groupId, petId) {
    if (!groupId) return null;
    try {
      const group = JSON.parse(localStorage.getItem('rk_team_config') || '{}').groups?.find(group => group.id === groupId);
      return group?.team?.includes(petId) ? group : null;
    } catch (_) { return null; }
  }

  function selectPet(side, pet, teamData = null) {
    if (!pet) return;
    const config = petConfiguration(pet.id, teamData);
    if (side === 'attacker') {
      // User edits already save per-pet memory. Role changes save only the active view.
      state.atkPet = pet; state.atkNature = config.nature; state.atkIV = config.iv;
      applySkillMemory(pet.id);
      onAttackerSelected();
      // 保留机幕方舟独立覆盖规则；仅换精灵时应用，不在切页时重置。
      checkJmfzBonus();
      calculate();
    } else {
      state.defPet = pet; state.defNature = config.nature; state.defIV = config.iv;
      onDefenderSelected();
    }
    searchBoxes[side]?.setValue(getPetName(pet), pet);
    syncModifierButtons(side);
    renderSkillIcons();
    selectionTeams[side] = teamData?.id || null;
    saveSelection({ [side]: pet.id, [side + 'Team']: selectionTeams[side] });
    saveActiveSkill();
  }

  /* ============================================================
   * 7. 默认精灵 & 组队头像
   * ============================================================ */
  function initDefaultPets() {
    const selection = readSelection();
    const atkPet = selection.attacker == null ? null : RKData.getMonsterById(Number(selection.attacker));
    if (atkPet) {
      state.atkPet = atkPet;
      const team = selectionTeam(selection.attackerTeam, atkPet.id);
      selectionTeams.attacker = team?.id || null;
      const saved = petConfiguration(atkPet.id, team);
      state.atkNature = saved.nature; state.atkIV = saved.iv;
    }
    // Process startup alone chooses the dummy. Route navigation uses restoreFromState.
    state.defPet = RKData.getMonsterById(9001) || null;
    selectionTeams.defender = null;
    if (state.defPet) {
      const saved = petConfiguration(state.defPet.id);
      state.defNature = saved.nature; state.defIV = saved.iv;
    }
    const active = window.UserConfig.getObject('rk_damage_view', {}).skill;
    // Populate inputs BEFORE any calculation reads the new DOM's 100 placeholders.
    applySkillConfig(active || loadSkillConfig(atkPet?.id) || SKILL_DEFAULTS);
    restoreFromState();
  }

  /* ============================================================
   * 8. 修正按钮 & 同步
   * ============================================================ */
  function syncModifierButtons(side) {
    const nature = side === 'attacker' ? state.atkNature : state.defNature;
    const iv = side === 'attacker' ? state.atkIV : state.defIV;
    const rootEl = document.querySelector(`.${side}-card`);
    CommonUI.StatBox.syncButtons(rootEl, nature, iv);
    const modeKey = side === 'attacker' ? 'atkStatMode' : 'defStatMode';
    document.querySelectorAll(`input[name="${modeKey}"]`).forEach(radio => { radio.checked = radio.value === state[modeKey]; });
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
    updateFinalStats(side);
    updateSpecialPower();
    calculate();
    // 保存性格/个体配置
    const pet = side === 'attacker' ? state.atkPet : state.defPet;
    if (pet) {
      const nature = side === 'attacker' ? state.atkNature : state.defNature;
      const iv = side === 'attacker' ? state.atkIV : state.defIV;
      selectionTeams[side] = null;
      savePetConfig(pet.id, nature, iv);
      saveSelection({ [side + 'Team']: null });
      saveActiveSkill();
    }
  }

  function resetModifiers(side) {
    const pet = side === 'attacker' ? state.atkPet : state.defPet;
    if (!pet) return;
    const config = PetConfiguration.defaults(pet);
    if (side === 'attacker') { state.atkNature = config.nature; state.atkIV = config.iv; }
    else { state.defNature = config.nature; state.defIV = config.iv; }
    selectionTeams[side] = null;
    savePetConfig(pet.id, config.nature, config.iv, 0);
    saveSelection({ [side + 'Team']: null });
    syncModifierButtons(side);
    updateFinalStats(side); calculate(); saveActiveSkill();
  }

  function resetSkillSettings() {
    applySkillConfig(SKILL_DEFAULTS);
    renderSkillIcons();
  }

  function swapPokemons() {
    if (!state.atkPet || !state.defPet) return;
    [state.atkPet, state.defPet] = [state.defPet, state.atkPet];
    [state.atkNature, state.defNature] = [state.defNature, state.atkNature];
    [state.atkIV, state.defIV] = [state.defIV, state.atkIV];
    [state.atkStatMode, state.defStatMode] = [state.defStatMode, state.atkStatMode];
    [selectionTeams.attacker, selectionTeams.defender] = [selectionTeams.defender, selectionTeams.attacker];
    applySkillMemory(state.atkPet.id);
    checkJmfzBonus();
    restoreFromState();
    saveSelection({ attacker: state.atkPet.id, defender: state.defPet.id,
      attackerTeam: selectionTeams.attacker, defenderTeam: selectionTeams.defender });
    saveActiveSkill();
  }

  /* ============================================================
   * 9. 精灵选中 & 属性更新
   * ============================================================ */
  function onAttackerSelected() {
    const pet = state.atkPet;
    if (!pet) return;

    updateTypeBadges('attacker', pet);
    updateFinalStats('attacker');

    // 攻击类型已由目标精灵的技能记忆/默认设置确定，不再只修改单选按钮。
    setSkillType(state.skillType);
    checkSameType();
    updateSpecialPower();
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
    updateSpecialPower();
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
      fpEl.textContent = Math.round(evalExpr(manualVal, 0));
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
    const basePower = Math.round(evalExpr(document.getElementById('basePower').value, 0));
    const fixedBonus = Math.round(evalExpr(document.getElementById('fixedBonus').value, 0));
    const percentBonus = evalExpr(document.getElementById('percentBonus').value, 0);
    const buffPercent = evalExpr(document.getElementById('buff').value, 0);
    fpEl.textContent = CalcEngine.calcFinalPower(basePower, fixedBonus, percentBonus,
      state.atkPet, state.defPet, state.skillAttr, buffPercent, null);
  }

  /* ============================================================
   * 10. 主计算 & 结果渲染
   * ============================================================ */
  function calculate() {
    const atk = state.atkPet;
    const def = state.defPet;
    const stepsEl = document.getElementById('calculationSteps');

    // 同步输入到 state（支持 + - * / 表达式，如 30+40+50）
    const powerInput = String(document.getElementById('basePower').value).trim();
    state.basePower = Math.round(evalExpr(powerInput, 0));
    state.basePowerExpression = normalizePowerExpression(powerInput, state.basePower);
    // 保留特殊技能自动覆盖；依据主技能表分别比较速度或物防。
    updateSpecialPower();
    state.fixedBonus = Math.round(evalExpr(document.getElementById('fixedBonus').value, 0));
    state.percentBonus = evalExpr(document.getElementById('percentBonus').value, 0);
    state.buff = evalExpr(document.getElementById('buff').value, 0);
    state.comboCount = Math.max(1, Math.round(evalExpr(document.getElementById('comboCount').value, 1)));
    state.debuffPercent = (document.getElementById('debuffPercent').value || '0').trim();
    state.defenseMod = (document.getElementById('defenseMod').value || '0').trim();
    state.starMeteor = Math.max(0, Math.round(evalExpr(document.getElementById('starMeteor').value, 0)));
    state.finalPowerManual = (document.getElementById('finalPowerManual').value || '').trim();
    // 注意：此处不保存技能配置记忆——calculate 会在选中精灵/恢复页面时被触发，
    // 若在此保存会把当前默认值覆盖进该精灵的记忆；保存点在用户输入事件与技能图标点击处。

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
      if (existing) { if (closeSkillPicker) closeSkillPicker(); else existing.remove(); return; }
      openSkillAttrPicker();
    });
  }

  function openSkillAttrPicker() {
    if (closeSkillPicker) closeSkillPicker();
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

    document.body.appendChild(dropdown);
    CommonUI.positionAnchoredLayer(btn, dropdown);
    closeSkillPicker = CommonUI.bindAnchoredLayer(btn, dropdown, () => {
      dropdown.remove();
      closeSkillPicker = null;
    });

    dropdown.querySelectorAll('.skill-attr-dropdown-item').forEach(el => {
      el.addEventListener('click', () => {
        state.skillAttr = el.dataset.type;
        updateSkillAttrButton();
        checkSameType();
        checkJmfzBonus();
        updateTypeEffectiveness();
        updateFinalPower();
        calculate();
        saveSkillConfig(state.atkPet && state.atkPet.id);
        if (closeSkillPicker) closeSkillPicker();
      });
    });

    // 滚动、缩放、窗口变化、Escape 和外部点击由公共弹层生命周期处理。
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
      if (pet) selectPet('attacker', pet);
    });
    defInput.addEventListener('input', function(e) {
      const name = e.target.value.trim();
      const pet = RKData.getMonsters().find(m => getPetName(m) === name);
      if (pet) selectPet('defender', pet);
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
        setSkillType(radio.value);
        calculate();
        saveSkillConfig(state.atkPet && state.atkPet.id);
      });
    });

    ['basePower','fixedBonus','percentBonus','comboCount','buff','debuffPercent','defenseMod','starMeteor','finalPowerManual'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => {
        updateFinalPower();
        calculate(); // 先同步 state
        // 用户手动输入：保存为该攻击方精灵的技能设置记忆（须在 state 同步后）
        saveSkillConfig(state.atkPet && state.atkPet.id);
      });
    });

    document.querySelector('.attacker-card').addEventListener('click', e => handleModifierClick(e));
    document.querySelector('.attacker-card').addEventListener('contextmenu', e => handleModifierClick(e, false));
    document.querySelector('.defender-card').addEventListener('click', e => handleModifierClick(e));
    document.querySelector('.defender-card').addEventListener('contextmenu', e => handleModifierClick(e, false));

    document.getElementById('resetAttackerBtn').addEventListener('click', () => {
      resetModifiers('attacker');
    });
    document.getElementById('resetDefenderBtn').addEventListener('click', () => {
      resetModifiers('defender');
    });
    document.getElementById('resetSkillSettingsBtn').addEventListener('click', () => {
      resetSkillSettings();
      saveSkillConfig(state.atkPet && state.atkPet.id);
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
    if (copyOutsideClick) document.removeEventListener('click', copyOutsideClick);
    copyOutsideClick = e => {
      if (isCopied && !copyBtn.contains(e.target)) {
        copyBtn.innerHTML = originalHTML;
        copyBtn.style.background = '';
        copyBtn.style.color = '';
        isCopied = false;
      }
    };
    document.addEventListener('click', copyOutsideClick);
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

  /* 绑定头像点击事件：左键攻方，右键守方，中键收藏 */
  function bindAvatarClicks(container) {
    const teamData = container._teamData || null;
    container.querySelectorAll('.quick-pet-item').forEach(el => {
      el.addEventListener('click', () => {
        const petId = parseInt(el.dataset.petId);
        const pet = RKData.getMonsterById(petId);
        if (!pet) return;
        selectPet('attacker', pet, teamData);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const petId = parseInt(el.dataset.petId);
        const pet = RKData.getMonsterById(petId);
        if (!pet) return;
        selectPet('defender', pet, teamData);
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
            html += buildPetAvatarHtml(lf.id, { title: `${getPetName(lf)} (首领形态) - 左键攻方/右键守方/中键收藏` });
          });
        }
      }
    }
    container.innerHTML = html || '<p class="ext-placeholder">编队为空</p>';
    // 必须先提供本编队的数据，再绑定读取它的事件。
    container._teamData = teamData;
    bindAvatarClicks(container);
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
    try {
      localStorage.setItem('rk_fav_pets', JSON.stringify(state.favPets));
      if (typeof FavoritePets !== 'undefined') FavoritePets.notify();
    } catch (e) {}
  }

  function loadFavPets() {
    if (typeof FavoritePets !== 'undefined') { state.favPets = FavoritePets.getDamageIds(); return; }
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
  function onLeave() {
    const scroller = document.querySelector('.calc-root.scroll-container');
    if (scroller) pageScrollTop = scroller.scrollTop;
    if (copyOutsideClick) document.removeEventListener('click', copyOutsideClick);
    copyOutsideClick = null;
    if (closeSkillPicker) closeSkillPicker();
    clearTimeout(skillNoticeTimer);
    document.getElementById('skill-variant-notice')?.remove();
    Object.values(searchBoxes).forEach(box => box.destroy?.());
  }

  function reloadPersonalDefaults() {
    for (const [side, prefix] of [['attacker','atk'],['defender','def']]) {
      const pet = state[prefix + 'Pet'];
      if (!pet || selectionTeams[side]) continue;
      const config = petConfiguration(pet.id);
      state[prefix + 'IV'] = config.iv;
      state[prefix + 'Nature'] = config.nature;
    }
    // Keep skills, manual records and team-source values untouched; inactive pages
    // use the updated in-memory IV/nature on restoreFromState when revisited.
    if (document.querySelector('.attacker-card') && document.getElementById('basePower')) {
      syncModifierButtons('attacker'); syncModifierButtons('defender');
      updateFinalStats('attacker'); updateFinalStats('defender');
      updateFinalPower(); calculate();
    }
  }
  if (typeof window !== 'undefined') window.addEventListener?.('petdefaultsreset', reloadPersonalDefaults);
  return { render, onLeave, getState: () => state, CalcEngine };
})();
