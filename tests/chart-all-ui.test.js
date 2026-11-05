'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'js/pages/chart.js'),'utf8');
const math=vm.runInNewContext(source.split('const ChartPage =')[0]+'\nChartFavoriteMath;');
test('ALL is opt-in and only expands legal all-on controls',()=>{
 for(const[atkIV,atkNature]of [[false,0],[true,0],[true,1]])for(const defIV of [false,true])for(const hpNature of [false,true]){
  const selected={atkIV,atkNature,defIV,defNature:0,hpNature},eligible=atkIV&&atkNature===1&&defIV&&hpNature;
  assert.equal(math.curveConfigurations(selected).length,1);assert.equal(math.curveConfigurations(selected,false).length,1);
  const rows=math.curveConfigurations(selected,true);assert.equal(rows.length,eligible?12:1);assert.equal(new Set(rows.map(JSON.stringify)).size,rows.length);
  assert.ok(rows.every(r=>r.atkIV||!r.atkNature));
 }
});
test('ALL is presentation state, does not add another persisted control reset',()=>{
 const {createStore}=require('../js/chart-workspace.js'),store=createStore({});
 assert.equal(store.defaults().controlsRevision,2);assert.ok(!Object.hasOwn(store.defaults().controls,'showAll'));
 assert.match(source,/markersVisible: true, showAll: false/);
 assert.match(source,/hidden: view\.hidden\[key\] \?\? \(view\.showAll && !row\.selected\)/);
 assert.match(source,/if \(!eligible && view\.showAll\)/);
 assert.equal(store.getPresets().find(p=>p.id==='preset:Survivors').name,'斩杀预设');
 assert.equal(store.getPresets().find(p=>p.id==='preset:Favorites').name,'收藏预设');
});
test('fixed 400 dataset and its reverse crossing path are deleted, not disabled',()=>{
 assert.doesNotMatch(source,/\b400\b|400伤害参考线|reverseCrossing|crossLabel|options\.threshold|thresholdLabel/);
 assert.match(source,/targetHP: hp/);
 assert.match(source,/id: 'killLabel'/);
});
test('UI sizes and styles replace old geometry rather than overriding it',()=>{
 const reduction=fs.readFileSync(path.join(root,'css/damage-reduction.css'),'utf8'),chart=fs.readFileSync(path.join(root,'css/chart-features.css'),'utf8');
 assert.match(reduction,/padding: 8px 5px/);assert.doesNotMatch(reduction,/padding: 9px 5px/);
 assert.match(reduction,/gap: 6px/);assert.match(reduction,/padding: 10px/);
 assert.match(chart,/\.chart-preset-dynamic-row\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
 assert.match(chart,/\.chart-all-toggle\[hidden\]\s*\{ display: none; \}/);
 assert.equal((chart.match(/\.chart-preset-picker \.chart-preset-dynamic \{/g)||[]).length,1);
 assert.match(source,/feedbackTimers\.forEach\(timer => clearTimeout\(timer\)\)/);
});
