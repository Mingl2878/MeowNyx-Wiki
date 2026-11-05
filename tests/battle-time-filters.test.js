'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Time = require('../js/battle-time-filters.js');
const source = fs.readFileSync(path.join(__dirname, '../js/battle-time-filters.js'), 'utf8');

const local = (year, month, day, hour = 4, minute = 0, second = 0, ms = 0) => new Date(year, month - 1, day, hour, minute, second, ms);
const civil = value => {
  const d = new Date(value);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
};
const assertLocal = (value, year, month, day, hour = 4) => assert.deepEqual(civil(value), [year, month, day, hour, 0, 0, 0]);

// Change this process's TZ only, restoring it after every synchronous check.
// No child process, shell, network, profile, database or persistent test fixtures.
function inZone(t, zone, expectedJanuaryOffset, run) {
  const previous = process.env.TZ;
  try {
    process.env.TZ = zone;
    if (local(2026, 1, 15).getTimezoneOffset() !== expectedJanuaryOffset) {
      t.skip('This Node runtime does not support process.env.TZ=' + zone);
      return;
    }
    run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('known anchor and season names use local 04:00 with eight contiguous weeks', () => {
  for (const [number, month, day, endMonth, endDay] of [[1, 3, 26, 5, 21], [2, 5, 21, 7, 16], [3, 7, 16, 9, 10], [4, 9, 10, 11, 5], [5, 11, 5, 12, 31]]) {
    const b = Time.bounds(number);
    assertLocal(b.from, 2026, month, day);
    assertLocal(b.to, 2026, endMonth, endDay);
    assert.equal(b.toExclusive, true);
    let last = b.from;
    for (let week = 1; week <= 8; week++) {
      const w = Time.bounds(number, week);
      assert.equal(w.from, last);
      assert.equal(new Date(w.from).getHours(), 4);
      assert.equal(new Date(w.to).getHours(), 4);
      assert.equal(w.toExclusive, true);
      last = w.to;
    }
    assert.equal(last, b.to);
  }
  assert.deepEqual(Time.seasons(local(2026, 12, 1)).map(s => s.name), ['S1', 'S2', '铅字幻梦', '月涌狂想', '圣龙宝藏']);
});

test('2026-11-02 is S4 W8, never a hard-coded S5', () => {
  const now = local(2026, 11, 2, 21, 43);
  assert.equal(Time.currentSeason(now), 4);
  const all = Time.seasons(now);
  assert.deepEqual(all.map(s => s.number), [1, 2, 3, 4]);
  assert.deepEqual(all.filter(s => s.current).map(s => s.number), [4]);
  assert.equal(all[3].weeks.length, 8);
  assert.deepEqual(all[3].weeks.filter(w => w.current).map(w => w.number), [8]);
  assert.ok(all.every(s => s.weeks.every(w => w.started)));
  assert.ok(all.slice(0, 3).every(s => s.weeks.every(w => !w.current)));
  assertLocal(all[3].weeks[7].start, 2026, 10, 29);
  assertLocal(all[3].weeks[7].end, 2026, 11, 5);
});

test('only started weeks are active in current season; no future season button', () => {
  const all = Time.seasons(local(2026, 9, 20));
  assert.equal(all.length, 4);
  assert.ok(all.slice(0, 3).every(s => s.weeks.every(w => w.started && !w.current)));
  assert.deepEqual(all[3].weeks.map(w => w.started), [true, true, false, false, false, false, false, false]);
  assert.deepEqual(all[3].weeks.map(w => w.current), [false, true, false, false, false, false, false, false]);
  assert.equal(Time.seasons(local(2026, 9, 10))[3].weeks[0].current, true);
});

test('midnight does not roll a season/week, exactly local 04:00 does', () => {
  for (const hour of [0, 1, 2, 3]) assert.equal(Time.currentSeason(local(2026, 11, 5, hour)), 4);
  assert.equal(Time.currentSeason(local(2026, 11, 5, 3, 59, 59, 999)), 4);
  assert.equal(Time.currentSeason(local(2026, 11, 5)), 5);
  assert.equal(Time.currentSeason(local(2026, 11, 5, 4, 0, 0, 1)), 5);
  const week = at => Time.seasons(at)[3].weeks.find(w => w.current).number;
  assert.equal(week(local(2026, 10, 29, 0)), 7);
  assert.equal(week(local(2026, 10, 29, 3, 59, 59, 999)), 7);
  assert.equal(week(local(2026, 10, 29)), 8);
});

test('before S1 yields null and no future buttons, including on its boundary morning', () => {
  for (const now of [local(1900, 1, 1), local(2025, 12, 31), local(2026, 3, 26, 0), local(2026, 3, 26, 3, 59, 59, 999)]) {
    assert.equal(Time.currentSeason(now), null);
    assert.deepEqual(Time.seasons(now), []);
  }
  assert.equal(Time.currentSeason(local(2026, 3, 26)), 1);
  const all = Time.seasons(local(2026, 3, 26));
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].weeks.map(w => w.started), [true, false, false, false, false, false, false, false]);
});

