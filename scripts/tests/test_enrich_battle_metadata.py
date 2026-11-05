"""Isolated synthetic tests; real source reads require RKPP_METADATA_REAL_OPTIN=1."""
import copy
import csv
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
import enrich_battle_metadata as m


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.csv'
        self.own_role, self.enemy_role = 99330001, 99330002
        own1 = self.pet(1, True)
        own2 = self.pet(2, True)
        own2['battle_inside_pet_info']['pos'] = 1
        enemy = self.pet(401, False)
        enemy['battle_inside_pet_info']['pos'] = 1
        self.initial = {'battle_id': 'test',
                        'player_team': [{'base': {'role_uin': self.own_role, 'side': 1}, 'pets': [own1, own2]}],
                        'enemy_team': [{'base': {'role_uin': self.enemy_role, 'side': 0}, 'pets': [enemy]}],
                        'others': []}
        self.packet = {'settle_info': {'battle_id': 'test', 'rounds': 1, 'result': 12,
                                      'side': 1, 'seconds': 613, 'enter_battle_time': 1793250622,
                                      'monster_info': [{'pet_id': 401, 'uin': self.enemy_role, 'side': 0},
                                                       {'pet_id': 2, 'uin': self.own_role, 'side': 1},
                                                       {'pet_id': 1, 'uin': self.own_role, 'side': 1}],
                                      'pvp_mode': {'match_infos': [
                                          {'uin': self.enemy_role, 'pvp_rank_master_score': 1277,
                                           'pvp_rank_order': 20053, 'pvp_rank_star': 135},
                                          {'uin': self.own_role, 'pvp_rank_master_score': 1389,
                                           'pvp_rank_order': 15904, 'pvp_rank_star': 142}]}},
                       'pvp_rank_settle_info': {'old_pvp_rank_master_score': 1389,
                                                'new_pvp_rank_master_score': 1349,
                                                'old_pvp_rank_order': 15904, 'new_pvp_rank_order': 17215,
                                                'old_pvp_rank_star': 142, 'new_pvp_rank_star': 141}}
        self.record = {'version': 1, 'id': 'rkpp:test', 'mode': 'pvp', 'rounds': 1,
                       'outcome': 'unknown', 'importedAt': '2026-10-29T05:26:58.680494Z',
                       'quality': {'roster': {'me': True, 'enemy': True}, 'actions': False,
                                   'lead': {'me': False, 'enemy': False}},
                       'sides': {'me': {'pets': [self.normalized(1), self.normalized(2)], 'before': {}, 'after': {}},
                                 'enemy': {'pets': [self.normalized(401)], 'before': {}, 'after': {}}},
                       'events': [], 'issues': ['Original issue retained.']}
        self.primary = []
        self.catalog = {'schema_version': 2, 'monsters': [{'id': 1}, {'id': 2}, {'id': 401}]}

    @staticmethod
    def normalized(pid):
        return {'instanceId': str(pid), 'monsterId': pid, 'protocolId': str(5000 + pid),
                'protocolBaseId': str(6000 + pid), 'level': 60}

    @staticmethod
    def pet(pid, own):
        battle = [0] * 97
        battle[1:7] = [374, 111, 242, 161, 184, 260] if own else [490, 0, 0, 0, 0, 0]
        battle[25] = battle[1]
        battle[80], battle[84] = (2**64 - 1000, 2000) if own else (0, 0)
        common = {'level': 60}
        if own:
            triples = {'hp': (60, 274, 100), 'attack': (0, 68, 50),
                       'special_attack': (60, 192, 50), 'defense': (0, 111, 50),
                       'special_defense': (0, 134, 50), 'speed': (60, 175, 50)}
            common.update(nature=25, changed_nature_pos_attr_type=0,
                          changed_nature_neg_attr_type=2,
                          attribute_info={k: {'talent': a, 'base_value': b, 'effort_add': c}
                                          for k, (a, b, c) in triples.items()})
        return {'battle_common_pet_info': common,
                'battle_inside_pet_info': {'pet_id': pid, 'conf_id': 5000 + pid,
                                           'base_conf_id': 6000 + pid, 'pos': 2**64-1,
                                           'battle_attr': battle, 'speed_min': 178 if own else 144,
                                           'speed_max': 260 if own else 214}}

    def write_source(self, extra_before=None, extra_after=None):
        rows = (extra_before or []) + [('0x1316', {'init_info': self.initial})]
        rows += [('0x131A', {'state_info': {'battle_id': 'test'}, 'perform_cmd': p}) for p in self.primary]
        rows += [('0x132C', self.packet)] + (extra_after or [])
        with self.source.open('w', encoding='utf-8', newline='') as stream:
            writer = csv.DictWriter(stream, fieldnames=['opencode', 'content'])
            writer.writeheader()
            for op, content in rows:
                writer.writerow({'opencode': op, 'content': json.dumps(content)})
        return m.digest(self.source)

    def run_enrich(self, **kwargs):
        expected = self.write_source()
        return m.enrich(self.source, self.record, expected_sha256=expected,
                        catalog=self.catalog, **kwargs)

    def test_direct_metadata_and_all_core_invariants(self):
        original = copy.deepcopy(self.record)
        result, audit = self.run_enrich()
        self.assertEqual(self.record, original)
        self.assertEqual(result['events'], original['events'])
        self.assertEqual(result['issues'], original['issues'])
        self.assertEqual(result['importedAt'], original['importedAt'])
        self.assertNotIn('endedAt', result)
        self.assertFalse(result['quality']['actions'])
        self.assertEqual(result['startedAt'], '2026-10-29T05:10:22Z')
        self.assertEqual(result['durationSeconds'], 613)
        self.assertEqual(result['outcome'], 'loss')
        self.assertEqual(result['sides']['me']['lead'], '2')
        self.assertEqual(result['sides']['enemy']['lead'], '401')
        own = result['sides']['me']['pets'][0]
        self.assertEqual(own['iv']['speed']['value'], 60)
        self.assertEqual(own['nature']['speed']['value'], 1)
        self.assertEqual(own['nature']['attack']['value'], 2)
        self.assertEqual(own['nature']['hp']['value'], 0)
        self.assertEqual(own['nature']['speed']['certainty'], 'direct')
        self.assertEqual(own['speed'], 260)
        enemy = result['sides']['enemy']['pets'][0]
        self.assertNotIn('iv', enemy)
        self.assertNotIn('nature', enemy)
        self.assertNotIn('speed', enemy)
        self.assertEqual((enemy['speedMin'], enemy['speedMax']), (144, 214))
        self.assertTrue(audit['eventsUnchanged'])
        self.assertEqual(audit['speedAudit']['eligibleSpeedConstraints'], 0)
        self.assertNotIn('constraints', result)
        self.assertNotIn('speedObservations', result)
        serialized = json.dumps([result, audit])
        self.assertNotIn(str(self.own_role), serialized)
        self.assertNotIn(str(self.enemy_role), serialized)
        self.assertNotIn('role_uin', serialized)

    def test_exact_talent_not_boolean_or_divided_by_six(self):
        self.initial['player_team'][0]['pets'][0]['battle_common_pet_info']['attribute_info']['hp']['talent'] = 54
        result, _ = self.run_enrich()
        self.assertEqual(result['sides']['me']['pets'][0]['iv']['hp']['value'], 54)

    def test_invalid_talents_are_rejected(self):
        common = self.initial['player_team'][0]['pets'][0]['battle_common_pet_info']
        for value in (-1, 61, True, None, 60.0, '60'):
            with self.subTest(value=value):
                common['attribute_info']['speed']['talent'] = value
                with self.assertRaises(ValueError):
                    self.run_enrich()

    def test_unsupported_nature_not_guessed_from_actual_stats(self):
        common = self.initial['player_team'][0]['pets'][0]['battle_common_pet_info']
        for value in (0, 31, 999):
            common['nature'] = value
            result, _ = self.run_enrich()
            self.assertNotIn('nature', result['sides']['me']['pets'][0])
            self.assertIn('iv', result['sides']['me']['pets'][0])

    def test_nature_mismatched_modifier_or_actual_stat_stays_unknown(self):
        battle = self.initial['player_team'][0]['pets'][0]['battle_inside_pet_info']['battle_attr']
        battle[84] = 0
        result, _ = self.run_enrich()
        self.assertNotIn('nature', result['sides']['me']['pets'][0])
        battle[84], battle[6] = 2000, 261
        result, _ = self.run_enrich()
        self.assertNotIn('nature', result['sides']['me']['pets'][0])

    def test_changed_nature_override_validated_all_stats(self):
        p = self.initial['player_team'][0]['pets'][0]
        common, inside = p['battle_common_pet_info'], p['battle_inside_pet_info']
        common['nature'] = 26
        common['changed_nature_neg_attr_type'] = 6
        inside['battle_attr'][1:7] = [429, 118, 242, 161, 184, 208]
        inside['battle_attr'][79:85] = [2000, 0, 0, 0, 0, 2**64-1000]
        result, _ = self.run_enrich()
        nature = result['sides']['me']['pets'][0]['nature']
        self.assertEqual(nature['hp']['value'], 1)
        self.assertEqual(nature['speed']['value'], 2)
        self.assertEqual(nature['attack']['value'], 0)

    def test_conflicting_existing_direct_evidence_rejected(self):
        self.record['sides']['me']['pets'][0]['iv'] = {'speed': {'certainty': 'direct', 'value': 0}}
        with self.assertRaisesRegex(ValueError, 'evidence conflicts'):
            self.run_enrich()

    def test_repeated_enrichment_is_idempotent(self):
        result, _ = self.run_enrich()
        again, _ = m.enrich(self.source, result, expected_sha256=m.digest(self.source))
        self.assertEqual(result, again)

    def test_rank_old_new_timing_and_enemy_unphased(self):
        result, _ = self.run_enrich()
        own, enemy = result['sides']['me'], result['sides']['enemy']
        self.assertEqual(own['before'], {'score': 1389, 'rank': 15904, 'stars': 142})
        self.assertEqual(own['after'], {'score': 1349, 'rank': 17215, 'stars': 141})
        self.assertNotIn('matching', own)
        self.assertEqual(enemy['before'], {})
        self.assertEqual(enemy['after'], {})
        self.assertEqual(enemy['matching'], {'score': 1277, 'rank': 20053, 'stars': 135})
        self.assertNotIn('tier', own['before'])

    def test_settlement_container_does_not_imply_rank_after(self):
        self.packet.pop('pvp_rank_settle_info')
        result, _ = self.run_enrich()
        for side in ('me', 'enemy'):
            self.assertEqual(result['sides'][side]['before'], {})
            self.assertEqual(result['sides'][side]['after'], {})
            self.assertIn('matching', result['sides'][side])

    def test_rank_subject_requires_unique_full_matching_tuple(self):
        infos = self.packet['settle_info']['pvp_mode']['match_infos']
        for key in ('pvp_rank_master_score', 'pvp_rank_order', 'pvp_rank_star'):
            infos[0][key] = infos[1][key]
        with self.assertRaisesRegex(ValueError, 'uniquely joined'):
            self.run_enrich()

    def test_unknown_role_never_uses_array_position(self):
        infos = self.packet['settle_info']['pvp_mode']['match_infos']
        infos[1]['uin'] = 12345678
        with self.assertRaisesRegex(ValueError, 'uniquely joined'):
            self.run_enrich()

    def test_outcome_follows_explicit_subject_not_side_zero(self):
        self.packet['settle_info']['side'] = 0
        result, _ = self.run_enrich()
        self.assertEqual(result['outcome'], 'win')
        self.packet['settle_info']['side'] = 1
        self.packet['settle_info']['result'] = 4
        result, _ = self.run_enrich()
        self.assertEqual(result['outcome'], 'loss')

    def test_settlement_enum_and_side_reject_boolean_or_text(self):
        for field, value in (('side', True), ('side', '1'), ('result', True), ('result', '12')):
            with self.subTest(field=field, value=value):
                old = self.packet['settle_info'][field]
                self.packet['settle_info'][field] = value
                with self.assertRaises(ValueError):
                    self.run_enrich()
                self.packet['settle_info'][field] = old

    def test_outcome_missing_identity_remains_unknown(self):
        self.packet['settle_info']['monster_info'] = []
        result, _ = self.run_enrich()
        self.assertEqual(result['outcome'], 'unknown')

    def test_outcome_conflicting_actor_role_rejected(self):
        self.packet['settle_info']['monster_info'][0]['uin'] = self.own_role
        with self.assertRaisesRegex(ValueError, 'ownership mismatch'):
            self.run_enrich()

    def test_duplicate_lead_rejected_and_missing_lead_not_filled(self):
        pets = self.initial['player_team'][0]['pets']
        pets[0]['battle_inside_pet_info']['pos'] = 1
        with self.assertRaisesRegex(ValueError, 'ambiguous explicit opening lead'):
            self.run_enrich()
        for p in pets:
            p['battle_inside_pet_info']['pos'] = 2**64-1
        result, _ = self.run_enrich()
        self.assertNotIn('lead', result['sides']['me'])
        self.assertFalse(result['quality']['lead']['me'])

    def test_other_team_requires_explicit_role_join(self):
        enemy = self.initial['enemy_team'][0]['pets'].pop()
        self.initial['others'] = [{'role_uin': self.enemy_role, 'pets': [enemy]}]
        result, _ = self.run_enrich()
        self.assertEqual(result['sides']['enemy']['lead'], '401')
        self.initial['others'][0]['role_uin'] = self.own_role
        with self.assertRaisesRegex(ValueError, 'side/identity conflict'):
            self.run_enrich()

    def test_duplicate_opening_actor_must_be_identical(self):
        enemy = self.initial['enemy_team'][0]['pets'][0]
        self.initial['others'] = [{'role_uin': self.enemy_role, 'pets': [copy.deepcopy(enemy)]}]
        self.run_enrich()
        self.initial['others'][0]['pets'][0]['battle_inside_pet_info']['speed_max'] = 999
        with self.assertRaisesRegex(ValueError, 'identity conflict'):
            self.run_enrich()

    def test_duration_zero_is_known_and_no_end_timestamp_synthesized(self):
        self.packet['settle_info']['seconds'] = 0
        result, _ = self.run_enrich()
        self.assertEqual(result['durationSeconds'], 0)
        self.assertNotIn('endedAt', result)
        self.packet['settle_info']['seconds'] = -1
        with self.assertRaises(ValueError):
            self.run_enrich()

    def test_existing_times_preserved_and_conflicts_rejected(self):
        self.record['startedAt'] = '2026-10-29T13:10:22+08:00'
        self.record['endedAt'] = '2026-10-29T13:20:35+08:00'
        result, _ = self.run_enrich()
        self.assertEqual(result['startedAt'], self.record['startedAt'])
        self.assertEqual(result['endedAt'], self.record['endedAt'])
        self.record['startedAt'] = '2026-10-29T13:10:23+08:00'
        with self.assertRaisesRegex(ValueError, 'timestamp conflicts'):
            self.run_enrich()

    def test_identity_and_catalog_conflict_rejected(self):
        self.record['sides']['me']['pets'][0]['protocolBaseId'] = '1'
        with self.assertRaisesRegex(ValueError, 'protocol identity conflict'):
            self.run_enrich()
        self.record['sides']['me']['pets'][0]['protocolBaseId'] = '6001'
        self.catalog['monsters'] = []
        with self.assertRaisesRegex(ValueError, 'absent from current catalog'):
            self.run_enrich()

    def test_static_priority_never_generates_speed_constraint(self):
        for seq, actor, side in ((1, 1, 'me'), (2, 401, 'enemy')):
            cast = {'caster_id': actor, 'skill_id': 700001, 'skill_priority': 5}
            self.primary.append({'round': 1, 'seq_num': seq, 'perform_info': [
                {'exec_index': 1, 'type': 1, 'skill_cast': cast}]})
            self.record['events'].append({'id': f'rkpp:action:1:{seq}:1:cast', 'round': 1,
                                          'seq': seq, 'execIndex': 1, 'kind': 'skill',
                                          'phase': 'executed', 'skillClass': 'ordinary',
                                          'side': side, 'actor': str(actor), 'protocolSkillId': '700001'})
        result, audit = self.run_enrich()
        self.assertEqual(result['events'], self.record['events'])
        self.assertNotIn('speedObservations', result)
        self.assertEqual(audit['speedAudit']['rejectedOrdinaryOpposingPairs'], 1)
        self.assertEqual(audit['speedAudit']['eligibleSpeedConstraints'], 0)
        self.assertEqual(audit['speedAudit']['fieldOccurrences']['priority'], 0)
        self.record['events'][1]['skillClass'] = 'response'
        _, audit = self.run_enrich()
        self.assertEqual(audit['speedAudit']['rejectedOrdinaryOpposingPairs'], 0)
        self.assertEqual(audit['speedAudit']['excludedNonOrdinary']['response:executed'], 1)

    def test_source_sha_and_logical_boundaries_required(self):
        expected = self.write_source()
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
            m.enrich(self.source, self.record, expected_sha256='0' * 64)
        with self.assertRaisesRegex(ValueError, 'logical boundary mismatch'):
            m.enrich(self.source, self.record, expected_sha256=expected, opening_line=3)

    def test_target_reopen_and_mismatched_finish_rejected(self):
        expected = self.write_source(extra_after=[('0x1316', {'init_info': self.initial})])
        with self.assertRaisesRegex(ValueError, 'repeated target opening'):
            m.enrich(self.source, self.record, expected_sha256=expected)
        self.packet['settle_info']['battle_id'] = 'other'
        with self.assertRaisesRegex(ValueError, 'mismatched settlement'):
            self.run_enrich()

    def test_outside_other_battle_metadata_not_used(self):
        other = copy.deepcopy(self.packet)
        other['settle_info']['battle_id'] = 'unrelated'
        other['settle_info']['seconds'] = 999
        expected = self.write_source(extra_before=[('0x132C', other)], extra_after=[('0x132C', other)])
        result, _ = m.enrich(self.source, self.record, expected_sha256=expected)
        self.assertEqual(result['durationSeconds'], 613)

    def test_unreviewed_nature_config_and_duplicate_json_rejected(self):
        path = self.root / 'nature.json'
        path.write_text('[]', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'unreviewed nature'):
            m.load_nature_config(path, m.digest(path))
        with self.assertRaisesRegex(ValueError, 'duplicate JSON key'):
            m.strict_json('{"a":1,"a":2}')
        with self.assertRaises(ValueError):
            m.strict_json('{"a":NaN}')

    def test_cli_refuses_overwriting_existing_output(self):
        output = self.root / 'candidate.json'
        output.write_text('do not overwrite', encoding='utf-8')
        args = ['--source', str(self.source), '--record', str(self.root / 'record.json'),
                '--nature-config', str(self.root / 'nature.json'), '--source-sha256', '0' * 64,
                '--nature-sha256', m.NATURE_SHA256, '--output', str(output),
                '--report', str(self.root / 'audit.json')]
        with self.assertRaisesRegex(ValueError, 'refusing overwrite'):
            m.main(args)
        self.assertEqual(output.read_text(), 'do not overwrite')


