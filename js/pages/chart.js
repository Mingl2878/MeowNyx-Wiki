/**
 * chart.js — 伤害曲线页面
 * 只保留曲线图，攻击方/防守方/技能设置引用 DamagePage.getState()
 */
const ChartPage = (function () {
  const { getTypeZhFull, getBaseStat, getPetStat } = RKData;

  // 曲线专用状态
  let chartMode = 'defense';
  let chartAxisSwapped = false;
  let chartCritActive = 0;
  let chartSameTypeActive = false;
  let chartAtkType = 'attack';
  let defenseChartInstance = null;

  // 从 DamagePage 读取状态
  function dmgState() { return DamagePage.getState(); }

  function getPetTypes(pet) {
    if (!pet) return [];
    const types = [];
    if (pet.main_type) types.push(pet.main_type.name);
    if (pet.sub_type) types.push(pet.sub_type.name);
    return types;
  }
  function getPetName(pet) { return RKData.getMonsterDisplayName(pet); }

  // ============ 渲染页面 ============
  function render(container) {
    container.innerHTML = `<div class="calc-root"><div class="container">
      <div class="card result-card" style="border:none;box-shadow:none;"><div class="card-header">
        <h3><img src="assets/icons/ui/icon_curve.png" alt="伤害曲线" class="title-icon"> <span id="chartTitle">伤害-防御曲线</span></h3>
        <div class="chart-header-right"><button id="chartModeBtn" class="chart-mode-btn" title="切换曲线模式">切换：防御-伤害</button></div>
      </div><div class="card-body" style="padding:20px;">
        <div id="chartPowerControl" class="chart-power-control" style="display:none;">
          <span class="chart-control-label" id="chartPowerLabel">技能威力：</span>
          <input type="range" id="chartPowerSlider" min="0" max="600" value="200" step="1" class="chart-power-slider">
          <input type="number" id="chartPowerInput" min="0" max="600" value="200" class="chart-power-number">
          <button id="chartSwapAxisBtn" class="chart-control-btn" title="交换横轴与滑动条">⇄</button>
          <button id="chartCritBtn" class="chart-control-btn" title="克制：伤害×2">克制</button>
          <button id="chartSameTypeBtn" class="chart-control-btn" title="本系加成×1.25">本系</button>
          <button id="chartAtkTypeBtn" class="chart-control-btn" title="切换物攻/魔攻">物攻</button>
        </div>
        <div class="defense-chart-help" id="chartInfo">请在「伤害计算器」页面设置精灵和技能，然后回到此页面查看曲线</div>
        <div class="chart-container"><canvas id="defenseChart"></canvas></div>
        <div id="chartControls" class="defense-chart-controls">
          <span class="chart-control-label">攻击方个体与性格：</span>
          <button id="chartAtkIVBtn" class="chart-control-btn" title="左键：显示有个体加成的折线">个体</button>
          <button id="chartAtkNatureBtn" class="chart-control-btn" title="左键：性格+ | 右键：性格-">性格</button>
          <span class="chart-control-sep"></span>
          <span class="chart-control-label">防守方个体：</span>
          <button id="chartIVBtn" class="chart-control-btn" title="左键：显示有个体加成的折线">个体</button>
          <span class="chart-control-sep"></span>
          <button id="chartCritBtnDef" class="chart-control-btn" title="左键：克制×2 | 右键：抵抗×0.5">克制</button>
        </div>
        <div id="chartAttackControls" class="defense-chart-controls" style="display:none;">
          <span class="chart-control-label">攻击方个体与性格：</span>
          <button id="chartAtkIVBtn2" class="chart-control-btn" title="左键：显示有个体加成的折线">个体</button>
          <button id="chartAtkNatureBtn2" class="chart-control-btn" title="左键：性格+ | 右键：性格-">性格</button>
          <span class="chart-control-sep"></span>
          <span class="chart-control-label">防守方个体：</span>
          <button id="chartDefIVBtn2" class="chart-control-btn" title="左键：显示有个体加成的折线">个体</button>
          <span class="chart-control-sep"></span>
          <span class="chart-control-label">防守方生命：</span>
          <button id="chartHPIVBtn" class="chart-control-btn" title="左键：生命个体">个体</button>
          <button id="chartHPNatureBtn" class="chart-control-btn" title="左键：生命性格+ | 右键：生命性格-">性格</button>
        </div>
      </div></div>
    </div></div>`;
    bindChartEvents();
    renderChart();
  }

  // ============ 曲线图事件绑定 ============
  function bindChartEvents() {
    const modeBtn = document.getElementById('chartModeBtn');
    const powerSlider = document.getElementById('chartPowerSlider');
    const powerInput = document.getElementById('chartPowerInput');
    const powerControl = document.getElementById('chartPowerControl');
    const chartControls = document.getElementById('chartControls');
    const chartAttackControls = document.getElementById('chartAttackControls');
    const ivBtn = document.getElementById('chartIVBtn');
    const atkIVBtn = document.getElementById('chartAtkIVBtn');
    const atkNatureBtn = document.getElementById('chartAtkNatureBtn');
    const atkIVBtn2 = document.getElementById('chartAtkIVBtn2');
    const atkNatureBtn2 = document.getElementById('chartAtkNatureBtn2');
    const defIVBtn2 = document.getElementById('chartDefIVBtn2');
    const hpIVBtn = document.getElementById('chartHPIVBtn');
    const hpNatureBtn = document.getElementById('chartHPNatureBtn');

    atkNatureBtn.dataset.nature = '0'; atkNatureBtn2.dataset.nature = '0'; hpNatureBtn.dataset.nature = '0';
    hpIVBtn.addEventListener('click', () => { hpIVBtn.classList.toggle('active-iv'); renderChart(); });
    bindNatureBtn(hpNatureBtn);

    modeBtn.addEventListener('click', () => {
      chartMode = chartMode === 'defense' ? 'attack' : 'defense';
      if (chartMode === 'attack') {
        modeBtn.textContent = '切换：伤害-防御'; modeBtn.classList.add('active');
        powerControl.style.display = 'flex'; chartControls.style.display = 'none'; chartAttackControls.style.display = 'flex';
        document.getElementById('chartTitle').textContent = '防御-伤害曲线';
      } else {
        modeBtn.textContent = '切换：防御-伤害'; modeBtn.classList.remove('active');
        powerControl.style.display = 'none'; chartControls.style.display = 'flex'; chartAttackControls.style.display = 'none';
        document.getElementById('chartTitle').textContent = '伤害-防御曲线';
      }
      renderChart();
    });

    powerSlider.addEventListener('input', () => { powerInput.value = powerSlider.value; renderChart(); });
    powerInput.addEventListener('input', () => { let v = parseInt(powerInput.value) || 200; v = Math.max(0, Math.min(600, v)); powerSlider.value = v; renderChart(); });

    const critBtn = document.getElementById('chartCritBtn'); const critBtnDef = document.getElementById('chartCritBtnDef');
    const updateCritBtns = () => { [critBtn, critBtnDef].forEach(btn => { if (!btn) return; btn.classList.remove('active-iv', 'active-negative');
      if (chartCritActive === 1) { btn.classList.add('active-iv'); btn.textContent = '克制×2'; }
      else if (chartCritActive === 2) { btn.classList.add('active-negative'); btn.textContent = '抵抗×0.5'; }
      else btn.textContent = '克制'; }); };
    const bindCritBtn = (btn) => { if (!btn) return;
      btn.addEventListener('click', () => { chartCritActive = chartCritActive === 1 ? 0 : 1; updateCritBtns(); renderChart(); });
      btn.addEventListener('contextmenu', (e) => { e.preventDefault(); chartCritActive = chartCritActive === 2 ? 0 : 2; updateCritBtns(); renderChart(); }); };
    bindCritBtn(critBtn); bindCritBtn(critBtnDef);

    const sameTypeBtn = document.getElementById('chartSameTypeBtn');
    sameTypeBtn.addEventListener('click', () => { chartSameTypeActive = !chartSameTypeActive; sameTypeBtn.classList.toggle('active-iv', chartSameTypeActive); renderChart(); });

    const atkTypeBtn = document.getElementById('chartAtkTypeBtn');
    atkTypeBtn.addEventListener('click', () => { chartAtkType = chartAtkType === 'attack' ? 'magic_attack' : 'attack';
      atkTypeBtn.textContent = chartAtkType === 'attack' ? '物攻' : '魔攻'; atkTypeBtn.classList.toggle('active-iv', chartAtkType === 'magic_attack'); renderChart(); });

    const swapAxisBtn = document.getElementById('chartSwapAxisBtn'); const powerLabel = document.getElementById('chartPowerLabel');
    swapAxisBtn.addEventListener('click', () => { chartAxisSwapped = !chartAxisSwapped; swapAxisBtn.classList.toggle('active-iv', chartAxisSwapped);
      if (chartAxisSwapped) { powerLabel.textContent = '攻击资质：'; powerSlider.min = 80; powerSlider.max = 200; powerSlider.step = 2; powerInput.min = 80; powerInput.max = 200;
        const cur = parseInt(powerSlider.value); if (cur < 80 || cur > 200) { powerSlider.value = 120; powerInput.value = 120; } }
      else { powerLabel.textContent = '技能威力：'; powerSlider.min = 0; powerSlider.max = 600; powerSlider.step = 1; powerInput.min = 0; powerInput.max = 600;
        const cur = parseInt(powerSlider.value); if (cur > 600) { powerSlider.value = 200; powerInput.value = 200; } }
      renderChart();
    });

    atkIVBtn2.addEventListener('click', () => { atkIVBtn2.classList.toggle('active-iv'); renderChart(); });
    bindNatureBtn(atkNatureBtn2);
    defIVBtn2.addEventListener('click', () => { defIVBtn2.classList.toggle('active-iv'); renderChart(); });
    atkIVBtn.addEventListener('click', () => { atkIVBtn.classList.toggle('active-iv'); renderChart(); });
    bindNatureBtn(atkNatureBtn);
    ivBtn.addEventListener('click', () => { ivBtn.classList.toggle('active-iv'); renderChart(); });
  }

  function bindNatureBtn(btn) {
    btn.addEventListener('click', () => { const cur = parseInt(btn.dataset.nature);
      if (cur === 1) { btn.dataset.nature = '0'; btn.classList.remove('active-positive', 'active-negative'); btn.textContent = '性格'; }
      else { btn.dataset.nature = '1'; btn.classList.remove('active-negative'); btn.classList.add('active-positive'); btn.textContent = '性格+'; }
      renderChart();
    });
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); const cur = parseInt(btn.dataset.nature);
      if (cur === 2) { btn.dataset.nature = '0'; btn.classList.remove('active-positive', 'active-negative'); btn.textContent = '性格'; }
      else { btn.dataset.nature = '2'; btn.classList.remove('active-positive'); btn.classList.add('active-negative'); btn.textContent = '性格-'; }
      renderChart();
    });
  }

  // ============ 伤害计算 ============
  function calculateDamageForDefense(defenseValue, attackStatOverride) {
    try {
      const s = dmgState();
      const attacker = s.atkPet; if (!attacker) return 0;
      const skillType = s.skillType || 'attack';
      const basePower = s.basePower || 0;
      const fixedBonus = s.fixedBonus || 0;
      const percentBonus = s.percentBonus || 0;
      const buffPercent = s.buff || 0;
      let finalPower = Math.floor((basePower + fixedBonus) * (1 + percentBonus / 100));
      const skillAttrFull = getTypeZhFull(s.skillAttr);
      const isSameType = getPetTypes(attacker).map(t => getTypeZhFull(RKData.getTypeZh(t))).includes(skillAttrFull);
      const sameTypeBonus = isSameType ? 1.25 : 1.0;
      let buffModifier = buffPercent >= 0 ? 1 + buffPercent / 100 : 1 / (1 + Math.abs(buffPercent) / 100);
      const comboCount = s.comboCount || 1;
      const debuffInput = (s.debuff || '0').trim();
      let debuffModifier = 1, defenseModifier = 1;
      if (debuffInput && debuffInput !== '0') {
        if (debuffInput.toLowerCase().startsWith('d')) defenseModifier = 1 + (parseFloat(debuffInput.substring(1)) || 0) / 100;
        else debuffModifier = (100 - (parseFloat(debuffInput) || 0)) / 100;
      }
      let attackStat;
      if (attackStatOverride !== undefined) attackStat = attackStatOverride;
      else {
        const atkStatKey = skillType;
        attackStat = getPetStat(attacker, atkStatKey, (s.atkNature[atkStatKey] || 0), !!(s.atkIV[atkStatKey]));
      }
      const defenseStat = Math.round(defenseValue * defenseModifier);
      const finalPowerWithBonus = Math.floor(finalPower * sameTypeBonus * buffModifier);
      const d1 = Math.ceil(attackStat * finalPowerWithBonus);
      const d2 = Math.ceil(d1 * (37 / 41));
      const d3 = Math.ceil(d2 / defenseStat);
      const d4 = Math.ceil(d3 * debuffModifier);
      return d4 * comboCount;
    } catch (error) { return 0; }
  }

  function calcStatFromQual(qualification, ivEnabled, natureModifier) {
    const ivValue = ivEnabled ? 10 : 0;
    const step1 = Math.round(1.1 * (qualification + 3 * ivValue));
    const step2 = step1 + 10;
    const step3 = Math.round(step2 * natureModifier);
    return step3 + 50;
  }

  function calcDamageForAttack(attackStat, power, defenseStat) {
    const d1 = Math.ceil(attackStat * power);
    const d2 = Math.ceil(d1 * (37 / 41));
    return Math.ceil(d2 / defenseStat);
  }

  // ============ 渲染曲线图 ============
  function renderChart() {
    if (chartMode === 'attack') { renderAttackChart(); return; }
    renderDefenseChart();
  }

  function renderDefenseChart() {
    const canvas = document.getElementById('defenseChart'); if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const s = dmgState();
    const attacker = s.atkPet; const defender = s.defPet;
    if (!attacker || !defender) return;

    const basePower = s.basePower || 0;
    const fixedBonus = s.fixedBonus || 0;
    const percentBonus = s.percentBonus || 0;
    const buffPercent = s.buff || 0;
    const comboCount = s.comboCount || 1;
    const skillAttr = s.skillAttr;
    const skillAttrFull = getTypeZhFull(skillAttr);
    const isSameType = getPetTypes(attacker).map(t => getTypeZhFull(RKData.getTypeZh(t))).includes(skillAttrFull);
    const sameTypeBonus = isSameType ? 1.25 : 1.0;
    let buffModifier = buffPercent >= 0 ? 1 + buffPercent / 100 : 1 / (1 + Math.abs(buffPercent) / 100);
    const finalPowerWithBonus = Math.floor(Math.floor((basePower + fixedBonus) * (1 + percentBonus / 100)) * sameTypeBonus * buffModifier);

    const infoElement = document.getElementById('chartInfo');
    infoElement.textContent = [`攻击方：${getPetName(attacker)}`, `技能属性：${skillAttr}`, `基础威力：${basePower}`,
      `最终威力：${finalPowerWithBonus} (本系${isSameType ? '×1.25' : '×1'} BUFF${buffPercent >= 0 ? '+' : ''}${buffPercent}%)`, `连击数：${comboCount}`].join(' | ');

    const atkIVActive = document.getElementById('chartAtkIVBtn').classList.contains('active-iv');
    const atkNatureInt = parseInt(document.getElementById('chartAtkNatureBtn').dataset.nature || '0');
    const skillType = s.skillType || 'attack';
    const atkStatKey = skillType === 'attack' ? 'attack' : 'magic_attack';
    const atkBase = getBaseStat(attacker, atkStatKey) || 0;
    const atkNatureMod = atkNatureInt === 1 ? 1.2 : atkNatureInt === 2 ? 0.9 : 1.0;
    const currentQualification = skillType === 'attack' ? getBaseStat(defender, 'defense') : getBaseStat(defender, 'magic_defense') || 0;
    const ivActive = document.getElementById('chartIVBtn').classList.contains('active-iv');

    const qualifications = []; for (let q = 80; q <= 200; q += 2) qualifications.push(q);
    const defCritMult = chartCritActive === 1 ? 2 : chartCritActive === 2 ? 0.5 : 1;

    function calcAtkStat(ivEnabled, natureMod) { return calcStatFromQual(atkBase, ivEnabled, natureMod); }
    function genData(defIvEnabled, atkStat) {
      return qualifications.map(q => { const dv = calcStatFromQual(q, defIvEnabled, 1.0); return Math.ceil(calculateDamageForDefense(dv, atkStat) * defCritMult); });
    }

    const colors = { base: {border:'#11998e',bg:'rgba(17,153,142,0.08)'}, iv: {border:'#4a90e2',bg:'rgba(74,144,226,0.08)'},
      atkIV: {border:'#e67e22',bg:'rgba(230,126,34,0.08)'}, atkIVDef: {border:'#8e44ad',bg:'rgba(142,68,173,0.08)'},
      naturePlus: {border:'#3d7e1b',bg:'rgba(61,126,27,0.08)'}, natureMinus: {border:'#c0392b',bg:'rgba(192,57,43,0.08)'},
      ivNaturePlus: {border:'#9b59b6',bg:'rgba(155,89,182,0.08)'}, ivNatureMinus: {border:'#d35400',bg:'rgba(211,84,0,0.08)'} };

    function makeDataset(label, data, color, hidden = false) {
      return { label, data, hidden, borderColor: color.border, backgroundColor: color.bg,
        borderWidth: 2, tension: 0.2, cubicInterpolationMode: 'monotone', fill: false,
        pointRadius: c => Math.abs(c.parsed.x - currentQualification) <= 3 ? 6 : 2,
        pointBackgroundColor: c => Math.abs(c.parsed.x - currentQualification) <= 3 ? '#e43316' : color.border };
    }

    const atkStat_00 = calcAtkStat(false, 1.0); const atkStat_iv = calcAtkStat(true, 1.0);
    const atkStat_nat = calcAtkStat(false, atkNatureMod); const atkStat_ivNat = calcAtkStat(true, atkNatureMod);
    const natStr2 = atkNatureInt === 2 ? '-性格' : '+性格';
    const allActive = atkIVActive && atkNatureInt !== 0 && ivActive;
    const datasets = [];

    if (allActive) {
      datasets.push(makeDataset('基础', genData(false, atkStat_00), colors.base, false));
      datasets.push(makeDataset('防+个体', genData(true, atkStat_00), colors.iv, true));
      datasets.push(makeDataset('攻+个体', genData(false, atkStat_iv), colors.atkIV, true));
      datasets.push(makeDataset('攻+个体/防+个体', genData(true, atkStat_iv), colors.atkIVDef, true));
      datasets.push(makeDataset(`攻+个体${natStr2}`, genData(false, atkStat_ivNat), colors.ivNaturePlus, true));
      datasets.push(makeDataset(`攻+个体${natStr2}/防+个体`, genData(true, atkStat_ivNat), colors.ivNatureMinus, true));
    } else {
      datasets.push(makeDataset('基础', genData(false, atkStat_00), colors.base));
      if (ivActive) datasets.push(makeDataset('防+个体', genData(true, atkStat_00), colors.iv));
      if (atkIVActive) { datasets.push(makeDataset('攻+个体', genData(false, atkStat_iv), colors.atkIV));
        if (ivActive) datasets.push(makeDataset('攻+个体/防+个体', genData(true, atkStat_iv), colors.atkIVDef)); }
      if (atkNatureInt !== 0) { const ivNatColor = atkNatureInt === 1 ? colors.ivNaturePlus : colors.ivNatureMinus;
        if (atkIVActive) { datasets.push(makeDataset(`攻+个体${natStr2}`, genData(false, atkStat_ivNat), ivNatColor));
          if (ivActive) datasets.push(makeDataset(`攻+个体${natStr2}/防+个体`, genData(true, atkStat_ivNat), colors.ivNatureMinus)); } }
    }

    const maxDamage = Math.max(...datasets.map(d => Math.max(...d.data)));
    if (maxDamage >= 400) { datasets.push({ label: '斩杀线(400)', data: qualifications.map(() => 400),
      borderColor: '#e43316', backgroundColor: 'transparent', borderWidth: 1.5, segment: { borderDash: () => [6, 4] },
      tension: 0, fill: false, pointRadius: 0, pointHoverRadius: 0 }); }

    if (defenseChartInstance) defenseChartInstance.destroy();
    defenseChartInstance = new Chart(ctx, {
      type: 'line', data: { labels: qualifications, datasets },
      plugins: [{ id: 'crossLabel', afterDatasetsDraw(chart) {
        if (maxDamage < 400) return;
        const visibleDs = chart.data.datasets.map((ds, i) => ({ ds, i, meta: chart.getDatasetMeta(i) }))
          .filter(({ ds, meta }) => ds.label !== '斩杀线(400)' && !meta.hidden);
        if (visibleDs.length === 0 || visibleDs.length > 3) return;
        const c = chart.ctx;
        visibleDs.forEach(({ ds, i }) => { let crossIdx = -1;
          for (let j = ds.data.length - 1; j >= 0; j--) { if (ds.data[j] >= 400) { crossIdx = j; break; } }
          if (crossIdx === -1) return; const meta = chart.getDatasetMeta(i); const pt = meta.data[crossIdx]; if (!pt) return;
          const qual = qualifications[crossIdx]; c.save(); c.font = 'bold 12px sans-serif'; c.fillStyle = ds.borderColor;
          c.strokeStyle = 'white'; c.lineWidth = 3; c.textAlign = 'center'; const text = `资质${qual}`;
          c.strokeText(text, pt.x, pt.y - 12); c.fillText(text, pt.x, pt.y - 12);
          c.beginPath(); c.arc(pt.x, pt.y, 5, 0, Math.PI * 2); c.fillStyle = ds.borderColor; c.fill(); c.restore(); });
      }}],
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, position: 'top', labels: { font: { size: 13 },
          generateLabels(chart) { const defaults = Chart.defaults.plugins.legend.labels.generateLabels(chart);
            defaults.forEach(item => { if (item.text === '斩杀线(400)') item.lineDash = [6, 4]; }); return defaults; } }},
          tooltip: { filter: item => item.dataset.label !== '斩杀线(400)', callbacks: {
            title: ctx => '防御资质: ' + ctx[0].label, label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}` } } },
        scales: { x: { title: { display: true, text: '防御资质', font: { size: 14, weight: 'bold' } }, ticks: { stepSize: 5 } },
          y: { title: { display: true, text: '造成的伤害', font: { size: 14, weight: 'bold' } }, beginAtZero: true, ticks: { stepSize: 10 } } } }
    });
  }

  function renderAttackChart() {
    const canvas = document.getElementById('defenseChart'); if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const s2 = dmgState();
    const attacker = s2.atkPet; const defender = s2.defPet;
    if (!attacker || !defender) return;

    const sliderValue = parseInt(document.getElementById('chartPowerSlider').value) || 200;
    const critMult = chartCritActive === 1 ? 2 : chartCritActive === 2 ? 0.5 : 1;
    const sameTypeMult = chartSameTypeActive ? 1.25 : 1.0;
    const skillType = chartAtkType;
    const defQualKey = skillType === 'attack' ? 'defense' : 'magic_defense';
    const defQualVal = getBaseStat(defender, defQualKey) || 0;
    const hpQualVal = getBaseStat(defender, 'hp') || 0;

    const hpIVActive = document.getElementById('chartHPIVBtn').classList.contains('active-iv');
    const hpNatureInt = parseInt(document.getElementById('chartHPNatureBtn').dataset.nature || '0');
    const hpNatureMod = hpNatureInt === 1 ? 1.2 : hpNatureInt === 2 ? 0.9 : 1.0;
    function calcHP(ivEnabled, natureMod) { const ivVal = ivEnabled ? 10 : 0;
      const step1 = Math.round(1.7 * (hpQualVal + 3 * ivVal)); const step2 = step1 + 70;
      const step3 = Math.round(step2 * natureMod); return step3 + 100; }
    const defenderHP = calcHP(hpIVActive, hpNatureMod);

    const critStr = chartCritActive === 1 ? ' ×2克制' : chartCritActive === 2 ? ' ×0.5抵抗' : '';
    const sameTypeStr = chartSameTypeActive ? ' ×1.25本系' : '';
    const atkTypeStr = skillType === 'attack' ? '物攻' : '魔攻';
    let xLabels, xAxisTitle, fixedLabel, fixedValue;
    if (!chartAxisSwapped) { xLabels = []; for (let q = 80; q <= 200; q += 2) xLabels.push(q);
      xAxisTitle = '攻击资质'; fixedLabel = '技能威力'; fixedValue = sliderValue; }
    else { xLabels = []; for (let p = 0; p <= 600; p += 6) xLabels.push(p);
      xAxisTitle = '技能威力'; fixedLabel = '攻击资质'; fixedValue = sliderValue; }

    const currentQualification = !chartAxisSwapped
      ? (skillType === 'attack' ? getBaseStat(attacker, 'attack') : getBaseStat(attacker, 'magic_attack')) : sliderValue;

    const infoElement = document.getElementById('chartInfo');
    infoElement.textContent = `防守方：${getPetName(defender)} | ${defQualKey === 'defense' ? '物防' : '魔防'}资质：${defQualVal} | 生命资质：${hpQualVal} | 当前生命：${defenderHP} | ${fixedLabel}：${fixedValue}${critStr}${sameTypeStr} | ${atkTypeStr}`;

    const qualifications = xLabels;
    const colors = { base: {border:'#11998e',bg:'rgba(17,153,142,0.08)'}, iv: {border:'#e67e22',bg:'rgba(230,126,34,0.08)'},
      naturePlus: {border:'#3d7e1b',bg:'rgba(61,126,27,0.08)'}, natureMinus: {border:'#c0392b',bg:'rgba(192,57,43,0.08)'},
      ivNatPlus: {border:'#9b59b6',bg:'rgba(155,89,182,0.08)'}, ivNatMinus: {border:'#d35400',bg:'rgba(211,84,0,0.08)'},
      atkIVDef: {border:'#8e44ad',bg:'rgba(142,68,173,0.08)'} };

    function makeDs(label, data, color, hidden = false) {
      return { label, data, hidden, borderColor: color.border, backgroundColor: color.bg,
        borderWidth: 2, tension: 0.2, cubicInterpolationMode: 'monotone', fill: false,
        pointRadius: c => Math.abs(c.parsed.x - currentQualification) <= 3 ? 6 : 2,
        pointBackgroundColor: c => Math.abs(c.parsed.x - currentQualification) <= 3 ? '#e43316' : color.border };
    }

    const atkIVActive2 = document.getElementById('chartAtkIVBtn2').classList.contains('active-iv');
    const atkNatureInt2 = parseInt(document.getElementById('chartAtkNatureBtn2').dataset.nature || '0');
    const defIVActive2 = document.getElementById('chartDefIVBtn2').classList.contains('active-iv');
    const atkNatureMod2 = atkNatureInt2 === 1 ? 1.2 : atkNatureInt2 === 2 ? 0.9 : 1.0;
    const natStr = atkNatureInt2 === 2 ? '-性格' : '+性格';
    const defStat_base = calcStatFromQual(defQualVal, false, 1.0);
    const defStat_iv = calcStatFromQual(defQualVal, true, 1.0);

    function dmgLine(atkIV, atkNat, defStatVal) {
      return qualifications.map(q => { let dmg;
        if (!chartAxisSwapped) { const atkStat = calcStatFromQual(q, atkIV, atkNat);
          const effectivePower = Math.floor(fixedValue * sameTypeMult); dmg = calcDamageForAttack(atkStat, effectivePower, defStatVal); }
        else { const atkStat = calcStatFromQual(fixedValue, atkIV, atkNat);
          const effectivePower = Math.floor(q * sameTypeMult); dmg = calcDamageForAttack(atkStat, effectivePower, defStatVal); }
        return dmg * critMult;
      });
    }

    const allActive2 = atkIVActive2 && atkNatureInt2 !== 0 && defIVActive2;
    let datasets;
    if (allActive2) {
      datasets = [
        makeDs('基础', dmgLine(false, 1.0, defStat_base), colors.base, false),
        makeDs('攻+个体', dmgLine(true, 1.0, defStat_base), colors.iv, true),
        makeDs(`攻+个体${natStr}`, dmgLine(true, atkNatureMod2, defStat_base), colors.ivNatPlus, true),
        makeDs('防+个体', dmgLine(false, 1.0, defStat_iv), colors.natureMinus, true),
        makeDs('攻+个体/防+个体', dmgLine(true, 1.0, defStat_iv), colors.atkIVDef, true),
        makeDs(`攻+个体${natStr}/防+个体`, dmgLine(true, atkNatureMod2, defStat_iv), colors.ivNatMinus, true),
      ];
    } else {
      datasets = [makeDs('基础', dmgLine(false, 1.0, defStat_base), colors.base)];
      if (defIVActive2) datasets.push(makeDs('防+个体', dmgLine(false, 1.0, defStat_iv), colors.natureMinus));
      if (atkIVActive2) { datasets.push(makeDs('攻+个体', dmgLine(true, 1.0, defStat_base), colors.iv));
        if (defIVActive2) datasets.push(makeDs('攻+个体/防+个体', dmgLine(true, 1.0, defStat_iv), colors.atkIVDef)); }
      if (atkNatureInt2 !== 0) { const ivNatColor = atkNatureInt2 === 1 ? colors.ivNatPlus : colors.ivNatMinus;
        if (atkIVActive2) { datasets.push(makeDs(`攻+个体${natStr}`, dmgLine(true, atkNatureMod2, defStat_base), ivNatColor));
          if (defIVActive2) datasets.push(makeDs(`攻+个体${natStr}/防+个体`, dmgLine(true, atkNatureMod2, defStat_iv), colors.ivNatMinus)); } }
    }

    const maxDamage = Math.max(...datasets.map(d => Math.max(...d.data)));
    const killLine = defenderHP;
    if (maxDamage >= killLine) { datasets.push({ label: `斩杀线(${killLine})`, data: qualifications.map(() => killLine),
      borderColor: '#e43316', backgroundColor: 'transparent', borderWidth: 1.5, segment: { borderDash: () => [6, 4] },
      tension: 0, fill: false, pointRadius: 0, pointHoverRadius: 0 }); }

    if (defenseChartInstance) defenseChartInstance.destroy();
    defenseChartInstance = new Chart(ctx, {
      type: 'line', data: { labels: qualifications, datasets },
      plugins: [{ id: 'crossLabel', afterDatasetsDraw(chart) {
        if (maxDamage < killLine) return;
        const visibleDs = chart.data.datasets.map((ds, i) => ({ ds, i, meta: chart.getDatasetMeta(i) }))
          .filter(({ ds, meta }) => !ds.label.startsWith('斩杀线') && !meta.hidden);
        if (visibleDs.length === 0 || visibleDs.length > 3) return;
        const c = chart.ctx;
        visibleDs.forEach(({ ds, i }) => { let crossIdx = -1;
          for (let j = 0; j < ds.data.length; j++) { if (ds.data[j] >= killLine) { crossIdx = j; break; } }
          if (crossIdx === -1) return; const meta = chart.getDatasetMeta(i); const pt = meta.data[crossIdx]; if (!pt) return;
          const qual = qualifications[crossIdx]; c.save(); c.font = 'bold 12px sans-serif'; c.fillStyle = ds.borderColor;
          c.strokeStyle = 'white'; c.lineWidth = 3; c.textAlign = 'center';
          const label = chartAxisSwapped ? `威力:${qual}` : `资质${qual}`;
          c.strokeText(label, pt.x, pt.y - 12); c.fillText(label, pt.x, pt.y - 12);
          c.beginPath(); c.arc(pt.x, pt.y, 5, 0, Math.PI * 2); c.fillStyle = ds.borderColor; c.fill(); c.restore(); });
      }}],
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, position: 'top', labels: { font: { size: 13 },
          generateLabels(chart) { const d = Chart.defaults.plugins.legend.labels.generateLabels(chart);
            d.forEach(item => { if (item.text.startsWith('斩杀线')) item.lineDash = [6, 4]; }); return d; } }},
          tooltip: { filter: item => !item.dataset.label.startsWith('斩杀线'), callbacks: {
            title: ctx => (chartAxisSwapped ? '技能威力: ' : '攻击资质: ') + ctx[0].label,
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y}` } } },
        scales: { x: { title: { display: true, text: xAxisTitle, font: { size: 14, weight: 'bold' } }, ticks: { stepSize: chartAxisSwapped ? 60 : 5 } },
          y: { title: { display: true, text: '造成的伤害', font: { size: 14, weight: 'bold' } }, beginAtZero: true, ticks: { stepSize: 10 } } } }
    });
  }

  return { render };
})();