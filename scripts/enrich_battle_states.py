"""Offline, bounded RKPP state/cost enrichment. No network, DB or profile I/O.

Only primary commands between one exact opening and its matching settlement are
eligible. The normalized input remains the authority for roster and old events.
"""
import argparse
import collections
import copy
import csv
import hashlib
import json
from pathlib import Path
import re

INT32_MAX = (1 << 31) - 1
UINT64_MINUS_ONE = (1 << 64) - 1
PREVENTION_RUNTIME = '702111100'
# Only these literal, explicitly approved original-runtime cost relationships.
# The audit establishes identity; later query numeric values are never read.
ORIGINAL_COST_LINKS = {
    '707027100': ('707027000', 'audited-original-runtime-link'),
    '702111100': ('702111000', 'user-confirmed-effective-prevention-family'),
}


def integer(value, label, minimum=0, maximum=INT32_MAX):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError('invalid ' + label)
    return value


def signed32(value):
    if type(value) is not int:
        raise ValueError('invalid int32 synchronization')
    if (1 << 63) <= value < (1 << 64):
        value -= 1 << 64
    return integer(value, 'int32 synchronization', -(1 << 31))


def object_value(value, label):
    if not isinstance(value, dict):
        raise ValueError('invalid ' + label)
    return value


def array(value, label):
    if not isinstance(value, list):
        raise ValueError('invalid ' + label)
    return value


def pet_id(value):
    return str(integer(value, 'battle pet ID', 1))


def unwrap(document):
    object_value(document, 'record document')
    if 'records' in document:
        if type(document.get('version')) is not int or document['version'] != 1 or len(array(document['records'], 'records')) != 1:
            raise ValueError('exactly one version-1 record required')
        document = document['records'][0]
    object_value(document, 'record')
    if type(document.get('version')) is not int or document['version'] != 1 or not isinstance(document.get('id'), str) or not re.fullmatch(r'rkpp:[A-Za-z0-9_-]+', document['id']):
        raise ValueError('version-1 explicit RKPP record required')
    integer(document.get('rounds'), 'settlement rounds', 1, 1000000)
    return document


def bounded_source(source, record):
    """Return only the initial named message and exact primary execution entries."""
    battle = record['id'][5:]
    active = False
    starts = finishes = 0
    initial = None
    entries = []
    seen_entries = set()
    counter = collections.Counter()
    csv.field_size_limit(10000000)
    with Path(source).open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        if not {'opencode', 'content'}.issubset(reader.fieldnames or []):
            raise ValueError('named CSV columns required')
        for line, row in enumerate(reader, 2):
            opcode = row['opencode'].upper()
            if opcode not in ('0X1316', '0X131A', '0X1324', '0X132C'):
                continue
            message = object_value(json.loads(row['content']), 'named packet')
            if opcode == '0X1316':
                if active:
                    raise ValueError('overlapping battle opening')
                info = object_value(message.get('init_info', {}), 'opening')
                if str(info.get('battle_id')) == battle:
                    starts += 1
                    if starts != 1:
                        raise ValueError('repeated target opening')
                    active = True
                    initial = (info, line)
                continue
            if not active:
                counter['outside_boundary_packets'] += 1
                continue
            if opcode == '0X132C':
                settle = object_value(message.get('settle_info'), 'settlement')
                if str(settle.get('battle_id')) != battle or settle.get('rounds') != record['rounds']:
                    raise ValueError('mismatched settlement')
                finishes += 1
                active = False
                continue
            if opcode == '0X131A' and str(message.get('state_info', {}).get('battle_id')) != battle:
                raise ValueError('mismatched primary battle')
            for declared in (message.get('battle_id'), message.get('state_info', {}).get('battle_id')):
                if declared is not None and str(declared) != battle:
                    raise ValueError('mismatched primary battle')
            command = message.get('perform_cmd')
            if command is None:
                continue
            object_value(command, 'primary command')
            round_no = integer(command.get('round'), 'primary round', 1, record['rounds'])
            seq = integer(command.get('seq_num'), 'primary sequence', 0, 1000000000)
            counter['primary_batches'] += 1
            for entry in array(command.get('perform_info', []), 'primary entries'):
                object_value(entry, 'primary entry')
                index = integer(entry.get('exec_index'), 'execution index', 0, 1000000000)
                coordinate = (round_no, seq, index)
                # Different primary branches can legitimately share exec_index.
                # Conflicts are checked below at the extracted actor/field key.
                signature = (coordinate, json.dumps(entry, sort_keys=True, separators=(',', ':')))
                if signature in seen_entries:
                    counter['duplicate_primary_entries'] += 1
                    continue
                seen_entries.add(signature)
                entries.append((coordinate, entry, line))
    if starts != 1 or finishes != 1 or active:
        raise ValueError('complete unique battle boundary required')
    return initial, sorted(entries, key=lambda item: item[0]), counter


