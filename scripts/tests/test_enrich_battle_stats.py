"""Synthetic isolated tests. Actual capture access requires explicit opt-in JSON.

Set BATTLE_STATS_ACTUAL_INPUTS to a JSON object with source, record, catalog,
schema_db and all four *_sha256 values. Inputs read-only; outputs use temp dirs.
"""
import copy
import csv
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import enrich_battle_stats as stats


def schema_fixture():
    enums = {
        'SkillPerformType': {'values': {'1': 'SPT_ACTIVE', '2': 'SPT_PASSIVE', '3': 'SPT_COUNTER'}},
        'SkillRestraintType': {'values': copy.deepcopy(stats.RESTRAINT_ENUM)},
        'ChangePetPerformType': {'values': {'0': 'CPPT_NORMAL', '1': 'CPPT_NO_BALL'}},
        'BattleDeadInfo.DeadType': {'values': {'0': 'NORMAL_DEAD'}},
    }
    fields = {
        'BattlePerformInfo': {'1': ('type', 'BattlePerformType'), '2': ('group_id', 'uint32'), '11': ('is_group_head', 'bool'), '26': ('group_ref', 'uint32'), '39': ('exec_index', 'uint32')},
        'BattleSkillCast': {'1': ('caster_id', 'uint32'), '3': ('skill_id', 'uint32'), '7': ('type', 'SkillPerformType'), '8': ('is_interupt', 'bool')},
        'BattleDamageInfo': {'1': ('caster_id', 'uint32'), '2': ('target_id', 'uint32'), '3': ('source_id', 'uint32'), '7': ('restraint_type', 'int32'), '9': ('dam_type', 'int32')},
        'BattleDeadInfo': {'1': ('caster_id', 'uint32'), '2': ('target_id', 'uint32'), '3': ('dead_type', 'BattleDeadInfo.DeadType')},
        'BattleChangePet': {'2': ('rest_pet_id', 'uint32'), '3': ('battle_pet_id', 'uint32'), '5': ('is_cmd', 'bool'), '6': ('perform_type', 'ChangePetPerformType')},
    }
    return {'enums': enums, 'messages': {name: {'fields': {number: {'name': pair[0], 'type': pair[1]} for number, pair in fs.items()}} for name, fs in fields.items()}}


def skill(sid, category):
    name, description, _ = stats.REVIEWED_RESPONSES[sid]
    return {'id': sid, 'name': name, 'description': description, 'category': category}


def event(index, suffix, kind, actor, side, **extra):
    return {'id': f'rkpp:action:1:1:{index}:{suffix}', 'round': 1, 'seq': 1,
            'execIndex': index, 'kind': kind, 'phase': 'executed', 'actor': actor,
            'side': side, **extra}


def fixture():
    entries = [
        {'type': 1, 'group_id': 1, 'exec_index': 1, 'is_group_head': True, 'group_ref': 0,
         'skill_cast': {'caster_id': 1, 'target_id': [401], 'skill_id': 100, 'type': 1}},
        {'type': 1, 'group_id': 2, 'exec_index': 2, 'is_group_head': True, 'group_ref': 1,
         'skill_cast': {'caster_id': 401, 'target_id': [401], 'skill_id': 200, 'type': 3}},
        {'type': 4, 'group_id': 2, 'exec_index': 3,
         'damage_info': {'caster_id': 401, 'target_id': 1, 'source_id': 200, 'restraint_type': 0, 'dam_type': 14},
         'sync_data': {'pet_sync_info': [{'pet_id': 1, 'hp_change': (1 << 64) - 100, 'hp_result': 0}]}},
        {'type': 7, 'group_id': 2, 'exec_index': 4,
         'dead_info': {'caster_id': 401, 'target_id': 1, 'dead_type': 0}},
    ]
    record = {'version': 1, 'id': 'rkpp:synthetic', 'rounds': 1,
              'quality': {'actions': False}, 'startedAt': '2020-01-01T00:00:00Z',
              'sides': {'me': {'pets': [{'instanceId': '1', 'level': 60}]},
                        'enemy': {'pets': [{'instanceId': '401', 'level': 60}]}},
              'events': [
                  {'id': 'hp-initial', 'round': 0, 'seq': 0, 'execIndex': 0, 'kind': 'resource', 'phase': 'executed', 'actor': '1', 'side': 'me', 'hpMax': 100, 'hpAfter': 100},
                  event(1, 'cast', 'skill', '1', 'me', skillId=187, protocolSkillId='100', skillClass='ordinary'),
                  event(2, 'cast', 'skill', '401', 'enemy', target='401', targetSide='enemy', skillId=339, protocolSkillId='200', skillClass='response'),
                  event(3, 'damage_info', 'damage', '401', 'enemy', target='1', targetSide='me', hpChange=-100, hpAfter=0, amount=999),
                  event(4, 'faint', 'effect', '1', 'me', label='倒下通知'),
              ]}
    catalog = {'schema_version': 2, 'skills': [skill(187, 'Physical Attack'), skill(339, 'Defense'), skill(492, 'Status')]}
    return record, entries, catalog, schema_fixture()


