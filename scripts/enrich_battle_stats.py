"""Add reviewed combat facts to an immutable normalized record, offline only.

No profile/database writes, packet decoder, network, inferred speed, damage-formula
inversion or HP fallback. Protocol schema facts are read from one explicit SQLite
kv row, read-only. RKPP implementation is not used or copied. Raw annotations
(skill_name/skill_desc/skill_priority/skill_damage_type) are deliberately ignored.
"""
import argparse
import collections
import copy
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from enrich_battle_states import array, bounded_source, integer, object_value, pet_id, signed32, unwrap
from enrich_battle_metadata import digest, roster_from_opening, settlement, strict_json

SOURCE_SHA256 = 'c80cec7ea42edf5b0a7825b73f23b1b9204dadbc9e2d93d2c02cfb9b64f8999b'
SCHEMA_SHA256 = 'c90a418b8313882228d719ed218395371e7f9c9d59594a9527d21e96cc4eb33d'
BATTLE_ID = '1876469132858231449'
CATEGORIES = {'Physical Attack': True, 'Magic Attack': True, 'Status': False, 'Defense': False}
# Explicitly reviewed local response conditions, not a substring heuristic.
# Name + exact description must still match; negation/changed prose stays unknown.
REVIEWED_RESPONSES = {
    27: ('快速移动', '自己获得速度+80， 应对防御 ：改为速度+160。', True),
    52: ('偷袭', '造成物伤， 应对状态 ：本次技能威力变为3倍。', True),
    58: ('先发制人', '造成物理伤害， 先手 +1。', False),
    68: ('摇篮曲', '敌方获得全技能能耗+3， 应对防御 ：额外造成 打断 ，且敌方下回合获得眩晕。', True),
    74: ('有效预防', '减伤50%， 应对攻击 ：下一次行动获得 先手 +1。', True),
    155: ('水弹', '对敌方精灵造成魔法伤害。', False),
    161: ('水泡盾', '减伤80%， 应对攻击 ：自己获得魔攻+70%。', True),
    164: ('天洪', '造成魔伤， 应对状态 ：本技能能耗永久-6。', True),
    187: ('地刺', '造成物伤， 应对状态 ：额外 打断 被应对技能。', True),
    191: ('跺地', '对敌方精灵造成物理伤害。', False),
    217: ('冰捆缚', '2连击，每次连击敌方获得全技能能耗+1。', False),
    225: ('极寒领域', '造成魔伤，若敌方有 冻结 ，本次技能威力+60， 应对状态 ：使 冻结 翻倍。', True),
    303: ('虫击', '造成物伤， 应对状态 ：本次技能威力变为2倍，无视敌方系别抵抗。', True),
    321: ('贮藏', '自己获得双攻+50%，每携带1个0能耗技能，额外+50%。', False),
    339: ('听桥', '减伤60%， 应对攻击 ：对敌方造成武系物理伤害，威力与被应对技能相等。', True),
    351: ('风隐', '敌方和自己均 脱离 ， 先手 -1。', False),
    403: ('蝙蝠', '造成物伤，并 吸血 100%。', False),
    482: ('俯冲', '造成物伤， 先手 +1。', False),
    491: ('相位移动', '减伤50%，本技能位于1号位或3号位时，额外减伤40%， 应对攻击 ， 传动 1。', True),
    492: ('过山车', '使己方队伍中的所有精灵携带的技能跨精灵向下移动1个位置， 巧变 ：机械系技能。', False),
}
RESTRAINT_ENUM = {'-3': 'SRT_RESTRAINTED_THREE', '-2': 'SRT_RESTRAINTED_TWO',
                  '-1': 'SRT_RESTRAINTED_ONE', '0': 'SRT_NONE',
                  '1': 'SRT_RESTRAINT_ONE', '2': 'SRT_RESTRAINT_TWO', '3': 'SRT_RESTRAINT_THREE'}


