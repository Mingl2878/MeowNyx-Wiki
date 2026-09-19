/**
 * common.js — 公共组件模块
 * 提供跨页面复用的 UI 功能
 */

/* ============================================================
 * 窗口缩放控制（完全由前端接管，禁用浏览器原生缩放）：
 *   - 非最大化：禁用 Ctrl+滚轮缩放，强制 100%（最大化时缩放后还原窗口会自动复位）
 *   - 最大化：Ctrl+滚轮调整缩放（50%~200%，步进10%），Ctrl+0 复位
 * ============================================================ */
(function () {
  let windowMaximized = false;
  let windowStateInitialized = false;
  // Detached read-only snapshots. Unknown native state is conservatively windowed.
  const getWindowState = () => Object.freeze({ maximized: windowMaximized, initialized: windowStateInitialized });
  let windowStatePending = false, windowStateDirty = false;
  let zoom = 1;
  // 缩放的唯一运行时入口；设置页和快捷操作都通过它更新。
  const readMemory = key => { try { return localStorage.getItem(key); } catch (e) { return null; } };
  const writeMemory = (key, value) => { try { localStorage.setItem(key, String(value)); } catch (e) {} };
  const clampZoom = value => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.min(2, Math.max(0.5, number)) : 1;
  };
  let savedMaxZoom = clampZoom(readMemory('xwiki-max-zoom'));
  let zoomRevision = 0;
  function applyZoom() {
    document.documentElement.style.zoom = zoom;
    document.documentElement.style.setProperty('--page-zoom', zoom);
    window.dispatchEvent(new CustomEvent('appzoomchange', { detail: { zoom } }));
  }
  // Runtime/cache setter only: applying a successful commit must never queue another save.
  function setMaxZoom(value, persist = true) {
    savedMaxZoom = clampZoom(value);
    zoomRevision++;
    if (persist) writeMemory('xwiki-max-zoom', savedMaxZoom);
    zoom = windowMaximized ? savedMaxZoom : 1;
    applyZoom();
    return savedMaxZoom;
  }
  async function saveShortcutZoom(value) {
    const next = setMaxZoom(value, false); // immediate visual preview, not a durable commit
    try {
      if (window.UserConfig?.saveSettings) {
        const ok = await window.UserConfig.saveSettings({ default_max_zoom: Math.round(next * 100) });
        if (!ok) return false; // UserConfig owns durable/cache failure reporting and flush tracking.
      }
      writeMemory('xwiki-max-zoom', next);
      return true;
    } catch (_) {
      return false; // Keep the previous cache; UserConfig reports the failed queued operation.
    }
  }
  const speedModes = ['include', 'exclude', 'threshold'];
  const normalizeThreshold = value => {
    const number = value == null || value === '' ? NaN : Number(value);
    return Number.isFinite(number) ? Math.min(120, Math.max(40, Math.round(number))) : 80;
  };
  const cachedSpeedMode = readMemory('xwiki-effective-speed-mode');
  let effectiveSpeedMode = speedModes.includes(cachedSpeedMode) ? cachedSpeedMode
    : readMemory('xwiki-effective-include-speed') === 'false' ? 'exclude' : 'include';
  let effectiveSpeedThreshold = normalizeThreshold(readMemory('xwiki-effective-speed-threshold'));
  let effectiveRevision = 0;
  const getEffectiveSpeedPolicy = () => ({ mode: effectiveSpeedMode, threshold: effectiveSpeedThreshold });
  // Legacy boolean means unconditional inclusion; threshold requires the new policy API.
  const getEffectiveIncludeSpeed = () => effectiveSpeedMode === 'include';
  function setEffectiveSpeedPolicy(mode, threshold = effectiveSpeedThreshold, persist = true) {
    const nextMode = speedModes.includes(mode) ? mode : 'include';
    const nextThreshold = normalizeThreshold(threshold);
    const changed = nextMode !== effectiveSpeedMode || nextThreshold !== effectiveSpeedThreshold;
    effectiveSpeedMode = nextMode;
    effectiveSpeedThreshold = nextThreshold;
    effectiveRevision++;
    if (persist) {
      writeMemory('xwiki-effective-speed-mode', nextMode);
      writeMemory('xwiki-effective-speed-threshold', nextThreshold);
      writeMemory('xwiki-effective-include-speed', getEffectiveIncludeSpeed());
    }
    const policy = getEffectiveSpeedPolicy();
    if (changed) window.dispatchEvent(new CustomEvent('appstatspreferenceschange', {
      detail: { ...policy, includeSpeed: getEffectiveIncludeSpeed() }
    }));
    return policy;
  }
  function setEffectiveIncludeSpeed(value, persist = true) {
    setEffectiveSpeedPolicy(value !== false ? 'include' : 'exclude', effectiveSpeedThreshold, persist);
    return getEffectiveIncludeSpeed();
  }
  window.AppPreferences = Object.freeze({ getMaxZoom: () => savedMaxZoom, getZoom: () => zoom, setMaxZoom,
    getEffectiveSpeedPolicy, setEffectiveSpeedPolicy, getEffectiveIncludeSpeed, setEffectiveIncludeSpeed,
    getWindowState, isMaximized: () => windowMaximized });
  function refreshWindowState() {
    // One shared request at a time. Resize during fetch invalidates that response and
    // coalesces a fresh read; an old response cannot overwrite a newer native state.
    if (windowStatePending) { windowStateDirty = true; return; }
    windowStatePending = true;
    fetch('/api/window/state', { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('Window state unavailable'); return r.json(); })
      .then(d => {
        if (windowStateDirty || typeof d?.maximized !== 'boolean') return;
        const changed = !windowStateInitialized || windowMaximized !== d.maximized;
        windowMaximized = d.maximized;
        windowStateInitialized = true;
        const target = windowMaximized ? savedMaxZoom : 1;
        if (zoom !== target) { zoom = target; applyZoom(); }
        // Initialization (unknown -> known) is a state change too; identical polls
        // thereafter emit nothing. Consumers read the stored snapshot when mounting.
        if (changed) window.dispatchEvent(new CustomEvent('appwindowstatechange', { detail: getWindowState() }));
      })
      .catch(() => {})
      .finally(() => {
        windowStatePending = false;
        if (windowStateDirty) { windowStateDirty = false; refreshWindowState(); }
      });
  }
  let fontLoadToken = 0;

  function getAppFontStack(fontFamily) {
    if (!fontFamily) return 'system-ui, sans-serif';
    return '"__xhm_selected_font", system-ui, sans-serif';
  }

  async function applyAppFont(fontFamily) {
    const root = document.documentElement;
    const token = ++fontLoadToken;
    if (!fontFamily) {
      root.style.setProperty('--app-font-family', 'system-ui, sans-serif');
      if (document.body) document.body.style.fontFamily = 'system-ui, sans-serif';
      window.dispatchEvent(new CustomEvent('appfontchange', { detail: { fontFamily: '' } }));
      return { applied: true, fallback: false };
    }

    try {
      const url = '/api/font-file?family=' + encodeURIComponent(fontFamily) + '&v=' + Date.now();
      const font = new FontFace('__xhm_selected_font', `url("${url}")`);
      await font.load();
      if (token !== fontLoadToken) return { applied: false, fallback: false };
      document.fonts.add(font);
      const stack = getAppFontStack(fontFamily);
      root.style.setProperty('--app-font-family', stack);
      if (document.body) document.body.style.fontFamily = stack;
      window.dispatchEvent(new CustomEvent('appfontchange', { detail: { fontFamily } }));
      return { applied: true, fallback: false };
    } catch (error) {
      if (token !== fontLoadToken) return { applied: false, fallback: false };
      root.style.setProperty('--app-font-family', 'system-ui, sans-serif');
      if (document.body) document.body.style.fontFamily = 'system-ui, sans-serif';
      window.dispatchEvent(new CustomEvent('appfontchange', { detail: { fontFamily: '' } }));
      return { applied: false, fallback: true, error };
    }
  }
  window.getAppFontStack = getAppFontStack;
  window.applyAppFont = applyAppFont;

  // The shared settings file is startup authority; per-port storage is only a cache.
  // Parent app.init awaits this promise before choosing its initial route.
  const initialEffectiveRevision = effectiveRevision;
  const initialZoomRevision = zoomRevision;
  window.appPreferencesReady = fetch('/api/settings', { cache: 'no-store' })
    .then(r => {
      if (!r.ok) throw new Error('加载共享设置失败');
      return r.json();
    })
    .then(s => {
      if (!s || typeof s !== 'object' || Array.isArray(s) || s.ok === false) throw new Error('共享设置响应无效');
      writeMemory('xwiki-default-route', typeof s.default_route === 'string' && s.default_route ? s.default_route : 'petdex');
      applyAppFont(s.font_family || '');
      if (effectiveRevision === initialEffectiveRevision) setEffectiveSpeedPolicy(
        speedModes.includes(s.effective_speed_mode) ? s.effective_speed_mode : s.effective_include_speed === false ? 'exclude' : 'include',
        normalizeThreshold(s.effective_speed_threshold)
      );
      if (zoomRevision === initialZoomRevision) setMaxZoom((s.default_max_zoom ?? 100) / 100);
      return s;
    })
    .catch(() => null);
  // 窗口最大化/还原时会触发 resize
  window.addEventListener('resize', refreshWindowState);
  refreshWindowState();
  window.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault(); // 接管缩放，禁用浏览器原生 Ctrl+滚轮
    if (!windowMaximized) return; // 非最大化：完全忽略
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    return saveShortcutZoom(Math.round((zoom + delta) * 10) / 10);
  }, { passive: false });
  // Ctrl+0 resets the shared default to 100%, using the same queue as settings saves.
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === '0' || e.code === 'Digit0')) {
      e.preventDefault();
      return saveShortcutZoom(1);
    }
  });
  // 供 fixed 定位下拉框修正坐标（CSS zoom 下 getBoundingClientRect 返回视觉坐标）
  window.__getPageZoom = function () { return zoom; };
})();

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

    // 优先放到外层定位壳，避免作为滚动内容的一部分被裁切。
    const host = container.closest('.scroll-wrapper-container') || container;
    let btn = host.querySelector(':scope > .back-to-top-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'back-to-top-btn';
      btn.title = '回到顶部';
      btn.innerHTML = SVG_UP;
      host.appendChild(btn);
    }

    container.addEventListener('scroll', () => {
      btn.classList.toggle('show', container.scrollTop > 200);
    });

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

  /* 公共组件生命周期：路由切换主动清理，局部重绘由观察器兜底。 */
  const managedWidgets = new Map();
  function registerCleanup(owner, cleanup) {
    if (!managedWidgets.has(owner)) managedWidgets.set(owner, new Set());
    managedWidgets.get(owner).add(cleanup);
    return () => {
      const callbacks = managedWidgets.get(owner);
      if (!callbacks) return;
      callbacks.delete(cleanup);
      if (!callbacks.size) managedWidgets.delete(owner);
    };
  }
  function destroyWithin(root) {
    for (const [owner, callbacks] of [...managedWidgets]) {
      if (!root || root === owner || root.contains(owner)) for (const cleanup of [...callbacks]) cleanup();
    }
  }
  if (typeof MutationObserver !== 'undefined' && document.body) {
    new MutationObserver(() => {
      for (const [owner, callbacks] of [...managedWidgets]) {
        if (!owner.isConnected) for (const cleanup of [...callbacks]) cleanup();
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function positionAnchoredLayer(anchor, layer, matchWidth = false, options = {}) {
    const zoom = window.__getPageZoom?.() || 1;
    const rect = anchor.getBoundingClientRect();
    layer.style.position = 'fixed';
    if (getComputedStyle(layer).display === 'none') layer.style.display = 'block';
    if (matchWidth) layer.style.width = `${rect.width / zoom}px`;
    layer.style.maxWidth = `${Math.max(0, window.innerWidth - 16) / zoom}px`;
    layer.style.maxHeight = `${Math.min(320, Math.max(0, window.innerHeight - 16) / zoom)}px`;
    layer.style.overflowY = 'auto';
    // Toolbar popovers must leave their trigger/mode buttons accessible even at 200% zoom.
    let useAbove = false;
    if (options.avoidAnchor) {
      const below = Math.max(0, window.innerHeight - rect.bottom - 12);
      const above = Math.max(0, rect.top - 12);
      useAbove = below < Math.min(140 * zoom, above);
      layer.style.maxHeight = `${Math.min(320, (useAbove ? above : below) / zoom)}px`;
    }
    const popup = layer.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popup.width - 8));
    let top = useAbove ? rect.top - popup.height - 4 : rect.bottom + 4;
    if (!options.avoidAnchor) {
      if (top + popup.height > window.innerHeight - 8 && rect.top > popup.height + 4) top = rect.top - popup.height - 4;
      top = Math.max(8, Math.min(top, window.innerHeight - popup.height - 8));
    }
    layer.style.left = `${left / zoom}px`;
    layer.style.top = `${top / zoom}px`;
  }

  function bindAnchoredLayer(anchor, layer, onClose) {
    let closed = false;
    const disposers = [];
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      disposers.push(() => target.removeEventListener(type, handler, options));
    };
    const close = () => {
      if (closed) return;
      closed = true;
      disposers.forEach(dispose => dispose());
      unregister();
      onClose();
    };
    const unregister = registerCleanup(anchor, close);
    listen(document, 'scroll', event => { if (!layer.contains(event.target)) close(); }, true);
    listen(window, 'resize', close);
    listen(window, 'appzoomchange', close);
    listen(document, 'pointerdown', event => { if (!anchor.contains(event.target) && !layer.contains(event.target)) close(); }, true);
    listen(document, 'keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }, true);
    return close;
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
   * @param {number} [opts.limit=10] - 自定义搜索最多候选数；精灵候选不截断，通过下拉滚动查看
   * @param {boolean} [opts.showIcon=true] - 是否在搜索框左侧显示图标占位
   * @returns {{wrapper:?, input:HTMLInputElement, dropdown:HTMLDivElement, getValue:function, setValue:function, destroy:function}}
   * 路由离开应 destroy；公共注册表同时处理局部 DOM 重绘造成的移除。
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
    let destroyed = false;
    let blurTimer = null;
    let closeLayer = null;
    function hideDropdown() {
      dropdown.style.display = 'none';
      suggestIndex = -1;
      if (closeLayer) { const close = closeLayer; closeLayer = null; close(); }
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(blurTimer);
      hideDropdown();
      unregister();
    }
    const unregister = registerCleanup(input, destroy);

    function doSearch() {
      if (destroyed) return;
      suggestIndex = -1;
      const kw = input.value.trim().toLowerCase();
      if (!kw) { hideDropdown(); return; }

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
      if (list.length === 0) { hideDropdown(); return; }
      if (customSearch && list.length > limit) list = list.slice(0, limit);

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
      positionAnchoredLayer(input, dropdown, true);
      if (!closeLayer) closeLayer = bindAnchoredLayer(input, dropdown, () => {
        closeLayer = null; dropdown.style.display = 'none'; suggestIndex = -1;
      });
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
        hideDropdown();
      }
    });

    input.addEventListener('focus', () => {
      if (input.value.trim()) doSearch();
    });

    input.addEventListener('blur', () => {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(hideDropdown, 200);
    });

    dropdown.addEventListener('click', e => {
      const itemEl = e.target.closest('.autocomplete-item');
      if (!itemEl) return;
      if (customSearch) {
        const itemId = itemEl.dataset.itemId;
        const list = customSearch(input.value.trim().toLowerCase()) || [];
        const found = list.find(x => String(x.id) === itemId);
        if (!found) return;
        input.value = found.name;
        hideDropdown();
        updateIcon(found);
        if (typeof opts.onSelect === 'function') opts.onSelect(found);
      } else {
        const petId = parseInt(itemEl.dataset.monsterId);
        const pet = RKData.getMonsterById(petId);
        if (!pet) return;
        input.value = RKData.getMonsterDisplayName(pet);
        hideDropdown();
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
      hideDropdown,
      destroy
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

  // Per-view, three-state value filters. No storage or source-data mutations.
  const FilterExclusion = (function () {
    const dimensions = ['type', 'elem', 'energy', 'power', 'season'];
    const selector = dimensions.map(key => '[data-filter-' + key + ']').join(',');
    function create() {
      return { include: Object.fromEntries(dimensions.map(key => [key, new Set()])),
        exclude: Object.fromEntries(dimensions.map(key => [key, new Set()])) };
    }
    function toggle(state, dimension, value, exclude = false) {
      value = String(value);
      const target = state[exclude ? 'exclude' : 'include'][dimension];
      state[exclude ? 'include' : 'exclude'][dimension].delete(value);
      if (target.has(value)) target.delete(value); else target.add(value);
    }
    function valueMatches(dimension, filter, value) {
      if (value == null || value === '') return false;
      if (dimension === 'energy' && filter === '10+') return Number(value) >= 10;
      if (dimension === 'power') {
        if (filter === '140+') return Number(value) >= 140;
        const max = Number(filter);
        return Number(value) >= max - 19 && Number(value) <= max;
      }
      return String(value) === filter;
    }
    function matches(state, values) {
      return dimensions.every(key => {
        const match = value => valueMatches(key, value, values[key]);
        return (!state.include[key].size || [...state.include[key]].some(match)) &&
          ![...state.exclude[key]].some(match);
      });
    }
    function hasSelection(state) {
      return dimensions.some(key => state.include[key].size || state.exclude[key].size);
    }
    function identify(button) {
      const dimension = dimensions.find(key => button.hasAttribute('data-filter-' + key));
      return { dimension, value: button.getAttribute('data-filter-' + dimension) };
    }
    function sync(button, state) {
      const { dimension, value } = identify(button);
      const included = state.include[dimension].has(value), excluded = state.exclude[dimension].has(value);
      button.classList.toggle('active', included);
      button.classList.toggle('filter-excluded', excluded);
      button.dataset.filterState = excluded ? 'exclude' : included ? 'include' : 'neutral';
      button.setAttribute('role', 'button'); button.setAttribute('tabindex', '0');
      button.setAttribute('aria-pressed', excluded ? 'mixed' : included ? 'true' : 'false');
      const label = { type: '类型', elem: '属性', energy: '能耗', power: '威力', season: '赛季' }[dimension] + '：' + value;
      button.setAttribute('aria-label', label + '，' + (excluded ? '已排除' : included ? '已纳入' : '不限制'));
      button.title = label + '；左键或 Enter/空格：纳入；右键或 Shift+Enter/空格：排除；重复操作取消';
      let mark = button.querySelector('.filter-exclusion-mark');
      if (!mark) {
        mark = document.createElement('span'); mark.className = 'filter-exclusion-mark';
        mark.textContent = '−'; mark.setAttribute('aria-hidden', 'true'); button.appendChild(mark);
      }
      mark.hidden = !excluded;
    }
    function bind(container, state, onChange) {
      // Bind the pills themselves: the live toolbar may portal their parent.
      const buttons = [...container.querySelectorAll(selector)];
      const removers = [];
      buttons.forEach(button => {
        sync(button, state);
        const apply = exclude => {
          const { dimension, value } = identify(button);
          toggle(state, dimension, value, exclude); sync(button, state); onChange();
        };
        const click = event => { if (event.button === 0) { event.preventDefault(); apply(false); } };
        const context = event => { event.preventDefault(); event.stopPropagation(); apply(true); };
        const keydown = event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault(); event.stopPropagation();
          if (!event.repeat) apply(event.shiftKey);
        };
        for (const [type, handler] of [['click',click],['contextmenu',context],['keydown',keydown]]) {
          button.addEventListener(type, handler); removers.push(() => button.removeEventListener(type, handler));
        }
      });
      return () => removers.forEach(remove => remove());
    }
    return { create, toggle, matches, hasSelection, bind, sync, selector };
  })();

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

    function bindFilterEvents(container, itemSelector, options = {}) {
      const filterContainer = container.querySelector('.detail-skill-filter');
      if (!filterContainer) return;

      const filterState = FilterExclusion.create();
      const applyFilters = () => {
        // 筛选前记录滚动位置
        const scrollBody = container.querySelector('.team-skill-picker-body') || container.querySelector('.hide-scrollbar') ||
          (container.id === 'pet-modal-body' ? container : null);
        const savedScrollTop = scrollBody ? scrollBody.scrollTop : 0;

        container.querySelectorAll(itemSelector || '.detail-skill-item').forEach(item => {
          const itemType = item.dataset.skillType;
          const itemElem = item.dataset.skillElem;
          const itemEnergy = item.dataset.skillEnergy;
          item.style.display = FilterExclusion.matches(filterState, {
            type: itemType, elem: itemElem, energy: itemEnergy
          }) ? '' : 'none';
        });

        container.querySelectorAll('.detail-skill-group').forEach(group => {
          const visible = group.querySelectorAll('.detail-skill-item:not([style*="display: none"])');
          group.style.display = visible.length ? '' : 'none';
        });

        // 滚动 spacer：在底部插入空白，使 scrollTop 不被浏览器 clamp
        if (scrollBody) {
          let spacer = scrollBody.querySelector('.skill-filter-scroll-spacer');
          const hasFilter = FilterExclusion.hasSelection(filterState);
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
              if (!spacer.isConnected || !scrollBody.isConnected) return;
              const maxScroll = scrollBody.scrollHeight - scrollBody.clientHeight;
              if (maxScroll > savedScrollTop) {
                spacer.style.height = Math.max(0, spacerHeight - (maxScroll - savedScrollTop)) + 'px';
                scrollBody.scrollTop = savedScrollTop;
              }
            });
          } else {
            if (spacer) spacer.remove();
          }
        }
      };
      if (options.allowExclusion === true) {
        const destroy = FilterExclusion.bind(filterContainer, filterState, applyFilters);
        registerCleanup(filterContainer, destroy);
      } else {
        // Team picker and other legacy callers remain include-only unless opted in.
        filterContainer.addEventListener('click', event => {
          const button = event.target.closest('.detail-skill-filter-btn');
          if (!button || !filterContainer.contains(button)) return;
          const dimension = ['type', 'elem', 'energy'].find(key => button.hasAttribute('data-filter-' + key));
          if (!dimension) return;
          const value = button.getAttribute('data-filter-' + dimension);
          FilterExclusion.toggle(filterState, dimension, value);
          button.classList.toggle('active', filterState.include[dimension].has(value));
          applyFilters();
        });
      }
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
              energy: energy, power: power, moveId: moveId,
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

    /** 同步显示；自由模拟面板不显示组队上限提示。 */
    function syncButtons(rootEl, nature, iv) {
      if (!rootEl) return;
      const stats = DEFAULT_STATS;
      const freeSimulation = rootEl.dataset.statPolicy === 'free';
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
          if (!freeSimulation && natureVal !== 1 && natureVal !== 2 && hasPositive) natureBtn.classList.add('btn-disabled');
        }
        if (ivBtn) {
          ivBtn.classList.remove('active', 'btn-disabled');
          if (ivVal) ivBtn.classList.add('active');
          if (!freeSimulation && !ivVal && ivCount >= 3) ivBtn.classList.add('btn-disabled');
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
    // Enabled UI labels only; never normalize arbitrary text or mathematical roots.
    enabledText: (enabled, label) => `${enabled ? '✓' : '×'}${label}`,
    bindBackToTop, bindScrollControls, wrapRelative,
    registerCleanup, destroyWithin, positionAnchoredLayer, bindAnchoredLayer,
    createSearchBox,
    monsterRenderItem, monsterTypeText, renderTypePills,
    showAlert, showConfirm,
    SkillPicker, FilterExclusion,
    StatBox
  };
})();
