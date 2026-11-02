import type { ResolvedOptions } from '../core/options';
import { abortable } from '../core/validation';
import type { Candidates } from './retrieval';
import type { HybridConfig, HybridHit, SearchQuery, WeakLexicalDecision } from '../types';

/**
 * Weak-lexical promotion for the fusion strategy. Rank fusion with the presets' weights gives BM25's first hit
 * 3/(1+1) = 1.5 points and the vector source's first hit at most 0.5, so BM25 decides the top even when its first
 * hit matched one common word. This step looks at the evidence behind that first hit: the share of the query's
 * words it matches, each word weighted by its inverse document frequency in the index, and how much less similar
 * it is to the query than the vector source's first hit. When both say the match is incidental, the vector
 * source's first hit moves to the top; every other hit keeps its order, so BM25's hits stay in the first results.
 * Moving one hit beats dropping BM25 for the query: both reach the same R@1, but dropping BM25 lost R@5.
 * VERIFIED: bench/confidence-fusion.mjs on 2026-11-01, see the thresholds in src/presets.ts.
 */
export async function weakLexical(
  hits: HybridHit[],
  candidates: Candidates,
  query: SearchQuery,
  retrievers: Pick<HybridConfig, 'lexical' | 'vector'>,
  o: ResolvedOptions,
): Promise<WeakLexicalDecision> {
  if (!o.weakLexical) return { action: 'disabled' };
  if (o.strategy !== 'fusion') return { action: 'unavailable', reason: 'strategy' };
  const lexical = candidates.lexical[0],
    vector = candidates.vector[0];
  if (!lexical || !vector) return { action: 'unavailable', reason: 'no-candidates' };
  if (lexical.id === vector.id) return { action: 'unavailable', reason: 'same-first-hit' };
  if (typeof retrievers.lexical.matchShare !== 'function')
    return { action: 'unavailable', reason: 'unsupported' };
  const share = await abortable(retrievers.lexical.matchShare(query, lexical.id), o.signal);
  if (share === undefined) return { action: 'unavailable', reason: 'no-words' };

  // The lexical hit's vector score: from the candidates, else from an exact rescore of that one document, else
  // bounded by the last vector candidate. A text-only query is rescored too: the built-in vector and ColBERT
  // retrievers keep the last query's embedding or scan, so the rescore costs no second model call. VERIFIED: on
  // Belebele the bound alone moved the vector hit for 3 questions where the exact score moved it for 10.
  let score = candidates.vector.find((hit) => hit.id === lexical.id)?.score;
  let gapBound = false;
  if (score === undefined && retrievers.vector.rescore) {
    const [hit] = await abortable(
      retrievers.vector.rescore(query, {
        limit: 1,
        ids: new Set([lexical.id]),
        signal: o.signal,
      }),
      o.signal,
    );
    score = hit?.id === lexical.id ? hit.score : undefined;
  }
  if (score === undefined) {
    score = candidates.vector.at(-1)!.score;
    gapBound = true;
  }
  const gap = vector.score - score;
  let moved = false;
  if (share < o.weakLexical.share && gap > o.weakLexical.gap) {
    const from = hits.findIndex((hit) => hit.id === vector.id);
    // Requested exact matches stay ahead of the promoted hit.
    const to = o.exact === 'promote' ? hits.findIndex((hit) => !hit.exact) : 0;
    if (from > to && to >= 0) {
      const [hit] = hits.splice(from, 1);
      hit!.reasons.push('weak-lexical');
      hits.splice(to, 0, hit!);
      moved = true;
    }
  }
  return {
    action: moved ? 'promoted' : 'kept',
    lexical: lexical.id,
    vector: vector.id,
    share,
    gap,
    gapBound,
  };
}
