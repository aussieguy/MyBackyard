# MyBackyard

A proof of concept that identifies birds from live microphone audio, or from recordings, on a Mac. It uses Google's **Perch 2.0** bioacoustics model and runs entirely offline once the model has been downloaded.

It can be used two ways: a **web interface** in your browser, or a plain **command line** that prints each species name and its confidence percentage.

## Requirements

- macOS on Apple Silicon
- Node.js 20 or newer
- ffmpeg (`brew install ffmpeg`)

## Setup

```bash
npm install              # installs ONNX Runtime
npm run download-model   # deliberate, one-off download (~410 MB) into models/
npm run build-species-index   # optional, deliberate: common names, bird/non-bird sorting, photo credits (~10-20 min)
```

The species index comes from Wikidata (names and categories, public domain) and Wikimedia Commons (photo addresses and credits). Without it, everything still works but species show scientific names only and photos are unavailable.

## Web interface

```bash
node bin/mybackyard.js serve --device 1              # then open http://localhost:8420
node bin/mybackyard.js serve --file recording.wav    # play a recording in real time instead of a mic
```

- **Now hearing** shows the latest bird with a confidence ring, plus any others heard at the same moment.
- **Heard this session** has one card per species, with its best confidence and number of visits. Repeat detections within 15 seconds count as the same visit.
- **Live feed** lists every detection. Non-bird sounds (speech, dogs, frogs, insects…) are greyed out and tagged.
- **Controls:** microphone, confidence threshold (re-filters everything already heard), window step (1 / 2.5 / 5 s) and **Show photos**.
- **Photos are off by default.** When on, photos load from Wikimedia Commons, each credited to its photographer. When off, nothing is fetched from the internet.
- **Nothing is saved.** The session lives in the page and disappears on reload. The server only accepts connections from this Mac.

## Command line

```bash
node bin/mybackyard.js devices                      # list microphones and their numbers
node bin/mybackyard.js listen --device 1            # identify birds live (Ctrl+C to stop)
node bin/mybackyard.js file recording.wav           # analyse a recording
node bin/mybackyard.js listen --threshold 30 --step 5 --verbose     # no window overlap
```

The first time you use `listen`, macOS asks whether your terminal app may use the microphone.

## About the confidence figure

Perch gives every one of its 14,795 classes an independent score. Several birds can score highly at once, and the scores don't add up to 100%. Google describes them as **uncalibrated**: a figure of 90% means a strong match, not a 90% chance of being correct. Tune `--threshold` against recordings whose species you already know.

The command line shows scientific names (e.g. *Turdus merula*). The web interface shows common names once the species index is built.

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
| `src/species.js` | Adds common names, bird/non-bird kind and photo info to each result |
| `src/engine.js` | The listening loop behind the web interface: pause, resume, restart with new settings, level meter |
| `src/server.js` | Local-only web server; pushes live updates to the page with Server-Sent Events |
| `public/` | The web page (plain HTML, CSS and JavaScript; no framework or build step) |
| `bin/mybackyard.js` | Command-line interface (`devices`, `listen`, `file`, `serve`) |
| `scripts/download-model.js` | Pinned, checksum-verified model download |
| `scripts/build-species-index.js` | Builds the species index from Wikidata and Wikimedia Commons |

## Licensing and provenance

| Component | Source | Licence |
|---|---|---|
| Perch 2.0 model (original) | Google, [Kaggle](https://www.kaggle.com/models/google/bird-vocalization-classifier) | Apache 2.0 |
| `perch_v2.onnx` (ONNX conversion) | [justinchuby/Perch-onnx](https://huggingface.co/justinchuby/Perch-onnx), pinned commit `da88bf8` | Apache 2.0 |
| `labels.csv` | Assets from Google's release, via [cgeorgiaw/Perch](https://huggingface.co/cgeorgiaw/Perch), pinned commit `c3c3c81` | Apache 2.0 |
| Common names, categories | [Wikidata](https://www.wikidata.org) | CC0 (public domain) |
| Bird photos | [Wikimedia Commons](https://commons.wikimedia.org), linked not copied | Per photo (mostly CC BY / CC BY-SA): credit shown with each photo |
| ONNX Runtime | Microsoft, `onnxruntime-node` | MIT |
| ffmpeg | Called as a separate program, not bundled | LGPL/GPL (depends on build) |

This project deliberately uses **no** BirdNET code, models or data (BirdNET models and BirdNET-Pi are licensed CC BY-NC-SA 4.0, which does not allow commercial use).

![alt text](<Screenshot 2026-10-17 at 5.26.23 pm.png>)