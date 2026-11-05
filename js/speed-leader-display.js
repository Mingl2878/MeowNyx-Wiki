/* Shared explicit search choice for same-speed advanced/leader avatars only. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpeedLeaderDisplay = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const KEY = 'rk_speed_form_overrides';
  // Existing ordinary-form keys contain pipes; this namespace cannot collide.
  const groupKey = (advancedId, speed) => `leader:${advancedId}:${speed}`;
  const id = n => Number.isSafeInteger(n) && n > 0;
  // The existing form-preference schema also admits quoted decimal IDs.
  const selectedId = value => {
    const n = typeof value === 'string' && /^\+?\d+$/.test(value) ? Number(value) : value;
    return id(n) ? n : null;
  };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const leader = pet => pet?.is_leader_form === true || pet?.evolution_stage === '首领形态';
  let fallbackChoices = {};

  function groups(monsters) {
    const list = Array.isArray(monsters) ? monsters : [];
    const byId = new Map(list.filter(pet => id(pet?.id)).map(pet => [pet.id, pet]));
    const found = new Map();
    for (const pet of list) {
      if (!id(pet?.id) || !leader(pet) || pet.hidden || !id(pet.leader_of_id) || pet.leader_of_id === pet.id) continue;
      const advanced = byId.get(pet.leader_of_id);
      if (!advanced || advanced.hidden || leader(advanced) || advanced.evolution_stage !== '高级形态') continue;
      if (!Number.isFinite(pet.base_spd) || pet.base_spd <= 0 || pet.base_spd !== advanced.base_spd) continue;
      const key = groupKey(advanced.id, advanced.base_spd);
      if (!found.has(key)) found.set(key, { key, advancedId: advanced.id, memberIds: [advanced.id] });
      const group = found.get(key);
      if (!group.memberIds.includes(pet.id)) group.memberIds.push(pet.id);
    }
    return [...found.values()];
  }

  function choices() {
    if (root.UserConfig?.getObject) {
      const value = root.UserConfig.getObject(KEY, {});
      return object(value) ? value : {};
    }
    try {
      const saved = JSON.parse(root.localStorage?.getItem(KEY) || '{}');
      return { ...(object(saved) ? saved : {}), ...fallbackChoices };
    } catch (_) { return { ...fallbackChoices }; }
  }

  function display(monsters) {
    const saved = choices();
    const visible = new Set((Array.isArray(monsters) ? monsters : []).filter(pet => id(pet?.id)).map(pet => pet.id));
    const preferred = new Set();
    for (const group of groups(monsters)) {
      const requested = selectedId(saved[group.key]);
      const selected = id(requested) && group.memberIds.includes(requested) ? requested : group.advancedId;
      preferred.add(selected);
      for (const member of group.memberIds) if (member !== selected) visible.delete(member);
    }
    return { visible, preferred };
  }
  function visibleIds(monsters) { return display(monsters).visible; }
  function preferredIds(monsters) { return display(monsters).preferred; }

  function recordSearch(pet, monsters) {
    if (!id(pet?.id)) return Promise.resolve(false);
    const group = groups(monsters).find(group => group.memberIds.includes(pet.id));
    if (!group) return Promise.resolve(false);
    const saved = choices();
    if (selectedId(saved[group.key]) === pet.id) return Promise.resolve(true);
    const fields = { [group.key]: pet.id };
    if (root.UserConfig?.patch) {
      // UserConfig synchronously queues its optimistic draft; both pages immediately
      // read that same draft, including during failed-save retry/close waiting.
      return Promise.resolve(root.UserConfig.patch(KEY, fields)).catch(error => {
        root.console?.warn?.('速度显示选择未保存', error);
        return false;
      });
    }
    // Static-preview fallback only. Never keep a second override layer over the
    // native UserConfig authority, or an older page could win over a newer choice.
    fallbackChoices = { ...fallbackChoices, ...fields };
    try {
      if (typeof root.localStorage?.setItem !== 'function') throw Error('本地存储不可用');
      root.localStorage.setItem(KEY, JSON.stringify({ ...saved, ...fields }));
      fallbackChoices = {}; // Successful storage must not be shadowed by an older memory copy.
      return Promise.resolve(true);
    } catch (error) {
      root.console?.warn?.('速度显示选择仅在本次会话保留', error);
      return Promise.resolve(false);
    }
  }
  return Object.freeze({ groups, visibleIds, preferredIds, recordSearch });
});
