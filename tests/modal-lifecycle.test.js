'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime } = require('./modal-lifecycle-fixture.cjs');
const right = node => node.emit('contextmenu', { button: 2 });
const releaseRight = node => { node.emit('pointerdown', { button: 2 }); return node.emit('pointerup', { button: 2 }); };

test('real pet renderer survives queued child replacement/style records, all origins, and hide/reopen', async () => {
  const r = runtime();
  for (const petdex of [true, false]) {
    for (const selector of ['.detail-name', '.detail-skill-item', '.detail-skill-filter-btn', '.detail-pet-img', null]) {
      r.pet.showPetDetail(221, { petdex });
      await r.flush();
      assert.equal(r.modal.count('contextmenu'), 1, 'opening microtasks must not dispose visible root');
      const target = selector ? r.modal.querySelector(selector) : r.modal;
      assert.ok(target, selector);
      assert.equal(right(target).defaultPrevented, true);
      assert.equal(r.modal.style.display, 'none');
      await r.flush();
    }
  }
  r.pet.showPetDetail(221); await r.flush();
  const oldFilter = r.modal.querySelector('.detail-skill-filter-btn');
  r.pet.showPetDetail(221); await r.flush();
  assert.equal(oldFilter.isConnected, false);
  assert.equal(r.modal.count('contextmenu'), 1);
  r.document.emit('keydown', { key: 'Escape' }); await r.flush();
  r.pet.showPetDetail(221); await r.flush();
  assert.equal(right(r.modal.querySelector('.detail-skill-filter-btn')).defaultPrevented, true);
  r.pet.showPetDetail(221); await r.flush(); r.modal.click(); await r.flush();
  r.pet.showPetDetail(221); await r.flush(); assert.equal(right(r.modal).defaultPrevented, true);
  assert.ok(r.delivered.some(record => record.type === 'childList' && record.removedNodes.length));
  assert.ok(r.delivered.some(record => record.type === 'attributes' && record.attributeName === 'style'));
  assert.equal(r.document.count('contextmenu'), 0);
});

test('actual team avatar/slot entry opens fresh root after observer delivery without resetting equipped draft', async () => {
  const r = runtime(); r.team.seed();
  r.element('team-detail-body');
  r.team.renderDetail(); await r.flush();
  const before = r.team.state();
  for (const entry of ['#detail-pet-img-clickable', '.detail-skill-slot']) {
    for (const selector of ['.detail-skill-item[data-skill-source="血脉"]', '.detail-skill-filter-btn', '.detail-pet-img', '.team-skill-picker-overlay']) {
      r.document.querySelector(entry).click(); await r.flush();
      const modal = r.document.getElementById('team-skill-picker-modal');
      assert.ok(modal); assert.equal(modal.count('contextmenu'), 1);
      const target = modal.querySelector(selector); assert.ok(target, selector);
      assert.equal(right(target).defaultPrevented, true); await r.flush();
      assert.equal(modal.isConnected, false); assert.equal(modal.count('contextmenu'), 0);
      assert.equal(r.team.state(), before, 'right close must not reset config, skills, nature, IV or bloodline');
    }
  }
  r.team.openSkillPicker(); await r.flush(); const old = r.document.getElementById('team-skill-picker-modal');
  r.team.openSkillPicker(); await r.flush(); const current = r.document.getElementById('team-skill-picker-modal');
  assert.notEqual(current, old); assert.equal(old.count('contextmenu'), 0); assert.equal(current.count('contextmenu'), 1);
  old.querySelector('#team-skill-picker-close').click(); await r.flush(); assert.equal(current.isConnected, true);
  assert.equal(right(current).defaultPrevented, true); await r.flush(); assert.equal(r.team.state(), before);
  assert.equal(r.document.count('contextmenu'), 0);
});

