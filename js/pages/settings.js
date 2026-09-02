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

  let settings = {
    close_behavior: 'close',
    window_width: 1280,
    window_height: 800,
    window_maximized: false,
    default_route: 'petdex',
    default_max_zoom: 100,
    hotkey_mods: 0,
    hotkey_vk: 0
  };

  var DEFAULT_SETTINGS = {
    close_behavior: 'close',
    window_width: 1280,
    window_height: 800,
    window_maximized: false,
    default_route: 'petdex',
    default_max_zoom: 100,
    hotkey_mods: 0,
    hotkey_vk: 0
  };

  let loaded = false;

  // 未保存更改提示
  function markDirty() {
    var el = document.getElementById('settings-dirty-hint');
    if (el) el.style.display = 'block';
  }
  function clearDirty() {
    var el = document.getElementById('settings-dirty-hint');
    if (el) el.style.display = 'none';
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
      const res = await fetch('/api/settings');
      const data = await res.json();
      Object.assign(settings, data);
      loaded = true;
    } catch (e) {
      console.error('加载设置失败:', e);
      loaded = true;
    }
  }

  async function saveSettings() {
    const r = document.getElementById('settings-result');
    if (r) r.innerHTML = '<span style="color:var(--text-secondary);">正在保存...</span>';
    try {
      // 同时更新 localStorage 中的默认路由与最大化缩放记忆
      localStorage.setItem('xwiki-default-route', settings.default_route);
      if (settings.default_max_zoom) {
        localStorage.setItem('xwiki-max-zoom', settings.default_max_zoom / 100);
      }

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (r) r.innerHTML = !data.ok
        ? '<span style="color:var(--danger);">保存失败</span>'
        : (data.hotkey_failed
          ? '<span style="color:var(--danger);">✓ 已保存，但全局快捷键注册失败：该组合键可能已被其他程序占用，请更换后重新保存</span>'
          : '<span style="color:var(--success);font-weight:600;">✓ 保存成功！部分设置重启后生效</span>');
      if (data.ok) clearDirty();
    } catch (e) {
      if (r) r.innerHTML = '<span style="color:var(--danger);">请求失败: ' + e.message + '</span>';
    }
  }

  function buildHtml() {
    return '<div class="calc-root"><div class="scroll-container" style="padding:8px 24px 40px;">'
      + PAGE_STYLE

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

      // 最大化时界面缩放（仅默认窗口模式为“最大化”时显示）
      + '<div class="settings-row" id="set-maxzoom-row" style="' + (settings.window_maximized ? '' : 'display:none;') + '">'
      +   '<div class="settings-label">最大化时界面缩放</div>'
      +   '<div class="settings-control">'
      +     '<div class="settings-input-group">'
      +       '<input type="range" class="settings-slider" id="set-zoom-slider" min="100" max="200" step="5" value="' + (settings.default_max_zoom || 100) + '">'
      +       '<input type="number" id="set-zoom" value="' + (settings.default_max_zoom || 100) + '" min="100" max="200" style="width:70px;padding:6px 10px;border:2px solid var(--border);border-radius:8px;font-size:14px;text-align:center;color:var(--text-primary);background:var(--bg-secondary);">'
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
      };
    }

    // 最大化时界面缩放（拖动即写入记忆，保存后持久化到设置文件）
    var zoomSlider = document.getElementById('set-zoom-slider');
    var zoomInput = document.getElementById('set-zoom');
    function applyZoomSetting(v) {
      v = Math.round(v);
      if (v < 100) v = 100;
      if (v > 200) v = 200;
      settings.default_max_zoom = v;
      markDirty();
      if (zoomSlider) zoomSlider.value = v;
      if (zoomInput) zoomInput.value = v;
      // 实时写入缩放记忆，下次最大化立即生效
      localStorage.setItem('xwiki-max-zoom', v / 100);
    }
    if (zoomSlider && zoomInput) {
      zoomSlider.addEventListener('input', function() { applyZoomSetting(+zoomSlider.value); });
      zoomInput.addEventListener('input', function() { applyZoomSetting(+zoomInput.value || 100); });
    }

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

    // 恢复默认
    var resetBtn = document.getElementById('set-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', async function() {
        Object.assign(settings, DEFAULT_SETTINGS);
        localStorage.setItem('xwiki-max-zoom', DEFAULT_SETTINGS.default_max_zoom / 100);
        await saveSettings();
        var container = document.querySelector('.calc-root .scroll-container');
        if (container) {
          container.innerHTML = buildHtml();
          bindEvents();
        }
        var r = document.getElementById('settings-result');
        if (r) r.innerHTML = '<span style="color:var(--success);font-weight:600;">✓ 已恢复默认设置</span>';
      });
    }
  }

  function render(container) {
    if (loaded) {
      container.innerHTML = buildHtml();
      bindEvents();
    } else {
      container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">加载设置中...</div>';
      loadSettings().then(function() {
        container.innerHTML = buildHtml();
        bindEvents();
      });
    }
  }

  return { render: render };
})();