/**
 * petdex.js — 精灵图鉴页面
 * 亮色主题，pill属性筛选，形态筛选，完整数据表格
 */
const PetDexPage = (function () {
  let state = {
    keyword: '',
    activeTypes: new Set(),    // 选中的属性集合，多选交集筛选
    activeForms: new Set(['high']),  // 多选: 'high' | 'leader' | 'pending'（不把未确认当成高级）
    activeSeasons: new Set(),
    sortKey: 'dex_number',
    sortAsc: true,
    selectedRow: null,
    highlightedRow: null
  };

  // 记录被收起的精灵 id 集合（默认展开）
  let collapsedTraits = new Set([129, 467, 468, 469, 509, 510, 646, 647]);
  // 记录已展开形态的主形态 id 集合
  let expandedForms = new Set();

  // Presentation-only copy: all identity/type/learning data remains the original data.
  // Call with catalogue entries, never feed a projected copy back into this function.
  function projectMonster(monster, enabled = window.AppPreferences?.getTrickRoom?.() === true) {
    if (!monster || !enabled) return monster;
    return { ...monster, base_spd: 200 - (Number(monster.base_spd) || 0) };
  }

  // One cache per mounted page, never an unbounded history of filters/sorts.
  let tableView = null;
  let pendingFilterInitialized = false;

  function mountTable(tbody) {
    tableView?.dispose();
    if (!pendingFilterInitialized) {
      if (RKData.getMonsters().some(m => !m.hidden && m.evolution_stage === '未确认')) state.activeForms.add('pending');
      pendingFilterInitialized = true;
    }
    const view = { tbody, rows: new Map(), dispose: null };
    tableView = view;
    const click = event => {
      const target = event.target.closest?.('[data-petdex-action], tr[data-id]');
      const row = target?.closest('tr[data-id]');
      if (!row || row.parentElement !== tbody || event.target.closest('.game-glossary-term')) return;
      const id = Number(row.dataset.id);
      if (target.dataset.petdexAction === 'trait') toggleTrait(id);
      else if (target.dataset.petdexAction === 'form') toggleForm(id);
      else showPetDetail(id, { petdex: true });
    };
    tbody.addEventListener('click', click);
    const unregister = CommonUI.registerCleanup(tbody, () => view.dispose());
    view.dispose = () => {
      tbody.removeEventListener('click', click);
      view.rows.clear();
      unregister();
      if (tableView === view) { tableView = null; formGroupIndex = null; }
    };
  }

  function render(container) {
    CommonUI.destroyWithin(container);
    container.innerHTML = `
      <div class="petdex-page-layout">
      <!-- 筛选面板 -->
      <div class="filter-panel">
        <div id="petdex-search-slot"></div>
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
            ${RKData.getMonsters().some(m => !m.hidden && m.evolution_stage === '未确认') ? '<button class="form-btn" data-form="pending" title="官方尚未提供进化阶段；独立显示，不视为高级或首领">阶段未确认</button>' : ''}
          </div>
        </div>
        <!-- 赛季筛选 -->
        <div class="filter-section" style="display:flex;align-items:center;justify-content:center;gap:12px;">
          <span class="filter-section-label" style="margin-bottom:0;white-space:nowrap;">赛季</span>
          <div class="form-buttons" id="season-buttons">
            <button class="form-btn" data-season="S1">S1</button>
            <button class="form-btn" data-season="S2">S2</button>
            <button class="form-btn" data-season="S3">S3</button>
            <button class="form-btn" data-season="S4">S4</button>
            <button class="form-btn" data-season="S5">S5</button>
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
              <th>精灵</th>
              <th>属性</th>
              <th>特性</th>
              ${ListingUI.statHeaders({ key: state.sortKey, asc: state.sortAsc }, { petdex: true })}
            </tr>
          </thead>
          <tbody id="pet-tbody"></tbody>
        </table>
      </div>
      </div>
      </div>
    `;
    mountTable(document.getElementById('pet-tbody'));
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
    let isComposing = false;
    const applySearch = () => {
      const keyword = searchInput.value;
      if (state.keyword === keyword) return;
      state.keyword = keyword;
      renderTable();
    };
    searchInput.addEventListener('compositionstart', () => { isComposing = true; });
    searchInput.addEventListener('compositionend', () => {
      isComposing = false;
      applySearch();
    });
    searchInput.addEventListener('input', event => {
      if (isComposing || event.isComposing) return;
      applySearch();
    });
    document.getElementById('petdex-search-slot').appendChild(searchWrap);
    ListingUI.mountFilters(container.querySelector('.filter-panel'), 'petdex');
    ListingUI.onStatsChange(container.querySelector('.petdex-page-layout'), renderTable);
    bindEvents();
    // 恢复形态按钮状态
    if (state.activeForms.has('high')) document.querySelector('.form-btn[data-form="high"]')?.classList.add('active');
    else document.querySelector('.form-btn[data-form="high"]')?.classList.remove('active');
    if (state.activeForms.has('leader')) document.querySelector('.form-btn[data-form="leader"]')?.classList.add('active');
    else document.querySelector('.form-btn[data-form="leader"]')?.classList.remove('active');
    document.querySelector('.form-btn[data-form="pending"]')?.classList.toggle('active', state.activeForms.has('pending'));
    if (allExpanded) document.querySelector('.form-btn[data-form="regional"]')?.classList.add('active');
    else document.querySelector('.form-btn[data-form="regional"]')?.classList.remove('active');
    document.querySelectorAll('#season-buttons .form-btn').forEach(btn => btn.classList.toggle('active', state.activeSeasons.has(btn.dataset.season)));
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
          buildFormGroupIndex();
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

    document.getElementById('season-buttons').addEventListener('click', e => {
      const btn = e.target.closest('.form-btn[data-season]');
      if (!btn) return;
      const season = btn.dataset.season;
      if (state.activeSeasons.has(season)) state.activeSeasons.delete(season);
      else state.activeSeasons.add(season);
      btn.classList.toggle('active', state.activeSeasons.has(season));
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
    const isDexNumberSort = state.sortKey === 'dex_number';
    document.querySelectorAll('#pet-table th[data-sort]').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      th.setAttribute('aria-sort', th.dataset.sort === state.sortKey ? (state.sortAsc ? 'ascending' : 'descending') : 'none');
      if (th.dataset.sort === state.sortKey) th.classList.add(state.sortAsc ? 'sort-asc' : 'sort-desc');
      if (th.dataset.sort === 'dex_number') th.textContent = isDexNumberSort ? '编号' : '#';
    });
  }

  function getSeason(m) {
    if (['S1', 'S2', 'S3', 'S4', 'S5'].includes(m.season)) return m.season;
    const dex = m.dex_number || 0;
    if ((dex >= 443 && dex <= 465) || dex === 466) return 'S4';
    if (dex >= 376 && dex <= 442) return 'S3';
    if (dex >= 348 && dex <= 375) return 'S2';
    return 'S1';
  }

  /** Explicit local-ID ownership, independent of dex/name sorting and leader forms. */
  let formGroupIndex = null;
  function buildFormGroupIndex() {
    formGroupIndex = PetDexFamily.formIndex(RKData.getMonsters());
  }

  function getFormVariants(m) {
    if (!formGroupIndex) buildFormGroupIndex();
    return formGroupIndex.variantsById.get(m.id) || [];
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
        if (state.activeForms.has('pending')) stages.push('未确认');
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
        if (RKData.matchesMonsterName ? RKData.matchesMonsterName(m, kw) : RKData.getMonsterDisplayName(m).toLowerCase().includes(kw)) return true;
      }
      // Never attach a variant to an adjacent same-dex row (e.g. 岚鸟 / 霜翼领主).
      if (!formGroupIndex) buildFormGroupIndex();
      return expandedForms.has(formGroupIndex.parentById.get(m.id));
    });

    // 赛季筛选：多选并集；未选任何赛季时显示全部。
    if (state.activeSeasons.size > 0) {
      list = list.filter(m => state.activeSeasons.has(getSeason(m)));
    }

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
        if (RKData.matchesMonsterName ? RKData.matchesMonsterName(m, kw) : RKData.getMonsterDisplayName(m).toLowerCase().includes(kw)) return true;
        const trait = RKData.getTraitInfo(m);
        if (trait.name && trait.name.toLowerCase().includes(kw)) return true;
        if (trait.desc && trait.desc.toLowerCase().includes(kw)) return true;
        return false;
      });
    }

    // Shared stable numeric sorting; filtering and form policies remain local.
    return ListingUI.sortMonsters(list.map(monster => projectMonster(monster)), state.sortKey, state.sortAsc);
  }

  // Compare the actual presentation inputs, not monster object identity: source
  // editors can mutate in place and the dream-speed projection makes fresh copies.
  function updateRow(m, idx, view) {
    const id = String(m.id);
    let entry = view.rows.get(id);
    if (!entry) {
      const row = document.createElement('tr');
      row.dataset.id = id;
      row.innerHTML = `<td style="color:var(--text-muted);"></td><td></td><td></td><td style="max-width:280px;white-space:normal;font-size:12px;"></td>${ListingUI.statCells(m)}`;
      entry = { row, cells: Array.from(row.cells), stats: [], name: null, types: null, trait: null };
      view.rows.set(id, entry);
    }
    const { row, cells } = entry;
    const rowClass = m.form_category === '变体形态' ? 'form-variant-row' : '';
    if (row.className !== rowClass) row.className = rowClass;
    const dexNum = state.sortKey === 'dex_number'
      ? String(m.dex_number || m.id).padStart(3, '0') : String(idx + 1);
    if (cells[0].textContent !== dexNum) cells[0].textContent = dexNum;

    const hasVariants = m.form_category === '主形态' && getFormVariants(m).length > 0;
    const nameHtml = RKData.getMonsterDisplayNameHtml(m);
    const pendingStage = m.evolution_stage === '未确认';
    const nameKey = JSON.stringify([nameHtml, m.image, hasVariants, hasVariants && expandedForms.has(m.id), pendingStage]);
    if (entry.name !== nameKey) {
      const iconHtml = m.image
        ? `<img src="assets/monster/images/${m.image}" class="pet-icon-img" alt="" loading="lazy" onerror="this.removeAttribute('src'); this.style.visibility='hidden';">`
        : '<div class="pet-icon-placeholder" aria-hidden="true"></div>';
      const arrow = hasVariants ? `<span class="form-toggle-arrow" data-petdex-action="form">${expandedForms.has(m.id) ? '▼' : '▶'}</span>` : '';
      const stageNote = pendingStage ? '<small class="pet-stage-pending" title="官方未提供进化阶段，暂不归入高级或首领">（阶段未确认）</small>' : '';
      cells[1].innerHTML = `<div class="pet-name-cell">${iconHtml}<span class="pet-name-text">${nameHtml}${stageNote}</span>${arrow}</div>`;
      entry.name = nameKey;
    }
    const types = [m.main_type?.name, m.sub_type?.name].filter(Boolean).map(t => RKData.typeBadgeHtml(t)).join(' ') || '-';
    if (entry.types !== types) { cells[2].innerHTML = types; entry.types = types; }

    const { name: traitName, desc: traitDesc } = RKData.getTraitInfo(m);
    const collapsible = [129, 467, 468, 469, 509, 510, 646, 647].includes(m.id) && traitDesc.includes('\n');
    const collapsed = collapsible && collapsedTraits.has(m.id);
    const traitKey = JSON.stringify([traitName, traitDesc, collapsible, collapsed]);
    // Builder references also invalidate if the host replaces a presentation helper.
    if (entry.trait !== traitKey || entry.traitBuilder !== RKData.buildTraitDetailHtml || entry.traitIcon !== RKData.traitIconHtml) {
      let html = '<span style="color:var(--text-muted);">-</span>';
      if (traitName && collapsible) {
        const visibleDesc = collapsed ? traitDesc.split('\n')[0] : traitDesc;
        const desc = RKData.traitDescriptionHtml(visibleDesc, m.id).replace(/\n/g, '<br>');
        html = `<div class="detail-trait-box" data-petdex-action="trait" style="cursor:pointer;">
          <div class="detail-trait-head"><span class="trait-arrow">${collapsed ? '▶' : '▼'}</span>
          ${RKData.traitIconHtml(traitName, { className: 'detail-trait-icon', fallback: 'assets/icons/type/light.png' })}
          <span><span class="detail-trait-name">${traitName}:</span> <span class="detail-trait-desc">${desc}</span></span></div></div>`;
      } else if (traitName) html = RKData.buildTraitDetailHtml(traitName, traitDesc, m.id);
      cells[3].innerHTML = html;
      entry.trait = traitKey;
      entry.traitBuilder = RKData.buildTraitDetailHtml;
      entry.traitIcon = RKData.traitIconHtml;
    }
    // Dynamic effective-speed policy, 200-Q projection and shared formulas are
    // evaluated every time, but unchanged numbers never generate DOM mutations.
    ListingUI.STAT_COLUMNS.forEach(({ key }, i) => {
      const value = String(ListingUI.statValue(m, key));
      if (entry.stats[i] !== value) {
        const span = cells[i + 4].firstElementChild;
        if (span.textContent !== value) span.textContent = value;
        entry.stats[i] = value;
      }
    });
    return row;
  }

  function reconcileRows(tbody, rows) {
    const wanted = new Set(rows);
    for (const row of Array.from(tbody.children)) if (!wanted.has(row)) row.remove();
    let cursor = tbody.firstElementChild;
    let batch = document.createDocumentFragment();
    const flush = () => {
      if (!batch.childNodes.length) return;
      tbody.insertBefore(batch, cursor);
      batch = document.createDocumentFragment();
    };
    // Existing correctly ordered rows stay connected. New/moved runs enter in
    // order as fragments, not hundreds of individual tbody insertions.
    const focused = document.activeElement;
    for (const row of rows) {
      if (row === cursor) { flush(); cursor = cursor.nextElementSibling; }
      else batch.appendChild(row);
    }
    flush();
    if (focused && tbody.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }

  function renderTable() {
    const view = tableView;
    if (!view || !view.tbody.isConnected) return;
    // Rebuild this small index from current records (including in-place edits).
    buildFormGroupIndex();
    const liveIds = new Set(RKData.getMonsters().filter(m => !m.hidden).map(m => String(m.id)));
    for (const id of view.rows.keys()) if (!liveIds.has(id)) view.rows.delete(id);
    for (const id of expandedForms) if (!liveIds.has(String(id))) expandedForms.delete(id);
    const list = getFilteredMonsters();
    const speedHeader = document.querySelector('#pet-table th[data-sort="base_spd"]');
    const speedLabel = window.AppPreferences?.getTrickRoom?.() ? '速度（梦境）' : '速度';
    if (speedHeader && speedHeader.textContent !== speedLabel) speedHeader.textContent = speedLabel;
    // Keep the sorted rank attached to its ID; only presentation nests visible
    // variants under their visible owner. A filtered-out owner is never reinserted.
    const rankById = new Map(list.map((m, idx) => [m.id, idx]));
    const grouped = PetDexFamily.groupVisible(list, formGroupIndex);
    reconcileRows(view.tbody, grouped.map(m => updateRow(m, rankById.get(m.id), view)));
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

  function getEffectiveRank(m, petdex = false) {
    const allMonsters = RKData.getMonsters().filter(mm => !mm.hidden);
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
        .map(mm => ({ id: mm.id, e: RKData.getEffectiveStats(petdex ? projectMonster(mm) : mm) }))
        .sort((a, b) => b.e - a.e)
        .findIndex(mm => mm.id === m.id) + 1;
    }
    return { rank: effectiveRank, count: effectiveRankTotal };
  }

  function refreshPetStats(m, body, petdex = false) {
    const modal = document.getElementById('pet-modal');
    if (!modal || modal.style.display === 'none') return;
    const valueEl = body.querySelector('.detail-stats-total');
    if (!valueEl) return;
    const display = petdex ? projectMonster(m) : m;
    const { rank, count } = getEffectiveRank(m, petdex);
    valueEl.innerHTML = `${RKData.getEffectiveStats(display)}${rank > 0 ? `<span class="detail-stats-rank"> #${rank}/${count}</span>` : ''}`;
    const speedBar = body.querySelector('[data-detail-stat="速度"]');
    if (speedBar) {
      const speed = display.base_spd || 0;
      speedBar.querySelector('.detail-stat-val').textContent = speed;
      speedBar.querySelector('.detail-stat-fill').style.width = Math.max(0, Math.min(100, speed / 2)) + '%';
      speedBar.querySelector('.detail-stat-label').textContent = petdex && window.AppPreferences?.getTrickRoom?.() ? '速度（霞光梦境）' : '速度';
    }
  }

  function buildRelationsHtml(monster) {
    return PetDexFamily.render(PetDexFamily.build(RKData.getMonsters(), monster.id), RKData.getMonsterDisplayName);
  }

  function showPetDetail(id, { petdex = false } = {}) {
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
    // Calls from speed / skill learner pages intentionally retain raw qualifications.
    const display = petdex ? projectMonster(m) : m;
    const total = RKData.getTotalStats(display);
    const effective = RKData.getEffectiveStats(display);

    // 计算种族值排名
    const allMonsters = RKData.getMonsters().filter(mm => !mm.hidden);
    const totalRank = allMonsters
      .map(mm => ({ id: mm.id, t: RKData.getTotalStats(petdex ? projectMonster(mm) : mm) }))
      .sort((a, b) => b.t - a.t)
      .findIndex(mm => mm.id === m.id) + 1;
    const { rank: effectiveRank, count: effectiveRankTotal } = getEffectiveRank(m, petdex);
    const totalRankStr = totalRank > 0 ? ` #${totalRank}` : '';
    const effectiveRankStr = effectiveRank > 0 ? ` #${effectiveRank}/${effectiveRankTotal}` : '';

    const { name: traitName, desc: traitDesc } = RKData.getTraitInfo(m);

    // 图片保持当前精确名称/基础名回退；技能统一按进化学习面来源解析。
    let wikiData = RKData.getWikiData(name);
    if (!wikiData && baseName && baseName !== name) wikiData = RKData.getWikiData(baseName);
    const skillWikiData = RKData.getResolvedWikiData(m);
    const imgUrl = (wikiData && wikiData.image) ? wikiData.image : (m.image ? `assets/monster/images/${m.image}` : '');

    const stats = [
      { label: '生命', value: m.base_hp || 0, color: STAT_COLORS['生命'] },
      { label: '物攻', value: m.base_phy_atk || 0, color: STAT_COLORS['物攻'] },
      { label: '魔攻', value: m.base_mag_atk || 0, color: STAT_COLORS['魔攻'] },
      { label: '物防', value: m.base_phy_def || 0, color: STAT_COLORS['物防'] },
      { label: '魔防', value: m.base_mag_def || 0, color: STAT_COLORS['魔防'] },
      { label: '速度', value: display.base_spd || 0, color: STAT_COLORS['速度'] }
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
      const pct = Math.max(0, Math.min(100, (s.value / maxStat) * 100));
      const icon = STAT_ICON_MAP[s.label] || '';
      return `
        <div class="detail-stat-bar" data-detail-stat="${s.label}">
          <div class="detail-stat-left">
            ${icon ? `<img src="${icon}" class="detail-stat-icon" alt="${s.label}">` : ''}
            <span class="detail-stat-label">${s.label === '速度' && petdex && window.AppPreferences?.getTrickRoom?.() ? '速度（霞光梦境）' : s.label}</span>
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
    const skills = (skillWikiData && skillWikiData.skills) ? skillWikiData.skills : [];

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

    CommonUI.destroyWithin(body);
    body.innerHTML = `
      <div class="detail-layout">
        <div class="detail-col-1">
          <div class="detail-name">${nameHtml}</div>
          <div class="detail-types">
            ${mainType ? RKData.typeBadgeHtml(mainType) : ''}
            ${subType ? RKData.typeBadgeHtml(subType) : ''}
          </div>
          ${imgUrl ? `<img src="${imgUrl}" class="detail-pet-img" alt="" loading="lazy" onerror="this.removeAttribute('src'); this.style.visibility='hidden';">` : ''}
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
          ${RKData.buildTraitDetailHtml(traitName, traitDesc, m.id)}
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
          ${buildRelationsHtml(m)}
        </div>
      </div>
      ${skillsHtml ? `
      <div class="detail-skills-fullwidth">
        ${filterBarHtml}
        ${skillsHtml}
      </div>` : ''}
    `;
    ListingUI.onStatsChange(body.querySelector('.detail-layout'), () => refreshPetStats(m, body, petdex));
    body.scrollTop = 0;
    modal.style.display = 'flex';
    // 动态调整 z-index，确保显示在技能弹窗之上
    const moveModal = document.getElementById('move-modal');
    const moveZ = moveModal ? parseInt(getComputedStyle(moveModal).zIndex) || 200 : 200;
    modal.style.zIndex = moveZ + 100;

    // 点击空白处关闭弹窗（仅点击 overlay 本身，非内部内容）
    modal.onclick = function(e) {
      if (e.target === modal) modal.style.display = 'none';
    };

    // 整个弹窗（含筛选、输入和遮罩）右键关闭，主页面的右键不受影响。
    CommonUI.bindModalContextMenu(modal, () => { modal.style.display = 'none'; });

    body.querySelectorAll('[data-related-id]').forEach(button => {
      button.addEventListener('click', () => showPetDetail(Number(button.dataset.relatedId), { petdex }));
    });

    // 绑定筛选按钮事件 — 使用 SkillPicker 公共模块（多选并集）
    CommonUI.SkillPicker.bindFilterEvents(body, undefined, { allowExclusion: true });

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
      CommonUI.bindModalContextMenu(modal, () => { modal.style.display = 'none'; });
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
