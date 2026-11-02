import type { HybridSearchOptions } from './types';

export type SearchPreset = 'efficient' | 'reranked';

/**
 * Explicit, independently owned presets; existing constructor defaults stay intact.
 * Efficient: lexical-weighted RRF selected on the development split described in
 * docs/pareto.md, with no neural inference. Reranked adds a bounded raw-score stage
 * and an agreement/margin gate. Neither preset establishes universal optimality.
 * Literal promotion still requires explicitly configured exact fields.
 *
 * Both presets move the vector source's first hit to the top when BM25's first hit matches less than 20% of the
 * query's IDF-weighted words and trails it by more than 0.15 cosine (src/pipeline/weak-lexical.ts). The thresholds
 * are the setting with the highest mean R@1 among those that cost no corpus more than one point of R@1, out of a
 * 3 x 3 grid. VERIFIED: bench/confidence-fusion.mjs on 2026-11-01, efficient preset against its rule-free
 * predecessor, R@1: notes found by their translations 97.8% against 61.5%, paraphrase queries 86.4% against 63.6%,
 * Belebele 91.3% against 91.0%, Belebele passages cut to 6 words 47.8% against 48.3%; R@5 within 0.4 points
 * everywhere. HYPOTHESIS: the thresholds hold on queries that did not select them; falsifier: fresh queries where
 * the rule costs a corpus more than a point of R@1.
 */
export function searchPreset(name: SearchPreset = 'efficient'): HybridSearchOptions {
  if (name !== 'efficient' && name !== 'reranked') throw new TypeError('Unknown search preset');
  return {
    strategy: 'fusion',
    lexicalCandidates: 25,
    vectorCandidates: 25,
    fusion: { method: 'rrf', k: 1, weights: { lexical: 3, vector: 1 } },
    weakLexical: { share: 0.2, gap: 0.15 },
    rerank:
      name === 'efficient'
        ? false
        : { candidates: 25, method: 'rrf', k: 1, weight: 0.25, skipIfVectorMargin: 0.1 },
  };
}
