'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const speedLeaderSource = fs.readFileSync(path.join(__dirname, '../js/speed-leader-display.js'), 'utf8');
const damageSpeedPrioritySource = fs.readFileSync(path.join(__dirname, '../js/damage-speed-priority.js'), 'utf8');
const { runtime: speedRuntime } = require('./speed-levels-fixture.cjs');
const SPEED_KEY = 'rk_speed_form_overrides', LEADER_GROUP = 'leader:13:130';
const unrelatedChoices = { 'ordinary-form|default|130': 77, 'other-form|default|60': 88, 'leader:unrelated:90': 999 };
const { harness, plain } = require('./skill-simulation-fixture.cjs');
const { runtime } = require('./selection-search-fixture.cjs');
// Selection/MRU behavior uses explicit relations, independent of the real catalog's schema migration.
const monsters = require('./catalog-read-fixture.cjs').readProjectData('monsters.json')
  .map(m => [221, 222, 223].includes(m.id) ? { ...m, evolution_members: [221, 222, 223] } : m);

function setup(options = {}) {
  const h = harness(options);
  const getElement = h.document.getElementById, createElement = h.document.createElement;
  const withRemoval = element => {
    element.removeEventListener ??= (type, listener) => { if (element.events[type] === listener) delete element.events[type]; };
    return element;
  };
  h.document.getElementById = id => withRemoval(getElement(id));
  h.document.createElement = (...args) => withRemoval(createElement(...args));
  // Load the real shared module against exactly the damage harness's in-memory
  // UserConfig authority. No real profile, storage files, browser or network.
  h.profile[SPEED_KEY] ??= { ...unrelatedChoices };
  vm.runInNewContext(speedLeaderSource, { window: h.window });
  vm.runInNewContext(damageSpeedPrioritySource, { window: h.window });
  const speedHelper = h.window.SpeedLeaderDisplay;
  // Real damage selection/config/skills/counters with DOM-only additions to its isolated fixture.
  const dummy = h.state.defPet; // The runtime dummy is not a canonical catalog entity.
  h.RKData.getMonsterById = id => monsters.find(m => m.id === id) || (id === 9001 ? dummy : undefined);
  h.RKData.getMonsters = () => monsters;
  h.RKData.getLeaderBase = pet => monsters.find(m => m.id === pet?.leader_of_id && !m.is_leader_form) || null;
  h.RKData.getMonsterDisplayName = pet => pet.localized?.zh?.name || pet.name || 'Fixture';
  h.RKData.typeBadgeHtml = type => `<span>${type}</span>`;
  for (const side of ['attacker', 'defender']) h.document.getElementById(side + 'Types').insertAdjacentHTML = function (_, html) { this.innerHTML += html; };
  const grids = [];
  function grid(id) {
    const container = h.document.getElementById(id); grids.push(container);
    container.querySelectorAll = selector => selector === '.quick-pet-item' ? container.children : [];
    container.redraws = 0;
    Object.defineProperty(container, 'innerHTML', { configurable: true, get() { return this.html; }, set(html) {
      this.html = html; this.redraws++; this.children = [];
      for (const m of html.matchAll(/class="quick-pet-item" data-pet-id="(\d+)"/g)) {
        const el = h.document.createElement(), wrapper = h.document.createElement();
        el.dataset.petId = m[1]; el.querySelector = () => wrapper;
        wrapper.marks = [];
        wrapper.insertAdjacentHTML = (_, markup) => {
          for (const match of markup.matchAll(/class="([^"]+)"/g)) {
            const mark = { className: match[1], remove() { wrapper.marks = wrapper.marks.filter(m => m !== mark); } }; wrapper.marks.push(mark);
          }
        };
        wrapper.querySelectorAll = selector => wrapper.marks.filter(m => m.className.split(' ').includes(selector.slice(1)));
        wrapper.querySelector = selector => wrapper.querySelectorAll(selector)[0];
        container.children.push(el);
      }
    } });
    return container;
  }
  const history = grid('quick-history-grid'), favorites = grid('quick-fav-grid'), teamGrid = grid('quick-team-grid');
  const queryAll = h.document.querySelectorAll, query = h.document.querySelector;
  h.document.querySelectorAll = selector => selector === '.quick-pet-item' ? grids.flatMap(g => g.children) : queryAll(selector);
  h.document.querySelector = selector => {
    const match = /^\.quick-pet-item\[data-pet-id="(\d+)"\]$/.exec(selector);
    return match ? grids.flatMap(g => g.children).find(el => el.dataset.petId === match[1]) || null : query(selector);
  };
  h.document.addEventListener = () => {};
  h.document.removeEventListener = () => {};
  // Full render is used only where the production team/drop initialization is
  // needed. Stat layout is outside this event fixture's scope.
  h.CommonUI.StatBox.buildHTML = () => '';
  h.CommonUI.StatBox.buildModeRadio = () => '';
  let historyWrites = 0;
  const set = h.storage.set.bind(h.storage);
  h.storage.set = (key, value) => { if (key === 'rk_searched_pets') historyWrites++; return set(key, value); };
  const common = runtime(monsters);
  h.CommonUI.createSearchBox = common.api.createSearchBox; h.CommonUI.monsterRenderItem = common.api.monsterRenderItem;
  h.page.initSearchDropdown('atk-search', 'attacker'); h.page.initSearchDropdown('def-search', 'defender');
  h.page.bindEvents();
  const seed = ids => { h.state.searchedPets = ids.slice(); set('rk_searched_pets', JSON.stringify(ids)); h.page.renderQuickHistory(); };
  const avatarIn = (container, id) => container.children.find(el => Number(el.dataset.petId) === id);
  const freshTeam = (teamData, ids = teamData.team) => {
    // Never rebind a favorite's existing listeners as a pretend team event.
    const container = grid('isolated-team-' + grids.length);
    container._teamData = teamData;
    container.innerHTML = ids.map(id => `<div class="quick-pet-item" data-pet-id="${id}"></div>`).join('');
    h.page.bindAvatarClicks(container);
    return container;
  };
  return { ...h, common, history, favorites, teamGrid, seed, freshTeam, avatarIn, speedHelper,
    preferenceWrites: () => h.writes.filter(write => write.key === SPEED_KEY),
    priorityWrites: () => h.writes.filter(write => write.key === 'rk_damage_view' && Object.hasOwn(write.patch, 'speedPriority')),
    speedPriority: () => Array.from(h.window.DamageSpeedPriority.read(h.state.searchedPets)),
    speed: () => speedRuntime(monsters, h.storage, true, h.window.SpeedLeaderDisplay, {
      UserConfig: h.window.UserConfig, DamagePage: h.page, DamageSpeedPriority: h.window.DamageSpeedPriority, avatarWidth: 34
    }),
    visibleChoice: () => [...speedHelper.visibleIds(monsters)].filter(id => id === 13 || id === 14),
    render: () => h.page.render(h.document.createElement()),
    historyWrites: () => historyWrites, avatar: id => avatarIn(history, id) };
}