def full_pet_fields(pet):
    """Read only reviewed exact indices and current common.energy, never defaults."""
    inside = object_value(pet.get('battle_inside_pet_info'), 'inside pet')
    pid = pet_id(inside.get('pet_id'))
    fields = {}
    if 'battle_attr' in inside:
        attrs = array(inside['battle_attr'], 'battle attributes')
        if len(attrs) > 1:
            fields['hpMax'] = integer(attrs[1], 'AT_HPMAX', 1)
        if len(attrs) > 25:
            fields['hpAfter'] = integer(attrs[25], 'AT_HPCUR')
    common = object_value(pet.get('battle_common_pet_info', {}), 'common pet')
    if 'energy' in common:
        fields['energyAfter'] = integer(common['energy'], 'current common energy')
    position = inside.get('pos')
    if type(position) is int:
        if position == 1 and fields.get('hpAfter', 0) > 0:
            fields['stateActive'] = True
        elif position in (-1, UINT64_MINUS_ONE):
            fields['stateActive'] = False
    return pid, fields, inside


def enrich(source, original):
    original = unwrap(original)
    record = copy.deepcopy(original)
    actors = {}
    roster = {}
    for side in ('me', 'enemy'):
        for pet in array(record['sides'][side]['pets'], 'initial roster'):
            pid = pet.get('instanceId')
            if not isinstance(pid, str) or not re.fullmatch(r'[1-9][0-9]*', pid) or pid in actors:
                raise ValueError('ambiguous or nonnumeric initial instance ID')
            actors[pid] = side
            roster[pid] = pet
    if not actors:
        raise ValueError('known initial roster required')
    events = array(record['events'], 'normalized events')
    by_id = {}
    for event in events:
        eid = event.get('id')
        if not isinstance(eid, str) or eid in by_id:
            raise ValueError('unique normalized event IDs required')
        by_id[eid] = event
    initial, entries, counts = bounded_source(source, record)
    states = {}
    last_state = {}
    costs = collections.defaultdict(list)
    cost_updates = {}
    seen_casts = set()
    cost_examples = []
    energy_checks = []
    last_sync = {}

    def ingest_costs(pid, skills, coordinate):
        if pid not in actors:
            return
        values = {}
        for skill in array(skills, 'skill round data'):
            object_value(skill, 'skill round entry')
            runtime = str(integer(skill.get('id'), 'runtime skill ID', 1))
            # Missing is not zero and invalidates this explicitly updated entry.
            value = integer(skill['cost_energy'], 'skill cost') if 'cost_energy' in skill else None
            if runtime in values and values[runtime] != value:
                raise ValueError('conflicting per-pet skill costs')
            values[runtime] = value
        for runtime, value in values.items():
            key = (coordinate, pid, runtime)
            if key in cost_updates and cost_updates[key] != value:
                raise ValueError('conflicting same-position skill costs')
            cost_updates[key] = value
            costs[(pid, runtime)].append((value, coordinate))
            counts['cost_observations'] += 1

    def snapshot(pet, coordinate, stage, line, expected_side=None):
        object_value(pet, 'full pet snapshot')
        inside = object_value(pet.get('battle_inside_pet_info'), 'inside pet')
        pid = pet_id(inside.get('pet_id'))
        if pid not in actors:
            counts['outside_roster_snapshots_skipped'] += 1
            return None
        if expected_side and actors[pid] != expected_side:
            raise ValueError('initial source side mismatch')
        pid, fields, inside = full_pet_fields(pet)
        if stage == 'initial' and roster[pid].get('protocolBaseId') is not None:
            if str(inside.get('base_conf_id')) != roster[pid]['protocolBaseId']:
                raise ValueError('initial base identity mismatch')
        if 'skill_round_data' in inside:
            ingest_costs(pid, inside['skill_round_data'], coordinate)
        if not fields:
            return pid
        round_no, seq, index = coordinate
        suffix = '' if stage == 'snapshot' else ':' + stage
        eid = f'rkpp:state:{round_no}:{seq}:{index}:{pid}{suffix}'
        event = {'id': eid, 'round': round_no, 'seq': seq, 'execIndex': index,
                 'kind': 'resource', 'phase': 'executed', 'side': actors[pid],
                 'actor': pid, 'stateStage': stage, **fields,
                 'text': f'主通道明确状态；battle_attr[1]/[25] 与 common.energy（仅存在字段）；CSV逻辑行 {line}。'}
        if eid in states:
            if {key: value for key, value in states[eid].items() if key != 'text'} != {key: value for key, value in event.items() if key != 'text'}:
                raise ValueError('conflicting stable state key')
            counts['duplicate_state_keys'] += 1
            return pid
        # Register even unchanged samples, so same-key disagreements cannot hide.
        states[eid] = event
        current = last_state.setdefault(pid, {})
        unchanged = all(current.get(key) == value for key, value in fields.items())
        current.update(fields)
        if stage == 'snapshot' and unchanged:
            counts['unchanged_snapshots_skipped'] += 1
            return pid
        generated.append(event)
        counts[stage + '_states'] += 1
        if 'energyAfter' in fields and pid in last_sync:
            previous_coordinate, previous_value = last_sync[pid]
            counts['energy_snapshots_matching_prior_sync' if fields['energyAfter'] == previous_value else 'energy_snapshots_differing_from_prior_sync'] += 1
            if len(energy_checks) < 12:
                energy_checks.append({'actor': pid, 'coordinate': list(coordinate), 'energy': fields['energyAfter'], 'priorSyncCoordinate': list(previous_coordinate), 'priorSyncEnergy': previous_value})
        return pid

    generated = []
    initial_pets = set()
    initial_info, initial_line = initial
    for collection, side in (('player_team', 'me'), ('enemy_team', 'enemy'), ('others', 'enemy')):
        for team in array(initial_info.get(collection, []), 'initial team collection'):
            for pet in array(team.get('pets', []), 'initial team pets'):
                pid = snapshot(pet, (0, 0, 0), 'initial', initial_line, side)
                if pid:
                    initial_pets.add(pid)
    if initial_pets != set(actors):
        raise ValueError('opening does not contain every known initial actor')

    existing_resource = collections.defaultdict(list)
    for event in events:
        if event.get('kind') == 'resource' and event.get('phase') == 'executed' and 'energyChange' in event:
            key = (event.get('round'), event.get('seq'), event.get('execIndex'), event.get('actor'))
            existing_resource[key].append(event)

    for coordinate, entry, line in entries:
        typ = entry.get('type')
        typ = typ.get('value') if isinstance(typ, dict) else typ
        if type(typ) is not int:
            raise ValueError('numeric primary entry type required')
        sync_values = {}
        for sync in array(entry.get('sync_data', {}).get('pet_sync_info', []), 'synchronizations'):
            pid = pet_id(sync.get('pet_id'))
            if pid not in actors:
                continue
            for field in ('energy_change', 'energy_result', 'hp_result'):
                if field not in sync:
                    continue
                value = signed32(sync[field])
                key = (pid, field)
                if key in sync_values and sync_values[key] != value:
                    raise ValueError('conflicting same-entry synchronization')
                sync_values[key] = value
                if field == 'energy_result':
                    integer(value, 'energy result')
                    last_sync[pid] = (coordinate, value)
        if typ == 35:
            update = object_value(entry.get('data_update'), 'primary data update')
            if 'pet_skill' in update:
                skill_update = object_value(update['pet_skill'], 'pet skill update')
                ingest_costs(pet_id(skill_update.get('pet_id')), skill_update.get('skills', []), coordinate)
            pets = [update['pet']] if 'pet' in update else []
            if 'other' in update:
                pets += array(update['other'].get('pets', []), 'other pets')
            for pet in pets:
                snapshot(pet, coordinate, 'snapshot', line)
        elif typ == 37:
            supply = object_value(entry.get('supply_pet'), 'primary supply')
            for info in array(supply.get('pet_infos', []), 'supply pets'):
                pid = pet_id(info.get('pet_id'))
                if pid not in actors:
                    counts['outside_roster_snapshots_skipped'] += 1
                    continue
                pet = object_value(info.get('pet_info'), 'supplied full pet')
                if pet_id(pet.get('battle_inside_pet_info', {}).get('pet_id')) != pid:
                    raise ValueError('supplied instance mismatch')
                prefix = ':'.join(map(str, coordinate))
                previous = by_id.get(f'rkpp:action:{prefix}:supply:{pid}')
                if not previous or previous.get('kind') != 'effect' or previous.get('phase') != 'executed' or previous.get('actor') != pid or previous.get('side') != actors[pid] or tuple(previous.get(key) for key in ('round', 'seq', 'execIndex')) != coordinate:
                    raise ValueError('entry snapshot requires existing matching supply event')
                if info.get('pet_pos') != 1 or pet['battle_inside_pet_info'].get('pos') != 1:
                    raise ValueError('supplied position mismatch')
                snapshot(pet, coordinate, 'entry', line)
        elif typ == 1:
            cast = object_value(entry.get('skill_cast'), 'primary cast')
            if not cast.get('caster_id') or not cast.get('skill_id'):
                continue
            pid, runtime = pet_id(cast['caster_id']), str(integer(cast['skill_id'], 'runtime skill ID', 1))
            eid = 'rkpp:action:' + ':'.join(map(str, coordinate)) + ':cast'
            event = by_id.get(eid)
            if not event or not (event.get('kind') == 'skill' or event.get('kind') == 'effect' and event.get('skillClass') == 'system'):
                continue
            expected_phase = 'interrupted' if cast.get('is_interupt') is True else 'executed'
            if 'is_interupt' in cast and type(cast['is_interupt']) is not bool:
                raise ValueError('invalid interruption flag')
            if pid not in actors or event.get('actor') != pid or event.get('side') != actors[pid] or event.get('protocolSkillId') != runtime or event.get('phase') != expected_phase or tuple(event.get(key) for key in ('round', 'seq', 'execIndex')) != coordinate:
                raise ValueError('normalized cast differs from primary source')
            seen_casts.add(eid)
            if runtime == PREVENTION_RUNTIME:
                if event.get('kind') != 'skill' or event.get('skillClass') != 'response' or event.get('skillId', 0) not in (0, 74):
                    raise ValueError('effective prevention identity conflict')
                if event.get('skillId', 0) == 0:
                    event['skillId'] = 74
                    counts['prevention_mappings_added'] += 1
            resource = existing_resource.get((*coordinate, pid), [])
            negative = set()
            for item in resource:
                if item.get('side') != actors[pid]:
                    raise ValueError('energy resource side mismatch')
                delta = signed32(item['energyChange'])
                if delta < 0:
                    negative.add(-delta)
            if len(negative) > 1:
                raise ValueError('conflicting matched negative costs')
            source_cost, source_coordinate = next(((value, point) for value, point in reversed(costs[(pid, runtime)]) if point < coordinate), (None, None))
            proof = 'prior-per-pet-cost_energy'
            value = source_cost
            original_link = None
            if negative:
                value = next(iter(negative))
                if sync_values.get((pid, 'energy_change')) != -value:
                    raise ValueError('normalized cost delta differs from primary synchronization')
                proof = 'matched-negative-energyChange'
                source_coordinate = coordinate
            elif value is None and runtime in ORIGINAL_COST_LINKS:
                original_runtime, link_proof = ORIGINAL_COST_LINKS[runtime]
                value, source_coordinate = next(((amount, point) for amount, point in reversed(costs[(pid, original_runtime)]) if point < coordinate), (None, None))
                if value is not None:
                    proof = 'prior-actor-original-cost_energy'
                    original_link = {'originalRuntimeSkillId': original_runtime, 'linkProof': link_proof}
            if value is not None:
                integer(value, 'explicit action energy cost')
                if 'energyCost' in event and (type(event['energyCost']) is not int or event['energyCost'] != value):
                    raise ValueError('existing explicit energy cost conflict')
                if 'energyCost' not in event:
                    counts['action_costs_added'] += 1
                event['energyCost'] = value
                counts['action_costs_explicit'] += 1
                counts['cost_from_delta' if negative else 'cost_from_original_snapshot' if original_link else 'cost_from_snapshot'] += 1
                cost_examples.append({'eventId': eid, 'actor': pid, 'runtimeSkillId': runtime, 'energyCost': value, 'proof': proof, 'sourceCoordinate': list(source_coordinate), **(original_link or {})})
            else:
                counts['action_costs_unknown'] += 1
    eligible = {event['id'] for event in events if event.get('kind') == 'skill' or event.get('kind') == 'effect' and event.get('skillClass') == 'system'}
    if eligible != seen_casts:
        raise ValueError('eligible normalized casts missing from bounded primary source')
    for event in generated:
        if event['id'] in by_id:
            if event != by_id[event['id']]:
                raise ValueError('existing state event conflict')
        else:
            events.append(event)
            counts['state_events_added'] += 1
    report = {'counts': dict(sorted(counts.items())), 'initialActors': len(actors),
              'originalEvents': len(original['events']), 'totalEvents': len(events),
              'explicitCostCoverage': {'known': counts['action_costs_explicit'], 'unknown': counts['action_costs_unknown'], 'eligible': len(eligible)},
              'costEvidence': cost_examples, 'energySnapshotChecks': energy_checks,
              'stateExamples': generated[:3] + [event for event in generated if event['stateStage'] == 'entry'],
              'qualityUnchanged': record.get('quality') == original.get('quality'),
              'sourceSHA256': hashlib.sha256(Path(source).read_bytes()).hexdigest()}
    return record, report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'record', 'output', 'report'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--source-sha256', required=True)
    args = parser.parse_args(argv)
    paths = [path.resolve() for path in (args.source, args.record, args.output, args.report)]
    if len(set(paths)) != 4:
        raise ValueError('inputs and outputs must be distinct')
    for output in (args.output, args.report):
        if output.exists():
            raise ValueError('refuse overwriting prior output')
        if output.suffix.lower() != '.json':
            raise ValueError('JSON output paths required')
    if not re.fullmatch(r'[0-9a-f]{64}', args.source_sha256) or hashlib.sha256(args.source.read_bytes()).hexdigest() != args.source_sha256:
        raise ValueError('source SHA-256 mismatch')
    record, report = enrich(args.source, json.loads(args.record.read_bytes()))
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump({'version': 1, 'records': [record]}, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    with args.report.open('x', encoding='utf-8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    print(json.dumps({'counts': report['counts'], 'totalEvents': report['totalEvents'], 'explicitCostCoverage': report['explicitCostCoverage']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
