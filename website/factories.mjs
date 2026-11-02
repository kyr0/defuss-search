/**
 * The three factories of defuss-search/strategies as the demo offers them: what each one downloads, which result
 * column it fills and which published figures its in-browser measurement compares with. Pure data, shared by the
 * page and the markup builders.
 * Why the demo asks for a factory first: each one downloads something different (nothing, MoEdernColBERT, Winzling),
 * so the choice decides what the page loads, and the results show one search as an application would run it.
 * VERIFIED: scripts/e2e.mjs starts every factory and checks each result's column method and measured rows by these ids.
 */
export const FACTORIES = [
  {
    id: 'lexical-only',
    fn: 'createLexicalOnlySearch',
    title: 'Lexical-only',
    badge: 'No model',
    description:
      "BM25 with each language's analyzer and stopwords. Nothing to download beyond the text.",
    models: [],
  },
  {
    id: 'tiny',
    fn: 'createLexicalSemanticTinySearch',
    title: 'Lexical-semantic tiny',
    badge: 'ColBERT only',
    description:
      'BM25 fused with MoEdernColBERT 1.5M as the only vector model. This browser encodes the 2,000 passages into a TurboQuant token index and scans every token per query.',
    models: ['colbert'],
  },
  {
    id: 'semantic',
    fn: 'createLexicalSemanticSearch',
    title: 'Lexical-semantic',
    badge: 'Measured default',
    description:
      'BM25 fused with Winzling vectors (the efficient preset); with the reranker, MoEdernColBERT reorders the top 25 unless both sources agree on a clear winner (the reranked preset).',
    models: ['winzling'],
  },
];
export const factoryOf = (id) => FACTORIES.find((factory) => factory.id === id);

/** Result columns and measurement rows: one per factory, lexical-semantic split by its preset. */
export const METHODS = {
  'lexical-only': { title: 'Lexical-only', published: 'strategies' },
  tiny: { title: 'Lexical-semantic tiny', published: 'strategies' },
  efficient: { title: 'Lexical-semantic · efficient', published: 'recall' },
  reranked: { title: 'Lexical-semantic · reranked', published: 'recall' },
};
/** The column a factory's search fills; lexical-semantic reports the preset it ran. */
export const methodOf = (factory, rerank) =>
  factory === 'semantic' ? (rerank ? 'reranked' : 'efficient') : factory;

/** One model's file sizes added up: the bytes its download progress counts and the browser cache keeps. */
export const modelBytes = (files) =>
  Object.values(files).reduce((sum, file) => sum + file.bytes, 0);
/** The same files gzipped: the transfer from a host that sends them compressed (scripts/demo-data.mjs). */
export const gzipBytes = (files) => Object.values(files).reduce((sum, file) => sum + file.gzip, 0);
