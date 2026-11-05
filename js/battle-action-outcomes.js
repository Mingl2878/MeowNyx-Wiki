/* Conservative display-only interruption exception. Raw phase, HP, energy and API remain untouched. */
(function (root,factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BattleActionOutcomes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this,function () {
  'use strict';
  // Canonical local stable identities reviewed Nov 4. Never classify by labels,
  // protocol-number arithmetic or nearby damage. These stay under the parent default.
  const interruptors = Object.freeze([
    Object.freeze({id:68,name:'摇篮曲'}), Object.freeze({id:187,name:'地刺'}),
    Object.freeze({id:343,name:'硬门'}), Object.freeze({id:345,name:'斩断'})
  ]);
  const excluded = new Set(interruptors.map(s => s.id));
  const list = value => Array.isArray(value) ? value : [];
  const idKnown = value => typeof value === 'string' && value.length > 0;
  const sideKnown = side => ['me','enemy'].includes(side);
  const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
  const index = e => nonnegative(e.execIndex) ? e.execIndex : e.kind === 'form' && nonnegative(e.form?.execIndex) ? e.form.execIndex : null;
  const before = (a,b) => nonnegative(a.round) && nonnegative(b.round) && nonnegative(a.seq) && nonnegative(b.seq) &&
    (a.round !== b.round ? a.round < b.round : a.seq !== b.seq ? a.seq < b.seq : index(a) !== null && index(b) !== null && index(a) < index(b));
  const noAction = e => e.protocolSkillId === '700001200' && (e.skillId === undefined || e.skillId === 0) && e.kind === 'skill' &&
    ['executed','interrupted'].includes(e.phase) && (e.skillClass === undefined || ['','unknown','ordinary','response'].includes(e.skillClass));
  const signature = value => JSON.stringify(value,(_,v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
  const safeCall = (fn,...args) => { try { return typeof fn === 'function' ? fn(...args) : null; } catch (_) { return null; } };
  function resolveSkill(id,catalog) {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const c = catalog?.catalog || catalog;
    if (c?.schema_version !== undefined && ![1,2].includes(c.schema_version)) return null;
    const rows = list(c?.skills || c?.moves || safeCall(catalog?.getMoves));
    const matches = rows.filter(s => s?.id === id);
    if (matches.length > 1) return null;
    const s = matches[0] || safeCall(catalog?.getMoveById,id);
    return s?.id === id && idKnown(s.name || s.localized?.zh?.name) ? s : null;
  }
  function interruptionLabel(event,record,catalog = {}) {
    if (!event || !record || noAction(event) || event.phase !== 'interrupted' || !sideKnown(event.side) || !idKnown(event.actor) || !idKnown(event.id) ||
      !(event.kind === 'skill' || event.kind === 'effect' && event.skillClass === 'system') || event.skillClass === 'passive') return null;
    const ids = new Map(), pets = new Set();
    for (const side of ['me','enemy']) for (const pet of list(record.sides?.[side]?.pets)) {
      if (!idKnown(pet?.instanceId)) continue;
      const key = JSON.stringify([side,pet.instanceId]);
      if (pets.has(key)) return null;
      pets.add(key);
    }
    const actorKnown = (side,actor) => pets.has(JSON.stringify([side,actor]));
    if (!actorKnown(event.side,event.actor)) return null;
    for (const e of list(record.events)) {
      if (!e || !idKnown(e.id)) return null;
      if (ids.has(e.id)) { if (signature(ids.get(e.id)) !== signature(e)) return null; }
      else ids.set(e.id,e);
    }
    if (!ids.has(event.id) || signature(ids.get(event.id)) !== signature(event)) return null;
    // The counter edge resolves the original interrupted action by event identity,
    // not combat.actionId (which is exclusively a source reference).
    const responses = [...ids.values()].filter(source => source.kind === 'skill' && source.phase === 'executed' && source.skillClass === 'response' &&
      !noAction(source) && sideKnown(source.side) && source.side !== event.side && actorKnown(source.side,source.actor) && source.round === event.round &&
      source.combat?.counteredActionId === event.id && source.combat?.responseAttempt !== false);
    if (responses.length !== 1) return null;
    const source = responses[0];
    if (!resolveSkill(source.skillId,catalog) || excluded.has(source.skillId)) return null;
    // A confirmed defeat must independently name this exact source action and
    // this victim. HP0 (including a leader's HP0→form→heal) is not defeat proof.
    const deaths = [...ids.values()].filter(death => {
      if (death.phase !== 'executed' || death.combat?.leaveReason !== 'defeat' || death.combat?.actionId !== source.id || death.round !== source.round || !before(source,death)) return false;
      if (death.kind === 'effect') return death.side === event.side && death.actor === event.actor;
      if (death.kind === 'switch') return death.side === event.side && (death.targetSide === undefined || death.targetSide === '' || death.targetSide === event.side) && death.target === event.actor;
      return false;
    });
    return deaths.length ? '被应对击败' : null;
  }
  return Object.freeze({interruptionLabel,interruptors});
});
