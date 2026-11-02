export type Strategy = 'vector-first' | 'lexical-first' | 'fusion';
export type Source = 'lexical' | 'vector';
export interface SearchQuery {
  readonly text: string;
  readonly vector?: ArrayLike<number>;
}
export interface RankedHit {
  readonly id: string;
  readonly score: number;
  readonly tier?: string;
}
export type Awaitable<T> = T | PromiseLike<T>;
export interface RetrievalContext {
  readonly limit: number;
  /** Must restrict eligibility BEFORE top-k. Each call receives its own set. */
  readonly ids?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}
export interface Retriever {
  retrieve(query: SearchQuery, context: RetrievalContext): Awaitable<readonly RankedHit[]>;
  /** If absent, retrieve() is called with the candidate IDs and their count. */
  rescore?(query: SearchQuery, context: RetrievalContext): Awaitable<readonly RankedHit[]>;
  /** Literal equality on explicitly configured fields. No fuzzy/tier inference. */
  exact?(query: SearchQuery, context: RetrievalContext): Awaitable<readonly RankedHit[]>;
  /**
   * Average analyzed terms per document over the fields this retriever searches, or undefined when unknown or
   * empty. A lexical retriever that reports it lets `vectorOnlyBelow` route short-text indexes.
   */
  averageLength?(): number | undefined;
  /**
   * Share of the query's words, each weighted by its inverse document frequency in this retriever's index, that
   * document `id` matches; undefined when no query word is searchable (stopwords and punctuation only). Lets
   * `weakLexical` recognize a BM25 first hit that matched only common words.
   */
  matchShare?(query: SearchQuery, id: string): Awaitable<number | undefined>;
}
export interface Reranker {
  /** Must return a complete permutation of supplied IDs; higher score is better. */
  rerank(
    query: SearchQuery,
    ids: readonly string[],
    context: { readonly signal?: AbortSignal },
  ): Awaitable<readonly RankedHit[]>;
}
export interface RankList {
  readonly name: string;
  readonly hits: readonly RankedHit[];
  readonly weight?: number;
}
export interface FusionOptions {
  method?: 'rrf' | 'linear';
  /** RRF constant, default 60. */
  k?: number;
  weights?: Partial<Record<Source, number>>;
}
export interface Contribution {
  rank: number;
  score: number;
  weight: number;
  contribution: number;
  tier?: string;
}
export interface FusedHit {
  id: string;
  score: number;
  contributions: Record<string, Contribution>;
}
export interface Signal {
  rank: number;
  score: number;
  tier?: string;
}
export interface HybridHit {
  id: string;
  /** Authoritative order after reranking and presentation policies. */
  rank: number;
  /** Score from scoreKind; different stages are NOT numerically comparable. */
  score: number;
  scoreKind: 'lexical' | 'vector' | 'rrf' | 'linear' | 'reranker' | 'rerank-rrf';
  signals: Partial<Record<Source | 'reranker', Signal>>;
  exact: boolean;
  reasons: string[];
  contributions?: Record<string, Contribution>;
  /** Neural-stage fusion explanation; first-stage contributions remain above. */
  rerankContributions?: Record<string, Contribution>;
}
export interface BalanceOptions {
  /** Guarantees are for a fixed prefix of the complete candidate ordering, not each page. */
  window: number;
  /** Reserve the best N available hits from each original retrieval order. */
  lexical: number;
  vector: number;
}
export interface RerankOptions {
  candidates?: number;
  /** Default rrf: fuse current order with raw neural order inside this prefix. */
  method?: 'rrf' | 'replace';
  k?: number;
  weight?: number;
  /**
   * Skip inference when the vector lead reaches this gap AND its winner is already
   * first AND lexical retrieval agrees (or is empty). Compared in raw vector score
   * units; 0.1 is a Winzling cosine heuristic, not a calibrated probability.
   * Undefined or Infinity always runs the configured neural stage.
   */
  skipIfVectorMargin?: number;
}
export type RerankDecision =
  | { action: 'disabled' | 'empty' }
  | { action: 'applied'; candidates: number }
  | { action: 'skipped'; reason: 'short-documents'; averageLength: number; threshold: number }
  | {
      action: 'skipped';
      reason: 'vector-margin';
      winner: string;
      margin: number;
      threshold: number;
      lexical: 'agrees' | 'empty';
    };
