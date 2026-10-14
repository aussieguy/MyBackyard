#!/usr/bin/env node
// ---------------------------------------------------------------------------
// download-model.js
//
// Downloads the two files MyBackyard needs to identify birds:
//
//   1. perch_v2.onnx  (~409 MB) - the neural network itself (Google Perch 2.0,
//      converted from Google's TensorFlow release to ONNX format by the
//      Hugging Face user "justinchuby"). Licence: Apache 2.0.
//   2. labels.csv     (~0.3 MB) - the list of 14,795 species / sound names,
//      in the same order as the model's outputs. Taken from a copy of
//      Google's original release ("cgeorgiaw/Perch"). Licence: Apache 2.0.
//
// This script is NEVER run automatically. You run it on purpose with:
//
//     npm run download-model
//
// Both URLs are "pinned" to a specific commit of each Hugging Face repo, so
// that if someone later changes the files on Hugging Face we still get the
// exact same files we tested with. The model file is also checked against
// a SHA-256 fingerprint so a corrupted or tampered download is rejected.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Where downloaded files are saved (MyBackyard/models/).
const MODELS_DIR = path.join(__dirname, '..', 'models');

const FILES = [
  {
    name: 'perch_v2.onnx',
    url: 'https://huggingface.co/justinchuby/Perch-onnx/resolve/da88bf8c37c0b3068fc706fe509f633b9fbd28c1/perch_v2.onnx',
    // SHA-256 fingerprint published by Hugging Face for this exact file.
    // If even one byte differs, the fingerprint will not match.
    sha256: 'bf0c8467a924cb074663970ca4a0ab1e143602121930209657d0dff5d5cefa1f',
  },
  {
    name: 'labels.csv',
    url: 'https://huggingface.co/cgeorgiaw/Perch/resolve/c3c3c816976a6c1bb75140b8fbaef7397a6f708f/assets/labels.csv',
    // Hugging Face doesn't publish a SHA-256 for small (non-LFS) files, so
    // instead we sanity-check the line count after downloading:
    // 1 header line + 14,795 labels, one per model output.
    expectedLines: 14796,
  },
];

// Turns a byte count into something readable, e.g. 409148616 -> "390.2 MB".
function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Downloads one file, showing progress, while computing its SHA-256 as it
// streams in (so we don't have to re-read 400 MB from disk afterwards).
async function downloadFile(file) {
  const destination = path.join(MODELS_DIR, file.name);

  // We first download to a ".partial" file and only rename it to the real
  // name once it has been fully downloaded AND verified. That way an
  // interrupted download can never be mistaken for a good one.
  const partial = `${destination}.partial`;

  console.log(`\nDownloading ${file.name}`);
  console.log(`  from ${file.url}`);

  // fetch() is built into Node 18+. Hugging Face redirects to a CDN; fetch
  // follows redirects automatically.
  const response = await fetch(file.url);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const totalBytes = Number(response.headers.get('content-length')) || 0;
  let receivedBytes = 0;
  let lastPercentShown = -1;
  const hash = crypto.createHash('sha256');

  // Convert the web-style stream from fetch() into a Node stream so we can
  // pipe it into a file.
  const body = Readable.fromWeb(response.body);

  // Every chunk that arrives: feed it to the hash and update the progress.
  body.on('data', (chunk) => {
    hash.update(chunk);
    receivedBytes += chunk.length;
    if (totalBytes) {
      const percent = Math.floor((receivedBytes / totalBytes) * 100);
      if (percent !== lastPercentShown) {
        lastPercentShown = percent;
        // "\r" returns the cursor to the start of the line so the progress
        // overwrites itself rather than printing 100 lines.
        process.stdout.write(`\r  ${percent}%  (${formatBytes(receivedBytes)} of ${formatBytes(totalBytes)})`);
      }
    }
  });

  // pipeline() writes the download to disk and waits until it's finished
  // (and cleans up properly if anything goes wrong part-way).
  await pipeline(body, fs.createWriteStream(partial));
  process.stdout.write('\n');

  // --- Verify the download -------------------------------------------------
  if (file.sha256) {
    const actual = hash.digest('hex');
    if (actual !== file.sha256) {
      fs.rmSync(partial, { force: true });
      throw new Error(
        `Checksum mismatch for ${file.name}.\n  expected ${file.sha256}\n  got      ${actual}\n` +
        'The partial file has been deleted. Try again, and if it keeps failing the file on Hugging Face may have changed.'
      );
    }
    console.log('  Checksum OK');
  }

  if (file.expectedLines) {
    const text = fs.readFileSync(partial, 'utf8');
    // trimEnd() ignores a trailing newline at the end of the file.
    const lines = text.trimEnd().split('\n').length;
    if (lines !== file.expectedLines) {
      fs.rmSync(partial, { force: true });
      throw new Error(`${file.name} has ${lines} lines, expected ${file.expectedLines}.`);
    }
    console.log(`  Line count OK (${lines})`);
  }

  // Everything checked out - move it into place under its real name.
  fs.renameSync(partial, destination);
  console.log(`  Saved to ${destination}`);
}

async function main() {
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  for (const file of FILES) {
    const destination = path.join(MODELS_DIR, file.name);
    // Skip files we already have, so re-running the script is cheap.
    if (fs.existsSync(destination)) {
      console.log(`${file.name} already downloaded - skipping (delete it to re-download).`);
      continue;
    }
    await downloadFile(file);
  }

  console.log('\nAll model files are ready.');
}

main().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exit(1);
});
