'use strict';
// User-authorized Nov4 fixture expectations, not permanent catalogue totals.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),raw=fs.readFileSync(path.join(root,'data/catalog.json')),c=JSON.parse(raw),C=require('../js/catalog-data.js'),v=C.toLegacy(c);
const m=id=>c.monsters.find(x=>x.id===id),l=id=>c.learnsets.find(x=>x.monster_id===id),skill=id=>c.skills.find(x=>x.id===id),effective=id=>l(id).mode==='own'?l(id).skills:effective(l(id).from_id);
const expected=[
[624,469,'小冥龙',[94,102,34,65,51,56],[8,15]],[619,470,'冥古龙',[118,128,42,81,63,70],[8,15]],
[625,471,'地银链',[60,32,74,49,72,72],[6]],[626,472,'地底银鳞',[80,42,98,66,96,96],[6]],[627,473,'地绡银龙',[100,53,123,82,120,120],[6]],
[628,474,'沉金兽',[87,79,35,76,53,48],[9]],[629,475,'龙头金',[116,105,46,102,70,64],[9]],[630,476,'龙嵴金脉',[145,131,58,127,88,80],[9]],
[631,477,'乐乐鲨',[98,94,37,96,70,76],[4]],[632,478,'阿瓦鲨',[123,117,46,120,88,95],[4]],[633,478,'阿瓦鲨',[90,146,57,120,88,95],[4]],
[634,479,'蛋包蛋',[96,77,76,91,69,52],[1,14]],[635,480,'鸡麻麻',[120,96,95,113,86,65],[1,14]],
[636,481,'蟹蟹椰',[108,102,43,110,81,68],[4,2]],[637,482,'沙咔蟹',[135,128,54,137,101,85],[4,2]],
[638,483,'鲸羽',[108,30,99,58,82,80],[18,7]],[639,484,'圆环鲸羽',[135,38,123,73,102,100],[18,7]],
[640,485,'豆粒鹅',[102,77,69,107,72,76],[7]],[641,486,'刨雪鹅',[127,96,87,134,90,95],[7]],
[642,487,'西瓜虫',[86,50,100,61,103,64],[11,2]],[643,488,'冬虫夏瓜',[107,62,125,77,129,80],[11,2]],
[644,489,'小剪影',[98,114,44,84,66,96],[15]],[645,490,'影子剪纸',[123,143,56,104,83,120],[15]],
[646,491,'滴溜豚',[91,89,89,73,98,80],[10,18]],[647,492,'滴廿豚',[114,112,112,92,122,100],[10,18]],
[648,493,'阿布',[126,105,45,122,80,100],[8]],[623,493,'超能阿布',[126,105,45,122,80,100],[8]],
[649,467,'云梦豚',[77,37,101,87,94,84],[4]],[650,468,'长江豚',[96,46,126,109,117,105],[4]],
[651,null,'琉璃君主',[141,40,89,93,136,95],null],[652,null,'圣冠布鲁斯',[73,103,28,114,88,90],null]
];
test('all declared data rows keep exact stats, explicit season and stable ID namespace',()=>{
 for(const[id,dex,name,stats,types]of expected){const p=m(id);assert.ok(p,name);assert.equal(p.name,name);if(dex!==null)assert.equal(p.dex_number,dex);assert.deepEqual(['hp','phy_atk','mag_atk','phy_def','mag_def','speed'].map(k=>p.stats[k]),stats,name);if(types)assert.deepEqual(p.type_ids,types,name);assert.equal(p.season,[649,650].includes(id)?'S4':'S5',name);assert.ok(p.source_ref.provider.startsWith('user-supplied-'));}
 assert.equal(m(467).name,'星尘虫');assert.equal(m(468).name,'落星虫');assert.equal(new Set(c.monsters.map(x=>x.id)).size,c.monsters.length);
 assert.equal(m(619).default_level,99);assert.equal(m(619).level_configurable,true);assert.equal(m(623).default_level,60);assert.deepEqual([m(623).level_min,m(623).level_max,m(623).level_step],[60,99,2]);
});
test('declared ordinary branches, native chiefs and types are not confused with local IDs',()=>{
 assert.equal(m(619).evolves_from_id,624);assert.equal(m(632).evolves_from_id,631);assert.equal(m(633).evolves_from_id,631);assert.equal(m(633).main_form_id,632);assert.equal(m(632).form,'柠檬鲨的样子');assert.equal(m(633).form,'虎纹鲨的样子');
 assert.equal(m(623).leader_of_id,648);assert.equal(m(623).evolves_from_id,undefined);assert.equal(m(623).form,'default');assert.equal(m(650).evolves_from_id,649);
 for(const[id,base]of [[651,'琉璃水母'],[652,'冰钻布鲁斯']]){const p=m(id),b=c.monsters.find(x=>x.name===base&&!x.is_leader_form);assert.equal(p.leader_of_id,b.id);assert.deepEqual(p.type_ids,b.type_ids);assert.equal(p.dex_number,b.dex_number);assert.equal(p.evolution_stage,'首领形态');assert.equal(p.images.avatar,undefined,'missing head never borrows portrait');}
});
test('new skill identities, raw definitions and explicit combos remain independently referenced',()=>{
 const added=c.skills.filter(x=>x.id>=5963&&x.id<=5991);assert.equal(added.length,29);assert.ok(added.every(x=>x.season==='S5'));assert.equal(skill(250).name,'龙之利爪');assert.equal(skill(5979).name,'龙之爪牙');assert.equal(skill(250).power,130);assert.equal(skill(5979).power,25);
 for(const[id,combo]of [[5965,2],[5979,5],[5988,3]])assert.equal(c.skill_rules.find(x=>x.skill_id===id).base_combo,combo);
 for(const p of expected)for(const row of effective(p[0]))assert.ok(skill(row.skill_id),`${p[2]} dangling skill`);
 assert.ok(effective(635).some(x=>x.skill_id===544));assert.ok(effective(619).some(x=>x.skill_id===250));assert.ok(effective(648).some(x=>x.skill_id===5979));
});
test('explicit shared learning keeps legend only on named species and supports both chiefs',()=>{
 const legends=id=>effective(id).filter(x=>x.source==='传说').map(x=>x.skill_id);assert.deepEqual(legends(619),[5977]);assert.deepEqual(legends(624),[]);assert.deepEqual(legends(648),[5980]);assert.deepEqual(legends(623),[]);
 const normal=id=>effective(id).filter(x=>x.source!=='传说');assert.deepEqual(normal(624),normal(619));assert.deepEqual(normal(623),normal(648));assert.deepEqual(normal(649),normal(650));assert.deepEqual(normal(632),normal(633));
 for(const id of[619,623,649,650])assert.ok(effective(id).length>2);for(const id of[651,652])assert.deepEqual(effective(id),normal(m(id).leader_of_id));
});
test('trait split, completed619 and provided cube/fish graphics survive actual projections',()=>{
 const trait=id=>c.traits.find(x=>x.id===m(id).trait_id);assert.equal(trait(619).name,'恶龙的奢望');assert.equal(trait(648).name,'圣龙的心愿');assert.equal(trait(623).description,'在战斗中每提升1级，获得物攻+5%，低于80级时受到伤害+30%。');assert.equal(trait(649).name,'吐水');assert.equal(trait(650).id,trait(649).id);
 for(const id of[410,649,650]){const p=v.monsters.find(x=>x.id===id),w=v.wiki[C.toLegacy(c).monsters.find(x=>x.id===id).localized.zh.name];assert.ok(p.image);assert.ok(w.image);assert.ok(fs.existsSync(path.join(root,'assets/monster',p.image)));assert.ok(fs.existsSync(path.join(root,w.image)));}
 const p=v.monsters.find(x=>x.id===619),w=v.wiki['冥古龙'];assert.notEqual(p.data_status,'placeholder');assert.notEqual(w.data_status,'placeholder');assert.equal(w.image,m(619).images.portrait);assert.equal(w.skills.length,effective(619).length);assert.ok(fs.existsSync(path.join(root,w.image)));
 for(const name of['吐水','圣龙狂斩']){const p=path.join(root,'assets/monster',name==='吐水'?'trait':'skill',name+'.png');assert.deepEqual([...fs.readFileSync(p).subarray(0,8)],[137,80,78,71,13,10,26,10]);}
});
