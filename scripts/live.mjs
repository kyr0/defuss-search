/**
 * Native CPU integration: real Winzling and ColBERT over the API fixture, all strategies and presets.
 * VERIFIED: recorded vectors cannot show that ONNX loading, tokenization and score mapping work; this does.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  createWinzlingEmbedder,
  createColbertReranker,
  WINZLING_PROFILE,
} from 'defuss-vectorsearch/onnx.js';
import { apiSearchPreset } from 'defuss-lexicalsearch';
import { searchPreset } from 'defuss-search';
import { createHybridIndex } from 'defuss-search/indexing';
import { createColbertAdapter } from 'defuss-search/colbert';
import { documents, queries, documentText } from '../fixtures/api-corpus.mjs';
import { downloadModels, loadModelFile } from './models.mjs';
await downloadModels();
const embedder = createWinzlingEmbedder({
  device: 'cpu',
  numThreads: 1,
  loadFile: loadModelFile('winzling'),
  allowRemoteModels: false,
});
const reranker = createColbertReranker({
  model: '1.5m',
  precision: 'q8',
  device: 'cpu',
  numThreads: 1,
  loadFile: loadModelFile('colbert'),
  allowRemoteModels: false,
});
const started = performance.now();
try {
  const texts = new Map(documents.map((doc) => [doc.id, documentText(doc)]));
  console.log(
    `${new Date().toISOString()} INFO Embedding ${documents.length} documents and ${queries.length} queries with real Winzling`,
  );
  const vectors = await embedder.embedDocuments(documents.map(documentText));
  const queryVectors = await Promise.all(queries.map((query) => embedder.embedQuery(query.text)));
  const index = createHybridIndex({
    documents,
    vectors,
    lexical: apiSearchPreset,
    lexicalSearch: { exact: { fields: ['symbol'] } },
    reranker: createColbertAdapter(reranker, (id) => texts.get(id)),
  });
  const records = [];
  for (let i = 0; i < queries.length; i++) {
    const query = { text: queries[i].text, vector: queryVectors[i] };
    for (const strategy of ['vector-first', 'lexical-first', 'fusion']) {
      const plain = await index.searchWithStats(query, { strategy, rerank: false, limit: 100 });
      const result = await index.searchWithStats(query, {
        strategy,
        rerank: { candidates: 25 },
        exact: 'promote',
        limit: 100,
      });
      assert.ok(result.hits.every((hit) => Number.isFinite(hit.score) && texts.has(hit.id)));
      assert.equal(new Set(result.hits.map((x) => x.id)).size, result.hits.length);
      assert.ok(result.counts.reranked <= 25);
      if (strategy !== 'fusion')
        assert.ok(
          result.hits.every((hit) => plain.hits.some((x) => x.id === hit.id)),
          'cascade must not expand recall ceiling',
        );
      if (strategy === 'fusion' && queries[i].exact)
        assert.equal(result.hits[0].id, Object.keys(queries[i].relevant)[0]);
      records.push({
        query: query.text,
        strategy,
        plain: plain.hits.map((x) => ({ id: x.id, score: x.score })),
        reranked: result.hits.map((x) => ({ id: x.id, score: x.score, exact: x.exact })),
        counts: result.counts,
        timings: result.timings,
      });
    }
    console.log(`${new Date().toISOString()} INFO query ${i + 1}/${queries.length}: ${query.text}`);
  }
  const presetRecords = [];
  for (let i = 0; i < queries.length; i++) {
    for (const preset of ['efficient', 'reranked']) {
      const response = await index.searchWithStats(
        { text: queries[i].text, vector: queryVectors[i] },
        {
          ...searchPreset(preset),
          exact: 'promote',
          limit: 100,
        },
      );
      if (queries[i].exact) assert.equal(response.hits[0].id, Object.keys(queries[i].relevant)[0]);
      if (preset === 'efficient') assert.equal(response.counts.reranked, 0);
      presetRecords.push({ query: queries[i].text, preset, response });
    }
  }
  const filter = new Set(['array.push', 'array.pop']);
  const filtered = await index.search(
    { text: 'add an item', vector: queryVectors[5] },
    { ids: filter, rerank: { candidates: 2 } },
  );
  assert.ok(filtered.every((hit) => filter.has(hit.id)));
  const precomputed = {
    model: WINZLING_PROFILE,
    documents,
    vectors: vectors.map((x) => Array.from(x)),
    queries: queries.map((q, i) => ({ ...q, vector: Array.from(queryVectors[i]) })),
  };
  await mkdir('input', { recursive: true });
  await mkdir('output', { recursive: true });
  await writeFile('fixtures/api-embeddings.json', JSON.stringify(precomputed) + '\n');
  await writeFile(
    `output/live-${process.versions.bun ? 'bun' : 'node'}.json`,
    JSON.stringify(
      {
        version: JSON.parse(await readFile('package.json', 'utf8')).version,
        runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
        platform: process.platform,
        model: WINZLING_PROFILE.fingerprint,
        reranker: 'MoEdernColBERT 1.5m q8 / CPU',
        documents: documents.length,
        queries: queries.length,
        comparisons: records.length + presetRecords.length,
        elapsedMs: performance.now() - started,
        records,
        presetRecords,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `${new Date().toISOString()} INFO PASS: ${records.length + presetRecords.length} real-model strategy/preset comparisons; vectors and report written.`,
  );
} finally {
  await embedder.dispose();
  await reranker.dispose();
}
