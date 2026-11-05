/**
 * 伤害曲线：共用基础换算与伤害算术，保留各模式原有的效果取舍。
 * 曲线收藏及个体/性格完全独立，只从伤害页带入精灵与技能参数。
 */
/* Pure helpers, independent of Chart.js and event ownership. */
const ChartFavoriteMath = Object.freeze({
  selectedValuesMatch(values, selected) {
    return ['atkIV', 'atkNature', 'defIV', 'defNature', 'hpNature'].every(key => values[key] === selected[key]);
  },
  visibleDamageRows(chart) {
    return chart ? chart.data.datasets.filter((ds, i) => !ds.reference && !ds.favoriteMarker
      && ds.type !== 'scatter' && chart.isDatasetVisible(i)) : [];
  },
  visibleDamageConfig(chart) {
    const rows = this.visibleDamageRows(chart);
    return rows.length === 1 ? rows[0].damageConfig || null : null;
  },
  survival(result) {
    return result && Number.isFinite(result.hp) && result.hp > 0 && Number.isFinite(result.damage) && result.damage >= 0
      ? result.damage >= result.hp ? 'kill' : 'survive' : 'neutral';
  },
  attackLevel(context, data, math) {
    return math.normalizeLevel(context.attackerLevel ?? data.getPetLevel(context.atkPet));
  },
  operatingPoint(context, pet, values, data, math) {
    if (!context?.atkPet || !pet || !values) return null;
    const atk = context.attackType, def = atk === 'magic_attack' ? 'magic_defense' : 'defense';
    const hp = data.getPetStat(pet, 'hp', (values.hpNature ?? context.hpNature) ? 1 : 0, true);
    const defense = data.getPetStat(pet, def, values.defNature, values.defIV);
    const effect = data.getTypeEff(context.skillAttr, pet.main_type?.name || '', pet.sub_type?.name || '');
    const level = this.attackLevel(context, data, math);
    // Curve-owned IV/nature, but the damage card's effective attacker level.
    // Use the raw base directly: RKData's generic stat API intentionally ignores
    // overrides for ordinary species, which may have a battle-snapshot level here.
    // A tiny legacy adapter without raw bases may still supply its own stat API.
    const attack = context.mode === 'defense'
      ? typeof data.getBaseStat === 'function'
        ? math.statFromBase(data.getBaseStat(context.atkPet, atk), atk, values.atkNature, values.atkIV, level)
        : data.getPetStat(context.atkPet, atk, values.atkNature, values.atkIV, level)
      : math.statFromBase(context.qualification, atk, values.atkNature, values.atkIV, level);
    // Effect scope is unchanged: defense uses skill/buff/combo; the attack sweep
    // uses standalone power + same-type. No reduction, starMeteor or manual final.
    const power = context.mode === 'defense'
      ? math.finalPower(context.basePower, context.fixedBonus, context.percentBonus, context.sameType, 1, context.buff)
      : math.finalPower(context.power, 0, 0, context.sameType);
    const damage = math.normalDamage(attack, power, defense, 1, context.mode === 'defense' ? context.comboCount : 1, level, effect);
    return { hp, damage, defense, effect, attack, power, level };
  },
  curveConfigurations(selected, showAll = false) {
    const values = { ...selected, atkNature: selected.atkIV && selected.atkNature === 1 ? 1 : 0, defNature: 0 };
    if (!showAll || !(values.atkIV && values.atkNature === 1 && values.defIV && values.hpNature)) return [values];
    return [[false, 0], [true, 0], [true, 1]].flatMap(([atkIV, atkNature]) =>
      [false, true].flatMap(defIV => [false, true].map(hpNature => ({ atkIV, atkNature, defIV, defNature: 0, hpNature }))));
  },
  tooltipLines(context, pet, rows, data, math) {
    if (!context || !pet) return [];
    const flag = value => value ? '✓' : '×';
    return rows.flatMap(row => {
      const v = row.damageConfig;
      if (!v) return [];
      const r = this.operatingPoint(context, pet, v, data, math);
      const hpNature = v.hpNature ?? context.hpNature;
      const ratio = r.hp > 0 ? (r.damage / r.hp * 100).toFixed(2) : '—';
      const last = `⑥ 伤害占比 = ${r.damage} ÷ ${r.hp} (✓个体&${flag(hpNature)}性格) = ${ratio}%`;
      // Visible rows retain legend order; hidden rows never contribute a summary.
      if (rows.length !== 1) return [last];
      const defenseMode = context.mode === 'defense', combo = defenseMode ? context.comboCount : 1;
      const raw = defenseMode ? context.basePower : context.power;
      const fixed = defenseMode ? context.fixedBonus : 0, percent = defenseMode ? context.percentBonus : 0;
      const buff = defenseMode ? context.buff : 0, base = math.basePower(raw, fixed, percent);
      const name = p => data.getMonsterDisplayName?.(p) || p.localized?.zh?.name || p.name || '精灵';
      const attrZh = data.getTypeZh?.(context.skillAttr) || context.skillAttr;
      const attr = data.getTypeZhFull?.(attrZh) || attrZh;
      let baseText = defenseMode && context.basePowerExpression ? context.basePowerExpression : String(raw);
      if (fixed !== 0) baseText += ` + ${fixed}`;
      if (percent !== 0) baseText = `(${baseText}) × ${(1 + percent / 100).toFixed(2)}`;
      if (fixed !== 0 || percent !== 0 || (defenseMode && context.basePowerExpression)) baseText += ` = ${base}`;
      const powerParts = [String(base)];
      if (context.sameType !== 1) powerParts.push(`本系${context.sameType}`);
      if (buff !== 0) powerParts.push(buff > 0 ? `BUFF${math.buffMultiplier(buff).toFixed(2)}` : `BUFF÷${(1 / math.buffMultiplier(buff)).toFixed(2)}`);
      const finalText = powerParts.length > 1 ? `${powerParts.join(' × ')} = ${r.power}` : String(r.power);
      const attackBase = defenseMode ? data.getBaseStat?.(context.atkPet, context.attackType) : context.qualification;
      const nature = v.atkNature === 1 ? 1.2 : v.atkNature === 2 ? 0.9 : 1;
      const attackText = Number.isFinite(attackBase)
        ? `R((R((${r.level} ÷ 100 + 0.5) × (${attackBase} + ${v.atkIV ? 30 : 0})) + 10) × ${nature}) + 50 = ${r.attack}`
        : String(r.attack);
      const factor = `等级系数B[(1000 + 45 × ${r.level}) ÷ 4100]`;
      const damageParts = [`${r.power} × (${r.attack} ÷ ${r.defense})`, factor];
      if (r.effect !== 1) damageParts.push(`克制${r.effect}`);
      // Exact coefficient, floor each hit first, then multiply the hit count.
      const damageText = `⌊${damageParts.join(' × ')}⌋` + (combo !== 1 ? ` × ${combo}连击` : '');
      return [
        `① ${name(context.atkPet)}${context.attackType === 'attack' ? '物攻' : '魔攻'}（Lv${r.level}） = ${attackText} (${flag(v.atkIV)}个体&${flag(v.atkNature === 1)}性格${Number.isFinite(attackBase) ? '；R=四舍五入' : ''})`,
        `② ${name(pet)}${context.attackType === 'attack' ? '物防' : '魔防'} = ${r.defense} (${flag(v.defIV)}个体&×性格)`,
        `③ 技能基础威力 = ${baseText}，技能属性 = ${attr}`,
        `④ 技能最终威力 = ${finalText}`,
        `⑤ 最终伤害 = ${damageText} = ${r.damage}`,
        last
      ];
    });
  },
  contentSize(container, style) {
    const px = value => Number.parseFloat(value) || 0;
    // client dimensions are layout CSS pixels, not CSS-zoom visual pixels.
    return {
      width: Math.max(0, container.clientWidth - px(style.paddingLeft) - px(style.paddingRight)),
      height: Math.max(0, container.clientHeight - px(style.paddingTop) - px(style.paddingBottom))
    };
  },
  pointerPosition(chart, event) {
    const native = event?.native || event;
    const point = native?.touches?.[0] || native?.changedTouches?.[0] || native;
    const rect = chart.canvas?.getBoundingClientRect();
    if (!rect?.width || !rect?.height || !Number.isFinite(point?.clientX) || !Number.isFinite(point?.clientY)) return null;
    // Chart.js offsetX/Y are visual pixels under CSS zoom; data/PointElements use layout pixels.
    return { x: (point.clientX - rect.left) * chart.width / rect.width,
      y: (point.clientY - rect.top) * chart.height / rect.height };
  },
  configuration(entry, state, configs, sharedDefender, pet, resolver) {
    // Compatibility signature only: never inspect damage or personal configuration.
    return { iv: { ...sharedDefender.iv, hp: true }, nature: { ...sharedDefender.nature },
      source: '曲线共用防守方设置' };
  },
  equivalentLife(hp, effect) {
    if (!Number.isFinite(effect) || effect < 0) return { y: null, reason: '属性倍率无效' };
    if (effect === 0) return { y: null, reason: '属性免疫，无法击杀（不绘制无限等效生命）' };
    if (!Number.isFinite(hp) || hp < 0) return { y: null, reason: '目标生命无效' };
    // Continuous neutral reference, not a shortcut through an already-floored hit.
    // Actual survival is always evaluated by normalDamage(..., effectiveness).
    const y = hp / effect;
    return Number.isFinite(y) ? { y } : { y: null, reason: '等效生命超出可绘制范围' };
  },
  defenseMinimum(markers) {
    // Low-defense favorites (e.g. Dragon327 physical 69) keep their real x. Extend
    // reference samples downward on the same 2-point grid, never clamp the marker.
    return Math.floor(Math.min(80, ...markers.filter(m => Number.isFinite(m.y) && Number.isFinite(m.x) && m.x >= 0).map(m => m.x)) / 2) * 2;
  },
  yAxis(maximum, plotHeight) {
    // Actual grid spacing, not a 5–8-label target. Aim for >=24 layout px per
    // interval when possible, but NEVER go outside 10/20/25/50. Tall plots detail up.
    const value = Math.max(1, maximum);
    const height = Number.isFinite(plotHeight) ? Math.max(24, plotHeight) : 24;
    const raw = value * 1.04 / Math.max(1, Math.floor(height / 24));
    let step = value <= 100 ? (raw <= 10 ? 10 : 20) : ([10, 20, 25, 50].find(n => n >= raw) || 50);
    // Hard safety contract: <=501 ticks INCLUDING zero, with 4% display headroom.
    // Try larger permitted steps before guarding. Never clamp data, emit Infinity,
    // silently increase spacing above 50, or ask Chart.js to allocate unsafe ticks.
    if (Math.ceil(value * 1.04 / step) > 500) step = 50;
    const max = Math.ceil(value * 1.04 / step) * step;
    if (!Number.isFinite(maximum) || !Number.isFinite(max) || max / step > 500) return {
      step: 50, max: null, tickCount: 0, guarded: true,
      reason: '纵轴范围过大或无效，已暂停绘图：含4%留白最多501个刻度（含0），间距不超过50。请降低输入；原始伤害和收藏坐标未改动。'
    };
    return { step, max, tickCount: max / step + 1, guarded: false };
  },
  avatarPositions(anchors, area, radius = 16) {
    // Layout pixels only, never change numeric chart data. Bound the candidate grid.
    const gap = radius * 2 + 4, slots = [], placed = [];
    const left = area.left + radius, right = Math.max(left, area.right - radius);
    const top = area.top + radius, bottom = Math.max(top, area.bottom - radius);
    for (let y = top; y <= bottom && slots.length < 4096; y += gap) {
      for (let x = left; x <= right && slots.length < 4096; x += gap) slots.push({ x, y });
    }
    for (const anchor of anchors) {
      const origin = { x: Math.min(right, Math.max(left, anchor.x)), y: Math.min(bottom, Math.max(top, anchor.y)) };
      const free = candidate => placed.every(p => Math.abs(p.x - candidate.x) >= gap || Math.abs(p.y - candidate.y) >= gap);
      let position = origin;
      if (!free(origin)) {
        let distance = Infinity;
        for (const slot of slots) {
          const d = (slot.x - anchor.x) ** 2 + (slot.y - anchor.y) ** 2;
          if (d < distance && free(slot)) { position = slot; distance = d; }
        }
      }
      placed.push({ ...position });
    }
    return placed;
  },
  minimumInteger(hp, damageAt, limit = 1073741824) {
    // Exact step-rounded monotone formula, never a continuous inverse or an axis clamp.
    if (!Number.isFinite(hp) || hp < 0) return { x: null, reason: '目标生命无效' };
    const enough = x => { const damage = damageAt(x); return Number.isFinite(damage) && damage >= hp; };
    if (enough(0)) return { x: 0 };
    let lo = 0, hi = 1;
    while (hi < limit && !enough(hi)) { lo = hi; hi = Math.min(limit, hi * 2); }
    if (!enough(hi)) return { x: null, reason: `在整数搜索上限${limit}内无法击杀` };
    while (lo + 1 < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (enough(mid)) hi = mid; else lo = mid;
    }
    return { x: hi };
  }
});

