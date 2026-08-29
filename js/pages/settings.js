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
    default_route: 'petdex'
  };

  let loaded = false;

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
      // 同时更新 localStorage 中的默认路由
      localStorage.setItem('xwiki-default-route', settings.default_route);

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (r) r.innerHTML = data.ok
        ? '<span style="color:var(--success);font-weight:600;">✓ 保存成功！部分设置重启后生效</span>'
        : '<span style="color:var(--danger);">保存失败</span>';
    } catch (e) {
      if (r) r.innerHTML = '<span style="color:var(--danger);">请求失败: ' + e.message + '</span>';
    }
  }

  function buildHtml() {
    return '<div class="calc-root"><div class="scroll-container" style="padding:8px 24px 40px;">'
      + PAGE_STYLE
      + '<div id="settings-result" style="text-align:center;margin-bottom:16px;"></div>'

      // 关闭行为
      + '<div class="settings-card">'
      +   '<div class="settings-card-header">窗口关闭行为</div>'
      +   '<div class="settings-card-body">'
      +     '<div class="settings-row">'
      +       '<div class="settings-label">点击 × 时<div class="settings-desc">关闭窗口时的行为</div></div>'
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
      +       '<div class="settings-label">窗口模式<div class="settings-desc">打开时的窗口状态</div></div>'
      +       '<div class="settings-control">'
      +         '<div class="settings-pills" id="set-max-pills">'
      +           '<span class="settings-pill ' + (!settings.window_maximized ? 'active' : '') + '" data-val="false">窗口化</span>'
      +           '<span class="settings-pill ' + (settings.window_maximized ? 'active' : '') + '" data-val="true">最大化</span>'
      +         '</div>'
      +       '</div>'
      +     '</div>'
      +     '<div class="settings-row" id="set-size-row" style="' + (settings.window_maximized ? 'display:none;' : '') + '">'
      +       '<div class="settings-label">窗口尺寸<div class="settings-desc">窗口化时的宽度和高度</div></div>'
      +       '<div class="settings-control">'
      +         '<div style="margin-bottom:10px;">'
      +           '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--text-secondary);font-weight:600;user-select:none;">'
      +             '<input type="checkbox" id="set-lock-ratio" style="width:16px;height:16px;cursor:pointer;accent-color:var(--accent);"> 等比例缩放（锁定宽高比）'
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

      // 默认页面
      + '<div class="settings-card">'
      +   '<div class="settings-card-header">默认打开页面</div>'
      +   '<div class="settings-card-body">'
      +     '<div class="settings-row">'
      +       '<div class="settings-label">默认页面<div class="settings-desc">启动时自动打开的页面</div></div>'
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
      + '</div>'
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
        closePills.innerHTML =
          '<span class="settings-pill ' + (settings.close_behavior === 'close' ? 'active' : '') + '" data-val="close">直接关闭</span>'
          + '<span class="settings-pill ' + (settings.close_behavior === 'minimize' ? 'active' : '') + '" data-val="minimize">最小化到任务栏</span>';
      };
    }

    // 窗口模式
    var maxPills = document.getElementById('set-max-pills');
    if (maxPills) {
      maxPills.onclick = function(e) {
        var pill = e.target.closest('.settings-pill');
        if (!pill) return;
        settings.window_maximized = pill.dataset.val === 'true';
        maxPills.innerHTML =
          '<span class="settings-pill ' + (!settings.window_maximized ? 'active' : '') + '" data-val="false">窗口化</span>'
          + '<span class="settings-pill ' + (settings.window_maximized ? 'active' : '') + '" data-val="true">最大化</span>';
        var sizeRow = document.getElementById('set-size-row');
        if (sizeRow) sizeRow.style.display = settings.window_maximized ? 'none' : '';
      };
    }

    // 默认页面
    var routeGrid = document.getElementById('set-route-grid');
    if (routeGrid) {
      routeGrid.onclick = function(e) {
        var item = e.target.closest('.settings-route-item');
        if (!item) return;
        settings.default_route = item.dataset.route;
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
        if (lockCheckbox && lockCheckbox.checked) syncHeightFromWidth();
      });
      wInput.addEventListener('input', function() {
        var v = +wInput.value || 640;
        v = clampVal(v, 640, 2560);
        wSlider.value = v;
        if (lockCheckbox && lockCheckbox.checked) syncHeightFromWidth();
      });
    }
    if (hSlider && hInput) {
      hSlider.addEventListener('input', function() {
        hInput.value = hSlider.value;
        if (lockCheckbox && lockCheckbox.checked) syncWidthFromHeight();
      });
      hInput.addEventListener('input', function() {
        var v = +hInput.value || 360;
        v = clampVal(v, 360, 1440);
        hSlider.value = v;
        if (lockCheckbox && lockCheckbox.checked) syncWidthFromHeight();
      });
    }

    // 锁定比例复选框
    if (lockCheckbox) {
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