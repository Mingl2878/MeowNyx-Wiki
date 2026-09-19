/** Game glossary table. Shares the petdex search/table appearance, not its monster-specific behavior. */
(function (global, factory) {
  const api = factory(global);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global.document) global.GameDescriptionPage = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
  'use strict';
  const state = { query: '', scrollTop: 0, scrollLeft: 0 };
  let cleanup = null;

  function filterEntries(entries, query = '') {
    const needle = String(query).trim().toLocaleLowerCase();
    return entries.filter(entry => !needle || [entry.name, entry.category, entry.attribute || '', entry.description]
      .some(value => String(value).toLocaleLowerCase().includes(needle)));
  }

  function attributeIcon(attribute, data = typeof RKData !== 'undefined' ? RKData : global.RKData) {
    if (!data?.getTypeIcon) throw new Error('请先加载属性图标映射');
    const label = attribute || '无属性';
    const type = attribute ? data.getTypeEn(String(attribute).replace(/系$/, '')) : 'None';
    const known = type === 'None' || data.PILL_ORDER.includes(type);
    // Only recognized local type paths; unknown text must never become an image URL.
    return { label, type: known ? type : 'None', src: data.getTypeIcon(known ? type : 'None') };
  }

  function render(container) {
    onLeave();
    const doc = container.ownerDocument;
    const glossary = global.GameGlossary;
    if (!glossary) throw new Error('请先加载 GameGlossary 并等待 init()');
    const entries = glossary.getEntries();
    const make = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    };
    const page = make('section', 'petdex-page-layout game-description-page');
    page.setAttribute('aria-label', '游戏描述');
    const controls = make('div', 'filter-panel game-description-toolbar');
    const searchWrap = make('div', 'petdex-search-wrap game-description-search-wrap');
    const search = make('input', 'search-bar game-description-search');
    search.type = 'text';
    search.placeholder = '名称、类别、属性或效果…';
    search.setAttribute('aria-label', '搜索游戏描述');
    search.setAttribute('autocomplete', 'off');
    search.value = state.query;
    searchWrap.appendChild(search);
    const count = make('p', 'game-description-count');
    count.setAttribute('role', 'status');
    count.setAttribute('aria-live', 'polite');
    controls.append(searchWrap, count);

    const scrollHost = make('div', 'scroll-wrapper-container');
    const list = make('div', 'data-table-wrapper hide-scrollbar game-description-list');
    list.tabIndex = 0;
    list.setAttribute('aria-label', '游戏描述表格，可滚动');
    const table = make('table', 'data-table game-description-table');
    table.setAttribute('aria-label', '游戏描述');
    const cols = make('colgroup');
    for (const key of ['name', 'category', 'attribute', 'effect']) cols.appendChild(make('col', 'game-description-col-' + key));
    const thead = make('thead'), headRow = make('tr');
    for (const title of ['名称', '类别', '属性', '效果']) {
      const th = make('th', '', title); th.setAttribute('scope', 'col'); headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = make('tbody');
    table.append(cols, thead, tbody); list.appendChild(table); scrollHost.appendChild(list);

    function update(resetScroll = true) {
      const visible = filterEntries(entries, state.query);
      count.textContent = `显示 ${visible.length} / ${entries.length} 条`;
      const fragment = doc.createDocumentFragment();
      for (const entry of visible) {
        const row = make('tr', 'game-description-entry');
        row.dataset.glossaryId = entry.id;
        const attribute = make('td', 'game-description-attribute');
        const icon = attributeIcon(entry.attribute);
        attribute.setAttribute('aria-label', icon.label);
        attribute.setAttribute('title', entry.attribute || '无属性（使用普通系图标）');
        const image = make('img', 'game-description-attribute-icon');
        image.setAttribute('src', icon.src);
        image.setAttribute('alt', ''); // The cell supplies the original semantic attribute label.
        image.setAttribute('loading', 'lazy');
        image.setAttribute('width', '22'); image.setAttribute('height', '22');
        attribute.appendChild(image);
        row.append(make('td', 'game-description-name', entry.name),
          make('td', 'game-description-category', entry.category), attribute,
          make('td', 'game-description-body', entry.description));
        fragment.appendChild(row);
      }
      if (!visible.length) {
        const row = make('tr'), cell = make('td', 'game-description-empty', '没有匹配的词条，请调整关键词。');
        cell.colSpan = 4; row.appendChild(cell); fragment.appendChild(row);
      }
      tbody.replaceChildren(fragment);
      if (resetScroll) { list.scrollTop = 0; list.scrollLeft = 0; state.scrollTop = 0; state.scrollLeft = 0; }
    }
    let composing = false;
    const applySearch = () => {
      if (state.query === search.value) return;
      state.query = search.value; update();
    };
    const onSearch = event => { if (!composing && !event.isComposing) applySearch(); };
    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => { composing = false; applySearch(); };
    search.addEventListener('input', onSearch);
    search.addEventListener('compositionstart', onCompositionStart);
    search.addEventListener('compositionend', onCompositionEnd);
    page.append(controls, scrollHost);
    container.replaceChildren(page);
    update(false);
    list.scrollTop = state.scrollTop; list.scrollLeft = state.scrollLeft;
    const ui = typeof CommonUI !== 'undefined' ? CommonUI : global.CommonUI;
    let unregister = null;
    const dispose = () => {
      state.scrollTop = list.scrollTop; state.scrollLeft = list.scrollLeft;
      search.removeEventListener('input', onSearch);
      search.removeEventListener('compositionstart', onCompositionStart);
      search.removeEventListener('compositionend', onCompositionEnd);
      unregister?.(); unregister = null;
      if (cleanup === dispose) cleanup = null;
    };
    cleanup = dispose;
    unregister = ui?.registerCleanup?.(page, dispose);
  }

  function onLeave() { cleanup?.(); }
  return Object.freeze({ render, onLeave, filterEntries, attributeIcon });
});
