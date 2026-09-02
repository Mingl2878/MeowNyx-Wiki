const fs = require('fs');
const lines = fs.readFileSync('js/pages/damage.js', 'utf8').split('\n');
const re = /\.value\s*=\s*(''|""|``|null)/;
lines.forEach((l, i) => { if (re.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 95)); });
console.log('--- state.basePower 赋值点 ---');
lines.forEach((l, i) => { if (/state\.basePower\s*=/.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 95)); });