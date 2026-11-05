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
    percentBonus: 0, buff: 0, comboCount: 1, skillInputKind: 'power', skillInputValue: '', debuffPercent: '0',
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

  // A battle handoff is a session-only overlay, never a personal/team record.
  const battleSides = { attacker: null, defender: null };
  let battleReturn = null, battleRevision = -1;
  let battleSkillMemory = {};
  let battleLooseLevels = { attacker: null, defender: null };
  // Derived species growth is displayed in buff, but never baked into saved manual buff.
  let appliedFireAttackBonus = 0;
  let appliedAbuAttackBonus = 0, nativeAbuBuffOverridden = false, battleAbuBuffOverridden = false;
  let abuBlankSuspended = false; // A blank read drops tracking without writing an override marker.
  const ABU_DESCRIPTIONS = Object.freeze([
    '己方精灵每使用1次能耗为3的技能，自己入场前等级+2。在战斗中每提升1级，获得物攻+5%，低于80级时受到伤害+30%。',
    '在战斗中每提升1级，获得物攻+5%，低于80级时受到伤害+30%。'
  ]);
  function nativeAbu(pet) {
    const trait = pet?.trait?.localized?.zh;
    return pet?.id === 623 && trait?.name === '圣龙的守护' &&
      ABU_DESCRIPTIONS.includes(String(trait.description || '').replace(/\s/g, ''));
  }
  function levelEffectMode(side) {
    const pet = levelPet(side);
    if (nativeAbu(pet)) return 'abu';
    if (pet?.id === 619) return 'ming';
    // Snapshot wolves keep their own species, never borrow the personal menu's mode.
    return !battleSides[side] && [595, 616, 617].includes(pet?.id) && isWolf(pet) ? wolfRecord(side).mode : '';
  }
  function abuOverridden() {
    if (isBattleSimulation()) return battleAbuBuffOverridden;
    return nativeAbu(state.atkPet) ? nativeAbuBuffOverridden : isWolf(state.atkPet) && wolfRecord('attacker').abuBuffOverridden === true;
  }
  function setAbuOverridden(value) {
    if (isBattleSimulation()) battleAbuBuffOverridden = value;
    else if (nativeAbu(state.atkPet)) nativeAbuBuffOverridden = value;
    else if (isWolf(state.atkPet)) wolfRecord('attacker').abuBuffOverridden = value;
  }
  function prepareAbuBuff({ mode = levelEffectMode('attacker'), level = effectiveLevel('attacker'), type = state.skillType, resume = false, fromState = false } = {}) {
    if (mode !== 'abu' && levelEffectMode('attacker') !== 'abu' && !appliedAbuAttackBonus) return null;
    const input = document.getElementById('buff');
    const text = String(!fromState && input ? input.value : state.buff), blank = text.trim() === '';
    const current = SkillSimulation.evaluate(buffInputExpression(text));
    const previousBonus = blank ? 0 : appliedAbuAttackBonus;
    const suspended = blank || abuBlankSuspended;
    const bonus = mode === 'abu' && type === 'attack' && (resume || (!suspended && !abuOverridden())) ? Math.max(0, level - 60) * 5 : 0;
    const total = buffWithFireAttack(bonus, current, previousBonus);
    return { total, bonus, suspended, resume };
  }
  function commitAbuBuff(plan) {
    if (!plan) return;
    if (plan.resume) setAbuOverridden(false);
    else if (plan.suspended) setAbuOverridden(true); // Explicit action, not an ordinary calculation read.
    abuBlankSuspended = false;
    state.buff = plan.total; appliedAbuAttackBonus = plan.bonus;
    const input = document.getElementById('buff'); if (input) input.value = state.buff;
  }
  function preflightAbuBuff(options) {
    try { return { ok: true, plan: prepareAbuBuff(options) }; }
    catch (error) {
      const input = document.getElementById('buff');
      if (input) { input.setAttribute('aria-invalid', 'true'); input.title = error.message; }
      return { ok: false };
    }
  }
  const isBattleSimulation = () => !!(battleSides.attacker || battleSides.defender);
  function battleStat(side, stat) {
    const prefix = side === 'attacker' ? 'atk' : 'def', pet = state[prefix + 'Pet'];
    const overlay = battleSides[side], nature = state[prefix + 'Nature'][stat] || 0;
    if (overlay) {
      const iv = Object.hasOwn(overlay.iv, stat) ? overlay.iv[stat] : state[prefix + 'IV'][stat] ? 60 : 0;
      return BattleMath.statFromEffectiveIV(getBaseStat(pet, stat), stat, nature, iv, effectiveLevel(side));
    }
    return getPetStat(pet, stat, nature, !!state[prefix + 'IV'][stat], effectiveLevel(side));
  }
  function battleIVText(side, stat) {
    const overlay = battleSides[side], prefix = side === 'attacker' ? 'atk' : 'def';
    if (overlay && Object.hasOwn(overlay.iv, stat)) return `个体${overlay.iv[stat]}（${overlay.manualIV[stat] ? '临时' : '快照'}）`;
    return (state[prefix + 'IV'][stat] ? '✓个体' : '×个体') + (overlay ? '（手动假设）' : '');
  }
  function beginBattleSimulation() {
    if (battleReturn) return;
    const keys = [...Object.keys(SKILL_DEFAULTS), 'atkPet', 'defPet', 'atkNature', 'defNature', 'atkIV', 'defIV', 'atkStatMode', 'defStatMode'];
    battleReturn = { state: Object.fromEntries(keys.map(k => [k, /(?:Nature|IV)$/.test(k) ? { ...state[k] } : state[k]])),
      teams: { ...selectionTeams }, bonuses: JSON.parse(JSON.stringify(bonusOverrides)), jmfz: jmfzActive,
      fireAttackBonus: appliedFireAttackBonus, abuAttackBonus: appliedAbuAttackBonus,
      nativeAbuBuffOverridden, battleAbuBuffOverridden, abuBlankSuspended,
      wolves: Object.fromEntries(['attacker', 'defender'].map(side => [side, new Map([...wolfLevels[side]].map(([id, record]) => [id, { ...record }]))])) };
    battleSkillMemory = {}; battleLooseLevels = { attacker: null, defender: null };
    battleAbuBuffOverridden = false; abuBlankSuspended = false;
    if (appliedFireAttackBonus) setFireAttackBonus(0); // Personal growth is not a battle-record fact or a temporary counter.
  }
  function endBattleSimulation() {
    closeLevelMenu?.();
    const previous = battleReturn;
    battleSides.attacker = null; battleSides.defender = null; battleReturn = null; battleSkillMemory = {};
    battleLooseLevels = { attacker: null, defender: null };
    if (previous) {
      wolfLevels.attacker = previous.wolves.attacker; wolfLevels.defender = previous.wolves.defender;
      Object.assign(state, previous.state); selectionTeams = previous.teams;
      Object.assign(bonusOverrides, previous.bonuses); jmfzActive = previous.jmfz;
      appliedFireAttackBonus = previous.fireAttackBonus; appliedAbuAttackBonus = previous.abuAttackBonus;
      nativeAbuBuffOverridden = previous.nativeAbuBuffOverridden; battleAbuBuffOverridden = previous.battleAbuBuffOverridden;
      abuBlankSuspended = previous.abuBlankSuspended;
      if (document.getElementById('basePower')) restoreFromState(false);
    }
  }
  function applyBattlePet(side, battleSide, instanceId) {
    const api = window.BattleRecordsClient, record = api?.getRecord();
    const source = record?.sides?.[battleSide]?.pets?.find(p => p.instanceId === instanceId);
    const pet = source && RKData.getMonsterById(source.monsterId);
    if (!['attacker', 'defender'].includes(side) || !pet) return false;
    closeReductionPicker?.(); closeLevelMenu?.();
    if (battleRevision !== api.getRevision()) { endBattleSimulation(); battleRevision = api.getRevision(); }
    beginBattleSimulation();
    const config = petConfiguration(pet.id), values = api.snapshotValues(source), prefix = side === 'attacker' ? 'atk' : 'def';
    state[prefix + 'Pet'] = pet; state[prefix + 'IV'] = { ...config.iv }; state[prefix + 'Nature'] = { ...config.nature, ...values.nature };
    for (const [stat, value] of Object.entries(values.iv)) state[prefix + 'IV'][stat] = value > 0;
    battleSides[side] = { source, battleSide, iv: { ...values.iv }, nature: { ...values.nature }, manualIV: {}, manualNature: {},
      level: { slider: 60, manual: String(values.level ?? (isWolf(pet) ? 60 : speciesLevelConfig(pet).enabled ? speciesLevelConfig(pet).defaultLevel : 60)) }, unknownLevel: values.level === null };
    selectionTeams[side] = null;
    if (side === 'attacker') { battleAbuBuffOverridden = false; applySkillMemory(pet.id); applyTraitPowerDefaults(true); onAttackerSelected('battle'); }
    else onDefenderSelected('battle');
    checkJmfzBonus(); searchBoxes[side]?.setValue(getPetName(pet), pet);
    syncModifierButtons(side); updateFinalStats(side); renderSkillIcons(); calculate(); renderBattleSnapshotPanel();
    return true;
  }
  function setBattleValue(side, kind, stat, value) {
    const overlay = battleSides[side], api = window.BattleRecordsClient;
    if (!overlay || !STAT_KEYS.includes(stat) || !['iv','nature'].includes(kind) || !api?.validValue(kind, value)) return false;
    const prefix = side === 'attacker' ? 'atk' : 'def';
    if (kind === 'iv') { overlay.iv[stat] = value; overlay.manualIV[stat] = true; state[prefix + 'IV'][stat] = value > 0; }
    else { overlay.nature[stat] = value; overlay.manualNature[stat] = true; state[prefix + 'Nature'][stat] = value; }
    syncModifierButtons(side); updateFinalStats(side); calculate(); return true;
  }
  function renderBattleSnapshotPanel() {
    const api = window.BattleRecordsClient, host = document.getElementById('battle-snapshot-panel');
    if (!host || !api) return;
    if (battleRevision !== api.getRevision()) { endBattleSimulation(); battleRevision = api.getRevision(); }
    const record = api.getRecord(); host.hidden = !record;
    if (!record) { host.replaceChildren(); return; }
    const esc = api.escape, name = pet => { const species = RKData.getMonsterById(pet.monsterId); return species ? getPetName(species) : '未匹配精灵'; };
    host.innerHTML = `<div class="card-body"><div class="battle-snapshot-heading"><strong>本局阵容 · 临时试算</strong><button type="button" class="btn battle-snapshot-exit">退出试算</button></div>
      <p class="battle-note">已确认参数单独应用；未知字段使用当前个人设置作手动假设。试算期间个体、等级、技能调整不写回个人/编队，普通搜索或历史选择会退出试算。</p>
      ${['me','enemy'].map(from => `<div class="battle-roster"><strong>${from === 'me' ? '我方' : '敌方'}</strong>${(record.sides[from]?.pets || []).map((pet,index) => `<div class="battle-roster-pet"><span>${esc(name(pet))}</span><button type="button" class="btn" data-from="${from}" data-index="${index}" data-battle-side="attacker" ${RKData.getMonsterById(pet.monsterId) ? '' : 'disabled'}>攻</button><button type="button" class="btn" data-from="${from}" data-index="${index}" data-battle-side="defender" ${RKData.getMonsterById(pet.monsterId) ? '' : 'disabled'}>守</button></div>`).join('')}</div>`).join('')}
      <div class="battle-snapshot-status" role="status">${isBattleSimulation() ? '当前为本局临时试算；退出后恢复进入前参数。' : '请选择本局精灵作为攻击方或防守方。'}</div>
      ${['attacker','defender'].filter(side => battleSides[side]).map(side => {
        const overlay = battleSides[side], prefix = side === 'attacker' ? 'atk' : 'def';
        return `<details class="battle-snapshot-values"><summary>${side === 'attacker' ? '攻击方' : '防守方'}：${esc(name(overlay.source))} · 个体/性格${overlay.unknownLevel ? ' · 等级为手动假设' : ''}</summary><p class="battle-note">个体使用有效值0—60（显示+10对应60）；改选候选只作本次手动试算。</p>${STAT_KEYS.map(stat => {
          const ivKnown = Object.hasOwn(overlay.iv,stat), natKnown = Object.hasOwn(overlay.nature,stat), iv = ivKnown ? overlay.iv[stat] : state[prefix+'IV'][stat] ? 60 : 0;
          const possibilities = ['iv','nature'].map(kind => { const values = api.candidates(overlay.source,stat,kind); return values.length > 1 ? `${kind==='iv'?'个体':'性格'}候选：${values.map(v=>kind==='iv'?v:['中性','正','负'][v]).join('/')}` : ''; }).filter(Boolean).join('；');
          return `<div class="battle-snapshot-stat"><label>${api.LABELS[stat]}个体<input type="number" min="0" max="60" step="1" value="${iv}" data-value-side="${side}" data-value-kind="iv" data-stat="${stat}"></label><label>性格<select data-value-side="${side}" data-value-kind="nature" data-stat="${stat}">${[0,1,2].map(v=>`<option value="${v}" ${v===(state[prefix+'Nature'][stat]||0)?'selected':''}>${['中性','正性格','负性格'][v]}</option>`).join('')}</select></label><small>${ivKnown && !overlay.manualIV[stat] ? '个体快照' : '个体手动假设'} / ${natKnown && !overlay.manualNature[stat] ? '性格快照' : '性格手动假设'}${possibilities ? '；'+possibilities : ''}</small></div>`;
        }).join('')}</details>`;
      }).join('')}</div>`;
    host.querySelector('.battle-snapshot-exit').addEventListener('click', () => { endBattleSimulation(); renderBattleSnapshotPanel(); });
    host.querySelectorAll('[data-battle-side]').forEach(button => button.addEventListener('click', () => {
      const pet = record.sides[button.dataset.from].pets[Number(button.dataset.index)];
      applyBattlePet(button.dataset.battleSide, button.dataset.from, pet.instanceId);
    }));
    host.querySelectorAll('[data-value-kind]').forEach(input => input.addEventListener('change', () => {
      if (input.value === '' || !setBattleValue(input.dataset.valueSide,input.dataset.valueKind,input.dataset.stat,Number(input.value))) {
        input.setAttribute('aria-invalid','true'); host.querySelector('[role="status"]').textContent = '请输入有效个体0—60整数或已列出的性格。';
      } else { input.removeAttribute('aria-invalid'); host.querySelector('[role="status"]').textContent = '已应用临时手动参数；未修改战报事实或个人配置。'; }
    }));
  }

  // Side-specific preferences are separate from personal IV/nature and skill memory.
  const LEVEL_STEPS = Object.freeze([1, 9, 19, 29, 39, 49, 59, 69, 79, 89, 99]);
  const levelPet = side => state[side === 'attacker' ? 'atkPet' : 'defPet'];
  const wolfLevels = { attacker: new Map(), defender: new Map() };
  const isWolf = pet => typeof PetLevels !== 'undefined' && PetLevels.isWolf(pet, RKData.getMonsters?.() || []);
  const speciesLevelConfig = pet => typeof PetLevels !== 'undefined' ? PetLevels.config(pet) : { enabled: pet?.level_configurable === true, min: 1, max: 99, step: 10, defaultLevel: pet?.default_level || 99 };
  const configurableLevel = pet => speciesLevelConfig(pet).enabled || isWolf(pet);
  function wolfRecord(side, pet = levelPet(side)) {
    if (!wolfLevels[side].has(pet.id)) wolfLevels[side].set(pet.id, { mode: 'final', slider: 60, manual: '' });
    return wolfLevels[side].get(pet.id);
  }
  function sideLevelConfig(side, pet = levelPet(side)) {
    if (battleSides[side]) return { enabled: true, min: 1, max: 99, step: 1, defaultLevel: 60 };
    return isWolf(pet) ? PetLevels.wolfConfig(wolfRecord(side, pet).mode) : speciesLevelConfig(pet);
  }
  function levelSteps(side) {
    return typeof PetLevels !== 'undefined' ? PetLevels.steps(sideLevelConfig(side)) : LEVEL_STEPS;
  }
  let closeLevelMenu = null, activeLevelMenu = null;
  const levelControlDisposers = new Map();
  const LEVEL_MODES = [['final', '属性值'], ['base', '种族值'], ['ming', '冥古龙'], ['abu', '阿布']];
  function levelRecord(side, pet = levelPet(side)) {
    if (battleSides[side]?.level) return { ...battleSides[side].level };
    if (isBattleSimulation() && battleLooseLevels[side]) return { ...battleLooseLevels[side] };
    if (isWolf(pet)) return { ...wolfRecord(side, pet) };
    const policy = sideLevelConfig(side, pet);
    const raw = window.UserConfig?.getObject('rk_damage_levels', {})?.[pet?.id]?.[side];
    const manual = String(raw?.manual ?? '');
    return {
      ...raw,
      slider: Number.isInteger(raw?.slider) && raw.slider >= policy.min && raw.slider <= policy.max ? raw.slider : policy.defaultLevel,
      manual: /^(?:[1-9]|[1-9][0-9])$/.test(manual) && Number(manual) >= policy.min && Number(manual) <= policy.max ? manual : ''
    };
  }
  function effectiveLevel(side) {
    if (battleSides[side]?.level) { const value = battleSides[side].level; return value.manual === '' ? value.slider : Number(value.manual); }
    if (!sideLevelConfig(side).enabled) return 60;
    const value = levelRecord(side);
    return value.manual === '' ? value.slider : Number(value.manual);
  }
  function setWolfMode(side, mode) {
    if (!['attacker','defender'].includes(side) || !isWolf(levelPet(side)) || battleSides[side] || !['final','base','ming','abu'].includes(mode)) return false;
    const policy = PetLevels.wolfConfig(mode);
    const prepared = side === 'attacker' ? preflightAbuBuff({ mode, level: policy.defaultLevel, resume: true }) : { ok: true };
    if (!prepared.ok) return false;
    closeLevelMenu?.();
    wolfLevels[side].set(levelPet(side).id, { mode, slider: policy.defaultLevel, manual: '' });
    commitAbuBuff(prepared.plan);
    state[side === 'attacker' ? 'atkStatMode' : 'defStatMode'] = mode === 'base' ? 'base' : 'final';
    refreshLevelChange();
    return true;
  }
  function refreshLevelChange() {
    updateFinalStats('attacker'); updateFinalStats('defender');
    // Target-side level effects follow the active defender, not a saved attacker skill.
    if (hasLevelDefenderEffect()) checkJmfzBonus();
    // Recalculate only; never reselect a remembered skill or write personal mode.
    if (document.getElementById('basePower')) calculate();
  }
  function setLevelPreference(side, changes) {
    const pet = levelPet(side);
    if (!['attacker', 'defender'].includes(side) || !sideLevelConfig(side).enabled) return Promise.resolve(false);
    if (Object.hasOwn(changes, 'slider') && !levelSteps(side).includes(changes.slider)) return Promise.resolve(false);
    const policy = sideLevelConfig(side);
    if (Object.hasOwn(changes, 'manual') && changes.manual !== '' &&
        (!/^(?:[1-9]|[1-9][0-9])$/.test(String(changes.manual)) || Number(changes.manual) < policy.min || Number(changes.manual) > policy.max)) return Promise.resolve(false);
    if (isWolf(pet) && !battleSides[side] && Object.hasOwn(changes, 'manual')) return Promise.resolve(false);
    const next = { ...levelRecord(side, pet) };
    // Legacy manual values remain effective until a level control is used. A new
    // slider choice owns the actual level, including when an old override exists.
    if (Object.hasOwn(changes, 'manual')) next.manual = String(changes.manual);
    if (Object.hasOwn(changes, 'slider')) { next.slider = changes.slider; next.manual = ''; }
    const prepared = side === 'attacker' ? preflightAbuBuff({ level: next.manual === '' ? next.slider : Number(next.manual), resume: true }) : { ok: true };
    if (!prepared.ok) return Promise.resolve(false);
    if (battleSides[side]) {
      battleSides[side].level = next; battleSides[side].unknownLevel = true;
      commitAbuBuff(prepared.plan); refreshLevelChange(); return Promise.resolve(true);
    }
    if (isWolf(pet)) { wolfLevels[side].set(pet.id, next); commitAbuBuff(prepared.plan); refreshLevelChange(); return Promise.resolve(true); }
    if (isBattleSimulation()) {
      battleLooseLevels[side] = next; commitAbuBuff(prepared.plan); refreshLevelChange(); return Promise.resolve(true);
    }
    const records = window.UserConfig.getObject('rk_damage_levels', {});
    const record = { ...records[pet.id], [side]: next };
    // patch queues immediately. getObject includes the pending draft; ONLY the
    // shared UserConfig queue reports durable success and owns retry/close flush.
    const saved = window.UserConfig.patch('rk_damage_levels', { [pet.id]: record });
    commitAbuBuff(prepared.plan);
    refreshLevelChange();
    if (side === 'attacker' && nativeAbu(pet)) saveSkillConfig(pet.id);
    return saved;
  }
  function stepLevelPreference(side, direction) {
    if (!['attacker', 'defender'].includes(side) || !sideLevelConfig(side).enabled || ![-1, 1].includes(direction)) return Promise.resolve(false);
    const level = effectiveLevel(side), steps = levelSteps(side);
    const next = direction < 0 ? steps.slice().reverse().find(value => value < level) : steps.find(value => value > level);
    return next === undefined ? Promise.resolve(false) : setLevelPreference(side, { slider: next });
  }
  function buildLevelControls(side) {
    const label = side === 'attacker' ? '攻击方' : '防守方';
    return `<button type="button" class="damage-level-mode" id="${side}-level-mode" aria-label="${label}显示与等级模拟" aria-haspopup="listbox" aria-expanded="false" hidden>属性值</button>
      <div class="damage-level-controls" id="${side}-level-controls" hidden>
      <output class="damage-level-value" id="${side}-level-value" aria-live="polite"></output>
      <button type="button" class="damage-level-step" id="${side}-level-decrease" aria-label="${label}降低等级到上一档">&lt;</button>
      <input class="damage-level-slider" id="${side}-level-slider" type="range" min="0" max="10" step="1" value="10" aria-label="${label}等级快捷档位">
      <button type="button" class="damage-level-step" id="${side}-level-increase" aria-label="${label}提高等级到下一档">&gt;</button>
    </div>`;
  }
  function syncLevelControls(side) {
    const wolf = isWolf(levelPet(side)) && !battleSides[side];
    const special = sideLevelConfig(side).enabled;
    if (activeLevelMenu?.side === side && (!wolf || activeLevelMenu.petId !== levelPet(side)?.id || activeLevelMenu.mode !== wolfRecord(side).mode)) closeLevelMenu?.();
    const menu = document.getElementById(`${side}-level-mode`);
    if (menu) {
      menu.hidden = !wolf;
      if (wolf) {
        menu.textContent = LEVEL_MODES.find(([mode]) => mode === wolfRecord(side).mode)[1];
        menu.setAttribute('aria-label', `${side === 'attacker' ? '攻击方' : '防守方'}显示与等级模拟：${menu.textContent}`);
      }
    }
    const prefix = side === 'attacker' ? 'atk' : 'def';
    const radio = document.querySelector(`input[name="${prefix}StatMode"]`);
    const group = radio?.closest?.('.stat-mode-group');
    if (group) group.hidden = special || wolf;
    const controls = document.getElementById(`${side}-level-controls`);
    if (!controls) return;
    controls.hidden = !special;
    if (!special) return;
    const level = effectiveLevel(side), policy = sideLevelConfig(side), steps = levelSteps(side);
    const output = document.getElementById(`${side}-level-value`);
    output.textContent = `lv：${level}`;
    output.title = levelPet(side)?.data_note || '';
    output.setAttribute('aria-label', `${side === 'attacker' ? '攻击方' : '防守方'}等级 ${level}`);
    const slider = document.getElementById(`${side}-level-slider`);
    // An old off-grid value is preserved, not silently quantized on load. Only
    // the thumb uses the nearest point; text/AT and +/- use the real level.
    const nearest = steps.reduce((best, value, index) => Math.abs(value - level) < Math.abs(steps[best] - level) ? index : best, 0);
    slider.max = steps.length - 1;
    slider.value = nearest;
    slider.setAttribute('aria-valuetext', `${level}级${steps.includes(level) ? '' : '（已记忆等级；操作后使用快捷档位）'}`);
    document.getElementById(`${side}-level-decrease`).disabled = level <= policy.min;
    document.getElementById(`${side}-level-increase`).disabled = level >= policy.max;
  }
  function bindLevelControls(side) {
    levelControlDisposers.get(side)?.();
    const owner = document.getElementById(`${side}-level-mode`);
    const controls = document.getElementById(`${side}-level-controls`);
    const slider = document.getElementById(`${side}-level-slider`);
    if (!owner || !controls || !slider) return;
    let disposed = false, closeOwnedMenu = null, unregister = () => {};
    const listeners = [];
    const listen = (node, type, handler) => {
      node.addEventListener(type, handler);
      listeners.push(() => node.removeEventListener(type, handler));
    };
    const usable = () => !disposed && owner.isConnected && controls.isConnected;
    const open = (edge) => {
      if (!usable() || owner.hidden || !isWolf(levelPet(side)) || battleSides[side]) return;
      if (closeOwnedMenu) { closeOwnedMenu(); return; }
      closeLevelMenu?.();
      const petId = levelPet(side).id, mode = wolfRecord(side).mode;
      const layer = document.createElement('div');
      layer.id = `${side}-level-options`; layer.className = 'damage-level-options';
      layer.setAttribute('role', 'listbox'); layer.setAttribute('aria-label', '显示与等级模拟');
      let closed = false;
      const choose = value => {
        if (closed || !usable() || !layer.isConnected || levelPet(side)?.id !== petId || battleSides[side]) return;
        closeOwnedMenu?.();
        setWolfMode(side, value);
      };
      const choices = LEVEL_MODES.map(([value, label]) => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'damage-level-option'; button.tabIndex = -1;
        button.dataset.mode = value; button.textContent = label;
        button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(value === mode));
        button.addEventListener('click', () => choose(value));
        layer.appendChild(button); return button;
      });
      layer.addEventListener('keydown', event => {
        if (event.isComposing || closed) return;
        const index = choices.indexOf(document.activeElement);
        let next;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % choices.length;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + choices.length - 1) % choices.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = choices.length - 1;
        else if ((event.key === 'Enter' || event.key === ' ') && index >= 0) { event.preventDefault(); choose(LEVEL_MODES[index][0]); }
        // Return focus before the native Tab action so it proceeds from the
        // trigger, rather than from a detached body-portal option.
        else if (event.key === 'Tab') closeOwnedMenu?.();
        if (next !== undefined) { event.preventDefault(); choices[next].focus({ preventScroll: true }); }
      });
      document.body.appendChild(layer);
      owner.setAttribute('aria-expanded', 'true'); owner.setAttribute('aria-controls', layer.id);
      CommonUI.positionAnchoredLayer(owner, layer);
      closeOwnedMenu = CommonUI.bindAnchoredLayer(owner, layer, () => {
        closed = true;
        const focusOwner = layer.contains(document.activeElement);
        layer.remove(); owner.setAttribute('aria-expanded', 'false'); owner.removeAttribute('aria-controls');
        if (closeLevelMenu === closeOwnedMenu) { closeLevelMenu = null; activeLevelMenu = null; }
        closeOwnedMenu = null;
        if (focusOwner && usable() && !owner.hidden) owner.focus({ preventScroll: true });
      });
      closeLevelMenu = closeOwnedMenu; activeLevelMenu = { side, petId, mode };
      const index = edge === 'first' ? 0 : edge === 'last' ? choices.length - 1 : LEVEL_MODES.findIndex(([value]) => value === mode);
      choices[index].focus({ preventScroll: true });
    };
    listen(owner, 'click', () => open());
    listen(owner, 'keydown', event => {
      if (event.isComposing) return;
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); open(event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined);
      }
    });
    listen(slider, 'input', () => {
      if (!usable() || controls.hidden) return;
      const index = Number(slider.value), steps = levelSteps(side);
      if (Number.isInteger(index) && index >= 0 && index < steps.length) void setLevelPreference(side, { slider: steps[index] });
    });
    listen(slider, 'keydown', event => {
      if (!usable() || controls.hidden || event.isComposing) return;
      const direction = ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : 0;
      if (direction) { event.preventDefault(); void stepLevelPreference(side, direction); }
      else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); const steps = levelSteps(side);
        void setLevelPreference(side, { slider: event.key === 'Home' ? steps[0] : steps[steps.length - 1] });
      }
    });
    for (const [name, direction] of [['decrease', -1], ['increase', 1]]) {
      const button = document.getElementById(`${side}-level-${name}`);
      listen(button, 'click', () => { if (usable() && !controls.hidden && !button.disabled) void stepLevelPreference(side, direction); });
    }
    const dispose = () => {
      if (disposed) return;
      disposed = true; closeOwnedMenu?.(); listeners.forEach(remove => remove()); unregister();
      if (levelControlDisposers.get(side) === dispose) levelControlDisposers.delete(side);
    };
    levelControlDisposers.set(side, dispose);
    unregister = CommonUI.registerCleanup?.(owner, dispose) || unregister;
  }

  // Safe parser: ^ means exponentiation; identifiers/calls are never executed.
  function evalExpr(str, fallback) {
    const evaluate = SkillSimulation.evaluate; // A missing required module must fail visibly, not erase modifiers.
    try { return evaluate(str); } catch (_) { return fallback; }
  }
  function normalizePowerExpression(text, total) {
    if (typeof text !== 'string' || text.length > 128 || !/[+*/()^\-]/.test(text)) return '';
    try { return Math.round(SkillSimulation.evaluate(text)) === Number(total) ? text : ''; }
    catch (_) { return ''; }
  }
  const simulationMove = () => RKData.getMoves().find(m => RKData.getMoveName(m) === state.currentSkillName);
  const simulationKey = move => state.atkPet && move ? `${state.atkPet.id}:${move.id}` : null;
  function simulationRecord(move) {
    if (isBattleSimulation()) return battleSkillMemory[simulationKey(move)] || {};
    return window.UserConfig.getObject('rk_skill_simulation', {})[simulationKey(move)] || {};
  }
  function rememberedFireAttackBonus() {
    if (state.atkPet?.id !== 14 || !SkillSimulation.fireAttackEnabled(state.atkPet)) return 0;
    const move = RKData.getMoves().find(m => m.id === 113);
    if (!move || !SkillVariants.describe(move).reviewed) return 0;
    return SkillSimulation.fireAttackBonus(state.atkPet, simulationRecord(move));
  }
  function buffInputExpression(value) {
    const text = String(value);
    return text.trim() === '' ? '0' : text; // Empty means manual zero only in the BUFF field.
  }
  function buffWithFireAttack(bonus, current = state.buff, previousBonus = appliedFireAttackBonus) {
    const manual = Number(current) - previousBonus, total = manual + bonus;
    if (![manual, total].every(n => Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER)) throw Error('双攻加成超出安全计算范围');
    return total;
  }
  function setFireAttackBonus(bonus, current = state.buff, previousBonus = appliedFireAttackBonus) {
    state.buff = buffWithFireAttack(bonus, current, previousBonus);
    appliedFireAttackBonus = bonus;
    const input = document.getElementById('buff');
    if (input) input.value = state.buff;
  }
  function readBuffInput(manualTakeover = false) {
    const input = document.getElementById('buff'), text = String(input.value), blank = text.trim() === '';
    if (state.atkPet?.id !== 14 && !appliedFireAttackBonus && levelEffectMode('attacker') !== 'abu' && !appliedAbuAttackBonus) { state.buff = evalExpr(buffInputExpression(text), 0); return true; }
    try {
      const value = SkillSimulation.evaluate(buffInputExpression(text));
      if (manualTakeover) {
        const move = RKData.getMoves().find(m => m.id === 113);
        if (move && SkillSimulation.fireAttackEnabled(state.atkPet) && SkillVariants.describe(move).reviewed) {
          // Validate the existing pair before any write. Manual input is the new
          // literal baseline, not a total hiding value-minus-old-growth compensation.
          SkillSimulation.fireAttackBonus(state.atkPet, simulationRecord(move));
          saveSimulation(move, { fireBuffOverridden: true });
        }
        if (levelEffectMode('attacker') === 'abu') setAbuOverridden(true);
      } else if (!blank) {
        buffWithFireAttack(appliedFireAttackBonus + appliedAbuAttackBonus, value, appliedFireAttackBonus + appliedAbuAttackBonus);
      }
      // A blank DOM value may arrive without an input event. Its zero baseline
      // cannot retain old derived tracking; calculation reads never write a marker.
      if (manualTakeover || blank) { appliedFireAttackBonus = 0; appliedAbuAttackBonus = 0; }
      if (levelEffectMode('attacker') === 'abu' && (blank || manualTakeover)) abuBlankSuspended = blank && !manualTakeover;
      state.buff = value;
      input.setAttribute('aria-invalid', 'false'); input.title = '';
      return true;
    } catch (error) {
      input.setAttribute('aria-invalid', 'true'); input.title = error.message;
      return false; // Invalid drafts leave the last valid value, tracker and saved pair untouched.
    }
  }
  function saveSimulation(move, record) {
    const key = simulationKey(move);
    if (isBattleSimulation()) { if (key) battleSkillMemory[key] = { ...battleSkillMemory[key], ...record }; return; }
    if (key) void window.UserConfig.patch('rk_skill_simulation', { [key]: { ...simulationRecord(move), ...record } });
  }
  function syncPowerInput() {
    const input = document.getElementById('basePower');
    if (!input) return;
    const kind = state.skillInputKind || 'power';
    const label = document.getElementById('skill-power-input-label');
    if (label) label.textContent = kind === 'energy' ? '当前能量' : kind === 'hp-ratio' ? '血量比' : '基础威力';
    input.value = kind === 'power' ? state.basePowerExpression || state.basePower : state.skillInputValue;
    input.setAttribute('aria-label', kind === 'energy' ? '当前能量（0—10）' : kind === 'hp-ratio' ? '血量比（当前生命/最大生命）' : '基础威力');
    input.setAttribute('inputmode', kind === 'energy' ? 'numeric' : 'text');
    input.setAttribute('aria-invalid', 'false');
  }
  function readPowerInput() {
    const input = document.getElementById('basePower');
    try {
      const values = SkillSimulation.input(state.skillInputKind || 'power', input.value);
      Object.assign(state, values); input.setAttribute('aria-invalid', 'false'); input.title = '';
      return true;
    } catch (error) {
      input.setAttribute('aria-invalid', 'true'); input.title = error.message;
      // Invalid drafts never overwrite the previous valid state or persisted value.
      return false;
    }
  }
  // Trait/default and defender-derived values are display overlays, not manual memory.
  const bonusOverrides = { fixedBonus: null, percentBonus: null };
  let jmfzActive = false;
  function setAutomaticBonus(field, value, reason) {
    if (!Number.isFinite(value)) return;
    const prior = bonusOverrides[field];
    bonusOverrides[field] = { manual: prior ? prior.manual : Number(isBattleSimulation() ? state[field] : loadSkillConfig(state.atkPet?.id)?.[field] ?? state[field]), value, reason };
    state[field] = value;
    const input = document.getElementById(field); if (input) input.value = value;
  }
  function releaseAutomaticBonus(field) {
    const prior = bonusOverrides[field]; if (!prior) return;
    state[field] = prior.manual; const input = document.getElementById(field); if (input) input.value = prior.manual;
    bonusOverrides[field] = null;
  }
  function applyTraitPowerDefaults(onSelection = false) {
    const api = typeof TraitPowerDefaults === 'undefined' ? window.TraitPowerDefaults : TraitPowerDefaults;
    const rule = api?.resolve(state.atkPet, state.currentSkillName, state.skillAttr);
    if (rule && (onSelection || rule.mode === 'dynamic')) setAutomaticBonus(rule.field, rule.value, 'trait');
    if (!rule) for (const field of ['fixedBonus', 'percentBonus']) {
      if (bonusOverrides[field]?.reason === 'trait') releaseAutomaticBonus(field);
    }
    return rule;
  }
  function updateSpecialPower() {
    const move = RKData.getMoves().find(m => RKData.getMoveName(m) === state.currentSkillName);
    const stat = move?.power_formula === 'speed_diff' ? 'speed'
      : move?.power_formula === 'phy_def_diff' ? 'defense' : null;
    if (!stat || !state.atkPet || !state.defPet) return;
    const attackValue = battleStat('attacker', stat);
    const defenseValue = battleStat('defender', stat);
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
   * 3. 计算引擎层（共用等级公式；每击伤害仅最终向下取整）
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
      const atkStat = battleStat('attacker', atkStatKey);
      const defBaseStat = battleStat('defender', defStatKey);
      const defStat = Math.round(defBaseStat * defenseMod);

      const isManual = state.finalPowerManual !== '' && state.finalPowerManual !== null;
      const skillFinalPower = this.calcFinalPower(basePower, fixedBonus, percentBonus, atk, def, skillAttr, buffPercent, isManual ? state.finalPowerManual : null);

      // 普通伤害计算
      const attackLevel = effectiveLevel('attacker');
      const factorText = sideLevelConfig('attacker').enabled || attackLevel !== 60 ? BattleMath.damageFactor(attackLevel).toFixed(2) : '0.9';
      const singleHit = BattleMath.normalDamage(atkStat, skillFinalPower, defStat, debuffMod, 1, attackLevel);
      let totalDamage = singleHit * comboCount;

      // 非幻系攻击触发；追加伤害为幻系，使用攻击方等级系数，但不叠本系/普通威力加成/连击。
      let starMeteorDamage = 0;
      let starMeteorBase = 0;
      const starMeteorLayers = state.starMeteor || 0;
      const starMeteorTriggered = starMeteorLayers > 0 && RKData.getTypeEn(skillAttr) !== 'Illusion';
      const starMeteorTypeEff = RKData.getTypeEff('Illusion', def.main_type?.name, def.sub_type?.name);
      if (starMeteorTriggered) {
        starMeteorBase = this.calcStarMeteorBase(starMeteorLayers);
        starMeteorDamage = BattleMath.starMeteorDamage(starMeteorBase, atkStat, defStat, buffMod, starMeteorTypeEff, debuffMod, attackLevel);
        totalDamage += starMeteorDamage;
      }

      const defHP = battleStat('defender', 'hp');
      const remainingHP = Math.max(0, defHP - totalDamage);
      const damagePercent = (totalDamage / defHP * 100);

      return {
        atkName: getPetName(atk), defName: getPetName(def),
        skillTypeName, skillAttrFull,
        atkStat, defStat, defBaseStat, defStatKey,
        skillBasePower, skillFinalPower,
        isSameType, sameTypeBonus, typeEff, buffMod,
        debuffMod, defenseMod, hasDefenseMod, hasDebuffMod,
        singleHit, totalDamage, comboCount, attackLevel, factorText,
        starMeteorDamage, starMeteorLayers, starMeteorBase, starMeteorTypeEff, starMeteorTriggered,
        defHP, remainingHP, damagePercent,
        atkIVText: battleIVText('attacker', atkStatKey),
        atkNatureText: state.atkNature[atkStatKey] === 1 ? '✓性格' : state.atkNature[atkStatKey] === 2 ? '负性格' : '×性格',
        defIVText: battleIVText('defender', defStatKey),
        defNatureText: state.defNature[defStatKey] === 1 ? '✓性格' : state.defNature[defStatKey] === 2 ? '负性格' : '×性格',
        hpIVText: battleIVText('defender', 'hp'),
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

      let dmgParts = [`${r.skillFinalPower} × (${r.atkStat} ÷ ${r.defStat})`, r.factorText || '0.9'];
      if (r.hasDebuffMod) dmgParts.push(`减伤${r.debuffMod.toFixed(2)}`);
      if (r.comboCount > 1) dmgParts.push(`${r.comboCount}连击`);
      const normalDamage = r.totalDamage - r.starMeteorDamage;
      if (r.starMeteorDamage > 0) {
        steps.push(`⑤ 普通伤害 = ${dmgParts.join(' × ')} = <span class="danger-text">${normalDamage}</span>`);
        let starParts = [`${r.starMeteorLayers}层星陨印记（幻系，基础威力${r.starMeteorBase}）`, `(${r.atkStat} ÷ ${r.defStat})`, r.factorText || '0.9'];
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
                ${buildLevelControls('attacker')}
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
                ${buildLevelControls('defender')}
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
                <label class="accent-label" id="skill-power-input-label" for="basePower">基础威力:</label>
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
                <label class="debuff-percent-label" for="debuffPercent">减伤百分比:</label>
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

    // 优先本ID；首领只返回明确普通来源，不能把同编号的另一形态当成本精灵。
    const base = pet.is_leader_form || pet.evolution_stage === '首领形态' ? RKData.getLeaderBase(pet) : null;
    const ownIndex = team.indexOf(pet.id);
    const idx = ownIndex >= 0 ? ownIndex : (base ? team.indexOf(base.id) : -1);
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
      html += `<div class="skill-icon-group"><div class="skill-icon-group-title">基础技能</div><div class="skill-icons-subgrid">${baseSkills.map(buildSkillIconHtml).join('')}</div></div>`;
    }
    if (bloodlineSkills.length > 0) {
      html += `<div class="skill-icon-group"><div class="skill-icon-group-title">血脉技能</div><div class="skill-icons-subgrid">${bloodlineSkills.map(buildSkillIconHtml).join('')}</div></div>`;
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
        let simulation, fireGrowth, abuGrowth;
        try {
          abuGrowth = prepareAbuBuff({ type: SkillVariants.describe(move).skillType });
          simulation = SkillVariants.describe(move).reviewed ? SkillSimulation.select(move, state.atkPet, side, simulationRecord(move)) : null;
          if (simulation?.applied && simulation.fireAttackBonus !== undefined) {
            const text = String(document.getElementById('buff').value);
            const current = SkillSimulation.evaluate(buffInputExpression(text));
            const previousBonus = text.trim() === '' ? 0 : appliedFireAttackBonus;
            // Blank is a fresh manual0, even without an input event. Preflight
            // with no old derivation, but commit nothing until all guards pass.
            buffWithFireAttack(simulation.fireAttackBonus, current, previousBonus);
            fireGrowth = { bonus: simulation.fireAttackBonus, current, previousBonus };
          }
        } catch (error) { showSkillNotice(error.message); return; }
        const result = simulation ? (simulation.applied ? {
          applied: true, state: { ...state, ...simulation.values, skillType: SkillVariants.describe(move).skillType,
            skillAttr: short, currentSkillName: RKData.getMoveName(move) }
        } : { applied: false, notice: '此技能没有中键模拟操作' }) : SkillVariants.select(state, move, side, short);
        if (!result.applied) {
          showSkillNotice(item.dataset.skillName + '：未应用；请查看提示并手动设置。', result.notice);
          return; // No value, highlight, snapshot, or profile writes.
        }
        Object.assign(state, result.state);
        commitAbuBuff(abuGrowth);
        if (fireGrowth) setFireAttackBonus(fireGrowth.bonus, fireGrowth.current, fireGrowth.previousBonus);
        if (!simulation) { state.skillInputKind = 'power'; state.skillInputValue = ''; }
        if (simulation?.applied) saveSimulation(move, simulation.record);
        syncPowerInput();
        document.getElementById('comboCount').value = state.comboCount;
        setSkillType(state.skillType);
        updateSkillAttrButton();
        grid.querySelectorAll('.skill-icon-item').forEach(i => i.classList.toggle('selected', i.dataset.skillName === state.currentSkillName));

        checkSameType();
        const traitRule = applyTraitPowerDefaults(false);
        if (hasLevelDefenderEffect() || (state.defPet?.id === 501 && (previousAttribute !== RKData.getTypeEn(state.skillAttr) ||
            (traitRule?.mode === 'dynamic' && traitRule.field === 'percentBonus')))) checkJmfzBonus();
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
      item.addEventListener('auxclick', event => {
        if (event.button !== 1) return;
        event.preventDefault(); select('middle');
      });
      item.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
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
              <div id="battle-snapshot-panel" class="card battle-snapshot-panel" hidden></div>
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
    renderBattleSnapshotPanel();
    const scroller = document.querySelector('.calc-root.scroll-container');
    if (scroller) scroller.scrollTop = pageScrollTop;
  }

  /* 从已有 state 恢复 UI（页面切换回来时不重置数据） */
  function restoreFromState(reapplyTarget = true) {
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
    if (reapplyTarget && hasLevelDefenderEffect()) checkJmfzBonus();
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

  // Explicit search/quick-avatar choices share display memory. Keep generic
  // selectPet free of this effect so startup, navigation and battle restores do
  // not become new choices. Preserve the quick source's team and MRU policy.
  function selectExplicitPet(side, pet, teamData = null, source = 'selection') {
    if (!pet) return;
    selectPet(side, pet, teamData, source);
    window.SpeedLeaderDisplay?.recordSearch(pet, RKData.getMonsters());
    window.DamageSpeedPriority?.record(pet, state.searchedPets);
  }
  function initSearchDropdown(slotId, side) {
    const sb = CommonUI.createSearchBox({
      placeholder: '选择或搜索精灵',
      limit: 10,
      onSelect: pet => selectExplicitPet(side, pet),
      renderItem: CommonUI.monsterRenderItem()
    });
    searchBoxes[side] = sb;
    document.getElementById(slotId).appendChild(sb.wrapper);
  }

  /* Shared file only: failed writes remain in UserConfig's visible retry/close queue. */
  const STAT_KEYS = ['attack', 'magic_attack', 'defense', 'magic_defense', 'hp', 'speed'];
  function savePetConfig(petId, nature, iv, mode = 1) {
    if (isBattleSimulation()) return;
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
    bonusOverrides.fixedBonus = null; bonusOverrides.percentBonus = null; jmfzActive = false;
    const skillCfg = loadSkillConfig(petId);
    if (skillCfg) {
      applySkillConfig(skillCfg);
    } else {
      resetSkillSettings();
      renderSkillIcons(); // 清除上个精灵的技能选中高亮
    }
  }
  const SKILL_CONFIG_KEYS = ['basePower','basePowerExpression','skillInputKind','skillInputValue','fixedBonus','percentBonus','buff','comboCount',
    'debuffPercent','defenseMod','starMeteor','finalPowerManual'];
  function skillSnapshot() {
    const snapshot = Object.fromEntries(Object.keys(SKILL_DEFAULTS).map(key => [key, state[key]]));
    // The pair's powerCount is the shared use count (an explicit manual-power
    // detach may retain growth). Save only independent manual buff, never bake in growth twice.
    snapshot.buff = buffWithFireAttack(0, state.buff, appliedFireAttackBonus + appliedAbuAttackBonus);
    // Temporary target percentages are not attacker manual memory.
    if (isLevelDefenderOverride()) snapshot.percentBonus = bonusOverrides.percentBonus.manual;
    return snapshot;
  }
  function saveActiveSkill() {
    if (isBattleSimulation()) return;
    const skill = { ...window.UserConfig.getObject('rk_damage_view', {}).skill, ...skillSnapshot() };
    // The active view has no owner ID. Only the native623 per-pet record may carry this marker.
    delete skill.abuBuffOverridden;
    void window.UserConfig.patch('rk_damage_view', { skill });
  }
  function saveSkillConfig(petId) {
    if (isBattleSimulation()) return;
    if (petId) void window.UserConfig.patch('rk_damage_skill_configs', {
      [petId]: { ...loadSkillConfig(petId), ...skillSnapshot(),
        ...(Number(petId) === 623 ? { abuBuffOverridden: nativeAbuBuffOverridden } : {}),
        ...Object.fromEntries(Object.entries(bonusOverrides).filter(([,v]) => v).map(([k,v]) => [k,v.manual])) }
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
      if (el) {
        el.value = key === 'basePower' ? state.basePowerExpression || state.basePower : state[key];
        if (key === 'buff') { el.setAttribute('aria-invalid', 'false'); el.title = ''; }
      }
    });
    syncPowerInput();
    setSkillType(state.skillType);
    updateSkillAttrButton();
  }

  function applySkillConfig(cfg) {
    // 目标精灵缺少的旧字段使用默认值，绝不继承上一只精灵的残留。
    appliedFireAttackBonus = 0; appliedAbuAttackBonus = 0; abuBlankSuspended = false;
    nativeAbuBuffOverridden = state.atkPet?.id === 623 && loadSkillConfig(623)?.abuBuffOverridden === true;
    Object.assign(state, SKILL_DEFAULTS);
    for (const key of Object.keys(SKILL_DEFAULTS)) {
      if (cfg?.[key] == null) continue;
      if (cfg[key] === '' && !['finalPowerManual', 'currentSkillName', 'basePowerExpression', 'skillInputValue'].includes(key)) continue;
      state[key] = cfg[key];
    }
    const growth = rememberedFireAttackBonus();
    if (growth) setFireAttackBonus(growth);
    commitAbuBuff(prepareAbuBuff({ fromState: true }));
    writeSkillInputs();
    if (hasLevelDefenderEffect()) checkJmfzBonus();
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
    if (isBattleSimulation()) return;
    void window.UserConfig.patch('rk_damage_selection', fields);
  }
  function selectionTeam(groupId, petId) {
    if (!groupId) return null;
    try {
      const group = JSON.parse(localStorage.getItem('rk_team_config') || '{}').groups?.find(group => group.id === groupId);
      return group?.team?.includes(petId) ? group : null;
    } catch (_) { return null; }
  }

  function selectPet(side, pet, teamData = null, source = 'selection') {
    if (!pet) return;
    if (isBattleSimulation()) endBattleSimulation();
    closeReductionPicker?.();
    closeLevelMenu?.();
    const config = petConfiguration(pet.id, teamData);
    if (side === 'attacker') {
      // User edits already save per-pet memory. Role changes save only the active view.
      state.atkPet = pet; state.atkNature = config.nature; state.atkIV = config.iv;
      applySkillMemory(pet.id);
      applyTraitPowerDefaults(true);
      onAttackerSelected(source);
      // 保留机幕方舟独立覆盖规则；仅换精灵时应用，不在切页时重置。
      checkJmfzBonus();
      calculate();
    } else {
      state.defPet = pet; state.defNature = config.nature; state.defIV = config.iv;
      onDefenderSelected(source);
    }
    searchBoxes[side]?.setValue(getPetName(pet), pet);
    syncModifierButtons(side);
    renderSkillIcons();
    selectionTeams[side] = teamData?.id || null;
    saveSelection({ [side]: pet.id, [side + 'Team']: selectionTeams[side] });
    saveActiveSkill(); renderBattleSnapshotPanel();
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
    applyTraitPowerDefaults(true);
    checkJmfzBonus();
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
    rootEl?.querySelectorAll?.('.iv-btn').forEach(button => {
      const overlay = battleSides[side], stat = button.dataset.stat;
      button.textContent = overlay && Object.hasOwn(overlay.iv, stat) ? `个体${overlay.iv[stat]}` : '个体';
    });
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

    if (battleSides[side]) {
      if (isNature) { battleSides[side].nature[stat] = s[stat]; battleSides[side].manualNature[stat] = true; }
      else { battleSides[side].iv[stat] = sIV[stat] ? 60 : 0; battleSides[side].manualIV[stat] = true; }
    }
    syncModifierButtons(side);
    updateFinalStats(side);
    updateSpecialPower();
    calculate();
    if (isBattleSimulation()) { renderBattleSnapshotPanel(); return; }
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
    if (battleSides[side]) { battleSides[side].iv = {}; battleSides[side].nature = {}; battleSides[side].manualIV = {}; battleSides[side].manualNature = {}; }
    if (side === 'attacker') { state.atkNature = config.nature; state.atkIV = config.iv; }
    else { state.defNature = config.nature; state.defIV = config.iv; }
    selectionTeams[side] = null;
    savePetConfig(pet.id, config.nature, config.iv, 0);
    saveSelection({ [side + 'Team']: null });
    syncModifierButtons(side);
    updateFinalStats(side); calculate(); saveActiveSkill(); renderBattleSnapshotPanel();
  }

  function resetSkillSettings() {
    bonusOverrides.fixedBonus = null; bonusOverrides.percentBonus = null; jmfzActive = false;
    applySkillConfig(SKILL_DEFAULTS);
    renderSkillIcons();
  }

  function swapPokemons() {
    if (!state.atkPet || !state.defPet) return;
    closeLevelMenu?.();
    [state.atkPet, state.defPet] = [state.defPet, state.atkPet];
    [state.atkNature, state.defNature] = [state.defNature, state.atkNature];
    [state.atkIV, state.defIV] = [state.defIV, state.atkIV];
    [state.atkStatMode, state.defStatMode] = [state.defStatMode, state.atkStatMode];
    [selectionTeams.attacker, selectionTeams.defender] = [selectionTeams.defender, selectionTeams.attacker];
    [battleSides.attacker, battleSides.defender] = [battleSides.defender, battleSides.attacker];
    applySkillMemory(state.atkPet.id);
    applyTraitPowerDefaults(true);
    checkJmfzBonus();
    restoreFromState();
    saveSelection({ attacker: state.atkPet.id, defender: state.defPet.id,
      attackerTeam: selectionTeams.attacker, defenderTeam: selectionTeams.defender });
    saveActiveSkill(); renderBattleSnapshotPanel();
  }

  /* ============================================================
   * 9. 精灵选中 & 属性更新
   * ============================================================ */
  function onAttackerSelected(source = 'selection') {
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
    if (source !== 'history' && source !== 'battle') addSearchedPet(pet);
    updateAllRoleMarks();
  }

  function onDefenderSelected(source = 'selection') {
    const pet = state.defPet;
    if (!pet) return;

    updateTypeBadges('defender', pet);
    updateFinalStats('defender');

    checkJmfzBonus();
    updateSpecialPower();
    updateTypeEffectiveness();
    calculate();
    if (source !== 'history' && source !== 'battle') addSearchedPet(pet);
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
    syncLevelControls(side);
    const pet = state[side === 'attacker' ? 'atkPet' : 'defPet'];
    if (!pet) return;
    const nature = side === 'attacker' ? state.atkNature : state.defNature;
    const iv = side === 'attacker' ? state.atkIV : state.defIV;
    const mode = battleSides[side] ? 'final' : isWolf(pet) ? (wolfRecord(side).mode === 'base' ? 'base' : 'final') : configurableLevel(pet) ? 'final' : side === 'attacker' ? state.atkStatMode : state.defStatMode;
    const rootEl = document.querySelector(`.${side}-card`);
    CommonUI.StatBox.refreshValues(rootEl, pet, nature, iv, mode);
    // The common StatBox uses page-default levels; override only this special
    // damage-side instance while retaining its base metadata and shared controls.
    if (mode === 'final' && (configurableLevel(pet) || battleSides[side])) rootEl?.querySelectorAll('.final-stat-item').forEach(item => {
      const stat = item.dataset.stat, value = item.querySelector('.stat-value');
      if (value) value.textContent = battleStat(side, stat);
    });
    if (battleSides[side]) syncModifierButtons(side);
  }

  function checkSameType() {
    const pet = state.atkPet;
    const el = document.getElementById('sameTypeBonus');
    if (!pet) { el.textContent = '未触发'; el.classList.remove('triggered'); return; }
    const isSame = CalcEngine.isSameType(pet, state.skillAttr);
    if (isSame) { el.textContent = '已触发'; el.classList.add('triggered'); }
    else { el.textContent = '未触发'; el.classList.remove('triggered'); }
  }

  const isLevelDefenderOverride = () => ['ming-defender', 'abu-defender'].includes(bonusOverrides.percentBonus?.reason);
  const hasLevelDefenderEffect = () => ['ming', 'abu'].includes(levelEffectMode('defender')) || isLevelDefenderOverride();
  /* Target-side automatic percentage presets; keep the existing entry for callers. */
  function checkJmfzBonus() {
    const isJmfz = state.defPet?.id === 501, mode = levelEffectMode('defender');
    if (['ming', 'abu'].includes(mode) && effectiveLevel('defender') < 80) {
      setAutomaticBonus('percentBonus', mode === 'abu' ? 30 : 40, mode + '-defender');
      jmfzActive = false;
    } else if (isJmfz) {
      setAutomaticBonus('percentBonus', CalcEngine.calcTypeEff(state.skillAttr, state.defPet) > 1 ? 25 : 0, 'defender');
      jmfzActive = true;
    } else if (jmfzActive || isLevelDefenderOverride()) {
      releaseAutomaticBonus('percentBonus'); jmfzActive = false;
      applyTraitPowerDefaults(true);
    }
    // Ordinary defenders never zero a restored manual value (including saved 0).
  }

  // 切换种族值/属性值显示
  function setStatMode(side, mode) {
    if (isWolf(levelPet(side)) && !battleSides[side]) { setWolfMode(side, mode); return; }
    if (configurableLevel(levelPet(side))) return;
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
    if (!readPowerInput()) return;
    const basePower = state.basePower;
    const fixedBonus = Math.round(evalExpr(document.getElementById('fixedBonus').value, 0));
    const percentBonus = evalExpr(document.getElementById('percentBonus').value, 0);
    if (!readBuffInput()) return;
    const buffPercent = state.buff;
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
    if (!readPowerInput() || !readBuffInput()) return;
    // 保留特殊技能自动覆盖；依据主技能表分别比较速度或物防。
    updateSpecialPower();
    state.fixedBonus = Math.round(evalExpr(document.getElementById('fixedBonus').value, 0));
    state.percentBonus = evalExpr(document.getElementById('percentBonus').value, 0);
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
    if (![r.totalDamage, r.skillFinalPower, r.basePower].every(value => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)) {
      document.getElementById('damageValue').textContent = '—';
      document.getElementById('damagePercent').textContent = '—';
      document.getElementById('remainingHP').textContent = '数值超出安全计算范围';
      stepsEl.textContent = '请减少累计次数或修正加成后重新计算；未显示溢出的伤害结果。';
      return;
    }

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
        applyTraitPowerDefaults(false);
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

  let closeReductionPicker = null;
  function bindReductionPresets() {
    const input = document.getElementById('debuffPercent');
    if (!input) return;
    let disposed = false, closeOwnedPicker = null, unregister = () => {};
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-expanded', 'false');
    const open = () => {
      if (disposed || closeReductionPicker || !input.isConnected) return;
      const layer = document.createElement('div');
      layer.id = 'damageReductionPresets';
      layer.className = 'bloodline-hdropdown damage-reduction-picker';
      layer.setAttribute('role', 'listbox');
      layer.setAttribute('aria-label', '减伤百分比预设');
      const choices = [50, 60, 70, 80, 90].map(value => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'damage-reduction-option';
        button.dataset.reduction = String(value); button.textContent = value + '%';
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(Number(input.value) === value));
        button.addEventListener('click', () => {
          if (!layer.isConnected || !input.isConnected) return;
          closeReductionPicker?.();
          input.value = String(value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus({ preventScroll: true });
        });
        layer.appendChild(button); return button;
      });
      layer.addEventListener('keydown', event => {
        const index = choices.indexOf(document.activeElement);
        let next;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % choices.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + choices.length - 1) % choices.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = choices.length - 1;
        if (next !== undefined) { event.preventDefault(); choices[next].focus(); }
      });
      document.body.appendChild(layer);
      input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', layer.id);
      CommonUI.positionAnchoredLayer(input, layer);
      closeOwnedPicker = CommonUI.bindAnchoredLayer(input, layer, () => {
        const restoreFocus = layer.contains(document.activeElement);
        layer.remove();
        if (closeReductionPicker === closeOwnedPicker) closeReductionPicker = null;
        closeOwnedPicker = null;
        input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-controls');
        if (restoreFocus && input.isConnected) input.focus({ preventScroll: true });
      });
      closeReductionPicker = closeOwnedPicker;
    };
    input.addEventListener('click', open);
    document.querySelector('.debuff-percent-label')?.addEventListener('click', open);
    input.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' || event.isComposing) return;
      event.preventDefault(); open();
      const layer = document.getElementById('damageReductionPresets');
      (layer?.querySelector('[aria-selected="true"]') || layer?.querySelector('button'))?.focus();
    });
    input.addEventListener('input', () => closeOwnedPicker?.());
    unregister = CommonUI.registerCleanup?.(input, () => {
      if (disposed) return;
      disposed = true; closeOwnedPicker?.(); unregister();
    }) || unregister;
  }

  function bindEvents() {
    bindReductionPresets();
    const atkInput = searchBoxes.attacker.input;
    const defInput = searchBoxes.defender.input;

    atkInput.addEventListener('click', function() { this.select(); });
    defInput.addEventListener('click', function() { this.select(); });

    atkInput.addEventListener('input', function(e) {
      const name = e.target.value.trim();
      const pet = RKData.getMonsters().find(m => getPetName(m) === name);
      if (pet) selectExplicitPet('attacker', pet);
    });
    defInput.addEventListener('input', function(e) {
      const name = e.target.value.trim();
      const pet = RKData.getMonsters().find(m => getPetName(m) === name);
      if (pet) selectExplicitPet('defender', pet);
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
    for (const side of ['attacker', 'defender']) bindLevelControls(side);
    document.querySelectorAll('input[name="atkStatMode"]').forEach(radio => {
      radio.addEventListener('change', () => setStatMode('attacker', radio.value));
    });
    document.querySelectorAll('input[name="defStatMode"]').forEach(radio => {
      radio.addEventListener('change', () => setStatMode('defender', radio.value));
    });

    document.querySelectorAll('input[name="skillType"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const prepared = preflightAbuBuff({ type: radio.value });
        if (!prepared.ok) { setSkillType(state.skillType); return; }
        commitAbuBuff(prepared.plan);
        setSkillType(radio.value);
        calculate();
        saveSkillConfig(state.atkPet && state.atkPet.id);
      });
    });

    ['basePower','fixedBonus','percentBonus','comboCount','buff','debuffPercent','defenseMod','starMeteor','finalPowerManual'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => {
        if (id === 'buff' && !readBuffInput(true)) return;
        if (id === 'basePower') {
          if (!readPowerInput()) return;
          const move = simulationMove(), kind = state.skillInputKind;
          if (kind === 'energy') saveSimulation(move, { energy: Number(state.skillInputValue) });
          else if (kind === 'hp-ratio') saveSimulation(move, { hpRatio: state.skillInputValue });
          else if (SkillSimulation.kind(move, state.atkPet)) {
            const reset = { powerCount: 0, comboCount: 0, counterMode: false };
            // A manual power edit is distinct from selecting the base50 preset.
            // Preserve only the explicitly retained growth; the next113 click realigns both counts.
            if (move?.id === 113 && SkillSimulation.fireAttackEnabled(state.atkPet) && SkillVariants.describe(move).reviewed) {
              reset.firePowerDetached = true;
              reset.fireAttackCount = appliedFireAttackBonus / 30;
            }
            saveSimulation(move, reset);
          }
        }
        if (id === 'fixedBonus' || id === 'percentBonus') bonusOverrides[id] = null;
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
  function bindAvatarClicks(container, source = 'selection') {
    const teamData = container._teamData || null;
    container.querySelectorAll('.quick-pet-item').forEach(el => {
      el.addEventListener('click', () => {
        const petId = parseInt(el.dataset.petId);
        const pet = RKData.getMonsterById(petId);
        if (!pet) return;
        selectExplicitPet('attacker', pet, teamData, source);
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const petId = parseInt(el.dataset.petId);
        const pet = RKData.getMonsterById(petId);
        if (!pet) return;
        selectExplicitPet('defender', pet, teamData, source);
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
          const leaderForms = RKData.getLeaderForms(pet).filter(m => !m.hidden).sort((a, b) => a.id - b.id);
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
    // Reusing a historical avatar changes roles/configuration, not its position
    // or the persisted history. Other avatar/search paths retain normal MRU.
    bindAvatarClicks(container, 'history');
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
    closeReductionPicker?.();
    closeLevelMenu?.();
    for (const dispose of [...levelControlDisposers.values()]) dispose();
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
      if (!pet || selectionTeams[side] || battleSides[side]) continue;
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
  // Preserve the established public/test instrumentation anchor.
  Object.assign(CalcEngine, { effectiveLevel, levelRecord, setLevelPreference, stepLevelPreference, LEVEL_STEPS, levelSteps, setWolfMode, sideLevelConfig,
    applyBattlePet, setBattleValue, endBattleSimulation, isBattleSimulation, battleStat, renderBattleSnapshotPanel });
  return { render, onLeave, getState: () => state, CalcEngine };
})();
