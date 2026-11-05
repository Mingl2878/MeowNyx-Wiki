/* Battle records UI. Only normalized API records; no capture or browser data persistence. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) root.BattleRecordsPage = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const STATS = { hp: '生命', attack: '物攻', magic_attack: '魔攻', defense: '物防', magic_defense: '魔防', speed: '速度' };
  const OUTCOMES = { win: '胜利', loss: '失败', draw: '平局', unknown: '结果未知' };
  const SIDES = { me: '我方', enemy: '敌方', unknown: '阵营未知' };
  const KINDS = { skill: '技能', damage: '伤害', switch: '换场', effect: '效果', growth: '成长', heal: '治疗', resource: '资源 / 状态', weather: '天气', note: '备注', order: '行动顺序', form: '形态变化' };
  const LIFECYCLES = { enter: '进入对战', round_start: '回合开始', finish: '对战结束' };
  const EMPTY_TURN = '没有解析到可确认的行动，不代表未行动';
  const EMPTY_FILTERS = { from: '', to: '', toExclusive: false, season: null, week: null, outcome: '', monsterId: '', teamRuleId: '', rankSide: 'enemy', rankMetric: '', rankMin: '', rankMax: '' };
  const timeFilters = () => root.BattleTimeFilters || (typeof module === 'object' && module.exports && typeof require === 'function' ? require('../battle-time-filters.js') : null);
  const systemActions = () => root.BattleSystemActions || (typeof module === 'object' && module.exports && typeof require === 'function' ? require('../battle-system-actions.js') : null);
  const isNoAction = event => systemActions()?.isNoAction?.(event) === true;
  const state = { filters: { ...EMPTY_FILTERS }, page: 1, pageSize: 25, tab: 'list', statsSide: 'me', performanceMode: 'totals', selectedLineupKey: '', selectedArchetypeId: '', selectedId: '', relayURL: 'http://127.0.0.1:18765' };
  let dispose = null;
  const statsCache = new Map(); // bounded, revision-qualified, memory-only
  const ruleFamilies = () => root.BattleRuleFamilies || (typeof module === 'object' && module.exports && typeof require === 'function' ? require('../battle-rule-families.js') : null);
  const historyGrowth = () => root.BattleHistoryGrowth || (typeof module === 'object' && module.exports && typeof require === 'function' ? require('../battle-history-growth.js') : null);
  const actionOutcomes = () => root.BattleActionOutcomes || (typeof module === 'object' && module.exports && typeof require === 'function' ? require('../battle-action-outcomes.js') : null);
  // A submitted scan is a tracked write, not modal-owned work. Keep its state
  // through close/leave/reopen; only the currently mounted page may paint it.
  const scanState = { path: null, token: '', pending: null, result: null, error: null };
  let scanChanged = null;
  // Operation deadline survives leave/remount; status reads never renew it.
  const runtimeProgress = { deadline: null };
  const SOURCE_EMPTY = '暂无转换前事件；旧战报不会反推，可扫描已有RKPP采集记录补导';
  const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const arr = value => Array.isArray(value) ? value : [];
  const known = value => value !== undefined && value !== null && value !== '';
  const text = value => known(value) ? String(value) : '未知';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const data = () => typeof RKData !== 'undefined' ? RKData : root.RKData;
  const ui = () => typeof CommonUI !== 'undefined' ? CommonUI : root.CommonUI;
  const client = () => root.BattleRecordsClient;
  // Browser dependency is explicit; the optional Node path serves pure/test consumers.
  const turnView = () => root.BattleTurnView || (typeof module === 'object' && module.exports && typeof require === 'function' ? require('../battle-turn-view.js') : null);

  function speciesName(id, declaredName) {
    const pet = Number.isSafeInteger(id) && id > 0 ? data()?.getMonsterById?.(id) : null;
    if (pet) return data().getMonsterDisplayName(pet);
    return id > 0 ? `未收录精灵 #${id}${declaredName ? `（来源名：${declaredName}）` : ''}` : `身份未映射${declaredName ? `（来源名：${declaredName}）` : ''}`;
  }
  function skillName(id) {
    const skill = id > 0 ? data()?.getMoves?.().find(item => item.id === id) : null;
    return skill ? data().getMoveName(skill) : id > 0 ? '未收录技能' : '技能身份未知';
  }
  function lineupKey(lineup) {
    const ids = arr(lineup?.monsterIds);
    // Preserve duplicates; never sort or coerce the DTO in place. Malformed or
    // oversized rosters cannot alias a valid initial six-member lineup.
    return ids.length > 0 && ids.length <= 6 && ids.every(id => Number.isSafeInteger(id) && id > 0)
      ? JSON.stringify([...ids].sort((a, b) => a - b)) : '';
  }
  function ratio(numerator, denominator) {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return '—（无有效样本）';
    return `${numerator} / ${denominator} · ${(numerator / denominator * 100).toFixed(1)}%`;
  }
  function displayTime(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return '时间未知';
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  }
  function filterQuery(filters) {
    const query = new URLSearchParams();
    for (const key of ['from', 'to']) if (filters[key]) {
      const date = new Date(filters[key]);
      if (!Number.isFinite(date.getTime())) throw Error('请输入有效的本地时间');
      // Season/week ranges already carry the precise local 04:00 RFC3339
      // boundary. Preserve the offset; never rebuild one from a calendar date.
      query.set(key, filters.toExclusive === true ? filters[key] : date.toISOString());
    }
    if (filters.toExclusive === true && filters.to) query.set('toExclusive', 'true');
    if (filters.from && filters.to && new Date(filters.from) > new Date(filters.to)) throw Error('开始时间不能晚于结束时间');
    for (const key of ['outcome', 'monsterId', 'teamRuleId']) if (filters[key]) query.set(key, filters[key]);
    if (filters.rankMetric) {
      const metric = filters.rankMetric;
      const hasRank = metric === 'tier' ? !!filters.tier.trim() : filters.rankMin !== '' || filters.rankMax !== '';
      if (hasRank) {
        query.set('rankSide', filters.rankSide); query.set('rankMetric', metric);
        if (metric === 'tier') query.set('tier', filters.tier.trim());
        else {
          for (const key of ['rankMin', 'rankMax']) if (filters[key] !== '') {
            const n = Number(filters[key]);
            if (!Number.isFinite(n) || n < 0 || (metric === 'rank' && (!Number.isInteger(n) || n < 1))) throw Error('名次须为正整数，积分须为非负数字');
            query.set(key, String(n));
          }
          if (filters.rankMin !== '' && filters.rankMax !== '' && Number(filters.rankMin) > Number(filters.rankMax)) throw Error('下限不能大于上限');
        }
      }
    }
    return query;
  }
  function recordCounts(record) {
    // Settlement rounds are authoritative; neither event rows nor their round
    // labels can supply a missing count. An omitted event list is also unknown.
    return {
      rounds: Number.isInteger(record?.rounds) && record.rounds > 0 && record.rounds <= 1000000 ? record.rounds : null,
      events: Array.isArray(record?.events) ? record.events.length : null
    };
  }
  function recordCountsText(record) {
    const rounds = recordCounts(record).rounds;
    const duration = record?.durationSeconds;
    const label = `对战回合：${rounds === null ? '未知' : rounds + '回合'}`;
    // Only the normalized duration supplies elapsed time. Zero is known, and
    // neither timestamps nor event/round counts can repair a missing duration.
    return Number.isSafeInteger(duration) && duration >= 0
      ? `${label}；对战用时：${Math.floor(duration / 60)}分钟${duration % 60}秒` : label;
  }
  function identityEvidenceText(pet) {
    return `初始 baseID（protocolBaseId）：${text(pet?.protocolBaseId)} · 映射版本（mappingRevision / canonical SHA-256）：${text(pet?.mappingRevision)}`;
  }
  function formChangeText(form, name = speciesName) {
    // Only canonical IDs name forms. Base IDs, conf_id and source names are
    // evidence, never a client-side lookup or a fallback identity.
    return `${name(form?.fromMonsterId)} → ${name(form?.toMonsterId)}`;
  }
  function formEvidenceText(form) {
    return `baseID：${text(form?.fromBaseId)} → ${text(form?.toBaseId)} · 映射版本（mappingRevision / canonical SHA-256）：${text(form?.mappingRevision)}`;
  }
  function executionIndex(event) {
    // An explicit zero wins over the legacy nested form index. Missing stays
    // missing for display, even though sorting uses zero as its stable fallback.
    return Number.isSafeInteger(event.execIndex) ? event.execIndex : Number.isSafeInteger(event.form?.execIndex) ? event.form.execIndex : null;
  }
  function groupedTurns(events) {
    const groups = new Map();
    // Stable sort of a copy; equal keys retain source order.
    for (const event of [...arr(events)].sort((a, b) => (a.round || 0) - (b.round || 0) || (a.seq || 0) - (b.seq || 0) || (executionIndex(a) ?? 0) - (executionIndex(b) ?? 0))) {
      const round = event.round > 0 ? event.round : 0;
      if (!groups.has(round)) groups.set(round, []);
      groups.get(round).push(event);
    }
    return [...groups].map(([round, rows]) => ({ round, events: rows }));
  }
  function lifecycleKind(event) {
    if (event.kind !== 'note') return '';
    if (Object.hasOwn(LIFECYCLES, event.lifecycle)) return event.lifecycle;
    // Exact old adapter signatures only: a word in an arbitrary note or an ID
    // alone must not hide a gameplay event. Do not modify persisted legacy rows.
    if (known(event.lifecycle) || !Number.isSafeInteger(event.round) || event.round < 0 || event.round > 1000000) return '';
    for (const [opcode, kind, source] of [['1316', 'enter', 'battle_enter'], ['131a', 'round_start', 'round_start'], ['132c', 'finish', 'battle_finish']]) {
      if (event.id === `rkpp:${opcode}:${event.round}` && event.text === `Observed RKPP ${source}; gameplay attribution unavailable.`) return kind;
    }
    return '';
  }
  function timelineTurns(record) {
    const turns = groupedTurns(arr(record.events).filter(event => !lifecycleKind(event)));
    const rounds = recordCounts(record).rounds;
    if (rounds === null) return turns;
    const result = [];
    let nextRound = 1;
    function gap(end) {
      if (end < nextRound) return;
      // Valid imports allow very large round counts. Preserve a large empty
      // interval explicitly without allocating a million empty DOM sections.
      if (end - nextRound >= 100) result.push({ round: nextRound, endRound: end, events: [] });
      else for (let round = nextRound; round <= end; round++) result.push({ round, events: [] });
      nextRound = end + 1;
    }
    for (const turn of turns) {
      if (turn.round > 0) gap(Math.min(turn.round - 1, rounds));
      result.push(turn);
      if (turn.round > 0) nextRound = Math.max(nextRound, turn.round + 1);
    }
    gap(rounds);
    return result;
  }
  function eventName(event) {
    if (isNoAction(event)) return '眩晕 · 未执行行动';
    if (event.kind === 'form') return `形态变化 · ${formChangeText(event.form)}`;
    const effectClass = ['passive', 'system'].includes(event.skillClass);
    const kind = effectClass && event.kind === 'skill' ? 'effect' : event.kind;
    let label = KINDS[kind] || text(kind);
    if (effectClass) label += `（${event.skillClass === 'passive' ? '被动' : '系统'}，不计技能释放）`;
    else if (event.skillClass === 'response') label += '（响应）';
    else if (event.skillClass === 'unknown') label += '（类别未确认）';
    if (event.kind === 'skill' && event.phase === 'interrupted') label += ' · 已打断';
    // A verified config label supplies display text, not canonical identity.
    // Once mapped, always use the canonical name; retain labels only in evidence.
    if (event.skillId > 0) label += ' · ' + skillName(event.skillId);
    else if (event.label) label += !effectClass && (kind === 'skill' || event.protocolSkillId)
      ? ` · 配置标签：${event.label}（Wiki 身份未映射）` : ' · ' + event.label;
    else if (kind === 'skill') label += ' · 技能身份未知';
    return label;
  }
  function eventNumbers(event) {
    if (event.kind === 'form') return '—（身份变化）';
    const parts = [], signed = value => value > 0 ? '+' + value : String(value);
    if (Number.isFinite(event.amount)) parts.push(`${event.kind === 'damage' ? '报告伤害' : event.kind === 'heal' ? '治疗' : event.kind === 'growth' ? '变化量' : '数值'} ${event.amount}`);
    else if (event.kind === 'damage') parts.push('报告伤害未提供');
    else if (event.kind === 'heal') parts.push('治疗量未提供');
    if (Number.isSafeInteger(event.hpChange)) parts.push('生命实际变化 ' + signed(event.hpChange));
    if (Number.isSafeInteger(event.hpAfter) && event.hpAfter >= 0) parts.push('剩余生命 ' + event.hpAfter);
    if (Number.isSafeInteger(event.energyChange)) parts.push('能量变化 ' + signed(event.energyChange));
    if (Number.isSafeInteger(event.energyAfter) && event.energyAfter >= 0) parts.push('剩余能量 ' + event.energyAfter);
    if (Number.isSafeInteger(event.stacks) && event.stacks >= 0) parts.push((event.kind === 'growth' ? '累计计数 ' : '层数 ') + event.stacks);
    return parts.join(' · ') || '—';
  }
  function confirmedGrowth(record) {
    const groups = new Map();
    for (const event of groupedTurns(record.events).flatMap(turn => turn.events)) {
      if (event.kind !== 'growth' || event.phase !== 'executed' || !event.trigger || !event.actor ||
          !arr(record.sides?.[event.side]?.pets).some(pet => pet.instanceId === event.actor)) continue;
      const key = JSON.stringify([event.side, event.actor, event.skillId || 0, event.trigger]);
      if (!groups.has(key)) groups.set(key, { side: event.side, actor: event.actor, skillId: event.skillId, trigger: event.trigger, events: [], count: 0, hasExplicitCounter: false });
      const group = groups.get(key);
      group.events.push(event);
      // stacks is the cumulative counter AFTER this event, not a delta. A later
      // explicit counter supersedes earlier observations; never sum 1 + 2 + 3.
      if (Number.isInteger(event.stacks) && event.stacks >= 0) { group.count = event.stacks; group.hasExplicitCounter = true; }
      else group.count++; // Only an already-confirmed executed growth trigger.
    }
    return [...groups.values()];
  }
  function evidenceText(evidence, kind) {
    const value = v => kind === 'nature' ? ({ 0: '中性', 1: '正性格', 2: '负性格' }[v] || `未知枚举 ${v}`) : text(v);
    if (!evidence) return '未知';
    if (['direct', 'unique'].includes(evidence.certainty) && known(evidence.value)) return `${value(evidence.value)}（${evidence.condition === 'effective_iv_60' ? '按+10个体前提唯一，不证明实际个体值' : evidence.certainty === 'direct' ? '来源直接声明' : '条件下唯一'}）`;
    if (evidence.certainty === 'candidate' && arr(evidence.candidates).length) return `候选：${evidence.candidates.map(value).join(' / ')}（未确认）`;
    return '未知';
  }
  // One page-module queue also spans leave/reopen while a write is pending.
  // Occupied slots are released only when transport settles, not on abort intent.
  const requestQueue = [];
  let requestsActive = 0;
  function pumpRequests() {
    while (requestsActive < 2 && requestQueue.length) {
      const entry = requestQueue.shift();
      entry.signal?.removeEventListener('abort', entry.cancel);
      if (entry.signal?.aborted) { entry.cancel(); continue; }
      requestsActive++;
      const run = async () => {
        if (client()?.request) return client().request('/api/battles/' + entry.path, entry.options);
        const response = await root.fetch('/api/battles/' + entry.path, entry.options);
        let body;
        try { body = await response.json(); } catch (_) { throw Error('服务返回格式异常，请重试'); }
        if (!response.ok) throw Error(typeof body.error === 'string' ? body.error : `请求失败（${response.status}）`);
        return body;
      };
      run().then(entry.resolve, entry.reject).finally(() => { requestsActive--; pumpRequests(); });
    }
  }
  function request(path, options = {}) {
    // The full client owns the shared application queue and close barrier.
    if (client()?.request) return client().request('/api/battles/' + path, options);
    const writing = !!options.method && options.method !== 'GET';
    // A queued mutation participates in the native close barrier immediately.
    // No write is aborted/discarded merely because this page is left.
    const signal = writing ? null : options.signal;
    const task = new Promise((resolve, reject) => {
      const entry = { path, options: writing ? { ...options, signal: undefined } : options, signal, resolve, reject };
      entry.cancel = () => {
        const index = requestQueue.indexOf(entry);
        if (index >= 0) requestQueue.splice(index, 1);
        signal?.removeEventListener('abort', entry.cancel);
        const error = Error('请求已取消'); error.name = 'AbortError'; reject(error);
      };
      if (signal?.aborted) { entry.cancel(); return; }
      signal?.addEventListener('abort', entry.cancel, { once: true });
      requestQueue.push(entry); pumpRequests();
    });
    return writing && client()?.track ? client().track(task) : task;
  }
  function onLeave() { dispose?.(); }

  function render(container) {
    onLeave();
    const doc = container.ownerDocument, aborts = new Map(), cleanups = [];
    let active = true, pollTimer = null, progressTimer = null, statusRead = null, statusFailed = false, rules = [], rulesReady = false, rulesBusy = false;
    let generation = 0, detailGeneration = 0, modal = null, petTip = null, tipSerial = 0;
    let importedCount = null, updatedCount = null, liveState = 'unknown', liveBusy = false, importing = false;
    let currentStats = null, statsGeneration = 0, statsQuery = null, statsPending = null;
    const make = (tag, cls, content) => {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (content != null) node.textContent = String(content);
      return node;
    };
    const page = make('section', 'battle-records-page'); page.setAttribute('aria-label', '对战记录');
    const button = (label, fn, primary = false) => {
      const node = make('button', `btn ${primary ? 'btn-primary' : 'btn-secondary'}`, label); node.type = 'button';
      node.addEventListener('click', fn); return node;
    };
    const note = content => make('p', 'br-note', content);
    const title = (content, level = 'h3') => make(level, 'br-section-title', content);
    function ownStatsTitle(content) {
      const heading = make('div', 'br-own-stats-heading');
      heading.append(title(content), make('small', 'br-own-stats-warning', '目前技能、个体、性格的统计还有问题，勉强可以参考'));
      return heading;
    }
    const field = (label, control) => { const node = make('label', 'br-field'); node.append(make('span', 'br-label', label), control); return node; };
    const input = (type, name, value = '') => { const node = make('input', 'br-input'); node.type = type; node.name = name; node.value = value; return node; };
    const select = (name, options, value = '') => {
      const node = make('select', 'br-input'); node.name = name;
      for (const [key, label] of options) { const option = make('option', '', label); option.value = key; node.append(option); }
      node.value = value; return node;
    };
    function errorAt(host, error, retry) {
      host.replaceChildren();
      const detail = error.message || '请求失败，请重试';
      const message = make('p', 'br-error', /(?:capacity|too many|concurrent|request limit|in.flight)/i.test(detail) ? '请求繁忙，请稍后重试' : detail); message.setAttribute('role', 'alert'); host.append(message);
      if (retry) host.append(button('重试', retry));
    }
    function controller(key) {
      aborts.get(key)?.abort(); const abort = new AbortController(); aborts.set(key, abort); return abort;
    }
    function table(headers, rows, empty = '暂无有效样本。未知不计为零。') {
      const wrap = make('div', 'br-table-scroll'); wrap.tabIndex = 0; wrap.setAttribute('aria-label', headers.join('、') + '表格，可横向滚动');
      const node = make('table', 'data-table br-table'), thead = make('thead'), tr = make('tr'), body = make('tbody');
      for (const header of headers) { const th = make('th', '', header); th.scope = 'col'; tr.append(th); }
      thead.append(tr);
      for (const row of rows) { const tr = make('tr'); for (const item of row) { const td = make('td'); if (item?.nodeType) td.append(item); else td.textContent = text(item); tr.append(td); } body.append(tr); }
      if (!rows.length) { const tr = make('tr'), td = make('td', 'br-empty', empty); td.colSpan = headers.length; tr.append(td); body.append(tr); }
      node.append(thead, body); wrap.append(node); return wrap;
    }
    function monsterPicker(label, onSelect, pageOwned = true) {
      const catalogue = arr(data()?.getMonsters?.()).filter(p => Number.isSafeInteger(p.id) && p.id > 0);
      const wrap = make('div', 'br-picker');
      let chosen = '', box;
      const choice = make('span', 'br-picker-selected'); choice.hidden = true;
      const clear = button('×', () => { set(''); onSelect(''); box.input?.focus(); });
      clear.className = 'br-picker-clear'; clear.setAttribute('aria-label', '清空' + label); clear.hidden = true;
      const safeItem = id => { const p = data()?.getMonsterById?.(Number(id)); return p ? { id:p.id, name:escape(data().getMonsterDisplayName(p)), icon:escape(avatarSource(p)) } : null; };
      function set(id) {
        chosen = String(id || ''); const p = data()?.getMonsterById?.(Number(chosen));
        box?.setValue(chosen ? speciesName(Number(chosen)) : '', p ? safeItem(p.id) : undefined);
        choice.replaceChildren(); choice.hidden = !chosen; clear.hidden = !chosen;
        if (p) choice.append(avatar({monsterId:p.id}));
      }
      if (ui()?.createSearchBox) {
        box = ui().createSearchBox({ showIcon:false, placeholder:'搜索精灵…', limit:Math.max(catalogue.length,1),
          search: keyword => catalogue.filter(p => `${data().getMonsterDisplayName(p)} ${p.id}`.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())).map(p=>safeItem(p.id)),
          onInput: value => { if (!value.trim() && chosen) { set(''); onSelect(''); } },
          onSelect: item => { set(item.id); onSelect(chosen); }
        });
        box.input.setAttribute('aria-label', label); box.input.name = label === '精灵' ? 'monsterId' : '';
        box.wrapper.className += ' br-picker-box'; box.wrapper.append(choice, clear); wrap.append(box.wrapper);
        if (pageOwned) cleanups.push(() => box.destroy());
      } else {
        const node = select('', [['','选择精灵'], ...catalogue.map(p=>[String(p.id),speciesName(p.id)])]); node.setAttribute('aria-label',label);
        node.addEventListener('change',()=>{set(node.value);onSelect(chosen);}); wrap.append(node,choice,clear); box={input:node,setValue:()=>{node.value=chosen;}};
      }
      return { wrap, destroy(){box.destroy?.();}, setDisabled(value){for(const c of wrap.querySelectorAll('input, select, button')) c.disabled=value;}, set };
    }
    function menuSelect(name, options, value) {
      const wrap=make('div','br-menu-select'), control=button('',()=>{menu.hidden=!menu.hidden;control.setAttribute('aria-expanded',String(!menu.hidden));if(!menu.hidden)menu.children[0]?.focus();});
      const menu=make('div','br-select-menu');menu.hidden=true;menu.setAttribute('role','listbox');menu.setAttribute('aria-label','敌方阵容体系');
      control.className='br-input br-select-toggle';control.name=name;control.value=value;control.setAttribute('aria-haspopup','listbox');control.setAttribute('aria-expanded','false');
      let entries=[];
      const close=()=>{menu.hidden=true;control.setAttribute('aria-expanded','false');};
      const sync=()=>{control.textContent=entries.find(x=>x[0]===control.value)?.[1]||'规则已不可用（重置后可清除）';for(const node of menu.children)node.setAttribute('aria-selected',String(node.value===control.value));};
      control.setOptions=rows=>{entries=rows;menu.replaceChildren();for(const [id,label] of rows){const item=button(label,()=>{control.value=id;sync();close();control.focus();});item.value=id;item.setAttribute('role','option');menu.append(item);}sync();};control.sync=sync;control.closeMenu=close;
      const outside=event=>{if(!wrap.contains(event.target))close();};doc.addEventListener('pointerdown',outside,true);cleanups.push(()=>doc.removeEventListener('pointerdown',outside,true));
      wrap.addEventListener('keydown',event=>{if(event.key==='Escape'&&!menu.hidden){event.preventDefault();event.stopPropagation();close();control.focus();}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();menu.hidden=false;control.setAttribute('aria-expanded','true');const items=[...menu.children];let index=items.indexOf(doc.activeElement);index=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[index]?.focus();}});
      wrap.append(control,menu);control.setOptions(options);return {wrap,control};
    }

    const heading = make('header', 'br-heading'), headingText = make('div');
    headingText.append(make('p', 'br-eyebrow', 'BATTLE RECORDS'), title('对战记录', 'h2'), note('本地记录 · 可追溯样本 · 不自动采集'));
    const importFile = input('file', 'battleFile'); importFile.accept = '.json,.ndjson,.jsonl,application/json,application/x-ndjson'; importFile.hidden = true;
    const importBtn = button('导入对局记录', () => importFile.click(), true); importBtn.dataset.br = 'import';
    const exportBtn = button('导出对局记录', () => openExport()); exportBtn.dataset.br = 'export-source';
    const scanBtn = button('扫描采集记录', () => openScan()); scanBtn.dataset.br = 'scan';
    const importControls = make('div', 'br-import-controls'); importControls.append(importBtn, exportBtn, scanBtn, importFile);
    heading.append(headingText, importControls);
    const importStatus = make('div', 'br-feedback'); importStatus.setAttribute('aria-live', 'polite');
    const scanStatus = make('div', 'br-feedback'); scanStatus.dataset.br = 'scan-status'; scanStatus.setAttribute('aria-live', 'polite');
    const dataChangeStatus = note(''); dataChangeStatus.dataset.br = 'import-filter-note'; dataChangeStatus.setAttribute('role', 'status');
    function refreshImported() {
      if (!active) return;
      dataChangeStatus.textContent = filterQuery(state.filters).toString()
        ? '已保留当前筛选；新记录若未显示，请检查时间范围等筛选条件。' : '';
      invalidateStats();refresh();
    }
    function paintScanStatus(host) {
      host.replaceChildren();
      if (scanState.pending) host.append(note('正在扫描采集记录；关闭窗口不会取消已提交的扫描。'));
      else if (scanState.error) errorAt(host, scanState.error);
      else if (scanState.result) {
        const result = scanState.result;
        host.append(note(`扫描完成：文件 ${text(counter(result.files))} · 已完成对战 ${text(counter(result.completed))} · 已导入 ${text(counter(result.imported))} · 已更新 ${text(counter(result.updated))} · 未变化 ${text(counter(result.unchanged))} · 待完成 ${text(counter(result.pending))} · 已忽略 ${text(counter(result.ignored))}`));
        // Issues are normalized API diagnostics, never raw payloads or HTML.
        for (const issue of arr(result.issues)) {
          const message = typeof issue === 'string' ? issue : issue?.message;
          if (typeof message === 'string' && message) host.append(make('p', 'br-error', message));
        }
      }
    }
    function syncScan(changed = false) {
      if (!active) return;
      paintScanStatus(scanStatus);
      if (modal?.kind === 'scan') {
        if (modal.pathInput.disabled && !scanState.pending && scanState.path !== null) modal.pathInput.value = scanState.path;
        modal.pathInput.disabled = !!scanState.pending;
        modal.startScan.disabled = !!scanState.pending || !modal.scanReady;
        modal.scanFeedback.setAttribute('aria-busy', String(!!scanState.pending));
        paintScanStatus(modal.scanFeedback);
      }
      if (changed) refreshImported();
    }
    function startScan(current) {
      if (!active || modal !== current || scanState.pending || !current.scanReady || !scanState.token) return;
      const path = current.pathInput.value.trim();
      if (!path) { errorAt(current.scanFeedback, Error('请输入 RKPP 目录或 opencode_summary.csv 的路径')); current.pathInput.focus(); return; }
      aborts.get('scan-path')?.abort(); current.pathFeedback.replaceChildren();
      scanState.path = path; scanState.result = null; scanState.error = null;
      // Call request immediately: even while queued behind reads the write is
      // already in the shared close barrier. Never pass a page/modal abort signal.
      const task = request('scan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Battle-Scan-Token': scanState.token }, body: JSON.stringify({ path }) });
      scanState.pending = task; syncScan();
      task.then(result => {
        scanState.result = result;
        if (typeof result?.path === 'string') scanState.path = result.path;
      }, error => { scanState.error = error; }).finally(() => {
        scanState.pending = null;
        const changed = counter(scanState.result?.imported) > 0 || counter(scanState.result?.updated) > 0;
        scanChanged?.(changed);
      });
    }
    async function loadScanPath(current) {
      if (!active || modal !== current || scanState.pending) return;
      const abort = controller('scan-path'); current.scanReady = false; syncScan();
      current.pathFeedback.replaceChildren(note('正在读取上次路径（不会扫描文件）…'));
      try {
        const result = await request('scan', { signal: abort.signal });
        if (!active || modal !== current || abort.signal.aborted) return;
        if (typeof result?.path !== 'string' || typeof result.scanToken !== 'string' || !result.scanToken) throw Error('无法读取扫描配置，请重试');
        // Session authorization is memory-only, never displayed or persisted.
        // Re-read on opening so a restarted service cannot leave a stale token.
        scanState.token = result.scanToken; current.scanReady = true;
        // A slow metadata read must not overwrite a path already typed.
        if (scanState.path === null) { scanState.path = result.path; current.pathInput.value = result.path; }
        current.pathFeedback.replaceChildren(); syncScan();
      } catch (error) {
        if (active && modal === current && !abort.signal.aborted) errorAt(current.pathFeedback, error, () => loadScanPath(current));
      }
    }
    function openScan() {
      if (!active) return;
      openPageModal('scan', '扫描采集记录', '扫描路径与结果', scanBtn);
      const current = modal, pathInput = input('text', 'scanPath', scanState.path ?? '');
      current.dialog.className += ' br-scan-dialog';
      pathInput.spellcheck = false; pathInput.autocomplete = 'off';
      pathInput.placeholder = 'RKPP 根目录、runs / 单次 run 目录，或 opencode_summary.csv';
      pathInput.addEventListener('input', () => { if (active && modal === current && !scanState.pending) scanState.path = pathInput.value; });
      const pathFeedback = make('div'), scanFeedback = make('div');
      pathFeedback.setAttribute('aria-live', 'polite'); scanFeedback.setAttribute('role', 'status');
      const start = button('开始扫描', () => startScan(current), true); start.dataset.br = 'start-scan';
      const actions = make('div', 'br-actions'); actions.append(start);
      Object.assign(current, { pathInput, pathFeedback, scanFeedback, startScan: start, scanReady: !!scanState.pending });
      current.body.append(field('采集记录路径', pathInput), note('只读取 opencode_summary.csv 摘要，不读取密钥或 PCAP；仅点击「开始扫描」才补录历史记录。'), pathFeedback, actions, scanFeedback);
      syncScan();
      if (!scanState.pending) pathInput.focus({ preventScroll: true });
      loadScanPath(current);
    }
    async function loadExportStatus(current) {
      if (!active || modal !== current || current.exportBusy) return;
      const abort = controller('export-source'); current.exportReady = false;
      current.formats.forEach(node => { node.disabled = true; });
      current.feedback.replaceChildren(note('正在读取转换前事件归档状态…'));
      try {
        if (!client()?.getSourceEventsStatus) throw Error('转换前事件导出客户端尚未就绪，请重新载入页面');
        const status = await client().getSourceEventsStatus({ signal: abort.signal });
        if (!active || modal !== current || abort.signal.aborted) return;
        current.sourceStatus = status; current.feedback.replaceChildren();
        if (!status.available || status.count === 0) current.feedback.append(note(SOURCE_EMPTY));
        else {
          current.exportReady = true;
          current.feedback.append(note(`可导出已归档转换前事件 ${status.count} 条 · ${status.bytes} 字节；不受当前筛选影响，不包含未归档的旧战报源。`));
          if (status.complete === false) current.feedback.append(note('归档存在未保留的来源；本次只导出已安全保留的原事件。'));
        }
        for (const issue of arr(status.issues)) {
          const message = typeof issue === 'string' ? issue : issue?.message;
          if (typeof message === 'string' && message) current.feedback.append(note(message));
        }
        current.formats.forEach(node => { node.disabled = !current.exportReady; });
      } catch (error) { if (active && modal === current && !abort.signal.aborted) errorAt(current.feedback, error, () => loadExportStatus(current)); }
    }
    async function downloadSource(current, format) {
      if (!active || modal !== current || !current.exportReady || current.exportBusy) return;
      const abort = controller('export-source'); current.exportBusy = true;
      current.formats.forEach(node => { node.disabled = true; }); current.feedback.replaceChildren(note('正在导出已归档的转换前原事件…'));
      try {
        const result = await client().exportSourceEvents(format, { signal: abort.signal });
        if (!active || modal !== current || abort.signal.aborted) return;
        if (result.count === 0) { current.feedback.replaceChildren(note(SOURCE_EMPTY)); current.exportReady = false; return; }
        if (!root.URL?.createObjectURL || !root.URL?.revokeObjectURL) throw Error('当前环境无法下载文件，请重新载入页面');
        const url = root.URL.createObjectURL(result.blob), anchor = make('a');
        anchor.href = url; anchor.download = result.filename; anchor.hidden = true; doc.body.append(anchor);
        try { anchor.click(); }
        finally {
          anchor.remove();
          // This independent release intentionally survives page leave: immediate
          // revocation can invalidate the browser's pending download navigation.
          root.setTimeout(() => root.URL.revokeObjectURL(url), 1000);
        }
        current.feedback.replaceChildren(note('已发起转换前事件下载；未转换或重写源内容，也不反推旧战报。'));
        if (result.complete === false || current.sourceStatus?.complete === false) current.feedback.append(note('归档存在未保留的来源；下载不代表全部旧战报原事件完整。'));
      } catch (error) { if (active && modal === current && !abort.signal.aborted) errorAt(current.feedback, error, () => downloadSource(current, format)); }
      finally {
        current.exportBusy = false;
        if (active && modal === current && !abort.signal.aborted) current.formats.forEach(node => { node.disabled = !current.exportReady; });
      }
    }
    function openExport() {
      if (!active) return;
      openPageModal('export-source', '导出对局记录', '选择转换前事件导出格式', exportBtn);
      const current = modal, feedback = make('div', 'br-feedback'), actions = make('div', 'br-actions'); feedback.setAttribute('role', 'status');
      const formats = ['json', 'ndjson'].map(format => button(format.toUpperCase(), () => downloadSource(current, format)));
      actions.append(...formats); Object.assign(current, { feedback, formats, exportBusy: false, exportReady: false });
      current.body.append(note('导出为转换成战报前的RKPP源事件，包含账号标识等个人信息，请勿直接公开。不会自动上传。'), note('选择 JSON 数组或 NDJSON；导出全部已归档 RKPP 转换前原事件，不是 Wiki 规范化战报，不受时间、精灵或体系筛选影响。'), actions, feedback);
      loadExportStatus(current);
    }
    let lastFile = null;
    async function importSelected(file) {
      if (!active || importing || !file) return;
      lastFile = file; importing = true; importBtn.disabled = true; importStatus.replaceChildren(note('正在导入；只保存后端接受的规范化记录…'));
      try {
        if (!file.size || file.size > 8 * 1024 * 1024) throw Error('请选择非空且不超过 8 MiB 的 JSON / NDJSON；较大记录请分批导入');
        if (!/\.(json|ndjson|jsonl)$/i.test(file.name)) throw Error('仅支持 JSON / NDJSON / JSONL；PCAP 请先交给外部解析器');
        const payload = await file.text(); if (!active) return;
        const result = await request('import', { method: 'POST', headers: { 'Content-Type': /\.(ndjson|jsonl)$/i.test(file.name) ? 'application/x-ndjson' : 'application/json' }, body: payload });
        if (!active) return;
        importStatus.replaceChildren(note(`导入完成：${text(result.imported)} 条；重复 ${text(result.duplicates)} 条。`));
        lastFile = null; invalidateStats();refresh(); if (state.selectedId) loadDetail(state.selectedId);
      } catch (error) { if (active) errorAt(importStatus, error, () => importSelected(lastFile)); }
      finally { importing = false; if (active) { importBtn.disabled = false; importFile.value = ''; } }
    }
    importFile.addEventListener('change', () => importSelected(importFile.files?.[0]));

    const relay = make('details', 'br-card br-relay'); relay.append(make('summary', '', '实时接入 · RKPP'));
    relay.append(note('「启动」由本机服务启动已配置的 RKPP 并自动连接；不安装驱动。手动连接已有中继时使用下面的 URL。停止会断开接入，只结束本软件启动的进程，不关闭外部已运行的 RKPP。'));
    const relayControls = make('div', 'br-relay-controls'), relayURL = input('url', 'relayURL', state.relayURL); relayURL.spellcheck = false;
    relayURL.addEventListener('input', () => { state.relayURL = relayURL.value; });
    const startBtn = button('启动', () => changeRuntime('start'), true), stopBtn = button('停止', () => changeRuntime('stop'));
    startBtn.title = '启动RKPP并且连接'; stopBtn.title = '断开接入并停止本软件启动的RKPP';
    const connectBtn = button('连接中继', () => changeRelay('start')); connectBtn.title = '仅连接已经运行的本地中继';
    const statusBtn = button('刷新状态', () => loadStatus());
    const relayStatus = make('div', 'br-relay-status'), runtimeStatus = make('div', 'br-runtime-status'); relayStatus.setAttribute('role', 'status'); runtimeStatus.setAttribute('role', 'status');
    let runtimeState = 'unknown', runtimeOwned = false, runtimeConnected = false;
    relayControls.append(field('本地中继 URL（手动连接）', relayURL), startBtn, stopBtn, connectBtn, statusBtn); relay.append(relayControls, runtimeStatus, relayStatus);
    function syncRelayButtons() {
      startBtn.disabled = liveBusy || runtimeConnected || ['starting', 'stopping'].includes(runtimeState);
      connectBtn.disabled = liveBusy || ['running', 'connecting'].includes(liveState);
      stopBtn.disabled = liveBusy || liveState === 'stopped' && !runtimeOwned && runtimeState !== 'running'; // unknown/error must still permit an explicit stop
      statusBtn.disabled = liveBusy; relayURL.disabled = liveBusy || ['running', 'connecting'].includes(liveState);
    }
    function showRuntimeStatus(status) {
      runtimeState = status.state || 'unknown'; runtimeOwned = status.owned === true; runtimeConnected = status.connected === true;
      if (runtimeState === 'error' || status.error) { statusFailed = true; runtimeConnected = false; stopProgress(); }
      const labels = { stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', error: '异常', unknown: '状态未知' };
      runtimeStatus.replaceChildren(note(`RKPP：${labels[runtimeState] || '状态未知'} · ${runtimeConnected ? '接入已连接' : '接入尚未连接'}${runtimeOwned ? ' · 由本软件启动' : ''}`));
      if (status.error) runtimeStatus.append(make('p', 'br-error', status.error));
      syncRelayButtons();
    }
    function showStatus(status) {
      liveState = status.state || 'unknown';
      const labels = { stopped: '已停止', connecting: '连接中', running: '中继已连接（不代表游戏字段已验证）', error: '接入异常', unknown: '状态未知' };
      // Relay's legacy imported counts all changed writes; updated is a subset,
      // unlike scan's new-only imported. Display the subset without adding twice.
      const imported = counter(status.imported), updated = counter(status.updated);
      relayStatus.replaceChildren(note(`状态：${labels[liveState] || '未知'} · 已接收消息 ${text(counter(status.received))} · 忽略非对战 ${text(counter(status.ignored))} · 已写入 ${text(imported)}（其中更新 ${text(updated)}） · 待完成 ${text(counter(status.pending))} · 不支持 ${text(counter(status.unsupported))}`));
      if (counter(status.received) > 0 && imported === 0 && !(updated > 0)) relayStatus.append(note('尚未报告成功导入或更新的战报；接收消息不等于导入成功。'));
      if (status.url) relayStatus.append(note(`当前连接：${status.url}`));
      if (status.error) relayStatus.append(make('p', 'br-error', status.error));
      if (liveState === 'error' || status.error) {
        statusFailed = true; runtimeConnected = false; stopProgress();
        if (runtimeState !== 'error') runtimeStatus.replaceChildren(note('RKPP：接入异常 · 连接尚未确认'));
      }
      syncRelayButtons();
      // First observation (including a newly available optional counter) is a
      // baseline, not an import. Resets, ignored messages and replay are not writes.
      const changed = importedCount !== null && imported !== null && imported > importedCount || updatedCount !== null && updated !== null && updated > updatedCount;
      if (imported !== null) importedCount = imported;
      if (updated !== null) updatedCount = updated;
      if (changed) refreshImported();
    }
    function stopProgress() { runtimeProgress.deadline = null; clearTimeout(progressTimer); progressTimer = null; }
    function statusFailure(host, error) {
      statusFailed = true; runtimeConnected = false; runtimeState = 'error';
      clearTimeout(pollTimer); clearTimeout(progressTimer); progressTimer = null;
      if (host !== runtimeStatus) runtimeStatus.replaceChildren(note('RKPP：状态未知 · 连接尚未确认'));
      errorAt(host, error, loadStatus); syncRelayButtons();
    }
    function progressTimeout() {
      if (!active || runtimeProgress.deadline === null) return;
      aborts.get('status')?.abort(); aborts.get('runtime-receiver')?.abort();
      statusFailure(runtimeStatus, Error('RKPP 状态确认超时（20秒）；请刷新状态查看当前结果，不会自动重试启动。'));
    }
    function beginProgress() {
      runtimeProgress.deadline = Date.now() + 20000; statusFailed = false;
      clearTimeout(progressTimer); progressTimer = setTimeout(progressTimeout, 20000);
    }
    function scheduleStatus() {
      clearTimeout(pollTimer); pollTimer = null;
      if (!active || statusFailed) return;
      const transitioning = ['starting', 'stopping'].includes(runtimeState) && !runtimeConnected;
      if (transitioning) {
        if (runtimeProgress.deadline === null) beginProgress(); // backend already starting on remount
        const remaining = runtimeProgress.deadline - Date.now();
        if (remaining <= 0) { progressTimeout(); return; }
        if (progressTimer === null) progressTimer = setTimeout(progressTimeout, remaining);
        pollTimer = setTimeout(loadStatus, Math.min(500, remaining));
      } else {
        stopProgress();
        if (runtimeConnected || runtimeState === 'running' || ['connecting', 'running'].includes(liveState)) pollTimer = setTimeout(loadStatus, 2500);
      }
    }
    async function loadStatus() {
      if (!active) return;
      if (liveBusy || statusRead) { scheduleStatus(); return; } // keep lifecycle, never duplicate an in-flight read
      clearTimeout(pollTimer); pollTimer = null; statusFailed = false;
      const abort = controller('status');
      const work = (async () => {
        const results = await Promise.allSettled([
          client()?.getRKPPStatus ? client().getRKPPStatus({ signal: abort.signal }) : Promise.resolve(null),
          request('status', { method: 'GET', signal: abort.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
        ]);
        if (!active || abort.signal.aborted) return;
        const [runtime, receiver] = results;
        if (runtime.status === 'rejected' || receiver.status === 'rejected') {
          if (runtime.status === 'rejected') statusFailure(runtimeStatus, runtime.reason);
          if (receiver.status === 'rejected') { liveState = 'unknown'; statusFailure(relayStatus, receiver.reason); }
          return;
        }
        if (runtime.value) showRuntimeStatus(runtime.value);
        showStatus(receiver.value);
        if (runtimeState === 'error' || receiver.value?.state === 'error' || runtime.value?.error || receiver.value?.error) {
          statusFailed = true; runtimeConnected = false; stopProgress(); syncRelayButtons();
        }
      })();
      statusRead = work;
      try { await work; }
      finally { if (statusRead === work) statusRead = null; if (active) scheduleStatus(); }
    }
    async function changeRuntime(operation) {
      if (!active || liveBusy) return;
      clearTimeout(pollTimer); aborts.get('status')?.abort(); liveBusy = true;
      runtimeState = operation === 'start' ? 'starting' : 'stopping'; runtimeConnected = false; beginProgress(); syncRelayButtons();
      runtimeStatus.replaceChildren(note(operation === 'start' ? '正在启动RKPP并连接…' : '正在断开接入并停止本软件启动的RKPP…'));
      try {
        const action = operation === 'start' ? client()?.startRKPP : client()?.stopRKPP;
        if (!action) throw Error('RKPP 本机服务客户端尚未就绪，请重新载入页面');
        const status = await action();
        if (!active || statusFailed) return; showRuntimeStatus(status);
        const abort = controller('runtime-receiver');
        const receiver = await request('status', { method: 'GET', signal: abort.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        if (active && !abort.signal.aborted && !statusFailed) showStatus(receiver);
      } catch (error) { if (active && !statusFailed) statusFailure(runtimeStatus, error); }
      finally { liveBusy = false; if (active) { syncRelayButtons(); scheduleStatus(); } }
    }
    async function changeRelay(operation) {
      if (!active || liveBusy) return;
      if (operation === 'start' && !relayURL.reportValidity()) return;
      clearTimeout(pollTimer); aborts.get('status')?.abort(); liveBusy = true; statusFailed = false; syncRelayButtons();
      relayStatus.replaceChildren(note(operation === 'start' ? '正在连接已有中继…' : '正在停止接入…'));
      try {
        const status = await request('relay/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation === 'start' ? { url: relayURL.value.trim() } : {}) });
        if (active) showStatus(status);
      } catch (error) { if (active) { liveState = 'unknown'; statusFailure(relayStatus, error); } }
      finally { liveBusy = false; if (active) { syncRelayButtons(); scheduleStatus(); } }
    }

    const helper = timeFilters();
    const filters = make('form', 'filter-panel br-filters'); filters.id = 'br-filter-panel'; filters.hidden = true; filters.setAttribute('aria-label', '对战记录共享筛选');
    const fields = {}, grid = make('div', 'br-filter-grid');
    let draftTime = { from: state.filters.from, to: state.filters.to, toExclusive: state.filters.toExclusive, season: state.filters.season, week: state.filters.week };
    const seasonHost = make('div', 'br-season-list'), weekHost = make('div', 'br-week-list'), currentPeriod = make('p', 'br-note'); currentPeriod.dataset.br = 'current-period';
    seasonHost.setAttribute('aria-label', '赛季'); weekHost.setAttribute('aria-label', '赛季周次');
    function paintSeasons() {
      const focused = doc.activeElement, focusSeason = seasonHost.contains(focused) ? focused.dataset.season : null, focusWeek = weekHost.contains(focused) ? focused.dataset.week : null;
      seasonHost.replaceChildren(); weekHost.replaceChildren();
      const seasons = helper?.seasons() || [], current = seasons.find(season => season.current), week = current?.weeks.find(week => week.current);
      currentPeriod.textContent = current ? `当前 S${current.number}${week ? ` · 第${week.number}周` : ''}` : '';
      for (const season of seasons) {
        const choose = button(`S${season.number}`, () => selectPeriod(season.number)); choose.dataset.season = String(season.number);
        choose.title = season.name; choose.setAttribute('aria-pressed', String(draftTime.season === season.number)); seasonHost.append(choose);
      }
      const selected = seasons.find(season => season.number === draftTime.season);
      for (const week of selected?.weeks || []) {
        const choose = button(`第${week.number}周`, () => selectPeriod(selected.number, week.number)); choose.dataset.week = String(week.number);
        choose.disabled = !week.started; choose.setAttribute('aria-pressed', String(draftTime.week === week.number)); weekHost.append(choose);
      }
      const replacement = focusSeason ? [...seasonHost.children].find(node => node.dataset.season === focusSeason) : focusWeek ? [...weekHost.children].find(node => node.dataset.week === focusWeek) : null;
      if (!filters.hidden && replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    }
    function selectPeriod(season, week) {
      const interval = helper?.bounds(season, week); if (!interval) return;
      draftTime = { ...interval, season, week: week ?? null };
      paintSeasons(); applyFilters();
    }
    fields.outcome = select('outcome', [['', '全部结果'], ...Object.entries(OUTCOMES)], state.filters.outcome); grid.append(field('对战结果', fields.outcome));
    let selectedMonster = state.filters.monsterId;
    const monster = monsterPicker('精灵', id => { selectedMonster = id; }); monster.set(selectedMonster);
    const monsterField = make('div', 'br-field'); monsterField.append(make('span', 'br-label', '精灵'), monster.wrap); grid.append(monsterField);
    const teamMenu=menuSelect('teamRuleId',[['','全部体系'],...(state.filters.teamRuleId && state.filters.teamRuleId!=='__other__'?[[state.filters.teamRuleId,'正在读取已选体系…']]:[]),['__other__','其他']],state.filters.teamRuleId);fields.teamRuleId=teamMenu.control;grid.append(field('敌方阵容体系',teamMenu.wrap));
    const rankPanel = make('section', 'br-rank-filter'), unlimitedRank = input('checkbox', 'rankUnlimited'); unlimitedRank.checked = !state.filters.rankMetric;
    rankPanel.append(title('敌方赛前名次', 'h4'), field('不限名次', unlimitedRank));
    let rankValues = { rankMin: state.filters.rankMin === '' ? 1 : Number(state.filters.rankMin), rankMax: state.filters.rankMax === '' ? 100000 : Number(state.filters.rankMax) };
    const rankSliders = {}, rankLabels = {}, rankTrack=make('div','br-rank-track'), rankReadouts=make('div','br-rank-readouts');rankPanel.append(rankTrack,rankReadouts);
    const syncRank = () => {
      for (const key of ['rankMin', 'rankMax']) {
        rankSliders[key].value = String(helper?.rankIndex(rankValues[key]) ?? (key === 'rankMin' ? 0 : 100));
        rankSliders[key].setAttribute('aria-valuetext', String(rankValues[key])); rankLabels[key].textContent = String(rankValues[key]);
      }
      rankPanel.dataset.unlimited = String(unlimitedRank.checked);rankTrack.style.setProperty('--rank-low',String(helper?.rankIndex(rankValues.rankMin)??0)+'%');rankTrack.style.setProperty('--rank-high',String(helper?.rankIndex(rankValues.rankMax)??100)+'%');
    };
    for (const [key, label] of [['rankMin', '名次下限'], ['rankMax', '名次上限']]) {
      const slider = input('range', key), output = make('output'); slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.setAttribute('aria-label', label);
      slider.disabled = !helper; rankSliders[key] = slider; rankLabels[key] = output;
      rankTrack.append(slider);const row=make('span');row.append(make('span','',label+' '),output);rankReadouts.append(row);
      slider.addEventListener('input', () => {
        const value = helper?.rankAt(Number(slider.value)); if (value === null || value === undefined) return;
        unlimitedRank.checked = false; rankValues[key] = value;
        if (rankValues.rankMin > rankValues.rankMax) rankValues[key === 'rankMin' ? 'rankMax' : 'rankMin'] = value;
        syncRank(); // Live labels only; no per-pixel network requests.
      });
    }
    unlimitedRank.addEventListener('change', syncRank); syncRank();
    const apply = button('应用筛选', () => {}, true); apply.type = 'submit';
    const reset = button('重置筛选', () => {
      for (const key of Object.keys(fields)) fields[key].value = EMPTY_FILTERS[key];
      draftTime = { from: '', to: '', toExclusive: false, season: null, week: null }; unlimitedRank.checked = true; rankValues = { rankMin: 1, rankMax: 100000 };
      selectedMonster = ''; monster.set(''); fields.teamRuleId.sync(); syncRank(); paintSeasons(); state.filters = { ...EMPTY_FILTERS }; state.page = 1; refresh();
    });
    const filterActions = make('div', 'br-actions'); filterActions.append(apply, reset);
    const queryStatus = make('p', 'br-note'); queryStatus.setAttribute('role', 'status'); queryStatus.dataset.br = 'query-status';
    filters.append(currentPeriod, seasonHost, weekHost, grid, rankPanel, filterActions);
    function applyFilters() {
      const next = { ...EMPTY_FILTERS, ...draftTime, monsterId: selectedMonster, outcome: fields.outcome.value, teamRuleId: fields.teamRuleId.value };
      if (!unlimitedRank.checked) Object.assign(next, { rankMetric: 'rank', rankSide: 'enemy', rankMin: String(rankValues.rankMin), rankMax: String(rankValues.rankMax) });
      try { filterQuery(next); state.filters = next; state.page = 1; refresh(); }
      catch (error) { queryStatus.textContent = error.message; }
    }
    filters.addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
    paintSeasons();

    const navigation = make('div', 'br-navigation'), nav = make('nav', 'br-tabs br-main-nav'); nav.setAttribute('aria-label', '对战记录视图');
    const panels = {}, tabs = {}, navLeft = make('div', 'br-nav-left');
    for (const [key, label] of [['list', '对战列表'], ['stats', '样本统计']]) {
      panels[key] = make('section', 'br-panel'); panels[key].dataset.brPanel = key; panels[key].setAttribute('aria-label', label);
      tabs[key] = button(label, () => showTab(key)); navLeft.append(tabs[key]);
    }
    const timeButton = button('时间范围', () => { if (!filters.hidden) closeFilters(true); else openFilters(); }); timeButton.dataset.br = 'time-filter';
    timeButton.setAttribute('aria-controls', filters.id); timeButton.setAttribute('aria-expanded', 'false');
    nav.append(navLeft, timeButton); navigation.append(nav, filters);
    function closeFilters(restoreFocus = false) {
      if (filters.hidden) return;
      fields.teamRuleId.closeMenu();filters.hidden = true; timeButton.setAttribute('aria-expanded', 'false');
      doc.removeEventListener('pointerdown', outsideFilters, true); doc.removeEventListener('keydown', filterKeys, true); doc.removeEventListener('focusin', filterFocus, true);
      root.removeEventListener?.('resize', filterResize);
      if (restoreFocus && active && timeButton.isConnected) timeButton.focus({ preventScroll: true });
    }
    function outsideFilters(event) { if (!filters.contains(event.target) && !timeButton.contains(event.target)) closeFilters(); }
    function filterKeys(event) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFilters(true); } }
    function filterFocus(event) { if (!filters.contains(event.target) && !timeButton.contains(event.target)) closeFilters(); }
    function filterResize() { closeFilters(filters.contains(doc.activeElement)); }
    function openFilters() {
      if (!active) return; paintSeasons(); filters.hidden = false; timeButton.setAttribute('aria-expanded', 'true');
      doc.addEventListener('pointerdown', outsideFilters, true); doc.addEventListener('keydown', filterKeys, true); doc.addEventListener('focusin', filterFocus, true);
      root.addEventListener?.('resize', filterResize); filters.querySelector('button')?.focus({ preventScroll: true });
    }
    function showTab(key) {
      closeFilters(); closePetTip();
      if (!panels[key]) key = 'list';
      state.tab = key;
      for (const name of Object.keys(panels)) { panels[name].hidden = name !== key; tabs[name].setAttribute('aria-pressed', String(name === key)); }
      if(key==='stats') queueMicrotaskSafe(()=>ensureStats());
    }
    const listStatus = make('div'), listHost = make('div', 'br-match-list'); listHost.dataset.br = 'list';
    const pager = make('div', 'br-pagination'), pageLabel = note(''), previous = button('上一页', () => { if (state.page > 1) { state.page--; refresh(); } }), nextPage = button('下一页', () => { state.page++; refresh(); });
    previous.dataset.br = 'previous'; nextPage.dataset.br = 'next';
    const pageSize = select('pageSize', [['25', '25 条 / 页'], ['50', '50 条 / 页'], ['100', '100 条 / 页']], String(state.pageSize)); pageSize.setAttribute('aria-label', '每页条数');
    pageSize.addEventListener('change', () => { state.pageSize = Number(pageSize.value); state.page = 1; refresh(); });
    pager.append(previous, pageLabel, nextPage, pageSize); panels.list.append(listStatus, listHost, pager);

    function rankText(rank) {
      const values = [];
      if (Number.isFinite(rank?.score) && rank.score >= 0) values.push(`积分 ${rank.score}`);
      if (Number.isSafeInteger(rank?.rank) && rank.rank > 0) values.push(`榜单名次 ${rank.rank}`);
      if (typeof rank?.tier === 'string' && rank.tier.trim()) values.push(`段位 ${rank.tier}`);
      if (Number.isSafeInteger(rank?.stars) && rank.stars >= 0) values.push(`星数 ${rank.stars}`);
      return values.join(' · ');
    }
    function verifiedLead(record, side) {
      const team = record.sides?.[side];
      if (record.quality?.lead?.[side] !== true || typeof team?.lead !== 'string' || !team.lead) return null;
      const matches = arr(team.pets).filter(pet => pet.instanceId === team.lead);
      return matches.length === 1 ? matches[0] : null;
    }
    function sideSummary(record, side) {
      const host = make('div', 'br-side-summary'), s = record.sides?.[side] || {};
      host.append(make('strong', '', `${SIDES[side]} · 初始阵容`));
      const pets = make('div', 'br-roster'), lead = verifiedLead(record, side);
      pets.setAttribute('aria-label', `${SIDES[side]}初始阵容`);
      // One avatar for every original instance, in original order. A nickname,
      // base ID or a later/current form is never an initial-roster identity.
      for (const pet of arr(s.pets)) {
        const item = make('span', 'br-roster-pet'); item.tabIndex = 0;
        item.dataset.instanceId = pet.instanceId; item.dataset.side = side;
        const label = petLabel(pet) + (pet === lead ? ' · 首发（已确认）' : '');
        item.setAttribute('role', 'img');
        attachPetTip(item, pet, { record, side }, label);
        item.append(avatar(pet));
        if (pet === lead) { item.dataset.lead = 'true'; item.append(make('span', 'br-lead-badge', '首发')); }
        pets.append(item);
      }
      if (!arr(s.pets).length) pets.append(note('阵容未知（不是空队）'));
      host.append(pets);
      for (const [key, label] of [['matching', '匹配时'], ['before', '赛前'], ['after', '赛后']]) {
        const rank = rankText(s[key]); if (rank) host.append(note(`${label} ${rank}`));
      }
      return host;
    }
    function renderList(result) {
      closePetTip();
      listStatus.replaceChildren(); listHost.replaceChildren();
      const records = arr(result.records);
      if (!records.length) {
        const empty = make('div', 'br-card br-empty');
        empty.append(title(filterQuery(state.filters).toString() ? '没有符合条件的记录' : '还没有对战记录'), note('选择 JSON / NDJSON 导入，或手动连接已运行的本地中继。不会自动生成示例或开始采集。'), button('选择导入文件', () => importFile.click(), true)); listHost.append(empty);
      }
      for (const record of records) {
        const card = make('article', 'br-card br-match'); card.dataset.recordId = record.id;
        const top = make('div', 'br-match-heading'), resultBadge = make('span', 'br-outcome', OUTCOMES[record.outcome] || OUTCOMES.unknown);
        resultBadge.dataset.outcome = Object.hasOwn(OUTCOMES, record.outcome) ? record.outcome : 'unknown';
        top.append(resultBadge, make('time', '', displayTime(record.startedAt)), button('查看详情', event => openDetail(record.id, event.currentTarget || event.target)));
        const sides = make('div', 'br-sides'); sides.append(sideSummary(record, 'me'), sideSummary(record, 'enemy'));
        card.append(top, note(recordCountsText(record)), sides); listHost.append(card);
      }
      const total = Number.isFinite(result.total) ? result.total : 0, pages = Math.max(1, Math.ceil(total / state.pageSize));
      pageLabel.textContent = `第 ${state.page} / ${pages} 页 · 共 ${total} 场`;
      previous.disabled = state.page <= 1; nextPage.disabled = state.page >= pages;
    }
    // Four independent modules consume the same stats response. Keep the old
    // me/enemy panel IDs for species navigation; switching never re-queries.
    const statsNav = make('nav', 'br-tabs br-stats-tabs'); statsNav.setAttribute('aria-label', '样本统计模块');
    const statsSummary = make('div'), statsStatus = make('div'), statsHosts = {}, statsButtons = {};
    statsStatus.setAttribute('role', 'status');
    for (const [key, label] of [['me', '我方精灵统计'], ['me-lineups', '我方阵容统计'], ['enemy', '敌方精灵统计'], ['enemy-lineups', '敌方阵容统计']]) {
      const host = make('section', 'br-stats-branch'); host.id = `br-stats-${key}`; host.dataset.brStats = key; host.setAttribute('aria-label', label);
      const toggle = button(label, () => { if (active) showStatsSide(key); }); toggle.setAttribute('aria-controls', host.id);
      statsHosts[key] = host; statsButtons[key] = toggle; statsNav.append(toggle);
    }
    panels.stats.append(statsNav, statsStatus, statsSummary, ...Object.values(statsHosts));
    function showStatsSide(key) {
      closePetTip(); state.statsSide = Object.hasOwn(statsHosts, key) ? key : 'me';
      for (const name of Object.keys(statsHosts)) {
        statsHosts[name].hidden = name !== state.statsSide;
        statsButtons[name].setAttribute('aria-pressed', String(name === state.statsSide));
      }
    }
    showStatsSide(state.statsSide);
    let performanceBindings = [];
    const performanceNumber = value => Number.isFinite(value) && value >= 0 ? value > 0 && value < .01 ? '<0.01' : String(Number(value.toFixed(2))) : '—';
    const performanceRate = value => Number.isFinite(value) && value >= 0 && value <= 1 ? `${(value * 100).toFixed(1)}%` : '—';
    function metricList(entries) {
      const list = make('dl', 'br-performance-metrics');
      for (const [label, value] of entries) {
        const term = make('dt', '', label), description = make('dd');
        if (value?.nodeType) description.append(value); else description.textContent = value;
        list.append(term, description);
      }
      return list;
    }
    function performanceValue(totals, averages, field) {
      const value = make('span'); value.dataset.performanceMetric = field;
      const update = () => { value.textContent = performanceNumber((state.performanceMode === 'averages' ? averages : totals)?.[field]); };
      performanceBindings.push(update); update(); return value;
    }
    function performanceRelationship(row, field, direction) {
      const value = performanceValue(row.totals, row.averages, field);
      const prefix = direction === 'outgoing' ? 'outgoing' : 'received', coverage = row.coverage?.[`${prefix}EffectivenessUnknown`];
      // All classifications absent with explicit unknown coverage is unavailable,
      // not three measured zeros. Never relabel that gap as usually effective.
      const noKnownRelationship = coverage > 0 && ['Advantage', 'Resisted', 'Usual'].every(suffix => row.totals?.[prefix + suffix] === 0);
      if (noKnownRelationship) {
        const update = () => { value.textContent = '—'; }; performanceBindings.push(update); update();
      }
      if (coverage > 0) {
        value.tabIndex = 0; value.title = `累计 ${coverage} 次行动的关系未完全确认；只列已确认分类，缺失不补为通常伤害。`;
        const update = () => value.setAttribute('aria-label', `${value.textContent}；${value.title}`); performanceBindings.push(update); update();
      }
      return value;
    }
    function performanceRatio(value, key, label, numerator, denominator, percent = true) {
      // Ratios are authoritative DTO values, never repaired from the displayed
      // counts/averages. Zero or missing denominators remain unavailable.
      const node = make('span', '', Number.isFinite(denominator) && denominator > 0 ? (percent ? performanceRate(value) : performanceNumber(value)) : '—');
      node.dataset.performanceRate = key; node.tabIndex = 0;
      node.title = `累计 ${performanceNumber(numerator)} / ${performanceNumber(denominator)}；${label}不随总计 / 场均切换。`;
      node.setAttribute('aria-label', `${label} ${node.textContent}；${node.title}`);
      return node;
    }
    function performanceDamage(totals, averages, label) {
      const value = make('span', 'br-performance-damage'); value.tabIndex = 0;
      const update = () => {
        const selected = state.performanceMode === 'averages' ? averages : totals;
        const total = Number.isFinite(selected?.actual) && Number.isFinite(selected?.estimated) ? selected.actual + selected.estimated : null;
        const prefix = Number.isFinite(totals?.unresolved) && totals.unresolved > 0 ? '已计' : '合计';
        value.replaceChildren(make('span', '', `${prefix} ${performanceNumber(total)}`));
        if (Number.isFinite(totals?.estimated) && totals.estimated > 0) value.append(make('span', 'br-estimate', ` · 含估 ${performanceNumber(selected?.estimated)}`));
        if (Number.isFinite(totals?.unresolved) && totals.unresolved > 0) value.append(make('span', 'br-coverage-gap', ` · 累计缺 ${performanceNumber(totals.unresolved)} 条`));
        const coverage = `累计实际 ${performanceNumber(totals?.actual)}；累计估算 ${performanceNumber(totals?.estimated)}；未解决 ${performanceNumber(totals?.unresolved)} 条伤害事件（不是HP量）`;
        value.title = `${label}：${coverage}。估算不是实测；未解决部分不计入伤害量。`;
        value.setAttribute('aria-label', `${label}：${value.textContent}。${coverage}`);
      };
      performanceBindings.push(update); update(); return value;
    }
    // Shared count-only SVG renderer. Callers supply already grouped, actual
    // cumulative counts; missing/unsafe totals never become an empty 0% chart.
    function countPie(values, options) {
      const total = values.reduce((sum, entry) => sum + entry.count, 0);
      if (!values.length || values.some(entry => !Number.isSafeInteger(entry.count) || entry.count <= 0) || !Number.isSafeInteger(total) || total <= 0) return null;
      const palette = ['#4387c6', '#d67b3b', '#47866a', '#9a67b5', '#bc536d', '#6c7f30', '#a56b4f', '#587c9a'];
      const svgNode = (tag, attributes = {}, content) => {
        const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        if (content !== undefined) node.textContent = content;
        return node;
      };
      const svg = svgNode('svg', { viewBox: '0 0 200 200', role: 'img', 'aria-label': `${options.label}，累计 ${total} 次`, class: options.pieClass });
      const legend = options.legendClass ? make('ul', options.legendClass) : null;
      legend?.setAttribute('aria-label', options.legendLabel);
      let cumulative = 0;
      values.forEach((entry, index) => {
        const percentage = `${(entry.count / total * 100).toFixed(1)}%`, color = palette[index % palette.length];
        const description = options.describe(entry, percentage);
        let slice;
        if (values.length === 1) slice = svgNode('circle', { cx: 100, cy: 100, r: 96, fill: color });
        else {
          const from = cumulative / total * 2 * Math.PI - Math.PI / 2;
          cumulative += entry.count;
          const to = cumulative / total * 2 * Math.PI - Math.PI / 2;
          const point = angle => `${100 + Math.cos(angle) * 96} ${100 + Math.sin(angle) * 96}`;
          slice = svgNode('path', { d: `M 100 100 L ${point(from)} A 96 96 0 ${entry.count / total > .5 ? 1 : 0} 1 ${point(to)} Z`, fill: color });
        }
        slice.setAttribute('data-count', String(entry.count));
        slice.append(svgNode('title', {}, description)); svg.append(slice);
        const item = legend ? make('li') : null;
        options.identify?.(entry, slice, item);
        if (item) {
          item.title = description;
          const swatch = make('span', options.swatchClass); swatch.style.setProperty('background-color', color); swatch.setAttribute('aria-hidden', 'true');
          item.append(swatch);if(options.icon) {const icon=options.icon(entry);if(icon)item.append(icon);}item.append(make('span', '', description)); legend.append(item);
        }
      });
      return { svg, legend, total };
    }
    const departureReasons = [['defeat', '被击杀', 'cause'], ['forced', '被迫离场', 'cause'], ['self', '自行离场', 'facing']];
    function performanceDepartures(row, side) {
      const host = make('div');
      // Backend self includes manual switching and own-skill departures. Never
      // add legacy voluntary again or repair totals from visible reason fields.
      const entries = [['total', '离场总计'], ['defeat', '被击杀'], ['forced', '被迫离场'], ['self', '自行离场']]
        .map(([key, label]) => [label, performanceValue(row.totals?.departures, row.averages?.departures, key)]);
      const growth = arr(currentStats?.growth?.[side]).find(item => item.monsterId === row.monsterId);
      const growthValue = (item, kind) => {
        const node = make('span', '', item?.samples > 0 ? performanceNumber(item.average) : '—'); node.dataset.growthKind = kind;
        node.title = `已知 ${performanceNumber(item?.samples)} 场；未确认 ${performanceNumber(item?.unknown)} 场。仅展示已确认场均，不随总计切换。${typeof item?.unit === 'string' && item.unit ? ` ${item.unit}` : ''}`;
        node.tabIndex = 0; return node;
      };
      if (growth?.trait) entries.push(['场均特性触发', growthValue(growth.trait, 'trait')]);
      for (const skill of arr(growth?.skills)) {
        const branch = { power: '威力', hits: '连击' }[skill.branch];
        const label = `${skill.name || skillName(skill.skillId)}叠层数${branch ? `（${branch}）` : ''}`;
        const value = growthValue(skill, 'skill'); value.dataset.skillId = String(skill.skillId); if (branch) value.dataset.branch = skill.branch;
        entries.push([label, value]);
      }
      if (row.monsterId === 501) {
        const roller = row.rollerCoaster;
        entries.push(['过山车成功率', performanceRatio(roller?.successRate, 'rollerCoasterSuccess', '过山车成功率', roller?.successBattles, roller?.carriedBattles)],
          ['成功过山车后的胜率', performanceRatio(roller?.winRate, 'rollerCoasterWin', '成功过山车后的胜率', roller?.wins, roller?.knownOutcomeBattles)]);
      }
      host.append(metricList(entries)); return host;
    }
    function renderDepartureCharts(row) {
      if (modal?.kind !== 'departures') return;
      const host = modal.body; host.replaceChildren(); host.setAttribute('aria-busy', 'false');
      host.append(title(petLabel({ monsterId: row.monsterId })));
      renderOwnSkillUsage(host, row.monsterId);
      host.append(title('离场原因与对手'), note('按累计次数展示。来源表示已确认的离场来源；当时面对不表示强制来源。'));
      const groups = make('div', 'br-departure-charts');
      for (const [reason, label, expectedAttribution] of departureReasons) {
        const entries = new Map();
        for (const opponent of arr(row.departuresByOpponent)) {
          const count = opponent?.totals?.[reason];
          if (!Number.isSafeInteger(count) || count <= 0) continue;
          // Only the backend's matching cause/facing identity may name a slice.
          // Unknown identity keeps the known reason, never a replacement avatar.
          const mapped = opponent.attribution === expectedAttribution && Number.isSafeInteger(opponent.monsterId) && opponent.monsterId > 0;
          const monsterId = mapped ? opponent.monsterId : 0, key = String(monsterId);
          const entry = entries.get(key) || { monsterId, attribution: mapped ? expectedAttribution : 'unknown', count: 0 };
          entry.count += count; entries.set(key, entry);
        }
        if (!entries.size) continue;
        const section = make('section', 'br-departure-reason'); section.dataset.reason = reason;
        section.append(title(label)); groups.append(section);
        const attributionLabel = expectedAttribution === 'cause' ? '来源' : '当时面对';
        const chart = countPie([...entries.values()], {
          pieClass: 'br-departure-pie', legendClass: 'br-departure-legend', swatchClass: 'br-departure-swatch',
          label: `${label}：${attributionLabel}精灵占比`, legendLabel: `${label}：${attributionLabel}精灵、累计次数与占比`,
          describe(entry, percentage) {
            const canonical = entry.monsterId > 0 ? data()?.getMonsterById?.(entry.monsterId) : null;
            const name = canonical ? data().getMonsterDisplayName(canonical) : '未确认精灵';
            return `${attributionLabel}：${name} · ${entry.count} 次 · ${percentage}`;
          },
          icon: entry => entry.monsterId>0?avatar({monsterId:entry.monsterId}):null,
          identify(entry, slice, item) {
            slice.setAttribute('data-opponent-id', String(entry.monsterId));
            item.dataset.opponentId = String(entry.monsterId); item.dataset.attribution = entry.attribution;
          }
        });
        if (!chart) { section.append(note('累计次数不可用，未绘制占比。')); continue; }
        section.dataset.total = String(chart.total);
        section.append(note(`${attributionLabel} · 累计 ${chart.total} 次`));
        const layout = make('div', 'br-departure-chart');
        layout.append(chart.svg, chart.legend); section.append(layout);
      }
      if (!groups.children.length) groups.append(note('暂无已确认原因的对手离场明细。'));
      host.append(groups);
      if (!modal.dialog.contains(doc.activeElement)) modal.close.focus({ preventScroll: true });
    }
    function openDepartures(row, trigger) {
      if (!active || !trigger?.isConnected) return;
      if (modal?.kind === 'departures' && modal.monsterId === row.monsterId) { modal.close.focus({ preventScroll: true }); return; }
      openPageModal('departures', '精灵详情', '精灵技能使用与离场原因', trigger, { monsterId: row.monsterId });
      renderDepartureCharts(row);
    }
    function renderPerformancePets(host, performance, side = 'me') {
      const rows = arr(performance.species).map(row => {
        const identity = make('div'); identity.dataset.performanceMonsterId = String(row.monsterId ?? '');
        const identityMetrics = [
          ['携带局数', performanceNumber(row.carriedBattles)],
          ...(side === 'me' ? [['登场局数', performanceNumber(row.enteredBattles)]] : []),
          ['进场次数', performanceValue(row.totals, row.averages, 'entries')]
        ];
        if (side === 'enemy') identityMetrics.push(
          ['携带率', performanceRatio(row.carryRate, 'carryRate', '携带率', row.carryOccurrences, row.carrySamples)],
          ['精灵胜率', performanceRatio(row.winRate, 'winRate', '敌方携带者已知结果胜率', row.wins, row.knownOutcomeBattles)]);
        identity.append(petLine({ monsterId: row.monsterId }), metricList(identityMetrics));
        if (side === 'me') {
          const open = button('精灵详情', event => openDepartures(row, event.currentTarget || event.target));
          open.className = 'br-departure-open'; open.dataset.departureMonsterId = String(row.monsterId ?? ''); open.setAttribute('aria-haspopup', 'dialog'); identity.append(open);
        }
        const counts = entries => entries.map(([field, label]) => [label, performanceValue(row.totals, row.averages, field)]);
        const relationships = direction => [['Advantage', '克制伤害次数'], ['Resisted', '抵抗伤害次数'], ['Usual', '通常伤害次数']].map(([suffix, label]) => [label, performanceRelationship(row, direction + suffix, direction)]);
        const outgoing = metricList([...counts([['kills', '击杀数']]),
          ['每死攻击数', performanceRatio(row.attackPerDeath, 'attackPerDeath', '每死攻击数', row.totals?.attackActions, row.totals?.deaths, false)], ...relationships('outgoing'),
          ['伤害总量', performanceDamage(row.totals?.damageDealt, row.averages?.damageDealt, '伤害总量')]]);
        const response = metricList([...counts([['attackActions', '攻击次数'], ['statusActions', '状态次数'], ['defenseActions', '防御次数']]),
          ['攻击被应对率', performanceRatio(row.attackCounteredRate, 'attackCounteredRate', '攻击被应对率', row.totals?.attackCountered, row.totals?.attackAttempts)],
          ['状态被应对率', performanceRatio(row.statusCounteredRate, 'statusCounteredRate', '状态被应对率', row.totals?.statusCountered, row.totals?.statusAttempts)],
          ['防御成功率', performanceRatio(row.defenseSuccessRate, 'defenseSuccessRate', '防御成功率', row.totals?.defenseSuccess, row.totals?.defenseAttempts)]]);
        const received = metricList([...counts([['receivedActions', '受击数']]),
          ['每死受击数', performanceRatio(row.receivedPerDeath, 'receivedPerDeath', '每死受击数', row.totals?.receivedActions, row.totals?.deaths, false)], ...relationships('received'),
          ['受击总量', performanceDamage(row.totals?.damageReceived, row.averages?.damageReceived, '受击总量')]]);
        return [identity, outgoing, response, received, performanceDepartures(row, side)];
      });
      const grid = table(['精灵 / 出场样本', '进攻表现', '应对表现', '受击表现', '离场记录'], rows, Array.isArray(performance.species) ? `当前筛选下暂无可归属的${side === 'enemy' ? '敌方' : '我方'}精灵样本。` : '统计接口未提供精灵表现明细。');
      grid.className += ' br-performance-table'; host.append(grid);
    }
    function openOwnLineup(lineup, trigger) {
      const key=lineupKey(lineup);if(!active||!key||!trigger?.isConnected)return;
      state.selectedLineupKey=key;openPageModal('own-lineup','我方阵容 · 对局与技能','所选精确阵容统计',trigger,{lineupKey:key});
      modal.dialog.className+=' br-member-dialog';paintOwnLineup(lineup);
    }
    function paintOwnLineup(lineup) {
      if(modal?.kind!=='own-lineup')return;modal.body.replaceChildren();
      const roster=make('div','br-lineup-roster');for(const id of arr(lineup.monsterIds))roster.append(petLine({monsterId:id}));modal.body.append(roster);
      renderOwnMatchups(modal.body,lineup);
      const rows=arr(lineup.selfSkills);
      for(const id of [...new Set(arr(lineup.monsterIds))])renderOwnSkillUsage(modal.body,id,rows);
    }
    function renderPerformanceLineups(host, performance) {
      const section=make('section','br-performance-lineups');section.setAttribute('aria-label','我方阵容统计');section.append(ownStatsTitle('我方阵容统计'));host.append(section);
      const lineups=arr(performance.completeLineups).filter(x=>x&&typeof x==='object'),controls=[];
      if(!lineups.some(x=>lineupKey(x)&&lineupKey(x)===state.selectedLineupKey))state.selectedLineupKey='';
      const rows=lineups.map((lineup,index)=>{
        const composition=make('div','br-lineup-roster');for(const id of arr(lineup.monsterIds))composition.append(petLine({monsterId:id}));
        const key=lineupKey(lineup),choose=button('查看对局',event=>{event.stopPropagation?.();openOwnLineup(lineup,event.currentTarget||event.target);});choose.className='br-lineup-select';choose.disabled=!key;choose.dataset.lineupKey=key;choose.setAttribute('aria-haspopup','dialog');choose.setAttribute('aria-label',`查看阵容 ${index+1} 的体系对局`);composition.append(choose);controls.push({choose,lineup,index});
        composition.setAttribute('aria-label','精确阵容成员');
        const outcomes=make('div');outcomes.append(make('strong','',performanceRate(lineup.winRate)),note(`已知结果 ${performanceNumber(lineup.knownOutcomes)} / ${performanceNumber(lineup.battles)} 场`),note(`胜 ${performanceNumber(lineup.wins)} · 负 ${performanceNumber(lineup.losses)} · 平 ${performanceNumber(lineup.draws)} · 未知 ${performanceNumber(lineup.unknown)}`));
        const rounds=make('div');rounds.append(make('span','',Number.isFinite(lineup.averageRounds)&&lineup.averageRounds>=0?`${performanceNumber(lineup.averageRounds)} 回合`:'—'),note(`回合样本 ${performanceNumber(lineup.roundSamples)} 场`));
        const time=make('div'),seconds=Number.isFinite(lineup.averageDurationSeconds)&&lineup.averageDurationSeconds>=0?Math.round(lineup.averageDurationSeconds):null;time.append(make('span','',seconds===null?'—':`${Math.floor(seconds/60)}分钟${seconds%60}秒`),note(`用时样本 ${performanceNumber(lineup.durationSamples)} 场`));
        return [composition,performanceNumber(lineup.battles),outcomes,rounds,time];
      });
      const grid=table(['精确阵容','对战局数','胜率 / 结果样本','平均回合','平均用时'],rows,Array.isArray(performance.completeLineups)?'当前筛选下暂无完整且可确认的我方阵容样本。':'统计接口未提供我方阵容明细。');section.append(grid);
      for(const {choose,lineup,index} of controls){const row=choose.parentNode.parentNode.parentNode;row.className='br-lineup-row';row.dataset.lineupSelectable=String(!choose.disabled);row.tabIndex=choose.disabled?-1:0;row.setAttribute('aria-haspopup','dialog');row.setAttribute('aria-label',`阵容 ${index+1}，打开体系对局弹窗`);row.addEventListener('click',event=>{if(!choose.contains(event.target))openOwnLineup(lineup,row);});row.addEventListener('keydown',event=>{if(event.target===row&&!event.repeat&&['Enter',' '].includes(event.key)){event.preventDefault();openOwnLineup(lineup,row);}});}
    }
    function renderOwnSkillUsage(host, monsterId, sourceRows=currentStats?.selfSkills) {
      const section = make('section', 'br-own-skill-usage'); section.dataset.skillMonsterId = String(monsterId);
      const heading = title('', 'h4'); heading.className += ' br-own-skill-heading';
      heading.setAttribute('aria-label', `${petLabel({ monsterId })}：技能使用`);
      heading.append(avatar({ monsterId }), make('span', '', '技能使用'));
      section.append(heading); host.append(section);
      const entries = new Map();
      for (const row of arr(sourceRows)) {
        if (!row || row.monsterId !== monsterId || !Number.isSafeInteger(row.casts) || row.casts <= 0) continue;
        const wish = row.kind === 'wishImpact';
        const ordinary = (row.kind === undefined || row.kind === '' || row.kind === 'skill') && Number.isSafeInteger(row.skillId) && row.skillId > 0;
        if (!wish && !ordinary) continue; // Charge/passive/unknown identities never enter the denominator.
        const typeId = wish && Number.isSafeInteger(row.typeId) && row.typeId >= 1 && row.typeId <= 18 ? row.typeId : null;
        const key = wish ? `wishImpact:${typeId ?? 'unknown'}` : `skill:${row.skillId}`;
        if (!entries.has(key)) entries.set(key, { kind: wish ? 'wishImpact' : 'skill', skillId: wish ? null : row.skillId, typeId, count: 0 });
        entries.get(key).count += row.casts;
      }
      const entryName = entry => {
        if (entry.kind !== 'wishImpact') return skillName(entry.skillId);
        const type = entry.typeId === null ? null : arr(data()?.getTypes?.()).find(item => item.id === entry.typeId);
        const name = type ? data()?.getTypeObjZh?.(type) : null;
        return `愿力冲击·${typeof name === 'string' && name ? name : '未确认属性'}`;
      };
      const chart = countPie([...entries.values()], {
        pieClass: 'br-skill-pie', label: `${petLabel({ monsterId })}：技能使用占比`,
        describe: (entry, percentage) => `${entryName(entry)} · ${entry.count} 次 · ${percentage}`,
        identify(entry, slice) {
          slice.setAttribute('data-skill-kind', entry.kind);
          if (entry.kind === 'wishImpact') slice.setAttribute('data-type-id', String(entry.typeId ?? ''));
          else slice.setAttribute('data-skill-id', String(entry.skillId));
        }
      });
      if (!chart) { section.append(note(entries.size ? '累计次数不可用，未绘制占比。' : '暂无已记录技能使用。')); return; }
      section.dataset.total = String(chart.total);
      const rows = [...entries.values()].map(entry => [skillLine(entry,entryName(entry)), `${entry.count} 次`, performanceRate(entry.count / chart.total)]);
      const layout = make('div', 'br-own-skill-layout'), details = table(['技能名称', '释放次数', '占比'], rows);
      details.className += ' br-own-skill-table';
      layout.append(chart.svg, details); section.append(layout);
    }
    function summaryCells(value) {
      const outcome = make('div');
      outcome.append(make('strong', '', value.knownOutcomes > 0 ? performanceRate(value.winRate) : '—'),
        note(`已知结果 ${performanceNumber(value.knownOutcomes)} / ${performanceNumber(value.battles)} 场`));
      const rounds = make('div'); rounds.append(make('span', '', value.roundSamples > 0 && Number.isFinite(value.averageRounds) ? `${performanceNumber(value.averageRounds)} 回合` : '—'), note(`回合样本 ${performanceNumber(value.roundSamples)} 场`));
      const duration = make('div'), seconds = value.durationSamples > 0 && Number.isFinite(value.averageDurationSeconds) && value.averageDurationSeconds >= 0 ? Math.round(value.averageDurationSeconds) : null;
      duration.append(make('span', '', seconds === null ? '—' : `${Math.floor(seconds / 60)}分钟${seconds % 60}秒`), note(`用时样本 ${performanceNumber(value.durationSamples)} 场`));
      return [outcome, rounds, duration];
    }
    function archetypeCore(team) {
      const composition = make('div', 'br-archetype-core'); composition.append(make('strong', '', team.name));
      // Stats identity is already normalized by its immutable source snapshot.
      // Only omitted legacy fields may use the same stable-ID loaded rule; never
      // union predicates, infer families here, or replace explicit empty arrays.
      const rule = rules.find(item => item.id === team.id);
      const values = key => arr(Object.hasOwn(team, key) ? team[key] : rule?.[key]);
      const required = values('monsterIds'), groups = values('anyOf'), excluded = values('excludedMonsterIds');
      if (required.length) {
        const core = make('div', 'br-rule-members'), roster = make('div', 'br-lineup-roster');
        core.append(make('strong', 'br-label', '必含'));
        for (const monsterId of required) roster.append(petLine({ monsterId }));
        core.append(roster); composition.append(core);
      }
      if (groups.length) {
        const alternatives = make('div', 'br-any-groups'); alternatives.append(make('strong', 'br-label', '任选组（组间全部满足）'));
        groups.forEach((ids, index) => {
          const group = make('div', 'br-rule-members'); group.dataset.coreAnyGroup = String(index);
          group.append(make('strong', 'br-label', `组 ${index + 1} · 任选其一`));
          const roster = make('div', 'br-lineup-roster');
          for (const monsterId of arr(ids)) roster.append(petLine({ monsterId }));
          group.append(roster); alternatives.append(group);
        });
        composition.append(alternatives);
      }
      if (excluded.length) {
        const omit = make('div', 'br-rule-members'), roster = make('div', 'br-lineup-roster'); omit.append(make('strong', 'br-label', '排除'));
        for (const monsterId of excluded) roster.append(petLine({ monsterId }));
        omit.append(roster); composition.append(omit);
      }
      return composition;
    }
    function renderOwnMatchups(host, lineup) {
      const section = make('section', 'br-own-matchups'); section.setAttribute('aria-label', '所选我方阵容对敌方体系');
      section.append(title('对敌方体系战绩', 'h4')); host.append(section);
      // Compare the exact initial multiset, never server key strings or one pet.
      const group = arr(currentStats?.archetypes?.ownMatchups).find(item => lineupKey(item) === lineupKey(lineup));
      section.append(table(['敌方体系 / 核心', '对战局数', '我方胜率 / 已知结果', '平均回合', '平均用时'],
        arr(group?.teams).map(team => [archetypeCore(team), performanceNumber(team.battles), ...summaryCells(team)]),
        group ? '此阵容暂无有效的敌方体系对局。' : '当前筛选未提供此精确阵容的体系对局。'));
    }
    function skillLine(entry,label) {
      const host=make('span','br-skill-line');let src='';
      if(entry.kind==='wishImpact')src=systemActions()?.resolve({...entry,kind:'wishImpact'})?.iconPath||'';
      else {const name=skillName(entry.skillId);if(name!=='技能身份未知'&&name!=='未收录技能'&&!/[\/\\\x00-\x1f]/.test(name))src=`assets/monster/skill/${encodeURIComponent(name)}.png`;}
      host.append(imageSlot(src,'skill'),make('span','',label));return host;
    }
    function individualLines(host,values,label='个体选择率') {
      const section=make('section','br-individual-lines');section.append(title(label,'h4'));host.append(section);
      const attrs={hp:'hp',attack:'attack',magic_attack:'magicAttack',defense:'defense',magic_defense:'magicDefense',speed:'speed'};
      for(const [stat,name]of Object.entries(STATS)){
        const v=arr(values).find(x=>x.attribute===attrs[stat]),line=make('div','detail-stat-bar br-individual-line'),left=make('div','detail-stat-left'),track=make('div','detail-stat-track'),fill=make('div','detail-stat-fill'),amount=make('span','detail-stat-val');
        const valid=v&&Number.isSafeInteger(v.selected)&&Number.isSafeInteger(v.unselected)&&v.selected>=0&&v.unselected>=0&&Number.isSafeInteger(v.samples)&&v.samples===v.selected+v.unselected&&v.samples>0&&Number.isFinite(v.rate)&&Math.abs(v.rate-v.selected/v.samples)<1e-8;
        line.dataset.attribute=attrs[stat];left.append(make('span','detail-stat-label',name));track.append(fill);
        amount.textContent=valid?performanceRate(v.rate):'未探明';fill.style.setProperty('width',valid?`${v.rate*100}%`:'0%');line.dataset.available=String(!!valid);
        if(valid){line.setAttribute('role','meter');line.setAttribute('aria-label',`${name}个体选择率`);line.setAttribute('aria-valuemin','0');line.setAttribute('aria-valuemax','100');line.setAttribute('aria-valuenow',String(v.rate*100));line.title=`${v.selected} / ${v.samples} 个已探明样本；确认未选 ${v.unselected}；未知 ${text(v.unknown)}（不参与分母）`;}
        line.append(left,track,amount);section.append(line);if(valid)section.append(make('span','br-line-samples',`${v.selected} / ${v.samples} 个已探明样本`));
      }
    }
    function renderArchetypeComponents(host, team) {
      for(const component of arr(team.components)){
        const section=make('section','br-archetype-component');section.dataset.componentMonsterId=String(component.monsterId);section.append(petLine({monsterId:component.monsterId}));host.append(section);
        const charts=make('div','br-member-charts');section.append(charts);
        const usage=arr(component.skillUsage).filter(x=>Number.isSafeInteger(x.casts)&&x.casts>0&&(x.kind==='wishImpact'||((!x.kind||x.kind==='skill')&&Number.isSafeInteger(x.skillId)&&x.skillId>0))),total=component.usageTotalCasts;
        const skill=make('section','br-member-skill');skill.append(title('技能使用率','h4'));charts.append(skill);
        const skillLabel=x=>x.kind==='wishImpact'?`愿力冲击·${systemActions()?.metadata?.('wishImpact',x.typeId)?.typeLabel||'未确认属性'}`:skillName(x.skillId);
        const pie=Number.isSafeInteger(total)&&total>0&&usage.reduce((n,x)=>n+x.casts,0)===total?countPie(usage.map(x=>({...x,count:x.casts})),{pieClass:'br-member-pie',legendClass:'br-member-legend',swatchClass:'br-departure-swatch',label:'技能使用率',legendLabel:'技能名称、次数和使用率',describe:(x,p)=>`${skillLabel(x)} · ${x.count} 次 · ${p}`,icon:x=>skillLine(x,'')}):null;
        if(pie){const layout=make('div','br-member-chart');layout.append(pie.svg,pie.legend);skill.append(layout);}else skill.append(note('暂无有效技能执行样本。'));
        const nature=make('section','br-member-nature');nature.append(title('性格分布','h4'));charts.append(nature);
        const values=arr(component.natureConfigurations).filter(x=>Number.isSafeInteger(x.battles)&&x.battles>0),samples=component.natureSamples;
        const naturePie=Number.isSafeInteger(samples)&&samples>0&&values.reduce((n,x)=>n+x.battles,0)===samples?countPie(values.map(x=>({...x,count:x.battles})),{pieClass:'br-member-pie',legendClass:'br-member-legend',swatchClass:'br-departure-swatch',label:'性格分布（包含未探明）',legendLabel:'性格配置、样本与比例',describe:(x,p)=>`${x.key==='unknown'?'未探明':x.label||'未探明'} · ${x.count} 个 · ${p}`}):null;
        if(naturePie){const layout=make('div','br-member-chart');layout.append(naturePie.svg,naturePie.legend);nature.append(layout);}else nature.append(note('暂无性格配置样本，不绘制假零值饼图。'));
        individualLines(charts,component.individualChoices);
      }
      if(!arr(team.components).length)host.append(note('当前筛选下此体系暂无成员配置样本。'));
    }
    function openArchetype(team,trigger) {
      if(!active||!trigger?.isConnected)return;state.selectedArchetypeId=team.id;openPageModal('archetype',`${team.name} · 成员配置`,'当前体系成员配置',trigger,{archetypeId:team.id});modal.dialog.className+=' br-member-dialog';renderArchetypeComponents(modal.body,team);
    }
    function renderArchetypeHeading(host) {
      const heading = make('div', 'br-performance-heading');
      const editRules = button('阵容规则', event => openRules(event.currentTarget || event.target)); editRules.dataset.br = 'open-rules'; editRules.setAttribute('aria-haspopup', 'dialog');
      heading.append(ownStatsTitle('敌方阵容统计'), editRules); host.append(heading);
    }
    function renderArchetypeTeams(host, archetypes) {
      renderArchetypeHeading(host);const teams=arr(archetypes?.teams);
      const rows=teams.map(team=>{const teammates=make('div','br-archetype-teammates');for(const e of arr(team.teammates)){const item=make('div');item.append(petLine({monsterId:e.monsterId}),make('span','br-teammate-rate',e.samples>0?performanceRate(e.rate):'—'));item.title=`选择 ${performanceNumber(e.carried)} / ${performanceNumber(e.samples)} 场`;teammates.append(item);}return [archetypeCore(team),teammates,performanceNumber(team.battles),...summaryCells(team)];});
      const grid=table(['体系核心','其他队友 / 选择率','对战局数','我方对局胜率 / 已知结果','平均回合','平均用时'],rows,'当前筛选下暂无敌方体系样本。');host.append(grid);
      const bodyRows=grid.querySelector('tbody').children;teams.forEach((team,index)=>{const row=bodyRows[index];row.className='br-archetype-row';row.dataset.archetypeId=team.id;row.tabIndex=0;row.setAttribute('aria-haspopup','dialog');row.setAttribute('aria-label',`${team.name}，打开成员配置弹窗`);row.addEventListener('click',()=>openArchetype(team,row));row.addEventListener('keydown',e=>{if(e.target===row&&!e.repeat&&['Enter',' '].includes(e.key)){e.preventDefault();openArchetype(team,row);}});});
    }
    function renderEnvironment(host, archetypes) {
      host.append(title('敌方环境统计', 'h4'));const samples=archetypes?.samples,values=arr(archetypes?.environment);
      if(!(Number.isSafeInteger(samples)&&samples>0)){host.append(note('暂无有效环境样本。'));return;}
      host.append(note(`去重对战 ${samples} 场；体系可同时命中，以下比例不相加或归一化。`));
      for(const item of values){if(!Number.isSafeInteger(item.battles)||item.battles<0||item.samples!==samples||!Number.isFinite(item.rate)||Math.abs(item.rate-item.battles/samples)>1e-8)continue;const row=make('div','br-environment-rate');row.dataset.archetypeId=item.id;row.append(make('strong','',item.name),make('span','',`${item.battles} / ${samples} 场 · ${performanceRate(item.rate)}`));host.append(row);}
    }
    function renderPerformanceSection(host, performance, side) {
      const label = side === 'enemy' ? '敌方' : '我方';
      const heading = make('div', 'br-performance-heading'); heading.append(ownStatsTitle(side === 'me' ? '我方精灵统计' : '敌方精灵统计')); host.append(heading);
      if (!performance || typeof performance !== 'object') { host.append(note(`当前统计接口尚未提供${label}表现数据；不将缺失字段显示为零。`)); return; }
      const mode = make('div', 'br-performance-mode'), buttons = {};
      mode.setAttribute('role', 'group'); mode.setAttribute('aria-label', label + '表现计量方式');
      for (const [key, caption] of [['totals', '总计'], ['averages', '场均']]) {
        buttons[key] = button(caption, () => { if (!active) return; state.performanceMode = key; for (const update of performanceBindings) update(); }); mode.append(buttons[key]);
      }
      const sync = () => { for (const [key, control] of Object.entries(buttons)) control.setAttribute('aria-pressed', String(state.performanceMode === key)); };
      performanceBindings.push(sync); sync(); heading.append(mode); renderPerformancePets(host, performance, side);
    }
    function renderSelfStats(stats) {
      statsHosts.me.replaceChildren(); statsHosts['me-lineups'].replaceChildren();
      renderPerformanceSection(statsHosts.me, stats.selfPerformance, 'me');
      renderPerformanceLineups(statsHosts['me-lineups'], stats.selfPerformance || {});
    }
    function renderStats(stats) {
      currentStats = stats; performanceBindings = [];
      statsHosts.enemy.replaceChildren(); statsHosts['enemy-lineups'].replaceChildren(); statsStatus.replaceChildren(); statsSummary.replaceChildren();
      renderSelfStats(stats);
      if(modal?.kind==='archetype'){const team=arr(stats.archetypes?.teams).find(x=>x.id===modal.archetypeId);if(team){modal.body.replaceChildren();renderArchetypeComponents(modal.body,team);}else closeModal();}
      if(modal?.kind==='own-lineup'){const lineup=arr(stats.selfPerformance?.completeLineups).find(x=>lineupKey(x)===modal.lineupKey);if(lineup)paintOwnLineup(lineup);else closeModal();}
      if (modal?.kind === 'departures') {
        const row = arr(stats.selfPerformance?.species).find(row => row.monsterId === modal.monsterId);
        if (row) renderDepartureCharts(row); else closeModal();
      }
      const tiles = make('div', 'br-stat-tiles');
      for (const [label, value] of [['匹配对战', stats.matchedBattles], ['胜利', stats.outcomes?.win], ['失败', stats.outcomes?.loss], ['平局', stats.outcomes?.draw], ['结果未知', stats.outcomes?.unknown]]) {
        const tile = make('div', 'br-card br-stat'); tile.append(make('strong', '', text(value)), note(label)); tiles.append(tile);
      }
      statsSummary.append(tiles);
      renderPerformanceSection(statsHosts.enemy, stats.enemyPerformance, 'enemy');
      const lineupHost = statsHosts['enemy-lineups']; renderArchetypeTeams(lineupHost, stats.archetypes);
      // Environment is retained within the lineup module, not a third enemy
      // main module. Its original samples/rates and multilabel semantics remain.
      const environment = make('section', 'br-enemy-module'); environment.dataset.enemyModule = 'environment';
      renderEnvironment(environment, stats.archetypes); lineupHost.append(environment);
    }
    const queueMicrotaskSafe=fn=>Promise.resolve().then(()=>{if(active)fn();});
    async function revision(signal) {
      try{const value=await request('revision',{signal});return typeof value?.revision==='string'&&value.revision?value.revision:null;}catch(error){if(signal?.aborted)throw error;return null;}
    }
    function invalidateStats() {statsCache.clear();currentStats=null;statsQuery=null;statsGeneration++;aborts.get('stats')?.abort();statsPending=null;}
    async function ensureStats(force=false, retry=0) {
      if(!active)return;
      const query=filterQuery(state.filters).toString();if(statsPending&&statsPending.query===query&&!force)return statsPending.promise;
      const token=++statsGeneration,abort=controller('stats');currentStats=null;performanceBindings=[];statsSummary.replaceChildren();for(const host of Object.values(statsHosts))host.replaceChildren();renderArchetypeHeading(statsHosts['enemy-lineups']);statsStatus.replaceChildren(note('正在读取本地统计…'));panels.stats.setAttribute('aria-busy','true');
      if(['departures','archetype','own-lineup'].includes(modal?.kind)){modal.body.replaceChildren(note('正在核对当前统计版本…'));modal.body.setAttribute('aria-busy','true');}
      const work=(async()=>{try{
        const before=await revision(abort.signal);if(!active||abort.signal.aborted||token!==statsGeneration)return;
        const key=before?`${before}|${data()?.getCatalogRevision?.()||''}|${query}`:null;
        if(!force&&key&&statsCache.has(key)){renderStats(statsCache.get(key));statsQuery=query;return;}
        const stats=await request('stats?'+query,{signal:abort.signal});if(!active||abort.signal.aborted||token!==statsGeneration)return;
        const after=before?await revision(abort.signal):null;if(!active||abort.signal.aborted||token!==statsGeneration)return;
        if(before&&after&&(before!==after||stats.revision&&stats.revision!==before)){if(retry>=2)throw Error('数据持续变化，请稍后重试统计');statsStatus.replaceChildren(note('数据已变化，正在重新读取统计…'));statsPending=null;return ensureStats(true,retry+1);}
        if(key&&after===before&&(!stats.revision||stats.revision===before)){statsCache.delete(key);statsCache.set(key,stats);while(statsCache.size>8)statsCache.delete(statsCache.keys().next().value);}
        renderStats(stats);statsQuery=query;
      }catch(error){if(active&&!abort.signal.aborted&&token===statsGeneration){currentStats=null;statsQuery=null;statsSummary.replaceChildren();for(const host of Object.values(statsHosts))host.replaceChildren();renderArchetypeHeading(statsHosts['enemy-lineups']);errorAt(statsStatus,error,()=>ensureStats(true));if(['departures','archetype','own-lineup'].includes(modal?.kind))errorAt(modal.body,error,()=>ensureStats(true));}}finally{if(statsPending?.token===token){statsPending=null;panels.stats.setAttribute('aria-busy','false');if(['departures','archetype','own-lineup'].includes(modal?.kind))modal.body.setAttribute('aria-busy','false');}}})();
      statsPending={query,token,promise:work};return work;
    }
    async function refresh() {
      if(!active)return;closePetTip();const token=++generation,abort=controller('query');let query;
      try{query=filterQuery(state.filters).toString();}catch(error){queryStatus.textContent=error.message;return;}
      if(statsQuery!==query){currentStats=null;statsGeneration++;aborts.get('stats')?.abort();statsPending=null;performanceBindings=[];statsSummary.replaceChildren();for(const host of Object.values(statsHosts))host.replaceChildren();renderArchetypeHeading(statsHosts['enemy-lineups']);statsStatus.replaceChildren(note('进入样本统计后加载。'));}
      previous.disabled=true;nextPage.disabled=true;listStatus.replaceChildren(note('正在读取本地对战列表…'));listHost.replaceChildren();queryStatus.textContent='';
      const listing=request(`list?${query}${query?'&':''}page=${state.page}&pageSize=${state.pageSize}`,{signal:abort.signal}).then(result=>{if(active&&!abort.signal.aborted&&token===generation){renderList(result);queryStatus.textContent=`${text(result.total)} 场匹配 · 当前输入需点击「应用筛选」才生效`;}}).catch(error=>{if(active&&!abort.signal.aborted&&token===generation)errorAt(listStatus,error,refresh);});
      if(state.tab==='stats'||['departures','archetype','own-lineup'].includes(modal?.kind))ensureStats();
      return listing;
    }

    function closePetTip() {
      const previous = petTip; if (!previous) return;
      petTip = null; clearTimeout(previous.timer);
      previous.anchor.removeAttribute('aria-describedby'); previous.anchor.title = previous.title;
      previous.tooltip.remove(); previous.release?.();
    }
    function petDetails(pet, context) {
      const lines = [], side = context?.side, record = context?.record;
      const matches = arr(record?.sides?.[side]?.pets).filter(item => item.instanceId === pet.instanceId);
      // A same-name species or a duplicate/other-side instance cannot supply a
      // record profile. These are read-only normalized evidence values only.
      if (matches.length !== 1) return lines;
      if (side === 'me') {
        const openingSpeed = matches[0].speed;
        if (Number.isSafeInteger(openingSpeed) && openingSpeed >= 1 && openingSpeed <= 1000000) lines.push(`开场速度：${openingSpeed}`);
        for (const [stat, label] of Object.entries(STATS)) {
          const fields = [], iv = matches[0].iv?.[stat], nature = matches[0].nature?.[stat];
          if (iv?.certainty === 'direct' && Number.isInteger(iv.value) && iv.value >= 0 && iv.value <= 60) fields.push(`个体 ${iv.value}`);
          if (nature?.certainty === 'direct' && Number.isInteger(nature.value) && nature.value >= 0 && nature.value <= 2) fields.push(['中性', '正性格', '负性格'][nature.value]);
          if (fields.length) lines.push(`${label}：${fields.join(' · ')}`);
        }
        if (lines.length) lines.unshift('记录配置');
      } else if (side === 'enemy') {
        const byInstance = context?.inferred?.sides?.[side];
        const result = byInstance && Object.hasOwn(byInstance, pet.instanceId) ? byInstance[pet.instanceId] : null;
        if (!Number.isSafeInteger(pet.monsterId) || pet.monsterId <= 0 || !result || !['inferred', 'direct'].includes(result.status) ||
            (result.monsterId !== undefined && result.monsterId !== pet.monsterId)) return lines;
        // Only summarize the projector's candidates. No stats, action order,
        // personal settings or numeric inference is evaluated in the renderer.
        const candidates = arr(result.candidates).filter(candidate => Number.isInteger(candidate.iv) && candidate.iv >= 0 && candidate.iv <= 60 && Number.isInteger(candidate.nature) && candidate.nature >= 0 && candidate.nature <= 2);
        if (!candidates.length) return lines;
        lines.push('速度推测');
        if (typeof result.message === 'string' && result.message) lines.push(result.message);
        for (const [nature, label] of ['中性', '加速', '减速'].entries()) {
          const values = [...new Set(candidates.filter(candidate => candidate.nature === nature).map(candidate => candidate.iv))].sort((a, b) => a - b);
          const ranges = [];
          for (let index = 0; index < values.length; index++) {
            const first = values[index]; let last = first;
            while (values[index + 1] === last + 1) last = values[++index];
            ranges.push(first === last ? String(first) : `${first}–${last}`);
          }
          if (ranges.length) lines.push(`${label}：个体 ${ranges.join('、')}`);
        }
      }
      return lines;
    }
    function attachPetTip(anchor, pet, context, label = petLabel(pet)) {
      const details = petDetails(pet, context);
      anchor.tabIndex = 0; anchor.setAttribute('aria-label', label);
      // Preserve a native text fallback when the shared anchored-layer helper is
      // unavailable. Normal app rendering uses the same zoom-aware helper as search.
      anchor.title = [label, ...details].join('\n');
      const cancelHide = () => { if (petTip?.anchor === anchor) clearTimeout(petTip.timer); };
      const hideSoon = () => { if (petTip?.anchor === anchor && doc.activeElement !== anchor) { cancelHide(); petTip.timer = setTimeout(closePetTip, 100); } };
      const show = () => {
        if (!active || !anchor.isConnected || (modal && !modal.dialog.contains(anchor)) || !ui()?.positionAnchoredLayer) return;
        if (petTip?.anchor === anchor) { cancelHide(); return; }
        closePetTip();
        const tooltip = make('div', 'br-pet-tooltip'); tooltip.id = `br-pet-tip-${++tipSerial}`;
        tooltip.setAttribute('role', 'tooltip'); tooltip.append(make('strong', '', label));
        for (const line of details) tooltip.append(make('div', '', line));
        (modal?.overlay || page).append(tooltip);
        const current = { anchor, tooltip, timer: null, release: null, title: anchor.title }; petTip = current;
        anchor.title = ''; anchor.setAttribute('aria-describedby', tooltip.id);
        tooltip.addEventListener('pointerenter', cancelHide); tooltip.addEventListener('pointerleave', hideSoon);
        ui().positionAnchoredLayer(anchor, tooltip, false, { avoidAnchor: true });
        current.release = ui().bindAnchoredLayer?.(anchor, tooltip, closePetTip);
      };
      anchor.addEventListener('pointerenter', show); anchor.addEventListener('focus', show);
      anchor.addEventListener('pointerleave', hideSoon); anchor.addEventListener('blur', closePetTip);
    }
    function imageSlot(src, kind) {
      const slot = make('span', `br-image-slot br-image-${kind}`); slot.setAttribute('aria-hidden', 'true');
      if (src) {
        const image = make('img'); image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
        image.addEventListener('error', () => { image.remove(); }); // Keep the blank slot, never a broken or substitute image.
        image.src = src; slot.append(image);
      }
      return slot;
    }
    function avatarSource(pet) {
      if(pet?.id && !pet.monsterId)pet={monsterId:pet.id};
      const canonical = Number.isSafeInteger(pet?.monsterId) && pet.monsterId > 0 ? data()?.getMonsterById?.(pet.monsterId) : null;
      // RKData's canonical avatar filename (not wiki full-body art, source names or protocol IDs).
      const image = typeof canonical?.image === 'string' ? canonical.image : '';
      const [filename] = image.split('?');
      const valid = filename && !/[\\\\:#\x00-\x1f]/.test(image) && !filename.startsWith('/') && filename.split('/').every(part => part && part !== '.' && part !== '..');
      let src = '';
      if (valid) {
        try {
          src = root.FavoritePets?.avatarUrl ? root.FavoritePets.avatarUrl(canonical)
            : 'assets/monster/images/' + filename.split('/').map(encodeURIComponent).join('/') + image.slice(filename.length);
        } catch (_) { src = ''; } // Decorative assets must not prevent the record from opening.
        if (typeof src !== 'string' || !/^assets\/monster\/images\//.test(src) || /[\\\\\x00-\x1f]/.test(src) || src.split(/[/?]/).some(part => part === '..')) src = '';
      }
      return src;
    }
    function avatar(pet){return imageSlot(avatarSource(pet),'pet');}
    function petLabel(pet) {
      const canonical = Number.isSafeInteger(pet?.monsterId) && pet.monsterId > 0 ? data()?.getMonsterById?.(pet.monsterId) : null;
      return canonical ? data().getMonsterDisplayName(canonical) : speciesName(pet?.monsterId, pet?.declaredName ?? pet?.name);
    }
    function petLine(pet, context) {
      const line = make('div', 'br-pet-line'); line.dataset.instanceId = pet.instanceId;
      line.setAttribute('role', 'group'); attachPetTip(line, pet, context);
      line.append(avatar(pet), make('strong', 'br-pet-name', petLabel(pet))); return line;
    }
    function actionTile(action, context) {
      const event = action.event, tile = make('div', 'br-action'); tile.dataset.eventId = event.id || '';
      const move = Number.isSafeInteger(event.skillId) && event.skillId > 0 ? arr(data()?.getMoves?.()).find(item => item.id === event.skillId) : null;
      const canonicalName = move ? data().getMoveName(move) : '';
      // Resolve only confirmed normalized system identity. Base species, labels,
      // nearby actions and personal stats never choose wish identity/type/category.
      const system = systemActions()?.resolve(event);
      const label = system ? system.name : canonicalName || event.label || '技能身份未知';
      const deliberatelyBlank = ['愿力冲击', '聚能'].includes(label) || ['愿力冲击', '聚能'].includes(event.label);
      const safeName = typeof canonicalName === 'string' && canonicalName && !/[\\/\\\\\x00-\x1f]/.test(canonicalName) && !['.', '..'].includes(canonicalName);
      const systemIcon = typeof system?.iconPath === 'string' && /^assets\/system-actions\/(?:charge\.webp|wish-(?:[1-9]|1[0-8])\.png)$/.test(system.iconPath) ? system.iconPath : '';
      const src = system ? systemIcon : safeName && !deliberatelyBlank ? `assets/monster/skill/${encodeURIComponent(canonicalName)}.png` : '';
      const content = make('div', 'br-action-content'), nameLine = make('div', 'br-skill-heading');
      nameLine.append(make('strong', 'br-skill-name', label));
      if (event.skillClass === 'response') nameLine.append(make('span', 'br-response-badge', '应对'));
      content.append(nameLine);
      if (system) {
        const metadata = [system.categoryLabel, `耗能 ${system.energyCost}`];
        if (Number.isFinite(system.power)) metadata.push(`威力 ${system.power}`);
        if (system.typeLabel) metadata.push(system.typeLabel);
        const description = `${system.name}：${metadata.join(' · ')}。${system.description}${Number.isFinite(system.counterPower) ? `应对状态时威力 ${system.counterPower}。` : ''}`;
        tile.dataset.systemAction = system.kind; if (system.typeId !== null) tile.dataset.typeId = String(system.typeId);
        tile.tabIndex = 0; tile.title = description; tile.setAttribute('aria-label', description);
        // Fixed system-action details stay in the tooltip/accessibility label,
        // not beneath the card name. Observed battle values remain below.
      } else if (!move && event.skillClass !== 'system') content.append(make('span', 'br-action-meta', 'Wiki 身份未映射'));
      const numbers = make('div', 'br-action-numbers');
      if (event.phase === 'interrupted') numbers.append(make('span', 'br-interrupted', actionOutcomes()?.interruptionLabel?.(event,context?.record,{getMoves:()=>arr(data()?.getMoves?.())}) || '被打断'));
      else {
        if (Number.isFinite(action.hpLoss)) numbers.append(make('span', 'br-damage', `伤害 ${action.hpLoss}`));
        else if (Number.isFinite(action.damage)) numbers.append(make('span', 'br-damage', `报告伤害 ${action.damage}`));
        // The VM supplies known costs, including zero; the UI never infers them.
        if (Number.isFinite(action.energyCost)) numbers.append(make('span', '', `耗能 ${action.energyCost}`));
        if (Number.isFinite(action.energyGain)) numbers.append(make('span', '', `回能 +${action.energyGain}`));
      }
      content.append(numbers); tile.append(imageSlot(src, 'skill'), content); return tile;
    }
    function stateCard(snapshot, context) {
      const box = make('div', 'br-state'); box.dataset.status = snapshot?.status || 'unknown';
      if (!snapshot || (snapshot.status === 'unknown' && !snapshot.pet)) { box.append(note('场上精灵未确认')); return box; }
      if (snapshot.status === 'empty') { box.append(note('空场')); return box; }
      if (snapshot.pet) box.append(petLine(snapshot.pet, context));
      const values = make('div', 'br-state-values');
      for (const [field, label] of [['hp', '生命'], ['energy', '能量']]) {
        const value = snapshot[field];
        let display = Number.isFinite(value) ? value : '未确认';
        if (field === 'hp' && value == null && Number.isFinite(snapshot.hpRatio) && snapshot.hpRatio >= 0 && snapshot.hpRatio <= 1) {
          display = `${Number((snapshot.hpRatio * 100).toFixed(2))}%`;
        }
        values.append(make('span', 'br-state-value', `${label} ${display}`));
      }
      box.append(values);
      return box;
    }
    function renderTurnCards(host, projected, context) {
      const timeline = make('section', 'br-rounds'); timeline.setAttribute('aria-label', '回合行动');
      if (!arr(projected.rounds).length) timeline.append(make('div', 'br-empty', EMPTY_TURN));
      for (const turn of arr(projected.rounds)) {
        const section = make('section', 'br-round'); section.dataset.round = String(turn.round);
        const label = turn.round ? '回合 ' + turn.round + (turn.endRound ? '–' + turn.endRound : '') : '回合未知';
        section.append(title(label, 'h4'));
        const headings = make('div', 'br-bilateral br-side-labels');
        for (const side of ['me', 'enemy']) { const heading = make('strong', 'br-side-label', SIDES[side]); heading.dataset.side = side; headings.append(heading); }
        section.append(headings);
        const row = (kind, build) => {
          const grid = make('div', 'br-bilateral br-row-' + kind); grid.dataset.row = kind;
          for (const side of ['me', 'enemy']) { const cell = make('div', 'br-side-cell'); cell.dataset.side = side; build(cell, turn.sides[side], side); grid.append(cell); }
          section.append(grid);
        };
        row('pets', (cell, side, sideKey) => {
          const participants = arr(side.participants);
          for (const [index, pet] of participants.entries()) {
            const previous = participants[index - 1];
            // An explicit same-side switch labels this exact outgoing → incoming
            // pair only. Multiple participants (including forms) are not proof.
            if (previous?.instanceId && pet.instanceId && previous.instanceId !== pet.instanceId && arr(turn.events).some(event =>
              event.kind === 'switch' && event.phase === 'executed' && event.side === sideKey &&
              (event.targetSide === undefined || event.targetSide === sideKey) &&
              event.target === previous.instanceId && event.actor === pet.instanceId)) {
              cell.append(make('span', 'br-switch-separator', '换场 →'));
            }
            cell.append(petLine(pet, { ...context, side: sideKey }));
          }
        });
        row('actions', (cell, side) => {
          for (const action of arr(side.actions)) if (!isNoAction(action.event)) cell.append(actionTile(action,context));
        });
        if (['me', 'enemy'].some(side => arr(turn.sides[side].annotations).length)) {
          row('annotations', (cell, side) => {
            for (const annotation of arr(side.annotations)) {
              if (!isNoAction(annotation.event)) continue;
              const line = note(`${annotation.pet ? petLabel(annotation.pet) + '：' : ''}${eventName(annotation.event)}`);
              line.dataset.noAction = 'stunSkip'; line.dataset.eventId = annotation.event.id || '';
              line.dataset.instanceId = annotation.event.actor || '';
              cell.append(line);
            }
          });
        }
        const entryHistory=arr(context?.history?.entries).filter(entry=>entry.round===turn.round&&entry.known&&Number.isFinite(entry.count));
        if(entryHistory.length)row('history-growth',(cell,side,sideKey)=>{for(const entry of entryHistory.filter(x=>x.side===sideKey)){const line=note(`${petLabel({monsterId:entry.monsterId})}：${entry.name} · 入场时累计 ${performanceNumber(entry.count)}${entry.unit||'次'}`);line.dataset.traitId=entry.traitId;line.dataset.instanceId=entry.actor;line.dataset.eventId=entry.eventId;line.title=entry.coverage?.complete?'按已确认的入场前行动序列累计。':'按已记录的入场前行动累计；不表示整场捕获完整。';cell.append(line);}});
        row('endstate', (cell, side, sideKey) => cell.append(stateCard(side.endState, { ...context, side: sideKey })));
        if (['me', 'enemy'].some(side => arr(turn.sides[side].replacements).length)) {
          row('replacements', (cell, side, sideKey) => { for (const replacement of arr(side.replacements)) cell.append(stateCard(replacement, { ...context, side: sideKey })); });
        }
        if (!arr(turn.events).length) section.append(note(EMPTY_TURN));
        timeline.append(section);
      }
      host.append(timeline);
    }
    function renderDetail(record) {
      if (!modal) return;
      const projection = turnView();
      if (!projection?.project) throw Error('回合视图组件未加载，请刷新应用后重试');
      const projected = projection.project(record, {
        getMonsterById: id => data()?.getMonsterById?.(id),
        getMoveById: id => arr(data()?.getMoves?.()).find(move => move.id === id)
      });
      // List/hover never run inference or fetch a record. The full-record pure
      // projector is optional, and only its read-only result reaches tooltips.
      let inferred = null;
      if (root.BattleSpeedInference?.project) {
        try { inferred = root.BattleSpeedInference.project(record, { getMonsterById: id => data()?.getMonsterById?.(id) }); }
        catch (_) { /* Unavailable inference must not replace or block the battle view. */ }
      }
      closePetTip();
      const host = modal.body; host.replaceChildren();
      const top = make('div', 'br-match-heading');
      top.append(title(`${OUTCOMES[record.outcome] || OUTCOMES.unknown} · ${displayTime(record.startedAt)}`, 'h3'));
      host.append(top, note(recordCountsText(record)));
      let history=null;try{history=historyGrowth()?.project?.(record,{getMonsterById:id=>data()?.getMonsterById?.(id),getMoves:()=>arr(data()?.getMoves?.())});}catch(_){ /* Unavailable trait evidence must not block the raw battle. */ }
      renderTurnCards(host, projected, { record, inferred, history });
      if (!modal.dialog.contains(doc.activeElement)) modal.close.focus({ preventScroll: true });
    }
    function closeModal(restoreFocus = true) {
      const previous = modal;
      if (!previous) return;
      closePetTip();
      if (previous.kind === 'rules') destroyRulePickers();
      if (previous.kind === 'scan') { aborts.get('scan-path')?.abort(); aborts.delete('scan-path'); }
      if (previous.kind === 'export-source') { aborts.get('export-source')?.abort(); aborts.delete('export-source'); }
      previous.disposeContextMenu?.();
      modal = null; state.selectedId = ''; detailGeneration++;
      aborts.get('detail')?.abort(); aborts.delete('detail');
      doc.removeEventListener('keydown', previous.keydown, true);
      doc.removeEventListener('focusin', previous.focusin, true);
      previous.overlay.remove();
      for (const saved of previous.background) {
        saved.node.inert = saved.inert;
        if (saved.ariaHidden === null) saved.node.removeAttribute('aria-hidden'); else saved.node.setAttribute('aria-hidden', saved.ariaHidden);
      }
      for (const saved of previous.scrollers) {
        if (saved.overflow) saved.node.style.setProperty('overflow', saved.overflow, saved.priority); else saved.node.style.removeProperty('overflow');
        saved.node.scrollTop = saved.top; saved.node.scrollLeft = saved.left;
      }
      if (restoreFocus && active) {
        const fallback = previous.kind==='archetype'?statsButtons.enemy:previous.kind==='own-lineup'?statsButtons.me:previous.kind === 'scan' ? scanBtn : previous.kind === 'export-source' ? exportBtn : previous.kind === 'rules' ? [...statsHosts.enemy.querySelectorAll('button')].find(node => node.dataset.br === 'open-rules') || statsButtons.enemy : previous.kind === 'departures'
          ? [...statsHosts.me.querySelectorAll('button')].find(node => node.dataset.departureMonsterId === String(previous.monsterId ?? '')) || statsButtons.me
          : [...listHost.children].find(node => node.dataset.recordId === previous.recordId)?.querySelector('button') || tabs.list;
        const target = previous.trigger?.isConnected && previous.trigger.getClientRects().length ? previous.trigger : fallback;
        target?.focus({ preventScroll: true });
      }
    }
    function openPageModal(kind, label, regionLabel, trigger, metadata = {}) {
      closeFilters(); closePetTip();
      if (modal) closeModal(false);
      const overlay = make('div', 'br-modal-root'); overlay.dataset.modalKind = kind;
      const dialog = make('section', 'br-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'br-dialog-title'); dialog.tabIndex = -1;
      const header = make('header', 'br-dialog-header'), heading = title(label, 'h2'); heading.id = 'br-dialog-title';
      const close = button('关闭', () => closeModal()); close.className += ' br-modal-close'; close.setAttribute('aria-label', '关闭' + label);
      const body = make('div', 'br-dialog-body'); body.dataset.br = kind; body.tabIndex = 0;
      body.setAttribute('role', 'region'); body.setAttribute('aria-label', regionLabel);
      header.append(heading, close); dialog.append(header, body); overlay.append(dialog);
      const background = [...doc.body.children].map(node => ({ node, inert: node.inert, ariaHidden: node.getAttribute('aria-hidden') }));
      const scrollers = [doc.documentElement, doc.body, page].map(node => ({ node, top: node.scrollTop, left: node.scrollLeft, overflow: node.style.getPropertyValue('overflow'), priority: node.style.getPropertyPriority('overflow') }));
      const focusables = () => [...dialog.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')]
        .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length > 0);
      const keydown = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (petTip) closePetTip(); else closeModal(); }
        else if (event.key === 'Tab') {
          const nodes = focusables(), first = nodes[0] || dialog, last = nodes[nodes.length - 1] || dialog;
          if (event.shiftKey && (doc.activeElement === first || !dialog.contains(doc.activeElement))) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (doc.activeElement === last || !dialog.contains(doc.activeElement))) { event.preventDefault(); first.focus(); }
        }
      };
      const focusin = event => { if (!dialog.contains(event.target)) close.focus({ preventScroll: true }); };
      modal = { overlay, dialog, body, close, trigger: trigger || doc.activeElement, kind, ...metadata, background, scrollers, keydown, focusin };
      doc.body.append(overlay);
      for (const saved of scrollers) saved.node.style.setProperty('overflow', 'hidden');
      // Move focus before aria-hiding its former ancestor (avoids browser a11y rejection).
      close.focus({ preventScroll: true });
      for (const saved of background) { saved.node.inert = true; saved.node.setAttribute('aria-hidden', 'true'); }
      overlay.addEventListener('click', event => { if (event.target === overlay) closeModal(); });
      doc.addEventListener('keydown', keydown, true); doc.addEventListener('focusin', focusin, true);
      modal.disposeContextMenu = ui()?.bindModalContextMenu?.(overlay, () => { if (modal?.overlay === overlay) closeModal(); });
    }
    function openDetail(id, trigger) {
      if (!active || !id) return;
      if (modal?.kind === 'detail' && state.selectedId === id) { modal.close.focus({ preventScroll: true }); return; }
      openPageModal('detail', '对战详情', '战斗详情内容', trigger, { recordId: id });
      state.selectedId = id;
      loadDetail(id);
    }
    async function loadDetail(id) {
      if (!active || !id || modal?.kind !== 'detail' || state.selectedId !== id) return;
      closePetTip();
      const current = modal, token = ++detailGeneration, abort = controller('detail');
      const loading = note('正在加载对战详情…'); loading.setAttribute('role', 'status');
      current.body.setAttribute('aria-busy', 'true'); current.body.replaceChildren(loading);
      if (!current.dialog.contains(doc.activeElement)) current.close.focus({ preventScroll: true });
      try {
        const record = await request('record?' + new URLSearchParams({ id }), { signal: abort.signal });
        if (active && modal === current && !abort.signal.aborted && token === detailGeneration && state.selectedId === id) renderDetail(record);
      } catch (error) { if (active && modal === current && !abort.signal.aborted && token === detailGeneration) errorAt(current.body, error, () => loadDetail(id)); }
      finally { if (modal === current && token === detailGeneration) current.body.setAttribute('aria-busy', 'false'); }
    }

    // The editor is detached until opened. Draft IDs are allocated once and
    // survive editing/reordering/errors; no example rules or implicit PUTs.
    const ruleHost = make('section', 'br-rule-editor'), ruleList = make('div', 'br-rule-list'), ruleStatus = make('div'), ruleError = make('div'), ruleConflictHost = make('div'), ruleDefaultsHost = make('div'); ruleStatus.setAttribute('aria-live', 'polite');
    let rulesRevision = null, ruleConflict = null, ruleDrafts = [], defaultRules = [], defaultConfirmation = null, draftsLoaded = false, draftVersion = 0, editId = '', editDirty = false, draftIds = [], excludedIds = [], anyGroups = [], localId = 0;
    function clearDefaultConfirmation() { defaultConfirmation = null; ruleDefaultsHost.replaceChildren(); }
    const copyRules = values => (ruleFamilies()?.normalizeRules(values,arr(data()?.getMonsters?.()))||values).map(rule => ({ id: rule.id, name: rule.name, monsterIds: [...arr(rule.monsterIds)], excludedMonsterIds: [...arr(rule.excludedMonsterIds)], ...(arr(rule.anyOf).length ? { anyOf: rule.anyOf.map(group => [...arr(group)]) } : {}) }));
    const newRuleId = () => 'team-' + (root.crypto?.randomUUID?.() || Date.now().toString(36)) + '-' + (++localId).toString(36);
    const ruleForm = make('form', 'br-card br-rule-form'), ruleName = input('text', 'ruleName'); ruleName.maxLength = 80;
    const draftHost = make('div', 'br-roster'), excludedHost = make('div', 'br-roster');
    const changeDraft = () => { clearDefaultConfirmation(); editDirty = true; draftVersion++; };
    ruleName.addEventListener('input', changeDraft);
    const addMember = (id, excluded) => {
      if (rulesBusy) return;
      const numeric = Number(id), target = excluded ? excludedIds : draftIds, other = excluded ? [...draftIds, ...anyGroups.flat()] : excludedIds;
      if (!Number.isSafeInteger(numeric) || numeric <= 0 || !data()?.getMonsterById?.(numeric)) return;
      if (other.includes(numeric)) { errorAt(ruleStatus, Error('同一精灵不能同时要求包含和排除')); return; }
      if (target.length >= 24 && !target.includes(numeric)) { errorAt(ruleStatus, Error('每组最多 24 个精灵 ID')); return; }
      if (!target.includes(numeric)) { target.push(numeric); changeDraft(); } renderDraft();
    };
    let rulePicker = null, excludePicker = null, anyPicker = null;
    const rulePickerHost = make('div'), excludePickerHost = make('div'), anyPickerHost = make('div'), anyHost = make('div', 'br-any-groups');
    const anyGroupSelect = select('ruleAnyGroup', []); anyGroupSelect.setAttribute('aria-label', '添加到任选组');
    const addAnyGroup = button('新增任选组', () => { if (rulesBusy) return; anyGroups.push([]); anyGroupSelect.value = String(anyGroups.length - 1); changeDraft(); renderDraft(); });
    function addAnyMember(id) {
      const numeric = Number(id), index = Number(anyGroupSelect.value), group = anyGroups[index];
      if (rulesBusy || !group || !Number.isSafeInteger(numeric) || numeric <= 0 || !data()?.getMonsterById?.(numeric)) return;
      if (excludedIds.includes(numeric)) { errorAt(ruleStatus, Error('同一精灵不能同时要求包含和排除')); return; }
      if (group.length >= 24 && !group.includes(numeric)) { errorAt(ruleStatus, Error('每组最多 24 个精灵 ID')); return; }
      if (!group.includes(numeric)) { group.push(numeric); changeDraft(); renderDraft(); }
    }
    function destroyRulePickers() {
      clearDefaultConfirmation();
      rulePicker?.destroy(); excludePicker?.destroy(); anyPicker?.destroy(); rulePicker = excludePicker = anyPicker = null;
      rulePickerHost.replaceChildren(); excludePickerHost.replaceChildren(); anyPickerHost.replaceChildren();
    }
    function renderDraft() {
      for (const [host, values, excluded] of [[draftHost, draftIds, false], [excludedHost, excludedIds, true]]) {
        host.replaceChildren();
        for (const id of values) {
          const remove = button(`移除${excluded ? '排除' : '核心'} ${speciesName(id)}`, () => {
            if (rulesBusy) return;
            if (excluded) excludedIds = excludedIds.filter(value => value !== id); else draftIds = draftIds.filter(value => value !== id);
            changeDraft(); renderDraft();
          }); remove.replaceChildren(avatar({monsterId:id}),make('span','',speciesName(id)),make('span','', '×'));remove.className+=' br-member-chip';remove.disabled = rulesBusy; host.append(remove);
        }
        if (!values.length) host.append(note(excluded ? '没有排除成员（可选）。' : '选择核心或添加任选组。'));
      }
      const selectedGroup = anyGroupSelect.value; anyGroupSelect.replaceChildren(); anyHost.replaceChildren();
      anyGroups.forEach((group, index) => {
        const option = make('option', '', `任选组 ${index + 1}`); option.value = String(index); anyGroupSelect.append(option);
        const row = make('div', 'br-any-group'); row.dataset.anyGroup = String(index); row.append(make('strong', '', `任选组 ${index + 1}（任一）`));
        for (const id of group) {
          const remove = button(`移除任选 ${speciesName(id)}`, () => { if (rulesBusy) return; anyGroups[index] = group.filter(value => value !== id); changeDraft(); renderDraft(); });
          remove.replaceChildren(avatar({monsterId:id}),make('span','',speciesName(id)),make('span','', '×'));remove.className+=' br-member-chip';remove.disabled = rulesBusy; row.append(remove);
        }
        const removeGroup = button('删除任选组', () => { if (rulesBusy) return; anyGroups.splice(index, 1); changeDraft(); renderDraft(); }); removeGroup.disabled = rulesBusy; row.append(removeGroup); anyHost.append(row);
      });
      anyGroupSelect.value = anyGroups[Number(selectedGroup)] ? selectedGroup : anyGroups.length ? '0' : '';
      anyGroupSelect.disabled = rulesBusy || !anyGroups.length; anyPicker?.setDisabled(rulesBusy || !anyGroups.length); addAnyGroup.disabled = rulesBusy;
    }
    function editRule(rule) {
      if (rulesBusy) return;
      clearDefaultConfirmation();
      editId = rule?.id || newRuleId(); ruleName.value = rule?.name || ''; const normalized=rule?copyRules([rule])[0]:null;draftIds=[...arr(normalized?.monsterIds)];excludedIds=[...arr(normalized?.excludedMonsterIds)];anyGroups=arr(normalized?.anyOf).map(group=>[...arr(group)]);
      editDirty = false; rulePicker?.set(''); excludePicker?.set(''); anyPicker?.set(''); renderDraft();
    }
    function stageEditor() {
      clearDefaultConfirmation();
      if (!editDirty) return true;
      const name = ruleName.value.trim();
      if (!name || name.length > 80 || (!draftIds.length && !anyGroups.length)) { errorAt(ruleStatus, Error('请输入规则名并选择至少一个核心精灵或任选组')); return false; }
      if (anyGroups.some(group => !group.length)) { errorAt(ruleStatus, Error('每个任选组至少选择一个精灵')); return false; }
      if ([...draftIds, ...anyGroups.flat()].some(id => excludedIds.includes(id))) { errorAt(ruleStatus, Error('包含和排除成员不能重叠')); return false; }
      const next = copyRules([{ id: editId, name, monsterIds: [...draftIds], excludedMonsterIds: [...excludedIds], ...(anyGroups.length ? { anyOf: anyGroups.map(group => [...group]) } : {}) }])[0];
      const index = ruleDrafts.findIndex(rule => rule.id === editId);
      if (index < 0) ruleDrafts.push(next); else ruleDrafts[index] = next;
      editDirty = false; draftVersion++; return true;
    }
    const newRule = button('新增规则', () => { if (rulesBusy || !stageEditor()) return; editRule(); renderRules(); });
    const saveRule = button('保存规则', () => { if (stageEditor()) saveRules(); }, true);
    const loadDefaultRules = button('载入内置规则', () => {
      if (!active || modal?.kind !== 'rules' || !rulesReady || rulesBusy || !defaultRules.length) return;
      clearDefaultConfirmation();
      const confirmation = { version: draftVersion, revision: rulesRevision, defaults: defaultRules, modal }; defaultConfirmation = confirmation;
      const confirm = button('确认替换当前草稿', () => {
        if (!active || modal !== confirmation.modal || !rulesReady || rulesBusy || defaultConfirmation !== confirmation || draftVersion !== confirmation.version || rulesRevision !== confirmation.revision || defaultRules !== confirmation.defaults) return;
        // Use the service's stable builtin IDs and order. Loading is draft-only;
        // neither the loaded CAS base nor unresolved conflict is rebased here.
        ruleDrafts = copyRules(defaultRules); draftVersion++; editRule(ruleDrafts[0]); renderRules();
        ruleStatus.replaceChildren(note('已替换当前草稿，尚未保存。')); ruleName.focus({ preventScroll: true });
      });
      ruleDefaultsHost.replaceChildren(note('载入内置规则将替换当前草稿，尚未保存；原有未保存编辑将丢弃。'), confirm,
        button('取消载入', () => { clearDefaultConfirmation(); loadDefaultRules.focus({ preventScroll: true }); }));
    });
    loadDefaultRules.hidden = true;
    ruleHost.addEventListener('click', event => { if (!loadDefaultRules.contains(event.target) && !ruleDefaultsHost.contains(event.target)) clearDefaultConfirmation(); }, true);
    ruleHost.addEventListener('input', clearDefaultConfirmation);
    ruleHost.addEventListener('change', clearDefaultConfirmation);
    anyGroupSelect.addEventListener('change', clearDefaultConfirmation);
    ruleForm.append(field('规则名称', ruleName), title('必须包含（全部）', 'h4'), rulePickerHost, draftHost, title('任选组（组间全部满足）', 'h4'), addAnyGroup, anyGroupSelect, anyPickerHost, anyHost, title('不得包含（任一，可选）', 'h4'), excludePickerHost, excludedHost);
    const actions = make('div', 'br-actions'); actions.append(newRule, saveRule, loadDefaultRules);
    ruleHost.append(note('同一阵容可同时归入多个体系；规则顺序只控制显示。'),ruleError, ruleStatus, ruleConflictHost, ruleForm, actions, ruleDefaultsHost, ruleList);
    ruleForm.addEventListener('submit', event => { event.preventDefault(); if (rulesBusy || !stageEditor()) return; renderRules(); ruleStatus.replaceChildren(note('已更新草稿；尚未保存。')); });
    editRule();
    function updateRuleOptions() {
      const current=fields.teamRuleId.value,entries=[['','全部体系'],...rules.map(rule=>[rule.id,rule.name]),['__other__','其他']];
      if(current&&current!=='__other__'&&!rules.some(rule=>rule.id===current))entries.push([current,'规则已不可用（重置后可清除）']);fields.teamRuleId.setOptions(entries);
    }
    function ruleSnapshotTable(snapshot) {
      return table(['顺序', '规则名称', '必须包含', '不得包含'], snapshot.map((rule, index) => [
        String(index + 1), rule.name, [...rule.monsterIds.map(id => speciesName(id)), ...arr(rule.anyOf).map(group => '(' + group.map(id => speciesName(id)).join(' 或 ') + ')')].join(' + '), rule.excludedMonsterIds.map(id => speciesName(id)).join(' / ') || '无'
      ]), '此版本没有自定义规则。');
    }
    function renderRuleConflict() {
      ruleConflictHost.replaceChildren();
      const conflict = ruleConflict; if (!conflict) return;
      const panel = make('section', 'br-card br-rule-conflict'); panel.setAttribute('aria-label', '规则版本冲突核对');
      panel.append(title('服务器规则已变化：保存已暂停'), note('保留本地草稿，但不会自动套用新版本。规则可同时命中；请核对服务器的完整列表及显示顺序，再明确选择如何处理。'),
        title('最新服务器规则（当前生效顺序）', 'h4'), ruleSnapshotTable(conflict.rules));
      const confirmation = make('div'), choices = make('div', 'br-actions');
      const usable = () => active && rulesReady && !rulesBusy && ruleConflict === conflict;
      const adopt = button('采用服务器版本（放弃本地草稿）', () => {
        if (!usable()) return;
        clearDefaultConfirmation();
        confirmation.replaceChildren(note('确认放弃全部本地未保存编辑、增删和排序？服务器规则及其顺序保持不变，此操作不写入服务器。'),
          button('确认放弃本地草稿，采用服务器版本', () => {
            if (!usable()) return;
            rules = copyRules(conflict.rules); ruleDrafts = copyRules(conflict.rules); rulesRevision = conflict.revision; ruleConflict = null; draftVersion++;
            editRule(ruleDrafts.find(rule => rule.id === editId)); ruleError.replaceChildren(); ruleStatus.replaceChildren(note('已采用服务器版本；未写入服务器。')); updateRuleOptions(); renderRules();
          }), button('取消处理，保留草稿', () => confirmation.replaceChildren()));
      });
      const replace = button('核对用本地草稿整体替换', () => {
        if (!usable() || !stageEditor()) return;
        const version = draftVersion, proposed = copyRules(ruleDrafts);
        const removed = conflict.rules.filter(rule => !proposed.some(draft => draft.id === rule.id));
        confirmation.replaceChildren(title('待整体保存的本地规则（含显示顺序）', 'h4'), ruleSnapshotTable(proposed),
          note('此操作将整体替换上面的服务器版本，覆盖其内容及显示顺序；服务器新增而本地没有的规则将被删除。'),
          note('将删除的服务器规则：' + (removed.map(rule => rule.name).join('；') || '无')),
          button('确认整体替换，并保存', () => {
            if (!usable()) return;
            if (draftVersion !== version || editDirty) { renderRules(); ruleStatus.replaceChildren(note('草稿已变化，请重新核对后确认。')); return; }
            saveRules({ conflict, version, rules: proposed });
          }, true), button('取消处理，保留草稿', () => confirmation.replaceChildren()));
      });
      adopt.disabled = replace.disabled = !rulesReady || rulesBusy;
      choices.append(adopt, replace); panel.append(choices, confirmation); ruleConflictHost.append(panel);
    }
    function renderRules() {
      clearDefaultConfirmation();
      renderRuleConflict(); ruleList.replaceChildren();
      if (!ruleDrafts.length) ruleList.append(note('暂无自定义规则。'));
      ruleDrafts.forEach((rule, index) => {
        const card = make('div', 'br-card br-rule'); card.dataset.ruleId = rule.id; card.tabIndex = 0; card.setAttribute('role', 'group'); card.setAttribute('aria-label', `编辑规则 ${rule.name}`);
        card.append(title(`${index + 1}. ${rule.name}`), note('包含：' + (arr(rule.monsterIds).map(id => speciesName(id)).join(' + ') || '由任选组匹配')));
        const members = make('div', 'br-rule-members');
        for (const id of arr(rule.monsterIds)) members.append(petLine({ monsterId: id })); card.append(members);
        for(const [groupIndex,group]of arr(rule.anyOf).entries()){const alternatives=make('div','br-rule-alternatives');alternatives.append(make('strong','',`任选组 ${groupIndex+1}：`));for(const id of group)alternatives.append(petLine({monsterId:id}));card.append(alternatives);}
        card.append(note('排除：' + (arr(rule.excludedMonsterIds).map(id => speciesName(id)).join(' / ') || '无')));
        const actions = make('div', 'br-actions');
        const beginEdit = () => { if (!active || !card.isConnected || rulesBusy || !stageEditor()) return; editRule(ruleDrafts.find(item => item.id === rule.id)); renderRules(); ruleName.focus({ preventScroll: true }); };
        const edit = button('编辑规则', event => { event.stopPropagation?.(); beginEdit(); });
        card.addEventListener('click', event => { if (!actions.contains(event.target)) beginEdit(); });
        card.addEventListener('keydown', event => { if (actions.contains(event.target) || event.repeat || !['Enter', ' '].includes(event.key)) return; event.preventDefault(); beginEdit(); });
        const remove = button('删除规则', () => {
          if (rulesBusy) return;
          ruleDrafts = ruleDrafts.filter(item => item.id !== rule.id); if (editId === rule.id) editRule(); draftVersion++; renderRules();
          ruleStatus.replaceChildren(note('已从草稿删除；点击保存规则后生效。'));
        });
        const reorder = offset => {
          if (rulesBusy || !stageEditor()) return;
          const current = ruleDrafts.findIndex(item => item.id === rule.id), next = current + offset;
          if (current < 0 || next < 0 || next >= ruleDrafts.length) return;
          [ruleDrafts[current], ruleDrafts[next]] = [ruleDrafts[next], ruleDrafts[current]]; draftVersion++; renderRules();
          ruleStatus.replaceChildren(note('已调整草稿显示顺序；点击保存规则后生效。'));
        };
        const up = button('上移', () => reorder(-1)), down = button('下移', () => reorder(1));
        edit.disabled = remove.disabled = rulesBusy; up.disabled = rulesBusy || index === 0; down.disabled = rulesBusy || index === ruleDrafts.length - 1;
        actions.append(edit, remove, up, down); card.append(actions); ruleList.append(card);
      });
      saveRule.disabled = !rulesReady || rulesBusy || !!ruleConflict; newRule.disabled = ruleName.disabled = rulesBusy;
      loadDefaultRules.hidden = !defaultRules.length; loadDefaultRules.disabled = !rulesReady || rulesBusy;
      rulePicker?.setDisabled(rulesBusy); excludePicker?.setDisabled(rulesBusy); renderDraft();
    }
    function openRules(trigger) {
      if (!active || !trigger?.isConnected) return;
      if (modal?.kind === 'rules') { modal.close.focus({ preventScroll: true }); return; }
      openPageModal('rules', '阵容规则', '敌方阵容规则编辑', trigger);
      modal.body.append(ruleHost);
      // CommonUI destroys disconnected widgets. Create these only while the
      // modal is connected, and release them on close without discarding drafts.
      const editingModal = modal;
      rulePicker = monsterPicker('添加规则核心成员（Wiki ID）', id => { if (active && modal === editingModal) addMember(id, false); }, false);
      excludePicker = monsterPicker('添加规则排除成员（Wiki ID）', id => { if (active && modal === editingModal) addMember(id, true); }, false);
      anyPicker = monsterPicker('添加任选组成员（Wiki ID）', id => { if (active && modal === editingModal) addAnyMember(id); }, false);
      rulePickerHost.append(rulePicker.wrap); excludePickerHost.append(excludePicker.wrap); anyPickerHost.append(anyPicker.wrap); renderRules();
    }
    async function loadRules(preserveDrafts = false) {
      if (!active || rulesBusy) return;
      clearDefaultConfirmation();
      const abort = controller('rules'); rulesReady = false; saveRule.disabled = loadDefaultRules.disabled = true; ruleError.replaceChildren(); ruleStatus.replaceChildren(note('正在读取阵容规则…'));
      try {
        const result = await request('rules', { signal: abort.signal });
        if (!active || abort.signal.aborted) return;
        if (!known(result.revision) || !Array.isArray(result.rules)) throw Error('规则接口未提供有效版本，请更新服务后重试');
        defaultRules = Array.isArray(result.defaults) ? copyRules(result.defaults) : [];
        const latest = copyRules(result.rules), hasLocalChanges = editDirty || JSON.stringify(ruleDrafts) !== JSON.stringify(rules);
        const changedRevision = result.revision !== rulesRevision;
        if (!draftsLoaded) {
          // A first GET/retry may finish after the user has staged a new local
          // rule. Keep those stable-ID drafts while adding the saved baseline.
          const local = ruleDrafts; ruleDrafts = copyRules(latest);
          for (const draft of local) if (!ruleDrafts.some(rule => rule.id === draft.id)) ruleDrafts.push(draft);
          draftsLoaded = true; rulesRevision = result.revision;
        } else if (changedRevision && (hasLocalChanges || ruleConflict)) {
          // Reading a newer CAS token is not permission to overwrite that newer
          // snapshot with an older full-list draft, especially its rule order.
          ruleConflict = { rules: latest, revision: result.revision };
        } else {
          ruleConflict = null; rulesRevision = result.revision;
          if (changedRevision) { ruleDrafts = copyRules(latest); editRule(ruleDrafts.find(rule => rule.id === editId)); }
        }
        rules = latest; rulesReady = true;
        ruleStatus.replaceChildren(ruleConflict ? note('已读取最新服务器规则，保留本地草稿；请先处理版本冲突，普通保存已禁用。') : preserveDrafts ? note('规则版本未冲突，保留本地草稿。') : note('')); updateRuleOptions(); renderRules();
      } catch (error) { if (active && !abort.signal.aborted) { ruleStatus.replaceChildren(); errorAt(ruleError, error, () => loadRules(preserveDrafts)); } }
    }
    async function saveRules(resolution = null) {
      if (!active || !rulesReady || rulesBusy) return;
      if ((ruleConflict && (!resolution || resolution.conflict !== ruleConflict || resolution.version !== draftVersion || editDirty)) || (resolution && resolution.conflict !== ruleConflict)) {
        renderRules(); ruleStatus.replaceChildren(note('请先核对并明确处理服务器版本冲突。')); return;
      }
      const nextRules = copyRules(resolution ? resolution.rules : ruleDrafts), submittedVersion = draftVersion;
      const baseRevision = resolution ? resolution.conflict.revision : rulesRevision;
      rulesBusy = true; renderRules(); ruleError.replaceChildren(); ruleStatus.replaceChildren(note('正在保存规则…'));
      try {
        const result = await request('rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: nextRules, baseRevision }) });
        if (!active) return;
        if (!known(result.revision) || !Array.isArray(result.rules)) throw Error('服务未返回已保存规则版本，请重新读取核对');
        rules = copyRules(result.rules); rulesRevision = result.revision; ruleConflict = null;
        if (Array.isArray(result.defaults)) defaultRules = copyRules(result.defaults);
        if (submittedVersion === draftVersion) ruleDrafts = copyRules(rules);
        ruleStatus.replaceChildren(note('规则已保存')); updateRuleOptions(); invalidateStats();refresh();
      } catch (error) {
        if (active) {
          ruleStatus.replaceChildren(); errorAt(ruleError, error, () => { if (stageEditor()) saveRules(); });
          ruleError.append(button('重新读取规则版本（保留草稿）', () => loadRules(true)));
        }
      } finally { rulesBusy = false; if (active) renderRules(); }
    }

    page.append(heading, importStatus, scanStatus, dataChangeStatus, relay, navigation, queryStatus, ...Object.values(panels));
    container.replaceChildren(page); showTab(state.tab);
    const cleanup = () => {
      if (!active) return;
      active = false; closeFilters(); closePetTip(); closeModal(false); generation++; detailGeneration++;statsGeneration++;statsPending=null; clearTimeout(pollTimer); clearTimeout(progressTimer);
      for (const abort of aborts.values()) abort.abort(); aborts.clear();
      lastFile = null; currentStats = null; performanceBindings = [];
      for (const fn of cleanups) fn();
      if (scanChanged === syncScan) scanChanged = null;
      if (dispose === cleanup) dispose = null;
    };
    scanChanged = syncScan; syncScan();
    dispose = cleanup;
    const unregister = ui()?.registerCleanup?.(page, cleanup); if (unregister) cleanups.push(unregister);
    refresh(); loadRules(); loadStatus();
  }
  return Object.freeze({ render, onLeave, filterQuery, groupedTurns, timelineTurns, lifecycleKind, executionIndex, eventName, eventNumbers, confirmedGrowth, evidenceText, ratio, speciesName, skillName, recordCounts, recordCountsText, identityEvidenceText, formChangeText, formEvidenceText });
});
