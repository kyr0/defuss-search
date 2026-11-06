import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LexicalSearch } from 'defuss-lexicalsearch';
import { de } from 'defuss-lexicalsearch/de';
import { en } from 'defuss-lexicalsearch/en';
import { HybridSearch } from 'defuss-search';
import { createLexicalRetriever, surfaceAnalyzer, withSurfaceFields } from 'defuss-search/lexical';
import { createLexicalOnlySearch } from 'defuss-search/strategies';

// One note per language; "zoo" is a word of both, so only the query's language decides which comes first.
const notes = [
  { id: 'de', fields: { de: 'Pinguine im Zoo' } },
  { id: 'en', fields: { en: 'penguins at the zoo' } },
];
const indexOf = (options) => {
  const index = new LexicalSearch(options);
  index.addAll(notes);
  return index;
};
const languages = { fields: { de: { analyzer: de }, en: { analyzer: en } } };
const ids = (hits) => hits.map((hit) => hit.id);

test("a query's language weighs its fields higher and keeps the other language's matches", async () => {
  const search = await createLexicalOnlySearch(indexOf(languages));
  assert.deepEqual(ids(await search.search({ text: 'zoo', language: 'de' })), ['de', 'en']);
  assert.deepEqual(ids(await search.search({ text: 'zoo', language: 'en-GB' })), ['en', 'de']);
  // A wrong guess still finds the note in the other language.
  assert.deepEqual(ids(await search.search({ text: 'Pinguine', language: 'en' })), ['de']);
});

test("the query's language overrides a fixed search language", () => {
  const lexical = createLexicalRetriever(indexOf(languages), { search: { language: 'en' } });
  assert.deepEqual(ids(lexical.retrieve({ text: 'zoo' }, { limit: 2 })), ['en', 'de']);
  assert.deepEqual(ids(lexical.retrieve({ text: 'zoo', language: 'de' }, { limit: 2 })), [
    'de',
    'en',
  ]);
});

test('unstemmed companions keep their analyzer language, so the boost covers them', () => {
  assert.equal(surfaceAnalyzer(de).language, 'de');
  const index = indexOf(withSurfaceFields(languages));
  const scores = (language) =>
    Object.fromEntries(
      createLexicalRetriever(index)
        .retrieve({ text: 'zoo', ...(language ? { language } : {}) }, { limit: 2 })
        .map((hit) => [hit.id, hit.score]),
    );
  const plain = scores(),
    german = scores('de');
  // Field and companion both weigh three times more; the English note keeps its score.
  assert.ok(Math.abs(german.de - 3 * plain.de) < 1e-9);
  assert.equal(german.en, plain.en);
});

test('a query language must be a nonempty string; LexicalSearch rejects an invalid tag', async () => {
  const search = new HybridSearch({
    lexical: createLexicalRetriever(indexOf(languages)),
    vector: { retrieve: () => [] },
  });
  for (const language of [7, ''])
    await assert.rejects(search.search({ text: 'zoo', language }), TypeError);
  await assert.rejects(search.search({ text: 'zoo', language: 'not a tag' }), RangeError);
});