export interface HybridSearchOptions {
  strategy?: Strategy;
  /** Default 25 each. Fixed across pages; no implicit expansion with offset. */
  lexicalCandidates?: number;
  vectorCandidates?: number;
  /** Cascades: secondary order with unmatched tail, or fuse both stage orders. */
  cascade?: 'replace' | 'fuse';
  unmatched?: 'keep' | 'drop';
  fusion?: FusionOptions;
  /** Disabled by default. Cascades never inject documents outside stage 1. */
  exact?: 'none' | 'promote';
  exactCandidates?: number;
  balance?: BalanceOptions;
  rerank?: false | RerankOptions;
  /**
   * Fusion only, opt-in: when the lexical retriever reports fewer analyzed terms per document than this, the query
   * uses the vector source alone and skips the reranker. For short texts where translations or paraphrases count
   * as matches; on short same-language passages BM25 stays better. VERIFIED: bench/bm25-switch.mjs.
   */
  vectorOnlyBelow?: number;
  /**
   * Fusion only; both presets set it, constructors leave it off. When BM25's first hit matches less than `share`
   * of the query's IDF-weighted words AND its vector score trails the vector source's first hit by more than `gap`
   * (raw vector score units, cosine for Winzling), the vector source's first hit goes first; the rest keeps its
   * order. Requires `matchShare` on the lexical retriever. VERIFIED: bench/confidence-fusion.mjs.
   */
  weakLexical?: false | WeakLexicalOptions;
  ids?: ReadonlySet<string>;
  signal?: AbortSignal;
  limit?: number;
  offset?: number;
}
export interface HybridResponse {
  hits: HybridHit[];
  /** Size of this finite candidate union/pool, NOT a full-corpus match count. */
  totalCandidates: number;
  strategy: Strategy;
  counts: { lexical: number; vector: number; exact: number; reranked: number };
  /** A skipped stage has no synthetic neural scores or contributions. */
  rerankDecision: RerankDecision;
  /** Which sources ran, and the document length that decided it when `vectorOnlyBelow` is set. */
  route: RouteDecision;
  /** Whether `weakLexical` moved the vector source's first hit to the top, with the evidence it used. */
  weakLexical: WeakLexicalDecision;
  timings: {
    lexicalMs: number;
    vectorMs: number;
    exactMs: number;
    rerankMs: number;
    totalMs: number;
  };
  /** The best available source representatives required inside balance.window. */
  representatives: { lexical: string[]; vector: string[] };
}
export interface WeakLexicalOptions {
  /** Share of the query's IDF-weighted words, in [0, 1], below which BM25's first hit counts as weak. */
  share: number;
  /** Lead of the vector source's first hit over BM25's first hit, in raw vector score units. */
  gap: number;
}
export type WeakLexicalDecision =
  | { action: 'disabled' }
  | {
      action: 'unavailable';
      reason: 'strategy' | 'no-candidates' | 'same-first-hit' | 'unsupported' | 'no-words';
    }
  | {
      action: 'kept' | 'promoted';
      /** BM25's first hit and the vector source's first hit. */
      lexical: string;
      vector: string;
      share: number;
      gap: number;
      /** True when the lexical hit was outside the vector candidates and the gap is a lower bound. */
      gapBound: boolean;
    };
export interface RouteDecision {
  route: 'hybrid' | 'vector';
  averageLength?: number;
  threshold?: number;
}
export interface HybridConfig {
  lexical: Retriever;
  vector: Retriever;
  reranker?: Reranker;
  defaults?: Omit<HybridSearchOptions, 'ids' | 'signal'>;
}
