import type { BalanceOptions, HybridHit, RankedHit } from '../types';

/** Apply policies to the full ordering before pagination. Never invent candidates. */
export function applyPolicies(
  hits: HybridHit[],
  promote: boolean,
  balance: BalanceOptions | undefined,
  lexical: readonly RankedHit[],
  vector: readonly RankedHit[],
): { hits: HybridHit[]; representatives: { lexical: string[]; vector: string[] } } {
  const ordered = promote
    ? [...hits.filter((hit) => hit.exact), ...hits.filter((hit) => !hit.exact)]
    : [...hits];
  const representatives: { lexical: string[]; vector: string[] } = { lexical: [], vector: [] };
  if (!balance || !ordered.length) return { hits: ordered, representatives };
  const available = new Set(ordered.map((hit) => hit.id));
  representatives.lexical = lexical
    .filter((hit) => available.has(hit.id))
    .slice(0, balance.lexical)
    .map((hit) => hit.id);
  representatives.vector = vector
    .filter((hit) => available.has(hit.id))
    .slice(0, balance.vector)
    .map((hit) => hit.id);
  const required = new Set([...representatives.lexical, ...representatives.vector]);
  // A required nonexact hit can follow exact hits only if all exact hits fit too.
  if (promote && ordered.some((hit) => required.has(hit.id) && !hit.exact)) {
    for (const hit of ordered) if (hit.exact) required.add(hit.id);
  }
  const window = Math.min(balance.window, ordered.length);
  if (required.size > window)
    throw new RangeError(
      'Exact promotion and source coverage cannot fit balance.window; enlarge it or relax the policies',
    );
  const prefix = new Set(required);
  for (const hit of ordered) {
    if (prefix.size >= window) break;
    prefix.add(hit.id);
  }
  const before = new Map(ordered.map((hit, i) => [hit.id, i]));
  const result = [
    ...ordered.filter((hit) => prefix.has(hit.id)),
    ...ordered.filter((hit) => !prefix.has(hit.id)),
  ];
  for (let i = 0; i < result.length; i++) {
    const hit = result[i]!;
    if (
      required.has(hit.id) &&
      before.get(hit.id)! >= window &&
      i < window &&
      !hit.reasons.includes('source-coverage')
    )
      hit.reasons.push('source-coverage');
  }
  return { hits: result, representatives };
}
