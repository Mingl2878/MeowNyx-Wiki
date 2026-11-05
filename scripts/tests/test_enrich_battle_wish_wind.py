"""Isolated synthetic tests; never access an actual profile, database or capture."""
import copy
import csv
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import enrich_battle_wish_wind as audit


def fixture():
    schema = {
        'messages': {name: {'fields': {number: {'name': pair[0], 'type': pair[1]}
                                       for number, pair in fields.items()}}
                     for name, fields in audit.SCHEMA_FIELDS.items()},
        'enums': {
            'BattlePerformType': {'values': {'1': 'BPT_SKILL_CAST', '4': 'BPT_DAMAGE',
                                             '13': 'BPT_CHANGE_PET', '24': 'BPT_CHANGE_MODEL',
                                             '29': 'BPT_ROLE_SKILL_CAST'}},
            'SkillDamType': {'values': {str(raw): values[0] for raw, values in audit.TYPE_CODES.items()}},
        },
    }
    catalog = {'schema_version': 2,
               'skills': [{'id': 351, 'name': '风隐', 'description': '敌方和自己均 脱离 ， 先手 -1。', 'category': 'Status'}],
               'types': [{'id': values[2], 'code': values[1]} for values in audit.TYPE_CODES.values()]}
    wind = {'id': audit.WIND_ID, 'round': 5, 'seq': 26, 'execIndex': 1, 'kind': 'skill',
            'phase': 'executed', 'side': 'me', 'actor': '3', 'target': '401', 'targetSide': 'enemy',
            'skillId': 351, 'protocolSkillId': '715027000', 'skillClass': 'ordinary',
            'combat': {'isAttack': False, 'responseAttempt': False}, 'label': '风隐'}
    events = [wind]
    entries = [((5, 26, 1), {'type': 1, 'group_id': 1, 'group_ref': 0, 'exec_index': 1,
                           'skill_cast': {'caster_id': 3, 'target_id': [401], 'skill_id': 715027000, 'type': 1}}, 944)]
    for eid, (point, side, incoming, outgoing, reason, group) in audit.SWITCHES.items():
        events.append({'id': eid, 'round': point[0], 'seq': point[1], 'execIndex': point[2],
                       'kind': 'switch', 'phase': 'executed', 'side': side, 'actor': incoming,
                       'target': outgoing, 'targetSide': side, 'combat': {'leaveReason': 'unknown'},
                       'label': '换场', 'text': 'unchanged'})
        entries.append((point, {'type': 13, 'group_id': group, 'group_ref': 0, 'exec_index': point[2],
                               'change_pet': {'rest_pet_id': int(outgoing), 'battle_pet_id': int(incoming),
                                              'is_cmd': False, 'perform_type': 0}}, 1062))
    events.extend([
        {'id': 'unchanged-hp', 'round': 5, 'seq': 26, 'execIndex': 2, 'kind': 'resource',
         'phase': 'executed', 'side': 'me', 'actor': '3', 'hpAfter': 223, 'hpMax': 458,
         'combat': {'hpBefore': 223}},
        {'id': 'other-unknown-switch', 'round': 9, 'seq': 51, 'execIndex': 1,
         'kind': 'switch', 'phase': 'executed', 'side': 'me', 'actor': '3', 'target': '6',
         'combat': {'leaveReason': 'unknown'}},
    ])
    record = {'version': 1, 'id': audit.BATTLE_ID, 'rounds': 36, 'quality': {'actions': False},
              'sides': {'me': {'pets': [{'instanceId': '3', 'monsterId': 501}, {'instanceId': '6', 'monsterId': 129}]},
                        'enemy': {'pets': [{'instanceId': '401', 'monsterId': 132}, {'instanceId': '402', 'monsterId': 264}]}},
              'events': events, 'issues': ['unchanged'], 'outcome': 'loss'}
    return record, catalog, schema, entries