test('history left/right selects roles without MRU writes/redraw; marks, individual config, trait and skill restore survive', () => {
  const h = setup(); h.seed([223, 203, 222, 221]);
  h.profile.rk_pet_configs[203] = { mode: 1, iv: { hp: false, attack: true }, nature: { attack: 2 } };
  h.profile.rk_damage_skill_configs[203] = { basePower: 83, comboCount: 3, buff: 9, percentBonus: 11 };
  h.window.TraitPowerDefaults = require('../js/trait-power-defaults.js');
  const original = h.history.children.slice(), serialized = h.storage.get('rk_searched_pets'), redraws = h.history.redraws;
  h.avatar(203).fire('click');
  assert.equal(h.state.atkPet.id, 203); assert.equal(h.state.atkNature.attack, 2); assert.equal(h.state.atkIV.hp, false);
  assert.equal(h.state.basePower, 83); assert.equal(h.state.comboCount, 3); assert.equal(h.state.percentBonus, 30);
  assert.equal(h.page.searchBoxes.attacker.getValue(), h.RKData.getMonsterDisplayName(h.state.atkPet));
  assert.ok(h.avatar(203).querySelector().marks.some(m => m.className.includes('atk')));
  h.avatar(222).fire('contextmenu');
  assert.equal(h.state.defPet.id, 222); assert.ok(h.avatar(222).querySelector().marks.some(m => m.className.includes('def')));
  assert.equal(h.state.percentBonus, 30); assert.equal(h.state.comboCount, 3);
  assert.deepEqual(h.history.children, original); assert.equal(h.history.redraws, redraws);
  assert.deepEqual(Array.from(h.state.searchedPets), [223, 203, 222, 221]);
  assert.equal(h.storage.get('rk_searched_pets'), serialized); assert.equal(h.historyWrites(), 0);
  assert.ok(h.writes.some(w => w.key === 'rk_damage_selection'), 'active role persistence is not disabled');
});

test('historical reselect restores saved skill input and never resets persistent skill counters', () => {
  const h = setup(); h.seed([1, 222]);
  h.icon(41).fire('contextmenu'); h.icon(41).fire('contextmenu');
  h.icon(35).fire('click'); h.document.getElementById('basePower').value = '6'; h.document.getElementById('basePower').fire('input');
  const counters = plain(h.profile.rk_skill_simulation);
  const simulationWrites = h.writes.filter(w => w.key === 'rk_skill_simulation').length;
  assert.equal(counters['1:41'].powerCount, 2);
  assert.equal(counters['1:35'].energy, 6);
  h.avatar(1).fire('click');
  assert.equal(h.state.skillInputKind, 'energy'); assert.equal(h.state.skillInputValue, '6');
  assert.equal(h.document.getElementById('basePower').value, '6'); assert.equal(h.state.basePower, 166);
  h.avatar(1).fire('click'); h.avatar(222).fire('contextmenu');
  assert.deepEqual(plain(h.profile.rk_skill_simulation), counters);
  assert.equal(h.writes.filter(w => w.key === 'rk_skill_simulation').length, simulationWrites);
  assert.equal(h.historyWrites(), 0);
});