test('future numbering continues over December/January and leap years', () => {
  assert.equal(Time.currentSeason(local(2026, 12, 31, 3, 59)), 5);
  assert.equal(Time.currentSeason(local(2026, 12, 31)), 6);
  assert.equal(Time.currentSeason(local(2027, 1, 1)), 6);
  assertLocal(Time.bounds(6).from, 2026, 12, 31);
  assertLocal(Time.bounds(6).to, 2027, 2, 25);
  assert.equal(Time.currentSeason(local(2027, 2, 25)), 7);
  assert.equal(Time.seasons(local(2027, 1, 1)).at(-1).name, 'S6');
  for (const now of [local(2028, 2, 29), local(2035, 1, 1), local(2100, 3, 1)]) {
    const number = Time.currentSeason(now);
    const all = Time.seasons(now);
    assert.ok(Number.isInteger(number) && number > 7);
    assert.equal(all.length, number);
    assert.equal(all.at(-1).name, 'S' + number);
    assert.equal(all.at(-1).current, true);
    assert.equal(all.flatMap(s => s.weeks).filter(w => w.current).length, 1);
    const b = Time.bounds(number);
    assert.ok(new Date(b.from) <= now && now < new Date(b.to));
  }
});

test('explicit ISO conversion uses local zone rather than treating local 04:00 as UTC', t => {
  inZone(t, 'Asia/Shanghai', -480, () => {
    assert.deepEqual(Time.bounds(4), { from: '2026-09-09T20:00:00.000Z', to: '2026-11-04T20:00:00.000Z', toExclusive: true });
    assert.equal(Time.parseLocalDate('2026-11-02T04:00'), '2026-11-01T20:00:00.000Z');
    assert.equal(Time.localInput(new Date('2026-11-01T20:00:00.000Z')), '2026-11-02T04:00');
  });
});

test('DST fall changes elapsed duration, never local 04:00 or calendar week classification', t => {
  inZone(t, 'America/New_York', 300, () => {
    assert.equal(local(2026, 7, 15).getTimezoneOffset(), 240);
    const season = Time.bounds(4), week = Time.bounds(4, 8);
    assertLocal(season.from, 2026, 9, 10);
    assertLocal(season.to, 2026, 11, 5);
    assertLocal(week.from, 2026, 10, 29);
    assertLocal(week.to, 2026, 11, 5);
    assert.equal((new Date(season.to) - new Date(season.from)) / 3600000, 56 * 24 + 1);
    assert.equal((new Date(week.to) - new Date(week.from)) / 3600000, 7 * 24 + 1);
    assert.equal(Time.currentSeason(local(2026, 11, 5, 3, 59, 59, 999)), 4);
    assert.equal(Time.currentSeason(local(2026, 11, 5)), 5);
    assert.equal(Time.seasons(local(2026, 11, 2))[3].weeks[7].current, true);
    assert.equal(Time.parseLocalDate('2026-03-08T02:30'), null, 'nonexistent local DST minute');
    assert.equal(Time.parseLocalDate('2026-11-01T01:30'), '2026-11-01T05:30:00.000Z', 'earlier occurrence of repeated local minute');
    assert.equal(Time.currentSeason(new Date('2026-11-01T05:30:00.000Z')), 4);
    assert.equal(Time.currentSeason(new Date('2026-11-01T06:30:00.000Z')), 4);
  });
});

test('DST spring preserves seven/56 calendar days instead of elapsed-day arithmetic', t => {
  inZone(t, 'Europe/Berlin', -60, () => {
    assert.equal(local(2026, 7, 15).getTimezoneOffset(), -120);
    const season = Time.bounds(1), week = Time.bounds(1, 1);
    assertLocal(season.from, 2026, 3, 26);
    assertLocal(season.to, 2026, 5, 21);
    assertLocal(week.from, 2026, 3, 26);
    assertLocal(week.to, 2026, 4, 2);
    assert.equal((new Date(season.to) - new Date(season.from)) / 3600000, 56 * 24 - 1);
    assert.equal((new Date(week.to) - new Date(week.from)) / 3600000, 7 * 24 - 1);
    assert.equal(Time.seasons(local(2026, 4, 2, 3, 59))[0].weeks[0].current, true);
    assert.equal(Time.seasons(local(2026, 4, 2))[0].weeks[1].current, true);
    assert.equal(Time.parseLocalDate('2026-03-29T02:30'), null);
    for (let i = 1; i <= 20; i++) for (let w = 1; w <= 8; w++) {
      const b = Time.bounds(i, w);
      assert.equal(new Date(b.from).getHours(), 4);
      assert.equal(new Date(b.to).getHours(), 4);
    }
  });
});

