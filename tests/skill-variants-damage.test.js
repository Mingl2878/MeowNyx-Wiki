'use strict';
// Runs the actual damage renderer/event closures in an in-memory DOM/profile.
// No server, filesystem writes, application launch, or real personal configuration.
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const moves=require('../data/moves.json'), V=require('../js/skill-variants.js'), BattleMath=require('../js/battle-math.js');
const source=fs.readFileSync(path.join(__dirname,'../js/pages/damage.js'),'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
const decode=x=>x.replaceAll('&quot;','"').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
class Element {
  constructor(){this.value='';this.textContent='';this.dataset={};this.events={};this.children=[];this.attrs={};this.style={};const s=new Set();this.classList={add:x=>s.add(x),remove:x=>s.delete(x),toggle:(x,on)=>on?s.add(x):s.delete(x),contains:x=>s.has(x)};}
  addEventListener(type,fn){this.events[type]=fn;}
  setAttribute(k,v){this.attrs[k]=v;}
  appendChild(child){this.children=this.children.filter(c=>c!==child);this.children.push(child);return child;}
  remove(){this.removed=true;}
  querySelectorAll(selector){return selector==='.skill-icon-item'?this.children:[];}
  fire(type,options={}){const e={prevented:false,preventDefault(){this.prevented=true;},...options};this.events[type]?.(e);return e;}
}
function harness({mode=0,emptyWiki=false,savedProfile=null}={}){
  const nodes=new Map(), groups=[];
  const grid=new Element();
  Object.defineProperty(grid,'innerHTML',{set(html){this.html=html;groups.length=0;grid.children=[];
    const headers=[...html.matchAll(/<div class="skill-icon-group-title">([^<]+)<\/div>/g)];
    headers.forEach((h,i)=>{const group=new Element();group.label=h[1];const section=html.slice(h.index,headers[i+1]?.index??html.length);
      for(const match of section.matchAll(/<div class="skill-icon-item[^>]*>/g)){
        const item=new Element();item.group=group.label;
        for(const a of match[0].matchAll(/([\w-]+)="([^"]*)"/g)){
          if(a[1].startsWith('data-'))item.dataset[a[1].slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=decode(a[2]);
          else item.attrs[a[1]]=decode(a[2]);
        }
        group.children.push(item);grid.children.push(item);
      }
      groups.push(group);
    });},get(){return this.html;}});
  nodes.set('skill-icons-grid',grid);
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},
    createElement(){return new Element();},querySelector(){return new Element();},
    querySelectorAll(selector){return selector==='.skill-icons-subgrid'?groups:[];}};
  const storage=new Map([['rk_team_config',JSON.stringify({activeGroupId:'test',groups:[{id:'test',team:[501,1],petSkills:{501:['驱赶','撕咬','乘胜追击']}}]})]]);
  const profile=savedProfile?plain(savedProfile):{rk_pet_configs:{1:{mode,iv:{hp:false},nature:{attack:2},extra:'preserve'}},
    rk_damage_skill_configs:{1:{unknownSkillKey:'keep'}},rk_damage_view:{skill:{unknownViewKey:'keep'}}};
  const writes=[];
  const UserConfig={getObject:(key,fallback={})=>profile[key]??fallback,
    patch(key,patch){writes.push({key,patch:plain(patch)});profile[key]={...profile[key],...plain(patch)};return Promise.resolve(true);}};
  const pets={1:{id:1,dex_number:1,name:'Fixture',stats:{speed:160,defense:90},main_type:{name:'Normal'}},501:{id:501,dex_number:501}};
  const RKData={ALL_TYPES:[],getTypeZhFull:x=>x,getTypeEff:()=>1,getBaseStat:()=>100,
    getPetStat:(pet,stat)=>pet.stats?.[stat]??100,getTypeIcon:x=>x,getTypeEn:x=>x,getTypeShortZh:x=>x==='普通'?'普':x,
    getTypeZh:x=>x,getMonsterDisplayName:p=>p.name||'Fixture',getMonsterById:id=>pets[id],getMoves:()=>moves,
    getMoveName:m=>m?.localized.zh.name,getMoveCategoryZh:m=>m.move_category==='Physical Attack'?'物攻':'魔攻',
    isAttackMove:m=>!!m&&['Physical Attack','Magic Attack'].includes(m.move_category),
    getResolvedWikiData:()=>({skills:emptyWiki?[]:moves.filter(m=>['Physical Attack','Magic Attack'].includes(m.move_category)).map(m=>({name:m.localized.zh.name,source:m.id===420?'血脉':'普通',type:m.move_category==='Physical Attack'?'物攻':'魔攻',element:m.move_type.localized.zh}))})};
  const events={};
  const box=vm.createContext({document,RKData,BattleMath,SkillVariants:V,
    PetConfiguration:require('../js/pet-configuration.js'),
    CommonUI:{StatBox:{syncButtons(){},refreshValues(){}}},
    window:{UserConfig,addEventListener:(name,callback)=>events[name]=callback},
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},setTimeout:()=>1,clearTimeout:()=>{}});
  // Test-only access to existing private functions; no test seam in shipped code.
  const instrumented=source.replace('return { render, onLeave, getState: () => state, CalcEngine };','return { render, onLeave, getState: () => state, CalcEngine, renderSkillIcons, applySkillConfig, skillSnapshot, calculate, applySkillMemory, saveSkillConfig, writeSkillInputs, selectionTeams };');
  vm.runInContext(instrumented+'\nthis.page=DamagePage;',box);
  const page=box.page,state=page.getState();
  state.atkPet=pets[1];state.defPet={id:9001,stats:{speed:100,defense:100},main_type:{name:'Normal'}};
  const modifiers={fixedBonus:-17,percentBonus:23.5,buff:-35,debuffPercent:'10+5',defenseMod:'-50',starMeteor:4,finalPowerManual:'0'};
  Object.assign(state,modifiers,{basePower:0,comboCount:9});
  for(const key of ['basePower','comboCount',...Object.keys(modifiers)])document.getElementById(key).value=String(state[key]);
  page.renderSkillIcons();
  const icon=(id,group)=>grid.children.find(i=>i.dataset.skillName===moves.find(m=>m.id===id).localized.zh.name&&(!group||i.group===group));
  return {page,state,grid,groups,icon,profile,writes,document,modifiers,storage,RKData,events};
}
for(const mode of [0,1])test(`actual renderer: all groups, both buttons, persistence, zero/manual fields, mode ${mode}`,()=>{
  const h=harness({mode}),originalPet=plain(h.profile.rk_pet_configs),team=h.storage.get('rk_team_config');
  assert.deepEqual(h.groups.map(g=>g.label),['过山车技能','基础技能','血脉技能']);
  const click=(id,side,group)=>{
    const item=h.icon(id,group);assert.ok(item,`${id} ${group}`);const e=item.fire(side==='right'?'contextmenu':'click');
    if(side==='right')assert.equal(e.prevented,true);
    for(const [k,v]of Object.entries(h.modifiers))assert.equal(h.state[k],v,k);
    assert.deepEqual(plain(h.profile.rk_pet_configs),originalPet);
    assert.equal(h.storage.get('rk_team_config'),team);
    assert.ok(item.attrs.title.includes('左键：')&&item.attrs['aria-label'].includes('右键：'));
    return item;
  };
  for(const [id,group,lp,lc,rp,rc]of [[535,'基础技能',90,1,210,1],[535,'过山车技能',90,1,210,1],[420,'血脉技能',20,3,20,5],[420,'过山车技能',20,3,20,5],[29,'基础技能',30,2,30,4],[337,'基础技能',35,2,35,6]]){
    click(id,'left',group);assert.deepEqual([h.state.basePower,h.state.comboCount],[lp,lc]);
    click(id,'right',group);click(id,'right',group);assert.deepEqual([h.state.basePower,h.state.comboCount],[rp,rc]);
    const snapshot=plain(h.page.skillSnapshot());
    for(const[k,v]of Object.entries(snapshot)){assert.deepEqual(h.profile.rk_damage_view.skill[k],v);assert.deepEqual(h.profile.rk_damage_skill_configs[1][k],v);}
    assert.equal(h.profile.rk_damage_view.skill.unknownViewKey,'keep');
    assert.equal(h.profile.rk_damage_skill_configs[1].unknownSkillKey,'keep');
    h.page.applySkillConfig(plain(h.profile.rk_damage_view.skill));
    assert.deepEqual(plain(h.page.skillSnapshot()),snapshot,'restore exact snapshot, not default branch');
    click(id,'left',group);assert.deepEqual([h.state.basePower,h.state.comboCount],[lp,lc]);
  }
  // Zero placeholder remains zero (no `|| 100`); zero manual-final persists.
  click(435,'left','基础技能');assert.equal(h.state.basePower,0);assert.equal(h.profile.rk_damage_view.skill.finalPowerManual,'0');
  assert.ok(h.writes.every(w=>['rk_damage_view','rk_damage_skill_configs'].includes(w.key)));
});
test('ordinary right clicks are no-ops including all persistence and usage order',()=>{
  const h=harness();h.icon(535,'基础技能').fire('contextmenu');
  for(const id of [8]){
    const before=plain(h.page.skillSnapshot()),writes=h.writes.length,usage=h.storage.get('rk_skill_usage_order');
    assert.equal(h.icon(id).fire('contextmenu').prevented,true);
    assert.deepEqual(plain(h.page.skillSnapshot()),before);
    assert.equal(h.writes.length,writes);assert.equal(h.storage.get('rk_skill_usage_order'),usage);
    assert.match(h.document.getElementById('skill-variant-notice').textContent,/未应用/);
  }
});
test('self-target normal is blocked while explicit enemy counter can be selected',()=>{
  const h=harness(),item=h.icon(425);
  const before=plain(h.page.skillSnapshot());item.fire('click');
  assert.deepEqual(plain(h.page.skillSnapshot()),before);
  item.fire('contextmenu');assert.equal(h.state.basePower,180);assert.equal(h.state.comboCount,1);
  const counter=plain(h.page.skillSnapshot());item.fire('click');
  assert.deepEqual(plain(h.page.skillSnapshot()),counter);
});
test('known null combos, keyboard, and empty base table preserve coaster operation',()=>{
  const h=harness();
  for(const[id,combo]of [[516,3],[538,2]]){h.icon(id).fire('click');assert.equal(h.state.comboCount,combo);}
  assert.equal(h.icon(535).fire('keydown',{key:'Enter',shiftKey:true}).prevented,true);assert.equal(h.state.basePower,210);
  h.icon(535).fire('keydown',{key:'Enter',shiftKey:false});assert.equal(h.state.basePower,90);
  const empty=harness({emptyWiki:true});assert.deepEqual(empty.groups.map(g=>g.label),['过山车技能']);
  empty.icon(535).fire('contextmenu');assert.equal(empty.state.basePower,210);
});
test('existing speed/physical-defense difference auto behavior stays dynamic after both buttons',()=>{
  const h=harness();
  for(const[id,stat]of [[358,'speed'],[195,'defense']]){
    for(const type of ['click','contextmenu']){
      h.icon(id).fire(type);
      assert.equal(h.state.basePower,BattleMath.differencePower(h.state.atkPet.stats[stat]-h.state.defPet.stats[stat]));
      h.state.atkPet.stats[stat]=300;h.page.calculate();assert.equal(h.state.basePower,200);
      h.state.atkPet.stats[stat]=70;h.page.calculate();assert.equal(h.state.basePower,60);
    }
  }
});
test('special defender auto-bonus refreshes only on changed attribute, not a left/right preset toggle',()=>{
  const h=harness(); h.state.defPet.id=501;
  h.page.CalcEngine.calcTypeEff=type=>type==='火'?2:1;
  h.icon(132).fire('click');
  assert.equal(h.state.percentBonus,25,'changing to effective fire keeps special defender behavior');
  h.state.percentBonus=17;h.document.getElementById('percentBonus').value='17';
  h.icon(132).fire('contextmenu');assert.equal(h.state.percentBonus,17,'same-attribute variant preserves manual percent');
  h.icon(164).fire('click');assert.equal(h.state.percentBonus,0,'changing to neutral attribute clears stale special bonus');
  h.state.defPet.id=9001;h.state.percentBonus=19;h.document.getElementById('percentBonus').value='19';
  h.icon(132).fire('click');assert.equal(h.state.percentBonus,19,'ordinary defender does not erase independent manual percent');
  h.state.defPet.id=501;h.state.skillAttr='普通';h.state.percentBonus=37;h.document.getElementById('percentBonus').value='37';
  h.RKData.getTypeEn=x=>['普','普通'].includes(x)?'Normal':x;
  h.icon(8).fire('click');assert.equal(h.state.percentBonus,37,'equivalent localized type names are not a real attribute change');
});