test('only history skips MRU: ordinary selection/favorite/team/search still deduplicate, cap16 and exclude wood dummy', () => {
  const h = setup(); h.seed(Array.from({ length: 16 }, (_, i) => i + 1));
  h.page.selectPet('defender', h.RKData.getMonsterById(221));
  assert.deepEqual(Array.from(h.state.searchedPets), [221, ...Array.from({ length: 15 }, (_, i) => i + 1)]);
  h.page.selectPet('attacker', h.RKData.getMonsterById(5)); assert.equal(h.state.searchedPets[0], 5);
  assert.equal(h.state.searchedPets.filter(id => id === 5).length, 1);
  const before = Array.from(h.state.searchedPets), writes = h.historyWrites();
  h.page.selectPet('defender', h.RKData.getMonsterById(9001)); assert.deepEqual(Array.from(h.state.searchedPets), before); assert.equal(h.historyWrites(), writes);
  h.state.favPets = [222]; h.page.renderQuickFav(); h.favorites.children[0].fire('click'); assert.equal(h.state.searchedPets[0], 222);
  // Same shared avatar binding with teamData must still use team configuration and MRU.
  const team = { id: 'test-team', team: [222], petIVs: { 222: { hp: true } }, petNatures: { 222: { defense: 2 } } };
  const teamContainer = h.freshTeam(team);
  teamContainer.children[0].fire('contextmenu');
  assert.equal(h.state.defNature.defense, 2); assert.equal(h.page.selectionTeams.defender, 'test-team');
  assert.equal(h.state.searchedPets[0], 222);
  const box = h.page.searchBoxes.attacker;
  h.common.type(box, '小黑'); h.common.pick(box, 221); assert.equal(h.state.searchedPets[0], 221);
});

test('middle favorite behavior unchanged and does not select a role or touch history', () => {
  const h = setup(); h.seed([221, 222]); const atk = h.state.atkPet, def = h.state.defPet;
  h.avatar(222).fire('auxclick', { button: 1 }); assert.ok(h.state.favPets.includes(222));
  h.avatar(222).fire('auxclick', { button: 1 }); assert.ok(!h.state.favPets.includes(222));
  assert.equal(h.state.atkPet, atk); assert.equal(h.state.defPet, def); assert.equal(h.historyWrites(), 0);
  assert.equal(h.priorityWrites().length, 0, 'middle-click favorite toggle never records an explicit damage selection');
});

function assertChoice(h, id) {
  assert.equal(h.profile[SPEED_KEY][LEADER_GROUP], id, 'one existing shared group key stores the latest explicit choice');
  assert.deepEqual(h.visibleChoice(), [id], 'actual shared visibleIds suppresses only the other same-speed member');
  for (const [key, value] of Object.entries(unrelatedChoices)) assert.equal(h.profile[SPEED_KEY][key], value);
  for (const write of h.preferenceWrites()) assert.deepEqual(Object.keys(write.patch), [LEADER_GROUP], 'only the shared group field is patched');
}

function historySnapshot(h) {
  return { nodes: h.history.children.slice(), html: h.history.innerHTML, redraws: h.history.redraws,
    order: Array.from(h.state.searchedPets), serialized: h.storage.get('rk_searched_pets'), writes: h.historyWrites() };
}
function assertHistoryUnchanged(h, before) {
  assert.deepEqual(h.history.children, before.nodes, 'existing history DOM nodes keep their identities/order');
  assert.equal(h.history.innerHTML, before.html); assert.equal(h.history.redraws, before.redraws);
  assert.deepEqual(Array.from(h.state.searchedPets), before.order);
  assert.equal(h.storage.get('rk_searched_pets'), before.serialized); assert.equal(h.historyWrites(), before.writes);
}

for (const source of ['history', 'favorites', 'team']) for (const [side, prefix, event] of [
  ['attacker', 'atk', 'click'], ['defender', 'def', 'contextmenu']
]) test(`${source} ${event} selects ${side}, flips the real shared speed choice, and preserves source configuration/MRU semantics`, () => {
  const h = setup(), catalogBefore = JSON.stringify(monsters);
  h.seed([223, 13, 203, 14, 222, ...Array.from({ length: 11 }, (_, i) => i + 1)]);
  const personal = { mode: 1, iv: { hp: false, attack: true, defense: false }, nature: { attack: 2, defense: 0 }, unknown: 'keep' };
  h.profile.rk_pet_configs[13] = plain(personal); h.profile.rk_pet_configs[14] = plain(personal);
  const team = { id: 'same-speed-team', team: [13, 14], petIVs: { 13: { hp: true, attack: false, defense: true }, 14: { hp: false, attack: false, defense: true } },
    petNatures: { 13: { attack: 1, defense: 2 }, 14: { attack: 0, defense: 1 } }, extra: { keep: true } };
  const teamBefore = JSON.stringify(team), personalBefore = JSON.stringify(h.profile.rk_pet_configs);
  h.state.favPets = [13, 14]; h.storage.set('rk_fav_pets', '[13,14]'); h.page.renderQuickFav();
  const container = source === 'history' ? h.history : source === 'favorites' ? h.favorites : h.freshTeam(team);
  const historyBefore = historySnapshot(h), favoriteBefore = h.storage.get('rk_fav_pets');
  assert.deepEqual(h.visibleChoice(), [13], 'actual projected advanced13/leader14 default is advanced13');
  assert.equal(h.RKData.getMonsterById(14).leader_of_id, 13);
  assert.equal(h.RKData.getMonsterById(13).base_spd, 130); assert.equal(h.RKData.getMonsterById(14).base_spd, 130);
  let expectedHistory = historyBefore.order;
  for (const [index, id] of [14, 13, 14].entries()) {
    const clicked = h.avatarIn(container, id), result = clicked.fire(event);
    if (event === 'contextmenu') assert.equal(result.prevented, true);
    assert.equal(h.state[prefix + 'Pet'].id, id); assertChoice(h, id);
    assert.equal(h.preferenceWrites().length, index + 1);
    const expected = source === 'team' ? { iv: team.petIVs[id], nature: team.petNatures[id] } : personal;
    for (const [stat, value] of Object.entries(expected.iv)) assert.equal(h.state[prefix + 'IV'][stat], value);
    for (const [stat, value] of Object.entries(expected.nature)) assert.equal(h.state[prefix + 'Nature'][stat], value);
    assert.equal(h.page.selectionTeams[side], source === 'team' ? team.id : null);
    assert.equal(h.profile.rk_damage_selection[side], id);
    assert.equal(h.profile.rk_damage_selection[side + 'Team'], source === 'team' ? team.id : null);
    const speedWriteIndex = h.writes.findLastIndex(write => write.key === SPEED_KEY);
    assert.ok(h.writes.slice(0, speedWriteIndex).some(write => write.key === 'rk_damage_selection' && write.patch[side] === id), 'role/team selection completes before recording display preference');
    const priorityIndex = h.writes.findLastIndex(write => write.key === 'rk_damage_view' && Object.hasOwn(write.patch, 'speedPriority'));
    assert.ok(priorityIndex > speedWriteIndex, 'independent ordinary-row priority records after the existing leader hook');
    assert.ok(clicked.querySelector().marks.some(mark => mark.className.split(' ').includes(prefix)));
    if (source === 'history') assertHistoryUnchanged(h, historyBefore);
    else {
      expectedHistory = [id, ...expectedHistory.filter(value => value !== id)].slice(0, 16);
      assert.deepEqual(Array.from(h.state.searchedPets), expectedHistory);
      assert.equal(h.storage.get('rk_searched_pets'), JSON.stringify(expectedHistory));
      assert.equal(h.historyWrites(), historyBefore.writes + index + 1);
    }
  }
  assert.equal(JSON.stringify(h.profile.rk_pet_configs), personalBefore, 'selection never rewrites individual IV/nature');
  assert.equal(JSON.stringify(team), teamBefore, 'team ID/IV/nature and unknown fields stay intact');
  assert.equal(h.storage.get('rk_fav_pets'), favoriteBefore); assert.deepEqual(Array.from(h.state.favPets), [13, 14]);
  assert.equal(JSON.stringify(monsters), catalogBefore, 'actual projected catalog is never mutated');
});

