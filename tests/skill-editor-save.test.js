// Exercise the actual save callback with a minimal DOM/network harness; no real files are written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/pages/updatedata.js'), 'utf8');
const marker = "document.getElementById('ud-save-btn').addEventListener('click', async () => {";
const start = source.indexOf(marker);
const end = source.indexOf('\n\n    // 重置', start);
assert.ok(start >= 0 && end > start, 'save callback must be identifiable');
const callbackCode = source.slice(start, end);
const original = [{ name: '械斗', source: '默认' }];

async function save({ current = original, baseline = original, loaded = true, confirm = false } = {}) {
  let click;
  let confirmations = 0;
  const requests = [];
  const result = { innerHTML: '', textContent: '' };
  const context = {
    document: { getElementById(id) {
      if (id === 'ud-save-btn') return { addEventListener(event, fn) { click = fn; } };
      if (id === 'ud-save-result') return result;
      return { value: '0' };
    } },
    window: { confirm() { confirmations++; return confirm; } },
    m: { id: 434 }, editorTypeSel: new Set(['Mechanical']),
    editorSkillList: current, originalSkillList: JSON.stringify(baseline), skillsLoaded: loaded,
    editorFormCategory: '无多形态', editorEvolvesFromID: null,
    getEvoValue: () => '高级形态',
    fetch: async (url, options) => { requests.push({ url, payload: JSON.parse(options.body) }); return { json: async () => ({ ok: true }) }; }
  };
  vm.createContext(context);
  vm.runInContext(callbackCode, context);
  await click();
  return { requests, confirmations, result };
}

test('unchanged skills are omitted from ordinary data edits', async () => {
  const { requests } = await save();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.id, 434);
  assert.equal('skillList' in requests[0].payload, false);
});

test('explicit skill edit sends the list', async () => {
  const current = [...original, { name: '拖拉机', source: '技能石' }];
  const { requests } = await save({ current });
  assert.deepEqual(requests[0].payload.skillList, current);
  assert.equal(requests[0].payload.allowEmptySkills, false);
});

test('clearing all skills requires confirmation and sends an explicit flag', async () => {
  const rejected = await save({ current: [] });
  assert.equal(rejected.confirmations, 1);
  assert.equal(rejected.requests.length, 0);
  const accepted = await save({ current: [], confirm: true });
  assert.equal(accepted.confirmations, 1);
  assert.deepEqual(accepted.requests[0].payload.skillList, []);
  assert.equal(accepted.requests[0].payload.allowEmptySkills, true);
});

test('an unresolved list is not saved as an empty learnset', async () => {
  const { requests } = await save({ baseline: [], current: [], loaded: false });
  assert.equal(requests.length, 1);
  assert.equal('skillList' in requests[0].payload, false);
});

test('editing an unresolved list is blocked before any write request', async () => {
  const { requests, result } = await save({ baseline: [], current: original, loaded: false });
  assert.equal(requests.length, 0);
  assert.match(result.textContent, /阻止覆盖/);
});
