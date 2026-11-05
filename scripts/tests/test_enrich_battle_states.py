"""Isolated synthetic CSV tests. Real backup access is explicit opt-in only."""
import copy
import csv
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('enrich_states', Path(__file__).parents[1] / 'enrich_battle_states.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def pet(pid, hp=100, maximum=100, energy=10, position=1, skills=None):
    attrs = [0] * 26
    attrs[1], attrs[25] = maximum, hp
    inside = {'pet_id': pid, 'pos': position, 'battle_attr': attrs,
              'owner_uin': 'must-not-persist', 'name': 'must-not-persist'}
    if skills is not None:
        inside['skill_round_data'] = skills
    return {'battle_inside_pet_info': inside, 'battle_common_pet_info': {'energy': energy, 'owner': 'must-not-persist'}}


def cost(runtime=700, value=2):
    return {'id': runtime, 'cost_energy': value, 'skill_energy_cost': [999], 'raw_cost_energy': 999}


def cast_entry(pid=1, runtime=700, index=2, interrupted=False, delta=None):
    entry = {'type': 1, 'exec_index': index, 'skill_cast': {'caster_id': pid, 'skill_id': runtime, 'is_interupt': interrupted}}
    if delta is not None:
        entry['sync_data'] = {'pet_sync_info': [{'pet_id': pid, 'energy_change': delta if delta >= 0 else 2**64 + delta}]}
    return entry


def cast_event(pid=1, runtime=700, index=2, seq=2, round_no=1, interrupted=False):
    return {'id': f'rkpp:action:{round_no}:{seq}:{index}:cast', 'kind': 'skill', 'phase': 'interrupted' if interrupted else 'executed', 'round': round_no, 'seq': seq,
            'execIndex': index, 'actor': str(pid), 'side': 'me' if pid in (1, 3) else 'enemy', 'protocolSkillId': str(runtime), 'skillId': 20, 'skillClass': 'ordinary', 'text': 'old text unchanged'}


class StateEnrichmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'capture.csv'
        self.initial = {'battle_id': 'fixture', 'player_team': [{'pets': [pet(1, skills=[cost()])]}], 'enemy_team': [{'pets': [pet(2, position=-1)]}]}
        self.record = {'version': 1, 'id': 'rkpp:fixture', 'rounds': 2, 'source': 'isolated', 'outcome': 'unknown',
                       'quality': {'actions': False, 'lead': {'me': False, 'enemy': False}},
                       'sides': {'me': {'pets': [{'instanceId': '1', 'monsterId': 11}]}, 'enemy': {'pets': [{'instanceId': '2', 'monsterId': 22}]}},
                       'events': [], 'issues': ['preserve this issue']}

    def write(self, batches=(), prefix=(), suffix=(), complete=True):
        rows = list(prefix) + [('0x1316', {'init_info': self.initial})]
        for seq, entries in batches:
            rows.append(('0x131A', {'state_info': {'battle_id': 'fixture'}, 'perform_cmd': {'round': 1, 'seq_num': seq, 'perform_info': entries}}))
        if complete:
            rows.append(('0x132C', {'settle_info': {'battle_id': 'fixture', 'rounds': 2}}))
        rows += list(suffix)
        with self.source.open('w', encoding='utf-8', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(['opencode', 'meaning', 'content'])
            writer.writerows((op, '', json.dumps(message)) for op, message in rows)
        return rows

    def result(self, record=None):
        return m.enrich(self.source, record if record is not None else self.record)

    def test_initial_exact_indices_zero_and_explicit_position_only(self):
        self.initial['enemy_team'][0]['pets'][0] = pet(2, hp=0, energy=0, position=1)
        self.write()
        r, report = self.result()
        a, b = r['events']
        self.assertEqual((a['hpMax'], a['hpAfter'], a['energyAfter'], a['stateActive']), (100, 100, 10, True))
        self.assertEqual((b['hpAfter'], b['energyAfter']), (0, 0))
        self.assertNotIn('stateActive', b, 'HP0 alone never means inactive')
        self.assertEqual((a['round'], a['seq'], a['execIndex'], a['stateStage']), (0, 0, 0, 'initial'))
        self.assertEqual(report['initialActors'], 2)
        self.assertNotIn('must-not-persist', json.dumps(r) + json.dumps(report))
        self.assertEqual(r['quality'], self.record['quality'])
        self.assertEqual(r['sides'], self.record['sides'])

    def test_unsigned_negative_one_is_explicit_inactive_but_position_zero_is_unknown(self):
        self.initial['player_team'][0]['pets'][0]['battle_inside_pet_info']['pos'] = m.UINT64_MINUS_ONE
        self.initial['enemy_team'][0]['pets'][0]['battle_inside_pet_info']['pos'] = 0
        self.write()
        r, _ = self.result()
        self.assertIs(r['events'][0]['stateActive'], False)
        self.assertNotIn('stateActive', r['events'][1])

    def test_missing_numeric_fields_are_not_defaults_and_bad_values_fail(self):
        full = self.initial['player_team'][0]['pets'][0]
        full['battle_inside_pet_info'].pop('battle_attr')
        full['battle_common_pet_info'].pop('energy')
        self.write()
        r, _ = self.result()
        self.assertTrue(all(e['actor'] != '1' for e in r['events']))
        for field, value in [('hp', -1), ('hp', True), ('maximum', 0), ('maximum', 2**31), ('energy', None), ('energy', '10')]:
            with self.subTest(field=field, value=value):
                self.initial['player_team'][0]['pets'][0] = pet(1, **{field: value})
                self.write()
                with self.assertRaises(ValueError):
                    self.result()

    def test_unknown_random_pets_are_skipped_never_added_to_roster(self):
        update = {'type': 35, 'exec_index': 1, 'data_update': {'pet': pet(7, skills=[cost(700, 0)])}}
        self.write([(1, [update])])
        r, report = self.result()
        self.assertEqual(report['counts']['outside_roster_snapshots_skipped'], 1)
        self.assertTrue(all(e['actor'] != '7' for e in r['events']))
        self.assertEqual(r['sides'], self.record['sides'])

    def test_snapshots_dedupe_unchanged_keep_explicit_zero_and_partial(self):
        partial = pet(1, hp=0, energy=0, position=0)
        partial['battle_common_pet_info'].pop('energy')
        self.write([(1, [{'type': 35, 'exec_index': 1, 'data_update': {'pet': pet(1)}}]),
                    (2, [{'type': 35, 'exec_index': 1, 'data_update': {'pet': partial}}])])
        r, report = self.result()
        self.assertEqual(report['counts']['unchanged_snapshots_skipped'], 1)
        self.assertEqual(len(r['events']), 3)
        self.assertEqual(r['events'][-1]['hpAfter'], 0)
        self.assertNotIn('energyAfter', r['events'][-1])
        self.assertNotIn('stateActive', r['events'][-1])

    def test_same_state_key_conflicts_even_if_first_sample_was_unchanged(self):
        entries = [{'type': 35, 'exec_index': 1, 'data_update': {'pet': pet(1, hp=hp)}} for hp in (100, 90)]
        self.write([(1, entries)])
        with self.assertRaisesRegex(ValueError, 'conflicting stable state'):
            self.result()

    def test_exact_duplicate_entries_and_initial_aliases_dedupe(self):
        self.initial['others'] = copy.deepcopy(self.initial['enemy_team'])
        entry = {'type': 35, 'exec_index': 1, 'data_update': {'pet': pet(1, hp=90)}}
        self.write([(1, [entry, copy.deepcopy(entry)])])
        r, report = self.result()
        self.assertEqual(len(r['events']), 3)
        self.assertEqual(report['counts']['duplicate_primary_entries'], 1)
        self.assertEqual(report['counts']['duplicate_state_keys'], 1)

    def test_different_branches_can_share_index_without_false_conflict(self):
        self.write([(1, [{'type': 3, 'exec_index': 1, 'buff_trigger': {}}, {'type': 35, 'exec_index': 1, 'data_update': {'pet': pet(1, hp=90)}}])])
        r, _ = self.result()
        self.assertEqual(r['events'][-1]['hpAfter'], 90)

    def test_cost_is_per_actor_runtime_prior_not_future_or_catalog_raw_cost(self):
        self.record['sides']['me']['pets'].append({'instanceId': '3', 'monsterId': 33})
        self.initial['player_team'][0]['pets'].append(pet(3, skills=[cost(700, 0)]))
        one, three = cast_event(index=2), cast_event(pid=3, index=3)
        self.record['events'] = [one, three]
        future = {'type': 35, 'exec_index': 9, 'data_update': {'pet_skill': {'pet_id': 3, 'skills': [cost(700, 8)]}}}
        self.write([(2, [cast_entry(index=2), cast_entry(pid=3, index=3), future])])
        r, report = self.result()
        self.assertEqual([e['energyCost'] for e in r['events'][:2]], [2, 0])
        self.assertEqual(report['explicitCostCoverage'], {'known': 2, 'unknown': 0, 'eligible': 2})
        self.assertNotIn('energyCost', one)

    def test_same_coordinate_cost_update_does_not_supply_cast_cost(self):
        self.record['events'] = [cast_event()]
        update = {'type': 35, 'exec_index': 2, 'data_update': {'pet_skill': {'pet_id': 1, 'skills': [cost(700, 0)]}}}
        self.write([(2, [update, cast_entry()])])
        r, _ = self.result()
        self.assertEqual(r['events'][0]['energyCost'], 2)

    def test_missing_updated_cost_invalidates_previous_without_guessing_zero(self):
        self.record['events'] = [cast_event()]
        update = {'type': 35, 'exec_index': 1, 'data_update': {'pet_skill': {'pet_id': 1, 'skills': [{'id': 700}]}}}
        self.write([(1, [update]), (2, [cast_entry()])])
        r, report = self.result()
        self.assertNotIn('energyCost', r['events'][0])
        self.assertEqual(report['explicitCostCoverage']['unknown'], 1)

    def test_negative_resource_overrides_snapshot_and_interruption_stays_interrupted(self):
        event = cast_event(interrupted=True)
        resource = {'id': 'resource', 'kind': 'resource', 'phase': 'executed', 'round': 1, 'seq': 2, 'execIndex': 2, 'actor': '1', 'side': 'me', 'energyChange': -4, 'energyAfter': 6}
        self.record['events'] = [event, resource]
        self.write([(2, [cast_entry(interrupted=True, delta=-4)])])
        r, report = self.result()
        self.assertEqual(r['events'][0]['energyCost'], 4)
        self.assertEqual(r['events'][0]['phase'], 'interrupted')
        self.assertEqual(r['events'][1], resource)
        self.assertEqual(report['counts']['cost_from_delta'], 1)
        self.record['events'][1]['energyChange'] = -3
        with self.assertRaisesRegex(ValueError, 'differs from primary'):
            self.result()

    def test_conflicting_costs_and_existing_cost_reject(self):
        self.record['events'] = [cast_event()]
        update = {'type': 35, 'exec_index': 1, 'data_update': {'pet_skill': {'pet_id': 1, 'skills': [cost(700, 0), cost(700, 1)]}}}
        self.write([(1, [update]), (2, [cast_entry()])])
        with self.assertRaisesRegex(ValueError, 'conflicting per-pet'):
            self.result()
        self.record['events'][0]['energyCost'] = 3
        self.write([(2, [cast_entry()])])
        with self.assertRaisesRegex(ValueError, 'energy cost conflict'):
            self.result()

    def test_entry_requires_existing_same_coordinates_supply_and_never_adds_roster(self):
        supply = {'id': 'rkpp:action:1:2:4:supply:2', 'kind': 'effect', 'phase': 'executed', 'actor': '2', 'side': 'enemy', 'round': 1, 'seq': 2, 'execIndex': 4, 'label': '补位通知'}
        self.record['events'] = [supply]
        entry = {'type': 37, 'exec_index': 4, 'supply_pet': {'pet_infos': [{'pet_id': 2, 'pet_pos': 1, 'pet_info': pet(2, hp=80, energy=7)}]}}
        self.write([(2, [entry])])
        r, _ = self.result()
        self.assertEqual(r['events'][-1]['stateStage'], 'entry')
        self.assertEqual(r['events'][-1]['id'], 'rkpp:state:1:2:4:2:entry')
        self.assertEqual(r['events'][-1]['energyAfter'], 7)
        self.assertEqual(r['events'][0], supply)
        self.record['events'] = []
        with self.assertRaisesRegex(ValueError, 'existing matching supply'):
            self.result()

    def test_prevention_only_approved_exact_runtime_response_maps_74(self):
        event = cast_event(runtime=702111100)
        event.update(skillId=0, skillClass='response')
        self.record['events'] = [event]
        self.write([(2, [cast_entry(runtime=702111100)])])
        r, report = self.result()
        self.assertEqual(r['events'][0]['skillId'], 74)
        self.assertEqual(report['counts']['prevention_mappings_added'], 1)
        event['skillId'] = 75
        with self.assertRaisesRegex(ValueError, 'identity conflict'):
            self.result()

    def test_idempotence_immutability_existing_state_conflicts_and_envelope(self):
        self.record['events'] = [cast_event()]
        before = copy.deepcopy(self.record)
        self.write([(2, [cast_entry()])])
        first, _ = self.result()
        second, report = self.result({'version': 1, 'records': [first]})
        self.assertEqual(first, second)
        self.assertEqual(self.record, before)
        self.assertNotIn('state_events_added', report['counts'])
        first['events'][-1]['hpAfter'] = 9
        with self.assertRaisesRegex(ValueError, 'existing state event conflict'):
            self.result(first)

    def test_primary_boundaries_ignore_previews_queries_orphans_and_future_packets(self):
        fake = {'perform_cmd': {'round': 1, 'seq_num': 2, 'perform_info': [cast_entry()]}}
        preview = ('0x13F3', fake)
        orphan = ('0x1324', fake)
        self.write(prefix=[preview, orphan], suffix=[preview, orphan])
        r, report = self.result()
        self.assertEqual(len(r['events']), 2)
        self.assertEqual(report['explicitCostCoverage']['eligible'], 0)
        self.write(complete=False)
        with self.assertRaisesRegex(ValueError, 'boundary'):
            self.result()
        self.write(suffix=[('0x1316', {'init_info': self.initial})])
        with self.assertRaisesRegex(ValueError, 'repeated target'):
            self.result()

    def test_missing_initial_actor_or_side_or_source_cast_identity_refuse(self):
        self.initial['enemy_team'] = []
        self.write()
        with self.assertRaisesRegex(ValueError, 'every known'):
            self.result()
        self.initial['enemy_team'] = [{'pets': [pet(2)]}]
        self.record['events'] = [cast_event(pid=2)]
        self.write([(2, [cast_entry()])])
        with self.assertRaisesRegex(ValueError, 'differs from primary'):
            self.result()

    def test_same_key_identical_state_dedupes_even_if_private_metadata_differs(self):
        a = {'type': 35, 'exec_index': 1, 'data_update': {'pet': pet(1, hp=90)}, 'owner': 'first-secret'}
        b = copy.deepcopy(a); b['owner'] = 'second-secret'
        self.write([(1, [a]), (1, [b])])
        r, report = self.result()
        self.assertEqual(len(r['events']), 3)
        self.assertEqual(report['counts']['duplicate_state_keys'], 1)
        self.assertNotIn('secret', json.dumps(r) + json.dumps(report))

    def test_overlapping_and_mismatched_boundaries_refuse(self):
        for packet in [('0x1316', {'init_info': {'battle_id': 'other'}}),
                       ('0x132C', {'settle_info': {'battle_id': 'other', 'rounds': 2}}),
                       ('0x1324', {'battle_id': 'other', 'perform_cmd': {'round': 1, 'seq_num': 1, 'perform_info': []}})]:
            self.write(complete=False, suffix=[packet])
            with self.assertRaises(ValueError):
                self.result()

    def test_noninteger_type_and_invalid_versions_are_not_coerced(self):
        self.record['events'] = [cast_event()]
        entry = cast_entry(); entry['type'] = True
        self.write([(2, [entry])])
        with self.assertRaisesRegex(ValueError, 'numeric primary entry type'):
            self.result()
        for value in [True, '1', 2]:
            bad = copy.deepcopy(self.record); bad['version'] = value
            with self.assertRaises(ValueError):
                self.result(bad)

    def test_conflicting_negative_resource_costs_are_not_summed(self):
        self.record['events'] = [cast_event()] + [dict(id='resource-' + str(n), kind='resource', phase='executed', round=1, seq=2, execIndex=2, actor='1', side='me', energyChange=-n) for n in (2, 3)]
        self.write([(2, [cast_entry(delta=-2)])])
        with self.assertRaisesRegex(ValueError, 'conflicting matched negative costs'):
            self.result()

    def test_approved_original_cost_pairs_use_actor_local_prior_changes_with_distinct_proof(self):
        for response, original, link in [(707027100, 707027000, 'audited-original-runtime-link'), (702111100, 702111000, 'user-confirmed-effective-prevention-family')]:
            self.initial['player_team'][0]['pets'][0]['battle_inside_pet_info']['skill_round_data'] = [cost(original, 1)]
            event = cast_event(runtime=response); event.update(skillClass='response', skillId=0 if response == 702111100 else 491)
            self.record['events'] = [event]
            change = {'type': 35, 'exec_index': 1, 'data_update': {'pet_skill': {'pet_id': 1, 'skills': [cost(original, 0)]}}}
            self.write([(1, [change]), (2, [cast_entry(runtime=response)])])
            r, report = self.result()
            self.assertEqual(r['events'][0]['energyCost'], 0)
            proof = report['costEvidence'][0]
            self.assertEqual(proof['proof'], 'prior-actor-original-cost_energy')
            self.assertEqual(proof['originalRuntimeSkillId'], str(original))
            self.assertEqual(proof['linkProof'], link)
            self.assertEqual(proof['sourceCoordinate'], [1, 1, 1])
            self.assertEqual(report['counts']['cost_from_original_snapshot'], 1)

    def test_original_cost_is_last_priority_after_same_runtime_then_negative_delta(self):
        self.initial['player_team'][0]['pets'][0]['battle_inside_pet_info']['skill_round_data'] = [cost(707027000, 0), cost(707027100, 4)]
        self.record['events'] = [cast_event(runtime=707027100)]
        self.write([(2, [cast_entry(runtime=707027100)])])
        r, report = self.result()
        self.assertEqual(r['events'][0]['energyCost'], 4)
        self.assertEqual(report['costEvidence'][0]['proof'], 'prior-per-pet-cost_energy')
        self.assertNotIn('originalRuntimeSkillId', report['costEvidence'][0])
        self.record['events'].append(dict(id='delta', kind='resource', phase='executed', round=1, seq=2, execIndex=2, actor='1', side='me', energyChange=-3))
        self.write([(2, [cast_entry(runtime=707027100, delta=-3)])])
        r, report = self.result()
        self.assertEqual(r['events'][0]['energyCost'], 3)
        self.assertEqual(report['costEvidence'][0]['proof'], 'matched-negative-energyChange')

    def test_original_cost_never_borrows_other_actor_same_position_future_or_query_values(self):
        self.initial['player_team'][0]['pets'][0]['battle_inside_pet_info']['skill_round_data'] = []
        self.initial['enemy_team'][0]['pets'][0]['battle_inside_pet_info']['skill_round_data'] = [cost(707027000, 0)]
        self.record['events'] = [cast_event(runtime=707027100)]
        update = {'type': 35, 'exec_index': 2, 'data_update': {'pet_skill': {'pet_id': 1, 'skills': [cost(707027000, 0)]}}}
        future = copy.deepcopy(update); future['exec_index'] = 3
        query = ('0x1336', {'items': [{'skill_op': {'skill_id': 707027100, 'original_skill_id': 707027000, 'cost_energy': 0}}]})
        self.write([(2, [update, cast_entry(runtime=707027100), future])], prefix=[query])
        r, _ = self.result()
        self.assertNotIn('energyCost', r['events'][0])
        # Similar suffixes are not an approved third pair.
        self.initial['player_team'][0]['pets'][0]['battle_inside_pet_info']['skill_round_data'] = [cost(707028000, 0)]
        self.record['events'] = [cast_event(runtime=707028100)]
        self.write([(2, [cast_entry(runtime=707028100)])])
        r, _ = self.result()
        self.assertNotIn('energyCost', r['events'][0])
        self.assertEqual(set(m.ORIGINAL_COST_LINKS), {'707027100', '702111100'})

    def test_cli_requires_matching_hash_fresh_distinct_json_outputs(self):
        self.write()
        record_path, output, report = (self.root / name for name in ('record.json', 'output.json', 'report.json'))
        record_path.write_text(json.dumps(self.record), encoding='utf-8')
        args = ['--source', str(self.source), '--source-sha256', hashlib.sha256(self.source.read_bytes()).hexdigest(), '--record', str(record_path), '--output', str(output), '--report', str(report)]
        bad = args.copy(); bad[3] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            m.main(bad)
        self.assertFalse(output.exists())
        m.main(args)
        first = output.read_bytes()
        self.assertEqual(json.loads(first)['version'], 1)
        with self.assertRaisesRegex(ValueError, 'overwriting'):
            m.main(args)
        self.assertEqual(first, output.read_bytes())


@unittest.skipUnless(os.environ.get('BATTLE_STATE_SOURCE') and os.environ.get('BATTLE_STATE_RECORD'), 'real source and backup are opt-in')
class RealStateEnrichmentTests(unittest.TestCase):
    def test_reviewed_capture_preserves_200_events_and_wind_zero(self):
        source = Path(os.environ['BATTLE_STATE_SOURCE'])
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), 'c80cec7ea42edf5b0a7825b73f23b1b9204dadbc9e2d93d2c02cfb9b64f8999b')
        original = json.loads(Path(os.environ['BATTLE_STATE_RECORD']).read_bytes())
        r, report = m.enrich(source, original)
        self.assertEqual(len(original['events']), 200)
        old = {e['id']: e for e in original['events']}
        self.assertEqual(len(r['events']), 283)
        self.assertEqual(report['counts']['initial_states'], 12)
        self.assertEqual(report['counts']['entry_states'], 3)
        self.assertEqual(report['counts']['prevention_mappings_added'], 2)
        self.assertEqual(report['explicitCostCoverage'], {'known': 59, 'unknown': 2, 'eligible': 61})
        self.assertEqual(report['counts']['cost_from_original_snapshot'], 2)
        for event in r['events']:
            if event['id'] not in old:
                self.assertIn(event['actor'], {'1', '2', '3', '4', '5', '6', '401', '402', '403', '404', '405', '406'})
                continue
            core = copy.deepcopy(event)
            core.pop('energyCost', None)
            if core.get('protocolSkillId') == m.PREVENTION_RUNTIME:
                if 'skillId' in old[event['id']]:
                    core['skillId'] = old[event['id']]['skillId']
                else:
                    core.pop('skillId', None)
            self.assertEqual(core, old[event['id']])
        wind = next(e for e in r['events'] if e['id'] == 'rkpp:action:5:26:1:cast')
        self.assertEqual((wind['actor'], wind['protocolSkillId'], wind['energyCost']), ('3', '715027000', 0))
        for eid, actor, origin, point in [('rkpp:action:3:15:12:cast', '3', '707027000', [3, 13, 4]), ('rkpp:action:35:192:110:cast', '1', '702111000', [35, 190, 2])]:
            event = next(e for e in r['events'] if e['id'] == eid)
            proof = next(e for e in report['costEvidence'] if e['eventId'] == eid)
            self.assertEqual((event['actor'], event['energyCost']), (actor, 0))
            self.assertEqual(proof['sourceCoordinate'], point)
            self.assertEqual(proof['originalRuntimeSkillId'], origin)
            self.assertEqual(proof['proof'], 'prior-actor-original-cost_energy')
        self.assertEqual(r['quality'], original['quality'])
        self.assertEqual(r['sides'], original['sides'])
        again, _ = m.enrich(source, r)
        self.assertEqual(r, again)


if __name__ == '__main__':
    unittest.main()
