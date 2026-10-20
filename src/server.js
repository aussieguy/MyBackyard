// ---------------------------------------------------------------------------
// server.js
//
// A small web server that shows the listening engine in your browser at
// http://localhost:8420 (or the port you choose).
//
// It's built on Node's own "http" module - no web framework - so there are
// no extra dependencies to install or trust. It does three jobs:
//
//   1. Serves the web page itself (the files in the public/ folder).
//   2. Streams live updates to the page using "Server-Sent Events" (SSE):
//      the page opens one long-lived connection to /api/events, and the
//      server writes a message down it whenever something happens. It's
//      simpler than WebSockets and perfect for one-way "server -> page"
//      updates.
//   3. Accepts a few commands from the page: pause, resume, change
//      microphone, change step.
//   4. Remembers the last 48 hours of detections IN MEMORY ONLY (never on
//      disk), so the page can show "last 24 hours" etc. and a reloaded
//      page gets its history back. Stopping the server forgets it all.
//
// PRIVACY: the server only listens on 127.0.0.1 ("this computer"), so no
// other device on your network can open the page.
// ---------------------------------------------------------------------------

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { listInputDevices } = require('./audio');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// The only file types we serve, and how to label them for the browser.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Allowed values for the step setting (seconds).
const ALLOWED_STEPS = [1, 2.5, 5];

// How much history to keep in memory: 48 hours, the longest period the
// page can show.
const HISTORY_MS = 48 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// startServer(engine, { port })
// ---------------------------------------------------------------------------
function startServer(engine, { port = 8420 } = {}) {
  // Every page currently connected to /api/events. Each is a response
  // object we keep open and write messages into.
  const clients = new Set();

  // Sends one SSE message to every connected page. The format is plain
  // text: "event: <name>\ndata: <json>\n\n" (the blank line ends a message).
  function broadcast(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(message);
  }

  // --- History (in memory only) -------------------------------------------
  //
  // Each detection is stored in a compact form - just the time and the
  // label + confidence of each result - rather than the full version with
  // names and photo details. At a 1-second step, 48 hours is ~170,000
  // windows, so repeating names and photo addresses in every one would
  // waste a lot of memory. The names are looked up again when the history
  // is sent (see historyMessage).
  //
  //   { id: 42, time: 1760000000000, results: [['Turdus merula', 0.873], ...] }
  const history = [];

  function remember(detection) {
    history.push({
      id: detection.id,
      time: detection.time,
      // Confidence rounded to 3 decimal places (0.873) - more precision
      // than that is meaningless and just makes the data bigger.
      results: detection.results.map((r) => [r.label, Math.round(r.confidence * 1000) / 1000]),
    });
    // Forget detections older than 48 hours. They're at the front of the
    // list (oldest first), so we remove from the front until we reach one
    // that's recent enough.
    const cutoff = Date.now() - HISTORY_MS;
    while (history.length && history[0].time < cutoff) history.shift();
  }

  // Builds the 'history' message sent to a page when it connects:
  //   windows - the compact history above
  //   species - names, kind and photo for every label in it, sent once
  //             each rather than once per detection
  function historyMessage() {
    const species = {};
    for (const w of history) {
      for (const [label] of w.results) {
        if (!species[label]) species[label] = engine.species.describe(label);
      }
    }
    return { windows: history, species };
  }

  // Forward everything the engine reports to the pages (and remember
  // detections).
  engine.on('status', (status) => broadcast('status', status));
  engine.on('detection', (detection) => {
    remember(detection);
    broadcast('detection', detection);
  });
  engine.on('level', (level) => broadcast('level', level));

  // --- Helpers ----------------------------------------------------------------

  function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  // Reads a small JSON request body (commands from the page).
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10000) reject(new Error('Request too large'));
      });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  // Serves a file from public/. path.normalize + the startsWith check stop
  // "../" tricks from reading files outside the public folder.
  function serveStatic(res, urlPath) {
    const relative = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
    const type = CONTENT_TYPES[path.extname(filePath)];
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !type || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    // 'no-store' so the browser always picks up edits to the page while
    // we're developing it, rather than showing a cached copy.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
  }

  // --- The request handler ----------------------------------------------------

  async function handle(req, res) {
    // Security: only answer requests addressed to this computer by name.
    // This blocks "DNS rebinding", a trick where a malicious website points
    // its own domain name at 127.0.0.1 to reach local servers like this one.
    const host = req.headers.host || '';
    if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const url = new URL(req.url, `http://${host}`);

    // Live updates stream.
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      clients.add(res);
      // Tell the new page the current state and history straight away.
      // (SSE messages arrive in order, so the page always gets the history
      // before any new detections.)
      res.write(`event: status\ndata: ${JSON.stringify(engine.getStatus())}\n\n`);
      res.write(`event: history\ndata: ${JSON.stringify(historyMessage())}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/devices') {
      try {
        sendJson(res, 200, { devices: listInputDevices() });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }

    // Commands. We require the JSON content type: browsers won't let
    // another website send a cross-site request with this type without our
    // permission (which we never give), so only our own page can send
    // commands.
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (!(req.headers['content-type'] || '').startsWith('application/json')) {
        sendJson(res, 415, { error: 'Expected application/json' });
        return;
      }
      let body;
      try { body = await readJson(req); } catch (error) { sendJson(res, 400, { error: error.message }); return; }

      if (url.pathname === '/api/pause') {
        await engine.pause();
        sendJson(res, 200, engine.getStatus());
        return;
      }
      if (url.pathname === '/api/resume') {
        engine.resume();
        sendJson(res, 200, engine.getStatus());
        return;
      }
      if (url.pathname === '/api/settings') {
        const changes = {};
        if (body.step !== undefined) {
          const step = Number(body.step);
          if (!ALLOWED_STEPS.includes(step)) { sendJson(res, 400, { error: 'Invalid step' }); return; }
          changes.step = step;
        }
        if (body.device !== undefined) {
          // Only accept a device number that ffmpeg actually listed.
          const device = String(body.device);
          if (!listInputDevices().some((d) => String(d.index) === device)) {
            sendJson(res, 400, { error: 'Unknown microphone' });
            return;
          }
          changes.device = device;
        }
        await engine.updateSettings(changes);
        sendJson(res, 200, engine.getStatus());
        return;
      }
    }

    if (req.method === 'GET') {
      serveStatic(res, url.pathname);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      else res.end();
    });
  });

  // SSE connections stay open, so a heartbeat comment every 20 s keeps
  // them from being closed as "idle" by the browser.
  setInterval(() => { for (const res of clients) res.write(': heartbeat\n\n'); }, 20000).unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // '127.0.0.1' = only accept connections from this Mac.
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startServer };
