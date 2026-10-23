#!/usr/bin/env node
// ---------------------------------------------------------------------------
// build-species-index.js
//
// Builds models/species-index.json: for each of Perch's 14,595 species,
// its English common name, whether it's a bird (or a frog, insect, ...),
// a photo with its photographer credit and licence, its order and family,
// its conservation status, and - for birds - a short description from
// Wikipedia. The web page shows these when you click a species card.
//
// Like download-model.js this is NEVER run automatically. You run it on
// purpose with:
//
//     npm run build-species-index
//
// It takes roughly 15-25 minutes and produces a file of about 10 MB. If
// it's interrupted, run it again - it picks up where it left off.
//
// Where the information comes from:
//
//   1. Wikidata (query.wikidata.org) - the free knowledge base behind
//      Wikipedia. We look up each scientific name and get its English name,
//      its photo, its taxonomic class (Aves = birds, Amphibia = frogs,
//      Insecta = insects, ...), order and family, its IUCN conservation
//      status ("Least Concern", "Endangered", ...), and the title of its
//      English Wikipedia article. Wikidata's data is public domain (CC0),
//      so it's safe to use commercially without credit.
//
//   2. Wikimedia Commons (commons.wikimedia.org) - where those photos live.
//      Each photo has its OWN licence (usually CC BY or CC BY-SA), which
//      requires crediting the photographer. We fetch the photographer's
//      name and licence so the web page can show a credit line under each
//      photo. We store only the photo's web address, not the photo itself.
//      The browser only downloads a photo if you switch "Show photos" on.
//
//   3. English Wikipedia (en.wikipedia.org) - the first few sentences of
//      each bird's article, stored in the index so the page can show them
//      without going online. Wikipedia text is licensed CC BY-SA 4.0,
//      which requires a credit and link - the page shows both.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const MODELS_DIR = path.join(__dirname, '..', 'models');
const LABELS_PATH = path.join(MODELS_DIR, 'labels.csv');
const OUTPUT_PATH = path.join(MODELS_DIR, 'species-index.json');

// Progress is saved here after every batch, so an interrupted run can
// resume. It's deleted once the finished index has been written.
const PARTIAL_PATH = path.join(MODELS_DIR, 'species-index.partial.json');

// The index format version. Version 2 added order, family, conservation
// status and Wikipedia descriptions. The web page checks this to know
// whether those details are available. A saved partial run from an older
// version is ignored and the build starts afresh.
const INDEX_VERSION = 2;

// Wikimedia asks every program that uses its services to identify itself
// with a descriptive "User-Agent", so they can contact the author if the
// program misbehaves. Anonymous/generic agents may be blocked.
const USER_AGENT = 'MyBackyard/0.1 (bird identification proof of concept; https://github.com/aussieguy)';

// How many species to look up per Wikidata query, photos per Commons
// request (50 is the most the Commons API allows in one request), and
// articles per Wikipedia request (20 is the most for article intros).
const WIKIDATA_BATCH = 150;
const COMMONS_BATCH = 50;
const WIKIPEDIA_BATCH = 20;

// Wikidata's codes for the taxonomic ranks we want. (Wikidata identifies
// everything by "Q" numbers rather than by name.)
const RANK = { class: 'Q37517', order: 'Q36602', family: 'Q35409' };

// Species names look like "Turdus merula" (Genus species) or occasionally
// "Genus species subspecies". The other 200 labels are sound categories
// such as "Dog" or "Male_speech_and_man_speaking", which aren't in Wikidata.
const SPECIES_NAME = /^[A-Z][a-z]+( [a-z][a-z-]*){1,2}$/;

