"""Offline, bounded metadata enrichment; never opens a profile or writes input files.

Protocol facts were inspected read-only, not copied from RKPP implementation.
Only reviewed NATURE_CONF facts below are embedded; no network is used at runtime.
Original normalized events, identity, importedAt, endedAt and actions quality stay
unchanged. Unknown final priority means NO speed constraints are generated.
"""
import argparse
import collections
import copy
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

from enrich_battle_states import (array, bounded_source, integer, object_value,
                                  pet_id, signed32, unwrap)

SOURCE_SHA256 = 'c80cec7ea42edf5b0a7825b73f23b1b9204dadbc9e2d93d2c02cfb9b64f8999b'
NATURE_COMMIT = '727614cc195299cce6b3398c2dd82e23e4db9318'
NATURE_SHA256 = 'ff055ca59229bbeaaf7328821b31a6291e45274ae884c12e7657df7cfde678ae'
NATURE_URL = ('https://raw.githubusercontent.com/mieli1722/roco_kingdom_world_conf/'
              + NATURE_COMMIT + '/NATURE_CONF.json')
# Explicit reviewed (positive_effect, negative_effect) pairs, not a computed table.
# ID31 has special tiny proportions and is intentionally unsupported.
NATURE_EFFECTS = {
    1: (80, 82), 2: (80, 81), 3: (80, 83), 4: (80, 84), 5: (80, 79),
    6: (82, 80), 7: (82, 81), 8: (82, 83), 9: (82, 84), 10: (82, 79),
    11: (81, 80), 12: (81, 82), 13: (81, 83), 14: (81, 84), 15: (81, 79),
    16: (83, 80), 17: (83, 82), 18: (83, 81), 19: (83, 84), 20: (83, 79),
    21: (84, 80), 22: (84, 82), 23: (84, 81), 24: (84, 83), 25: (84, 79),
    26: (79, 80), 27: (79, 82), 28: (79, 81), 29: (79, 83), 30: (79, 84),
}
# dataconfig.AttributeType, xls_enum.proto. No array-order identity inference.
ATTR_STAT = {1: 'hp', 2: 'attack', 3: 'magic_attack', 4: 'defense',
             5: 'magic_defense', 6: 'speed'}
PERCENT_STAT = {79: 'hp', 80: 'attack', 81: 'magic_attack', 82: 'defense',
                83: 'magic_defense', 84: 'speed'}
RAW_STAT = {'hp': 'hp', 'attack': 'attack', 'special_attack': 'magic_attack',
            'defense': 'defense', 'special_defense': 'magic_defense', 'speed': 'speed'}
MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_RECORD_BYTES = 16 * 1024 * 1024
MAX_ENTRIES = 100000
MAX_DURATION = 7 * 24 * 60 * 60


def digest(path, maximum=MAX_SOURCE_BYTES):
    path = Path(path)
    if path.stat().st_size > maximum:
        raise ValueError('input exceeds byte budget')
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    def bad_constant(_):
        raise ValueError('nonfinite JSON number')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=bad_constant)


def put_equal(target, key, value, allow_unknown=False):
    if key in target and target[key] != value:
        if not (allow_unknown and target[key] in ('', 'unknown', None)):
            raise ValueError('existing metadata conflicts: ' + key)
    target[key] = copy.deepcopy(value)


def direct(target, key, value, evidence):
    existing = target.get(key)
    new = {'value': value, 'certainty': 'direct', 'evidence': [evidence]}
    if existing is not None:
        object_value(existing, 'existing evidence')
        if existing.get('certainty') == 'unknown' and 'value' not in existing:
            pass
        elif existing.get('value') == value and existing.get('certainty') == 'direct':
            return  # retain original evidence verbatim on repeated enrichment
        else:
            raise ValueError('existing evidence conflicts: ' + key)
    target[key] = new


def settlement(source, record, opening_line):
    """Only decode the first settlement inside the already-validated boundary."""
    csv.field_size_limit(10000000)
    with Path(source).open(encoding='utf-8-sig', newline='') as stream:
        for line, row in enumerate(csv.DictReader(stream), 2):
            if line <= opening_line or row['opencode'].upper() != '0X132C':
                continue
            message = object_value(strict_json(row['content']), 'settlement packet')
            info = object_value(message.get('settle_info'), 'settlement info')
            if str(info.get('battle_id')) != record['id'][5:] or info.get('rounds') != record['rounds']:
                raise ValueError('mismatched settlement')
            return message, line
    raise ValueError('missing settlement')


