/* Pure local-calendar season/rank helpers. No DOM, IO, profile or clock cache. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BattleTimeFilters = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const LIMITS = Object.freeze({ minYear: 1900, maxYear: 9999, maxSeasons: 53000, seasonDays: 56, weekDays: 7, weeks: 8 });
  const ANCHOR = Object.freeze({ number: 3, year: 2026, month: 6, day: 16, hour: 4 });
  const NAMES = Object.freeze({ 3: '铅字幻梦', 4: '月涌狂想', 5: '圣龙宝藏' });
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const usable = date => Number.isFinite(date.getTime()) && integer(date.getFullYear(), LIMITS.minYear, LIMITS.maxYear);

  // Date.prototype accepts cross-realm Dates but not strings, numbers or duck types.
  function copyDate(value) {
    try {
      const date = new Date(Date.prototype.getTime.call(value));
      return usable(date) ? date : null;
    } catch (_) { return null; }
  }

  // UTC is used only as a timezone-independent civil-day ordinal. Never add an
  // elapsed 56*24 hours to a local instant: DST would shift the 04:00 boundary.
  function civilDay(date) {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  }
  const S1_DAY = Math.floor(Date.UTC(ANCHOR.year, ANCHOR.month, ANCHOR.day) / 86400000) - (ANCHOR.number - 1) * LIMITS.seasonDays;

  function boundary(season, weekOffset) {
    const date = new Date(ANCHOR.year, ANCHOR.month, ANCHOR.day, ANCHOR.hour, 0, 0, 0);
    date.setDate(date.getDate() + (season - ANCHOR.number) * LIMITS.seasonDays + weekOffset * LIMITS.weekDays);
    date.setHours(ANCHOR.hour, 0, 0, 0);
    return usable(date) && date.getHours() === ANCHOR.hour ? date : null;
  }

  function period(season, week) {
    if (!integer(season, 1, LIMITS.maxSeasons) || (week !== undefined && !integer(week, 1, LIMITS.weeks))) return null;
    const start = boundary(season, week === undefined ? 0 : week - 1);
    const end = boundary(season, week === undefined ? LIMITS.weeks : week);
    return start && end ? { start, end } : null;
  }

  function seasonNumber(date) {
    // A civil boundary day still belongs to the previous season before 04:00.
    const day = civilDay(date) - (date.getHours() < ANCHOR.hour ? 1 : 0);
    const number = Math.floor((day - S1_DAY) / LIMITS.seasonDays) + 1;
    if (!integer(number, 1, LIMITS.maxSeasons)) return null;
    const span = period(number);
    return span && date >= span.start && date < span.end ? number : null;
  }

  function currentSeason(now = new Date()) {
    const date = copyDate(now);
    return date ? seasonNumber(date) : null;
  }

  function seasons(now = new Date()) {
    const date = copyDate(now);
    const currentNumber = date ? seasonNumber(date) : null;
    // Validate before allocating, including rejecting unsafe/unusable dates.
    if (currentNumber === null) return [];
    const result = [];
    for (let number = 1; number <= currentNumber; number++) {
      const span = period(number);
      if (!span) return [];
      const weeks = [];
      for (let week = 1; week <= LIMITS.weeks; week++) {
        const range = period(number, week);
        if (!range) return [];
        weeks.push({
          number: week,
          start: range.start.toISOString(),
          end: range.end.toISOString(),
          started: date >= range.start,
          current: date >= range.start && date < range.end
        });
      }
      result.push({ number, name: NAMES[number] || 'S' + number, start: span.start.toISOString(), end: span.end.toISOString(), weeks, current: number === currentNumber });
    }
    return result;
  }

  function bounds(season, week) {
    const span = period(season, week);
    // Keep the original next boundary: subtracting 1ms loses sub-ms records.
    return span ? { from: span.start.toISOString(), to: span.end.toISOString(), toExclusive: true } : null;
  }

  function rankAt(index) {
    return integer(index, 0, 100) ? (index === 0 ? 1 : index * 1000) : null;
  }

  function rankIndex(value) {
    if (!integer(value, 1, 100000)) return null;
    if (value < 1000) return value - 1 < 1000 - value ? 0 : 1;
    // Closest stop, with exact midpoint ties toward the larger numeric rank.
    return Math.floor((value + 500) / 1000);
  }

  function localInput(value) {
    const date = copyDate(value);
    if (!date) return '';
    const pad = number => String(number).padStart(2, '0');
    return String(date.getFullYear()).padStart(4, '0') + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function parseLocalDate(value) {
    if (typeof value !== 'string' || value.length !== 16) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]), hour = Number(match[4]), minute = Number(match[5]);
    if (!integer(year, LIMITS.minYear, LIMITS.maxYear) || !integer(month, 1, 12) || !integer(day, 1, 31) || !integer(hour, 0, 23) || !integer(minute, 0, 59)) return null;
    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    // Reject impossible dates and nonexistent DST wall times, not normalize them.
    if (!usable(date) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) return null;
    return date.toISOString();
  }

  return Object.freeze({ currentSeason, seasons, bounds, rankAt, rankIndex, localInput, parseLocalDate });
});
