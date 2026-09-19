/**
 * settings.js — 用户设置页面
 */
const SettingsPage = (function () {
  const PAGE_STYLE = `
    <style>
      .settings-card {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 12px;
        margin-bottom: 16px;
        overflow: hidden;
      }
      .settings-card-header {
        padding: 16px 20px;
        border-bottom: 1px solid var(--border);
        font-size: 1.1em;
        font-weight: 700;
        color: var(--text-primary);
      }
      .settings-card-body { padding: 20px; }
      .settings-row {
        display: flex;
        align-items: flex-start;
        gap: 16px;
        margin-bottom: 20px;
      }
      .settings-row:last-child { margin-bottom: 0; }
      .settings-label {
        flex-shrink: 0;
        width: 180px;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
        padding-top: 8px;
      }
      .settings-desc {
        font-size: 12px;
        color: var(--text-secondary);
        margin-top: 4px;
        font-weight: 400;
      }
      .settings-control { flex: 1; min-width: 0; }
      .settings-speed-control { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
      .settings-speed-modes { display: inline-flex; padding: 3px; gap: 2px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary); }
      .settings-speed-modes button { font: inherit; font-size: 13px; padding: 6px 10px; border: 0; border-radius: 5px; background: transparent; color: var(--text-secondary); cursor: pointer; white-space: nowrap; }
      .settings-speed-modes button[aria-pressed="true"] { background: var(--accent); color: #fff; }
      .settings-speed-modes button:focus-visible, #set-effective-threshold:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .settings-speed-threshold { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; font-size: 13px; }
      .settings-speed-threshold[hidden] { display: none; }
      .settings-speed-threshold input { width: 140px; min-width: 40px; accent-color: var(--accent); }
      .settings-speed-threshold output { min-width: 3ch; font-variant-numeric: tabular-nums; }
      .settings-speed-row { flex-wrap: wrap; }
      .settings-speed-row .settings-control { flex-basis: 280px; }
      .settings-pills {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .settings-pill {
        padding: 4px 20px;
        border-radius: 8px;
        border: 2px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
        user-select: none;
      }
      .settings-pill:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
      .settings-pill.active {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
        box-shadow: 0 2px 8px rgba(0,0,0,0.12);
      }
      .settings-input-group {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .settings-input-group label {
        font-size: 13px;
        color: var(--text-secondary);
        font-weight: 600;
        white-space: nowrap;
      }
      .settings-input-group input[type="number"] {
        width: 70px;
        padding: 6px 10px;
        border: 2px solid var(--border);
        border-radius: 8px;
        font-size: 14px;
        text-align: center;
        color: var(--text-primary);
        background: var(--bg-secondary);
        -moz-appearance: textfield;
      }
      .settings-input-group input[type="number"]::-webkit-inner-spin-button,
      .settings-input-group input[type="number"]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .settings-input-group input[type="number"]:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(108,92,231,0.1);
      }
      .settings-slider-group {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .settings-slider {
        -webkit-appearance: none;
        appearance: none;
        width: 200px;
        height: 6px;
        border-radius: 3px;
        background: var(--border);
        outline: none;
      }
      .settings-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--accent);
        cursor: pointer;
        border: 2px solid #fff;
        box-shadow: 0 1px 4px rgba(0,0,0,0.2);
      }
      .settings-slider::-moz-range-thumb {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--accent);
        cursor: pointer;
        border: 2px solid #fff;
        box-shadow: 0 1px 4px rgba(0,0,0,0.2);
      }
      .settings-route-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 8px;
      }
      .settings-route-item {
        padding: 6px 12px;
        border-radius: 8px;
        border: 2px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font-size: 13px;
        font-weight: 600;
        text-align: center;
        cursor: pointer;
        transition: all 0.2s ease;
        user-select: none;
      }
      .settings-route-item:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
      .settings-route-item.active {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
        box-shadow: 0 2px 8px rgba(0,0,0,0.12);
      }
      .settings-btn-row {
        display: flex;
        justify-content: center;
        gap: 12px;
        margin-top: 24px;
      }
    </style>`;

  const DEFAULT_SETTINGS = {
    close_behavior: 'close',
    window_width: 1280,
    window_height: 800,
    window_maximized: false,
    default_route: 'petdex',
    default_max_zoom: 100,
    effective_include_speed: true,
    effective_speed_mode: 'include',
    effective_speed_threshold: 80,
    hotkey_mods: 0,
    hotkey_vk: 0,
    font_family: ''
  };

  function speedSettings(data) {
    const mode = ['include', 'exclude', 'threshold'].includes(data.effective_speed_mode)
      ? data.effective_speed_mode : data.effective_include_speed === false ? 'exclude' : 'include';
    const raw = data.effective_speed_threshold;
    const number = raw == null || raw === '' ? NaN : Number(raw);
    const threshold = Number.isFinite(number) ? Math.min(120, Math.max(40, Math.round(number))) : 80;
    return { effective_speed_mode: mode, effective_speed_threshold: threshold, effective_include_speed: mode === 'include' };
  }

  let settings = { ...DEFAULT_SETTINGS };
  let loaded = false;
  let dirty = false;
  let revision = 0;
  let saving = false;
  let renderVersion = 0;
  let resultDismissHandler = null, personalResetHandler = null;
  function escapeHtml(value) {
    const node = document.createElement('span');
    node.textContent = value;
    return node.innerHTML;
  }
  let fontFamilies = [];
  let savedFontFamily = '';

  async function applyFontPreview(fontFamily) {
    const result = window.applyAppFont ? await window.applyAppFont(fontFamily || '') : { applied: true };
    const preview = document.getElementById('set-font-preview');
    if (preview && window.getAppFontStack) preview.style.fontFamily = window.getAppFontStack(fontFamily || '');
    return result;
  }

  async function loadFontFamilies() {
    try {
      const res = await fetch('/api/fonts');
      const data = await res.json();
      fontFamilies = Array.isArray(data.fonts) ? data.fonts : [];
    } catch (e) {
      fontFamilies = [];
    }
  }

  // 未保存更改提示
  function markDirty() {
    dirty = true;
    revision++;
    var el = document.getElementById('settings-dirty-hint');
    if (el) el.style.display = 'block';
    // 任何更改后清除"保存成功/已恢复默认"等结果提示
    var r = document.getElementById('settings-result');
    if (r) r.innerHTML = '';
  }
  function clearDirty() {
    dirty = false;
    var el = document.getElementById('settings-dirty-hint');
    if (el) el.style.display = 'none';
  }

  // 生成默认显示屏选项 HTML（仅多显示器时调用）
  function monitorPillsHtml() {
    var n = settings.monitor_count || 1;
    var cur = settings.default_monitor || 0;
    var out = '';
    for (var i = 0; i < n; i++) {
      out += '<span class="settings-pill ' + (cur === i ? 'active' : '') + '" data-val="' + i + '">' + (i === 0 ? '主显示器' : '显示器 ' + (i + 1)) + '</span>';
    }
    return out;
  }

  // 可选路由列表
  const ROUTE_OPTIONS = [
    { value: 'petdex',     label: '精灵图鉴' },
    { value: 'moves',      label: '技能列表' },
    { value: 'types',      label: '克制关系' },
    { value: 'speed',      label: '速度速查' },
    { value: 'team',       label: '组队系统' },
    { value: 'damage',     label: '伤害计算' },
    { value: 'chart',      label: '伤害曲线' },
  ];

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data || typeof data !== 'object' || Array.isArray(data) || data.ok === false) throw new Error('加载共享设置失败');
      Object.assign(settings, data);
      if (settings.default_route === 'game-description') settings.default_route = 'petdex';
      settings.font_family = settings.font_family || '';
      Object.assign(settings, speedSettings(data));
      savedFontFamily = settings.font_family;
      if (window.AppPreferences) settings.default_max_zoom = Math.round(window.AppPreferences.getMaxZoom() * 100);
      applyFontPreview(settings.font_family);
      // 兼容旧版后端：无 monitor_count 字段时按单屏处理
      if (typeof settings.monitor_count !== 'number') settings.monitor_count = 1;
      if (typeof settings.default_monitor !== 'number') settings.default_monitor = 0;
      loaded = true;
    } catch (e) {
      console.error('加载设置失败:', e);
      loaded = true;
    }
  }

  async function saveSettings() {
    if (saving) return false;
    saving = true;
    const proposal = { ...settings, ...speedSettings(settings) };
    const submittedRevision = revision;
    const r = document.getElementById('settings-result');
    const button = document.getElementById('set-save-btn');
    if (button) button.disabled = true;
    if (r) r.textContent = '正在保存...';
    try {
      let data = {};
      if (window.UserConfig?.saveSettings) {
        const ok = await window.UserConfig.saveSettings(proposal);
        if (!ok) throw new Error(window.UserConfig.getStatus?.()?.error || '共享设置保存失败');
        data = window.UserConfig.getSettingsResult?.() || {};
      } else {
        const res = await fetch('/api/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proposal)
        });
        data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || '保存失败');
      }
      // Only accepted writes commit caches/runtime. This setter does NOT enqueue a save.
      let cacheFailed = false;
      const committedZoom = window.AppPreferences
        ? window.AppPreferences.setMaxZoom(proposal.default_max_zoom / 100, false)
        : proposal.default_max_zoom / 100;
      try {
        localStorage.setItem('xwiki-default-route', proposal.default_route);
        localStorage.setItem('xwiki-max-zoom', String(committedZoom));
      } catch (e) { cacheFailed = true; }
      window.AppPreferences?.setEffectiveSpeedPolicy?.(proposal.effective_speed_mode, proposal.effective_speed_threshold);
      savedFontFamily = proposal.font_family || '';
      if (revision === submittedRevision) clearDirty();
      if (r) r.innerHTML = data.hotkey_failed
        ? '<span style="color:var(--danger);">✓ 已保存，但全局快捷键注册失败，请更换组合键后重新保存</span>'
        : cacheFailed ? '<span style="color:var(--warning);">✓ 设置已保存，但本地页面缓存不可写</span>'
        : '<span style="color:var(--success);font-weight:600;">✓ 保存成功！缩放已同步，其他部分设置重启后生效</span>';
      return true;
    } catch (e) {
      if (r) r.textContent = '保存失败：' + e.message;
      if (revision === submittedRevision) {
        settings.font_family = savedFontFamily;
        applyFontPreview(savedFontFamily);
        const select = document.getElementById('set-font');
        if (select) select.value = savedFontFamily;
      }
      return false;
    } finally {
      saving = false;
      if (button) button.disabled = false;
    }
  }

  function bindSpeedSettings() {
    const buttons = document.querySelectorAll('#set-effective-speed [data-speed-mode]');
    const thresholdControl = document.getElementById('set-effective-threshold-control');
    const slider = document.getElementById('set-effective-threshold');
    const value = document.getElementById('set-effective-threshold-value');
    buttons.forEach(button => {
      button.addEventListener('click', () => {
        settings.effective_speed_mode = button.dataset.speedMode;
        settings.effective_include_speed = settings.effective_speed_mode === 'include';
        buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        if (thresholdControl) thresholdControl.hidden = settings.effective_speed_mode !== 'threshold';
        markDirty();
      });
    });
    slider?.addEventListener('input', () => {
      settings.effective_speed_threshold = speedSettings({ effective_speed_threshold: slider.value }).effective_speed_threshold;
      slider.value = settings.effective_speed_threshold;
      if (value) value.textContent = settings.effective_speed_threshold;
      markDirty();
    });
  }

  function buildHtml() {
    return '<div class="calc-root"><div class="scroll-container" style="padding:8px 24px 40px;">'
      + PAGE_STYLE

      // 界面字体
      + '<div class="settings-card">'
      +   '<div class="settings-card-header">界面字体</div>'
      +   '<div class="settings-card-body">'
      +     '<div class="settings-row">'
      +       '<div class="settings-label">当前字体</div>'
      +       '<div class="settings-control" style="min-width:280px;">'
      +         '<select id="set-font" style="width:100%;max-width:420px;padding:8px 10px;border:2px solid var(--border);border-radius:8px;color:var(--text-primary);background:var(--bg-secondary);">'
      +           '<option value="">跟随 Windows 系统默认字体（推荐）</option>'
      +           fontFamilies.map(function(font) { return '<option value="' + escapeHtml(font) + '"' + (settings.font_family === font ? ' selected' : '') + '>' + escapeHtml(font) + '</option>'; }).join('')
      +         '</select>'
      +         '<div id="set-font-preview" style="margin-top:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary);font-family:var(--app-font-family);">字体预览：小黑猫 Wiki · 洛克王国 · ABC abc · 0123456789 · !?（）</div>'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      + '</div>'

      // 关闭行为
      + '<div class="settings-card">'
      +   '<div class="settings-card-header">窗口关闭行为</div>'
      +   '<div class="settings-card-body">'
      +     '<div class="settings-row">'
      +       '<div class="settings-label">关闭窗口时的行为</div>'
      +       '<div class="settings-control">'
      +         '<div class="settings-pills" id="set-close-pills">'
      +           '<span class="settings-pill ' + (settings.close_behavior === 'close' ? 'active' : '') + '" data-val="close">直接关闭</span>'
      +           '<span class="settings-pill ' + (settings.close_behavior === 'minimize' ? 'active' : '') + '" data-val="minimize">最小化到任务栏</span>'
      +         '</div>'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      + '</div>'

      // 窗口大小
      + '<div class="settings-card">'
      +   '<div class="settings-card-header">窗口大小</div>'
      +   '<div class="settings-card-body">'
      +     '<div class="settings-row">'
      +       '<div class="settings-label">默认窗口模式</div>'
      +       '<div class="settings-control">'
      +         '<div class="settings-pills" id="set-max-pills">'
      +           '<span class="settings-pill ' + (!settings.window_maximized ? 'active' : '') + '" data-val="false">窗口化</span>'
      +           '<span class="settings-pill ' + (settings.window_maximized ? 'active' : '') + '" data-val="true">最大化</span>'
      +         '</div>'
      +       '</div>'
      +     '</div>'

      // 默认打开的显示器（仅多显示器时显示）
      // 默认显示屏（仅多显示器时显示）
      + (settings.monitor_count > 1
      ? ('<div class="settings-row">'
      +   '<div class="settings-label">默认显示屏</div>'
      +   '<div class="settings-control">'
      +     '<div class="settings-pills" id="set-monitor-pills">'
      +       monitorPillsHtml()
      +     '</div>'
      +   '</div>'
      + '</div>')
      : '')

      // 最大化时界面缩放（仅默认窗口模式为“最大化”时显示）
      + '<div class="settings-row" id="set-maxzoom-row" style="' + (settings.window_maximized ? '' : 'display:none;') + '">'
      +   '<div class="settings-label">最大化时界面缩放</div>'
      +   '<div class="settings-control">'
      +     '<div class="settings-input-group">'
      +       '<input type="range" class="settings-slider" id="set-zoom-slider" min="50" max="200" step="5" value="' + (settings.default_max_zoom || 100) + '">'
      +       '<input type="number" id="set-zoom" value="' + (settings.default_max_zoom || 100) + '" min="50" max="200" style="width:70px;padding:6px 10px;border:2px solid var(--border);border-radius:8px;font-size:14px;text-align:center;color:var(--text-primary);background:var(--bg-secondary);">'
      +       '<span style="font-size:12px;color:var(--text-muted);">%</span>'
      +     '</div>'
      +   '</div>'
      + '</div>'

      +     '<div class="settings-row" id="set-size-row" style="' + (settings.window_maximized ? 'display:none;' : '') + '">'
      +       '<div class="settings-label">窗口尺寸</div>'
      +       '<div class="settings-control">'
      +         '<div style="margin-bottom:10px;">'
      +           '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--text-secondary);font-weight:600;user-select:none;">'
      +             '<input type="checkbox" id="set-lock-ratio" checked style="width:16px;height:16px;cursor:pointer;accent-color:var(--accent);"> 等比例缩放（锁定宽高比）'
      +           '</label>'
      +         '</div>'
      +         '<div class="settings-input-group">'
      +           '<label>宽度</label>'
      +           '<div class="settings-slider-group">'
      +             '<input type="range" class="settings-slider" id="set-width-slider" min="640" max="2560" step="10" value="' + settings.window_width + '">'
      +             '<input type="number" id="set-width" value="' + settings.window_width + '" min="640" max="2560">'
      +           '</div>'
      +           '<label>高度</label>'
      +           '<div class="settings-slider-group">'
      +             '<input type="range" class="settings-slider" id="set-height-slider" min="360" max="1440" step="10" value="' + settings.window_height + '">'
      +             '<input type="number" id="set-height" value="' + settings.window_height + '" min="360" max="1440">'
      +           '</div>'
      +           '<span style="font-size:12px;color:var(--text-muted);">像素</span>'
      +         '</div>'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      + '</div>'

      // 全局唤醒快捷键
      + '<div class="settings-card">'
      +   '<div class="settings-card-header">全局唤醒快捷键</div>'
      +   '<div class="settings-card-body">'
      +     '<div class="settings-row">'
      +       '<div class="settings-label">唤起窗口</div>'
      +       '<div class="settings-control">'
      +         '<input type="text" id="set-hotkey" readonly placeholder="未绑定（点击后按下快捷键）" '
      +           'style="width:280px;padding:8px 12px;border:2px solid var(--border);border-radius:8px;font-size:14px;color:var(--text-primary);background:var(--bg-secondary);cursor:pointer;">'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      + '</div>'

      // 统计偏好只编辑草稿；成功保存后刷新全站有效种族显示与排序。
      + '<div class="settings-card">'
      + '<div class="settings-card-header">有效种族值</div><div class="settings-card-body">'
      + '<div class="settings-row settings-speed-row"><div class="settings-label">速度计入方式</div>'
      + '<div class="settings-control settings-speed-control" id="set-effective-speed">'
      + '<div class="settings-speed-modes" role="group" aria-label="有效种族速度模式">'
      + [['include', '包含速度'], ['exclude', '不包含速度'], ['threshold', '速度综合']].map(([mode, label]) =>
          '<button type="button" data-speed-mode="' + mode + '" aria-pressed="' + (settings.effective_speed_mode === mode) + '">' + label + '</button>').join('')
      + '</div><label class="settings-speed-threshold" id="set-effective-threshold-control"' + (settings.effective_speed_mode === 'threshold' ? '' : ' hidden') + '>'
      + '<span>门槛</span><input type="range" id="set-effective-threshold" min="40" max="120" step="1" value="' + settings.effective_speed_threshold + '">'
      + '<output id="set-effective-threshold-value" for="set-effective-threshold">' + settings.effective_speed_threshold + '</output></label>'
      + '</div></div></div></div>'

      // Explicit personal reset, independent of settings drafts and chart/team data.
      + '<div class="settings-card">'
      + '<div class="settings-card-header">精灵个人配置</div><div class="settings-card-body">'
      + '<div class="settings-row"><div class="settings-label">个体与性格</div><div class="settings-control" style="display:flex;flex-wrap:wrap;gap:8px;">'
      + '<button type="button" class="btn" id="set-reset-pet-defaults" style="max-width:100%;white-space:normal;">全部精灵个人配置恢复默认</button>'
      + '<button type="button" class="btn" id="set-clear-pet-configs" style="max-width:100%;white-space:normal;">清空所有精灵配置</button>'
      + '<div id="pet-defaults-result" role="status" aria-live="polite" style="flex-basis:100%;"></div>'
      + '</div></div></div></div>'

      // 默认页面
      + '<div class="settings-card">'
      +   '<div class="settings-card-header">默认打开页面</div>'
      +   '<div class="settings-card-body">'
      +     '<div class="settings-row">'
      +       '<div class="settings-label">默认页面</div>'
      +       '<div class="settings-control">'
      +         '<div class="settings-route-grid" id="set-route-grid">'
      +           ROUTE_OPTIONS.map(function(r) {
              return '<div class="settings-route-item ' + (r.value === settings.default_route ? 'active' : '') + '" data-route="' + r.value + '">' + r.label + '</div>';
            }).join('')
      +         '</div>'
      +       '</div>'
      +     '</div>'
      +   '</div>'
      + '</div>'

      + '<div class="settings-btn-row">'
      +   '<button type="button" class="btn btn-primary ud-btn-lg" id="set-save-btn" style="padding:10px 40px;font-size:15px;font-weight:700;border-radius:8px;">保存设置</button>'
      +   '<button type="button" class="btn ud-btn-lg" id="set-reset-btn" style="padding:10px 28px;font-size:15px;font-weight:700;border-radius:8px;background:var(--bg-secondary);border:2px solid var(--border);color:var(--text-secondary);cursor:pointer;">恢复默认</button>'
      + '</div>'
      + '<div id="settings-result" style="text-align:center;margin-top:12px;"></div>'
      // 未保存更改提示（右下角红框）
      + '<div id="settings-dirty-hint" style="display:none;position:fixed;right:24px;bottom:24px;padding:10px 18px;border:2px solid var(--danger);background:var(--bg-card);border-radius:10px;font-size:13px;font-weight:700;color:var(--danger);box-shadow:0 4px 16px rgba(0,0,0,0.25);z-index:9999;">⚠ 有未保存的更改，请点击“保存设置”</div>'
    + '</div></div>';
  }

  function bindEvents() {
    // 点击空白处（非交互控件）时清除结果提示（保存成功/已恢复默认等）
    if (resultDismissHandler) document.removeEventListener('click', resultDismissHandler);
    resultDismissHandler = function(e) {
      if (e.target.closest('button, input, select, label, .settings-pill, .settings-route-item')) return;
      var r = document.getElementById('settings-result');
      if (r && r.innerHTML) r.innerHTML = '';
    };
    document.addEventListener('click', resultDismissHandler);

    // 字体选择：立即预览，保存后持久化。
    var fontSelect = document.getElementById('set-font');
    if (fontSelect) {
      fontSelect.addEventListener('change', async function() {
        settings.font_family = fontSelect.value || '';
        await applyFontPreview(settings.font_family);
        markDirty();
      });
    }

    // 关闭行为
    var closePills = document.getElementById('set-close-pills');
    if (closePills) {
      closePills.onclick = function(e) {
        var pill = e.target.closest('.settings-pill');
        if (!pill) return;
        settings.close_behavior = pill.dataset.val;
        markDirty();
        closePills.innerHTML =
          '<span class="settings-pill ' + (settings.close_behavior === 'close' ? 'active' : '') + '" data-val="close">直接关闭</span>'
          + '<span class="settings-pill ' + (settings.close_behavior === 'minimize' ? 'active' : '') + '" data-val="minimize">最小化到任务栏</span>';
      };
    }

    // 窗口模式（仅设置启动时的默认状态，不改变当前窗口）
    var maxPills = document.getElementById('set-max-pills');
    if (maxPills) {
      maxPills.onclick = function(e) {
        var pill = e.target.closest('.settings-pill');
        if (!pill) return;
        settings.window_maximized = pill.dataset.val === 'true';
        markDirty();
        maxPills.innerHTML =
          '<span class="settings-pill ' + (!settings.window_maximized ? 'active' : '') + '" data-val="false">窗口化</span>'
          + '<span class="settings-pill ' + (settings.window_maximized ? 'active' : '') + '" data-val="true">最大化</span>';
        var sizeRow = document.getElementById('set-size-row');
        if (sizeRow) sizeRow.style.display = settings.window_maximized ? 'none' : '';
        var zoomRow = document.getElementById('set-maxzoom-row');
        if (zoomRow) zoomRow.style.display = settings.window_maximized ? '' : 'none';
      }

    // 默认显示屏选择（仅多显示器时渲染）
    var monitorPills = document.getElementById('set-monitor-pills');
    if (monitorPills) {
      monitorPills.onclick = function(e) {
        var pill = e.target.closest('.settings-pill');
        if (!pill) return;
        settings.default_monitor = +pill.dataset.val;
        markDirty();
        monitorPills.querySelectorAll('.settings-pill').forEach(function(p) {
          p.classList.toggle('active', +p.dataset.val === settings.default_monitor);
        });
      };
    };
    }

    // 缩放控件只编辑草稿；保存成功后同步运行时与记忆，失败不改变旧配置。
    var zoomSlider = document.getElementById('set-zoom-slider');
    var zoomInput = document.getElementById('set-zoom');
    function applyZoomSetting(v) {
      v = Math.round(v);
      if (v < 50) v = 50;
      if (v > 200) v = 200;
      settings.default_max_zoom = v;
      markDirty();
      if (zoomSlider) zoomSlider.value = v;
      if (zoomInput) zoomInput.value = v;
      // 不在请求成功前写入 localStorage。
    }
    if (zoomSlider && zoomInput) {
      zoomSlider.addEventListener('input', function() { applyZoomSetting(+zoomSlider.value); });
      zoomInput.addEventListener('input', function() { applyZoomSetting(+zoomInput.value || 100); });
    }

    bindSpeedSettings();

    // 默认页面
    var routeGrid = document.getElementById('set-route-grid');
    if (routeGrid) {
      routeGrid.onclick = function(e) {
        var item = e.target.closest('.settings-route-item');
        if (!item) return;
        settings.default_route = item.dataset.route;
        markDirty();
        routeGrid.innerHTML = ROUTE_OPTIONS.map(function(r) {
          return '<div class="settings-route-item ' + (r.value === settings.default_route ? 'active' : '') + '" data-route="' + r.value + '">' + r.label + '</div>';
        }).join('');
      };
    }

    // 等比例锁定
    var lockCheckbox = document.getElementById('set-lock-ratio');
    var lockedRatio = 0; // 宽/高

    function initLockRatio() {
      var w = +wInput.value || 1280;
      var h = +hInput.value || 800;
      if (h > 0) lockedRatio = w / h;
    }

    function clampVal(v, min, max) {
      v = Math.round(v);
      if (v < min) return min;
      if (v > max) return max;
      return v;
    }

    // 滑块 <-> 输入框联动
    var wSlider = document.getElementById('set-width-slider');
    var wInput = document.getElementById('set-width');
    var hSlider = document.getElementById('set-height-slider');
    var hInput = document.getElementById('set-height');

    function syncHeightFromWidth() {
      if (lockedRatio <= 0) return;
      var w = +wInput.value;
      var h = clampVal(w / lockedRatio, 360, 1440);
      hInput.value = h;
      hSlider.value = h;
    }
    function syncWidthFromHeight() {
      if (lockedRatio <= 0) return;
      var h = +hInput.value;
      var w = clampVal(h * lockedRatio, 640, 2560);
      wInput.value = w;
      wSlider.value = w;
    }

    if (wSlider && wInput) {
      wSlider.addEventListener('input', function() {
        wInput.value = wSlider.value;
        markDirty();
        if (lockCheckbox && lockCheckbox.checked) syncHeightFromWidth();
      });
      wInput.addEventListener('input', function() {
        var v = +wInput.value || 640;
        v = clampVal(v, 640, 2560);
        wSlider.value = v;
        markDirty();
        if (lockCheckbox && lockCheckbox.checked) syncHeightFromWidth();
      });
    }
    if (hSlider && hInput) {
      hSlider.addEventListener('input', function() {
        hInput.value = hSlider.value;
        markDirty();
        if (lockCheckbox && lockCheckbox.checked) syncWidthFromHeight();
      });
      hInput.addEventListener('input', function() {
        var v = +hInput.value || 360;
        v = clampVal(v, 360, 1440);
        hSlider.value = v;
        markDirty();
        if (lockCheckbox && lockCheckbox.checked) syncWidthFromHeight();
      });
    }

    // 锁定比例复选框（默认勾选，初始化时记录当前比例）
    if (lockCheckbox) {
      if (lockCheckbox.checked) initLockRatio();
      lockCheckbox.addEventListener('change', function() {
        if (lockCheckbox.checked) initLockRatio();
      });
    }

    // 保存
    var saveBtn = document.getElementById('set-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async function() {
        if (wInput) settings.window_width = +wInput.value || 1280;
        if (hInput) settings.window_height = +hInput.value || 800;
        await saveSettings();
      });
    }

    // 全局唤醒快捷键录入
    var hotkeyInput = document.getElementById('set-hotkey');
    function hotkeyLabel(mods, vk) {
      if (!vk) return '未绑定（点击后按下快捷键）';
      var parts = [];
      if (mods & 2) parts.push('Ctrl');
      if (mods & 1) parts.push('Alt');
      if (mods & 4) parts.push('Shift');
      if (mods & 8) parts.push('Win');
      // 可打印字符直接显示，特殊键用keyCode表示
      var key = (vk >= 65 && vk <= 90) ? String.fromCharCode(vk)
        : (vk >= 48 && vk <= 57) ? String.fromCharCode(vk)
        : (vk >= 112 && vk <= 123) ? 'F' + (vk - 111)
        : (vk === 32) ? 'Space'
        : (vk === 19) ? 'Pause'
        : 'Key(' + vk + ')';
      parts.push(key);
      return parts.join(' + ');
    }
    if (hotkeyInput) {
      // 回显当前设置
      hotkeyInput.value = hotkeyLabel(settings.hotkey_mods || 0, settings.hotkey_vk || 0);
      hotkeyInput.addEventListener('keydown', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          settings.hotkey_mods = 0;
          settings.hotkey_vk = 0;
          markDirty();
          hotkeyInput.value = hotkeyLabel(0, 0);
          return;
        }
        // 忽略单纯按下修饰键
        if (['Control', 'Shift', 'Alt', 'Meta'].indexOf(e.key) !== -1) return;
        var mods = (e.ctrlKey ? 2 : 0) | (e.altKey ? 1 : 0) | (e.shiftKey ? 4 : 0) | (e.metaKey ? 8 : 0);
        settings.hotkey_mods = mods;
        settings.hotkey_vk = e.keyCode;
        markDirty();
        hotkeyInput.value = hotkeyLabel(mods, e.keyCode);
      });
    }

    if (personalResetHandler) window.removeEventListener('petdefaultsreset', personalResetHandler);
    personalResetHandler = event => {
      const result = document.getElementById('pet-defaults-result');
      if (result) {
        result.textContent = event.detail?.operation === 'clear' ? '✓ 所有精灵的个人个体、性格已全部设为不选择。' : '✓ 全部精灵个人配置已恢复自动默认。';
        result.style.color = 'var(--success)';
      }
    };
    window.addEventListener('petdefaultsreset', personalResetHandler);
    const petReset = document.getElementById('set-reset-pet-defaults');
    if (petReset) petReset.addEventListener('click', async () => {
      const result = document.getElementById('pet-defaults-result');
      const api = window.UserConfig;
      if (!api?.resetPetDefaults || !api.getStatus().ready) {
        result.textContent = '共享配置尚未就绪，未执行重置。';
        return;
      }
      const count = Object.values(api.getObject('rk_pet_configs', {})).filter(record => record?.mode !== 0).length;
      if (!window.confirm(`将全部精灵的个人个体、性格恢复自动默认（当前${count}条人工配置）。\n不是全部关闭；不影响技能记忆、收藏、编队和曲线。\n保存前会自动备份。确定恢复吗？`)) return;
      petReset.disabled = true;
      document.getElementById('set-clear-pet-configs').disabled = true;
      result.textContent = '正在备份并恢复个人配置…';
      try {
        const ok = await api.resetPetDefaults();
        result.textContent = ok ? '✓ 全部精灵个人配置已恢复自动默认。' : '未完成保存，请使用共享配置提示中的“重试保存”；未把失败操作显示为成功。';
        result.style.color = ok ? 'var(--success)' : 'var(--danger)';
      } catch (error) {
        result.textContent = '恢复失败：' + (error.message || String(error));
        result.style.color = 'var(--danger)';
      } finally { petReset.disabled = false; document.getElementById('set-clear-pet-configs')?.removeAttribute('disabled'); }
    });

    const petClear = document.getElementById('set-clear-pet-configs');
    if (petClear) petClear.addEventListener('click', async () => {
      const result = document.getElementById('pet-defaults-result'), api = window.UserConfig;
      if (!api?.clearPetConfigs || !api.getStatus().ready) { result.textContent = '共享配置尚未就绪，未执行清空。'; return; }
      const ids = [...new Set(RKData.getMonsters().map(p => p.id))];
      if (!ids.length) { result.textContent = '精灵资料尚未就绪，未执行清空。'; return; }
      if (!window.confirm('将当前所有精灵（含木桩）的个人个体、性格全部设为“不选择”，重启后保持。\n这不是恢复默认；技能记忆、收藏、编队和独立曲线设置不变。\n保存前会自动备份。确定清空吗？')) return;
      petClear.disabled = true; if (petReset) petReset.disabled = true;
      result.textContent = '正在备份并清空个人个体、性格…';
      try {
        const ok = await api.clearPetConfigs(ids);
        result.textContent = ok ? '✓ 所有精灵的个人个体、性格已全部设为不选择。' : '未完成保存，请使用共享配置提示中的“重试保存”。';
        result.style.color = ok ? 'var(--success)' : 'var(--danger)';
      } catch (error) { result.textContent = '清空失败：' + (error.message || String(error)); result.style.color = 'var(--danger)'; }
      finally { petClear.disabled = false; if (petReset) petReset.disabled = false; }
    });

    // 恢复应用设置，与上面的个人配置重置无关。
    var resetBtn = document.getElementById('set-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', async function() {
        Object.assign(settings, DEFAULT_SETTINGS);
        markDirty();
        applyFontPreview('');
        const version = renderVersion;
        if (!await saveSettings()) return;
        if (version !== renderVersion) return;
        var container = document.getElementById('page-container');
        if (container) render(container);
        var r = document.getElementById('settings-result');
        if (r) r.innerHTML = '<span style="color:var(--success);font-weight:600;">✓ 已恢复默认设置</span>';
      });
    }
  }

  function onLeave() {
    renderVersion++;
    if (resultDismissHandler) document.removeEventListener('click', resultDismissHandler);
    resultDismissHandler = null;
    if (personalResetHandler) window.removeEventListener('petdefaultsreset', personalResetHandler);
    personalResetHandler = null;
    if (settings.font_family !== savedFontFamily) {
      settings.font_family = savedFontFamily;
      applyFontPreview(savedFontFamily);
    }
  }

  function render(container) {
    const version = ++renderVersion;
    const paint = () => {
      if (version !== renderVersion) return;
      if (!dirty && window.AppPreferences) settings.default_max_zoom = Math.round(window.AppPreferences.getMaxZoom() * 100);
      container.innerHTML = buildHtml();
      bindEvents();
      const hint = document.getElementById('settings-dirty-hint');
      if (hint) hint.style.display = dirty ? 'block' : 'none';
    };
    if (loaded) paint();
    else {
      container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">加载设置中...</div>';
      Promise.all([loadSettings(), loadFontFamilies()]).then(paint);
    }
  }

  return { render: render, onLeave: onLeave };
})();