def numeric_enum(value, label):
    if isinstance(value, dict):
        value = value.get('value')
    return integer(value, label)


def validate_schema(schema):
    """Only facts needed by this enrichment; no interpretation of unknown flags."""
    enums = object_value(schema.get('enums'), 'schema enums')
    for name, expected in {
        'SkillPerformType': {'1': 'SPT_ACTIVE', '2': 'SPT_PASSIVE', '3': 'SPT_COUNTER'},
        'SkillRestraintType': RESTRAINT_ENUM,
        'ChangePetPerformType': {'0': 'CPPT_NORMAL', '1': 'CPPT_NO_BALL'},
    }.items():
        if enums.get(name, {}).get('values') != expected:
            raise ValueError('unreviewed schema enum: ' + name)
    messages = object_value(schema.get('messages'), 'schema messages')
    expected = {
        'BattlePerformInfo': {'1': ('type', 'BattlePerformType'), '2': ('group_id', 'uint32'),
                              '11': ('is_group_head', 'bool'), '26': ('group_ref', 'uint32'),
                              '39': ('exec_index', 'uint32')},
        'BattleSkillCast': {'1': ('caster_id', 'uint32'), '3': ('skill_id', 'uint32'),
                            '7': ('type', 'SkillPerformType'), '8': ('is_interupt', 'bool')},
        'BattleDamageInfo': {'1': ('caster_id', 'uint32'), '2': ('target_id', 'uint32'),
                             '3': ('source_id', 'uint32'), '7': ('restraint_type', 'int32'),
                             '9': ('dam_type', 'int32')},
        'BattleDeadInfo': {'1': ('caster_id', 'uint32'), '2': ('target_id', 'uint32'),
                           '3': ('dead_type', 'BattleDeadInfo.DeadType')},
        'BattleChangePet': {'2': ('rest_pet_id', 'uint32'), '3': ('battle_pet_id', 'uint32'),
                            '5': ('is_cmd', 'bool'), '6': ('perform_type', 'ChangePetPerformType')},
    }
    for name, fields in expected.items():
        actual = messages.get(name, {}).get('fields', {})
        for number, pair in fields.items():
            if tuple(actual.get(number, {}).get(k) for k in ('name', 'type')) != pair:
                raise ValueError('unreviewed schema field: ' + name + '.' + number)
    if enums.get('BattleDeadInfo.DeadType', {}).get('values', {}).get('0') != 'NORMAL_DEAD':
        raise ValueError('unreviewed death enum')


def load_schema(path, expected_sha256):
    """Never query any key besides the explicitly authorized schema payload."""
    try:
        import msgpack
    except ImportError as exc:
        raise ValueError('msgpack required for explicit schema input; use an existing equipped Python') from exc
    uri = Path(path).resolve().as_uri() + '?mode=ro'
    with sqlite3.connect(uri, uri=True) as connection:
        connection.execute('PRAGMA query_only=ON')
        rows = connection.execute("SELECT payload_msgpack FROM kv WHERE kind='proto_schema' AND key='root'").fetchall()
    if len(rows) != 1 or not isinstance(rows[0][0], bytes) or len(rows[0][0]) > 32 * 1024 * 1024:
        raise ValueError('exactly one bounded protocol schema payload required')
    payload = rows[0][0]
    if hashlib.sha256(payload).hexdigest() != expected_sha256:
        raise ValueError('schema payload SHA-256 mismatch')
    schema = msgpack.unpackb(payload, raw=False, strict_map_key=False)
    validate_schema(schema)
    return schema


def event_id(point, suffix):
    return 'rkpp:action:' + ':'.join(map(str, point)) + ':' + suffix


