import copy,csv,importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('actions',Path(__file__).parents[1]/'reconstruct_battle_actions.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ActionReconstructionTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.source=Path(self.temp.name)/'capture.csv'
  self.record={'version':1,'id':'rkpp:test','rounds':1,'mode':'unknown','outcome':'unknown','quality':{'actions':False,'roster':{'me':False,'enemy':False},'lead':{'me':False,'enemy':False}},'sides':{'me':{'pets':[{'instanceId':'1','monsterId':1}]},'enemy':{'pets':[{'instanceId':'2','monsterId':2}]}},'events':[],'issues':[]}
  self.catalog={'schema_version':2,'skills':[{'id':7,'name':'测试技能'}]}
  self.audit={'provenance':{'revision':'audited-test'},'mapping':[{'raw_skill_id':123456701,'configuration_skill_id':98765,'source_name':'测试技能','canonical_name':'测试技能','local_skill_id':7,'classification':'normal_skill','proof_status':'explicit_instance_to_config_pair'}]}
  self.cast={'type':1,'exec_index':1,'skill_cast':{'caster_id':1,'target_id':[2],'skill_id':123456701,'type':1}}
 def write(self,entries,preview=None):
  rows=[('0x1316',{'init_info':{'battle_id':'test'}})]
  if preview:rows.append(('0x13F3',{'perform_cmd':{'round':1,'seq_num':2,'perform_info':preview}}))
  rows += [('0x131A',{'state_info':{'battle_id':'test'},'perform_cmd':{'round':1,'seq_num':3,'perform_info':entries}}),('0x132C',{'settle_info':{'battle_id':'test','rounds':1}})]
  with self.source.open('w',encoding='utf-8',newline='') as f:
   out=csv.writer(f);out.writerow(['opencode','meaning','content']);out.writerows((op,'',json.dumps(data)) for op,data in rows)
 def result(self,record=None):return m.reconstruct(self.source,record or self.record,self.catalog,self.audit)
 def test_exact_signed_varint_not_float_or_uint32_guess(self):
  self.assertEqual(m.signed32(2**64-115),-115);self.assertEqual(m.signed32(0),0)
  for x in [2**32-115,2**64,2**31,True,1.0,'12']:
   with self.assertRaises(ValueError):m.signed32(x)
 def test_runtime_identity_is_not_arithmetic_and_previews_not_actions(self):
  self.write([self.cast],preview=[self.cast]);r,report=self.result();self.assertEqual(len(r['events']),1);self.assertEqual(r['events'][0]['skillId'],7);self.assertEqual(report['counts']['primary_batches'],1)
 def test_explicit_interruption_does_not_become_execution(self):
  cast=copy.deepcopy(self.cast);cast['skill_cast']['is_interupt']=True;self.write([cast]);r,_=self.result();self.assertEqual(r['events'][0]['phase'],'interrupted')
 def test_damage_report_is_distinct_from_hp_loss_and_source_is_not_skill(self):
  damage={'type':4,'exec_index':2,'damage_info':{'caster_id':1,'target_id':2,'source_id':123456701},'sync_data':{'pet_sync_info':[{'pet_id':2,'damage_result':642},{'pet_id':2,'hp_change':2**64-340,'hp_result':0}]}}
  self.write([damage]);r,_=self.result();e=r['events'][0];self.assertEqual((e['amount'],e['hpChange'],e['hpAfter']),(642,-340,0));self.assertNotIn('skillId',e);self.assertNotIn('protocolSkillId',e)
 def test_resources_not_extra_casts_and_unknowns_not_zero(self):
  cast=copy.deepcopy(self.cast);cast['sync_data']={'pet_sync_info':[{'pet_id':1,'energy_change':2**64-2,'energy_result':0}]};self.write([cast]);r,_=self.result();self.assertEqual([e['kind'] for e in r['events']],['skill','resource']);self.assertEqual(r['events'][1]['energyChange'],-2);self.assertEqual(r['events'][1]['energyAfter'],0);self.assertNotIn('amount',r['events'][0])
 def test_idempotence_and_conflicting_same_execution_key(self):
  self.write([self.cast,self.cast]);r,report=self.result();self.assertEqual(len(r['events']),1);self.assertEqual(report['counts']['duplicate_action_keys'],1);second,report2=self.result(r);self.assertEqual(r,second);self.assertEqual(report2['addedEvents'],0)
  changed=copy.deepcopy(self.cast);changed['skill_cast']['target_id']=[1];self.write([self.cast,changed])
  with self.assertRaises(ValueError):self.result()
 def test_ambiguous_mapping_and_outside_roster_refuse(self):
  self.write([self.cast]);self.audit['mapping'].append(copy.deepcopy(self.audit['mapping'][0]))
  with self.assertRaises(ValueError):self.result()
  self.audit['mapping'].pop();bad=copy.deepcopy(self.cast);bad['skill_cast']['caster_id']=3;self.write([bad])
  with self.assertRaises(ValueError):self.result()
 def test_source_family_candidate_never_becomes_canonical_fact(self):
  self.audit['mapping'][0].update(classification='response_variant',proof_status='source_reviewed_family_only_no_runtime_original_link');self.write([self.cast]);r,_=self.result();self.assertNotIn('skillId',r['events'][0]);self.assertIn('未确认',r['events'][0]['label'])

if __name__=='__main__':unittest.main()
