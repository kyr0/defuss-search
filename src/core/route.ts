import type { ResolvedOptions } from './options';
import type { Retriever, RouteDecision } from '../types';

/**
 * Opt-in short-text routing for the fusion strategy: below `vectorOnlyBelow` analyzed terms per document, the
 * query uses the vector source alone and skips the reranker. It suits collections of short texts where a
 * translation or a paraphrase counts as a match, such as notes in several languages.
 * VERIFIED: bench/bm25-switch.mjs measured 98.9% R@1 with the vector source alone on such notes (8.7 terms per
 * note), against 61.5% for the reranked preset; on Belebele passages cut to 8 terms, where the relevant passage
 * shares the question's language and words, BM25 still led with 47.4% against 19.8%. Length alone therefore cannot
 * choose the route, and no preset sets this option.
 */
export function routeFor(lexical: Retriever, o: ResolvedOptions): RouteDecision {
  const threshold = o.vectorOnlyBelow;
  if (threshold === undefined || o.strategy !== 'fusion') return { route: 'hybrid' };
  const averageLength = lexical.averageLength?.();
  if (averageLength === undefined || !Number.isFinite(averageLength))
    return { route: 'hybrid', threshold };
  if (averageLength >= threshold) return { route: 'hybrid', averageLength, threshold };
  return { route: 'vector', averageLength, threshold };
}
