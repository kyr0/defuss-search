import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LexicalSearch, keywordAnalyzer, unicodeAnalyzer } from 'defuss-lexicalsearch';
import { en } from 'defuss-lexicalsearch/en';
import { searchPreset } from 'defuss-search';
import { createHybridIndex } from 'defuss-search/indexing';
import {
  createLexicalRetriever,
  surfaceAnalyzer,
  surfaceField,
  withSurfaceFields,
} from 'defuss-search/lexical';

// The English stemmer reduces "tabs" and "tab" to one term; the first document repeats it.
const documents = [
  { id: 'tab', fields: { text: 'Press the tab key to move focus to the next tab stop' } },
  { id: 'tabs', fields: { text: 'Tabs switch between panels of related content' } },
];
const english = { fields: { text: { analyzer: en } } };

test('an unstemmed companion ranks the word as written first, also under a field restriction', () => {
  const ranked = (options) => {
    const index = new LexicalSearch(options);
    index.addAll(documents);
    const lexical = createLexicalRetriever(index, { search: { fields: ['text'] } });
    return {
      ids: lexical.retrieve({ text: 'tabs' }, { limit: 2 }).map((hit) => hit.id),
      averageLength: lexical.averageLength(),
    };
  };
  const stemmed = ranked(english);
  const surface = ranked(withSurfaceFields(english));
  assert.deepEqual(stemmed.ids, ['tab', 'tabs']);
  assert.deepEqual(surface.ids, ['tabs', 'tab']);
  assert.equal(
    surface.averageLength,
    stemmed.averageLength,
    'companions stay out of the statistics',
  );
});

test('withSurfaceFields adds companions only to fields whose analyzer stems', () => {
  const options = {
    ranking: 'exact-first',
    fields: {
      title: { analyzer: en, weight: 3, b: 0.5 },
      symbol: { analyzer: keywordAnalyzer },
      body: { analyzer: unicodeAnalyzer },
    },
  };
  const result = withSurfaceFields(options, { weight: 0.5 });
  assert.equal(result.ranking, 'exact-first');
  assert.deepEqual(Object.keys(result.fields).sort(), ['body', 'symbol', 'title', 'title~surface']);
  assert.deepEqual(result.fields[surfaceField('title')], {
    source: 'title',
    analyzer: surfaceAnalyzer(en),
    weight: 1.5,
    b: 0.5,
  });
  assert.equal(surfaceAnalyzer(en).stem, undefined);
  assert.deepEqual(
    withSurfaceFields(result).fields,
    result.fields,
    'applying it twice adds nothing',
  );
  const plain = { fields: { body: { analyzer: unicodeAnalyzer } } };
  assert.equal(withSurfaceFields(plain), plain);
  assert.deepEqual(Object.keys(withSurfaceFields({ analyzer: en }).fields), [
    'text',
    'text~surface',
  ]);
  assert.throws(() => withSurfaceFields(english, { weight: 0 }), RangeError);

  const index = new LexicalSearch(withSurfaceFields(english));
  index.addAll(documents);
  const restored = LexicalSearch.fromJSON(index.toJSON(), {
    [en.id]: en,
    [surfaceAnalyzer(en).id]: surfaceAnalyzer(en),
  });
  assert.deepEqual(
    restored.search('tabs').map((hit) => hit.id),
    index.search('tabs').map((hit) => hit.id),
  );
});

test('createHybridIndex adds the companions by default; surface: false keeps the options as given', async () => {
  const top = async (surface) => {
    const search = createHybridIndex({
      documents,
      vectors: [
        [1, 0],
        [1, 0],
      ],
      lexical: english,
      ...(surface === undefined ? {} : { surface }),
    });
    // Equal vectors leave the order to BM25 under the efficient preset's 3:1 lexical weight.
    return (await search.search({ text: 'tabs', vector: [1, 0] }, searchPreset('efficient')))[0].id;
  };
  assert.equal(await top(), 'tabs');
  assert.equal(await top({ weight: 2 }), 'tabs');
  assert.equal(await top(false), 'tab');
});