def roster_from_opening(initial, record):
    known, ownership, raw, roles = {}, {}, {}, {}
    for side in ('me', 'enemy'):
        for pet in array(record['sides'][side]['pets'], 'normalized roster'):
            pid = pet.get('instanceId')
            if not isinstance(pid, str) or not re.fullmatch(r'[1-9][0-9]*', pid) or pid in known:
                raise ValueError('ambiguous normalized actor')
            known[pid], ownership[pid] = pet, side
    sources = []
    for collection, side in (('player_team', 'me'), ('enemy_team', 'enemy')):
        teams = array(initial.get(collection), 'opening teams')
        if len(teams) != 1:
            raise ValueError('exactly one explicit role per side required')
        team = object_value(teams[0], 'opening team')
        role = integer(object_value(team.get('base'), 'team base').get('role_uin'),
                       'team role identity', 1, (1 << 32) - 1)
        if role in roles:
            raise ValueError('overlapping side role identities')
        roles[role] = side  # ephemeral; NEVER included in result/report
        sources.append((team, side))
    for team in array(initial.get('others', []), 'opening other teams'):
        side = roles.get(team.get('role_uin'))
        if side is not None:
            sources.append((team, side))  # explicit role join, never array order
    for team, side in sources:
        for pet in array(team.get('pets'), 'opening pets'):
            inside = object_value(pet.get('battle_inside_pet_info'), 'inside pet')
            pid = pet_id(inside.get('pet_id'))
            if pid not in known:
                continue  # opening may contain non-roster auxiliary pets
            if ownership[pid] != side or pid in raw and raw[pid] != pet:
                raise ValueError('opening actor side/identity conflict')
            common = object_value(pet.get('battle_common_pet_info'), 'common pet')
            for field, observed in (('protocolBaseId', inside.get('base_conf_id')),
                                    ('protocolId', inside.get('conf_id'))):
                if field in known[pid] and known[pid][field] != str(observed):
                    raise ValueError('opening protocol identity conflict')
            if 'level' in known[pid] and known[pid]['level'] != common.get('level'):
                raise ValueError('opening level conflict')
            raw[pid] = pet
    if set(raw) != set(known):
        raise ValueError('opening missing normalized roster actor')
    return known, ownership, raw, roles


def load_nature_config(path, expected_sha256):
    """Require exact reviewed bytes, then validate extracted pairs independently."""
    if expected_sha256 != NATURE_SHA256 or digest(path, 1024 * 1024) != NATURE_SHA256:
        raise ValueError('unreviewed nature configuration digest')
    rows = array(strict_json(Path(path).read_bytes()), 'nature configuration')
    observed = {}
    for row in rows:
        nid = integer(row.get('id'), 'configuration nature ID', 1)
        if nid in observed:
            raise ValueError('duplicate nature configuration ID')
        observed[nid] = (row.get('positive_effect'), row.get('negative_effect'))
        if nid in NATURE_EFFECTS and (row.get('positive_effect_proportion'),
                                     row.get('positive_effect_grow'),
                                     row.get('negative_effect_proportion')) != (1000, 200, 1000):
            raise ValueError('nature configuration coefficients changed')
    if any(observed.get(nid) != pair for nid, pair in NATURE_EFFECTS.items()):
        raise ValueError('nature configuration does not match reviewed facts')
    return {nid: observed[nid] for nid in NATURE_EFFECTS}


