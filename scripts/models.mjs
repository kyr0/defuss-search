/**
 * VERIFIED: download the pinned Winzling and ColBERT files once, verify each SHA-256 and rename atomically, so
 * every model check and benchmark loads identical bytes with remote loading disabled.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decompress, init as initDecoder } from 'defuss-brotli/decompressor';
import {
  WINZLING_MODEL_ID,
  WINZLING_REVISION,
  WINZLING_FILES,
  MOEDERNCOLBERT_MODELS,
} from 'defuss-vectorsearch/onnx.js';
export const modelRoot = resolve(process.env.DEFUSS_MODEL_DIR || '.models');
const colbert = MOEDERNCOLBERT_MODELS['1.5m'];
export const releases = [
  { name: 'winzling', id: WINZLING_MODEL_ID, revision: WINZLING_REVISION, files: WINZLING_FILES },
  {
    name: 'colbert',
    id: colbert.id,
    revision: colbert.revision,
    files: Object.fromEntries(
      Object.entries(colbert.files).filter(
        ([name]) => !name.endsWith('.onnx') || name === 'model_q8.onnx',
      ),
    ),
  },
];
export async function downloadModels() {
  const manifest = [];
  for (const release of releases)
    for (const [name, sha256] of Object.entries(release.files)) {
      const file = resolve(modelRoot, release.name, name);
      const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
      let bytes;
      try {
        bytes = await readFile(file);
        if (digest(bytes) !== sha256) bytes = undefined;
      } catch {
        /* fetch absent files */
      }
      if (!bytes) {
        const url = `https://huggingface.co/${release.id}/resolve/${release.revision}/${name}`;
        console.log(`${new Date().toISOString()} INFO Downloading ${release.name}/${name}`);
        let last;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
            if (!response.ok) throw new Error(`${response.status} ${url}`);
            bytes = new Uint8Array(await response.arrayBuffer());
            if (digest(bytes) !== sha256) throw new Error(`SHA-256 mismatch: ${name}`);
            break;
          } catch (error) {
            last = error;
            bytes = undefined;
          }
        }
        if (!bytes) throw last;
        await mkdir(dirname(file), { recursive: true });
        await writeFile(`${file}.partial`, bytes);
        await rename(`${file}.partial`, file);
      }
      manifest.push({
        model: release.id,
        revision: release.revision,
        file: name,
        sha256,
        bytes: bytes.length,
      });
    }
  await mkdir('output', { recursive: true });
  await writeFile('output/model-assets.json', JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export const loadModelFile = (name) => async (file) =>
  new Uint8Array(await readFile(resolve(modelRoot, name, file)));

/**
 * The pinned file as browsers download it: `<file>.br` from the same revision (defuss-vectorsearch 0.4.0 serves
 * every model file so), kept next to the file. Its decoded bytes must match the pin, so the size the website quotes
 * belongs to the bytes inference checks. Returns the `.br` size in bytes.
 */
export async function brotliSize(name, file) {
  const release = releases.find((entry) => entry.name === name);
  const path = resolve(modelRoot, name, `${file}.br`);
  let bytes;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    const url = `https://huggingface.co/${release.id}/resolve/${release.revision}/${file}.br`;
    console.log(`${new Date().toISOString()} INFO Downloading ${name}/${file}.br`);
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  await initDecoder();
  const digest = createHash('sha256').update(decompress(bytes)).digest('hex');
  if (digest !== release.files[file]) throw new Error(`SHA-256 mismatch after decoding: ${name}/${file}.br`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return bytes.length;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await downloadModels();
