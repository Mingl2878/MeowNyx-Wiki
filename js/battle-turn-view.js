/* Read-only normalized battle-record projection. No catalogue, profile, DOM or I/O. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BattleTurnView = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const SIDES = ['me', 'enemy'];
  const systemActions = () => root.BattleSystemActions || (typeof module === 'object' && module.exports && typeof require === 'function' ? require('./battle-system-actions.js') : null);
  const isNoAction = event => systemActions()?.isNoAction?.(event) === true;
  const list = value => Array.isArray(value) ? value : [];
  const sideKnown = side => SIDES.includes(side);
  const instanceKnown = id => typeof id === 'string' && id.length > 0;
  const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
  const monsterId = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const roundOf = event => nonnegative(event.round) && event.round <= 1000000 ? event.round : 0;
  const seqOf = event => nonnegative(event.seq) ? event.seq : 0;
  const key = (...parts) => JSON.stringify(parts);
  const petCopy = pet => pet ? { ...pet } : null;
  const executionIndex = event => nonnegative(event.execIndex) ? event.execIndex : nonnegative(event.form?.execIndex) ? event.form.execIndex : null;
  const exactMatch = (pattern, value) => {
    const match = typeof value === 'string' && pattern.exec(value);
    return match && match[0] === value ? match : null; // JS $ alone also accepts a final newline.
  };

  function lifecycleKind(event) {
    if (event.kind !== 'note') return '';
    if (['enter', 'round_start', 'finish'].includes(event.lifecycle)) return event.lifecycle;
    if (event.lifecycle !== undefined && event.lifecycle !== null && event.lifecycle !== '') return '';
    if (!nonnegative(event.round) || event.round > 1000000) return '';
    for (const [opcode, kind, source] of [['1316', 'enter', 'battle_enter'], ['131a', 'round_start', 'round_start'], ['132c', 'finish', 'battle_finish']]) {
      if (event.id === `rkpp:${opcode}:${event.round}` && event.text === `Observed RKPP ${source}; gameplay attribution unavailable.`) return kind;
    }
    return '';
  }
  function isAction(event) {
    if (isNoAction(event) || !['executed', 'interrupted'].includes(event.phase) || event.skillClass === 'passive') return false;
    return event.kind === 'skill' || event.kind === 'effect' && event.skillClass === 'system';
  }
  function isFaint(event) {
    return event.kind === 'effect' && event.phase === 'executed' &&
      exactMatch(/^rkpp:action:\d+:\d+:\d+:faint$/, event.id) && event.label === '倒下通知' &&
      event.text === '明确 dead_info；不由动画或HP推测。';
  }
  function isSupply(event) {
    const match = exactMatch(/^rkpp:action:\d+:\d+:\d+:supply:(.+)$/, event.id);
    return event.kind === 'effect' && event.phase === 'executed' && match && match[1] === event.actor &&
      event.label === '补位通知' && event.text === '同一既有实例的 supply_pet 通知；不增加初始队员。';
  }
  function sourceRef(event) {
    // This reference is a protocol identity, NEVER a local skill ID or a label.
    if (instanceKnown(event.protocolSkillId)) return event.protocolSkillId;
    if (event.protocolSkillId !== undefined && event.protocolSkillId !== null && event.protocolSkillId !== '') return null;
    if (event.kind !== 'damage' || !exactMatch(/^rkpp:action:\d+:\d+:\d+:damage_info$/, event.id)) return null;
    const match = exactMatch(/^同一条执行消息、同一目标的数值同步；来源标识 (\d+)（不直接当作技能ID）。CSV逻辑行 \d+。 报告伤害与实际生命变化分开保留，不推导隐藏配置。$/, event.text);
    return match ? match[1] : null;
  }
  function associationBase(event) {
    // Missing chronology or side/instance evidence cannot match another missing value.
    return nonnegative(event.round) && nonnegative(event.seq) && sideKnown(event.side) && instanceKnown(event.actor);
  }
  function damageKey(event, ref) {
    return associationBase(event) && ref && sideKnown(event.targetSide) && instanceKnown(event.target) && executionIndex(event) !== null
      ? key(event.round, event.seq, event.side, event.actor, event.targetSide, event.target, ref) : null;
  }
  function energyKey(event) {
    // Energy requires the explicit top-level index, not a legacy nested fallback.
    return associationBase(event) && nonnegative(event.execIndex) ? key(event.round, event.seq, event.execIndex, event.side, event.actor) : null;
  }
  function append(map, id, value) {
    if (id === null) return;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(value);
  }
  function associate(turn) {
    const actions = SIDES.flatMap(side => turn.sides[side].actions);
    const damageActions = new Map(), energyActions = new Map(), resources = new Map();
    // Removing a skip from actions must not make a colliding resource suddenly
    // attributable to another cast at the same execution slot.
    const skippedEnergy = new Set(turn.events.filter(isNoAction).map(energyKey).filter(id => id !== null));
    const assigned = new Set(actions.map(action => action.event));
    for (const action of actions) {
      const event = action.event;
      if (event.phase === 'executed') append(damageActions, damageKey(event, sourceRef(event)), action);
      append(energyActions, energyKey(event), action);
    }
    for (const event of turn.events) {
      if (event.phase !== 'executed') continue;
      if (event.kind === 'resource') append(resources, energyKey(event), event);
      if (event.kind !== 'damage') continue;
      const candidates = damageActions.get(damageKey(event, sourceRef(event))) || [];
      let match = null, count = 0;
      for (const action of candidates) {
        if (executionIndex(action.event) < executionIndex(event)) {
          match = action;
          if (++count > 1) break; // Ambiguity is not resolved by picking the nearest cast.
        }
      }
      if (count === 1) { match.damageEvents.push(event); assigned.add(event); }
    }
    for (const [id, events] of resources) {
      const candidates = energyActions.get(id) || [];
      if (skippedEnergy.has(id) || events.length !== 1 || candidates.length !== 1 || !Number.isSafeInteger(events[0].energyChange)) continue;
      const event = events[0], action = candidates[0], delta = event.energyChange;
      action.energyEvents.push(event);
      if (delta <= 0) action.energyCost = -delta || 0;
      if (delta >= 0) action.energyGain = delta;
      assigned.add(event);
    }
    for (const action of actions) {
      const hits = action.damageEvents;
      // Never present a partial known subtotal as the complete action damage.
      // Source hits remain intact even when a missing/invalid/overflowing number
      // prevents a trustworthy scalar aggregate.
      if (hits.length && hits.every(event => Number.isFinite(event.amount) && event.amount >= 0 && event.amount <= Number.MAX_SAFE_INTEGER)) {
        const total = hits.reduce((sum, event) => sum + event.amount, 0);
        if (Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER) action.damage = total;
      }
      if (hits.length && hits.every(event => Number.isSafeInteger(event.hpChange) && event.hpChange <= 0)) {
        const total = hits.reduce((sum, event) => sum - event.hpChange, 0);
        if (Number.isSafeInteger(total)) action.hpLoss = total;
      }
    }
    // All other source events remain available, including forms, supply/faint,
    // bench values, unlinked numbers, unknown-phase actions and passive effects.
    turn.unassigned = turn.events.filter(event => !assigned.has(event));
  }
  function timeline(events, total) {
    const groups = new Map();
    for (const event of events) {
      const round = roundOf(event);
      if (!groups.has(round)) groups.set(round, []);
      groups.get(round).push(event);
    }
    const turns = [], add = (round, rows, endRound) => {
      const turn = { round, sides: {}, events: rows, unassigned: [] };
      if (endRound !== undefined) turn.endRound = endRound;
      turns.push(turn);
    };
    let next = 1;
    function gap(end) {
      if (end < next) return;
      if (end - next >= 100) add(next, [], end);
      else for (let round = next; round <= end; round++) add(round, []);
      next = end + 1;
    }
    for (const [round, rows] of groups) {
      if (total && round > 0) gap(Math.min(total, round - 1));
      add(round, rows);
      if (round > 0) next = Math.max(next, round + 1);
    }
    if (total) gap(total);
    return turns;
  }

  function project(record, options = {}) {
    record = record && typeof record === 'object' ? record : {};
    const lookup = (fn, id) => { try { return typeof fn === 'function' ? fn(id) : null; } catch (_) { return null; } };
    const getMove = id => lookup(options.getMoveById, id);
    const knownStage = event => event.kind === 'resource' && event.phase === 'executed' && ['initial', 'snapshot', 'entry'].includes(event.stateStage);
    const uniqueEvents = [], seenEvents = new Map();
    const signature = event => JSON.stringify(event, (_, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
    for (const event of list(record.events)) {
      if (!event || typeof event !== 'object') continue;
      if (instanceKnown(event.id) && seenEvents.has(event.id)) {
        if (signature(event) !== signature(seenEvents.get(event.id))) throw Error('战报存在冲突的事件 ID');
        continue;
      }
      if (instanceKnown(event.id)) seenEvents.set(event.id, event);
      uniqueEvents.push(event);
    }
    const initialEvents = uniqueEvents.filter(event => knownStage(event) && event.stateStage === 'initial' && event.round === 0);
    const entered = new Set();
    const warnings = ['按最后记录；缺项未确认。生命、能量及在场信息不是完整回合结束快照。'];
    if (record.quality?.actions !== true) warnings.push('行动记录不完整或完整性未确认；缺少行动不代表未行动。');
    const events = uniqueEvents.map((event, index) => ({ event, index }))
      .sort((a, b) => roundOf(a.event) - roundOf(b.event) || seqOf(a.event) - seqOf(b.event) ||
        (executionIndex(a.event) ?? 0) - (executionIndex(b.event) ?? 0) || a.index - b.index).map(item => item.event);
    const lifecycle = events.filter(event => lifecycleKind(event));
    const total = nonnegative(record.rounds) && record.rounds > 0 && record.rounds <= 1000000 ? record.rounds : null;
    const rounds = timeline(events.filter(event => !lifecycleKind(event) && !initialEvents.includes(event)), total);
    const roster = new Map(), duplicateRoster = new Set(), identities = new Map(), forms = new Map(), values = new Map();
    const slots = new Map(SIDES.map(side => [side, { status: 'unknown', id: null, sourceRound: 0, evidence: [], pending: null }]));
    for (const side of SIDES) for (const pet of list(record.sides?.[side]?.pets)) {
      if (!pet || !instanceKnown(pet.instanceId)) continue;
      const id = key(side, pet.instanceId);
      // Even malformed duplicate roster identities must not select the last name.
      if (roster.has(id)) { duplicateRoster.add(id); roster.set(id, { instanceId: pet.instanceId, monsterId: 0, declaredName: '' }); continue; }
      roster.set(id, { instanceId: pet.instanceId, monsterId: monsterId(pet.monsterId), declaredName: typeof pet.name === 'string' ? pet.name : '' });
    }
    // Only an explicit verified lead declaration may seed the initial slot.
    // Round 0 means initial declaration; do not fabricate an event or values.
    for (const side of SIDES) {
      const lead = record.sides?.[side]?.lead, id = key(side, lead);
      if (record.quality?.lead?.[side] === true && instanceKnown(lead) && roster.has(id) && !duplicateRoster.has(id)) {
        const slot = slots.get(side);
        slot.status = 'present'; slot.id = lead; entered.add(id);
      }
    }
    function petAt(side, instanceId) {
      if (!sideKnown(side) || !instanceKnown(instanceId)) return null;
      const id = key(side, instanceId), original = roster.get(id);
      return { instanceId, monsterId: identities.has(id) ? identities.get(id) : original?.monsterId || 0, declaredName: original?.declaredName || '' };
    }
    function snapshot(side) {
      // An unknown slot may carry a unique interrupted/system participant.
      // Its measured values remain useful, but never assert confirmed presence.
      const slot = slots.get(side), pet = slot.status !== 'empty' ? petAt(side, slot.id) : null;
      const state = pet ? values.get(key(side, pet.instanceId)) : null;
      return {
        status: slot.status, pet, hp: state?.hp ?? null, hpMax: state?.hpMax ?? null, hpRatio: state?.hpRatio ?? null, energy: state?.energy ?? null,
        hpRound: state?.hpRound ?? null, energyRound: state?.energyRound ?? null,
        sourceRound: slot.sourceRound, confirmedActive: slot.status === 'present',
        evidence: [...new Set([...slot.evidence, pet && forms.get(key(side, pet.instanceId)), state?.hpEvent, state?.energyEvent].filter(Boolean))]
      };
    }
    function participant(turn, side, pet) {
      if (!pet) return;
      const pets = turn.sides[side].participants;
      if (!pets.some(item => item.instanceId === pet.instanceId && item.monsterId === pet.monsterId)) pets.push(petCopy(pet));
    }
    function activate(turn, event) {
      const slot = slots.get(event.side), pet = petAt(event.side, event.actor);
      if (!pet) return false;
      entered.add(key(event.side, pet.instanceId));
      slot.status = 'present'; slot.id = pet.instanceId; slot.sourceRound = roundOf(event); slot.evidence = [event]; slot.pending = null;
      participant(turn, event.side, pet);
      return true;
    }
    function updateValues(event) {
      if (event.phase !== 'executed' || !['damage', 'heal', 'resource'].includes(event.kind)) return;
      const side = event.kind === 'resource' ? event.side : event.targetSide;
      const instanceId = event.kind === 'resource' ? event.actor : event.target;
      if (!sideKnown(side) || !instanceKnown(instanceId)) return;
      const touched = nonnegative(event.hpAfter) || nonnegative(event.hpMax) && event.hpMax > 0 || event.kind === 'resource' && nonnegative(event.energyAfter) || (Number.isSafeInteger(event.hpChange) || event.kind === 'resource' && Number.isSafeInteger(event.energyChange));
      if (!touched) return;
      const id = key(side, instanceId), next = { ...(values.get(id) || { hp: null, hpMax: null, hpRatio: null, energy: null, hpRound: null, energyRound: null }) };
      if (nonnegative(event.hpMax) && event.hpMax > 0) next.hpMax = event.hpMax;
      if (nonnegative(event.hpAfter)) {
        next.hp = event.hpAfter; next.hpRound = roundOf(event); next.hpEvent = event;
      } else if (Number.isSafeInteger(event.hpChange)) {
        next.hp = nonnegative(next.hp) && nonnegative(next.hp + event.hpChange) ? next.hp + event.hpChange : null;
        if (next.hp === null && event.hpChange !== 0) next.hpRatio = null;
        next.hpRound = roundOf(event); next.hpEvent = event;
      }
      if (next.hp !== null) next.hpRatio = next.hpMax > 0 ? Math.max(0, Math.min(1, next.hp / next.hpMax)) : next.hp === 0 ? 0 : null;
      if (event.kind === 'resource' && nonnegative(event.energyAfter)) {
        next.energy = event.energyAfter; next.energyRound = roundOf(event); next.energyEvent = event;
      } else if (event.kind === 'resource' && Number.isSafeInteger(event.energyChange)) {
        next.energy = nonnegative(next.energy) && nonnegative(next.energy + event.energyChange) ? next.energy + event.energyChange : null;
        next.energyRound = roundOf(event); next.energyEvent = event;
      }
      values.set(id, next);
      const slot = slots.get(side);
      if (slot.status !== 'empty' && slot.id === instanceId) slot.sourceRound = roundOf(event);
    }
    function applyPresence(event) {
      if (!knownStage(event) || !roster.has(key(event.side, event.actor)) || typeof event.stateActive !== 'boolean') return;
      const slot = slots.get(event.side);
      if (event.stateActive) {
        slot.status = 'present'; slot.id = event.actor; slot.sourceRound = roundOf(event); slot.evidence = [event]; slot.pending = null;
        entered.add(key(event.side, event.actor));
      } else if (slot.status === 'present' && slot.id === event.actor) {
        slot.status = 'unknown'; slot.id = null; slot.sourceRound = roundOf(event); slot.evidence = [event];
      }
    }
    function costs(turn) {
      for (const side of SIDES) for (const action of turn.sides[side].actions) {
        const e = action.event;
        if (action.energyCost !== null) continue; // actual signed expenditure wins
        if (nonnegative(e.energyCost)) { action.energyCost = e.energyCost; continue; }
        const move = getMove(e.skillId);
        if (move && nonnegative(move.energy_cost)) action.energyCost = move.energy_cost;
        else if (e.skillClass === 'system' && e.protocolSkillId === '700001000' && e.label === '聚能') action.energyCost = 0;
      }
    }
    for (const event of initialEvents) { updateValues(event); applyPresence(event); }
    for (const turn of rounds) {
      const actionSeen = { me: false, enemy: false };
      const uncertain = { me: new Set(), enemy: new Set() };
      for (const side of SIDES) {
        turn.sides[side] = { participants: [], actions: [], annotations: [], endState: null, replacements: [], notes: [] };
        const slot = slots.get(side);
        if (slot.status === 'present') participant(turn, side, petAt(side, slot.id));
      }
      const actionByEvent = new Map(), appliedEntryStates = new Set();
      for (const event of turn.events) if (sideKnown(event.side) && isAction(event)) {
        const action = { event, pet: null, damage: null, hpLoss: null, energyCost: null, energyGain: null, damageEvents: [], energyEvents: [] };
        turn.sides[event.side].actions.push(action); actionByEvent.set(event, action);
      }
      associate(turn); costs(turn);
      for (const event of turn.events) {
        const side = event.side, slot = slots.get(side), action = actionByEvent.get(event);
        if (slot && isNoAction(event)) {
          // A confirmed skip names this instance, not a cast or proof of presence.
          // Keep its event in unassigned; resource/HP facts still advance below.
          turn.sides[side].annotations.push({ kind: 'stunSkip', event, pet: petAt(side, event.actor) });
        }
        if (slot && action) {
          const pet = petAt(side, event.actor);
          participant(turn, side, pet);
          action.pet = pet;
          actionSeen[side] = true;
          // A system notification can originate from the bench. It is visible
          // as an action, but cannot establish or change the confirmed slot.
          if (event.phase === 'executed' && event.kind === 'skill' && event.skillClass !== 'system') activate(turn, event);
          else if (slot.status === 'unknown') {
            uncertain[side].add(pet?.instanceId || null);
            slot.id = uncertain[side].size === 1 && pet ? pet.instanceId : null;
            slot.sourceRound = roundOf(event); slot.evidence = [event];
          }
        }
        if (slot && event.phase === 'executed') {
          if (event.kind === 'switch') {
            // The normalized switch actor is incoming, target is outgoing.
            if (!activate(turn, event)) {
              slot.status = 'unknown'; slot.id = null; slot.sourceRound = roundOf(event); slot.evidence = [event]; slot.pending = null;
              uncertain[side].clear();
            }
          } else if (isFaint(event) && slot.status === 'present' && slot.id === event.actor) {
            slot.status = 'empty'; slot.id = null; slot.sourceRound = roundOf(event); slot.evidence = [event]; slot.pending = { round: turn.round, turn };
          } else if (isSupply(event) && roster.has(key(side, event.actor))) {
            const pending = slot.pending, wasEmpty = slot.status === 'empty';
            // Same-entry snapshot is the replacement's own state, never a later action result.
            for (const state of turn.events) if (state.stateStage === 'entry' && state.kind === 'resource' && state.side === side && state.actor === event.actor && state.seq === event.seq && state.execIndex === event.execIndex && !appliedEntryStates.has(state)) {
              updateValues(state); appliedEntryStates.add(state);
            }
            if (activate(turn, event)) {
              const replacement = snapshot(side); // immutable-in-time: before later resource/actions
              const previous = wasEmpty && pending && pending.round + 1 === turn.round && !actionSeen[side] &&
                pending.turn.sides[side].endState?.status === 'empty';
              (previous ? pending.turn : turn).sides[side].replacements.push(replacement);
            }
          } else if (event.kind === 'form' && roster.has(key(side, event.actor))) {
            identities.set(key(side, event.actor), monsterId(event.form?.toMonsterId));
            forms.set(key(side, event.actor), event);
            if (slot.status === 'present' && slot.id === event.actor) {
              slot.sourceRound = roundOf(event);
              participant(turn, side, petAt(side, event.actor));
            }
          }
        }
        if (!appliedEntryStates.has(event)) updateValues(event);
        if (event.stateStage === 'entry') appliedEntryStates.add(event);
        applyPresence(event);
      }
      turn.teamStates = Object.fromEntries(SIDES.map(side => [side, list(record.sides?.[side]?.pets).map(pet => ({ pet: petAt(side, pet.instanceId), ...(values.get(key(side, pet.instanceId)) || {}), hasEntered: entered.has(key(side, pet.instanceId)) }))]));
      for (const side of SIDES) {
        const view = turn.sides[side];
        view.endState = snapshot(side);
        if (view.endState.status === 'unknown') view.notes.push('在场精灵未确认；不按阵容顺序、受击或资源同步推定。');
        if (!view.actions.length && !view.annotations.length) view.notes.push('没有解析到可确认的行动，不代表未行动。');
      }
    }
    return { rounds, lifecycle, warnings };
  }
  return { project };
});