test('damage search → quick → speed recordSearch → quick uses latest explicit same-pet selection, then restores on restart', async () => {
  const h = setup(); h.seed([13, 14, 222]);
  const box = h.page.searchBoxes.attacker;
  h.common.type(box, '烈火'); assert.equal(h.preferenceWrites().length, 0, 'partial input does not become a choice');
  h.common.pick(box, 14); assertChoice(h, 14);
  let before = historySnapshot(h);
  h.avatar(13).fire('click'); assert.equal(h.state.atkPet.id, 13); assertChoice(h, 13); assertHistoryUnchanged(h, before);
  await h.speedHelper.recordSearch(h.RKData.getMonsterById(14), monsters); assertChoice(h, 14);
  before = historySnapshot(h);
  h.avatar(13).fire('click'); assert.equal(h.state.atkPet.id, 13); assertChoice(h, 13); assertHistoryUnchanged(h, before);
  const writes = h.preferenceWrites().length;
  h.avatar(13).fire('click'); assertChoice(h, 13); assert.equal(h.preferenceWrites().length, writes, 'same effective choice need not cause a redundant preference save');
  assertHistoryUnchanged(h, before);
  h.common.type(h.page.searchBoxes.defender, '烈火战神'); assert.equal(h.state.defPet.id, 14); assertChoice(h, 14);
  h.common.type(box, ''); h.page.restoreFromState(); assertChoice(h, 14);
  const saved = plain(h.profile), restored = setup({ savedProfile: saved });
  restored.page.initDefaultPets(); restored.page.restoreFromState();
  assertChoice(restored, 14); assert.equal(restored.preferenceWrites().length, 0, 'saved leader wins over default13, even when restored attacker is13');
  assert.equal(restored.state.atkPet.id, 13); assert.equal(restored.state.defPet.id, 9001);
});

