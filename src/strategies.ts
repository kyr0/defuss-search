import type { JsonValue, LexicalSearch } from 'defuss-lexicalsearch';
import type { ColbertLike } from './adapters/colbert';
import type { TokenMatrixLike } from './adapters/colbert-retriever';
import { createLexicalRetriever, type LexicalRetrieverOptions } from './adapters/lexical';
import { id } from './core/validation';
import { HybridSearch } from './engine';
import { searchPreset } from './presets';
import type { Awaitable, HybridSearchOptions, Retriever } from './types';

/**
 * Three ready-made searches with their defaults, from no model to the measured default:
 * - lexical-only: BM25 through HybridSearch, no model;
 * - lexical-semantic-tiny: BM25 fused with MoEdernColBERT 1.5M (3.83 MB) as the only vector model, over a
 *   TurboQuant token index;
 * - lexical-semantic: BM25 fused with Winzling (39.8 MB) vectors, optionally reranked by ColBERT: the presets.
 * The model-backed factories import their adapters on demand, so the lexical-only search loads no
 * defuss-vectorsearch code. They take model instances; this package never downloads a model itself.
 */
export interface StrategyDocument {
  readonly id: string;
  readonly text: string;
}
/** Structural contract of defuss-vectorsearch's ColBERT model: its encodeDocuments() and encodeQueries(). */
export interface ColbertEncoder {
  encodeDocuments(
    texts: readonly string[],
    options?: { truncate?: boolean },
  ): Awaitable<readonly TokenMatrixLike[]>;
  encodeQueries(
    texts: readonly string[],
    options?: { truncate?: boolean },
  ): Awaitable<readonly TokenMatrixLike[]>;
}
/** Structural contract of defuss-vectorsearch's Winzling embedder. */
export interface DocumentEmbedder {
  embedDocuments(texts: string[]): Awaitable<readonly ArrayLike<number>[]>;
  embedQuery(text: string): Awaitable<ArrayLike<number>>;
}

const NO_VECTOR = { retrieve: () => [] };
/**
 * The tiny strategy's defaults: the efficient preset's fusion with a smaller weak-lexical gap. VERIFIED: in
 * bench/strategies.mjs (2026-11-09, defuss-vectorsearch 0.3.1 models), with text-only queries rescored exactly, gap
 * 0.1 had the highest mean R@1 of the gaps 0.05 to 0.2 among those that cost no corpus more than one point of R@1
 * against the rule switched off, the presets' criterion: translated notes rose from 41.8% to 47.3% R@1 and Belebele
 * moved from 90.5% to 90.6%. Gap 0.05 reached 61.5% on the notes but lost one of the API fixture's 10 paraphrase
 * queries at rank 1; with the previous models it cost Belebele 1.1 points. The gap was chosen on those same queries.
 * HYPOTHESIS: averaged MaxSim compresses score differences, because every query token finds some similar document
 * token, so the presets' 0.15 is too wide for it; a corpus where 0.1 loses R@1 against 0.15 would falsify this.
 */
const TINY_DEFAULTS: HybridSearchOptions = {
  ...searchPreset('efficient'),
  // The presets' language group was selected for Winzling's vectors; tiny's vector source is ColBERT.
  fusion: { ...searchPreset('efficient').fusion, byLanguage: [] },
  weakLexical: { share: 0.2, gap: 0.1 },
};

function documentList(documents: readonly StrategyDocument[]) {
  if (!Array.isArray(documents)) throw new TypeError('documents must be an array of { id, text }');
  const list = documents.map((doc) => {
    id(doc?.id);
    if (typeof doc.text !== 'string') throw new TypeError(`Document ${doc.id} needs a text`);
    return { id: doc.id, text: doc.text };
  });
  if (new Set(list.map((doc) => doc.id)).size !== list.length)
    throw new Error('Duplicate document IDs');
  return list;
}

/**
 * A vector source passed in to share one index between searches that differ only in their lexical options, such as
 * one search per language: the factories then build no index of their own, so N searches hold one copy.
 */
function retriever(vector: Retriever) {
  if (typeof vector?.retrieve !== 'function') throw new TypeError('vector must be a retriever');
  return vector;
}

/** lexical-only: BM25 alone, with the result shape and policies of the hybrid searches. */
export function createLexicalOnlySearch<M extends JsonValue>(
  index: LexicalSearch<M>,
  options: { lexical?: LexicalRetrieverOptions<M>; defaults?: HybridSearchOptions } = {},
): HybridSearch {
  return new HybridSearch({
    lexical: createLexicalRetriever(index, options.lexical),
    vector: NO_VECTOR,
    defaults: {
      strategy: 'fusion',
      lexicalCandidates: 25,
      rerank: false,
      weakLexical: false,
      ...options.defaults,
    },
  });
}

