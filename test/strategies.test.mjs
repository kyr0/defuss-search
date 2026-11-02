import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LexicalSearch } from 'defuss-lexicalsearch';
import en from 'defuss-lexicalsearch/en';
import { buildColbertTokenIndex, createColbertRetriever } from 'defuss-search/colbert';
import {
  createLexicalOnlySearch,
  createLexicalSemanticSearch,
  createLexicalSemanticTinySearch,
} from 'defuss-search/strategies';
import { packTokenIndex, unpackTokenIndex } from '../website/token-index.mjs';

const documents = [
  { id: 'd1', text: 'A cat sleeps on the warm sofa' },
  { id: 'd2', text: 'Dogs need a walk every morning' },
  { id: 'd3', text: 'The kitten naps beside the heater' },
  { id: 'd4', text: 'Invoices are due at the end of the month' },
];
const lexicalIndex = () => {
  const index = new LexicalSearch({ fields: { text: { analyzer: en } } });
  index.addAll(documents.map(({ id, text }) => ({ id, fields: { text } })));
  return index;
};
// Deterministic stand-ins for the models: words map to fixed 8-dimensional directions, and "cat", "kitten",
// "sleeps" and "naps" share one, so the semantic sources can find a paraphrase that BM25 misses.
const SYNONYMS = { kitten: 'cat', naps: 'sleeps', nap: 'sleeps' };
const wordVector = (word) => {
  const key = SYNONYMS[word] ?? word;
  const v = Array.from({ length: 8 }, (_, i) => Math.sin((i + 1) * [...key].reduce((s, c) => s + c.charCodeAt(0), 0)));
  return v;
};
const words = (text) => text.toLowerCase().match(/[a-z]+/g) ?? [];
const matrix = (text) => {
  const list = words(text);
  return { data: Float32Array.from(list.flatMap(wordVector)), tokenCount: list.length, dimensions: 8 };
};
let encodedDocuments = 0;
const colbert = {
  encodeDocuments(texts) {
    encodedDocuments += texts.length;
    return texts.map(matrix);
  },
  encodeQueries: (texts) => texts.map(matrix),
};
const mean = (text) => {
  const sum = Array.from({ length: 8 }, () => 0);
  for (const w of words(text)) wordVector(w).forEach((x, i) => (sum[i] += x));
  return sum;
};
let embeddedDocuments = 0;
const embedder = {
  embedDocuments(texts) {
    embeddedDocuments += texts.length;
    return texts.map(mean);
  },
  embedQuery: (text) => mean(text),
};

test('lexical-only needs no model and keeps the BM25 order', async () => {
  const index = lexicalIndex();
  const search = createLexicalOnlySearch(index);
  const result = await search.searchWithStats('morning walk');
  assert.deepEqual(
    result.hits.map((hit) => hit.id),
    index.search('morning walk').map((hit) => hit.id),
  );
  assert.equal(result.counts.vector, 0);
  assert.deepEqual(result.weakLexical, { action: 'disabled' });
  assert.deepEqual(result.rerankDecision, { action: 'disabled' });
});

test('the ColBERT retriever scores averaged MaxSim, exactly or from TurboQuant codes', async () => {
  const matrices = documents.map((doc) => matrix(doc.text));
  const exact = createColbertRetriever({
    ids: documents.map((doc) => doc.id),
    matrices,
    quantization: 'exact',
    encodeQuery: (text) => matrix(text),
  });
  const quantized = createColbertRetriever({
    ids: documents.map((doc) => doc.id),
    matrices,
    encodeQuery: (text) => matrix(text),
  });
  const hits = await exact.retrieve({ text: 'kitten naps' }, { limit: 4 });
  // Every query token finds an identical document token in d1 and d3, so both average to 1.
  assert.deepEqual(hits.slice(0, 2).map((hit) => [hit.id, Math.round(hit.score * 1e6) / 1e6]), [
    ['d1', 1],
    ['d3', 1],
  ]);
  const approximate = await quantized.retrieve({ text: 'kitten naps' }, { limit: 2 });
  assert.deepEqual(new Set(approximate.map((hit) => hit.id)), new Set(['d1', 'd3']));
  const restricted = await exact.rescore({ text: 'kitten naps' }, { limit: 4, ids: new Set(['d2', 'd4']) });
  assert.deepEqual(restricted.map((hit) => hit.id).sort(), ['d2', 'd4']);
});

