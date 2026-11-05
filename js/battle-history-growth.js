/* Read-only historical trait entry snapshots. No DOM, IO, personal counters or formula changes.
 * Stable identities + exact descriptions are pinned to battle_record_growth.go.
 * Known positive observed-prefix counts are lower bounds, NOT complete battle effects.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BattleHistoryGrowth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const rules = Object.freeze([
    ['trait-4ce2d8a1ba544b5988de673421381236','爆燃','使用火系技能后，获得双攻永久+30%。','fire'],
    ['trait-5f30b4d15f6e0734998d5982fe99af30','三鼓作气','使用能耗为3的技能后，获得双攻和双防永久+20%。','cost3'],
    ['trait-9ef3df35c33a62120339671bade2c934','蓄电池','每入场1次，永久获得双攻+30%。','entry'],
    ['trait-46d489bf168900998f2b111b706b906b','洄游','每次进入 蓄力 状态，获得全技能能耗永久-2。',''],
    ['trait-f2078a657798e94b6e8aeba9eac29e5f','合拍','本回合与敌方使用的技能在系别/类型/能耗上每有1项相同，回合结束时获得物攻和物防永久+10%。',''],
    ['trait-89a451b13730893fa3e7b589b5ae7904','光度换算','携带的火系技能获得 选择 ：使用后失去15%生命，光系技能威力永久+30。',''],
    ['trait-58e88fa60b0289b9263e8af3651bc2ce','水翼推进','己方精灵每使用1次水系技能，自己入场时获得全技能能耗-1。','historyWater'],
    ['trait-564a216af26fd00a269a371c7f622cb7','水翼飞升','己方精灵每使用1次水系技能，自己入场时获得全技能能耗-1，且能耗为0的技能威力+30%。','historyWater'],
    ['trait-6b978661da9d650de7a7dac2fe4b18aa','身经百练','己方精灵每应对1次，自己入场时水系和武系技能威力+20%。','historyResponse'],
    ['trait-5f2ff7cdd642cdb0950c1d9b5e1b7e40','渗透','己方精灵每使用1次武系或地系技能，自己入场时获得攻防+5%。','historyFightingGround'],
    ['trait-119e36dd263e93e5905c17d955f5d327','拨浪鼓','己方精灵每使用1次状态技能，自己入场时毒系和萌系技能威力+10。','historyStatus'],
    ['trait-70f7af8fffa315e7138dead633d27461','蒸汽膨胀','己方精灵每使用1次火系技能，自己入场时获得全技能威力+10。','historyFire'],
    ['trait-970197bade05ff4ec66567a33a31bbe0','定向精炼','己方精灵每使用1次防御技能，自己入场时机械系和地系技能威力+10%。','historyDefense'],
    ['trait-e25ae47945095818382dc9f9809b5882','搜刮','敌方每使用1次「聚能」技能或更换精灵，自己入场时获得魔攻+20%。','historyEnemyChargeSwitch'],
    ['trait-1d22de1794cbc151f7e505e1f7c1acd1','扫荡','敌方每使用1次「聚能」技能或更换精灵，自己入场时获得魔攻+20%和魔防+10%。','historyEnemyChargeSwitch'],
    ['trait-38e548d59a4015f8d7bc19fc7aed574d','淬炼火','入场前己方精灵每使用1次火系技能，获得攻防+10%，速度+10。（最多触发10次）','historyFireCap10'],
    ['trait-40d2524b7b9510efda8103ef4084cddc','猫精灵的礼物','己方精灵每完整使用1次「 选择 」技能（「明」和「暗」各1次），自己入场时获得物攻+40%。',''],
    ['trait-447f953e530b953692a3185912ca1db4','旧玩具','己方精灵每使用过1个不同系别的技能，自己入场时获得双攻+10%。','historyDistinctType'],
    ['trait-6697629d910983b329437713b38e2c29','蒸汽革命','己方精灵每使用1次火系技能，自己入场时获得全技能威力+10和物防+5%','historyFire'],
    ['trait-2d62e65c758af0457fe3fcdc3054ae81','圣龙的守护','己方精灵每使用1次能耗为3的技能，自己入场前等级+2。在战斗中每提升1级，获得物攻+5%，低于80级时受到伤害+30%。','historyCost3'],
    ['trait-c9050cafd31bb60d4885f7b19e2133cb','花精灵','回合结束时，己方队伍获得1次随机 奉献 。',''],
    ['trait-b1a42772aab02046a9affde6c827c885','坚韧铠甲','每受到1次攻击伤害，己方队伍获得1次随机 奉献 。','']
  ].map(([traitId,name,description,derive]) => Object.freeze({traitId,name,description,derive})));
  const registry = new Map(rules.map(rule => [rule.traitId,rule]));
  const list = value => Array.isArray(value) ? value : [];
  const sideKnown = side => side === 'me' || side === 'enemy';
  const idKnown = id => typeof id === 'string' && id.length > 0;
  const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
  const indexOf = e => nonnegative(e.execIndex) ? e.execIndex : e.kind === 'form' && nonnegative(e.form?.execIndex) ? e.form.execIndex : null;
  const frame = e => JSON.stringify([e.side,e.round,e.seq]);
  const actorKey = (side,actor) => JSON.stringify([side,actor]);
  const before = (a,b) => nonnegative(a.round) && nonnegative(b.round) && nonnegative(a.seq) && nonnegative(b.seq) &&
    (a.round !== b.round ? a.round < b.round : a.seq !== b.seq ? a.seq < b.seq : indexOf(a) !== null && indexOf(b) !== null && indexOf(a) < indexOf(b));
  const isNoAction = e => e.protocolSkillId === '700001200' && (e.skillId === undefined || e.skillId === 0) && e.kind === 'skill' &&
    ['executed','interrupted'].includes(e.phase) && (e.skillClass === undefined || ['','unknown','ordinary','response'].includes(e.skillClass));
  const isUse = e => !isNoAction(e) && e.phase === 'executed' && (e.kind === 'skill' || e.combat?.actionKind === 'wishImpact') &&
    e.skillClass !== 'passive' && (e.skillClass !== 'system' || e.combat?.actionKind === 'wishImpact') && e.protocolSkillId !== '700001000';
  const isCharge = e => !isNoAction(e) && e.phase === 'executed' && e.protocolSkillId === '700001000' &&
    (e.kind === 'skill' || e.kind === 'effect' && e.skillClass === 'system');
  const exact = (pattern,value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
  const isFaint = e => e.kind === 'effect' && e.phase === 'executed' && exact(/^rkpp:action:\d+:\d+:\d+:faint$/,e.id) &&
    e.label === '倒下通知' && e.text === '明确 dead_info；不由动画或HP推测。';
  const isSupply = e => e.kind === 'effect' && e.phase === 'executed' && exact(/^rkpp:action:\d+:\d+:\d+:supply:(.+)$/,e.id) &&
    e.id.endsWith(`:supply:${e.actor}`) && e.label === '补位通知' && e.text === '同一既有实例的 supply_pet 通知；不增加初始队员。';
  const historical = rule => rule?.derive.startsWith('history');
  const signature = value => JSON.stringify(value,(_,v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
  const safeCall = (fn,...args) => { try { return typeof fn === 'function' ? fn(...args) : null; } catch (_) { return null; } };

  function auditNote(rule) {
    if (historical(rule)) return 'Exact reviewed condition; qualified executed actions strictly before each explicit entry. Partial captures expose an observed-prefix lower bound.';
    if (rule.derive) return 'Existing complete-action derivation; not an entry-history condition.';
    if (rule.name === '洄游') return 'Needs explicit entry into charged state; casts/charge energy do not prove this state.';
    if (rule.name === '合拍') return 'Needs paired round actions and confirmed round-end enactment; no round-end growth is guessed.';
    if (['光度换算','猫精灵的礼物'].includes(rule.name)) return 'Needs explicit choice branch/completion evidence; ordinary casts do not prove the branch.';
    if (rule.name === '花精灵') return 'Needs confirmed round-end offering enactment; round-start/finish/settlement is insufficient.';
    return 'Needs confirmed attack-damage trigger/offering enactment; HP loss or multihit messages alone are insufficient.';
  }
  function catalogView(options,record) {
    const c = options.catalog || (options.schema_version !== undefined ? options : null);
    const unavailable = c && ![1,2].includes(c.schema_version);
    const monsters = new Map(), skills = new Map(), traits = new Map(), types = new Map();
    const addTrait = t => { if (idKnown(t?.id)) traits.set(t.id,{name:t.name,description:t.description}); };
    const addMonster = m => {
      if (!m || !Number.isSafeInteger(m.id) || m.id <= 0) return;
      // No identity/name/family inference: ONLY an explicit stable trait ID.
      const traitId = m.trait_id ?? m.traitId ?? m._trait_id ?? safeCall(options.getTraitId,m.id);
      monsters.set(m.id,{traitId});
      const localized = m.trait?.localized?.zh;
      if (idKnown(traitId) && localized) traits.set(traitId,{name:localized.name,description:localized.description});
    };
    if (!unavailable) {
      for (const t of list(c?.types || options.types || safeCall(options.getTypes))) types.set(t.id,t.code || t.name);
      for (const t of list(c?.traits || options.traits || safeCall(options.getTraits))) addTrait(t);
      for (const m of list(c?.monsters || options.monsters)) addMonster(m);
      const ids = new Set();
      for (const side of ['me','enemy']) for (const p of list(record.sides?.[side]?.pets)) ids.add(p.monsterId);
      for (const e of list(record.events)) if (e.form) { ids.add(e.form.fromMonsterId); ids.add(e.form.toMonsterId); }
      for (const id of ids) if (!monsters.has(id)) addMonster(safeCall(options.getMonsterById,id));
      for (const s of list(c?.skills || options.moves || options.skills || safeCall(options.getMoves))) {
        if (!s || !Number.isSafeInteger(s.id) || s.id <= 0) continue;
        const typeId = s.type_id ?? s.move_type?.id;
        const code = s.move_type?.name || types.get(typeId);
        if (code) types.set(typeId,code);
        skills.set(s.id,{name:s.name || s.localized?.zh?.name,category:s.category || s.move_category,typeId,code});
      }
    }
    const verified = new Map();
    for (const rule of rules) {
      const t = traits.get(rule.traitId);
      if (t?.name === rule.name) verified.set(rule.traitId,{...rule,derive:t.description === rule.description ? rule.derive : ''});
    }
    return {monsters,skills,traits,types,verified};
  }
  function project(record,options = {}) {
    record = record && typeof record === 'object' ? record : {};
    const cat = catalogView(options,record);
    const audit = rules.map(rule => {
      const checked = cat.verified.get(rule.traitId), derive = checked?.derive || '';
      return {...rule,derive,supported:!!derive,note:!checked || derive !== rule.derive ? 'Canonical identity/name/description guard failed; derivation disabled.' : auditNote(rule)};
    });
    const result = {entries:[],audit};
    const events = [], ids = new Map(), pets = new Map(), forms = new Map();
    for (const e of list(record.events)) {
      if (!e || typeof e !== 'object' || !idKnown(e.id) || !nonnegative(e.round) || !nonnegative(e.seq)) return result;
      if (ids.has(e.id)) { if (signature(ids.get(e.id)) !== signature(e)) return result; continue; }
      ids.set(e.id,e); events.push(e);
      if (e.kind === 'form' && e.phase === 'executed' && e.form) {
        const a = actorKey(e.side,e.actor);
        if (!forms.has(a)) forms.set(a,[]);
        forms.get(a).push(e);
      }
    }
    for (const side of ['me','enemy']) for (const p of list(record.sides?.[side]?.pets)) {
      if (!idKnown(p?.instanceId)) continue;
      const key = actorKey(side,p.instanceId);
      if (pets.has(key)) return result;
      pets.set(key,p);
    }
    for (const rows of forms.values()) rows.sort((a,b) => before(a,b) ? -1 : before(b,a) ? 1 : 0);
    function speciesAt(p,e,initial) {
      let id = p.monsterId;
      if (initial) return id;
      const rows = forms.get(actorKey(e.side,e.actor)) || [];
      for (const f of rows) {
        if (f.round === e.round && f.seq === e.seq && !before(e,f) && !before(f,e)) return 0;
        if (!before(f,e)) continue;
        if (rows.some(other => other.id !== f.id && other.round === f.round && other.seq === f.seq && !before(f,other) && !before(other,f)) || f.form.fromMonsterId !== id) return 0;
        id = f.form.toMonsterId;
      }
      return id;
    }
    const actionType = e => {
      if (e.combat?.typeId !== undefined && e.combat.typeId !== null) return cat.types.get(e.combat.typeId) || null;
      if (e.combat?.actionKind === 'wishImpact' || e.skillId === 180) return null; // actual weather type of 天光 is required
      return cat.skills.get(e.skillId)?.code || null;
    };
    function prefix(snapshot,entry,initial,rule) {
      const coverage = {mode:'unknown',complete:record.quality?.actions === true,unknownActions:0,ambiguousOrder:0};
      const sourceSide = rule.derive === 'historyEnemyChargeSwitch' ? snapshot.side === 'me' ? 'enemy' : 'me' : snapshot.side;
      const candidates = events.filter(e => e.side === sourceSide && (isUse(e) || rule.derive === 'historyEnemyChargeSwitch' && (isCharge(e) || e.kind === 'switch' && e.phase === 'executed')));
      const frames = new Map();
      for (const e of candidates) { const k = frame(e); if (!frames.has(k)) frames.set(k,[]); frames.get(k).push(e); }
      let count = 0;
      const types = new Set();
      for (const e of events) {
        if (initial || e.side !== sourceSide) continue;
        if (e.kind === 'skill' && e.phase === 'unknown' && before(e,entry) && !['passive','system'].includes(e.skillClass) && !isNoAction(e)) { coverage.unknownActions++; continue; }
        const switching = rule.derive === 'historyEnemyChargeSwitch' && e.kind === 'switch' && e.phase === 'executed';
        const charge = rule.derive === 'historyEnemyChargeSwitch' && isCharge(e), use = isUse(e);
        if (!switching && !charge && !use) continue;
        if (!before(e,entry)) { if (e.round === entry.round && e.seq === entry.seq && !before(entry,e)) coverage.ambiguousOrder++; continue; }
        if (!sideKnown(e.side) || !pets.has(actorKey(e.side,e.actor))) { coverage.unknownActions++; continue; }
        if (frames.get(frame(e)).some(other => other.id !== e.id && !before(e,other) && !before(other,e))) { coverage.ambiguousOrder++; continue; }
        if (use && !cat.skills.has(e.skillId) && e.combat?.actionKind !== 'wishImpact') { coverage.unknownActions++; continue; }
        let match = false, known = true;
        switch (rule.derive) {
          case 'historyEnemyChargeSwitch':
            if (switching) known = pets.has(actorKey(e.side,e.target)) && e.target !== e.actor && (!e.targetSide || e.targetSide === e.side);
            match = charge || switching;
            break;
          case 'historyResponse':
            if (e.skillClass === 'response') {
              const target = ids.get(e.combat?.counteredActionId);
              known = !!target && target.side !== e.side && target.round === e.round && !isNoAction(target) && ['executed','interrupted'].includes(target.phase) && e.combat?.responseAttempt !== false;
              match = known;
            } else if (!e.skillClass || e.skillClass === 'unknown') known = false;
            break;
          case 'historyCost3':
            known = nonnegative(e.energyCost); match = known && e.energyCost === 3;
            break;
          case 'historyStatus': case 'historyDefense': {
            const s = cat.skills.get(e.skillId); known = !!s || e.combat?.actionKind === 'wishImpact';
            match = !!s && s.category === (rule.derive === 'historyStatus' ? 'Status' : 'Defense');
            break;
          }
          default: {
            const type = actionType(e); known = !!type;
            if (rule.derive === 'historyWater') match = type === 'Water';
            else if (rule.derive === 'historyFightingGround') match = ['Fighting','Ground'].includes(type);
            else if (['historyFire','historyFireCap10'].includes(rule.derive)) match = type === 'Fire';
            else if (rule.derive === 'historyDistinctType' && type && !types.has(type)) { match = true; types.add(type); }
          }
        }
        if (!known) { coverage.unknownActions++; continue; }
        if (match) { count++; snapshot.evidenceEventIds.push(e.id); }
      }
      if (rule.derive === 'historyFireCap10') count = Math.min(count,10);
      coverage.complete = coverage.complete && coverage.unknownActions === 0 && coverage.ambiguousOrder === 0;
      coverage.mode = coverage.complete ? 'completePrefix' : count > 0 ? 'observedPrefix' : 'unknown';
      snapshot.known = count > 0 || coverage.complete; snapshot.count = snapshot.known ? count : null; snapshot.coverage = coverage;
    }
    function appendEntry(e,initial = false) {
      const p = pets.get(actorKey(e.side,e.actor));
      if (!p) return;
      const monsterId = speciesAt(p,e,initial), traitId = cat.monsters.get(monsterId)?.traitId, rule = cat.verified.get(traitId);
      if (!rule) return;
      const unit = rule.derive === 'historyWater' ? '层' : rule.derive === 'historyDistinctType' ? '种系别' : '次';
      const snapshot = {eventId:e.id || '',round:e.round || 0,seq:e.seq || 0,execIndex:indexOf(e),side:e.side,actor:e.actor,monsterId,traitId,name:rule.name,unit,count:null,known:false,
        coverage:{mode:'unknown',complete:false,unknownActions:0,ambiguousOrder:0},derivedBasis:rule.derive,evidenceEventIds:[]};
      if (historical(rule)) prefix(snapshot,e,initial,rule);
      result.entries.push(snapshot);
    }
    const active = new Map();
    for (const side of ['me','enemy']) if (record.quality?.lead?.[side] === true && idKnown(record.sides?.[side]?.lead)) {
      const actor = record.sides[side].lead; active.set(side,actor); appendEntry({side,actor,round:0,seq:0},true);
    }
    const presence = events.filter(e => e.phase === 'executed' && (e.kind === 'switch' || isSupply(e) || e.kind === 'resource' && typeof e.stateActive === 'boolean' && (e.stateStage === 'entry' || !e.stateActive) || isFaint(e) || e.kind === 'effect' && e.combat?.leaveReason === 'defeat'));
    presence.sort((a,b) => before(a,b) ? -1 : before(b,a) ? 1 : 0);
    const frames = new Map();
    for (const e of presence) { const k = frame(e); if (!frames.has(k)) frames.set(k,[]); frames.get(k).push(e); }
    for (const e of presence) {
      if (frames.get(frame(e)).some(other => other.id !== e.id && !before(e,other) && !before(other,e))) { active.delete(e.side); continue; }
      if (e.kind === 'switch') {
        if (!idKnown(e.target) || e.target === e.actor || e.targetSide && e.targetSide !== e.side) { active.delete(e.side); continue; }
        if (active.get(e.side) !== e.actor) appendEntry(e);
        active.set(e.side,e.actor);
      } else if (isSupply(e) || e.kind === 'resource' && e.stateStage === 'entry' && e.stateActive === true) {
        if (active.get(e.side) !== e.actor) appendEntry(e);
        active.set(e.side,e.actor);
      } else if (active.get(e.side) === e.actor) active.delete(e.side);
    }
    return result;
  }
  return Object.freeze({project,rules,before,executionIndex:indexOf});
});