test('unreviewed type names stay explicit and icon markup escapes editable skill labels',()=>{
  const h=harness(),name='技能"<evil>&';
  const m={id:999999,power:10,base_combo:1,move_category:'Physical Attack',move_type:{name:'Water'},localized:{zh:{name,description:'未审阅'}}};
  assert.equal(V.describe(m).element,'Water','missing Chinese localization must not become Normal');
  h.RKData.getMoves=()=>[m];
  h.RKData.getResolvedWikiData=()=>({skills:[{name,type:'物攻',element:'水',source:'默认'}]});
  h.page.renderSkillIcons();
  assert.ok(!h.grid.html.includes('<evil>'));
  assert.ok(h.grid.html.includes('技能&quot;&lt;evil&gt;&amp;'));
  assert.ok(h.grid.html.includes(encodeURIComponent(name)+'.png'));
});

test('calculation labels use the same checked/absent/negative convention as the chart legend',()=>{
  const h=harness();h.state.skillType='magic_attack';
  for(const [value,label]of [[0,'×性格'],[1,'✓性格'],[2,'负性格']]){
    h.state.atkNature.magic_attack=value;h.state.defNature.magic_defense=value;h.state.defNature.hp=value;
    const result=h.page.CalcEngine.calculate();
    for(const field of ['atkNatureText','defNatureText','hpNatureText'])assert.equal(result[field],label);
    assert.ok(!JSON.stringify(result).includes('√'));
  }
});

