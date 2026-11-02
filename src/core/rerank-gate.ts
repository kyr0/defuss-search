import type { HybridHit, RankedHit, RerankDecision } from '../types';

/**
 * Inspect source evidence before paying for neural inference. Unlike a margin
 * measured on fused scores, this threshold has an explicit source score scale.
 * Lexical disagreement, policy promotion, an incomplete pair or a nonmonotonic
 * vector list always leaves the neural stage enabled. No relevance is inferred.
 */
export function rerankGate(
  hits: readonly HybridHit[],
  lexical: readonly RankedHit[],
  vector: readonly RankedHit[],
  threshold: number | undefined,
): Extract<RerankDecision, { action: 'skipped' }> | undefined {
  if (threshold === undefined || threshold === Infinity || vector.length < 2) return;
  const winner = vector[0]!;
  if (hits[0]?.id !== winner.id || (lexical.length && lexical[0]!.id !== winner.id)) return;
  if (vector.some((hit, i) => i > 0 && hit.score > vector[i - 1]!.score)) return;
  const margin = winner.score - vector[1]!.score;
  if (!Number.isFinite(margin) || margin < threshold) return;
  return {
    action: 'skipped',
    reason: 'vector-margin',
    winner: winner.id,
    margin,
    threshold,
    lexical: lexical.length ? 'agrees' : 'empty',
  };
}