@unittest.skipUnless(os.environ.get('RKPP_METADATA_REAL_OPTIN') == '1',
                     'explicit opt-in required for read-only real source audit')
class RealMetadataTests(unittest.TestCase):
    def test_exact_approved_battle_read_only(self):
        source = Path('D:/HabilynX/Roco-Kingdom-Protocol-Parser/runs/20261029-130832-6564/opencode_summary.csv')
        backup = Path('D:/echoagent/old/MeowNyx Wiki-backups/battle-complete-20261101-162918')
        record_path, catalog_path = backup / 'record-before.json', backup / 'active-catalog.json'
        before = {str(p): m.digest(p) for p in (source, record_path, catalog_path)}
        original = m.strict_json(record_path.read_bytes())
        result, audit = m.enrich(source, original, expected_sha256=m.SOURCE_SHA256,
                                 opening_line=565, finish_line=6102,
                                 catalog=m.strict_json(catalog_path.read_bytes()))
        self.assertEqual(len(result['events']), 283)
        self.assertEqual(result['events'], original['events'])
        self.assertEqual(result['outcome'], 'loss')
        self.assertEqual(result['durationSeconds'], 613)
        self.assertEqual(result['startedAt'], '2026-10-29T05:10:22Z')
        self.assertEqual(result['sides']['me']['lead'], '3')
        self.assertEqual(result['sides']['enemy']['lead'], '401')
        own = result['sides']['me']['pets']
        self.assertEqual(len(own), 6)
        self.assertTrue(all(len(p['iv']) == len(p['nature']) == 6 for p in own))
        self.assertEqual(own[0]['speed'], 260)
        self.assertEqual(own[0]['iv']['speed']['value'], 60)
        self.assertEqual(own[0]['nature']['speed']['value'], 1)
        self.assertEqual(own[3]['iv']['hp']['value'], 54)
        self.assertEqual(result['sides']['me']['before']['score'], 1389)
        self.assertEqual(result['sides']['me']['after']['score'], 1349)
        self.assertEqual(result['sides']['enemy']['matching']['stars'], 135)
        self.assertTrue(all('speed' not in p and 'iv' not in p and 'nature' not in p
                            for p in result['sides']['enemy']['pets']))
        self.assertEqual(audit['speedAudit']['eligibleSpeedConstraints'], 0)
        self.assertEqual(audit['speedAudit']['fieldOccurrences']['skill_buff'], 0)
        self.assertEqual(before, {str(p): m.digest(p) for p in (source, record_path, catalog_path)})


if __name__ == '__main__':
    unittest.main()