test('full render binds actual team/drop events: team context survives both roles, middle/drag favorites never choose a speed member', () => {
  const h = setup(); h.seed([13, 14]);
  const team = { id: 'rendered-team', team: [13, 14], petIVs: { 14: { hp: false, defense: true } }, petNatures: { 14: { defense: 2 } } };
  h.storage.set('rk_team_config', JSON.stringify({ activeGroupId: team.id, groups: [team] }));
  h.render();
  assert.equal(h.preferenceWrites().length, 0, 'render/startup must not elect a member');
  assert.equal(h.priorityWrites().length, 0, 'render/startup must not seed independent priority');
  assert.deepEqual(h.teamGrid.children.map(el => Number(el.dataset.petId)), [13, 14]);
  const teamStorage = h.storage.get('rk_team_config');
  for (const [side, prefix, event] of [['attacker', 'atk', 'click'], ['defender', 'def', 'contextmenu']]) {
    h.avatarIn(h.teamGrid, 14).fire(event);
    assert.equal(h.state[prefix + 'Pet'].id, 14); assert.equal(h.state[prefix + 'IV'].hp, false);
    assert.equal(h.state[prefix + 'Nature'].defense, 2); assert.equal(h.profile.rk_damage_selection[side + 'Team'], team.id);
    assertChoice(h, 14);
  }
  const writes = h.preferenceWrites().length, priorityWrites = h.priorityWrites().length, priority = h.speedPriority(), before = historySnapshot(h), roles = [h.state.atkPet, h.state.defPet];
  for (const container of [h.history, h.teamGrid]) {
    const avatar = h.avatarIn(container, 13);
    assert.equal(avatar.fire('mousedown', { button: 1 }).prevented, true);
    assert.equal(avatar.fire('auxclick', { button: 1 }).prevented, true);
    assert.equal(h.state.favPets.includes(13), true);
    // The actual rendered favorite binding toggles back, with no role change.
    h.avatarIn(h.favorites, 13).fire('mousedown', { button: 1 });
    h.avatarIn(h.favorites, 13).fire('auxclick', { button: 1 });
    assert.equal(h.state.favPets.includes(13), false);
  }
  const transfer = { data: {}, setData(key, value) { this.data[key] = value; }, getData(key) { return this.data[key] || ''; } };
  h.avatar(13).fire('dragstart', { dataTransfer: transfer });
  assert.equal(transfer.data['text/pet-id'], '13'); assert.equal(transfer.effectAllowed, 'move');
  assert.equal(h.favorites.fire('dragover', { dataTransfer: transfer }).prevented, true);
  assert.equal(h.favorites.fire('drop', { dataTransfer: transfer }).prevented, true);
  assert.deepEqual(Array.from(h.state.favPets), [13]); assert.equal(h.storage.get('rk_fav_pets'), '[13]');
  assert.equal(h.preferenceWrites().length, writes); assertChoice(h, 14); assertHistoryUnchanged(h, before);
  assert.equal(h.priorityWrites().length, priorityWrites); assert.deepEqual(h.speedPriority(), priority, 'actual middle/drop handlers preserve independent priority');
  assert.deepEqual([h.state.atkPet, h.state.defPet], roles); assert.equal(h.storage.get('rk_team_config'), teamStorage);
});

test('missing avatar IDs, partial typing/clear, generic selection and startup/restore do not write a preference', () => {
  const h = setup(); h.seed([13, 14]); h.profile[SPEED_KEY][LEADER_GROUP] = 14;
  h.profile.rk_damage_selection = { attacker: 13, defender: 14 };
  const missing = h.freshTeam({ id: 'missing', team: [999999] }).children[0];
  const roles = [h.state.atkPet, h.state.defPet], before = historySnapshot(h);
  missing.fire('click'); assert.equal(missing.fire('contextmenu').prevented, true);
  delete missing.dataset.petId; missing.fire('click'); missing.fire('contextmenu');
  assert.deepEqual([h.state.atkPet, h.state.defPet], roles); assertHistoryUnchanged(h, before);
  for (const side of ['attacker', 'defender']) {
    const box = h.page.searchBoxes[side];
    for (const value of ['烈火', '火', 'does-not-exist', '', '   ']) h.common.type(box, value);
    box.setValue('火神', h.RKData.getMonsterById(13));
    h.page.selectPet(side, h.RKData.getMonsterById(13), null, 'history');
    assertChoice(h, 14); assert.equal(h.preferenceWrites().length, 0, 'generic selection is not the explicit hook');
  }
  h.page.initDefaultPets(); assert.equal(h.state.atkPet.id, 13);
  h.page.restoreFromState(); h.page.restoreFromState();
  assertChoice(h, 14); assert.equal(h.preferenceWrites().length, 0);
  assert.equal(h.priorityWrites().length, 0, 'missing IDs, partial/clear/programmatic values, generic selection and startup/restore never record priority');
});

for (const [side, prefix, event] of [['attacker', 'atk', 'click'], ['defender', 'def', 'contextmenu']])
  test(`battle apply/end/restore never records preferences; explicit ${side} quick selection records only after exit`, () => {
    const h = setup(); h.seed([13, 14]); h.profile[SPEED_KEY][LEADER_GROUP] = 13;
    const context = { BattleMath: require('../js/battle-math.js') };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/battle-records.js'), 'utf8'), context);
    const client = h.window.BattleRecordsClient = context.BattleRecordsClient;
    const host = h.document.getElementById('battle-snapshot-panel');
    host.querySelector = () => h.document.createElement(); host.replaceChildren = () => { host.children = []; };
    client.useRecord({ version: 1, id: 'isolated-selection-battle', sides: { me: { pets: [{ instanceId: 'me14', monsterId: 14, level: 60, iv: {}, nature: {} }] },
      enemy: { pets: [{ instanceId: 'enemy14', monsterId: 14, level: 60, iv: {}, nature: {} }] } } });
    const api = h.page.CalcEngine, before = historySnapshot(h), roles = [h.state.atkPet, h.state.defPet];
    assert.equal(api.applyBattlePet('attacker', 'me', 'me14'), true);
    assert.equal(api.applyBattlePet('defender', 'enemy', 'enemy14'), true);
    assert.equal(api.isBattleSimulation(), true); h.page.restoreFromState();
    assertChoice(h, 13); assert.equal(h.preferenceWrites().length, 0); assertHistoryUnchanged(h, before);
    assert.equal(h.priorityWrites().length, 0, 'automatic battle snapshots and restores do not publish selection priority');
    api.endBattleSimulation(); assert.equal(api.isBattleSimulation(), false);
    assert.deepEqual([h.state.atkPet, h.state.defPet], roles); assertChoice(h, 13); assert.equal(h.preferenceWrites().length, 0);
    assert.equal(h.priorityWrites().length, 0, 'ending battle simulation restores without recording priority');
    assert.equal(api.applyBattlePet(side, 'me', 'me14'), true);
    const patch = h.window.UserConfig.patch;
    h.window.UserConfig.patch = (key, fields) => {
      if (key === SPEED_KEY || (key === 'rk_damage_view' && Object.hasOwn(fields, 'speedPriority'))) assert.equal(api.isBattleSimulation(), false, 'selection exits the overlay before either shared choice or priority is recorded');
      return patch(key, fields);
    };
    h.avatar(14).fire(event);
    assert.equal(api.isBattleSimulation(), false); assert.equal(h.state[prefix + 'Pet'].id, 14);
    assertChoice(h, 14); assert.equal(h.preferenceWrites().length, 1); assertHistoryUnchanged(h, before);
    assert.equal(h.priorityWrites().length, 1); assert.equal(h.speedPriority()[0], 14);
  });

