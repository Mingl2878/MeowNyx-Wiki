/** Shared listing controls. Load after common.js, before petdex.js / moves.js. */
const ListingUI = (() => {
  'use strict';
  const STAT_COLUMNS = Object.freeze([
    ['base_hp', '生命', 'stat-num'], ['base_phy_atk', '物攻', 'stat-num'],
    ['base_mag_atk', '魔攻', 'stat-num'], ['base_phy_def', '物防', 'stat-num'],
    ['base_mag_def', '魔防', 'stat-num'], ['base_spd', '速度', 'stat-num'],
    ['total', '总种族', 'stat-total'], ['effective', '有效种族', 'stat-effective']
  ].map(([key, label, className]) => Object.freeze({ key, label, className })));
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  function statValue(monster, key) {
    if (key === 'total') return RKData.getTotalStats(monster);
    if (key === 'effective') return RKData.getEffectiveStats(monster);
    const value = Number(monster[key]);
    return Number.isFinite(value) ? value : 0;
  }
  // Decorate with the source index: ties never reverse when direction changes.
  function sortMonsters(monsters, key, asc = false) {
    if (!key) return monsters.slice();
    return monsters.map((monster, index) => ({ monster, index })).sort((a, b) => {
      const diff = key === 'name'
        ? RKData.getMonsterName(a.monster).localeCompare(RKData.getMonsterName(b.monster), 'zh')
        : statValue(a.monster, key) - statValue(b.monster, key);
      return (asc ? diff : -diff) || a.index - b.index;
    }).map(item => item.monster);
  }
  function nextSort(sort, key) {
    return { ...sort, key, asc: sort.key === key ? !sort.asc : false };
  }
  function uniqueMonsters(monsters) {
    const seen = new Set();
    return monsters.filter(monster => {
      // IDs, not names / images / evolutionary families, define identity here.
      const id = String(monster.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  function statHeaders(sort = {}, { petdex = false } = {}) {
    return STAT_COLUMNS.map(({ key, label }) => {
      const active = sort.key === key;
      const direction = active ? (sort.asc ? 'ascending' : 'descending') : 'none';
      const text = petdex && (key === 'total' || key === 'effective') ? label + '值' : label;
      return `<th ${petdex ? 'data-sort' : 'data-listing-sort'}="${key}" aria-sort="${direction}"${active ? ` class="sort-${sort.asc ? 'asc' : 'desc'}"` : ''}>${petdex ? text : `<button type="button" data-listing-sort="${key}">${text}</button>`}</th>`;
    }).join('');
  }
  function statCells(monster) {
    return STAT_COLUMNS.map(({ key, className }) => `<td class="stat-col" data-stat="${key}"><span class="${className}">${escapeHtml(statValue(monster, key))}</span></td>`).join('');
  }
  // ATTRIBUTE PRIORITY (non-layout): stable partition AFTER ordinary sorting.
  // Never alter types, source groups, or the input row/identity set.
  function prioritizeMonsters(monsters, type = '') {
    if (!type) return monsters.slice();
    const pinned = [], rest = [];
    for (const monster of monsters) {
      (monster.main_type?.name === type || monster.sub_type?.name === type ? pinned : rest).push(monster);
    }
    return pinned.concat(rest);
  }
  function priorityHeader(type = '') {
    const label = type ? `属性：${RKData.getTypeShortZh(type)}优先，再次选择取消` : '属性：选择优先属性';
    const indicator = type ? `<img class="listing-priority-indicator" src="assets/icons/type/${escapeHtml(type.toLowerCase())}.png" alt="">` : '';
    return `<th><button type="button" data-listing-priority="${escapeHtml(type)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" aria-haspopup="dialog" aria-expanded="false">属性${indicator}</button></th>`;
  }
  function monsterTable(monsters, sort = {}, priorityType = sort.priorityType || '') {
    const rows = prioritizeMonsters(sortMonsters(uniqueMonsters(monsters), sort.key, sort.asc), priorityType);
    return `<div class="listing-table-scroll"><table class="data-table listing-monster-table"><thead><tr><th>精灵</th>${priorityHeader(priorityType)}${statHeaders(sort)}</tr></thead><tbody>${rows.map(m => {
      const types = [m.main_type?.name, m.sub_type?.name].filter(Boolean).map(t => RKData.typeBadgeHtml(t)).join(' ');
      const image = m.image ? `<img class="pet-icon-img" src="assets/monster/images/${escapeHtml(m.image)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '';
      return `<tr data-monster-id="${escapeHtml(m.id)}"><td><button type="button" class="listing-monster-link" data-monster-id="${escapeHtml(m.id)}">${image}${RKData.getMonsterDisplayNameHtml(m)}</button></td><td>${types || '-'}</td>${statCells(m)}</tr>`;
    }).join('')}</tbody></table></div>`;
  }

  // ATTRIBUTE PRIORITY (non-layout): independent of team bloodline mutations.
  // One live picker; CommonUI owns escape/outside/scroll/resize/zoom + detach.
  let closePriority = null, prioritySequence = 0;
  function mountAttributePriority(host, type, onChange) {
    const anchor = host.querySelector('[data-listing-priority]');
    if (!anchor) return;
    let closeLayer = null;
    const open = () => {
      if (closeLayer) { closeLayer(); return; }
      closePriority?.();
      const layer = document.createElement('div');
      layer.className = 'listing-priority-popup';
      layer.id = `listing-priority-${++prioritySequence}`;
      layer.setAttribute('role', 'dialog');
      layer.setAttribute('aria-label', '优先属性（再次选择取消）');
      anchor.setAttribute('aria-controls', layer.id);
      anchor.setAttribute('aria-expanded', 'true');
      const buttons = RKData.PILL_ORDER.filter(value => value !== 'None' && value !== 'Leader').map(value => {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.priorityType = value;
        const label = RKData.getTypeShortZh(value);
        button.title = label;
        button.setAttribute('aria-label', `${label}优先`);
        button.setAttribute('aria-pressed', String(type === value));
        button.innerHTML = `<img src="assets/icons/type/${escapeHtml(value.toLowerCase())}.png" alt="">`;
        button.addEventListener('click', event => {
          event.stopPropagation();
          closeLayer();
          onChange(value === type ? '' : value);
        });
        layer.appendChild(button);
        return button;
      });
      // Escape transformed/clipped modal content. Derive stacking from actual
      // anchor ancestors, rather than inheriting team's hardcoded 10000.
      let z = 0;
      const ancestors = [];
      for (let node = anchor; node; node = node.parentElement) {
        ancestors.push(node);
        z = Math.max(z, Number.parseInt(getComputedStyle(node).zIndex) || 0);
      }
      layer.style.zIndex = String(z + 1);
      document.body.appendChild(layer);
      CommonUI.positionAnchoredLayer(anchor, layer);
      const onFont = () => closeLayer?.();
      window.addEventListener('appfontchange', onFont);
      document.fonts?.addEventListener('loadingdone', onFont);
      // Modal hiding does not detach its children. Observe only ancestors and
      // dispose this observer with the anchored layer, never a permanent watcher.
      const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
        if (ancestors.some(node => !node.isConnected || node.hidden || getComputedStyle(node).display === 'none')) closeLayer?.();
      });
      ancestors.forEach(node => observer?.observe(node, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] }));
      closeLayer = CommonUI.bindAnchoredLayer(anchor, layer, () => {
        const restoreFocus = layer.contains(document.activeElement);
        observer?.disconnect();
        window.removeEventListener('appfontchange', onFont);
        document.fonts?.removeEventListener('loadingdone', onFont);
        if (closePriority === closeLayer) closePriority = null;
        closeLayer = null;
        layer.remove();
        anchor.setAttribute('aria-expanded', 'false');
        anchor.removeAttribute('aria-controls');
        if (restoreFocus && anchor.isConnected && !ancestors.some(node => node.hidden || getComputedStyle(node).display === 'none')) anchor.focus({ preventScroll: true });
      });
      closePriority = closeLayer;
      (buttons.find(button => button.dataset.priorityType === type) || buttons[0])?.focus({ preventScroll: true });
      // Native Tab navigation remains available; leave the dialog to dismiss.
      layer.addEventListener('focusout', event => {
        if (event.relatedTarget && !layer.contains(event.relatedTarget) && event.relatedTarget !== anchor) closeLayer?.();
      });
    };
    const click = event => { event.stopPropagation(); open(); };
    anchor.addEventListener('click', click);
    const unregister = CommonUI.registerCleanup(anchor, () => {
      closeLayer?.(); anchor.removeEventListener('click', click); unregister();
    });
  }
  // Shared inline filter toolbar. Accepted layout; no separate rollback payload.
  const MODES = Object.freeze({ expanded: '展开', collapsed: '折叠', floating: '浮窗' });
  const modeMemory = new Map();
  const modeKey = page => `xwiki-listing-mode:${page}`;
  function readMode(page) {
    if (modeMemory.has(page)) return modeMemory.get(page);
    let saved;
    try { saved = localStorage.getItem(modeKey(page)); } catch (_) { /* private / disabled storage */ }
    return Object.hasOwn(MODES, saved) ? saved : 'expanded';
  }
  function saveMode(page, mode) {
    modeMemory.set(page, mode);
    try { localStorage.setItem(modeKey(page), mode); } catch (_) { /* memory still works */ }
  }

  /** Permanent search/modes; only the original lower panel is hidden or portalled.
   * Optional third argument is the ORIGINAL search slot, not a copy.
   */
  function mountFilters(panel, page, searchSlot = panel.querySelector(`#${page === 'petdex' ? 'petdex' : 'move'}-search-slot`)) {
    if (!['petdex', 'moves'].includes(page) || !searchSlot || !panel.contains(searchSlot)) {
      throw new Error('Listing filters require a supported page and its original search slot');
    }
    const shell = document.createElement('section');
    shell.className = 'listing-controls';
    shell.dataset.listingPage = page;
    const bar = document.createElement('div');
    bar.className = 'listing-toolbar';
    const modes = document.createElement('div');
    modes.className = 'listing-modes';
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', '筛选条件显示模式');
    const buttons = Object.entries(MODES).map(([value, label]) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label; button.dataset.listingMode = value;
      button.setAttribute('aria-label', label + '筛选条件');
      modes.appendChild(button);
      return button;
    });
    // moveBefore preserves focus/IME where supported; fallback retains focus.
    // Mode changes never move the search subtree at all.
    const move = (parent, node) => {
      const active = document.activeElement;
      if (parent.moveBefore && parent.isConnected && node.isConnected) parent.moveBefore(node, null);
      else {
        parent.appendChild(node);
        if (active && node.contains(active) && document.activeElement !== active) active.focus({ preventScroll: true });
      }
    };
    panel.parentNode.insertBefore(shell, panel);
    shell.appendChild(bar);
    searchSlot.classList.add('listing-search-slot');
    move(bar, searchSlot); bar.appendChild(modes); move(shell, panel);
    // The permanent shell, not the lower conditions, owns the card appearance.
    panel.classList.remove('filter-panel');
    panel.classList.add('listing-filter-panel');
    if (!panel.id) panel.id = `listing-filter-${page}`;
    panel.setAttribute('aria-label', '筛选条件');
    panel.setAttribute('role', 'region');
    panel.setAttribute('tabindex', '-1');
    buttons.forEach(button => button.setAttribute('aria-controls', panel.id));
    const trigger = buttons[2]; // Compatibility handle: floating mode's native button.
    let mode = readMode(page), timer = null, closeLayer = null, destroyed = false, restoring = false, opening = false;
    let keyboardOwned = false, pointerFocus = false, pointerFocusTimer = null;
    const disposers = [];
    const listen = (node, event, callback) => {
      node.addEventListener(event, callback);
      disposers.push(() => node.removeEventListener(event, callback));
    };
    const cancelClose = () => { clearTimeout(timer); timer = null; };
    const inControls = node => !!node && (shell.contains(node) || panel.contains(node));
    const inFocusControls = node => !!node && (modes.contains(node) || panel.contains(node));
    const sync = () => {
      shell.dataset.mode = mode;
      panel.hidden = mode !== 'expanded' && !closeLayer;
      buttons.forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.listingMode === mode));
        button.setAttribute('aria-expanded', String(!panel.hidden));
      });
    };
    const restorePanel = () => {
      cancelClose(); restoring = true;
      // Never strand keyboard focus in a hidden portal; suppress focus reopening.
      if (panel.contains(document.activeElement)) trigger.focus({ preventScroll: true });
      closeLayer = null;
      panel.classList.remove('listing-filter-floating');
      // Only inline styles owned by this popup's positioning are removed.
      for (const key of ['position', 'width', 'maxWidth', 'maxHeight', 'overflowY', 'left', 'top', 'display']) panel.style[key] = '';
      move(shell, panel);
      sync(); restoring = false;
    };
    const close = () => { cancelClose(); if (closeLayer) closeLayer(); };
    const open = () => {
      cancelClose();
      if (destroyed || restoring || opening || mode !== 'floating' || closeLayer || !shell.isConnected) return;
      opening = true;
      panel.hidden = false;
      panel.classList.add('listing-filter-floating');
      move(document.body, panel); // avoid clipping / transformed ancestors
      // Always below the whole toolbar. CommonUI's general positioner may flip
      // above; this local placement instead shortens/scrolls the lower conditions.
      const zoom = window.__getPageZoom?.() || 1;
      const rect = shell.getBoundingClientRect();
      panel.style.position = 'fixed';
      panel.style.width = `${rect.width / zoom}px`;
      panel.style.maxWidth = `${Math.max(0, window.innerWidth - 16) / zoom}px`;
      panel.style.maxHeight = `${Math.min(320, Math.max(0, window.innerHeight - rect.bottom - 12) / zoom)}px`;
      panel.style.overflowY = 'auto';
      const popup = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popup.width - 8)) / zoom}px`;
      panel.style.top = `${(rect.bottom + 4) / zoom}px`;
      closeLayer = CommonUI.bindAnchoredLayer(shell, panel, restorePanel);
      sync(); opening = false;
    };
    const delayClose = (event, focus = false) => {
      cancelClose();
      if ((focus ? inFocusControls : inControls)(event.relatedTarget)) return;
      timer = setTimeout(() => {
        timer = null;
        // Portal moves can omit pointerleave; cached hover sets then get stuck.
        if (!shell.matches(':hover') && !panel.matches(':hover') && !(keyboardOwned && inFocusControls(document.activeElement))) close();
      }, 80);
    };
    const setMode = value => {
      if (!Object.hasOwn(MODES, value) || destroyed) return;
      const focused = panel.contains(document.activeElement) ? document.activeElement : null;
      close(); mode = value; saveMode(page, mode); sync();
      if (focused && mode === 'expanded') focused.focus({ preventScroll: true });
      else if (focused && mode === 'collapsed') buttons[1].focus({ preventScroll: true });
      if (mode === 'floating') open();
    };
    buttons.forEach(button => listen(button, 'click', () => setMode(button.dataset.listingMode)));
    const firstFilter = () => panel.querySelector('button, input, select, textarea, a[href], [tabindex="0"]');
    listen(modes, 'keydown', event => {
      keyboardOwned = true;
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
      else if (event.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else if (event.key === 'Tab' && !event.shiftKey && mode === 'floating' && closeLayer && index === 2) {
        event.preventDefault(); (firstFilter() || panel).focus(); return;
      } else return;
      event.preventDefault(); buttons[next].focus(); setMode(buttons[next].dataset.listingMode);
    });
    listen(panel, 'keydown', event => {
      keyboardOwned = true;
      if (event.key === 'Tab' && event.shiftKey && mode === 'floating' &&
          (document.activeElement === panel || document.activeElement === firstFilter())) {
        event.preventDefault(); trigger.focus();
      }
    });
    // Distinguish mouse focus from keyboard ownership: clicking a mode must not
    // pin its popup forever, while keyboard users can tab into the conditions.
    for (const node of [shell, panel]) listen(node, 'pointerdown', () => {
      keyboardOwned = false; pointerFocus = true;
      clearTimeout(pointerFocusTimer);
      pointerFocusTimer = setTimeout(() => { pointerFocus = false; }, 0);
    });
    // Header padding/search/whitespace + portal are one pointer
    // union. Search keyboard focus alone neither opens nor owns the popup.
    listen(searchSlot, 'focusin', () => { keyboardOwned = false; });
    for (const element of [shell, panel]) {
      listen(element, 'pointerenter', event => {
        if (event.pointerType !== 'touch') open();
      });
      listen(element, 'pointerleave', delayClose);
    }
    for (const element of [modes, panel]) {
      listen(element, 'focusin', () => { if (!restoring && !pointerFocus) keyboardOwned = true; open(); });
      listen(element, 'focusout', event => { if (!inFocusControls(event.relatedTarget)) keyboardOwned = false; delayClose(event, true); });
    }
    // Font changes can move an anchor without resize; close rather than detach.
    listen(window, 'appfontchange', close);
    const destroy = () => {
      if (destroyed) return;
      destroyed = true; close(); clearTimeout(pointerFocusTimer); disposers.forEach(dispose => dispose()); unregister();
    };
    const unregister = CommonUI.registerCleanup(shell, destroy);
    sync();
    return { shell, bar, modes, trigger, searchSlot, panel, getMode: () => mode, setMode, open, close, destroy };
  }

  /** Adjacent buttons, always visible beside the learner title (no popup/menu). */
  function mountStyleSwitch(host, value, onChange) {
    host.classList.add('listing-style-switch');
    host.setAttribute('role', 'group'); host.setAttribute('aria-label', '精灵列表样式');
    const buttons = [];
    const update = () => {
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.style === value));
    };
    const select = key => {
      if (value === key) return;
      value = key; update(); onChange(key);
    };
    const disposers = [];
    for (const [key, label] of [['default', '默认'], ['table', '表格']]) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label; button.dataset.style = key;
      const click = () => select(key);
      button.addEventListener('click', click);
      disposers.push(() => button.removeEventListener('click', click));
      buttons.push(button); host.appendChild(button);
    }
    const onKey = event => {
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      let next;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = 1 - index;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = 1;
      else return;
      event.preventDefault(); buttons[next].focus(); select(buttons[next].dataset.style);
    };
    host.addEventListener('keydown', onKey); update();
    const unregister = CommonUI.registerCleanup(host, () => {
      disposers.forEach(dispose => dispose()); host.removeEventListener('keydown', onKey); unregister();
    });
  }

  // One window listener for all live list/detail owners; registrations replace, not stack.
  const statsSubscribers = new Map();
  function dispatchStatsRefresh() {
    for (const [owner, subscription] of [...statsSubscribers]) {
      if (!owner.isConnected) subscription.dispose();
      else subscription.refresh();
    }
  }
  function onStatsChange(owner, refresh) {
    statsSubscribers.get(owner)?.dispose();
    if (!statsSubscribers.size) window.addEventListener('appstatspreferenceschange', dispatchStatsRefresh);
    const subscription = { refresh, dispose: () => {
      if (statsSubscribers.get(owner) !== subscription) return;
      statsSubscribers.delete(owner); unregister();
      if (!statsSubscribers.size) window.removeEventListener('appstatspreferenceschange', dispatchStatsRefresh);
    } };
    const unregister = CommonUI.registerCleanup(owner, subscription.dispose);
    statsSubscribers.set(owner, subscription);
    return subscription.dispose;
  }
  return Object.freeze({ STAT_COLUMNS, statValue, sortMonsters, nextSort, uniqueMonsters,
    statHeaders, statCells, monsterTable, prioritizeMonsters, mountAttributePriority, mountFilters, mountStyleSwitch, onStatsChange });
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ListingUI;
