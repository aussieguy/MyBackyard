// ---------------------------------------------------------------------------
// windower.js
//
// The Perch model always looks at exactly 5 seconds of audio at a time
// (160,000 samples at 32 kHz). Audio, however, arrives from ffmpeg in small
// chunks of unpredictable size. This module collects those chunks and cuts
// them into 5-second "windows" to hand to the model.
//
// Windows can overlap. With a 5-second window and a 2.5-second step:
//
//     time (s):  0    2.5   5    7.5   10
//     window 1:  [=========]
//     window 2:       [=========]
//     window 3:            [=========]
//
// Overlap helps when a bird call straddles the boundary between two
// windows: without it, each window might only hear half the call. The
// trade-off is that the model runs more often and the same call may be
// reported twice. With step = window length there is no overlap.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// makeWindows(audioChunks, options)
//
//   audioChunks   - async iterator of Float32Array chunks (from audio.js)
//   windowSamples - window length in samples (160,000 for Perch)
//   stepSamples   - how far to move forward between windows, in samples
//   sampleRate    - used only to work out each window's start time
//   padFinal      - if true, a leftover piece at the very end (e.g. the
//                   last 3 seconds of a recording) is padded with silence
//                   to make a full window, rather than being thrown away
//
// Yields objects: { startSeconds, samples } where `samples` is a
// Float32Array of exactly `windowSamples` length.
// ---------------------------------------------------------------------------
async function* makeWindows(audioChunks, { windowSamples, stepSamples, sampleRate, padFinal = false }) {
  // `buffer` holds audio we've received but not yet fully used. It's
  // allocated with room for one window plus some spare, and grown if needed.
  let buffer = new Float32Array(windowSamples * 2);
  let filled = 0;          // how many samples in `buffer` are real audio
  let consumedSamples = 0; // total samples discarded from the front so far
                           // (used to calculate each window's start time)

  for await (const chunk of audioChunks) {
    // Make sure there's room for the new chunk; if not, allocate a bigger
    // buffer and copy the existing audio across.
    if (filled + chunk.length > buffer.length) {
      const bigger = new Float32Array((filled + chunk.length) * 2);
      bigger.set(buffer.subarray(0, filled));
      buffer = bigger;
    }

    // Append the new chunk after the audio we already have.
    buffer.set(chunk, filled);
    filled += chunk.length;

    // While we have at least one full window, hand it out.
    while (filled >= windowSamples) {
      yield {
        startSeconds: consumedSamples / sampleRate,
        // slice() makes a copy, so the caller can keep it safely even after
        // we reuse `buffer`.
        samples: buffer.slice(0, windowSamples),
      };

      // Drop `stepSamples` from the front by shifting the rest of the
      // audio down. copyWithin() moves data inside the same array without
      // allocating a new one.
      buffer.copyWithin(0, stepSamples, filled);
      filled -= stepSamples;
      consumedSamples += stepSamples;
    }
  }

  // The audio has ended (only happens for files - a microphone never ends).
  // Optionally pad the remaining partial window with silence (zeros).
  // We skip tiny scraps under 1 second: there's not enough sound in them to
  // be worth classifying.
  if (padFinal && filled >= sampleRate) {
    const padded = new Float32Array(windowSamples); // starts as all zeros
    padded.set(buffer.subarray(0, filled));
    yield { startSeconds: consumedSamples / sampleRate, samples: padded };
  }
}

module.exports = { makeWindows };
