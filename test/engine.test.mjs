import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HybridSearch } from 'defuss-search';
import { fixture } from './fixture.mjs';
const q = { text: 'Append an element', vector: [0, 1, 0] };
const ids = (hits) => hits.map((x) => x.id);

test('vector-first rescores only stage-1 IDs and keeps zero-overlap tail', async () => {
  const { search, vector, index } = fixture();
  const first = await vector.retrieve(q, { limit: 4 });
  const expected = index.search(q.text, { ids: new Set(ids(first)), limit: 4 });
  const hits = await search.search(q, { strategy: 'vector-first', vectorCandidates: 4, limit: 20 });
  assert.deepEqual(new Set(ids(hits)), new Set(ids(first)));
  assert.deepEqual(ids(hits).slice(0, expected.length), ids(expected));
  for (const hit of hits.filter((x) => !x.signals.lexical))
    assert.ok(hit.reasons.includes('unmatched-secondary'));
  const dropped = await search.search(q, {
    strategy: 'vector-first',
    vectorCandidates: 4,
    unmatched: 'drop',
    limit: 20,
  });
  assert.deepEqual(ids(dropped), ids(expected));
});
test('lexical-first never expands its pool; the supplied query vector controls reranking', async () => {
  const { search, lexical, vector } = fixture();
  const query = { text: 'programming language', vector: [0.97, 0.15, 0] };
  const first = await lexical.retrieve(query, { limit: 2 });
  const expected = await vector.rescore(query, { ids: new Set(ids(first)), limit: 2 });
  assert.deepEqual(
    ids(await search.search(query, { strategy: 'lexical-first', lexicalCandidates: 2 })),
    ids(expected),
  );
});
test('fusion unions both sources, explains contributions and has stable fixed-window pages', async () => {
  const { search } = fixture();
  const config = { vectorCandidates: 6, lexicalCandidates: 4, limit: 20 };
  const whole = await search.searchWithStats(q, config);
  assert.ok(whole.hits.some((x) => x.signals.lexical && x.signals.vector));
  assert.ok(whole.hits.some((x) => !x.signals.lexical && x.signals.vector));
  const pages = [
    ...(await search.search(q, { ...config, limit: 2 })),
    ...(await search.search(q, { ...config, offset: 2, limit: 20 })),
  ];
  assert.deepEqual(pages, whole.hits);
  assert.equal(whole.totalCandidates, whole.hits.length);
  assert.ok(whole.timings.totalMs >= 0);
  assert.deepEqual(await search.search(q, { ...config, offset: 100 }), []);
});
test('exact API equality is punctuation-sensitive and can inject into fusion only', async () => {
  const { search } = fixture();
  const query = { text: 'C++', vector: [0, 1, 0] };
  const hits = await search.search(query, {
    vectorCandidates: 1,
    lexicalCandidates: 1,
    exact: 'promote',
    limit: 20,
  });
  assert.equal(hits[0].id, 'api/c++');
  assert.equal(hits[0].exact, true);
  assert.equal(hits.find((x) => x.id === 'api/c')?.exact ?? false, false);
  const cascade = await search.search(query, {
    strategy: 'vector-first',
    vectorCandidates: 1,
    exact: 'promote',
  });
  assert.deepEqual(ids(cascade), ['method/push']);
  assert.equal(cascade[0].exact, false);
  const dotted = await search.search({ text: 'x.y()', vector: [1, 0, 0] }, { exact: 'promote' });
  assert.equal(dotted[0].id, '__proto__');
});
test('scope eligibility applies before retrieval and survives every strategy and exact injection', async () => {
  const { search } = fixture();
  const allowed = new Set(['api/c#', '__proto__']);
  for (const strategy of ['fusion', 'vector-first', 'lexical-first']) {
    const out = await search.search(
      { text: 'C++', vector: [1, 0, 0] },
      { strategy, ids: allowed, vectorCandidates: 1, lexicalCandidates: 1, exact: 'promote' },
    );
    assert.ok(out.every((x) => allowed.has(x.id)));
    if (strategy !== 'lexical-first') assert.ok(out.some((x) => x.id === 'api/c#'));
  }
});
test('fixed-prefix coverage represents top candidates from both original sources', async () => {
  const { search, lexical, vector } = fixture();
  const query = { text: 'programming language', vector: [0, 1, 0] };
  const lex = await lexical.retrieve(query, { limit: 3 }),
    vec = await vector.retrieve(query, { limit: 4 });
  const options = {
    lexicalCandidates: 3,
    vectorCandidates: 4,
    fusion: { weights: { lexical: 0.01, vector: 100 } },
    balance: { window: 3, lexical: 1, vector: 1 },
    limit: 20,
  };
  const result = await search.searchWithStats(query, options);
  assert.ok(ids(result.hits.slice(0, 3)).includes(lex[0].id));
  assert.ok(ids(result.hits.slice(0, 3)).includes(vec[0].id));
  assert.deepEqual(result.representatives, { lexical: [lex[0].id], vector: [vec[0].id] });
  assert.deepEqual(
    await search.search(query, { ...options, offset: 2, limit: 2 }),
    result.hits.slice(2, 4),
  );
  await assert.rejects(
    search.search(query, { ...options, balance: { window: 1, lexical: 1, vector: 1 } }),
    /cannot fit/,
  );
});
test('cascade fusion keeps primary evidence and optional drop still restricts the union', async () => {
  const { search } = fixture();
  const kept = await search.search(q, {
    strategy: 'vector-first',
    vectorCandidates: 5,
    cascade: 'fuse',
    limit: 20,
  });
  const dropped = await search.search(q, {
    strategy: 'vector-first',
    vectorCandidates: 5,
    cascade: 'fuse',
    unmatched: 'drop',
    limit: 20,
  });
  assert.equal(kept.length, 5);
  assert.ok(dropped.length < kept.length);
  assert.ok(dropped.every((x) => x.signals.lexical));
});
test('empty queries/scopes and zero limit avoid calling expensive embeddings', async () => {
  const { search } = fixture({
    vector: {
      embedQuery: () => {
        throw new Error('must not embed');
      },
    },
  });
  assert.deepEqual(await search.search(''), []);
  assert.deepEqual(await search.search('hello', { ids: new Set() }), []);
  assert.deepEqual(await search.search('hello', { limit: 0 }), []);
});
test('invalid options and malformed retriever responses fail closed', async () => {
  const { search, lexical, vector } = fixture();
  for (const opts of [
    { strategy: 'oops' },
    { limit: -1 },
    { offset: NaN },
    { vectorCandidates: 0 },
    { fusion: { weights: { vector: 0, lexical: 0 } } },
    { fusion: { k: -1 } },
    { cascade: 'oops' },
    { unmatched: 'oops' },
    { exact: 'oops' },
    { rerank: {} },
    { balance: { window: 0, lexical: 0, vector: 0 } },
  ])
    await assert.rejects(search.search(q, opts));
  await assert.rejects(search.search({ text: 'x', vector: [NaN] }));
  await assert.rejects(search.search('x', { ids: ['x'] }));
  const bad = new HybridSearch({ lexical, vector: { retrieve: () => [{ id: 'leak', score: 1 }] } });
  await assert.rejects(bad.search(q, { ids: new Set(['api/c']) }), /escaped/);
  const noExact = new HybridSearch({ lexical: { retrieve: lexical.retrieve }, vector });
  await assert.rejects(noExact.search(q, { exact: 'promote' }), /requires/);
});
test('abort rejects promptly and snapshots query vectors, IDs, and options across await', async () => {
  const { lexical } = fixture();
  let release, observed;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const vector = {
    async retrieve(query, ctx) {
      await gate;
      observed = { vector: [...query.vector], ids: [...ctx.ids] };
      return [{ id: 'api/c++', score: 1 }];
    },
  };
  const search = new HybridSearch({ lexical, vector });
  const query = { text: 'C++', vector: [1, 0, 0] },
    allowed = new Set(['api/c++']);
  const pending = search.search(query, { ids: allowed });
  query.vector[0] = 9;
  allowed.clear();
  release();
  await pending;
  assert.deepEqual(observed, { vector: [1, 0, 0], ids: ['api/c++'] });
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(search.search(q, { signal: controller.signal }), /cancelled/);
  const blocked = new HybridSearch({ lexical, vector: { retrieve: () => new Promise(() => {}) } });
  const active = new AbortController();
  const task = blocked.search(q, { signal: active.signal });
  active.abort(new Error('stop now'));
  await assert.rejects(task, /stop now/);
});
test('synchronous cancellation inside a retriever still observes its late rejection', async () => {
  const { lexical } = fixture();
  const controller = new AbortController();
  const search = new HybridSearch({
    lexical,
    vector: {
      retrieve() {
        controller.abort(new Error('cancelled inside'));
        return Promise.reject(new Error('late failure'));
      },
    },
  });
  await assert.rejects(search.search(q, { signal: controller.signal }), /cancelled inside/);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
test('defaults and per-call weights merge without leaking mutable settings across queries', async () => {
  const defaults = { fusion: { weights: { lexical: 2, vector: 3 } }, rerank: false };
  const { search } = fixture({ engine: { defaults } });
  defaults.fusion.weights.lexical = 99;
  const hits = await search.search(q, { fusion: { weights: { vector: 4 } } });
  assert.equal(hits.find((x) => x.contributions.lexical).contributions.lexical.weight, 2);
  assert.equal(hits.find((x) => x.contributions.vector).contributions.vector.weight, 4);
  await assert.rejects(search.search(q, { rerank: true }), /options object/);
});
test('byLanguage replaces k and weights for queries in its languages, by primary subtag', async () => {
  const group = { languages: ['de', 'FR'], k: 10, weights: { lexical: 1 } };
  const defaults = { fusion: { k: 0, weights: { lexical: 2, vector: 1 }, byLanguage: [group] }, rerank: false };
  const { search } = fixture({ engine: { defaults } });
  // RRF contributes weight / (k + rank), so weight and k are both recoverable from a contribution.
  const fused = async (query, options = {}) => {
    const hits = await search.search(query, { ...options, limit: 20 });
    const of = (source) => hits.find((x) => x.contributions[source]).contributions[source];
    const k = (c) => c.weight / c.contribution - c.rank;
    return { lexical: of('lexical').weight, vector: of('vector').weight, k: Math.round(k(of('lexical'))) };
  };
  assert.deepEqual(await fused({ ...q, language: 'de-AT' }), { lexical: 1, vector: 1, k: 10 });
  assert.deepEqual(await fused({ ...q, language: 'fr' }), { lexical: 1, vector: 1, k: 10 });
  assert.deepEqual(await fused({ ...q, language: 'en' }), { lexical: 2, vector: 1, k: 0 });
  assert.deepEqual(await fused(q), { lexical: 2, vector: 1, k: 0 });
  // A query's own k or weights win over inherited groups unless it passes groups of its own.
  const german = { ...q, language: 'de' };
  assert.deepEqual(await fused(german, { fusion: { k: 5 } }), { lexical: 2, vector: 1, k: 5 });
  assert.deepEqual(await fused(german, { fusion: { byLanguage: [] } }), { lexical: 2, vector: 1, k: 0 });
  assert.deepEqual(
    await fused(german, { fusion: { weights: { vector: 3 }, byLanguage: [group] } }),
    { lexical: 1, vector: 3, k: 10 },
  );
  for (const byLanguage of [
    'de',
    [{ languages: [] }],
    [{ languages: [''] }],
    [{ languages: ['de'], k: -1 }],
    [{ languages: ['de'], weights: { lexical: 0, vector: 0 } }],
  ])
    await assert.rejects(search.search(german, { fusion: { byLanguage } }));
  defaults.fusion.byLanguage[0].k = 99;
  assert.equal((await fused(german)).k, 10);
  // Invalid default groups fail when the search is created, whatever language later queries carry.
  assert.throws(() => fixture({ engine: { defaults: { fusion: { byLanguage: [{ languages: ['de'], k: 0.5 }] } } } }));
});
