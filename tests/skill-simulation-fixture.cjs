'use strict';
// Runs the actual damage renderer/event closures in an in-memory DOM/profile.
// No server, filesystem writes, application launch, or real personal configuration.
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const moves=require('./catalog-read-fixture.cjs').readProjectData('moves.json'), V=require('../js/skill-variants.js'), BattleMath=require('../js/battle-math.js');
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
function harness({mode=0,emptyWiki=false,savedProfile=null,data={}}={}){
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
  Object.assign(RKData,data);
  const events={};
  const box=vm.createContext({document,RKData,BattleMath,SkillVariants:V,SkillSimulation:require('../js/skill-simulation.js'),
    PetConfiguration:require('../js/pet-configuration.js'), PetLevels:require('../js/pet-levels.js'),
    CommonUI:{StatBox:{syncButtons(){},refreshValues(){}}},
    window:{UserConfig,addEventListener:(name,callback)=>events[name]=callback},
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},setTimeout:()=>1,clearTimeout:()=>{}});
  // Test-only access to existing private functions; no test seam in shipped code.
  const instrumented=source.replace('return { render, onLeave, getState: () => state, CalcEngine };','return { render, onLeave, getState: () => state, CalcEngine, renderSkillIcons, applySkillConfig, skillSnapshot, calculate, applySkillMemory, saveSkillConfig, writeSkillInputs, selectionTeams, checkJmfzBonus, applyTraitPowerDefaults, readPowerInput, syncPowerInput, bindEvents, selectPet, bindAvatarClicks, renderQuickHistory, renderQuickFav, searchBoxes, initSearchDropdown, initDefaultPets, restoreFromState };');
  vm.runInContext(instrumented+'\nthis.page=DamagePage;',box);
  const page=box.page,state=page.getState();
  state.atkPet=pets[1];state.defPet={id:9001,stats:{speed:100,defense:100},main_type:{name:'Normal'}};
  const modifiers={fixedBonus:-17,percentBonus:23.5,buff:-35,debuffPercent:'10+5',defenseMod:'-50',starMeteor:4,finalPowerManual:'0'};
  Object.assign(state,modifiers,{basePower:0,comboCount:9});
  for(const key of ['basePower','comboCount',...Object.keys(modifiers)])document.getElementById(key).value=String(state[key]);
  page.renderSkillIcons();
  const icon=(id,group)=>grid.children.find(i=>i.dataset.skillName===moves.find(m=>m.id===id).localized.zh.name&&(!group||i.group===group));
  return {page,state,grid,groups,icon,profile,writes,document,modifiers,storage,RKData,events,window:box.window,CommonUI:box.CommonUI};
}

module.exports={harness,plain,moves};