test('contextmenu-only baseline does not fail on mutation delivery but cannot close when that notification is absent', async () => {
  const r = runtime(true); r.pet.showPetDetail(221); await r.flush();
  assert.equal(r.modal.count('contextmenu'), 1);
  assert.equal(r.modal.emit('pointerup', { button: 2 }).defaultPrevented, false);
  assert.equal(r.modal.style.display, 'flex', 'baseline has no release path; not an observer disposal');
  assert.equal(right(r.modal).defaultPrevented, true); assert.equal(r.modal.style.display, 'none');
});

test('scoped right-button release closes actual pet/team even without contextmenu and does not change drafts', async () => {
  const r = runtime(); r.team.seed(); const before = r.team.state();
  for (const page of ['petdex', 'learner-or-speed', 'team']) {
    for (const surface of ['filter', 'skill', 'input', 'select', 'backdrop']) {
      if (page === 'team') r.team.openSkillPicker(); else r.pet.showPetDetail(221, { petdex: page === 'petdex' });
      await r.flush();
      const root = page === 'team' ? r.document.getElementById('team-skill-picker-modal') : r.modal;
      const target = surface === 'filter' ? root.querySelector('.detail-skill-filter-btn') :
        surface === 'skill' ? root.querySelector('.detail-skill-item') :
          ['input', 'select'].includes(surface) ? r.element('native-' + surface, root, surface) : root;
      assert.ok(target); await r.flush();
      assert.equal(target.emit('pointerup', { button: 0 }).defaultPrevented, false);
      assert.equal(target.emit('pointerup', { button: 1 }).defaultPrevented, false);
      assert.equal(root.count('pointerup'), 1);
      assert.equal(releaseRight(target).defaultPrevented, true);
      await r.flush();
      r.runTimers(); // Missing native contextmenu must expire its temporary guard.
      assert.equal(root.count('pointerup'), 0); assert.equal(root.count('contextmenu'), 0);
      assert.equal(page === 'team' ? root.isConnected : root.style.display !== 'none', false);
      assert.equal(r.team.state(), before);
    }
  }
  assert.equal(r.document.count('pointerup'), 0); assert.equal(r.document.count('contextmenu'), 0);
});

test('right release and contextmenu share single nested close; confirmation release is cancellation and main page retains actions', async () => {
  const r = runtime(), outer = r.element('outer'), inner = r.element('inner', outer);
  const input = r.element('nested', inner, 'input'); let outerClosed = 0, innerClosed = 0, confirmed = 0;
  r.ui.bindModalContextMenu(outer, () => outerClosed++);
  r.ui.bindModalContextMenu(inner, () => { innerClosed++; inner.remove(); }); await r.flush();
  releaseRight(input); right(r.document.body); await r.flush();
  assert.equal(innerClosed, 1); assert.equal(outerClosed, 0); assert.equal(outer.count('pointerup'), 1);
  right(outer); outer.emit('pointerup', { button: 2 }); assert.equal(outerClosed, 1);
  r.ui.showConfirm('隔离确认', () => confirmed++); await r.flush();
  const confirm = r.document.querySelector('#cui-popup-confirm');
  releaseRight(confirm); await r.flush(); r.runTimers(); confirm.click(); assert.equal(confirmed, 0);
  const main = r.element('main-page-filter'); main.innerHTML = '<button data-filter-type="物攻"></button>';
  const state = r.ui.FilterExclusion.create(); let changed = 0;
  r.ui.FilterExclusion.bind(main, state, () => changed++);
  const button = main.querySelector('button'); button.emit('pointerup', { button: 2 }); right(button);
  assert.equal(changed, 1); assert.equal(state.exclude.type.has('物攻'), true);
  assert.equal(r.document.count('pointerup'), 0); assert.equal(r.document.count('contextmenu'), 0);
});