test('a prebuilt token index ranks like its matrices, also after the demo byte round trip', async () => {
  const ids = documents.map((doc) => doc.id);
  const matrices = documents.map((doc) => matrix(doc.text));
  const encodeQuery = (text) => matrix(text);
  const fromMatrices = createColbertRetriever({ ids, matrices, encodeQuery });
  const built = buildColbertTokenIndex(matrices);
  assert.deepEqual(Array.from(built.tokenCounts), matrices.map((m) => m.tokenCount));
  const { meta, bytes } = packTokenIndex(built);
  const restored = unpackTokenIndex(JSON.parse(JSON.stringify(meta)), bytes);
  for (const index of [built, restored]) {
    const prebuilt = createColbertRetriever({ ids, index, encodeQuery });
    for (const text of ['kitten naps', 'morning walk'])
      assert.deepEqual(
        await prebuilt.retrieve({ text }, { limit: 4 }),
        await fromMatrices.retrieve({ text }, { limit: 4 }),
      );
  }
  assert.throws(() => unpackTokenIndex(meta, bytes.subarray(1)), RangeError);
});

test('a prebuilt token index must match its IDs', () => {
  const ids = documents.map((doc) => doc.id);
  const matrices = documents.map((doc) => matrix(doc.text));
  const index = buildColbertTokenIndex(matrices);
  const encodeQuery = (text) => matrix(text);
  assert.throws(() => createColbertRetriever({ ids, matrices, index, encodeQuery }), /either matrices or index/);
  assert.throws(() => createColbertRetriever({ ids, encodeQuery }), /either matrices or index/);
  assert.throws(() => createColbertRetriever({ ids: ids.slice(1), index, encodeQuery }), RangeError);
  const counts = Array.from(index.tokenCounts);
  counts[0] += 1;
  assert.throws(() => createColbertRetriever({ ids, index: { ...index, tokenCounts: counts }, encodeQuery }), RangeError);
  assert.throws(() => buildColbertTokenIndex([]), TypeError);
});

test('a failed query encoding rejects that search and does not stick to the query', async () => {
  let fail = true;
  const retriever = createColbertRetriever({
    ids: documents.map((doc) => doc.id),
    matrices: documents.map((doc) => matrix(doc.text)),
    quantization: 'exact',
    encodeQuery: async (text) => {
      if (fail) throw new Error('model unavailable');
      return matrix(text);
    },
  });
  await assert.rejects(retriever.retrieve({ text: 'kitten naps' }, { limit: 2 }), /model unavailable/);
  fail = false;
  const hits = await retriever.retrieve({ text: 'kitten naps' }, { limit: 2 });
  assert.deepEqual(new Set(hits.map((hit) => hit.id)), new Set(['d1', 'd3']));
});

test('the ColBERT retriever validates its input', () => {
  const ids = ['a', 'b'];
  const good = { data: [1, 0], tokenCount: 1, dimensions: 2 };
  const encodeQuery = () => good;
  assert.throws(() => createColbertRetriever({ ids, matrices: [good], encodeQuery }), TypeError);
  assert.throws(() => createColbertRetriever({ ids, matrices: [good, good] }), TypeError);
  assert.throws(
    () => createColbertRetriever({ ids, matrices: [good, { data: [1, 0, 0], tokenCount: 1, dimensions: 3 }], encodeQuery }),
    RangeError,
  );
  assert.throws(
    () => createColbertRetriever({ ids, matrices: [good, { data: [0, 0], tokenCount: 1, dimensions: 2 }], encodeQuery }),
    RangeError,
  );
  assert.throws(
    () => createColbertRetriever({ ids: ['a', 'a'], matrices: [good, good], encodeQuery }),
    /Duplicate/,
  );
  assert.throws(
    () => createColbertRetriever({ ids, matrices: [good, good], encodeQuery, quantization: 'pq' }),
    TypeError,
  );
});