test('real damage input auto-pick and setValue path track selection; family reopen is read-only', () => {
  const h = setup(), box = h.page.searchBoxes.attacker;
  h.common.type(box, '黑猫巫师'); assert.equal(h.state.atkPet.id, 222); assert.equal(h.state.searchedPets[0], 222);
  assert.equal(h.speedPriority()[0], 222); assert.equal(h.priorityWrites().length, 1, 'existing exact-name auto-pick records through the explicit hook');
  const writes = h.historyWrites(), profileWrites = h.writes.length;
  box.input.click(); assert.deepEqual(h.common.ids(box), [221, 223]);
  h.common.key(box, 'Escape'); box.input.click(); assert.deepEqual(h.common.ids(box), [221, 223]);
  assert.equal(h.historyWrites(), writes); assert.equal(h.writes.length, profileWrites);
  assert.equal(box.input.selectionEnd, box.input.value.length);
  h.common.type(box, '小黑'); assert.ok(h.common.ids(box).includes(221));
});

// Joined integration: actual CommonUI input/candidate events or rendered quick
// handlers → actual DamageSpeedPriority → the same UserConfig authority → actual
// SpeedPage row sorting AND responsive avatar HTML at synthetic one-avatar width.
const ordinaryIds = [488, 225, 595];
const ordinaryHistory = [488, 13, 225, 595, 14, 522, 430, 264];
function ordinaryFlow(fireMember) {
  const h = setup();
  h.profile[SPEED_KEY][LEADER_GROUP] = fireMember;
  h.profile.rk_speed_pet_priority = { 130: [108, 522] };
  h.profile.rk_damage_levels = { 619: { manual: 43 } };
  for (const id of ordinaryIds) h.profile.rk_pet_configs[id] = {
    mode: 1, iv: { hp: false, attack: true, defense: false }, nature: { attack: 2, defense: 0 }, extra: 'ordinary-personal-keep'
  };
  const team = { id: 'ordinary-quick-team', team: ordinaryIds.slice(),
    petIVs: Object.fromEntries(ordinaryIds.map(id => [id, { hp: true, attack: false, defense: true }])),
    petNatures: Object.fromEntries(ordinaryIds.map(id => [id, { attack: 1, defense: 2 }])), extra: { unchanged: true } };
  h.storage.set('rk_team_config', JSON.stringify({ activeGroupId: team.id, groups: [team] }));
  h.storage.set('rk_fav_pets', JSON.stringify(ordinaryIds));
  h.seed(ordinaryHistory); h.render();
  const r = h.speed();
  r.node('tier-fixed').value = '30'; r.node('tier-fixed').dispatch('input');
  r.node('tier-percent').value = '20'; r.node('tier-percent').dispatch('input');
  r.node('tier-negnature-btn').click(); r.click('pet:619', 'iv'); r.level(79);
  assert.equal(h.priorityWrites().length, 0, 'startup and initial rendering do not migrate fallback priority');
  return { h, r, team };
}
function ordinarySelect(flow, source, side, event, id) {
  const { h } = flow;
  if (source === 'search') {
    const box = h.page.searchBoxes[side], name = h.RKData.getMonsterDisplayName(h.RKData.getMonsterById(id));
    h.common.type(box, name.slice(0, 1));
    assert.ok(h.common.ids(box).includes(id), 'actual CommonUI renders the requested search candidate');
    h.common.pick(box, id);
  } else {
    const container = { history: h.history, favorites: h.favorites, team: h.teamGrid }[source];
    const avatar = h.avatarIn(container, id); assert.ok(avatar, `rendered ${source} avatar ${id}`);
    const result = avatar.fire(event);
    if (event === 'contextmenu') assert.equal(result.prevented, true);
  }
}
function speedControls(r) {
  const state = r.api.getState();
  return Object.fromEntries(['iv', 'nature', 'negNature', 'fixed', 'percent', 'showMonsters', 'selectedCol', 'selectedSpeed', 'selectedLevel', 'selectedRowKey', 'mingSpeedLevel'].map(key => [key, state[key]]));
}
function fireRow(r, first, fireMember) {
  const row = r.row('130:60'), pool = r.pools().get('130:60'), strip = row.querySelector('.speed-avatar-strip');
  assert.equal(pool[0], first, 'complete sorted row pool consumes current-query/damage-priority order');
  assert.equal(strip.dataset.capacity, '1', 'actual production capacity(34px) yields one avatar');
  const buttons = strip.querySelectorAll('button.speed-tier-avatar');
  assert.equal(buttons.length, 1); assert.equal(Number(buttons[0].dataset.petId), first, 'first and only visible production button is the prioritized ordinary pet');
  assert.equal(buttons[0].getAttribute('aria-label'), monsters.find(pet => pet.id === first).localized.zh.name);
  assert.ok(pool.includes(fireMember)); assert.ok(!pool.includes(fireMember === 13 ? 14 : 13), 'ordinary selections cannot elect the suppressed fire member');
  return { pool, visible: buttons.map(button => Number(button.dataset.petId)) };
}
function sourceRecords(h) {
  return { personal: JSON.stringify(h.profile.rk_pet_configs), levels: JSON.stringify(h.profile.rk_damage_levels),
    team: h.storage.get('rk_team_config'), favorites: h.storage.get('rk_fav_pets'), viewUnknown: h.profile.rk_damage_view.skill.unknownViewKey };
}
for (const source of ['history', 'favorites', 'team']) for (const [side, prefix, event] of [
  ['attacker', 'atk', 'click'], ['defender', 'def', 'contextmenu']
]) test(`ordinary ${source} ${event} equals real damage search in joined speed pool/34px DOM, without changing history policy or fire13/14`, () => {
  const fireMember = side === 'attacker' ? 14 : 13;
  const quick = ordinaryFlow(fireMember), search = ordinaryFlow(fireMember), catalogBefore = JSON.stringify(monsters);
  const historyBefore = historySnapshot(quick.h), recordsBefore = sourceRecords(quick.h), controlsBefore = speedControls(quick.r);
  const row = quick.r.row('130:60'), mingRow = quick.r.row(), mingLower = quick.r.button(-1);
  let expectedPriority = ordinaryHistory.slice(), expectedHistory = ordinaryHistory.slice();
  for (const [index, id] of ordinaryIds.entries()) {
    const ownSpeedBefore = JSON.stringify(quick.h.profile.rk_speed_pet_priority), writesBefore = quick.h.priorityWrites().length;
    ordinarySelect(quick, source, side, event, id); ordinarySelect(search, 'search', side, event, id);
    expectedPriority = [id, ...expectedPriority.filter(value => value !== id)].slice(0, 16);
    assert.deepEqual(quick.h.speedPriority(), expectedPriority); assert.deepEqual(search.h.speedPriority(), expectedPriority);
    assert.deepEqual(plain(quick.h.profile.rk_damage_view.speedPriority), expectedPriority, 'independent numeric IDs are queued in the existing section root');
    assert.equal(quick.h.priorityWrites().length, writesBefore + 1, 'first explicit fallback seed and subsequent MRU changes save independently');
    assert.equal(JSON.stringify(quick.h.profile.rk_speed_pet_priority), ownSpeedBefore, 'damage does not rewrite speed-own MRU');
    assert.equal(quick.h.state[prefix + 'Pet'].id, id);
    assert.equal(quick.h.page.selectionTeams[side], source === 'team' ? quick.team.id : null);
    assert.equal(quick.h.profile.rk_damage_selection[side + 'Team'], source === 'team' ? quick.team.id : null);
    assert.equal(quick.h.state[prefix + 'IV'].hp, source === 'team');
    assert.equal(quick.h.state[prefix + 'Nature'].defense, source === 'team' ? 2 : 0);
    const priorityIndex = quick.h.writes.findLastIndex(write => write.key === 'rk_damage_view' && Object.hasOwn(write.patch, 'speedPriority'));
    assert.ok(quick.h.writes.slice(0, priorityIndex).some(write => write.key === 'rk_damage_selection' && write.patch[side] === id), 'role/team application precedes priority publication');
    quick.r.api.renderTierTable(); search.r.api.renderTierTable();
    assert.deepEqual(fireRow(quick.r, id, fireMember), fireRow(search.r, id, fireMember), 'quick and real search produce identical full pools and visible first buttons');
    assert.equal(quick.r.row('130:60'), row, 'ordinary row keeps stable DOM identity');
    assert.equal(quick.r.row(), mingRow); assert.equal(quick.r.button(-1), mingLower);
    assert.deepEqual(speedControls(quick.r), controlsBefore);
    if (source === 'history') assertHistoryUnchanged(quick.h, historyBefore);
    else {
      expectedHistory = [id, ...expectedHistory.filter(value => value !== id)].slice(0, 16);
      assert.deepEqual(Array.from(quick.h.state.searchedPets), expectedHistory);
      assert.equal(quick.h.storage.get('rk_searched_pets'), JSON.stringify(expectedHistory));
      assert.equal(quick.h.historyWrites(), historyBefore.writes + index + 1);
    }
    assert.equal(quick.h.preferenceWrites().length, 0); assertChoice(quick.h, fireMember);
    assert.deepEqual(sourceRecords(quick.h), recordsBefore);
  }
  // Actual SpeedPage query selection still wins over BOTH damage entry paths.
  for (const flow of [quick, search]) flow.r.search.onSelect(flow.h.RKData.getMonsterById(488));
  const queriedControls = speedControls(quick.r), ownSpeedWithQuery = JSON.stringify(quick.h.profile.rk_speed_pet_priority);
  for (const id of [225, 595]) {
    ordinarySelect(quick, source, side, event, id); ordinarySelect(search, 'search', side, event, id);
    quick.r.api.renderTierTable(); search.r.api.renderTierTable();
    assert.equal(quick.h.speedPriority()[0], id); assert.equal(search.h.speedPriority()[0], id);
    assert.deepEqual(fireRow(quick.r, 488, fireMember), fireRow(search.r, 488, fireMember));
    assert.equal(quick.r.api.getState().searchPetId, 488); assert.deepEqual(speedControls(quick.r), queriedControls);
    assert.equal(JSON.stringify(quick.h.profile.rk_speed_pet_priority), ownSpeedWithQuery);
  }
  if (source === 'history') assertHistoryUnchanged(quick.h, historyBefore);
  const savedPriority = quick.h.speedPriority(), writes = quick.h.priorityWrites().length;
  for (const flow of [quick, search]) {
    flow.r.search.onInput(''); // Real clear callback renders, no manual priority injection.
    fireRow(flow.r, 595, fireMember);
    flow.h.common.type(flow.h.page.searchBoxes[side], '');
    flow.h.page.onLeave(); flow.h.render();
    flow.r.api.onLeave(); flow.r.api.render(flow.r.container);
    fireRow(flow.r, 595, fireMember);
  }
  assert.deepEqual(quick.h.speedPriority(), savedPriority); assert.equal(quick.h.priorityWrites().length, writes);
  assert.deepEqual(sourceRecords(quick.h), recordsBefore); assert.equal(JSON.stringify(monsters), catalogBefore);
  assert.ok(quick.r.damageReads.length && quick.r.damageReads.every(key => key === 'searchedPets'));
  assert.ok(!quick.r.reads.some(key => ['rk_damage_levels', 'rk_pet_configs', 'rk_speed_view'].includes(key)));
  assert.equal(quick.h.profile[SPEED_KEY][LEADER_GROUP], fireMember); assert.deepEqual(quick.h.visibleChoice(), [fireMember]);
  for (const [key, value] of Object.entries(unrelatedChoices)) assert.equal(quick.h.profile[SPEED_KEY][key], value);
  assert.ok(quick.h.preferenceWrites().every(write => !Object.hasOwn(write.patch, LEADER_GROUP)), 'ordinary speed query may retain its old form patch, never rewrite fire choice');
  // A fresh actual damage/module/speed runtime consumes the serialized authority,
  // not the old page/module closure, regardless of the unchanged quick-history order.
  const restored = setup({ savedProfile: plain(quick.h.profile) });
  for (const [key, value] of quick.h.storage) restored.storage.set(key, value);
  restored.render(); const restartedSpeed = restored.speed();
  assert.deepEqual(restored.speedPriority(), savedPriority); fireRow(restartedSpeed, 595, fireMember);
  assert.equal(restored.priorityWrites().length, 0); assert.equal(restored.preferenceWrites().length, 0);
  assert.equal(restartedSpeed.api.getState().mingSpeedLevel, 99); assertChoice(restored, fireMember);
});

