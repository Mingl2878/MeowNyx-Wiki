/**
 * speed.js — 速度线页面
 * 速度档位表（基础速度 → 各加成下实际速度）
 */
const SpeedPage = (function () {
  let tierState = { iv: true, nature: true, fixed: 0, percent: 0, search: '', searchDisplay: '', searchPetId: null, selectedCol: null, negNature: false, showMonsters: true, selectedSpeed: null, selectedLevel: 60, selectedRowKey: null, mingSpeedLevel: 99, formOverrides: {} };

  /* ===== 搜索习惯持久化（localStorage） ===== */
  const PET_PRIORITY_KEY = 'rk_speed_pet_priority';
  // 结构: { "speed值": [monsterId, monsterId, ...] }
  let petPriority = {};
  function loadPetPriority() {
    if (window.UserConfig) { petPriority = window.UserConfig.getObject(PET_PRIORITY_KEY, {}); return; }
    try {
      const raw = localStorage.getItem(PET_PRIORITY_KEY);
      petPriority = raw ? JSON.parse(raw) : {};
    } catch (e) { petPriority = {}; }
  }
  function savePetPriority(speed) {
    if (window.UserConfig) { void window.UserConfig.patch(PET_PRIORITY_KEY, { [speed]: petPriority[speed] }); return; }
    try { localStorage.setItem(PET_PRIORITY_KEY, JSON.stringify(petPriority)); } catch (e) {}
  }
  function recordPetSearch(monster) {
    if (!monster || !monster.base_spd) return;
    const spd = monster.base_spd;
    if (!petPriority[spd]) petPriority[spd] = [];
    // 移除已有记录（去重）
    petPriority[spd] = petPriority[spd].filter(id => id !== monster.id);
    // 插入到首位
    petPriority[spd].unshift(monster.id);
    // 限制每行最多记录 20 条
    if (petPriority[spd].length > 20) petPriority[spd].length = 20;
    savePetPriority(spd);
  }
  function readDamageHistory() {
    let history = [];
    try {
      const active = typeof DamagePage !== 'undefined' ? DamagePage.getState()?.searchedPets : null;
      if (Array.isArray(active) && active.length) history = active;
      else {
        const saved = JSON.parse(localStorage.getItem('rk_searched_pets') || '[]');
        if (Array.isArray(saved)) history = saved;
      }
    } catch (_) { /* History is optional; never reset the speed page on cache failure. */ }
    return [...new Set(history.filter(id => typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id)))
      .map(Number).filter(id => Number.isSafeInteger(id) && id > 0 && id !== 9001))];
  }
  function getPetPriority(spd) {
    // Keep current speed-search precedence. Damage's independent selection order
    // includes quick clicks without moving its visible history; only use the old
    // history as a read-only fallback until an explicit choice creates that order.
    const legacy = readDamageHistory();
    const damagePriority = window.DamageSpeedPriority?.read(legacy) ?? legacy;
    return [...new Set([...damagePriority, ...(petPriority[spd] || [])])];
  }
  loadPetPriority();

  /* ===== 形态覆盖持久化（localStorage） ===== */
  const FORM_OVERRIDE_KEY = 'rk_speed_form_overrides';
  function loadFormOverrides() {
    if (window.UserConfig) { tierState.formOverrides = window.UserConfig.getObject(FORM_OVERRIDE_KEY, {}); return; }
    try {
      const raw = localStorage.getItem(FORM_OVERRIDE_KEY);
      tierState.formOverrides = raw ? JSON.parse(raw) : {};
    } catch (e) { tierState.formOverrides = {}; }
  }
  function saveFormOverrides(key) {
    if (window.UserConfig) { void window.UserConfig.patch(FORM_OVERRIDE_KEY, { [key]: tierState.formOverrides[key] ?? null }); return; }
    try {
      // The shared leader module owns other keys in this object. Patch only this
      // form key into the latest fallback value, never replay a page-local snapshot.
      const raw = JSON.parse(localStorage.getItem(FORM_OVERRIDE_KEY) || '{}');
      const saved = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      if (key in tierState.formOverrides) saved[key] = tierState.formOverrides[key];
      else delete saved[key];
      localStorage.setItem(FORM_OVERRIDE_KEY, JSON.stringify(saved));
    } catch (e) {}
  }
  function getFormGroupKey(m) {
    const name = RKData.getMonsterName(m);
    const gk = m.form_category === '主形态' ? (m.form || 'default') : (m.main_form_name || m.form || 'default');
    return name + '|' + gk + '|' + (m.base_spd || 0);
  }
  function setFormOverride(m) {
    if (!m) return;
    const key = getFormGroupKey(m);
    if (m.form_category === '主形态') {
      // 选主形态：清除覆盖
      delete tierState.formOverrides[key];
    } else {
      // 选子形态：设置覆盖
      tierState.formOverrides[key] = m.id;
    }
    saveFormOverrides(key);
  }
  loadFormOverrides();

  // Current controls/search/selection are intentionally process-memory only.
  // Page navigation keeps tierState; a fresh WebView starts from the defaults above.
  // Historical persisted view values are neither imported nor read/written here.

  /* ===== 属性计算公式（与 data.js getPetStat 一致，非HP） ===== */
  function calcSpeedStat(base, iv, nature, level = 60) {
    return BattleMath.statFromBase(base, 'speed', nature, iv, level);
  }

  function applyBonus(val) {
    return BattleMath.basePower(val, tierState.fixed, tierState.percent);
  }

  // One species-owned speed row, independent of damage levels and personal config.
  // Its selected level lives only in this page's session state, never on the pet.
  const MING_SPEED_LEVELS = Object.freeze([1, 9, 19, 29, 39, 49, 59, 69, 79, 89, 99]);
  function getSpeedLevel(pet) {
    return pet?.id === 619 ? tierState.mingSpeedLevel : RKData.getPetLevel(pet);
  }
  function speedRowKey(base, level, petId) {
    return petId === 619 ? 'pet:619' : `${base}:${level}`;
  }
  function rowContainsPet(row, pet) {
    return !!pet && row.base === pet.base_spd && row.key === speedRowKey(pet.base_spd, getSpeedLevel(pet), pet.id);
  }

  function levelRows(speeds, monsters) {
    const rows = speeds.map(base => ({ base, level: 60, key: speedRowKey(base, 60) }));
    for (const pet of monsters) {
      if (pet.hidden || !pet.base_spd) continue;
      const level = getSpeedLevel(pet), key = speedRowKey(pet.base_spd, level, pet.id);
      if ((pet.id === 619 || level !== 60) && !rows.some(row => row.key === key)) {
        rows.push({ base: pet.base_spd, level, key });
      }
    }
    const mingIndex = rows.findIndex(row => row.key === 'pet:619');
    const mingRow = mingIndex < 0 ? null : rows.splice(mingIndex, 1)[0];
    rows.sort((a, b) => b.base - a.base || b.level - a.level);
    if (mingRow) {
      // Fixed display slot between the105 and100 tiers, not a synthetic base stat
      // or computed-speed sort. Keep its species key and actual selected level.
      const before100 = rows.findIndex(row => row.base <= 100);
      rows.splice(before100 < 0 ? rows.length : before100, 0, mingRow);
    }
    return rows;
  }

  function stepMingSpeedLevel(direction) {
    const current = tierState.mingSpeedLevel;
    const next = direction < 0 ? MING_SPEED_LEVELS.filter(level => level < current).at(-1)
      : MING_SPEED_LEVELS.find(level => level > current);
    if (next === undefined) return;
    tierState.mingSpeedLevel = next;
    if (tierState.selectedRowKey === 'pet:619') tierState.selectedLevel = next;
    renderTierTable();
  }

  function render(container) {
    onLeave();
    loadPetPriority(); loadFormOverrides();
    container.innerHTML = `
      <div class="speed-tier-box speed-responsive scroll-container">
        <div class="speed-tier-controls" style="flex-direction:column; align-items:center; gap:12px;">
          <div class="tier-ctrl-group" style="display:flex; justify-content:center;">
            <div id="tier-search-slot"></div>
          </div>
          <div class="tier-ctrl-group" style="display:flex; align-items:center; gap:12px;">
            <div style="display:flex; align-items:center; gap:4px;">
              <span class="tier-ctrl-label" style="font-size:16px;">固定加成:</span>
              <input type="number" id="tier-fixed" value="0" class="tier-num-input">
              <button class="tier-quick-btn" data-fixed="-20">-20</button>
              <button class="tier-quick-btn" data-fixed="0">0</button>
<button class="tier-quick-btn" data-fixed="20">+20</button>
<button class="tier-quick-btn" data-fixed="30">+30</button>
<button class="tier-quick-btn" data-fixed="50">+50</button>
              <button class="tier-quick-btn" data-fixed="80">+80</button>
              <button class="tier-quick-btn" data-fixed="130">+130</button>
            </div>
            <div style="display:flex; align-items:center; gap:4px;">
              <span class="tier-ctrl-label" style="font-size:16px;">百分比:</span>
              <input type="number" id="tier-percent" value="0" class="tier-num-input">
              <span class="tier-unit">%</span>
              <button class="tier-quick-btn" data-percent="0">0%</button>
              <button class="tier-quick-btn" data-percent="20">20%</button>
            </div>
          </div>
          <div class="tier-ctrl-group" style="display:flex; align-items:center; gap:8px;">
            <button class="tier-quick-btn" id="tier-negnature-btn" style="min-width:auto;">-性格</button>
            <button class="tier-quick-btn" id="tier-iv-btn" style="min-width:auto;">+个体</button>
            <button class="tier-quick-btn" id="tier-nature-btn" style="min-width:auto;">+性格</button>
            <button class="tier-quick-btn" id="tier-monsters-btn" style="min-width:auto;">精灵</button>
          </div>
        </div>
        <div class="speed-tier-table-wrap">
          <table class="speed-tier-table" id="speed-tier-table"></table>
          <div class="tier-overlay" id="tier-overlay" style="display:none;"></div>
        </div>
      </div>
    `;
    bindTierTable();
    // 创建搜索框
    const acSearch = CommonUI.createSearchBox({
      placeholder: '搜索精灵名称...',
      limit: 10,
      onInput: (val) => {
        tierState.search = val.trim().toLowerCase();
        tierState.searchDisplay = val;
        tierState.searchPetId = null;
        tierState.selectedCol = null;
        tierState.selectedSpeed = null;
        tierState.selectedRowKey = null;
        // Typing must not close the candidate dropdown via table scroll events.
        // Empty input already closes it, and must remove temporary low-speed rows now.
        if (!tierState.search) renderTierTable();
      },
      onSelect: (pet) => {
        const displayName = RKData.getMonsterDisplayName(pet);
        tierState.search = displayName.toLowerCase();
        tierState.searchDisplay = displayName;
        tierState.searchPetId = pet.id;
        tierState.selectedCol = null;
        tierState.selectedSpeed = null;
        tierState.selectedRowKey = null;
        tierState.scrollIntoView = true;
        setFormOverride(pet);
        recordPetSearch(pet);
        window.SpeedLeaderDisplay?.recordSearch(pet, RKData.getMonsters());
        renderTierTable();
      },
      renderItem: CommonUI.monsterRenderItem(m => '速度资质 ' + (m.base_spd || 0) + (m.id === 619 || getSpeedLevel(m) !== 60 ? ' · Lv' + getSpeedLevel(m) : ''))
    });
    acSearch.input.id = 'tier-search';
    if (tierState.searchDisplay) {
      // 恢复搜索框：设置文本 + 手动同步图标，不触发 onInput 避免覆盖状态
      acSearch.setValue(tierState.searchDisplay);
    }
    document.getElementById('tier-search-slot').appendChild(acSearch.wrapper);
    renderTierTable();
    bindResponsiveLayout();
  }

  /* ===== 形态组索引（用于多形态精灵去重） ===== */
  let formGroupIndex = null;
  function buildFormGroupIndex() {
    formGroupIndex = new Map();
    const all = RKData.getMonsters();
    for (const m of all) {
      if (m.hidden) continue;
      const name = RKData.getMonsterName(m);
      const gk = m.form_category === '主形态' ? (m.form || 'default') : (m.main_form_name || m.form || 'default');
      const key = name + '|' + gk;
      if (!formGroupIndex.has(key)) formGroupIndex.set(key, []);
      formGroupIndex.get(key).push(m);
    }
    for (const arr of formGroupIndex.values()) {
      arr.sort((a, b) => {
        if (a.form_category === '主形态' && b.form_category !== '主形态') return -1;
        if (a.form_category !== '主形态' && b.form_category === '主形态') return 1;
        return 0;
      });
    }
  }
  function getMainForm(m) {
    if (!formGroupIndex) buildFormGroupIndex();
    const name = RKData.getMonsterName(m);
    const gk = m.form_category === '主形态' ? (m.form || 'default') : (m.main_form_name || m.form || 'default');
    const key = name + '|' + gk;
    const group = formGroupIndex.get(key);
    if (!group) return null;
    return group.find(x => x.form_category === '主形态') || null;
  }

  /* ===== 速度档位表逻辑 ===== */
  function bindTierTable() {
    const fixedInput = document.getElementById('tier-fixed');
    fixedInput.value = tierState.fixed;
    fixedInput.addEventListener('input', function () {
      tierState.fixed = parseFloat(this.value) || 0;
      renderTierTable();
    });
    const percentInput = document.getElementById('tier-percent');
    percentInput.value = tierState.percent;
    percentInput.addEventListener('input', function () {
      tierState.percent = parseFloat(this.value) || 0;
      renderTierTable();
    });

    // 快捷按钮
    document.querySelectorAll('.tier-quick-btn[data-fixed]').forEach(btn => {
      btn.addEventListener('click', function () {
        const val = parseFloat(this.dataset.fixed);
        const input = document.getElementById('tier-fixed');
        input.value = val;
        tierState.fixed = val;
        renderTierTable();
      });
    });
    document.querySelectorAll('.tier-quick-btn[data-percent]').forEach(btn => {
      btn.addEventListener('click', function () {
        const val = parseFloat(this.dataset.percent);
        const input = document.getElementById('tier-percent');
        input.value = val;
        tierState.percent = val;
        renderTierTable();
      });
    });

    // +个体切换
    const ivBtn = document.getElementById('tier-iv-btn');
    ivBtn.addEventListener('click', function () {
      tierState.iv = !tierState.iv;
      this.style.background = tierState.iv ? '#667eea' : '';
      this.style.color = tierState.iv ? '#fff' : '';
      if (!tierState.iv && tierState.selectedCol === 'iv') tierState.selectedCol = null;
      renderTierTable();
    });
    if (tierState.iv) { ivBtn.style.background = '#667eea'; ivBtn.style.color = '#fff'; }

    // +性格切换
    const natureBtn = document.getElementById('tier-nature-btn');
    natureBtn.addEventListener('click', function () {
      tierState.nature = !tierState.nature;
      this.style.background = tierState.nature ? '#667eea' : '';
      this.style.color = tierState.nature ? '#fff' : '';
      if (!tierState.nature && tierState.selectedCol === 'ivNature') tierState.selectedCol = null;
      renderTierTable();
    });
    if (tierState.nature) { natureBtn.style.background = '#667eea'; natureBtn.style.color = '#fff'; }

    // -性格切换
    const negNatureBtn = document.getElementById('tier-negnature-btn');
    negNatureBtn.addEventListener('click', function () {
      tierState.negNature = !tierState.negNature;
      if (tierState.negNature) {
        this.style.background = '#e53935';
        this.style.color = '#fff';
      } else {
        this.style.background = '';
        this.style.color = '';
      }
      if (!tierState.negNature && tierState.selectedCol === 'negNature') tierState.selectedCol = null;
      renderTierTable();
    });
    if (tierState.negNature) { negNatureBtn.style.background = '#e53935'; negNatureBtn.style.color = '#fff'; }

    // 精灵列切换
    const monstersBtn = document.getElementById('tier-monsters-btn');
    if (tierState.showMonsters) { monstersBtn.style.background = '#667eea'; monstersBtn.style.color = '#fff'; }
    monstersBtn.addEventListener('click', function () {
      tierState.showMonsters = !tierState.showMonsters;
      if (tierState.showMonsters) {
        this.style.background = '#667eea';
        this.style.color = '#fff';
      } else {
        this.style.background = '';
        this.style.color = '';
      }
      renderTierTable();
    });
  }

  function renderTierTable() {
    const table = document.getElementById('speed-tier-table');
    if (!table) return;

    // 获取所有不重复的基础速度值，降序排列
    const monsters = RKData.getMonsters();
    // Read the shared explicit-search choice once. Damage/speed history only sorts
    // the remaining avatars; it never elects or restores a suppressed member.
    const visibleIds = window.SpeedLeaderDisplay?.visibleIds(monsters) ?? new Set(monsters.map(m => m.id));
    const preferredIds = window.SpeedLeaderDisplay?.preferredIds?.(monsters) ?? new Set();
    const speedSet = new Set();
    monsters.forEach(m => { if (m.base_spd && m.id !== 619 && getSpeedLevel(m) === 60) speedSet.add(m.base_spd); });
    const speeds = [...speedSet]
      .filter(s => s >= 50 && (s % 5 === 0 || s === 92))
      .sort((a, b) => b - a);

    // 如果有搜索，找到匹配精灵的速度
    let highlightSpeed = null;
    let highlightMonster = null;
    let highlightLevel = tierState.selectedRowKey === 'pet:619' ? tierState.mingSpeedLevel : tierState.selectedLevel || 60;
    let highlightRowKey = tierState.selectedRowKey;
    if (tierState.search) {
      const matched = monsters.find(m => m.id === tierState.searchPetId) || monsters.find(m =>
        RKData.getMonsterName(m).toLowerCase() === tierState.search ||
        RKData.getMonsterDisplayName(m).toLowerCase() === tierState.search
      );
      if (matched && matched.base_spd) {
        highlightSpeed = matched.base_spd;
        highlightMonster = matched;
        highlightLevel = getSpeedLevel(matched);
        highlightRowKey = speedRowKey(highlightSpeed, highlightLevel, matched.id);
        // 如果搜索到的普通精灵速度不在表格中，临时新增一行
        if (matched.id !== 619 && highlightLevel === 60 && !speeds.includes(highlightSpeed)) {
          speeds.push(highlightSpeed);
          speeds.sort((a, b) => b - a);
        }
      }
    }
    // 没有搜索高亮时，使用手动选中的速度
    if (highlightSpeed === null && tierState.selectedSpeed !== null) {
      highlightSpeed = tierState.selectedSpeed;
    }


    // 构建表头（根据开关动态构建）
    const cols = [
      { key: 'speed', label: '速度' },
      ...(tierState.negNature ? [{ key: 'negNature', label: '-性格' }] : []),
      { key: 'base', label: '基础' },
      ...(tierState.iv ? [{ key: 'iv', label: '+个体' }] : []),
      ...(tierState.nature ? [{ key: 'ivNature', label: '+个体+性格' }] : []),
      ...(tierState.showMonsters ? [{ key: 'monsters', label: '精灵' }] : [])
    ];

    const rowPets = [];
    let html = '<colgroup>';
    cols.forEach(c => { html += `<col data-col-key="${c.key}">`; });
    html += '</colgroup><thead><tr>';
    cols.forEach(c => { html += `<th${c.key === 'monsters' ? ' class="th-monsters"' : ''}><span class="speed-column-label">${c.label}</span></th>`; });
    html += '</tr></thead><tbody>';

    // 计算高亮行各列的值（用于比较）
    let highlightVals = null;
    if (highlightSpeed !== null) {
      highlightVals = {
        negNature: applyBonus(calcSpeedStat(highlightSpeed, false, 2, highlightLevel)),
        base: applyBonus(calcSpeedStat(highlightSpeed, false, 0, highlightLevel)),
        iv: applyBonus(calcSpeedStat(highlightSpeed, true, 0, highlightLevel)),
        ivNature: applyBonus(calcSpeedStat(highlightSpeed, true, 1, highlightLevel))
      };
    }

    levelRows(speeds, monsters).forEach(row => {
      const { base, level, key } = row;
      const isHighlight = highlightSpeed !== null && key === highlightRowKey;
      // 高亮行：选中某列后，只有选中列显示加成值，其他列显示常规值
      const showBonus = (colKey) => {
        if (!isHighlight) return false;
        if (!tierState.selectedCol) return true;
        return tierState.selectedCol === colKey;
      };
      const baseVal = showBonus('base') ? applyBonus(calcSpeedStat(base, false, 0, level)) : calcSpeedStat(base, false, 0, level);
      const ivVal = showBonus('iv') ? applyBonus(calcSpeedStat(base, true, 0, level)) : calcSpeedStat(base, true, 0, level);
      const ivNatureVal = showBonus('ivNature') ? applyBonus(calcSpeedStat(base, true, 1, level)) : calcSpeedStat(base, true, 1, level);
      const negNatureVal = showBonus('negNature') ? applyBonus(calcSpeedStat(base, false, 2, level)) : calcSpeedStat(base, false, 2, level);

      const rowClass = isHighlight ? 'tier-highlight' : '';
      const isMing = key === 'pet:619';
      html += `<tr class="${rowClass}" data-level="${level}" data-base-speed="${base}" data-row-key="${key}">`;
      html += `<td class="td-speed"><span class="speed-column-label${isMing ? ' speed-level-selector' : ''}"><span class="speed-row-label">${base}${isMing || level !== 60 ? ' · Lv' + level : ''}</span>${isMing ? `<span class="speed-level-actions"><button type="button" class="speed-level-step" data-level-step="-1" aria-label="降低冥古龙速度计算等级"${level <= MING_SPEED_LEVELS[0] ? ' disabled' : ''}>&lt;</button><button type="button" class="speed-level-step" data-level-step="1" aria-label="提高冥古龙速度计算等级"${level >= MING_SPEED_LEVELS.at(-1) ? ' disabled' : ''}>&gt;</button></span>` : ''}</span></td>`;

      // 构建列数据（根据开关动态插入）
      const colOrder = [];
      const colData = [];
      if (tierState.negNature) { colOrder.push('negNature'); colData.push(['negNature', negNatureVal]); }
      colOrder.push('base'); colData.push(['base', baseVal]);
      if (tierState.iv) { colOrder.push('iv'); colData.push(['iv', ivVal]); }
      if (tierState.nature) { colOrder.push('ivNature'); colData.push(['ivNature', ivNatureVal]); }

      colData.forEach(([colKey, val]) => {
        let cellClass = 'tier-btn';
        if (isHighlight) {
          if (tierState.selectedCol === colKey) {
            cellClass += ' tier-selected';
          } else if (tierState.selectedCol) {
            // 选中后：左侧列变灰，右侧列如果常规值 < 选中列加成值也变灰
            const selIdx = colOrder.indexOf(tierState.selectedCol);
            const curIdx = colOrder.indexOf(colKey);
            if (curIdx < selIdx) {
              cellClass += ' tier-grayed';
            } else {
              // 右侧列：比较常规值与选中列加成值
              const curRegular = calcSpeedStat(base,
                colKey === 'iv' || colKey === 'ivNature',
                colKey === 'ivNature' ? 1 : colKey === 'negNature' ? 2 : 0, level);
              if (curRegular < highlightVals[tierState.selectedCol]) {
                cellClass += ' tier-grayed';
              } else {
                cellClass += ' tier-dim';
              }
            }
          }
        } else if (tierState.selectedCol && highlightVals) {
          // 非高亮行：如果该列被选中且当前值低于高亮行的值，则灰掉
          const currentVal = calcSpeedStat(base,
            colKey === 'iv' || colKey === 'ivNature',
            colKey === 'ivNature' ? 1 : colKey === 'negNature' ? 2 : 0, level);
          if (currentVal < highlightVals[tierState.selectedCol]) {
            cellClass += ' tier-grayed';
          }
        }
        html += `<td class="${cellClass.trim()}" data-col="${colKey}" data-speed="${base}" data-level="${level}" role="button" tabindex="0" aria-pressed="${isHighlight && tierState.selectedCol === colKey ? 'true' : 'false'}"><span class="speed-column-label">${val}</span></td>`;
      });
      // 精灵列
      if (tierState.showMonsters) {
        const pets = monsters.filter(m => {
          if (m.hidden || !visibleIds.has(m.id) || !rowContainsPet(row, m)) return false;
          // Advanced forms and confirmed leaders share the ordinary eligible pool.
          if (level === 60 && !isMing && m.evolution_stage !== '高级形态' &&
              m.evolution_stage !== '首领形态' && !m.is_leader_form) return false;
          // The shared leader choice is an exact ID, not a same-name form guess.
          // Independent form groups keep their existing override/main-form policy.
          if (!preferredIds.has(m.id) && (m.form_category === '变体形态' || m.form_category === '主形态')) {
            const fgKey = getFormGroupKey(m);
            const overrideId = tierState.formOverrides[fgKey];
            const mainForm = getMainForm(m);
            if (overrideId && visibleIds.has(overrideId)) {
              // 有覆盖：只显示被覆盖的形态
              if (m.id !== overrideId) return false;
            } else {
              // 无覆盖：只显示主形态，隐藏同速变体
              if (m.form_category === '变体形态' && mainForm && visibleIds.has(mainForm.id) && mainForm.base_spd === m.base_spd) return false;
            }
          }
          return true;
        });
        // 按搜索习惯排序：记录中的精灵排前面，顺序按记录顺序
        const priorityIds = getPetPriority(base);
        pets.sort((a, b) => {
          const ai = priorityIds.indexOf(a.id);
          const bi = priorityIds.indexOf(b.id);
          if (ai === -1 && bi === -1) return 0;
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return ai - bi;
        });
        // Keep the complete eligible pool. Search injection/priority precedes viewport slicing.
        const searchedPet = highlightMonster && visibleIds.has(highlightMonster.id) && rowContainsPet(row, highlightMonster) ? highlightMonster : null;
        const orderedPets = prioritizeSearchedPet(pets, searchedPet);
        rowPets.push(orderedPets);
        html += '<td class="td-monsters" style="text-align:left;padding:3px 8px;line-height:0;white-space:nowrap;"><div class="speed-avatar-strip"></div></td>';
      }
      html += '</tr>';
    });
    html += '</tbody>';
    syncTierTable(table, html);

    // One delegated handler per event; reused rows never accumulate listeners.
    table.onclick = e => {
      const step = e.target.closest('.speed-level-step');
      if (step) {
        e.stopPropagation();
        if (!step.disabled) stepMingSpeedLevel(Number(step.dataset.levelStep));
        return;
      }
      const avatar = e.target.closest('.speed-tier-avatar[data-pet-id]');
      if (avatar) {
        e.stopPropagation();
        if (typeof PetDexPage !== 'undefined' && PetDexPage.showPetDetail) PetDexPage.showPetDetail(Number(avatar.dataset.petId));
        return;
      }
      const cell = e.target.closest('.tier-btn[data-col]');
      if (!cell) return;
      const col = cell.dataset.col, spd = Number(cell.dataset.speed), level = Number(cell.dataset.level);
      const key = cell.closest('tr').dataset.rowKey;
      if (tierState.search) {
        // Comparison-column clicks keep the searched species/row highlighted.
        tierState.selectedCol = tierState.selectedCol === col ? null : col;
        if (key === highlightRowKey) {
          tierState.selectedSpeed = spd;
          tierState.selectedLevel = level;
          tierState.selectedRowKey = key;
        }
      } else if (tierState.selectedRowKey === key && tierState.selectedCol === col) {
        tierState.selectedSpeed = null;
        tierState.selectedRowKey = null;
        tierState.selectedCol = null;
      } else {
        tierState.selectedSpeed = spd;
        tierState.selectedLevel = level;
        tierState.selectedRowKey = key;
        tierState.selectedCol = col;
      }
      renderTierTable();
    };
    table.onkeydown = e => {
      if (e.target.closest('.speed-level-step')) {
        // Native buttons supply Enter/Space click exactly once. Do not prevent it.
        e.stopPropagation();
      } else if (e.target.closest('.tier-btn[data-col]') && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault(); e.stopPropagation();
        e.target.closest('.tier-btn[data-col]').click();
      }
    };
    table.onkeyup = e => { if (e.target.closest('.speed-level-step')) e.stopPropagation(); };
    layoutState = { table, rowPets, hasHighlight: highlightSpeed !== null };
    updateResponsiveLayout();
  }

  // Reconcile by stable row/column keys. In particular a Ming level change must
  // not replace its row, label, buttons or selected cell (and lose keyboard focus).
  function syncTierTable(table, html) {
    const body = table.querySelector('tbody');
    if (!body) { table.innerHTML = html; return; }
    const focused = table.contains(document.activeElement) ? document.activeElement : null;
    const next = document.createElement('table');
    next.innerHTML = html;
    for (const tag of ['colgroup', 'thead']) {
      const current = table.querySelector(tag), incoming = next.querySelector(tag);
      if (current.innerHTML !== incoming.innerHTML) current.innerHTML = incoming.innerHTML;
    }
    const rows = new Map([...body.children].map(row => [row.dataset.rowKey, row]));
    [...next.querySelector('tbody').children].forEach((incoming, index) => {
      const row = rows.get(incoming.dataset.rowKey) || incoming;
      rows.delete(incoming.dataset.rowKey);
      if (row !== incoming) {
        row.className = incoming.className;
        Object.assign(row.dataset, incoming.dataset);
        const cellKey = cell => cell.dataset.col || cell.className;
        const cells = new Map([...row.children].map(cell => [cellKey(cell), cell]));
        [...incoming.children].forEach((fresh, i) => {
          const cell = cells.get(cellKey(fresh)) || fresh;
          cells.delete(cellKey(fresh));
          if (cell !== fresh) {
            cell.className = fresh.className;
            Object.assign(cell.dataset, fresh.dataset);
            if (cell.className === 'td-speed') {
              cell.querySelector('.speed-row-label').textContent = fresh.querySelector('.speed-row-label').textContent;
              cell.querySelectorAll('.speed-level-step').forEach((button, j) => {
                button.disabled = fresh.querySelectorAll('.speed-level-step')[j].disabled;
              });
            } else if (cell.dataset.col) {
              cell.querySelector('.speed-column-label').textContent = fresh.querySelector('.speed-column-label').textContent;
              cell.setAttribute('aria-pressed', fresh.getAttribute('aria-pressed'));
            } else {
              // Invalidate avatar capacity so a changed search/pool is repopulated.
              cell.innerHTML = fresh.innerHTML;
            }
          }
          if (row.children[i] !== cell) row.insertBefore(cell, row.children[i] || null);
        });
        cells.forEach(cell => cell.remove());
      }
      if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null);
    });
    rows.forEach(row => row.remove());
    if (focused && table.contains(focused)) {
      const target = focused.disabled ? focused.closest('tr')?.querySelector('.speed-level-step:not(:disabled)') : focused;
      if (target && document.activeElement !== target) target.focus({ preventScroll: true });
    }
  }

  // Capacity is a layout-pixel calculation, independent of visual/CSS zoom.
  function avatarCapacity(width, avatarWidth = 32, margin = 1) {
    const stride = avatarWidth + 2 * margin;
    return Number.isFinite(width) && stride > 0 ? Math.max(0, Math.floor(width / stride)) : 0;
  }

  function prioritizeSearchedPet(pets, searched) {
    if (!searched) return pets.slice();
    return [searched, ...pets.filter(pet => pet.id !== searched.id)];
  }

  let layoutState = null;
  let layoutFrame = null;
  let layoutObserver = null;
  let layoutGeneration = 0;
  const layoutEvents = ['resize', 'appzoomchange', 'appfontchange'];

  function scheduleResponsiveLayout() {
    if (!layoutState || layoutFrame !== null) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      updateResponsiveLayout();
    });
  }

  function bindResponsiveLayout() {
    const generation = layoutGeneration;
    layoutEvents.forEach(type => window.addEventListener(type, scheduleResponsiveLayout));
    document.fonts?.addEventListener('loadingdone', scheduleResponsiveLayout);
    document.fonts?.ready.then(() => {
      if (generation === layoutGeneration) scheduleResponsiveLayout();
    });
    if (typeof ResizeObserver !== 'undefined' && layoutState) {
      let lastWidth = -1;
      layoutObserver = new ResizeObserver(entries => {
        const width = entries[0]?.contentRect.width;
        // Height changes (e.g. populated rows) must not drive another layout pass.
        if (width === lastWidth) return;
        lastWidth = width;
        scheduleResponsiveLayout();
      });
      layoutObserver.observe(layoutState.table.parentElement);
    }
  }

  function onLeave() {
    layoutGeneration++;
    layoutEvents.forEach(type => window.removeEventListener(type, scheduleResponsiveLayout));
    document.fonts?.removeEventListener('loadingdone', scheduleResponsiveLayout);
    layoutObserver?.disconnect();
    layoutObserver = null;
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    layoutFrame = null;
    layoutState = null;
  }

  function updateResponsiveLayout() {
    if (!layoutState || !layoutState.table.isConnected) return;
    const { table, rowPets, hasHighlight } = layoutState;
    const columns = [...table.querySelectorAll('col')];
    const headers = [...table.querySelectorAll('thead th')];
    const numeric = columns.map((col, i) => ({ col, i })).filter(({ col }) => col.dataset.colKey !== 'monsters');
    const hasAvatars = columns.some(col => col.dataset.colKey === 'monsters');
    // Keep the former 185px numeric width when there is room. On narrow windows shrink
    // only to the actual text footprint, then scroll horizontally rather than crushing avatars.
    const minimums = numeric.map(({ i }) => {
      const widths = [...table.querySelectorAll(`tr > :nth-child(${i + 1}) .speed-column-label`)].map(label => label.offsetWidth);
      const style = getComputedStyle(headers[i]);
      return Math.ceil(Math.max(0, ...widths) + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) + 2);
    });
    const avatarHeader = headers[columns.findIndex(col => col.dataset.colKey === 'monsters')];
    const avatarHeaderStyle = avatarHeader && getComputedStyle(avatarHeader);
    const avatarHeadingWidth = avatarHeader ? (avatarHeader.querySelector('.speed-column-label')?.offsetWidth || 0) +
      (parseFloat(avatarHeaderStyle.paddingLeft) || 0) + (parseFloat(avatarHeaderStyle.paddingRight) || 0) : 0;
    const avatarMinimum = hasAvatars ? Math.max(32 + 2 + 16, avatarHeadingWidth) + 2 : 0;
    const minimumWidth = minimums.reduce((sum, n) => sum + n, 0) + avatarMinimum;
    const minWidthStyle = `${minimumWidth}px`;
    if (table.style.minWidth !== minWidthStyle) table.style.minWidth = minWidthStyle;
    const spare = Math.max(0, table.parentElement.clientWidth - minimumWidth);
    const preferredExtra = minimums.map(n => Math.max(0, 185 - n));
    const extraTotal = preferredExtra.reduce((sum, n) => sum + n, 0);
    const fraction = extraTotal ? Math.min(1, spare / extraTotal) : 0;
    numeric.forEach(({ col }, i) => {
      const width = `${minimums[i] + preferredExtra[i] * fraction}px`;
      if (col.style.width !== width) col.style.width = width;
    });
    const strips = [...table.querySelectorAll('.speed-avatar-strip')];
    // Read every width before writing avatars; fixed layout and the clipped strips make
    // capacity independent of their contents, so adding/removing avatars cannot feed back.
    const capacities = strips.map(strip => avatarCapacity(parseFloat(getComputedStyle(strip).width)));
    strips.forEach((strip, i) => {
      const capacity = capacities[i];
      if (strip.dataset.capacity === String(capacity)) return;
      strip.dataset.capacity = String(capacity);
      strip.innerHTML = rowPets[i].slice(0, capacity).map(m => {
        const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const rawName = RKData.getMonsterDisplayName(m);
        const name = escape(rawName);
        const image = m.image ? `<img src="${escape('assets/monster/images/' + m.image)}" alt="" loading="lazy">` : escape(rawName.charAt(0));
        return `<button type="button" class="speed-tier-avatar" title="${name}" aria-label="${name}" data-pet-id="${m.id}">${image}</button>`;
      }).join('');
    });
    positionOverlay(table, hasHighlight);
  }

  function positionOverlay(table, hasHighlight) {
    const overlay = document.getElementById('tier-overlay');
    if (!overlay) return;
    if (!hasHighlight) { overlay.style.display = 'none'; return; }

    const wrap = table.parentElement;
    const wrapRect = wrap.getBoundingClientRect();
    const _z = (window.__getPageZoom && window.__getPageZoom()) || 1;
    const highlightRow = table.querySelector('tr.tier-highlight');
    if (!highlightRow) { overlay.style.display = 'none'; return; }

    if (tierState.selectedCol) {
      // 选中状态：overlay 只包裹选中的单元格
      const selectedTd = highlightRow.querySelector('.tier-selected');
      if (selectedTd) {
        const tdRect = selectedTd.getBoundingClientRect();
        overlay.style.display = 'block';
        overlay.classList.add('tier-overlay-selected');
        overlay.style.left = ((tdRect.left - wrapRect.left) / _z) + 'px';
        overlay.style.top = ((tdRect.top - wrapRect.top) / _z) + 'px';
        overlay.style.width = (tdRect.width / _z) + 'px';
        overlay.style.height = (tdRect.height / _z) + 'px';
      }
    } else {
      // 未选中：overlay 包裹整行4个数值（td-speed + 3个 tier-btn）
      const firstTd = highlightRow.querySelector('.td-speed');
      const lastTd = highlightRow.querySelector('td:last-child');
      if (firstTd && lastTd) {
        const firstRect = firstTd.getBoundingClientRect();
        const lastRect = lastTd.getBoundingClientRect();
        overlay.style.display = 'block';
        overlay.classList.remove('tier-overlay-selected');
        overlay.style.left = ((firstRect.left - wrapRect.left) / _z) + 'px';
        overlay.style.top = ((firstRect.top - wrapRect.top) / _z) + 'px';
        overlay.style.width = ((lastRect.right - firstRect.left) / _z) + 'px';
        overlay.style.height = (firstRect.height / _z) + 'px';
      }
    }
    // 自动滚动让高亮行可见（仅搜索选中时）
    if (highlightRow && tierState.scrollIntoView) {
      tierState.scrollIntoView = false;
      highlightRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  return { render, onLeave };
})();
