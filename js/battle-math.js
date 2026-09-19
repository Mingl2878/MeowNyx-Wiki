/* Shared arithmetic only. Each page explicitly chooses which battle effects to include. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BattleMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // UI convention is “0.9”; arithmetic always uses the exact shared factor.
  const DAMAGE_FACTOR = 37 / 41;

  function statFromBase(base, stat, nature = 0, iv = false) {
    const individual = iv ? 30 : 0;
    const natureMultiplier = nature === 1 ? 1.2 : nature === 2 ? 0.9 : 1;
    const hp = stat === 'hp';
    return Math.round((Math.round((hp ? 1.7 : 1.1) * (base + individual)) + (hp ? 70 : 10)) * natureMultiplier) + (hp ? 100 : 50);
  }

  function basePower(power, fixed = 0, percent = 0) {
    return Math.floor((power + fixed) * (1 + percent / 100));
  }

  function buffMultiplier(percent) {
    return percent >= 0 ? 1 + percent / 100 : 1 / (1 + Math.abs(percent) / 100);
  }

  function finalPower(power, fixed, percent, sameType = 1, effectiveness = 1, buff = 0) {
    return Math.floor(basePower(power, fixed, percent) * sameType * effectiveness * buffMultiplier(buff));
  }

  function normalDamage(attack, power, defense, reduction = 1, combo = 1) {
    const attackPower = Math.ceil(power * attack);
    const corrected = Math.ceil(attackPower * DAMAGE_FACTOR);
    const reduced = Math.ceil(corrected * reduction);
    return Math.ceil(reduced / defense) * combo;
  }

  // Meteor is a separate Illusion-type hit: no STAB, ordinary power additions, or combo multiplication.
  function starMeteorDamage(base, attack, defense, buff = 1, effectiveness = 1, reduction = 1) {
    const attackPower = Math.ceil(base * attack);
    const corrected = Math.ceil(attackPower * DAMAGE_FACTOR);
    const buffed = Math.ceil(corrected * buff);
    const reduced = Math.ceil(buffed * effectiveness * reduction);
    return Math.ceil(reduced / defense);
  }

  // Confirmed existing tiers, shared by speed_diff and phy_def_diff.
  function differencePower(diff) {
    if (diff < 0) return 60;
    if (diff < 15) return 100;
    if (diff < 30) return 130;
    if (diff < 45) return 140;
    if (diff < 60) return 150;
    if (diff < 75) return 160;
    if (diff < 90) return 170;
    if (diff < 105) return 180;
    if (diff < 120) return 190;
    if (diff < 135) return 194;
    return 200;
  }

  return { DAMAGE_FACTOR, statFromBase, basePower, buffMultiplier, finalPower, normalDamage, starMeteorDamage, differencePower };
});