def write_source(path, record, entries, duplicate=False):
    def team(pid, role):
        return {'base': {'role_uin': role}, 'pets': [{'battle_inside_pet_info': {'pet_id': pid}, 'battle_common_pet_info': {'level': 60}}]}
    initial = {'battle_id': record['id'][5:], 'player_team': [team(1, 101)], 'enemy_team': [team(401, 202)]}
    batch = {'state_info': {'battle_id': record['id'][5:]}, 'perform_cmd': {'round': 1, 'seq_num': 1, 'perform_info': entries}}
    rows = [('0x1316', {'init_info': initial}), ('0x131a', batch)]
    if duplicate:
        rows.append(('0x131a', batch))
    rows.append(('0x132c', {'settle_info': {'battle_id': record['id'][5:], 'rounds': 1}}))
    with path.open('w', encoding='utf-8', newline='') as out:
        writer = csv.writer(out)
        writer.writerow(['opencode', 'content'])
        for code, value in rows:
            writer.writerow([code, json.dumps(value)])


class CombatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'source.csv'
        self.record, self.entries, self.catalog, self.schema = fixture()

    def run_enrich(self, duplicate=False):
        write_source(self.path, self.record, self.entries, duplicate)
        return stats.enrich(self.path, self.record, self.catalog, self.schema)

    def test_additive_source_counter_and_actual_hp(self):
        old = copy.deepcopy(self.record)
        result, audit = self.run_enrich()
        self.assertEqual(self.record, old)
        self.assertEqual(len(result['events']), len(old['events']))
        for a, b in zip(old['events'], result['events']):
            self.assertEqual(a, {k: v for k, v in b.items() if k != 'combat'})
        attack, response, damage, faint = result['events'][1:]
        self.assertTrue(attack['combat']['isAttack'])
        self.assertFalse(response['combat']['isAttack'])  # defense retaliation != attack action
        self.assertEqual(response['combat']['counteredActionId'], attack['id'])
        self.assertEqual(damage['combat']['actionId'], response['id'])
        self.assertEqual(damage['combat']['hpBefore'], 100)
        self.assertTrue(damage['combat']['fullHpBefore'])
        self.assertEqual(damage['combat']['effectivenessClass'], 'usual')
        self.assertNotIn('effectiveness', damage['combat'])
        self.assertEqual(damage['amount'], 999)
        self.assertEqual(damage['hpChange'], -100)
        self.assertEqual(faint['combat']['actionId'], response['id'])
        self.assertEqual(faint['combat']['leaveReason'], 'defeat')
        self.assertTrue(audit['qualityUnchanged'])
        self.assertFalse(result['quality']['actions'])

    def test_exact_source_id_not_adjacency(self):
        self.entries[2]['damage_info']['source_id'] = 999
        result, audit = self.run_enrich()
        self.assertNotIn('actionId', result['events'][3]['combat'])
        self.assertNotIn('actionId', result['events'][4]['combat'])
        self.assertEqual(audit['counts']['damage_action_unknown'], 1)

    def test_group_not_nearest_same_runtime(self):
        self.entries[2]['group_id'] = 7
        result, _ = self.run_enrich()
        self.assertNotIn('actionId', result['events'][3]['combat'])

    def test_missing_group_ref_not_adjacency(self):
        self.entries[1].pop('group_ref')
        result, _ = self.run_enrich()
        self.assertTrue(result['events'][2]['combat']['responseAttempt'])
        self.assertNotIn('counteredActionId', result['events'][2]['combat'])

    def test_unsigned_negative_restraint(self):
        self.entries[2]['damage_info']['restraint_type'] = (1 << 64) - 2
        result, audit = self.run_enrich()
        self.assertEqual(result['events'][3]['combat']['effectivenessClass'], 'resisted')
        self.assertEqual(audit['effectivenessEvidence'][0]['rawSignedTier'], -2)
        self.assertNotIn('effectiveness', result['events'][3]['combat'])

    def test_positive_restraint(self):
        self.entries[2]['damage_info']['restraint_type'] = 1
        result, _ = self.run_enrich()
        self.assertEqual(result['events'][3]['combat']['effectivenessClass'], 'advantage')

    def test_unknown_restraint_not_usual(self):
        self.entries[2]['damage_info']['restraint_type'] = 9
        result, _ = self.run_enrich()
        self.assertNotIn('effectivenessClass', result['events'][3]['combat'])

    def test_zero_hp_without_faint_is_not_kill(self):
        self.entries.pop()
        self.record['events'].pop()
        result, audit = self.run_enrich()
        self.assertNotIn('leaveReason', audit['counts'])
        self.assertEqual(result['events'][-1]['hpAfter'], 0)

    def test_missing_numeric_hp_never_estimated(self):
        self.entries[2].pop('sync_data')
        self.record['events'][3].pop('hpChange')
        self.record['events'][3].pop('hpAfter')
        result, _ = self.run_enrich()
        self.assertNotIn('hpBefore', result['events'][3]['combat'])
        self.assertNotIn('fullHpBefore', result['events'][3]['combat'])

    def test_non_full_numeric_hp_not_marked_full(self):
        self.record['events'][0]['hpMax'] = 110
        result, _ = self.run_enrich()
        self.assertNotIn('fullHpBefore', result['events'][3]['combat'])

    def test_exact_sync_conflict_rejected(self):
        self.record['events'][3]['hpChange'] = -99
        with self.assertRaisesRegex(ValueError, 'normalized HP'):
            self.run_enrich()

    def test_duplicate_primary_deduplicated(self):
        once, _ = self.run_enrich()
        repeated, audit = self.run_enrich(duplicate=True)
        self.assertEqual(once, repeated)
        self.assertEqual(audit['primaryDuplicateEntriesSkipped'], 4)

    def test_conflicting_existing_combat_rejected(self):
        self.record['events'][1]['combat'] = {'isAttack': False}
        with self.assertRaisesRegex(ValueError, 'combat fact conflicts'):
            self.run_enrich()

    def test_idempotent_existing_combat(self):
        self.record, _ = self.run_enrich()
        second, _ = self.run_enrich()
        self.assertEqual(second, self.record)

    def test_catalog_response_negation_not_substring(self):
        self.catalog['skills'][0]['description'] = '无法应对状态；不能被应对。'
        result, audit = self.run_enrich()
        self.assertNotIn('responseAttempt', result['events'][1]['combat'])
        self.assertEqual(audit['counts']['response_capability_unknown'], 1)

    def test_reviewed_nonresponse_explicit_false(self):
        self.record['events'][1]['skillId'] = 492
        result, _ = self.run_enrich()
        self.assertFalse(result['events'][1]['combat']['responseAttempt'])
        self.assertFalse(result['events'][1]['combat']['isAttack'])

    def test_interrupted_attempt_preserved_not_executed(self):
        self.record['events'][1]['phase'] = 'interrupted'
        self.entries[0]['skill_cast']['is_interupt'] = True
        result, _ = self.run_enrich()
        self.assertTrue(result['events'][1]['combat']['responseAttempt'])
        self.assertEqual(result['events'][1]['phase'], 'interrupted')
        self.assertEqual(result['events'][2]['combat']['counteredActionId'], result['events'][1]['id'])

    def test_switch_command_true_only_voluntary(self):
        # Both actors share the same synthetic side for this standalone switch test.
        for manual, reason in [(True, 'voluntary'), (False, 'unknown')]:
            record, entries, catalog, schema = fixture()
            record['sides']['me']['pets'].append({'instanceId': '2', 'level': 60})
            # Extend opening explicitly, not inferred from normalized array order.
            self.record, self.entries = record, entries
            write_source(self.path, record, entries)
            with self.path.open(encoding='utf-8') as stream:
                rows = list(csv.DictReader(stream))
            initial = json.loads(rows[0]['content'])
            initial['init_info']['player_team'][0]['pets'].append({'battle_inside_pet_info': {'pet_id': 2}, 'battle_common_pet_info': {'level': 60}})
            entries.append({'type': 13, 'group_id': 3, 'exec_index': 5, 'is_group_head': True, 'group_ref': 0, 'change_pet': {'rest_pet_id': 1, 'battle_pet_id': 2, 'is_cmd': manual, 'perform_type': 0}})
            record['events'].append(event(5, 'switch', 'switch', '2', 'me', target='1', targetSide='me'))
            rows[0]['content'] = json.dumps(initial)
            batch = json.loads(rows[1]['content']); batch['perform_cmd']['perform_info'] = entries
            rows[1]['content'] = json.dumps(batch)
            with self.path.open('w', encoding='utf-8', newline='') as out:
                w = csv.DictWriter(out, fieldnames=['opencode', 'content']); w.writeheader(); w.writerows(rows)
            result, _ = stats.enrich(self.path, record, catalog, schema)
            self.assertEqual(result['events'][-1]['combat']['leaveReason'], reason)
            self.assertNotIn('actionId', result['events'][-1]['combat'])

    def test_boundary_mismatch_rejected(self):
        write_source(self.path, self.record, self.entries)
        with self.assertRaisesRegex(ValueError, 'boundary mismatch'):
            stats.enrich(self.path, self.record, self.catalog, self.schema, (565, 6102))

    def test_schema_mismatch_rejected(self):
        self.schema['enums']['SkillPerformType']['values']['3'] = 'UNREVIEWED'
        with self.assertRaisesRegex(ValueError, 'unreviewed schema'):
            self.run_enrich()

    def test_audit_has_no_raw_identity_or_annotations(self):
        self.entries[0]['skill_cast'].update(caster_uin=987654, skill_name='wrong name', skill_priority=1000)
        result, audit = self.run_enrich()
        text = json.dumps(audit, ensure_ascii=False)
        self.assertNotIn('987654', text)
        self.assertNotIn('wrong name', text)
        self.assertNotIn('caster_uin', text)
        self.assertTrue(result['events'][1]['combat']['isAttack'])

    def test_cli_hash_mismatch_no_outputs(self):
        write_source(self.path, self.record, self.entries)
        args = ['--source', str(self.path), '--record', str(Path(self.temp.name) / 'r.json'),
                '--catalog', str(Path(self.temp.name) / 'c.json'), '--schema-db', str(Path(self.temp.name) / 's.sqlite'),
                '--output', str(Path(self.temp.name) / 'out.json'), '--report', str(Path(self.temp.name) / 'audit.json'),
                '--source-sha256', '0' * 64, '--record-sha256', '0' * 64, '--catalog-sha256', '0' * 64,
                '--schema-sha256', '0' * 64, '--battle-id', stats.BATTLE_ID, '--opening-line', '565', '--finish-line', '6102']
        with self.assertRaisesRegex(ValueError, 'source SHA-256 mismatch'):
            stats.main(args)
        self.assertFalse((Path(self.temp.name) / 'out.json').exists())


