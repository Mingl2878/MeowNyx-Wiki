/**
 * speed.js — 速度线页面
 * 速度档位表（基础速度 → 各加成下实际速度）
 */
const SpeedPage = (function () {
  let tierState = { iv: true, nature: true, fixed: 0, percent: 0, search: '', searchDisplay: '', selectedCol: null, negNature: false, showMonsters: true, selectedSpeed: null, formOverrides: {} };

  /* ===== 搜索习惯持久化（localStorage） ===== */
  const PET_PRIORITY_KEY = 'rk_speed_pet_priority';
  // 结构: { "speed值": [monsterId, monsterId, ...] }
  let petPriority = {};
  function loadPetPriority() {
    try {
      const raw = localStorage.getItem(PET_PRIORITY_KEY);
      petPriority = raw ? JSON.parse(raw) : {};
    } catch (e) { petPriority = {}; }
  }
  function savePetPriority() {
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
    savePetPriority();
  }
  function getPetPriority(spd) {
    return petPriority[spd] || [];
  }
  loadPetPriority();

  /* ===== 形态覆盖持久化（localStorage） ===== */
  const FORM_OVERRIDE_KEY = 'rk_speed_form_overrides';
  function loadFormOverrides() {
    try {
      const raw = localStorage.getItem(FORM_OVERRIDE_KEY);
      tierState.formOverrides = raw ? JSON.parse(raw) : {};
    } catch (e) { tierState.formOverrides = {}; }
  }
  function saveFormOverrides() {
    try { localStorage.setItem(FORM_OVERRIDE_KEY, JSON.stringify(tierState.formOverrides)); } catch (e) {}
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
    saveFormOverrides();
  }
  loadFormOverrides();

  /* ===== 属性计算公式（与 data.js getPetStat 一致，非HP） ===== */
  function calcSpeedStat(base, iv, nature) {
    const ivVal = iv ? 10 : 0;
    const natureMod = nature === 1 ? 1.2 : nature === 2 ? 0.9 : 1.0;
    return Math.round(Math.round(Math.round(1.1 * (base + 3 * ivVal)) + 10) * natureMod) + 50;
  }

  function applyBonus(val) {
    return Math.floor((val + tierState.fixed) * (1 + tierState.percent / 100));
  }

  function render(container) {
    container.innerHTML = `
      <div class="speed-tier-box scroll-container">
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
        tierState.selectedCol = null;
        tierState.selectedSpeed = null;
        // 不调用 renderTierTable()，避免表格重建触发 scroll 事件导致下拉列表被隐藏
      },
      onSelect: (pet) => {
        const displayName = RKData.getMonsterDisplayName(pet);
        tierState.search = displayName.toLowerCase();
        tierState.searchDisplay = displayName;
        tierState.selectedCol = null;
        tierState.selectedSpeed = null;
        tierState.scrollIntoView = true;
        setFormOverride(pet);
        recordPetSearch(pet);
        renderTierTable();
      },
      renderItem: CommonUI.monsterRenderItem(m => '速度 ' + (m.base_spd || 0))
    });
    acSearch.input.id = 'tier-search';
    if (tierState.searchDisplay) {
      // 恢复搜索框：设置文本 + 手动同步图标，不触发 onInput 避免覆盖状态
      acSearch.setValue(tierState.searchDisplay);
    }
    document.getElementById('tier-search-slot').appendChild(acSearch.wrapper);
    renderTierTable();
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
    const speedSet = new Set();
    monsters.forEach(m => { if (m.base_spd) speedSet.add(m.base_spd); });
    const speeds = [...speedSet]
      .filter(s => s >= 40 && (s % 5 === 0 || s === 92 || s === 44 || s === 49) && s !== 45)
      .sort((a, b) => b - a);

    // 如果有搜索，找到匹配精灵的速度
    let highlightSpeed = null;
    let highlightMonster = null;
    if (tierState.search) {
      const matched = monsters.find(m =>
        RKData.getMonsterName(m).toLowerCase() === tierState.search ||
        RKData.getMonsterDisplayName(m).toLowerCase() === tierState.search
      );
      if (matched && matched.base_spd) {
        highlightSpeed = matched.base_spd;
        highlightMonster = matched;
        // 如果搜索到的精灵速度不在表格中，临时新增一行
        if (!speeds.includes(highlightSpeed)) {
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

    let html = '<colgroup>';
    cols.forEach(c => { html += `<col${c.key === 'monsters' ? ' style="width:auto;"' : ' style="width:185px;"'}>`; });
    html += '</colgroup><thead><tr>';
    cols.forEach(c => { html += `<th${c.key === 'monsters' ? ' class="th-monsters"' : ''}>${c.label}</th>`; });
    html += '</tr></thead><tbody>';

    // 计算高亮行各列的值（用于比较）
    let highlightVals = null;
    if (highlightSpeed !== null) {
      highlightVals = {
        negNature: applyBonus(calcSpeedStat(highlightSpeed, false, 2)),
        base: applyBonus(calcSpeedStat(highlightSpeed, false, 0)),
        iv: applyBonus(calcSpeedStat(highlightSpeed, true, 0)),
        ivNature: applyBonus(calcSpeedStat(highlightSpeed, true, 1))
      };
    }

    speeds.forEach(base => {
      const isHighlight = highlightSpeed !== null && base === highlightSpeed;
      // 高亮行：选中某列后，只有选中列显示加成值，其他列显示常规值
      const showBonus = (colKey) => {
        if (!isHighlight) return false;
        if (!tierState.selectedCol) return true;
        return tierState.selectedCol === colKey;
      };
      const baseVal = showBonus('base') ? applyBonus(calcSpeedStat(base, false, 0)) : calcSpeedStat(base, false, 0);
      const ivVal = showBonus('iv') ? applyBonus(calcSpeedStat(base, true, 0)) : calcSpeedStat(base, true, 0);
      const ivNatureVal = showBonus('ivNature') ? applyBonus(calcSpeedStat(base, true, 1)) : calcSpeedStat(base, true, 1);
      const negNatureVal = showBonus('negNature') ? applyBonus(calcSpeedStat(base, false, 2)) : calcSpeedStat(base, false, 2);

      const hasSelection = isHighlight && tierState.selectedCol;
      const rowClass = isHighlight ? 'tier-highlight' : '';
      html += `<tr class="${rowClass}">`;
      html += `<td class="td-speed">${base}</td>`;

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
                colKey === 'ivNature' ? 1 : colKey === 'negNature' ? 2 : 0);
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
            colKey === 'ivNature' ? 1 : colKey === 'negNature' ? 2 : 0);
          if (currentVal < highlightVals[tierState.selectedCol]) {
            cellClass += ' tier-grayed';
          }
        }
        html += `<td class="${cellClass.trim()}" data-col="${colKey}" data-speed="${base}" style="cursor:pointer;">${val}</td>`;
      });
      // 精灵列
      if (tierState.showMonsters) {
        const pets = monsters.filter(m => {
          if (m.base_spd !== base) return false;
          // 过滤掉非高级形态（除非例外）
          if (m.evolution_stage !== '高级形态') {
            const name = RKData.getMonsterName(m);
            if (name !== '武斗酷猫' && name !== '恶魔男爵') return false;
          }
          // 多形态去重：同速度的形态只显示一个
          // 优先级：形态覆盖 > 主形态 > 变体形态
          if (m.form_category === '变体形态' || m.form_category === '主形态') {
            const fgKey = getFormGroupKey(m);
            const overrideId = tierState.formOverrides[fgKey];
            const mainForm = getMainForm(m);
            if (overrideId) {
              // 有覆盖：只显示被覆盖的形态
              if (m.id !== overrideId) return false;
            } else {
              // 无覆盖：只显示主形态，隐藏同速变体
              if (m.form_category === '变体形态' && mainForm && mainForm.base_spd === m.base_spd) return false;
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
        const petsSliced = pets.slice(0, 13);
        // 搜索精灵：如果该精灵属于当前行速度且不在列表中，插入到首位
        if (highlightMonster && highlightMonster.base_spd === base) {
          const idx = petsSliced.findIndex(m => m.id === highlightMonster.id);
          if (idx === -1) {
            petsSliced.unshift(highlightMonster);
            if (petsSliced.length > 13) petsSliced.pop();
          } else if (idx > 0) {
            petsSliced.unshift(petsSliced.splice(idx, 1)[0]);
          }
        }
        let petImgs = '';
        const petIds = [];
        petsSliced.forEach(m => {
          const name = RKData.getMonsterDisplayName(m);
          const img = m.image ? `assets/monster/images/${m.image}` : '';
          if (img) {
            petImgs += `<img src="${img}" title="${name}" data-pet-id="${m.id}" style="width:32px;height:32px;object-fit:cover;border-radius:3px;margin:0 1px;cursor:pointer;vertical-align:middle;" onerror="this.style.display='none'">`;
            petIds.push(m.id);
          }
        });
        html += `<td class="td-monsters" style="text-align:left;padding:3px 8px;line-height:0;white-space:nowrap;">${petImgs || ''}</td>`;
      }
      html += '</tr>';
    });
    html += '</tbody>';
    table.innerHTML = html;

    // 绑定数据单元格点击事件
    table.querySelectorAll('.tier-btn[data-col]').forEach(td => {
      td.addEventListener('click', function () {
        const col = this.dataset.col;
        const spd = parseInt(this.dataset.speed);
        if (tierState.search) {
          // 搜索模式：只切换列选中
          tierState.selectedCol = (tierState.selectedCol === col) ? null : col;
        } else {
          // 手动模式：点击单元格 → 选中该行+该列；再次点击同一单元格 → 取消
          if (tierState.selectedSpeed === spd && tierState.selectedCol === col) {
            tierState.selectedSpeed = null;
            tierState.selectedCol = null;
          } else {
            tierState.selectedSpeed = spd;
            tierState.selectedCol = col;
          }
        }
        renderTierTable();
      });
    });

    // 绑定精灵头像点击事件 —— 打开精灵详情弹窗
    table.querySelectorAll('img[data-pet-id]').forEach(img => {
      img.addEventListener('click', function(e) {
        e.stopPropagation();
        const id = parseInt(this.dataset.petId);
        if (PetDexPage && PetDexPage.showPetDetail) {
          PetDexPage.showPetDetail(id);
        }
      });
    });

    // 定位 overlay 边框
    positionOverlay(table, highlightSpeed !== null);
  }

  function positionOverlay(table, hasHighlight) {
    const overlay = document.getElementById('tier-overlay');
    if (!overlay) return;
    if (!hasHighlight) { overlay.style.display = 'none'; return; }

    const wrap = table.parentElement;
    const wrapRect = wrap.getBoundingClientRect();
    const highlightRow = table.querySelector('tr.tier-highlight');
    if (!highlightRow) { overlay.style.display = 'none'; return; }

    if (tierState.selectedCol) {
      // 选中状态：overlay 只包裹选中的单元格
      const selectedTd = highlightRow.querySelector('.tier-selected');
      if (selectedTd) {
        const tdRect = selectedTd.getBoundingClientRect();
        overlay.style.display = 'block';
        overlay.classList.add('tier-overlay-selected');
        overlay.style.left = (tdRect.left - wrapRect.left) + 'px';
        overlay.style.top = (tdRect.top - wrapRect.top) + 'px';
        overlay.style.width = tdRect.width + 'px';
        overlay.style.height = tdRect.height + 'px';
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
        overlay.style.left = (firstRect.left - wrapRect.left) + 'px';
        overlay.style.top = (firstRect.top - wrapRect.top) + 'px';
        overlay.style.width = (lastRect.right - firstRect.left) + 'px';
        overlay.style.height = firstRect.height + 'px';
      }
    }
    // 自动滚动让高亮行可见（仅搜索选中时）
    if (highlightRow && tierState.scrollIntoView) {
      tierState.scrollIntoView = false;
      highlightRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  return { render };
})();
