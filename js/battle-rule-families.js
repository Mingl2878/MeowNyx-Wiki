/* Pure rule-family normalization. No DOM, I/O, mutable catalog or saved-rule writes. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BattleRuleFamilies = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const validID = id => Number.isSafeInteger(id) && id > 0 && id <= 1000000000;
  const copy = rule => ({ ...rule, monsterIds: [...(rule.monsterIds || [])], excludedMonsterIds: [...(rule.excludedMonsterIds || [])], ...(rule.anyOf ? { anyOf: rule.anyOf.map(group => [...group]) } : {}) });

  function createIndex(input) {
    const monsters = Array.isArray(input) ? input : input && input.monsters || [];
    const rows = new Map(monsters.filter(m => m && validID(m.id)).map(m => [m.id, m]));
    const adjacent = new Map([...rows.keys()].map(id => [id, []]));
    const parents = new Map(), children = new Set(), families = new Map(), depths = new Map();
    for (const m of rows.values()) {
      // Names, dex numbers, main forms and evolution_members are never edges.
      for (const parent of [m.evolves_from_id, m.leader_of_id]) {
        if (!validID(parent) || !rows.has(parent) || parent === m.id) continue;
        adjacent.get(m.id).push(parent); adjacent.get(parent).push(m.id);
        if (!parents.has(m.id)) parents.set(m.id, []);
        parents.get(m.id).push(parent); children.add(parent);
      }
    }
    function family(id) {
      if (families.has(id)) return families.get(id);
      const members = new Set([id]), queue = [id];
      for (let i = 0; i < queue.length; i++) for (const next of adjacent.get(queue[i]) || []) {
        if (!members.has(next)) { members.add(next); queue.push(next); }
      }
      const key = Math.min(...members);
      for (const member of members) families.set(member, { key, members });
      return families.get(id);
    }
    function depth(id, active = new Set()) {
      if (depths.has(id)) return depths.get(id);
      if (active.has(id)) return 0;
      active.add(id);
      let d = 0;
      for (const parent of parents.get(id) || []) d = Math.max(d, depth(parent, active) + 1);
      active.delete(id); depths.set(id, d); return d;
    }
    function prefer(a, b) {
      if (children.has(a) !== children.has(b)) return !children.has(a) ? a : b;
      const da = depth(a), db = depth(b);
      return da > db || da === db && a < b ? a : b;
    }
    return Object.freeze({ family: id => [...family(id).members].sort((a, b) => a - b), key: id => family(id).key, prefer });
  }

  function normalizeRule(rule, input) {
    const index = input && typeof input.key === 'function' ? input : createIndex(input);
    const out = copy(rule);
    const collapse = ids => {
      const positions = new Map(), result = [];
      for (const id of ids) {
        if (!validID(id)) throw new TypeError('Invalid stable monster ID');
        const key = index.key(id);
        if (positions.has(key)) { const i = positions.get(key); result[i] = index.prefer(result[i], id); }
        else { positions.set(key, result.length); result.push(id); }
      }
      return result;
    };
    const required = [...out.monsterIds], groups = [];
    for (const original of out.anyOf || []) {
      if (!Array.isArray(original) || !original.length) throw new TypeError('Empty rule alternative group');
      const group = collapse(original);
      if (group.length === 1) required.push(group[0]); else groups.push(group);
    }
    out.monsterIds = collapse(required); out.excludedMonsterIds = collapse(out.excludedMonsterIds);
    delete out.anyOf;
    const included = new Set(out.monsterIds.map(index.key)), seen = new Map();
    for (const group of groups) {
      const keys = group.map(index.key);
      if (keys.some(key => included.has(key))) continue;
      const signature = JSON.stringify([...keys].sort((a, b) => a - b));
      if (seen.has(signature)) {
        const existing = out.anyOf[seen.get(signature)];
        for (let i = 0; i < existing.length; i++) for (const other of group) {
          if (index.key(existing[i]) === index.key(other)) existing[i] = index.prefer(existing[i], other);
        }
      } else { if (!out.anyOf) out.anyOf = []; seen.set(signature, out.anyOf.length); out.anyOf.push(group); }
    }
    // Retain the old 24-core budget: promoting 24 core + 24 singleton ORs
    // must not create an invalid save DTO. The original predicate still matches.
    if (out.monsterIds.length > 24) return copy(rule);
    // Do not introduce exact-ID save conflicts or drop an impossible predicate
    // when promoting an OR which originally also contained an exclusion.
    if (out.monsterIds.some(id => out.excludedMonsterIds.includes(id))) return copy(rule);
    return out;
  }
  function normalizeRules(rules, input) {
    const index = createIndex(input);
    return rules.map(rule => normalizeRule(rule, index));
  }
  return Object.freeze({ createIndex, normalizeRule, normalizeRules });
});
