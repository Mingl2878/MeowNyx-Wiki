/* Go owns source validation, server-generated candidates, snapshots and atomic
 * writes. Radios are session drafts only; no localStorage, arbitrary JSON writes,
 * external URL input or automatic reload. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = { createCatalogUpdater: factory };
  else root.CatalogUpdater = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, options) {
  'use strict';
  options = options || {};
  const POLL_MS = options.pollMs ?? 1200, REQUEST_MS = options.requestTimeoutMs ?? 12000, FLUSH_MS = options.flushTimeoutMs ?? 15000;
  const PAGE_SIZE = 30;
  const STATES = ['idle', 'checking', 'preview', 'applying', 'applied', 'cancelled', 'error'];
  const STATE_LABEL = { idle: '尚未检查', checking: '正在检查官方资料', preview: '差异预览 · 尚未应用', applying: '正在安全应用', applied: '应用完成', cancelled: '已取消', error: '更新失败 · 未完成' };
  const ENTITY_LABEL = { monster: '精灵', skill: '技能', move: '技能', catalog: '图鉴', wiki: '学习面' };
  const FIELD_LABEL = { identity: '身份与形态', evolution: '进化成员与前置', leader_form: '首领化来源', learning: '完整学习面', evolution_stage: '进化阶段', type_ids: '属性', type_id: '属性', trait: '特性', entity: '完整新增条目', description: '效果', category: '类别', power: '威力', energy_cost: '能耗', season: '赛季', image_policy: '普通立绘更新策略', data_note: '资料备注', 'stats.hp': '生命', 'stats.phy_atk': '物攻', 'stats.mag_atk': '魔攻', 'stats.phy_def': '物防', 'stats.mag_def': '魔防', 'stats.speed': '速度' };
  let host = null, view = null, timer = null, pending = null, busy = '';
  let state = null, transportError = '', acknowledged = false, engaged = false;
  let draft = new Map(), permanentDraft = new Set(), changeFilter = '', changePage = 0, issuePage = 0, memoryPage = 0;
  let closing = false, closePromise = null, reloading = false, reloadPromise = null, detailModal = null;
  const active = value => value && (value.state === 'checking' || value.state === 'applying');
  const text = value => value == null ? '（明确空值）' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const label = (table, key) => Object.hasOwn(table, key) ? table[key] : String(key ?? '');
  const candidates = () => state?.candidates || [];
  const issues = () => state?.issues || [];
  const reviews = () => issues().filter(item => item.severity === 'review');
  const blocking = () => issues().some(item => item.severity === 'blocking');
  const stale = () => state?.base_revision && state?.current_revision && state.base_revision !== state.current_revision;
  const locked = () => !!pending || closing || reloading;
  const editable = () => state?.state === 'preview' && !locked() && !stale() && !transportError;
  const hasSelection = () => draft.size > 0 || state?.automatic_source_changes > 0;
  const canApply = () => editable() && state.can_apply === true && !!state.task_id && !!state.base_revision && !blocking() && !state.error && (!reviews().length || acknowledged) && hasSelection();
  function applyReason() {
    if (transportError) return '尚未确认服务端状态，请重试获取状态。';
    if (blocking()) return '存在阻断问题，不能应用。';
    if (state?.state === 'preview') {
      if (stale()) return '预览已过期，请重新检查。';
      if (!state.task_id || !state.base_revision) return '缺少有效任务或资料版本，请重新检查。';
      if (state.can_apply !== true || state.error) return '后端未允许应用：' + (state.error || '请查看错误。');
      if (!hasSelection()) return '';
      if (reviews().length && !acknowledged) return '请查看待确认项并勾选审阅确认。';
      return locked() ? '正在等待操作安全完成。' : '';
    }
    return ({ idle: '', checking: '正在检查，请等待。', applying: '正在安全应用，请等待。', applied: '应用已完成，不会自动重新载入。', cancelled: '任务已取消。', error: '更新未完成，请重试。' })[state?.state || 'idle'];
  }
  function stopTimer() { if (timer !== null) root.clearTimeout(timer); timer = null; }
  function schedule() {
    stopTimer();
    if (!host || host.isConnected === false || !active(state) || pending || closing || reloading) return;
    timer = root.setTimeout(() => { timer = null; void refresh(); }, POLL_MS);
  }
  async function bounded(promise, ms, message, onTimeout) {
    let id;
    try { return await Promise.race([promise, new Promise((_, reject) => { id = root.setTimeout(() => { onTimeout?.(); reject(Error(message)); }, ms); })]); }
    finally { root.clearTimeout(id); }
  }
  async function request(action, body) {
    const controller = root.AbortController ? new root.AbortController() : null;
    const get = action === 'status' || action === 'choices';
    const init = { method: get ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } };
    if (controller) init.signal = controller.signal;
    if (!get) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return bounded((async () => {
      const response = await root.fetch('/api/catalog/update/' + action, init);
      let value;
      try { value = await response.json(); } catch (_) { throw Error('更新服务返回非 JSON 内容，未确认成功。'); }
      if (!response.ok || value?.ok !== true) throw Error(typeof value?.error === 'string' ? value.error : '更新请求失败（HTTP ' + response.status + '）');
      if (!STATES.includes(value.state) || ['changes', 'issues', 'candidates', 'remembered_choices'].some(key => value[key] != null && !Array.isArray(value[key]))) throw Error('更新服务状态格式异常，未确认成功。');
      if ((value.issues || []).some(item => !item || !['blocking', 'warning', 'review'].includes(item.severity))) throw Error('问题列表格式异常，已阻止应用。');
      const keys = new Set();
      if ((value.candidates || []).some(item => !item || typeof item.key !== 'string' || !item.key || keys.has(item.key) || !keys.add(item.key) || typeof item.local_available !== 'boolean' || typeof item.source_available !== 'boolean')) throw Error('候选列表格式异常，已阻止应用。');
      if ((value.remembered_choices || []).some(item => !item || typeof item.key !== 'string' || !['local', 'source'].includes(item.choice))) throw Error('记忆列表格式异常，已阻止应用。');
      if (value.automatic_source_changes != null && (!Number.isSafeInteger(value.automatic_source_changes) || value.automatic_source_changes < 0)) throw Error('自动变化计数异常。');
      if (value.source_baseline_active != null && typeof value.source_baseline_active !== 'boolean') throw Error('来源基线状态异常。');
      return { ...value, changes: value.changes || [], issues: value.issues || [], candidates: value.candidates || [], remembered_choices: value.remembered_choices || [] };
    })(), REQUEST_MS, '请求超时，尚不能确认服务端结果。请重新查询任务状态。', () => controller?.abort());
  }
  function accept(value) {
    if (!state || state.task_id !== value.task_id || state.base_revision !== value.base_revision || state.state !== value.state || !!state.source_baseline_active !== !!value.source_baseline_active) {
      draft = new Map(); permanentDraft = new Set(); acknowledged = false; changePage = 0; issuePage = 0;
    } else {
      if (JSON.stringify(state.issues) !== JSON.stringify(value.issues)) acknowledged = false;
      const byKey = new Map(value.candidates.map(item => [item.key, item]));
      for (const [key, choice] of draft) { const item = byKey.get(key); if (!item || !item[choice + '_available']) { draft.delete(key); permanentDraft.delete(key); } }
    }
    state = value; transportError = '';
  }
  function run(action, body) {
    if (pending) return pending;
    closeDetails(false);
    engaged = true; busy = action; stopTimer();
    pending = Promise.resolve().then(() => request(action, body)).then(value => { accept(value); return true; }, error => { transportError = error?.message || String(error); return false; })
      .finally(() => { pending = null; busy = ''; render(); schedule(); });
    render(); return pending;
  }
  function refresh() { return run('status'); }
  function check() {
    if (locked()) return Promise.resolve(false);
    // Recover the existing task before starting another check: a lost response
    // may still belong to an active check or an already-committed apply.
    if (transportError) return refresh();
    if (active(state)) return Promise.resolve(false);
    if (state?.state === 'preview' && !root.confirm('重新检查会丢弃本次选择草稿，继续？')) return Promise.resolve(false);
    return run('check', {});
  }
  function apply() {
    const prompt = state?.source_baseline_active ? '确认所选来源变化并应用？仅勾选长期记忆的项目会影响以后选择；未选项不处理。' : '保存所选策略并应用？未选项目保留本地，页面不会自动刷新。';
    if (!canApply() || !root.confirm(prompt)) return Promise.resolve(false);
    return run('apply', { task_id: state.task_id, base_revision: state.base_revision, acknowledge_reviews: reviews().length > 0 && acknowledged, choices: [...draft].map(([key, choice]) => ({ key, choice, ...(state.source_baseline_active ? { acknowledge_only: !permanentDraft.has(key) } : {}) })) });
  }
  function clearMemory(keys) {
    if (locked() || active(state) || !state?.current_revision || transportError) return Promise.resolve(false);
    if (!root.confirm(keys ? '撤销此项记忆？当前预览及选择草稿将失效。' : '撤销全部记忆？当前预览及选择草稿将失效。')) return Promise.resolve(false);
    return run('choices/clear', { base_revision: state.current_revision, ...(keys ? { keys } : { all: true }) });
  }
  function bulkSelect(mode) {
    if (!editable()) return;
    // Always traverse the complete server candidate list, not the visible page.
    // Bulk selection never opts a newly chosen side into permanent memory.
    for (const item of candidates()) {
      const before = draft.get(item.key);
      // An unavailable source is not permission to erase an explicit, valid
      // local decision. Invert/cancel remain the explicit clearing operations.
      if (mode === 'all' && !item.source_available && before === 'local' && item.local_available) continue;
      const after = mode === 'clear' || (mode === 'invert' && before) || !item.source_available ? null : 'source';
      if (after) draft.set(item.key, after); else draft.delete(item.key);
      if (!after || before !== after) permanentDraft.delete(item.key);
    }
    renderControls(); renderChanges();
  }
  function rememberSelected() {
    if (!editable() || !state.source_baseline_active) return;
    for (const item of candidates()) {
      const choice = draft.get(item.key);
      if (['local', 'source'].includes(choice) && item[choice + '_available']) permanentDraft.add(item.key);
      else { draft.delete(item.key); permanentDraft.delete(item.key); }
    }
    renderControls(); renderChanges();
  }
  function make(tag, content, className) {
    const node = host.ownerDocument.createElement(tag);
    if (content != null) node.textContent = content;
    if (className) node.className = className;
    return node;
  }
  function button(content, action, name) {
    const node = make('button', content, 'btn btn-secondary'); node.type = 'button'; node.dataset.action = name;
    node.addEventListener('click', () => { void action(); }); return node;
  }
  const longValue = content => content.length > 360 || content.split('\n').length > 8;
  function closeDetails(restoreFocus = true) {
    if (!detailModal) return;
    const { node, opener } = detailModal; detailModal = null;
    if (node.open) node.close();
    node.remove();
    if (restoreFocus && opener.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
  }
  function detailButton(item, side, heading, content, raw) {
    const snapshot = state;
    const opener = button('详情', () => {
      // Detached controls and obsolete snapshots must never reopen old evidence.
      if (!opener.isConnected || !host?.isConnected || !editable() || state !== snapshot || !candidates().includes(item)) return;
      closeDetails(false);
      const dialog = make('dialog', null, 'cu-detail-modal');
      dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'cu-detail-title');
      const header = make('div', null, 'cu-detail-header'), titleNode = make('h4', title(item) + ' · ' + (side === 'local' ? '本地值' : '源值') + ' · ' + heading);
      titleNode.id = 'cu-detail-title';
      const closeBtn = button('×', () => closeDetails(), 'close-details'); closeBtn.setAttribute('aria-label', '关闭详情');
      header.append(titleNode, closeBtn);
      const body = make('div', null, 'cu-detail-body'); body.tabIndex = 0; body.setAttribute('aria-label', '完整候选内容');
      body.append(make('pre', content));
      if (raw != null && raw !== content) body.append(make('h4', '原始候选值'), make('pre', raw));
      dialog.append(header, body);
      dialog.addEventListener('cancel', event => { event.preventDefault(); closeDetails(); });
      dialog.addEventListener('close', () => { if (detailModal?.node === dialog) closeDetails(); });
      detailModal = { node: dialog, opener };
      view.page.append(dialog); dialog.showModal(); closeBtn.focus({ preventScroll: true });
    }, 'details');
    opener.className = 'btn btn-secondary cu-details-button';
    opener.dataset.key = item.key; opener.dataset.side = side; opener.dataset.heading = heading;
    opener.setAttribute('aria-label', title(item) + ' · ' + (side === 'local' ? '本地值' : '源值') + ' · ' + heading + '详情');
    opener.disabled = !editable();
    return opener;
  }
  function appendEvidence(cell, item, side, heading, value) {
    const content = text(value);
    if (longValue(content)) {
      const evidence = make('div', null, 'cu-evidence');
      evidence.append(make('span', heading), detailButton(item, side, heading, content)); cell.append(evidence);
    } else {
      const details = make('details', null, 'cu-raw-value'); details.append(make('summary', heading)); let filled = false;
      details.addEventListener('toggle', () => { if (!details.open || filled) return; filled = true; details.append(make('pre', content)); }); cell.append(details);
    }
  }
  function build() {
    const page = make('section', null, 'catalog-updater'); page.setAttribute('aria-label', '从官方图鉴更新');
    const heading = make('h3', null, 'cu-heading'), hint = make('small', '该功能尚未完善', 'cu-feature-hint');
    hint.id = 'cu-feature-hint'; heading.setAttribute('aria-label', '从官方图鉴更新'); heading.setAttribute('aria-describedby', hint.id);
    heading.append(make('span', '从官方图鉴更新'), hint); page.append(heading);
    const operation = make('section', null, 'cu-operation'); operation.setAttribute('aria-label', '检查、选择与应用');
    const actions = make('div', null, 'cu-actions');
    const checkBtn = button('检查官方更新', check, 'check');
    const applyBtn = button('确认并应用', apply, 'apply'); applyBtn.className = 'btn btn-primary';
    const reloadBtn = button('重新载入资料', reload, 'reload');
    actions.append(checkBtn, applyBtn, reloadBtn); operation.append(actions);
    const bulkActions = make('div', null, 'cu-bulk-actions'); bulkActions.setAttribute('aria-label', '全部候选项（跨分类与分页）');
    const allBtn = button('全选', () => bulkSelect('all'), 'select-all');
    const invertBtn = button('反选', () => bulkSelect('invert'), 'invert-selection');
    const clearBtn = button('取消选择', () => bulkSelect('clear'), 'clear-selection');
    const rememberBtn = button('记忆已选项', rememberSelected, 'remember-selected');
    bulkActions.append(allBtn, invertBtn, clearBtn, rememberBtn); operation.append(bulkActions);
    const reviewLabel = make('label', null, 'cu-review'), reviewInput = make('input'); reviewInput.type = 'checkbox';
    reviewInput.addEventListener('change', () => { acknowledged = reviewInput.checked; renderControls(); });
    reviewLabel.append(reviewInput, make('span', '已查看待确认项；未解决项保留本地'));
    const reason = make('p', '', 'cu-apply-reason'); reason.id = 'cu-apply-reason'; reason.setAttribute('aria-live', 'polite'); applyBtn.setAttribute('aria-describedby', reason.id);
    const reloadHint = make('p', '', 'cu-muted');
    operation.append(reviewLabel, reason, reloadHint); page.append(operation);
    const status = make('div', '', 'cu-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const progress = make('progress'); progress.setAttribute('aria-label', '官方图鉴更新进度');
    const problem = make('p', '', 'cu-error'); problem.setAttribute('role', 'alert');
    const notice = make('p', '', 'cu-notice');
    const changesPanel = make('section', null, 'cu-panel'), issuePanel = make('section', null, 'cu-panel'), memoryPanel = make('section', null, 'cu-panel');
    page.append(status, progress, problem, notice, changesPanel, issuePanel, memoryPanel);
    host.replaceChildren(page);
    view = { page, operation, checkBtn, applyBtn, allBtn, invertBtn, clearBtn, rememberBtn, reviewLabel, reviewInput, reason, reloadBtn, reloadHint, status, progress, problem, notice, changesPanel, issuePanel, memoryPanel };
  }
  function renderControls() {
    if (!view) return;
    const v = view;
    if (!editable()) closeDetails(false);
    v.checkBtn.disabled = locked() || (!!active(state) && !transportError);
    v.checkBtn.textContent = transportError ? '重试检查' : '检查官方更新';
    v.applyBtn.disabled = !canApply(); v.reason.textContent = applyReason(); v.reason.hidden = !v.reason.textContent; v.applyBtn.title = v.reason.textContent;
    v.allBtn.disabled = v.invertBtn.disabled = !editable() || !candidates().length;
    v.clearBtn.disabled = !editable() || !draft.size;
    v.rememberBtn.disabled = !state?.source_baseline_active || !editable() || !draft.size;
    v.reviewLabel.hidden = !reviews().length || state?.state !== 'preview'; v.reviewInput.checked = acknowledged; v.reviewInput.disabled = locked() || blocking();
    v.reloadBtn.disabled = locked() || active(state); v.reloadBtn.className = state?.state === 'applied' ? 'btn btn-primary' : 'btn btn-secondary';
    v.reloadHint.textContent = state?.state === 'applied' ? '应用完成，主动重新载入后显示新资料。' : '';
    v.reloadHint.hidden = !v.reloadHint.textContent;
  }
  function render() {
    if (!host || !view) return;
    const v = view, mode = state?.state || 'idle'; v.page.dataset.state = mode;
    v.status.textContent = busy ? '请求处理中 · ' + busy : STATE_LABEL[mode];
    if (active(state) && Number.isFinite(state.completed)) v.status.textContent += ' · ' + state.completed + (state.total ? ' / ' + state.total : '');
    v.progress.hidden = !active(state) && !['check', 'apply'].includes(busy);
    if (Number.isFinite(state?.total) && state.total > 0) { v.progress.max = state.total; v.progress.value = Math.min(state.total, Math.max(0, state.completed || 0)); } else v.progress.removeAttribute('value');
    v.problem.textContent = transportError || state?.error || ''; v.problem.hidden = !v.problem.textContent;
    v.notice.textContent = mode === 'preview' ? (state.source_baseline_active ? '' : '选择本地：以后保留本地；选择源：以后跟随有效来源。仅点击应用才提交，未选项目保持本地且不记忆。') : mode === 'applied' ? '选择与资料已保存；当前页面仍使用原已载入资料，不会自动刷新。' : mode === 'checking' ? '检查不会写入。离页不取消后台任务。' : mode === 'cancelled' ? '任务已取消，未提交的选择不会保存。' : '';
    v.notice.hidden = !v.notice.textContent;
    renderControls(); renderChanges(); renderIssues(); renderMemory();
  }
  function pager(parent, total, page, setPage) {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), row = make('div', null, 'cu-pagination');
    const prev = button('上一批', () => setPage(page - 1), 'previous'); prev.disabled = page <= 0;
    const next = button('下一批', () => setPage(page + 1), 'next'); next.disabled = page >= pages - 1;
    row.append(prev, make('span', `${page + 1} / ${pages} 批 · 共 ${total} 项`), next); parent.append(row);
  }
  function title(item) { return [label(ENTITY_LABEL, item.entity), item.id || '', item.name, label(FIELD_LABEL, item.field)].filter(Boolean).join(' · '); }
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  function recordName(value, entity) {
    if (!record(value)) return '';
    const zh = value.localized?.zh;
    const name = entity === 'type' && typeof zh === 'string' ? zh : typeof value.name === 'string' ? value.name : typeof zh?.name === 'string' ? zh.name : '';
    if (!name) return '';
    const form = value.form;
    return entity === 'monster' && typeof form === 'string' && form && !['default', 'Original'].includes(form) ? name + '（' + form + '）' : name;
  }
  function candidateNames() {
    // Read-only display lookup by local ID. No source numeric-ID matching and
    // no requests: candidate labels must not change the actual choice payload.
    const data = root.RKData || (typeof RKData !== 'undefined' ? RKData : null);
    const local = { monster: new Map(), skill: new Map(), type: new Map() };
    let compatible = true;
    try {
      if (typeof data?.getCatalogRevision === 'function' && state?.base_revision) {
        const revision = data.getCatalogRevision(); compatible = !revision || revision === state.base_revision;
      }
    } catch (_) { compatible = false; }
    for (const [entity, method] of [['monster', 'getMonsters'], ['skill', 'getMoves'], ['type', 'getTypes']]) {
      let rows = [];
      try { if (compatible && typeof data?.[method] === 'function') rows = data[method](); } catch (_) { /* Unknown labels remain exact IDs. */ }
      if (!Array.isArray(rows)) continue;
      for (const row of rows) { const name = recordName(row, entity); if (Number.isSafeInteger(row?.id) && name) local[entity].set(row.id, name); }
    }
    const names = { local, source: Object.fromEntries(Object.entries(local).map(([key, values]) => [key, new Map(values)])) };
    // Fallback row labels first, then explicit identity values so list order
    // never lets an old row label overwrite a newly supplied formal name.
    for (const item of candidates()) {
      const entity = item.entity === 'move' ? 'skill' : item.entity;
      if (!local[entity] || !Number.isSafeInteger(item.id) || item.kind === 'add' || typeof item.name !== 'string' || !item.name) continue;
      for (const side of ['local', 'source']) if (!names[side][entity].has(item.id)) names[side][entity].set(item.id, item.name);
    }
    for (const item of candidates()) {
      const entity = item.entity === 'move' ? 'skill' : item.entity;
      if (!local[entity] || !Number.isSafeInteger(item.id)) continue;
      for (const side of ['local', 'source']) {
        if (!item[side + '_available']) continue;
        const value = item[side + '_value'];
        const entry = item.field === 'identity' ? value : item.kind === 'add' ? value?.[entity] || value : null;
        if (!record(entry) || (entry.id != null && entry.id !== item.id)) continue;
        const name = recordName(entry, entity); if (name) names[side][entity].set(item.id, name);
      }
    }
    return names;
  }
  function candidateValue(item, side, names) {
    const value = item[side + '_value'];
    const reference = (entity, id) => {
      const name = names[side][entity]?.get(id), kind = entity === 'monster' ? '精灵' : entity === 'skill' ? '技能' : '属性';
      return name ? name + '（' + (entity === 'monster' ? '本地 ID ' : 'ID ') + text(id) + '）' : kind + ' ID ' + text(id);
    };
    const optionalMonster = id => id == null || id === 0 ? '无' : reference('monster', id);
    if (item.field === 'type_ids' && Array.isArray(value)) return '属性：' + (value.length ? value.map(id => reference('type', id)).join('、') : '无（空列表）');
    if (item.field === 'type_id' && Number.isSafeInteger(value)) return '属性：' + reference('type', value);
    if (!record(value)) return null;
    if (item.kind === 'add' && item.field === 'entity' && item.entity === 'monster') {
      const entry = value.monster || value, name = recordName(entry, 'monster');
      if (name) {
        // Full add candidates may carry learnset objects, not field=learning.
        // Keep identity concise; all skills/extensions remain in raw evidence.
        const rows = ['正式名：' + name];
        if (Number.isSafeInteger(entry.id)) rows.push('本地 ID：' + entry.id);
        if (Array.isArray(entry.type_ids)) rows.push('属性：' + (entry.type_ids.length ? entry.type_ids.map(id => reference('type', id)).join('、') : '无（空列表）'));
        return rows.join('\n');
      }
    }
    if (item.field === 'evolution' && Array.isArray(value.evolution_members)) {
      return '进化成员：' + (value.evolution_members.length ? value.evolution_members.map(id => reference('monster', id)).join('、') : '无（空列表）') + '\n普通前置：' + optionalMonster(value.evolves_from_id);
    }
    if (item.field === 'leader_form') {
      return '普通来源：' + optionalMonster(value.leader_of_id) + '\n是否首领：' + (value.is_leader_form === true ? '是' : value.is_leader_form === false || value.is_leader_form == null ? '否' : text(value.is_leader_form));
    }
    if (item.field === 'learning' && typeof value.mode === 'string' && Array.isArray(value.skills)) {
      const rows = ['学习模式：' + label({ own: '独立学习', inherit: '继承' }, value.mode), '继承目标：' + optionalMonster(value.from_id), '技能：' + (value.skills.length ? '' : '无（空列表）')];
      value.skills.forEach((skill, index) => rows.push((index + 1) + '. ' + (record(skill) && Number.isSafeInteger(skill.skill_id) ? reference('skill', skill.skill_id) + ' · 来源：' + (typeof skill.source === 'string' && skill.source ? skill.source : '（未提供）') : text(skill))));
      return rows.join('\n');
    }
    if (item.field === 'identity' && typeof value.name === 'string') {
      const rows = ['正式名：' + value.name];
      if (item.entity === 'monster') {
        if (Object.hasOwn(value, 'form')) rows.push('形态：' + label({ default: '默认形态', Original: '本来的样子' }, value.form));
        if (Object.hasOwn(value, 'form_category')) rows.push('形态类别：' + text(value.form_category));
        if (Object.hasOwn(value, 'dex_number')) rows.push('图鉴编号：' + text(value.dex_number));
        rows.push('主形态：' + optionalMonster(value.main_form_id));
        rows.push('别名：' + (Array.isArray(value.aliases) ? value.aliases.length ? value.aliases.map(text).join('、') : '无' : value.aliases == null ? '无' : text(value.aliases)));
      }
      const ref = value.source_ref;
      rows.push('来源：' + (record(ref) ? label({ 'tencent-compendium': '腾讯图鉴' }, ref.provider) + (ref.id == null ? '' : '（来源 ID ' + text(ref.id) + '）') : ref == null ? '未关联' : text(ref)));
      return rows.join('\n');
    }
    return null;
  }
  function renderChanges() {
    if (!view) return;
    closeDetails(false);
    const panel = view.changesPanel; panel.replaceChildren(); panel.hidden = state?.state !== 'preview'; if (panel.hidden) return;
    panel.append(make('h4', '差异候选'));
    if (!candidates().length) { panel.append(make('p', state?.automatic_source_changes ? '没有新的待选项；已记忆来源变化仍需点击应用。' : '没有新的待选项。')); return; }
    const select = make('select'); select.setAttribute('aria-label', '差异分类');
    for (const entity of ['', ...new Set(candidates().map(item => item.entity))]) { const option = make('option', entity ? label(ENTITY_LABEL, entity) : '全部分类'); option.value = entity; select.append(option); }
    if (changeFilter && !candidates().some(item => item.entity === changeFilter)) changeFilter = '';
    select.value = changeFilter; select.addEventListener('change', () => { changeFilter = select.value; changePage = 0; renderChanges(); }); panel.append(select);
    const filtered = candidates().filter(item => !changeFilter || item.entity === changeFilter);
    changePage = Math.min(changePage, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
    const table = make('table', null, 'cu-choice-table'), head = make('thead'), header = make('tr');
    for (const heading of ['项目', '本地值', '源值']) { const th = make('th', heading); th.setAttribute('scope', 'col'); header.append(th); } head.append(header); table.append(head);
    const body = make('tbody'), names = candidateNames();
    for (const item of filtered.slice(changePage * PAGE_SIZE, (changePage + 1) * PAGE_SIZE)) {
      const row = make('tr', null, 'cu-change'), name = make('th', title(item)); name.setAttribute('scope', 'row'); row.append(name);
      let rememberInput = null;
      if (state.source_baseline_active) {
        const rememberLabel = make('label', null, 'cu-remember'); rememberInput = make('input'); rememberInput.type = 'checkbox'; rememberInput.dataset.rememberKey = item.key;
        rememberInput.setAttribute('aria-label', title(item) + ' · 记忆此项'); rememberInput.checked = permanentDraft.has(item.key); rememberInput.disabled = !editable() || !draft.has(item.key);
        rememberInput.addEventListener('change', () => { if (!editable() || !draft.has(item.key)) return; if (rememberInput.checked) permanentDraft.add(item.key); else permanentDraft.delete(item.key); });
        rememberLabel.append(rememberInput, make('span', '记忆此项')); name.append(rememberLabel);
      }
      const radios = [];
      for (const side of ['local', 'source']) {
        const cell = make('td'), radio = make('input');
        radio.type = 'radio'; radio.name = 'catalog-choice-' + item.key; radio.value = side; radio.dataset.key = item.key;
        radio.setAttribute('aria-label', title(item) + ' · ' + (side === 'local' ? '本地' : '源'));
        radio.checked = draft.get(item.key) === side; radio.disabled = !editable() || !item[side + '_available']; radios.push(radio);
        radio.title = '再次点击或按空格可撤销本项选择';
        // Native click also covers label clicks and keyboard Space activation;
        // clear checked before change fires so undo cannot reselect the row.
        radio.addEventListener('click', () => {
          if (!editable() || !item[side + '_available'] || draft.get(item.key) !== side) return;
          draft.delete(item.key); permanentDraft.delete(item.key);
          for (const sibling of radios) sibling.checked = false;
          if (rememberInput) { rememberInput.checked = false; rememberInput.disabled = true; }
          renderControls();
        });
        radio.addEventListener('change', () => {
          if (!editable() || !item[side + '_available'] || !radio.checked) return;
          draft.set(item.key, side); for (const sibling of radios) sibling.checked = sibling.value === side; if (rememberInput) rememberInput.disabled = false; renderControls();
        });
        const formatted = item[side + '_available'] ? candidateValue(item, side, names) : null;
        const content = item[side + '_available'] ? (item.kind === 'add' && side === 'local' ? '不新增，保持本地' : formatted ?? text(item[side + '_value'])) : (item.kind === 'source_review' ? '来源有新变化，但涉及受保护规则或关联字段，不能直接覆盖。' : '未提供可用源值（不可选）');
        const expanded = longValue(content), wrapper = make(expanded ? 'div' : 'label', null, 'cu-choice');
        // A details button is deliberately outside a label: opening it cannot
        // implicitly choose (or undo) either radio.
        wrapper.append(radio, expanded ? detailButton(item, side, '完整内容', content, formatted !== null ? text(item[side + '_value']) : null) : make('pre', content)); cell.append(wrapper);
        if (side === 'source' && item.kind === 'source_review' && item.source_revision != null) appendEvidence(cell, item, side, '本次来源证据', item.source_revision);
        if (formatted !== null && !expanded) appendEvidence(cell, item, side, '原始候选值', item[side + '_value']);
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body); panel.append(table); pager(panel, filtered.length, changePage, page => { changePage = page; renderChanges(); });
  }
  function renderIssues() {
    const panel = view.issuePanel; panel.replaceChildren();
    // Candidate rows already say unavailable; keep concise real review/blockers.
    const list = issues().filter(item => item.severity !== 'warning' || item.entity === 'image'); panel.hidden = !list.length; if (panel.hidden) return;
    panel.append(make('h4', '问题与待确认'));
    list.sort((a, b) => (a.severity === 'blocking' ? 0 : 1) - (b.severity === 'blocking' ? 0 : 1));
    issuePage = Math.min(issuePage, Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1));
    const rows = make('ul', null, 'cu-issues');
    for (const item of list.slice(issuePage * PAGE_SIZE, (issuePage + 1) * PAGE_SIZE)) {
      const row = make('li', null, 'cu-issue cu-' + item.severity); row.append(make('strong', (item.severity === 'blocking' ? '阻断 · ' : item.severity === 'review' ? '待确认 · ' : '警告 · ') + title(item)), make('p', item.message)); rows.append(row);
    }
    panel.append(rows); pager(panel, list.length, issuePage, page => { issuePage = page; renderIssues(); });
  }
  function renderMemory() {
    const panel = view.memoryPanel; panel.replaceChildren(); const memory = state?.remembered_choices || [];
    panel.append(make('h4', '已记忆项管理（撤销）'));
    if (!memory.length) { panel.append(make('p', '尚无已记忆项。')); return; }
    const clearAll = button('撤销全部记忆', () => clearMemory(), 'clear-all'); clearAll.disabled = locked() || active(state) || !state?.current_revision || !!transportError; panel.append(clearAll);
    memoryPage = Math.min(memoryPage, Math.max(0, Math.ceil(memory.length / PAGE_SIZE) - 1));
    const rows = make('ul', null, 'cu-memories');
    for (const item of memory.slice(memoryPage * PAGE_SIZE, (memoryPage + 1) * PAGE_SIZE)) {
      const row = make('li'); row.append(make('span', title(item) + '：' + (item.choice === 'local' ? '保留本地' : '跟随有效源')));
      const clear = button('撤销', () => clearMemory([item.key]), 'clear-choice'); clear.dataset.key = item.key; clear.disabled = clearAll.disabled; row.append(clear); rows.append(row);
    }
    panel.append(rows); pager(panel, memory.length, memoryPage, page => { memoryPage = page; renderMemory(); });
  }
  function mount(element) { unmount(); host = element; engaged = true; build(); render(); return pending ? pending.then(() => host === element ? refresh() : false) : refresh(); }
  function unmount() { stopTimer(); closeDetails(false); host = null; view = null; }
  function flush() {
    if (closePromise) return closePromise;
    if (!engaged && !pending) return Promise.resolve(true);
    closing = true; stopTimer(); renderControls();
    let expired = false, delayId = null, wake = null;
    const pause = () => new Promise(resolve => { wake = resolve; delayId = root.setTimeout(resolve, POLL_MS); });
    const work = async () => {
      if (pending) await pending;
      if (expired || !await refresh()) return false;
      let cancelledTask = null;
      while (!expired && active(state)) {
        if (state.state === 'checking' && state.task_id && cancelledTask !== state.task_id) { cancelledTask = state.task_id; if (!await run('cancel', { task_id: state.task_id })) return false; }
        else { await pause(); if (expired || !await refresh()) return false; }
      }
      return !expired;
    };
    closePromise = bounded(work(), FLUSH_MS, '任务仍未安全结束，请稍后重试关闭。', () => { expired = true; }).catch(error => { transportError = error.message; return false; })
      .finally(() => { expired = true; if (delayId !== null) root.clearTimeout(delayId); wake?.(); closing = false; closePromise = null; render(); schedule(); });
    return closePromise;
  }
  function reload() {
    if (reloadPromise) return reloadPromise;
    if (locked()) return Promise.resolve(false);
    reloading = true; stopTimer(); renderControls();
    reloadPromise = (async () => {
      if (!await refresh()) return false;
      if (active(state)) throw Error('更新任务仍在进行，不能重新载入。');
      if (typeof root.UserConfig?.flush !== 'function' || typeof root.BattleRecordsClient?.flush !== 'function') throw Error('保存组件不可用，已阻止重新载入。');
      const results = await bounded(Promise.all([root.UserConfig.flush(), root.BattleRecordsClient.flush()]), FLUSH_MS, '保存等待超时，未重新载入。');
      if (results.some(result => result !== true)) throw Error('个人配置或对战记录未保存成功，未重新载入。');
      if (!root.confirm('个人配置和对战记录已保存。重新载入资料会丢弃尚未提交的手工表单草稿及当前页面临时状态，是否继续？')) return false;
      root.location.reload(); return true;
    })().catch(error => { transportError = error.message; return false; }).finally(() => { reloading = false; reloadPromise = null; render(); schedule(); });
    return reloadPromise;
  }
  return Object.freeze({ mount, unmount, flush, reload });
});
