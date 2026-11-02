import { fuseRankings } from './fusion';
import type { Candidates } from '../pipeline/retrieval';
import type { ResolvedOptions } from './options';
import type { HybridHit, RankedHit } from '../types';

/** Build explainable result rows without interpreting unlike raw scores as one scale. */
export function rankCandidates(candidates: Candidates, o: ResolvedOptions): HybridHit[] {
  const { lexical, vector, primary, secondary, primarySource, secondarySource } = candidates;
  const signals = new Map<string, HybridHit['signals']>();
  for (const [source, hits] of [
    ['lexical', lexical],
    ['vector', vector],
  ] as const) {
    hits.forEach((hit, i) => {
      const entry = signals.get(hit.id) ?? {};
      entry[source] = {
        rank: i + 1,
        score: hit.score,
        ...(hit.tier !== undefined ? { tier: hit.tier } : {}),
      };
      signals.set(hit.id, entry);
    });
  }
  const makeHit = (hit: RankedHit, scoreKind: HybridHit['scoreKind']): HybridHit => ({
    id: hit.id,
    rank: 0,
    score: hit.score,
    scoreKind,
    signals: signals.get(hit.id) ?? {},
    exact: false,
    reasons: [],
  });
  let hits: HybridHit[];
  if (o.strategy === 'fusion' || o.cascade === 'fuse') {
    hits = fuseRankings(
      [
        { name: 'lexical', hits: lexical, weight: o.fusion.weights.lexical },
        { name: 'vector', hits: vector, weight: o.fusion.weights.vector },
      ],
      o.fusion,
    ).map((hit) => ({ ...makeHit(hit, o.fusion.method), contributions: hit.contributions }));
  } else {
    const matched = new Set(secondary.map((hit) => hit.id));
    hits = [
      ...secondary.map((hit) => makeHit(hit, secondarySource)),
      ...primary
        .filter((hit) => !matched.has(hit.id))
        .map((hit) => ({ ...makeHit(hit, primarySource), reasons: ['unmatched-secondary'] })),
    ];
  }
  if (o.strategy !== 'fusion' && o.unmatched === 'drop') {
    const matched = new Set(secondary.map((hit) => hit.id));
    hits = hits.filter((hit) => matched.has(hit.id));
  }

  return hits;
}
