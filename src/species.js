// ---------------------------------------------------------------------------
// species.js
//
// Turns a raw Perch label into something friendlier to display.
//
//   "Dacelo novaeguineae"  ->  { common: "Laughing Kookaburra", kind: "bird", photo: {...} }
//   "Male_speech_and_man_speaking"  ->  { common: "Male speech and man speaking", kind: "sound" }
//
// Common names, kinds and photos come from models/species-index.json, which
// is built on request by `npm run build-species-index`. If that file
// doesn't exist yet everything still works - species just show their
// scientific names, without photos, and can't be told apart from frogs or
// insects (their kind is "unknown").
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const INDEX_PATH = path.join(__dirname, '..', 'models', 'species-index.json');

// Same pattern as in build-species-index.js: "Genus species" (optionally
// with a subspecies). Perch's other 200 labels are general sound categories.
const SPECIES_NAME = /^[A-Z][a-z]+( [a-z][a-z-]*){1,2}$/;

// ---------------------------------------------------------------------------
// loadSpeciesIndex()
//
// Reads the index once at start-up. Returns an object with:
//   available - true if the index file exists
//   describe(label) - see below
// ---------------------------------------------------------------------------
function loadSpeciesIndex() {
  let species = {};
  let available = false;
  if (fs.existsSync(INDEX_PATH)) {
    species = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')).species || {};
    available = true;
  }

  // -------------------------------------------------------------------------
  // describe(label)
  //
  // Returns { label, scientific, common, kind, photo } where:
  //   scientific - the scientific name, or null for a sound category
  //   common     - English name (null if unknown)
  //   kind       - 'bird', 'amphibian', 'insect', 'mammal', 'reptile',
  //                'other' (another living thing), 'unknown' (not in the
  //                index), or 'sound' (a general sound category)
  //   photo      - { thumb, page, artist, license, licenseUrl } or null
  // -------------------------------------------------------------------------
  function describe(label) {
    if (!SPECIES_NAME.test(label)) {
      // A sound category, e.g. "Car_passing_by" -> "Car passing by".
      return { label, scientific: null, common: label.replace(/_/g, ' '), kind: 'sound', photo: null };
    }
    const info = species[label];
    return {
      label,
      scientific: label,
      common: info?.common || null,
      kind: info?.kind || 'unknown',
      photo: info?.photo || null,
    };
  }

  return { available, describe };
}

module.exports = { loadSpeciesIndex };