test('exclusive end retains records immediately before the boundary at sub-ms precision', () => {
  const b = Time.bounds(4, 8);
  const fromNs = BigInt(new Date(b.from).getTime()) * 1000000n;
  const toNs = BigInt(new Date(b.to).getTime()) * 1000000n;
  const matches = startedAt => startedAt >= fromNs && (b.toExclusive ? startedAt < toNs : startedAt <= toNs);
  assert.equal(matches(fromNs - 1n), false);
  assert.equal(matches(fromNs), true);
  assert.equal(matches(toNs - 1n), true, 'last nanosecond remains within [from,to)');
  assert.equal(matches(toNs), false);
  assert.equal(b.to, Time.bounds(5).from);
});

test('all rank stops and strict index/value guards, nearest-stop ties are explicit', () => {
  assert.deepEqual(Array.from({ length: 101 }, (_, i) => Time.rankAt(i)), [1, ...Array.from({ length: 100 }, (_, i) => (i + 1) * 1000)]);
  for (let i = 0; i <= 100; i++) assert.equal(Time.rankIndex(Time.rankAt(i)), i);
  for (const [rank, index] of [[1, 0], [499, 0], [500, 0], [501, 1], [999, 1], [1499, 1], [1500, 2], [2001, 2], [99500, 100], [100000, 100]]) assert.equal(Time.rankIndex(rank), index);
  for (const value of [undefined, null, '', '1', '1000', false, true, NaN, Infinity, -Infinity, -1, 101, 0.5, Number.MAX_SAFE_INTEGER, 1e100, {}, [], Symbol('x'), 1n]) assert.equal(Time.rankAt(value), null);
  for (const value of [undefined, null, '', '1', '1000', false, true, NaN, Infinity, -Infinity, -1, 0, 100001, 1.5, Number.MAX_SAFE_INTEGER, 1e100, {}, [], Symbol('x'), 1n]) assert.equal(Time.rankIndex(value), null);
});

test('bounds reject invalid and huge phases before calendar arithmetic/list allocation', () => {
  for (const value of [undefined, null, '', '1', false, true, NaN, Infinity, -Infinity, -1, 0, 1.5, 53001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1e100, {}, [], Symbol('x'), 1n]) assert.equal(Time.bounds(value), null);
  for (const value of [null, '', '1', false, true, NaN, Infinity, -1, 0, 1.5, 9, Number.MAX_SAFE_INTEGER, {}, [], Symbol('x'), 1n]) assert.equal(Time.bounds(4, value), null);
  assert.deepEqual(Time.bounds(4, undefined), Time.bounds(4));
  assert.equal(Time.bounds(53000), null, 'even capped phases must keep both dates within year9999');
});

test('Date ranges are bounded, invalid input never coerces or creates future buttons', () => {
  const impostor = { valueOf() { throw Error('must not coerce'); }, getTime() { throw Error('not a Date'); } };
  for (const value of [null, '', '2026-11-02', 0, false, NaN, Infinity, 1e100, {}, [], impostor, Symbol('x'), 1n, new Date(NaN), new Date(8.64e15), local(1899, 12, 31), local(10000, 1, 1)]) {
    assert.equal(Time.currentSeason(value), null);
    assert.deepEqual(Time.seasons(value), []);
    assert.equal(Time.localInput(value), '');
  }
  // The furthest usable year remains a small integer count, not an unsafe loop.
  const number = Time.currentSeason(local(9999, 1, 1));
  assert.ok(Number.isSafeInteger(number) && number < 53000);
  assert.ok(Time.bounds(number));
  const farFuture = Time.seasons(local(9999, 1, 1));
  assert.equal(farFuture.length, number);
  assert.ok(farFuture.length * 8 < 424000, 'even year9999 cannot request an unbounded list');
  assert.equal(farFuture.at(-1).weeks.length, 8);
  assert.equal(farFuture.at(-1).current, true);
  assert.equal(Time.currentSeason(local(9999, 12, 31, 23, 59)), null, 'final incomplete season would cross year10000');
  assert.equal(Time.localInput(local(1900, 1, 1, 0)), '1900-01-01T00:00');
  assert.equal(Time.localInput(local(9999, 12, 31, 23, 59)), '9999-12-31T23:59');
});

