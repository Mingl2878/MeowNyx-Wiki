/* Level UI policy. Pure data helpers; never writes player or source records. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetLevels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  const LEGACY_STEPS = Object.freeze([1, 9, 19, 29, 39, 49, 59, 69, 79, 89, 99]);
  const familyCache = new WeakMap();
  function traitHasLevel(pet) {
    const trait = pet?.trait?.localized?.zh;
    return /等级/.test((trait?.name || '') + ' ' + (trait?.description || ''));
  }
  function config(pet) {
    const enabled = pet?.level_configurable === true || traitHasLevel(pet);
    const min = integer(pet?.level_min, 1, 99) ? pet.level_min : 1;
    const max = integer(pet?.level_max, min, 99) ? pet.level_max : 99;
    const defaultLevel = integer(pet?.default_level, min, max) ? pet.default_level : Math.min(max, Math.max(min, pet?.id === 619 ? 99 : 60));
    const step = integer(pet?.level_step, 1, 98) ? pet.level_step : pet?.id === 619 ? 10 : 1;
    return { enabled, min, max, step, defaultLevel };
  }
  // Default is an exact usable point even when it is off the min-based grid.
  // Step out from it, retaining both range endpoints (short endpoint intervals).
  function steps(settings) {
    const { min, max, step, defaultLevel } = settings;
    if (!integer(min, 1, 99) || !integer(max, min, 99) || !integer(step, 1, 98) || !integer(defaultLevel, min, max)) throw Error('无效等级范围、步进或默认等级');
    const values = new Set([min, max, defaultLevel]);
    for (let n = defaultLevel - step; n > min; n -= step) values.add(n);
    for (let n = defaultLevel + step; n < max; n += step) values.add(n);
    return [...values].sort((a, b) => a - b);
  }
  function isWolf(pet, monsters = []) {
    if (!pet) return false;
    // Stable identity, then explicit ordinary/leader/form links only. No dex/name guessing.
    if (!familyCache.has(monsters)) {
      const links = new Map();
      for (const m of monsters) {
        if (!links.has(m.id)) links.set(m.id, []);
        for (const parent of [m.evolves_from_id, m.leader_of_id, m.main_form_id]) if (Number.isInteger(parent) && parent > 0) {
          links.get(m.id).push(parent);
          if (!links.has(parent)) links.set(parent, []);
          links.get(parent).push(m.id);
        }
      }
      const ids = new Set([595]), queue = [595];
      for (let i = 0; i < queue.length; i++) for (const id of links.get(queue[i]) || []) if (!ids.has(id)) { ids.add(id); queue.push(id); }
      familyCache.set(monsters, ids);
    }
    return familyCache.get(monsters).has(pet.id);
  }
  function wolfConfig(mode) {
    if (mode === 'ming') return { enabled: true, min: 1, max: 99, step: 10, defaultLevel: 99 };
    if (mode === 'abu') return { enabled: true, min: 60, max: 99, step: 2, defaultLevel: 60 };
    return { enabled: false, min: 60, max: 60, step: 1, defaultLevel: 60 };
  }
  return { config, steps, traitHasLevel, isWolf, wolfConfig, LEGACY_STEPS };
});
