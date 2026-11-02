import { LexicalSearch } from 'defuss-lexicalsearch';
import type { JsonValue, LexicalDocument, LexicalSearchOptions } from 'defuss-lexicalsearch';
import { HybridSearch } from './engine';
import { createLexicalRetriever, withSurfaceFields } from './lexical';
import type { LexicalRetrieverOptions } from './lexical';
import { createVectorRetriever } from './vector';
import type { VectorRetrieverOptions } from './vector';
import type {
  HybridConfig,
  HybridHit,
  HybridResponse,
  HybridSearchOptions,
  SearchQuery,
} from './types';

export interface HybridIndexOptions<M extends JsonValue = Record<string, JsonValue>> {
  documents: readonly LexicalDocument<M>[];
  /** Row-aligned with documents; generate with the same model used by embedQuery. */
  vectors: readonly ArrayLike<number>[];
  embedQuery?: VectorRetrieverOptions['embedQuery'];
  lexical?: LexicalSearchOptions;
  /**
   * Unstemmed companions for every stemming field (withSurfaceFields), on by default; `false` leaves the lexical
   * options as given, `{ weight }` scales the companions' field weights (default 1). On by default rather than opt-in:
   * VERIFIED: bench/surface.mjs (2026-11-02) measured 27 more exact-word hits at rank 1 of 100 in the defuss-shadcn
   * docs and one fewer of 1,000 Belebele questions (efficient preset).
   */
  surface?: boolean | { weight?: number };
  lexicalSearch?: LexicalRetrieverOptions<M>;
  vector?: Omit<VectorRetrieverOptions, 'ids' | 'vectors' | 'embedQuery'>;
  reranker?: HybridConfig['reranker'];
  defaults?: HybridConfig['defaults'];
}
export interface HybridIndex<M extends JsonValue = Record<string, JsonValue>> {
  readonly size: number;
  get(id: string): LexicalDocument<M> | undefined;
  search(query: string | SearchQuery, options?: HybridSearchOptions): Promise<HybridHit[]>;
  searchWithStats(
    query: string | SearchQuery,
    options?: HybridSearchOptions,
  ): Promise<HybridResponse>;
}
/** An owned, immutable corpus snapshot. Rebuild to update; existing queries keep their snapshot. */
export function createHybridIndex<M extends JsonValue = Record<string, JsonValue>>(
  options: HybridIndexOptions<M>,
): HybridIndex<M> {
  const surface = options.surface ?? true;
  const lexical = new LexicalSearch<M>(
    surface === false
      ? options.lexical
      : withSurfaceFields(options.lexical, surface === true ? {} : surface),
  );
  lexical.addAll(options.documents);
  const vector = createVectorRetriever({
    ...options.vector,
    ids: options.documents.map((doc) => doc.id),
    vectors: options.vectors,
    embedQuery: options.embedQuery,
  });
  const search = new HybridSearch({
    lexical: createLexicalRetriever(lexical, options.lexicalSearch),
    vector,
    reranker: options.reranker,
    defaults: options.defaults,
  });
  return Object.freeze({
    size: lexical.size,
    get: (id: string) => lexical.get(id),
    search: (query: string | SearchQuery, opts?: HybridSearchOptions) => search.search(query, opts),
    searchWithStats: (query: string | SearchQuery, opts?: HybridSearchOptions) =>
      search.searchWithStats(query, opts),
  });
}