class WindWishTests(unittest.TestCase):
    def setUp(self):
        self.record, self.catalog, self.schema, self.entries = fixture()

    def run_audit(self):
        return audit.enrich(self.record, self.catalog, self.schema, self.entries, True)

    def test_only_four_authorized_leaves_change(self):
        before = copy.deepcopy(self.record)
        result, report = self.run_audit()
        expected = copy.deepcopy(before)
        for e in expected['events']:
            if e['id'] in audit.SWITCHES:
                e['combat'].update(leaveReason=audit.SWITCHES[e['id']][4], actionId=audit.WIND_ID)
        self.assertEqual(result, expected)
        self.assertEqual(self.record, before)
        self.assertEqual(report['newEvents'], 0)
        self.assertEqual(report['windFacing']['facingAtCast'], '401')
        self.assertEqual(report['windFacing']['facingMonsterId'], 132)
        self.assertFalse(result['quality']['actions'])
        self.assertEqual(result['events'][-1]['combat'], {'leaveReason': 'unknown'})
        self.assertFalse(report['wish']['metadataWritten'])
        self.assertFalse(any('typeId' in e.get('combat', {}) or 'actionKind' in e.get('combat', {}) for e in result['events']))

    def test_same_repair_is_idempotent(self):
        result, _ = self.run_audit()
        again, _ = audit.enrich(result, self.catalog, self.schema, self.entries, True)
        self.assertEqual(result, again)

    def test_requires_user_authorization_not_adjacency(self):
        with self.assertRaisesRegex(ValueError, 'authorization'):
            audit.enrich(self.record, self.catalog, self.schema, self.entries)

    def test_other_battle_refused(self):
        self.record['id'] = 'rkpp:other'
        with self.assertRaisesRegex(ValueError, 'one exact battle'):
            self.run_audit()

    def test_known_reason_conflict_refused(self):
        self.record['events'][1]['combat']['leaveReason'] = 'voluntary'
        with self.assertRaisesRegex(ValueError, 'known leave reason conflict'):
            self.run_audit()

    def test_known_action_conflict_refused(self):
        self.record['events'][1]['combat']['actionId'] = 'some-other-cast'
        with self.assertRaisesRegex(ValueError, 'known source action conflict'):
            self.run_audit()

    def test_missing_unknown_is_not_silently_repaired(self):
        self.record['events'][1]['combat'].pop('leaveReason')
        with self.assertRaisesRegex(ValueError, 'known leave reason conflict'):
            self.run_audit()

    def test_outgoing_and_cast_target_must_match_exact_rows(self):
        self.record['events'][2]['target'] = '6'
        with self.assertRaisesRegex(ValueError, 'switch identity'):
            self.run_audit()
        self.record, _, _, _ = fixture()
        self.record['events'][0]['target'] = '402'
        with self.assertRaisesRegex(ValueError, 'wind cast'):
            self.run_audit()

    def test_raw_manual_switch_or_other_group_is_refused(self):
        self.entries[1][1]['change_pet']['is_cmd'] = True
        with self.assertRaisesRegex(ValueError, 'raw switch'):
            self.run_audit()
        self.entries[1][1]['change_pet']['is_cmd'] = False
        self.entries[1][1]['group_ref'] = 1
        with self.assertRaisesRegex(ValueError, 'raw switch'):
            self.run_audit()

    def test_new_unreviewed_cast_cannot_be_inserted(self):
        extra = copy.deepcopy(self.entries[0])
        self.entries.append(((6, 31, 1), extra[1], 1111))
        with self.assertRaisesRegex(ValueError, 'primary cast missing'):
            self.run_audit()

    def test_replacement_or_perform_flag_needs_new_audit(self):
        self.entries[0][1]['skill_cast']['real_perform_id'] = 123
        with self.assertRaisesRegex(ValueError, 'replacement/perform'):
            self.run_audit()

    def test_no_schema_or_local_type_guess(self):
        self.schema['enums']['SkillDamType']['values']['8'] = 'SDT_EARTH'
        with self.assertRaisesRegex(ValueError, 'damage type enum'):
            self.run_audit()
        self.assertNotIn(7, audit.TYPE_CODES)
        self.assertEqual(audit.TYPE_CODES[8][2], 6)

    def test_prewritten_wish_not_reinterpreted(self):
        self.record['events'][0]['combat']['actionKind'] = 'wishImpact'
        with self.assertRaisesRegex(ValueError, 'preexisting wish'):
            self.run_audit()

    def test_damage_segments_do_not_create_extra_casts(self):
        for index in (2, 3):
            point = (5, 26, index)
            eid = audit.event_id(point, 'damage_info')
            self.entries.append((point, {'type': 4, 'group_id': 1, 'exec_index': index,
                                        'damage_info': {'caster_id': 3, 'target_id': 401,
                                                        'source_id': 715027000, 'dam_type': 15}}, 944))
            self.record['events'].append({'id': eid, 'kind': 'damage', 'actor': '3', 'target': '401',
                                          'combat': {'actionId': audit.WIND_ID}, 'hpChange': -10})
        result, report = self.run_audit()
        self.assertEqual(report['coverage'], {'primaryCastCount': 1, 'linkedDamageCount': 2})
        self.assertEqual(len(result['events']), len(self.record['events']))
        self.entries[-1][1]['damage_info']['source_id'] = 999
        with self.assertRaisesRegex(ValueError, 'unique direct source cast'):
            self.run_audit()

    def test_role_magic_form_is_not_wish_impact(self):
        self.record['events'].append({'id': 'rkpp:identity-form:24:129:67:5',
                                      'kind': 'form', 'actor': '5'})
        self.entries += [
            ((24, 129, 1), {'type': 29, 'group_id': 1, 'exec_index': 1,
                           'role_skill_cast': {'pet_id': 5, 'skill_id': 7010070, 'is_call_success': False,
                                               'skill_name': '愿力强化'}}, 3756),
            ((24, 129, 67), {'type': 24, 'group_id': 1, 'exec_index': 67,
                            'change_model': {'pet_id': 5}}, 3756),
        ]
        result, report = self.run_audit()
        self.assertEqual(report['wish']['provenImpactCasts'], 0)
        self.assertEqual(len(report['wish']['roleCastsAreNotImpactEvidence']), 1)
        self.assertEqual(report['newEvents'], 0)
        self.assertEqual(len(result['events']), len(self.record['events']))

    def test_duplicate_or_changed_schema_refused(self):
        self.entries.append(self.entries[0])
        with self.assertRaisesRegex(ValueError, 'deduplicated'):
            self.run_audit()
        self.entries.pop()
        self.schema['messages']['BattleRoleSkillCast']['fields']['3']['type'] = 'string'
        with self.assertRaisesRegex(ValueError, 'schema field'):
            self.run_audit()


class FileSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_exact_sha_pin_refuses_new_source(self):
        path = self.root / 'input.json'
        path.write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
            audit.verified_bytes(path, audit.SOURCE_SHA256)
        self.assertEqual(audit.verified_bytes(path, hashlib.sha256(b'{}').hexdigest()), b'{}')

    def test_existing_output_never_overwritten(self):
        output = self.root / 'candidate.json'
        output.write_text('sentinel', encoding='utf-8')
        argv = ['audit', '--source', str(self.root/'source.csv'), '--record', str(self.root/'record.json'),
                '--catalog', str(self.root/'catalog.json'), '--schema-db', str(self.root/'schema.sqlite'),
                '--output', str(output), '--report', str(self.root/'report.json'),
                '--authorize-r5-wind-both-switches']
        with mock.patch.object(sys, 'argv', argv), self.assertRaisesRegex(ValueError, 'existing output'):
            audit.main()
        self.assertEqual(output.read_text(), 'sentinel')
        self.assertFalse((self.root/'report.json').exists())

    def test_boundaries_skip_undecodable_nonprimary_and_outside_payloads(self):
        source = self.root/'source.csv'
        _, _, _, entries = fixture()
        cmd = {'state_info': {'battle_id': audit.BATTLE_ID[5:]},
               'perform_cmd': {'round': 5, 'seq_num': 26, 'perform_info': [entries[0][1]]}}
        rows = [('0x0102', 'NOT JSON'), ('0x1316', json.dumps({'init_info': {'battle_id': audit.BATTLE_ID[5:]}})),
                ('0x0102', 'NOT JSON'), ('0x131a', json.dumps(cmd)), ('0x131a', json.dumps(cmd)),
                ('0x132c', json.dumps({'settle_info': {'battle_id': audit.BATTLE_ID[5:], 'rounds': 36}})),
                ('0x0102', 'NOT JSON')]
        with source.open('w', newline='', encoding='utf-8') as stream:
            writer = csv.writer(stream); writer.writerow(['opencode', 'content']); writer.writerows(rows)
        with mock.patch.object(audit, 'BOUNDARY', (3, 7)):
            found, duplicates = audit.bounded_entries(source, 36)
            self.assertEqual(len(found), 1)
            self.assertEqual(duplicates, 1)
            with self.assertRaisesRegex(ValueError, 'settlement rounds'):
                audit.bounded_entries(source, 35)


if __name__ == '__main__':
    unittest.main()
