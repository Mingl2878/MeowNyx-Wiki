/**
 * updatedata.js — 数据更新页面
 * 复用 style.css 的控件外观；表单排列只由本页面限定的规则负责。
 */
const UpdateDataPage = (function () {
  let currentTab = 'home';
  let currentEditorMonster = null;
  let editorSkillList = [];   // [{name, source}]
  let addPetSkillList = [];   // [{name, source}]
  let editorTypeSel = new Set();   // 编辑精灵属性选择
  let addPetTypeSel = new Set();   // 新增精灵属性选择
  let editorSearchText = '';        // 保存编辑精灵搜索框文字
  let editorSearchObj = null;       // 保存选中的精灵对象（用于恢复图标）
  // 地区形态 & 进化关系状态
  let editorFormCategory = '无多形态';
  let editorMainFormName = '';
  let editorEvolvesFromID = null;   // 明确普通前置
  let editorLeaderOfID = null;      // 独立首领化来源，不混入普通进化
  let addPetFormCategory = '无多形态';
  let addPetMainFormName = '';
  let addPetEvolvesFromID = null;

  // 数据更新页面专用样式（注入在页面 HTML 中，避免 CSS 缓存问题）
  const PAGE_STYLE = `<style>
    /* 仅数据编辑表单需要换行和120px最小宽度；不得放回共用 .calc-root 布局。 */
    #ud-tab-content .input-row { display: flex; gap: 15px; flex-wrap: wrap; }
    #ud-tab-content .input-group { flex: 1; min-width: 120px; }
    /* 大按钮 */
    .ud-btn-lg {
      padding: 12px 32px !important;
      font-size: 15px !important;
      border-radius: 8px !important;
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
      min-width: 140px;
      transition: all 0.2s ease;
    }
    .ud-btn-lg:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.18);
    }
    .ud-btn-lg:active {
      transform: translateY(0);
      box-shadow: 0 1px 4px rgba(0,0,0,0.1);
    }
    /* 按钮行靠右 */
    .ud-btn-row { display: flex; gap: 12px; justify-content: flex-end; margin-top: 16px; }
    /* 属性选择网格 — 缩小 */
    .ud-type-grid {
      display: grid;
      grid-template-columns: repeat(9, minmax(0, 40px));
      gap: 6px;
      justify-content: center;
    }
    .ud-type-icon {
      aspect-ratio: 1;
      border-radius: 50%;
      cursor: pointer;
      transition: all 0.3s;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      background: var(--bg-secondary);
    }
    .ud-type-icon img { width: 26px; height: 26px; object-fit: contain; }
    .ud-type-icon:hover { border-color: var(--text-muted); transform: translateY(-2px); }
    .ud-type-icon.active { transform: scale(1.1); border-color: transparent; }
    .ud-type-icon.active[data-type="Normal"]     { background: #9099a1; }
    .ud-type-icon.active[data-type="Grass"]      { background: #5dbc5d; }
    .ud-type-icon.active[data-type="Fire"]       { background: #e8643c; }
    .ud-type-icon.active[data-type="Water"]      { background: #3d8ee0; }
    .ud-type-icon.active[data-type="Light"]      { background: #e8a73a; }
    .ud-type-icon.active[data-type="Ground"]     { background: #b8865a; }
    .ud-type-icon.active[data-type="Ice"]        { background: #5cc6e8; }
    .ud-type-icon.active[data-type="Dragon"]     { background: #7a5bef; }
    .ud-type-icon.active[data-type="Electric"]   { background: #f0b737; }
    .ud-type-icon.active[data-type="Poison"]     { background: #9555a5; }
    .ud-type-icon.active[data-type="Bug"]        { background: #8a9a30; }
    .ud-type-icon.active[data-type="Fighting"]   { background: #c45a3c; }
    .ud-type-icon.active[data-type="Flying"]     { background: #8aa5e8; }
    .ud-type-icon.active[data-type="Cute"]       { background: #e88ab0; }
    .ud-type-icon.active[data-type="Ghost"]      { background: #6a4a7a; }
    .ud-type-icon.active[data-type="Dark"]       { background: #5a4a6a; }
    .ud-type-icon.active[data-type="Mechanical"] { background: #8895a7; }
    .ud-type-icon.active[data-type="Illusion"]   { background: #d06cf0; }
    /* 进化阶段 pill */
    .ud-evo-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 24px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: var(--bg-secondary);
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;
    }
    .ud-evo-pill:hover { border-color: var(--text-muted); color: var(--text-primary); }
    .ud-evo-pill.active {
      border-color: transparent;
      background: var(--accent);
      color: #fff;
    }
    .ud-evo-pills { display: flex; gap: 12px; justify-content: center; }
    /* 种族值输入框 — 缩小 */
    .ud-stat-input {
      width: 80px !important;
      padding: 8px 10px !important;
      font-size: 14px !important;
      border: 2px solid var(--border) !important;
      border-radius: 8px !important;
      background: var(--bg-card) !important;
      color: var(--text-primary) !important;
      text-align: center !important;
    }
    .ud-stat-input:focus {
      outline: none;
      border-color: var(--accent) !important;
      box-shadow: 0 0 0 3px rgba(108,92,231,0.1) !important;
    }
    /* 技能卡片 — 删除按钮浮在卡片右上角外侧 */
    .ud-skill-item-wrap { position: relative; }
    .ud-skill-remove {
      position: absolute;
      top: -8px;
      right: -8px;
      z-index: 10;
      line-height: 1;
      width: 22px;
      height: 22px;
      padding: 0;
      font-size: 14px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #ud-tab-content .detail-skill-tag { margin: 1px !important; }
    #ud-tab-content .detail-skill-item { position: relative !important; padding-right: 22px !important; }
    #ud-tab-content .detail-skill-energy {
      border: 1px solid #ccc !important;
      background: #fff !important;
      color: #000 !important;
      border-radius: 10px !important;
      padding: 1px 8px !important;
      font-size: 11px !important;
      font-weight: 600 !important;
      min-width: 18px !important;
      text-align: center !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 2px !important;
    }
    #ud-tab-content .detail-skill-tag.type-物攻, #ud-tab-content .detail-skill-tag.type-魔攻, #ud-tab-content .detail-skill-tag.type-防御, #ud-tab-content .detail-skill-tag.type-状态 {
      border: 1px solid #ccc !important;
      background: #fff !important;
      color: #000 !important;
      border-radius: 10px !important;
      padding: 1px 8px !important;
      font-size: 11px !important;
      font-weight: 600 !important;
    }
    #ud-tab-content .detail-skill-tag.detail-skill-power {
      border: 1px solid #ccc !important;
      background: #fff !important;
      color: #000 !important;
    }
    /* 技能来源分组 */
    .ud-skill-source-group { margin-bottom: 12px; }
    .ud-skill-source-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--text-primary);
      padding: 4px 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      display: inline-block;
      margin-bottom: 8px;
    }
    /* Tab 栏 */
    #ud-page .ud-tabs {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      max-width: 100%;
      gap: 8px;
      margin: 0 auto 24px;
      padding: 6px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: fit-content;
    }
    .ud-tab {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 28px;
      border-radius: 8px;
      color: var(--text-secondary);
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
      text-decoration: none;
      user-select: none;
    }
    .ud-tab:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }
    .ud-tab.active {
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    }
  </style>`;

  function render(container) {
    window.CatalogUpdater?.unmount();
    container.innerHTML = `<div class="calc-root" id="ud-page"><div class="scroll-container" style="padding:8px 24px 40px;">
      ${PAGE_STYLE}
      <h3 style="font-size:1.3em;font-weight:700;margin-bottom:16px;text-align:center;">数据更新</h3>
      <div class="ud-tabs">
        <a class="ud-tab" data-tab="home">更新与工具</a>
        <a class="ud-tab" data-tab="editor">编辑精灵</a>
        <a class="ud-tab" data-tab="addPet">新增精灵</a>
        <a class="ud-tab" data-tab="addMove">新增技能</a>
      </div>
      <div class="ud-catalog-toolbar">
        <button type="button" class="btn btn-secondary" id="ud-reload-catalog">重新载入资料</button>
        <span id="ud-reload-result" role="status"></span>
      </div>
      <div id="ud-tab-content"></div>
    </div></div>`;
    document.getElementById('ud-reload-catalog').addEventListener('click', async () => {
      const button = document.getElementById('ud-reload-catalog');
      const result = document.getElementById('ud-reload-result');
      if (!window.CatalogUpdater) { result.textContent = '更新组件未载入；请保留完整程序文件后重试。'; return; }
      button.disabled = true;
      result.textContent = '正在确认任务状态并等待保存…';
      const ok = await window.CatalogUpdater.reload();
      button.disabled = false;
      if (!ok) result.textContent = '未重新载入（取消、任务进行中或保存未成功）。草稿仍在；请在“更新与工具”查看状态，确认保存后重试。';
    });
    bindTabEvents();
    renderTab();
  }

  function bindTabEvents() {
    document.querySelectorAll('.ud-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        // 切换前保存搜索框文字
        const editorInput = document.querySelector('#ud-editor-search-slot .search-bar');
        if (editorInput) editorSearchText = editorInput.value;
        currentTab = btn.dataset.tab;
        updateTabHighlight();
        renderTab();
      });
    });
    updateTabHighlight();
  }

  function updateTabHighlight() {
    document.querySelectorAll('.ud-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === currentTab);
    });
  }

  function renderTab() {
    const el = document.getElementById('ud-tab-content');
    if (!el) return;
    window.CatalogUpdater?.unmount();
    if (typeof CommonUI !== 'undefined') CommonUI.destroyWithin?.(el);
    if (currentTab === 'home')       { el.innerHTML = renderHome();       bindHome(); }
    else if (currentTab === 'editor')  { el.innerHTML = renderEditor();     bindEditor(); if (currentEditorMonster) { editorSkillList = getMonsterSkillNames(currentEditorMonster).slice(); editorTypeSel = new Set(); if (currentEditorMonster.main_type) editorTypeSel.add(currentEditorMonster.main_type.name); if (currentEditorMonster.sub_type) editorTypeSel.add(currentEditorMonster.sub_type.name); renderEditorForm(currentEditorMonster); } }
    else if (currentTab === 'addPet')  { el.innerHTML = renderAddPet();     bindAddPet(); }
    else if (currentTab === 'addMove') { el.innerHTML = renderAddMove();    bindAddMove(); }
  }

  // ─── 通用组件 ───
  const escapeText = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function statField(label, id, val) {
    return `<div class="input-group" style="flex:0 0 auto;min-width:auto;">
      <label class="accent-label">${label}</label>
      <input type="number" id="${id}" class="ud-stat-input" value="${escapeText(val || 0)}" min="0" max="999">
    </div>`;
  }

  function textField(label, id, val, placeholder) {
    return `<div class="input-group" style="flex:1;">
      <label class="accent-label">${label}</label>
      <input type="text" id="${id}" value="${escapeText(val || '')}" placeholder="${escapeText(placeholder || '')}">
    </div>`;
  }

  function textareaField(label, id, val, placeholder) {
    return `<div class="input-group" style="flex:1 1 100%;">
      <label class="accent-label">${label}</label>
      <textarea id="${id}" rows="3" placeholder="${escapeText(placeholder || '')}">${escapeText(val || '')}</textarea>
    </div>`;
  }

  function selectField(label, id, optionsHtml) {
    return `<div class="input-group">
      <label class="accent-label">${label}</label>
      <select id="${id}">${optionsHtml}</select>
    </div>`;
  }

  // ─── 地区形态选择器 HTML ───
  const FORM_CATEGORIES = [
    { value: '无多形态', label: '无地区形态' },
    { value: '主形态',   label: '主形态' },
    { value: '变体形态', label: '变体形态' },
  ];

  function formCategoryHtml(prefix, currentCat, mainFormName) {
    return `<div class="skill-section">
      <h4>地区形态</h4>
      <div class="ud-evo-pills" id="${prefix}-formcat-pills">
        ${FORM_CATEGORIES.map(c => `<span class="ud-evo-pill ${c.value === currentCat ? 'active' : ''}" data-cat="${c.value}">${c.label}</span>`).join('')}
      </div>
      <div id="${prefix}-mainform-wrap" style="${currentCat === '变体形态' ? '' : 'display:none;'}margin-top:8px;">
        <div class="input-group" style="flex:0 0 auto;min-width:auto;">
          <label class="accent-label">主形态名称</label>
          <input type="text" id="${prefix}-mainform-name" value="${escapeText(mainFormName || '')}" placeholder="填写主形态的形态名，如：蓬松的样子" style="width:260px;padding:8px 12px;border:2px solid var(--border);border-radius:8px;font-size:14px;">
        </div>
      </div>
    </div>`;
  }

  function bindFormCategory(prefix, getCat, setCat, getMainForm, setMainForm) {
    const pills = document.getElementById(prefix + '-formcat-pills');
    if (!pills) return;
    pills.onclick = e => {
      const pill = e.target.closest('.ud-evo-pill');
      if (!pill) return;
      const cat = pill.dataset.cat;
      setCat(cat);
      pills.innerHTML = FORM_CATEGORIES.map(c =>
        `<span class="ud-evo-pill ${c.value === cat ? 'active' : ''}" data-cat="${c.value}">${c.label}</span>`
      ).join('');
      const wrap = document.getElementById(prefix + '-mainform-wrap');
      if (wrap) wrap.style.display = cat === '变体形态' ? '' : 'none';
    };
  }

  // ─── 进化/退化关系选择器 ───
  function evolutionRelHtml(prefix, evolvesFromID, label = '普通进化前置') {
    const hasEvo = evolvesFromID != null;
    let parentName = '';
    if (hasEvo) {
      const parent = RKData.getMonsters().find(m => m.id === evolvesFromID);
      if (parent) parentName = RKData.getMonsterDisplayName(parent);
    }
    return `<div class="skill-section">
      <h4>${escapeText(label)}</h4>
      <div class="ud-evo-pills" id="${prefix}-evorel-pills">
        <span class="ud-evo-pill ${!hasEvo ? 'active' : ''}" data-evo="none">无关联</span>
        <span class="ud-evo-pill ${hasEvo ? 'active' : ''}" data-evo="has">有关联</span>
      </div>
      <div id="${prefix}-evorel-wrap" style="${hasEvo ? '' : 'display:none;'}margin-top:8px;">
        <div style="text-align:center;">
          <div style="margin-bottom:8px;color:var(--text-secondary);font-size:13px;">从下方搜索选择上游（进化前）精灵：</div>
          <div id="${prefix}-evorel-slot" style="position:relative;text-align:center;"></div>
          ${hasEvo && parentName ? `<div style="margin-top:8px;font-size:14px;color:var(--text-primary);">当前上游：<b>${escapeText(parentName)}</b>（ID: ${evolvesFromID}）</div>` : ''}
        </div>
      </div>
    </div>`;
  }

  let evoRelSearchState = {};   // prefix -> { currentParentId, searchBox }

  function bindEvolutionRel(prefix, getEvoID, setEvoID, extraFilter = () => true) {
    const pills = document.getElementById(prefix + '-evorel-pills');
    if (!pills) return;

    evoRelSearchState[prefix] = { currentParentId: getEvoID() };

    pills.onclick = e => {
      const pill = e.target.closest('.ud-evo-pill');
      if (!pill) return;
      const has = pill.dataset.evo === 'has';
      const wrap = document.getElementById(prefix + '-evorel-wrap');
      if (!has) {
        setEvoID(null);
        evoRelSearchState[prefix].currentParentId = null;
        if (wrap) wrap.style.display = 'none';
        pills.innerHTML = `<span class="ud-evo-pill active" data-evo="none">无关联</span><span class="ud-evo-pill" data-evo="has">有关联</span>`;
      } else {
        if (wrap) wrap.style.display = '';
        pills.innerHTML = `<span class="ud-evo-pill" data-evo="none">无关联</span><span class="ud-evo-pill active" data-evo="has">有关联</span>`;
        // 创建搜索框
        const slot = document.getElementById(prefix + '-evorel-slot');
        if (slot) {
          slot.innerHTML = '';
          const sb = CommonUI.createSearchBox({
            placeholder: '搜索关联来源...',
            limit: 15,
            extraFilter,
            onSelect: (pet) => {
              setEvoID(pet.id);
              evoRelSearchState[prefix].currentParentId = pet.id;
              const pname = RKData.getMonsterDisplayName(pet);
              const info = document.createElement('div');
              info.style.cssText = 'margin-top:8px;font-size:14px;color:var(--text-primary);';
              info.innerHTML = `当前上游：<b>${escapeText(pname)}</b>（ID: ${pet.id}）`;
              slot.innerHTML = '';
              slot.appendChild(sb.wrapper);
              slot.appendChild(info);
              sb.setValue(pname);
            },
            renderItem: CommonUI.monsterRenderItem(null)
          });
          if (sb && sb.wrapper) slot.appendChild(sb.wrapper);
        }
      }
    };

    // 如果初始有关联，创建搜索框
    if (getEvoID() != null) {
      const slot = document.getElementById(prefix + '-evorel-slot');
      if (slot) {
        const sb = CommonUI.createSearchBox({
          placeholder: '搜索关联来源...',
          limit: 15,
          extraFilter,
          onSelect: (pet) => {
            setEvoID(pet.id);
            evoRelSearchState[prefix].currentParentId = pet.id;
            const pname = RKData.getMonsterDisplayName(pet);
            const info = document.createElement('div');
            info.style.cssText = 'margin-top:8px;font-size:14px;color:var(--text-primary);';
            info.innerHTML = `当前上游：<b>${escapeText(pname)}</b>（ID: ${pet.id}）`;
            slot.innerHTML = '';
            slot.appendChild(sb.wrapper);
            slot.appendChild(info);
            sb.setValue(pname);
          },
          renderItem: CommonUI.monsterRenderItem(null)
        });
        if (sb && sb.wrapper) {
          slot.appendChild(sb.wrapper);
          if (evoRelSearchState[prefix].currentParentId != null) {
            const parent = RKData.getMonsters().find(m => m.id === evoRelSearchState[prefix].currentParentId);
            if (parent) sb.setValue(RKData.getMonsterDisplayName(parent));
          }
        }
      }
    }
  }

  function typeOptions() {
    return RKData.getTypes().map(t =>
      `<option value="${t.name}">${RKData.getTypeZh(t.name)}</option>`
    ).join('');
  }

  // ─── 技能列表渲染（复用技能列表页面的 .detail-skill-item 样式）───
  const CATEGORY_MAP = { 'Physical Attack':'物攻', 'Magic Attack':'魔攻', 'Status':'状态', 'Defense':'防御' };
  
  function findMoveByName(name) {
    return RKData.getMoves().find(mv => RKData.getMoveName(mv) === name);
  }

  function getMoveField(name, field) {
    const mv = findMoveByName(name);
    if (!mv) return '';
    if (field === 'type') return CATEGORY_MAP[mv.move_category] || '';
    if (field === 'element') return (mv.move_type && mv.move_type.localized && mv.move_type.localized.zh) || (mv.move_type && mv.move_type.name) || '';
    if (field === 'energy') return mv.energy_cost;
    if (field === 'power') return mv.power;
    if (field === 'desc') return RKData.getMoveDesc(mv);
    return '';
  }

  // 技能来源分组顺序
  const SKILL_SOURCE_ORDER = ['默认', '血脉', '技能石', '传说'];
  const SKILL_SOURCE_LABEL = { '默认': '基础技能', '血脉': '血脉技能', '技能石': '技能石', '传说': '传说技能' };

  function getMonsterSkillNamesWithSource(m) {
    const wd = RKData.getResolvedWikiData(m);
    if (wd && wd.skills) return wd.skills.map(s => ({ name: s.name, source: s.source || '默认' }));
    return [];
  }

  function skillListHtml(skills) {
    if (!skills || skills.length === 0)
      return '<div class="empty-state" style="padding:16px;">暂无技能</div>';
    // 按 source 分组（skills 为 [{name, source}]）
    const groups = {};
    skills.forEach((s, idx) => {
      const src = s.source || '默认';
      if (!groups[src]) groups[src] = [];
      groups[src].push({ name: s.name, idx });
    });
    // 按 SKILL_SOURCE_ORDER 排序
    const orderedSources = [...SKILL_SOURCE_ORDER.filter(s => groups[s]), ...Object.keys(groups).filter(s => !SKILL_SOURCE_ORDER.includes(s))];
    return orderedSources.map(src => {
      const label = SKILL_SOURCE_LABEL[src] || src;
      const items = groups[src];
      return `<div class="ud-skill-source-group">
        <div class="ud-skill-source-title">${escapeText(label)} (${items.length})</div>
        <div class="detail-skill-list" style="grid-template-columns: repeat(4, 1fr); gap: 8px;">${items.map(({ name, idx }) => {
          const mv = findMoveByName(name);
          const card = RKData.buildSkillCardHtml({
            name: name,
            desc: mv ? RKData.getMoveDesc(mv) : '',
            type: mv ? (CATEGORY_MAP[mv.move_category] || '') : '',
            element: mv ? ((mv.move_type && mv.move_type.localized && mv.move_type.localized.zh) || (mv.move_type && mv.move_type.name) || '') : '',
            energy: mv ? mv.energy_cost : null,
            power: mv ? mv.power : null,
            extraAttrs: `data-skill-idx="${idx}"`,
            extraHtml: `<button type="button" class="btn btn-danger btn-sm ud-skill-remove" data-idx="${idx}">×</button>`
          });
          return card;
        }).join('')}</div>
      </div>`;
    }).join('');
  }

  function findSkillSource(name) {
    // 从 wiki 数据中查找技能来源
    const allMonsters = RKData.getMonsters();
    for (const m of allMonsters) {
      const wd = RKData.getResolvedWikiData(m);
      if (wd && wd.skills) {
        const skill = wd.skills.find(s => s.name === name);
        if (skill) return skill.source || '默认';
      }
    }
    return null;
  }

  function getMonsterSkillNames(m) {
    const wd = RKData.getResolvedWikiData(m);
    if (wd && wd.skills) return wd.skills.map(s => ({ name: s.name, source: s.source || '默认' }));
    return [];
  }

  // ─── 属性选择器（使用页面专用 .ud-type-grid + .ud-type-icon 样式）───
  function renderTypePills(containerId, selSet, maxCount) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.className = 'ud-type-grid';
    const allTypes = RKData.ALL_TYPES;
    container.innerHTML = allTypes.map(t => {
      const enName = RKData.getTypeEn(t) || t;
      const icon = RKData.getTypeIcon(t);
      const active = selSet.has(enName) ? 'active' : '';
      return `<div class="ud-type-icon ${active}" data-type="${enName}"><img src="${icon}" alt="${t}"></div>`;
    }).join('');
    container.onclick = e => {
      const icon = e.target.closest('.ud-type-icon');
      if (!icon) return;
      const type = icon.dataset.type;
      if (selSet.has(type)) {
        selSet.delete(type);
      } else {
        if (selSet.size >= maxCount) {
          const first = selSet.values().next().value;
          selSet.delete(first);
        }
        selSet.add(type);
      }
      renderTypePills(containerId, selSet, maxCount);
    };
  }

  // ─── 进化阶段 pill 选择器（单选，使用页面专用 .ud-evo-pill 样式）───
  let evoStageValue = '';
  function renderEvoPills(containerId, stages, currentVal) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.className = 'ud-evo-pills';
    evoStageValue = currentVal || stages[0];
    container.innerHTML = stages.map(s =>
      `<span class="ud-evo-pill ${s === evoStageValue ? 'active' : ''}" data-stage="${s}">${s}</span>`
    ).join('');
    container.onclick = e => {
      const pill = e.target.closest('.ud-evo-pill');
      if (!pill) return;
      evoStageValue = pill.dataset.stage;
      container.innerHTML = stages.map(s =>
        `<span class="ud-evo-pill ${s === evoStageValue ? 'active' : ''}" data-stage="${s}">${s}</span>`
      ).join('');
    };
  }
  function getEvoValue() { return evoStageValue; }

  // 技能来源选项
  const SKILL_SOURCE_SELECT = [
    { value: '默认', label: '基础技能' },
    { value: '血脉', label: '血脉技能' },
    { value: '技能石', label: '技能石' },
    { value: '传说', label: '传说技能' },
  ];

  // ─── 技能搜索添加器（带来源选择）───
  function bindSkillAdder(slotId, listId, skillArr) {
    const slot = document.getElementById(slotId);
    if (!slot) return;
    // 来源选择按钮组
    let currentSource = '默认';
    const sourceBar = document.createElement('div');
    sourceBar.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;justify-content:center;';
    sourceBar.innerHTML = SKILL_SOURCE_SELECT.map(s =>
      `<span class="ud-evo-pill ${s.value === currentSource ? 'active' : ''}" data-source="${s.value}" style="padding:6px 16px;font-size:13px;">${s.label}</span>`
    ).join('');
    sourceBar.onclick = e => {
      const pill = e.target.closest('.ud-evo-pill');
      if (!pill) return;
      currentSource = pill.dataset.source;
      sourceBar.innerHTML = SKILL_SOURCE_SELECT.map(s =>
        `<span class="ud-evo-pill ${s.value === currentSource ? 'active' : ''}" data-source="${s.value}" style="padding:6px 16px;font-size:13px;">${s.label}</span>`
      ).join('');
    };

    const searchWrapper = document.createElement('div');
    searchWrapper.style.cssText = 'text-align:center;';
    searchWrapper.appendChild(sourceBar);

    const searchBox = CommonUI.createSearchBox({
      placeholder: '输入技能名称搜索...',
      limit: 10,
      showIcon: true,
      search: (kw) => {
        const allMoves = RKData.getMoves();
        return allMoves.filter(mv => {
          const name = RKData.getMoveName(mv);
          return name.toLowerCase().includes(kw) && !skillArr.some(s => s.name === name);
        }).slice(0, 10).map(mv => {
          const name = RKData.getMoveName(mv);
          return { id: name, name: name, icon: `assets/monster/skill/${name}.png` };
        });
      },
      onSelect: (item) => {
        skillArr.push({ name: item.name, source: currentSource });
        document.getElementById(listId).innerHTML = skillListHtml(skillArr);
      }
    });
    if (searchBox && searchBox.wrapper) searchWrapper.appendChild(searchBox.wrapper);
    slot.appendChild(searchWrapper);
  }

  // ─── Tab 1: 更新与工具 ───
  function renderHome() {
    return '<div id="ud-official-catalog" class="card"><p>正在载入官方图鉴更新工具…</p></div>';
  }
  function bindHome() {
    const host = document.getElementById('ud-official-catalog');
    if (!host) return;
    if (window.CatalogUpdater) void window.CatalogUpdater.mount(host);
    else host.textContent = '官方图鉴更新组件未载入，请保留完整程序文件后重试。此时不会更新任何资料，仍可进入手工 Tab。';
  }

  // ─── Tab 2: 编辑精灵 ───
  function renderEditor() {
    return `<div style="width:100%;">
      <div class="card" style="margin-bottom:16px;">
        <div class="card-header"><h3>搜索精灵</h3></div>
        <div class="card-body" style="padding:20px;">
          <div id="ud-editor-search-slot" style="position:relative;"></div>
        </div>
      </div>
      <div id="ud-editor-form"></div>
    </div>`;
  }

  function bindEditor() {
    const slot = document.getElementById('ud-editor-search-slot');
    if (!slot) return;
    const searchBox = CommonUI.createSearchBox({
      placeholder: '搜索精灵名称...',
      limit: 20,
      onSelect: (pet) => {
        currentEditorMonster = pet;
        editorSearchText = RKData.getMonsterDisplayName(pet);
        editorSkillList = getMonsterSkillNames(pet).slice();
        editorTypeSel = new Set();
        if (pet.main_type) editorTypeSel.add(pet.main_type.name);
        if (pet.sub_type) editorTypeSel.add(pet.sub_type.name);
        renderEditorForm(pet);
      },
      renderItem: CommonUI.monsterRenderItem(null)
    });
    if (searchBox && searchBox.wrapper) {
      slot.appendChild(searchBox.wrapper);
      // 恢复搜索框文字
      if (editorSearchText) {
        searchBox.setValue(editorSearchText);
      }
    }
  }

  function editorLevelSettings(m) {
    const policy = PetLevels.config(m);
    return { enabled: m.level_configurable === true, default: policy.defaultLevel, min: policy.min, max: policy.max, step: policy.step };
  }
  function levelSettingsHtml(settings) {
    return `<div class="skill-section ud-level-settings"><h4>等级调节</h4>
      <label class="ud-level-enable"><input type="checkbox" id="ud-level-enabled" ${settings.enabled ? 'checked' : ''}>手动开启（特性含“等级”时自动开启）</label>
      <div class="input-row">${[['默认等级','default',99],['最低等级','min',99],['最高等级','max',99],['步进','step',98]].map(([label,key,max]) => `<div class="input-group"><label for="ud-level-${key}">${label}</label><input type="number" id="ud-level-${key}" min="1" max="${max}" step="1" value="${settings[key]}"></div>`).join('')}</div>
      <small>以默认等级为步进基准，保留范围两端。</small></div>`;
  }
  function readEditorLevelSettings() {
    const result = { enabled: document.getElementById('ud-level-enabled').checked };
    for (const key of ['default','min','max','step']) result[key] = Number(document.getElementById('ud-level-' + key).value);
    PetLevels.steps({ min: result.min, max: result.max, step: result.step, defaultLevel: result.default });
    return result;
  }

  function renderEditorForm(m) {
    const el = document.getElementById('ud-editor-form');
    if (!el || !m) return;
    const skillsLoaded = Array.isArray(RKData.getResolvedWikiData(m)?.skills);
    const originalSkillList = JSON.stringify(editorSkillList);
    const initialLevels = editorLevelSettings(m);
    const traitName = (m.trait && m.trait.localized && m.trait.localized.zh && m.trait.localized.zh.name) || '';
    const traitDesc = (m.trait && m.trait.localized && m.trait.localized.zh && m.trait.localized.zh.description) || '';

    // 读取当前精灵的形态和进化数据
    editorFormCategory = m.form_category || '无多形态';
    editorMainFormName = m.main_form_name || '';
    editorEvolvesFromID = m.evolves_from_id ?? null;
    editorLeaderOfID = m.leader_of_id ?? null;
    const originalPredecessor = editorEvolvesFromID;
    const originalLeaderBase = editorLeaderOfID;
    const memberText = Array.isArray(m.evolution_members)
      ? m.evolution_members.map(id => { const pet = RKData.getMonsters().find(item => item.id === id); return pet ? RKData.getMonsterDisplayName(pet) : `ID ${id}`; }).join('、') || '无'
      : '未提供';

    el.innerHTML = `<div class="card">
      <div class="card-header"><h3>编辑 — ${escapeText(RKData.getMonsterDisplayName(m))}</h3></div>
      <div class="card-body" style="padding:20px;">
        <div id="ud-save-result" style="margin-bottom:16px;"></div>
        <div class="skill-section">
          <h4>种族值</h4>
          <div class="input-row" style="justify-content:center;">
            ${statField('生命','ud-base_hp',m.base_hp)}
            ${statField('物攻','ud-base_phy_atk',m.base_phy_atk)}
            ${statField('魔攻','ud-base_mag_atk',m.base_mag_atk)}
            ${statField('物防','ud-base_phy_def',m.base_phy_def)}
            ${statField('魔防','ud-base_mag_def',m.base_mag_def)}
            ${statField('速度','ud-base_spd',m.base_spd)}
          </div>
        </div>
        <div class="skill-section">
          <h4>属性（最多2个）</h4>
          <div id="ud-editor-type-pills"></div>
        </div>
        <div class="skill-section">
          <h4>进化阶段</h4>
          <div id="ud-evo-pills"></div>
        </div>
        ${formCategoryHtml('ud-editor', editorFormCategory, editorMainFormName)}
        <div class="skill-section"><h4>进化关联成员</h4><p>${escapeText(memberText)}</p></div>
        ${evolutionRelHtml('ud-editor', editorEvolvesFromID)}
        ${m.is_leader_form || editorLeaderOfID != null ? evolutionRelHtml('ud-editor-leader', editorLeaderOfID, '首领化来源') : ''}
        <div class="skill-section">
          <h4>特性</h4>
          <div class="input-row">
            ${textField('特性名称','ud-trait-name',traitName,'特性名称')}
          </div>
          <div class="input-row" style="margin-top:8px;">
            ${textareaField('特性描述','ud-trait-desc',traitDesc,'特性描述')}
          </div>
        </div>
        ${levelSettingsHtml(initialLevels)}
        <div class="skill-section">
          <h4>技能列表</h4>
          <div class="input-row" style="margin-bottom:12px;">
            <div class="input-group" style="flex:1;">
              <label class="accent-label">搜索添加技能</label>
              <div id="ud-editor-skill-slot" style="position:relative;"></div>
            </div>
          </div>
          ${skillsLoaded ? '' : '<p style="color:var(--danger);">技能数据未成功关联；保存其他资料不会覆盖技能。请先修复数据后再编辑技能。</p>'}
          <div id="ud-editor-skill-list" class="ud-skill-list">${skillListHtml(editorSkillList)}</div>
        </div>
        <div class="ud-btn-row">
          <button type="button" class="btn btn-primary ud-btn-lg" id="ud-save-btn">保存修改</button>
          <button type="button" class="btn btn-secondary ud-btn-lg" id="ud-reset-btn">重置</button>
        </div>
      </div>
    </div>`;

    // 属性 pill
    renderTypePills('ud-editor-type-pills', editorTypeSel, 2);
    // 进化阶段 pill
    const editorStages = ['基础形态','高级形态','首领形态'];
    if (m.evolution_stage === '未确认') editorStages.push('未确认');
    renderEvoPills('ud-evo-pills', editorStages, m.evolution_stage);
    // 地区形态
    bindFormCategory('ud-editor',
      () => editorFormCategory, v => editorFormCategory = v,
      () => editorMainFormName, v => editorMainFormName = v);
    // 进化关系
    bindEvolutionRel('ud-editor',
      () => editorEvolvesFromID, v => editorEvolvesFromID = v,
      candidate => candidate.id !== m.id && (!Array.isArray(m.evolution_members) || m.evolution_members.includes(candidate.id)));
    bindEvolutionRel('ud-editor-leader',
      () => editorLeaderOfID, v => editorLeaderOfID = v,
      candidate => candidate.id !== m.id && !candidate.is_leader_form && candidate.evolution_stage !== '首领形态');
    // 技能搜索
    bindSkillAdder('ud-editor-skill-slot', 'ud-editor-skill-list', editorSkillList);

    // 技能删除
    document.getElementById('ud-editor-skill-list').addEventListener('click', e => {
      const rm = e.target.closest('.ud-skill-remove');
      if (rm) { editorSkillList.splice(+rm.dataset.idx, 1); document.getElementById('ud-editor-skill-list').innerHTML = skillListHtml(editorSkillList); }
    });

    // 保存
    document.getElementById('ud-save-btn').addEventListener('click', async () => {
      const r = document.getElementById('ud-save-result');
      const typeArr = [...editorTypeSel];
      let levels;
      try { levels = readEditorLevelSettings(); } catch (err) { if (r) r.textContent = err.message; return; }
      const skillsChanged = JSON.stringify(editorSkillList) !== originalSkillList;
      if (skillsChanged && !skillsLoaded) {
        if (r) r.textContent = '技能数据未成功关联，已阻止覆盖。请修复数据并刷新后重试。';
        return;
      }
      const allowEmptySkills = skillsChanged && editorSkillList.length === 0;
      if (allowEmptySkills && !window.confirm('确认清空这只精灵的全部技能？此操作只修改当前精灵，不会清空它的进化来源。')) return;
      const payload = {
        // Version belongs to the data currently loaded by RKData, never to the latest update status.
        ...(typeof RKData !== 'undefined' && RKData.getCatalogRevision ? { base_revision: RKData.getCatalogRevision?.() || null } : {}),
        id: m.id,
        base_hp: +document.getElementById('ud-base_hp').value || 0,
        base_phy_atk: +document.getElementById('ud-base_phy_atk').value || 0,
        base_mag_atk: +document.getElementById('ud-base_mag_atk').value || 0,
        base_phy_def: +document.getElementById('ud-base_phy_def').value || 0,
        base_mag_def: +document.getElementById('ud-base_mag_def').value || 0,
        base_spd: +document.getElementById('ud-base_spd').value || 0,
        main_type: typeArr[0] || '',
        sub_type: typeArr[1] || '',
        evolution_stage: getEvoValue(),
        form_category: editorFormCategory,
        main_form_name: document.getElementById('ud-editor-mainform-name') ? document.getElementById('ud-editor-mainform-name').value.trim() : '',
        ...(editorEvolvesFromID !== originalPredecessor ? { evolves_from_id: editorEvolvesFromID } : {}),
        ...(editorLeaderOfID !== originalLeaderBase ? { leader_of_id: editorLeaderOfID } : {}),
        trait_name: document.getElementById('ud-trait-name').value.trim(),
        trait_desc: document.getElementById('ud-trait-desc').value.trim(),
        ...(JSON.stringify(levels) !== JSON.stringify(initialLevels) ? { level_controls: levels } : {}),
        // 未编辑技能时不回传列表，避免查询失败或旧页面状态覆盖已有学习面。
        ...(skillsChanged ? { skillList: editorSkillList, allowEmptySkills } : {})
      };
      if (r) r.innerHTML = '<span style="color:var(--text-secondary);">正在保存...</span>';
      try {
        const res = await fetch('/api/edit/monster', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        const data = await res.json();
        if (r) r.textContent = data.ok && res.ok !== false
          ? '✓ 保存成功！点击“重新载入资料”后生效；当前草稿不会自动清除。'
          : `保存失败: ${data.error || '服务返回异常'}。若资料版本已变化，请先确认重新载入后再编辑。`;
      } catch (err) {
        if (r) r.textContent = `请求失败: ${err.message}`;
      }
    });

    // 重置
    document.getElementById('ud-reset-btn').addEventListener('click', () => {
      currentEditorMonster = m;
      editorSkillList = getMonsterSkillNames(m).slice();
      editorTypeSel = new Set();
      if (m.main_type) editorTypeSel.add(m.main_type.name);
      if (m.sub_type) editorTypeSel.add(m.sub_type.name);
      renderEditorForm(m);
    });
  }

  // ─── Tab 3: 新增精灵 ───
  function renderAddPet() {
    return `<div style="width:100%;">
      <div class="card">
        <div class="card-header"><h3>新增精灵</h3></div>
        <div class="card-body" style="padding:20px;">
          <div id="ud-addpet-result" style="margin-bottom:16px;"></div>
          <div class="skill-section">
            <h4>基本信息</h4>
            <div class="input-row">
              ${textField('名称','ud-addpet-name','','精灵名称')}
            </div>
          </div>
          <div class="skill-section">
            <h4>种族值</h4>
            <div class="input-row" style="justify-content:center;">
              ${statField('生命','ud-addpet-hp',100)}
              ${statField('物攻','ud-addpet-phy',100)}
              ${statField('魔攻','ud-addpet-mag',100)}
              ${statField('物防','ud-addpet-def',100)}
              ${statField('魔防','ud-addpet-mdef',100)}
              ${statField('速度','ud-addpet-spd',100)}
            </div>
          </div>
          <div class="skill-section">
            <h4>属性（最多2个）</h4>
            <div id="ud-addpet-type-pills"></div>
          </div>
          <div class="skill-section">
            <h4>进化阶段</h4>
            <div id="ud-addpet-evo-pills"></div>
          </div>
          ${formCategoryHtml('ud-addpet', addPetFormCategory, addPetMainFormName)}
          ${evolutionRelHtml('ud-addpet', addPetEvolvesFromID, '普通进化前置／首领化来源（按阶段保存）')}
          <div class="skill-section">
            <h4>特性</h4>
            <div class="input-row">
              ${textField('特性名称','ud-addpet-trait-name','','特性名称')}
            </div>
            <div class="input-row" style="margin-top:8px;">
              ${textareaField('特性描述','ud-addpet-trait-desc','','特性描述')}
            </div>
          </div>
          <div class="skill-section">
            <h4>技能列表</h4>
            <div class="input-row" style="margin-bottom:12px;">
              <div class="input-group" style="flex:1;">
                <label class="accent-label">搜索添加技能</label>
                <div id="ud-addpet-skill-slot" style="position:relative;"></div>
              </div>
            </div>
            <div id="ud-addpet-skill-list" class="ud-skill-list">${skillListHtml(addPetSkillList)}</div>
          </div>
          <div class="ud-btn-row">
            <button type="button" class="btn btn-primary ud-btn-lg" id="ud-addpet-save">添加精灵</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function bindAddPet() {
    addPetTypeSel = new Set();
    renderTypePills('ud-addpet-type-pills', addPetTypeSel, 2);
    renderEvoPills('ud-addpet-evo-pills', ['基础形态','高级形态','首领形态'], '基础形态');
    // 地区形态
    bindFormCategory('ud-addpet',
      () => addPetFormCategory, v => addPetFormCategory = v,
      () => addPetMainFormName, v => addPetMainFormName = v);
    // 进化关系
    bindEvolutionRel('ud-addpet',
      () => addPetEvolvesFromID, v => addPetEvolvesFromID = v);
    bindSkillAdder('ud-addpet-skill-slot', 'ud-addpet-skill-list', addPetSkillList);
    document.getElementById('ud-addpet-skill-list').addEventListener('click', e => {
      const rm = e.target.closest('.ud-skill-remove');
      if (rm) { addPetSkillList.splice(+rm.dataset.idx, 1); document.getElementById('ud-addpet-skill-list').innerHTML = skillListHtml(addPetSkillList); }
    });
    document.getElementById('ud-addpet-save').addEventListener('click', async () => {
      const r = document.getElementById('ud-addpet-result');
      const typeArr = [...addPetTypeSel];
      const payload = {
        // Version belongs to the data currently loaded by RKData, never to the latest update status.
        ...(typeof RKData !== 'undefined' && RKData.getCatalogRevision ? { base_revision: RKData.getCatalogRevision?.() || null } : {}),
        name: document.getElementById('ud-addpet-name').value.trim(),
        evolution_chain_name: '',
        form_category: addPetFormCategory,
        main_form_name: addPetMainFormName,
        evolves_from_id: getEvoValue() === '首领形态' ? null : addPetEvolvesFromID,
        leader_of_id: getEvoValue() === '首领形态' ? addPetEvolvesFromID : null,
        base_hp: +document.getElementById('ud-addpet-hp').value || 0,
        base_phy_atk: +document.getElementById('ud-addpet-phy').value || 0,
        base_mag_atk: +document.getElementById('ud-addpet-mag').value || 0,
        base_phy_def: +document.getElementById('ud-addpet-def').value || 0,
        base_mag_def: +document.getElementById('ud-addpet-mdef').value || 0,
        base_spd: +document.getElementById('ud-addpet-spd').value || 0,
        main_type: typeArr[0] || '',
        sub_type: typeArr[1] || '',
        evolution_stage: getEvoValue(),
        trait_name: document.getElementById('ud-addpet-trait-name').value.trim(),
        trait_desc: document.getElementById('ud-addpet-trait-desc').value.trim(),
        skillList: addPetSkillList
      };
      if (!payload.name) { r.innerHTML = '<span style="color:var(--danger);">请填写精灵名称</span>'; return; }
      r.innerHTML = '<span style="color:var(--text-secondary);">正在添加...</span>';
      try {
        const res = await fetch('/api/add/monster', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        const data = await res.json();
        r.textContent = data.ok && res.ok !== false
          ? '✓ 添加成功！点击“重新载入资料”后生效；当前草稿不会自动清除。'
          : `添加失败: ${data.error || '服务返回异常'}。若资料版本已变化，请先确认重新载入后再编辑。`;
      } catch (err) {
        r.textContent = `请求失败: ${err.message}`;
      }
    });
  }

  // ─── Tab 4: 新增技能 ───
  let addMoveTypeSel = new Set();
  let addMoveCatValue = '物攻';
  function renderAddMove() {
    const cats = ['物攻','魔攻','状态','防御'];
    return `<div style="width:100%;">
      <div class="card">
        <div class="card-header"><h3>新增技能</h3></div>
        <div class="card-body" style="padding:20px;">
          <div id="ud-addmove-result" style="margin-bottom:16px;"></div>
          <div class="skill-section">
            <div class="input-row">
              ${textField('技能名称','ud-addmove-name','','技能名称')}
            </div>
          </div>
          <div class="skill-section">
            <h4>属性（选择1个）</h4>
            <div id="ud-addmove-type-pills"></div>
          </div>
          <div class="skill-section">
            <h4>技能类型</h4>
            <div class="ud-evo-pills" id="ud-addmove-cat-pills">
              ${cats.map(c => `<span class="ud-evo-pill ${c === addMoveCatValue ? 'active' : ''}" data-cat="${c}">${c}</span>`).join('')}
            </div>
          </div>
          <div class="skill-section">
            <h4>数值</h4>
            <div class="input-row" style="justify-content:center;">
              ${statField('威力','ud-addmove-power',0)}
              ${statField('能耗','ud-addmove-energy',0)}
              ${statField('连击数','ud-addmove-combo',1)}
            </div>
          </div>
          <div class="skill-section">
            <div class="input-row">
              ${textareaField('技能描述','ud-addmove-desc','','技能描述')}
            </div>
          </div>
          <div class="ud-btn-row">
            <button type="button" class="btn btn-primary ud-btn-lg" id="ud-addmove-save">添加技能</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function bindAddMove() {
    // 属性选择器（单选）
    addMoveTypeSel = new Set();
    renderTypePills('ud-addmove-type-pills', addMoveTypeSel, 1);
    // 技能类型按钮组（单选）
    const catPills = document.getElementById('ud-addmove-cat-pills');
    if (catPills) {
      catPills.onclick = e => {
        const pill = e.target.closest('.ud-evo-pill');
        if (!pill) return;
        addMoveCatValue = pill.dataset.cat;
        const cats = ['物攻','魔攻','状态','防御'];
        catPills.innerHTML = cats.map(c =>
          `<span class="ud-evo-pill ${c === addMoveCatValue ? 'active' : ''}" data-cat="${c}">${c}</span>`
        ).join('');
      };
    }
    const saveBtn = document.getElementById('ud-addmove-save');
    if (!saveBtn) return;
    saveBtn.addEventListener('click', async () => {
      const r = document.getElementById('ud-addmove-result');
      const typeArr = [...addMoveTypeSel];
      const payload = {
        // Version belongs to the data currently loaded by RKData, never to the latest update status.
        ...(typeof RKData !== 'undefined' && RKData.getCatalogRevision ? { base_revision: RKData.getCatalogRevision?.() || null } : {}),
        name: document.getElementById('ud-addmove-name').value.trim(),
        type: typeArr[0] || '',
        category: addMoveCatValue,
        power: +document.getElementById('ud-addmove-power').value || 0,
        energy: +document.getElementById('ud-addmove-energy').value || 0,
        combo: +document.getElementById('ud-addmove-combo').value || 1,
        description: document.getElementById('ud-addmove-desc').value.trim()
      };
      if (!payload.name) { r.innerHTML = '<span style="color:var(--danger);">请填写技能名称</span>'; return; }
      r.innerHTML = '<span style="color:var(--text-secondary);">正在添加...</span>';
      try {
        const res = await fetch('/api/add/move', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        const data = await res.json();
        r.textContent = data.ok && res.ok !== false
          ? '✓ 添加成功！点击“重新载入资料”后生效；当前草稿不会自动清除。'
          : `添加失败: ${data.error || '服务返回异常'}。若资料版本已变化，请先确认重新载入后再编辑。`;
      } catch (err) {
        r.textContent = `请求失败: ${err.message}`;
      }
    });
  }

  function onLeave() { window.CatalogUpdater?.unmount(); }
  return { render, onLeave };
})();
