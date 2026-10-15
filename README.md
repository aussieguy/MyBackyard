# MyBackyard

A proof of concept that identifies birds from live microphone audio, or from recordings, on a Mac. It uses Google's **Perch 2.0** bioacoustics model and runs entirely offline once the model has been downloaded.

Output goes to the terminal only. Each line is a species name and a confidence percentage.

## Requirements

- macOS on Apple Silicon
- Node.js 20 or newer
- ffmpeg (`brew install ffmpeg`)

## Setup

```bash
npm install              # installs ONNX Runtime
npm run download-model   # deliberate, one-off download (~410 MB) into models/
```

## Usage

```bash
node bin/mybackyard.js devices                      # list microphones and their numbers
node bin/mybackyard.js listen --device 1            # identify birds live (Ctrl+C to stop)
node bin/mybackyard.js file recording.wav           # analyse a recording
node bin/mybackyard.js listen --threshold 30 --step 5 --verbose     # no window overlap
```

The first time you use `listen`, macOS asks whether your terminal app may use the microphone.

## About the confidence figure

Perch gives every one of its 14,795 classes an independent score. Several birds can score highly at once, and the scores don't add up to 100%. Google describes them as **uncalibrated**: a figure of 90% means a strong match, not a 90% chance of being correct. Tune `--threshold` against recordings whose species you already know.

Names are scientific names (e.g. *Turdus merula*). Mapping them to common names is not done yet.

## How it works

```
microphone / file → ffmpeg (32 kHz mono float) → 5-second windows → peak-normalise to 0.25
  → Perch (ONNX Runtime) → calibrate (logit × 0.97 − 10) → sigmoid → filter & print
```

The normalisation and calibration values match how Google's own [perch-hoplite](https://github.com/google-research/perch-hoplite) toolkit runs this same ONNX file (the `perch_v2_onnx` preset).

| File | Role |
|---|---|
| `src/audio.js` | Runs ffmpeg to capture or decode audio and stream raw samples |
| `src/windower.js` | Cuts the stream into 5-second (160,000-sample) windows, optionally overlapping |
| `src/perch.js` | Loads the model and labels, and turns model output into ranked results |
| `bin/mybackyard.js` | Command-line interface |
| `scripts/download-model.js` | Pinned, checksum-verified model download |

## Licensing and provenance

| Component | Source | Licence |
|---|---|---|
| Perch 2.0 model (original) | Google, [Kaggle](https://www.kaggle.com/models/google/bird-vocalization-classifier) | Apache 2.0 |
| `perch_v2.onnx` (ONNX conversion) | [justinchuby/Perch-onnx](https://huggingface.co/justinchuby/Perch-onnx), pinned commit `da88bf8` | Apache 2.0 |
| `labels.csv` | Assets from Google's release, via [cgeorgiaw/Perch](https://huggingface.co/cgeorgiaw/Perch), pinned commit `c3c3c81` | Apache 2.0 |
| ONNX Runtime | Microsoft, `onnxruntime-node` | MIT |
| ffmpeg | Called as a separate program, not bundled | LGPL/GPL (depends on build) |

This project deliberately uses **no** BirdNET code, models or data (BirdNET models and BirdNET-Pi are licensed CC BY-NC-SA 4.0, which does not allow commercial use).

Before any commercial release:
- Ship the Apache 2.0 licence text and attribution for Perch.
- Review the ffmpeg licence terms if ffmpeg is bundled with the app.
- Get legal advice on the residual question of Perch's training data (some of it, e.g. Xeno-Canto recordings, carries non-commercial licences).
