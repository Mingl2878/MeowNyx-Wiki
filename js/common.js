/**
 * common.js — 公共组件模块
 * 提供跨页面复用的 UI 功能
 */

const CommonUI = (function () {
  const SVG_UP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const SVG_DOWN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>';

  // 手势触发阈值（像素）
  const GESTURE_THRESHOLD = 40;

  /**
   * 为可滚动容器绑定右键拖拽手势：
   *   右键按住向上拖 → 滚动到顶部
   *   右键按住向下拖 → 滚动到底部
   * @param {HTMLElement} container - 可滚动容器
   */
  function bindRightDragGesture(container) {
    let isRightDown = false;
    let startY = 0;

    container.addEventListener('mousedown', e => {
      if (e.button === 2) { // 右键
        isRightDown = true;
        startY = e.clientY;
      }
    });

    container.addEventListener('mousemove', e => {
      if (!isRightDown) return;
      const deltaY = e.clientY - startY;
      if (Math.abs(deltaY) >= GESTURE_THRESHOLD) {
        if (deltaY < 0) {
          // 向上拖 → 回到顶部
          container.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          // 向下拖 → 滑到底部
          container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        }
        isRightDown = false; // 触发一次后重置
      }
    });

    container.addEventListener('mouseup', e => {
      if (e.button === 2) isRightDown = false;
    });

    container.addEventListener('mouseleave', () => { isRightDown = false; });

    // 阻止容器内的右键菜单
    container.addEventListener('contextmenu', e => e.preventDefault());
  }

  /**
   * 为指定可滚动容器绑定"回到顶部"按钮
   * @param {string|HTMLElement} scrollContainer - 可滚动容器的选择器或 DOM 元素
   * @returns {HTMLElement|null}
   */
  function bindBackToTop(scrollContainer) {
    const container = typeof scrollContainer === 'string'
      ? document.querySelector(scrollContainer)
      : scrollContainer;
    if (!container) return null;

    // 查找或创建按钮
    let btn = container.querySelector('.back-to-top-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'back-to-top-btn';
      btn.title = '回到顶部';
      btn.innerHTML = SVG_UP;
      container.appendChild(btn);
    }

    // 滚动监听
    container.addEventListener('scroll', () => {
      if (container.scrollTop > 200) {
        btn.classList.add('show');
      } else {
        btn.classList.remove('show');
      }
    });

    // 点击回到顶部
    btn.addEventListener('click', () => {
      container.scrollTo({ top: 0, behavior: 'smooth' });
    });

    return container;
  }

  /**
   * 一次性绑定回到顶部 + 右键拖拽手势
   * @param {string|HTMLElement} scrollContainer - 可滚动容器的选择器或 DOM 元素
   * @returns {HTMLElement|null}
   */
  function bindScrollControls(scrollContainer) {
    const container = typeof scrollContainer === 'string'
      ? document.querySelector(scrollContainer)
      : scrollContainer;
    if (!container) return null;

    bindBackToTop(container);
    bindRightDragGesture(container);

    return container;
  }

  /**
   * 将一个元素包装在 relative 容器中（如果尚未包装）
   * @param {HTMLElement} el - 需要包装的元素
   * @returns {HTMLElement} 包装容器
   */
  function wrapRelative(el) {
    if (el.parentElement && el.parentElement.classList.contains('scroll-wrapper-container')) {
      return el.parentElement;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'scroll-wrapper-container';
    el.parentNode.insertBefore(wrapper, el);
    wrapper.appendChild(el);
    return wrapper;
  }

  /* ==================== 搜索框组件 ==================== */

  /**
   * 统一搜索框（带候选下拉框 + 左侧图标占位）
   * @param {Object} opts
   * @param {string} [opts.id] - input 的 id
   * @param {string} [opts.placeholder='搜索...']
   * @param {string|HTMLElement} [opts.attachTo] - 挂载到已有 input（选择器或 DOM 元素）
   * @param {function} [opts.search] - 自定义搜索函数，参数为关键词，返回 [{id,name,icon,extra?}]。不传则默认搜索精灵
   * @param {function} [opts.filter] - 精灵模式下的额外过滤函数
   * @param {function} [opts.renderItem] - 自定义候选项渲染 (item, name) => html
   * @param {function} [opts.onSelect] - 选中回调，参数为精灵对象或自定义候选项对象
   * @param {function} [opts.onInput] - 输入回调，参数为当前文本值
   * @param {number} [opts.limit=10] - 最多显示候选数
   * @param {boolean} [opts.showIcon=true] - 是否在搜索框左侧显示图标占位
   * @returns {{wrapper:?, input:HTMLInputElement, dropdown:HTMLDivElement, getValue:function, setValue:function}}
   */
  function createSearchBox(opts) {
    opts = opts || {};
    const placeholder = opts.placeholder || '搜索...';
    const limit = opts.limit || 10;
    const customSearch = opts.search || null;
    const extraFilter = opts.filter || (() => true);
    const customRenderItem = opts.renderItem || null;
    const showIcon = opts.showIcon !== false;

    let wrapper, input, dropdown, iconBox;

    /* ---- 构建 DOM ---- */
    if (opts.attachTo) {
      input = typeof opts.attachTo === 'string'
        ? document.querySelector(opts.attachTo)
        : opts.attachTo;
      if (!input) return null;
      input.className = 'search-bar';
      input.setAttribute('autocomplete', 'off');
      if (placeholder) input.placeholder = placeholder;

      const parent = input.parentNode;
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }
      wrapper = parent;

      if (showIcon) {
        iconBox = document.createElement('div');
        iconBox.className = 'autocomplete-input-icon';
        parent.insertBefore(iconBox, input);
        input.style.paddingLeft = '48px';
      }

      dropdown = document.createElement('div');
      dropdown.className = 'autocomplete-dropdown';
      dropdown.style.display = 'none';
      parent.appendChild(dropdown);
    } else {
      wrapper = document.createElement('div');
      wrapper.className = 'autocomplete-search-wrap';

      if (showIcon) {
        iconBox = document.createElement('div');
        iconBox.className = 'autocomplete-input-icon';
        wrapper.appendChild(iconBox);
      }

      input = document.createElement('input');
      input.type = 'text';
      input.className = 'search-bar';
      if (opts.id) input.id = opts.id;
      input.placeholder = placeholder;
      input.setAttribute('autocomplete', 'off');
      if (showIcon) input.style.paddingLeft = '48px';
      wrapper.appendChild(input);

      dropdown = document.createElement('div');
      dropdown.className = 'autocomplete-dropdown';
      dropdown.style.display = 'none';
      wrapper.appendChild(dropdown);
    }

    /* ---- 图标更新 ---- */
    function updateIcon(item) {
      if (!iconBox) return;
      if (item && item.image) {
        iconBox.innerHTML = `<img src="assets/monster/images/${item.image}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
        iconBox.style.border = 'none';
      } else if (item && item.icon) {
        iconBox.innerHTML = `<img src="${item.icon}" style="width:22px;height:22px;object-fit:contain;">`;
        iconBox.style.border = 'none';
      } else if (item && !item.image && !item.icon) {
        iconBox.innerHTML = `<span style="font-size:10px;color:var(--text-muted);">无图</span>`;
        iconBox.style.border = '1px dashed var(--border)';
      } else {
        iconBox.innerHTML = '';
        iconBox.style.border = '1px dashed var(--border)';
      }
    }

    /* ---- 搜索逻辑 ---- */
    let suggestIndex = -1;

    function doSearch() {
      suggestIndex = -1;
      const kw = input.value.trim().toLowerCase();
      if (!kw) { dropdown.style.display = 'none'; return; }

      let list;
      if (customSearch) {
        list = customSearch(kw) || [];
      } else {
        // 拆分关键词："岚鸟(冬天的样子)" → namePart="岚鸟", formPart="冬天的样子"
        const kwBase = kw.split(/[（(]/)[0].trim();
        const formMatch = kw.match(/[（(]([^）)]+)[）)]/);
        const formPart = formMatch ? formMatch[1].trim() : '';
        list = RKData.getMonsters().filter(m => {
          if (m.hidden || !extraFilter(m)) return false;
          const name = RKData.getMonsterName(m).toLowerCase();
          const displayName = RKData.getMonsterDisplayName(m).toLowerCase();
          const chainName = (m.evolution_chain_name || '').toLowerCase();
          const form = (m.form || '').toLowerCase();
          const mainForm = (m.main_form_name || '').toLowerCase();
          // 完整匹配
          if (displayName.includes(kw) || name.includes(kw) || chainName.includes(kw)) return true;
          // 拆分匹配：名字部分匹配 AND (无形态部分 OR 形态部分匹配)
          if (kwBase && (name.includes(kwBase) || chainName.includes(kwBase) || displayName.includes(kwBase))) {
            if (!formPart) return true;
            if (form.includes(formPart) || mainForm.includes(formPart)) return true;
            // 形态部分的变体形态也匹配（如搜"冬天的样子"，变体形态的 main_form_name 也是"冬天的样子"）
            return false;
          }
          return false;
        });
      }
      if (list.length === 0) { dropdown.style.display = 'none'; return; }
      if (list.length > limit) list = list.slice(0, limit);

      dropdown.innerHTML = list.map(item => {
        if (customSearch) {
          const iconHtml = item.icon
            ? `<img src="${item.icon}" class="autocomplete-icon" loading="lazy">`
            : '<div class="autocomplete-icon-placeholder"></div>';
          const extraHtml = item.extra
            ? `<span class="autocomplete-extra" style="font-size:12px;color:var(--text-muted);white-space:nowrap;">${item.extra}</span>`
            : '';
          return `<div class="autocomplete-item" data-item-id="${item.id}">${iconHtml}<span class="autocomplete-name">${item.name}</span>${extraHtml}</div>`;
        }
        const name = RKData.getMonsterDisplayName(item);
        if (customRenderItem) {
          return `<div class="autocomplete-item" data-monster-id="${item.id}">${customRenderItem(item, name)}</div>`;
        }
        const imgUrl = item.image ? `assets/monster/images/${item.image}` : '';
        return `<div class="autocomplete-item" data-monster-id="${item.id}">
          ${imgUrl ? `<img src="${imgUrl}" class="autocomplete-icon" loading="lazy">` : '<div class="autocomplete-icon-placeholder"></div>'}
          <span class="autocomplete-name">${name}</span>
        </div>`;
      }).join('');
      // position: fixed 定位到输入框下方
      const inputRect = input.getBoundingClientRect();
      dropdown.style.left = inputRect.left + 'px';
      dropdown.style.top = (inputRect.bottom + 4) + 'px';
      dropdown.style.width = inputRect.width + 'px';
      dropdown.style.display = 'block';
    }

    function updateHighlight() {
      const items = dropdown.querySelectorAll('.autocomplete-item');
      items.forEach((it, i) => it.classList.toggle('autocomplete-active', i === suggestIndex));
    }

    /* ---- 输入时同步左侧图标 ---- */
    function syncIcon() {
      if (!showIcon) return;
      const kw = input.value.trim().toLowerCase();
      if (!kw) { updateIcon(null); return; }
      let matched = null;
      if (customSearch) {
        const list = customSearch(kw) || [];
        matched = list.length > 0 ? list[0] : null;
      } else {
        const kwBase = kw.split(/[（(]/)[0].trim();
        matched = RKData.getMonsters().find(m => {
          if (m.hidden || !extraFilter(m)) return false;
          const name = RKData.getMonsterName(m).toLowerCase();
          const displayName = RKData.getMonsterDisplayName(m).toLowerCase();
          const chainName = (m.evolution_chain_name || '').toLowerCase();
          if (displayName.includes(kw) || name.includes(kw) || chainName.includes(kw)) return true;
          if (kwBase && (name.includes(kwBase) || chainName.includes(kwBase) || displayName.includes(kwBase))) {
            const formMatch = kw.match(/[（(]([^）)]+)[）)]/);
            if (!formMatch) return true;
            const formPart = formMatch[1].trim();
            return (m.form || '').toLowerCase().includes(formPart) || (m.main_form_name || '').toLowerCase().includes(formPart);
          }
          return false;
        }) || null;
      }
      updateIcon(matched);
    }

    /* ---- 事件绑定 ---- */
    input.addEventListener('input', () => {
      doSearch();
      syncIcon();
      if (typeof opts.onInput === 'function') opts.onInput(input.value);
    });

    input.addEventListener('keydown', e => {
      const items = dropdown.querySelectorAll('.autocomplete-item');
      if (items.length === 0 || dropdown.style.display === 'none') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        suggestIndex = Math.min(suggestIndex + 1, items.length - 1);
        updateHighlight();
        items[suggestIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        suggestIndex = Math.max(suggestIndex - 1, 0);
        updateHighlight();
        items[suggestIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (suggestIndex >= 0 && items[suggestIndex]) {
          e.preventDefault();
          items[suggestIndex].click();
        }
      } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
        suggestIndex = -1;
      }
    });

    input.addEventListener('focus', () => {
      if (input.value.trim()) doSearch();
    });

    input.addEventListener('blur', () => {
      setTimeout(() => { dropdown.style.display = 'none'; }, 200);
    });

    // 滚动时隐藏 dropdown（position:fixed 无法跟随滚动）
    function hideOnScroll() {
      if (dropdown.style.display !== 'none') {
        dropdown.style.display = 'none';
        suggestIndex = -1;
      }
    }
    // 监听所有可滚动祖先
    let scrollParent = input.parentElement;
    while (scrollParent && scrollParent !== document.body) {
      const style = getComputedStyle(scrollParent);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') {
        scrollParent.addEventListener('scroll', hideOnScroll, { passive: true });
      }
      scrollParent = scrollParent.parentElement;
    }
    window.addEventListener('scroll', hideOnScroll, { passive: true });

    dropdown.addEventListener('click', e => {
      const itemEl = e.target.closest('.autocomplete-item');
      if (!itemEl) return;
      if (customSearch) {
        const itemId = itemEl.dataset.itemId;
        const list = customSearch(input.value.trim().toLowerCase()) || [];
        const found = list.find(x => String(x.id) === itemId);
        if (!found) return;
        input.value = found.name;
        dropdown.style.display = 'none';
        suggestIndex = -1;
        updateIcon(found);
        if (typeof opts.onSelect === 'function') opts.onSelect(found);
      } else {
        const petId = parseInt(itemEl.dataset.monsterId);
        const pet = RKData.getMonsterById(petId);
        if (!pet) return;
        input.value = RKData.getMonsterDisplayName(pet);
        dropdown.style.display = 'none';
        suggestIndex = -1;
        updateIcon(pet);
        if (typeof opts.onSelect === 'function') opts.onSelect(pet);
      }
    });

    return {
      wrapper,
      input,
      dropdown,
      getValue: () => input.value,
      setValue: (v, item) => { input.value = v; if (item) updateIcon(item); else syncIcon(); },
      focus: () => input.focus(),
      hideDropdown: () => { dropdown.style.display = 'none'; suggestIndex = -1; }
    };
  }

  /**
   * 精灵候选项渲染工厂 —— 统一头像+名称布局，右侧显示自定义文本
   * @param {function} [extraFn] - 返回右侧文本，参数为 monster 对象。不传则只显示头像+名称
   * @returns {function} renderItem(m, name) => htmlString
   */
  function monsterRenderItem(extraFn) {
    return function (m, name) {
      const imgUrl = m.image ? `assets/monster/images/${m.image}` : '';
      const iconHtml = imgUrl
        ? `<img src="${imgUrl}" alt="${name}" class="autocomplete-icon" loading="lazy">`
        : '<div class="autocomplete-icon-placeholder"></div>';
      const extraHtml = (extraFn && extraFn(m))
        ? `<span class="autocomplete-extra" style="font-size:12px;color:var(--text-muted);white-space:nowrap;">${extraFn(m)}</span>`
        : '';
      return `${iconHtml}<span class="autocomplete-name">${name}</span>${extraHtml}`;
    };
  }

  /** 获取精灵主/副属性中文简写（如 "火/草"） */
  function monsterTypeText(m) {
    const mainType = m.main_type ? m.main_type.name : '';
    const subType = m.sub_type ? m.sub_type.name : '';
    return [mainType, subType].filter(Boolean).map(t => RKData.getTypeShortZh(t) || t).join('/');
  }

  /**
   * 渲染属性 pill 按钮组
   * @param {HTMLElement} container - 挂载容器
   * @param {Set|Array} activeSet - 当前选中的属性集合
   * @param {function} [onToggle] - 点击 pill 回调，参数为属性英文名
   * @returns {void}
   */
  function renderTypePills(container, activeSet, onToggle) {
    if (!container) return;
    const pillOrder = RKData.PILL_ORDER;
    container.innerHTML = pillOrder.map(t => {
      const zh = RKData.getTypeShortZh(t) || t;
      const active = (activeSet && activeSet.has(t)) ? 'active' : '';
      const icon = `assets/icons/type/${t.toLowerCase()}.png`;
      return `<span class="type-pill ${active}" data-type="${t}"><img src="${icon}" class="type-pill-icon" alt="${zh}">${zh}</span>`;
    }).join('');
    if (typeof onToggle === 'function') {
      container.onclick = e => {
        const pill = e.target.closest('.type-pill');
        if (!pill) return;
        onToggle(pill.dataset.type);
      };
    }
  }

  /* ========== 自定义 Popup 弹窗 ========== */

  function showAlert(message, title) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'cui-popup-overlay';
      overlay.innerHTML = `
        <div class="cui-popup-card">
          ${title ? `<div style="padding:16px 28px 0;font-size:15px;font-weight:700;color:var(--text-primary);">${title}</div>` : ''}
          <div class="cui-popup-body">${message}</div>
          <div class="cui-popup-actions">
            <button class="cui-popup-btn cui-popup-btn-primary" id="cui-popup-ok">确定</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const close = () => { overlay.remove(); resolve(); };
      overlay.querySelector('#cui-popup-ok').addEventListener('click', close);
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    });
  }

  function showConfirm(message, onConfirm, title) {
    const overlay = document.createElement('div');
    overlay.className = 'cui-popup-overlay';
    overlay.innerHTML = `
      <div class="cui-popup-card">
        ${title ? `<div style="padding:16px 28px 0;font-size:15px;font-weight:700;color:var(--text-primary);">${title}</div>` : ''}
        <div class="cui-popup-body">${message}</div>
        <div class="cui-popup-actions">
          <button class="cui-popup-btn cui-popup-btn-secondary" id="cui-popup-cancel">取消</button>
          <button class="cui-popup-btn cui-popup-btn-danger" id="cui-popup-confirm">确定</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#cui-popup-cancel').addEventListener('click', close);
    overlay.querySelector('#cui-popup-confirm').addEventListener('click', () => { close(); if (typeof onConfirm === 'function') onConfirm(); });
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  }

  /* ========== SkillPicker 公共模块 ========== */

  const SKILL_TYPE_ORDER = ['物攻', '魔攻', '状态', '防御'];
  const SKILL_ELEM_ORDER = ['普通', '草', '火', '水', '光', '地', '冰', '龙', '电', '毒', '虫', '武', '翼', '萌', '幽', '恶', '机械', '幻'];
  const SKILL_TYPE_ICON_MAP = {
    '物攻': 'physical-attack', '魔攻': 'magic-attack',
    '防御': 'defense', '状态': 'status',
    '条件攻击': 'conditional-attack', '能量': 'energy'
  };

  const SkillPicker = (function () {

    function renderFilterBar(skills) {
      const allTypes = [...new Set(skills.map(s => s.type).filter(Boolean))];
      const allElems = [...new Set(skills.map(s => s.element).filter(Boolean))];
      const skillTypes = [...SKILL_TYPE_ORDER.filter(t => allTypes.includes(t)), ...allTypes.filter(t => !SKILL_TYPE_ORDER.includes(t))];
      const skillElems = [...SKILL_ELEM_ORDER.filter(t => allElems.includes(t)), ...allElems.filter(t => !SKILL_ELEM_ORDER.includes(t))];

      return `
        <div class="detail-skill-filter">
          <div class="detail-skill-filter-group">
            ${skillTypes.map(t => {
              const display = t === '普通' ? '普' : t === '机械' ? '钢' : t;
              const iconFile = SKILL_TYPE_ICON_MAP[t] || '';
              const iconHtml = iconFile ? `<img src="assets/icons/move-sub/${iconFile}.png" class="detail-skill-filter-icon" alt="${t}">` : '';
              return `<button class="detail-skill-filter-btn" data-filter-type="${t}">${iconHtml}${display}</button>`;
            }).join('')}
          </div>
          <div class="detail-skill-filter-group">
            ${skillElems.map(t => {
              const display = t === '普通' ? '普' : t === '机械' ? '钢' : t;
              const iconName = RKData.getTypeIcon(t);
              return `<button class="detail-skill-filter-btn" data-filter-elem="${t}"><img src="${iconName}" class="detail-skill-filter-icon" alt="${t}">${display}</button>`;
            }).join('')}
          </div>
          <div class="detail-skill-filter-group">
            ${[0,1,2,3,4,5,6,7,8,9,'10+'].map(c => `<button class="detail-skill-filter-btn" data-filter-energy="${c}"><img src="assets/icons/move-sub/energy.png" class="detail-skill-filter-icon" alt="能耗">${c}</button>`).join('')}
          </div>
        </div>`;
    }

    function bindFilterEvents(container, itemSelector) {
      const filterContainer = container.querySelector('.detail-skill-filter');
      if (!filterContainer) return;

      const activeTypes = new Set();
      const activeElems = new Set();
      const activeEnergy = new Set();

      filterContainer.addEventListener('click', function (e) {
        const btn = e.target.closest('.detail-skill-filter-btn');
        if (!btn) return;

        if (btn.dataset.filterType) {
          const val = btn.dataset.filterType;
          if (activeTypes.has(val)) { activeTypes.delete(val); btn.classList.remove('active'); }
          else { activeTypes.add(val); btn.classList.add('active'); }
        }
        if (btn.dataset.filterElem) {
          const val = btn.dataset.filterElem;
          if (activeElems.has(val)) { activeElems.delete(val); btn.classList.remove('active'); }
          else { activeElems.add(val); btn.classList.add('active'); }
        }
        if (btn.dataset.filterEnergy) {
          const val = btn.dataset.filterEnergy;
          if (activeEnergy.has(val)) { activeEnergy.delete(val); btn.classList.remove('active'); }
          else { activeEnergy.add(val); btn.classList.add('active'); }
        }

        // 筛选前记录滚动位置
        const scrollBody = container.querySelector('.team-skill-picker-body') || container.querySelector('.hide-scrollbar');
        const savedScrollTop = scrollBody ? scrollBody.scrollTop : 0;

        container.querySelectorAll(itemSelector || '.detail-skill-item').forEach(item => {
          const itemType = item.dataset.skillType;
          const itemElem = item.dataset.skillElem;
          const itemEnergy = item.dataset.skillEnergy;
          const typeMatch = activeTypes.size === 0 || activeTypes.has(itemType);
          const elemMatch = activeElems.size === 0 || activeElems.has(itemElem);
          let energyMatch = true;
          if (activeEnergy.size > 0) {
            energyMatch = [...activeEnergy].some(ae => {
              if (ae === '10+') return itemEnergy !== '' && parseInt(itemEnergy) >= 10;
              return itemEnergy === ae;
            });
          }
          item.style.display = (typeMatch && elemMatch && energyMatch) ? '' : 'none';
        });

        container.querySelectorAll('.detail-skill-group').forEach(group => {
          const visible = group.querySelectorAll('.detail-skill-item:not([style*="display: none"])');
          group.style.display = visible.length ? '' : 'none';
        });

        // 滚动 spacer：在底部插入空白，使 scrollTop 不被浏览器 clamp
        if (scrollBody) {
          let spacer = scrollBody.querySelector('.skill-filter-scroll-spacer');
          const hasFilter = activeTypes.size > 0 || activeElems.size > 0 || activeEnergy.size > 0;
          if (hasFilter && savedScrollTop > 0) {
            // 先移除旧 spacer
            if (spacer) spacer.remove();
            // 直接用 savedScrollTop + clientHeight 作为 spacer 高度
            // 保证 scrollHeight >= savedScrollTop + clientHeight，即 maxScroll >= savedScrollTop
            const spacerHeight = savedScrollTop + scrollBody.clientHeight;
            spacer = document.createElement('div');
            spacer.className = 'skill-filter-scroll-spacer';
            spacer.style.height = spacerHeight + 'px';
            scrollBody.appendChild(spacer);
            scrollBody.scrollTop = savedScrollTop;
            // 下一帧精简 spacer 到刚好够用
            requestAnimationFrame(() => {
              const maxScroll = scrollBody.scrollHeight - scrollBody.clientHeight;
              if (maxScroll > savedScrollTop) {
                spacer.style.height = (spacerHeight - (maxScroll - savedScrollTop)) + 'px';
                scrollBody.scrollTop = savedScrollTop;
              }
            });
          } else {
            if (spacer) spacer.remove();
          }
        }
      });
    }

    function renderSkillList(skills, allMoves, options) {
      const moveEnergyMap = {}, movePowerMap = {}, moveIdMap = {};
      (allMoves || []).forEach(mv => {
        if (mv.localized && mv.localized.zh && mv.localized.zh.name) {
          moveEnergyMap[mv.localized.zh.name] = mv.energy_cost;
          movePowerMap[mv.localized.zh.name] = mv.power;
          moveIdMap[mv.localized.zh.name] = mv.id;
        }
      });

      const sourceOrder = options.sourceOrder || ['默认', '血脉', '技能石', '传说'];
      const skillsBySource = {};
      sourceOrder.forEach(s => { skillsBySource[s] = []; });
      skills.forEach(s => {
        if (!skillsBySource[s.source]) skillsBySource[s.source] = [];
        skillsBySource[s.source].push(s);
      });

      return sourceOrder
        .filter(s => skillsBySource[s] && skillsBySource[s].length > 0)
        .map(src => {
          const items = skillsBySource[src].map(s => {
            const energy = moveEnergyMap[s.name];
            const power = movePowerMap[s.name];
            const moveId = moveIdMap[s.name];
            const extraClass = [];
            if (options.equippedSkills && options.equippedSkills.includes(s.name)) extraClass.push('skill-equipped');
            if (options.disabledSkills && options.disabledSkills(s)) extraClass.push('skill-disabled');
            const extraAttrs = [
              `data-skill-name="${s.name}"`,
              `data-skill-source="${s.source || ''}"`,
              `data-skill-elem="${s.element || ''}"`,
              `data-skill-type="${s.type || ''}"`
            ];
            if (moveId != null && options.showMoveLink) extraAttrs.push(`data-move-id="${moveId}" style="cursor:pointer;"`);
            return RKData.buildSkillCardHtml({
              name: s.name, desc: s.desc, type: s.type, element: s.element,
              energy: energy, power: power,
              extraClass: extraClass.join(' '),
              extraAttrs: extraAttrs.join(' ')
            });
          }).join('');
          return `<div class="detail-skill-group">
            <div style="text-align:center;"><span class="detail-skill-group-title">${src} <span class="detail-skill-count">${skillsBySource[src].length}</span></span></div>
            <div class="detail-skill-list">${items}</div>
          </div>`;
        }).join('');
    }

    return { renderFilterBar, bindFilterEvents, renderSkillList };
  })();

  /* ============================================================
   * StatBox — 公共属性值面板模块
   * 提供统一的属性值/种族值显示、切换、性格/个体按钮状态管理
   * ============================================================ */
  const StatBox = (function () {
    const STAT_LABELS = { attack: '物攻', magic_attack: '魔攻', defense: '物防', magic_defense: '魔防', hp: '生命', speed: '速度' };
    const DEFAULT_STATS = ['hp', 'defense', 'attack', 'magic_defense', 'magic_attack', 'speed'];

    /** 构建属性条 HTML */
    function buildHTML(side, stats) {
      stats = stats || DEFAULT_STATS;
      return stats.map(stat => `
        <div class="final-stat-item" data-stat="${stat}">
          <span class="stat-label">${STAT_LABELS[stat]}:</span>
          <span class="stat-value accent">0</span>
          <button class="nature-btn" data-type="${side}" data-stat="${stat}">性格</button>
          <button class="iv-btn" data-type="${side}" data-stat="${stat}">个体</button>
        </div>
      `).join('');
    }

    /** 构建属性值/种族值单选切换 HTML */
    function buildModeRadio(side) {
      const name = side + 'StatMode';
      return `<div class="radio-group stat-mode-group">
        <label class="radio-label"><input type="radio" name="${name}" value="final" checked><span>属性值</span></label>
        <label class="radio-label"><input type="radio" name="${name}" value="base"><span>种族值</span></label>
      </div>`;
    }

    /** 同步性格/个体按钮状态（不更新数值） */
    function syncButtons(rootEl, nature, iv) {
      if (!rootEl) return;
      const stats = DEFAULT_STATS;
      const hasPositive = stats.some(s => (nature && nature[s]) === 1);
      const ivCount = stats.filter(s => (iv && iv[s])).length;

      rootEl.querySelectorAll('.final-stat-item').forEach(item => {
        const stat = item.dataset.stat;
        const natureBtn = item.querySelector('.nature-btn');
        const ivBtn = item.querySelector('.iv-btn');
        const natureVal = (nature && nature[stat]) || 0;
        const ivVal = (iv && iv[stat]) || false;

        if (natureBtn) {
          natureBtn.classList.remove('active-positive', 'active-negative', 'btn-disabled');
          if (natureVal === 1) { natureBtn.classList.add('active-positive'); natureBtn.textContent = '性格+'; }
          else if (natureVal === 2) { natureBtn.classList.add('active-negative'); natureBtn.textContent = '性格-'; }
          else { natureBtn.textContent = '性格'; }
          if (natureVal !== 1 && natureVal !== 2 && hasPositive) natureBtn.classList.add('btn-disabled');
        }
        if (ivBtn) {
          ivBtn.classList.remove('active', 'btn-disabled');
          if (ivVal) ivBtn.classList.add('active');
          if (!ivVal && ivCount >= 3) ivBtn.classList.add('btn-disabled');
        }
      });
    }

    /** 刷新属性数值 + 按钮状态 */
    function refreshValues(rootEl, pet, nature, iv, mode) {
      if (!rootEl || !pet) return;
      const stats = DEFAULT_STATS;
      stats.forEach(stat => {
        const item = rootEl.querySelector(`.final-stat-item[data-stat="${stat}"]`);
        if (!item) return;
        const valEl = item.querySelector('.stat-value');
        const baseStat = RKData.getBaseStat(pet, stat);
        if (valEl) valEl.dataset.baseStat = baseStat;

        const natureVal = (nature && nature[stat]) || 0;
        const ivVal = (iv && iv[stat]) || false;
        if (mode === 'base') {
          if (valEl) valEl.textContent = baseStat;
        } else {
          const final = RKData.getPetStat(pet, stat, natureVal, ivVal);
          if (valEl) valEl.textContent = final;
        }
      });
      syncButtons(rootEl, nature, iv);
    }

    /** 仅显示种族值 */
    function showBaseValues(rootEl) {
      if (!rootEl) return;
      rootEl.querySelectorAll('.final-stat-item').forEach(item => {
        const valEl = item.querySelector('.stat-value');
        if (valEl && valEl.dataset.baseStat != null) valEl.textContent = valEl.dataset.baseStat;
      });
    }

    return { buildHTML, buildModeRadio, refreshValues, syncButtons, showBaseValues, STAT_LABELS, DEFAULT_STATS };
  })();

  return {
    bindBackToTop, bindScrollControls, wrapRelative,
    createSearchBox,
    monsterRenderItem, monsterTypeText, renderTypePills,
    showAlert, showConfirm,
    SkillPicker,
    StatBox
  };
})();