test('local input formatting and strict parsing preserve valid minutes, reject normalization', () => {
  const date = local(2026, 11, 2, 9, 7, 59, 999);
  assert.equal(Time.localInput(date), '2026-11-02T09:07');
  assert.equal(Time.parseLocalDate('2026-11-02T09:07'), local(2026, 11, 2, 9, 7).toISOString());
  assert.equal(Time.parseLocalDate('2028-02-29T04:00'), local(2028, 2, 29).toISOString());
  for (const value of [undefined, null, 1, {}, '', ' 2026-11-02T04:00', '2026-11-02T04:00 ', '2026-11-02 04:00', '2026-11-02', '2026-1-02T04:00', '2026-11-02T4:00', '2026-11-02T04:00Z', '2026-11-02T04:00:00', '2026-11-02T04:00+08:00', '2026-02-29T04:00', '2026-02-30T04:00', '2026-04-31T04:00', '2026-00-01T04:00', '2026-13-01T04:00', '2026-11-00T04:00', '2026-11-32T04:00', '2026-11-02T24:00', '2026-11-02T04:60', '1899-12-31T23:59', '0000-01-01T00:00', '10000-01-01T00:00', '9'.repeat(100000)]) assert.equal(Time.parseLocalDate(value), null);
  assert.equal(Time.parseLocalDate('1900-01-01T00:00'), local(1900, 1, 1, 0).toISOString());
  assert.equal(Time.parseLocalDate('9999-12-31T23:59'), local(9999, 12, 31, 23, 59).toISOString());
});

test('caller Dates and nested results are isolated; API constants cannot be changed', () => {
  const date = Object.freeze(local(2026, 11, 2, 21, 43, 31, 123)), before = date.getTime();
  const first = Time.seasons(date), second = Time.seasons(date);
  assert.notEqual(first, second);
  assert.notEqual(first[3], second[3]);
  assert.notEqual(first[3].weeks, second[3].weeks);
  assert.notEqual(first[3].weeks[7], second[3].weeks[7]);
  assert.deepEqual(first, second);
  first[0].name = 'changed';
  first[3].weeks[7].start = 'changed';
  first[3].weeks.pop();
  first.push({ number: 100 });
  assert.deepEqual(Time.seasons(date), second);
  const b = Time.bounds(3);
  b.from = 'changed'; b.toExclusive = false;
  assert.notEqual(Time.bounds(3).from, 'changed');
  assert.equal(Time.bounds(3).toExclusive, true);
  Time.currentSeason(date); Time.localInput(date);
  assert.equal(date.getTime(), before);
  assert.ok(Object.isFrozen(Time));
  assert.throws(() => { Time.rankAt = () => 7; }, TypeError);
});

test('browser IIFE and CommonJS expose identical pure API without DOM or network', () => {
  const window = {};
  const blocked = () => { throw Error('module must not access host effects'); };
  const sandbox = { window, fetch: blocked, localStorage: { getItem: blocked, setItem: blocked }, document: new Proxy({}, { get: blocked }) };
  vm.runInNewContext(source, sandbox);
  assert.deepEqual(Object.keys(window.BattleTimeFilters).sort(), Object.keys(Time).sort());
  assert.equal(window.BattleTimeFilters.currentSeason(local(2026, 11, 2)), 4, 'accepts cross-realm real Dates');
  assert.equal(window.BattleTimeFilters.bounds(4).from, Time.bounds(4).from);
  assert.equal(window.BattleTimeFilters.rankAt(100), 100000);
  assert.ok(Object.isFrozen(window.BattleTimeFilters));
  const foreignDate = vm.runInNewContext('new Date(2026, 10, 2, 4)');
  assert.equal(Time.currentSeason(foreignDate), 4);
});

test('default now is sampled freshly at each call, not cached when module loads', () => {
  let now = local(2026, 11, 5, 3, 59, 59, 999).getTime();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
  }
  const context = { window: {}, Date: ClockDate };
  vm.runInNewContext(source, context);
  const api = context.window.BattleTimeFilters;
  assert.equal(api.currentSeason(), 4);
  assert.equal(api.seasons().length, 4);
  now = local(2026, 11, 5).getTime();
  assert.equal(api.currentSeason(), 5);
  assert.equal(api.seasons().length, 5);
  assert.equal(api.seasons().at(-1).weeks[0].current, true);
});