// Taxonomic classes we recognise, in priority order. Order matters:
// Wikidata places birds inside BOTH Aves and Reptilia (birds evolved from
// reptiles), so Aves must be checked first.
const CLASS_TO_KIND = [
  ['Aves', 'bird'],
  ['Amphibia', 'amphibian'],
  ['Insecta', 'insect'],
  ['Mammalia', 'mammal'],
  ['Reptilia', 'reptile'],
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Splits a list into chunks: chunk([1,2,3,4,5], 2) -> [[1,2],[3,4],[5]]
function chunk(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

// fetch() with automatic retries. Public services occasionally reply
// "too busy" (HTTP 429) or have a hiccup (HTTP 5xx); waiting and trying
// again is the polite and expected response. Each retry waits longer.
async function fetchJson(url, options = {}) {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...options.headers },
      });
      if (response.ok) return await response.json();

      // 4xx errors other than 429 mean our request is wrong - retrying
      // won't help, so give up straight away.
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      // Network errors (e.g. Wi-Fi drop) also land here.
      if (attempt === maxAttempts) throw error;
    }
    const waitSeconds = 5 * attempt;
    console.log(`  (service busy or unreachable - retrying in ${waitSeconds} s)`);
    await sleep(waitSeconds * 1000);
  }
}

// Escapes a name for safe use inside a SPARQL string literal "...".
function sparqlString(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Removes HTML tags and tidies spaces. Commons returns photographer names
// as HTML, e.g. '<a href="...">Jane Smith</a>' -> 'Jane Smith'.
function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Step 1: Wikidata - common names, photos and classes
// ---------------------------------------------------------------------------

// Builds the Wikidata query for one batch of scientific names.
//
// In plain English, for each name it asks: find the Wikidata item whose
// "taxon name" (property P225) is this name; give me its English label, its
// English "taxon common names" (P1843), its photo (P18), its IUCN
// conservation status (P141), the title of its English Wikipedia article,
// and - walking up the "parent taxon" chain (P171) - every ancestor whose
// "taxon rank" (P105) is class, order or family, with its English label.
//
// The answer comes back as one row per COMBINATION of values (e.g. 3 common
// names x 2 photos x 4 ancestors = 24 rows for one species). lookUpBatch()
// below merges those rows back into one entry per species. (Asking Wikidata
// to merge them with GROUP BY made its query engine crash with a
// "StackOverflowError", so we do it ourselves.)
function buildQuery(names) {
  return `
SELECT ?name ?item ?label ?common ?image ?statusLabel ?wikiTitle ?rank ?ancName ?ancLabel WHERE {
  VALUES ?name { ${names.map(sparqlString).join(' ')} }
  ?item wdt:P225 ?name .
  OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label) = "en") }
  OPTIONAL { ?item wdt:P1843 ?common FILTER(LANG(?common) = "en") }
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?item wdt:P141 ?status . ?status rdfs:label ?statusLabel FILTER(LANG(?statusLabel) = "en") }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?wikiTitle }
  OPTIONAL {
    ?item wdt:P171* ?anc .
    # Performance hint: walk UP from each species to its ancestors, rather
    # than down from "all birds" (which timed out in testing).
    hint:Prior hint:gearing "forward" .
    ?anc wdt:P105 ?rank ; wdt:P225 ?ancName .
    FILTER(?rank IN (wd:${RANK.class}, wd:${RANK.order}, wd:${RANK.family}))
    OPTIONAL { ?anc rdfs:label ?ancLabel FILTER(LANG(?ancLabel) = "en") }
  }
}`;
}

// Works out the 'kind' (bird, amphibian, ...) from a list of class names.
function kindFromClasses(classes) {
  for (const [className, kind] of CLASS_TO_KIND) {
    if (classes.includes(className)) return kind;
  }
  return 'other';
}

// Chooses the nicest English common name.
//
// Wikidata labels are usually lower case ("tawny owl"), while the "taxon
// common name" list has proper capitalisation ("Tawny Owl") but may hold
// several alternatives ("Eurasian Blackbird", "Common Blackbird",
// "Blackbird"). So: prefer the common name that matches the label; else
// the label (if it's a real common name, not just the scientific name
// again); else the first common name; else nothing.
//
// The same name is sometimes listed twice in different capitalisation
// ("White-throated Sparrow" and "white-throated sparrow"), so among
// matches we prefer one that starts with a capital letter.
function chooseCommonName(scientificName, label, commons) {
  const startsUpper = (c) => c.charAt(0) !== c.charAt(0).toLowerCase();
  const byCapital = [...commons].sort((a, b) => startsUpper(b) - startsUpper(a));
  const labelIsCommonName = label && label.toLowerCase() !== scientificName.toLowerCase();
  if (labelIsCommonName) {
    const matching = byCapital.find((c) => c.toLowerCase() === label.toLowerCase());
    return matching || label;
  }
  return byCapital[0] || null;
}

// Small words that stay lower case inside a bird name ("Nightingale of
// the Woods"), as in printed bird books.
const SMALL_WORDS = new Set(['of', 'the', 'and', 'de', 'del', 'la', 'du', 'des', 'von', 'van', 'in', 'on', 'or']);

// Gives names consistent capitalisation:
//   birds  -> Title Case, the bird-book convention: "White-throated Sparrow"
//             (the part after a hyphen stays lower case, as in "White-throated")
//   others -> just a capital first letter: "Eastern dwarf tree frog"
// Words that already contain capitals (e.g. "Swainson's", "Perijá") are
// left as they are.
function tidyCommonName(name, kind) {
  if (!name) return name;
  if (kind !== 'bird') return name.charAt(0).toUpperCase() + name.slice(1);
  return name
    .split(' ')
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

// "least concern" -> "Least Concern" (the IUCN Red List's own style).
function titleCase(text) {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

// The photo comes back as a web address like
//   http://commons.wikimedia.org/wiki/Special:FilePath/Magpie%20samcem05.jpg
// We just want the file name: "Magpie samcem05.jpg".
function fileNameFromImageUrl(url) {
  if (!url) return null;
  return decodeURIComponent(url.split('/Special:FilePath/')[1] || '') || null;
}

// Looks up one batch of names and returns { name: entry } for those found.
async function lookUpBatch(names) {
  const json = await fetchJson('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query: buildQuery(names) }),
  });

  // First, merge the rows into one record per Wikidata item, collecting
  // each item's distinct values into Sets (a Set ignores duplicates) and
  // its order/family into Maps of { scientific name -> English label }.
  const items = new Map();
  for (const row of json.results.bindings) {
    const id = row.item.value;
    let item = items.get(id);
    if (!item) {
      item = {
        name: row.name.value, label: null, wikiTitle: null,
        commons: new Set(), images: new Set(), statuses: new Set(),
        classes: new Set(), orders: new Map(), families: new Map(),
      };
      items.set(id, item);
    }
    if (row.label) item.label = row.label.value;
    if (row.wikiTitle) item.wikiTitle = row.wikiTitle.value;
    if (row.common) item.commons.add(row.common.value);
    if (row.image) item.images.add(row.image.value);
    if (row.statusLabel) item.statuses.add(row.statusLabel.value);
    if (row.rank) {
      const rank = row.rank.value.split('/').pop(); // ".../entity/Q37517" -> "Q37517"
      const ancName = row.ancName.value;
      if (rank === RANK.class) item.classes.add(ancName);
      if (rank === RANK.order) item.orders.set(ancName, row.ancLabel?.value || null);
      if (rank === RANK.family) item.families.set(ancName, row.ancLabel?.value || null);
    }
  }

  // Taxonomists sometimes disagree, so an item can have two orders or
  // families in Wikidata. We take the alphabetically first so re-running
  // the script always gives the same answer.
  const first = (values) => [...values].sort()[0] || null;

  // Then turn each item into the entry we store.
  const found = {};
  for (const [id, item] of items) {
    const kind = kindFromClasses([...item.classes]);
    const orderName = first(item.orders.keys());
    const orderLabel = orderName ? item.orders.get(orderName) : null;
    const status = first(item.statuses);
    const entry = {
      common: tidyCommonName(chooseCommonName(item.name, item.label, [...item.commons]), kind),
      kind,
      wikidata: id.split('/').pop(), // e.g. "Q25334"
      // If an item has several photos, pick the alphabetically first so
      // re-running the script always chooses the same one.
      photoFile: fileNameFromImageUrl(first(item.images)),
      // e.g. { name: "Passeriformes", common: "Passerines" }. The English
      // label is only kept if it's a real common name, not the Latin again.
      order: orderName ? {
        name: orderName,
        common: orderLabel && orderLabel.toLowerCase() !== orderName.toLowerCase() ? titleCase(orderLabel) : null,
      } : null,
      // Family English names are filled in later (step 2) - Wikidata's
      // labels for families are almost always just the Latin name.
      familyName: first(item.families.keys()),
      status: status ? titleCase(status) : null,
      wikiTitle: item.wikiTitle,
    };

    // Occasionally two different Wikidata items share a scientific name
    // (e.g. an animal and a plant genus). Keep the animal: a bird beats
    // anything; any animal beats 'other'.
    const existing = found[item.name];
    const rank = (e) => (e.kind === 'bird' ? 2 : e.kind === 'other' ? 0 : 1);
    if (!existing || rank(entry) > rank(existing)) found[item.name] = entry;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Step 2: Wikimedia Commons - photo addresses, photographers and licences
// ---------------------------------------------------------------------------

async function lookUpPhotos(fileNames) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    // Ask for a 500-pixel-wide version rather than the full original
    // (which can be 20+ MB). 500 is one of Wikimedia's standard sizes.
    iiurlwidth: '500',
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl',
    titles: fileNames.map((f) => `File:${f}`).join('|'),
  });
  const json = await fetchJson(`https://commons.wikimedia.org/w/api.php?${params}`);

  // Commons may "normalise" titles we send (e.g. underscores -> spaces).
  // This maps the returned title back to the title we asked for.
  const askedFor = {};
  for (const n of json.query?.normalized || []) askedFor[n.to] = n.from;

  const photos = {};
  for (const page of Object.values(json.query?.pages || {})) {
    const info = page.imageinfo?.[0];
    if (!info) continue; // file missing or deleted
    const title = askedFor[page.title] || page.title;
    const meta = info.extmetadata || {};
    photos[title.replace(/^File:/, '')] = {
      // The image itself (500 px wide). Commons adds tracking tags to the
      // address ("?utm_source=..."); they aren't needed, so we drop them.
      thumb: (info.thumburl || info.url).split('?')[0],
      page: info.descriptionurl,             // the photo's page on Commons
      artist: stripHtml(meta.Artist?.value) || 'Unknown photographer',
      license: meta.LicenseShortName?.value || 'See Commons page',
      licenseUrl: meta.LicenseUrl?.value || null,
    };
  }
  return photos;
}

// ---------------------------------------------------------------------------
// Step 2: Wikidata again - English names for families
//
// Families rarely have an English "common name" in Wikidata, but their
// Wikipedia article title is often one: Alcedinidae -> "Kingfisher",
// Meliphagidae -> "Honeyeater". So for each family we ask for both and
// use whichever exists.
// ---------------------------------------------------------------------------

async function lookUpFamilies(familyNames) {
  const query = `
SELECT ?name ?common ?wikiTitle WHERE {
  VALUES ?name { ${familyNames.map(sparqlString).join(' ')} }
  ?family wdt:P225 ?name ; wdt:P105 wd:${RANK.family} .
  OPTIONAL { ?family wdt:P1843 ?common FILTER(LANG(?common) = "en") }
  OPTIONAL { ?article schema:about ?family ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?wikiTitle }
}`;
  const json = await fetchJson('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query }),
  });

  const found = {};
  for (const row of json.results.bindings) {
    const name = row.name.value;
    if (found[name]) continue; // keep the first answer for each family
    // Article titles can have a clarifying note in brackets, e.g.
    // "Thrush (bird)" - drop it.
    const title = row.wikiTitle?.value.replace(/\s*\(.*\)$/, '');
    const fromTitle = title && title.toLowerCase() !== name.toLowerCase() ? title : null;
    const common = row.common?.value || fromTitle;
    if (common) found[name] = titleCase(common);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Step 4: Wikipedia - a short description of each bird
// ---------------------------------------------------------------------------

// Fetches the first three sentences of up to 20 articles at once, as plain
// text. Returns { title-we-asked-for: { extract, url } }.
async function lookUpExtracts(titles) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    prop: 'extracts|info',
    exintro: '1',       // only the introduction, before the first heading
    explaintext: '1',   // plain text rather than HTML
    exsentences: '3',
    exlimit: String(WIKIPEDIA_BATCH),
    inprop: 'url',      // also give us each article's web address
    redirects: '1',     // follow redirects ("Blackbird" -> "Common blackbird")
    titles: titles.join('|'),
  });
  const json = await fetchJson(`https://en.wikipedia.org/w/api.php?${params}`);

  // Wikipedia may tidy a title we sent (normalise) and/or follow a redirect
  // to a different article. Work backwards from each article it returns to
  // the title we originally asked for.
  const backTo = {};
  for (const n of json.query?.normalized || []) backTo[n.to] = n.from;
  for (const r of json.query?.redirects || []) backTo[r.to] = backTo[r.from] || r.from;

  const found = {};
  for (const page of Object.values(json.query?.pages || {})) {
    if (!page.extract) continue; // missing article, or no introduction
    const asked = backTo[page.title] || page.title;
    found[asked] = {
      // Plain-text conversion leaves empty brackets where pronunciation
      // guides used to be, e.g. "The kookaburra ( ) is" - tidy those away.
      extract: page.extract.replace(/\s*\(\s*[;,]?\s*\)/g, '').trim(),
      url: page.fullurl,
    };
  }
  return found;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(LABELS_PATH)) {
    throw new Error('labels.csv not found. Run  npm run download-model  first.');
  }

  const labels = fs.readFileSync(LABELS_PATH, 'utf8').trimEnd().split('\n').slice(1).map((l) => l.trim());
  const speciesNames = labels.filter((l) => SPECIES_NAME.test(l));
  console.log(`${speciesNames.length} species names to look up.`);

  // Resume from a previous interrupted run, if there is one (and it was
  // made by this version of the script).
  let progress = fs.existsSync(PARTIAL_PATH) ? JSON.parse(fs.readFileSync(PARTIAL_PATH, 'utf8')) : null;
  if (!progress || progress.version !== INDEX_VERSION) {
    progress = { version: INDEX_VERSION, doneBatches: 0, species: {}, families: {}, photos: {}, extracts: {} };
  }
  const save = () => fs.writeFileSync(PARTIAL_PATH, JSON.stringify(progress));

  // --- Step 1: Wikidata - species --------------------------------------------
  const batches = chunk(speciesNames, WIKIDATA_BATCH);
  if (progress.doneBatches > 0) console.log(`Resuming at batch ${progress.doneBatches + 1}.`);
  console.log('\nStep 1 of 4: names, categories and details from Wikidata');
  for (let i = progress.doneBatches; i < batches.length; i++) {
    Object.assign(progress.species, await lookUpBatch(batches[i]));
    progress.doneBatches = i + 1;
    save();
    process.stdout.write(`\r  batch ${i + 1} of ${batches.length}  (${Object.keys(progress.species).length} found)`);
    // A short pause between queries keeps us well inside Wikidata's
    // fair-use limits for a shared public service.
    await sleep(500);
  }
  process.stdout.write('\n');

  // --- Step 2: Wikidata - family names ---------------------------------------
  const familyNames = [...new Set(Object.values(progress.species).map((s) => s.familyName).filter(Boolean))];
  const familiesToDo = familyNames.filter((f) => !(f in progress.families));
  console.log(`\nStep 2 of 4: English names for ${familiesToDo.length} families from Wikidata`);
  const familyBatches = chunk(familiesToDo, WIKIDATA_BATCH);
  for (let i = 0; i < familyBatches.length; i++) {
    const found = await lookUpFamilies(familyBatches[i]);
    // Record every family we asked about - null if no English name - so a
    // resumed run doesn't ask again.
    for (const f of familyBatches[i]) progress.families[f] = found[f] || null;
    save();
    process.stdout.write(`\r  batch ${i + 1} of ${familyBatches.length}`);
    await sleep(500);
  }
  process.stdout.write('\n');

  // --- Step 3: Commons -------------------------------------------------------
  const wanted = [...new Set(Object.values(progress.species).map((s) => s.photoFile).filter(Boolean))];
  const missing = wanted.filter((f) => !(f in progress.photos));
  console.log(`\nStep 3 of 4: photo credits from Wikimedia Commons (${missing.length} photos)`);
  const photoBatches = chunk(missing, COMMONS_BATCH);
  for (let i = 0; i < photoBatches.length; i++) {
    const found = await lookUpPhotos(photoBatches[i]);
    for (const f of photoBatches[i]) progress.photos[f] = found[f] || null;
    save();
    process.stdout.write(`\r  batch ${i + 1} of ${photoBatches.length}`);
    await sleep(300);
  }
  process.stdout.write('\n');

  // --- Step 4: Wikipedia - bird descriptions ---------------------------------
  // Birds only: they're the only species shown as cards on the page.
  const articleTitles = [...new Set(Object.values(progress.species)
    .filter((s) => s.kind === 'bird' && s.wikiTitle).map((s) => s.wikiTitle))];
  const articlesToDo = articleTitles.filter((t) => !(t in progress.extracts));
  console.log(`\nStep 4 of 4: descriptions of ${articlesToDo.length} birds from Wikipedia`);
  const articleBatches = chunk(articlesToDo, WIKIPEDIA_BATCH);
  for (let i = 0; i < articleBatches.length; i++) {
    const found = await lookUpExtracts(articleBatches[i]);
    for (const t of articleBatches[i]) progress.extracts[t] = found[t] || null;
    save();
    process.stdout.write(`\r  batch ${i + 1} of ${articleBatches.length}`);
    await sleep(300);
  }
  process.stdout.write('\n');

  // --- Combine and write the final index -------------------------------------
  const species = {};
  let withPhoto = 0;
  let withDescription = 0;
  for (const [name, s] of Object.entries(progress.species)) {
    const photo = s.photoFile ? progress.photos[s.photoFile] || null : null;
    const wiki = s.kind === 'bird' && s.wikiTitle ? progress.extracts[s.wikiTitle] || null : null;
    if (photo) withPhoto++;
    if (wiki) withDescription++;
    species[name] = {
      common: s.common,
      kind: s.kind,
      wikidata: s.wikidata,
      photo,
      order: s.order,
      family: s.familyName ? { name: s.familyName, common: progress.families[s.familyName] || null } : null,
      status: s.status,
      wiki, // { extract, url } or null
    };
  }

  const index = {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    sources: {
      names: 'Wikidata (CC0 public domain)',
      photos: 'Wikimedia Commons (licence per photo - see each entry)',
      descriptions: 'English Wikipedia (CC BY-SA 4.0 - credit and link required)',
    },
    species,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(index));
  fs.rmSync(PARTIAL_PATH, { force: true });

  const birds = Object.values(species).filter((s) => s.kind === 'bird').length;
  console.log(`\nDone. ${Object.keys(species).length} of ${speciesNames.length} species found ` +
    `(${birds} birds), ${withPhoto} with photos, ${withDescription} bird descriptions.`);
  console.log(`Saved to ${OUTPUT_PATH}`);
}

// Run only when started directly (npm run build-species-index), not when
// another file loads this one with require() - e.g. to test a function.
if (require.main === module) {
  main().catch((error) => {
    console.error(`\nError: ${error.message}`);
    console.error('Progress so far has been saved - run the script again to resume.');
    process.exit(1);
  });
}

module.exports = {
  buildQuery, lookUpBatch, lookUpFamilies, lookUpPhotos, lookUpExtracts,
  chooseCommonName, tidyCommonName, kindFromClasses,
};
