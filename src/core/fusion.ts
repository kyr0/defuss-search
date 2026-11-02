import type { FusedHit, RankList } from '../types';
import { checkHits, compareId, integer, weight } from './validation';

/** Ordered inputs are authoritative, including lexical exact-first tiers. No duplicate votes per source. */
export function fuseRankings(
  lists: readonly RankList[],
  options: { method?: 'rrf' | 'linear'; k?: number } = {},
): FusedHit[] {
  if (!Array.isArray(lists) || !lists.length || lists.length > 64)
    throw new TypeError('Between 1 and 64 rank lists are required');
  const method = options.method ?? 'rrf',
    k = options.k ?? 60;
  if (!['rrf', 'linear'].includes(method)) throw new TypeError('Unknown fusion method');
  integer(k, 'RRF k', 0, 1e9);
  const names = new Set<string>();
  const validated = lists.map((list) => {
    if (!list || typeof list.name !== 'string' || !list.name.length || names.has(list.name))
      throw new TypeError('Rank list names must be unique nonempty strings');
    names.add(list.name);
    const w = list.weight ?? 1;
    weight(w, 'rank weight');
    const hits = checkHits(list.hits);
    if (method === 'linear' && hits.some((hit, i) => i > 0 && hit.score > hits[i - 1]!.score))
      throw new Error(
        'Linear fusion requires descending scores; use RRF for tiered/nonmonotonic rankings',
      );
    return { name: list.name, hits, weight: w };
  });
  const sum = validated.reduce((n, list) => n + list.weight, 0);
  if (!sum) throw new RangeError('At least one rank weight must be positive');
  const results = new Map<string, FusedHit>();
  // Canonical source order makes ties independent of caller's rank-list array order.
  for (const list of validated.sort((a, b) => compareId(a.name, b.name))) {
    const max = list.hits[0]?.score ?? 0,
      min = list.hits.at(-1)?.score ?? 0;
    list.hits.forEach((hit, i) => {
      const w = method === 'linear' ? list.weight / sum : list.weight;
      // Scaling first prevents overflow for opposite, very large finite scores.
      const scale = Math.max(Math.abs(max), Math.abs(min), 1);
      const normalized =
        max === min ? 1 : (hit.score / scale - min / scale) / (max / scale - min / scale);
      const contribution = method === 'rrf' ? w / (k + i + 1) : w * normalized;
      let result = results.get(hit.id);
      if (!result) {
        result = {
          id: hit.id,
          score: 0,
          contributions: Object.create(null) as FusedHit['contributions'],
        };
        results.set(hit.id, result);
      }
      result.score += contribution;
      result.contributions[list.name] = {
        rank: i + 1,
        score: hit.score,
        weight: w,
        contribution,
        ...(hit.tier ? { tier: hit.tier } : {}),
      };
    });
  }
  return [...results.values()].sort((a, b) => b.score - a.score || compareId(a.id, b.id));
}
