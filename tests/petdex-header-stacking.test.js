const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '');

// Static contracts, not a browser paint/hit-test simulator. Inspect every active
// stylesheet so a later override cannot hide the original conflicting rule.
const stylesheets = [...source('index.html').matchAll(/<link\b[^>]*href="(css\/[^"?]+\.css)(?:\?[^" ]*)?"/g)].map(match => match[1]);
const rules = stylesheets.flatMap(file => [...source(file).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
  file,
  selectors: match[1].trim().split(',').map(selector => selector.trim()),
  declarations: match[2].split(';').map(text => text.trim()).filter(Boolean).map(text => {
    const colon = text.indexOf(':');
    return [text.slice(0, colon).trim(), text.slice(colon + 1).trim()];
  })
})));
function rule(selector) {
  const matches = rules.filter(item => item.selectors.includes(selector));
  assert.equal(matches.length, 1, `${selector}: edit the original rule, do not append an override`);
  assert.equal(matches[0].file, 'css/style.css');
  return Object.fromEntries(matches[0].declarations);
}
function zDeclarations(token) {
  return rules.filter(item => item.selectors.some(selector => selector.includes(token)))
    .flatMap(item => item.declarations.filter(([property]) => property === 'z-index').map(([, value]) => value));
}

test('sticky column header keeps its existing layer instead of a global z-index escalation', () => {
  const header = rule('.data-table thead th');
  assert.equal(header.position, 'sticky');
  assert.equal(header.top, '0');
  assert.equal(header['z-index'], '10');
  assert.equal(header.background, 'var(--bg-tag)');
  assert.deepEqual(zDeclarations('.data-table thead th'), ['10']);
});

for (const selector of ['.form-toggle-arrow', '.trait-arrow']) {
  test(`${selector} stays above ordinary cell content but strictly below sticky headers`, () => {
    const arrow = rule(selector), header = rule('.data-table thead th');
    assert.equal(arrow.position, 'relative');
    assert.equal(arrow['z-index'], '1');
    assert.ok(Number(arrow['z-index']) > 0);
    assert.ok(Number(arrow['z-index']) < Number(header['z-index']), 'later tbody descendants must not tie or exceed the header');
    assert.deepEqual(zDeclarations(selector), ['1'], 'no stale high layer hidden behind a scoped/hover/theme override');
  });

  test(`${selector} retains triangle size, flex sizing and expanded pointer hit area`, () => {
    const arrow = rule(selector);
    for (const [property, value] of Object.entries({
      display: 'inline-block', 'font-size': '10px', 'flex-shrink': '0',
      padding: '12px 14px', margin: '-12px -14px', cursor: 'pointer',
      'user-select': 'none', 'text-align': 'center'
    })) assert.equal(arrow[property], value, `${selector} ${property}`);
    assert.equal(arrow['pointer-events'], undefined);
    assert.equal(arrow.overflow, undefined);
  });
}

test('production table places headers before ordinary form/trait cell descendants', () => {
  const code = source('js/pages/petdex.js');
  const table = code.match(/<table class="data-table" id="pet-table">([\s\S]*?)<\/table>/)?.[1];
  assert.ok(table);
  assert.match(table, /<thead>[\s\S]*?<th data-sort="dex_number">编号<\/th>\s*<th>精灵<\/th>\s*<th>属性<\/th>[\s\S]*?<\/thead>\s*<tbody id="pet-tbody"><\/tbody>/);
  assert.match(code, /cells\[1\]\.innerHTML = `<div class="pet-name-cell">[^`]*\$\{arrow\}<\/div>`/);
  assert.match(code, /<span class="form-toggle-arrow" data-petdex-action="form">/);
  assert.match(code, /<div class="detail-trait-box" data-petdex-action="trait"[^>]*>\s*<div class="detail-trait-head"><span class="trait-arrow">/);
});
