'use strict';

// Read-only compatibility views. catalog.json is authoritative whenever it
// exists; malformed/future catalogs never fall back to stale legacy files.
const fs = require('node:fs');
const path = require('node:path');
const { toLegacy } = require('../../js/catalog-data.js');

const LEGACY_FILES = Object.freeze({
  'monsters.json': 'monsters',
  'moves.json': 'moves',
  'types.json': 'types',
  'wiki_monster_data.json': 'wiki'
});

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readCatalog(root) {
  const file = path.resolve(root, 'data', 'catalog.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return { value: JSON.parse(text) };
}

// Returns parsed legacy shapes: {monsters, moves, types, wiki}. Never writes,
// downloads, merges, or substitutes an empty collection for a failed read.
function readLegacy(root) {
  const catalog = readCatalog(root);
  if (catalog) return toLegacy(catalog.value);
  const result = {};
  for (const [filename, key] of Object.entries(LEGACY_FILES)) {
    result[key] = readJSON(path.resolve(root, 'data', filename));
  }
  return result;
}

// filename is normally a name relative to root/data; an absolute file path is
// also accepted. Only the four files in that exact data directory are projected.
// Unknown files are read as ordinary JSON, with their original errors intact.
function readDataFile(root, filename) {
  if (typeof filename !== 'string' || !filename) throw new TypeError('filename must be a nonempty string');
  const directory = path.resolve(root, 'data');
  const file = path.isAbsolute(filename) ? path.resolve(filename) : path.resolve(directory, filename);
  const name = path.basename(file);
  const key = path.dirname(file) === directory && Object.prototype.hasOwnProperty.call(LEGACY_FILES, name) && LEGACY_FILES[name];
  if (key) {
    const catalog = readCatalog(root);
    if (catalog) return toLegacy(catalog.value)[key];
  }
  return readJSON(file);
}

module.exports = { readLegacy, readDataFile };
