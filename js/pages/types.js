/** Attribute relations: one structured result for the grid, categories and clipboard. */
const TypeTools = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // Encode path segments, not the query delimiter added by RKData for cache versions.
  function imagePath(value) {
    const raw = String(value || '');
    if (!raw || /^(?:[a-z]+:|\/\/)/i.test(raw) || raw.includes('\\')) return '';
    const at = raw.search(/[?#]/);
    const path = at < 0 ? raw : raw.slice(0, at);
    const suffix = at < 0 ? '' : raw.slice(at);
    if (path.split('/').some(p => { try { return ['.', '..'].includes(decodeURIComponent(p)); } catch (_) { return false; } })) return '';
    return path.split('/').map(p => {
      try { return encodeURIComponent(decodeURIComponent(p)); } catch (_) { return encodeURIComponent(p); }
    }).join('/') + suffix;
  }
  function pool(data) {
    const byId = new Map();
    for (const m of data.getMonsters()) {
      if (m.hidden || m.is_leader_form || m.evolution_stage === '基础形态' || m.id == null) continue;
      // IDs are identities. Shared dex numbers must not collapse distinct forms.
      if (!byId.has(String(m.id))) byId.set(String(m.id), m);
    }
    return [...byId.values()];
  }
  function build(data, mode, selection) {
    mode = mode === 'defense' ? 'defense' : 'attack';
    const allowed = new Set(data.ALL_TYPES.map(t => data.getTypeEn(t)));
    const selected = [...new Set(selection.map(t => data.getTypeEn(t)).filter(t => allowed.has(t)))];
    const label = t => data.getTypeZhFull(data.getTypeZh(t));
    const grid = data.ALL_TYPES.map(type => {
      const effects = selected.map(s => ({ type: s, label: label(s), value: mode === 'attack' ? data.getTypeEff(s, type) : data.getTypeEff(type, s) }));
      // Defense classification retains the existing multi-selected-type score rule.
      const score = effects.reduce((n, e) => n + (e.value >= 2 ? 1 : e.value <= .5 ? -1 : 0), 0);
      const value = score >= 2 ? 3 : score === 1 ? 2 : score <= -2 ? .25 : score === -1 ? .5 : 1;
      return { type, label: label(type), effects, value };
    });
    const definitions = mode === 'attack'
      ? [['effective','克制属性 (×2)','green'],['resisted','抵抗属性 (×0.5)','red'],['neutral','无法克制属性 (×1)','gray']]
      : [['triple','三倍弱点 (×3)','red'],['double','双倍弱点 (×2)','orange'],['half','半倍抵抗 (×0.5)','blue'],['quarter','四倍抵抗 (×0.25)','green'],['neutral','正常效果 (×1)','gray']];
    const categories = definitions.map(([key, title, color]) => ({key,title,color,items:[]}));
    if (selected.length) for (const entry of grid) {
      const key = mode === 'attack'
        ? entry.effects.some(e => e.value >= 2) ? 'effective' : entry.effects.every(e => e.value <= .5) ? 'resisted' : 'neutral'
        : ({3:'triple',2:'double',0.5:'half',0.25:'quarter',1:'neutral'})[entry.value];
      categories.find(c => c.key === key).items.push(entry);
    }
    const monsters = mode !== 'attack' || !selected.length ? [] : pool(data).map(m => {
      const types = [m.main_type?.name, m.sub_type?.name].filter(t => t && t !== 'None');
      const effects = selected.map(t => ({type:t, label:label(t), value:data.getTypeEff(t, types[0], types[1])}));
      return {id:m.id,name:data.getMonsterDisplayName(m),image:m.image ? imagePath('assets/monster/images/' + m.image) : '',effects,total:data.getTotalStats(m),hasTypes:types.length > 0};
    }).filter(m => m.hasTypes && (selected.length === 1 ? m.effects[0].value === .25 : m.effects.every(e => e.value <= .5)))
      .sort((a,b) => b.total-a.total || String(a.id).localeCompare(String(b.id), undefined, {numeric:true}));
    // Count each monster once: any quarter resistance wins; otherwise every attack must be half.
    const resistanceCounts = [.5,.25].map(value => ({value,count:monsters.filter(m => value === .25
      ? m.effects.some(e => e.value === .25) : m.effects.every(e => e.value === .5)).length})).filter(c => c.count);
    return {mode, selected:selected.map(type => ({type,label:label(type)})),grid,categories,monsters,resistanceCounts};
  }
  function mapping(effects) { return effects.map(e => `${e.label}×${e.value}`).join('；'); }
  function monsterLabel(m) { return `${m.name}；${mapping(m.effects)}`; }
  function resistanceTitle(model) {
    if (model.selected.length === 1) return `x0.25倍 抵抗精灵（共${model.monsters.length}只）`;
    const detail = model.resistanceCounts.map(c => `${c.count}只×${c.value}`).join('丨');
    return `抵抗精灵（共${model.monsters.length}只${detail ? '丨' + detail : ''}）`;
  }
  function text(model, includeMonsters) {
    const lines = [`${model.mode === 'attack' ? '进攻方' : '防守方'}：${model.selected.map(s => s.label).join('、') || '未选择'}`];
    if (!model.selected.length) return lines.join('\n') + '\n请选择属性';
    for (const c of model.categories) lines.push(`${c.title} (${c.items.length})：${c.items.map(e => e.label).join('、') || '—'}`);
    if (model.mode === 'attack' && includeMonsters) {
      lines.push(resistanceTitle(model));
      lines.push(...(model.monsters.length ? model.monsters.map(monsterLabel) : ['—']));
    }
    return lines.join('\n');
  }
  function ring(effects) {
    return effects.length ? `conic-gradient(${effects.map((e,i) => `${e.value === .25 ? 'var(--type-tools-ring-red)' : 'var(--type-tools-ring-neutral)'} ${i*360/effects.length}deg ${(i+1)*360/effects.length}deg`).join(',')})` : 'none';
  }
  return {build,text,mapping,monsterLabel,resistanceTitle,ring,escape,imagePath,pool};
})();