def nature_codes(common, inside):
    """Configuration supplies sign; actual attributes only cross-check, never infer.

    Zero changed_* means no override. Only a complete, matching opening attribute
    vector is accepted, protecting against unreviewed change semantics or buffs.
    """
    nature = integer(common.get('nature'), 'nature ID', 0)
    if nature not in NATURE_EFFECTS:
        return None, 'unsupported nature ID'
    pos = integer(common.get('changed_nature_pos_attr_type'), 'changed positive stat', 0, 6)
    neg = integer(common.get('changed_nature_neg_attr_type'), 'changed negative stat', 0, 6)
    positive, negative = (PERCENT_STAT[n] for n in NATURE_EFFECTS[nature])
    if pos:
        positive = ATTR_STAT[pos]
    if neg:
        negative = ATTR_STAT[neg]
    if positive == negative:
        return None, 'overlapping nature signs'
    codes = {stat: 0 for stat in ATTR_STAT.values()}
    codes[positive], codes[negative] = 1, 2
    attributes = object_value(common.get('attribute_info'), 'attribute info')
    battle = array(inside.get('battle_attr'), 'battle attributes')
    if len(battle) <= 84:
        return None, 'missing independent nature cross-check'
    for raw_stat, stat in RAW_STAT.items():
        row = object_value(attributes.get(raw_stat), 'own attribute')
        base = integer(row.get('base_value'), 'base attribute', 1)
        effort = integer(row.get('effort_add'), 'effort attribute')
        index = next(i for i, s in ATTR_STAT.items() if s == stat)
        percent_index = next(i for i, s in PERCENT_STAT.items() if s == stat)
        expected_percent = (0, 2000, -1000)[codes[stat]]
        if signed32(battle[percent_index]) != expected_percent:
            return None, 'opening percent modifier conflicts with verified nature'
        # Integer half-up arithmetic, matching all six observed own attributes.
        factor = (10, 12, 9)[codes[stat]]
        expected_stat = (base * factor + 5) // 10 + effort
        if battle[index] != expected_stat:
            return None, 'opening actual attribute conflicts with verified nature'
    return codes, 'configuration plus six independent opening attribute checks'


def resolve_leads(record, raw, ownership):
    found = {'me': [], 'enemy': []}
    for pid, pet in raw.items():
        inside = pet['battle_inside_pet_info']
        attrs = array(inside.get('battle_attr'), 'opening battle attributes')
        if inside.get('pos') == 1 and len(attrs) > 25 and type(attrs[25]) is int and attrs[25] > 0:
            found[ownership[pid]].append(pid)
    for side, pids in found.items():
        if len(pids) > 1:
            raise ValueError('ambiguous explicit opening lead')
        if not pids:
            continue
        pid = pids[0]
        # Existing initial state is independent normalized confirmation if present.
        for e in record['events']:
            if e.get('stateStage') == 'initial' and e.get('actor') == pid:
                if e.get('side') != side or e.get('stateActive') is not True:
                    raise ValueError('initial normalized lead conflicts')
        put_equal(record['sides'][side], 'lead', pid, True)
        record['quality']['lead'][side] = True
    return {side: pids[0] for side, pids in found.items() if pids}


