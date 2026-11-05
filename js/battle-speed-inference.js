/* Read-only, conditional speed configuration candidates. No profile or IO. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BattleSpeedInference = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const list = x => Array.isArray(x) ? x : [];
  const int = (x, low = 0, high = 1000000) => Number.isSafeInteger(x) && x >= low && x <= high;
  const text = x => typeof x === 'string' && x.trim().length > 0;
  const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  const executionIndex = e => int(e.execIndex) ? e.execIndex : e.kind === 'form' && int(e.form?.execIndex) ? e.form.execIndex : null;
  const before = (a, b) => a.round < b.round || a.round === b.round && (a.seq < b.seq || a.seq === b.seq && executionIndex(a) !== null && executionIndex(b) !== null && executionIndex(a) < executionIndex(b));
  function project(record, options = {}) {
    record = record && typeof record === 'object' ? record : {};
    const math = options.math || root.BattleMath || (typeof require === 'function' ? require('./battle-math.js') : null);
    const systemActions = root.BattleSystemActions || (typeof require === 'function' ? require('./battle-system-actions.js') : null);
    const out = { sides: { me: Object.create(null), enemy: Object.create(null) }, groups: [], skipped: [] };
    const pets = new Map(), events = new Map(), duplicates = new Set();
    for (const side of ['me', 'enemy']) for (const p of list(record.sides?.[side]?.pets)) {
      if (!p || !text(p.instanceId)) continue;
      const key = side + ':' + p.instanceId;
      if (pets.has(key)) duplicates.add(key); else pets.set(key, p);
    }
    for (const e of list(record.events)) if (e && text(e.id)) {
      if (events.has(e.id) && canonical(events.get(e.id)) !== canonical(e)) throw Error('速度观察引用了冲突事件');
      events.set(e.id, e);
    }
    function speciesAt(e) {
      let id = pets.get(e.side + ':' + e.actor)?.monsterId, latest;
      for (const f of events.values()) if (f.kind === 'form' && f.phase === 'executed' && f.side === e.side && f.actor === e.actor && f.form && before(f, e) && (!latest || before(latest, f))) latest = f;
      return latest ? latest.form.toMonsterId : id;
    }
    function candidates(pet, monsterId, level) {
      let monster; try { monster = options.getMonsterById?.(monsterId); } catch (_) { return []; }
      if (!monster || !int(monster.base_spd, 0, 10000) || !int(level, 1, 99) || typeof math?.statFromEffectiveIV !== 'function') return [];
      const iv = pet.iv?.speed, nature = pet.nature?.speed;
      const knownIV = iv?.certainty === 'direct' && int(iv.value, 0, 60) ? iv.value : null;
      const knownNature = nature?.certainty === 'direct' && int(nature.value, 0, 2) ? nature.value : null;
      const answer = [];
      for (let i = 0; i <= 60; i++) for (let n = 0; n <= 2; n++) {
        if (knownIV !== null && i !== knownIV || knownNature !== null && n !== knownNature) continue;
        const speed = math.statFromEffectiveIV(monster.base_spd, 'speed', n, i, level);
        if (int(speed, 1)) answer.push({ iv: i, nature: n, speed });
      }
      return answer;
    }
    const groups = new Map(), seen = new Map(), pairs = new Map();
    for (const o of list(record.speedObservations)) {
      if (!o || typeof o !== 'object') continue;
      if (seen.has(o.id)) { if (canonical(seen.get(o.id)) !== canonical(o)) throw Error('速度观察 ID 冲突'); continue; }
      seen.set(o.id, o);
      const me = events.get(o.meEvent), enemy = events.get(o.enemyEvent);
      let reason = '';
      if (!text(o.id) || !int(o.round, 1) || !int(o.meSpeed, 1) || !int(o.meLevel, 1, 99) || !int(o.enemyLevel, 1, 99)) reason = '缺少明确数值';
      else if (o.prioritiesVerified !== true || o.speedConditionsVerified !== true || !int(o.mePriority, -1000000) || o.mePriority !== o.enemyPriority || !text(o.conditions) || !list(o.evidence).some(text)) reason = '先制或速度条件未核实';
      else if (!me || !enemy || me.side !== 'me' || enemy.side !== 'enemy' || me.round !== o.round || enemy.round !== o.round) reason = '缺少双方同回合行动';
      else if ([me, enemy].some(e => systemActions?.isNoAction?.(e) === true || e.kind !== 'skill' || e.skillClass !== 'ordinary' || e.phase !== 'executed' || !int(e.seq) || !int(e.execIndex))) reason = '不是可比较的正常行动';
      else if (!['me', 'enemy'].includes(o.first) || (o.first === 'me' ? !before(me, enemy) : !before(enemy, me))) reason = '先后顺序冲突';
      else if (!pets.has('me:' + me.actor) || !pets.has('enemy:' + enemy.actor) || !int(o.meMonsterId, 1, 1000000000) || !int(o.enemyMonsterId, 1, 1000000000) || duplicates.has('me:' + me.actor) || duplicates.has('enemy:' + enemy.actor) || speciesAt(me) !== o.meMonsterId || speciesAt(enemy) !== o.enemyMonsterId) reason = '对位身份或形态不明确';
      if (reason) { out.skipped.push({ id: o.id, reason }); continue; }
      const pair = o.meEvent + '\0' + o.enemyEvent;
      if (pairs.has(pair)) {
        const other = pairs.get(pair), withoutID = x => { const y = { ...x }; delete y.id; return y; };
        if (canonical(withoutID(other)) !== canonical(withoutID(o))) throw Error('同一对行动的速度条件冲突');
        continue;
      }
      pairs.set(pair, o);
      const target = pets.get('enemy:' + enemy.actor);
      if (!target) { out.skipped.push({ id: o.id, reason: '不在初始实例中' }); continue; }
      const key = canonical([me.actor, enemy.actor, o.meMonsterId, o.enemyMonsterId, o.meLevel, o.enemyLevel, o.meSpeed, o.mePriority, o.conditions]);
      if (!groups.has(key)) groups.set(key, { target, meActor: me.actor, targetActor: enemy.actor, model: o, rows: [] });
      groups.get(key).rows.push(o);
    }
    for (const group of groups.values()) {
      const o = group.model, all = candidates(group.target, o.enemyMonsterId, o.enemyLevel);
      const counts = { meFirst: group.rows.filter(r => r.first === 'me').length, enemyFirst: group.rows.filter(r => r.first === 'enemy').length };
      const lastRound = Math.max(...group.rows.map(r => r.round));
      const result = { status: 'insufficient', relation: null, basis: '', monsterId: o.enemyMonsterId, level: o.enemyLevel, candidates: [], samples: counts, message: '', lastRound, knownSpeed: o.meSpeed, targetActor: group.targetActor };
      if (!all.length) { result.status = 'conflict'; result.message = '缺少可靠的速度计算资料'; }
      else {
        const minimum = Math.min(...all.map(p => p.speed)), maximum = Math.max(...all.map(p => p.speed));
        const impossible = counts.enemyFirst > 0 && o.meSpeed > maximum || counts.meFirst > 0 && o.meSpeed < minimum;
        if (impossible) { result.status = 'conflict'; result.message = '观察与速度范围冲突'; }
        else {
          if (o.meSpeed === maximum && counts.enemyFirst > 0) { result.relation = 'equal'; result.basis = 'boundary-max'; }
          else if (o.meSpeed === minimum && counts.meFirst > 0) { result.relation = 'equal'; result.basis = 'boundary-min'; }
          else if (counts.meFirst && counts.enemyFirst) { result.relation = 'equal'; result.basis = 'mixed-order'; }
          else if (counts.meFirst >= 2) { result.relation = 'slower'; result.basis = 'two-first'; }
          else if (counts.enemyFirst >= 2) { result.relation = 'faster'; result.basis = 'two-first'; }
          if (result.relation) {
            result.candidates = all.filter(p => result.relation === 'equal' ? p.speed === o.meSpeed : result.relation === 'slower' ? p.speed < o.meSpeed : p.speed > o.meSpeed);
            result.status = result.candidates.length ? 'inferred' : 'conflict';
            result.message = result.status === 'conflict' ? '观察与配置候选冲突' : result.relation === 'equal'
              ? `同速 ${o.meSpeed}${result.basis === 'boundary-max' ? '（最高速度边界）' : result.basis === 'boundary-min' ? '（最低速度边界）' : ''}`
              : result.relation === 'slower' ? `推测低于 ${o.meSpeed}` : `推测高于 ${o.meSpeed}`;
          } else result.message = '有效比较不足两次';
        }
      }
      out.groups.push(result);
      const old = out.sides.enemy[group.targetActor];
      // Changed speed/peer/form conditions start a new group, not a pooled vote.
      if (!old || old.lastRound < lastRound) out.sides.enemy[group.targetActor] = result;
      else if (old.lastRound === lastRound && canonical(old) !== canonical(result)) out.sides.enemy[group.targetActor] = { ...result, status: 'conflict', candidates: [], message: '同回合比较条件不一致' };
    }
    // A directly recorded initial speed is never overwritten by a weaker guess.
    for (const p of list(record.sides?.enemy?.pets)) {
      if (!p || !int(p.speed, 1) || !int(p.level, 1, 99) || duplicates.has('enemy:' + p.instanceId)) continue;
      const current = out.sides.enemy[p.instanceId];
      if (current && (current.monsterId !== p.monsterId || current.level !== p.level)) continue;
      const all = candidates(p, p.monsterId, p.level).filter(c => c.speed === p.speed);
      if (all.length) out.sides.enemy[p.instanceId] = { status: 'direct', relation: null, basis: 'recorded-speed', monsterId: p.monsterId, level: p.level, candidates: all, samples: { meFirst: 0, enemyFirst: 0 }, message: `开场速度 ${p.speed}` };
    }
    return out;
  }
  return Object.freeze({ project });
});
