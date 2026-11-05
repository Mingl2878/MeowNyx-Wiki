'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readProjectData } = require('./catalog-read-fixture.cjs');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'js/data.js'), 'utf8'), context);
const data = vm.runInContext('RKData', context);
const monsters = readProjectData('monsters.json');
const heading = '本地补充（非官方图鉴原文）：';
const descriptionHtml = html => html.match(/<span class="detail-trait-desc">([\s\S]*?)<\/span>/)?.[1];
const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

for (const [id, name] of [[129, '兽花蕾'], [467, '星尘虫'], [468, '落星虫'], [469, '陨星虫'], [509, '猴麦仔'], [510, '音碟吼'], [646, '滴溜豚'], [647, '滴廿豚']]) {
  test(`${name}: only the displayed heading is omitted; every existing entry stays on its own line`, () => {
    const monster = structuredClone(monsters.find(m => m.id === id));
    assert.equal(monster.localized.zh.name, name);
    const before = JSON.stringify(monster);
    const source = monster.trait.localized.zh;
    const notes = monster._trait_notes;
    assert.ok(notes.includes('\n'), 'exercise the current multiline notes');
    const trait = data.getTraitInfo(monster);
    assert.equal(trait.name, source.name);
    assert.equal(trait.desc, source.description + '\n' + notes);
    assert.ok(!trait.desc.includes(heading));
    assert.deepEqual(trait.desc.split('\n'), [source.description, ...notes.split('\n')]);
    const html = data.buildTraitDetailHtml(trait.name, trait.desc);
    assert.equal(descriptionHtml(html), escapeText(trait.desc));
    assert.doesNotMatch(html, /<br\b/i, 'newlines remain text rather than injected HTML breaks');
    assert.equal(JSON.stringify(monster), before, 'presentation must not mutate source or notes');
  });
}

test('ball effects separated by commas stay on one logical line, not one line per effect', () => {
  const monster = monsters.find(m => m.id === 469);
  const noteLines = monster._trait_notes.split('\n');
  const multipleEffects = noteLines.filter(line => line.includes('，'));
  assert.ok(multipleEffects.length > 0, 'exercise existing multi-effect balls');
  const trait = data.getTraitInfo(monster);
  const renderedLines = descriptionHtml(data.buildTraitDetailHtml(trait.name, trait.desc)).split('\n');
  for (const line of multipleEffects) {
    assert.equal(renderedLines.filter(rendered => rendered === escapeText(line)).length, 1);
  }
});

test('all other monsters retain original description and local-note provenance', () => {
  for (const monster of monsters.filter(m => ![129, 467, 468, 469, 509, 510, 646, 647].includes(m.id))) {
    const before = JSON.stringify(monster);
    const source = monster.trait?.localized?.zh;
    const notes = typeof monster._trait_notes === 'string' ? monster._trait_notes : '';
    const trait = data.getTraitInfo(monster);
    const expected = monster.trait ? (source?.description || '') + (notes ? '\n' + heading + '\n' + notes : '') : '';
    assert.equal(trait.desc, expected, `unexpected description change for ${monster.id}`);
    assert.equal(JSON.stringify(monster), before);
  }
  // The current placeholder need not have notes: future local notes still need provenance.
  const placeholder = {
    id: 619, _trait_notes: '测试占位说明\n资料待确认',
    trait: { localized: { zh: { name: '资料待补充', description: '原始描述。' } } }
  };
  assert.equal(data.getTraitInfo(placeholder).desc, '原始描述。\n' + heading + '\n测试占位说明\n资料待确认');
});

test('heading exception is stable-ID scoped, not inferred from copied species or trait names', () => {
  for (const id of [129, 469]) {
    const original = monsters.find(m => m.id === id);
    const copy = { ...original, id: 999999 };
    assert.equal(data.getTraitInfo(copy).desc, original.trait.localized.zh.description + '\n' + heading + '\n' + original._trait_notes);
    const renamed = structuredClone(original);
    renamed.localized.zh.name = '改名';
    renamed.trait.localized.zh.name = '改名特性';
    assert.equal(data.getTraitInfo(renamed).desc, original.trait.localized.zh.description + '\n' + original._trait_notes);
  }
});

test('empty notes and absent traits keep their existing behavior', () => {
  for (const id of [129, 469, 619]) {
    for (const notes of [undefined, null, '', 0, []]) {
      const monster = { id, _trait_notes: notes, trait: { localized: { zh: { name: '特性', description: '原文。' } } } };
      assert.equal(data.getTraitInfo(monster).desc, '原文。');
    }
  }
  assert.equal(data.getTraitInfo(null).desc, '');
  assert.equal(data.getTraitInfo({ id: 129, _trait_notes: '不凭补充虚构特性' }).desc, '');
  assert.equal(data.buildTraitDetailHtml('', '描述'), '');
  assert.equal(descriptionHtml(data.buildTraitDetailHtml('特性', '')), undefined);
});

test('shared detail rendering safely escapes plain descriptions and notes without losing explicit newlines', () => {
  const description = '原文 <script>bad()</script> & 字面 &lt;br&gt;';
  const notes = '一：<img src=x onerror=bad()>\r\n二：甲，乙\n三："引号"与\'单引号\'';
  for (const id of [129, 469, 619]) {
    const monster = { id, _trait_notes: notes, trait: { localized: { zh: { name: '安全特性', description } } } };
    const trait = data.getTraitInfo(monster);
    const html = data.buildTraitDetailHtml(trait.name, trait.desc);
    const rendered = descriptionHtml(html);
    assert.equal(rendered, escapeText(trait.desc));
    assert.doesNotMatch(rendered, /[<>]/);
    assert.equal(rendered.split('\n').length, trait.desc.split('\n').length);
    assert.ok(rendered.includes('二：甲，乙'));
    assert.ok(rendered.includes('&amp;lt;br&amp;gt;'), 'literal entities are not treated as authored HTML');
  }
});

test('existing narrow shared description rule honors newlines and still allows natural wrapping', () => {
  const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
  const rules = [...css.matchAll(/\.detail-trait-desc\s*\{([^}]*)\}/g)];
  assert.equal(rules.length, 1, 'edit the existing rule instead of layering an override');
  assert.match(rules[0][1], /white-space:\s*pre-line\s*;/);
  assert.doesNotMatch(rules[0][1], /white-space:\s*(?:nowrap|pre)\s*;/);
});
