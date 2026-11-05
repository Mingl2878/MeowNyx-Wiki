"""Explicit offline reconstruction from an audited RKPP capture.
No default paths, network, DB writes, personal data writes or automatic capture.
Runtime skill IDs require reviewed evidence, never division/name guesses.
"""
from pathlib import Path
import argparse,collections,copy,csv,hashlib,json,re

def digest(data):return hashlib.sha256(data).hexdigest()
def signed32(n):
 if type(n) is not int:raise ValueError('integer sync field required')
 if (1<<63)<=n<(1<<64):n-=1<<64
 if not -(1<<31)<=n<(1<<31):raise ValueError('non-int32 sync value')
 return n

def reconstruct(source,original,catalog,audit):
 if catalog['schema_version']!=2:raise ValueError('canonical v2 required')
 if not original['id'].startswith('rkpp:'):raise ValueError('explicit RKPP record required')
 battle_id=original['id'][5:];r=copy.deepcopy(original)
 skill_by_id={s['id']:s for s in catalog['skills']}
 bindings={str(m['raw_skill_id']):m for m in audit['mapping']}
 if len(bindings)!=len(audit['mapping']):raise ValueError('duplicate audited runtime binding')
 proven={'explicit_instance_to_config_pair','explicit_runtime_original_to_base_to_config'}
 for m in bindings.values():
  if m.get('local_skill_id') and m['proof_status'] in proven:
   assert skill_by_id[m['local_skill_id']]['name']==m['canonical_name'],'canonical identity changed'
 actors={p['instanceId']:side for side in ('me','enemy') for p in r['sides'][side]['pets']}
 assert len(actors)==sum(len(r['sides'][s]['pets']) for s in ('me','enemy')),'ambiguous instance side'
 ids={e['id']:e for e in r['events']};old_forms={}
 for e in r['events']:
  lifecycle={'1316':'enter','131a':'round_start','132c':'finish'}
  expected={'enter':'battle_enter','round_start':'round_start','finish':'battle_finish'}
  found=re.fullmatch(r'rkpp:(1316|131a|132c):(\d+)',e['id'])
  if found and e['kind']=='note' and e.get('text')=='Observed RKPP '+expected[lifecycle[found[1]]]+'; gameplay attribution unavailable.':e['lifecycle']=lifecycle[found[1]]
  if e.get('form'):
   e['execIndex']=e['form']['execIndex'];old_forms[(e['round'],e['seq'],e['execIndex'],e['actor'])]=e
 new={};seen_forms=set();counter=collections.Counter();early=[];round_counts=collections.Counter();active=False;starts=finishes=0
 def put(e):
  if e['id'] in new:
   if e!=new[e['id']]:raise ValueError('conflicting stable action key '+e['id'])
   counter['duplicate_action_keys']+=1;return
  if e['id'] in ids:
   if e!=ids[e['id']]:raise ValueError('conflicting already reconstructed action '+e['id'])
   return
  new[e['id']]=e;counter[e['kind']]+=1;round_counts[e['round']]+=1
 def actor(e,n,field='actor'):
  if n in (None,0):return
  s=str(n)
  if s not in actors:raise ValueError('action participant outside validated roster '+s)
  e[field]=s;e['side' if field=='actor' else 'targetSide']=actors[s]
 def event(c,x,branch):
  return {'id':f"rkpp:action:{c['round']}:{c['seq_num']}:{x['exec_index']}:{branch}",'round':c['round'],'seq':c['seq_num'],'execIndex':x['exec_index'],'kind':'note','phase':'executed','side':'unknown'}
 csv.field_size_limit(10_000_000)
 with source.open(encoding='utf-8-sig',newline='') as f:
  for row_number,row in enumerate(csv.DictReader(f),2):
   op=row['opencode'].upper()
   if op not in ('0X1316','0X131A','0X1324','0X132C'):continue
   msg=json.loads(row['content'])
   if op=='0X1316':
    if active:raise ValueError('overlapping battle opening')
    active=str(msg.get('init_info',{}).get('battle_id'))==battle_id
    if active:starts+=1
   if not active:continue
   if op=='0X132C':
    settle=msg['settle_info'];assert str(settle['battle_id'])==battle_id and settle['rounds']==r['rounds'];finishes+=1;active=False;continue
   if op not in ('0X131A','0X1324'):continue
   if op=='0X131A':assert str(msg['state_info']['battle_id'])==battle_id
   c=msg.get('perform_cmd')
   if not c:continue
   counter['primary_batches']+=1
   assert type(c.get('round')) is int and 1<=c['round']<=r['rounds'] and type(c.get('seq_num')) is int and 0<=c['seq_num']<=1_000_000_000
   for x in c.get('perform_info',[]):
    assert type(x.get('exec_index')) is int and 0<=x['exec_index']<=1_000_000_000
    typ=x.get('type');typ=typ.get('value') if isinstance(typ,dict) else typ
    numeric={}
    for p in x.get('sync_data',{}).get('pet_sync_info',[]):
     pid=str(p.get('pet_id',''))
     relevant={k:signed32(p[k]) for k in ('hp_change','hp_result','energy_change','energy_result','damage_result') if k in p}
     if not relevant:continue
     if pid not in actors:
      counter['unresolved_resource_fragments']+=1;continue
     bucket=numeric.setdefault(pid,{})
     for k,v in relevant.items():
      if k in bucket and bucket[k]!=v:raise ValueError('ambiguous same-entry sync field')
      bucket[k]=v
    def attach(e,pid,kind):
     values=numeric.get(str(pid),{})
     if kind=='damage' and 'damage_result' in values:
      assert values['damage_result']>=0;e['amount']=values['damage_result']
     if kind=='heal' and 'hp_change' in values:
      assert values['hp_change']>=0;e['amount']=values['hp_change']
     for src,dst in (('hp_change','hpChange'),('hp_result','hpAfter')):
      if src in values:e[dst]=values.pop(src)
     values.pop('damage_result',None)
    e=None
    if typ==1 and isinstance(x.get('skill_cast'),dict):
     b=x['skill_cast']
     if not b.get('skill_id') or not b.get('caster_id'):
      counter['unattributable_cast_fragments']+=1;continue
     raw=str(b['skill_id']);m=bindings.get(raw)
     if not m:raise ValueError('skill outside reviewed evidence '+raw)
     e=event(c,x,'cast');actor(e,b['caster_id']);e['protocolSkillId']=raw
     targets=list(dict.fromkeys(str(t) for t in b.get('target_id',[]) if t))
     if len(targets)==1:actor(e,int(targets[0]),'target')
     elif len(targets)>1:counter['multitarget_notifications']+=1
     classification=m['classification'];verified=m['proof_status'] in proven
     if classification=='passive_trait_not_canonical_skill':
      assert b['type']==2;e['kind']='effect';e['skillClass']='passive';e['label']='特性通知：'+(m['source_name'] if verified else '名称未确认')
     elif classification=='system_action_not_canonical_skill':
      e['kind']='effect';e['skillClass']='system';e['label']=m['source_name'] if verified else '系统行动（未确认）'
     else:
      e['kind']='skill';e['skillClass']='response' if classification=='response_variant' else 'ordinary'
      if verified:e['skillId']=m['local_skill_id']
      e['label']=m['source_name'] if verified else ('应对技能（来源候选：'+m.get('canonical_name','未知')+'，本地映射未确认）' if classification=='response_variant' else '技能对应未确认')
     if 'is_interupt' in b and type(b['is_interupt']) is not bool:raise ValueError('invalid interruption flag')
     if b.get('is_interupt'):
      assert e['kind']=='skill';e['phase']='interrupted';counter['interrupted']+=1
     e['text']='主执行通道的'+('中断通知，不计已执行施放。' if e['phase']=='interrupted' else '执行通知；不保证伤害命中或所有效果成功。')
     e['text']+=f" 技能实例 {raw}；核对状态 {m['proof_status']}；原始CSV逻辑行 {row_number}。"
     if verified:e['text']+=f" 配置ID {m['configuration_skill_id']}；配置校准版本 {audit['provenance']['revision']}。"
     if len(targets)>1:e['text']+=' 多目标实例 '+','.join(targets)+'；只记录一次通知。'
     if c['round']<=3:early.append({'round':c['round'],'label':e['label'],'phase':e['phase']})
     counter['cast_notifications']+=1
    elif typ in (4,5) and isinstance(x.get('damage_info' if typ==4 else 'heal_info'),dict):
     branch='damage_info' if typ==4 else 'heal_info';b=x[branch];e=event(c,x,branch);e['kind']='damage' if typ==4 else 'heal'
     actor(e,b.get('caster_id'));actor(e,b.get('target_id'),'target');attach(e,b.get('target_id'),e['kind'])
     e['text']=f"同一条执行消息、同一目标的数值同步；来源标识 {b.get('source_id',0)}（不直接当作技能ID）。CSV逻辑行 {row_number}。"
     if typ==4:e['text']+=' 报告伤害与实际生命变化分开保留，不推导隐藏配置。'
    elif typ==13 and isinstance(x.get('change_pet'),dict):
     b=x['change_pet'];e=event(c,x,'switch');e['kind']='switch';actor(e,b.get('battle_pet_id'));actor(e,b.get('rest_pet_id'),'target')
     assert e.get('side')==e.get('targetSide');e['label']='换场';e['text']='battle_pet_id 为进场实例，rest_pet_id 为退场实例；不据此推断首发。'
    elif typ==24 and isinstance(x.get('change_model'),dict):
     b=x['change_model'];key=(c['round'],c['seq_num'],x['exec_index'],str(b['pet_id']));assert key in old_forms,'identity form missing'
     f=old_forms[key]['form'];assert f['fromBaseId']==str(b['old_base_id']) and f['toBaseId']==str(b['pet_info']['battle_inside_pet_info']['base_conf_id']);seen_forms.add(key)
     if 'skill_cast' in x:counter['nonprimary_cast_fragments']+=1
    elif typ==7 and isinstance(x.get('dead_info'),dict):
     b=x['dead_info'];e=event(c,x,'faint');e['kind']='effect';actor(e,b.get('target_id'));e['label']='倒下通知';e['text']='明确 dead_info；不由动画或HP推测。'
    elif typ==37 and isinstance(x.get('supply_pet'),dict):
     b=x['supply_pet']
     for p in b.get('pet_infos',[]):
      pid=p.get('pet_id');inside=p.get('pet_info',{}).get('battle_inside_pet_info',{})
      assert pid==inside.get('pet_id') and p.get('pet_pos')==inside.get('pos')==1,'ambiguous supplied instance'
      if str(pid) not in actors:raise ValueError('unproven supplied instance')
      supplied=event(c,x,'supply:'+str(pid));supplied['kind']='effect';actor(supplied,pid);supplied['label']='补位通知';supplied['text']='同一既有实例的 supply_pet 通知；不增加初始队员。';put(supplied)
    else:counter['nonaction_or_unexpanded_primary_entries']+=1
    if e:put(e)
    # Resource sync is explicit observed state, not an extra skill cast/damage.
    for pid,v in numeric.items():
     fields={dst:v[src] for src,dst in (('hp_change','hpChange'),('hp_result','hpAfter'),('energy_change','energyChange'),('energy_result','energyAfter')) if src in v}
     if not fields:continue
     if all(v.get(k)==0 for k in ('hp_change','energy_change')) and 'hp_result' not in v and 'energy_result' not in v:continue
     state=event(c,x,'resource:'+pid);state.update(fields);state['kind']='resource';actor(state,int(pid));state['label']='生命 / 能量同步' if any(k.startswith('hp') for k in fields) else '能量同步';state['text']=f"同一执行消息的 pet_sync_info，字段按原始 int32 解码；不是额外施放或推测伤害。CSV逻辑行 {row_number}。";put(state)
 assert starts==finishes==1 and not active,'complete unique battle boundary required'
 assert set(old_forms)==seen_forms,'form evidence mismatch'
 r['events'].extend(new.values());r['quality']['actions']=False
 issue='已从主执行通道补入经核对的技能通知、中断、换场、伤害/治疗及生命能量同步；生命周期节点单独显示。被动/系统行动不计普通施放；预演与回放只作身份核对，不作额外行动。状态/效果未全量解释，行动完整性仍未知。'
 if issue not in r['issues']:r['issues'].append(issue)
 return r,{'counts':dict(counter),'roundsWithAddedEvents':sorted(round_counts),'addedEvents':len(new),'totalEvents':len(r['events']),'earlyActions':early,'strictSkillMapping':True,'allActionsComplete':False}

def main():
 p=argparse.ArgumentParser();p.add_argument('--source',required=True,type=Path);p.add_argument('--record',required=True,type=Path);p.add_argument('--catalog',required=True,type=Path);p.add_argument('--mapping-evidence',required=True,type=Path);p.add_argument('--mapping-sha256',required=True);p.add_argument('--output',required=True,type=Path);p.add_argument('--report',required=True,type=Path);a=p.parse_args()
 audit_bytes=a.mapping_evidence.read_bytes();assert digest(audit_bytes)==a.mapping_sha256,'unreviewed mapping report';audit=json.loads(audit_bytes)
 assert digest(a.source.read_bytes())==audit['provenance']['source_csv_sha256'];catalog_bytes=a.catalog.read_bytes();assert digest(catalog_bytes)==audit['provenance']['active_catalog_sha256']
 r,report=reconstruct(a.source,json.loads(a.record.read_bytes()),json.loads(catalog_bytes),audit)
 for dest in (a.output,a.report):
  if dest.exists():raise ValueError('refuse overwriting prior output: '+str(dest))
 a.output.write_text(json.dumps({'version':1,'records':[r]},ensure_ascii=False,indent=2),encoding='utf-8');a.report.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
