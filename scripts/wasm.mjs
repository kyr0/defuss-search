/**
 * The browser entry of defuss-vectorsearch (onnxruntime-web WASM) in Bun or Node.js: a fast check of
 * the browser code path without a browser (VERIFIED: Bun and Node.js, 2026-10-31); the Chromium e2e and recall benchmark cover a real one.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createWinzlingEmbedder, createColbertReranker } from 'defuss-vectorsearch/browser.js';
import { createHybridIndex } from 'defuss-search/indexing';
import { createColbertAdapter } from 'defuss-search/colbert';
import { apiSearchPreset } from 'defuss-lexicalsearch';
import { downloadModels, loadModelFile } from './models.mjs';
await downloadModels();
const data = JSON.parse(await readFile('fixtures/api-embeddings.json', 'utf8'));
const embedder = createWinzlingEmbedder({
  device: 'wasm',
  numThreads: 1,
  loadFile: loadModelFile('winzling'),
  allowRemoteModels: false,
});
const reranker = createColbertReranker({
  model: '1.5m',
  precision: 'q8',
  device: 'wasm',
  numThreads: 1,
  loadFile: loadModelFile('colbert'),
  allowRemoteModels: false,
});
try {
  const texts = new Map(
    data.documents.map((doc) => [doc.id, `${doc.fields.symbol}\n${doc.fields.description}`]),
  );
  const index = createHybridIndex({
    documents: data.documents,
    vectors: data.vectors,
    embedQuery: (text) => embedder.embedQuery(text),
    lexical: apiSearchPreset,
    lexicalSearch: { exact: { fields: ['symbol'] } },
    reranker: createColbertAdapter(reranker, (id) => texts.get(id)),
  });
  const responses = [];
  for (const strategy of ['fusion', 'vector-first', 'lexical-first']) {
    const result = await index.searchWithStats('C++', { strategy, exact: 'promote' });
    assert.equal(result.hits[0].id, 'c++');
    assert.ok(result.counts.reranked > 0);
    responses.push(result);
  }
  await writeFile(
    `output/live-wasm-${process.versions.bun ? 'bun' : 'node'}.json`,
    JSON.stringify(
      {
        version: JSON.parse(await readFile('package.json', 'utf8')).version,
        runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
        backend: 'onnxruntime-web WASM using browser entry in a CLI runtime (not a browser)',
        responses,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `${new Date().toISOString()} INFO PASS: real browser-entry WASM models in CLI runtime, all three strategies`,
  );
} finally {
  await embedder.dispose();
  await reranker.dispose();
}
