/* Battle record client: session-only handoff, bounded inference, tracked writes.
 * No capture, profile/localStorage writes, guessed protocol IDs, or raw secrets. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./battle-math.js') : root.BattleMath, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BattleRecordsClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (math, environment) {
  'use strict';
  // RKData/CommonUI are top-level lexical bindings, not window properties.
  const root = typeof RKData !== 'undefined' ? {
    RKData, CommonUI: typeof CommonUI !== 'undefined' ? CommonUI : environment.CommonUI,
    fetch: (...args) => environment.fetch(...args), crypto: environment.crypto, document: environment.document
  } : environment;
  const STATS = ['hp', 'attack', 'magic_attack', 'defense', 'magic_defense', 'speed'];
  const LABELS = { hp: '生命', attack: '物攻', magic_attack: '魔攻', defense: '物防', magic_defense: '魔防', speed: '速度' };
  const copy = value => JSON.parse(JSON.stringify(value));
  const own = (object, key) => object != null && Object.hasOwn(object, key);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const listeners = new Set(), pending = new Set();
  let record = null, revision = 0;
  function useRecord(value) {
    if (!value || value.version !== 1 || typeof value.id !== 'string' || !value.sides ||
        !['me', 'enemy'].every(side => Array.isArray(value.sides[side]?.pets))) throw Error('对战快照结构无效');
    record = copy(value); revision++;
    for (const fn of listeners) fn();
  }
  function getRecord() { return record ? copy(record) : null; }
  function clearRecord() { record = null; revision++; for (const fn of listeners) fn(); }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function validValue(kind, value) {
    return Number.isInteger(value) && value >= 0 && value <= (kind === 'iv' ? 60 : 2);
  }
  function confirmedValue(evidence, kind) {
    return evidence && ['direct', 'unique'].includes(evidence.certainty) && validValue(kind, evidence.value) ? evidence.value : null;
  }
  function candidates(pet, stat, kind) {
    const e = pet?.[kind]?.[stat];
    if (confirmedValue(e, kind) !== null) return [e.value];
    return [...new Set((e?.candidates || []).filter(value => validValue(kind, value)))].sort((a, b) => a - b);
  }
  function snapshotValues(pet) {
    const iv = {}, nature = {}, unknown = [];
    for (const stat of STATS) for (const kind of ['iv', 'nature']) {
      const value = confirmedValue(pet?.[kind]?.[stat], kind);
      if (value === null) unknown.push(`${LABELS[stat]}${kind === 'iv' ? '个体' : '性格'}`);
      else (kind === 'iv' ? iv : nature)[stat] = value;
    }
    return { iv, nature, unknown, level: Number.isInteger(pet?.level) && pet.level >= 1 && pet.level <= 99 ? pet.level : null };
  }
  function track(promise) {
    const p = Promise.resolve(promise); pending.add(p);
    p.then(() => pending.delete(p), () => pending.delete(p));
    return p;
  }
  async function flush() {
    while (pending.size) {
      const results = await Promise.allSettled([...pending]);
      if (results.some(r => r.status === 'rejected')) return false;
    }
    return true;
  }
  // The native service admits two concurrent battle requests. Queue before fetch,
  // including writes in the close barrier while they are still waiting for a slot.
  const requestQueue = [];
  let activeRequests = 0;
  function abortedRequest() { const error = Error('请求已取消'); error.name = 'AbortError'; return error; }
  function pumpRequests() {
    while (activeRequests < 2 && requestQueue.length) {
      const job = requestQueue.shift(); job.cleanup();
      if (job.options.signal?.aborted) { job.reject(abortedRequest()); continue; }
      activeRequests++;
      (async () => {
        const response = await root.fetch(job.url, job.options);
        if (job.readResponse) return job.readResponse(response, job.options.signal);
        let body; try { body = await response.json(); } catch (_) { throw Error('对战记录服务返回格式异常'); }
        if (!response.ok) {
          const message = response.status === 429 ? '请求繁忙，请稍后重试。' : typeof body.error === 'string' ? body.error : '对战记录请求失败';
          const error = Error(message); error.status = response.status; throw error;
        }
        return body;
      })().then(job.resolve, job.reject).finally(() => { activeRequests--; pumpRequests(); });
    }
  }
  function request(url, options = {}, readResponse = null) {
    const opts = { ...options }, writing = !!opts.method && String(opts.method).toUpperCase() !== 'GET';
    const task = new Promise((resolve, reject) => {
      const signal = opts.signal;
      if (signal?.aborted) { reject(abortedRequest()); return; }
      const job = { url, options:opts, readResponse, resolve, reject, cleanup:() => signal?.removeEventListener?.('abort', cancel) };
      function cancel() {
        const index = requestQueue.indexOf(job);
        if (index < 0) return; // Active transport owns cancellation and its slot until settlement.
        requestQueue.splice(index, 1); job.cleanup(); reject(abortedRequest()); pumpRequests();
      }
      signal?.addEventListener?.('abort', cancel, { once:true });
      requestQueue.push(job); pumpRequests();
    });
    return writing ? track(task) : task;
  }
  const SOURCE_EXPORT_LIMIT = 64 * 1024 * 1024;
  function sourceReadOptions(signal) {
    return { method: 'GET', signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } };
  }
  async function getSourceEventsStatus({ signal } = {}) {
    const status = await request('/api/battles/source/status', sourceReadOptions(signal));
    if (!status || typeof status.available !== 'boolean' || !Number.isSafeInteger(status.count) || status.count < 0 ||
        !Number.isSafeInteger(status.bytes) || status.bytes < 0) throw Error('转换前事件状态格式异常，请重试');
    return status;
  }
  function exportSourceEvents(format, { signal } = {}) {
    if (!['json', 'ndjson'].includes(format)) return Promise.reject(Error('请选择 JSON 或 NDJSON'));
    const options = sourceReadOptions(signal);
    options.headers.Accept = format === 'json' ? 'application/json' : 'application/x-ndjson';
    return track(request('/api/battles/source/export?format=' + format, options, async (response, readSignal) => {
      if (!response.ok) {
        let body; try { body = await response.json(); } catch (_) { /* Only error bodies are parsed. */ }
        const error = Error(response.status === 429 ? '请求繁忙，请稍后重试。' : typeof body?.error === 'string' ? body.error : '转换前事件导出失败');
        error.status = response.status; throw error;
      }
      const length = response.headers?.get?.('Content-Length');
      if (length && (!/^\d+$/.test(length) || Number(length) > SOURCE_EXPORT_LIMIT)) throw Error('转换前事件导出超过 64 MiB 限制，未导出或截断内容');
      let blob;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = []; let bytes = 0;
        try {
          while (true) {
            if (readSignal?.aborted) throw abortedRequest();
            const part = await reader.read(); if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > SOURCE_EXPORT_LIMIT) throw Error('转换前事件导出超过 64 MiB');
            chunks.push(part.value);
          }
          blob = new environment.Blob(chunks, { type: options.headers.Accept });
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
      } else {
        blob = await response.blob();
        if (blob.size > SOURCE_EXPORT_LIMIT) throw Error('转换前事件导出超过 64 MiB');
      }
      if (readSignal?.aborted) throw abortedRequest();
      // Source success bytes never enter JSON.parse/stringify: uint64 IDs and
      // raw source whitespace survive unchanged. Ignore unsafe server filenames.
      const disposition = response.headers?.get?.('Content-Disposition') || '';
      const candidate = /filename="([^"]+)"/i.exec(disposition)?.[1];
      const filename = candidate && /^[a-zA-Z0-9_.-]+$/.test(candidate) && candidate.endsWith('.' + format)
        ? candidate : 'rkpp-source-events.' + format;
      const countHeader = response.headers?.get?.('X-Battle-Source-Count');
      const count = countHeader != null && /^\d+$/.test(countHeader) && Number.isSafeInteger(Number(countHeader)) ? Number(countHeader) : null;
      const completeHeader = response.headers?.get?.('X-Battle-Source-Complete');
      return { blob, filename, count, complete: completeHeader === 'true' ? true : completeHeader === 'false' ? false : null };
    }));
  }
  // Native runtime control stays same-origin and shares the battle queue/barrier.
  // Session tokens are memory-only; neither callers nor the URL input choose a command.
  let rkppSessionToken = '', rkppSessionPending = null, rkppMutationTail = Promise.resolve();
  async function getRKPPStatus({ signal } = {}) {
    const status = await request('/api/rkpp/status', { method: 'GET', signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
    if (!status || typeof status !== 'object' || Array.isArray(status)) throw Error('RKPP 服务返回格式异常');
    if (typeof status.sessionToken === 'string' && status.sessionToken) rkppSessionToken = status.sessionToken;
    return status;
  }
  function changeRKPP(operation) {
    // Serialize start/stop across page remounts; an older start cannot finish after stop.
    // Track the whole operation before even its prerequisite GET has a free slot.
    const task = rkppMutationTail.catch(() => {}).then(async () => {
      if (!rkppSessionToken) {
        if (!rkppSessionPending) rkppSessionPending = getRKPPStatus().finally(() => { rkppSessionPending = null; });
        await rkppSessionPending;
      }
      if (!rkppSessionToken) throw Error('RKPP 会话尚未就绪，请重新读取状态');
      return request('/api/rkpp/' + operation, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-RKPP-Session-Token': rkppSessionToken }, body: '{}' });
    });
    rkppMutationTail = task;
    return track(task);
  }
  function startRKPP() { return changeRKPP('start'); }
  function stopRKPP() { return changeRKPP('stop'); }
  function validateConstraint(c, pet, stat) {
    if (!c || c.modifiersKnown !== true) throw Error('必须确认影响伤害或先后的全部条件');
    if (!STATS.includes(stat) || c.stat !== stat || !Number.isFinite(c.knownStat) || c.knownStat <= 0 || c.knownStat > 1000000) throw Error('已知属性或目标属性无效');
    if (!Number.isInteger(pet.level) || pet.level < 1 || pet.level > 99) throw Error('目标精灵等级未知，不能进行唯一性判断');
    if (c.kind === 'speedOrder') {
      if (stat !== 'speed' || c.samePriority !== true || typeof c.before !== 'boolean') throw Error('先后手推断要求同优先级、无其它速度修正');
    } else {
      if (!(c.kind === 'damageDealt' && ['attack', 'magic_attack'].includes(stat)) &&
          !(c.kind === 'damageReceived' && ['defense', 'magic_defense'].includes(stat))) throw Error('伤害方向与目标属性不匹配');
      if (!Number.isInteger(c.damage) || c.damage < 0 || c.damage > 100000000 ||
          !Number.isFinite(c.power) || c.power <= 0 || c.power > 1000000 ||
          !Number.isFinite(c.reduction) || c.reduction <= 0 || c.reduction > 1 ||
          !Number.isFinite(c.effectiveness) || c.effectiveness <= 0 || c.effectiveness > 4 ||
          !Number.isInteger(c.level) || c.level < 1 || c.level > 99) throw Error('单击伤害、最终威力、等级或倍率无效');
      if (c.kind === 'damageDealt' && c.level !== pet.level) throw Error('攻击方等级与该精灵已知等级不符');
    }
  }
  // Enumerate joint (IV, nature) pairs; never infer one field independently and
  // silently assume the other neutral. Speed ties remain feasible in BOTH orders.
  function inferStat(pet, stat, constraints, base) {
    if (!Number.isFinite(base) || base < 0 || base > 10000 || !Array.isArray(constraints) || !constraints.length || constraints.length > 128) throw Error('缺少有效种族值或推断条件');
    constraints.forEach(c => validateConstraint(c, pet, stat));
    const directIV = pet.iv?.[stat]?.certainty === 'direct' ? confirmedValue(pet.iv[stat], 'iv') : null;
    const directNature = pet.nature?.[stat]?.certainty === 'direct' ? confirmedValue(pet.nature[stat], 'nature') : null;
    const pairs = [];
    for (let iv = 0; iv <= 60; iv++) for (let nature = 0; nature <= 2; nature++) {
      if (directIV !== null && iv !== directIV || directNature !== null && nature !== directNature) continue;
      const value = math.statFromEffectiveIV(base, stat, nature, iv, pet.level);
      const matches = constraints.every(c => {
        if (c.kind === 'speedOrder') return c.before ? value >= c.knownStat : value <= c.knownStat;
        const calculated = c.kind === 'damageDealt'
          ? math.normalDamage(value, c.power, c.knownStat, c.reduction, 1, c.level, c.effectiveness)
          : math.normalDamage(c.knownStat, c.power, value, c.reduction, 1, c.level, c.effectiveness);
        return calculated === c.damage;
      });
      if (matches) pairs.push({ iv, nature, value });
    }
    if (!pairs.length) throw Error('条件互相冲突，或存在未记录修正；未保存本次推断');
    const evidence = constraints.map(c => `${c.id}: ${c.provenance || '导入条件'}`).slice(0, 128);
    function result(key) {
      const values = [...new Set(pairs.map(p => p[key]))].sort((a, b) => a - b);
      return { value: values.length === 1 ? values[0] : null, certainty: values.length === 1 ? 'unique' : 'candidate', candidates: values, evidence };
    }
    return { pairs, iv: result('iv'), nature: result('nature') };
  }
  function analyzeRecord(input, data = root.RKData) {
    const out = copy(input);
    if ((out.constraints || []).length > 512) throw Error('推断条件过多');
    for (const side of ['me', 'enemy']) for (const pet of out.sides?.[side]?.pets || []) {
      const species = data?.getMonsterById(pet.monsterId);
      if (!species) continue; // Unknown protocol identity must never map by name.
      for (const stat of STATS) {
        const conditions = (out.constraints || []).filter(c => c.side === side && c.instanceId === pet.instanceId && c.stat === stat);
        if (!conditions.length) continue;
        const found = inferStat(pet, stat, conditions, data.getBaseStat(species, stat));
        for (const kind of ['iv', 'nature']) {
          pet[kind] ||= {};
          if (pet[kind][stat]?.certainty !== 'direct') pet[kind][stat] = found[kind];
        }
      }
    }
    return out;
  }
  function renderInference(host, input, onSaved = () => {}) {
    if (!host) return () => {};
    let active = true, busy = false, local = copy(input);
    const abort = new AbortController();
    const pets = ['enemy', 'me'].flatMap(side => (local.sides?.[side]?.pets || []).map(pet => ({ side, pet })))
      .filter(row => root.RKData?.getMonsterById(row.pet.monsterId));
    host.classList.add('battle-inference');
    host.innerHTML = `<details><summary>性格 / 个体条件推断</summary>
      <p class="battle-note">缺少完整条件不自动猜测。只接受未被剩余生命截断的单击普通伤害；最终威力已含本系、克制及BUFF，不含减伤。先后手仅在同优先级、无其它速度修正时可用，同速不排除。</p>
      <form class="battle-inference-form">
        <label>目标精灵<select name="pet">${pets.map((r,i) => `<option value="${i}">${r.side === 'me' ? '我方' : '敌方'} · ${escape(root.RKData.getMonsterDisplayName(root.RKData.getMonsterById(r.pet.monsterId)))} · ${escape(r.pet.instanceId)}</option>`).join('')}</select></label>
        <label>观察类型<select name="kind"><option value="damageDealt">目标打出的伤害 → 攻击</option><option value="damageReceived">目标受到的伤害 → 防御</option><option value="speedOrder">双方先后手 → 速度</option></select></label>
        <label>目标属性<select name="stat"><option value="attack">物攻</option><option value="magic_attack">魔攻</option></select></label>
        <label>对侧已知属性值<input name="knownStat" type="number" min="1" max="1000000" required></label>
        <label data-damage>单击伤害<input name="damage" type="number" min="0" max="100000000" required></label>
        <label data-damage>最终威力<input name="power" type="number" min="1" max="1000000" required></label>
        <label data-damage>攻击方等级<input name="level" type="number" min="1" max="99" value="60" required></label>
        <label data-damage>减伤后保留倍率<input name="reduction" type="number" min="0.001" max="1" step="0.001" value="1" required></label>
        <label data-speed hidden>目标行动<select name="before"><option value="true">在对侧之前</option><option value="false">在对侧之后</option></select></label>
        <label>回合<input name="round" type="number" min="1" max="10000" value="1" required></label>
        <label class="battle-wide">条件来源<input name="provenance" maxlength="160" placeholder="例如：第3回合伤害事件；已核对双方修正" required></label>
        <label class="battle-wide battle-confirm"><input name="confirmed" type="checkbox" required>我已核对上述条件，不含暴击、固伤、混合连击或未知防御/速度修正</label>
        <button type="submit" class="btn" ${pets.length ? '' : 'disabled'}>分析并保存候选</button>
      </form><p class="battle-inference-status" role="status"></p><div class="battle-inference-results"></div></details>`;
    const form = host.querySelector('form'), status = host.querySelector('[role="status"]');
    const field = name => form.elements.namedItem(name);
    const sync = () => {
      const speed = field('kind').value === 'speedOrder';
      const stats = speed ? ['speed'] : field('kind').value === 'damageDealt' ? ['attack', 'magic_attack'] : ['defense', 'magic_defense'];
      field('stat').innerHTML = stats.map(k => `<option value="${k}">${LABELS[k]}</option>`).join('');
      host.querySelectorAll('[data-damage]').forEach(el => { el.hidden = speed; el.querySelector('input').required = !speed; });
      host.querySelector('[data-speed]').hidden = !speed;
      if (field('kind').value === 'damageDealt') field('level').value = pets[Number(field('pet').value)]?.pet.level ?? '';
    };
    field('kind').addEventListener('change', sync, { signal: abort.signal });
    field('pet').addEventListener('change', sync, { signal: abort.signal }); sync();
    function showResults() {
      const rows = [];
      for (const row of pets) {
        const pet = local.sides[row.side].pets.find(p => p.instanceId === row.pet.instanceId);
        for (const stat of STATS) for (const kind of ['iv', 'nature']) {
          const ev = pet?.[kind]?.[stat];
          if (!ev || !['unique', 'candidate'].includes(ev.certainty)) continue;
          const values = candidates(pet, stat, kind).map(v => kind === 'nature' ? ['中性', '正性格', '负性格'][v] : v);
          rows.push(`${row.side === 'me' ? '我方' : '敌方'} ${root.RKData.getMonsterDisplayName(root.RKData.getMonsterById(pet.monsterId))} · ${LABELS[stat]}${kind === 'iv' ? '有效个体' : '性格'}：${ev.certainty === 'unique' ? '唯一候选 ' : '候选 '}${values.join(' / ')}`);
        }
      }
      const resultHost = host.querySelector('.battle-inference-results');
      resultHost.replaceChildren(...rows.map(text => { const p = root.document.createElement('p'); p.textContent = text; return p; }));
    }
    showResults();
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !form.reportValidity()) return;
      const row = pets[Number(field('pet').value)]; if (!row) return;
      const stat = field('stat').value, kind = field('kind').value;
      const c = { id: `manual-${root.crypto?.randomUUID?.() || Date.now()}`, side: row.side, instanceId: row.pet.instanceId, stat, kind,
        knownStat: Number(field('knownStat').value), power: kind === 'speedOrder' ? 1 : Number(field('power').value),
        damage: kind === 'speedOrder' ? null : Number(field('damage').value), level: Number(field('level').value) || row.pet.level,
        reduction: kind === 'speedOrder' ? 1 : Number(field('reduction').value), effectiveness: 1,
        before: field('before').value === 'true', samePriority: kind === 'speedOrder', modifiersKnown: field('confirmed').checked,
        provenance: field('provenance').value.trim(), round: Number(field('round').value) };
      busy = true; form.querySelector('button').disabled = true; status.textContent = '分析并保存…';
      try {
        const next = analyzeRecord({ ...local, constraints: [...(local.constraints || []), c] });
        await request('/api/battles/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, records: [next] }) });
        if (!active || !host.isConnected) return;
        local = next; status.textContent = '候选已保存；多解仍需人工确认，不作为确定配置。'; showResults(); onSaved(copy(next));
      } catch (error) { if (active && host.isConnected) status.textContent = error.message; }
      finally { busy = false; if (active && host.isConnected) form.querySelector('button').disabled = false; }
    }, { signal: abort.signal });
    const cleanup = () => { active = false; abort.abort(); };
    root.CommonUI?.registerCleanup?.(host, cleanup);
    return cleanup;
  }
  return { STATS, LABELS, escape, useRecord, getRecord, clearRecord, subscribe, getRevision: () => revision,
    validValue, confirmedValue, candidates, snapshotValues, inferStat, analyzeRecord, renderInference, track, flush, request, startRKPP, stopRKPP, getRKPPStatus, getSourceEventsStatus, exportSourceEvents };
});