test('ordinary damage priority is ordering-only: slow quick selection never injects a speed query row, and dummy never records', () => {
  const h = setup(), slow = monsters.find(pet => pet.base_spd === 44 && !pet.hidden);
  assert.ok(slow, 'read-only catalog contains a slow candidate');
  h.seed([488, slow.id]); const r = h.speed(), before = historySnapshot(h);
  assert.equal(r.row('44:60'), undefined);
  h.avatar(slow.id).fire('click');
  assert.equal(h.state.atkPet.id, slow.id); assert.equal(h.speedPriority()[0], slow.id);
  r.api.renderTierTable();
  assert.equal(r.row('44:60'), undefined, 'damage priority cannot masquerade as a speed-page query');
  assert.equal(r.api.getState().search, ''); assert.equal(r.api.getState().searchPetId, null);
  fireRow(r, 488, 13); assertHistoryUnchanged(h, before);
  const writes = h.priorityWrites().length, priority = h.speedPriority();
  const dummy = h.freshTeam({ id: 'dummy-test', team: [9001] }).children[0];
  dummy.fire('click'); dummy.fire('contextmenu');
  assert.equal(h.priorityWrites().length, writes); assert.deepEqual(h.speedPriority(), priority);
});

test('FIRST history click 落陨星兔488 replaces 火神13 as the actual 34px first avatar, while uninitialized legacy history still starts13', () => {
  const h = setup(); h.profile[SPEED_KEY][LEADER_GROUP] = 13;
  h.seed([13, 488, 225, 595, 14]);
  assert.equal(Object.hasOwn(h.profile.rk_damage_view, 'speedPriority'), false, 'no independent list exists before first explicit selection');
  const r = h.speed(), before = historySnapshot(h), row = r.row('130:60');
  fireRow(r, 13, 13);
  assert.equal(h.priorityWrites().length, 0, 'initial render reads legacy fallback without initializing it');
  assert.equal(Object.hasOwn(h.profile.rk_damage_view, 'speedPriority'), false);
  h.avatar(488).fire('click'); // The FIRST quick callback must seed and promote immediately.
  assert.equal(h.state.atkPet.id, 488);
  assert.deepEqual(plain(h.profile.rk_damage_view.speedPriority), [488, 13, 225, 595, 14]);
  assert.equal(h.priorityWrites().length, 1, 'one first click publishes one independent list, without a second initializing choice');
  r.api.renderTierTable();
  fireRow(r, 488, 13); assert.equal(r.row('130:60'), row);
  assertHistoryUnchanged(h, before);
  assert.equal(JSON.parse(h.storage.get('rk_searched_pets'))[0], 13, 'serialized quick history still starts with 火神13');
  assert.equal(h.state.searchedPets[0], 13); assertChoice(h, 13);
  assert.equal(r.api.getState().search, ''); assert.equal(r.api.getState().searchPetId, null);
});

