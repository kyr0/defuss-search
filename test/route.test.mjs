import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LexicalSearch, keywordAnalyzer } from 'defuss-lexicalsearch';
import { HybridSearch } from 'defuss-search';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';

const vectors = [
  [1, 0, 0],
  [0.8, 0.6, 0],
  [0, 1, 0],
  [0, 0, 1],
].map((x) => Float32Array.from(x));
/** Four notes; the vector query [0, 0, 1] points at n4, while the words "cat food" match n1 and n2. */
function notes(texts, engine = {}) {
  const index = new LexicalSearch({ fields: { text: {} } });
  index.addAll(texts.map((text, i) => ({ id: `n${i + 1}`, fields: { text } })));
  const lexical = createLexicalRetriever(index);
  const vector = createVectorRetriever({ ids: texts.map((_, i) => `n${i + 1}`), vectors });
  let calls = 0;
  const reranker = {
    rerank(query, ids) {
      calls++;
      return ids.map((id, i) => ({ id, score: -i }));
    },
  };
  return {
    lexical,
    search: new HybridSearch({ lexical, vector, reranker, ...engine }),
    calls: () => calls,
  };
}
const short = ['cat food', 'cat food bowl', 'dog lead', 'rain jacket'];
const long = short.map((text) => `${text} ${'with several more ordinary words in it'.repeat(2)}`);
const query = { text: 'cat food', vector: [0.1, 0.5, 1] };
const options = { vectorOnlyBelow: 6, rerank: { candidates: 4 }, limit: 4 };

test('averageLength counts the searched fields per document', () => {
  const api = new LexicalSearch({ fields: { symbol: { analyzer: keywordAnalyzer }, text: {} } });
  api.addAll([
    { id: 'a', fields: { symbol: 'C++', text: 'one two three' } },
    { id: 'b', fields: { symbol: 'C#', text: 'four five six seven eight' } },
  ]);
  // A keyword field adds its one term to the same documents: (2 + 8) terms over two documents.
  assert.equal(createLexicalRetriever(api).averageLength(), 5);
  assert.equal(createLexicalRetriever(api, { search: { fields: ['text'] } }).averageLength(), 4);
  const languages = new LexicalSearch({ fields: { de: {}, en: {}, fr: {} } });
  languages.addAll([
    { id: 'c', fields: { de: 'eins zwei' } },
    { id: 'd', fields: { en: 'one two three four' } },
    { id: 'e', fields: { fr: 'un deux trois quatre cinq six' } },
  ]);
  // Disjoint language fields add up to their documents.
  assert.equal(
    createLexicalRetriever(languages, { search: { fields: ['de', 'en'] } }).averageLength(),
    3,
  );
  assert.equal(createLexicalRetriever(languages).averageLength(), 4);
  assert.equal(createLexicalRetriever(new LexicalSearch()).averageLength(), undefined);
});

test('short documents use the vector source alone and skip the reranker', async () => {
  const { search, calls } = notes(short);
  const result = await search.searchWithStats(query, options);
  assert.deepEqual(result.route, { route: 'vector', averageLength: 2.25, threshold: 6 });
  assert.equal(result.counts.lexical, 0);
  assert.deepEqual(
    result.hits.map((hit) => hit.id),
    ['n4', 'n3', 'n2', 'n1'],
  );
  assert.equal(calls(), 0);
  assert.deepEqual(result.rerankDecision, {
    action: 'skipped',
    reason: 'short-documents',
    averageLength: 2.25,
    threshold: 6,
  });
  assert.ok(result.hits[0].reasons.includes('rerank-skipped:short-documents'));
});

test('longer documents keep BM25 and the reranker, and report the length', async () => {
  const { search, calls } = notes(long);
  const result = await search.searchWithStats(query, options);
  assert.equal(result.route.route, 'hybrid');
  assert.ok(result.route.averageLength >= 6);
  assert.ok(result.counts.lexical > 0);
  assert.equal(calls(), 1);
});

test('the short-text route applies to fusion only and embeds text-only queries', async () => {
  const { search } = notes(short);
  const cascade = await search.searchWithStats(query, { ...options, strategy: 'vector-first' });
  assert.deepEqual(cascade.route, { route: 'hybrid' });
  const off = await search.searchWithStats(query, { rerank: false });
  assert.deepEqual(off.route, { route: 'hybrid' });
  const index = new LexicalSearch({ fields: { text: {} } });
  index.addAll(short.map((text, i) => ({ id: `n${i + 1}`, fields: { text } })));
  const embedding = new HybridSearch({
    lexical: createLexicalRetriever(index),
    vector: createVectorRetriever({
      ids: short.map((_, i) => `n${i + 1}`),
      vectors,
      embedQuery: () => [0.1, 0.5, 1],
    }),
  });
  const textOnly = await embedding.searchWithStats('cat food', { vectorOnlyBelow: 6 });
  assert.equal(textOnly.route.route, 'vector');
  assert.equal(textOnly.hits[0].id, 'n4');
});

test('vectorOnlyBelow is validated', async () => {
  const { search } = notes(short);
  for (const value of [-1, Number.NaN, '6'])
    await assert.rejects(search.search(query, { vectorOnlyBelow: value }), RangeError);
});

test('exact promotion still applies on the short-text route', async () => {
  const index = new LexicalSearch({ fields: { symbol: { analyzer: keywordAnalyzer }, text: {} } });
  const docs = ['C++', 'C#', 'Rust', 'Go'];
  index.addAll(docs.map((symbol, i) => ({ id: `s${i + 1}`, fields: { symbol, text: symbol } })));
  const search = new HybridSearch({
    lexical: createLexicalRetriever(index, { exact: { fields: ['symbol'] } }),
    vector: createVectorRetriever({ ids: docs.map((_, i) => `s${i + 1}`), vectors }),
  });
  const result = await search.searchWithStats(
    { text: 'C++', vector: [0.1, 0.5, 1] },
    { vectorOnlyBelow: 6, exact: 'promote' },
  );
  assert.equal(result.route.route, 'vector');
  assert.equal(result.hits[0].id, 's1');
  assert.ok(result.hits[0].exact);
});
