"""Read-only source audit and one explicitly authorized R5 wind repair.

No battle database/profile/catalog writes and no RKPP implementation dependency.
The schema loader reads only kv(kind=proto_schema,key=root), mode=ro/query_only.
This capture proves no wishImpact identity, so this tool NEVER manufactures one.
Only the caller-named new candidate/report files are written, after all checks.
"""
import argparse
import collections
import copy
import csv
import hashlib
import json
from pathlib import Path

from enrich_battle_stats import load_schema, numeric_enum
from enrich_battle_states import unwrap

BATTLE_ID = 'rkpp:1876469132858231449'
RECORD_SHA256 = 'bd3ba967f0926816e5f6ecd8d6217a92ce64984b52909b6b9ee5eecb9e516bae'
CATALOG_SHA256 = '99ccd7dbff69718f36367a8be1c0bcc52d720241aa8982aa96a5a2044dce201a'
SOURCE_SHA256 = 'c80cec7ea42edf5b0a7825b73f23b1b9204dadbc9e2d93d2c02cfb9b64f8999b'
SCHEMA_SHA256 = 'c90a418b8313882228d719ed218395371e7f9c9d59594a9527d21e96cc4eb33d'
BOUNDARY = (565, 6102)
WIND_ID = 'rkpp:action:5:26:1:cast'
SWITCHES = {
    'rkpp:action:5:30:6:switch': ((5, 30, 6), 'enemy', '402', '401', 'forced', 6),
    'rkpp:action:5:30:73:switch': ((5, 30, 73), 'me', '6', '3', 'self', 25),
}
ROLE_CASTS = {(24, 129, 1): (5, 67), (35, 192, 1): (405, 108)}
# Exact symbolic enum mappings. STONE->Ground is capture-corroborated by
# reviewed runtime/local skills187/191, NOT by a numeric offset or pet typing.
# EARTH=7 has no corresponding reviewed local type here and stays unmapped.
TYPE_CODES = {
    2: ('SDT_COMMON', 'Normal', 1), 3: ('SDT_GRASS', 'Grass', 2),
    4: ('SDT_FIRE', 'Fire', 3), 5: ('SDT_WATER', 'Water', 4),
    6: ('SDT_LIGHT', 'Light', 5), 8: ('SDT_STONE', 'Ground', 6),
    9: ('SDT_ICE', 'Ice', 7), 10: ('SDT_DRAGON', 'Dragon', 8),
    11: ('SDT_ELECTRIC', 'Electric', 9), 12: ('SDT_TOXIC', 'Poison', 10),
    13: ('SDT_INSECT', 'Bug', 11), 14: ('SDT_FIGHT', 'Fighting', 12),
    15: ('SDT_WING', 'Flying', 13), 16: ('SDT_MOE', 'Cute', 14),
    17: ('SDT_GHOST', 'Ghost', 15), 18: ('SDT_DEMON', 'Dark', 16),
    19: ('SDT_MECHANIC', 'Mechanical', 17), 20: ('SDT_PHANTOM', 'Illusion', 18),
}
SCHEMA_FIELDS = {
    'BattlePerformInfo': {'1': ('type', 'BattlePerformType'), '2': ('group_id', 'uint32'),
                         '11': ('is_group_head', 'bool'), '26': ('group_ref', 'uint32'),
                         '37': ('role_skill_cast', 'BattleRoleSkillCast'), '39': ('exec_index', 'uint32')},
    'BattleSkillCast': {'1': ('caster_id', 'uint32'), '2': ('target_id', 'uint32'),
                       '3': ('skill_id', 'uint32'), '5': ('real_perform_id', 'uint32'),
                       '7': ('type', 'SkillPerformType'), '8': ('is_interupt', 'bool'),
                       '10': ('perform_flag', 'uint32')},
    'BattleDamageInfo': {'1': ('caster_id', 'uint32'), '2': ('target_id', 'uint32'),
                        '3': ('source_id', 'uint32'), '9': ('dam_type', 'int32')},
    'BattleRoleSkillCast': {'2': ('skill_id', 'uint32'), '3': ('pet_id', 'uint32'),
                           '4': ('is_call_success', 'bool')},
    'BattleChangePet': {'2': ('rest_pet_id', 'uint32'), '3': ('battle_pet_id', 'uint32'),
                        '5': ('is_cmd', 'bool'), '6': ('perform_type', 'ChangePetPerformType')},
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def event_id(point, suffix):
    return 'rkpp:action:' + ':'.join(map(str, point)) + ':' + suffix


def validate_schema(schema, catalog):
    for name, fields in SCHEMA_FIELDS.items():
        actual = schema.get('messages', {}).get(name, {}).get('fields', {})
        for number, pair in fields.items():
            require(tuple(actual.get(number, {}).get(k) for k in ('name', 'type')) == pair,
                    'unreviewed schema field: ' + name + '.' + number)
    enum = schema.get('enums', {}).get('BattlePerformType', {}).get('values', {})
    for value, label in {1: 'BPT_SKILL_CAST', 4: 'BPT_DAMAGE', 13: 'BPT_CHANGE_PET',
                         24: 'BPT_CHANGE_MODEL', 29: 'BPT_ROLE_SKILL_CAST'}.items():
        require(enum.get(str(value)) == label, 'unreviewed primary type enum')
    types = schema.get('enums', {}).get('SkillDamType', {}).get('values', {})
    for raw, (name, code, local) in TYPE_CODES.items():
        require(types.get(str(raw)) == name, 'unreviewed damage type enum')
        matches = [t for t in catalog.get('types', []) if t.get('id') == local]
        require(len(matches) == 1 and matches[0].get('code') == code, 'local type identity mismatch')


def bounded_entries(source, rounds):
    """Do not decode out-of-bound payloads, nonprimary traffic, or account data."""
    csv.field_size_limit(10_000_000)
    entries, seen, boundaries = [], {}, set()
    duplicates = 0
    with Path(source).open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        require({'opencode', 'content'}.issubset(reader.fieldnames or []), 'named CSV required')
        for line, row in enumerate(reader, 2):
            if line < BOUNDARY[0]:
                continue
            if line > BOUNDARY[1]:
                break
            op = row['opencode'].lower()
            if line in BOUNDARY:
                expected = '0x1316' if line == BOUNDARY[0] else '0x132c'
                require(op == expected, 'boundary opcode mismatch')
                body = json.loads(row['content']).get('init_info' if line == BOUNDARY[0] else 'settle_info', {})
                require(str(body.get('battle_id')) == BATTLE_ID[5:], 'boundary battle mismatch')
                if line == BOUNDARY[1]:
                    require(body.get('rounds') == rounds, 'settlement rounds mismatch')
                boundaries.add(line)
                continue
            require(op not in ('0x1316', '0x132c'), 'nested battle boundary')
            if op not in ('0x131a', '0x1324'):
                continue
            message = json.loads(row['content'])
            if op == '0x131a':
                require(str(message.get('state_info', {}).get('battle_id')) == BATTLE_ID[5:], 'primary battle mismatch')
            for declared in (message.get('battle_id'), message.get('state_info', {}).get('battle_id')):
                require(declared is None or str(declared) == BATTLE_ID[5:], 'primary identity mismatch')
            command = message.get('perform_cmd')
            if command is None:
                continue
            r, seq = command.get('round'), command.get('seq_num')
            require(type(r) is int and 1 <= r <= rounds and type(seq) is int and 0 <= seq <= 1_000_000_000,
                    'invalid primary coordinate')
            for entry in command.get('perform_info', []):
                index = entry.get('exec_index')
                require(type(index) is int and 0 <= index <= 1_000_000_000, 'invalid execution index')
                point = (r, seq, index)
                typ = numeric_enum(entry.get('type'), 'primary type')
                key = (point, typ)
                if key in seen:
                    require(seen[key] == entry, 'conflicting primary identity')
                    duplicates += 1
                    continue
                seen[key] = entry
                entries.append((point, entry, line))
    require(boundaries == set(BOUNDARY), 'both exact boundaries required')
    return sorted(entries, key=lambda item: item[0]), duplicates


def enrich(record_document, catalog, schema, entries, authorize_wind=False):
    require(authorize_wind, 'explicit user R5 both-switch attribution authorization required')
    original = unwrap(record_document)
    require(original['id'] == BATTLE_ID, 'repair is restricted to one exact battle')
    require(original.get('quality', {}).get('actions') is False, 'actions quality must remain false')
    require(catalog.get('schema_version') == 2, 'canonical catalog v2 required')
    validate_schema(schema, catalog)
    skills = {s['id']: s for s in catalog.get('skills', [])}
    require((skills.get(351, {}).get('name'), skills.get(351, {}).get('description'),
             skills.get(351, {}).get('category')) == ('风隐', '敌方和自己均 脱离 ， 先手 -1。', 'Status'),
            'reviewed wind catalog identity changed')
    by_id = {e['id']: e for e in original['events']}
    require(len(by_id) == len(original['events']), 'unique event IDs required')
    require(not any(e.get('combat', {}).get('actionKind') == 'wishImpact' for e in original['events']),
            'capture-specific no-wish audit cannot overwrite a preexisting wish declaration')
    roster = {(side, p['instanceId']): p['monsterId'] for side in ('me', 'enemy') for p in original['sides'][side]['pets']}
    require(roster.get(('me', '3')) == 501 and roster.get(('enemy', '401')) == 132, 'wind caster/facing roster mismatch')
    raw = {(point, numeric_enum(e['type'], 'primary type')): (e, line) for point, e, line in entries}
    require(len(raw) == len(entries), 'entries must be deduplicated and unambiguous')
    cast_evidence, role_evidence, damage_evidence = [], [], []
    groups = collections.defaultdict(list)
    for point, entry, line in entries:
        groups[(*point[:2], entry.get('group_id'))].append((point, entry, line))
        typ = numeric_enum(entry['type'], 'primary type')
        if typ == 1:
            cast = entry.get('skill_cast', {})
            eid = event_id(point, 'cast')
            event = by_id.get(eid, {})
            require(event.get('kind') in ('skill', 'effect') and event.get('actor') == str(cast.get('caster_id'))
                    and event.get('protocolSkillId') == str(cast.get('skill_id')),
                    'primary cast missing from normalized record or identity mismatch')
            require(tuple(event.get(k) for k in ('round', 'seq', 'execIndex')) == point, 'cast coordinate mismatch')
            require(event.get('phase') == ('interrupted' if cast.get('is_interupt', False) else 'executed'), 'cast phase mismatch')
            require(cast.get('perform_flag', 0) == 0 and cast.get('real_perform_id', 0) == 0,
                    'unreviewed replacement/perform identity requires new audit')
            cast_evidence.append({'eventId': eid, 'csvLine': line, 'sourceSkillId': cast['skill_id'],
                                  'performType': cast.get('type'), 'phase': event['phase']})
        elif typ == 29:
            role = entry.get('role_skill_cast', {})
            require(point in ROLE_CASTS, 'unreviewed role action')
            pet, form_index = ROLE_CASTS[point]
            require(role.get('skill_id') == 7010070 and role.get('pet_id') == pet
                    and role.get('is_call_success') is False, 'reviewed role action changed')
            form = raw.get(((*point[:2], form_index), 24), (None,))[0]
            require(form is not None and form.get('group_id') == entry.get('group_id')
                    and form.get('change_model', {}).get('pet_id') == pet, 'role/form exact group link missing')
            form_id = 'rkpp:identity-form:' + ':'.join(map(str, (*point[:2], form_index, pet)))
            require(by_id.get(form_id, {}).get('kind') == 'form'
                    and by_id[form_id].get('actor') == str(pet), 'same-group form missing from normalized record')
            role_evidence.append({'coordinate': list(point), 'csvLine': line, 'sourceSkillId': 7010070,
                                  'untrustedDisplayAnnotation': '愿力强化',
                                  'annotationIsNotImpactIdentityProof': True,
                                  'petId': str(pet), 'isCallSuccess': False,
                                  'sameGroupExistingFormId': form_id,
                                  'wishImpactProven': False, 'newEventEmitted': False})
    require({x['eventId'] for x in cast_evidence} == {e['id'] for e in original['events']
            if e.get('kind') == 'skill' or e.get('kind') == 'effect' and e.get('skillClass') in ('system', 'passive')},
            'normalized cast coverage mismatch')
    for point, entry, line in entries:
        if numeric_enum(entry['type'], 'primary type') != 4:
            continue
        damage = entry['damage_info']
        matches = [(p, e) for p, e, _ in groups[(*point[:2], entry.get('group_id'))]
                   if numeric_enum(e['type'], 'primary type') == 1 and p < point
                   and e.get('skill_cast', {}).get('caster_id') == damage.get('caster_id')
                   and e.get('skill_cast', {}).get('skill_id') == damage.get('source_id')]
        require(len(matches) == 1, 'damage lacks unique direct source cast')
        source_id = event_id(matches[0][0], 'cast')
        eid = event_id(point, 'damage_info')
        event = by_id.get(eid, {})
        require(event.get('kind') == 'damage' and event.get('combat', {}).get('actionId') == source_id
                and event.get('actor') == str(damage.get('caster_id')) and event.get('target') == str(damage.get('target_id')),
                'normalized damage direct linkage differs')
        raw_type = damage.get('dam_type')
        mapping = TYPE_CODES.get(raw_type)
        damage_evidence.append({'eventId': eid, 'castId': source_id, 'csvLine': line,
                                'sourceSkillId': damage.get('source_id'), 'rawType': raw_type,
                                'localTypeId': mapping[2] if mapping else None,
                                'typeWrittenToCandidate': False})
    wind = by_id.get(WIND_ID, {})
    require(all(wind.get(k) == v for k, v in {'kind': 'skill', 'phase': 'executed', 'side': 'me',
            'actor': '3', 'target': '401', 'targetSide': 'enemy', 'skillId': 351,
            'protocolSkillId': '715027000', 'round': 5, 'seq': 26, 'execIndex': 1}.items()), 'exact wind cast mismatch')
    wind_raw, wind_line = raw.get(((5, 26, 1), 1), ({}, None))
    require(wind_raw.get('skill_cast', {}).get('target_id') == [401]
            and wind_raw.get('group_id') == 1 and wind_raw.get('group_ref') == 0, 'wind primary target/group mismatch')
    result = copy.deepcopy(record_document)
    changed_record = unwrap(result)
    changed = {e['id']: e for e in changed_record['events']}
    repairs = []
    for eid, (point, side, incoming, outgoing, reason, group) in SWITCHES.items():
        event = by_id.get(eid, {})
        require(all(event.get(k) == v for k, v in {'kind': 'switch', 'phase': 'executed', 'side': side,
                'actor': incoming, 'target': outgoing, 'targetSide': side,
                'round': point[0], 'seq': point[1], 'execIndex': point[2]}.items()), 'exact switch identity mismatch')
        entry, line = raw.get((point, 13), ({}, None))
        switch = entry.get('change_pet', {})
        require(switch.get('rest_pet_id') == int(outgoing) and switch.get('battle_pet_id') == int(incoming)
                and switch.get('is_cmd') is False and switch.get('perform_type') == 0
                and entry.get('group_id') == group and entry.get('group_ref') == 0, 'exact raw switch mismatch')
        combat = changed[eid].setdefault('combat', {})
        require(combat.get('leaveReason') in ('unknown', reason), 'known leave reason conflict')
        require(combat.get('actionId', WIND_ID) == WIND_ID, 'known source action conflict')
        prior = copy.deepcopy(combat)
        combat['leaveReason'], combat['actionId'] = reason, WIND_ID
        repairs.append({'eventId': eid, 'csvLine': line, 'before': prior, 'after': copy.deepcopy(combat),
                        'authorization': 'explicit-user-attribution-this-battle-R5-only',
                        'rawGroupRef': 0, 'rawCausalLinkClaimed': False})
    # Replay only the four permitted leaves against the input; everything else,
    # including HP, stats, event order, labels, issues and quality, stays exact.
    permitted = copy.deepcopy(original)
    for event in permitted['events']:
        if event['id'] in SWITCHES:
            event['combat']['leaveReason'] = SWITCHES[event['id']][4]
            event['combat']['actionId'] = WIND_ID
    require(changed_record == permitted, 'candidate changed an unauthorized fact')
    audit = {
        'version': 1, 'battleId': BATTLE_ID, 'originalEvents': len(original['events']),
        'totalEvents': len(changed_record['events']), 'newEvents': 0,
        'eventCoresUnchanged': True, 'hpStatsAndQualityUnchanged': True, 'qualityActions': False,
        'sourceDatabaseWritten': False, 'battleDatabaseWritten': False,
        'windRepairs': repairs,
        'windFacing': {'sourceCastId': WIND_ID, 'csvLine': wind_line, 'caster': '3',
                       'casterInitialMonsterId': 501, 'facingAtCast': '401', 'facingMonsterId': 132,
                       'enemyIncoming402MustNotReplaceCastFacing': True},
        'wish': {'provenImpactCasts': 0, 'meaning': 'No wishImpact identity proven in captured primary data; not a claim about unobserved gameplay.',
                 'newEventsEmitted': 0, 'metadataWritten': False, 'catalogEntityCreated': False,
                 'roleCastsAreNotImpactEvidence': role_evidence,
                 'roleVersusImpact': '角色魔法7010070的解析器注释为愿力强化；这不是愿力冲击施放证据。它与已有同组变形关联，不能按随后攻击或名称推断冲击。is_call_success=false不被解释为冲击失败。',
                 'schemaLimit': 'No reviewed wishImpact-specific enum or flag identified. BattleSkillCast.type is active/passive/counter, not elemental type; BattleDamageInfo.dam_type supplies actual linked attack type. Parser skill_name/skill_desc/skill_damage_type annotations are not typed source proof.',
                 'subsequentOrdinaryAttacks': [
                     {**d, 'localSkillId': by_id[d['castId']].get('skillId'),
                      'stillOrdinaryNotWishByAdjacency': True}
                     for d in damage_evidence if d['castId'] in
                     ('rkpp:action:24:129:68:cast', 'rkpp:action:35:192:109:cast')],
                 'castDedupRule': 'One primary (round,seq,execIndex,cast) ID per cast; damage segments are never extra casts.',
                 'noAdjacencyOrMonsterTypeInference': True},
        'coverage': {'primaryCastCount': len(cast_evidence), 'linkedDamageCount': len(damage_evidence)},
        'primaryCasts': cast_evidence, 'damageDirectTypeEvidence': damage_evidence,
        'typeMapping': [{'raw': raw_type, 'enum': enum, 'localCode': code, 'localId': local}
                        for raw_type, (enum, code, local) in TYPE_CODES.items()],
        'typeMappingLimits': 'Raw7 SDT_EARTH and invalid/none/other enum values remain unmapped. Raw8 SDT_STONE→local6 Ground is corroborated by mapped ordinary casts187/191, not a general numeric offset.',
        'optionalSchemaProposal': {'actionKind': 'wishImpact', 'typeId': 'optional local1..18 from exact linked actual cast/damage only'},
    }
    return result, audit


def verified_bytes(path, expected):
    data = Path(path).read_bytes()
    require(hashlib.sha256(data).hexdigest() == expected, 'input SHA-256 mismatch: ' + str(path))
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ('source', 'record', 'catalog', 'schema-db', 'output', 'report'):
        parser.add_argument('--' + field, required=True, type=Path)
    parser.add_argument('--authorize-r5-wind-both-switches', action='store_true')
    args = parser.parse_args()
    require(args.authorize_r5_wind_both_switches, 'explicit attribution flag required')
    inputs = {p.resolve() for p in (args.source, args.record, args.catalog, args.schema_db)}
    require(args.output.resolve() != args.report.resolve(), 'outputs must differ')
    for dest in (args.output, args.report):
        require(dest.resolve() not in inputs and not dest.exists(), 'refuse replacing an input/existing output')
    verified_bytes(args.source, SOURCE_SHA256)
    record = json.loads(verified_bytes(args.record, RECORD_SHA256))
    catalog = json.loads(verified_bytes(args.catalog, CATALOG_SHA256))
    require(len(unwrap(record)['events']) == 283, 'reviewed input must contain 283 events')
    schema = load_schema(args.schema_db, SCHEMA_SHA256)
    entries, duplicates = bounded_entries(args.source, unwrap(record)['rounds'])
    result, audit = enrich(record, catalog, schema, entries, True)
    require(audit['coverage'] == {'primaryCastCount': 76, 'linkedDamageCount': 26}, 'reviewed capture coverage changed')
    require(len(audit['wish']['roleCastsAreNotImpactEvidence']) == 2, 'reviewed role cast coverage changed')
    audit['inputs'] = {'record': str(args.record), 'recordSha256': RECORD_SHA256,
                       'catalog': str(args.catalog), 'catalogSha256': CATALOG_SHA256,
                       'sourceCsv': str(args.source), 'sourceSha256': SOURCE_SHA256,
                       'schemaDb': str(args.schema_db), 'schemaPayloadSha256': SCHEMA_SHA256,
                       'schemaQuery': "SELECT payload_msgpack FROM kv WHERE kind='proto_schema' AND key='root'",
                       'openingLogicalLine': BOUNDARY[0], 'finishLogicalLine': BOUNDARY[1]}
    audit['primaryDuplicatesSkipped'] = duplicates
    document = result if 'records' in result else {'version': 1, 'records': [result]}
    candidate_bytes = (json.dumps(document, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    audit['candidateSha256'] = hashlib.sha256(candidate_bytes).hexdigest()
    # Exclusive creation, never overwrite. There is deliberately no DB/apply mode.
    with args.output.open('xb') as stream:
        stream.write(candidate_bytes)
    with args.report.open('x', encoding='utf-8') as stream:
        json.dump(audit, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    print(json.dumps({'events': 283, 'newEvents': 0, 'windRepairs': 2, 'provenWishImpact': 0,
                      'candidateSha256': audit['candidateSha256'], 'qualityActions': False}))


if __name__ == '__main__':
    main()
