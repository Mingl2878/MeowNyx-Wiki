/** Explicit, user-operated skill simulations. No battle-history inference or eval. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SkillSimulation=api;})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const POWER=Object.freeze({37:90,41:45,88:60,113:20,126:85,154:20,173:30,252:20,272:40,429:15,489:20,537:25,5956:60});
  const COMBO=Object.freeze({2:[1,1],79:[2,2],326:[2,2],404:[2,2]});
  const ENERGY=Object.freeze([46,71,91,111,136,156,166,181,191,201,211]);
  const MAX=Number.MAX_SAFE_INTEGER, MAX_COUNT=1000000;
  function safe(n){if(!Number.isFinite(n)||Math.abs(n)>MAX)throw Error('数值超出安全计算范围');return n;}
  // Recursive descent. ^ is exponentiation, never JavaScript XOR. Bounded source
  // length prevents deep expressions; identifiers, commas and calls are rejected.
  function evaluate(text){
    const s=String(text??'').trim(); if(!s||s.length>128||!/^[\d\s.+*/()^\-]+$/.test(s))throw Error('请输入有效的数值表达式');
    const tokens=s.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+*/^\-]/g)||[];let i=0;
    const take=()=>tokens[i++];const peek=()=>tokens[i];
    function atom(){if(peek()==='('){take();const n=add();if(take()!==')')throw Error('括号不匹配');return n;}const t=take();if(!t||! /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(t))throw Error('缺少数值');return safe(Number(t));}
    function power(){let a=atom();if(peek()==='^'){take();const b=unary();a=safe(a**b);}return a;}
    function unary(){if(peek()==='+'){take();return unary();}if(peek()==='-'){take();return safe(-unary());}return power();}
    function mul(){let n=unary();while(peek()==='*'||peek()==='/'){const op=take(),b=unary();if(op==='/'&&b===0)throw Error('除数不能为0');n=safe(op==='*'?n*b:n/b);}return n;}
    function add(){let n=mul();while(peek()==='+'||peek()==='-'){const op=take(),b=mul();n=safe(op==='+'?n+b:n-b);}return n;}
    const n=add();if(i!==tokens.length)throw Error('表达式包含多余内容');return n;
  }
  function input(kind,text){
    text=String(text??'').trim();if(text.length>128)throw Error('输入过长');
    if(kind==='energy'){
      if(!/^(?:[0-9]|10)$/.test(text))throw Error('当前能量须为0—10的整数');
      return {basePower:ENERGY[Number(text)],skillInputKind:kind,skillInputValue:text,basePowerExpression:''};
    }
    if(kind==='hp-ratio'){
      const m=/^(\d+)\s*\/\s*(\d+)$/.exec(text);if(!m)throw Error('请按当前生命/最大生命输入，例如77/100');
      const current=BigInt(m[1]),max=BigInt(m[2]);
      if(max<=0n||current>max||max>BigInt(MAX))throw Error('须满足0≤当前生命≤最大生命，且最大生命大于0');
      const steps=Number(20n*(max-current)/max);
      return {basePower:240-10*steps,skillInputKind:kind,skillInputValue:`${current}/${max}`,basePowerExpression:''};
    }
    const value=Math.round(evaluate(text));if(value<0)throw Error('基础威力不能为负数');
    return {basePower:value,basePowerExpression:/[+*/()^\-]/.test(text)?text:'',skillInputKind:'power',skillInputValue:''};
  }
  function kind(move,pet){
    const id=Number(move?.id),p=Number(typeof pet==='object'?pet?.id:pet);
    if([568,569].includes(p)&&[510,538].includes(id))return null;
    if(id===35)return 'energy';if(id===19)return 'hp-ratio';
    if(id===510)return 'friend';if(id===538)return 'trial';
    if(Object.hasOwn(POWER,id))return 'power';if([131,464].includes(id))return 'double';if(Object.hasOwn(COMBO,id))return 'combo';return null;
  }
  function counter(record,key){const n=record?.[key]??0;if(!Number.isSafeInteger(n)||n<0||n>MAX_COUNT)throw Error('累计次数超出范围');return n;}
  function fireAttackEnabled(pet){
    const trait=pet?.trait?.localized?.zh, compact=text=>String(text??'').replace(/\s/g,'');
    return pet?.id===14 && compact(trait?.name)==='爆燃' && compact(trait?.description)==='使用火系技能后，获得双攻永久+30%。';
  }
  // One authoritative n for restored power and growth, including legacy records.
  // Only an explicit manual-power edit may detach retained growth until selection.
  function fireAttackCount(record={}){
    const power=Object.hasOwn(record,'powerCount')?record.powerCount:0;
    const retained=Object.hasOwn(record,'fireAttackCount')?record.fireAttackCount:0;
    if([power,retained].some(n=>!Number.isSafeInteger(n)||n<0||n>MAX_COUNT))throw Error('双攻累计次数超出范围');
    if(Object.hasOwn(record,'firePowerDetached')&&typeof record.firePowerDetached!=='boolean')throw Error('双攻手动威力标记无效');
    if(Object.hasOwn(record,'fireBuffOverridden')&&typeof record.fireBuffOverridden!=='boolean')throw Error('双攻手动BUFF标记无效');
    return record.firePowerDetached===true?retained:power;
  }
  function fireAttackBonus(pet,record={}){
    if(!fireAttackEnabled(pet))return 0;
    const count=fireAttackCount(record); // an override suppresses growth, never field validation
    return record.fireBuffOverridden===true?0:count*30;
  }
  function select(move,pet,side,record={}){
    const k=kind(move,pet);if(!k)return null;
    if(!['left','right','middle'].includes(side))throw Error('未知操作');
    if(side==='middle'&&!['friend','trial'].includes(k))return {applied:false};
    const r={...record},id=Number(move.id);let pc=counter(r,'powerCount'),cc=counter(r,'comboCount');
    const fireGrowth=id===113&&fireAttackEnabled(pet);
    if(fireGrowth)fireAttackCount(r); // reject malformed recognized fields before replacing the mirror
    let base=Number(move.power),combo=COMBO[id]?.[0]??move.base_combo??1,expression='';
    if(k==='energy'){r.energy=side==='right'?0:10;return {applied:true,record:r,values:{...input('energy',r.energy),comboCount:1}};}
    if(k==='hp-ratio'){const values=input('hp-ratio',r.hpRatio??'100/100');r.hpRatio=values.skillInputValue;return {applied:true,record:r,values:{...values,comboCount:1}};}
    if(side==='left'){pc=0;cc=0;r.counterMode=false;}
    else if(k==='trial'){if(side==='middle')cc++;else pc++;}
    else if(k==='friend'){if(side==='middle')r.counterMode=true;else {pc++;r.counterMode=false;}}
    else if(k==='combo')cc++;else pc++;
    if(pc>MAX_COUNT||cc>MAX_COUNT)throw Error('累计次数超出范围');
    r.powerCount=pc;r.comboCount=cc;
    if(k==='power')expression=pc?`${base}+(${pc}*${POWER[id]})`:String(base);
    if(k==='double')expression=pc?`${base}*2^(${pc})`:String(base);
    if(k==='combo'){combo=COMBO[id][0]+cc*COMBO[id][1];expression=String(base);}
    if(k==='trial'){base=20;combo=2+cc;expression=pc?`20+(${pc}*10)`:'20';}
    if(k==='friend'){base=70;expression=pc?`70+(${pc}*20)`:'70';if(r.counterMode)expression=`(${expression})*2`;}
    let growth;
    if(fireGrowth){
      r.fireAttackCount=pc;r.firePowerDetached=false;r.fireBuffOverridden=false;
      growth=fireAttackBonus(pet,r);
    }
    safe(combo);return {applied:true,record:r,values:{...input('power',expression),comboCount:combo},
      ...(growth===undefined?{}:{fireAttackBonus:growth})};
  }
  return Object.freeze({POWER,COMBO,ENERGY,kind,select,input,evaluate,MAX_COUNT,fireAttackEnabled,fireAttackBonus});
});
