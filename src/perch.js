// ---------------------------------------------------------------------------
// perch.js
//
// Loads Google's Perch 2.0 model and uses it to classify 5-second windows
// of audio.
//
// How the model works, in brief:
//   - Input: 160,000 audio samples (5 seconds at 32 kHz), values -1.0..+1.0.
//   - Inside, the model first turns the sound into a spectrogram (a picture
//     of which pitches are loud at each moment), then runs that picture
//     through a neural network (EfficientNet-B3, the same family of network
//     used for photo recognition).
//   - Output "label": 14,795 numbers, one per species/sound in labels.csv.
//     These are raw scores called "logits": large positive = "I think this
//     is present", large negative = "I think this is absent".
//   - The model also outputs "embedding" (1,536 numbers summarising the
//     sound) and the spectrogram itself; we don't use those yet. Embeddings
//     are what you'd use later to train a custom classifier on top.
//
// We use ONNX Runtime ("onnxruntime-node") to run the model. ONNX is a
// standard file format for neural networks; ONNX Runtime is Microsoft's
// open-source (MIT licence) engine for running such files.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ort = require('onnxruntime-node');

const MODELS_DIR = path.join(__dirname, '..', 'models');
const MODEL_PATH = path.join(MODELS_DIR, 'perch_v2.onnx');
const LABELS_PATH = path.join(MODELS_DIR, 'labels.csv');

// The model's fixed input length: 5 seconds x 32,000 samples per second.
const WINDOW_SAMPLES = 160000;

// --- Settings copied from Google's own Perch toolkit ------------------------
// These three numbers come from Google's "perch-hoplite" library, which
// is how Google itself runs this exact ONNX file (its "perch_v2_onnx"
// preset in perch_hoplite/zoo/model_configs.py). Without them the scores
// are badly off: in testing, pure silence scored 98.9% for Tawny Owl.

// Each window's audio is rescaled so its loudest sample is 0.25. This makes
// a quiet distant bird and a loud nearby one look alike to the model.
const TARGET_PEAK = 0.25;

// The raw scores are adjusted with  logit x 0.97 - 10  before converting to
// a percentage. This "calibration" shifts the scores down so that only
// strong matches end up with a high percentage.
const LOGIT_SLOPE = 0.97;
const LOGIT_INTERCEPT = -10.0;

// ---------------------------------------------------------------------------
// normalizeAudio(samples)
//
// Prepares one window of audio the same way Google's toolkit does:
//   1. Remove any "DC offset": subtract the average value so the waveform
//      is centred on zero (some microphones add a small constant bias).
//   2. Scale the whole window so the loudest sample is exactly TARGET_PEAK.
// A window of pure silence (all zeros) is left as all zeros, since there's
// nothing to scale and dividing by zero would produce garbage.
//
// Returns a new Float32Array; the original is left unchanged.
// ---------------------------------------------------------------------------
function normalizeAudio(samples) {
  // Step 1: the average (mean) value of the window.
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  const mean = sum / samples.length;

  // Subtract the mean, and at the same time find the loudest sample
  // (largest distance from zero, ignoring whether it's + or -).
  const centred = new Float32Array(samples.length);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    centred[i] = samples[i] - mean;
    const loudness = Math.abs(centred[i]);
    if (loudness > peak) peak = loudness;
  }

  // Step 2: scale so the peak becomes TARGET_PEAK.
  if (peak > 0) {
    const scale = TARGET_PEAK / peak;
    for (let i = 0; i < centred.length; i++) centred[i] *= scale;
  }
  return centred;
}

