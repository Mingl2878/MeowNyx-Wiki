/* Reviewed system-action display metadata. No catalog IDs, inference or IO. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BattleSystemActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const types = Object.freeze(['','普通','草','火','水','光','地','冰','龙','电','毒','虫','武','翼','萌','幽','恶','机械','幻']);
  const wishText = '造成伤害，伤害类型取决于精灵双攻更高的一项，应对状态：本次威力+150%。';
  const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  function metadata(kind, typeId = null, context = {}) {
    if (kind === 'charge') return { kind, name:'聚能', description:'获得5点能量。', energyCost:0, power:null, category:'status', categoryLabel:'状态', typeId:null, icon:'assets/system-actions/charge.webp', iconPath:'assets/system-actions/charge.webp' };
    if (kind !== 'wishImpact') return null;
    const id = Number.isInteger(typeId) && typeId >= 1 && typeId <= 18 ? typeId : null;
    let category = 'adaptive', categoryLabel = '物攻/魔攻';
    if (context.statsVerified === true && finite(context.attack) && finite(context.magicAttack)) {
      if (context.attack > context.magicAttack) { category = 'physical'; categoryLabel = '物攻'; }
      else if (context.magicAttack > context.attack) { category = 'magic'; categoryLabel = '魔攻'; }
    }
    const icon = id === null ? null : `assets/system-actions/wish-${id}.png`;
    return { kind, name:'愿力冲击', description:wishText, energyCost:2, power:80, counterPower:200,
      category, categoryLabel, typeId:id, typeLabel:id === null ? '属性未确认' : types[id], icon, iconPath:icon };
  }
  function isStunSkip(event) {
    // User-confirmed exact protocol identity, not a label/prefix or local skill.
    // Match the backend exclusion, including legacy omitted zero/class fields.
    return !!event && event.protocolSkillId === '700001200' &&
      (event.skillId === undefined || event.skillId === 0) && event.kind === 'skill' &&
      ['executed', 'interrupted'].includes(event.phase) &&
      (event.skillClass === undefined || ['', 'unknown', 'ordinary', 'response'].includes(event.skillClass));
  }
  function resolve(event, context = {}) {
    if (!event || typeof event !== 'object' || isStunSkip(event)) return null;
    // A typed usage bucket is already an explicit normalized system identity.
    if (event.kind === 'wishImpact') return metadata('wishImpact', event.typeId, context);
    const action = event.kind === 'skill' || event.kind === 'effect' && event.skillClass === 'system';
    if (!action) return null;
    const wish = event.combat?.actionKind === 'wishImpact';
    if (event.protocolSkillId === '700001000') return wish ? null : metadata('charge');
    return wish ? metadata('wishImpact', event.combat.typeId, context) : null;
  }
  return Object.freeze({ metadata, resolve, isStunSkip, isNoAction: isStunSkip });
});
