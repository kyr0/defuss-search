import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HybridSearch, searchPreset } from 'defuss-search';
import { createHybridIndex } from 'defuss-search/indexing';
import { apiSearchPreset } from 'defuss-lexicalsearch';

const documents = [
  { id: 'books', fields: { symbol: 'Books.find()', description: 'library books' } },
  { id: 'tax', fields: { symbol: 'Tax.file()', description: 'taxation income' } },
  { id: 'hike', fields: { symbol: 'Hike.plan()', description: 'mountain trip' } },
];
// Deterministic reverse-order scorer tests the orchestration contract, not neural relevance.
function index(
  vectors = [
    [1, 0],
    [0, 1],
    [-1, 0],
  ],
) {
  let calls = 0;
  const reranker = {
    rerank: (_query, ids) => {
      calls++;
      return [...ids].reverse().map((id, i) => ({ id, score: ids.length - i }));
    },
  };
  const search = createHybridIndex({
    documents,
    vectors,
    lexical: apiSearchPreset,
    lexicalSearch: { exact: { fields: ['symbol'] } },
    reranker,
  });
  return { search, calls: () => calls };
}
const query = { text: 'library', vector: [1, 0] };
const ids = (response) => response.hits.map((hit) => hit.id);
const guarded = {
  ...searchPreset('reranked'),
  rerank: { candidates: 25, method: 'replace', skipIfVectorMargin: 0.1 },
};

test('presets are explicit, independent configurations; default core behavior stays unchanged', async () => {
  const a = searchPreset(),
    b = searchPreset('efficient');
  a.fusion.weights.lexical = 999;
  assert.notEqual(a.fusion.weights.lexical, b.fusion.weights.lexical);
  assert.equal(b.rerank, false);
  assert.equal(searchPreset('reranked').rerank.skipIfVectorMargin, 0.1);
  // VERIFIED (maintainer, 2026-11-09): reranked is the default name, so a search without a reranker must ask for
  // 'efficient' explicitly rather than silently skip the neural stage.
  assert.deepEqual(searchPreset(), searchPreset('reranked'));
  assert.throws(
    () =>
      new HybridSearch({
        lexical: { retrieve: () => [] },
        vector: { retrieve: () => [] },
        defaults: searchPreset(),
      }),
    /A reranker must be configured/,
  );
  assert.throws(() => searchPreset('optimal-everywhere'), /Unknown/);
  const { search, calls } = index();
  await search.search(query, b);
  assert.equal(calls(), 0);
  await search.search(query);
  assert.equal(calls(), 1, 'Attached rerankers still run by default');
});

test('agreement and vector margin skip the neural call without fabricating evidence or changing order', async () => {
  const { search, calls } = index();
  const prior = await search.searchWithStats(query, searchPreset('efficient'));
  const result = await search.searchWithStats(query, guarded);
  assert.deepEqual(ids(result), ids(prior));
  assert.equal(calls(), 0);
  assert.equal(result.counts.reranked, 0);
  assert.deepEqual(result.rerankDecision, {
    action: 'skipped',
    reason: 'vector-margin',
    winner: 'books',
    margin: 1,
    threshold: 0.1,
    lexical: 'agrees',
  });
  assert.ok(result.hits[0].reasons.includes('rerank-skipped:vector-margin'));
  assert.ok(result.hits.every((hit) => !hit.signals.reranker && !hit.rerankContributions));
  assert.deepEqual(
    ids(await search.searchWithStats(query, { ...guarded, offset: 1 })),
    ids(result).slice(1),
  );
});

test('low margin, missing runner-up, explicit disable and lexical disagreement retain inference', async () => {
  for (const [vectors, text, options] of [
    [
      [
        [1, 0],
        [0.99, 0.14],
        [-1, 0],
      ],
      'library',
      {},
    ],
    [
      [
        [1, 0],
        [0, 1],
        [-1, 0],
      ],
      'library',
      { vectorCandidates: 1 },
    ],
    [
      [
        [1, 0],
        [0, 1],
        [-1, 0],
      ],
      'library',
      { rerank: { skipIfVectorMargin: Infinity } },
    ],
    [
      [
        [1, 0],
        [0, 1],
        [-1, 0],
      ],
      'taxation',
      { fusion: { weights: { lexical: 0.01, vector: 10 } } },
    ],
  ]) {
    const { search, calls } = index(vectors);
    const result = await search.searchWithStats(
      { text, vector: [1, 0] },
      { ...guarded, ...options },
    );
    assert.equal(calls(), 1);
    assert.equal(result.rerankDecision.action, 'applied');
    assert.ok(result.hits.some((hit) => hit.signals.reranker));
  }
});

