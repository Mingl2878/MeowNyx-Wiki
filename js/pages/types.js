/**
 * types.js — 属性克制关系页面
 * 统一选择区 + 双结果展示（扇形色块网格 + 分类列表）
 */
const TypesPage = (function () {
  const { ALL_TYPES, getTypeIcon, getTypeEff, getEffectiveness, getTypeZhFull } = RKData;
  let mode = 'attack';        // 'attack' | 'defense'
  let selected = [];          // 多选

  function render(container) {
    container.innerHTML = `
      <div class="type-calc-section scroll-container">
        <!-- 模式切换 -->
        <div class="tq-toggle-bar">
          <div class="tq-toggle-slider" id="toggle-slider"></div>
          <button class="tq-toggle-btn active" id="mode-attack">进攻方</button>
          <button class="tq-toggle-btn" id="mode-defense">防守方</button>
        </div>

        <!-- 统一属性选择网格 -->
        <div class="type-calc-sub-hint" id="select-hint">选择进攻属性</div>
        <div class="type-calc-grid" id="type-grid"></div>

        <!-- 结果1：扇形色块网格 -->
        <div class="type-calc-sub" style="margin-top:16px;">
          <h4 id="grid-result-title">进攻属性克制效果</h4>
          <div class="type-calc-result-grid" id="grid-results"></div>
        </div>

        <!-- 结果2：分类列表 -->
        <div class="type-calc-sub" style="margin-top:20px;">
          <h4 id="list-result-title">克制详情</h4>
          <div id="list-results">
            <div class="tq-placeholder">请选择属性</div>
          </div>
        </div>
      </div>
    `;
    init();
  }

  function init() {
    const grid = document.getElementById('type-grid');
    grid.innerHTML = ALL_TYPES.map(t => {
      const icon = getTypeIcon(t);
      const enName = RKData.getTypeEn(t) || t;
      return `<div class="tc-grid-icon" data-type="${enName}"><img src="${icon}" alt="${t}"></div>`;
    }).join('');

    grid.querySelectorAll('.tc-grid-icon').forEach(el => {
      el.addEventListener('click', () => toggleType(el.dataset.type));
    });

    document.getElementById('mode-attack').addEventListener('click', () => switchMode('attack'));
    document.getElementById('mode-defense').addEventListener('click', () => switchMode('defense'));

    // 初始化滑块位置
    updateSlider();
    updateHints();

    // 恢复模式按钮状态
    document.getElementById('mode-attack').classList.toggle('active', mode === 'attack');
    document.getElementById('mode-defense').classList.toggle('active', mode === 'defense');
    // 恢复选中的属性高亮
    updateSelectionUI();

    renderGridResults();
    renderListResults();
  }

  function updateSlider() {
    const slider = document.getElementById('toggle-slider');
    if (!slider) return;
    const btns = slider.parentElement.querySelectorAll('.tq-toggle-btn');
    const activeBtn = mode === 'attack' ? btns[0] : btns[1];
    if (activeBtn) {
      slider.style.width = activeBtn.offsetWidth + 'px';
      slider.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
    }
  }

  function switchMode(m) {
    mode = m;
    selected = [];
    document.getElementById('mode-attack').classList.toggle('active', m === 'attack');
    document.getElementById('mode-defense').classList.toggle('active', m === 'defense');
    document.querySelectorAll('#type-grid .tc-grid-icon').forEach(el => el.classList.remove('active'));
    updateHints();
    updateSlider();
    renderGridResults();
    renderListResults();
  }

  function updateHints() {
    const selectHint = document.getElementById('select-hint');
    const gridTitle = document.getElementById('grid-result-title');
    const listTitle = document.getElementById('list-result-title');
    if (mode === 'attack') {
      if (selectHint) selectHint.textContent = '选择进攻属性';
      if (gridTitle) gridTitle.textContent = '进攻属性克制效果';
      if (listTitle) listTitle.textContent = '克制详情';
    } else {
      if (selectHint) selectHint.textContent = '选择防守属性';
      if (gridTitle) gridTitle.textContent = '防守属性被克制效果';
      if (listTitle) listTitle.textContent = '被克制详情';
    }
  }

  function toggleType(type) {
    const idx = selected.indexOf(type);
    if (idx > -1) selected.splice(idx, 1);
    else selected.push(type);
    updateSelectionUI();
    renderGridResults();
    renderListResults();
  }

  function updateSelectionUI() {
    document.querySelectorAll('#type-grid .tc-grid-icon').forEach(el => {
      el.classList.toggle('active', selected.includes(el.dataset.type));
    });
  }

  // ============ 结果1：扇形色块网格 ============
  function renderGridResults() {
    const resultDiv = document.getElementById('grid-results');
    const selEn = selected.map(t => RKData.getTypeEn(t));

    resultDiv.innerHTML = ALL_TYPES.map(t => {
      const effects = [];
      let multiplier = 1;

      if (selected.length > 0) {
        if (mode === 'defense') {
          // 选了防守属性，算每个进攻属性的效果
          selEn.forEach(defEn => effects.push(getTypeEff(t, defEn)));
        } else {
          // 选了进攻属性，算每个防守属性的效果
          selEn.forEach(atkEn => effects.push(getTypeEff(atkEn, t)));
        }
        multiplier = effects.reduce((a, b) => a * b, 1);
      }

      let bgStyle = 'white';
      if (effects.length > 0 && !effects.every(e => Math.abs(e - 1) < 0.001)) {
        const n = effects.length;
        const sliceSize = 360 / n;
        const parts = effects.map((effect, i) => {
          const color = effect >= 2 ? '#3d7e1b' : (effect <= 0.5 ? '#e43316' : 'white');
          return `${color} ${i * sliceSize}deg ${(i + 1) * sliceSize}deg`;
        });
        bgStyle = `conic-gradient(${parts.join(', ')})`;
      }

      const icon = getTypeIcon(t);
      return `<div class="tc-result-item" style="background:${bgStyle};" title="${t} - 克制系数: ${multiplier}x">
        <img src="${icon}" alt="${t}">
      </div>`;
    }).join('');
  }

  // ============ 结果2：分类列表 ============
  function renderListResults() {
    const container = document.getElementById('list-results');

    const makeList = (types, label, color) => {
      const items = types.map(t => {
        const icon = getTypeIcon(t);
        const full = getTypeZhFull(t);
        return `<div class="tq-result-item"><img src="${icon}" alt="${t}"><span>${full}</span></div>`;
      }).join('');
      const placeholder = types.length === 0 ? '<span style="color:var(--text-muted);font-size:13px;">—</span>' : '';
      return `<div class="tq-category tq-cat-${color}"><div class="tq-cat-header">${label} (${types.length})</div><div class="tq-cat-list">${items || placeholder}</div></div>`;
    };

    const selEn = selected.map(t => RKData.getTypeEn(t));

    if (mode === 'attack') {
      // 进攻方：选了进攻属性，对每个防守属性判断
      const effective = [], resisted = [], neutral = [];
      if (selected.length > 0) {
        ALL_TYPES.forEach(t => {
          const tEn = RKData.getTypeEn(t);
          const isVulnerable = selEn.some(atk => getEffectiveness(atk, tEn) >= 2.0);
          const isResisted = selEn.every(atk => getEffectiveness(atk, tEn) <= 0.5);
          if (isVulnerable) effective.push(t);
          else if (isResisted) resisted.push(t);
          else neutral.push(t);
        });
      }
      container.innerHTML =
        makeList(effective, '克制属性 (2×)', 'green') +
        makeList(resisted, '抵抗属性 (0.5×)', 'red') +
        makeList(neutral, '无法克制属性 (1×)', 'gray');

      // 新增：克制精灵栏（显示每个被克制属性的精灵总数）
      if (selected.length > 0) {
        // 去重：同一 dex_number 只保留一个，排除隐藏和首领形态
        // 优先保留高级形态，其次主形态；排除基础形态
        const allMonsters = (() => {
          const filtered = RKData.getMonsters().filter(m => !m.hidden && !m.is_leader_form && m.evolution_stage !== '基础形态');
          const byDex = new Map();
          for (const m of filtered) {
            const existing = byDex.get(m.dex_number);
            if (!existing) { byDex.set(m.dex_number, m); continue; }
            // 优先保留高级形态
            const mIsHigh = m.evolution_stage === '高级形态';
            const eIsHigh = existing.evolution_stage === '高级形态';
            if (mIsHigh && !eIsHigh) { byDex.set(m.dex_number, m); continue; }
            // 同为高级或同级时，优先主形态
            if (mIsHigh === eIsHigh && m.form_category === '主形态' && existing.form_category !== '主形态') {
              byDex.set(m.dex_number, m);
            }
          }
          return Array.from(byDex.values());
        })();
        // 抵抗精灵栏（显示同时抵抗所有选中进攻属性的精灵头像）
        // 抵抗判定：双属性复合倍率 = 各属性效果倍率的乘积 ≤ 0.5
        // 排序：按总种族值降序
        const 抵抗精灵 = allMonsters.filter(m => {
          const mainEn = m.main_type ? m.main_type.name : '';
          const subEn = m.sub_type ? m.sub_type.name : '';
          const petTypes = [mainEn, subEn].filter(Boolean);
          if (petTypes.length === 0) return false;
          return selEn.every(atk => {
            const product = petTypes.reduce((acc, pt) => acc * getEffectiveness(atk, pt), 1);
            return product <= 0.5;
          });
        }).sort((a, b) => RKData.getTotalStats(b) - RKData.getTotalStats(a));
        const 抵抗精灵Html = 抵抗精灵.map(m => {
          const imgUrl = m.image ? `assets/monster/images/${m.image}` : '';
          const name = RKData.getMonsterDisplayName(m);
          return imgUrl
            ? `<img src="${imgUrl}" class="tq-monster-avatar" alt="${name}" title="${name}" loading="lazy">`
            : `<div class="tq-monster-avatar" style="display:flex;align-items:center;justify-content:center;background:var(--bg-secondary);font-size:12px;">${name.charAt(0)}</div>`;
        }).join('');
        const 抵抗精灵Placeholder = 抵抗精灵.length === 0 ? '<span style="color:var(--text-muted);font-size:13px;">—</span>' : '';
        container.innerHTML += `<div class="tq-category tq-cat-blue"><div class="tq-cat-header">抵抗精灵 (0.5×) (${抵抗精灵.length})</div><div class="tq-monster-list">${抵抗精灵Html || 抵抗精灵Placeholder}</div></div>`;
      }
    } else {
      // 防守方：选了防守属性，对每个进攻属性算累计得分
      const triple = [], dbl = [], half = [], quarter = [], neutral = [];
      if (selected.length > 0) {
        ALL_TYPES.forEach(t => {
          const tEn = RKData.getTypeEn(t);
          let score = 0;
          selEn.forEach(defEn => {
            const eff = getEffectiveness(tEn, defEn);
            if (eff >= 2.0) score++;
            else if (eff <= 0.5) score--;
          });
          if (score >= 2) triple.push(t);
          else if (score === 1) dbl.push(t);
          else if (score === -1) half.push(t);
          else if (score <= -2) quarter.push(t);
          else neutral.push(t);
        });
      }
      container.innerHTML =
        makeList(triple, '三倍弱点 (3×)', 'red') +
        makeList(dbl, '双倍弱点 (2×)', 'orange') +
        makeList(half, '半倍抵抗 (0.5×)', 'blue') +
        makeList(quarter, '三倍抵抗 (1/3×)', 'green') +
        makeList(neutral, '正常效果 (1×)', 'gray');
    }
  }

  return { render };
})();
