// ---------------------------------------------------------------------------
// app.js - everything that happens in the web page
//
// How it fits together:
//
//   server --(live messages)--> this file --(updates)--> the page
//   page controls --(commands)--> server
//
// The server sends three kinds of message (see src/engine.js):
//   status    - listening / paused / error, plus current settings
//   level     - microphone loudness, ~10 times a second
//   detection - Perch's results for one 5-second window
//
// When the page connects, the server first sends a 'history' message: the
// last 48 hours of detections, which the server keeps in memory (never on
// disk). We hold them all in the `windows` list, which is what lets the
// threshold slider, the "Show" period and "Sort by" re-arrange everything
// instantly. Reloading the page fetches the history again; stopping the
// server forgets it.
// ---------------------------------------------------------------------------

'use strict';

// --- Settings -----------------------------------------------------------------

// If the same bird is heard again within this many milliseconds, it counts
// as the same visit rather than a new one. With overlapping windows one
// call is often detected 2-3 times in a row - this stops those inflating
// the count.
const VISIT_GAP_MS = 15000;

// How long after a detection the hero card says "Now hearing" before it
// switches to "Last heard ... ago".
const NOW_MS = 10000;

// Most rows shown in the live feed (older ones drop off the bottom).
const FEED_MAX_ROWS = 200;

// How long detections are kept: 48 hours, matching the server, which is
// the longest period the "Show" menu offers.
const HISTORY_MS = 48 * 60 * 60 * 1000;

// The "Show" menu's periods: how far back each looks (null = everything
// the server remembers, i.e. since MyBackyard started, up to 48 hours),
// and the heading shown above the species cards.
const RANGES = {
  session: { ms: null, heading: 'Heard this session' },
  hour: { ms: 60 * 60 * 1000, heading: 'Heard in the last hour' },
  day: { ms: 24 * 60 * 60 * 1000, heading: 'Heard in the last 24 hours' },
  twoDays: { ms: 48 * 60 * 60 * 1000, heading: 'Heard in the last 48 hours' },
};

// Number of bars in the level meter.
const METER_BARS = 20;

// Labels for the tag shown on non-bird rows in the feed.
const KIND_TAGS = {
  amphibian: 'Frog',
  insect: 'Insect',
  mammal: 'Mammal',
  reptile: 'Reptile',
  other: 'Wildlife',
  sound: 'Other sound',
};

// --- State: everything the page knows ---------------------------------------

const state = {
  threshold: 0.20,     // the slider, as 0..1
  showPhotos: false,   // the "Show photos" switch
  windows: [],         // every detection received, oldest first
  status: null,        // latest status message from the server
  heroKey: null,       // which detection the hero card is showing
  range: 'session',    // the "Show" menu (a key of RANGES)
  sort: 'recent',      // the "Sort by" menu (a key of SORTS, further down)
};

// Shortcut for document.getElementById.
const $ = (id) => document.getElementById(id);

// --- Small helpers -----------------------------------------------------------

// Creates an element with a class and (optionally) text. We always set text
// with textContent - never innerHTML - so names or photo credits coming
// from the internet can never inject code into the page.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// Birds are the main event. 'unknown' means "not in the species index" -
// without the index we can't tell birds from frogs, so we show them all as
// birds (most of Perch's species are birds).
const isBird = (result) => result.kind === 'bird' || result.kind === 'unknown';

// Best name to show: the common name if we have one, else the scientific.
const displayName = (r) => r.common || r.scientific || r.label;

const percent = (confidence) => `${Math.round(confidence * 100)}%`;

