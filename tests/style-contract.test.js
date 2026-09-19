const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(m => m[1].trim().split(',').map(s => ({ selector: s.trim(), body: m[2] })));
const find = selector => rules.filter(r => r.selector === selector);

test('shared stylesheet contains no fallback row/group geometry', () => {
  for (const selector of ['.input-row', '.input-group', '.calc-root .input-row', '.calc-root .input-group']) {
    assert.equal(find(selector).length, 0, `Forbidden fallback: ${selector}`);
  }
});

test('skill rows have exactly one complete non-wrapping layout, not an override', () => {
  const entries = find('.skill-card .input-row');
  assert.equal(entries.length, 1);
  for (const declaration of [/display:\s*flex\s*;/, /gap:\s*15px\s*;/, /flex-wrap:\s*nowrap\s*;/]) assert.match(entries[0].body, declaration);
  assert.equal(find('.calc-root .skill-card .input-row').length, 0);
});

test('skill fields have exactly one shrinkable zero-minimum layout', () => {
  const entries = find('.skill-card .input-group');
  assert.equal(entries.length, 1);
  assert.match(entries[0].body, /flex:\s*1 1 0\s*;/);
  assert.match(entries[0].body, /min-width:\s*0\s*;/);
  assert.equal(find('.calc-root .skill-card .input-group').length, 0);
});

test('data editor owns its wrapping/120px layout under its own container', () => {
  const source = fs.readFileSync(path.join(root, 'js/pages/updatedata.js'), 'utf8');
  assert.match(source, /#ud-tab-content \.input-row\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(source, /#ud-tab-content \.input-group\s*\{[^}]*min-width:\s*120px;/);
  assert.match(source, /id="ud-tab-content"/);
});

test('deleted global card and forced statistic rules are not resurrected', () => {
  for (const selector of ['.card', '.card:hover', '.card.selected', '.card-grid', '.card-name', '.card-info', '.stat-value', '.calc-root .stat-label', '.calc-root .stat-value']) {
    assert.equal(find(selector).length, 0, `Deleted rule returned: ${selector}`);
  }
});

test('radio spacing has one definition and a scoped compact parameter, independent of order', () => {
  const base = find('.radio-group');
  const compact = find('.stats-title-row .stat-mode-group');
  assert.equal(base.length, 1);
  assert.equal(compact.length, 1);
  assert.match(base[0].body, /gap:\s*var\(--radio-group-gap,\s*15px\)\s*;/);
  assert.match(compact[0].body, /--radio-group-gap:\s*10px\s*;/);
  assert.doesNotMatch(compact[0].body, /(?:^|;)\s*(?:gap|column-gap|row-gap)\s*:/);
  assert.equal(find('.stat-mode-group').length, 0, 'the ineffective early gap rule must be deleted, not retained');
  assert.equal(rules.filter(r => /--radio-group-gap\s*:/.test(r.body)).length, 1);
});

test('orphaned legacy section headings and warning labels are absent', () => {
  for (const selector of ['.stats-section h4', '.stats-header-with-button h4', '.skill-section > h4', '.skill-section > label', '.calc-root .input-group label.warning-label', '.calc-root .input-group label.damage-reduction-label']) {
    assert.equal(find(selector).length, 0, `Unused rule returned: ${selector}`);
  }
});
