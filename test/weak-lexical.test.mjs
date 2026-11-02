import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LexicalSearch, keywordAnalyzer } from 'defuss-lexicalsearch';
import de from 'defuss-lexicalsearch/de';
import { HybridSearch, searchPreset } from 'defuss-search';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';

// The demo's failure: "Mehr Kontakt mit Tieren" shares only the common word "mehr" with two notes, while the
// penguin note is the one it means.
const notes = [
  ['n1', 'Die Tomatensoße braucht mehr Basilikum und eine Prise Zucker.', [1, 0, 0]],
  ['n2', 'Der Arzt rät zu mehr Bewegung und weniger Zucker.', [0.9, 0.3, 0]],
  ['n3', 'Die Kinder wollen am Sonntag die Pinguine im Zoo sehen.', [0, 0.2, 1]],
  ['n4', 'Rezept: Kartoffelsuppe mit Lauch und Möhren.', [0, 1, 0]],
];
function build({ embedQuery, matchShare = true, rescore = true } = {}) {
  const index = new LexicalSearch({ fields: { text: { analyzer: de } } });
  index.addAll(notes.map(([id, text]) => ({ id, fields: { text } })));
  const lexical = createLexicalRetriever(index);
  const vector = createVectorRetriever({
    ids: notes.map(([id]) => id),
    vectors: notes.map(([, , v]) => Float32Array.from(v)),
    ...(embedQuery ? { embedQuery } : {}),
  });
  return {
    lexical,
    search: new HybridSearch({
      lexical: matchShare ? lexical : { retrieve: lexical.retrieve },
      vector: rescore ? vector : { retrieve: vector.retrieve },
    }),
  };
}
const animals = { text: 'Mehr Kontakt mit Tieren', vector: [0, 0.1, 1] };

test('matchShare weighs words by their rarity in the index and ignores stopwords', () => {
  const { lexical } = build();
  const idf = (df) => Math.log(1 + (4 - df + 0.5) / (df + 0.5));
  // "mehr" occurs in two notes, "Kontakt" and "Tieren" in none, "mit" is a German stopword.
  assert.ok(
    Math.abs(lexical.matchShare(animals, 'n1') - idf(2) / (idf(2) + 2 * idf(0))) < 1e-12,
  );
  assert.equal(lexical.matchShare({ text: 'Kartoffelsuppe Lauch' }, 'n4'), 1);
  assert.equal(lexical.matchShare({ text: 'Kartoffelsuppe Lauch' }, 'n1'), 0);
  assert.equal(lexical.matchShare({ text: 'mit "und' }, 'n1'), undefined);
});

test('the presets put the vector first hit on top when BM25 matched only a common word', async () => {
  const { search } = build();
  const before = await search.searchWithStats(animals, {
    ...searchPreset('efficient'),
    weakLexical: false,
  });
  assert.notEqual(before.hits[0].id, 'n3');
  assert.deepEqual(before.weakLexical, { action: 'disabled' });
  const after = await search.searchWithStats(animals, searchPreset('efficient'));
  assert.equal(after.hits[0].id, 'n3');
  assert.ok(after.hits[0].reasons.includes('weak-lexical'));
  assert.equal(after.weakLexical.action, 'promoted');
  assert.equal(after.weakLexical.vector, 'n3');
  assert.equal(after.weakLexical.gapBound, false);
  assert.ok(after.weakLexical.share < 0.2 && after.weakLexical.gap > 0.15);
  // Only the promoted hit moves; the others keep their fused order.
  assert.deepEqual(
    after.hits.slice(1).map((hit) => hit.id),
    before.hits.map((hit) => hit.id).filter((id) => id !== 'n3'),
  );
});

test('a full lexical match or a small vector lead keeps the fused order', async () => {
  const { search } = build();
  const soup = await search.searchWithStats(
    { text: 'Kartoffelsuppe Lauch', vector: [0, 0.2, 1] },
    searchPreset('efficient'),
  );
  assert.equal(soup.hits[0].id, 'n4');
  assert.equal(soup.weakLexical.action, 'kept');
  assert.equal(soup.weakLexical.share, 1);
  // The vector source rates the tomato note almost as high as the penguin note.
  const close = await search.searchWithStats(
    { text: animals.text, vector: [0.9, 0, 1] },
    searchPreset('efficient'),
  );
  assert.equal(close.weakLexical.action, 'kept');
  assert.ok(close.weakLexical.gap <= 0.15);
});

