'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { runtime } = require('./selection-search-fixture.cjs');
const fixtures = () => {
  const members = [1, 2, 3, 4, 5, 6, 7, 9, 10];
  return [
    { id: 1, name: 'Root', evolution_members: members }, { id: 2, name: 'Branch', evolves_from_id: 1, evolution_members: members },
    { id: 3, name: 'Leaf', evolves_from_id: 2, evolution_members: members }, { id: 4, name: 'Sibling', evolves_from_id: 1, evolution_members: members },
    { id: 5, name: 'Leaf', displayName: 'Leaf (form)', evolves_from_id: 3, evolution_members: members },
    { id: 6, name: 'Hidden', hidden: true, evolves_from_id: 1, evolution_members: members },
    { id: 7, name: 'Beyond hidden', evolves_from_id: 6, evolution_members: members },
    { id: 8, name: 'Root', evolution_chain_name: 'Root', evolution_members: [8] }, // unrelated identical name
    { id: 9, name: 'Disallowed', evolves_from_id: 1, evolution_members: members },
    { id: 10, name: 'Beyond filter', evolves_from_id: 9, evolution_members: members }
  ];
};

test('explicit 221/222/223 members reopen other entries with stable IDs', () => {
  const catalogue = [221, 222, 223].map(id => ({ id, name: 'Fixture ' + id, evolution_members: [221, 222, 223] }));
  const h = runtime(catalogue), box = h.box();
  for (const id of [221, 222, 223]) {
    box.setValue(h.RKData.getMonsterDisplayName(h.RKData.getMonsterById(id)), h.RKData.getMonsterById(id));
    box.input.click();
    assert.deepEqual(h.ids(box), [221, 222, 223].filter(other => other !== id));
  }
});

test('explicit branches/forms filter outputs, deduplicate IDs and never infer from names', () => {
  const monsters = fixtures(), before = JSON.stringify(monsters), h = runtime(monsters);
  const box = h.box({ filter: m => m.id !== 9 });
  h.type(box, 'Leaf'); h.pick(box, 3); box.input.click();
  assert.deepEqual(h.ids(box), [1, 2, 4, 5, 7, 10]);
  assert.equal(JSON.stringify(monsters), before);
  h.pick(box, 5); box.input.click(); assert.deepEqual(h.ids(box), [1, 2, 3, 4, 7, 10]);
  h.pick(box, 1); box.input.click(); assert.ok(!h.ids(box).includes(8));
  // Duplicate labels identify different components; never pick the first name match on reopen.
  h.type(box, 'Root'); h.pick(box, 8); box.input.click(); assert.deepEqual(h.ids(box), []);
  assert.equal(box.dropdown.style.display, 'none');
});

test('asymmetric members retain source order without closure, skip missing/hidden IDs, and read live edits', () => {
  const monsters = [
    { id: 1, name: 'a', evolves_from_id: 2, evolution_members: [3, 2, 1, 3, 999, 4] },
    { id: 2, name: 'b', evolves_from_id: 1, evolution_members: [2, 5] },
    { id: 3, name: 'c', evolution_members: [3] }, { id: 4, name: 'hidden', hidden: true, evolution_members: [1, 5] },
    { id: 5, name: 'c', dex_number: 1, evolution_members: [] }
  ];
  const h = runtime(monsters), box = h.box();
  box.setValue('a', monsters[0]); box.input.click(); assert.deepEqual(h.ids(box), [3, 2]);
  h.pick(box, 2); box.input.click(); assert.deepEqual(h.ids(box), [5], 'no reverse or transitive membership');
  monsters[1].evolution_members = [3]; box.input.click(); assert.deepEqual(h.ids(box), [3]);
  box.setValue('c', monsters[2]); box.input.click(); assert.deepEqual(h.ids(box), [], 'self-only does not restore parents');
});

test('absent/empty members never restore even valid parent, child, same-dex or same-name links', () => {
  const monsters = [
    { id: 1, name: 'same', dex_number: 1, evolves_from_id: 2 },
    { id: 2, name: 'same', dex_number: 1, evolves_from_id: 1, evolution_members: [] },
    { id: 3, name: 'self', evolves_from_id: 1, evolution_members: [3] },
    { id: 4, name: 'missing-parent', evolves_from_id: 999 },
    { id: 5, name: 'self-parent', evolves_from_id: 5 }
  ];
  const h = runtime(monsters), box = h.box();
  for (const monster of monsters) { box.setValue(monster.name, monster); box.input.click(); assert.deepEqual(h.ids(box), []); }
});

test('typing restores original substring/chain/form matching, no normal monster limit10', () => {
  const monsters = fixtures().concat(Array.from({ length: 18 }, (_, i) => ({ id: 100 + i, name: 'Normal ' + i })));
  monsters.push({ id: 200, name: 'Bird', displayName: 'Bird variant', evolution_chain_name: 'Flock', form: 'winter', main_form_name: 'winter' });
  const h = runtime(monsters), box = h.box({ limit: 10 });
  box.setValue('Root', monsters[0]); box.input.click();
  h.type(box, ' NORMAL '); assert.equal(h.ids(box).length, 18);
  h.type(box, 'Flock(winter)'); assert.deepEqual(h.ids(box), [200]);
  h.type(box, 'Flock(summer)'); assert.deepEqual(h.ids(box), []);
  h.type(box, 'Leaf'); assert.deepEqual(h.ids(box), [3, 5]);
  // Editing text invalidates the prior selection even when it matches the old label again.
  h.type(box, 'Root'); box.input.click(); assert.deepEqual(h.ids(box), [1, 8]);
  h.type(box, ''); assert.equal(box.dropdown.style.display, 'none');
});

