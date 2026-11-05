const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/catalog.json'),'utf8'));
const byId=new Map(catalog.monsters.map(m=>[m.id,m]));
const family=require('../js/petdex-family.js');
const projection=require('../js/catalog-data.js').toLegacy(catalog);
const pinned=require('./catalog-pinned-baseline.cjs');
const {mingulongSkills,abuSkills}=require('./catalog-s5-expectations.cjs');

test('pinned client calibration preserves official identities without claiming later local additions',()=>{
 const evidence=catalog.extensions.mieli_calibration;
 assert.equal(evidence.version,1);
 assert.equal(evidence.revision,'727614cc195299cce6b3398c2dd82e23e4db9318');
 // Historical evidence covers only its original pinned ID set, not later S5
 // additions or graduation. Every original row is separately fingerprinted below.
 const real=catalog.monsters.filter(m=>pinned.calibratedMonsterIds.includes(m.id));
 assert.deepEqual(real.map(m=>m.id),pinned.calibratedMonsterIds);
 for(const m of real)assert.equal(m.source_ref.provider,'tencent-compendium');
 assert.deepEqual(evidence.mapping.map(m=>m.local_id).sort((a,b)=>a-b),real.map(m=>m.id).sort((a,b)=>a-b));
 assert.equal(evidence.mapping.length,real.length);
 assert.equal(new Set(evidence.mapping.map(m=>m.local_id)).size,real.length);
 assert.equal(new Set(evidence.mapping.map(m=>m.client_id)).size,real.length);
 for(const row of evidence.mapping)assert.ok(byId.has(row.local_id));
 assert.equal(evidence.counts.skills_checked,pinned.legacySkillIds.length);
 assert.equal(pinned.fingerprint(evidence),pinned.hashes.mieli_calibration,'historical calibration evidence must not be rewritten for S5');
 assert.equal(evidence.counts.learnsets_checked,real.length);
 for(const field of ['stats','type_ids','trait_id','evolution_stage'])assert.equal(evidence.counts['monster_'+field+'_changed']||0,0);
 assert.equal(evidence.counts.learnset_effective_skills_changed||0,0);
 assert.ok(!evidence.mapping.some(row=>row.local_id===619||row.local_id===623));
});

test('all original calibrated rows, traits, skills and learning metadata survive authorized S5 additions',()=>{
 assert.equal(pinned.fingerprint(pinned.originalMonsterView(catalog.monsters)),pinned.hashes.monsters,'original identities, stats, relationships, notes and unauthorized image roles changed');
 const oldSkills=catalog.skills.filter(s=>pinned.legacySkillIds.includes(s.id));
 assert.deepEqual(oldSkills.map(s=>s.id),pinned.legacySkillIds);
 assert.equal(pinned.fingerprint(oldSkills),pinned.hashes.skills,'any original skill semantic/raw field changed');
 assert.equal(pinned.fingerprint(catalog.traits.slice(0,244)),pinned.hashes.traits,'original exact trait definitions must remain even when monsters select new definitions');
 assert.equal(pinned.fingerprint(catalog.learnsets.filter(l=>pinned.calibratedMonsterIds.includes(l.monster_id))),pinned.hashes.learnsets,'original own/inherit, source ordering and unknown metadata must survive');
 assert.equal(pinned.fingerprint(catalog.skill_rules.filter(r=>pinned.legacySkillIds.includes(r.skill_id))),pinned.hashes.skill_rules);
 assert.equal(pinned.fingerprint(catalog.types),pinned.hashes.types);
 assert.equal(pinned.fingerprint(catalog.extensions.tencent_source_baseline),pinned.hashes.tencent_source_baseline);
});

test('graduated Mingulong has reviewed real metadata and complete own learning while keeping old level controls',()=>{
 const m=byId.get(619);
 assert.equal(m.name,'冥古龙');assert.equal(m.placeholder,false);
 assert.deepEqual(m.stats,{hp:118,phy_atk:128,phy_def:81,mag_atk:42,mag_def:63,speed:70});
 assert.deepEqual(m.type_ids,[8,15],'approved main Dragon / secondary Ghost order');
 assert.deepEqual(m.source_ref,{provider:'user-supplied-workbook',id:'470:冥古龙:default',identity:'NO.470|冥古龙|default'});
 assert.equal(m.dex_number,470);assert.equal(m.season,'S5');assert.equal(m.evolution_stage,'高级形态');
 assert.equal(m.evolves_from_id,624);assert.equal(byId.get(624).name,'小冥龙');assert.deepEqual(m.evolution_members,[624,619]);
 assert.equal(m.leader_of_id,undefined);assert.equal(m.default_level,99);assert.equal(m.level_configurable,true);
 assert.deepEqual([m.level_min,m.level_max,m.level_step],[undefined,undefined,undefined]);
 assert.ok(!m.data_note.includes('无属性'));
 const trait=catalog.traits.find(t=>t.id===m.trait_id);
 assert.equal(trait.name,'恶龙的奢望');
 assert.equal(trait.description,'初始等级+39，回合结束时等级-10，低于80级时受到伤害+40%。');
 assert.notEqual(m.trait_id,'trait-e6337fff38ccbd5fe07994daac0d1075');
 const l=catalog.learnsets.find(l=>l.monster_id===619);
 assert.equal(l.mode,'own');assert.equal(l.from_id,undefined);assert.deepEqual(l.skills,mingulongSkills);
 assert.equal(l.skills.length,45);assert.deepEqual(l.skills.filter(s=>s.source==='传说'),[{skill_id:5977,source:'传说'}]);
 const wiki=projection.wiki['冥古龙'];
 assert.match(m.images.portrait,/^assets\/monster\/images\/wiki\/s5-619-[a-f0-9]+\.png$/);
 assert.equal(wiki.image,m.images.portrait,'graduated portrait must survive the real legacy projection');
 assert.equal(wiki.data_status,undefined,'graduated wiki must not retain stale placeholder metadata');
 assert.equal(wiki.skills.length,mingulongSkills.length);
});