test('lexical-semantic-tiny encodes documents once and finds the paraphrase BM25 misses', async () => {
  encodedDocuments = 0;
  const index = lexicalIndex();
  const search = await createLexicalSemanticTinySearch(index, {
    documents,
    colbert,
    quantization: 'exact',
  });
  assert.equal(encodedDocuments, documents.length);
  assert.equal(index.search('kitten naps').length, 1);
  const result = await search.searchWithStats('cat sleeps');
  assert.deepEqual(new Set(result.hits.slice(0, 2).map((hit) => hit.id)), new Set(['d1', 'd3']));
  assert.ok(result.counts.vector > 0);
  // Supplied matrices skip encoding.
  await createLexicalSemanticTinySearch(index, {
    documents,
    colbert,
    matrices: documents.map((doc) => matrix(doc.text)),
  });
  assert.equal(encodedDocuments, documents.length);
});

test('lexical-semantic uses the efficient preset without a reranker and the reranked one with it', async () => {
  embeddedDocuments = 0;
  const index = lexicalIndex();
  const efficient = await createLexicalSemanticSearch(index, { documents, embedder });
  assert.equal(embeddedDocuments, documents.length);
  const plain = await efficient.searchWithStats('cat sleeps');
  assert.deepEqual(plain.rerankDecision, { action: 'disabled' });
  let reranked = 0;
  const reranker = {
    rerank(query, texts) {
      reranked++;
      return texts.map((_, index) => ({ index, score: -index }));
    },
  };
  const withReranker = await createLexicalSemanticSearch(index, {
    documents,
    embedder,
    vectors: documents.map((doc) => mean(doc.text)),
    reranker,
  });
  assert.equal(embeddedDocuments, documents.length);
  const decision = (await withReranker.searchWithStats('invoices month')).rerankDecision.action;
  assert.ok(['applied', 'skipped'].includes(decision));
  assert.equal(reranked, decision === 'applied' ? 1 : 0);
});

test('searches that differ in their lexical options can share one vector source', async () => {
  const index = lexicalIndex();
  let encodedQueries = 0;
  const tokens = createColbertRetriever({
    ids: documents.map((doc) => doc.id),
    matrices: documents.map((doc) => matrix(doc.text)),
    encodeQuery: (text) => {
      encodedQueries++;
      return matrix(text);
    },
  });
  const all = await createLexicalSemanticTinySearch(index, { vector: tokens });
  const some = await createLexicalSemanticTinySearch(index, {
    vector: tokens,
    lexical: { search: { ids: new Set(['d2', 'd4']) } },
  });
  const [a, b] = [await all.searchWithStats('cat sleeps'), await some.searchWithStats('cat sleeps')];
  // One token index answers both searches: the second reuses the first one's scan.
  assert.equal(encodedQueries, 1);
  assert.ok(a.counts.lexical > 0);
  assert.equal(b.counts.lexical, 0);
  assert.deepEqual(new Set(b.hits.slice(0, 2).map((hit) => hit.id)), new Set(['d1', 'd3']));
  // The semantic factory takes a shared vector source without an embedder.
  embeddedDocuments = 0;
  const { createVectorRetriever } = await import('defuss-search/vector');
  const vectors = createVectorRetriever({
    ids: documents.map((doc) => doc.id),
    vectors: documents.map((doc) => mean(doc.text)),
  });
  const semantic = await createLexicalSemanticSearch(index, { documents, vector: vectors });
  const hits = await semantic.search({ text: 'cat sleeps', vector: mean('cat sleeps') });
  assert.equal(embeddedDocuments, 0);
  assert.ok(hits.some((hit) => hit.id === 'd3'));
  await assert.rejects(createLexicalSemanticTinySearch(index, { vector: {} }), TypeError);
  await assert.rejects(createLexicalSemanticSearch(index, { documents, vector: {} }), TypeError);
});

test('the factories reject documents and models they cannot use', async () => {
  const index = lexicalIndex();
  await assert.rejects(
    createLexicalSemanticTinySearch(index, { documents: [documents[0], documents[0]], colbert }),
    /Duplicate/,
  );
  await assert.rejects(
    createLexicalSemanticTinySearch(index, { documents: [{ id: 'x' }], colbert }),
    TypeError,
  );
  await assert.rejects(createLexicalSemanticTinySearch(index, { documents, colbert: {} }), TypeError);
  await assert.rejects(createLexicalSemanticSearch(index, { documents, embedder: {} }), TypeError);
});
