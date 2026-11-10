/**
 * Writes the website demo's corpus: the 2,000 benchmark passages, the 1,000 questions with their gold passage,
 * and the Winzling vectors of both, from the same dataset bytes and embedding cache as the recall benchmark; and the
 * tiny factory's TurboQuant token index of the passages, from the ColBERT matrices the strategies benchmark caches,
 * so the page searches with the published index instead of encoding 2,000 passages in the browser.
 * Vectors stay float32. VERIFIED: in a 2026-11-01 probe, float16 halved the transfer but changed 9 of 1,000
 * efficient top-25 lists below the gold passage, which the reranker fuses, so the demo could drift from the
 * published figures. Brotli (defuss-brotli, quality 11) runs here, so every static host sends the same bytes; the
 * worker decodes them with defuss-brotli's WASM decoder, the one defuss-vectorsearch 0.4.0 uses for the models.
 * Why Brotli over gzip: the three files shrink further, and the page then loads one decoder for data and models.
 * VERIFIED (2026-11-09): 0.32 MB for the corpus, 4.23 MB for the vectors and 7.80 MB for the token index, against
 * 0.43, 4.29 and 8.89 MB gzipped.
 * Run by `make bench` after the embeddings exist.
 * The manifest points each model at its pinned Hugging Face revision, which serves every file as `<file>.br`, and
 * records each `.br` size, so the site carries no model bytes and quotes the bytes a browser downloads.
 */
import { compress, init as initCompressor } from 'defuss-brotli/compressor';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { buildColbertTokenIndex } from 'defuss-search/colbert';
import { WINZLING_PROFILE, createColbertReranker } from 'defuss-vectorsearch/onnx.js';
import { cachedMatrices } from '../bench/corpora.mjs';
import { datasetSha256, datasetUrl, loadDataset } from '../bench/dataset.mjs';
import { loadEmbeddings } from '../bench/embeddings.mjs';
import { packTokenIndex } from '../website/token-index.mjs';
import { brotliSize, downloadModels, loadModelFile, releases } from './models.mjs';

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
await initCompressor();
// Each model's pinned release with sizes and SHA-256 of the decoded files, so the worker checks and caches only
// verified files without importing the model runtime first; `brotli` is the size of the `.br` file it downloads,
// which the page shows and its progress counts.
const models = Object.fromEntries(
  releases.map((release) => [
    release.name,
    { base: `https://huggingface.co/${release.id}/resolve/${release.revision}/`, files: {} },
  ]),
);
for (const { file, bytes, sha256, model } of await downloadModels()) {
  const name = releases.find((release) => release.id === model).name;
  models[name].files[file] = { bytes, sha256, brotli: await brotliSize(name, file) };
}
// The strategies benchmark encodes with this model on the CPU and caches the matrices; a cache miss encodes here.
let colbert;
const matrices = await cachedMatrices(
  'belebele',
  documents.map((doc) => doc.text),
  async () =>
    (colbert ??= createColbertReranker({
      model: '1.5m',
      precision: 'q8',
      device: 'cpu',
      numThreads: 1,
      loadFile: loadModelFile('colbert'),
      allowRemoteModels: false,
    })),
);
await colbert?.dispose();
const tokens = packTokenIndex(buildColbertTokenIndex(matrices));
await mkdir('docs/data', { recursive: true });
const files = {
  corpus: ['corpus.json.br', json],
  vectors: ['vectors.bin.br', binary],
  tokens: ['tokens.bin.br', tokens.bytes],
};
const manifest = { schema: 'defuss-search-demo-manifest.v2', models };
for (const [key, [file, raw]] of Object.entries(files)) {
  const packed = compress(raw);
  await writeFile(`docs/data/${file}`, packed);
  manifest[key] = { file, bytes: packed.length, rawBytes: raw.length };
}
Object.assign(manifest.vectors, { dims, passages: vectors.length, queries: queryVectors.length });
// cachedMatrices keys its cache by the pinned ColBERT files, so the matrices come from this release.
const pin = releases.find((release) => release.name === 'colbert');
Object.assign(manifest.tokens, {
  model: `${pin.id}@${pin.revision}:${pin.files['model_q8.onnx']}`,
  ...tokens.meta,
});
await writeFile('docs/data/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
log(
  `Demo corpus written passages=${documents.length} questions=${queries.length} corpus=${manifest.corpus.bytes} vectors=${manifest.vectors.bytes} tokens=${manifest.tokens.bytes}`,
);
