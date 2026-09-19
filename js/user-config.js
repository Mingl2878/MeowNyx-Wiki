/* Shared AppData configuration. localStorage is a compatibility cache, not the durable authority. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UserConfig = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const KEYS = Object.freeze(['rk_pet_configs', 'rk_speed_pet_priority', 'rk_speed_form_overrides', 'rk_damage_selection', 'rk_damage_skill_configs', 'rk_damage_view', 'rk_chart_workspace']);
  // rk_speed_view is intentionally not read, cached or imported by this client.
  const UPGRADE_KEYS = new Set(['rk_damage_skill_configs', 'rk_damage_view', 'rk_chart_workspace']);
  const keySet = new Set(KEYS), forbidden = new Set(['__proto__', 'prototype', 'constructor']);
  const clone = value => JSON.parse(JSON.stringify(value));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  let committed = {}, queue = [], ready = false, initializing = null, running = null;
  let failure = '', cacheWarning = false, statusNode = null, statusText = null, retryButton = null, lastSettingsResult = {};
  function cache(key) {
    try {
      const value = JSON.parse(root.localStorage?.getItem(key) || 'null');
      return object(value) ? value : null;
    } catch (_) { return null; }
  }
  function apply(base, fields, deleteNull = false) {
    const out = { ...base };
    for (const [key, value] of Object.entries(fields)) {
      if (forbidden.has(key)) throw Error('无效的配置字段');
      if (value === null && deleteNull) delete out[key]; else out[key] = clone(value);
    }
    return out;
  }
  function getObject(key, fallback = {}) {
    if (!keySet.has(key)) return clone(fallback);
    let value = committed[key] || fallback;
    for (const item of queue) if (item.key === key) value = apply(value, item.fields, key === 'rk_speed_form_overrides');
    return clone(value);
  }
  function updateStatus() {
    if (!root.document?.body || !root.document.createElement) return;
    if (!statusNode) {
      statusNode = root.document.createElement('div'); statusNode.className = 'user-config-status';
      statusNode.setAttribute('role', 'status'); statusNode.setAttribute('aria-live', 'polite');
      statusText = root.document.createElement('span');
      retryButton = root.document.createElement('button'); retryButton.type = 'button'; retryButton.textContent = '重试保存';
      retryButton.addEventListener('click', () => retry());
      statusNode.append(statusText, retryButton); root.document.body.appendChild(statusNode);
    }
    const pending = queue.length > 0;
    statusNode.hidden = !failure && !pending && !cacheWarning;
    statusNode.dataset.state = failure ? 'error' : pending ? 'pending' : 'warning';
    statusText.textContent = failure ? `共享个人配置未保存：${failure}。旧记录未被清空，请重试。`
      : pending ? '正在保存个人配置，请稍候再退出…' : '共享配置可用，但本地缓存不可用。';
    retryButton.hidden = !failure;
  }
  function emitChange(keys) {
    if (root.dispatchEvent && root.CustomEvent) root.dispatchEvent(new root.CustomEvent('userconfigchange', { detail: { keys } }));
  }
  function adopt(data) {
    if (!object(data)) throw Error('共享配置响应无效');
    for (const key of KEYS) {
      if (!Object.hasOwn(data, key)) {
        committed[key] = {};
        try { root.localStorage?.setItem(key, '{}'); } catch (_) { cacheWarning = true; }
        continue;
      }
      if (!object(data[key])) throw Error('共享配置结构无效：' + key);
      committed[key] = clone(data[key]);
      try { root.localStorage?.setItem(key, JSON.stringify(data[key])); }
      catch (_) { cacheWarning = true; }
    }
  }
  async function request(body, endpoint = '/api/user-config') {
    const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    const timer = controller ? root.setTimeout(() => controller.abort(), 10000) : null;
    try {
      const response = await root.fetch(endpoint, body === undefined
        ? { cache: 'no-store', signal: controller?.signal }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller?.signal });
      const data = await response.json();
      if (!response.ok || !data || data.ok !== true || (endpoint === '/api/user-config' && !object(data.data))) throw Error(data?.error || '服务不可用或版本不支持共享配置');
      return data;
    } finally { if (timer !== null) root.clearTimeout(timer); }
  }
  async function init() {
    if (ready) return true;
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        let response = await request();
        const legacy = {};
        for (const key of KEYS) {
          const upgrade = UPGRADE_KEYS.has(key);
          if (upgrade ? response.legacy_imported_keys?.[key] === true : response.legacy_imported) continue;
          // Empty upgrades must be marked too, so stale origins cannot revive deleted values.
          if (upgrade) legacy[key] = {};
          const old = cache(key);
          let raw;
          try { raw = root.localStorage?.getItem(key); } catch (_) { cacheWarning = true; }
          if (raw && !old && !Object.hasOwn(response.data, key)) throw Error('旧配置无法解析：' + key + '，未覆盖原记录');
          if (!old || !Object.keys(old).length) continue;
          const missing = Object.fromEntries(Object.entries(old).filter(([entry]) => !forbidden.has(entry) && !Object.hasOwn(response.data[key] || {}, entry)));
          if (Object.keys(missing).length) legacy[key] = missing;
        }
        // One-time import fills missing entries; never resurrect deleted records on every reload.
        if (Object.keys(legacy).length) response = await request({ import: legacy });
        adopt(response.data); ready = true; failure = ''; emitChange(KEYS); updateStatus();
        if (queue.length) void pump();
        return true;
      } catch (error) {
        failure = error.message || String(error); ready = false;
        for (const item of queue) item.resolve(false);
        updateStatus(); return false;
      } finally { initializing = null; }
    })();
    return initializing;
  }
  async function pump() {
    if (running) return running;
    running = (async () => {
      if (!ready || failure) return false;
      while (queue.length) {
        const item = queue[0];
        try {
          const response = item.key === '@settings' ? await request(item.fields, '/api/settings')
            : item.key === '@petDefaults' ? await request({ reset_pet_defaults: true })
            : item.key === '@petClear' ? await request({ clear_pet_configs: item.fields.ids })
            : await request({ patch: { [item.key]: item.fields } });
          if (item.key !== '@settings') adopt(response.data);
          else lastSettingsResult = clone(response);
          queue.shift(); item.resolve(true);
          const petOperation = item.key === '@petDefaults' || item.key === '@petClear';
          emitChange([petOperation ? 'rk_pet_configs' : item.key]);
          if (petOperation && root.dispatchEvent && root.CustomEvent) {
            root.dispatchEvent(new root.CustomEvent('petdefaultsreset', { detail: { operation: item.key === '@petClear' ? 'clear' : 'defaults' } }));
          }
        } catch (error) {
          failure = error.message || String(error);
          // Retain unsaved operations for explicit retry; do not claim they were committed.
          for (const waiting of queue) waiting.resolve(false);
          updateStatus(); return false;
        }
        updateStatus();
      }
      return true;
    })();
    try { return await running; } finally {
      running = null;
      if (queue.length && ready && !failure) void pump();
    }
  }
  function enqueue(key, fields, explicitRetry = false) {
    if ((!keySet.has(key) && key !== '@settings' && key !== '@petDefaults' && key !== '@petClear') || !object(fields) || Object.keys(fields).some(k => forbidden.has(k))) {
      failure = '无效的个人配置更新'; updateStatus(); return Promise.resolve(false);
    }
    if (!Object.keys(fields).length) return Promise.resolve(true);
    if (failure && !running) {
      // Newer edits supersede failed values in the same section, while retaining other pending fields.
      const previous = queue.filter(item => item.key === key);
      fields = Object.assign({}, ...previous.map(item => item.fields), fields);
      for (const item of previous) item.resolve(false);
      queue = queue.filter(item => item.key !== key);
      if (explicitRetry && ready) failure = '';
    }
    const promise = new Promise(resolve => queue.push({ key, fields: clone(fields), resolve }));
    updateStatus();
    if (ready && !failure) void pump();
    else if (failure) { for (const item of queue) item.resolve(false); }
    else if (!initializing) void init();
    return promise;
  }
  const patch = (key, fields) => enqueue(key, fields);
  const saveSettings = fields => enqueue('@settings', fields, true);
  // Explicit UI confirmation happens before this call. Server resets current records
  // under its lock; no stale client snapshot can overwrite another saved field.
  const resetPetDefaults = () => enqueue('@petDefaults', { confirmed: true });
  const clearPetConfigs = ids => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || !ids.every(id => Number.isSafeInteger(id) && id > 0)) return Promise.resolve(false);
    return enqueue('@petClear', { ids: [...new Set(ids)] });
  };
  async function flush() {
    if (!queue.length) return true; // Read-only startup failure must not trap an otherwise clean window.
    if (!ready || failure) return false;
    await pump();
    // A new edit may have arrived in the final promise microtask.
    if (queue.length && !failure) return flush();
    return !queue.length && !failure;
  }
  async function retry() {
    if (!ready && !await init()) return false;
    failure = ''; updateStatus(); return flush();
  }
  async function requestClose() {
    const ok = await flush();
    if (typeof root.__xhmCloseReady === 'function') await root.__xhmCloseReady(ok);
    return ok;
  }
  root.addEventListener?.('beforeunload', event => {
    if (queue.length) { event.preventDefault(); event.returnValue = ''; }
  });
  return Object.freeze({ init, getObject, patch, saveSettings, resetPetDefaults, clearPetConfigs, flush, retry, requestClose,
    getSettingsResult: () => clone(lastSettingsResult),
    getStatus: () => ({ ready, pending: queue.length, error: failure, cacheWarning }) });
});
