/* Shared favorites. Damage owns A; chart owns B. No pet configuration is written here. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FavoritePets = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const DAMAGE_KEY = 'rk_fav_pets', CHART_KEY = 'rk_chart_fav_pets';
  const listeners = new Set();
  const normalizeId = id => (typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id)))
    && Number.isSafeInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
  function readIds(key) {
    try {
      const data = JSON.parse(root.localStorage.getItem(key) || '[]');
      return Array.isArray(data) ? [...new Set(data.map(normalizeId).filter(id => id !== null))] : [];
    } catch (_) { return []; }
  }
  const getDamageIds = () => readIds(DAMAGE_KEY);
  const getChartIds = () => readIds(CHART_KEY);
  function getUnion() {
    const a = getDamageIds(), b = getChartIds(), aa = new Set(a), bb = new Set(b);
    return [...new Set([...a, ...b])].map(id => ({ id, fromDamage: aa.has(id), fromChart: bb.has(id) }));
  }
  // Source identity is separate from pet identity. Keep getUnion/subscriber payloads compatible.
  function getEntries() {
    return [
      ...getDamageIds().map(id => ({ id, key: `A:${id}`, fromDamage: true, fromChart: false })),
      ...getChartIds().map(id => ({ id, key: `B:${id}`, fromDamage: false, fromChart: true }))
    ];
  }
  function notify() {
    // A broken subscriber must not prevent the remaining views from refreshing.
    for (const listener of [...listeners]) {
      try { listener(getUnion()); } catch (error) { root.console?.error('FavoritePets subscriber:', error); }
    }
  }
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function writeChart(ids) {
    try { root.localStorage.setItem(CHART_KEY, JSON.stringify(ids)); }
    catch (_) { return false; }
    notify();
    return true;
  }
  function addChart(id) {
    id = normalizeId(id);
    if (id === null) return false;
    const ids = getChartIds();
    return ids.includes(id) || writeChart([...ids, id]);
  }
  function removeChart(id) {
    id = normalizeId(id);
    if (id === null) return false; // Only B is edited; an overlapping A entry remains in the union.
    const ids = getChartIds();
    return !ids.includes(id) || writeChart(ids.filter(value => value !== id));
  }
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function avatarUrl(pet) {
    if (!pet?.image) return '';
    // RKData appends ?v=... to image filenames. Encode only the path, not its cache-busting query.
    const image = String(pet.image), split = image.indexOf('?');
    const pathname = split < 0 ? image : image.slice(0, split);
    const query = split < 0 ? '' : image.slice(split);
    return 'assets/monster/images/' + pathname.split('/').map(encodeURIComponent).join('/') + query;
  }
  // Unstyled, escaped markup: callers own their wrapper/layout. No global image cache.
  function avatarHTML(pet, name = '') {
    const url = avatarUrl(pet);
    return url ? `<img src="${escapeHTML(url)}" alt="${escapeHTML(name)}" width="32" height="32" loading="lazy" decoding="async">`
      : `<span role="img" aria-label="${escapeHTML(name || '无图')}">◉</span>`;
  }
  root.addEventListener?.('storage', event => {
    if (event.key === null || [DAMAGE_KEY, CHART_KEY, 'rk_pet_configs'].includes(event.key)) notify();
  });
  return Object.freeze({ getDamageIds, getChartIds, getUnion, getEntries, addChart, removeChart, notify, subscribe, avatarUrl, avatarHTML, escapeHTML });
});
