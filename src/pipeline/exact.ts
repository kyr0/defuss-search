import { abortable, checkHits, throwIfAborted } from '../core/validation';
import type { ResolvedOptions } from '../core/options';
import type { HybridHit, Retriever, SearchQuery } from '../types';

/**
 * Attach evidence from original-field equality. Fusion may add literal candidates;
 * cascades can only promote documents already retained from their first stage.
 */
export async function attachExact(
  hits: HybridHit[],
  query: SearchQuery,
  lexical: Retriever,
  options: ResolvedOptions,
  allowed?: ReadonlySet<string>,
): Promise<number> {
  const scope = options.strategy === 'fusion' ? allowed : new Set(hits.map((hit) => hit.id));
  const limit = Math.min(options.exactCandidates, scope?.size ?? options.exactCandidates);
  if (!limit) return 0;
  throwIfAborted(options.signal);
  const exact = checkHits(
    await abortable(
      lexical.exact!(query, {
        limit,
        ids: scope && new Set(scope),
        signal: options.signal,
      }),
      options.signal,
    ),
    scope,
    limit,
  );
  const byId = new Map(hits.map((hit) => [hit.id, hit]));
  for (const entry of exact) {
    let hit = byId.get(entry.id);
    if (!hit) {
      // This hit has literal evidence but no vote in either original retrieval window.
      hit = {
        id: entry.id,
        rank: 0,
        score: entry.score,
        scoreKind: 'lexical',
        signals: {},
        exact: false,
        reasons: [],
      };
      hits.push(hit);
      byId.set(hit.id, hit);
    }
    hit.exact = true;
    hit.reasons.push('literal-exact');
  }
  return exact.length;
}
