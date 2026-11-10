import type { HybridSearchOptions } from './types';

export type SearchPreset = 'reranked' | 'efficient';

/** Winzling-embed's target languages, whose vectors the benchmark finds strong enough for their own fusion. */
const WINZLING_LANGUAGES = ['de', 'en', 'es', 'fr', 'it', 'nl', 'pt', 'ru'] as const;

/**
 * Explicit, independently owned presets; existing constructor defaults stay intact.
 * Reranked, the default name: efficient's retrieval plus a bounded raw-score ColBERT stage and an agreement/margin
 * gate; it needs a configured reranker, and HybridSearch rejects it without one. Efficient: lexical-weighted RRF
 * selected on the development split described in docs/pareto.md, with no neural inference. Reranked is the default
 * by the maintainer's choice (2026-11-09), not by a measured gain. VERIFIED: with the defuss-vectorsearch 0.4.0
 * models, over all 1,000 benchmark questions, both reach 92.5% R@1 and 97.3% R@5, and reranked runs ColBERT for 893
 * of them (bench/pareto.mjs, 2026-11-10). Neither preset establishes universal optimality.
 * Literal promotion still requires explicitly configured exact fields.
 *
 * Both presets move the vector source's first hit to the top when BM25's first hit matches less than 20% of the
 * query's IDF-weighted words and trails it by more than 0.15 cosine (src/pipeline/weak-lexical.ts). The thresholds
 * are the setting with the highest mean R@1 among those that cost no corpus more than one point of R@1, out of a
 * 3 x 3 grid. VERIFIED: bench/confidence-fusion.mjs on 2026-11-09 with the defuss-vectorsearch 0.3.1 models,
 * efficient preset against its rule-free predecessor, R@1: notes found by their translations 97.8% against 61.5%,
 * paraphrase queries 81.8% against 59.1%, Belebele 91.2% against 91.0%, passages cut to 6 words 47.6% against
 * 48.4% and to 16 words 65.8% against 66.8%, exactly the one-point limit; R@5 equal everywhere. Those corpora pass no
 * `language`, so they measured the k=0 fusion. HYPOTHESIS: the thresholds hold on queries that did not select them;
 * falsifier: fresh queries where the rule costs a corpus more than a point of R@1.
 *
 * The fusion is RRF with weights 2:1, k=20 for a query whose `language` is one of Winzling-embed's eight target
 * languages and k=0 for any other or none: bench/pareto.mjs selects the other languages' k and weights on their
 * development questions, then the group's k at those weights (2026-11-10). Why shared weights: the group's own best,
 * 1:1, cost a guessed `language` 1.5 points R@1 when BM25 searches all 20 fields. VERIFIED: on the 500 held-out
 * questions, 93.6% R@1 against 92.4% with one setting for every language, R@5 96.8% for both; with a guessed
 * language, 89.7% R@1 against 89.9% (bench/language-guess.mjs). bench/language-groups.mjs compared groupings tuned on one half and scored on the other: two groups
 * beat one on all 20 halvings; four groups by language family led them by 0.15 points R@1 on average (14 of 20
 * halvings), 1.5 of 1,000 questions, while searched bins and one group per language scored lower. Two groups follow the
 * model's own target list; HYPOTHESIS: the family lead is noise; falsifier: a larger fixture where it persists.
 */
export function searchPreset(name: SearchPreset = 'reranked'): HybridSearchOptions {
  if (name !== 'efficient' && name !== 'reranked') throw new TypeError('Unknown search preset');
  return {
    strategy: 'fusion',
    lexicalCandidates: 25,
    vectorCandidates: 25,
    fusion: {
      method: 'rrf',
      k: 0,
      weights: { lexical: 2, vector: 1 },
      byLanguage: [
        { languages: [...WINZLING_LANGUAGES], k: 20, weights: { lexical: 2, vector: 1 } },
      ],
    },
    weakLexical: { share: 0.2, gap: 0.15 },
    rerank:
      name === 'efficient'
        ? false
        : { candidates: 25, method: 'rrf', k: 1, weight: 0.25, skipIfVectorMargin: 0.1 },
  };
}