def ranks_and_outcome(record, packet, roles, ownership):
    settle = packet['settle_info']
    side_ids = {}
    for row in array(settle.get('monster_info', []), 'settlement monsters'):
        pid = str(row.get('pet_id'))
        if pid not in ownership:
            continue
        role_side = roles.get(row.get('uin'))
        if role_side != ownership[pid]:
            raise ValueError('settlement actor ownership mismatch')
        code = integer(row.get('side'), 'explicit settlement side', 0, 1)
        if code in side_ids and side_ids[code] != role_side:
            raise ValueError('conflicting explicit settlement side')
        side_ids[code] = role_side
    if len(side_ids) == 2 and len(set(side_ids.values())) != 2:
        raise ValueError('nonunique explicit settlement side')
    result = settle.get('result')
    result = result.get('value') if isinstance(result, dict) else result
    if result is not None:
        result = integer(result, 'settlement result enum')
    subject_code = settle.get('side')
    if subject_code is not None:
        subject_code = integer(subject_code, 'settlement subject side', 0, 1)
    subject = side_ids.get(subject_code)
    outcome = None
    # Only reviewed enum meanings; all other values stay unknown.
    if type(result) is int and subject:
        if result in (4, 12, 68, 260):
            outcome = 'loss' if subject == 'me' else 'win'
        elif result in (2, 18, 34, 66):
            outcome = 'win' if subject == 'me' else 'loss'
    if outcome:
        put_equal(record, 'outcome', outcome, True)
    matching = {}
    for row in array(settle.get('pvp_mode', {}).get('match_infos', []), 'matching ranks'):
        side = roles.get(row.get('uin'))
        if not side:
            continue
        rank = {}
        for raw, key in (('pvp_rank_master_score', 'score'), ('pvp_rank_order', 'rank'),
                         ('pvp_rank_star', 'stars')):
            if raw in row:
                rank[key] = integer(row[raw], 'matching ' + key, 1 if key == 'rank' else 0)
        if side in matching:
            raise ValueError('duplicate role-matched rank')
        matching[side] = rank
    phase_side = None
    phased = packet.get('pvp_rank_settle_info')
    if phased is not None:
        object_value(phased, 'phased ranks')
        old, new = {}, {}
        for suffix, key in (('master_score', 'score'), ('order', 'rank'), ('star', 'stars')):
            for prefix, target in (('old', old), ('new', new)):
                field = prefix + '_pvp_rank_' + suffix
                if field in phased:
                    target[key] = integer(phased[field], 'phased ' + key, 1 if key == 'rank' else 0)
        # Require a unique full old tuple. Container location or list order is NOT
        # enough to choose a player. Values must match a role-joined match record.
        candidates = [side for side, rank in matching.items()
                      if len(old) == 3 and old == rank]
        if len(candidates) == 1:
            phase_side = candidates[0]
            for phase, rank in (('before', old), ('after', new)):
                for key, value in rank.items():
                    put_equal(record['sides'][phase_side].setdefault(phase, {}), key, value)
        elif old or new:
            raise ValueError('phased rank subject cannot be uniquely joined')
    for side, rank in matching.items():
        if side != phase_side and rank:
            put_equal(record['sides'][side], 'matching', rank)
    return {'outcome': outcome or 'unknown', 'resultCode': result,
            'resultSide': subject or 'unknown', 'matching': matching,
            'explicitOldNewSide': phase_side, 'tier': 'unknown: no reviewed rule for stars above table IDs'}