const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const shortTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// "just now", "45 s ago", "3 min ago", "2 h ago"
function timeAgo(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

// Turns a species name into a hue (0-359) so each species always gets the
// same placeholder colour. It's a tiny "hash": mixes the letters into a
// number. The exact maths doesn't matter, only that it's consistent.
function hueFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

// --- Bird pictures ---------------------------------------------------------------

// Fills a container with the bird drawing on the species' colour, and - if
// photos are switched on and one exists - a photo that fades in over it
// once loaded. If the same photo is already showing, nothing changes (so
// the image doesn't flicker when the card is refreshed).
function setArt(container, result) {
  container.classList.add('art');
  container.style.setProperty('--h', hueFor(result.label));

  if (!container.querySelector('svg')) {
    container.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#bird"/></svg>');
  }

  const wanted = state.showPhotos && result.photo ? result.photo.thumb : null;
  let img = container.querySelector('img');
  if (!wanted) {
    if (img) img.remove();
    return;
  }
  if (img && img.dataset.src === wanted) return;
  if (!img) {
    img = el('img');
    img.alt = displayName(result);
    // Don't tell Wikimedia which page the request came from.
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    container.appendChild(img);
  }
  img.classList.remove('loaded');
  img.dataset.src = wanted;
  img.onload = () => img.classList.add('loaded');
  img.onerror = () => img.remove(); // fall back to the drawing
  img.src = wanted;
}

// "Photo: Jane Smith · CC BY-SA 4.0", linked to the photo's Commons page.
function setCredit(container, result) {
  container.replaceChildren();
  if (!state.showPhotos || !result.photo) return;
  const p = result.photo;
  container.append('Photo: ');
  const link = el('a', null, p.artist);
  link.href = p.page;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  container.append(link, ` · ${p.license}`);
}

// --- Working out the session from the detections --------------------------------

// The earliest time included in a period, e.g. "24 hours ago" for 'day'.
// For 'session' that's 0, i.e. the beginning of time - include everything.
function cutoffFor(range) {
  const ms = RANGES[range].ms;
  return ms === null ? 0 : Date.now() - ms;
}

// Finds the position of the first window at or after `time` in the
// windows list. Because the list is in time order we can use a "binary
// search": check the middle, then throw away the half that can't contain
// the answer, and repeat. Finding a spot among 170,000 windows takes ~17
// steps instead of up to 170,000.
function firstWindowFrom(time) {
  let low = 0;
  let high = state.windows.length;
  while (low < high) {
    const middle = (low + high) >> 1; // >> 1 halves and rounds down
    if (state.windows[middle].time < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Goes through the windows in a period (oldest first) and builds one
// summary per bird species, using only results at or above the threshold:
//   visits - separate visits (see VISIT_GAP_MS)
//   best   - highest confidence heard
//   first / last - times first and most recently heard
//   info   - names/photo (from the most recent detection)
function summariseSpecies(range) {
  const species = new Map();
  for (let i = firstWindowFrom(cutoffFor(range)); i < state.windows.length; i++) {
    const w = state.windows[i];
    for (const r of w.results) {
      if (r.confidence < state.threshold || !isBird(r)) continue;
      let s = species.get(r.label);
      if (!s) {
        s = { info: r, visits: 0, best: 0, first: w.time, last: 0 };
        species.set(r.label, s);
      }
      if (w.time - s.last > VISIT_GAP_MS) s.visits++;
      s.best = Math.max(s.best, r.confidence);
      s.last = w.time;
      s.info = r;
    }
  }
  return species;
}

// The most recent window containing at least one bird above the threshold,
// with those birds sorted best-first. Returns null if there isn't one.
function latestBirdWindow() {
  for (let i = state.windows.length - 1; i >= 0; i--) {
    const w = state.windows[i];
    const birds = w.results.filter((r) => isBird(r) && r.confidence >= state.threshold);
    if (birds.length) return { window: w, birds: birds.sort((a, b) => b.confidence - a.confidence) };
  }
  return null;
}

// --- Rendering: the hero card ----------------------------------------------------

function renderHero(speciesSummary) {
  const hero = $('hero');
  const latest = latestBirdWindow();
  hero.dataset.state = state.status?.state || 'starting';

  // No bird yet: show the listening animation with a message that
  // matches the current state.
  if (!latest) {
    $('hero-idle').hidden = false;
    $('hero-bird').hidden = true;
    state.heroKey = null;
    const s = state.status?.state;
    $('hero-idle-title').textContent =
      s === 'paused' ? 'Paused' :
      s === 'error' ? 'Something went wrong' :
      s === 'finished' ? 'Recording finished' :
      'Listening for birds';
    $('hero-idle-sub').textContent =
      s === 'error' ? state.status.message :
      s === 'paused' ? 'Press Resume to start listening again.' :
      state.windows.length ? 'No birds above the threshold yet. Try lowering it.' :
      'The first results appear about five seconds after listening starts.';
    return;
  }

  const top = latest.birds[0];
  const summary = speciesSummary.get(top.label);
  $('hero-idle').hidden = true;
  const bird = $('hero-bird');
  bird.hidden = false;

  // Replay the entrance animation only when a different species takes over.
  const key = top.label;
  if (key !== state.heroKey) {
    bird.classList.remove('enter');
    void bird.offsetWidth; // forces the browser to notice the removal, so the animation can restart
    bird.classList.add('enter');
  }
  state.heroKey = key;

  setArt($('hero-photo'), top);
  $('hero-name').textContent = displayName(top);
  $('hero-sci').textContent = top.common ? top.scientific : '';

  // Ring: the full circle's length is 263.9, so 75% confidence leaves
  // 25% of it "undrawn".
  $('ring-fill').style.strokeDashoffset = String(263.9 * (1 - top.confidence));
  $('ring-value').textContent = percent(top.confidence);

  const visits = summary?.visits || 1;
  $('hero-visits').textContent = `${visits} ${visits === 1 ? 'visit' : 'visits'} this session`;
  $('hero-first').textContent = summary ? `First heard at ${shortTime(summary.first)}` : '';

  // Other birds heard in the same 5 seconds.
  const also = $('hero-also');
  also.replaceChildren();
  for (const r of latest.birds.slice(1, 4)) {
    const chip = el('span', 'chip');
    chip.append(el('b', null, displayName(r)), ` ${percent(r.confidence)}`);
    also.appendChild(chip);
  }

  setCredit($('hero-credit'), top);
  renderHeroEyebrow();
}

// "Now hearing · 14:03:27" for 10 seconds, then "Last heard · 2 min ago".
// Separate from renderHero so a timer can refresh just this line.
function renderHeroEyebrow() {
  const latest = latestBirdWindow();
  if (!latest) return;
  const eyebrow = $('hero-eyebrow');
  const fresh = Date.now() - latest.window.time < NOW_MS;
  eyebrow.textContent = fresh
    ? `Now hearing · ${clockTime(latest.window.time)}`
    : `Last heard · ${timeAgo(latest.window.time)}`;
  eyebrow.classList.toggle('past', !fresh);
}

// --- Rendering: the visitors grid ------------------------------------------------

// The "Sort by" options. Each is a comparison function, the standard way
// JavaScript's sort() is told what order to use: given two species
// summaries a and b, return a negative number if a should come first, or
// positive if b should. Ties fall back to most recently heard first.
const byRecent = (a, b) => b.last - a.last;
const SORTS = {
  recent: byRecent,
  mostVisits: (a, b) => b.visits - a.visits || byRecent(a, b),
  fewestVisits: (a, b) => a.visits - b.visits || byRecent(a, b),
  confidence: (a, b) => b.best - a.best || byRecent(a, b),
  // localeCompare sorts text alphabetically the way people expect,
  // e.g. ignoring upper/lower case.
  name: (a, b) => displayName(a.info).localeCompare(displayName(b.info)) || byRecent(a, b),
};

// Cards are kept and reused (one per species) rather than rebuilt each
// time, so photos don't reload and the "ping" animation can play.
const visitorCards = new Map();

function renderVisitors(speciesSummary, justHeard = new Set()) {
  const grid = $('visitor-grid');
  const sorted = [...speciesSummary.values()].sort(SORTS[state.sort]);
  $('visitor-heading').textContent = RANGES[state.range].heading;

  // Remove cards for species no longer above the threshold.
  for (const [label, card] of visitorCards) {
    if (!speciesSummary.has(label)) { card.remove(); visitorCards.delete(label); }
  }

  for (const s of sorted) {
    let card = visitorCards.get(s.info.label);
    if (!card) {
      card = el('article', 'visitor card');
      const art = el('div');
      const body = el('div', 'visitor-body');
      body.append(el('h3', 'visitor-name'), el('p', 'visitor-sci'));
      const stats = el('div', 'visitor-stats');
      stats.append(el('span', 'pill'), el('span', 'visits'), el('span', 'ago'));
      body.appendChild(stats);
      card.append(art, body);
      visitorCards.set(s.info.label, card);
    }
    setArt(card.firstChild, s.info);
    card.querySelector('.visitor-name').textContent = displayName(s.info);
    card.querySelector('.visitor-sci').textContent = s.info.common ? s.info.scientific : '';
    card.querySelector('.pill').textContent = percent(s.best);
    card.querySelector('.visits').textContent = `${s.visits} ${s.visits === 1 ? 'visit' : 'visits'}`;
    card.querySelector('.ago').textContent = timeAgo(s.last);
    card.querySelector('.ago').dataset.time = s.last;
    card.title = `Best ${percent(s.best)} · first heard ${shortTime(s.first)}`;

    // appendChild on an existing card MOVES it - this puts every card in
    // sorted order without recreating anything.
    grid.appendChild(card);

    if (justHeard.has(s.info.label)) {
      card.classList.remove('ping');
      void card.offsetWidth; // restart the animation
      card.classList.add('ping');
    }
  }

  $('visitor-empty').hidden = sorted.length > 0;
  $('visitor-empty').textContent = state.range === 'session'
    ? 'Birds you hear will collect here.'
    : 'No birds above the threshold in this period.';
  $('visitor-count').textContent = sorted.length ? `${sorted.length} species` : '';
}

// --- Rendering: the live feed ----------------------------------------------------

// Builds one feed row for a result.
function feedRow(windowTime, r, isNew) {
  const li = el('li', isBird(r) ? '' : 'other');
  if (isNew) li.classList.add('new');
  li.dataset.time = windowTime; // lets pruneFeed() find rows that have aged out

  li.appendChild(el('span', 'feed-time', clockTime(windowTime)));

  const name = el('div', 'feed-name');
  const title = el('span', 'name', displayName(r));
  if (!isBird(r)) title.appendChild(el('span', 'tag', KIND_TAGS[r.kind] || 'Other'));
  name.appendChild(title);
  if (r.common && r.scientific) name.appendChild(el('span', 'sub', r.scientific));
  const bar = el('div', 'feed-bar');
  const fill = el('span');
  fill.style.width = `${Math.round(r.confidence * 100)}%`;
  bar.appendChild(fill);
  name.appendChild(bar);
  li.appendChild(name);

  li.appendChild(el('span', 'feed-pct', percent(r.confidence)));
  return li;
}

// Rebuilds the whole feed (used when the threshold or period changes).
// Works backwards from the newest window, stopping at the start of the
// chosen period or once there are enough rows.
function renderFeed() {
  const feed = $('feed');
  const rows = [];
  const cutoff = cutoffFor(state.range);
  for (let i = state.windows.length - 1; i >= 0 && rows.length < FEED_MAX_ROWS; i--) {
    const w = state.windows[i];
    if (w.time < cutoff) break;
    for (const r of w.results) {
      if (r.confidence >= state.threshold) rows.push(feedRow(w.time, r, false));
    }
  }
  feed.replaceChildren(...rows.slice(0, FEED_MAX_ROWS));
  updateFeedCount();
}

// Adds one new window's rows to the top of the feed (used for live
// updates - much cheaper than rebuilding everything every second).
function prependToFeed(w) {
  const feed = $('feed');
  const rows = w.results.filter((r) => r.confidence >= state.threshold).map((r) => feedRow(w.time, r, true));
  feed.prepend(...rows);
  while (feed.children.length > FEED_MAX_ROWS) feed.lastChild.remove();
  updateFeedCount();
}

// Removes rows that have fallen out of the chosen period (e.g. older than
// one hour when showing "Last hour"). The oldest rows are at the bottom.
function pruneFeed() {
  const feed = $('feed');
  const cutoff = cutoffFor(state.range);
  let removed = false;
  while (feed.lastChild && Number(feed.lastChild.dataset.time) < cutoff) {
    feed.lastChild.remove();
    removed = true;
  }
  if (removed) updateFeedCount();
}

function updateFeedCount() {
  const n = $('feed').children.length;
  $('feed-empty').hidden = n > 0;
  $('feed-count').textContent = n ? `${n}${n === FEED_MAX_ROWS ? '+' : ''} shown` : '';
}

// --- Rendering: status, controls and level meter --------------------------------

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const labels = {
    starting: 'Starting…',
    listening: s.settings.file ? 'Playing recording' : 'Listening',
    paused: 'Paused',
    finished: 'Recording finished',
    error: 'Error',
  };
  $('status').dataset.state = s.state;
  $('status-text').textContent = labels[s.state] || s.state;
  $('status').title = s.message || '';

  const pauseBtn = $('pause-btn');
  const canResume = s.state === 'paused' || s.state === 'error' || s.state === 'finished';
  pauseBtn.textContent = canResume ? (s.state === 'paused' ? 'Resume' : 'Retry') : 'Pause';

  // Highlight the current step.
  for (const btn of $('step-group').querySelectorAll('button')) {
    btn.setAttribute('aria-checked', String(Number(btn.dataset.step) === s.settings.step));
  }

  // Microphone picker (or a note if we're playing a file instead).
  const select = $('device-select');
  if (s.settings.file) {
    select.hidden = true;
    $('file-note').hidden = false;
    $('file-note').textContent = `Playing a recording instead of a microphone: ${s.settings.file.split('/').pop()}`;
  } else {
    select.value = s.settings.device;
  }

  $('index-banner').hidden = s.speciesIndex;
  $('photos-toggle').disabled = !s.speciesIndex;
  if (!s.speciesIndex) $('photos-hint').textContent = 'Needs the species index (see the note at the top).';

  // While paused or stopped, empty the level meter straight away (rather
  // than letting it fall gently, which would leave bars stuck on because
  // no more level messages arrive to finish the fall).
  if (s.state !== 'listening') {
    meterValue = 0;
    renderLevel(0);
  }
}

// Builds the meter's 20 bars once.
const meterBars = [];
for (let i = 0; i < METER_BARS; i++) {
  const bar = el('span');
  meterBars.push(bar);
  $('meter').appendChild(bar);
}

// Lights bars for a loudness from 0 to 1. Sound loudness is perceived on a
// logarithmic scale, so we convert to decibels (dB) first: -60 dB (very
// quiet) lights no bars, 0 dB (the loudest possible) lights all 20.
let meterValue = 0;
function renderLevel(rms) {
  const db = rms > 0 ? 20 * Math.log10(rms) : -100;
  const target = Math.min(1, Math.max(0, (db + 60) / 60));
  // Rise instantly, fall gently - like a real VU meter. Easier on the eye.
  meterValue = Math.max(target, meterValue * 0.8);
  const lit = Math.round(meterValue * METER_BARS);
  meterBars.forEach((bar, i) => {
    bar.classList.toggle('on', i < lit);
    bar.classList.toggle('hot', i >= METER_BARS - 3); // last 3 bars amber
  });
  $('meter').setAttribute('aria-valuenow', String(Math.round(meterValue * 100)));
}

// Redraws everything that depends on the threshold, period, sort order or
// detections. "Now hearing" always counts visits over the whole session;
// the species cards use the period chosen in the "Show" menu.
function renderAll(justHeard) {
  const sessionSummary = summariseSpecies('session');
  const rangeSummary = state.range === 'session' ? sessionSummary : summariseSpecies(state.range);
  renderHero(sessionSummary);
  renderVisitors(rangeSummary, justHeard);
}

// --- Talking to the server ------------------------------------------------------

// Sends a command (pause, resume, settings) as JSON.
async function command(path, body = {}) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      alert(data.error || `Request failed (${response.status})`);
    }
  } catch {
    alert('Lost contact with MyBackyard. Is it still running?');
  }
}

