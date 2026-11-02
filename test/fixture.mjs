import { LexicalSearch, apiSearchPreset } from 'defuss-lexicalsearch';
import { HybridSearch } from 'defuss-search';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';

// Hand-authored vectors are algorithm fixtures, not claims about model quality.
export const documents = [
  {
    id: 'api/c++',
    fields: { symbol: 'C++', description: 'C plus plus programming language' },
    metadata: { public: true },
  },
  {
    id: 'api/c',
    fields: { symbol: 'C', description: 'C programming language' },
    metadata: { public: true },
  },
  {
    id: 'api/c#',
    fields: { symbol: 'C#', description: 'C sharp programming language' },
    metadata: { public: true },
  },
  {
    id: 'method/push',
    fields: {
      symbol: 'Array.prototype.push()',
      description: 'Append an element to the end of an array',
    },
    metadata: { public: true },
  },
  {
    id: 'method/pop',
    fields: {
      symbol: 'Array.prototype.pop()',
      description: 'Remove the last element from an array',
    },
    metadata: { public: true },
  },
  {
    id: 'concept/append',
    fields: { symbol: 'append', description: 'Grow a sequence with a new item' },
    metadata: { public: false },
  },
  {
    id: '__proto__',
    fields: { symbol: 'x.y()', description: 'A punctuation-sensitive dotted function' },
    metadata: { public: true },
  },
];
export const vectors = [
  [1, 0, 0],
  [0.98, 0.1, 0],
  [0.97, 0.15, 0],
  [0, 1, 0],
  [0, 0.7, 0.7],
  [0, 1, 0.05],
  [0, 0, 1],
].map((x) => Float32Array.from(x));
export function fixture(options = {}) {
  const index = new LexicalSearch(apiSearchPreset);
  index.addAll(documents);
  const lexical = createLexicalRetriever(index, {
    search: { fuzzy: false },
    exact: { fields: ['symbol'] },
  });
  const vector = createVectorRetriever({
    ids: documents.map((x) => x.id),
    vectors,
    ...options.vector,
  });
  return {
    index,
    lexical,
    vector,
    search: new HybridSearch({ lexical, vector, ...options.engine }),
  };
}