const TypesPage = (() => {
  let mode = 'attack';
  const selections = {attack:[],defense:[]};
  let root = null, result = null, dispose = null;
  function onLeave() { if (dispose) dispose(); }
  function render(container) {
    onLeave();
    container.innerHTML = `<div class="type-calc-section scroll-container type-tools-page">
      <div class="type-tools-toolbar"><div class="tq-toggle-bar">
        <div class="tq-toggle-slider" id="toggle-slider"></div>
        <button type="button" class="tq-toggle-btn" id="mode-attack">进攻方</button>
        <button type="button" class="tq-toggle-btn" id="mode-defense">防守方</button>
      </div><button type="button" class="type-tools-copy" title="左键复制属性关系；右键包含抵抗精灵名单。Shift+Enter/空格同右键。">复制</button>
      <span class="type-tools-status" role="status" aria-live="polite"></span></div>
      <div class="type-calc-sub-hint" id="select-hint"></div>
      <div class="type-calc-grid" id="type-grid"></div>
      <div class="type-calc-sub type-tools-grid-section"><h4 id="grid-result-title"></h4><div class="type-calc-result-grid" id="grid-results"></div></div>
      <div class="type-calc-sub type-tools-list-section"><h4 id="list-result-title"></h4><div id="list-results"></div></div>
    </div>`;
    root = container.querySelector('.type-tools-page');
    const owner = root, listeners = [];
    const listen = (node,type,fn,options) => {node.addEventListener(type,fn,options);listeners.push(()=>node.removeEventListener(type,fn,options));};
    const esc = TypeTools.escape;
    const grid = root.querySelector('#type-grid');
    grid.innerHTML = RKData.ALL_TYPES.map(t => `<button type="button" class="tc-grid-icon" data-type="${esc(RKData.getTypeEn(t))}" aria-label="${esc(RKData.getTypeZhFull(t))}" aria-pressed="false"><img src="${esc(TypeTools.imagePath(RKData.getTypeIcon(t)))}" alt=""></button>`).join('');
    grid.querySelectorAll('[data-type]').forEach(button => listen(button,'click',()=>{
      const list=selections[mode], type=button.dataset.type, index=list.indexOf(type);
      if(index<0)list.push(type);else list.splice(index,1);
      refresh();
    }));
    for (const m of ['attack','defense']) listen(root.querySelector('#mode-'+m),'click',()=>{mode=m;refresh();});
    let live=true, busy=false, resetTimer=null;
    const button=root.querySelector('.type-tools-copy'), status=root.querySelector('.type-tools-status');
    async function copy(includeMonsters) {
      if(busy || !live)return;
      const snapshot=result;
      const payload=TypeTools.text(snapshot,includeMonsters);
      busy=true;button.setAttribute('aria-busy','true');clearTimeout(resetTimer);status.textContent='';delete status.dataset.state;
      try {
        if(!navigator.clipboard?.writeText)throw Error('系统剪贴板不可用');
        await navigator.clipboard.writeText(payload);
        if(!live)return;
        button.textContent='✓ 已复制';status.textContent='';
      } catch (_) {
        if(!live)return;
        button.textContent='复制';status.textContent='复制失败，请检查剪贴板权限后重试';status.dataset.state='error';
      } finally {
        if(live){busy=false;button.removeAttribute('aria-busy');resetTimer=setTimeout(()=>{button.textContent='复制';},2200);}
      }
    }
    listen(button,'click',()=>copy(false));
    listen(button,'contextmenu',event=>{event.preventDefault();copy(true);});
    listen(button,'mousedown',event=>{if(event.button===1)event.preventDefault();});
    listen(button,'auxclick',event=>{if(event.button===1)event.preventDefault();});
    listen(button,'keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();if(!event.repeat)copy(event.shiftKey);}});
    listen(window,'resize',updateSlider);listen(window,'appfontchange',updateSlider);listen(window,'appzoomchange',updateSlider);
    let observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateSlider) : null;
    observer?.observe(root.querySelector('.tq-toggle-bar'));
    let unregister=()=>{};
    dispose=()=>{if(!live)return;live=false;clearTimeout(resetTimer);listeners.splice(0).forEach(fn=>fn());observer?.disconnect();observer=null;unregister();if(root===owner){root=null;result=null;dispose=null;}};
    if(typeof CommonUI!=='undefined' && CommonUI.registerCleanup)unregister=CommonUI.registerCleanup(owner,dispose);
    refresh();
  }
  function updateSlider() {
    if(!root)return;
    const slider=root.querySelector('#toggle-slider'), active=root.querySelector('#mode-'+mode);
    slider.style.width=active.offsetWidth+'px';slider.style.transform=`translateX(${active.offsetLeft}px)`;
  }
  function refresh() {
    if(!root)return;
    result=TypeTools.build(RKData,mode,selections[mode]);
    const esc=TypeTools.escape;
    for(const m of ['attack','defense']){
      const b=root.querySelector('#mode-'+m);b.classList.toggle('active',mode===m);b.setAttribute('aria-pressed',String(mode===m));
    }
    root.querySelector('#select-hint').textContent=mode==='attack'?'选择进攻属性':'选择防守属性';
    root.querySelector('#grid-result-title').textContent=mode==='attack'?'进攻属性克制效果':'防守属性被克制效果';
    root.querySelector('#list-result-title').textContent=mode==='attack'?'克制详情':'被克制详情';
    root.querySelectorAll('#type-grid [data-type]').forEach(b=>{const active=selections[mode].includes(b.dataset.type);b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    root.querySelector('#grid-results').innerHTML=result.grid.map(entry=>{
      const parts=entry.effects.map((e,i)=>`${e.value>=2?'#3d7e1b':e.value<=.5?'#e43316':'var(--bg-card)'} ${i*360/entry.effects.length}deg ${(i+1)*360/entry.effects.length}deg`);
      const bg=parts.length?`conic-gradient(${parts.join(',')})`:'var(--bg-card)';
      // Attack alternatives are never multiplied together in the title.
      const title=entry.label+'；'+(mode==='defense'&&result.selected.length?`合计：×${entry.value}；`:'')+TypeTools.mapping(entry.effects);
      return `<div class="tc-result-item" style="background:${bg}" title="${esc(title)}" aria-label="${esc(title)}"><img src="${esc(TypeTools.imagePath(RKData.getTypeIcon(entry.type)))}" alt="${esc(entry.label)}"></div>`;
    }).join('');
    root.querySelector('#list-results').innerHTML=result.categories.map(c=>`<div class="tq-category tq-cat-${c.color}" data-category="${c.key}"><div class="tq-cat-header">${esc(c.title)} (${c.items.length})</div><div class="tq-cat-list">${c.items.map(e=>`<div class="tq-result-item"><img src="${esc(TypeTools.imagePath(RKData.getTypeIcon(e.type)))}" alt=""><span>${esc(e.label)}</span></div>`).join('')||'<span class="type-tools-empty">—</span>'}</div></div>`).join('') + (mode==='attack'&&result.selected.length?`<div class="tq-category tq-cat-blue type-tools-resistance"><div class="tq-cat-header">${esc(TypeTools.resistanceTitle(result))}</div><div class="tq-monster-list">${result.monsters.map(m=>{
      const title=TypeTools.monsterLabel(m);
      return `<span class="type-tools-avatar" tabindex="0" data-monster-id="${esc(m.id)}" title="${esc(title)}" aria-label="${esc(title)}" style="--type-tools-ring:${TypeTools.ring(m.effects)}"><span class="type-tools-avatar-inner">${m.image?`<img src="${esc(m.image)}" alt="" loading="lazy">`:`<span>${esc(m.name.charAt(0))}</span>`}</span></span>`;
    }).join('')||'<span class="type-tools-empty">—</span>'}</div></div>`:'');
    updateSlider();
  }
  return {render,onLeave};
})();
