/* Damage selection order for speed display, independent of the quick history UI. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DamageSpeedPriority = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const KEY = 'rk_damage_view', FIELD = 'speedPriority', LIMIT = 16;
  const validId = id => Number.isSafeInteger(id) && id > 0 && id !== 9001;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validList = value => Array.isArray(value) && value.length <= LIMIT && value.every(validId) && new Set(value).size === value.length;
  const native = () => typeof root.UserConfig?.getObject === 'function';
  let fallbackDraft = null;

  function section() {
    const value = native() ? root.UserConfig.getObject(KEY, {}) : JSON.parse(root.localStorage?.getItem(KEY) || '{}');
    if (!object(value)) throw Error('伤害页共享配置格式无效');
    return value;
  }
  function legacyIds(history) {
    if (!Array.isArray(history)) return [];
    return [...new Set(history.filter(id => typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id)))
      .map(Number).filter(validId))].slice(0, LIMIT);
  }
  function read(legacyHistory = []) {
    if (!native() && fallbackDraft !== null) return fallbackDraft.slice();
    try {
      const value = section()[FIELD];
      if (validList(value)) return value.slice(); // An explicit [] is not a missing record.
    } catch (_) { /* A read cannot erase or migrate an unavailable/corrupt record. */ }
    return legacyIds(legacyHistory);
  }
  function record(pet, legacyHistory = []) {
    if (!validId(pet?.id)) return Promise.resolve(false);
    const next = [pet.id, ...read(legacyHistory).filter(id => id !== pet.id)].slice(0, LIMIT);
    if (!native()) fallbackDraft = next;
    try {
      const current = section(), previous = current[FIELD];
      if (validList(previous) && previous.length === next.length && previous.every((id, i) => id === next[i])) {
        if (!native()) fallbackDraft = null;
        return Promise.resolve(true);
      }
      if (native()) {
        // UserConfig exposes queued fields synchronously and owns failure/retry/close
        // handling. Never shadow that authority with another page-local order.
        return Promise.resolve(root.UserConfig.patch(KEY, { [FIELD]: next })).catch(error => {
          root.console?.warn?.('速度展示优先记录未保存', error);
          return false;
        });
      }
      if (typeof root.localStorage?.setItem !== 'function') throw Error('本地存储不可用');
      root.localStorage.setItem(KEY, JSON.stringify({ ...current, [FIELD]: next }));
      fallbackDraft = null;
      return Promise.resolve(true);
    } catch (error) {
      root.console?.warn?.('速度展示优先记录未保存', error);
      return Promise.resolve(false);
    }
  }
  return Object.freeze({ read, record, limit: LIMIT });
});
