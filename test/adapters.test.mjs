import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LexicalSearch, apiSearchPreset } from 'defuss-lexicalsearch';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
import { createHybridIndex } from 'defuss-search/indexing';
import { createColbertAdapter } from 'defuss-search/colbert';
import { HybridSearch } from 'defuss-search';
import { fixture, documents, vectors } from './fixture.mjs';
const ids = (hits) => hits.map((x) => x.id);

test('exact promotion works alongside fuzzy, prefix and substring retrieval defaults', async () => {
  const { index, vector } = fixture();
  const lexical = createLexicalRetriever(index, {
    search: { fuzzy: 1, prefix: true, substring: true, transpositions: true },
    exact: { fields: ['symbol'] },
  });
  const search = new HybridSearch({ lexical, vector });
  const hits = await search.search({ text: 'C++', vector: [0, 1, 0] }, { exact: 'promote' });
  assert.equal(hits[0].id, 'api/c++');
  assert.equal(hits[0].exact, true);
});

test('lexical restriction preserves full-corpus BM25 scores and caller options', async () => {
  const { index } = fixture();
  const options = {
    search: {
      fields: ['description'],
      ids: new Set(['api/c', 'api/c++']),
      filter: (metadata) => metadata.public,
      exclude: ['sharp'],
    },
    exact: { fields: ['symbol'] },
  };
  const adapter = createLexicalRetriever(index, options);
  options.search.fields[0] = 'symbol';
  options.search.ids.clear();
  options.exact.fields[0] = 'description';
  const query = { text: 'programming language' };
  const scope = new Set(['api/c++', 'api/c#']);
  const full = index.search(query.text, { fields: ['description'], limit: 20 });
  const result = await adapter.rescore(query, { limit: 10, ids: scope });
  assert.deepEqual(ids(result), ['api/c++']);
  assert.equal(result[0].score, full.find((x) => x.id === 'api/c++').score);
  assert.deepEqual(ids(await adapter.exact({ text: 'C++' }, { limit: 10 })), ['api/c++']);
  assert.deepEqual(await adapter.exact({ text: 'c++' }, { limit: 10 }), []);
  assert.deepEqual(await adapter.retrieve(query, { limit: 0 }), []);
});
test('lexical API forwards literal substring, phrase, exclusions and fuzzy options', async () => {
  const { index } = fixture();
  for (const search of [
    { mode: 'substring', fields: ['symbol'] },
    { operator: 'all', fields: ['description'], exclude: ['Remove'] },
    { fuzzy: 1, transpositions: true },
  ]) {
    const adapter = createLexicalRetriever(index, { search });
    const query = {
      text: search.mode ? 'prototype.' : search.fuzzy ? 'programing' : 'element array',
    };
    assert.deepEqual(
      await adapter.retrieve(query, { limit: 10 }),
      index
        .search(query.text, { ...search, limit: 10 })
        .map(({ id, score, tier }) => ({ id, score, ...(tier ? { tier } : {}) })),
    );
  }
});
test('vector cosine and dot match independent numeric expectations with stable string IDs', async () => {
  const corpus = [
      [3, 4],
      [4, 3],
      [-3, -4],
    ],
    names = ['b', 'a', '__proto__'];
  const cosine = createVectorRetriever({ ids: names, vectors: corpus });
  const out = await cosine.retrieve({ text: '', vector: [3, 4] }, { limit: 3 });
  assert.deepEqual(ids(out), ['b', 'a', '__proto__']);
  assert.ok(Math.abs(out[0].score - 1) < 1e-6);
  assert.ok(Math.abs(out[1].score - 0.96) < 1e-6);
  const dot = createVectorRetriever({ ids: names, vectors: corpus, metric: 'dot' });
  assert.equal((await dot.retrieve({ text: '', vector: [3, 4] }, { limit: 3 }))[0].score, 25);
});
test('vector snapshot is isolated, eligibility is pre-top-k, and rescoring uses exact floats', async () => {
  const names = ['a', 'b', 'c'],
    corpus = [
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
  const adapter = createVectorRetriever({
    ids: names,
    vectors: corpus,
    strategy: 'turboquant',
    refineCandidates: 3,
  });
  names[2] = 'changed';
  corpus[2][0] = 1;
  const result = await adapter.retrieve(
    { text: '', vector: [1, 0] },
    { limit: 1, ids: new Set(['c']) },
  );
  assert.deepEqual(ids(result), ['c']);
  assert.equal(result[0].score, -1);
  const raw = createVectorRetriever({
    ids: ['b', 'a'],
    vectors: [
      [1, 0],
      [1, 0],
    ],
    strategy: 'turboquant',
  });
  assert.deepEqual(ids(await raw.retrieve({ text: 'x', vector: [1, 0] }, { limit: 1 })), ['a']);
  assert.equal((await raw.rescore({ text: 'x', vector: [1, 0] }, { limit: 1 }))[0].score, 1);
});
test('vector validation: dimensions, zero norm, float overflow, duplicates, empty corpus, and embedding path', async () => {
  for (const config of [
    { ids: ['a'], vectors: [] },
    {
      ids: ['a', 'a'],
      vectors: [
        [1, 0],
        [1, 0],
      ],
    },
    { ids: ['a'], vectors: [[0, 0]] },
    { ids: ['a'], vectors: [[NaN, 1]] },
    { ids: ['a'], vectors: [[1e100, 0]], metric: 'dot' },
    { ids: ['a'], vectors: [[1, 0]], strategy: 'turboquant', metric: 'dot' },
  ])
    assert.throws(() => createVectorRetriever(config));
  const empty = createVectorRetriever({ ids: [], vectors: [] });
  assert.deepEqual(await empty.retrieve({ text: 'x' }, { limit: 10 }), []);
  const adapter = createVectorRetriever({
    ids: ['a'],
    vectors: [[1e300, 1e300]],
    embedQuery: () => [1e-300, 1e-300],
  });
  assert.ok(Math.abs((await adapter.retrieve({ text: 'x' }, { limit: 1 }))[0].score - 1) < 1e-6);
  await assert.rejects(
    adapter.retrieve({ text: 'x', vector: [1, 0, 0] }, { limit: 1 }),
    /dimensions/,
  );
  await assert.rejects(
    createVectorRetriever({ ids: ['a'], vectors: [[1, 0]] }).retrieve({ text: 'x' }, { limit: 1 }),
    /embedQuery/,
  );
});
test('immutable index owns the documents, metadata and vector row mapping', async () => {
  const docs = structuredClone(documents),
    vec = vectors.map((x) => x.slice());
  const index = createHybridIndex({
    documents: docs,
    vectors: vec,
    lexical: apiSearchPreset,
    lexicalSearch: { exact: { fields: ['symbol'] } },
  });
  docs[0].fields.symbol = 'broken';
  vec[0][0] = 0;
  const copy = index.get('api/c++');
  copy.fields.symbol = 'also broken';
  copy.metadata.public = false;
  assert.equal(index.get('api/c++').fields.symbol, 'C++');
  assert.equal(index.get('api/c++').metadata.public, true);
  assert.equal(index.size, 7);
  assert.equal(
    (await index.search({ text: 'C++', vector: [1, 0, 0] }, { exact: 'promote' }))[0].id,
    'api/c++',
  );
  assert.equal(
    (await index.searchWithStats({ text: 'C++', vector: [1, 0, 0] })).totalCandidates,
    7,
  );
  assert.equal(index.get('absent'), undefined);
});

// A real deterministic reranking algorithm exercises the adapter contract without model downloads.
const lengthReranker = {
  rerank(_query, texts, { topK }) {
    return texts
      .map((text, index) => ({ index, score: text.length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  },
};
test('raw reranker maps relative indices to IDs and keeps both fusion explanations', async () => {
  const texts = new Map(documents.map((d) => [d.id, d.fields.description]));
  const adapter = createColbertAdapter(lengthReranker, (id) => texts.get(id));
  const candidateIds = ['api/c', 'method/push', '__proto__'];
  assert.equal((await adapter.rerank({ text: 'x' }, candidateIds, {}))[0].id, 'method/push');
  const { lexical, vector } = fixture();
  const engine = new HybridSearch({ lexical, vector, reranker: adapter });
  const q = { text: 'programming language', vector: [1, 0, 0] };
  const base = await engine.search(q, { rerank: false, limit: 20 });
  const out = await engine.search(q, { rerank: { candidates: 3 }, limit: 20 });
  assert.deepEqual(ids(out.slice(3)), ids(base.slice(3)));
  assert.ok(
    out
      .slice(0, 3)
      .every(
        (x) =>
          x.scoreKind === 'rerank-rrf' &&
          x.contributions &&
          x.rerankContributions &&
          x.signals.reranker,
      ),
  );
  const exact = await engine.search(
    { text: 'C++', vector: [0, 1, 0] },
    {
      exact: 'promote',
      rerank: { method: 'replace', candidates: 7 },
      balance: { window: 3, lexical: 1, vector: 1 },
    },
  );
  assert.equal(exact[0].id, 'api/c++');
  assert.equal(exact[0].scoreKind, 'reranker');
});
test('reranker contract rejects incomplete, duplicate, out-of-range, unordered and missing-text results', async () => {
  for (const ranked of [
    [{ index: 0, score: 1 }],
    [
      { index: 0, score: 1 },
      { index: 0, score: 0 },
    ],
    [
      { index: 0, score: 1 },
      { index: 2, score: 0 },
    ],
    [
      { index: 0, score: 0 },
      { index: 1, score: 1 },
    ],
    [
      { index: 0, score: NaN },
      { index: 1, score: 0 },
    ],
  ]) {
    const broken = createColbertAdapter({ rerank: () => ranked }, (id) => id);
    await assert.rejects(broken.rerank({ text: 'x' }, ['a', 'b'], {}));
  }
  await assert.rejects(
    createColbertAdapter(lengthReranker, () => undefined).rerank({ text: 'x' }, ['a'], {}),
    /Missing text/,
  );
  assert.deepEqual(
    await createColbertAdapter(lengthReranker, (id) => id).rerank({ text: 'x' }, [], {}),
    [],
  );
  const { lexical, vector } = fixture();
  await assert.rejects(
    new HybridSearch({ lexical, vector, reranker: { rerank: () => [] } }).search({
      text: 'C',
      vector: [1, 0, 0],
    }),
    /every candidate/,
  );
});
test('exact promotion and coverage conflict is explicit; overlaps can satisfy both quotas', async () => {
  const index = new LexicalSearch(apiSearchPreset);
  index.addAll([
    { id: 'a', fields: { symbol: 'C++', description: 'a' } },
    { id: 'b', fields: { symbol: 'C++', description: 'b' } },
    { id: 'c', fields: { symbol: 'C', description: 'c' } },
  ]);
  const lexical = createLexicalRetriever(index, { exact: { fields: ['symbol'] } }),
    vector = createVectorRetriever({
      ids: ['a', 'b', 'c'],
      vectors: [
        [1, 0],
        [1, 0],
        [0, 1],
      ],
    });
  const search = new HybridSearch({ lexical, vector });
  await assert.rejects(
    search.search(
      { text: 'C++', vector: [0, 1] },
      { exact: 'promote', balance: { window: 2, lexical: 1, vector: 1 } },
    ),
    /cannot fit/,
  );
  const result = await search.search(
    { text: 'C++', vector: [1, 0] },
    { exact: 'promote', balance: { window: 1, lexical: 1, vector: 1 } },
  );
  assert.equal(result[0].id, 'a');
});
