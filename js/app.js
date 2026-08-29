/**
 * app.js — 主应用入口
 * 负责路由导航、数据初始化、页面渲染
 */
(function () {
  const routes = {
    'petdex': PetDexPage,
    'moves': MovesPage,
    'types': TypesPage,
    'speed': SpeedPage,
    'team': TeamPage,
    'damage': DamagePage,
    'chart': ChartPage,
    'updatedata': UpdateDataPage,
    'settings': SettingsPage
  };

  let currentRoute = null;

  /** 获取当前 hash 路由 */
  function getRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (routes[hash]) return hash;
    // 没有指定 hash 时使用默认路由
    const saved = localStorage.getItem('xwiki-default-route');
    return (saved && routes[saved]) ? saved : 'petdex';
  }

  /** 导航到指定路由 */
  function navigate(route) {
    if (!routes[route]) route = 'petdex';

    // 更新导航栏高亮
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.route === route);
    });

    // 渲染页面
    const container = document.getElementById('page-container');
    container.innerHTML = '';
    try {
      routes[route].render(container);
      currentRoute = route;
    } catch (err) {
      console.error(`[App] 页面渲染失败 (${route}):`, err);
      container.innerHTML = `<div class="empty-state">页面加载失败: ${err.message}</div>`;
    }
  }

  /** 处理路由变化 */
  function onHashChange() {
    navigate(getRoute());
  }

  /** 初始化 */
  async function init() {
    // 加载数据
    try {
      await RKData.init();
    } catch (err) {
      document.getElementById('loading-overlay').innerHTML = `
        <div style="text-align:center;color:var(--danger);">
          <p>数据加载失败！</p>
          <p style="font-size:13px;margin-top:8px;">${err.message}</p>
          <p style="font-size:13px;margin-top:8px;color:var(--text-muted);">请确保通过 HTTP 服务器访问（不要直接双击HTML文件打开）</p>
        </div>
      `;
      return;
    }

    // 隐藏加载提示
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.add('hidden');
    overlay.style.display = 'none';

    // 初始路由
    navigate(getRoute());

    // 监听路由变化
    window.addEventListener('hashchange', onHashChange);

    // 点击标题栏「小黑猫Wiki」进入设置页面
    const navBrand = document.querySelector('.nav-brand');
    if (navBrand) {
      navBrand.style.cursor = 'pointer';
      navBrand.addEventListener('click', () => {
        location.hash = '/settings';
      });
    }
  }

  // 关闭模态框（点击遮罩）
  document.addEventListener('click', e => {
    if (e.target.id === 'pet-modal') {
      e.target.style.display = 'none';
    }
  });

  // ESC 关闭模态框
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('pet-modal');
      if (modal) modal.style.display = 'none';
    }
  });

  // ===================== 夜间模式 =====================
  function applyTheme(isDark) {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    const moonIcon = document.querySelector('.theme-icon-moon');
    const sunIcon = document.querySelector('.theme-icon-sun');
    if (moonIcon && sunIcon) {
      moonIcon.style.display = isDark ? 'none' : '';
      sunIcon.style.display = isDark ? '' : 'none';
    }
    const toggleBtn = document.getElementById('theme-toggle');
    if (toggleBtn) toggleBtn.classList.toggle('theme-dark', isDark);
  }

  function initTheme() {
    const saved = localStorage.getItem('xwiki-theme');
    const isDark = saved === 'dark';
    applyTheme(isDark);
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') === 'dark';
        const next = !current;
        applyTheme(next);
        localStorage.setItem('xwiki-theme', next ? 'dark' : 'light');
      });
    }
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  initTheme();
})();