@unittest.skipUnless(os.environ.get('BATTLE_STATS_ACTUAL_INPUTS'), 'actual capture requires explicit opt-in input JSON')
class ActualCaptureTests(unittest.TestCase):
    def test_pinned_actual_capture_cli_in_temporary_directory(self):
        inputs = json.loads(os.environ['BATTLE_STATS_ACTUAL_INPUTS'])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = []
            for key in ['source', 'record', 'catalog', 'schema_db', 'source_sha256', 'record_sha256', 'catalog_sha256', 'schema_sha256']:
                args.extend(['--' + key.replace('_', '-'), inputs[key]])
            args += ['--output', str(root / 'candidate.json'), '--report', str(root / 'audit.json'),
                     '--battle-id', stats.BATTLE_ID, '--opening-line', '565', '--finish-line', '6102']
            self.assertEqual(stats.main(args), 0)
            before = json.loads(Path(inputs['record']).read_bytes())
            after = json.loads((root / 'candidate.json').read_bytes())
            audit = json.loads((root / 'audit.json').read_bytes())
            self.assertEqual(len(after['events']), 283)
            stripped = copy.deepcopy(after)
            for e in stripped['events']:
                e.pop('combat', None)
            self.assertEqual(stripped, before)
            self.assertFalse(after['quality']['actions'])
            self.assertEqual(audit['counts']['effectivenessClass'], 26)
            self.assertEqual(audit['counts']['hpBefore'], 26)
            self.assertEqual(audit['counts']['counteredActionId'], 10)
            self.assertEqual(audit['counts']['responseAttempt'], 42)
            self.assertEqual(audit['counts']['actionId'], 29)
            self.assertEqual(audit['counts']['leaveReason'], 13)
            self.assertEqual(sum(e.get('combat', {}).get('responseAttempt', False) for e in after['events']), 19)
            self.assertNotIn('effectiveness', {key for e in after['events'] for key in e.get('combat', {})})
            for key in ['source', 'record', 'catalog']:
                self.assertEqual(hashlib.sha256(Path(inputs[key]).read_bytes()).hexdigest(), inputs[key + '_sha256'])
            with self.assertRaisesRegex(ValueError, 'only new JSON'):
                stats.main(args)


if __name__ == '__main__':
    unittest.main()
