/**
 * team.js — 精灵组队系统
 * 左列：我的队伍 / 筛选条件 / 候选精灵
 * 右列：精灵详情
 */
const TeamPage = (function () {
  let searchKeyword = '';
  let activeTypes = new Set(); // 多选属性筛选


  // ---- 组管理 ----
  // 每个组独立存储: team, teamMagic, selectedDetailId, petNatures, petIVs, detailBloodline, petSkills
  let groups = [];      // [{ id, name, team, teamMagic, selectedDetailId, petNatures, petIVs, detailBloodline, petSkills }]
  let activeGroupId = null;

  // 当前组的实时数据（从 groups[activeGroupId] 同步）
  let team = [];
  let teamMagic = '';
  let selectedDetailId = 221;
  let petNatures = {};
  let petIVs = {};
  let detailBloodline = {};
  let petSkills = {};
  let leaderFormId = {}; // { petId: leaderFormMonsterId | null }  null=普通形态
  let detailStatMode = 'final'; // 'final' = 属性值, 'base' = 种族值

  // ---- 本地存储 ----
  const STORAGE_KEY = 'rk_team_config';

  function getCurrentGroupData() {
    return {
      team: team,
      teamMagic: teamMagic,
      selectedDetailId: selectedDetailId,
      petNatures: petNatures,
      petIVs: petIVs,
      detailBloodline: detailBloodline,
      petSkills: petSkills,
      leaderFormId: leaderFormId
    };
  }

  function applyGroupData(data) {
    team = Array.isArray(data.team) ? data.team : [];
    teamMagic = typeof data.teamMagic === 'string' ? data.teamMagic : '';
    selectedDetailId = data.selectedDetailId || (team.length > 0 ? team[0] : 221);
    petNatures = data.petNatures || {};
    petIVs = data.petIVs || {};
    detailBloodline = data.detailBloodline || {};
    petSkills = data.petSkills || {};
    leaderFormId = data.leaderFormId || {};
  }

  function saveConfig() {
    // 将当前数据写回当前组
    const g = groups.find(g => g.id === activeGroupId);
    if (g) Object.assign(g, getCurrentGroupData());
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ groups, activeGroupId }));
    } catch (e) {
      console.warn('保存配置失败:', e);
    }
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        // 首次使用，创建默认组
        groups = [{ id: 'g1', name: '组1', ...getCurrentGroupData() }];
        activeGroupId = 'g1';
        return;
      }
      const saved = JSON.parse(raw);
      // 兼容旧格式（无 groups）
      if (saved.groups && Array.isArray(saved.groups)) {
        groups = saved.groups;
        activeGroupId = saved.activeGroupId || (groups.length > 0 ? groups[0].id : null);
      } else if (saved.team) {
        groups = [{ id: 'g1', name: '组1', team: saved.team, teamMagic: saved.teamMagic || '', selectedDetailId: saved.selectedDetailId || 221, petNatures: saved.petNatures || {}, petIVs: saved.petIVs || {}, detailBloodline: saved.detailBloodline || {}, petSkills: saved.petSkills || {}, leaderFormId: saved.leaderFormId || {} }];
        activeGroupId = 'g1';
      } else {
        groups = [{ id: 'g1', name: '组1', ...getCurrentGroupData() }];
        activeGroupId = 'g1';
      }
      if (groups.length === 0) {
        groups = [{ id: 'g1', name: '组1', ...getCurrentGroupData() }];
        activeGroupId = 'g1';
      }
      // 确保至少5个组
      ensureMinGroups();
      // 加载当前组数据
      const g = groups.find(g => g.id === activeGroupId) || groups[0];
      applyGroupData(g);
    } catch (e) {
      console.warn('加载配置失败:', e);
      groups = [{ id: 'g1', name: '组1', ...getCurrentGroupData() }];
      activeGroupId = 'g1';
      ensureMinGroups();
    }
  }

  function ensureMinGroups() {
    // 至少4组
    while (groups.length < 4) {
      addEmptyGroup();
    }
    // 确保至少有一个空组（没有精灵的组）
    const hasEmpty = groups.some(g => !g.team || g.team.every(s => !s));
    if (!hasEmpty) {
      addEmptyGroup();
    }
  }

  function addEmptyGroup() {
    const num = groups.length + 1;
    const id = 'g' + Date.now() + '_' + num;
    const newGroup = { id, name: `组${num}`, team: [], teamMagic: '', selectedDetailId: 221, petNatures: {}, petIVs: {}, detailBloodline: {}, petSkills: {}, leaderFormId: {} };
    groups.push(newGroup);
    return newGroup;
  }

  function switchGroup(groupId) {
    if (groupId === activeGroupId) return;
    // 保存当前组数据
    saveConfig();
    // 切换到新组
    activeGroupId = groupId;
    const g = groups.find(g => g.id === groupId);
    if (g) applyGroupData(g);
    saveConfig();
    // 重新渲染
    const container = document.getElementById('page-container');
    render(container);
    // 恢复展开状态
    if (configExpanded) {
      const panel = document.getElementById('team-config-panel');
      const btn = document.getElementById('team-expand-btn');
      if (panel) panel.style.display = '';
      if (btn) btn.classList.add('expanded');
      renderTeamConfigRows();
    }
  }

  function addGroup() {
    const num = groups.length + 1;
    const id = 'g' + Date.now();
    const newGroup = { id, name: `组${num}`, team: [], teamMagic: '', selectedDetailId: 221, petNatures: {}, petIVs: {}, detailBloodline: {}, petSkills: {}, leaderFormId: {} };
    groups.push(newGroup);
    saveConfig();
    activeGroupId = id;
    applyGroupData(newGroup);
    const container = document.getElementById('page-container');
    render(container);
  }

  function deleteGroup(groupId) {
    if (groups.length <= 1) { CommonUI.showAlert('至少保留一个组'); return; }
    groups = groups.filter(g => g.id !== groupId);
    if (activeGroupId === groupId) {
      activeGroupId = groups[0].id;
      applyGroupData(groups[0]);
    }
    saveConfig();
    const container = document.getElementById('page-container');
    render(container);
  }

  function renameGroup(groupId, newName) {
    const g = groups.find(g => g.id === groupId);
    if (g) { g.name = newName; saveConfig(); }
  }

  function renderGroupBar() {
    const tabs = groups.map(g => `
      <div class="group-tab ${g.id === activeGroupId ? 'active' : ''}" data-group-id="${g.id}">
        <span class="group-tab-name" data-group-id="${g.id}" title="右键打开菜单">${g.name}</span>
        ${groups.length > 1 ? `<button class="group-tab-delete" data-group-id="${g.id}" title="删除此组">×</button>` : ''}
      </div>
    `).join('');
    return `<div class="group-bar">${tabs}<button class="group-add-btn" id="group-add-btn" title="新建组">+</button></div>`;
  }

  function bindGroupBarEvents() {
    // 点击切换组
    document.querySelectorAll('.group-tab').forEach(tab => {
      tab.addEventListener('click', function(e) {
        if (e.target.classList.contains('group-tab-delete')) return;
        switchGroup(this.dataset.groupId);
      });
      // 右键菜单
      tab.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        e.stopPropagation();
        showGroupContextMenu(e.clientX, e.clientY, this.dataset.groupId);
      });
    });
    // 删除组按钮
    document.querySelectorAll('.group-tab-delete').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const groupId = this.dataset.groupId;
        const g = groups.find(g => g.id === groupId);
        if (!g) return;
        if (groups.length <= 1) { CommonUI.showAlert('至少保留一个组'); return; }
        CommonUI.showConfirm(`确定删除「${g.name}」吗？`, () => deleteGroup(groupId));
      });
    });
    // 新建组
    const addBtn = document.getElementById('group-add-btn');
    if (addBtn) addBtn.addEventListener('click', addGroup);
  }

  function showGroupContextMenu(x, y, groupId) {
    const _z = (window.__getPageZoom && window.__getPageZoom()) || 1;
    // 移除已有菜单
    const existing = document.getElementById('group-context-menu');
    if (existing) existing.remove();
    const g = groups.find(g => g.id === groupId);
    if (!g) return;
    const menu = document.createElement('div');
    menu.id = 'group-context-menu';
    menu.className = 'group-context-menu';
    menu.style.left = (x / _z) + 'px';
    menu.style.top = (y / _z) + 'px';
    menu.innerHTML = `
      <div class="group-ctx-item" data-action="rename">重命名</div>
      <div class="group-ctx-item" data-action="copy">复制</div>
      <div class="group-ctx-item" data-action="delete">删除</div>
      <div class="group-ctx-sep"></div>
      <div class="group-ctx-item" data-action="export">导出</div>
      <div class="group-ctx-item" data-action="import">导入</div>
    `;
    document.body.appendChild(menu);
    // 调整位置防止溢出（rect 为视觉坐标，style 值为布局坐标，需除以缩放）
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = ((window.innerWidth - rect.width - 4) / _z) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = ((window.innerHeight - rect.height - 4) / _z) + 'px';
    // 菜单项点击
    menu.querySelectorAll('.group-ctx-item').forEach(item => {
      item.addEventListener('click', function() {
        const action = this.dataset.action;
        menu.remove();
        switch (action) {
          case 'rename':
            startGroupRename(groupId);
            break;
          case 'copy':
            copyGroup(groupId);
            break;
          case 'delete':
            CommonUI.showConfirm(`确定删除「${g.name}」吗？`, () => deleteGroup(groupId));
            break;
          case 'export':
            exportGroupConfig(groupId);
            break;
          case 'import':
            importGroupConfig();
            break;
        }
      });
    });
    // 点击外部关闭
    const closeHandler = (e) => {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', closeHandler); document.removeEventListener('contextmenu', closeHandler); }
    };
    setTimeout(() => {
      document.addEventListener('click', closeHandler);
      document.addEventListener('contextmenu', closeHandler);
    }, 0);
  }

  function startGroupRename(groupId) {
    const tab = document.querySelector(`.group-tab[data-group-id="${groupId}"] .group-tab-name`);
    if (!tab) return;
    const g = groups.find(g => g.id === groupId);
    if (!g) return;
    const oldName = g.name;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldName;
    input.className = 'group-rename-input';
    input.style.width = Math.max(40, oldName.length * 14) + 'px';
    tab.replaceWith(input);
    input.focus();
    input.select();
    const finish = () => {
      const newName = input.value.trim() || oldName;
      renameGroup(groupId, newName);
      const span = document.createElement('span');
      span.className = 'group-tab-name';
      span.dataset.groupId = groupId;
      span.title = '右键打开菜单';
      span.textContent = newName;
      input.replaceWith(span);
      // 重新绑定右键
      const tabEl = span.closest('.group-tab');
      if (tabEl) {
        tabEl.addEventListener('contextmenu', function(e) {
          e.preventDefault();
          e.stopPropagation();
          showGroupContextMenu(e.clientX, e.clientY, groupId);
        });
      }
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') input.blur(); });
  }

  function copyGroup(groupId) {
    const g = groups.find(g => g.id === groupId);
    if (!g) return;
    saveConfig(); // 先保存当前状态
    const num = groups.length + 1;
    const newId = 'g' + Date.now();
    const copy = {
      id: newId,
      name: g.name + '(副本)',
      team: JSON.parse(JSON.stringify(g.team)),
      teamMagic: g.teamMagic,
      selectedDetailId: g.selectedDetailId,
      petNatures: JSON.parse(JSON.stringify(g.petNatures)),
      petIVs: JSON.parse(JSON.stringify(g.petIVs)),
      detailBloodline: JSON.parse(JSON.stringify(g.detailBloodline)),
      petSkills: JSON.parse(JSON.stringify(g.petSkills))
    };
    groups.push(copy);
    activeGroupId = newId;
    applyGroupData(copy);
    saveConfig();
    const container = document.getElementById('page-container');
    render(container);
  }

  function exportGroupConfig(groupId) {
    const g = groups.find(g => g.id === groupId);
    if (!g) return;
    saveConfig();
    const config = { groups: [JSON.parse(JSON.stringify(g))], exportTime: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${g.name}_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importGroupConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) { input.remove(); return; }
      const reader = new FileReader();
      reader.onload = function(ev) {
        try {
          const config = JSON.parse(ev.target.result);
          let importedGroups = [];
          if (config.groups && Array.isArray(config.groups)) {
            importedGroups = config.groups;
          } else if (config.team) {
            importedGroups = [{ id: 'g1', name: '导入组', team: config.team, teamMagic: config.teamMagic || '', selectedDetailId: config.selectedDetailId || 181, petNatures: config.petNatures || {}, petIVs: config.petIVs || {}, detailBloodline: config.detailBloodline || {}, petSkills: config.petSkills || {} }];
          } else {
            CommonUI.showAlert('导入失败：无法识别的配置格式');
            return;
          }
          importedGroups.forEach(g => {
            g.id = 'g' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            if (!g.name) g.name = '导入组';
            groups.push(g);
          });
          const lastImported = importedGroups[importedGroups.length - 1];
          activeGroupId = lastImported.id;
          applyGroupData(lastImported);
          saveConfig();
          const container = document.getElementById('page-container');
          render(container);
          CommonUI.showAlert(`成功导入 ${importedGroups.length} 个组`);
        } catch (err) {
          CommonUI.showAlert('导入失败：JSON 格式错误');
        }
        input.remove();
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function exportConfig() {
    saveConfig();
    const config = {
      groups: groups,
      activeGroupId: activeGroupId,
      exportTime: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `team_config_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importConfig(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const config = JSON.parse(e.target.result);
        if (config.groups && Array.isArray(config.groups)) {
          groups = config.groups;
          activeGroupId = config.activeGroupId || (groups.length > 0 ? groups[0].id : null);
        } else if (config.team) {
          // 兼容旧格式
          groups = [{ id: 'g1', name: '导入组', team: config.team, teamMagic: config.teamMagic || '', selectedDetailId: config.selectedDetailId || 181, petNatures: config.petNatures || {}, petIVs: config.petIVs || {}, detailBloodline: config.detailBloodline || {}, petSkills: config.petSkills || {} }];
          activeGroupId = 'g1';
        } else {
          alert('导入失败：无法识别的配置格式');
          return;
        }
        const g = groups.find(g => g.id === activeGroupId) || groups[0];
        applyGroupData(g);
        saveConfig();
        const container = document.getElementById('page-container');
        render(container);
        CommonUI.showAlert('配置导入成功！');
      } catch (err) {
        alert('导入失败：JSON 格式错误');
      }
    };
    reader.readAsText(file);
  }

  // ---- 组配置面板（展开/收起 + 5行） ----
  let configExpanded = false;

  function renderTeamConfigRows() {
    const container = document.getElementById('team-config-rows');
    if (!container) return;
    ensureMinGroups();
    container.innerHTML = groups.map(g => {
      const isActive = g.id === activeGroupId;
      // 队伍魔法
      const magicItem = MAGIC_ITEMS.find(m => m.name === g.teamMagic);
      const magicHtml = magicItem
        ? `<div class="tc-row-magic"><img src="${magicItem.icon}" alt="${magicItem.name}" loading="lazy"></div>`
        : `<div class="tc-row-magic empty"></div>`;
      // 6个精灵槽
      let slotsHtml = '';
      for (let i = 0; i < 6; i++) {
        const petId = g.team[i];
        const pet = petId ? RKData.getMonsterById(petId) : null;
        if (pet) {
          const name = RKData.getMonsterDisplayName(pet);
          const imgUrl = pet.image ? `assets/monster/images/${pet.image}` : '';
          slotsHtml += `<div class="tc-row-slot filled" data-group-id="${g.id}" data-slot="${i}" title="${name}">${imgUrl ? `<img src="${imgUrl}" alt="${name}" loading="lazy">` : ''}</div>`;
        } else {
          slotsHtml += `<div class="tc-row-slot" data-group-id="${g.id}" data-slot="${i}"><span class="placeholder">+</span></div>`;
        }
      }
      return `<div class="team-config-row ${isActive ? 'active' : ''}" data-group-id="${g.id}">
        ${magicHtml}
        <div class="tc-row-slots">${slotsHtml}</div>
        <input class="tc-row-name" type="text" value="${g.name}" data-group-id="${g.id}" title="编辑队伍名称">
      </div>`;
    }).join('');

    // 绑定行点击 → 切换组
    container.querySelectorAll('.team-config-row').forEach(row => {
      row.addEventListener('click', function(e) {
        if (e.target.classList.contains('tc-row-name')) return;
        const groupId = this.dataset.groupId;
        if (groupId !== activeGroupId) switchGroup(groupId);
      });
    });

    // 绑定名称编辑
    container.querySelectorAll('.tc-row-name').forEach(input => {
      input.addEventListener('click', e => e.stopPropagation());
      input.addEventListener('change', function() {
        const groupId = this.dataset.groupId;
        const newName = this.value.trim() || '组';
        renameGroup(groupId, newName);
      });
    });
  }

  function bindExpandButton() {
    const btn = document.getElementById('team-expand-btn');
    const panel = document.getElementById('team-config-panel');
    if (!btn || !panel) return;
    btn.addEventListener('click', function() {
      configExpanded = !configExpanded;
      if (configExpanded) {
        panel.style.display = '';
        btn.classList.add('expanded');
        renderTeamConfigRows();
      } else {
        panel.style.display = 'none';
        btn.classList.remove('expanded');
      }
    });
  }

  // 页面首次加载时读取本地配置
  loadConfig();

  function render(container) {
    container.innerHTML = `
      <div class="scroll-container">
      <div class="team-layout">
        <!-- 左列 -->
        <div class="team-left">
          <!-- 我的队伍 -->
          <div class="team-panel team-panel-myteam">
            <div class="team-myteam-row">
              <div class="team-magic" id="team-magic"></div>
              <div class="team-slots" id="team-slots">${renderSlots()}</div>
              <div class="team-myteam-actions">
                <button class="team-reset-btn" id="team-reset-btn" title="清空所有已选精灵"><img src="assets/icons/ui/icon_reset.png" alt="重置" class="reset-btn-icon"></button>
                <button class="team-expand-btn" id="team-expand-btn" title="展开组配置"><img src="assets/icons/ui/icon_expand.png" alt="展开"></button>
              </div>
            </div>
          </div>
          <div class="team-config-panel" id="team-config-panel" style="display:none;">
            <div class="team-config-rows" id="team-config-rows"></div>
          </div>

          <!-- 筛选条件 -->
          <div class="team-panel team-panel-filter">
            <div class="team-filter-body">
              <div class="filter-section">
                <div id="team-search-slot" style="display:flex;justify-content:center;align-items:center;gap:8px;"></div>
              </div>
              <div class="filter-section">
                <div class="type-pills" id="team-type-pills"></div>
              </div>
            </div>
          </div>

          <!-- 候选精灵 -->
          <div class="team-panel team-panel-candidates">
            <div class="team-candidate-hint">左键查看精灵详情，右键编入/移出队伍</div>
            <div class="team-candidate-list hide-scrollbar" id="team-candidate-list"></div>
          </div>
        </div>

        <!-- 右列：精灵详情 -->
        <div class="team-right">
          <div class="team-panel team-panel-detail">
            <div class="team-panel-header">
              <h3 class="team-panel-title">精灵详情</h3>
            </div>
            <div class="team-detail-body" id="team-detail-body">
              <div class="team-detail-empty">点击候选精灵查看详情</div>
            </div>
          </div>
        </div>
      </div>
      <div class="team-bottom-panel">
        <div class="team-card-preview" id="team-card-preview">${renderTeamCard()}</div>
      </div>
      </div>
    `;
    bindEvents();
    bindExpandButton();
    renderTeamConfigRows();
    // 创建搜索框
    const searchBox = CommonUI.createSearchBox({
      placeholder: '搜索精灵名称...',
      limit: 10,
      onInput: (val) => { searchKeyword = val; renderCandidateList(); },
      onSelect: (pet) => {
        // 5c: 如果选中首领形态精灵，自动切换到基础形态
        if (pet.is_leader_form) {
          const baseForm = RKData.getMonsters().find(m =>
            m.dex_number === pet.dex_number && !m.is_leader_form && !m.hidden
          );
          if (baseForm) {
            searchKeyword = RKData.getMonsterDisplayName(baseForm);
            renderCandidateList();
            return;
          }
        }
        searchKeyword = RKData.getMonsterDisplayName(pet);
        renderCandidateList();
      },
      renderItem: CommonUI.monsterRenderItem(null)
    });
    searchBox.input.id = 'team-search';
    if (searchKeyword) searchBox.setValue(searchKeyword);
    const searchSlot = document.getElementById('team-search-slot');
    searchSlot.appendChild(searchBox.wrapper);
    renderTypePills();
    renderMagic();
    renderCandidateList();
    if (selectedDetailId) renderDetail();
    updateRestoreBtn();
  }

  function renderSlots() {
    let html = '';
    for (let i = 0; i < 6; i++) {
      const pet = team[i] ? RKData.getMonsterById(team[i]) : null;
      if (pet) {
        const name = RKData.getMonsterDisplayName(pet);
        const mainType = pet.main_type ? pet.main_type.name : '';
        const subType = pet.sub_type ? pet.sub_type.name : '';
        const imgUrl = pet.image ? `assets/monster/images/${pet.image}` : '';
        html += `
          <div class="team-slot filled" data-slot="${i}" data-pet-id="${pet.id}" title="${name}" draggable="true">
            ${imgUrl ? `<img src="${imgUrl}" class="slot-pet-img" alt="${name}" loading="lazy">` : ''}
          </div>
        `;
      } else {
        html += `<div class="team-slot" data-slot="${i}"><span class="slot-placeholder">+</span></div>`;
      }
    }
    return html;
  }

  const MAGIC_ITEMS = [
    { name: '进化之力', icon: 'assets/icons/magic-items/进化之力.png' },
    { name: '愿力强化', icon: 'assets/icons/magic-items/愿力强化.png' },
    { name: '光合治愈', icon: 'assets/icons/magic-items/光合治愈.png' },
    { name: '节流术', icon: 'assets/icons/magic-items/节流术.png' },
    { name: '闪焰爆发', icon: 'assets/icons/magic-items/闪焰爆发.png' }
  ];
  // 队伍魔法（单选）
  // teamMagic 已在顶部声明

  function renderMagic() {
    const container = document.getElementById('team-magic');
    if (!container) return;
    const item = MAGIC_ITEMS.find(m => m.name === teamMagic);
    const isUsed = teamMagic !== '';
    container.innerHTML = `<div class="team-magic-slot ${isUsed ? 'active' : ''}" data-slot="0" title="${item ? item.name : '点击选择队伍魔法'}">
      ${item ? `<img src="${item.icon}" class="team-magic-icon" alt="${item.name}" loading="lazy">` : '<span class="team-magic-placeholder">+</span>'}
    </div>`;
  }

  function openMagicPicker(slotIdx) {
    // 关闭已存在的下拉
    const existing = document.getElementById('magic-dropdown');
    if (existing) { existing.remove(); return; }

    const slotEl = document.querySelector(`.team-magic-slot[data-slot="0"]`);
    if (!slotEl) return;

    const dropdown = document.createElement('div');
    dropdown.id = 'magic-dropdown';
    dropdown.className = 'magic-dropdown';

    // 无选项 + 所有魔法
    const items = [{ name: '无', icon: '' }, ...MAGIC_ITEMS.map(m => ({ name: m.name, icon: m.icon }))];
    dropdown.innerHTML = `<div class="magic-dropdown-list">
      ${items.map(item => {
        const isActive = (item.name === '无' && teamMagic === '') || teamMagic === item.name;
        const iconHtml = item.icon
          ? `<img src="${item.icon}" class="magic-dropdown-icon" alt="${item.name}" loading="lazy">`
          : '<span class="magic-dropdown-empty">空</span>';
        return `<div class="magic-dropdown-item ${isActive ? 'active' : ''}" data-magic="${item.name}">
          ${iconHtml}
          <span class="magic-dropdown-name">${item.name}</span>
        </div>`;
      }).join('')}
    </div>`;

    // 定位到槽位下方
  const rect = slotEl.getBoundingClientRect();
  const _z = (window.__getPageZoom && window.__getPageZoom()) || 1;
  dropdown.style.position = 'fixed';
  dropdown.style.top = ((rect.bottom + 4) / _z) + 'px';
  dropdown.style.left = (Math.max(8, rect.left) / _z) + 'px';

    document.body.appendChild(dropdown);

    dropdown.querySelectorAll('.magic-dropdown-item').forEach(el => {
      el.addEventListener('click', () => {
        const name = el.dataset.magic;
        teamMagic = name === '无' ? '' : name;
        dropdown.remove();
        renderMagic();
        refreshTeamCard();
        saveConfig();
      });
    });

    // 点击外部关闭
    setTimeout(() => {
      const closeHandler = (e) => {
        if (!dropdown.contains(e.target) && !slotEl.contains(e.target)) {
          dropdown.remove();
          document.removeEventListener('click', closeHandler);
        }
      };
      document.addEventListener('click', closeHandler);
    }, 0);
  }

  function renderTypePills() {
    CommonUI.renderTypePills(
      document.getElementById('team-type-pills'),
      activeTypes,
      (type) => {
        if (activeTypes.has(type)) {
          activeTypes.delete(type);
        } else {
          activeTypes.add(type);
        }
        renderTypePills();
        renderCandidateList();
      }
    );
  }

  function renderCandidateList() {
    const listEl = document.getElementById('team-candidate-list');
    if (!listEl) return;

    let list = RKData.getMonsters();

    // 排除首领形态和隐藏精灵
    list = list.filter(m => !m.is_leader_form && !m.hidden && m.evolution_stage !== '基础形态');

    // 搜索筛选
    if (searchKeyword) {
      const kw = searchKeyword.toLowerCase().trim();
      // 拆分关键词：\"岚鸟(冬天的样子)\" → namePart=\"岚鸟\", formPart=\"冬天的样子\"
      const kwBase = kw.split(/[（(]/)[0].trim();
      const formMatch = kw.match(/[（(]([^）)]+)[）)]/);
      const formPart = formMatch ? formMatch[1].trim() : '';
      list = list.filter(m => {
        const name = RKData.getMonsterName(m).toLowerCase();
        const displayName = RKData.getMonsterDisplayName(m).toLowerCase();
        const chainName = (m.evolution_chain_name || '').toLowerCase();
        const form = (m.form || '').toLowerCase();
        const mainForm = (m.main_form_name || '').toLowerCase();
        // 完整匹配
        if (displayName.includes(kw) || name.includes(kw) || chainName.includes(kw)) return true;
        // 拆分匹配
        if (kwBase && (name.includes(kwBase) || chainName.includes(kwBase) || displayName.includes(kwBase))) {
          if (!formPart) return true;
          // form=default 的基础形态也匹配（冬季基础形态 form 是 default）
          if (form === 'default' || form === 'original') return true;
          return form.includes(formPart) || mainForm.includes(formPart);
        }
        return false;
      });
    }
    // 属性筛选（交集）
    if (activeTypes.size > 0) {
      list = list.filter(m => {
        const types = [m.main_type?.name, m.sub_type?.name].filter(Boolean);
        for (const t of activeTypes) {
          if (!types.includes(t)) return false;
        }
        return true;
      });
    }
    // 按有效种族值降序排列
    list.sort((a, b) => RKData.getEffectiveStats(b) - RKData.getEffectiveStats(a));

    listEl.innerHTML = list.map(m => {
      const name = RKData.getMonsterDisplayName(m);
      const isInTeam = team.includes(m.id);
      const imgUrl = m.image ? `assets/monster/images/${m.image}` : '';
      return `
        <div class="candidate-avatar ${isInTeam ? 'in-team' : ''}" data-pet-id="${m.id}" title="${name}">
          ${imgUrl ? `<img src="${imgUrl}" alt="${name}" loading="lazy">` : `<span class="candidate-avatar-placeholder">${name.charAt(0)}</span>`}
          ${isInTeam ? '<span class="candidate-check">✓</span>' : ''}
        </div>
      `;
    }).join('');

    // 固定容器高度为4行精灵，内部滚动且不显示滚动条
    const gap = 1, pad = 4;
    const w = listEl.clientWidth - pad * 2;
    const colW = (w - gap * 11) / 12;
    listEl.style.gridAutoRows = colW + 'px';
    listEl.style.height = (colW * 4 + gap * 3 + pad * 2) + 'px';

    // 点击候选项：展示详情 + 加入/移除队伍
    listEl.querySelectorAll('.candidate-avatar').forEach(el => {
      let clickTimer = null;
      el.addEventListener('click', function(e) {
        const petId = parseInt(this.dataset.petId);
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
          // 双击：加入/移除队伍
          TeamPage.togglePet(petId);
        } else {
          clickTimer = setTimeout(() => {
            clickTimer = null;
            // 单击：展示详情
            selectedDetailId = petId;
            renderDetail();
          }, 250);
        }
      });

      // 右键：查看详情 + 加入/移除队伍
      el.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        const petId = parseInt(this.dataset.petId);
        // 1. 查看详情
        selectedDetailId = petId;
        // 2. 加入/移除队伍
        if (team.includes(petId)) {
          const idx = team.indexOf(petId);
          team[idx] = null;
        } else {
          const emptyIdx = team.findIndex(s => s === null || s === undefined);
          if (emptyIdx >= 0) {
            team[emptyIdx] = petId;
            // 添加新精灵时清除快照，按钮恢复为"重置"
            teamSnapshot = null;
          } else if (team.length < 6) {
            team.push(petId);
            teamSnapshot = null;
          }
        }
        saveConfig();
        const container = document.getElementById('page-container');
        render(container);
      });
    });
  }

  // 属性值面板的6项属性
  const DETAIL_STATS = ['hp', 'defense', 'attack', 'magic_defense', 'magic_attack', 'speed'];
  const DETAIL_STAT_LABELS = { attack: '物攻', magic_attack: '魔攻', defense: '物防', magic_defense: '魔防', hp: '生命', speed: '速度' };

  function renderDetail() {
    const body = document.getElementById('team-detail-body');
    if (!body || !selectedDetailId) return;
    const m = RKData.getMonsterById(selectedDetailId);
    if (!m) { body.innerHTML = '<div class="team-detail-empty">未找到精灵</div>'; return; }

    // 获取当前精灵的性格/个体（切换精灵时保留各自的选择）
    const detailNature = petNatures[m.id] || {};
    const detailIV = petIVs[m.id] || {};

    // 5d: 首领血脉时，根据 leaderFormId 决定显示哪个形态的数据
    const bl = detailBloodline[m.id] || '';
    const lfId = leaderFormId[m.id] || null;
    let displayM = m;
    if (bl === 'Leader' && lfId) {
      const lf = RKData.getMonsterById(lfId);
      if (lf) displayM = lf;
    }
    const name = RKData.getMonsterDisplayName(displayM);
    const mainType = displayM.main_type ? displayM.main_type.name : '';
    const subType = displayM.sub_type ? displayM.sub_type.name : '';
    const imgUrl = displayM.image ? `assets/monster/images/${displayM.image}` : '';
    const { name: traitName, desc: traitDesc } = RKData.getTraitInfo(displayM);

    // 5d: 首领血脉时查找可用的首领形态列表
    const allMonsters = RKData.getMonsters();
    const leaderForms = allMonsters.filter(mm => mm.dex_number === m.dex_number && mm.is_leader_form).sort((a, b) => a.id - b.id);
    const showLeaderDropdown = bl === 'Leader' && leaderForms.length > 0;

    body.innerHTML = `
      <div class="detail-header">
        ${imgUrl ? `<img src="${imgUrl}" class="detail-pet-img" alt="${name}" loading="lazy" id="detail-pet-img-clickable" style="cursor:pointer;" title="点击选择技能">` : ''}
        <div>
          <div class="detail-pet-name">${name}${showLeaderDropdown ? (() => {
            const currentLabel = lfId ? RKData.getMonsterDisplayName(RKData.getMonsterById(lfId)) : '普通形态';
            return ` <button class="leader-form-trigger" id="leader-form-trigger" title="选择首领形态">${currentLabel} ▾</button>`;
          })() : ''}</div>
          <div class="detail-pet-types">
            ${mainType ? RKData.typeBadgeHtml(mainType) : ''}
            ${subType ? RKData.typeBadgeHtml(subType) : ''}
            <span class="type-badge bloodline-badge ${(() => {
              const bl = detailBloodline[m.id] || '';
              if (!bl) return m.main_type ? `type-${m.main_type.name}` : '';
              if (bl === 'Leader') return '';
              return `type-${bl}`;
            })()}" id="bloodline-btn" title="点击选择血脉属性">${(() => {
              const bl = detailBloodline[m.id] || '';
              if (!bl) {
                const firstType = m.main_type ? m.main_type.name : '';
                return firstType
                  ? `<img src="assets/icons/type/${firstType.toLowerCase()}.png" class="type-badge-icon" alt="默认血脉">默认血脉`
                  : '<span class="bloodline-empty">默认血脉</span>';
              }
              if (bl === 'Leader') return `<img src="assets/icons/magic-items/进化之力.png" class="type-badge-icon" alt="首领血脉">首领血脉`;
              const zhName = RKData.getTypeShortZh(bl) || bl;
              return `<img src="assets/icons/type/${bl.toLowerCase()}.png" class="type-badge-icon" alt="${zhName}血脉">${zhName}血脉`;
            })()}</span>
          </div>
        </div>
      </div>
      ${traitName ? (() => {
        const COLLAPSE_TRAIT_IDS = [129, 469];
        const isCollapse = COLLAPSE_TRAIT_IDS.includes(m.id);
        let traitSummary = '';
        let traitDetail = '';
        if (isCollapse && traitDesc) {
          const parts = traitDesc.split('\n');
          traitSummary = parts[0] || '';
          traitDetail = parts.slice(1).join('\n');
        } else {
          traitDetail = traitDesc;
        }
        return `
      <div class="detail-trait ${isCollapse ? 'collapsed' : ''}">
        <div class="detail-trait-head">
          ${RKData.traitIconHtml(traitName, { className: 'detail-trait-icon' })}
          <span><span class="detail-trait-name">${traitName}${traitSummary ? ':' : ''}</span>${traitSummary ? ` <span class="detail-trait-summary">${traitSummary}</span>` : ''}</span>
        </div>
        ${traitDetail ? `<div class="detail-trait-extra">${traitDetail.replace(/\n/g, '<br>')}</div>` : ''}
      </div>`;
      })() : ''}
      <div class="detail-attr-panel">
        <div class="detail-attr-header">
          ${CommonUI.StatBox.buildModeRadio('detail')}
        </div>
        <div class="final-stats-grid">
          ${CommonUI.StatBox.buildHTML('detail', DETAIL_STATS)}
        </div>
      </div>
      <div class="detail-skill-section">
        <div class="detail-skill-slots" id="detail-skill-slots">
          ${renderSkillSlots(m.id)}
        </div>
      </div>
    `;

    // 刷新属性值
    const detailRoot = body;
    const detailMode = detailStatMode;
    CommonUI.StatBox.refreshValues(detailRoot, displayM, detailNature, detailIV, detailMode);
    // 同步单选按钮状态
    const detailRadio = document.querySelector(`input[name="detailStatMode"][value="${detailMode}"]`);
    if (detailRadio) detailRadio.checked = true;

    bindDetailAttrEvents();
    bindSkillSlotEvents();
    bindBloodlineEvent();
    bindLeaderFormSelect();
    bindPetImgClick();
    refreshTeamCard();
  }

  // 5d: 首领形态下拉菜单（自定义 dropdown）
  function bindLeaderFormSelect() {
    const trigger = document.getElementById('leader-form-trigger');
    if (!trigger) return;

    trigger.addEventListener('click', function(e) {
      e.stopPropagation();

      // 关闭已存在的下拉
      const existing = document.getElementById('leader-form-dropdown');
      if (existing) { existing.remove(); return; }

      const petId = selectedDetailId;
      const m = RKData.getMonsterById(petId);
      if (!m) return;
      const allMonsters = RKData.getMonsters();
      const leaderForms = allMonsters.filter(mm => mm.dex_number === m.dex_number && mm.is_leader_form).sort((a, b) => a.id - b.id);
      const lfId = leaderFormId[petId] || null;

      const dropdown = document.createElement('div');
      dropdown.id = 'leader-form-dropdown';
      dropdown.className = 'leader-form-dropdown';

      // 普通形态选项（使用基础精灵头像）
      const baseImg = m.image ? `assets/monster/images/${m.image}` : '';
      let html = `<div class="leader-form-dropdown-item ${!lfId ? 'active' : ''}" data-lf-id="">
        ${baseImg ? `<img src="${baseImg}" class="leader-form-dropdown-icon" alt="普通形态">` : '<div class="leader-form-dropdown-placeholder">?</div>'}
        <span>普通形态</span>
      </div>`;
      // 各首领形态
      html += leaderForms.map(lf => {
        const lfName = RKData.getMonsterDisplayName(lf);
        const lfImg = lf.image ? `assets/monster/images/${lf.image}` : '';
        return `<div class="leader-form-dropdown-item ${lfId === lf.id ? 'active' : ''}" data-lf-id="${lf.id}">
          ${lfImg ? `<img src="${lfImg}" class="leader-form-dropdown-icon" alt="${lfName}">` : '<div class="leader-form-dropdown-placeholder">?</div>'}
          <span>${lfName}</span>
        </div>`;
      }).join('');
      dropdown.innerHTML = html;

      // 定位到 trigger 下方
  const rect = trigger.getBoundingClientRect();
  const _z = (window.__getPageZoom && window.__getPageZoom()) || 1;
  dropdown.style.position = 'fixed';
  dropdown.style.top = ((rect.bottom + 4) / _z) + 'px';
  dropdown.style.left = (Math.max(8, rect.left) / _z) + 'px';

      document.body.appendChild(dropdown);

      dropdown.querySelectorAll('.leader-form-dropdown-item').forEach(el => {
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          const val = this.dataset.lfId;
          if (val) {
            leaderFormId[petId] = parseInt(val);
          } else {
            leaderFormId[petId] = null;
          }
          dropdown.remove();
          renderDetail();
          saveConfig();
        });
      });

      // 点击外部关闭
      setTimeout(() => {
        const closeHandler = (e) => {
          if (!dropdown.contains(e.target) && !trigger.contains(e.target)) {
            dropdown.remove();
            document.removeEventListener('click', closeHandler);
          }
        };
        document.addEventListener('click', closeHandler);
      }, 0);
    });
  }

  // 5i: 点击头像弹出技能选择界面
  function bindPetImgClick() {
    const img = document.getElementById('detail-pet-img-clickable');
    if (!img) return;
    img.addEventListener('click', function() {
      openSkillPicker(0);
    });
  }

  function bindBloodlineEvent() {
    const btn = document.getElementById('bloodline-btn');
    if (!btn) return;
    btn.addEventListener('click', function() {
      openBloodlinePicker();
    });
  }

  // 切换血脉时不删除已装备的血脉技能，技能选择弹窗中会自动变灰禁用
  function clearBloodlineSkills(petId, newType) {
    // 不再删除，仅保留技能，禁用逻辑在技能选择弹窗中处理
  }

  function openBloodlinePicker() {
    // 关闭已存在的下拉
    const existing = document.getElementById('bloodline-dropdown');
    if (existing) { existing.remove(); return; }

    const btn = document.getElementById('bloodline-btn');
    if (!btn) return;

    const petId = selectedDetailId;
    const current = detailBloodline[petId] || '';

    // 构建选项列表：第一行(空+首领)，后三行各6个属性
    // 空血脉使用精灵第一属性的图标，但value仍为空
    const m = RKData.getMonsterById(petId);
    const firstType = m && m.main_type ? m.main_type.name : '';
    const firstRow = [
      { name: '无', icon: firstType ? `assets/icons/type/${firstType.toLowerCase()}.png` : '', value: '' },
      { name: '首领', icon: 'assets/icons/magic-items/进化之力.png', value: 'Leader' }
    ];
    const typeItems = RKData.PILL_ORDER.map(t => {
      const zh = RKData.getTypeShortZh(t) || t;
      return { name: zh, icon: `assets/icons/type/${t.toLowerCase()}.png`, value: t };
    });

    const dropdown = document.createElement('div');
    dropdown.id = 'bloodline-dropdown';
    dropdown.className = 'bloodline-hdropdown';

    const renderItem = (item, current) => {
      const isActive = item.value === current;
      const iconHtml = item.icon
        ? `<img src="${item.icon}" class="bloodline-hdropdown-icon" alt="${item.name}" loading="lazy">`
        : '<span class="bloodline-hdropdown-empty">空</span>';
      return `<div class="bloodline-hdropdown-item ${isActive ? 'active' : ''}" data-value="${item.value}" title="${item.name}">
        ${iconHtml}
      </div>`;
    };

    // 第一行：空 + 首领
    let html = '<div class="bloodline-hdropdown-row">';
    html += firstRow.map(it => renderItem(it, current)).join('');
    html += '</div>';
    // 后三行：每行6个属性
    for (let i = 0; i < typeItems.length; i += 6) {
      html += '<div class="bloodline-hdropdown-row">';
      html += typeItems.slice(i, i + 6).map(it => renderItem(it, current)).join('');
      html += '</div>';
    }
    dropdown.innerHTML = html;

    // 定位到按钮下方，水平排列
  const rect = btn.getBoundingClientRect();
  const _z = (window.__getPageZoom && window.__getPageZoom()) || 1;
  dropdown.style.position = 'fixed';
  dropdown.style.top = ((rect.bottom + 4) / _z) + 'px';
  dropdown.style.left = (Math.max(8, rect.left) / _z) + 'px';

    document.body.appendChild(dropdown);

    dropdown.querySelectorAll('.bloodline-hdropdown-item').forEach(el => {
      el.addEventListener('click', () => {
        const val = el.dataset.value;
        detailBloodline[petId] = val;
        // 切换血脉后，移除与新血脉不匹配的已装备血脉技能
        if (petSkills[petId]) {
          const m = RKData.getMonsterById(petId);
          const name = m ? RKData.getMonsterName(m) : '';
          const wikiData = RKData.getWikiData(name);
          const allSkills = (wikiData && wikiData.skills) ? wikiData.skills : [];
          petSkills[petId] = petSkills[petId].filter(skillName => {
            const sd = allSkills.find(s => s.name === skillName);
            if (!sd || sd.source !== '血脉') return true; // 非血脉技能保留
            // 首领血脉 / 无血脉 → 移除所有血脉技能
            if (!val || val === 'Leader') return false;
            // 具体属性 → 只保留匹配的
            return RKData.getTypeEn(sd.element) === val;
          });
        }
        dropdown.remove();
        renderDetail();
        saveConfig();
      });
    });

    // 点击外部关闭
    setTimeout(() => {
      const closeHandler = (e) => {
        if (!dropdown.contains(e.target) && !btn.contains(e.target)) {
          dropdown.remove();
          document.removeEventListener('click', closeHandler);
        }
      };
      document.addEventListener('click', closeHandler);
    }, 0);
  }

  function renderSkillSlots(petId) {
    const skills = petSkills[petId] || [];
    let html = '';
    for (let i = 0; i < 4; i++) {
      const skillName = skills[i];
      if (skillName) {
        html += `
           <div class="detail-skill-slot filled" data-slot="${i}" title="${skillName}" draggable="true">
            <img src="assets/monster/skill/${skillName}.png" alt="${skillName}" loading="lazy" onerror="this.src='assets/monster/skill/默认技能.png';this.onerror=null;">
            <span class="detail-skill-slot-name">${skillName}</span>
            <span class="detail-skill-slot-remove" data-slot="${i}">×</span>
          </div>
        `;
      } else {
        html += `<div class="detail-skill-slot" data-slot="${i}"><span class="detail-skill-slot-placeholder">+</span></div>`;
      }
    }
    return html;
  }

  function bindSkillSlotEvents() {
    const body = document.getElementById('team-detail-body');
    if (!body) return;

    let draggedSkillSlot = null;

    // 点击空槽或已填充槽位 → 打开技能选择弹窗
    body.querySelectorAll('.detail-skill-slot').forEach(slot => {
      slot.addEventListener('click', function(e) {
        if (e.target.classList.contains('detail-skill-slot-remove')) return;
        openSkillPicker(380);
      });
      // 右键点击 → 删除该格技能
      slot.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        const slotIdx = parseInt(this.dataset.slot);
        const petId = selectedDetailId;
        if (!petSkills[petId]) return;
        petSkills[petId][slotIdx] = null;
        renderDetail();
        saveConfig();
      });

      // 拖拽排序
      slot.addEventListener('dragstart', function(e) {
        if (!this.classList.contains('filled')) { e.preventDefault(); return; }
        draggedSkillSlot = parseInt(this.dataset.slot);
        this.style.opacity = '0.5';
        e.dataTransfer.effectAllowed = 'move';
      });
      slot.addEventListener('dragend', function() {
        this.style.opacity = '';
      });
      slot.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      });
      slot.addEventListener('drop', function(e) {
        e.preventDefault();
        if (draggedSkillSlot === null) return;
        const targetSlot = parseInt(this.dataset.slot);
        if (draggedSkillSlot === targetSlot) return;
        const petId = selectedDetailId;
        if (!petSkills[petId]) petSkills[petId] = [];
        const temp = petSkills[petId][draggedSkillSlot];
        petSkills[petId][draggedSkillSlot] = petSkills[petId][targetSlot];
        petSkills[petId][targetSlot] = temp;
        draggedSkillSlot = null;
        renderDetail();
        saveConfig();
      });
    });

    // 移除已装备技能
    body.querySelectorAll('.detail-skill-slot-remove').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const slotIdx = parseInt(this.dataset.slot);
        const petId = selectedDetailId;
        if (!petSkills[petId]) return;
        petSkills[petId][slotIdx] = null;
        renderDetail();
        saveConfig();
      });
    });

  }

  // 种族值条颜色
  const STAT_COLORS = {
    '生命': '#ef4444', '物攻': '#f97316', '魔攻': '#a855f7',
    '物防': '#3b82f6', '魔防': '#6366f1', '速度': '#eab308'
  };

  function getDefensiveMatchups(mainType, subType) {
    const allTypes = RKData.getTypes();
    const types = [mainType, subType].filter(Boolean)
      .map(n => allTypes.find(x => x.name === n))
      .filter(Boolean);
    if (types.length === 0) return { weak2: [], weak3: [], resist05: [], resist025: [] };
    const multipliers = {};
    types.forEach(t => {
      (t.vulnerable_to || []).forEach(v => { multipliers[v] = (multipliers[v] || 1) * 2; });
      (t.resistant_to || []).forEach(r => { multipliers[r] = (multipliers[r] || 1) * 0.5; });
    });
    const weak2 = [], weak3 = [], resist05 = [], resist025 = [];
    for (const [atk, mult] of Object.entries(multipliers)) {
      if (mult >= 3) weak3.push(atk);
      else if (mult >= 2) weak2.push(atk);
      else if (mult <= 0.25) resist025.push(atk);
      else if (mult <= 0.5) resist05.push(atk);
    }
    return { weak2, weak3, resist05, resist025 };
  }

  function defTypeIconHtml(typeName) {
    const zh = RKData.getTypeShortZh(typeName) || RKData.getTypeZh(typeName) || typeName;
    const icon = `assets/icons/type/${typeName.toLowerCase()}.png`;
    return `<span class="def-type-item"><img src="${icon}" class="def-type-icon" alt="${zh}">${zh}</span>`;
  }

  function openSkillPicker(scrollTopVal) {
    const m = RKData.getMonsterById(selectedDetailId);
    if (!m) return;
    const name = RKData.getMonsterDisplayName(m);
    const mainType = m.main_type ? m.main_type.name : '';
    const subType = m.sub_type ? m.sub_type.name : '';
    const wikiData = RKData.getWikiData(name);
    const skills = (wikiData && wikiData.skills) ? wikiData.skills : [];

    if (skills.length === 0) {
      CommonUI.showAlert('该精灵暂无技能数据');
      return;
    }

    const imgUrl = (wikiData && wikiData.image) ? wikiData.image : (m.image ? `assets/monster/images/${m.image}` : '');
    const total = RKData.getTotalStats(m);
    const effective = RKData.getEffectiveStats(m);
    const allMonsters = RKData.getMonsters();
    const totalRank = allMonsters
      .map(mm => ({ id: mm.id, t: RKData.getTotalStats(mm) }))
      .sort((a, b) => b.t - a.t)
      .findIndex(mm => mm.id === m.id) + 1;
    const effectiveRank = allMonsters
      .map(mm => ({ id: mm.id, e: RKData.getEffectiveStats(mm) }))
      .sort((a, b) => b.e - a.e)
      .findIndex(mm => mm.id === m.id) + 1;

    const { name: traitName, desc: traitDesc } = RKData.getTraitInfo(m);

    // 种族值条
    const statList = [
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
    const statBarsHtml = statList.map(s => {
      const pct = Math.min(100, (s.value / maxStat) * 100);
      const icon = STAT_ICON_MAP[s.label] || '';
      return `
        <div class="detail-stat-bar">
          <div class="detail-stat-left">
            ${icon ? `<img src="${icon}" class="detail-stat-icon" alt="${s.label}">` : ''}
            <span class="detail-stat-label">${s.label}</span>
          </div>
          <div class="detail-stat-track"><div class="detail-stat-fill" style="width:${pct}%;background:${s.color};"></div></div>
          <span class="detail-stat-val">${s.value}</span>
        </div>`;
    }).join('');

    // 防守属性克制
    const matchups = getDefensiveMatchups(mainType, subType);
    const weak2Html = matchups.weak2.length ? matchups.weak2.map(t => defTypeIconHtml(t)).join('') : '';
    const weak3Html = matchups.weak3.length ? matchups.weak3.map(t => defTypeIconHtml(t)).join('') : '';
    const resist05Html = matchups.resist05.length ? matchups.resist05.map(t => defTypeIconHtml(t)).join('') : '';
    const resist025Html = matchups.resist025.length ? matchups.resist025.map(t => defTypeIconHtml(t)).join('') : '';

    // 构建 技能名→能耗 映射
    const allMoves = RKData.getMoves();
    const moveEnergyMap = {};
    allMoves.forEach(mv => {
      if (mv.localized && mv.localized.zh && mv.localized.zh.name) {
        moveEnergyMap[mv.localized.zh.name] = mv.energy_cost;
      }
    });

    const sourceOrder = ['默认', '血脉', '技能石', '传说'];
    const skillsBySource = {};
    sourceOrder.forEach(s => { skillsBySource[s] = []; });

    // 根据血脉属性判断血脉技能是否可用（不可用的变灰而非删除）
    function getBloodlineType() { return detailBloodline[m.id] || ''; }

    function isBloodlineSkillDisabled(s) {
      if (s.source !== '血脉') return false;
      const blType = getBloodlineType();
      if (blType === 'Leader') return true;   // 首领血脉：血脉技能全部灰
      if (!blType) return false;                // 无血脉：血脉技能全部可选
      // 选了具体属性：不匹配的血脉技能灰
      return RKData.getTypeEn(s.element) !== blType;
    }

    skills.forEach(s => {
      if (!skillsBySource[s.source]) skillsBySource[s.source] = [];
      skillsBySource[s.source].push(s);
    });

    const equippedSkills = (petSkills[m.id] || []).filter(s => s);

    const TYPE_ICON_MAP = {
      '物攻': 'physical-attack',
      '魔攻': 'magic-attack',
      '防御': 'defense',
      '状态': 'status',
      '条件攻击': 'conditional-attack',
      '能量': 'energy'
    };

    const skillsHtml = CommonUI.SkillPicker.renderSkillList(skills, allMoves, {
      equippedSkills: equippedSkills,
      disabledSkills: isBloodlineSkillDisabled
    });

    const filterBarHtml = CommonUI.SkillPicker.renderFilterBar(skills);

    // 创建弹窗 — 复用图鉴详情页布局
    let modal = document.getElementById('team-skill-picker-modal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'team-skill-picker-modal';
    modal.className = 'team-skill-picker-modal';
    modal.innerHTML = `
      <div class="team-skill-picker-overlay"></div>
      <div class="team-skill-picker-content">
        <div class="team-skill-picker-header">
          <h3>选择技能 — ${name}</h3>
          <button class="team-skill-picker-close" id="team-skill-picker-close">×</button>
        </div>
        <div class="team-skill-picker-tips">点击技能装备/卸载（最多4个），已装备的技能会高亮显示</div>
        <div class="team-skill-picker-body hide-scrollbar">
          <div class="detail-layout">
            <div class="detail-col-1">
              <div class="detail-name">${name}</div>
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
                  <span class="detail-stats-total">${effective}<span class="detail-stats-rank">#${effectiveRank}/${allMonsters.length}</span></span>
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
          <div class="detail-skills-fullwidth">
            ${filterBarHtml}
            ${skillsHtml}
          </div>
        </div>
        <div class="team-skill-picker-footer">
          <button class="btn btn-primary btn-sm" id="team-skill-picker-done">完成</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.style.display = 'flex';
    modal.querySelector('.team-skill-picker-body').scrollTop = (scrollTopVal != null ? scrollTopVal : 0);

    // 初始化技能禁用状态（已有4个技能时，未选中的全部变灰）
    {
      const petId = selectedDetailId;
      const equipped = (petSkills[petId] || []).filter(s => s);
      const hasBloodlineEquipped = equipped.some(n => {
        const it = modal.querySelector(`.detail-skill-item[data-skill-name="${n}"]`);
        return it && it.dataset.skillSource === '血脉';
      });
      modal.querySelectorAll('.detail-skill-item').forEach(it => {
        it.classList.toggle('skill-equipped', equipped.includes(it.dataset.skillName));
        const isEquipped = equipped.includes(it.dataset.skillName);
        let disabled = false;
        if (it.dataset.skillSource === '血脉' && isBloodlineSkillDisabled({ source: '血脉', element: it.dataset.skillElem })) {
          disabled = true;
        }
        if (it.dataset.skillSource === '血脉' && !isEquipped && hasBloodlineEquipped && !disabled) {
          disabled = true;
        }
        if (!isEquipped && equipped.length >= 4) {
          disabled = true;
        }
        it.classList.toggle('skill-disabled', disabled);
      });
    }

    // 关闭
    const closeModal = () => { modal.remove(); renderDetail(); saveConfig(); };
    modal.querySelector('.team-skill-picker-overlay').addEventListener('click', closeModal);
    modal.querySelector('.team-skill-picker-overlay').addEventListener('contextmenu', e => { e.preventDefault(); closeModal(); });
    modal.querySelector('#team-skill-picker-close').addEventListener('click', closeModal);
    modal.querySelector('#team-skill-picker-done').addEventListener('click', closeModal);

    // 筛选 — 使用 SkillPicker 公共模块（多选并集）
    CommonUI.SkillPicker.bindFilterEvents(modal);

    // 右键空白区域 → 关闭模态框
    modal.querySelector('.team-skill-picker-content').addEventListener('contextmenu', function(e) {
      // 只在点击的不是技能项时关闭（技能项有自己的右键处理）
      if (!e.target.closest('.detail-skill-item')) {
        e.preventDefault();
        closeModal();
      }
    });

    // 点击技能装备/卸载
    modal.querySelectorAll('.detail-skill-item').forEach(item => {
      item.addEventListener('click', function() {
        if (this.classList.contains('skill-disabled')) return;
        const skillName = this.dataset.skillName;
        const skillSource = this.dataset.skillSource;
        const petId = selectedDetailId;
        if (!petSkills[petId]) petSkills[petId] = [];
        const idx = petSkills[petId].indexOf(skillName);
        if (idx >= 0) {
          petSkills[petId][idx] = null;
        } else {
          const filledCount = petSkills[petId].filter(s => s).length;
          if (filledCount >= 4) {
            CommonUI.showAlert('最多只能携带4个技能');
            return;
          }
          // 血脉技能只能选一个：选中新血脉技能时移除已选的血脉技能
          if (skillSource === '血脉') {
            petSkills[petId].forEach((n, i) => {
              if (!n) return;
              const item = modal.querySelector(`.detail-skill-item[data-skill-name="${n}"]`);
              if (item && item.dataset.skillSource === '血脉') {
                petSkills[petId][i] = null;
              }
            });
            // 自动设置对应血脉属性
            const skillItem = modal.querySelector(`.detail-skill-item[data-skill-name="${skillName}"]`);
            if (skillItem) {
              const elem = skillItem.dataset.skillElem;
              const elemEn = RKData.getTypeEn(elem);
              if (elemEn) detailBloodline[petId] = elemEn;
            }
          }
          const emptyIdx = petSkills[petId].findIndex(s => !s);
          if (emptyIdx >= 0) {
            petSkills[petId][emptyIdx] = skillName;
          } else {
            petSkills[petId].push(skillName);
          }
        }
        const equippedRaw = petSkills[petId] || [];
        const equipped = equippedRaw.filter(s => s);
        // 判断是否已有血脉技能被选中
        const hasBloodlineEquipped = equipped.some(n => {
          const it = modal.querySelector(`.detail-skill-item[data-skill-name="${n}"]`);
          return it && it.dataset.skillSource === '血脉';
        });
        modal.querySelectorAll('.detail-skill-item').forEach(it => {
          it.classList.toggle('skill-equipped', equipped.includes(it.dataset.skillName));
          const isEquipped = equipped.includes(it.dataset.skillName);
          let disabled = false;
          // 血脉属性不匹配的血脉技能始终灰
          if (it.dataset.skillSource === '血脉' && isBloodlineSkillDisabled({ source: '血脉', element: it.dataset.skillElem })) {
            disabled = true;
          }
          // 血脉技能：已有血脉技能被选中时，其余未选中的血脉技能变灰
          if (it.dataset.skillSource === '血脉' && !isEquipped && hasBloodlineEquipped && !disabled) {
            disabled = true;
          }
          // 已选满4个技能时，其余未选中的技能全部变灰
          if (!isEquipped && equipped.length >= 4) {
            disabled = true;
          }
          it.classList.toggle('skill-disabled', disabled);
        });
      });
      // 右键：血脉技能 → 清除血脉限制；非血脉技能/空白处 → 关闭模态框
      item.addEventListener('contextmenu', function(e) {
        if (this.dataset.skillSource !== '血脉') {
          e.preventDefault();
          closeModal();
          return;
        }
        e.preventDefault();
        const petId = selectedDetailId;
        // 清除血脉属性，解除所有血脉技能的限制
        detailBloodline[petId] = '';
        // 移除已装备的血脉技能
        if (petSkills[petId]) {
          petSkills[petId].forEach((n, i) => {
            if (!n) return;
            const it = modal.querySelector(`.detail-skill-item[data-skill-name="${n}"]`);
            if (it && it.dataset.skillSource === '血脉') petSkills[petId][i] = null;
          });
        }
        // 更新技能槽位显示
        const slotsEl = document.getElementById('detail-skill-slots');
        if (slotsEl) slotsEl.innerHTML = renderSkillSlots(petId);
        // 重新计算禁用状态
        const equipped = (petSkills[petId] || []).filter(s => s);
        modal.querySelectorAll('.detail-skill-item').forEach(it => {
          it.classList.toggle('skill-equipped', equipped.includes(it.dataset.skillName));
          const isEquipped = equipped.includes(it.dataset.skillName);
          let disabled = false;
          if (!isEquipped && equipped.length >= 4) {
            disabled = true;
          }
          it.classList.toggle('skill-disabled', disabled);
        });
      });
    });
  }

  function bindDetailAttrEvents() {
    const body = document.getElementById('team-detail-body');
    if (!body) return;

    // 属性值/种族值切换
    body.querySelectorAll('input[name="detailStatMode"]').forEach(radio => {
      radio.addEventListener('change', function() {
        detailStatMode = this.value;
        const m = RKData.getMonsterById(selectedDetailId);
        if (!m) return;
        const bl = detailBloodline[m.id] || '';
        const lfId = leaderFormId[m.id] || null;
        let displayM = m;
        if (bl === 'Leader' && lfId) {
          const lf = RKData.getMonsterById(lfId);
          if (lf) displayM = lf;
        }
        const detailNature = petNatures[m.id] || {};
        const detailIV = petIVs[m.id] || {};
        CommonUI.StatBox.refreshValues(body, displayM, detailNature, detailIV, detailStatMode);
      });
    });

    // 性格按钮：左击+，右击-（最多各一个）
    body.querySelectorAll('.nature-btn').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        const stat = this.dataset.stat;
        if (!petNatures[selectedDetailId]) petNatures[selectedDetailId] = {};
        const n = petNatures[selectedDetailId];
        const cur = n[stat] || 0;
        if (cur === 1) {
          n[stat] = 0;
        } else {
          DETAIL_STATS.forEach(s => { if (n[s] === 1) n[s] = 0; });
          n[stat] = 1;
        }
        renderDetail();
        saveConfig();
      });
      btn.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        const stat = this.dataset.stat;
        if (!petNatures[selectedDetailId]) petNatures[selectedDetailId] = {};
        const n = petNatures[selectedDetailId];
        const cur = n[stat] || 0;
        if (cur === 2) {
          n[stat] = 0;
        } else {
          DETAIL_STATS.forEach(s => { if (n[s] === 2) n[s] = 0; });
          n[stat] = 2;
        }
        renderDetail();
        saveConfig();
      });
    });

    // 个体按钮（最多3个，超出时移除最早的）
    body.querySelectorAll('.iv-btn').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        const stat = this.dataset.stat;
        if (!petIVs[selectedDetailId]) petIVs[selectedDetailId] = { _order: [] };
        const iv = petIVs[selectedDetailId];
        if (!iv._order) iv._order = [];
        if (iv[stat]) {
          iv[stat] = false;
          iv._order = iv._order.filter(s => s !== stat);
        } else {
          if (iv._order.length >= 3) {
            const oldest = iv._order.shift();
            iv[oldest] = false;
          }
          iv[stat] = true;
          iv._order.push(stat);
        }
        renderDetail();
        saveConfig();
      });
    });

    // 特性折叠/展开
    body.querySelectorAll('.detail-trait').forEach(el => {
      el.addEventListener('click', function() {
        this.classList.toggle('collapsed');
      });
    });
  }

  function bindEvents() {
    // 属性 pill 右键：强制取消选中
    document.getElementById('team-type-pills').addEventListener('contextmenu', e => {
      const pill = e.target.closest('.type-pill');
      if (!pill) return;
      e.preventDefault();
      const type = pill.dataset.type;
      if (activeTypes.has(type)) {
        activeTypes.delete(type);
        renderTypePills();
        renderCandidateList();
      }
    });

    // 队伍槽位：左键查看详情，右键移除
    document.getElementById('team-slots').addEventListener('click', e => {
      const slot = e.target.closest('.team-slot.filled');
      if (slot) {
        const petId = parseInt(slot.dataset.petId);
        selectedDetailId = petId;
        renderDetail();
      }
    });
    document.getElementById('team-slots').addEventListener('contextmenu', e => {
      const slot = e.target.closest('.team-slot.filled');
      if (slot) {
        e.preventDefault();
        const petId = parseInt(slot.dataset.petId);
        togglePet(petId);
      }
    });

    // 魔法槽位点击 → 打开魔法选择弹窗
    document.getElementById('team-magic').addEventListener('click', e => {
      const magicSlot = e.target.closest('.team-magic-slot');
      if (!magicSlot) return;
      openMagicPicker(0);
    });

    // 重置/恢复按钮：配队重置（仅重置配队，保留筛选）
    document.getElementById('team-reset-btn').addEventListener('click', onResetClick);

    // 精灵头像拖拽（6格内交换/填充空白）
    bindTeamSlotDrag();
  }

  function bindTeamSlotDrag() {
    const slotsEl = document.getElementById('team-slots');
    if (!slotsEl) return;
    let draggedSlot = null;

    slotsEl.querySelectorAll('.team-slot').forEach(slot => {
      slot.addEventListener('dragstart', function(e) {
        if (!this.classList.contains('filled')) { e.preventDefault(); return; }
        draggedSlot = parseInt(this.dataset.slot);
        this.style.opacity = '0.5';
        e.dataTransfer.effectAllowed = 'move';
      });
      slot.addEventListener('dragend', function() {
        this.style.opacity = '';
      });
      slot.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this.classList.add('drag-over');
      });
      slot.addEventListener('dragleave', function() {
        this.classList.remove('drag-over');
      });
      slot.addEventListener('drop', function(e) {
        e.preventDefault();
        this.classList.remove('drag-over');
        if (draggedSlot === null) return;
        const targetSlot = parseInt(this.dataset.slot);
        if (draggedSlot === targetSlot) return;
        // 交换
        const temp = team[draggedSlot];
        team[draggedSlot] = team[targetSlot];
        team[targetSlot] = temp;
        draggedSlot = null;
        saveConfig();
        // 重新渲染槽位
        document.getElementById('team-slots').innerHTML = renderSlots();
        bindTeamSlotDrag();
        renderCandidateList();
        refreshTeamCard();
        updateRestoreBtn();
      });
    });
  }

  let resetRotateDeg = 0;
  function applyResetIconRotation() {
    const btn = document.getElementById('team-reset-btn');
    if (btn) {
      const icon = btn.querySelector('.reset-btn-icon');
      if (icon) {
        const prevDeg = resetRotateDeg - 180;
        // 先无动画设到上一次的角度
        icon.style.transition = 'none';
        icon.style.transform = `rotate(${prevDeg}deg)`;
        void icon.offsetWidth; // 强制 reflow
        // 再动画到新角度，只转180度增量
        icon.style.transition = 'transform 0.4s ease';
        icon.style.transform = `rotate(${resetRotateDeg}deg)`;
      }
    }
  }
  function onResetClick() {
    resetRotateDeg += 180;
    if (teamSnapshot) {
      restoreTeam();
    } else {
      resetTeam();
    }
    applyResetIconRotation();
  }

  function togglePet(id) {
    const idx = team.indexOf(id);
    if (idx >= 0) {
      team[idx] = null;
    } else {
      const emptyIdx = team.findIndex(s => s === null || s === undefined);
      if (emptyIdx >= 0) {
        team[emptyIdx] = id;
        // 添加新精灵时清除快照，按钮恢复为"重置"
        teamSnapshot = null;
      } else if (team.length < 6) {
        team.push(id);
        teamSnapshot = null;
      }
    }
    saveConfig();
    const container = document.getElementById('page-container');
    render(container);
  }

  // 配队快照
  let teamSnapshot = null;

  function resetTeam() {
    // 保存快照以供恢复（仅配队相关，不保存精灵配置）
    teamSnapshot = {
      team: [...team],
      teamMagic: teamMagic,
      selectedDetailId: selectedDetailId
    };
    // 仅重置配队选择，保留精灵配置和当前详情选择
    team = [null, null, null, null, null, null];
    teamMagic = '';
    saveConfig();
    const container = document.getElementById('page-container');
    render(container);
    updateRestoreBtn();
  }

  function restoreTeam() {
    if (!teamSnapshot) return;
    team = [...teamSnapshot.team];
    teamMagic = teamSnapshot.teamMagic;
    selectedDetailId = teamSnapshot.selectedDetailId;
    // 精灵配置未被重置过，无需恢复
    teamSnapshot = null;
    saveConfig();
    const container = document.getElementById('page-container');
    render(container);
    updateRestoreBtn();
  }

  function resetFilter() {
    // 仅重置筛选，不影响配队
    searchKeyword = '';
    activeTypes = new Set();
    const searchInput = document.getElementById('team-search');
    if (searchInput) searchInput.value = '';
    renderTypePills();
    renderCandidateList();
  }

  function updateRestoreBtn() {
    const btn = document.getElementById('team-reset-btn');
    if (!btn) return;
    if (teamSnapshot) {
      btn.innerHTML = '<img src="assets/icons/ui/icon_reset.png" alt="恢复" class="reset-btn-icon">';
      btn.classList.add('restore-mode');
      btn.title = '恢复上次重置前的配队';
    } else {
      btn.innerHTML = '<img src="assets/icons/ui/icon_reset.png" alt="重置" class="reset-btn-icon">';
      btn.classList.remove('restore-mode');
      btn.title = '清空所有已选精灵';
    }
  }

  function renderTeamCard() {
    let cards = '';
    for (let slot = 0; slot < 6; slot++) {
      const petId = team[slot];
      const p = petId ? RKData.getMonsterById(petId) : null;
      if (!p) {
        const emptySkillHtml = Array.from({length: 4}, () => `<div class="tc-skill empty"><span class="tc-skill-placeholder">+</span></div>`).join('');
        cards += `
          <div class="tc-card tc-card-empty">
            <div class="tc-pet-img-wrap">
              <img src="assets/icons/move-sub/energy.png" class="tc-pet-img" alt="空位" loading="lazy" style="width:30px;height:30px;">
            </div>
            <div class="tc-card-right">
              <div class="tc-card-info">
                <div class="tc-name-row">
                  <span class="tc-name tc-name-empty">暂未放置精灵</span>
                </div>
                <div class="tc-nature-row">
                  <span class="tc-info-box">性格</span>
                  <span class="tc-info-box">—</span>
                </div>
                <div class="tc-nature-row">
                  <span class="tc-info-box">个体</span>
                  <span class="tc-info-box">—</span>
                </div>
              </div>
              <div class="tc-skills tc-skills-empty">${emptySkillHtml}</div>
            </div>
          </div>
        `;
        continue;
      }
      const idx = slot;
      const bl = detailBloodline[p.id] || '';
      const lfId = leaderFormId[p.id] || null;
      let displayName = RKData.getMonsterDisplayName(p);
      // 5e: 首领血脉且有首领形态选中时，显示首领形态名称
      if (bl === 'Leader' && lfId) {
        const lf = RKData.getMonsterById(lfId);
        if (lf) displayName = RKData.getMonsterDisplayName(lf);
      }
      const name = displayName;
      const mainType = p.main_type ? p.main_type.name : '';
      const subType = p.sub_type ? p.sub_type.name : '';
      const wikiData = RKData.getWikiData(name);
      let imgUrl = (wikiData && wikiData.image) ? wikiData.image : (p.image ? `assets/monster/images/${p.image}` : '');
      // 首领血脉：仅当用户选了具体首领形态时替换图片
      if (bl === 'Leader' && lfId) {
        const lf = RKData.getMonsterById(lfId);
        if (lf) {
          const lfName = RKData.getMonsterName(lf);
          const lfWiki = RKData.getWikiData(lfName);
          if (lfWiki && lfWiki.image) imgUrl = lfWiki.image;
        }
      }
      // 性格（任选其一时也显示）
      const pNature = petNatures[p.id] || {};
      const natureUp = [];
      const natureDown = [];
      DETAIL_STATS.forEach(s => {
        const nv = pNature[s] || 0;
        if (nv === 1) natureUp.push(`${DETAIL_STAT_LABELS[s]}↑`);
        if (nv === 2) natureDown.push(`${DETAIL_STAT_LABELS[s]}↓`);
      });
      const natureStr = [...natureUp, ...natureDown].join(' ') || '—';
      // 个体
      const pIV = petIVs[p.id] || {};
      const ivParts = [];
      DETAIL_STATS.forEach(s => {
        if (pIV[s]) ivParts.push(DETAIL_STAT_LABELS[s]);
      });
      const ivStr = ivParts.length ? ivParts.join(' ') : '—';
      // 技能
      const skills = petSkills[p.id] || [];
      const hasAnySkill = skills.some(s => s);
      const skillHtml = Array.from({length: 4}, (_, i) => {
        const sn = skills[i];
        if (sn) {
          return `<div class="tc-skill" title="${sn}">
            <img src="assets/monster/skill/${sn}.png" alt="${sn}" loading="lazy" onerror="this.src='assets/monster/skill/默认技能.png';this.onerror=null;">
            <span class="tc-skill-name">${sn}</span>
          </div>`;
        }
        return `<div class="tc-skill empty"><span class="tc-skill-placeholder">+</span></div>`;
      }).join('');
      // 属性图标
      const typeBadges = [mainType, subType].filter(Boolean).map(t => RKData.typeBadgeHtml(t)).join('');
      // 血脉
      let blHtml = '';
      if (bl === 'Leader') {
        blHtml = `<span class="tc-bl-badge"><img src="assets/icons/magic-items/进化之力.png" class="type-badge-icon" alt="首领血脉">首领血脉</span>`;
      } else if (bl) {
        const zh = RKData.getTypeShortZh(bl) || bl;
        blHtml = `<span class="tc-bl-badge type-${bl}"><img src="assets/icons/type/${bl.toLowerCase()}.png" class="type-badge-icon" alt="${zh}血脉">${zh}血脉</span>`;
      } else {
        const firstType = mainType || '';
        blHtml = firstType
          ? `<span class="tc-bl-badge type-${firstType}"><img src="assets/icons/type/${firstType.toLowerCase()}.png" class="type-badge-icon" alt="默认血脉">默认血脉</span>`
          : `<span class="tc-bl-badge">默认血脉</span>`;
      }

      cards += `
        <div class="tc-card">
          <div class="tc-pet-img-wrap">
            ${imgUrl ? `<img src="${imgUrl}" class="tc-pet-img" alt="${name}" loading="lazy">` : '<div class="tc-pet-img-placeholder">?</div>'}
          </div>
          <div class="tc-card-right">
              <div class="tc-card-info">
                <div class="tc-name-row">
                  <span class="tc-name">${name}</span>
                </div>
                <div class="tc-types">${typeBadges}${blHtml}</div>
              <div class="tc-nature-row">
                <span class="tc-info-box">性格</span>
                <span class="tc-info-box">${natureStr}</span>
              </div>
              <div class="tc-nature-row">
                <span class="tc-info-box">个体</span>
                <span class="tc-info-box">${ivStr}</span>
              </div>
            </div>
            <div class="tc-skills${hasAnySkill ? '' : ' tc-skills-empty'}">${skillHtml}</div>
          </div>
        </div>
      `;
    }

    // 队伍魔法
    const magicItem = MAGIC_ITEMS.find(m => m.name === teamMagic);
    const magicHtml = magicItem
      ? `<div class="tc-magic"><img src="${magicItem.icon}" alt="${magicItem.name}" loading="lazy"><span>${magicItem.name}</span></div>`
      : '';

    // 5h: 弱点汇总
    const weaknessHtml = renderTeamWeakness();
    // 抵抗汇总
    const resistanceHtml = renderTeamResistance();
    // 联防汇总
    const defenseHtml = renderTeamDefenseSummary();

    return `<div class="tc-grid">${cards}</div>${magicHtml}${weaknessHtml}${resistanceHtml}${defenseHtml}`;
  }

  // 5h: 计算队伍弱点汇总
  function renderTeamWeakness() {
    const { weaknesses } = calcTeamTypeSummary();
    const itemsHtml = RKData.PILL_ORDER.map(atk => {
      const count = weaknesses[atk] || 0;
      const zh = RKData.getTypeShortZh(atk) || RKData.getTypeZh(atk) || atk;
      const icon = `assets/icons/type/${atk.toLowerCase()}.png`;
      const cls = count === 0 ? 'weak-none' : (count >= 4 ? 'weak-3x' : 'weak-2x');
      return `<span class="team-weakness-item ${cls}"><img src="${icon}" class="team-weakness-icon" alt="${zh}">${zh} <span class="team-weakness-count">×${count}</span></span>`;
    }).join('');

    return `<div class="team-weakness-panel">
      <div class="team-weakness-title">队伍弱点汇总</div>
      <div class="team-weakness-grid">${itemsHtml}</div>
    </div>`;
  }

  // 抵抗汇总
  function renderTeamResistance() {
    const { resistances } = calcTeamTypeSummary();
    const itemsHtml = RKData.PILL_ORDER.map(atk => {
      const count = resistances[atk] || 0;
      const zh = RKData.getTypeShortZh(atk) || RKData.getTypeZh(atk) || atk;
      const icon = `assets/icons/type/${atk.toLowerCase()}.png`;
      const cls = count === 0 ? 'resist-none' : (count >= 4 ? 'resist-strong' : 'resist');
      return `<span class="team-resistance-item ${cls}"><img src="${icon}" class="team-resistance-icon" alt="${zh}">${zh} <span class="team-resistance-count">×${count}</span></span>`;
    }).join('');

    return `<div class="team-resistance-panel">
      <div class="team-resistance-title">队伍抵抗汇总</div>
      <div class="team-resistance-grid">${itemsHtml}</div>
    </div>`;
  }

  // 联防汇总：弱点数 - 抵抗数 = 净分
  function renderTeamDefenseSummary() {
    const { weaknesses, resistances } = calcTeamTypeSummary();
    const itemsHtml = RKData.PILL_ORDER.map(atk => {
      const weak = weaknesses[atk] || 0;
      const res = resistances[atk] || 0;
      const net = weak - res;
      const zh = RKData.getTypeShortZh(atk) || RKData.getTypeZh(atk) || atk;
      const icon = `assets/icons/type/${atk.toLowerCase()}.png`;
      let cls, sign;
      if (net > 0) { cls = 'weak'; sign = `+${net}`; }
      else if (net < 0) { cls = 'strong'; sign = `${net}`; }
      else { cls = 'neutral'; sign = '0'; }
      return `<span class="team-defense-item ${cls}"><img src="${icon}" class="team-defense-icon" alt="${zh}">${zh} <span class="team-defense-score">${sign}</span></span>`;
    }).join('');

    return `<div class="team-defense-panel">
      <div class="team-defense-title">队伍联防汇总</div>
      <div class="team-defense-grid">${itemsHtml}</div>
    </div>`;
  }

  // 统一计算队伍弱点和抵抗
  function calcTeamTypeSummary() {
    const allTypes = RKData.getTypes();
    const weaknesses = {};
    const resistances = {};

    team.forEach(petId => {
      if (!petId) return;
      const p = RKData.getMonsterById(petId);
      if (!p) return;
      const mainType = p.main_type ? p.main_type.name : '';
      const subType = p.sub_type ? p.sub_type.name : '';
      const defTypes = [mainType, subType].filter(Boolean)
        .map(n => allTypes.find(x => x.name === n))
        .filter(Boolean);
      if (defTypes.length === 0) return;

      const multipliers = {};
      defTypes.forEach(t => {
        (t.vulnerable_to || []).forEach(v => { multipliers[v] = (multipliers[v] || 1) * 2; });
        (t.resistant_to || []).forEach(r => { multipliers[r] = (multipliers[r] || 1) * 0.5; });
      });

      for (const [atk, mult] of Object.entries(multipliers)) {
        if (mult >= 2) {
          weaknesses[atk] = (weaknesses[atk] || 0) + 1;
        } else if (mult <= 0.5) {
          resistances[atk] = (resistances[atk] || 0) + 1;
        }
      }
    });

    return { weaknesses, resistances };
  }

  function refreshTeamCard() {
    const el = document.getElementById('team-card-preview');
    if (el) el.innerHTML = renderTeamCard();
  }

  function screenshot() {
    if (team.length === 0) { CommonUI.showAlert('队伍为空，请先选择精灵'); return; }
    // 生成文本摘要作为截图替代
    const pets = team.map(id => RKData.getMonsterById(id)).filter(Boolean);
    const lines = pets.map((p, i) => {
      const name = RKData.getMonsterDisplayName(p);
      const mainType = p.main_type ? RKData.getTypeZh(p.main_type.name) : '';
      const subType = p.sub_type ? RKData.getTypeZh(p.sub_type.name) : '';
      const types = [mainType, subType].filter(Boolean).join('/');
      return `${i+1}. ${name} [${types}] 速:${p.base_spd||0} HP:${p.base_hp||0}`;
    });
    const text = `=== 洛克王国队伍 ===\n${lines.join('\n')}\n=== ${new Date().toLocaleString()} ===`;
    // 复制到剪贴板
    navigator.clipboard.writeText(text).then(() => {
      CommonUI.showAlert('队伍信息已复制到剪贴板！\n\n' + text);
    }).catch(() => {
      CommonUI.showAlert(text);
    });
    // TODO: 可集成 html2canvas 实现真正的截图
  }

  return { render, togglePet };
})();
