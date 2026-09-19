/**
 * moves.js — 技能列表页面
 * 功能：上方筛选（搜索/类型/属性/能耗），下方卡片网格
 */
const MovesPage = (function () {
  let currentFilter = { keyword: '' };
  // Kept only in this page module: navigating away/back retains filters, reload resets.
  const valueFilters = CommonUI.FilterExclusion.create();
  let activeSortKey = '';
  let activeSortState = 0; // 0=default, 1=desc, 2=asc
  let detailStyle = 'default';
  let learnerSort = { key: null, asc: false, priorityType: '' };
  let currentDetail = null;
  let multiSkillSelected = []; // 交集筛选：额外选中的技能名

  const CATEGORY_MAP = {
    'Physical Attack': '物攻',
    'Magic Attack': '魔攻',
    'Status': '状态',
    'Defense': '防御'
  };

  const TYPE_ICON_MAP = {
    '物攻': 'physical-attack',
    '魔攻': 'magic-attack',
    '防御': 'defense',
    '状态': 'status'
  };

  const ELEM_ORDER = ['普通', '草', '火', '水', '光', '地', '冰', '龙', '电', '毒', '虫', '武', '翼', '萌', '幽', '恶', '机械', '幻'];

  function getMoveTypeZh(mv) {
    return CATEGORY_MAP[mv.move_category] || '';
  }

  function getMoveElemZh(mv) {
    if (!mv.move_type) return '';
    if (mv.move_type.localized && mv.move_type.localized.zh) return mv.move_type.localized.zh;
    return mv.move_type.name || '';
  }

  // 需要排除的技能名
  const EXCLUDED_MOVES = ['聚能', '愿力冲击'];

  // 折射技能的各系效果
  const REFRACTION_EFFECTS = [
    { elem: '地', desc: '对手-40速度,-2连击' },
    { elem: '普', desc: '技能威力+10' },
    { elem: '钢', desc: '物防+30%' },
    { elem: '草', desc: '回复生命15%' },
    { elem: '火', desc: '对手+4层灼烧' },
    { elem: '冰', desc: '对手+2层冻结' },
    { elem: '毒', desc: '对手+2层中毒' },
    { elem: '虫', desc: '对手-40%物防' },
    { elem: '龙', desc: '对手-40%魔防' },
    { elem: '翼', desc: '连击+1' },
    { elem: '水', desc: '全技能能耗-1' },
    { elem: '武', desc: '物攻+30%' },
    { elem: '光', desc: '魔攻+30%' },
    { elem: '幻', desc: '对手+1层星陨印记' },
    { elem: '幽', desc: '对手-2点能量' },
    { elem: '恶', desc: '吸血+30%' },
    { elem: '电', desc: '速度+20' },
    { elem: '萌', desc: '对手-30%双攻' }
  ];
  let refractionExpanded = false;

  function buildRefractionHtml() {
    const arrow = refractionExpanded ? '▼' : '▶';
    const items = REFRACTION_EFFECTS.map(e => {
      const iconName = RKData.getTypeIcon(e.elem);
      return `<div class="refraction-effect-item"><img src="${iconName}" class="refraction-effect-icon" alt="${e.elem}"><span class="refraction-effect-elem">${e.elem}系</span><span class="refraction-effect-desc">${e.desc}</span></div>`;
    }).join('');
    return `
      <div class="refraction-toggle" onclick="event.stopPropagation();MovesPage.toggleRefraction()">
        <span class="refraction-arrow">${arrow}</span>
        <span class="refraction-toggle-text">各系效果详情</span>
      </div>
      ${refractionExpanded ? `<div class="refraction-effects">${items}</div>` : ''}
    `;
  }

  function render(container) {
    CommonUI.destroyWithin(container);
    const allMoves = RKData.getMoves().filter(mv => {
      const name = RKData.getMoveName(mv);
      return !EXCLUDED_MOVES.includes(name);
    });

    // 收集实际出现的类型和属性
    const allTypes = [...new Set(allMoves.map(mv => getMoveTypeZh(mv)).filter(Boolean))];
    const allElems = [...new Set(allMoves.map(mv => getMoveElemZh(mv)).filter(Boolean))];
    const skillTypes = ['物攻', '魔攻', '状态', '防御'].filter(t => allTypes.includes(t));
    const skillElems = [...ELEM_ORDER.filter(t => allElems.includes(t)), ...allElems.filter(t => !ELEM_ORDER.includes(t))];

    container.innerHTML = `
      <div class="moves-page-layout">
      <div class="filter-panel" id="move-filter">
        <div id="move-search-slot"></div>
        <div class="filter-section">
          <div class="type-pills type-pills-nowrap" id="move-type-pills" style="width:auto;">
            ${skillTypes.map(t => {
              const iconFile = TYPE_ICON_MAP[t] || '';
              const iconHtml = iconFile ? `<img src="assets/icons/move-sub/${iconFile}.png" class="type-pill-icon move-filter-icon-sm" alt="${t}">` : '';
              return `<span class="type-pill" data-filter-type="${t}">${iconHtml}${t}</span>`;
            }).join('')}
          </div>
        </div>
        <div class="filter-section">
          <div class="type-pills" id="move-elem-pills">
            ${skillElems.map(t => {
              const enName = RKData.getTypeEn(t);
              const display = t === '普通' ? '普' : t === '机械' ? '钢' : t;
              const iconName = RKData.getTypeIcon(t);
              return `<span class="type-pill" data-filter-elem="${t}" data-type="${enName}"><img src="${iconName}" class="type-pill-icon" alt="${display}">${display}</span>`;
            }).join('')}
          </div>
        </div>
        <div class="filter-section">
          <div class="type-pills type-pills-nowrap" id="move-energy-pills">
            <span class="type-pill" data-sort-key="energy_cost" style="width:52px;padding:6px 12px;font-weight:700;">能耗</span>
            ${[0,1,2,3,4,5,6,7,8,9,'10+'].map(c => `<span class="type-pill" data-filter-energy="${c}" style="flex:1;padding:6px 4px;"><img src="assets/icons/move-sub/energy.png" class="type-pill-icon move-filter-icon-sm" alt="能耗">${c}</span>`).join('')}
          </div>
        </div>
        <div class="filter-section">
          <div class="type-pills type-pills-nowrap" id="move-power-pills" style="width:auto;">
            <span class="type-pill" data-sort-key="power" style="width:52px;padding:6px 12px;font-weight:700;">威力</span>
            ${[40,60,80,100,120,'140+'].map(p => `<span class="type-pill" data-filter-power="${p}" style="width:auto;padding:6px 8px;"><img src="assets/icons/move-sub/conditional-attack.png" class="type-pill-icon move-filter-icon-sm" alt="威力">${p}</span>`).join('')}
          </div>
        </div>
        <div class="filter-section">
          <div class="type-pills type-pills-nowrap" id="move-season-pills" style="width:auto;">
            ${['S1', 'S2', 'S3', 'S4'].map(season => `<span class="type-pill" data-filter-season="${season}" style="padding:6px 12px;">${season}</span>`).join('')}
          </div>
        </div>

      </div>
      <div class="move-scroll-wrapper hide-scrollbar">
        <div id="move-list-container"></div>
      </div>
      </div>
    `;
    bindEvents();
    // 创建技能搜索框（纯文本搜索，和精灵图鉴一致）
    const searchBox = createMoveSearchBox();
    document.getElementById('move-search-slot').appendChild(searchBox);
    // 恢复筛选区域的选中状态
    restoreFilterState();
    ListingUI.mountFilters(container.querySelector('#move-filter'), 'moves');
    ListingUI.onStatsChange(container.querySelector('.moves-page-layout'), renderList);
    renderList();
    // 回到顶部 + 滑到底部 + 右键拖拽手势
    CommonUI.bindScrollControls('.move-scroll-wrapper');
  }

  // 恢复筛选 pill 的 active 状态（切换页面回来后）
  function restoreFilterState() {
    const filterContainer = document.getElementById('move-filter');
    if (!filterContainer) return;
    filterContainer.querySelectorAll(CommonUI.FilterExclusion.selector).forEach(button => {
      CommonUI.FilterExclusion.sync(button, valueFilters);
    });
    if (activeSortKey && activeSortState > 0) {
      const el = filterContainer.querySelector(`[data-sort-key="${activeSortKey}"]`);
      if (el) el.classList.add('active');
    }
    // 恢复搜索框内容
    if (currentFilter.keyword) {
      const input = document.getElementById('move-search-input');
      if (input) input.value = currentFilter.keyword;
    }
  }

  /**
   * 技能搜索框 —— 纯文本搜索，无下拉菜单
   */
  function createMoveSearchBox() {
    const wrapper = document.createElement('div');
    wrapper.className = 'petdex-search-wrap';
    wrapper.style.cssText = 'position:relative;display:inline-flex;align-items:center;max-width:400px;width:100%;';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'search-bar';
    input.id = 'move-search-input';
    input.placeholder = '搜索技能名称和详情...';
    input.setAttribute('autocomplete', 'off');
    input.style.cssText = 'width:100%;';
    input.value = currentFilter.keyword || '';
    let isComposing = false;
    const applySearch = () => {
      const keyword = input.value;
      if (currentFilter.keyword === keyword) return;
      currentFilter.keyword = keyword;
      renderList();
    };
    input.addEventListener('compositionstart', () => { isComposing = true; });
    input.addEventListener('compositionend', () => {
      isComposing = false;
      applySearch();
    });
    input.addEventListener('input', event => {
      if (isComposing || event.isComposing) return;
      applySearch();
    });
    wrapper.appendChild(input);

    return wrapper;
  }

  function bindEvents() {
    const filterContainer = document.getElementById('move-filter');
    filterContainer.addEventListener('click', function(e) {
      const sortBtn = e.target.closest('.type-pill[data-sort-key]');
      if (sortBtn) {
        const key = sortBtn.dataset.sortKey;
        if (activeSortKey === key) {
          activeSortState = (activeSortState + 1) % 3;
        } else {
          activeSortKey = key;
          activeSortState = 1;
        }
        if (activeSortState === 0) activeSortKey = '';
        // 更新按钮显示
        filterContainer.querySelectorAll('.type-pill[data-sort-key]').forEach(b => {
          const bk = b.dataset.sortKey;
          if (bk === activeSortKey && activeSortState > 0) {
            b.classList.add('active');
          } else {
            b.classList.remove('active');
          }
        });
        renderList();
        return;
      }

    });

    const destroyFilters = CommonUI.FilterExclusion.bind(filterContainer, valueFilters, () => {
      const scrollBody = document.querySelector('.move-scroll-wrapper');
      const savedScrollTop = scrollBody ? scrollBody.scrollTop : 0;
      renderList();
      if (scrollBody && savedScrollTop > 0 && CommonUI.FilterExclusion.hasSelection(valueFilters)) {
        const missingHeight = savedScrollTop + scrollBody.clientHeight - scrollBody.scrollHeight;
        if (missingHeight > 0) {
          const spacer = document.createElement('div');
          spacer.className = 'skill-filter-scroll-spacer';
          spacer.style.height = missingHeight + 'px';
          document.getElementById('move-list-container').appendChild(spacer);
        }
        scrollBody.scrollTop = savedScrollTop;
      }
    });
    CommonUI.registerCleanup(filterContainer, destroyFilters);

    // 技能卡片点击 → 弹出详情
    const listContainer = document.getElementById('move-list-container');
    listContainer.addEventListener('click', function(e) {
      const item = e.target.closest('.detail-skill-item');
      if (!item) return;
      const moveId = parseInt(item.dataset.moveId);
      const mv = RKData.getMoves().find(m => m.id === moveId);
      if (mv) showMoveDetail(mv);
    });
  }

  // 同一进化链只显示最高阶段：如果某精灵的进化后形态也在列表中，则移除该精灵
  function deduplicateByEvolution(arr) {
    const hasEvolvedInList = (m) => {
      return arr.some(i => i.monster.evolves_from_id === m.id && i.monster.id !== m.id);
    };
    return arr.filter(info => !hasEvolvedInList(info.monster));
  }

  // 生成精灵卡片 HTML（模块级复用）
  function monsterCardHtml(info) {
    const m = info.monster;
    const mName = RKData.getMonsterName(m);
    const mDisplayName = RKData.getMonsterDisplayName(m);
    const mainType = m.main_type ? m.main_type.name : '';
    const form = m.form || '';
    const hasForm = form && form !== 'default' && form !== 'Original';
    const wiki = hasForm ? (RKData.getWikiData(mDisplayName) || RKData.getWikiData(mName)) : RKData.getWikiData(mName);
    const imgUrl = (wiki && wiki.image) ? wiki.image : (m.image ? `assets/monster/images/${m.image}` : '');
    const imgHtml = imgUrl
      ? `<img src="${imgUrl}" class="move-detail-monster-img" alt="${mDisplayName}" loading="lazy">`
      : `<div class="move-detail-monster-img-placeholder">${mainType ? RKData.getTypeShortZh(mainType) || '?' : '?'}</div>`;
    return `
        <div class="move-detail-monster-card" onclick="PetDexPage.showPetDetail(${m.id})">
          ${imgHtml}
          <div class="move-detail-monster-name">${mDisplayName}</div>
        </div>`;
  }

  function getMoveLearners(name) {
    // 查找能学习该技能的精灵
    const allMonsters = RKData.getMonsters();
    const selfLearn = []; // 默认
    const legendLearn = []; // 传说
    const bloodlineLearn = []; // 血脉
    const skillStone = []; // 技能石

    const resolvedSourceIds = new Set();
    allMonsters.forEach(m => {
      if (m.is_leader_form) return; // 首领技能由对应高级形态代表
      const resolved = RKData.resolveSkillSource(m);
      const sourceMonster = resolved.sourceMonster || m;
      if (resolvedSourceIds.has(sourceMonster.id)) return;
      const wiki = resolved.wiki;
      if (wiki && wiki.skills) {
        const matched = wiki.skills.filter(sk => sk.name === name);
        if (matched.length) resolvedSourceIds.add(sourceMonster.id);
        matched.forEach(sk => {
            const monsterInfo = { monster: sourceMonster, source: sk.source };
            if (sk.source === '技能石') {
              skillStone.push(monsterInfo);
            } else if (sk.source === '血脉') {
              bloodlineLearn.push(monsterInfo);
            } else if (sk.source === '传说') {
              legendLearn.push(monsterInfo);
            } else {
              selfLearn.push(monsterInfo);
            }
        });
      }
    });

    const selfLearnDedup = deduplicateByEvolution(selfLearn);
    const legendLearnDedup = deduplicateByEvolution(legendLearn);
    const bloodlineLearnDedup = deduplicateByEvolution(bloodlineLearn);
    const skillStoneDedup = deduplicateByEvolution(skillStone);

    return { selfLearnDedup, legendLearnDedup, bloodlineLearnDedup, skillStoneDedup };
  }

  function renderLearnerViews() {
    if (!currentDetail) return;
    const defaultView = document.getElementById('move-learners-default');
    const tableView = document.getElementById('move-learners-table');
    if (!defaultView || !tableView) return;
    defaultView.hidden = detailStyle === 'table';
    tableView.hidden = detailStyle !== 'table';
    const monsters = ListingUI.uniqueMonsters(currentDetail.monsters);
    const title = document.getElementById('move-learners-title');
    if (title) title.textContent = `可学习该技能的精灵 (${detailStyle === 'table' ? monsters.length : currentDetail.monsters.length})`;
    CommonUI.destroyWithin(tableView);
    tableView.innerHTML = detailStyle === 'table'
      ? (monsters.length ? ListingUI.monsterTable(monsters, learnerSort) : '<div class="move-detail-empty">暂无精灵数据</div>')
      : '';
    mountLearnerPriority(tableView);
    updateMultiSkillResult(currentDetail.name);
  }

  // ATTRIBUTE PRIORITY (non-layout): both tables share this detail's pin and
  // learnerSort. Default source-group cards never pass through priority sorting.
  function mountLearnerPriority(host) {
    ListingUI.mountAttributePriority(host, learnerSort.priorityType || '', value => {
      if (!currentDetail) return;
      learnerSort = { ...learnerSort, priorityType: value };
      renderLearnerViews();
      host.querySelector('[data-listing-priority]')?.focus({ preventScroll: true });
    });
  }

  function showMoveDetail(mv) {
    multiSkillSelected = [];
    const modal = document.getElementById('move-modal');
    const body = document.getElementById('move-modal-body');
    if (!modal || !body) return;
    const name = RKData.getMoveName(mv);
    const desc = RKData.getMoveDesc(mv);
    const typeZh = getMoveTypeZh(mv);
    const elemZh = getMoveElemZh(mv);
    const energy = mv.energy_cost;
    const power = RKData.isVariablePowerMove(mv) ? '?' : mv.power;
    const elemIcon = RKData.getTypeIcon(elemZh);
    const elemIconHtml = elemZh ? `<img src="${elemIcon}" class="move-detail-elem-icon" alt="${elemZh}">` : '';
    const typeIconName = TYPE_ICON_MAP[typeZh] || '';
    const typeIconHtml = typeIconName ? `<img src="assets/icons/move-sub/${typeIconName}.png" class="move-detail-type-icon" alt="${typeZh}">` : '';

    const { selfLearnDedup, legendLearnDedup, bloodlineLearnDedup, skillStoneDedup } = getMoveLearners(name);
    learnerSort = { ...learnerSort, priorityType: '' }; // Pin belongs to this detail, never petdex/team.
    currentDetail = { name, monsters: [...selfLearnDedup, ...legendLearnDedup, ...bloodlineLearnDedup, ...skillStoneDedup].map(info => info.monster) };


    const total = selfLearnDedup.length + legendLearnDedup.length + bloodlineLearnDedup.length + skillStoneDedup.length;
    const selfLearnHtml = selfLearnDedup.length > 0
      ? `<div class="move-detail-section"><div class="move-detail-section-title">自学技能 (${selfLearnDedup.length})</div><div class="move-detail-monster-grid">${selfLearnDedup.map(monsterCardHtml).join('')}</div></div>`
      : '';
    const legendLearnHtml = legendLearnDedup.length > 0
      ? `<div class="move-detail-section"><div class="move-detail-section-title">传说技能 (${legendLearnDedup.length})</div><div class="move-detail-monster-grid">${legendLearnDedup.map(monsterCardHtml).join('')}</div></div>`
      : '';
    const bloodlineLearnHtml = bloodlineLearnDedup.length > 0
      ? `<div class="move-detail-section"><div class="move-detail-section-title">血脉学习 (${bloodlineLearnDedup.length})</div><div class="move-detail-monster-grid">${bloodlineLearnDedup.map(monsterCardHtml).join('')}</div></div>`
      : '';
    const skillStoneHtml = skillStoneDedup.length > 0
      ? `<div class="move-detail-section"><div class="move-detail-section-title">技能石 (${skillStoneDedup.length})</div><div class="move-detail-monster-grid">${skillStoneDedup.map(monsterCardHtml).join('')}</div></div>`
      : '';

    CommonUI.destroyWithin(body);
    body.innerHTML = `
      <span class="modal-close" onclick="document.getElementById('move-modal').style.display='none'">&times;</span>
      <div class="move-detail-card">
        <img src="assets/monster/skill/${name}.png" class="move-detail-skill-icon" alt="${name}" onerror="this.style.display='none'">
        <div class="move-detail-skill-body">
          <div class="move-detail-skill-name-line">${elemIconHtml}<span class="move-detail-skill-name">${name}</span></div>
          <div class="move-detail-skill-info">
            <span class="move-detail-skill-tag">${typeIconHtml}${typeZh}</span>
            ${energy != null ? `<span class="move-detail-skill-tag"><img src="assets/icons/move-sub/energy.png" class="move-detail-type-icon" alt="能耗">${energy}</span>` : ''}
            ${power === '?' || (power != null && power > 0) ? `<span class="move-detail-skill-tag">${typeIconHtml}${power}</span>` : ''}
          </div>
          ${desc ? `<div class="move-detail-skill-desc">${desc}</div>` : ''}
          ${name === '折射' ? buildRefractionHtml() : ''}
        </div>
        <div class="multi-skill-selected-list" id="multi-skill-selected-list"></div>
        <div class="move-detail-multi-skill">
          <div class="multi-skill-label">技能交集筛选</div>
          <div class="multi-skill-search-wrap">
            <input type="text" id="multi-skill-search" class="multi-skill-input" placeholder="${multiSkillSelected.length >= 3 ? '已满3个' : '添加技能...'}" autocomplete="off" ${multiSkillSelected.length >= 3 ? 'disabled' : ''}>
            <div class="multi-skill-dropdown" id="multi-skill-dropdown" style="display:none;"></div>
          </div>
        </div>
      </div>
      <div id="multi-skill-result"></div>
      <div class="move-detail-monsters-title listing-learner-heading">
        <span id="move-learners-title">可学习该技能的精灵 (${total})</span>
        <span class="listing-style-host" id="move-detail-style"></span>
      </div>
      <div id="move-learners-default" class="listing-learner-view">
        ${total > 0 ? selfLearnHtml + legendLearnHtml + bloodlineLearnHtml + skillStoneHtml : '<div class="move-detail-empty">暂无精灵数据</div>'}
      </div>
      <div id="move-learners-table" class="listing-learner-view" hidden></div>
    `;
    modal.style.display = 'flex';
    // 动态调整 z-index，确保显示在精灵弹窗之上
    const petModal = document.getElementById('pet-modal');
    const petZ = petModal ? parseInt(getComputedStyle(petModal).zIndex) || 200 : 200;
    modal.style.zIndex = petZ + 100;
    modal.onclick = function(e) {
      if (e.target === modal) modal.style.display = 'none';
    };
    modal.oncontextmenu = function(e) {
      e.preventDefault();
      if (multiSkillSelected.length === 0) {
        modal.style.display = 'none';
      }
    };

    ListingUI.mountStyleSwitch(body.querySelector('#move-detail-style'), detailStyle, value => {
      detailStyle = value;
      renderLearnerViews();
    });
    const onTableClick = event => {
      const sortButton = event.target.closest('[data-listing-sort]');
      if (sortButton) {
        learnerSort = ListingUI.nextSort(learnerSort, sortButton.dataset.listingSort);
        renderLearnerViews();
        return;
      }
      const row = event.target.closest('[data-monster-id]');
      if (row) PetDexPage.showPetDetail(Number(row.dataset.monsterId));
    };
    body.addEventListener('click', onTableClick);
    const detailOwner = body.querySelector('.move-detail-card');
    const unregisterClick = CommonUI.registerCleanup(detailOwner, () => {
      body.removeEventListener('click', onTableClick); unregisterClick();
    });
    ListingUI.onStatsChange(detailOwner, () => {
      if (modal.style.display !== 'none') renderLearnerViews();
    });
    renderLearnerViews();
    // 绑定多技能交集筛选事件
    bindMultiSkillEvents(name);
  }

  // ===== 多技能交集筛选 =====

  function bindMultiSkillEvents(currentSkillName) {
    const input = document.getElementById('multi-skill-search');
    const dropdown = document.getElementById('multi-skill-dropdown');
    if (!input || !dropdown) return;

    let suggestIndex = -1;

    function searchSkills(kw) {
      const allMoves = RKData.getMoves().filter(mv => {
        const n = RKData.getMoveName(mv);
        return !EXCLUDED_MOVES.includes(n);
      });
      const exclude = new Set([currentSkillName, ...multiSkillSelected]);
      const results = [];
      for (const mv of allMoves) {
        const n = RKData.getMoveName(mv);
        if (exclude.has(n)) continue;
        if (n.toLowerCase().includes(kw) || (RKData.getMoveDesc(mv) || '').toLowerCase().includes(kw)) {
          results.push(n);
        }
      }
      return results.slice(0, 30);
    }

    function renderDropdown(items) {
      if (items.length === 0) {
        dropdown.style.display = 'none';
        return;
      }
      dropdown.innerHTML = items.map((n, i) => {
        const mv = RKData.getMoves().find(m => RKData.getMoveName(m) === n);
        const elemZh = mv ? getMoveElemZh(mv) : '';
        const elemIcon = elemZh ? RKData.getTypeIcon(elemZh) : '';
        const iconHtml = elemIcon ? `<img src="${elemIcon}" class="multi-skill-dropdown-icon" alt="${elemZh}">` : '';
        return `<div class="multi-skill-dropdown-item${i === suggestIndex ? ' active' : ''}" data-skill="${n}">${iconHtml}${n}</div>`;
      }).join('');
      dropdown.style.display = 'block';
    }

    input.addEventListener('input', function() {
      const kw = this.value.trim().toLowerCase();
      if (!kw) { dropdown.style.display = 'none'; return; }
      suggestIndex = -1;
      renderDropdown(searchSkills(kw));
    });

    input.addEventListener('keydown', function(e) {
      const items = dropdown.querySelectorAll('.multi-skill-dropdown-item');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        suggestIndex = Math.min(suggestIndex + 1, items.length - 1);
        items.forEach((it, i) => it.classList.toggle('active', i === suggestIndex));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        suggestIndex = Math.max(suggestIndex - 1, -1);
        items.forEach((it, i) => it.classList.toggle('active', i === suggestIndex));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (suggestIndex >= 0 && items[suggestIndex]) {
          addMultiSkill(items[suggestIndex].dataset.skill, currentSkillName);
        } else if (items.length > 0) {
          addMultiSkill(items[0].dataset.skill, currentSkillName);
        }
      } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
      }
    });

    dropdown.addEventListener('click', function(e) {
      const item = e.target.closest('.multi-skill-dropdown-item');
      if (item) addMultiSkill(item.dataset.skill, currentSkillName);
    });

    const searchWrap = document.querySelector('.multi-skill-search-wrap');
    if (searchWrap) {
      searchWrap.addEventListener('click', function(e) {
        if (!e.target.closest('.multi-skill-dropdown')) {
          input.focus();
        }
      });
    }

    // Modal-local listener: disposed on redraw, never accumulate document listeners.
    const modal = document.getElementById('move-modal');
    const outsideClick = event => {
      if (!event.target.closest('.multi-skill-search-wrap')) dropdown.style.display = 'none';
    };
    modal.addEventListener('click', outsideClick, true);
    const unregister = CommonUI.registerCleanup(input, () => {
      modal.removeEventListener('click', outsideClick, true); unregister();
    });
  }

  function renderSelectedSkills() {
    const listEl = document.getElementById('multi-skill-selected-list');
    if (!listEl) return;
    if (multiSkillSelected.length === 0) {
      listEl.innerHTML = '';
      return;
    }
    listEl.innerHTML = multiSkillSelected.map((n, i) => {
      const skillIconHtml = `<img src="assets/monster/skill/${n}.png" class="multi-skill-selected-skill-img" alt="" onerror="this.style.display='none'">`;
      return `<button type="button" class="multi-skill-selected-item" title="移除此技能" onclick="MovesPage.removeMultiSkill(${i})">${skillIconHtml}<span class="multi-skill-selected-name">${n}</span></button>`;
    }).join('');
  }

  function addMultiSkill(skillName, currentSkillName) {
    if (multiSkillSelected.length >= 3) return;
    if (multiSkillSelected.includes(skillName) || skillName === currentSkillName) return;
    multiSkillSelected.push(skillName);

    // 更新 UI
    const input = document.getElementById('multi-skill-search');
    const dropdown = document.getElementById('multi-skill-dropdown');
    if (input) {
      input.value = '';
      if (multiSkillSelected.length >= 3) {
        input.disabled = true;
        input.placeholder = '已满3个';
      }
    }
    if (dropdown) dropdown.style.display = 'none';
    renderSelectedSkills();
    updateMultiSkillResult(currentSkillName);
  }

  function removeMultiSkill(index) {
    const list = document.getElementById('multi-skill-selected-list');
    const restoreFocus = list?.contains(document.activeElement);
    multiSkillSelected.splice(index, 1);
    const input = document.getElementById('multi-skill-search');
    if (input) {
      input.disabled = false;
      input.placeholder = '添加技能...';
    }
    renderSelectedSkills();
    if (restoreFocus) (list.children[Math.min(index, list.children.length - 1)] || input)?.focus();
    updateMultiSkillResult(currentDetail?.name || '');
  }

  function updateMultiSkillResult(currentSkillName) {
    const resultEl = document.getElementById('multi-skill-result');
    if (!resultEl) return;
    CommonUI.destroyWithin(resultEl);

    if (multiSkillSelected.length === 0) {
      resultEl.innerHTML = '';
      return;
    }

    const allSkillNames = [currentSkillName, ...multiSkillSelected];
    const allMonsters = RKData.getMonsters();
    const results = [];

    allMonsters.forEach(m => {
      if (m.is_leader_form) return;
      const wiki = RKData.getResolvedWikiData(m);
      if (wiki && wiki.skills) {
        const skillSet = new Set(wiki.skills.map(s => s.name));
        if (allSkillNames.every(sn => skillSet.has(sn))) {
          results.push({ monster: m, source: '' });
        }
      }
    });

    const dedupResults = deduplicateByEvolution(results);
    const skillNamesStr = allSkillNames.join(' + ');

    if (dedupResults.length > 0) {
      resultEl.innerHTML = `
        <div class="move-detail-section multi-skill-result-section">
          <div class="move-detail-section-title multi-skill-result-title">同时拥有「${skillNamesStr}」的精灵 (${dedupResults.length})</div>
          ${detailStyle === 'table' ? ListingUI.monsterTable(dedupResults.map(info => info.monster), learnerSort) : `<div class="move-detail-monster-grid">${dedupResults.map(monsterCardHtml).join('')}</div>`}
        </div>`;
    } else {
      resultEl.innerHTML = `
        <div class="move-detail-section multi-skill-result-section">
          <div class="move-detail-section-title multi-skill-result-title">同时拥有「${skillNamesStr}」的精灵 (0)</div>
          <div class="move-detail-empty">没有精灵同时拥有这些技能</div>
        </div>`;
    }
    mountLearnerPriority(resultEl);
  }

  function renderList() {
    const listContainer = document.getElementById('move-list-container');
    const countEl = document.getElementById('move-count');
    if (!listContainer) return;

    let list = RKData.getMoves().filter(mv => {
      const name = RKData.getMoveName(mv);
      return !EXCLUDED_MOVES.includes(name);
    });

    // 关键词搜索（技能名称 + 描述）
    if (currentFilter.keyword) {
      const kw = currentFilter.keyword.toLowerCase();
      list = list.filter(mv =>
        RKData.getMoveName(mv).toLowerCase().includes(kw) ||
        (RKData.getMoveDesc(mv) || '').toLowerCase().includes(kw)
      );
    }

    // OR within each include dimension, AND across dimensions; exclusions remove
    // the union of matching values without mutating the master skill list.
    list = list.filter(mv => CommonUI.FilterExclusion.matches(valueFilters, {
      type: getMoveTypeZh(mv), elem: getMoveElemZh(mv),
      energy: mv.energy_cost, power: mv.power, season: mv.season || 'S1'
    }));

    // 排序
    if (activeSortKey && activeSortState > 0) {
      const asc = activeSortState === 2;
      list.sort((a, b) => {
        const va = a[activeSortKey] || 0;
        const vb = b[activeSortKey] || 0;
        return asc ? va - vb : vb - va;
      });
    }



    listContainer.innerHTML = `<div class="detail-skill-list" style="grid-template-columns: repeat(4, 1fr); gap: 8px;">${list.map(mv => {
      const name = RKData.getMoveName(mv);
      const desc = RKData.getMoveDesc(mv);
      const typeZh = getMoveTypeZh(mv);
      const elemZh = getMoveElemZh(mv);
      return RKData.buildSkillCardHtml({
        name, desc, type: typeZh, element: elemZh,
        energy: mv.energy_cost, power: mv.power, moveId: mv.id,
        extraAttrs: `data-move-id="${mv.id}" style="cursor:pointer;"`,
        extraHtml: name === '折射' ? buildRefractionHtml() : ''
      });
    }).join('')}</div>`;
  }

  function toggleRefraction() {
    refractionExpanded = !refractionExpanded;
    renderList();
    // 如果弹窗打开，也更新弹窗内容
    const modal = document.getElementById('move-modal');
    if (modal && modal.style.display === 'flex') {
      const mv = RKData.getMoves().find(m => RKData.getMoveName(m) === '折射');
      if (mv) showMoveDetail(mv);
    }
  }

  return { render, toggleRefraction, removeMultiSkill, showMoveDetail };
})();