// Fills the microphone list.
async function loadDevices() {
  try {
    const { devices = [] } = await (await fetch('/api/devices')).json();
    const select = $('device-select');
    select.replaceChildren(...devices.map((d) => {
      const option = el('option', null, d.name);
      option.value = String(d.index);
      return option;
    }));
    if (state.status) select.value = state.status.settings.device;
  } catch {
    // Not fatal: the picker just stays empty.
  }
}

// Opens the live connection. EventSource reconnects by itself if the
// server restarts; we just show "Reconnecting…" meanwhile.
function connect() {
  const events = new EventSource('/api/events');

  events.addEventListener('status', (e) => {
    state.status = JSON.parse(e.data);
    renderStatus();
    renderAll();
  });

  // Sent once, straight after connecting: everything the server remembers.
  // It replaces whatever we had, so a reconnect never duplicates rows.
  events.addEventListener('history', (e) => {
    const { windows, species } = JSON.parse(e.data);
    // The server sends results compactly as [label, confidence] pairs, with
    // each species' names/photo sent once in `species`. We rebuild full
    // result objects using Object.create(info): a tiny object that adds
    // `confidence` and borrows every other property (common, kind, photo,
    // ...) from the shared `info` object. Rows read exactly like live
    // results, but thousands of them don't each hold a copy of the names.
    state.windows = windows.map((w) => ({
      id: w.id,
      time: w.time,
      results: w.results.map(([label, confidence]) => {
        const result = Object.create(species[label]);
        result.confidence = confidence;
        return result;
      }),
    }));
    renderFeed();
    renderAll();
  });

  events.addEventListener('detection', (e) => {
    const w = JSON.parse(e.data);
    state.windows.push(w);
    // Forget anything older than 48 hours (the oldest is at the front).
    const oldest = Date.now() - HISTORY_MS;
    while (state.windows.length && state.windows[0].time < oldest) state.windows.shift();
    prependToFeed(w);
    // Birds in this window above the threshold get their card "pinged".
    const heard = new Set(w.results.filter((r) => isBird(r) && r.confidence >= state.threshold).map((r) => r.label));
    renderAll(heard);
  });

  events.addEventListener('level', (e) => renderLevel(JSON.parse(e.data).rms));

  events.onerror = () => {
    $('status').dataset.state = 'error';
    $('status-text').textContent = 'Reconnecting…';
  };
}