const ChartPage = (function () {
  const { getBaseStat } = RKData;
  const view = {
    mode: 'defense', axisSwapped: false, sameType: false,
    attackType: 'attack', power: 200, qualification: 120,
    sourceType: null,
    overrides: { atkIV: {}, atkNature: {}, defIV: {} }, hpNature: false,
    hidden: {}, markersVisible: true, showAll: false
  };
  let instance = null;
  let active = false;
  let resizeFrame = null, imageFrame = null, resizeObserver = null;
  let unsubscribeDamageFavorites = null, unsubscribeFavorites = null, favoriteSearch = null, closePresetPicker = null;
  const activePreset = () => !!window.ChartWorkspace?.isPreset(window.ChartWorkspace.getState().activeGroupId);
  let workspaceReady = false, workspaceBusy = false, workspaceError = '', retryWorkspace = null;
  let selectedFavoriteId = null, visibilitySignature = '', entriesError = '';
  const avatarCache = new Map();
  const AVATAR_LIMIT = 64;
  let pageScrollTop = 0;
  const COLORS = ['#11998e', '#e67e22', '#4a90e2', '#8e44ad', '#3d7e1b', '#c0392b', '#9b59b6', '#d35400', '#00838f', '#ad1457', '#546e7a', '#827717'];
  const copy = value => JSON.parse(JSON.stringify(value));
  const damageState = () => DamagePage.getState();
  const getPetName = pet => RKData.getMonsterDisplayName(pet);
  const element = id => document.getElementById(id);

  function fontFamily() { return getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'; }
  function setChartFont() {
    if (typeof Chart !== 'undefined' && Chart.defaults?.font) Chart.defaults.font.family = fontFamily();
  }
  function refreshAppearance() {
    setChartFont();
    if (active) renderChart();
  }

  function chartPalette() {
    const style = getComputedStyle(document.documentElement);
    const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return { text: token('--text-secondary', '#6b7280'), title: token('--text-primary', '#1a1a2e'),
      background: token('--bg-card', '#fff'), border: token('--border', '#e5e7eb'),
      grid: token('--chart-grid', 'rgba(0,0,0,0.1)') };
  }

  function applyWorkspace() {
    const c = window.ChartWorkspace.getState().controls;
    if (JSON.stringify(view.overrides) !== JSON.stringify({ atkIV: c.atkIV, atkNature: c.atkNature, defIV: c.defIV }) || view.hpNature !== c.hpNature) {
      view.hidden = {}; view.showAll = false;
    }
    view.overrides = { atkIV: { ...c.atkIV }, atkNature: { ...c.atkNature }, defIV: { ...c.defIV } };
    view.hpNature = c.hpNature;
  }

  function syncBaseline() {
    // Species/skill changes never reset independently saved curve controls.
    const type = damageState().skillType;
    if (view.sourceType !== type) { view.sourceType = type; view.attackType = type || 'attack'; }
  }

  async function workspaceAction(action) {
    if (workspaceBusy) return;
    workspaceBusy = true; workspaceError = ''; retryWorkspace = action;
    syncWorkspaceStatus();
    try {
      await action(); workspaceReady = true; applyWorkspace(); retryWorkspace = null;
    } catch (error) { workspaceError = error.message || '曲线配置保存失败，请重试'; }
    finally {
      workspaceBusy = false;
      if (active) { renderChart(); syncWorkspaceStatus(); }
    }
  }

  function presetAvailability(id) {
    const store = window.ChartWorkspace;
    if (!store?.isPreset?.(id)) return { disabled: false };
    const preset = store.getPresets().find(p => p.id === id);
    // Older embedded test adapters did not expose availability.
    if (!store.getPresetAvailability) return { disabled: false, label: preset?.name, count: null, reason: '' };
    try { return store.getPresetAvailability(id); }
    catch (error) { return { disabled: true, label: preset?.name, count: null, reason: error.message }; }
  }

  function requirePreset(id) {
    const availability = presetAvailability(id);
    if (availability.disabled) throw new Error(availability.reason || availability.label);
  }

  function presetOverLimit(id, availability) {
    return id === 'preset:Survivors' && Number.isFinite(availability.count) && availability.count > 100;
  }

  function syncPresetButtons() {
    const descriptors = window.ChartWorkspace?.getPresets() || [];
    document.querySelectorAll('#chartPresetPicker [data-preset-id]').forEach(button => {
      const id = button.dataset.presetId, a = presetAvailability(id);
      const overLimit = presetOverLimit(id, a);
      const name = descriptors.find(p => p.id === id)?.name || a.label;
      button.disabled = workspaceBusy || !workspaceReady || !!window.ChartWorkspace?.getStatus().pendingWrite || (!!a.disabled && !overLimit);
      if (!overLimit) delete button.dataset.feedback;
      const text = button.dataset.feedback ? '不可斩杀精灵过多' : name;
      button.title = a.disabled && !overLimit ? a.reason || name : text;
      button.setAttribute('aria-label', text);
      if (button.classList.contains('chart-preset-dynamic')) button.textContent = text;
    });
  }

  function syncWorkspaceStatus() {
    if (!active) return;
    const disabled = workspaceBusy || !workspaceReady || !!window.ChartWorkspace?.getStatus().pendingWrite;
    document.querySelectorAll('#chartControls button, #chartGroupToolbar select, #chartGroupToolbar button, #chartGroupManager input, #chartGroupManager button, #chartGroupManager select')
      .forEach(node => { node.disabled = disabled; });
    const readonly = activePreset();
    for (const id of ['chartGroupRename', 'chartGroupUp', 'chartGroupDown', 'chartGroupDelete', 'chartGroupMove', 'chartGroupMoveTarget', 'chartGroupImport', 'chartGroupImportPreset']) {
      const node = element(id);
      if (node) { node.disabled = disabled || readonly || (['chartGroupImport', 'chartGroupImportPreset'].includes(id) && window.ChartWorkspace?.getState().activeGroupId === 'all'); node.dataset.presetReadonly = String(readonly); }
    }
    const store = window.ChartWorkspace;
    if (store) {
      const copyButton = element('chartGroupCopy'), importButton = element('chartGroupImport');
      if (copyButton) copyButton.disabled = disabled || store.getState().activeGroupId === 'all' || !!presetAvailability(store.getState().activeGroupId).disabled;
      if (importButton) importButton.disabled ||= !!presetAvailability(element('chartGroupImportPreset').value).disabled;
    }
    syncPresetButtons();
    if (favoriteSearch) {
      favoriteSearch.input.disabled = disabled || readonly;
      favoriteSearch.input.placeholder = readonly ? '内置预设只读，可复制为自建分组后添加' : '搜索精灵并加入当前曲线分组';
      if (readonly || disabled) favoriteSearch.dropdown.style.display = 'none';
    }
    const retry = element('chartWorkspaceRetry');
    if (retry) { retry.hidden = !workspaceError; retry.disabled = workspaceBusy; }
    const status = element('chartWorkspaceStatus');
    if (status) status.textContent = workspaceError || (workspaceBusy ? '正在保存曲线配置…' : !workspaceReady ? '正在读取曲线配置…' : '');
  }

  function selectedType() { return view.mode === 'defense' ? damageState().skillType : view.attackType; }
  function defenseType() { return selectedType() === 'magic_attack' ? 'magic_defense' : 'defense'; }
  function baselineValue(field, stat) {
    // Fixed curve defaults, never damage-page IV/nature (including defense nature).
    return field === 'atkIV' ? true : field === 'defIV' ? false : 0;
  }
  function comparisonValue(field, stat) {
    return Object.hasOwn(view.overrides[field], stat) ? view.overrides[field][stat] : baselineValue(field, stat);
  }

  function sharedDefenderConfiguration() {
    return {
      iv: { hp: true, defense: comparisonValue('defIV', 'defense'), magic_defense: comparisonValue('defIV', 'magic_defense') },
      // HP IV is fixed on; only HP positive nature is switchable.
      nature: { hp: view.hpNature ? 1 : 0, defense: 0, magic_defense: 0 }
    };
  }

  function render(container) {
    cleanupFeatures();
    active = true;
    syncBaseline();
    setChartFont();
    container.innerHTML = `<div class="calc-root chart-page scroll-container"><div class="container">
      <div class="card result-card" style="border:none;box-shadow:none;"><div class="card-header">
        <h3><img src="assets/icons/ui/icon_curve.png" alt="伤害曲线" class="title-icon"> <span id="chartTitle"></span></h3>
        <div class="chart-header-right"><button id="chartModeBtn" class="chart-mode-btn" title="切换曲线模式"></button></div>
      </div><div class="card-body" style="padding:20px;">
        <div id="chartPowerControl" class="chart-power-control">
          <label class="chart-control-label" id="chartPowerLabel" for="chartPowerInput">技能威力：</label>
          <input type="number" id="chartPowerInput" min="0" max="600" step="1" value="200" class="chart-power-number">
          <button id="chartSwapAxisBtn" class="chart-control-btn" title="交换横轴与固定数值">⇄</button>
          <button id="chartSameTypeBtn" class="chart-control-btn" title="本系加成×1.25">本系</button>
          <button id="chartAtkTypeBtn" class="chart-control-btn" title="切换物攻/魔攻">物攻</button>
        </div>
        <div class="defense-chart-help" id="chartInfo"></div>
        <div id="chartAxisWarning" role="status" aria-live="polite" hidden></div>
        <div class="chart-container"><canvas id="defenseChart"></canvas></div>
        <div id="chartControls" class="defense-chart-controls">
          <div class="chart-control-group" role="group" aria-label="攻击方设置">
            <span class="chart-control-label">攻击方：</span>
            <button id="chartAtkIVBtn" class="chart-control-btn">个体</button>
            <button id="chartAtkNatureBtn" class="chart-control-btn" title="切换攻击正性格（开启时同时开启攻击个体）">性格</button>
          </div>
          <div class="chart-control-group" role="group" aria-label="防守方设置">
            <span class="chart-control-label">防守方：</span>
            <button id="chartIVBtn" class="chart-control-btn">防御个体</button>
            <button id="chartDoubleLifeBtn" class="chart-control-btn" title="仅切换生命正性格；生命个体固定开启">生命性格</button>
            <button id="chartAllBtn" class="chart-control-btn chart-all-toggle" title="展开12种配置选项，初始仅显示当前曲线；关闭后返回单线" aria-pressed="false" hidden>all</button>
          </div>
        </div>
        <section class="chart-favorites" aria-label="曲线收藏">
          <div class="chart-favorites-toolbar">
            <div id="chartFavoriteSearch"></div>
            <button type="button" id="chartFavoriteToggle" aria-label="隐藏图上头像标注"></button>
          </div>
          <div id="chartGroupToolbar" class="chart-group-toolbar">
            <label for="chartGroupSelect">分组</label><select id="chartGroupSelect" aria-label="查看曲线收藏分组"></select>
            <button type="button" id="chartGroupManage" aria-expanded="false" aria-controls="chartGroupManager">管理分组</button>
            <button type="button" id="chartGroupPresets" aria-haspopup="dialog" aria-expanded="false" aria-controls="chartPresetPicker">预设分组</button>
          </div>
          <div id="chartGroupManager" class="chart-group-manager" hidden>
            <div class="chart-group-actions">
              <input id="chartGroupName" maxlength="80" aria-label="分组名称" placeholder="分组名称">
              <button type="button" id="chartGroupCreate">新建</button>
              <button type="button" id="chartGroupRename">重命名</button>
              <button type="button" id="chartGroupCopy" title="复制成员列表，仍共用一套配置，全部组不重复头像">复制组</button>
              <select id="chartGroupImportPreset" aria-label="选择要导入的内置预设"></select>
              <button type="button" id="chartGroupImport" title="追加当前预设成员快照，保留原成员并去重">导入预设</button>
              <button type="button" id="chartGroupUp" aria-label="分组上移">↑</button>
              <button type="button" id="chartGroupDown" aria-label="分组下移">↓</button>
              <button type="button" id="chartGroupDelete">删除组</button>
            </div>
            <div class="chart-group-actions">
              <span id="chartGroupSelected">点击头像选择要移动的精灵</span>
              <select id="chartGroupMoveTarget" aria-label="移动到分组"></select>
              <button type="button" id="chartGroupMove">移动</button>
            </div>
          </div>
          <div id="chartWorkspaceStatus" role="status" aria-live="polite"></div>
          <button type="button" id="chartWorkspaceRetry" hidden>重试保存</button>
          <div id="chartFavoriteGrid" class="chart-favorites-grid quick-pet-grid"></div>
          <div id="chartFavoriteStatus" class="chart-favorites-status" role="status" aria-live="polite"></div>
        </section>
      </div></div>
    </div></div>`;
    bindEvents();
    bindFeatures();
    renderChart();
    const scroller = container.querySelector('.chart-page');
    if (scroller) scroller.scrollTop = pageScrollTop;
  }

  const IV_CONTROLS = [
    ['chartAtkIVBtn', 'atkIV', () => selectedType()],
    ['chartIVBtn', 'defIV', () => defenseType()]
  ];
  const NATURE_CONTROLS = [
    ['chartAtkNatureBtn', 'atkNature', () => selectedType()]
  ];

  function syncControls() {
    const attackMode = view.mode === 'attack';
    element('chartTitle').textContent = attackMode ? '防御-伤害曲线' : '伤害-防御曲线';
    element('chartModeBtn').textContent = attackMode ? '切换：伤害-防御' : '切换：防御-伤害';
    element('chartModeBtn').classList.toggle('active', attackMode);
    element('chartPowerControl').style.display = attackMode ? 'flex' : 'none';
    element('chartPowerLabel').textContent = view.axisSwapped ? '攻击资质：' : '技能威力：';
    const input = element('chartPowerInput');
    input.min = view.axisSwapped ? 80 : 0;
    input.max = view.axisSwapped ? 200 : 600;
    input.step = view.axisSwapped ? 2 : 1;
    input.value = view.axisSwapped ? view.qualification : view.power;
    element('chartSwapAxisBtn').classList.toggle('active-iv', view.axisSwapped);
    element('chartSameTypeBtn').classList.toggle('active-iv', view.sameType);
    element('chartAtkTypeBtn').textContent = view.attackType === 'magic_attack' ? '魔攻' : '物攻';
    element('chartAtkTypeBtn').classList.toggle('active-iv', view.attackType === 'magic_attack');
    for (const [id, field, stat] of IV_CONTROLS) {
      const enabled = comparisonValue(field, stat());
      element(id).classList.toggle('active-iv', enabled);
      element(id).setAttribute('aria-pressed', String(enabled));
    }
    for (const [id, field, stat] of NATURE_CONTROLS) {
      const nature = comparisonValue(field, stat());
      const button = element(id);
      button.dataset.nature = String(nature);
      button.textContent = nature === 1 ? '性格+' : '性格';
      button.classList.toggle('active-positive', nature === 1);
      button.setAttribute('aria-pressed', String(nature === 1));
    }
    element('chartIVBtn').title = `切换${defenseType() === 'defense' ? '物防' : '魔防'}个体（原曲线与曲线收藏共用）`;
    element('chartDoubleLifeBtn').classList.toggle('active-positive', view.hpNature);
    element('chartDoubleLifeBtn').setAttribute('aria-pressed', String(view.hpNature));
    const eligible = allControlsEnabled();
    if (!eligible && view.showAll) { view.showAll = false; view.hidden = {}; }
    const allButton = element('chartAllBtn');
    allButton.hidden = !eligible;
    allButton.classList.toggle('active-iv', view.showAll);
    allButton.setAttribute('aria-pressed', String(view.showAll));
  }

  function bindEvents() {
    element('chartModeBtn').addEventListener('click', () => { view.mode = view.mode === 'attack' ? 'defense' : 'attack'; renderChart(); });
    element('chartSwapAxisBtn').addEventListener('click', () => { view.axisSwapped = !view.axisSwapped; renderChart(); });
    const input = element('chartPowerInput');
    input.addEventListener('input', () => {
      if (!input.value.trim() || !Number.isFinite(Number(input.value))) return;
      const min = view.axisSwapped ? 80 : 0, max = view.axisSwapped ? 200 : 600;
      const value = Math.max(min, Math.min(max, Math.trunc(Number(input.value))));
      view[view.axisSwapped ? 'qualification' : 'power'] = value;
      renderChart();
    });
    input.addEventListener('change', () => syncControls());
    element('chartSameTypeBtn').addEventListener('click', () => { view.sameType = !view.sameType; renderChart(); });
    element('chartAtkTypeBtn').addEventListener('click', () => { view.attackType = view.attackType === 'attack' ? 'magic_attack' : 'attack'; renderChart(); });
    for (const [id, field, stat] of IV_CONTROLS) {
      element(id).addEventListener('click', () => {
        const key = stat(), value = !comparisonValue(field, key);
        workspaceAction(() => window.ChartWorkspace.setControls({ [field]: { [key]: value } }));
      });
    }
    for (const [id, field, stat] of NATURE_CONTROLS) {
      const change = value => {
        const key = stat(), next = comparisonValue(field, key) === value ? 0 : value;
        workspaceAction(() => window.ChartWorkspace.setControls({ [field]: { [key]: next } }));
      };
      element(id).addEventListener('click', () => change(1));
      element(id).addEventListener('contextmenu', event => { event.preventDefault(); });
    }
    element('chartDoubleLifeBtn').addEventListener('click', () => {
      const next = !view.hpNature;
      workspaceAction(() => window.ChartWorkspace.setControls({ hpNature: next }));
    });
    element('chartDoubleLifeBtn').addEventListener('contextmenu', event => event.preventDefault());
    element('chartAllBtn').addEventListener('click', () => {
      if (!workspaceReady || workspaceBusy || !allControlsEnabled()) return;
      view.showAll = !view.showAll; view.hidden = {};
      renderChart();
    });
  }

  function allControlsEnabled() {
    const values = selectedValues();
    return values.atkIV && values.atkNature === 1 && values.defIV && values.hpNature;
  }

  function selectedValues() {
    return { atkIV: comparisonValue('atkIV', selectedType()), atkNature: comparisonValue('atkNature', selectedType()),
      defIV: comparisonValue('defIV', defenseType()), defNature: 0, hpNature: view.hpNature };
  }

  function currentAttackLevel(s) {
    // Read only the effective level, not damage-page IV/nature or computed stats.
    // The engine owns native level controls, wolf modes and temporary snapshots.
    const level = typeof DamagePage.CalcEngine?.effectiveLevel === 'function'
      ? DamagePage.CalcEngine.effectiveLevel('attacker') : RKData.getPetLevel(s.atkPet);
    return BattleMath.normalizeLevel(level);
  }

  function operatingContext(s) {
    if (!s.atkPet || !s.defPet || !s.skillAttr || !['attack', 'magic_attack'].includes(selectedType())) return null;
    return { mode: view.mode, atkPet: s.atkPet, attackerLevel: currentAttackLevel(s), skillAttr: s.skillAttr, attackType: selectedType(), hpNature: view.hpNature,
      qualification: view.qualification, power: view.power, basePower: s.basePower, basePowerExpression: s.basePowerExpression, fixedBonus: s.fixedBonus,
      percentBonus: s.percentBonus, buff: s.buff, comboCount: s.comboCount,
      sameType: (view.mode === 'defense' ? DamagePage.CalcEngine.isSameType(s.atkPet, s.skillAttr) : view.sameType) ? 1.25 : 1 };
  }

  function survivalContext() {
    const context = operatingContext(damageState()), values = selectedValues();
    return context ? pet => ChartFavoriteMath.operatingPoint(context, pet, values, RKData, BattleMath) : null;
  }

  function currentEntries() {
    entriesError = '';
    if (!workspaceReady || !window.ChartWorkspace) return [];
    try { requirePreset(window.ChartWorkspace.getState?.().activeGroupId); return window.ChartWorkspace.getEntries(); }
    catch (error) { entriesError = error.message; return []; }
  }

  function variants() {
    return ChartFavoriteMath.curveConfigurations(selectedValues(), view.showAll).map(values => ({
      key: [values.atkIV, values.atkNature, values.defIV, values.hpNature].join(':'), values,
      selected: ChartFavoriteMath.selectedValuesMatch(values, selectedValues()),
      label: `攻：${CommonUI.enabledText(values.atkIV, '个体')}&${CommonUI.enabledText(values.atkNature === 1, '性格')} / 防：${CommonUI.enabledText(values.defIV, '个体')}&${CommonUI.enabledText(values.hpNature, '生命性格')}`
    }));
  }

  function renderChart() {
    const canvas = element('defenseChart');
    if (!active || !canvas) return;
    syncBaseline();
    syncControls();
    const s = damageState();
    window.ChartWorkspace?.setSurvivalContextProvider?.(survivalContext);
    renderFavorites(s, false);
    if (!s.atkPet || !s.defPet) {
      element('chartInfo').textContent = '请在「伤害计算」页面设置精灵和技能，然后回到此页面查看曲线';
      if (instance) instance.destroy();
      instance = null;
      return;
    }
    if (view.mode === 'defense') renderDefenseChart(canvas, s);
    else renderAttackChart(canvas, s);
  }

  function renderDefenseChart(canvas, s) {
    const minimum = ChartFavoriteMath.defenseMinimum(favoriteMarkers(s));
    const labels = Array.from({ length: (200 - minimum) / 2 + 1 }, (_, i) => minimum + i * 2);
    const atkStat = s.skillType, defStat = defenseType(), level = currentAttackLevel(s);
    const sameType = DamagePage.CalcEngine.isSameType(s.atkPet, s.skillAttr) ? 1.25 : 1;
    const power = BattleMath.finalPower(s.basePower, s.fixedBonus, s.percentBonus, sameType, 1, s.buff);
    // Deliberately exclude reduction, defenseMod, starMeteor and finalPowerManual.
    const rows = variants().map(row => ({ ...row, data: labels.map(base => {
      const attack = BattleMath.statFromBase(getBaseStat(s.atkPet, atkStat), atkStat, row.values.atkNature, row.values.atkIV, level);
      const defense = BattleMath.statFromBase(base, defStat, row.values.defNature, row.values.defIV, RKData.getPetLevel(s.defPet));
      return BattleMath.normalDamage(attack, power, defense, 1, s.comboCount, level);
    }) }));
    element('chartInfo').textContent = `攻击方：${getPetName(s.atkPet)}（Lv${level}） | 技能属性：${s.skillAttr} | 最终威力：${power} | 连击数：${s.comboCount} | 本系×${sameType}`;
    draw(canvas, labels, rows, {
      xTitle: '防御资质', current: getBaseStat(s.defPet, defStat), step: 5
    });
  }

  function renderAttackChart(canvas, s) {
    const labels = view.axisSwapped
      ? Array.from({ length: 101 }, (_, i) => i * 6)
      : Array.from({ length: 61 }, (_, i) => 80 + i * 2);
    const atkStat = view.attackType, defStat = defenseType(), level = currentAttackLevel(s);
    const sameType = view.sameType ? 1.25 : 1;
    const effect = RKData.getTypeEff(s.skillAttr, s.defPet.main_type?.name || '', s.defPet.sub_type?.name || '');
    const sharedDefender = sharedDefenderConfiguration();
    const hp = RKData.getPetStat(s.defPet, 'hp', sharedDefender.nature.hp, sharedDefender.iv.hp);
    const rows = variants().map(row => ({ ...row, data: labels.map(x => {
      const attackBase = view.axisSwapped ? view.qualification : x;
      const rawPower = view.axisSwapped ? x : view.power;
      const attack = BattleMath.statFromBase(attackBase, atkStat, row.values.atkNature, row.values.atkIV, level);
      const defense = RKData.getPetStat(s.defPet, defStat, row.values.defNature, row.values.defIV);
      // Standalone power remains independent; include type before the sole damage floor.
      const power = BattleMath.finalPower(rawPower, 0, 0, sameType);
      return BattleMath.normalDamage(attack, power, defense, 1, 1, level, effect);
    }) }));
    element('chartInfo').textContent = `防守方：${getPetName(s.defPet)} | ${defStat === 'defense' ? '物防' : '魔防'}资质：${getBaseStat(s.defPet, defStat)} | 参考生命：${hp} | ${view.axisSwapped ? '攻击资质' : '技能威力'}：${view.axisSwapped ? view.qualification : view.power} | ${atkStat === 'attack' ? '物攻' : '魔攻'} | 本系×${sameType} | 攻击方等级：Lv${level} | 当前判定点：资质${view.qualification} / 威力${view.power}`;
    draw(canvas, labels, rows, {
      xTitle: view.axisSwapped ? '技能威力' : '攻击资质',
      current: view.axisSwapped ? view.power : view.qualification,
      step: view.axisSwapped ? 60 : 5, targetHP: hp,
      crossingPrefix: view.axisSwapped ? '威力:' : '资质'
    });
  }

  function draw(canvas, labels, rows, options) {
    const palette = chartPalette();
    const signature = JSON.stringify([view.mode, selectedType(), selectedValues(), view.axisSwapped, view.showAll]);
    if (signature !== visibilitySignature) { view.hidden = {}; visibilitySignature = signature; }
    const context = operatingContext(damageState());
    const datasets = rows.map((row, index) => {
      const color = COLORS[index % COLORS.length];
      const key = `${view.mode}:${selectedType()}:${row.key}`;
      return {
        label: row.label, shortLabel: `曲线${index + 1}`, data: row.data, viewKey: key, damageConfig: { ...row.values },
        // ALL exposes the other configurations in the legend, not on the plot.
        // Explicit legend choices (including hiding the selected line) win on redraw.
        hidden: view.hidden[key] ?? (view.showAll && !row.selected),
        borderColor: color, backgroundColor: color, borderWidth: 2,
        tension: 0.2, cubicInterpolationMode: 'monotone', fill: false,
        pointRadius: context => options.current != null && Math.abs(Number(labels[context.dataIndex]) - options.current) <= 3 ? 6 : 2,
        pointBackgroundColor: context => options.current != null && Math.abs(Number(labels[context.dataIndex]) - options.current) <= 3 ? '#e43316' : color
      };
    });
    const maxDamage = Math.max(...rows.flatMap(row => row.data));
    if (options.targetHP != null && maxDamage >= options.targetHP) datasets.push({
      label: `斩杀线(${options.targetHP})`, reference: true, viewKey: `${view.mode}:reference`,
      hidden: view.hidden[`${view.mode}:reference`] ?? false,
      data: labels.map(() => options.targetHP), borderColor: '#e43316', backgroundColor: 'transparent',
      borderWidth: 1.5, borderDash: [6, 4], tension: 0, fill: false, pointRadius: 0, pointHoverRadius: 0
    });
    const markers = favoriteMarkers(damageState());
    const inRange = markers.filter(marker => marker.x !== null && Number.isFinite(marker.y) && marker.x >= labels[0] && marker.x <= labels.at(-1));
    pruneAvatars(inRange);
    const images = inRange.map(marker => cachedAvatar(marker.pet));
    if (inRange.length) datasets.push({
      type: 'scatter', label: '收藏头像', favoriteMarker: true, viewKey: 'favorites',
      data: inRange, hidden: !view.markersVisible, showLine: false,
      // Chart.js owns hit testing; the plugin moves only rendered PointElements.
      pointRadius: 16, pointHoverRadius: 16, pointHitRadius: 0,
      pointStyle: 'circle', backgroundColor: 'transparent', borderColor: 'transparent', borderWidth: 0,
      order: -10
    });
    const axisMaximum = Math.max(maxDamage, ...inRange.map(marker => marker.y));
    const axis = ChartFavoriteMath.yAxis(axisMaximum,
      ChartFavoriteMath.contentSize(canvas.parentElement, getComputedStyle(canvas.parentElement)).height - 80);
    if (instance) instance.destroy();
    instance = null;
    const warning = element('chartAxisWarning');
    warning.textContent = axis.guarded ? axis.reason : '';
    warning.hidden = !axis.guarded;
    canvas.hidden = axis.guarded;
    if (axis.guarded) return; // No Chart.js tick allocation; source math/data stay intact.
    instance = new Chart(canvas.getContext('2d'), {
      type: 'line', data: { labels, datasets },
      plugins: [favoriteAvatarPlugin(images, palette, context), ...(options.targetHP == null ? [] : [{ id: 'killLabel', afterDatasetsDraw(chart) {
        if (maxDamage < options.targetHP) return;
        const visible = chart.data.datasets.map((ds, i) => ({ ds, meta: chart.getDatasetMeta(i) }))
          .filter(({ ds, meta }) => !ds.reference && !ds.favoriteMarker && !meta.hidden);
        if (!visible.length || visible.length > 3) return;
        for (const { ds, meta } of visible) {
          const index = ds.data.findIndex(value => value >= options.targetHP);
          const point = meta.data[index];
          if (!point) continue;
          const c = chart.ctx;
          c.save(); c.font = `bold 12px ${fontFamily()}`; c.fillStyle = ds.borderColor;
          c.strokeStyle = palette.background; c.lineWidth = 3; c.textAlign = 'center';
          const text = `${options.crossingPrefix}${labels[index]}`;
          c.strokeText(text, point.x, point.y - 12); c.fillText(text, point.x, point.y - 12);
          c.beginPath(); c.arc(point.x, point.y, 5, 0, Math.PI * 2); c.fill(); c.restore();
        }
      }}])],
      options: {
        responsive: false, maintainAspectRatio: false, animation: false, color: palette.text, interaction: { mode: 'nearest', intersect: false },
        plugins: {
          legend: { display: true, position: 'top', labels: { color: palette.text, font: { size: 13 }, filter: item => !datasets[item.datasetIndex].favoriteMarker },
            onClick(event, item, legend) {
              const chart = legend.chart, index = item.datasetIndex;
              const hidden = chart.isDatasetVisible(index);
              view.hidden[chart.data.datasets[index].viewKey] = hidden;
              chart.setDatasetVisibility(index, !hidden); chart.update();
            }
          },
          tooltip: { backgroundColor: palette.background, titleColor: palette.title, bodyColor: palette.text,
            borderColor: palette.border, borderWidth: 1, filter: item => !item.dataset.reference, callbacks: {
            title: context => context[0]?.dataset.favoriteMarker ? context[0].raw.name : `${options.xTitle}: ${context[0]?.parsed.x}`,
            label: context => context.dataset.favoriteMarker ? markerTooltip(context.raw) : `${context.dataset.label}: ${context.parsed.y}`
          } }
        },
        scales: {
          x: { type: 'linear', min: labels[0], max: labels.at(-1), title: { display: true, text: options.xTitle, color: palette.title, font: { size: 14, weight: 'bold' } },
            ticks: { stepSize: options.step, color: palette.text }, grid: { color: palette.grid }, border: { color: palette.border } },
          y: { title: { display: true, text: view.mode === 'defense' ? '参考伤害 / 等效生命（头像）' : '造成的伤害', color: palette.title, font: { size: 14, weight: 'bold' } },
            max: axis.max,
            min: 0, beginAtZero: true,
            ticks: { stepSize: axis.step, autoSkip: false, color: palette.text,
              // Blank crowded LABELS only. Keep every actual tick/grid line at stepSize.
              callback(value, index, ticks) {
                const every = Math.max(1, Math.ceil((ticks.length - 1) / Math.max(1, Math.floor(this.height / 24))));
                return index % every === 0 || index === ticks.length - 1 ? value : '';
              }
            }, grid: { color: palette.grid }, border: { color: palette.border } }
        }
      }
    });
    instance.$axisMaximum = axisMaximum;
    resizeChart();
    scheduleResize();
  }

  function favoriteAvatarPlugin(images, palette, context) {
    const border = marker => marker.survival === 'kill' ? '#dc2626' : marker.survival === 'survive' ? '#16a34a' : palette.border;
    function applySurvival(chart) {
      const values = ChartFavoriteMath.visibleDamageConfig(chart);
      const resultFor = pet => values ? ChartFavoriteMath.operatingPoint(context, pet, values, RKData, BattleMath) : null;
      for (const ds of chart.data.datasets) if (ds.favoriteMarker) for (const marker of ds.data) {
        marker.visibleResult = resultFor(marker.pet);
        marker.survival = ChartFavoriteMath.survival(marker.visibleResult);
      }
      document.querySelectorAll('#chartFavoriteGrid [data-chart-favorite]').forEach(node => {
        const pet = RKData.getMonsterById(Number(node.dataset.chartFavorite));
        node.dataset.survival = ChartFavoriteMath.survival(resultFor(pet));
        node.title = pet ? [getPetName(pet), ...ChartFavoriteMath.tooltipLines(context, pet,
          ChartFavoriteMath.visibleDamageRows(chart), RKData, BattleMath)].join('\n') : `精灵 #${node.dataset.chartFavorite}（资料不存在）`;
        node.setAttribute('aria-label', node.title);
      });
    }
    return {
      id: 'favoriteAvatars',
      beforeEvent(chart, args) {
        const position = ChartFavoriteMath.pointerPosition(chart, args.event);
        if (!position) return;
        Object.assign(args.event, position);
        args.inChartArea = chart.isPointInArea(args.event);
      },
      afterUpdate(chart) {
        applySurvival(chart);
        const index = chart.data.datasets.findIndex(ds => ds.favoriteMarker);
        if (index < 0) return;
        const meta = chart.getDatasetMeta(index), markers = chart.data.datasets[index].data;
        const anchors = markers.map(m => ({ x: chart.scales.x.getPixelForValue(m.x), y: chart.scales.y.getPixelForValue(m.y) }));
        const positions = ChartFavoriteMath.avatarPositions(anchors, chart.chartArea);
        // Displaced x pixels may no longer be sorted. Disable Chart.js binary-search hit testing.
        meta._sorted = false;
        meta.data.forEach((point, i) => {
          point.x = positions[i].x; point.y = positions[i].y;
          point.$favoriteAnchor = anchors[i];
        });
      },
      afterDatasetsDraw(chart) {
        const index = chart.data.datasets.findIndex(ds => ds.favoriteMarker);
        if (index < 0 || !chart.isDatasetVisible(index)) return;
        const meta = chart.getDatasetMeta(index), markers = chart.data.datasets[index].data, c = chart.ctx;
        c.save();
        // Draw all leaders first so no later leader can obscure another avatar.
        meta.data.forEach((point, i) => {
          const anchor = point.$favoriteAnchor;
          if (!anchor || (anchor.x === point.x && anchor.y === point.y)) return;
          c.strokeStyle = border(markers[i]); c.fillStyle = border(markers[i]); c.lineWidth = 1;
          c.beginPath(); c.moveTo(anchor.x, anchor.y); c.lineTo(point.x, point.y); c.stroke();
          c.beginPath(); c.arc(anchor.x, anchor.y, 2, 0, Math.PI * 2); c.fill();
        });
        meta.data.forEach((point, i) => {
          c.save(); c.beginPath(); c.arc(point.x, point.y, 15, 0, Math.PI * 2);
          c.fillStyle = palette.background; c.fill();
          c.strokeStyle = border(markers[i]); c.lineWidth = 2; c.stroke();
          c.beginPath(); c.arc(point.x, point.y, 14, 0, Math.PI * 2); c.clip();
          const image = images[i];
          if (image?.complete && image.naturalWidth) c.drawImage(image, point.x - 14, point.y - 14, 28, 28);
          else {
            c.fillStyle = palette.title; c.font = `bold 12px ${fontFamily()}`;
            c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(markers[i].name.charAt(0), point.x, point.y);
          }
          c.restore();
        });
        c.restore();
      }
    };
  }

  function syncWindowLayout() {
    document.querySelector('.chart-page')?.classList.toggle('chart-window-maximized', !!window.AppPreferences?.isMaximized());
  }

  function resizeChart() {
    if (!active) return;
    syncWindowLayout();
    if (!instance) return;
    const container = element('defenseChart')?.parentElement;
    if (!container) return;
    const { width, height } = ChartFavoriteMath.contentSize(container, getComputedStyle(container));
    if (width > 0 && height > 0) {
      instance.resize(width, height);
      const axis = ChartFavoriteMath.yAxis(instance.$axisMaximum, instance.chartArea?.height || height - 80);
      const y = instance.options?.scales?.y;
      if (y && (y.max !== axis.max || y.ticks.stepSize !== axis.step)) {
        y.max = axis.max; y.ticks.stepSize = axis.step;
        instance.update('none');
      }
    }
  }

  function scheduleResize() {
    if (!active || resizeFrame !== null) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = null; resizeChart(); });
  }

  function cleanupFeatures() {
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    if (imageFrame !== null) cancelAnimationFrame(imageFrame);
    resizeFrame = imageFrame = null;
    resizeObserver?.disconnect(); resizeObserver = null;
    closePresetPicker?.(); closePresetPicker = null;
    unsubscribeFavorites?.(); unsubscribeFavorites = null;
    unsubscribeDamageFavorites?.(); unsubscribeDamageFavorites = null;
    favoriteSearch?.destroy(); favoriteSearch = null;
    for (const event of ['resize', 'appzoomchange', 'appwindowstatechange']) window.removeEventListener(event, scheduleResize);
    for (const event of ['appfontchange', 'appthemechange']) window.removeEventListener(event, refreshAppearance);
    for (const image of avatarCache.values()) image.onload = image.onerror = null;
    avatarCache.clear();
  }

  function bindFeatures() {
    syncWindowLayout();
    for (const event of ['resize', 'appzoomchange', 'appwindowstatechange']) window.addEventListener(event, scheduleResize);
    for (const event of ['appfontchange', 'appthemechange']) window.addEventListener(event, refreshAppearance);
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleResize);
      resizeObserver.observe(element('defenseChart').parentElement);
    }
    element('chartFavoriteToggle').addEventListener('click', () => { view.markersVisible = !view.markersVisible; renderChart(); });
    const grid = element('chartFavoriteGrid');
    const removeFavorite = async target => {
      const item = target.closest('[data-chart-favorite]');
      if (!item || !workspaceReady || workspaceBusy || activePreset()) return;
      const id = Number(item.dataset.chartFavorite), focused = item === document.activeElement;
      await workspaceAction(() => window.ChartWorkspace.removePet(id));
      if (active && focused) (grid.querySelector('[data-chart-favorite]') || element('chartFavoriteToggle')).focus();
    };
    grid.addEventListener('click', event => {
      const item = event.target.closest('[data-chart-favorite]');
      if (!item) return;
      selectedFavoriteId = Number(item.dataset.chartFavorite);
      renderFavorites(damageState());
    });
    // Middle click does not mutate favorites; right click removes only the curve species.
    grid.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
    grid.addEventListener('contextmenu', event => {
      event.preventDefault(); removeFavorite(event.target);
    });
    element('defenseChart').addEventListener('contextmenu', event => {
      event.preventDefault();
      if (!instance) return;
      const position = ChartFavoriteMath.pointerPosition(instance, event);
      if (!position) return;
      const normalized = { type: event.type, native: event, ...position };
      const hit = instance.getElementsAtEventForMode(normalized, 'nearest', { intersect: true }, false)
        .find(hit => instance.data.datasets[hit.datasetIndex].favoriteMarker);
      if (!hit) return;
      const marker = instance.data.datasets[hit.datasetIndex].data[hit.index];
      const item = grid.querySelector(`[data-favorite-key="${marker.key}"]`);
      if (item) removeFavorite(item);
    });
    grid.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        const item = event.target.closest('[data-chart-favorite]');
        if (!item) return;
        event.preventDefault(); selectedFavoriteId = Number(item.dataset.chartFavorite);
        renderFavorites(damageState());
        grid.querySelector(`[data-chart-favorite="${selectedFavoriteId}"]`)?.focus();
      } else if (event.key === 'Delete') {
        event.preventDefault(); removeFavorite(event.target);
      }
    });
    const store = window.ChartWorkspace;
    element('chartWorkspaceRetry').addEventListener('click', () => {
      if (window.ChartWorkspace?.getStatus().pendingWrite) workspaceAction(() => window.ChartWorkspace.retry());
      else if (retryWorkspace) workspaceAction(retryWorkspace);
    });
    if (!store) {
      workspaceError = '曲线配置组件未加载（js/chart-workspace.js），未读取伤害页收藏。';
      syncWorkspaceStatus(); return;
    }
    workspaceReady = store.getStatus().initialized;
    if (workspaceReady) applyWorkspace();
    unsubscribeFavorites = store.subscribe(() => {
      if (active) {
        const status = store.getStatus();
        if (status.initialized && !status.pendingWrite && !status.error) { workspaceReady = true; workspaceError = ''; retryWorkspace = null; }
        applyWorkspace(); renderChart();
      }
    });
    unsubscribeDamageFavorites = window.FavoritePets?.subscribe?.(() => { if (active) renderChart(); });
    bindGroups(store);
    favoriteSearch = CommonUI.createSearchBox({
      placeholder: '搜索精灵并加入当前曲线分组', limit: 10,
      onSelect: pet => {
        if (!workspaceReady || workspaceBusy || activePreset()) return;
        const id = Number(pet.id), groupId = store.getState().activeGroupId;
        workspaceAction(() => store.addPet(id, groupId === 'all' ? 'ungrouped' : groupId));
      }
    });
    element('chartFavoriteSearch').appendChild(favoriteSearch.wrapper);
    workspaceAction(() => store.init());
  }

  function openPresetPicker(store) {
    if (closePresetPicker) { closePresetPicker(); return; }
    if (workspaceBusy || !workspaceReady) return;
    const anchor = element('chartGroupPresets'), layer = document.createElement('div');
    layer.id = 'chartPresetPicker'; layer.className = 'bloodline-hdropdown chart-preset-picker';
    layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-label', '自动更新的18属性、不可斩杀及收藏预设分组');
    const selected = store.getState().activeGroupId;
    const presets = store.getPresets().filter(p => p.type);
    for (let i = 0; i < presets.length; i += 6) {
      const row = document.createElement('div'); row.className = 'bloodline-hdropdown-row';
      for (const preset of presets.slice(i, i + 6)) {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'bloodline-hdropdown-item' + (preset.id === selected ? ' active' : '');
        button.dataset.presetId = preset.id; button.title = preset.name;
        button.setAttribute('aria-label', preset.name); button.setAttribute('aria-pressed', String(preset.id === selected));
        const img = document.createElement('img'); img.className = 'bloodline-hdropdown-icon'; img.alt = '';
        img.src = `assets/icons/type/${preset.type.toLowerCase()}.png`; button.appendChild(img);
        button.addEventListener('click', () => { closePresetPicker?.(); workspaceAction(() => { requirePreset(preset.id); return store.selectGroup(preset.id); }); });
        row.appendChild(button);
      }
      layer.appendChild(row);
    }
    const dynamicRow = document.createElement('div'); dynamicRow.className = 'chart-preset-dynamic-row';
    const feedbackTimers = new Map();
    for (const dynamic of store.getPresets().filter(p => !p.type)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'chart-preset-dynamic';
      button.dataset.presetId = dynamic.id; button.textContent = dynamic.name;
      button.setAttribute('aria-pressed', String(dynamic.id === selected));
      button.setAttribute('aria-live', 'polite');
      button.addEventListener('click', () => {
        if (!layer.isConnected || button.disabled || workspaceBusy) return;
        const availability = presetAvailability(dynamic.id);
        if (presetOverLimit(dynamic.id, availability)) {
          clearTimeout(feedbackTimers.get(button));
          button.dataset.feedback = 'over-limit'; syncPresetButtons();
          feedbackTimers.set(button, setTimeout(() => {
            feedbackTimers.delete(button);
            if (!layer.isConnected) return;
            delete button.dataset.feedback; syncPresetButtons();
          }, 2000));
          return; // A limit notice is not a selection or a failed save.
        }
        if (availability.disabled) { syncPresetButtons(); return; }
        closePresetPicker?.(); workspaceAction(() => { requirePreset(dynamic.id); return store.selectGroup(dynamic.id); });
      });
      dynamicRow.appendChild(button);
    }
    layer.appendChild(dynamicRow);
    document.body.appendChild(layer); anchor.setAttribute('aria-expanded', 'true');
    const close = CommonUI.bindAnchoredLayer(anchor, layer, () => {
      const ownedFocus = layer.contains(document.activeElement);
      window.removeEventListener('appfontchange', close); window.removeEventListener('appthemechange', close);
      feedbackTimers.forEach(timer => clearTimeout(timer)); feedbackTimers.clear();
      layer.remove(); closePresetPicker = null; anchor.setAttribute('aria-expanded', 'false');
      if (ownedFocus && anchor.isConnected) anchor.focus();
    });
    closePresetPicker = close;
    window.addEventListener('appfontchange', close); window.addEventListener('appthemechange', close);
    syncPresetButtons();
    const enabledButtons = () => Array.from(layer.querySelectorAll('button')).filter(button => !button.disabled);
    layer.addEventListener('keydown', event => {
      const buttons = enabledButtons(), index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
      else if (event.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length;
      else if (event.key === 'ArrowDown') next = (index + 6) % buttons.length;
      else if (event.key === 'ArrowUp') next = (index + buttons.length - 6) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else if (event.key === 'Tab') { event.preventDefault(); close(); return; }
      else return;
      event.preventDefault(); buttons[next].focus();
    });
    CommonUI.positionAnchoredLayer(anchor, layer);
    const buttons = enabledButtons();
    (buttons.find(button => button.dataset.presetId === selected) || buttons[0])?.focus({ preventScroll: true });
  }

  function bindGroups(store) {
    const selectedGroup = () => store.getState().activeGroupId;
    const name = () => element('chartGroupName').value;
    const withGroup = action => {
      const id = selectedGroup();
      if (id === 'all') { workspaceError = '请先选择一个分组'; syncWorkspaceStatus(); return; }
      workspaceAction(() => action(id));
    };
    element('chartGroupSelect').addEventListener('change', event => {
      const id = event.target.value;
      workspaceAction(() => { requirePreset(id); return store.selectGroup(id); });
    });
    element('chartGroupPresets').addEventListener('click', () => openPresetPicker(store));
    element('chartGroupPresets').addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' && !closePresetPicker) { event.preventDefault(); openPresetPicker(store); }
    });
    element('chartGroupManage').addEventListener('click', () => {
      const manager = element('chartGroupManager'); manager.hidden = !manager.hidden;
      element('chartGroupManage').setAttribute('aria-expanded', String(!manager.hidden)); scheduleResize();
    });
    element('chartGroupCreate').addEventListener('click', () => { const text = name(); workspaceAction(() => store.createGroup(text)); });
    element('chartGroupRename').addEventListener('click', () => { const text = name(); withGroup(id => store.renameGroup(id, text)); });
    element('chartGroupCopy').addEventListener('click', () => {
      const text = name(); withGroup(id => { requirePreset(id); return store.copyGroup(id, text || (store.isPreset(id) ? store.getPreset(id) : store.getState().groups.find(g => g.id === id)).name + ' 副本'); });
    });
    element('chartGroupImportPreset').addEventListener('change', syncWorkspaceStatus);
    element('chartGroupImport').addEventListener('click', () => {
      const presetId = element('chartGroupImportPreset').value;
      withGroup(id => { requirePreset(presetId); return store.importPreset(presetId, id); });
    });
    element('chartGroupUp').addEventListener('click', () => withGroup(id => store.orderGroup(id, -1)));
    element('chartGroupDown').addEventListener('click', () => withGroup(id => store.orderGroup(id, 1)));
    element('chartGroupDelete').addEventListener('click', () => {
      const id = selectedGroup(), group = store.getState().groups.find(g => g.id === id);
      if (!group || id === 'ungrouped') { workspaceError = '请选择可删除的自建分组'; syncWorkspaceStatus(); return; }
      if (window.confirm(`删除“${group.name}”分组？成员将移入未分组，不删除精灵或个人数据。`)) workspaceAction(() => store.deleteGroup(id));
    });
    element('chartGroupMove').addEventListener('click', () => {
      if (!selectedFavoriteId) { workspaceError = '请先点击一个收藏头像'; syncWorkspaceStatus(); return; }
      const id = selectedFavoriteId, target = element('chartGroupMoveTarget').value, source = selectedGroup();
      if (source === 'all') { workspaceError = '请先选择来源分组，再移动成员'; syncWorkspaceStatus(); return; }
      workspaceAction(() => store.movePet(id, target, source));
    });
  }

  function renderGroups(entries) {
    const store = window.ChartWorkspace;
    if (!store) return;
    const state = store.getState(), escape = window.FavoritePets.escapeHTML;
    const select = element('chartGroupSelect');
    const preset = store.isPreset(state.activeGroupId) ? store.getPresets().find(p => p.id === state.activeGroupId) : null;
    const availability = preset ? presetAvailability(preset.id) : null;
    select.innerHTML = '<option value="all">全部组</option>' + state.groups.map(g => `<option value="${escape(g.id)}">${escape(g.name)} (${g.petIds.length})</option>`).join('')
      + (preset ? `<option value="${escape(preset.id)}"${availability.disabled ? ' disabled' : ''}>${escape(availability.label || preset.name)} (${availability.disabled || entriesError ? '不可用' : entries.length}) · 内置</option>` : '');
    select.value = state.activeGroupId;
    const imports = element('chartGroupImportPreset'), importValue = imports.value;
    imports.innerHTML = store.getPresets().map(p => {
      const a = presetAvailability(p.id);
      return `<option value="${escape(p.id)}"${a.disabled ? ' disabled' : ''}>${escape(a.label || p.name)}${a.count != null ? ` (${a.count})` : a.disabled ? '（不可用）' : ''}</option>`;
    }).join('');
    if (store.getPresets().some(p => p.id === importValue)) imports.value = importValue;
    const move = element('chartGroupMoveTarget'), previous = move.value;
    move.innerHTML = state.groups.map(g => `<option value="${escape(g.id)}">${escape(g.name)}</option>`).join('');
    if (state.groups.some(g => g.id === previous)) move.value = previous;
    if (!entries.some(entry => entry.id === selectedFavoriteId)) selectedFavoriteId = null;
    const pet = selectedFavoriteId ? RKData.getMonsterById(selectedFavoriteId) : null;
    element('chartGroupSelected').textContent = preset ? '内置预设自动更新，只读；可复制为自建分组'
      : selectedFavoriteId ? '已选：' + (pet ? getPetName(pet) : '#' + selectedFavoriteId) : '点击头像选择要移动的精灵';
    syncWorkspaceStatus();
  }

  function favoriteMarkers(s) {
    if (!s.atkPet || !s.defPet || !window.ChartWorkspace || !workspaceReady || !operatingContext(s)) return [];
    const atkStat = selectedType(), defStat = defenseType();
    const context = operatingContext(s), values = selectedValues(), level = context.attackerLevel;
    return currentEntries().map(entry => {
      const pet = RKData.getMonsterById(entry.id);
      if (!pet) return { ...entry, pet: null, name: `精灵 #${entry.id}`, x: null, reason: '精灵数据不存在', source: '曲线共用防守方设置' };
      const { hp, defense, effect, damage: currentDamage } = ChartFavoriteMath.operatingPoint(context, pet, values, RKData, BattleMath);
      const marker = { ...entry, pet, name: getPetName(pet), hp, defense, effect, source: '曲线共用防守方设置' };
      const attackNature = comparisonValue('atkNature', atkStat), attackIV = comparisonValue('atkIV', atkStat);
      if (view.mode === 'defense') {
        const sameType = DamagePage.CalcEngine.isSameType(s.atkPet, s.skillAttr) ? 1.25 : 1;
        const power = BattleMath.finalPower(s.basePower, s.fixedBonus, s.percentBonus, sameType, 1, s.buff);
        const attack = BattleMath.statFromBase(getBaseStat(s.atkPet, atkStat), atkStat, attackNature, attackIV, level);
        // Same arithmetic/order and selected effects as the ordinary defense curve.
        const damage = currentDamage;
        const referenceDefense = BattleMath.statFromBase(getBaseStat(pet, defStat), defStat,
          baselineValue('defNature', defStat), comparisonValue('defIV', defStat), RKData.getPetLevel(s.defPet));
        // Reference curve uses the selected target species' default level. A marker
        // can belong to another level; flag differing defense as well as configuration.
        // HP/E is a continuous guide, never a substitute for exact per-hit flooring.
        return { ...marker, x: getBaseStat(pet, defStat), ...ChartFavoriteMath.equivalentLife(hp, effect), damage,
          referenceDefense, referenceDamage: BattleMath.normalDamage(attack, power, referenceDefense, 1, s.comboCount, level),
          referenceRawDamage: BattleMath.normalDamageRaw(attack, power, referenceDefense, 1, level) * s.comboCount,
          defenseMismatch: defense !== referenceDefense };
      }
      const damageAt = x => {
        const attack = BattleMath.statFromBase(view.axisSwapped ? view.qualification : x, atkStat, attackNature, attackIV, level);
        const power = BattleMath.finalPower(view.axisSwapped ? x : view.power, 0, 0, view.sameType ? 1.25 : 1);
        return BattleMath.normalDamage(attack, power, defense, 1, 1, level, effect);
      };
      const result = effect <= 0 || (!view.axisSwapped && view.power <= 0)
        ? { x: null, reason: effect <= 0 ? '属性免疫，无法击杀' : '技能威力为零，无法击杀' }
        : ChartFavoriteMath.minimumInteger(hp, damageAt);
      return { ...marker, ...result, y: hp, damage: currentDamage };
    });
  }

  function markerTooltip(marker) {
    if (!marker.pet) return [marker.reason];
    return ChartFavoriteMath.tooltipLines(operatingContext(damageState()), marker.pet,
      ChartFavoriteMath.visibleDamageRows(instance), RKData, BattleMath);
  }

  function renderFavorites(s, updateLegend = true) {
    const api = window.FavoritePets, grid = element('chartFavoriteGrid');
    const button = element('chartFavoriteToggle');
    const label = view.markersVisible ? '隐藏图上头像标注' : '显示图上头像标注';
    button.title = label; button.setAttribute('aria-label', label);
    button.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false">
      ${view.markersVisible ? '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'
        : '<path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3 3.8M6.4 6.4A21 21 0 0 0 2 12s3.5 7 10 7c1.9 0 3.6-.6 5.1-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'}
    </svg>`;
    button.setAttribute('aria-pressed', String(view.markersVisible));
    if (!api) { element('chartFavoriteStatus').textContent = '收藏组件尚未加载（js/favorites.js）'; return; }
    const markers = favoriteMarkers(s), byKey = new Map(markers.map(marker => [marker.key, marker]));
    const min = view.mode === 'defense' ? ChartFavoriteMath.defenseMinimum(markers) : view.axisSwapped ? 0 : 80;
    const max = view.mode === 'attack' && view.axisSwapped ? 600 : 200;
    const entries = currentEntries();
    renderGroups(entries);
    let notes = 0;
    grid.innerHTML = entries.map(entry => {
      const marker = byKey.get(entry.key), pet = marker?.pet || RKData.getMonsterById(entry.id);
      const name = pet ? getPetName(pet) : `精灵 #${entry.id}`;
      const out = marker && (!Number.isFinite(marker.y) || marker.x === null || marker.x < min || marker.x > max);
      const note = !marker ? '请先设置攻守精灵' : marker.reason
        || (out ? `真实坐标 ${marker.x}，超出横轴 ${min}–${max}` : '');
      if (note) notes++;
      const tooltip = [name, ...(marker ? markerTooltip(marker) : [])].join(String.fromCharCode(10));
      return `<div class="chart-favorites-item quick-pet-item${selectedFavoriteId === entry.id ? ' chart-favorite-selected' : ''}" data-survival="neutral" data-chart-favorite="${entry.id}" data-favorite-key="${entry.key}" data-favorite-note="${api.escapeHTML(note)}" tabindex="0" title="${api.escapeHTML(tooltip)}" aria-label="${api.escapeHTML(tooltip)}">
        <div class="chart-favorites-avatar quick-pet-img-wrapper">
          ${api.avatarUrl(pet) ? api.avatarHTML(pet, name) : `<span class="quick-pet-initial">${api.escapeHTML(name.charAt(0))}</span>`}
        </div>
        <span class="quick-pet-name">${api.escapeHTML(name)}</span>
      </div>`;
    }).join('');
    element('chartFavoriteStatus').textContent = entriesError || (!entries.length ? (activePreset() ? '当前预设没有符合条件的精灵。' : '暂无收藏，可搜索精灵加入。')
      : notes ? `${notes}只精灵暂无可见标注（超出横轴或无法击倒等），悬停头像查看详情。` : '');
    // Rebuilt grid (selection/move focus) must keep current legend colors as well.
    if (updateLegend) instance?.update('none');
  }

  function pruneAvatars(markers) {
    const urls = new Set(markers.map(marker => window.FavoritePets.avatarUrl(marker.pet)));
    for (const [url, image] of avatarCache) if (!urls.has(url)) {
      image.onload = image.onerror = null; avatarCache.delete(url);
    }
  }

  function cachedAvatar(pet) {
    const url = window.FavoritePets?.avatarUrl(pet);
    if (!url || typeof Image === 'undefined') return null;
    if (avatarCache.has(url)) return avatarCache.get(url);
    // Hard cap; extra avatars retain a bordered initial and their full tooltip.
    if (avatarCache.size >= AVATAR_LIMIT) return null;
    const image = new Image(28, 28);
    avatarCache.set(url, image);
    image.onload = () => {
      if (!active || avatarCache.get(url) !== image || imageFrame !== null) return;
      imageFrame = requestAnimationFrame(() => { imageFrame = null; if (active) instance?.update('none'); });
    };
    image.onerror = () => { image.onload = image.onerror = null; };
    image.src = url;
    return image;
  }

  function onLeave() {
    const scroller = document.querySelector('.chart-page');
    if (scroller) pageScrollTop = scroller.scrollTop;
    active = false;
    window.ChartWorkspace?.setSurvivalContextProvider?.(null);
    cleanupFeatures();
    if (instance) instance.destroy();
    instance = null;
  }

  return { render, onLeave, getState: () => copy(view) };
})();
