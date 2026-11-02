import {
  HybridSearch,
  searchPreset,
  type RerankDecision,
  fuseRankings,
  type HybridHit,
  type HybridSearchOptions,
  type WeakLexicalDecision,
} from 'defuss-search';
import { createHybridIndex } from 'defuss-search/indexing';
import { createLexicalRetriever, withSurfaceFields } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
import { createColbertAdapter, createColbertRetriever } from 'defuss-search/colbert';
import {
  createLexicalOnlySearch,
  createLexicalSemanticSearch,
  createLexicalSemanticTinySearch,
} from 'defuss-search/strategies';
import { LexicalSearch, apiSearchPreset } from 'defuss-lexicalsearch';
import { createWinzlingEmbedder, createColbertReranker } from 'defuss-vectorsearch/onnx.js';
const lexical = new LexicalSearch<{ tag: string }>(apiSearchPreset);
const embedder = createWinzlingEmbedder();
const adapter = createColbertAdapter(createColbertReranker({ model: '1.5m' }), (id) => id);
const options: HybridSearchOptions = {
  strategy: 'fusion',
  ...searchPreset('efficient'),
  fusion: { method: 'rrf' },
  exact: 'promote',
  balance: { window: 5, lexical: 1, vector: 1 },
};
const search = new HybridSearch({
  lexical: createLexicalRetriever(lexical, {
    exact: { fields: ['symbol'] },
    search: { filter: (metadata) => metadata?.tag === 'x' },
  }),
  vector: createVectorRetriever({
    ids: [],
    vectors: [],
    embedQuery: (text) => embedder.embedQuery(text),
  }),
  reranker: adapter,
});
const result: Promise<HybridHit[]> = search.search('query', options);
const index = createHybridIndex({
  documents: [{ id: 'a', fields: { symbol: 'x' }, metadata: { tag: 'x' } }],
  vectors: [[1, 0]],
  lexical: withSurfaceFields(apiSearchPreset, { weight: 0.5 }),
  surface: false,
});
const tag: string | undefined = index.get('a')?.metadata?.tag;
void result;
void tag;
void fuseRankings;
// @ts-expect-error Strategy spelling is deliberately invalid.
search.search('x', { strategy: 'semantic-first' });

const decision: Promise<RerankDecision> = search
  .searchWithStats('query', { rerank: { skipIfVectorMargin: 0.1 } })
  .then((response) => response.rerankDecision);
void decision;
// Ready-made strategies accept the upstream models structurally.
const colbertModel = createColbertReranker({ model: '1.5m' });
const lexicalOnly: HybridSearch = createLexicalOnlySearch(lexical);
const tiny: Promise<HybridSearch> = createLexicalSemanticTinySearch(lexical, {
  documents: [{ id: 'a', text: 'x' }],
  colbert: colbertModel,
});
const semantic: Promise<HybridSearch> = createLexicalSemanticSearch(lexical, {
  documents: [{ id: 'a', text: 'x' }],
  embedder,
  reranker: colbertModel,
});
const tokenIndex = createColbertRetriever({
  ids: [],
  matrices: [],
  encodeQuery: async (text) => (await colbertModel.encodeQueries([text]))[0]!,
});
const weak: WeakLexicalDecision['action'] = 'promoted';
void lexicalOnly;
void tiny;
void semantic;
void tokenIndex;
void weak;