test('the gate honors eligibility and exact promotion, and handles absent lexical evidence', async () => {
  const { search } = index();
  const scoped = await search.searchWithStats(
    { text: 'taxation', vector: [1, 0] },
    { ...guarded, ids: new Set(['tax', 'hike']) },
  );
  assert.equal(scoped.rerankDecision.winner, 'tax');
  assert.ok(scoped.hits.every((hit) => hit.id !== 'books'));
  const emptyLex = await search.searchWithStats({ text: 'unmatched', vector: [1, 0] }, guarded);
  assert.equal(emptyLex.rerankDecision.lexical, 'empty');
  const promoted = await search.searchWithStats(
    { text: 'Tax.file()', vector: [1, 0] },
    { ...guarded, exact: 'promote' },
  );
  assert.equal(promoted.rerankDecision.action, 'applied');
  assert.equal(promoted.hits[0].id, 'tax');
  assert.equal(promoted.hits[0].exact, true);
});

test('nonmonotonic or overflowing raw margins cannot suppress inference', async () => {
  for (const scores of [
    [1, 0, 2],
    [1e308, -1e308, -1e308],
  ]) {
    let calls = 0;
    const hits = scores.map((score, i) => ({ id: String(i), score }));
    const search = new HybridSearch({
      lexical: { retrieve: () => [] },
      vector: { retrieve: () => hits },
      reranker: {
        rerank: (_q, values) => {
          calls++;
          return values.map((id, i) => ({ id, score: -i }));
        },
      },
    });
    await search.search('q', guarded);
    assert.equal(calls, 1);
  }
});

test('margin validation fails before retrieval; zero and Infinity retain their explicit semantics', async () => {
  const { search } = index();
  for (const skipIfVectorMargin of [-1, NaN, '0.1', null])
    await assert.rejects(
      search.search(query, { rerank: { skipIfVectorMargin } }),
      /skipIfVectorMargin/,
    );
  assert.equal(
    (await search.searchWithStats(query, { ...guarded, rerank: { skipIfVectorMargin: 1 } }))
      .rerankDecision.action,
    'skipped',
  );
  assert.equal(
    (await search.searchWithStats(query, { ...guarded, rerank: { skipIfVectorMargin: 1.001 } }))
      .rerankDecision.action,
    'applied',
  );
  assert.equal(
    (await search.searchWithStats(query, { ...guarded, limit: 0 })).rerankDecision.action,
    'empty',
  );
  assert.equal(
    (await search.searchWithStats(query, searchPreset('efficient'))).rerankDecision.action,
    'disabled',
  );
});

test('the reranked preset preserves the prior top result for every seven-candidate permutation', async () => {
  // For k=1 and w=1/4, prior rank 1 scores at least 1/2; any other hit scores at most 1/3+1/8=11/24.
  const { fuseRankings } = await import('defuss-search');
  const { k, weight } = searchPreset('reranked').rerank;
  const prior = Array.from({ length: 7 }, (_, i) => ({ id: String(i), score: 7 - i }));
  function* permutations(values) {
    if (!values.length) {
      yield [];
      return;
    }
    for (let i = 0; i < values.length; i++)
      for (const rest of permutations([...values.slice(0, i), ...values.slice(i + 1)]))
        yield [values[i], ...rest];
  }
  let count = 0;
  for (const order of permutations(prior.map((x) => x.id))) {
    const neural = order.map((id, i) => ({ id, score: 7 - i }));
    assert.equal(
      fuseRankings(
        [
          { name: 'prior', hits: prior },
          { name: 'neural', hits: neural, weight },
        ],
        { k },
      )[0].id,
      '0',
    );
    count++;
  }
  assert.equal(count, 5040);
});
