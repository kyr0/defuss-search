/**
 * Writes the website demo's corpus: the 2,000 benchmark passages, the 1,000 questions with their gold passage,
 * and the Winzling vectors of both, from the same dataset bytes and embedding cache as the recall benchmark.
 * Vectors stay float32. VERIFIED: in a 2026-11-01 probe, float16 halved the transfer but changed 9 of 1,000
 * efficient top-25 lists below the gold passage, which the reranker fuses, so the demo could drift from the
 * published figures. Gzip runs here, so every static host sends the same bytes; the worker unpacks them with
 * DecompressionStream. Run by `make bench` after the embeddings exist.
 * The manifest points each model at its pinned Hugging Face revision, so the site carries no model bytes.
 * VERIFIED (2026-11-02): gzip copies served by the site would transfer 2.09 MB and 29.08 MB instead of 2.43 MB and
 * 39.76 MB, but would add about 31 MB to the repository per model version; ARCH.md "Website demo" records why the
 * demo loads from Hugging Face.
 */
import { gzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { WINZLING_PROFILE } from 'defuss-vectorsearch/onnx.js';
import { datasetSha256, datasetUrl, loadDataset } from '../bench/dataset.mjs';
import { loadEmbeddings } from '../bench/embeddings.mjs';
import { downloadModels, modelRoot, releases } from './models.mjs';

const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
const { documents, queries, languages } = await loadDataset();
const { source } = JSON.parse(await readFile('input/tiny-embedding-bench-v1.json', 'utf8'));
const { vectors, queryVectors } = await loadEmbeddings({ documents, queries }, log);
const dims = vectors[0].length;
const row = new Map(documents.map((doc, i) => [doc.id, i]));
const corpus = {
  schema: 'defuss-search-demo-corpus.v1',
  dataset: {
    name: 'tiny-embedding-bench-v1',
    url: datasetUrl,
    sha256: datasetSha256,
    license: source.license,
    licenseUrl: source.license_url,
    attribution: source.attribution,
    citation: source.citation,
    changes: source.changes,
  },
  model: WINZLING_PROFILE.fingerprint,
  dims,
  languages,
  passages: {
    text: documents.map((doc) => doc.text),
    language: documents.map((doc) => languages.indexOf(doc.language)),
    group: documents.map((doc) => Number(doc.id.split(':')[0])),
  },
  queries: {
    text: queries.map((q) => q.text),
    language: queries.map((q) => languages.indexOf(q.language)),
    gold: queries.map((q) => row.get(q.target)),
  },
};
const json = Buffer.from(JSON.stringify(corpus));
const floats = Float32Array.from([...vectors, ...queryVectors].flat());
const binary = Buffer.from(floats.buffer);
const gzip = (bytes) => gzipSync(bytes, { level: 9 });
// Each model's pinned release with sizes and SHA-256 of the unpacked files, so the worker shows byte progress and
// caches only verified files without importing the model runtime first. `gzip` is each file's gzip -9 size, which the
// page shows next to the file size: the transfer from a host that sends the model files compressed.
const models = Object.fromEntries(
  releases.map((release) => [
    release.name,
    { base: `https://huggingface.co/${release.id}/resolve/${release.revision}/`, files: {} },
  ]),
);
for (const { file, bytes, sha256, model } of await downloadModels()) {
  const name = releases.find((release) => release.id === model).name;
  const packed = gzip(await readFile(`${modelRoot}/${name}/${file}`)).length;
  models[name].files[file] = { bytes, sha256, gzip: packed };
}
await mkdir('docs/data', { recursive: true });
const files = { corpus: ['corpus.json.gz', json], vectors: ['vectors.bin.gz', binary] };
const manifest = { schema: 'defuss-search-demo-manifest.v1', models };
for (const [key, [file, raw]] of Object.entries(files)) {
  const packed = gzip(raw);
  await writeFile(`docs/data/${file}`, packed);
  manifest[key] = { file, bytes: packed.length, rawBytes: raw.length };
}
Object.assign(manifest.vectors, { dims, passages: vectors.length, queries: queryVectors.length });
await writeFile('docs/data/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
log(
  `Demo corpus written passages=${documents.length} questions=${queries.length} corpus=${manifest.corpus.bytes} vectors=${manifest.vectors.bytes}`,
);