// ---------------------------------------------------------------------------
// sigmoid(x)
//
// Converts a raw logit into a number between 0 and 1, which we show as a
// percentage. Perch is "multi-label": several species can be present at
// once, so each species gets its own independent 0-1 score (they do NOT add
// up to 100% across species). The sigmoid is the standard function for
// this kind of model (applied after the calibration step described above):
//
//     -4  ->  2%      0  ->  50%      +4  ->  98%
//
// IMPORTANT: Google notes these scores are "uncalibrated". 90% means "a
// strong match", not "90% chance of being right". That's why the program
// calls it "confidence", not "accuracy".
// ---------------------------------------------------------------------------
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// ---------------------------------------------------------------------------
// loadLabels()
//
// Reads labels.csv: the first line is a header ("inat2024_fsd50k", the name
// of the class list), then one name per line. Line N+1 is the name for the
// model's output number N. Most names are scientific species names (e.g.
// "Turdus merula"); some are general sound categories from the FSD50K
// sound dataset (e.g. dog barks, speech, vehicles).
// ---------------------------------------------------------------------------
function loadLabels() {
  const lines = fs.readFileSync(LABELS_PATH, 'utf8').trimEnd().split('\n');
  return lines.slice(1).map((line) => line.trim()); // drop the header
}

// ---------------------------------------------------------------------------
// loadPerch()
//
// Loads the model and labels from disk. This takes a few seconds (the model
// is ~400 MB), so we do it once at start-up and reuse the result.
//
// Returns an object with a classify() function - see below.
// ---------------------------------------------------------------------------
async function loadPerch() {
  if (!fs.existsSync(MODEL_PATH) || !fs.existsSync(LABELS_PATH)) {
    throw new Error('Model files not found. Download them first with:  npm run download-model');
  }

  const labels = loadLabels();

  // Create the ONNX Runtime "session" - the loaded, ready-to-run model.
  // We use the default CPU engine: on Apple Silicon it's fast enough
  // (well under a second per 5-second window) and gives exact results.
  const session = await ort.InferenceSession.create(MODEL_PATH);

  // Safety check: the number of labels must match the number of outputs,
  // otherwise we'd attach the wrong names to the scores.
  const outputCount = session.outputMetadata?.find?.((o) => o.name === 'label')?.shape?.[1];
  if (outputCount && outputCount !== labels.length) {
    throw new Error(`Model has ${outputCount} outputs but labels.csv has ${labels.length} names.`);
  }

  // -------------------------------------------------------------------------
  // classify(samples, { threshold, top })
  //
  //   samples   - Float32Array of exactly 160,000 audio samples
  //   threshold - minimum confidence (0-1) for a result to be returned
  //   top       - maximum number of results to return
  //
  // Returns a list sorted best-first, e.g.:
  //   [{ label: 'Turdus merula', confidence: 0.93 }, ...]
  // -------------------------------------------------------------------------
  async function classify(samples, { threshold = 0.5, top = 5 } = {}) {
    if (samples.length !== WINDOW_SAMPLES) {
      throw new Error(`Expected ${WINDOW_SAMPLES} samples, got ${samples.length}`);
    }

    // Centre and rescale the audio, as Google's toolkit does (see above).
    const prepared = normalizeAudio(samples);

    // Wrap the samples in a "tensor" (the model's data type). The shape
    // [1, 160000] means "a batch of 1 clip, each 160,000 samples long".
    const input = new ort.Tensor('float32', prepared, [1, WINDOW_SAMPLES]);

    // Run the model. We only ask for the 'label' output, so ONNX Runtime
    // can skip returning the others.
    const outputs = await session.run({ inputs: input }, ['label']);
    const logits = outputs.label.data; // Float32Array of 14,795 scores

    // Calibrate each logit, convert it to a confidence, and keep those above
    // the threshold. (We compare against the threshold first and only keep
    // a handful, so we don't build and sort a 14,795-item list every window.)
    const results = [];
    for (let i = 0; i < logits.length; i++) {
      const calibrated = logits[i] * LOGIT_SLOPE + LOGIT_INTERCEPT;
      const confidence = sigmoid(calibrated);
      if (confidence >= threshold) {
        results.push({ label: labels[i], confidence });
      }
    }

    results.sort((a, b) => b.confidence - a.confidence);
    return results.slice(0, top);
  }

  return { classify, labelCount: labels.length };
}

module.exports = { loadPerch, WINDOW_SAMPLES };
