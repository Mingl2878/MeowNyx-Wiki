/* Pure, form-local personal configuration policy. No storage or team side effects. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetConfiguration = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function defaults(pet) {
    const hp = Number(pet?.base_hp) || 0;
    const attack = Number(pet?.base_phy_atk) || 0;
    const magic = Number(pet?.base_mag_atk) || 0;
    const speed = Number(pet?.base_spd) || 0;
    const both = Math.abs(attack - magic) <= 20;
    const higher = attack >= magic ? 'attack' : 'magic_attack';
    const iv = { hp: true }, nature = {};
    if (both) { iv.attack = true; iv.magic_attack = true; }
    else iv[higher] = true;
    if (speed < 85) iv.defense = true;
    if (speed < 115) {
      const maxAttack = Math.max(attack, magic);
      if (hp > maxAttack) nature.hp = 1;
      else if (maxAttack > hp) {
        if (both) { nature.attack = 1; nature.magic_attack = 1; }
        else nature[higher] = 1;
      }
    }
    return { mode: 0, iv, nature };
  }
  function resolve(pet, record) {
    if (record == null || record.mode === 0) return defaults(pet);
    // Even an empty pre-mode record is intentional manual configuration.
    return { mode: 1, iv: { ...(record.iv || {}) }, nature: { ...(record.nature || {}) } };
  }
  return Object.freeze({ defaults, resolve });
});
