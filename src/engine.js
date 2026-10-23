// ---------------------------------------------------------------------------
// engine.js
//
// The "listening engine" behind the web interface. It runs the same steps
// as the command-line program:
//
//     microphone (ffmpeg) -> 5-second windows -> Perch -> results
//
// but packaged so the web server can control it while it runs:
//   - pause() / resume()
//   - change microphone or window step (it restarts itself, ~1 second)
//
// and it reports what's happening by emitting events (Node's EventEmitter -
// the same idea as addEventListener in a web page):
//
//   'status'    { state, message, settings }  - listening / paused / error ...
//   'level'     { rms, peak }                 - microphone loudness, ~10 per second
//   'detection' { id, time, startSeconds, results }  - one per 5-second window
//
// Nothing is saved to disk. Detections are sent to the web page and then
// forgotten by the engine.
// ---------------------------------------------------------------------------

const { EventEmitter } = require('node:events');
const { SAMPLE_RATE, streamFromMicrophone, streamFromFile } = require('./audio');
const { makeWindows } = require('./windower');
const { loadPerch, WINDOW_SAMPLES } = require('./perch');
const { loadSpeciesIndex } = require('./species');

// The engine sends the page every result at or above this confidence. The
// page then applies YOUR threshold slider itself. Sending a low "floor"
// means moving the slider down instantly reveals weaker detections that
// were already heard, without waiting for new audio.
const FLOOR = 0.05;

// Maximum results sent per window. More than enough - it's rare for more
// than two or three sounds to score above the floor at once.
const TOP = 10;

// How often to report the microphone level: every 3,200 samples = 0.1 s.
const LEVEL_EVERY_SAMPLES = SAMPLE_RATE / 10;

class Engine extends EventEmitter {
  // options:
  //   device - microphone number or name (live mode)
  //   file   - path to a recording to play in real time instead of a mic
  //   step   - seconds between window starts (e.g. 2.5)
  constructor({ device = '0', file = null, step = 2.5 } = {}) {
    super();
    this.settings = { device: String(device), file, step };
    this.state = 'starting';
    this.message = '';
    this.perch = null;
    this.species = null;
    this.abortController = null; // used to stop the current run
    this.running = null;         // promise for the current run
    this.nextId = 1;             // each detection gets a unique number
  }

  // Loads the model and species index. Call once before start().
  async init() {
    this.perch = await loadPerch();
    this.species = loadSpeciesIndex();
  }

  // Current state as one object (sent to newly connected web pages).
  getStatus() {
    return {
      state: this.state,
      message: this.message,
      settings: this.settings,
      speciesIndex: this.species?.available ?? false,
      speciesDetails: this.species?.hasDetails ?? false,
    };
  }

  setStatus(state, message = '') {
    this.state = state;
    this.message = message;
    this.emit('status', this.getStatus());
  }

  // Starts listening (if not already).
  start() {
    if (this.running) return;
    this.abortController = new AbortController();
    this.running = this.run(this.abortController.signal).finally(() => { this.running = null; });
  }

  // Stops listening and waits until ffmpeg has fully shut down.
  async stop() {
    if (!this.running) return;
    this.abortController.abort();
    await this.running;
  }

  async pause() {
    await this.stop();
    this.setStatus('paused');
  }

  resume() {
    this.start();
  }

  // Changes settings. If we were listening, restart so they take effect.
  // (The step can't change mid-stream: the windower is set up with it.)
  async updateSettings({ device, step }) {
    const wasRunning = Boolean(this.running);
    await this.stop();
    if (device !== undefined) this.settings.device = String(device);
    if (step !== undefined) this.settings.step = step;
    if (wasRunning) this.start();
    else this.setStatus(this.state, this.message); // just announce new settings
  }

  // ---------------------------------------------------------------------------
  // meter(chunks)
  //
  // Passes audio straight through unchanged, but measures it on the way and
  // emits 'level' events for the page's level meter:
  //   rms  - "root mean square", the average loudness (0..1)
  //   peak - the single loudest sample (0..1)
  // ---------------------------------------------------------------------------
  async* meter(chunks) {
    let sumSquares = 0;
    let peak = 0;
    let count = 0;
    for await (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const s = chunk[i];
        sumSquares += s * s;
        const a = Math.abs(s);
        if (a > peak) peak = a;
        if (++count === LEVEL_EVERY_SAMPLES) {
          this.emit('level', { rms: Math.sqrt(sumSquares / count), peak });
          sumSquares = 0; peak = 0; count = 0;
        }
      }
      yield chunk;
    }
  }

  // ---------------------------------------------------------------------------
  // run(signal) - the main loop. Runs until aborted, or the file ends, or
  // something fails.
  // ---------------------------------------------------------------------------
  async run(signal) {
    const { device, file, step } = this.settings;
    this.setStatus('starting');

    const audio = file
      ? streamFromFile(file, { realtime: true, signal })
      : streamFromMicrophone(device, { signal });

    const windows = makeWindows(this.meter(audio), {
      windowSamples: WINDOW_SAMPLES,
      stepSamples: Math.round(step * SAMPLE_RATE),
      sampleRate: SAMPLE_RATE,
      padFinal: Boolean(file),
    });

    try {
      this.setStatus('listening');
      for await (const window of windows) {
        if (signal.aborted) break;
        const results = await this.perch.classify(window.samples, { threshold: FLOOR, top: TOP });
        this.emit('detection', {
          id: this.nextId++,
          time: Date.now(),
          startSeconds: window.startSeconds,
          // Add common names, kind (bird / frog / sound ...) and photo info.
          results: results.map((r) => ({ ...this.species.describe(r.label), confidence: r.confidence })),
        });
      }
      // If we get here without being aborted, the audio ended by itself.
      if (!signal.aborted) {
        if (file) this.setStatus('finished', 'The recording has finished.');
        else this.setStatus('error', 'The microphone stopped sending audio.');
      }
    } catch (error) {
      if (!signal.aborted) this.setStatus('error', error.message);
    }
  }
}

module.exports = { Engine };
