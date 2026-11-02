/** Real model providers establish that a skipped neural stage performs zero model reads. */
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import de from 'defuss-lexicalsearch/de';
import { createHybridIndex } from 'defuss-search/indexing';
import { createColbertAdapter } from 'defuss-search/colbert';
import { searchPreset } from 'defuss-search';
import { documents, query } from '../fixtures/confident-winner.mjs';
import { downloadModels, loadModelFile } from './models.mjs';
const device = process.argv.includes('--wasm') ? 'wasm' : 'cpu';
const { createWinzlingEmbedder, createColbertReranker } = await import(
  device === 'wasm' ? 'defuss-vectorsearch/browser.js' : 'defuss-vectorsearch/onnx.js'
);
await downloadModels();
let neuralReads = 0;
const embedder = createWinzlingEmbedder({
  device,
  numThreads: 1,
  loadFile: loadModelFile('winzling'),
  allowRemoteModels: false,
});
const neuralLoader = loadModelFile('colbert');
const colbert = createColbertReranker({
  model: '1.5m',
  precision: 'q8',
  device,
  numThreads: 1,
  loadFile: async (file) => {
    neuralReads++;
    return neuralLoader(file);
  },
  allowRemoteModels: false,
});
try {
  const vectors = await embedder.embedDocuments(documents.map((x) => x.fields.text));
  const vector = await embedder.embedQuery(query);
  const texts = new Map(documents.map((x) => [x.id, x.fields.text]));
  const search = createHybridIndex({
    documents,
    vectors,
    lexical: { analyzer: de },
    reranker: createColbertAdapter(colbert, (id) => texts.get(id)),
    defaults: searchPreset('reranked'),
  });
  const gated = await search.searchWithStats({ text: query, vector });
  assert.equal(gated.hits[0].id, 'library');
  assert.equal(gated.rerankDecision.action, 'skipped');
  assert.ok(gated.rerankDecision.margin >= 0.1);
  assert.equal(neuralReads, 0, 'Gate must run before the first ColBERT load');
  assert.equal(gated.counts.reranked, 0);
  assert.ok(gated.hits.every((hit) => !hit.signals.reranker));
  const always = await search.searchWithStats(
    { text: query, vector },
    { rerank: { skipIfVectorMargin: Infinity } },
  );
  assert.ok(neuralReads > 0);
  assert.equal(always.counts.reranked, documents.length);
  assert.equal(always.rerankDecision.action, 'applied');
  assert.equal(
    always.hits[0].id,
    gated.hits[0].id,
    'Low-weight reranking preserves the prior winner',
  );
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const runtime = process.versions.bun ? 'bun' : 'node';
  await writeFile(
    `output/gate-${runtime}-${device}.json`,
    JSON.stringify(
      {
        version: pkg.version,
        runtime: process.versions.bun ?? process.version,
        device,
        modelReadsBeforeSkippedStage: 0,
        modelReadsAfterForcedStage: neuralReads,
        gated,
        always,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `${new Date().toISOString()} INFO PASS: ${runtime} ${device}, source margin gate, zero neural loads, forced inference`,
  );
} finally {
  await embedder.dispose();
  await colbert.dispose();
}
