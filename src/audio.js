// ---------------------------------------------------------------------------
// audio.js
//
// Gets audio into the program, using ffmpeg (installed via Homebrew) to do
// the heavy lifting. ffmpeg can either:
//   - record live from a macOS microphone (via Apple's "AVFoundation"), or
//   - read an audio file of almost any format (wav, mp3, flac, m4a, ...).
//
// Whichever the source, we ask ffmpeg to convert the audio into exactly the
// format the Perch model expects:
//   - 32,000 samples per second (32 kHz)
//   - 1 channel (mono)
//   - each sample a 32-bit floating-point number between -1.0 and +1.0
//
// ffmpeg writes those raw numbers to its standard output, and we read them
// here as they arrive. Doing the conversion in ffmpeg means our own code
// never has to deal with file formats, resampling or stereo mixing.
// ---------------------------------------------------------------------------

const { spawn, spawnSync } = require('node:child_process');

// The sample rate Perch 2.0 was trained on. Every 5-second window the model
// looks at is therefore 5 x 32,000 = 160,000 samples long.
const SAMPLE_RATE = 32000;

// Each sample is a 32-bit float, which takes 4 bytes.
const BYTES_PER_SAMPLE = 4;

// Arguments that tell ffmpeg what to output (shared by mic and file modes):
const OUTPUT_ARGS = [
  '-ac', '1',                  // audio channels: 1 = mono (stereo is mixed down)
  '-ar', String(SAMPLE_RATE),  // audio rate: resample to 32 kHz
  '-f', 'f32le',               // format: raw 32-bit float, little-endian (Mac byte order)
  'pipe:1',                    // write to standard output instead of a file
];

// ---------------------------------------------------------------------------
// listInputDevices()
//
// Asks ffmpeg which microphones macOS can see. ffmpeg prints the list to its
// error output (stderr) and then exits with an "error" because we didn't
// give it a real input - that's normal and expected, so we ignore the exit
// code and just read the list.
//
// Returns an array like: [{ index: 0, name: 'MacBook Air Microphone' }, ...]
// ---------------------------------------------------------------------------
function listInputDevices() {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    encoding: 'utf8',
  });

  if (result.error) {
    throw new Error(`Could not run ffmpeg (${result.error.message}). Is it installed? Try: brew install ffmpeg`);
  }

  const devices = [];
  // ffmpeg lists video devices first, then audio devices. We only want the
  // lines after the "AVFoundation audio devices:" heading.
  let inAudioSection = false;
  for (const line of result.stderr.split('\n')) {
    if (line.includes('AVFoundation audio devices')) {
      inAudioSection = true;
      continue;
    }
    if (!inAudioSection) continue;

    // Lines look like: "[AVFoundation indev @ 0x...] [1] Glen Microphone"
    // The regex captures the number in the second [ ] and the name after it.
    const match = line.match(/\]\s*\[(\d+)\]\s*(.+)$/);
    if (match) {
      devices.push({ index: Number(match[1]), name: match[2].trim() });
    }
  }
  return devices;
}

// ---------------------------------------------------------------------------
// startFfmpeg(inputArgs)
//
// Starts ffmpeg with the given input arguments plus our standard output
// arguments, and returns an "async iterator" that hands back the audio as
// Float32Array chunks (arrays of samples) as they arrive.
//
// Usage:
//   for await (const samples of startFfmpeg([...])) { ... }
// ---------------------------------------------------------------------------
async function* startFfmpeg(inputArgs) {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',  // only print real problems, not progress spam
    ...inputArgs,
    ...OUTPUT_ARGS,
  ]);

  // Collect anything ffmpeg prints to stderr so we can show it if it fails
  // (e.g. "file not found" or "permission denied" for the microphone).
  let errorOutput = '';
  ffmpeg.stderr.on('data', (data) => { errorOutput += data.toString(); });

  // A promise that resolves with ffmpeg's exit code when it finishes. We set
  // this up immediately so we can't miss the 'close' event. The code is null
  // if ffmpeg was stopped by us (killed) rather than exiting by itself.
  const finished = new Promise((resolve) => ffmpeg.once('close', resolve));

  // If ffmpeg isn't installed, spawn() reports it via an 'error' event.
  let spawnError = null;
  ffmpeg.once('error', (error) => { spawnError = error; });

  // If our program is stopped (Ctrl+C), make sure ffmpeg stops too rather
  // than being left running in the background holding the microphone.
  const stopFfmpeg = () => ffmpeg.kill('SIGTERM');
  process.once('exit', stopFfmpeg);

  // Data from ffmpeg arrives in chunks of bytes whose size we don't control.
  // A chunk might end part-way through a 4-byte sample, so we keep any
  // leftover bytes and glue them to the front of the next chunk.
  let leftover = Buffer.alloc(0);

  try {
    for await (const chunk of ffmpeg.stdout) {
      const bytes = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;

      // How many whole samples are in this chunk?
      const sampleCount = Math.floor(bytes.length / BYTES_PER_SAMPLE);
      const usableBytes = sampleCount * BYTES_PER_SAMPLE;

      // Copy the whole samples into a fresh Float32Array. (We copy rather than
      // "view" the Buffer's memory because a Float32Array must start on a
      // 4-byte boundary in memory, which Node's Buffers don't guarantee.)
      const samples = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = bytes.readFloatLE(i * BYTES_PER_SAMPLE);
      }

      // Save the 0-3 bytes that didn't make up a whole sample.
      leftover = bytes.subarray(usableBytes);

      if (sampleCount > 0) yield samples;
    }
  } finally {
    // Runs when the loop finishes OR when the caller stops reading early.
    process.removeListener('exit', stopFfmpeg);
    stopFfmpeg();
  }

  // Wait for ffmpeg to actually exit, then report failures.
  const exitCode = await finished;
  if (spawnError) {
    throw new Error(`Could not run ffmpeg (${spawnError.message}). Is it installed? Try: brew install ffmpeg`);
  }
  if (exitCode !== 0 && exitCode !== null) {
    throw new Error(`ffmpeg failed: ${errorOutput.trim() || `exit code ${exitCode}`}`);
  }
}

// ---------------------------------------------------------------------------
// streamFromMicrophone(device)
//
// Live audio from a microphone. `device` can be the number shown by
// `mybackyard devices` (e.g. 1) or the device's name (e.g. "Glen Microphone").
//
// AVFoundation input names have the form "<video>:<audio>"; we leave the
// video part empty (":1") because we only want sound.
//
// The first time this runs, macOS will ask whether your Terminal app may use
// the microphone. If you say no, ffmpeg will record silence or fail; you can
// change it later in System Settings > Privacy & Security > Microphone.
// ---------------------------------------------------------------------------
function streamFromMicrophone(device) {
  return startFfmpeg(['-f', 'avfoundation', '-i', `:${device}`]);
}

// ---------------------------------------------------------------------------
// streamFromFile(filePath)
//
// Audio from a recording on disk. '-re' is deliberately NOT used, so ffmpeg
// decodes the file as fast as possible rather than in real time - a
// 10-minute recording is analysed in seconds, not 10 minutes.
// ---------------------------------------------------------------------------
function streamFromFile(filePath) {
  return startFfmpeg(['-i', filePath]);
}

module.exports = {
  SAMPLE_RATE,
  listInputDevices,
  streamFromMicrophone,
  streamFromFile,
};
