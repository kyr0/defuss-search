import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LexicalSearch, keywordAnalyzer } from 'defuss-lexicalsearch';
import { HybridSearch } from 'defuss-search';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
import { languageCases } from '../fixtures/languages.mjs';

for (const sample of languageCases)
  test(`${sample.name}: analyzer, three hybrid strategies, exact symbols and eligibility`, async () => {
    const analyzer = (await import(`defuss-lexicalsearch/${sample.entry}`)).default;
    const lexicalIndex = new LexicalSearch({
      fields: { text: { analyzer }, symbol: { analyzer: keywordAnalyzer } },
    });
    lexicalIndex.addAll([
      { id: 'books', fields: { text: sample.text, symbol: `${sample.query}::C++()` } },
      { id: 'other', fields: { text: 'unrelated 98765', symbol: 'C#' } },
    ]);
    const lexical = createLexicalRetriever(lexicalIndex, {
      search: { fields: ['text'] },
      exact: { fields: ['symbol'] },
    });
    const vector = createVectorRetriever({
      ids: ['books', 'other'],
      vectors: [
        [1, 0],
        [0, 1],
      ],
    });
    const search = new HybridSearch({ lexical, vector });
    for (const strategy of ['fusion', 'vector-first', 'lexical-first']) {
      const hits = await search.search({ text: sample.query, vector: [1, 0] }, { strategy });
      assert.equal(hits[0].id, 'books');
      assert.ok(hits[0].signals.lexical, sample.name);
      assert.deepEqual(
        await search.search({ text: sample.query, vector: [1, 0] }, { strategy, ids: new Set() }),
        [],
      );
    }
    const exact = await search.search(
      { text: `${sample.query}::C++()`, vector: [0, 1] },
      { exact: 'promote', vectorCandidates: 1 },
    );
    assert.equal(exact[0].id, 'books');
    assert.equal(exact[0].exact, true);
  });

test('per-language fields retain full-corpus scores and segmented query semantics', async () => {
  const ja = (await import('defuss-lexicalsearch/ja')).default,
    ru = (await import('defuss-lexicalsearch/ru')).default;
  const index = new LexicalSearch({ fields: { ja: { analyzer: ja }, ru: { analyzer: ru } } });
  index.addAll([
    { id: 'ja', fields: { ja: '東京の図書館で本を読んだ。' } },
    { id: 'ru', fields: { ru: 'Мы читали книги в библиотеке.' } },
  ]);
  const adapter = createLexicalRetriever(index, { search: { fields: ['ja'] } });
  assert.equal((await adapter.retrieve({ text: '図書館はどこ' }, { limit: 10 }))[0].id, 'ja');
  const all = createLexicalRetriever(index, { search: { fields: ['ja'], operator: 'all' } });
  assert.deepEqual(await all.retrieve({ text: '図書館はどこ' }, { limit: 10 }), []);
});
