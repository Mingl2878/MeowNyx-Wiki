/* Curve-owned groups and controls. The only legacy import is rk_chart_fav_pets.
 * No damage favorites, personal defaults, nature or IV records are read here. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = { createStore: factory };
  else root.ChartWorkspace = factory(root);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const KEY = 'rk_chart_workspace', UNGROUPED = 'ungrouped', ALL = 'all';
  // Reserved namespace cannot collide with user group IDs (which exclude ':').
  const PRESET_PREFIX = 'preset:';
  const PRESET_TYPES = ['Normal', 'Grass', 'Fire', 'Water', 'Light', 'Ground', 'Ice', 'Dragon', 'Electric', 'Poison', 'Bug', 'Fighting', 'Flying', 'Cute', 'Ghost', 'Dark', 'Mechanical', 'Illusion'];
  const PRESET_NAMES = ['普通', '草', '火', '水', '光', '地', '冰', '龙', '电', '毒', '虫', '武', '翼', '萌', '幽', '恶', '机械', '幻'];
  const isPreset = id => typeof id === 'string' && id.startsWith(PRESET_PREFIX);
  const validPreset = id => isPreset(id) && PRESET_TYPES.includes(id.slice(PRESET_PREFIX.length));
  const dataSource = () => root.RKData || (typeof RKData !== 'undefined' ? RKData : null);
  function getPresets() {
    const order = dataSource()?.PILL_ORDER || PRESET_TYPES;
    return order.filter(type => PRESET_TYPES.includes(type)).map(type => ({ id: PRESET_PREFIX + type, type,
      name: '所有' + PRESET_NAMES[PRESET_TYPES.indexOf(type)] + '系精灵', readonly: true }));
  }
  function getPreset(id) {
    if (!validPreset(id)) throw Error('预设分组不存在，请选择有效属性；已保存配置未修改');
    const type = id.slice(PRESET_PREFIX.length), seen = new Set();
    const pets = dataSource()?.getMonsters?.();
    if (!Array.isArray(pets)) throw Error('精灵资料尚未加载，预设分组暂不可用');
    const petIds = [];
    for (const pet of pets) {
      if (!pet || pet.hidden || pet.evolution_stage !== '高级形态' || pet.is_leader_form
        || !['主形态', '无多形态'].includes(pet.form_category)
        || (pet.main_type?.name !== type && pet.sub_type?.name !== type)
        || !petOK(pet.id) || seen.has(pet.id)) continue;
      seen.add(pet.id); petIds.push(pet.id);
    }
    return { id, type, name: '所有' + PRESET_NAMES[PRESET_TYPES.indexOf(type)] + '系精灵', petIds, readonly: true };
  }
  const editable = id => { if (isPreset(id)) throw Error('内置预设自动更新且只读，请先复制为自建分组'); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const idOK = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id) && !['__proto__', 'constructor', 'prototype', ALL].includes(id);
  const petOK = id => Number.isSafeInteger(id) && id > 0;
  const defaults = () => ({ version: 1, activeGroupId: UNGROUPED,
    groups: [{ id: UNGROUPED, name: '未分组', petIds: [] }],
    controls: { atkIV: { attack: true, magic_attack: true }, atkNature: { attack: 0, magic_attack: 0 },
      defIV: { defense: true, magic_defense: true }, doubleLife: false }, legacyImported: true });
  function validate(input) {
    if (!object(input) || input.version !== 1 || !Array.isArray(input.groups) || !object(input.controls)
      || input.legacyImported !== true) throw Error('曲线配置格式或版本不支持，旧文件未修改');
    const state = clone(input), seen = new Set();
    for (const g of state.groups) {
      if (!object(g) || !idOK(g.id) || seen.has(g.id) || typeof g.name !== 'string' || !g.name.trim()
        || g.name.length > 80 || !Array.isArray(g.petIds) || !g.petIds.every(petOK)
        || new Set(g.petIds).size !== g.petIds.length) throw Error('曲线分组数据无效，旧文件未修改');
      seen.add(g.id);
    }
    if (!seen.has(UNGROUPED)) state.groups.unshift({ id: UNGROUPED, name: '未分组', petIds: [] });
    if (state.activeGroupId !== ALL && !validPreset(state.activeGroupId) && !state.groups.some(g => g.id === state.activeGroupId)) throw Error('当前曲线分组不存在（或预设已失效），已保存配置未修改');
    const c = state.controls;
    for (const [field, keys] of Object.entries({ atkIV: ['attack', 'magic_attack'], atkNature: ['attack', 'magic_attack'], defIV: ['defense', 'magic_defense'] })) {
      if (!object(c[field]) || !keys.every(k => field === 'atkNature' ? [0, 1, 2].includes(c[field][k]) : typeof c[field][k] === 'boolean')) throw Error('曲线控件配置无效');
    }
    if (typeof c.doubleLife !== 'boolean') throw Error('曲线双生命配置无效');
    return state;
  }
  let state = defaults(), initialized = false, initializing = null, serial = Promise.resolve(), error = '', pendingInitial = null, pendingWrite = null;
  const listeners = new Set();
  function notify() { for (const fn of listeners) { try { fn(clone(state)); } catch (e) { root.console?.error(e); } } }
  async function persist(next) {
    try {
      if (root.UserConfig) {
        if (typeof root.UserConfig.patch !== 'function') throw Error('共享配置组件不完整');
        if (await root.UserConfig.patch(KEY, { state: clone(next) }) !== true) throw Error('曲线配置未保存，请先重试；界面保留上次已保存状态');
      } else {
        if (!root.localStorage) throw Error('没有可用的曲线存储');
        root.localStorage.setItem(KEY, JSON.stringify({ state: next }));
      }
      pendingWrite = null;
    } catch (e) { pendingWrite = clone(next); throw e; }
  }
  function adoptCommitted() {
    const status = root.UserConfig?.getStatus?.();
    // getObject overlays queued drafts. Read it only when ALL pending writes have
    // committed; this also handles the global retry button, not just our own retry.
    if (!status?.ready || status.pending !== 0 || status.error) return;
    try {
      const saved = root.UserConfig.getObject(KEY, {});
      if (!Object.hasOwn(saved, 'state')) return;
      const next = validate(saved.state), changed = !initialized || JSON.stringify(state) !== JSON.stringify(next);
      state = next; initialized = true; pendingInitial = pendingWrite = null; error = '';
      if (changed) notify();
    } catch (e) { error = e.message; }
  }
  const onCommitted = event => {
    // A later group's final write may drain the queue after our key committed.
    // On any successful final event, adopt this key's now-committed value.
    if (event?.detail?.keys?.length) adoptCommitted();
  };
  root.addEventListener?.('userconfigchange', onCommitted);
  function retry() {
    const run = serial.catch(() => {}).then(async () => {
      if (!pendingWrite) { adoptCommitted(); if (!initialized) return init(); return clone(state); }
      if (root.UserConfig?.retry && root.UserConfig.getStatus?.().pending > 0) {
        if (await root.UserConfig.retry() !== true) throw Error('曲线配置仍未保存，请重试');
        adoptCommitted();
        if (pendingWrite) throw Error('尚未收到已提交的曲线配置');
        return clone(state);
      }
      const next = clone(pendingWrite);
      await persist(next);
      state = next; pendingInitial = null; initialized = true; error = ''; notify(); return clone(state);
    });
    serial = run; return run.catch(e => { error = e.message; throw e; });
  }
  async function init() {
    if (initialized) return clone(state);
    if (initializing) return initializing;
    initializing = (async () => {
      // UserConfig may expose a failed draft through getObject. A failed first
      // migration must actually retry its write, never adopt that draft as committed.
      if (pendingInitial) {
        if (root.UserConfig?.retry && root.UserConfig.getStatus?.().pending > 0) {
          if (await root.UserConfig.retry() !== true) throw Error('曲线初始配置仍未保存，请重试');
          adoptCommitted();
          if (pendingInitial) throw Error('尚未收到已提交的曲线初始配置');
          return clone(state);
        }
        await persist(pendingInitial);
        state = pendingInitial; pendingInitial = null; initialized = true; error = ''; notify(); return clone(state);
      }
      let saved;
      if (root.UserConfig) {
        if (typeof root.UserConfig.getObject !== 'function') throw Error('共享配置组件不完整');
        saved = root.UserConfig.getObject(KEY, {});
      } else {
        const raw = root.localStorage?.getItem(KEY);
        saved = raw == null ? {} : JSON.parse(raw);
      }
      if (!object(saved)) throw Error('曲线存储格式无效');
      let next;
      if (Object.hasOwn(saved, 'state')) next = validate(saved.state);
      else {
        next = defaults();
        const raw = root.localStorage?.getItem('rk_chart_fav_pets');
        if (raw != null) {
          const ids = JSON.parse(raw);
          if (!Array.isArray(ids)) throw Error('旧曲线收藏格式无效，尚未迁移');
          next.groups[0].petIds = [...new Set(ids.map(Number).filter(petOK))];
        }
        pendingInitial = next;
        await persist(next); // Commit migration even if empty: never resurrect old B on reload.
        pendingInitial = null;
      }
      state = next; initialized = true; error = ''; notify(); return clone(state);
    })().catch(e => { error = e.message; throw e; }).finally(() => { initializing = null; });
    return initializing;
  }
  function transact(change) {
    const run = serial.catch(() => {}).then(async () => {
      if (pendingWrite) { adoptCommitted(); if (pendingWrite) throw Error('上一次曲线修改尚未保存，请先重试保存'); }
      await init();
      const next = clone(state), result = change(next);
      const checked = validate(next);
      await persist(checked); // No optimistic UI adoption, including active group/controls.
      state = checked; error = ''; notify(); return result;
    });
    serial = run;
    return run.catch(e => { error = e.message; throw e; });
  }
  const group = (s, id) => { editable(id); const found = s.groups.find(g => g.id === id); if (!found) throw Error('分组不存在'); return found; };
  const name = text => { if (typeof text !== 'string' || !text.trim() || text.trim().length > 80) throw Error('分组名称应为1至80字'); return text.trim(); };
  let counter = 0;
  const freshId = s => { let id; do { id = 'g_' + Date.now().toString(36) + '_' + (++counter).toString(36); } while (s.groups.some(g => g.id === id)); return id; };
  function entries() {
    if (isPreset(state.activeGroupId)) return getPreset(state.activeGroupId).petIds.map(id => ({ id, key: `chart:${id}` }));
    const groups = state.activeGroupId === ALL ? state.groups : state.groups.filter(g => g.id === state.activeGroupId);
    return [...new Set(groups.flatMap(g => g.petIds))].map(id => ({ id, key: `chart:${id}` }));
  }
  return Object.freeze({ init, retry, defaults, validate, isPreset, getPresets, getPreset, getState: () => clone(state), getEntries: entries,
    getStatus: () => ({ initialized, error, pendingWrite: !!pendingWrite }),
    dispose() { root.removeEventListener?.('userconfigchange', onCommitted); listeners.clear(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    selectGroup: id => transact(s => { if (isPreset(id)) getPreset(id); else if (id !== ALL) group(s, id); s.activeGroupId = id; }),
    createGroup: text => transact(s => { const id = freshId(s); s.groups.push({ id, name: name(text), petIds: [] }); s.activeGroupId = id; return id; }),
    renameGroup: (id, text) => transact(s => { if (id === UNGROUPED) throw Error('未分组名称固定'); group(s, id).name = name(text); }),
    orderGroup: (id, delta) => transact(s => {
      if (id === UNGROUPED) return;
      group(s, id); const index = s.groups.findIndex(g => g.id === id), target = index + Math.sign(delta);
      if (target < 0 || target >= s.groups.length || s.groups[target].id === UNGROUPED) return;
      [s.groups[index], s.groups[target]] = [s.groups[target], s.groups[index]];
    }),
    copyGroup: (id, text) => transact(s => {
      const original = isPreset(id) ? getPreset(id) : group(s, id), newId = freshId(s);
      s.groups.push({ id: newId, name: name(text), petIds: [...original.petIds] }); s.activeGroupId = newId; return newId;
    }),
    deleteGroup: id => transact(s => {
      if (id === UNGROUPED) throw Error('不能删除未分组');
      const removed = group(s, id), ungrouped = group(s, UNGROUPED);
      ungrouped.petIds = [...new Set([...ungrouped.petIds, ...removed.petIds])];
      s.groups = s.groups.filter(g => g.id !== id);
      if (s.activeGroupId === id) s.activeGroupId = UNGROUPED;
    }),
    addPet: (id, groupId) => transact(s => {
      editable(s.activeGroupId);
      if (!petOK(id)) throw Error('精灵ID无效');
      const target = group(s, groupId || (s.activeGroupId === ALL ? UNGROUPED : s.activeGroupId));
      if (!target.petIds.includes(id)) target.petIds.push(id);
    }),
    movePet: (id, groupId, sourceId) => transact(s => {
      editable(s.activeGroupId);
      const source = group(s, sourceId || s.activeGroupId), target = group(s, groupId);
      if (!petOK(id) || !source.petIds.includes(id)) throw Error('来源分组中没有该精灵');
      source.petIds = source.petIds.filter(p => p !== id);
      if (!target.petIds.includes(id)) target.petIds.push(id);
    }),
    removePet: id => transact(s => { editable(s.activeGroupId); if (!petOK(id)) throw Error('精灵ID无效'); for (const g of s.groups) g.petIds = g.petIds.filter(p => p !== id); }),
    setControls: patch => transact(s => {
      for (const field of ['atkIV', 'atkNature', 'defIV']) if (Object.hasOwn(patch, field)) s.controls[field] = { ...s.controls[field], ...patch[field] };
      if (Object.hasOwn(patch, 'doubleLife')) s.controls.doubleLife = patch.doubleLife;
    })
  });
});
