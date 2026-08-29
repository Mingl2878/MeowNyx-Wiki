/**
 * petdex.js — 精灵图鉴页面
 * 亮色主题，pill属性筛选，形态筛选，完整数据表格
 */
const PetDexPage = (function () {
  let state = {
    keyword: '',
    activeTypes: new Set(),    // 选中的属性集合，多选交集筛选
    activeForms: new Set(['high']),  // 多选: 'high' | 'leader'
    sortKey: 'dex_number',
    sortAsc: true,
    selectedRow: null,
    highlightedRow: null
  };

  // 记录被收起的精灵 id 集合（默认展开）
  let collapsedTraits = new Set([129, 469]);
  // 长描述阈值（超过则显示展开/收起箭头）
  const TRAIT_LONG_THRESHOLD = 50;
  // 记录已展开形态的主形态 id 集合
  let expandedForms = new Set();

  function render(container) {
    container.innerHTML = `
      <!-- 筛选面板 -->
      <div class="filter-panel">
        <div id="petdex-search-slot" style="text-align:center;margin-bottom:16px;"></div>
        <!-- 属性 pills -->
        <div class="filter-section">
          <div class="type-pills" id="type-pills"></div>
        </div>
        <!-- 形态筛选 -->
        <div class="filter-section" style="display:flex;align-items:center;justify-content:center;gap:12px;">
          <span class="filter-section-label" style="margin-bottom:0;white-space:nowrap;">精灵形态</span>
          <div class="form-buttons" id="form-buttons">
            <button class="form-btn" data-form="regional">地区形态</button>
            <button class="form-btn active" data-form="high">高阶形态</button>
            <button class="form-btn" data-form="leader">首领形态</button>
          </div>
        </div>
      </div>
      <!-- 数据表格 -->
      <div class="scroll-wrapper-container">
      <div class="data-table-wrapper hide-scrollbar" id="data-table-wrapper">
        <table class="data-table" id="pet-table">
          <thead>
            <tr>
              <th data-sort="dex_number">编号</th>
              <th data-sort="name">精灵</th>
              <th>属性</th>
              <th>特性</th>
              <th data-sort="base_hp">生命</th>
              <th data-sort="base_phy_atk">物攻</th>
              <th data-sort="base_mag_atk">魔攻</th>
              <th data-sort="base_phy_def">物防</th>
              <th data-sort="base_mag_def">魔防</th>
              <th data-sort="base_spd">速度</th>
              <th data-sort="total">总种族值</th>
              <th data-sort="effective">有效种族值</th>
            </tr>
          </thead>
          <tbody id="pet-tbody"></tbody>
        </table>
      </div>
      </div>
    `;
    renderTypePills();
    // 创建搜索框（纯文本，无下拉，搜索精灵名称和特性）
    const searchWrap = document.createElement('div');
    searchWrap.className = 'petdex-search-wrap';
    searchWrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;max-width:400px;width:100%;';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'petdex-search';
    searchInput.className = 'search-bar';
    searchInput.placeholder = '搜索精灵名称或特性...';
    searchInput.setAttribute('autocomplete', 'off');
    searchInput.style.cssText = 'width:100%;';
    searchWrap.appendChild(searchInput);
    searchInput.value = state.keyword || '';
    searchInput.addEventListener('input', () => {
      state.keyword = searchInput.value;
      renderTable();
    });
    document.getElementById('petdex-search-slot').appendChild(searchWrap);
    bindEvents();
    // 恢复形态按钮状态
    if (state.activeForms.has('high')) document.querySelector('.form-btn[data-form="high"]')?.classList.add('active');
    else document.querySelector('.form-btn[data-form="high"]')?.classList.remove('active');
    if (state.activeForms.has('leader')) document.querySelector('.form-btn[data-form="leader"]')?.classList.add('active');
    else document.querySelector('.form-btn[data-form="leader"]')?.classList.remove('active');
    if (allExpanded) document.querySelector('.form-btn[data-form="regional"]')?.classList.add('active');
    else document.querySelector('.form-btn[data-form="regional"]')?.classList.remove('active');
    renderTable();
  }

  function renderTypePills() {
    CommonUI.renderTypePills(
      document.getElementById('type-pills'),
      state.activeTypes,
      (type) => {
        if (state.activeTypes.has(type)) {
          state.activeTypes.delete(type);
        } else {
          state.activeTypes.add(type);
        }
        renderTypePills();
        renderTable();
      }
    );
  }


  function bindEvents() {

    // 形态按钮（多选）
    document.getElementById('form-buttons').addEventListener('click', e => {
      const btn = e.target.closest('.form-btn');
      if (!btn) return;
      const form = btn.dataset.form;
      if (form === 'regional') {
        // 地区形态：展开/收起所有折叠的变体形态
        if (allExpanded) {
          expandedForms.clear();
          allExpanded = false;
          btn.classList.remove('active');
        } else {
          for (const m of RKData.getMonsters()) {
            if (m.hidden) continue;
            if (m.form_category === '主形态' && getFormVariants(m).length > 0) {
              expandedForms.add(m.id);
            }
          }
          allExpanded = true;
          btn.classList.add('active');
        }
      } else {
        // 高阶/首领多选
        if (state.activeForms.has(form)) {
          state.activeForms.delete(form);
        } else {
          state.activeForms.add(form);
        }
        btn.classList.toggle('active');
      }
      renderTable();
    });

    // 排序：左键降序，右键升序，再次点击同一方向恢复默认
    document.querySelectorAll('#pet-table th[data-sort]').forEach(th => {
      th.addEventListener('click', e => {
        const key = th.dataset.sort;
        if (state.sortKey === key && !state.sortAsc) {
          // 当前已是该列降序 → 恢复默认
          state.sortKey = 'dex_number';
          state.sortAsc = true;
        } else {
          state.sortKey = key;
          state.sortAsc = false; // 降序
        }
        updateSortHeaders();
        renderTable();
      });
      th.addEventListener('contextmenu', e => {
        e.preventDefault();
        const key = th.dataset.sort;
        if (state.sortKey === key && state.sortAsc && key !== 'dex_number') {
          // 当前已是该列升序 → 恢复默认
          state.sortKey = 'dex_number';
          state.sortAsc = true;
        } else {
          state.sortKey = key;
          state.sortAsc = true; // 升序
        }
        updateSortHeaders();
        renderTable();
      });
    });
    updateSortHeaders();

    // 回到顶部 + 滑到底部 + 右键拖拽手势
    CommonUI.bindScrollControls('#data-table-wrapper');
  }

  function updateSortHeaders() {
    const isDefault = state.sortKey === 'dex_number' && state.sortAsc;
    document.querySelectorAll('#pet-table th[data-sort]').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.sort === state.sortKey) {
        th.classList.add(state.sortAsc ? 'sort-asc' : 'sort-desc');
      }
      // 编号列表头：默认显示"编号"，排序状态显示"(#)"
      if (th.dataset.sort === 'dex_number') {
        th.textContent = isDefault ? '编号' : '(#)';
      }
    });
  }

  /** 获取精灵的形态组键（主形态用 form，变体用 main_form_name） */
  function getFormGroupKey(m) {
    if (m.form_category === '主形态') return m.form || 'default';
    return m.main_form_name || m.form || 'default';
  }

  /** 构建形态组索引：key(name + groupKey) -> [主形态, ...变体形态] */
  let formGroupIndex = null;
  function buildFormGroupIndex() {
    formGroupIndex = new Map();
    const all = RKData.getMonsters();
    for (const m of all) {
      if (m.hidden) continue;
      const name = RKData.getMonsterName(m);
      const gk = getFormGroupKey(m);
      const key = name + '|' + gk;
      if (!formGroupIndex.has(key)) formGroupIndex.set(key, []);
      formGroupIndex.get(key).push(m);
    }
    // 每组内排序：主形态在前，变体在后
    for (const arr of formGroupIndex.values()) {
      arr.sort((a, b) => {
        if (a.form_category === '主形态' && b.form_category !== '主形态') return -1;
        if (a.form_category !== '主形态' && b.form_category === '主形态') return 1;
        return 0;
      });
    }
  }

  /** 获取某主形态精灵的变体形态列表 */
  function getFormVariants(m) {
    if (!formGroupIndex) buildFormGroupIndex();
    const name = RKData.getMonsterName(m);
    const gk = getFormGroupKey(m);
    const key = name + '|' + gk;
    const group = formGroupIndex.get(key);
    if (!group) return [];
    return group.filter(x => x.id !== m.id);
  }

  let allExpanded = false;

  function getFilteredMonsters() {
    let list = RKData.getMonsters().filter(m => !m.hidden);

    // 形态筛选（多选：高阶/首领可同时选，都不选则显示全部）
    if (state.activeForms.size > 0) {
      list = list.filter(m => {
        const stages = [];
        if (state.activeForms.has('high')) stages.push('高级形态');
        if (state.activeForms.has('leader')) stages.push('首领形态');
        return stages.includes(m.evolution_stage);
      });
    }

    // 默认只显示主形态和无多形态，变体形态折叠
    // 但搜索时如果变体形态匹配关键词，也一并显示
    list = list.filter(m => {
      if (m.form_category !== '变体形态') return true;
      // 搜索关键词匹配变体形态时，直接放行
      if (state.keyword) {
        const kw = state.keyword.toLowerCase();
        if (RKData.getMonsterDisplayName(m).toLowerCase().includes(kw)) return true;
      }
      // 变体形态：检查对应的主形态是否已展开
      const name = RKData.getMonsterName(m);
      const gk = getFormGroupKey(m);
      const key = name + '|' + gk;
      const group = formGroupIndex ? formGroupIndex.get(key) : null;
      if (group) {
        const mainForm = group.find(x => x.form_category === '主形态');
        if (mainForm && expandedForms.has(mainForm.id)) return true;
      }
      return false;
    });

    // 属性筛选（交集：必须同时包含所有选中属性）
    if (state.activeTypes.size > 0) {
      list = list.filter(m => {
        const types = [m.main_type?.name, m.sub_type?.name].filter(Boolean);
        for (const t of state.activeTypes) {
          if (!types.includes(t)) return false;
        }
        return true;
      });
    }

    // 搜索（精灵名称 + 形态名称 + 特性名称/描述）
    if (state.keyword) {
      const kw = state.keyword.toLowerCase();
      list = list.filter(m => {
        if (RKData.getMonsterName(m).toLowerCase().includes(kw)) return true;
        if (RKData.getMonsterDisplayName(m).toLowerCase().includes(kw)) return true;
        const trait = RKData.getTraitInfo(m);
        if (trait.name && trait.name.toLowerCase().includes(kw)) return true;
        if (trait.desc && trait.desc.toLowerCase().includes(kw)) return true;
        return false;
      });
    }

    // 排序
    const key = state.sortKey;
    list.sort((a, b) => {
      let va, vb;
      if (key === 'name') {
        va = RKData.getMonsterName(a);
        vb = RKData.getMonsterName(b);
        return state.sortAsc ? va.localeCompare(vb, 'zh') : vb.localeCompare(va, 'zh');
      }
      if (key === 'total') { va = RKData.getTotalStats(a); vb = RKData.getTotalStats(b); }
      else if (key === 'effective') {
        va = RKData.getTotalStats(a) - Math.min(a.base_phy_atk || 0, a.base_mag_atk || 0);
        vb = RKData.getTotalStats(b) - Math.min(b.base_phy_atk || 0, b.base_mag_atk || 0);
      }
      else { va = a[key] || 0; vb = b[key] || 0; }
      return state.sortAsc ? va - vb : vb - va;
    });

    return list;
  }

  function renderTable() {
    const tbody = document.getElementById('pet-tbody');
    if (!tbody) return;

    const list = getFilteredMonsters();

    const isDefaultSort = state.sortKey === 'dex_number' && state.sortAsc;
    tbody.innerHTML = list.map((m, idx) => {
      const name = RKData.getMonsterDisplayName(m);
      const nameHtml = RKData.getMonsterDisplayNameHtml(m);
      const mainType = m.main_type ? m.main_type.name : '';
      const subType = m.sub_type ? m.sub_type.name : '';
      const total = RKData.getTotalStats(m);
      const effective = total - Math.min(m.base_phy_atk || 0, m.base_mag_atk || 0);
      const dexNum = isDefaultSort
        ? String(m.dex_number || m.id).padStart(3, '0')
        : String(idx + 1);

      // 属性标签
      const typeBadges = [mainType, subType].filter(Boolean).map(t =>
        RKData.typeBadgeHtml(t)
      ).join(' ');

      // 不在名称旁显示形态后缀（形态信息已在名称中或无需显示）
      const formSuffix = '';

      // 特性
      const { name: traitName, desc: traitDesc } = RKData.getTraitInfo(m);
      const COLLAPSE_TRAIT_IDS = [129, 469];
      const isCollapseMonster = COLLAPSE_TRAIT_IDS.includes(m.id);
      const isCollapsed = collapsedTraits.has(m.id);

      // 构建特性单元格内容
      let traitCellHtml;
      if (!traitName) {
        traitCellHtml = '<span style="color:var(--text-muted);">-</span>';
      } else if (isCollapseMonster && traitDesc.includes('\n')) {
        // 多行特性：第一行摘要，剩余展开/收起
        const parts = traitDesc.split('\n');
        const traitSummary = parts[0] || '';
        const traitDetail = parts.slice(1).join('\n');
        const arrow = isCollapsed ? '▶' : '▼';
        const descText = isCollapsed ? traitSummary : traitDesc.replace(/\n/g, '<br>');
        traitCellHtml = `
          <div class="detail-trait-box" onclick="event.stopPropagation();PetDexPage.toggleTrait(${m.id})" style="cursor:pointer;">
            <div class="detail-trait-head">
              <span class="trait-arrow" onclick="event.stopPropagation();PetDexPage.toggleTrait(${m.id})">${arrow}</span>
              ${RKData.traitIconHtml(traitName, { className: 'detail-trait-icon', fallback: 'assets/icons/type/light.png' })}
              <span><span class="detail-trait-name">${traitName}:</span> <span class="detail-trait-desc">${descText}</span></span>
            </div>
          </div>`;
      } else {
        // 普通特性：直接用 buildTraitDetailHtml
        traitCellHtml = RKData.buildTraitDetailHtml(traitName, traitDesc);
      }

      // 图片
      const imgUrl = m.image ? `assets/monster/images/${m.image}` : '';
      const iconHtml = imgUrl
        ? `<img src="${imgUrl}" class="pet-icon-img" alt="${name}" loading="lazy">`
        : `<div class="pet-icon-placeholder">${mainType ? RKData.getTypeShortZh(mainType) || '?' : '?'}</div>`;

      // 形态折叠箭头（仅主形态且有变体时显示）
      let formArrow = '';
      if (m.form_category === '主形态') {
        const variants = getFormVariants(m);
        if (variants.length > 0) {
          const expanded = expandedForms.has(m.id);
          formArrow = `<span class="form-toggle-arrow" onclick="event.stopPropagation();PetDexPage.toggleForm(${m.id})">${expanded ? '▼' : '▶'}</span>`;
        }
      }

      const rowClass = m.form_category === '变体形态' ? ' class="form-variant-row"' : '';

      return `
        <tr data-id="${m.id}"${rowClass}>
          <td style="color:var(--text-muted);">${dexNum}</td>
          <td>
            <div class="pet-name-cell">
              ${iconHtml}
              <span class="pet-name-text">${nameHtml}</span>
              ${formArrow}
            </div>
          </td>
          <td>${typeBadges || '-'}</td>
          <td style="max-width:280px;white-space:normal;font-size:12px;">${traitCellHtml}</td>
          <td class="stat-col"><span class="stat-num">${m.base_hp || 0}</span></td>
          <td class="stat-col"><span class="stat-num">${m.base_phy_atk || 0}</span></td>
          <td class="stat-col"><span class="stat-num">${m.base_mag_atk || 0}</span></td>
          <td class="stat-col"><span class="stat-num">${m.base_phy_def || 0}</span></td>
          <td class="stat-col"><span class="stat-num">${m.base_mag_def || 0}</span></td>
          <td class="stat-col"><span class="stat-num">${m.base_spd || 0}</span></td>
          <td class="stat-col"><span class="stat-total">${total}</span></td>
          <td class="stat-col"><span class="stat-effective">${effective}</span></td>
        </tr>
      `;
    }).join('');

    // 行点击
    tbody.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', () => {
        const id = parseInt(tr.dataset.id);
        showPetDetail(id);
      });
    });
  }

  /** 统计条颜色 */
  const STAT_COLORS = {
    '生命': '#ef4444',
    '物攻': '#f97316',
    '魔攻': '#a855f7',
    '物防': '#3b82f6',
    '魔防': '#6366f1',
    '速度': '#eab308'
  };

  /** 计算防守属性克制（受到2倍/0.5倍伤害的属性） */
  function getDefensiveMatchups(mainType, subType) {
    const allTypes = RKData.getTypes();
    const types = [mainType, subType].filter(Boolean)
      .map(n => allTypes.find(x => x.name === n))
      .filter(Boolean);
    if (types.length === 0) return { weak2: [], weak3: [], resist05: [], resist025: [] };

    // 计算每个攻击属性对所有防守属性的总倍率
    const multipliers = {}; // atkTypeName -> total multiplier

    types.forEach(t => {
      (t.vulnerable_to || []).forEach(v => {
        multipliers[v] = (multipliers[v] || 1) * 2;
      });
      (t.resistant_to || []).forEach(r => {
        multipliers[r] = (multipliers[r] || 1) * 0.5;
      });
    });

    const weak2 = [], weak3 = [], resist05 = [], resist025 = [];
    for (const [atk, mult] of Object.entries(multipliers)) {
      if (mult >= 3) weak3.push(atk);
      else if (mult >= 2) weak2.push(atk);
      else if (mult <= 0.25) resist025.push(atk);
      else if (mult <= 0.5) resist05.push(atk);
      // mult === 1 (cancelled) -> not shown
    }

    return { weak2, weak3, resist05, resist025 };
  }

  /** 生成属性图标+文字 HTML（用于克制区域） */
  function typeIconHtml(typeName) {
    const zh = RKData.getTypeShortZh(typeName) || RKData.getTypeZh(typeName) || typeName;
    const icon = `assets/icons/type/${typeName.toLowerCase()}.png`;
    return `<span class="def-type-item"><img src="${icon}" class="def-type-icon" alt="${zh}">${zh}</span>`;
  }

  function showPetDetail(id) {
   try {
    const m = RKData.getMonsterById(id);
    if (!m) return;
    const modal = document.getElementById('pet-modal');
    const body = document.getElementById('pet-modal-body');
    if (!modal || !body) return;
    const name = RKData.getMonsterDisplayName(m);
    const nameHtml = RKData.getMonsterDisplayNameHtml(m);
    const baseName = RKData.getMonsterName(m);
    const mainType = m.main_type ? m.main_type.name : '';
    const subType = m.sub_type ? m.sub_type.name : '';
    const total = RKData.getTotalStats(m);
    const effective = total - Math.min(m.base_phy_atk || 0, m.base_mag_atk || 0);

    // 计算种族值排名
    const allMonsters = RKData.getMonsters().filter(mm => !mm.hidden);
    const totalRank = allMonsters
      .map(mm => ({ id: mm.id, t: RKData.getTotalStats(mm) }))
      .sort((a, b) => b.t - a.t)
      .findIndex(mm => mm.id === m.id) + 1;
    // 有效种族值排名：基础形态不显示，高级形态只与高级形态比，首领形态与高级+首领比
    let effectiveRank = 0;
    let effectiveRankTotal = 0;
    const stage = m.evolution_stage;
    if (stage === '高级形态' || stage === '首领形态') {
      const rankPool = allMonsters.filter(mm =>
        mm.evolution_stage === '高级形态' || (stage === '首领形态' && mm.evolution_stage === '首领形态')
      );
      effectiveRankTotal = rankPool.length;
      effectiveRank = rankPool
        .map(mm => ({ id: mm.id, e: RKData.getEffectiveStats(mm) }))
        .sort((a, b) => b.e - a.e)
        .findIndex(mm => mm.id === m.id) + 1;
    }
    const totalRankStr = totalRank > 0 ? ` #${totalRank}` : '';
    const effectiveRankStr = effectiveRank > 0 ? ` #${effectiveRank}/${effectiveRankTotal}` : '';

    const { name: traitName, desc: traitDesc } = RKData.getTraitInfo(m);

    // 优先使用 wiki 图片，回退到本地 monster-images
    // 先用显示名（含形态后缀）查找 wiki 数据，找不到则用基础名回退
    let wikiData = RKData.getWikiData(name);
    if (!wikiData && baseName && baseName !== name) {
      wikiData = RKData.getWikiData(baseName);
    }
    const imgUrl = (wikiData && wikiData.image) ? wikiData.image : (m.image ? `assets/monster/images/${m.image}` : '');

    const stats = [
      { label: '生命', value: m.base_hp || 0, color: STAT_COLORS['生命'] },
      { label: '物攻', value: m.base_phy_atk || 0, color: STAT_COLORS['物攻'] },
      { label: '魔攻', value: m.base_mag_atk || 0, color: STAT_COLORS['魔攻'] },
      { label: '物防', value: m.base_phy_def || 0, color: STAT_COLORS['物防'] },
      { label: '魔防', value: m.base_mag_def || 0, color: STAT_COLORS['魔防'] },
      { label: '速度', value: m.base_spd || 0, color: STAT_COLORS['速度'] }
    ];

    const maxStat = 200;
    const STAT_ICON_MAP = {
      '生命': 'assets/icons/move/图标 图鉴 生命.png',
      '物攻': 'assets/icons/move-sub/physical-attack.png',
      '魔攻': 'assets/icons/move/图标 图鉴 魔攻.png',
      '物防': 'assets/icons/move/图标 图鉴 物防.png',
      '魔防': 'assets/icons/move/图标 图鉴 魔防.png',
      '速度': 'assets/icons/move/图标 图鉴 速度.png'
    };
    const statBarsHtml = stats.map(s => {
      const pct = Math.min(100, (s.value / maxStat) * 100);
      const icon = STAT_ICON_MAP[s.label] || '';
      return `
        <div class="detail-stat-bar">
          <div class="detail-stat-left">
            ${icon ? `<img src="${icon}" class="detail-stat-icon" alt="${s.label}">` : ''}
            <span class="detail-stat-label">${s.label}</span>
          </div>
          <div class="detail-stat-track"><div class="detail-stat-fill" style="width:${pct}%;"></div></div>
          <span class="detail-stat-val">${s.value}</span>
        </div>`;
    }).join('');

    // 防守属性克制
    const matchups = getDefensiveMatchups(mainType, subType);
    const noHtml = '';
    const weak2Html = matchups.weak2.length ? matchups.weak2.map(t => typeIconHtml(t)).join('') : noHtml;
    const weak3Html = matchups.weak3.length ? matchups.weak3.map(t => typeIconHtml(t)).join('') : noHtml;
    const resist05Html = matchups.resist05.length ? matchups.resist05.map(t => typeIconHtml(t)).join('') : noHtml;
    const resist025Html = matchups.resist025.length ? matchups.resist025.map(t => typeIconHtml(t)).join('') : noHtml;

    // 技能列表
    const skills = (wikiData && wikiData.skills) ? wikiData.skills : [];

    // 构建 技能名→能耗/威力 映射
    const allMoves = RKData.getMoves();
    const moveEnergyMap = {};
    const movePowerMap = {};
    const moveIdMap = {};
    allMoves.forEach(mv => {
      if (mv.localized && mv.localized.zh && mv.localized.zh.name) {
        moveEnergyMap[mv.localized.zh.name] = mv.energy_cost;
        movePowerMap[mv.localized.zh.name] = mv.power;
        moveIdMap[mv.localized.zh.name] = mv.id;
      }
    });

    const sourceOrder = ['默认', '血脉', '技能石', '传说'];
    const skillsBySource = {};
    sourceOrder.forEach(s => { skillsBySource[s] = []; });
    skills.forEach(s => {
      if (!skillsBySource[s.source]) skillsBySource[s.source] = [];
      skillsBySource[s.source].push(s);
    });

    // 固定顺序的类型和属性，再合并实际出现但不在预设中的
    const TYPE_ORDER = ['物攻', '魔攻', '状态', '防御'];
    const ELEM_ORDER = ['普通', '草', '火', '水', '光', '地', '冰', '龙', '电', '毒', '虫', '武', '翼', '萌', '幽', '恶', '机械', '幻'];
    const allTypes = [...new Set(skills.map(s => s.type).filter(Boolean))];
    const allElems = [...new Set(skills.map(s => s.element).filter(Boolean))];
    const skillTypes = [...TYPE_ORDER.filter(t => allTypes.includes(t)), ...allTypes.filter(t => !TYPE_ORDER.includes(t))];
    const skillElems = [...ELEM_ORDER.filter(t => allElems.includes(t)), ...allElems.filter(t => !ELEM_ORDER.includes(t))];

    // 使用 SkillPicker 公共模块生成筛选栏和技能列表
    const filterBarHtml = skills.length ? CommonUI.SkillPicker.renderFilterBar(skills) : '';
    const skillsHtml = CommonUI.SkillPicker.renderSkillList(skills, allMoves, {
      showMoveLink: true
    });

    body.innerHTML = `
      <div class="detail-layout">
        <div class="detail-col-1">
          <div class="detail-name">${nameHtml}</div>
          <div class="detail-types">
            ${mainType ? RKData.typeBadgeHtml(mainType) : ''}
            ${subType ? RKData.typeBadgeHtml(subType) : ''}
          </div>
          ${imgUrl ? `<img src="${imgUrl}" class="detail-pet-img" alt="${name}" loading="lazy">` : ''}
        </div>
        <div class="detail-col-2">
          <div class="detail-stats-panel">
            <div class="detail-stats-header">
              <div class="detail-stats-title-wrap">
                <img src="assets/icons/move/图标 图鉴 有效种族值.png" class="detail-stats-title-icon" alt="有效种族值">
                <span class="detail-stats-title">有效种族值</span>
              </div>
              <span class="detail-stats-total">${effective}${effectiveRankStr ? `<span class="detail-stats-rank">${effectiveRankStr}</span>` : ''}</span>
            </div>
            <div class="detail-stats-body">
              ${statBarsHtml}
            </div>
          </div>
          ${RKData.buildTraitDetailHtml(traitName, traitDesc)}
        </div>
        <div class="detail-col-3">
          <div class="detail-matchup">
            <div class="detail-section-title">防守属性克制</div>
            <div class="detail-matchup-row">
              <span class="detail-matchup-badge weak">2倍</span>
              <div class="detail-matchup-types">${weak2Html}</div>
            </div>
            <div class="detail-matchup-row">
              <span class="detail-matchup-badge weak3">3倍</span>
              <div class="detail-matchup-types">${weak3Html}</div>
            </div>
            <div class="detail-matchup-row">
              <span class="detail-matchup-badge resist">0.5倍</span>
              <div class="detail-matchup-types">${resist05Html}</div>
            </div>
            <div class="detail-matchup-row">
              <span class="detail-matchup-badge resist025">0.25倍</span>
              <div class="detail-matchup-types">${resist025Html}</div>
            </div>
          </div>
        </div>
      </div>
      ${skillsHtml ? `
      <div class="detail-skills-fullwidth">
        ${filterBarHtml}
        ${skillsHtml}
      </div>` : ''}
    `;
    modal.style.display = 'flex';
    // 动态调整 z-index，确保显示在技能弹窗之上
    const moveModal = document.getElementById('move-modal');
    const moveZ = moveModal ? parseInt(getComputedStyle(moveModal).zIndex) || 200 : 200;
    modal.style.zIndex = moveZ + 100;

    // 点击空白处关闭弹窗（仅点击 overlay 本身，非内部内容）
    modal.onclick = function(e) {
      if (e.target === modal) modal.style.display = 'none';
    };

    // 右键任意区域关闭弹窗
    modal.oncontextmenu = function(e) {
      e.preventDefault();
      modal.style.display = 'none';
    };

    // 绑定筛选按钮事件 — 使用 SkillPicker 公共模块（多选并集）
    CommonUI.SkillPicker.bindFilterEvents(body);

    // 绑定技能卡片点击事件 —— 打开技能详情弹窗
    body.querySelectorAll('.detail-skill-item[data-move-id]').forEach(item => {
      item.addEventListener('click', function() {
        const moveId = parseInt(this.dataset.moveId);
        const mv = RKData.getMoves().find(m => m.id === moveId);
        if (mv && MovesPage && MovesPage.showMoveDetail) {
          MovesPage.showMoveDetail(mv);
        }
      });
    });
    } catch (err) {
     console.error('[PetDex] showPetDetail error:', err);
     const body = document.getElementById('pet-modal-body');
     const modal = document.getElementById('pet-modal');
     if (body && modal) {
      body.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted);">加载详情失败: ${err.message}</div>`;
      modal.style.display = 'flex';
      const moveModal2 = document.getElementById('move-modal');
      const moveZ2 = moveModal2 ? parseInt(getComputedStyle(moveModal2).zIndex) || 200 : 200;
      modal.style.zIndex = moveZ2 + 100;
     }
   }
  }

  // 展开/收起特性描述
  function toggleTrait(id) {
    if (collapsedTraits.has(id)) {
      collapsedTraits.delete(id);
    } else {
      collapsedTraits.add(id);
    }
    renderTable();
  }

  // 展开/收起形态变体
  function toggleForm(mainFormId) {
    if (expandedForms.has(mainFormId)) {
      expandedForms.delete(mainFormId);
    } else {
      expandedForms.add(mainFormId);
    }
    renderTable();
  }

  return { render, toggleTrait, toggleForm, showPetDetail };
})();
