/* Read-only v1-to-v2 migration and projection of local catalog data. No network or rule execution.
 * Keep this contract in sync with internal/catalog.ExportLegacy. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatalogData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const blank = value => typeof value !== 'string' || !value.trim();
  const integer = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
  const finite = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
  function fail(message) { throw new Error(`CatalogData: ${message}`); }
  function set(target, key, value) {
    // Treat even historical __proto__/constructor keys as ordinary local data.
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  }
  function copy(value) {
    if (Array.isArray(value)) return value.map(copy);
    if (object(value)) { const result = {}; for (const [key, item] of Object.entries(value)) set(result, key, copy(item)); return result; }
    return value;
  }
  function requireObject(value, context) { if (!object(value)) fail(`${context} must be an object`); return value; }
  function knownExtensions(value) {
    if (value.extensions == null) return;
    requireObject(value.extensions, 'extensions');
    for (const key of Object.keys(value.extensions)) if (!key.trim()) fail('empty extension key');
  }
  function optionalBooleans(value, keys) {
    for (const key of keys) if (value[key] != null && typeof value[key] !== 'boolean') fail(`invalid boolean ${key}`);
  }
  function optionalStrings(value, keys) {
    for (const key of keys) if (value[key] != null && typeof value[key] !== 'string') fail(`invalid string ${key}`);
  }
  function optionalIDs(value, keys) {
    for (const key of keys) if (value[key] != null && value[key] !== 0 && !integer(value[key])) fail(`invalid reference ${key}`);
  }
  function requireArray(value, context, nonempty = false) {
    if (!Array.isArray(value) || (nonempty && !value.length)) fail(`${context} must be ${nonempty ? 'a nonempty' : 'an explicit'} array`);
    return value;
  }
  function index(rows, key, context, allowZero = false, stringID = false) {
    const map = new Map();
    for (const row of rows) {
      requireObject(row, context); knownExtensions(row);
      const id = row[key];
      if (stringID ? blank(id) : !(integer(id) || (allowZero && id === 0))) fail(`invalid ${context} ${key}`);
      if (map.has(id)) fail(`duplicate ${context} ${key}: ${id}`);
      map.set(id, row);
    }
    return map;
  }
  function reference(map, id, context) { const row = map.get(id); if (!row) fail(`${context} references missing ID ${id}`); return row; }
  function sourceRef(ref) {
    if (ref == null) return;
    requireObject(ref, 'source_ref'); knownExtensions(ref);
    for (const key of Object.keys(ref)) if (!['provider', 'id', 'identity', 'extensions'].includes(key) && ref.extensions && own(ref.extensions, key)) fail(`source_ref unknown field conflicts with extension ${key}`);
    if (blank(ref.provider) || blank(ref.id) || blank(ref.identity)) fail('source_ref requires provider, id and identity');
    if (ref.extensions) for (const key of ['provider', 'id', 'identity']) if (own(ref.extensions, key)) fail(`source_ref extension overrides ${key}`);
  }
  function putRef(target, ref) {
    if (ref == null) return;
    const result = { provider: ref.provider, id: ref.id, identity: ref.identity };
    for (const [key, value] of Object.entries(ref)) if (!['provider', 'id', 'identity', 'extensions'].includes(key)) set(result, key, copy(value));
    for (const [key, value] of Object.entries(ref.extensions || {})) set(result, key, copy(value));
    set(target, '_source_ref', result);
  }
  const decodePath = path => path.split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  function mergePatch(target, patch) {
    requireObject(patch, 'legacy patch');
    for (const [key, value] of Object.entries(patch)) {
      if (own(target, key) && object(target[key]) && object(value)) mergePatch(target[key], value);
      else set(target, key, copy(value));
    }
  }
  function omitPath(target, path) {
    if (typeof path !== 'string' || !path) fail('invalid legacy omission path');
    const parts = decodePath(path);
    for (let i = 0; i < parts.length - 1; i++) {
      if (!own(target, parts[i]) || !object(target[parts[i]])) return;
      target = target[parts[i]];
    }
    delete target[parts[parts.length - 1]];
  }
  function applyExtensions(target, extensions) {
    if (extensions?.legacy !== undefined) mergePatch(target, extensions.legacy);
    if (extensions?.legacy_omit !== undefined) for (const path of requireArray(extensions.legacy_omit, 'legacy_omit')) omitPath(target, path);
    return target;
  }
  function protectPatch(extensions, paths) {
    if (!extensions) return;
    if (extensions.legacy !== undefined) {
      requireObject(extensions.legacy, 'legacy extension');
      for (const path of paths) {
        let current = extensions.legacy;
        const parts = path.split('/');
        for (let i = 0; i < parts.length; i++) {
          if (!object(current) || !own(current, parts[i])) break;
          if (i === parts.length - 1) fail(`legacy patch must not override core field ${path}`);
          current = current[parts[i]];
        }
      }
    }
    if (extensions.legacy_omit !== undefined) for (const omit of requireArray(extensions.legacy_omit, 'legacy_omit')) {
      if (typeof omit !== 'string' || !omit) fail('invalid legacy omission path');
      if (paths.some(path => path === omit || path.startsWith(`${omit}/`))) fail(`legacy omission removes core field ${omit}`);
    }
  }
  function displayName(monster) {
    return monster.form && monster.form !== 'default' && monster.form !== 'Original'
      ? `${monster.name}（${monster.form}）` : monster.name;
  }
  function normalizeName(value) {
    const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
    return value.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ').replace(/[\u2160-\u216B\u2170-\u217B]/g, c => roman[c.charCodeAt(0) % 16])
      .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[‐‑‒–—−﹣]/g, '-').trim()
      .replace(/[-_\s]*([ivx]+)$/i, (_, numeral) => numeral.toUpperCase());
  }
  function checkJSONValue(value, depth = 0) {
    if (depth > 100) fail('JSON nesting exceeds 100');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('non-finite JSON number'); return; }
    if (Array.isArray(value)) { for (const item of value) checkJSONValue(item, depth + 1); return; }
    if (!object(value)) fail('not a JSON value');
    for (const item of Object.values(value)) checkJSONValue(item, depth + 1);
  }
  function validate(c) {
    requireObject(c, 'catalog'); knownExtensions(c);
    if (c.schema_version !== 2) fail(`unsupported schema_version ${c.schema_version}`);
    checkJSONValue(c);
    const x = {
      monsters: index(requireArray(c.monsters, 'monsters', true), 'id', 'monster'),
      skills: index(requireArray(c.skills, 'skills', true), 'id', 'skill'),
      types: index(requireArray(c.types, 'types', true), 'id', 'type', true),
      traits: index(requireArray(c.traits, 'traits', true), 'id', 'trait', false, true),
      learnsets: index(requireArray(c.learnsets, 'learnsets', true), 'monster_id', 'learnset'),
      rules: index(requireArray(c.skill_rules || [], 'skill_rules'), 'skill_id', 'skill rule')
    };
    const typeCodes = new Set(), definitions = new Set(), skillNames = new Set(), names = new Map();
    for (const type of c.types) {
      optionalBooleans(type, ['runtime_only']);
      if (blank(type.code) || blank(type.name) || typeCodes.has(type.code)) fail(`invalid/duplicate type code ${type.code}`);
      typeCodes.add(type.code);
      const vulnerable = requireArray(type.vulnerable_to, 'vulnerable_to'), resistant = requireArray(type.resistant_to, 'resistant_to');
      if (type.id === 0 ? type.code !== 'None' || vulnerable.length || resistant.length : type.code === 'None' || type.runtime_only) fail('invalid None/runtime-only type');
      const seen = new Set();
      for (const id of [...vulnerable, ...resistant]) { reference(x.types, id, 'type relation'); if (seen.has(id)) fail('duplicate/contradictory type relation'); seen.add(id); }
      sourceRef(type.source_ref); protectPatch(type.extensions, ['id', 'name']);
    }
    for (const trait of c.traits) {
      const key = JSON.stringify([trait.name, trait.description]);
      if (blank(trait.name) || blank(trait.description) || definitions.has(key)) fail('invalid/duplicate trait definition');
      definitions.add(key); sourceRef(trait.source_ref);
    }
    function register(name, id) {
      if (blank(name)) fail('empty monster name/alias');
      const key = normalizeName(name);
      if (names.has(key) && names.get(key) !== id) fail(`ambiguous monster identity ${name}`);
      names.set(key, id);
    }
    for (const m of c.monsters) {
      optionalBooleans(m, ['is_leader_form', 'hidden', 'level_configurable', 'placeholder']);
      optionalStrings(m, ['evolution_chain_name', 'data_note', 'season']); optionalIDs(m, ['main_form_id', 'evolves_from_id', 'leader_of_id']);
      if (blank(m.name) || !Number.isInteger(m.dex_number) || m.dex_number < 0 || m.dex_number > 2147483647) fail(`invalid monster ${m.id}`);
      requireObject(m.stats, 'stats'); requireObject(m.images, 'images'); knownExtensions(m.stats); knownExtensions(m.images);
      for (const key of ['hp', 'phy_atk', 'phy_def', 'mag_atk', 'mag_def', 'speed']) if (!Number.isInteger(m.stats[key]) || !finite(m.stats[key], 1, 10000)) fail(`invalid monster stat ${key}`);
      for (const key of ['avatar', 'portrait']) if (m.images[key] !== undefined && typeof m.images[key] !== 'string') fail(`invalid image ${key}`);
      const ids = requireArray(m.type_ids, 'type_ids');
      if (!ids.length || ids.length > 2 || (ids.length === 2 && (ids[0] === ids[1] || ids.includes(0)))) fail('invalid monster type IDs');
      for (const id of ids) reference(x.types, id, 'monster type');
      reference(x.traits, m.trait_id, 'monster trait'); reference(x.learnsets, m.id, 'monster learnset');
      if (blank(m.form) || blank(m.evolution_stage)) fail('missing form/evolution stage');
      if (m.form_category === '变体形态') {
        const main = reference(x.monsters, m.main_form_id, 'main form');
        if (main.id === m.id || main.name !== m.name || main.form_category !== '主形态') fail('invalid main form');
      } else if (!['主形态', '无多形态'].includes(m.form_category) || m.main_form_id) fail('invalid form category');
      const members = requireArray(m.evolution_members, 'evolution_members'), seenMembers = new Set();
      for (const id of members) { reference(x.monsters, id, 'evolution member'); if (seenMembers.has(id)) fail('duplicate evolution member'); seenMembers.add(id); }
      if (m.evolves_from_id) { reference(x.monsters, m.evolves_from_id, 'evolution'); if (m.evolves_from_id === m.id || !seenMembers.has(m.evolves_from_id)) fail('invalid evolution predecessor (must belong to evolution_members)'); }
      if (m.leader_of_id && m.evolves_from_id) fail(`monster ${m.id}: leader_of_id 与 evolves_from_id 不可并存；请同时选择对应普通进化候选或清除普通前置`);
      if (m.leader_of_id) { reference(x.monsters, m.leader_of_id, 'leader'); if (m.leader_of_id === m.id) fail('self leader'); }
      if (m.default_level !== undefined && m.default_level !== 0 && (!Number.isInteger(m.default_level) || !finite(m.default_level, 1, 99))) fail('invalid default level');
      if (m.level_configurable && !m.default_level) fail('configurable level needs explicit default');
      if (['level_min', 'level_max', 'level_step'].some(key => m[key] !== undefined)) {
        if (!Number.isInteger(m.level_min) || !finite(m.level_min, 1, 99) || !Number.isInteger(m.level_max) || !finite(m.level_max, m.level_min, 99) || !Number.isInteger(m.level_step) || !finite(m.level_step, 1, 98) || !Number.isInteger(m.default_level) || !finite(m.default_level, m.level_min, m.level_max)) fail('invalid level range, step or default');
      }
      if (m.placeholder && blank(m.data_note)) fail('placeholder requires data_note');
      register(displayName(m), m.id);
      for (const alias of requireArray(m.aliases || [], 'aliases')) register(alias, m.id);
      for (const tag of requireArray(m.search_tags || [], 'search_tags')) if (blank(tag)) fail('empty search tag');
      sourceRef(m.source_ref);
      protectPatch(m.extensions, ['id', 'base_hp', 'base_phy_atk', 'base_phy_def', 'base_mag_atk', 'base_mag_def', 'base_spd', 'main_type/id', 'sub_type/id', 'learnset_mode', 'learnset_inherits_from_id', 'evolves_from_id', 'evolution_members', 'leader_of_id', 'main_form_id', 'default_level', 'level_configurable', 'level_min', 'level_max', 'level_step', 'season']);
    }
    for (const s of c.skills) {
      optionalStrings(s, ['season']);
      if (blank(s.name) || blank(s.description) || skillNames.has(s.name)) fail('invalid/duplicate master skill name');
      skillNames.add(s.name); reference(x.types, s.type_id, 'skill type');
      if (!['Physical Attack', 'Magic Attack', 'Status', 'Defense'].includes(s.category)) fail('invalid skill category');
      if (!finite(s.energy_cost, 0, 10000) || !own(s, 'power') || (s.power !== null && !finite(s.power, 0, 1e9))) fail('invalid energy/power; unknown power must be null');
      sourceRef(s.source_ref); protectPatch(s.extensions, ['id', 'power', 'energy_cost', 'move_category', 'move_type/id', 'base_combo', 'power_formula', 'season']);
    }
    for (const r of x.rules.values()) {
      reference(x.skills, r.skill_id, 'skill rule');
      if (r.base_combo != null && (!Number.isInteger(r.base_combo) || !finite(r.base_combo, 1, 10000))) fail('invalid base_combo');
      if (r.power_formula !== undefined && (typeof r.power_formula !== 'string' || (r.power_formula && blank(r.power_formula)))) fail('invalid power_formula');
    }
    for (const l of c.learnsets) {
      optionalIDs(l, ['from_id']);
      reference(x.monsters, l.monster_id, 'learnset');
      if (l.mode === 'own') { if (l.from_id) fail('own learnset must not inherit'); }
      else if (l.mode === 'inherit') { reference(x.monsters, l.from_id, 'learnset inheritance'); if (l.from_id === l.monster_id) fail('self inheritance'); }
      else fail('invalid learnset mode');
      for (const row of requireArray(l.skills, 'learning skills')) { requireObject(row, 'learning row'); knownExtensions(row); reference(x.skills, row.skill_id, 'learning row'); if (blank(row.source)) fail('empty learning source'); }
      sourceRef(l.source_ref); protectPatch(l.extensions, ['monster_id', 'skills', 'aliases']);
    }
    for (const [label, next] of [['leader', id => x.monsters.get(id).leader_of_id], ['evolution', id => x.monsters.get(id).evolves_from_id], ['main form', id => x.monsters.get(id).main_form_id], ['learnset inheritance', id => x.learnsets.get(id).from_id]]) {
      const state = new Map();
      function visit(id) { if (!id || state.get(id) === 2) return; if (state.get(id) === 1) fail(`${label} cycle at ${id}`); state.set(id, 1); visit(next(id)); state.set(id, 2); }
      for (const id of x.monsters.keys()) visit(id);
    }
    const placeholder = x.monsters.get(619);
    if (placeholder?.placeholder) {
      const l = x.learnsets.get(619);
      const ids = placeholder.type_ids;
      const legacyTypes = ids.length === 1 && ids[0] === 0;
      const approvedTypes = ids.length === 2 && ids[0] === 8 && ids[1] === 15 && x.types.get(8)?.code === 'Dragon' && x.types.get(15)?.code === 'Ghost';
      if (placeholder.name !== '冥古龙' || placeholder.default_level !== 99 || !placeholder.level_configurable || (!legacyTypes && !approvedTypes) || l.mode !== 'own' || l.skills.length || placeholder.images.avatar || placeholder.images.portrait) fail('monster 619 placeholder changed');
      // Retain old immutable versions while allowing only the complete user-approved revision.
      const approved = { hp: 118, phy_atk: 128, phy_def: 81, mag_atk: 42, mag_def: 63, speed: 70 };
      const keys = Object.keys(approved);
      if (!keys.every(key => placeholder.stats[key] === 100) && !keys.every(key => placeholder.stats[key] === approved[key])) fail('monster 619 stats are neither legacy nor approved');
    }
    return x;
  }

  // A pure migration boundary. Parent-root snapshots exist ONLY for v1 input;
  // normal v2 reads retain every entry's explicit (possibly empty) list.
  function upgrade(catalog) {
    requireObject(catalog, 'catalog');
    if (![1, 2].includes(catalog.schema_version)) fail(`unsupported schema_version ${catalog.schema_version}`);
    checkJSONValue(catalog);
    const c = copy(catalog);
    if (c.schema_version === 1) {
      const monsters = index(requireArray(c.monsters, 'monsters', true), 'id', 'monster');
      const roots = new Map(), visiting = new Set(), groups = new Map();
      function root(id) {
        if (roots.has(id)) return roots.get(id);
        if (visiting.has(id)) fail(`v1 evolution cycle at ${id}`);
        const m = reference(monsters, id, 'v1 evolution');
        optionalIDs(m, ['evolves_from_id']);
        visiting.add(id);
        const r = m.evolves_from_id ? root(m.evolves_from_id) : id;
        visiting.delete(id); roots.set(id, r); return r;
      }
      for (const m of c.monsters) { const r = root(m.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(m.id); }
      for (const m of c.monsters) if (!own(m, 'evolution_members')) m.evolution_members = [...groups.get(roots.get(m.id))];
      c.schema_version = 2;
    }
    validate(c);
    return c;
  }

  function toLegacy(catalog) {
    catalog = upgrade(catalog);
    const x = validate(catalog);
    function typeLegacy(t) {
      const r = { id: t.id, name: t.code, localized: { zh: t.name }, vulnerable_to: t.vulnerable_to.map(id => x.types.get(id).code), resistant_to: t.resistant_to.map(id => x.types.get(id).code) };
      putRef(r, t.source_ref); return r;
    }
    function skillLegacy(s) {
      const t = x.types.get(s.type_id), rule = x.rules.get(s.id);
      const r = { id: s.id, move_type: { id: t.id, name: t.code, localized: { zh: t.name } }, localized: { zh: { name: s.name, description: s.description } }, move_category: s.category, energy_cost: s.energy_cost, power: s.power, base_combo: rule?.base_combo ?? null, power_formula: rule?.power_formula || null, counter_power_multiplier: null, alt_power_total: null, alt_condition_zh: null, season: s.season || '' };
      putRef(r, s.source_ref); return applyExtensions(r, s.extensions);
    }
    function monsterLegacy(m) {
      const t = x.traits.get(m.trait_id), l = x.learnsets.get(m.id);
      const trait = { localized: { zh: { name: t.name, description: t.description } } }; putRef(trait, t.source_ref);
      const r = { id: m.id, dex_number: m.dex_number, localized: { zh: { name: m.name } }, base_hp: m.stats.hp, base_phy_atk: m.stats.phy_atk, base_phy_def: m.stats.phy_def, base_mag_atk: m.stats.mag_atk, base_mag_def: m.stats.mag_def, base_spd: m.stats.speed, main_type: typeLegacy(x.types.get(m.type_ids[0])), sub_type: m.type_ids.length > 1 ? typeLegacy(x.types.get(m.type_ids[1])) : null, trait, _trait_id: m.trait_id, image: m.images.avatar || '', form: m.form, form_category: m.form_category, main_form_id: m.main_form_id || null, main_form_name: m.main_form_id ? x.monsters.get(m.main_form_id).form : '', evolution_stage: m.evolution_stage, evolution_chain_name: m.evolution_chain_name || '', evolves_from_id: m.evolves_from_id || null, evolution_members: copy(m.evolution_members), leader_of_id: m.leader_of_id || null, is_leader_form: !!m.is_leader_form, learnset_mode: l.mode };
      if (l.from_id) r.learnset_inherits_from_id = l.from_id;
      if (m.season) r.season = m.season;
      if (m.default_level) r.default_level = m.default_level;
      if (m.level_configurable) r.level_configurable = true;
      if (m.level_min !== undefined) { r.level_min = m.level_min; r.level_max = m.level_max; r.level_step = m.level_step; }
      if (m.placeholder) r.data_status = 'placeholder';
      if (m.data_note) r.data_note = m.data_note;
      if (m.hidden) r.hidden = true;
      if (m.search_tags?.length) r.search_tags = copy(m.search_tags);
      putRef(r, m.source_ref); return applyExtensions(r, m.extensions);
    }
    const categories = { 'Physical Attack': '物攻', 'Magic Attack': '魔攻', Status: '状态', Defense: '防御' };
    function wikiLegacy(l) {
      const m = x.monsters.get(l.monster_id);
      const r = { monster_id: l.monster_id, image: m.images.portrait || '', skills: l.skills.map(row => { const s = x.skills.get(row.skill_id); return { name: s.name, source: row.source, desc: s.description, element: x.types.get(s.type_id).name, type: categories[s.category] }; }) };
      if (m.aliases?.length) r.aliases = copy(m.aliases);
      putRef(r, l.source_ref); applyExtensions(r, l.extensions);
      for (const [key, kind] of [['legacy_skills', 'patch'], ['legacy_skill_omit', 'omit']]) {
        const entries = l.extensions?.[key]; if (entries === undefined) continue;
        requireObject(entries, key);
        for (const [index, value] of Object.entries(entries)) {
          const i = Number(index);
          if (!Number.isSafeInteger(i) || i < 0 || i >= r.skills.length || String(i) !== index) fail(`invalid legacy learning row index ${index}`);
          if (kind === 'patch') {
            requireObject(value, 'legacy learning patch');
            if (own(value, 'name') || (own(value, 'source') && value.source !== '' && value.source !== null)) fail('legacy learning patch overrides identity/source');
            mergePatch(r.skills[i], value);
          } else for (const path of requireArray(value, 'legacy_skill_omit')) { if (path === 'name') fail('legacy omission removes skill identity'); omitPath(r.skills[i], path); }
        }
      }
      return r;
    }
    const wiki = {};
    for (const l of catalog.learnsets) set(wiki, displayName(x.monsters.get(l.monster_id)), wikiLegacy(l));
    return {
      monsters: catalog.monsters.map(monsterLegacy),
      moves: catalog.skills.map(skillLegacy),
      types: catalog.types.filter(type => !type.runtime_only).map(type => applyExtensions(typeLegacy(type), type.extensions)),
      wiki
    };
  }
  return { toLegacy, upgrade };
});
