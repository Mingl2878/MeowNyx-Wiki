'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../js/battle-records.js'),'utf8');
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function harness(){
 const pending=[];let active=0,peak=0;
 const context={module:{exports:{}},require:()=>require('../js/battle-math.js'),AbortController,console,
  fetch:(url,options)=>new Promise((resolve,reject)=>{active++;peak=Math.max(peak,active);let settled=false;
   const end=()=>{assert.equal(settled,false);settled=true;active--;};
   pending.push({url,options,ok(body={}){end();resolve({ok:true,status:200,json:async()=>body});},fail(status=429){end();resolve({ok:false,status,json:async()=>({error:'battle request capacity reached; retry after the current operation finishes'})});},reject(error){end();reject(error);}});
  })};
 vm.runInNewContext(source,context);return{api:context.module.exports,pending,get peak(){return peak;},get active(){return active;}};
}
test('client queues all initialization reads within two active transports',async()=>{
 const h=harness(),tasks=['list','stats','rules','status'].map(x=>h.api.request('/api/battles/'+x));
 assert.equal(h.pending.length,2);assert.equal(h.active,2);h.pending[0].ok({list:true});await tick();assert.equal(h.pending.length,3);h.pending[1].ok({stats:true});await tick();assert.equal(h.pending.length,4);
 h.pending[2].ok({rules:[]});h.pending[3].ok({status:true});await Promise.all(tasks);await tick();assert.equal(h.peak,2);assert.equal(h.active,0);
});
test('a queued write enters the close barrier before a transport slot is free',async()=>{
 const h=harness(),a=h.api.request('/list'),b=h.api.request('/stats'),write=h.api.request('/rules',{method:'PUT',body:'{}'});
 let closed=false;const flush=h.api.flush().then(x=>{closed=true;return x;});await tick();assert.equal(closed,false);assert.equal(h.pending.length,2);
 h.pending[0].ok();await tick();assert.equal(h.pending[2].url,'/rules');assert.equal(closed,false);h.pending[2].ok({revision:'saved'});assert.equal(await flush,true);assert.equal(closed,true);await write;
 h.pending[1].ok();await Promise.all([a,b]);await tick();assert.equal(h.peak,2);
});
test('aborting queued GET removes it without consuming a later slot',async()=>{
 const h=harness(),a=h.api.request('/list'),b=h.api.request('/stats'),abort=new AbortController();
 const stale=h.api.request('/stale',{signal:abort.signal});const rejected=assert.rejects(stale,{name:'AbortError'});abort.abort();await rejected;
 const fresh=h.api.request('/fresh');h.pending[0].ok();await tick();assert.equal(h.pending.length,3);assert.equal(h.pending[2].url,'/fresh');
 h.pending[1].ok();h.pending[2].ok();await Promise.all([a,b,fresh]);assert.equal(h.peak,2);
});
test('aborted active GET retains its slot until an abort-ignoring transport settles',async()=>{
 const h=harness(),abort=new AbortController(),a=h.api.request('/list',{signal:abort.signal}),b=h.api.request('/stats'),c=h.api.request('/rules');abort.abort();await tick();assert.equal(h.pending.length,2);
 h.pending[0].ok();await tick();assert.equal(h.pending.length,3);h.pending[1].ok();h.pending[2].ok();await Promise.all([a,b,c]);assert.equal(h.peak,2);
});
test('failed queued write reports failure, never retries, and releases capacity',async()=>{
 const h=harness(),a=h.api.request('/list'),b=h.api.request('/stats'),write=h.api.request('/rules',{method:'PUT'});
 const rejection=assert.rejects(write,error=>error.status===429&&error.message==='请求繁忙，请稍后重试。');const close=h.api.flush();
 h.pending[0].ok();await tick();h.pending[2].fail();await rejection;assert.equal(await close,false);h.pending[1].ok();await Promise.all([a,b]);await tick();assert.equal(h.pending.length,3);assert.equal(h.active,0);
});