def speed_audit(record, initial, entries, raw, ownership):
    observations = []
    for pid, pet in raw.items():
        inside = pet['battle_inside_pet_info']
        attrs = inside.get('battle_attr', [])
        item = {'actor': pid, 'side': ownership[pid]}
        if len(attrs) > 6 and type(attrs[6]) is int and attrs[6] > 0 and ownership[pid] == 'me':
            item['actualInitialSpeed'] = attrs[6]
        else:
            item['actualInitialSpeedUnknown'] = True
        for field in ('speed_min', 'speed_max'):
            if field in inside:
                item[field] = integer(inside[field], 'speed range', 1)
        observations.append(item)
    counter = collections.Counter({'priority_display': 0, 'skill_priority': 0, 'skill_buff': 0, 'priority': 0})
    def inspect(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in ('skill_priority', 'priority_display', 'skill_buff', 'priority'):
                    counter[key] += 1
                inspect(child)
        elif isinstance(value, list):
            for child in value:
                inspect(child)
    inspect(initial)
    casts = {}
    for coordinate, entry, line in entries:
        inspect(entry)
        if 'skill_cast' in entry:
            eid = 'rkpp:action:' + ':'.join(map(str, coordinate)) + ':cast'
            cast = entry['skill_cast']
            if eid in casts and cast != casts[eid][0]:
                raise ValueError('conflicting primary cast key')
            casts[eid] = (cast, line)
    ordinary = collections.defaultdict(list)
    excluded = collections.Counter()
    for event in record['events']:
        if event.get('kind') != 'skill':
            continue
        if event.get('phase') != 'executed' or event.get('skillClass') != 'ordinary':
            excluded[event.get('skillClass', 'unknown') + ':' + event.get('phase', 'unknown')] += 1
            continue
        observed = casts.get(event['id'])
        if not observed:
            raise ValueError('normalized ordinary cast missing from primary source')
        cast, line = observed
        if str(cast.get('caster_id')) != event['actor'] or str(cast.get('skill_id')) != event['protocolSkillId'] or cast.get('is_interupt') is True:
            raise ValueError('normalized ordinary cast disagrees with primary source')
        ordinary[event['round']].append({'eventId': event['id'], 'actor': event['actor'],
                                        'side': event['side'], 'seq': event['seq'],
                                        'execIndex': event['execIndex'], 'line': line,
                                        'staticPriorityAnnotation': cast.get('skill_priority')})
    rejected = []
    for round_no, actions in sorted(ordinary.items()):
        actions.sort(key=lambda e: (e['seq'], e['execIndex']))
        for a, b in zip(actions, actions[1:]):
            if a['side'] != b['side']:
                rejected.append({'round': round_no, 'first': a, 'second': b,
                                 'eligible': False,
                                 'reason': 'final priority and same effective speed conditions unproved'})
    return {'initialSpeeds': observations, 'fieldOccurrences': dict(counter),
            'excludedNonOrdinary': dict(excluded), 'ordinaryOpposingOrderExamples': rejected[:20],
            'rejectedOrdinaryOpposingPairs': len(rejected), 'eligibleSpeedConstraints': 0,
            'schema': {'BattleSkillCast': 'no final priority field',
                       'PetSkillRoundData.priority_display': 'bool, not priority',
                       'PetSkillRoundData.skill_buff.priority': 'int32 modifier; not final priority',
                       'skill_priority': 'annotation absent from reviewed protocol fields'},
            'policy': 'Opponent zero is placeholder. Ranges are not exact speed. No inferred IV/nature/constraints.'}


def enrich(source, original, *, expected_sha256, opening_line=None, finish_line=None, catalog=None):
    before_digest = digest(source)
    if not re.fullmatch(r'[0-9a-f]{64}', expected_sha256) or before_digest != expected_sha256:
        raise ValueError('source SHA-256 mismatch')
    original = unwrap(original)
    record = copy.deepcopy(original)
    if len(array(record.get('events'), 'events')) > 20000:
        raise ValueError('event budget exceeded')
    initial_pair, entries, counts = bounded_source(source, record)
    if len(entries) > MAX_ENTRIES:
        raise ValueError('primary entry budget exceeded')
    initial, start_line = initial_pair
    packet, stop_line = settlement(source, record, start_line)
    if opening_line is not None and start_line != opening_line or finish_line is not None and stop_line != finish_line:
        raise ValueError('source logical boundary mismatch')
    known, ownership, raw, roles = roster_from_opening(initial, record)
    if catalog is not None:
        if catalog.get('schema_version') != 2:
            raise ValueError('current schema-2 catalog required')
        ids = {m['id'] for m in array(catalog.get('monsters'), 'catalog monsters')}
        if any(p.get('monsterId') not in ids for p in known.values()):
            raise ValueError('normalized stable monster absent from current catalog')
    profiles = []
    for pid, pet in raw.items():
        inside = pet['battle_inside_pet_info']
        battle = array(inside.get('battle_attr'), 'initial battle attributes')
        if ownership[pid] == 'me' and len(battle) > 6 and type(battle[6]) is int and battle[6] > 0:
            put_equal(known[pid], 'speed', integer(battle[6], 'actual initial speed', 1))
        if 'speed_min' in inside and 'speed_max' in inside:
            low = integer(inside['speed_min'], 'initial minimum speed', 1)
            high = integer(inside['speed_max'], 'initial maximum speed', low)
            put_equal(known[pid], 'speedMin', low)
            put_equal(known[pid], 'speedMax', high)
        if ownership[pid] != 'me':
            continue  # enemy placeholders never become direct IV/nature
        common, inside = pet['battle_common_pet_info'], pet['battle_inside_pet_info']
        attributes = object_value(common.get('attribute_info'), 'own attributes')
        for field, stat in RAW_STAT.items():
            value = integer(object_value(attributes.get(field), 'own stat').get('talent'), 'own talent', 0, 60)
            direct(known[pid].setdefault('iv', {}), stat, value,
                   f'opening CSV {start_line}; actor {pid}; attribute_info.{field}.talent exact 0..60')
        codes, status = nature_codes(common, inside)
        if codes is not None:
            for stat, code in codes.items():
                direct(known[pid].setdefault('nature', {}), stat, code,
                       f'opening CSV {start_line}; actor {pid}; NATURE_CONF {NATURE_COMMIT}; changed nature attributes; six-stat validation')
        profiles.append({'actor': pid, 'natureId': common['nature'],
                         'changedPositive': common.get('changed_nature_pos_attr_type'),
                         'changedNegative': common.get('changed_nature_neg_attr_type'),
                         'natureStatus': status, 'natureCodes': codes})
    leads = resolve_leads(record, raw, ownership)
    meta = ranks_and_outcome(record, packet, roles, ownership)
    settle = packet['settle_info']
    if 'enter_battle_time' in settle:
        epoch = integer(settle['enter_battle_time'], 'battle start seconds', 1, (1 << 32) - 1)
        started = datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace('+00:00', 'Z')
        # Existing timestamps are preserved byte-for-byte if the instant matches.
        if record.get('startedAt'):
            existing = datetime.fromisoformat(record['startedAt'].replace('Z', '+00:00'))
            if existing.tzinfo is None or existing.timestamp() != epoch:
                raise ValueError('existing start timestamp conflicts')
        else:
            record['startedAt'] = started
    if 'seconds' in settle:
        put_equal(record, 'durationSeconds', integer(settle['seconds'], 'duration seconds', 0, MAX_DURATION))
    if digest(source) != before_digest:
        raise ValueError('source changed while reading')
    if record['events'] != original['events'] or record['quality']['actions'] != original['quality']['actions']:
        raise AssertionError('core event/completeness invariant violated')
    audit = {'sourceSHA256': before_digest, 'openingLine': start_line, 'finishLine': stop_line,
             'battleId': record['id'], 'originalEvents': len(original['events']),
             'totalEvents': len(record['events']), 'eventsUnchanged': True,
             'actionsQualityUnchanged': True, 'importedAtUnchanged': record.get('importedAt') == original.get('importedAt'),
             'endedAtUnchanged': record.get('endedAt') == original.get('endedAt'),
             'profiles': profiles, 'leads': leads, 'settlement': meta,
             'startedAt': record.get('startedAt'), 'durationSeconds': record.get('durationSeconds'),
             'natureSource': {'url': NATURE_URL, 'sha256': NATURE_SHA256},
             'speedAudit': speed_audit(record, initial, entries, raw, ownership),
             'bounds': dict(counts), 'accountIdentifiersPersisted': False,
             'notes': ['Existing historical issues retained verbatim; resolved metadata is described in this audit.',
                       'Tier unknown: configuration maximum ID117 is not proof of clamping stars135/141/142.',
                       'No synthesized end timestamp or new events; no profile/DB writes.']}
    return record, audit


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'record', 'nature-config', 'output', 'report'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--catalog', type=Path)
    parser.add_argument('--source-sha256', required=True)
    parser.add_argument('--nature-sha256', required=True)
    parser.add_argument('--opening-line', type=int)
    parser.add_argument('--finish-line', type=int)
    args = parser.parse_args(argv)
    paths = [p.resolve() for p in (args.source, args.record, args.nature_config, args.catalog, args.output, args.report) if p is not None]
    if len(set(paths)) != len(paths):
        raise ValueError('all input/output paths must be distinct')
    for path in (args.output, args.report):
        if path.exists() or path.suffix.lower() != '.json':
            raise ValueError('new JSON output paths required; refusing overwrite')
    digest(args.record, MAX_RECORD_BYTES)
    load_nature_config(args.nature_config, args.nature_sha256)
    catalog = None
    if args.catalog is not None:
        digest(args.catalog, 64 * 1024 * 1024)
        catalog = strict_json(args.catalog.read_bytes())
    record, report = enrich(args.source, strict_json(args.record.read_bytes()),
                            expected_sha256=args.source_sha256, opening_line=args.opening_line,
                            finish_line=args.finish_line, catalog=catalog)
    for path, value in ((args.output, {'version': 1, 'records': [record]}), (args.report, report)):
        with path.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write('\n')
    print(json.dumps({'events': len(record['events']), 'outcome': record['outcome'],
                      'leads': report['leads'], 'directOwnProfiles': len(report['profiles']),
                      'eligibleSpeedConstraints': 0}, ensure_ascii=False))


if __name__ == '__main__':
    main()
