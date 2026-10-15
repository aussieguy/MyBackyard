#!/usr/bin/env node
// ---------------------------------------------------------------------------
// mybackyard.js - the command-line program
//
// Commands:
//
//   mybackyard devices
//       List the microphones macOS can see, with their numbers.
//
//   mybackyard listen [--device 1] [--threshold 50] [--top 3] [--step 5]
//       Listen live and print birds as they're heard. Ctrl+C to stop.
//
//   mybackyard file <recording.wav> [--threshold 50] [--top 3] [--step 5]
//       Analyse a recording and print what was heard, with timestamps.
//
// Options:
//   --device     microphone number or name (from `devices`). Default: 0
//   --threshold  minimum confidence to report, in percent. Default: 50
//   --top        maximum results per 5-second window. Default: 3
//   --step       seconds between the start of each 5-second window.
//                5 = no overlap; 2.5 = windows overlap by half. Default: 2.5
//                (overlap catches calls that straddle two windows, at the
//                cost of the same call sometimes being reported twice)
//   --verbose    also print windows where nothing was detected, plus how
//                long the model took on each window
//
// From the project folder you can also use the npm shortcuts, e.g.
//   npm run listen -- --device 1
// (the "--" tells npm to pass the options through to this program).
// ---------------------------------------------------------------------------

const path = require('node:path');
const { parseArgs } = require('node:util');
const { SAMPLE_RATE, listInputDevices, streamFromMicrophone, streamFromFile } = require('../src/audio');
const { makeWindows } = require('../src/windower');
const { loadPerch, WINDOW_SAMPLES } = require('../src/perch');

// --- Read the command-line options -----------------------------------------
// parseArgs() is built into Node. It turns e.g. "--threshold 30" into
// { threshold: '30' }. Anything that isn't an option (like the command name
// or the file path) ends up in `positionals`.
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    device:    { type: 'string', default: '0' },
    threshold: { type: 'string', default: '50' },
    top:       { type: 'string', default: '3' },
    step:      { type: 'string', default: '2.5' },
    verbose:   { type: 'boolean', default: false },
    help:      { type: 'boolean', short: 'h', default: false },
  },
});

const [command, filePath] = positionals;

// Convert the option strings into numbers, and check they make sense.
const threshold = Number(options.threshold) / 100;  // percent -> 0..1
const top = Number(options.top);
const stepSeconds = Number(options.step);

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

if (!(threshold >= 0 && threshold <= 1)) fail('--threshold must be between 0 and 100');
if (!(Number.isInteger(top) && top >= 1)) fail('--top must be a whole number of 1 or more');
if (!(stepSeconds > 0 && stepSeconds <= 5)) fail('--step must be more than 0 and at most 5 seconds');

// --- Helpers for printing ---------------------------------------------------

// Formats seconds as m:ss.s, e.g. 75.5 -> "1:15.5" (for file timestamps).
function formatOffset(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${rest}`;
}

// Formats the current wall-clock time, e.g. "14:03:27" (for live mode).
function formatClock(date) {
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

// Prints one window's results, e.g.
//   14:03:27  Turdus merula                      93.4%
function printResults(timeText, results, elapsedMs) {
  const timing = options.verbose ? `   (${elapsedMs} ms)` : '';
  if (results.length === 0) {
    if (options.verbose) console.log(`${timeText}  -${timing}`);
    return;
  }
  results.forEach((result, i) => {
    // Only show the time on the first line of each window, so a window with
    // several results reads as a group.
    const prefix = i === 0 ? timeText : ' '.repeat(timeText.length);
    const percent = `${(result.confidence * 100).toFixed(1)}%`.padStart(6);
    console.log(`${prefix}  ${result.label.padEnd(40)} ${percent}${i === 0 ? timing : ''}`);
  });
}

// --- Commands ---------------------------------------------------------------

function showDevices() {
  const devices = listInputDevices();
  if (devices.length === 0) {
    console.log('No microphones found.');
    return;
  }
  console.log('Microphones:');
  for (const device of devices) {
    console.log(`  [${device.index}] ${device.name}`);
  }
  console.log('\nUse the number with:  mybackyard listen --device <number>');
}

// Shared by `listen` and `file`: loads the model, then runs every 5-second
// window from `audioChunks` through it and prints the results.
async function analyse(audioChunks, { live }) {
  process.stdout.write('Loading Perch model... ');
  const loadStart = Date.now();
  const perch = await loadPerch();
  console.log(`done (${perch.labelCount} classes, ${((Date.now() - loadStart) / 1000).toFixed(1)} s)`);
  console.log(`Reporting results at or above ${options.threshold}% confidence.\n`);

  const windows = makeWindows(audioChunks, {
    windowSamples: WINDOW_SAMPLES,
    stepSamples: Math.round(stepSeconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
    padFinal: !live, // pad the last partial window of a file; mics never end
  });

  for await (const window of windows) {
    const started = Date.now();
    const results = await perch.classify(window.samples, { threshold, top });
    const elapsedMs = Date.now() - started;

    // Live: show the time of day. File: show the position in the recording.
    const timeText = live ? formatClock(new Date()) : formatOffset(window.startSeconds);
    printResults(timeText, results, elapsedMs);
  }
}

async function listen() {
  console.log(`Listening on microphone ${options.device}. Press Ctrl+C to stop.`);
  // The first result appears after 5 seconds (one full window of audio).
  await analyse(streamFromMicrophone(options.device), { live: true });
}

async function analyseFile() {
  if (!filePath) fail('Please give a recording to analyse, e.g.  mybackyard file recording.wav');
  console.log(`Analysing ${path.basename(filePath)}`);
  await analyse(streamFromFile(filePath), { live: false });
  console.log('\nFinished.');
}

function showHelp() {
  console.log(`MyBackyard - bird identification proof of concept (Google Perch 2.0)

Usage:
  mybackyard devices                 list microphones
  mybackyard listen [options]        identify birds live from a microphone
  mybackyard file <path> [options]   identify birds in a recording

Options:
  --device <n|name>   microphone to use (default 0)
  --threshold <pct>   minimum confidence to report (default 50)
  --top <n>           max results per 5-second window (default 3)
  --step <seconds>    gap between window starts; <5 overlaps windows (default 2.5)
  --verbose           show empty windows and model timing`);
}

// --- Run the chosen command -------------------------------------------------

// Ctrl+C sends SIGINT. Exiting here triggers the 'exit' handler in audio.js,
// which stops ffmpeg cleanly.
process.on('SIGINT', () => {
  console.log('\nStopped.');
  process.exit(0);
});

const commands = { devices: showDevices, listen, file: analyseFile };

if (options.help || !command) {
  showHelp();
} else if (!commands[command]) {
  fail(`Unknown command "${command}". Run with --help to see the commands.`);
} else {
  Promise.resolve(commands[command]()).catch((error) => fail(error.message));
}
