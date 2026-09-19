/* Shared by the browser and Node update scripts. Identity is an ID, not a filename. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MonsterIdentity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

  // Deliberately bounded compatibility rules; never strip a form suffix.
  // Keep this contract in sync with normalizeMonsterName in wiki_identity.go.
  function normalizeName(value) {
    return String(value || '')
      .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ')
      .replace(/[\u2160-\u216B\u2170-\u217B]/g, c => ROMAN[c.charCodeAt(0) % 16])
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[‐‑‒–—−﹣]/g, '-')
      .trim()
      .replace(/[-_\s]*([ivx]+)$/i, (_, numeral) => numeral.toUpperCase());
  }

  function displayName(monster) {
    const name = monster?.localized?.zh?.name || '';
    const form = monster?.form;
    return form && form !== 'default' && form !== 'Original' ? `${name}（${form}）` : name;
  }

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
  }

  function mergeEntries(entries, canonicalName, id) {
    const result = {};
    const skills = new Map();
    const aliases = new Set();
    for (const [key, entry] of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`无效图鉴条目：${key}`);
      if (entry.skills != null && !Array.isArray(entry.skills)) throw new Error(`无效技能列表：${key}`);
      for (const [field, value] of Object.entries(entry)) {
        if (['skills', 'aliases', 'monster_id', 'image'].includes(field)) continue;
        if (result[field] !== undefined && stable(result[field]) !== stable(value)) throw new Error(`${canonicalName} 别名字段冲突：${field}`);
        result[field] = copy(value);
      }
      if (entry.image && (!result.image || key === canonicalName)) result.image = entry.image;
      if (key !== canonicalName) aliases.add(key);
      if (entry.aliases != null && (!Array.isArray(entry.aliases) || entry.aliases.some(alias => typeof alias !== 'string'))) throw new Error(`${key} 的 aliases 必须是名称数组`);
      for (const alias of entry.aliases || []) if (alias !== canonicalName) aliases.add(alias);
      for (const skill of entry.skills || []) {
        if (!skill || typeof skill.name !== 'string' || !skill.name) throw new Error(`${key} 含无效技能`);
        const skillKey = JSON.stringify([skill.name, skill.source || '默认']);
        if (!skills.has(skillKey)) { skills.set(skillKey, copy(skill)); continue; }
        const prior = skills.get(skillKey);
        for (const [field, value] of Object.entries(skill)) {
          if (field === 'source' && (prior.source || '默认') === (value || '默认')) continue;
          if (prior[field] !== undefined && stable(prior[field]) !== stable(value)) throw new Error(`${canonicalName} 的 ${skill.name}（${skill.source || '默认'}）别名数据冲突：${field}`);
          prior[field] = copy(value);
        }
      }
    }
    result.image = result.image || '';
    result.skills = [...skills.values()];
    if (id != null) result.monster_id = id;
    if (aliases.size) result.aliases = [...aliases];
    return result;
  }

  function createIndex(monsters, rawWiki) {
    if (!rawWiki || typeof rawWiki !== 'object' || Array.isArray(rawWiki)) throw new Error('图鉴数据必须是对象');
    const byId = new Map();
    const byName = new Map();
    function register(name, monster) {
      const key = normalizeName(name);
      if (!key) throw new Error(`精灵 #${monster.id} 名称为空`);
      const prior = byName.get(key);
      if (prior && prior.id !== monster.id) throw new Error(`精灵名称冲突：${name}（#${prior.id} / #${monster.id}）`);
      byName.set(key, monster);
    }
    for (const monster of monsters) {
      if (!Number.isSafeInteger(monster.id) || monster.id <= 0 || byId.has(monster.id)) throw new Error(`精灵 ID 无效或重复：${monster.id}`);
      byId.set(monster.id, monster);
      register(displayName(monster), monster);
    }
    // Explicit IDs survive display-name changes. Persisted aliases remain importable.
    for (const [key, entry] of Object.entries(rawWiki)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`无效图鉴条目：${key}`);
      let monster;
      if (entry.monster_id != null) {
        monster = byId.get(entry.monster_id);
        if (!monster) throw new Error(`${key} 指向不存在的精灵 ID：${entry.monster_id}`);
      } else monster = byName.get(normalizeName(key));
      if (monster) {
        register(key, monster);
        if (entry.aliases != null && (!Array.isArray(entry.aliases) || entry.aliases.some(alias => typeof alias !== 'string'))) throw new Error(`${key} 的 aliases 必须是名称数组`);
        for (const alias of entry.aliases || []) register(alias, monster);
      }
    }
    const groups = new Map();
    for (const [key, entry] of Object.entries(rawWiki)) {
      const monster = entry.monster_id != null ? byId.get(entry.monster_id) : byName.get(normalizeName(key));
      const canonical = monster ? displayName(monster) : key;
      if (!groups.has(canonical)) groups.set(canonical, { monster, entries: [] });
      groups.get(canonical).entries.push([key, entry]);
    }
    const wiki = Object.create(null);
    const wikiById = new Map();
    for (const [canonical, { monster, entries }] of groups) {
      // Do not modify unrelated single legacy entries or collapse their duplicate skill rows.
      const entry = entries.length === 1 ? copy(entries[0][1]) : mergeEntries(entries, canonical, monster?.id);
      if (entry.skills != null && !Array.isArray(entry.skills)) throw new Error(`无效技能列表：${canonical}`);
      if (monster) {
        entry.monster_id = monster.id;
        const aliases = new Set(entry.aliases || []);
        for (const [key] of entries) if (key !== canonical) aliases.add(key);
        aliases.delete(canonical);
        if (aliases.size) entry.aliases = [...aliases];
        else delete entry.aliases;
        wikiById.set(monster.id, entry);
      }
      wiki[canonical] = entry;
    }
    return {
      wiki,
      getMonster: name => byName.get(normalizeName(name)) || null,
      getByMonster: monster => monster ? wikiById.get(monster.id) || null : null,
      getByName(name) {
        const monster = byName.get(normalizeName(name));
        return (monster && wikiById.get(monster.id)) || wiki[name] || null;
      }
    };
  }

  return { normalizeName, displayName, createIndex, mergeEntries };
});
