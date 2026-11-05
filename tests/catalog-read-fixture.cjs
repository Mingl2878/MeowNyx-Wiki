'use strict';
// Read-only Node test resources. Only the four exact legacy data paths are
// projected through the production reader; JS/CSS/other JSON remain raw text.
// No adapters for external sources, persistent test data, or profile access.
const fs = require('node:fs');
const path = require('node:path');
const { readDataFile, readLegacy } = require('../scripts/lib/catalog-data.js');
const names = new Set(['monsters.json', 'moves.json', 'types.json', 'wiki_monster_data.json']);
function readResource(root, filename) {
  const file = path.resolve(root, filename);
  if (path.dirname(file) === path.resolve(root, 'data') && names.has(path.basename(file))) {
    return JSON.stringify(readDataFile(root, file));
  }
  return fs.readFileSync(file, 'utf8');
}
function readProjectData(filename) {
  return readDataFile(path.resolve(__dirname, '..'), filename);
}
module.exports = { readResource, readProjectData, readDataFile, readLegacy };
