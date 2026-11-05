'use strict';
const crypto = require('node:crypto');
// Fingerprints derived once from the immutable pre-S5 source, SHA256 below.
// No backup path or external client bytes are needed to run delivered tests.
// Recursive object keys are sorted, but array/row/source order remains protected.
const originalCatalogSha256 = '0f9211a0bff1600cbd1a46a5564e1f107164953ac8173b06585a82a642680542';
const legacySkillIds = [...Array.from({length:553},(_,i)=>i+1),5931,5932,5933,5934,5935,5936,5938,5940,5941,5943,5944,5945,5947,5948,5949,5951,5952,5954,5955,5956,5957,5958,5959,5960,5961,5962];
const calibratedMonsterIds = Array.from({length:622},(_,i)=>i+1).filter(id=>id!==619);
const authorizedAvatarIds = [10,14,18,68,71,79,114,175,198,203,209,223,247,323,357,362,410,435,437];
const hashes = Object.freeze({
  monsters:'bbe9eb006b01ffccca63a77e5d967f6718d73fb5228512ad6d32ce224f15eafc',
  skills:'caf909689b032504f2b329b70770136ed97c14d34afbeca79cefdf8ca88780c9',
  skill_variant_rows:'8c16921d3ca784459990d97cd3afc5824a81597e4002868a93357ad42e391a4d',
  traits:'1e08e48a2348247093429253daa2f420a0dcc086f6f866dd0654134f18637060',
  learnsets:'463146999817b07e8f12721ced93890b3bf887df909788a1818928d615a7b2b4',
  skill_rules:'690b9c156ba1ac0e4940023eb57ee09f3f6c4e5580267b640a392b6ee954ced8',
  types:'6c8169c413ca6179d968aec626646cb5d474c12f768bd384d009513e253a93fd',
  mieli_calibration:'167ee2b88eb7a7a82c8bc0e5e249c47f420d03efb36b5fbd189a4c384ad077d7',
  tencent_source_baseline:'4f29e1cf0e855bac7e9159cfa347879377a31056400b5cd3c1effa4c2ea9b5e3'
});
function fingerprint(value) {
  const json = JSON.stringify(value, (_,v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])) : v);
  return crypto.createHash('sha256').update(json).digest('hex');
}
function originalMonsterView(monsters) {
  return monsters.filter(m=>calibratedMonsterIds.includes(m.id)).map(m=>{
    const row=JSON.parse(JSON.stringify(m));
    // Only these exact user-authorized image roles are excluded, not all images.
    if(authorizedAvatarIds.includes(row.id))delete row.images.avatar;
    if(row.id===410)delete row.images.portrait;
    return row;
  });
}
module.exports = {originalCatalogSha256,legacySkillIds,calibratedMonsterIds,authorizedAvatarIds,hashes,fingerprint,originalMonsterView};
