/* Shared arithmetic only. Each page explicitly chooses which battle effects to include. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BattleMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // UI convention is “0.9”; arithmetic always uses the exact shared factor.
  const DAMAGE_FACTOR = 37 / 41;

  function normalizeLevel(level = 60) {
    const value = Number(level);
    return Number.isFinite(value) ? Math.max(1, Math.min(99, Math.round(value))) : 60;
  }

  function damageFactor(level = 60) {
    return (1000 + 45 * normalizeLevel(level)) / 4100;
  }

  function statFromBase(base, stat, nature = 0, iv = false, level = 60) {
    // Preserve the existing checkbox API. Exact IV values have a separate API.
    return statFromEffectiveIV(base, stat, nature, iv ? 60 : 0, level);
  }

  function statFromEffectiveIV(base, stat, nature = 0, effectiveIV = 0, level = 60) {
    if (!Number.isInteger(effectiveIV) || effectiveIV < 0 || effectiveIV > 60) return NaN;
    // Displayed +10 is effective IV60; the formula adds IV/2, never IV twice.
    const individual = effectiveIV / 2;
    level = normalizeLevel(level);
    const naturePercent = nature === 1 ? 120 : nature === 2 ? 90 : 100;
    const hp = stat === 'hp';
    // Form the integer coefficient numerator first, avoiding binary-FP half
    // underestimates (e.g. L8: .58*25); L69:119*150/100 must round178.5 to179.
    const coefficient = hp ? 2 * level + 50 : level + 50;
    const scaled = floorRatio([coefficient, base + individual], [100], true);
    return floorRatio([scaled + (hp ? level + 10 : 10), naturePercent], [100], true) + (hp ? 100 : 50);
  }

  function basePower(power, fixed = 0, percent = 0) {
    return floorRatio([power + fixed, 100 + percent], [100], true);
  }

  function buffMultiplier(percent) {
    return percent >= 0 ? 1 + percent / 100 : 1 / (1 + Math.abs(percent) / 100);
  }

  function finalPower(power, fixed, percent, sameType = 1, effectiveness = 1, buff = 0) {
    return floorRatio([basePower(power, fixed, percent), sameType, effectiveness, buff >= 0 ? 100 + buff : 100],
      [buff >= 0 ? 100 : 100 + Math.abs(buff)], true);
  }

  // Decimal inputs are rationals; floor only once at the end. BigInt prevents an
  // exact integer boundary (e.g. 41*37/41) slipping below it through binary FP.
  function decimalFraction(value) {
    const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
    const decimalPlaces = (mantissa.split('.')[1] || '').length;
    let numerator = BigInt(mantissa.replace('.', ''));
    const scale = decimalPlaces - Number(exponent);
    if (scale < 0) numerator *= 10n ** BigInt(-scale);
    return [numerator, scale > 0 ? 10n ** BigInt(scale) : 1n];
  }

  function floorRatio(factors, divisors, round = false) {
    if (![...factors, ...divisors].every(Number.isFinite) || divisors.some(x => x === 0)) {
      return (round ? Math.round : Math.floor)(factors.reduce((a, b) => a * b, 1) / divisors.reduce((a, b) => a * b, 1));
    }
    let numerator = 1n, denominator = 1n;
    for (const value of factors) {
      const [n, d] = decimalFraction(value); numerator *= n; denominator *= d;
    }
    for (const value of divisors) {
      const [n, d] = decimalFraction(value); numerator *= d; denominator *= n;
    }
    if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
    // Math.round's tie direction is +Infinity: floor(x + 1/2), including negatives.
    if (round) { numerator = 2n * numerator + denominator; denominator *= 2n; }
    const quotient = numerator / denominator;
    return Number(quotient - (numerator < 0n && numerator % denominator !== 0n ? 1n : 0n));
  }

  // Unrounded per-hit reference ONLY. Actual damage must use normalDamage below.
  function normalDamageRaw(attack, power, defense, reduction = 1, level = 60, effectiveness = 1) {
    return power * attack * damageFactor(level) * reduction * effectiveness / defense;
  }

  function normalDamage(attack, power, defense, reduction = 1, combo = 1, level = 60, effectiveness = 1) {
    return floorRatio([power, attack, 1000 + 45 * normalizeLevel(level), reduction, effectiveness], [4100, defense]) * combo;
  }

  // One separate Illusion hit: no STAB, ordinary power additions, or combo.
  function starMeteorDamage(base, attack, defense, buff = 1, effectiveness = 1, reduction = 1, level = 60) {
    return floorRatio([base, attack, 1000 + 45 * normalizeLevel(level), buff, effectiveness, reduction], [4100, defense]);
  }

  // Confirmed speed/physical-defense difference tiers; difference is not absolute.
  function differencePower(diff) {
    if (!Number.isFinite(diff) || diff <= 0) return 60;
    if (diff <= 30) return 80;
    if (diff <= 60) return 100;
    if (diff <= 90) return 120;
    if (diff <= 120) return 140;
    if (diff <= 150) return 150;
    if (diff <= 180) return 160;
    if (diff <= 210) return 170;
    if (diff <= 240) return 180;
    if (diff <= 270) return 190;
    return 200;
  }

  return { DAMAGE_FACTOR, normalizeLevel, damageFactor, normalDamageRaw, statFromBase, statFromEffectiveIV, basePower, buffMultiplier, finalPower, normalDamage, starMeteorDamage, differencePower };
});