test('module include precedes renderer; enabled-state glyphs only; no document-wide right-click handler',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  assert.ok(html.indexOf('js/skill-variants.js')<html.indexOf('js/pages/damage.js'));
  assert.equal((html.match(/src="js\/skill-variants.js/g)||[]).length,1);
  assert.ok(!source.includes('√个体'));assert.ok(source.includes('✓个体'));
  assert.ok(!source.includes("document.addEventListener('contextmenu'"));
});

test('Garl input expressions persist across fresh damage contexts and do not leak to other pets',()=>{
  const h=harness();h.state.atkPet={...h.state.atkPet,id:569};
  h.page.renderSkillIcons();h.icon(535).fire('contextmenu');
  assert.equal(h.document.getElementById('basePower').value,'210+210');
  assert.equal(h.state.basePower,420);assert.equal(h.state.comboCount,1);
  assert.equal(h.profile.rk_damage_view.skill.basePowerExpression,'210+210');
  assert.equal(h.profile.rk_damage_skill_configs[569].basePowerExpression,'210+210');
  const newWindow=harness({savedProfile:h.profile});newWindow.state.atkPet={...newWindow.state.atkPet,id:569};
  newWindow.page.applySkillConfig(newWindow.profile.rk_damage_view.skill);
  assert.equal(newWindow.document.getElementById('basePower').value,'210+210');assert.equal(newWindow.state.basePower,420);
  newWindow.state.atkPet={...newWindow.state.atkPet,id:1};newWindow.page.applySkillMemory(1);
  assert.equal(newWindow.state.basePowerExpression,'');assert.notEqual(newWindow.document.getElementById('basePower').value,'210+210');
  newWindow.state.atkPet={...newWindow.state.atkPet,id:569};newWindow.page.applySkillMemory(569);
  assert.equal(newWindow.document.getElementById('basePower').value,'210+210');
  newWindow.document.getElementById('basePower').value='77';newWindow.page.calculate();newWindow.page.saveSkillConfig(569);
  assert.equal(newWindow.state.basePowerExpression,'');assert.equal(newWindow.profile.rk_damage_skill_configs[569].basePowerExpression,'');
  newWindow.page.renderSkillIcons();newWindow.icon(535).fire('click');newWindow.icon(322).fire('click');
  assert.equal(newWindow.state.basePowerExpression,'');assert.equal(Number(newWindow.document.getElementById('basePower').value),65);
});
test('dynamic skills clear expression, invalid saved companion is discarded, damage uses summed power once',()=>{
  const h=harness();h.state.atkPet={...h.state.atkPet,id:569};h.page.renderSkillIcons();h.icon(535).fire('click');
  h.document.getElementById('finalPowerManual').value='';h.document.getElementById('starMeteor').value='4';h.page.calculate();
  const expressionResult=plain(h.page.CalcEngine.calculate());
  h.document.getElementById('basePower').value='180';h.page.calculate();
  const numericResult=plain(h.page.CalcEngine.calculate());
  delete expressionResult.basePowerExpression;delete numericResult.basePowerExpression;
  assert.deepEqual(expressionResult,numericResult,'same normal and meteor computation, no extra casts or combo');
  h.icon(535).fire('click');h.icon(358).fire('click');assert.equal(h.state.basePowerExpression,'');
  h.page.applySkillConfig({basePower:77,basePowerExpression:'90+90'});assert.equal(h.state.basePowerExpression,'');
  assert.equal(Number(h.document.getElementById('basePower').value),77);
});
test('durable reset event refreshes personal configurations only and never saves skills or pet records',()=>{
  const h=harness();const beforeSkill=plain(h.page.skillSnapshot());
  h.state.atkPet={id:1,base_hp:100,base_phy_atk:80,base_mag_atk:120,base_spd:60,main_type:{name:'Normal'}};
  h.state.atkIV={hp:false};h.state.atkNature={};h.state.defIV={hp:false,defense:false};h.state.defNature={speed:1};
  h.profile.rk_pet_configs[1]={mode:0};h.page.selectionTeams.defender='team-fixture';
  const beforeDef=plain({iv:h.state.defIV,nature:h.state.defNature}),writes=h.writes.length;
  h.events.petdefaultsreset();assert.equal(h.state.atkIV.hp,true);assert.equal(h.state.atkIV.magic_attack,true);assert.equal(h.state.atkIV.defense,true);
  assert.deepEqual(plain({iv:h.state.defIV,nature:h.state.defNature}),beforeDef);
  assert.deepEqual(plain(h.page.skillSnapshot()),beforeSkill);assert.equal(h.writes.length,writes);
});
