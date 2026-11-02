/**
 * VERIFIED: download the pinned Winzling and ColBERT files once, verify each SHA-256 and rename atomically, so
 * every model check and benchmark loads identical bytes with remote loading disabled.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await downloadModels();