test('user supplied Super Abu remains independent of the pinned official calibration',()=>{
 const abu=byId.get(623),evidence=catalog.extensions.mieli_calibration;
 assert.equal(abu.name,'超能阿布');
 assert.deepEqual(abu.source_ref,{provider:'user-supplied-workbook',id:'493:超能阿布:default',identity:'NO.493|超能阿布|default'});
 assert.equal(abu.dex_number,493);assert.equal(abu.season,'S5');
 assert.ok(!evidence.mapping.some(row=>row.local_id===623));
 assert.deepEqual(abu.stats,{hp:126,phy_atk:105,phy_def:122,mag_atk:45,mag_def:80,speed:100});
 assert.deepEqual(abu.type_ids,[8]);assert.equal(abu.evolution_stage,'首领形态');assert.equal(abu.is_leader_form,true);
 assert.equal(abu.leader_of_id,648);assert.equal(byId.get(648).name,'阿布');assert.equal(byId.get(648).dex_number,493);
 assert.deepEqual(abu.evolution_members,[648]);assert.equal(abu.evolves_from_id,undefined);assert.equal(abu.placeholder,undefined);
 assert.deepEqual([abu.default_level,abu.level_min,abu.level_max,abu.level_step],[60,60,99,2]);
 const trait=catalog.traits.find(t=>t.id===abu.trait_id);
 assert.equal(trait.name,'圣龙的守护');
 assert.equal(trait.description,'在战斗中每提升1级，获得物攻+5%，低于80级时受到伤害+30%。');
 assert.notEqual(abu.trait_id,'trait-2d62e65c758af0457fe3fcdc3054ae81');
 const oldTrait=catalog.traits.find(t=>t.id==='trait-2d62e65c758af0457fe3fcdc3054ae81');
 assert.equal(oldTrait.description,'己方精灵每使用1次能耗为3的技能，自己入场前等级+2。在战斗中每提升1级，获得物攻+5%，低于80级时受到伤害+30%。');
 assert.deepEqual(catalog.learnsets.find(l=>l.monster_id===623),{monster_id:623,mode:'own',skills:abuSkills});
 assert.equal(abuSkills.length,44);assert.ok(!abuSkills.some(s=>s.source==='传说'),'ordinary Abu legend must not leak into leader');
 assert.deepEqual(catalog.learnsets.find(l=>l.monster_id===648).skills.filter(s=>s.source==='传说'),[{skill_id:5980,source:'传说'}]);
 assert.equal(projection.wiki['超能阿布'].image,abu.images.portrait);
 assert.equal(projection.monsters.find(m=>m.id===623).image,abu.images.avatar);
});

test('four environment chains use explicit corresponding forms and graph highlights only selected form',()=>{
 for(let i=0;i<4;i++){
  const chain=[100+i,104+i,108+i];
  for(const id of chain)assert.deepEqual(byId.get(id).evolution_members,chain);
  assert.equal(byId.get(104+i).evolves_from_id,100+i);
  assert.equal(byId.get(108+i).evolves_from_id,104+i);
 }
 const graph=family.build(projection.monsters,106);
 assert.equal(graph.nodes.length,12);
 assert.deepEqual(graph.nodes.filter(n=>n.selected).map(n=>n.id),[106]);
 assert.equal(graph.edges.filter(e=>e.kind==='evolution').length,8);
 assert.equal(graph.edges.filter(e=>e.kind==='leader').length,0);
});

test('seasonal family contains all ordinary and leader forms with explicit separate arrows',()=>{
 const graph=family.build(projection.monsters,50);
 assert.equal(graph.nodes.length,16);
 assert.equal(graph.edges.filter(e=>e.kind==='evolution').length,8);
 assert.equal(graph.edges.filter(e=>e.kind==='leader').length,4);
 for(const edge of graph.edges.filter(e=>e.kind==='leader'))assert.equal(byId.get(edge.to).leader_of_id,edge.from);
});

test('shipped Tencent baseline is versioned source evidence, not blanket permanent local locks',()=>{
 const baseline=catalog.extensions.tencent_source_baseline;
 assert.equal(baseline.version,1);
 assert.equal(baseline.normalizer_version,1);
 assert.equal(baseline.provider,'tencent-compendium');
 assert.match(baseline.source_sha256,/^[a-f0-9]{64}$/);
 assert.ok(Object.keys(baseline.entries).length>1000);
 assert.equal(Object.keys(catalog.extensions.catalog_choices?.entries||{}).length,0,'factory data must not contain developer preset choices');
 assert.ok(!Object.keys(catalog.extensions.mieli_calibration.counts).some(key=>key.endsWith('_changed')),'factory provenance must not carry prior change counters');
});
