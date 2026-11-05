'use strict';
// Independently reviewed S5 tables, not generated from the catalog under test.
const bloodline = [33,94,120,147,183,191,220,244,275,287,318,327,350,374,390,405,441,453];
const rows = groups => Object.entries(groups).flatMap(([source,ids]) => ids.map(skill_id => ({skill_id,source})));
const mingulongSkills = rows({'默认':[388,12,547,48,5,5934,391,5976,392,5975,5987,250,485], '技能石':[387,484,399,241,251,419,421,359,539,52,9,28,25], '血脉':bloodline, '传说':[5977]});
const abuSkills = rows({'默认':[31,12,48,58,5979,242,69,52,251,5978,245,249,254], '技能石':[241,507,500,121,356,362,354,172,171,7,45,25,5975], '血脉':bloodline});
const newSkillDispositions = {
  ordinary: [5965,5979],
  'base-only': [5966,5967,5969,5970,5974,5975,5977,5980,5981,5983,5986,5988,5990],
  'non-attack': [5963,5964,5968,5971,5972,5973,5976,5978,5982,5984,5985,5987,5989,5991]
};
module.exports = {mingulongSkills,abuSkills,newSkillDispositions};