def corroborate_orientation(record, initial, entries, catalog, schema):
    """Two reviewed capture-specific checks against actual types, not damage size.

    This corroborates enum direction only. It does NOT produce a numeric ratio or
    infer the class of any other damage from today's static type chart.
    """
    if record['id'] != 'rkpp:' + BATTLE_ID:
        return []
    enum = schema['enums'].get('AttributeType', {}).get('values', {})
    if (enum.get('26'), enum.get('27')) != ('AT_DAMTYPE1', 'AT_DAMTYPE2'):
        raise ValueError('unreviewed actual attribute-type indices')
    reviewed_types = {3: ('SDT_GRASS', 'Grass'), 5: ('SDT_WATER', 'Water'),
                      9: ('SDT_ICE', 'Ice'), 14: ('SDT_FIGHT', 'Fighting'),
                      15: ('SDT_WING', 'Flying')}
    raw_types = schema['enums'].get('SkillDamType', {}).get('values', {})
    local_types = {}
    for raw, (name, code) in reviewed_types.items():
        matches = [t for t in catalog.get('types', []) if t.get('code') == code]
        if raw_types.get(str(raw)) != name or len(matches) != 1:
            raise ValueError('type orientation identity mismatch')
        local_types[raw] = matches[0]
    samples = collections.defaultdict(list)

    def observe(pet, point, line):
        inside = pet.get('battle_inside_pet_info', {})
        attrs = inside.get('battle_attr', [])
        if inside.get('pet_id') in (402, 404) and len(attrs) > 27:
            samples[inside['pet_id']].append((point, tuple(attrs[26:28]), line))

    for collection in ('player_team', 'enemy_team', 'others'):
        for team in initial[0].get(collection, []):
            for pet in team.get('pets', []):
                observe(pet, (0, 0, 0), initial[1])
    for point, entry, line in entries:
        update = entry.get('data_update', {})
        if 'pet' in update:
            observe(update['pet'], point, line)
        for pet in update.get('other', {}).get('pets', []):
            observe(pet, point, line)
        for container, field in (('change_pet', 'battle_pet_info'), ('change_model', 'pet_info')):
            if field in entry.get(container, {}):
                observe(entry[container][field], point, line)
        for item in entry.get('supply_pet', {}).get('pet_infos', []):
            if 'pet_info' in item:
                observe(item['pet_info'], point, line)
    checks = []
    for wanted, target, attack_type, expected_types, expected_tier in (
        ((25, 134, 5), 402, 15, (5, 14), 1),
        ((31, 172, 2), 404, 5, (3, 9), -2),
    ):
        rows = [(entry, line) for point, entry, line in entries if point == wanted and 'damage_info' in entry]
        if len(rows) != 1:
            raise ValueError('reviewed orientation damage missing/ambiguous')
        entry, line = rows[0]
        damage = entry['damage_info']
        prior = sorted(sample for sample in samples[target] if sample[0] < wanted)
        if not prior:
            raise ValueError('orientation target has no explicit type snapshot')
        point, target_types, type_line = prior[-1]
        if (damage.get('target_id'), damage.get('dam_type'), signed32(damage.get('restraint_type')), target_types) != (target, attack_type, expected_tier, expected_types):
            raise ValueError('reviewed orientation source facts changed')
        attack_local = local_types[attack_type]['id']
        relations = []
        net = 0
        for target_type in target_types:
            target_local = local_types[target_type]
            vulnerable = attack_local in target_local.get('vulnerable_to', [])
            resistant = attack_local in target_local.get('resistant_to', [])
            if vulnerable and resistant:
                raise ValueError('conflicting catalog type relation')
            net += int(vulnerable) - int(resistant)
            relations.append({'targetTypeId': target_local['id'], 'targetTypeCode': target_local['code'],
                              'relationship': 'vulnerable_to' if vulnerable else 'resistant_to' if resistant else 'neutral'})
        if net != expected_tier:
            raise ValueError('type chart fails restraint orientation corroboration')
        checks.append({'eventId': event_id(wanted, 'damage_info'), 'csvLine': line,
                       'coordinate': list(wanted), 'damageProtocolType': attack_type,
                       'damageLocalTypeId': attack_local, 'target': str(target),
                       'targetProtocolTypes': list(target_types), 'typeSourceCoordinate': list(point),
                       'typeSourceCsvLine': type_line, 'rawSignedTier': expected_tier,
                       'catalogRelationships': relations, 'numericMultiplierInferred': False})
    return checks