/**
 * lexical-semantic-tiny: ColBERT encodes every document once into token vectors, which a TurboQuant index keeps
 * at 64 bytes per token; a query is fused from BM25 and a MaxSim scan. No Winzling download, but the index and
 * the scan grow with the number of tokens.
 */
export async function createLexicalSemanticTinySearch<M extends JsonValue>(
  index: LexicalSearch<M>,
  options:
    | {
        documents: readonly StrategyDocument[];
        colbert: ColbertEncoder;
        /** Token matrices encoded earlier, in `documents` order; skips document encoding. */
        matrices?: readonly TokenMatrixLike[];
        quantization?: 'turboquant' | 'exact';
        lexical?: LexicalRetrieverOptions<M>;
        defaults?: HybridSearchOptions;
      }
    | {
        /** A token index built earlier with createColbertRetriever(), shared with other searches. */
        vector: Retriever;
        lexical?: LexicalRetrieverOptions<M>;
        defaults?: HybridSearchOptions;
      },
): Promise<HybridSearch> {
  if (options && 'vector' in options)
    return new HybridSearch({
      lexical: createLexicalRetriever(index, options.lexical),
      vector: retriever(options.vector),
      defaults: { ...TINY_DEFAULTS, ...options.defaults },
    });
  const documents = documentList(options?.documents);
  const colbert = options.colbert;
  if (typeof colbert?.encodeDocuments !== 'function' || typeof colbert.encodeQueries !== 'function')
    throw new TypeError('colbert must provide encodeDocuments() and encodeQueries()');
  const { createColbertRetriever } = await import('./adapters/colbert-retriever');
  let matrices = options.matrices;
  if (!matrices) {
    const encoded: TokenMatrixLike[] = [];
    for (let i = 0; i < documents.length; i += 64)
      encoded.push(
        ...(await colbert.encodeDocuments(
          documents.slice(i, i + 64).map((doc) => doc.text),
          { truncate: true },
        )),
      );
    matrices = encoded;
  }
  const vector = createColbertRetriever({
    ids: documents.map((doc) => doc.id),
    matrices,
    quantization: options.quantization ?? 'turboquant',
    encodeQuery: async (text) => (await colbert.encodeQueries([text], { truncate: true }))[0]!,
  });
  return new HybridSearch({
    lexical: createLexicalRetriever(index, options.lexical),
    vector,
    defaults: { ...TINY_DEFAULTS, ...options.defaults },
  });
}

/**
 * lexical-semantic: the measured default. Winzling embeds every document (or `vectors` supplies them) and each
 * query; with a ColBERT `reranker` the search uses searchPreset('reranked'), without one searchPreset('efficient').
 */
export async function createLexicalSemanticSearch<M extends JsonValue>(
  index: LexicalSearch<M>,
  options: {
    /** The documents' texts; the reranker reads them, and without `vector` the embedder embeds them. */
    documents: readonly StrategyDocument[];
    /** Required unless `vector` is passed. */
    embedder?: DocumentEmbedder;
    /** Document vectors computed earlier, in `documents` order; skips document embedding. */
    vectors?: readonly ArrayLike<number>[];
    /** A vector retriever built earlier with createVectorRetriever(), shared with other searches. */
    vector?: Retriever;
    reranker?: ColbertLike;
    vectorStrategy?: 'exact' | 'turboquant';
    lexical?: LexicalRetrieverOptions<M>;
    defaults?: HybridSearchOptions;
  },
): Promise<HybridSearch> {
  const documents = documentList(options?.documents);
  const embedder = options.embedder;
  if (
    !options.vector &&
    (typeof embedder?.embedDocuments !== 'function' || typeof embedder.embedQuery !== 'function')
  )
    throw new TypeError('embedder must provide embedDocuments() and embedQuery()');
  const [{ createVectorRetriever }, { createColbertAdapter }] = await Promise.all([
    import('./adapters/vector'),
    import('./adapters/colbert'),
  ]);
  const text = new Map(documents.map((doc) => [doc.id, doc.text]));
  const vector = options.vector
    ? retriever(options.vector)
    : createVectorRetriever({
        ids: documents.map((doc) => doc.id),
        vectors:
          options.vectors ?? (await embedder!.embedDocuments(documents.map((doc) => doc.text))),
        strategy: options.vectorStrategy ?? 'exact',
        embedQuery: (query) => embedder!.embedQuery(query),
      });
  return new HybridSearch({
    lexical: createLexicalRetriever(index, options.lexical),
    vector,
    ...(options.reranker
      ? {
          reranker: createColbertAdapter(options.reranker, (key) => text.get(key)!, {
            truncate: true,
          }),
        }
      : {}),
    defaults: {
      ...searchPreset(options.reranker ? 'reranked' : 'efficient'),
      ...options.defaults,
    },
  });
}
