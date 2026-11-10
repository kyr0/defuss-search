/**
 * The playground's examples. Each runs without a model: lexical search, or two-dimensional toy vectors standing in
 * for an embedding. test/playground.test.mjs runs each one and checks what it prints.
 * VERIFIED: test/playground.test.mjs runs every snippet and checks its output.
 */
export const SNIPPETS = {
  lexical: `import { LexicalSearch } from 'defuss-lexicalsearch';
import en from 'defuss-lexicalsearch/en';
import { createLexicalOnlySearch } from 'defuss-search/strategies';

const index = new LexicalSearch({ fields: { text: { analyzer: en } } });
index.addAll([
  { id: 'walk', fields: { text: 'Dogs need a walk every morning' } },
  { id: 'sofa', fields: { text: 'A cat sleeps on the warm sofa' } },
  { id: 'park', fields: { text: 'The park opens at seven in the morning' } },
]);
const search = createLexicalOnlySearch(index);

// The English analyzer stems: "walks" finds "walk".
const hits = await search.search('morning walks');
console.log(hits.map((hit) => \`\${hit.rank}. \${hit.id}\`));
`,
  exact: `import { apiSearchPreset } from 'defuss-lexicalsearch';
import { searchPreset } from 'defuss-search';
import { createHybridIndex } from 'defuss-search/indexing';

// Two API entries; two-dimensional toy vectors stand in for an embedding model.
const search = createHybridIndex({
  documents: [
    { id: 'push', fields: { symbol: 'Array.prototype.push()', description: 'Add elements to the end of an array' } },
    { id: 'pop', fields: { symbol: 'Array.prototype.pop()', description: 'Remove the last element of an array' } },
  ],
  vectors: [[1, 0], [0, 1]],
  defaults: searchPreset('efficient'),
  lexical: apiSearchPreset,
  lexicalSearch: { exact: { fields: ['symbol'] } },
});

// The query vector points at pop, but the text is exactly push's symbol.
const hits = await search.search(
  { text: 'Array.prototype.push()', vector: [0, 1] },
  { exact: 'promote' },
);
for (const hit of hits) console.log(hit.rank, hit.id, { exact: hit.exact, reasons: hit.reasons });
`,
  explain: `import { apiSearchPreset } from 'defuss-lexicalsearch';
import { searchPreset } from 'defuss-search';
import { createHybridIndex } from 'defuss-search/indexing';

const search = createHybridIndex({
  documents: [
    { id: 'push', fields: { symbol: 'Array.prototype.push()', description: 'Add elements to the end of an array' } },
    { id: 'pop', fields: { symbol: 'Array.prototype.pop()', description: 'Remove the last element of an array' } },
    { id: 'shift', fields: { symbol: 'Array.prototype.shift()', description: 'Remove the first element of an array' } },
  ],
  vectors: [[1, 0], [0.1, 1], [0.3, 0.9]],
  defaults: searchPreset('efficient'),
  lexical: apiSearchPreset,
});

// The sources disagree: BM25 prefers "first", the query vector points at pop.
const hits = await search.search({ text: 'remove the first element', vector: [0.05, 1] });
for (const hit of hits)
  console.log(hit.rank, hit.id, hit.score.toFixed(2), {
    lexical: hit.signals.lexical?.rank,
    vector: hit.signals.vector?.rank,
  });
// Weighted RRF with k=0 and weights 2:1: each source adds weight / rank.
console.log('#1', hits[0].contributions);
`,
  languages: `import { LexicalSearch } from 'defuss-lexicalsearch';
import de from 'defuss-lexicalsearch/de';
import en from 'defuss-lexicalsearch/en';
import { createLexicalOnlySearch } from 'defuss-search/strategies';

const index = new LexicalSearch({ fields: { de: { analyzer: de }, en: { analyzer: en } } });
index.addAll([
  { id: 'de-1', fields: { de: 'Die Pinguine im Zoo bekommen um zehn Uhr Fisch' } },
  { id: 'en-1', fields: { en: 'The penguins at the zoo get fish at ten' } },
]);
const search = createLexicalOnlySearch(index);

// The query's language picks its field's analyzer: German stemming matches "Pinguin" with "Pinguine".
for (const [text, language] of [['Wann bekommt der Pinguin Fisch?', 'de'], ['when do penguins get fish', 'en']]) {
  const hits = await search.search({ text, language });
  console.log(language, hits.map((hit) => hit.id));
}
`,
};