def enrich(source, document, catalog, schema, expected_boundary=None):
    """Return copy + sanitized audit; never mutate inputs or add/remove events."""
    validate_schema(schema)
    original = unwrap(document)
    result = copy.deepcopy(document)
    record = unwrap(result)
    if catalog.get('schema_version') != 2:
        raise ValueError('catalog schema version 2 required')
    skills = {}
    for skill in array(catalog.get('skills'), 'catalog skills'):
        sid = integer(skill.get('id'), 'stable skill ID', 1)
        if sid in skills:
            raise ValueError('duplicate catalog skill ID')
        skills[sid] = skill
    initial, entries, boundary_counts = bounded_source(source, record)
    if len(entries) > 100000:
        raise ValueError('primary entry budget exceeded')
    _, finish_line = settlement(source, record, initial[1])
    if expected_boundary is not None and (initial[1], finish_line) != tuple(expected_boundary):
        raise ValueError('logical CSV boundary mismatch')
    roster, sides, _, _ = roster_from_opening(initial[0], record)
    events, by_id = array(record.get('events'), 'normalized events'), {}
    for event in events:
        eid = event.get('id')
        if not isinstance(eid, str) or eid in by_id:
            raise ValueError('unique normalized event IDs required')
        by_id[eid] = event
    counts = collections.Counter()
    evidence = collections.defaultdict(list)
    raw_by_id, heads = {}, collections.defaultdict(list)
    groups = collections.defaultdict(list)

    def normalized(point, suffix, kind, actor, side, phase='executed'):
        eid = event_id(point, suffix)
        event = by_id.get(eid)
        if not event or event.get('kind') != kind or event.get('phase') != phase or event.get('actor') != actor or event.get('side') != side or tuple(event.get(k) for k in ('round', 'seq', 'execIndex')) != point:
            raise ValueError('normalized event differs from primary source: ' + eid)
        return event

    def add(event, field, value, proof):
        combat = event.setdefault('combat', {})
        object_value(combat, 'combat facts')
        if field in combat and (type(combat[field]) is not type(value) or combat[field] != value):
            raise ValueError('existing combat fact conflicts: ' + event['id'] + ':' + field)
        combat[field] = copy.deepcopy(value)
        counts[field] += 1
        evidence[event['id']].append({'field': field, 'value': value, **proof})

    def actor(value):
        pid = pet_id(value)
        if pid not in sides:
            raise ValueError('combat actor outside normalized roster')
        return pid

    # Group identities are primary (round, seq, group_id), NOT nearest events.
    for point, entry, line in entries:
        typ = numeric_enum(entry.get('type'), 'primary type')
        group = integer(entry.get('group_id'), 'primary group', 1)
        key = (*point[:2], group)
        groups[key].append((point, entry, line))
        if entry.get('is_group_head') is True:
            heads[key].append((point, entry, line))
        if typ != 1:
            continue
        cast = object_value(entry.get('skill_cast'), 'primary cast')
        if not cast.get('caster_id') or not cast.get('skill_id'):
            continue
        pid = actor(cast['caster_id'])
        runtime = str(integer(cast['skill_id'], 'runtime skill ID', 1))
        eid = event_id(point, 'cast')
        event = by_id.get(eid)
        if not event or event.get('kind') not in ('skill', 'effect'):
            raise ValueError('primary cast missing from original normalized record')
        interrupt = cast.get('is_interupt', False)
        if type(interrupt) is not bool:
            raise ValueError('invalid explicit interruption flag')
        normalized(point, 'cast', event['kind'], pid, sides[pid], 'interrupted' if interrupt else 'executed')
        if event.get('protocolSkillId') != runtime:
            raise ValueError('runtime skill identity mismatch')
        ctype = numeric_enum(cast.get('type'), 'cast type')
        expected_class = {2: 'passive', 3: 'response'}.get(ctype)
        if ctype not in (1, 2, 3) or expected_class and event.get('skillClass') != expected_class:
            raise ValueError('cast classification mismatch')
        if eid in raw_by_id and raw_by_id[eid] != (point, entry, line):
            raise ValueError('ambiguous cast identity')
        raw_by_id[eid] = (point, entry, line)
        proof = {'csvLine': line, 'coordinate': list(point), 'groupId': group}
        if event['kind'] == 'skill':
            skill = skills.get(event.get('skillId'))
            if not skill or skill.get('category') not in CATEGORIES:
                counts['unknown_attack_category'] += 1
            else:
                add(event, 'isAttack', CATEGORIES[skill['category']],
                    {**proof, 'rule': 'reviewed-local-skill-category', 'skillId': skill['id'], 'category': skill['category']})
        elif event.get('skillClass') == 'system' and runtime == '700001000':
            add(event, 'isAttack', False, {**proof, 'rule': 'explicit-reviewed-charge-runtime'})
        if event['kind'] == 'skill':
            skill = skills.get(event.get('skillId'), {})
            reviewed = REVIEWED_RESPONSES.get(event.get('skillId'))
            if reviewed and (skill.get('name'), skill.get('description')) == reviewed[:2]:
                if ctype == 3 and not reviewed[2]:
                    raise ValueError('counter notification contradicts reviewed response condition')
                add(event, 'responseAttempt', reviewed[2], {**proof, 'rule': 'reviewed-exact-local-response-condition', 'skillId': skill['id']})
            elif ctype == 3:
                add(event, 'responseAttempt', True, {**proof, 'rule': 'SPT_COUNTER-notification'})
            else:
                counts['response_capability_unknown'] += 1
    expected_casts = {e['id'] for e in events if e.get('kind') == 'skill' or e.get('kind') == 'effect' and e.get('skillClass') in ('system', 'passive')}
    if set(raw_by_id) != expected_casts:
        raise ValueError('original casts not covered by bounded primary channel')

    for eid, (point, entry, line) in raw_by_id.items():
        if numeric_enum(entry['skill_cast']['type'], 'cast type') != 3:
            continue
        event = by_id[eid]
        ref = entry.get('group_ref')
        candidates = heads.get((*point[:2], ref), []) if type(ref) is int and ref > 0 else []
        if entry.get('is_group_head') is not True or len(candidates) != 1:
            counts['response_link_unknown'] += 1
            continue
        parent_point, parent, _ = candidates[0]
        parent_event = by_id.get(event_id(parent_point, 'cast'))
        if numeric_enum(parent.get('type'), 'parent type') != 1 or parent_event is None or parent_event['side'] == event['side'] or parent_point >= point or parent_event['kind'] != 'skill':
            counts['response_link_unknown'] += 1
            continue
        if event['phase'] == 'executed':
            add(event, 'counteredActionId', parent_event['id'],
                {'csvLine': line, 'coordinate': list(point), 'groupId': entry['group_id'], 'groupRef': ref,
                 'rule': 'SPT_COUNTER-explicit-opposing-group_ref', 'sourceCoordinate': list(parent_point)})

    damage_groups = collections.defaultdict(list)
    restraint_rows, switch_rows = [], []
    # Latest numeric max is used ONLY to label a known numeric hpBefore as full.
    max_samples = collections.defaultdict(list)
    for event in events:
        if event.get('kind') == 'resource' and event.get('phase') == 'executed' and 'hpMax' in event:
            pid = event.get('actor')
            if pid not in sides:
                raise ValueError('HP maximum actor outside roster')
            point = tuple(integer(event.get(k), 'resource coordinate') for k in ('round', 'seq', 'execIndex'))
            max_samples[pid].append((point, integer(event['hpMax'], 'actual maximum HP', 1)))
    for samples in max_samples.values():
        samples.sort()
    for point, entry, line in entries:
        typ = numeric_enum(entry['type'], 'primary type')
        group_key = (*point[:2], entry['group_id'])
        proof = {'csvLine': line, 'coordinate': list(point), 'groupId': entry['group_id']}
        if typ == 4:
            damage = object_value(entry.get('damage_info'), 'primary damage')
            caster, target = actor(damage.get('caster_id')), actor(damage.get('target_id'))
            event = normalized(point, 'damage_info', 'damage', caster, sides[caster])
            if (event.get('target'), event.get('targetSide')) != (target, sides[target]):
                raise ValueError('damage target mismatch')
            source_id = integer(damage.get('source_id'), 'damage source ID')
            matches = []
            for cp, ce, _ in groups[group_key]:
                cast = ce.get('skill_cast', {})
                candidate = by_id.get(event_id(cp, 'cast'))
                if numeric_enum(ce['type'], 'source type') == 1 and cast.get('caster_id') == int(caster) and cast.get('skill_id') == source_id and cp < point and candidate and candidate.get('phase') == 'executed':
                    matches.append(candidate)
            if len(matches) == 1:
                add(event, 'actionId', matches[0]['id'], {**proof, 'rule': 'same-primary-group-exact-source_id-and-caster', 'sourceId': source_id})
            else:
                counts['damage_action_unknown'] += 1
            syncs = {}
            for sync in array(entry.get('sync_data', {}).get('pet_sync_info', []), 'damage synchronizations'):
                if sync.get('pet_id') != int(target):
                    continue
                for raw, norm in (('hp_change', 'hpChange'), ('hp_result', 'hpAfter')):
                    if raw not in sync:
                        continue
                    val = signed32(sync[raw])
                    if raw in syncs and syncs[raw] != val:
                        raise ValueError('conflicting damage HP synchronization')
                    syncs[raw] = val
                    if event.get(norm) != val or type(event.get(norm)) is not int:
                        raise ValueError('normalized HP differs from exact synchronization')
            if set(syncs) == {'hp_change', 'hp_result'}:
                delta, after = syncs['hp_change'], syncs['hp_result']
                if delta > 0:
                    raise ValueError('positive damage HP change')
                before = integer(after - delta, 'numeric HP before damage')
                integer(after, 'numeric HP after damage')
                add(event, 'hpBefore', before, {**proof, 'rule': 'same-target-sync-hp_result-minus-signed-hp_change'})
                known_max = next((value for coord, value in reversed(max_samples[target]) if coord < point), None)
                if known_max is not None and before == known_max:
                    add(event, 'fullHpBefore', True, {**proof, 'rule': 'numeric-hpBefore-equals-prior-explicit-hpMax', 'hpMax': known_max})
            if 'restraint_type' in damage:
                tier = signed32(damage['restraint_type'])
                if str(tier) not in RESTRAINT_ENUM:
                    counts['effectiveness_unknown_enum'] += 1
                else:
                    tag = 'advantage' if tier > 0 else 'resisted' if tier < 0 else 'usual'
                    add(event, 'effectivenessClass', tag, {**proof, 'rule': 'signed-protocol-SkillRestraintType', 'rawSignedTier': tier, 'schemaEnum': RESTRAINT_ENUM[str(tier)]})
                    restraint_rows.append({'eventId': event['id'], **proof, 'rawSignedTier': tier,
                                           'schemaEnum': RESTRAINT_ENUM[str(tier)], 'reviewedClass': tag,
                                           'damageAttributeType': integer(damage.get('dam_type'), 'damage attribute type')})
            damage_groups[group_key].append(event)
        elif typ == 13:
            change = object_value(entry.get('change_pet'), 'primary switch')
            entering, leaving = actor(change.get('battle_pet_id')), actor(change.get('rest_pet_id'))
            event = normalized(point, 'switch', 'switch', entering, sides[entering])
            if sides[entering] != sides[leaving] or event.get('target') != leaving or event.get('targetSide') != sides[leaving]:
                raise ValueError('switch identity mismatch')
            manual = change.get('is_cmd')
            if manual is not None and type(manual) is not bool:
                raise ValueError('invalid command-switch flag')
            reason = 'voluntary' if manual is True else 'unknown'
            add(event, 'leaveReason', reason, {**proof, 'rule': 'explicit-is_cmd-true' if manual is True else 'no-explicit-causal-link', 'isCmd': manual})
            switch_rows.append({'eventId': event['id'], **proof, 'isCmd': manual, 'leaveReason': reason})
        elif typ == 7:
            dead = object_value(entry.get('dead_info'), 'primary faint')
            target, caster = actor(dead.get('target_id')), actor(dead.get('caster_id'))
            event = normalized(point, 'faint', 'effect', target, sides[target])
            if numeric_enum(dead.get('dead_type'), 'death type') != 0:
                counts['unsupported_death_type'] += 1
                continue
            add(event, 'leaveReason', 'defeat', {**proof, 'rule': 'NORMAL_DEAD-notification'})
            causes = [d for d in damage_groups[group_key] if d.get('actor') == caster and d.get('target') == target and d.get('hpAfter') == 0 and d.get('combat', {}).get('actionId')]
            cause_ids = {d['combat']['actionId'] for d in causes}
            if len(causes) == 1 and len(cause_ids) == 1:
                add(event, 'actionId', next(iter(cause_ids)),
                    {**proof, 'rule': 'NORMAL_DEAD-same-primary-group-caster-target-zeroHP-damage', 'damageEventId': causes[0]['id']})
            else:
                counts['killer_action_unknown'] += 1
    # Only additive combat fields are allowed; old object/array values stay exact.
    for old, new in zip(original['events'], events):
        stripped = copy.deepcopy(new)
        if 'combat' in old:
            stripped['combat'] = copy.deepcopy(old['combat'])
        else:
            stripped.pop('combat', None)
        if stripped != old:
            raise ValueError('original event changed outside combat')
    old_record, new_record = copy.deepcopy(original), copy.deepcopy(record)
    old_record.pop('events'); new_record.pop('events')
    if old_record != new_record or len(events) != len(original['events']):
        raise ValueError('original record changed outside event combat')
    audit = {
        'version': 1, 'battleId': original['id'], 'openingLine': initial[1], 'finishLine': finish_line,
        'originalEvents': len(original['events']), 'totalEvents': len(events),
        'originalFactsUnchanged': True, 'qualityUnchanged': record.get('quality') == original.get('quality'),
        'counts': dict(sorted(counts.items())), 'primaryDuplicateEntriesSkipped': boundary_counts.get('duplicate_primary_entries', 0),
        'combatEvidence': [{'eventId': eid, 'facts': facts} for eid, facts in sorted(evidence.items())],
        'effectivenessEvidence': restraint_rows, 'switchEvidence': switch_rows,
        'effectivenessOrientationChecks': corroborate_orientation(record, initial, entries, catalog, schema),
        'catalogRules': [{'skillId': sid, 'name': skills[sid].get('name'), 'category': skills[sid].get('category'),
                          'description': skills[sid].get('description'),
                          'reviewedResponseAttempt': REVIEWED_RESPONSES[sid][2] if sid in REVIEWED_RESPONSES and (skills[sid].get('name'), skills[sid].get('description')) == REVIEWED_RESPONSES[sid][:2] else None}
                         for sid in sorted({e['skillId'] for e in events if e.get('kind') == 'skill' and e.get('skillId') in skills})],
        'unsupported': {
            'exactEffectivenessMultiplier': 'Schema proves signed restraint tiers/class, not a numeric multiplier; no exponent or damage-size inference.',
            'selectionOnlyAttempts': 'No additional selected-only events inserted; absence of a cast notification is not a failed attempt.',
            'nonCommandSwitchCause': 'is_cmd=false and group_ref=0 do not prove forced/self or source action. Wind/scare attribution remains unknown.',
            'hpFallback': 'No estimation performed. Numeric actual HP exists; no generic unknown-HP fallback.',
            'speed': 'Injected static skill_priority is not final action priority; ignored.',
        },
        'semantics': {
            'attack': 'Reviewed local skill category only. Executed actions counted once by event ID; interruption is not execution. Defense stays nonattack even if response deals damage.',
            'kills': 'Only explicit NORMAL_DEAD events; zero HP damage without faint is not a kill (survival/heal/transform possible).',
            'damageTotal': 'Sum actual HP loss max(0,-hpChange), never reported amount.',
            'effectivenessTags': 'Signed schema restraint class; action-deduplicate outgoing/incoming independently, multi-tag allowed, usual label is 通常.',
            'responses': 'SPT_COUNTER plus explicit opposing group_ref, not target side or adjacency; unobserved attempts unknown.',
        },
    }
    return result, audit


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'record', 'catalog', 'schema-db', 'output', 'report'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('source', 'record', 'catalog', 'schema'):
        parser.add_argument('--' + name + '-sha256', required=True)
    parser.add_argument('--battle-id', required=True)
    parser.add_argument('--opening-line', type=int, required=True)
    parser.add_argument('--finish-line', type=int, required=True)
    args = parser.parse_args(argv)
    paths = [p.resolve() for p in (args.source, args.record, args.catalog, args.schema_db, args.output, args.report)]
    if len(set(paths)) != len(paths):
        raise ValueError('all input and output paths must be distinct')
    for output in (args.output, args.report):
        if output.exists() or output.suffix.lower() != '.json':
            raise ValueError('only new JSON output files allowed')
        if not output.parent.is_dir():
            raise ValueError('output parent directory must exist')
    for name, maximum in (('source', 512 * 1024 * 1024), ('record', 16 * 1024 * 1024), ('catalog', 32 * 1024 * 1024)):
        expected = getattr(args, name + '_sha256')
        if not re.fullmatch(r'[0-9a-f]{64}', expected) or digest(getattr(args, name), maximum) != expected:
            raise ValueError(name + ' SHA-256 mismatch')
    if args.source_sha256 != SOURCE_SHA256 or args.schema_sha256 != SCHEMA_SHA256 or args.battle_id != BATTLE_ID or (args.opening_line, args.finish_line) != (565, 6102):
        raise ValueError('CLI permits only the explicitly reviewed capture/schema/boundary')
    document, catalog = strict_json(args.record.read_bytes()), strict_json(args.catalog.read_bytes())
    if unwrap(document)['id'] != 'rkpp:' + args.battle_id or len(unwrap(document)['events']) != 283:
        raise ValueError('exact original 283-event record required')
    schema = load_schema(args.schema_db, args.schema_sha256)
    result, audit = enrich(args.source, document, catalog, schema, (args.opening_line, args.finish_line))
    audit['inputHashes'] = {name: getattr(args, name + '_sha256') for name in ('source', 'record', 'catalog', 'schema')}
    outputs = [(args.output, result), (args.report, audit)]
    serialized = [(path, json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n') for path, value in outputs]
    for path, text in serialized:
        with path.open('x', encoding='utf-8', newline='\n') as stream:
            stream.write(text)
    print(json.dumps({'originalEvents': audit['originalEvents'], 'totalEvents': audit['totalEvents'], 'counts': audit['counts']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