test('outside the vector candidates the gap comes from a rescore, also for text alone, else from a bound', async () => {
  const exact = await build().search.searchWithStats(animals, {
    ...searchPreset('efficient'),
    vectorCandidates: 1,
  });
  assert.equal(exact.weakLexical.action, 'promoted');
  assert.equal(exact.weakLexical.gapBound, false);
  // A text-only query is rescored exactly with the embedding its retrieval computed: one model call.
  let embedded = 0;
  const embedQuery = () => {
    embedded++;
    return animals.vector;
  };
  const textOnly = await build({ embedQuery }).search.searchWithStats(animals.text, {
    ...searchPreset('efficient'),
    vectorCandidates: 1,
  });
  assert.deepEqual(
    [textOnly.weakLexical.action, textOnly.weakLexical.gapBound, embedded],
    ['promoted', false, 1],
  );
  const bounded = await build({ embedQuery, rescore: false }).search.searchWithStats(
    animals.text,
    { ...searchPreset('efficient'), vectorCandidates: 1 },
  );
  // Without a rescore, one candidate makes the bound the first hit's own score: the gap reads 0 and nothing moves.
  assert.deepEqual(
    [bounded.weakLexical.action, bounded.weakLexical.gap, bounded.weakLexical.gapBound],
    ['kept', 0, true],
  );
});

test('the vector retriever embeds a repeated query text once and retries a failed embedding', async () => {
  let calls = 0;
  const vector = createVectorRetriever({
    ids: ['a', 'b'],
    vectors: [Float32Array.from([1, 0]), Float32Array.from([0, 1])],
    embedQuery: (text) => {
      calls++;
      if (text === 'fails' && calls === 1) throw new Error('model unavailable');
      return [1, 0];
    },
  });
  await assert.rejects(vector.retrieve({ text: 'fails' }, { limit: 1 }), /model unavailable/);
  assert.deepEqual((await vector.retrieve({ text: 'fails' }, { limit: 1 })).map((hit) => hit.id), ['a']);
  await vector.rescore({ text: 'fails' }, { limit: 1, ids: new Set(['b']) });
  assert.equal(calls, 2);
  await vector.retrieve({ text: 'other' }, { limit: 1 });
  assert.equal(calls, 3);
});

test('the rule needs fusion, two different first hits and a retriever that reports matchShare', async () => {
  const { search } = build();
  assert.deepEqual((await search.searchWithStats(animals)).weakLexical, { action: 'disabled' });
  const options = searchPreset('efficient');
  assert.deepEqual(
    (await search.searchWithStats(animals, { ...options, strategy: 'vector-first' })).weakLexical,
    { action: 'unavailable', reason: 'strategy' },
  );
  assert.deepEqual(
    (await search.searchWithStats({ text: 'Pinguine Zoo', vector: [0, 0.2, 1] }, options))
      .weakLexical,
    { action: 'unavailable', reason: 'same-first-hit' },
  );
  assert.deepEqual(
    (await build({ matchShare: false }).search.searchWithStats(animals, options)).weakLexical,
    { action: 'unavailable', reason: 'unsupported' },
  );
});

test('requested exact matches stay ahead of the promoted hit', async () => {
  const index = new LexicalSearch({
    fields: { symbol: { analyzer: keywordAnalyzer }, text: { analyzer: de } },
  });
  index.addAll([
    { id: 'tag', fields: { symbol: animals.text, text: 'Etikett' } },
    ...notes.map(([id, text]) => ({ id, fields: { symbol: id, text } })),
  ]);
  const search = new HybridSearch({
    lexical: createLexicalRetriever(index, { exact: { fields: ['symbol'] } }),
    vector: createVectorRetriever({
      ids: ['tag', ...notes.map(([id]) => id)],
      vectors: [[1, 0, 0], ...notes.map(([, , v]) => v)].map((v) => Float32Array.from(v)),
    }),
  });
  const result = await search.searchWithStats(animals, {
    ...searchPreset('efficient'),
    exact: 'promote',
  });
  assert.equal(result.weakLexical.action, 'promoted');
  assert.deepEqual(
    result.hits.slice(0, 2).map((hit) => [hit.id, hit.exact]),
    [
      ['tag', true],
      ['n3', false],
    ],
  );
});

test('weakLexical is validated', async () => {
  const { search } = build();
  for (const value of [{ share: 2, gap: 0.1 }, { share: 0.2, gap: -1 }, { share: Number.NaN, gap: 0 }])
    await assert.rejects(search.search(animals, { weakLexical: value }), RangeError);
  await assert.rejects(search.search(animals, { weakLexical: 'on' }), TypeError);
});