test('one release gesture consumes a retargeted parent/page contextmenu, but never the next pointer gesture', async () => {
  const r = runtime(), outer = r.element('outer'), inner = r.element('inner', outer), input = r.element('inside', inner);
  let outerClosed = 0, innerClosed = 0, pageActions = 0;
  r.ui.bindModalContextMenu(outer, () => { outerClosed++; outer.remove(); });
  r.ui.bindModalContextMenu(inner, () => { innerClosed++; r.ui.destroyWithin(inner); inner.remove(); });
  await r.flush();
  releaseRight(input); await r.flush();
  assert.equal(r.document.count('contextmenu'), 1, 'only one short-lived trailing-event guard');
  assert.equal(right(outer).defaultPrevented, true);
  assert.equal(innerClosed, 1); assert.equal(outerClosed, 0, 'retargeted same-gesture menu must not close parent');
  assert.equal(r.document.count('contextmenu'), 0); assert.equal(r.document.count('pointerdown'), 0);
  releaseRight(outer); await r.flush(); assert.equal(outerClosed, 1);
  const page = r.element('main-context-action');
  page.addEventListener('contextmenu', () => pageActions++);
  assert.equal(right(page).defaultPrevented, true); assert.equal(pageActions, 0, 'trailing menu must not execute underlying delete/filter action');
  assert.equal(r.document.count('contextmenu'), 0);
  const modal = r.element('next-modal'); r.ui.bindModalContextMenu(modal, () => modal.remove());
  releaseRight(modal); await r.flush();
  page.emit('pointerdown', { button: 2 }); // Starts a new user gesture, not the modal's trailing event.
  assert.equal(r.document.count('contextmenu'), 0); assert.equal(r.timers.size, 0);
  assert.equal(right(page).defaultPrevented, false); assert.equal(pageActions, 1);
});

test('contextmenu-first sequence cannot close parent on retargeted release; guard expires/cancels on leave', async () => {
  const r = runtime(), outer = r.element('outer'), inner = r.element('inner', outer), input = r.element('inside', inner);
  let outerClosed = 0, innerClosed = 0;
  r.ui.bindModalContextMenu(outer, () => outerClosed++);
  r.ui.bindModalContextMenu(inner, () => { innerClosed++; inner.remove(); });
  input.emit('pointerdown', { button: 2 }); right(input); await r.flush();
  assert.equal(outer.emit('pointerup', { button: 2 }).defaultPrevented, false);
  assert.equal(innerClosed, 1); assert.equal(outerClosed, 0, 'outer did not own child press');
  releaseRight(outer); await r.flush(); assert.equal(outerClosed, 1);
  assert.equal(r.document.count('contextmenu'), 1); assert.equal(r.timers.size, 1);
  r.runTimers(); assert.equal(r.document.count('contextmenu'), 0); assert.equal(r.document.count('pointerdown'), 0);
  const leaving = r.element('leaving'); r.ui.bindModalContextMenu(leaving, () => leaving.remove());
  releaseRight(leaving); await r.flush(); assert.equal(r.document.count('contextmenu'), 1);
  r.ui.destroyWithin(r.element('new-route'));
  assert.equal(r.document.count('contextmenu'), 0); assert.equal(r.document.count('pointerdown'), 0); assert.equal(r.timers.size, 0);
  const cancelled = r.element('cancelled'); r.ui.bindModalContextMenu(cancelled, () => cancelled.remove());
  releaseRight(cancelled); r.document.emit('pointercancel');
  assert.equal(r.document.count('contextmenu'), 0); assert.equal(r.document.count('pointercancel'), 0); assert.equal(r.timers.size, 0);
});

test('queued detach and hide records dispose bindings without stale observer disposing a fresh registration', async () => {
  const r = runtime(), root = r.element('ephemeral'); let old = 0, current = 0;
  r.ui.bindModalContextMenu(root, () => old++);
  root.style.display = 'none';
  root.style.display = 'flex';
  r.ui.bindModalContextMenu(root, () => current++);
  await r.flush(); assert.equal(root.count('contextmenu'), 1);
  right(root); assert.equal(old, 0); assert.equal(current, 1);
  const detached = r.element('removed'); r.ui.bindModalContextMenu(detached, () => {});
  detached.remove(); await r.flush(); assert.equal(detached.count('contextmenu'), 0);
});