test('already-focused click, word selection, Escape/keyboard reopen do not emit input or recursively select', () => {
  const h = runtime(fixtures()); let inputs = 0, selections = 0, textSelections = 0;
  const box = h.box({ onInput: () => inputs++, onSelect: () => selections++ });
  box.input.addEventListener('click', function () { this.select(); }); // damage caller contract
  box.input.addEventListener('select', () => textSelections++);
  box.input.focus(); h.type(box, 'Leaf'); h.pick(box, 3);
  assert.equal(h.document.activeElement, box.input);
  box.input.click(); assert.deepEqual(h.ids(box), [1, 2, 4, 5, 7, 9, 10]);
  box.input.click(); assert.equal(textSelections, 2);
  assert.equal(box.input.selectionEnd, box.input.value.length);
  assert.equal(inputs, 1); assert.equal(selections, 1);
  h.key(box, 'Escape'); assert.equal(box.dropdown.style.display, 'none');
  box.input.click(); assert.ok(h.ids(box).length);
  h.key(box, 'Escape'); h.key(box, 'ArrowDown'); h.key(box, 'Enter');
  assert.equal(box.getValue(), 'Root'); assert.equal(selections, 2); assert.equal(inputs, 1);
  assert.equal(box.dropdown.style.display, 'none');
  h.key(box, 'ArrowUp'); assert.ok(h.ids(box).length);
});

test('explicit setValue and onInput auto-pick track ID; label-only echoes preserve but never guess identity', () => {
  const monsters = fixtures(), h = runtime(monsters); let picks = 0;
  const box = h.box({ onInput: value => { if (value === 'Root') box.setValue(value, monsters[7]); }, onSelect: () => picks++ });
  h.type(box, 'Root'); box.input.click(); assert.deepEqual(h.ids(box), []); // selected duplicate ID8, not ID1
  box.setValue('Root', monsters[0]); box.setValue('Root'); box.input.click(); assert.ok(h.ids(box).includes(2));
  box.setValue('Leaf'); box.input.click(); assert.deepEqual(h.ids(box), [3, 5]); // changed text is not selection
  assert.equal(picks, 0);
  const editorBox = h.box({ onSelect: pet => editorBox.setValue(h.RKData.getMonsterDisplayName(pet)) });
  h.type(editorBox, 'Leaf'); h.pick(editorBox, 3); editorBox.input.click(); assert.ok(h.ids(editorBox).includes(1));
});

test('custom skill search retains its query, limit, callback and ID contract, never monster-family behavior', () => {
  const h = runtime(fixtures()); let selected;
  const skills = Array.from({ length: 14 }, (_, i) => ({ id: 'skill-' + i, name: 'Skill ' + i }));
  const box = h.box({ search: kw => skills.filter(s => s.name.toLowerCase().includes(kw)), onSelect: item => { selected = item.id; }, limit: 10 });
  h.type(box, 'skill'); assert.equal(box.dropdown.children.length, 10);
  box.dropdown.children[0].children[0].click(); assert.equal(selected, 'skill-0');
  box.input.click(); assert.equal(box.dropdown.children.length, 1);
  assert.equal(box.dropdown.children[0].dataset.itemId, 'skill-0');
});

test('IME navigation does not select candidates; blur/refocus and cleanup retain existing layer lifecycle', () => {
  const h = runtime(fixtures()); let picks = 0;
  const box = h.box({ onSelect: () => picks++ });
  box.input.focus(); h.type(box, 'Leaf');
  box.input.emit('compositionstart'); h.type(box, 'Root');
  h.key(box, 'ArrowDown', { isComposing: true }); h.key(box, 'Enter', { isComposing: true });
  assert.equal(picks, 0); assert.equal(box.dropdown.style.display, 'none');
  box.input.emit('compositionend'); h.type(box, 'Root'); assert.deepEqual(h.ids(box), [1, 8]);
  h.pick(box, 1); box.input.click();
  box.input.emit('blur'); box.input.emit('focus'); h.runTimers(); assert.ok(h.ids(box).length);
  h.document.emit('pointerdown', { target: h.document.body }); assert.equal(box.dropdown.style.display, 'none');
  box.input.click(); h.window.emit('resize'); assert.equal(box.dropdown.style.display, 'none');
  box.input.click(); h.api.destroyWithin(box.wrapper); assert.equal(h.document.count(), 0); assert.equal(h.window.count(), 0);
  box.input.click(); h.type(box, 'Leaf'); assert.equal(box.dropdown.style.display, 'none'); assert.equal(picks, 1);
});