// --- Wiring up the controls -----------------------------------------------------

$('threshold').addEventListener('input', (e) => {
  state.threshold = Number(e.target.value) / 100;
  $('threshold-value').textContent = `${e.target.value}%`;
  renderFeed();
  renderAll();
});

$('range-select').addEventListener('change', (e) => {
  state.range = e.target.value;
  renderFeed();
  renderAll();
});

$('sort-select').addEventListener('change', (e) => {
  state.sort = e.target.value;
  renderAll();
});

$('step-group').addEventListener('click', (e) => {
  const step = e.target.closest('button')?.dataset.step;
  if (step) command('/api/settings', { step: Number(step) });
});

$('device-select').addEventListener('change', (e) => command('/api/settings', { device: e.target.value }));

$('pause-btn').addEventListener('click', () => {
  const s = state.status?.state;
  command(s === 'listening' || s === 'starting' ? '/api/pause' : '/api/resume');
});

$('photos-toggle').addEventListener('change', (e) => {
  state.showPhotos = e.target.checked;
  renderAll(); // swaps drawings for photos (or back) on every card
});

// Every 5 seconds: keep "2 min ago" labels fresh, and - when showing a
// limited period like "Last hour" - let detections that have aged out of
// it drop off, even if nothing new has been heard.
setInterval(() => {
  renderHeroEyebrow();
  if (state.range !== 'session') {
    pruneFeed();
    renderAll();
  }
  for (const ago of document.querySelectorAll('.visitor .ago')) ago.textContent = timeAgo(Number(ago.dataset.time));
}, 5000);

// --- Start --------------------------------------------------------------------------

$('threshold-value').textContent = `${$('threshold').value}%`;
state.threshold = Number($('threshold').value) / 100;
loadDevices();
connect();
