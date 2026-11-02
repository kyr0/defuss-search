import { fuseRankings } from '../core/fusion';
import { abortable, checkHits, throwIfAborted } from '../core/validation';
import type { ResolvedOptions } from '../core/options';
import type { HybridHit, Reranker, SearchQuery } from '../types';

/** Rerank only this prefix; preserve the untouched tail and the first-stage explanations. */
export async function rerankPrefix(
  hits: HybridHit[],
  query: SearchQuery,
  reranker: Reranker,
  options: Exclude<ResolvedOptions['rerank'], false>,
  signal?: AbortSignal,
) {
  const prefix = hits.slice(0, options.candidates),
    ids = Object.freeze(prefix.map((hit) => hit.id));
  throwIfAborted(signal);
  const neural = checkHits(
    await abortable(reranker.rerank(query, ids, { signal }), signal),
    new Set(ids),
    ids.length,
  );
  if (neural.length !== prefix.length)
    throw new Error('Reranker must return every candidate exactly once');
  if (neural.some((hit, i) => i > 0 && hit.score > neural[i - 1]!.score))
    throw new Error('Reranker scores must be in descending order');
  const byId = new Map(prefix.map((hit) => [hit.id, hit]));
  neural.forEach((hit, i) => {
    byId.get(hit.id)!.signals.reranker = { rank: i + 1, score: hit.score };
  });
  const order =
    options.method === 'replace'
      ? neural
      : fuseRankings(
          [
            { name: 'prior', hits: prefix },
            { name: 'reranker', hits: neural, weight: options.weight },
          ],
          { k: options.k },
        );
  const reranked = order.map((entry) => {
    const hit = byId.get(entry.id)!;
    hit.score = entry.score;
    hit.scoreKind = options.method === 'replace' ? 'reranker' : 'rerank-rrf';
    if ('contributions' in entry) hit.rerankContributions = entry.contributions;
    hit.reasons.push('neural-rerank');
    return hit;
  });
  hits = [...reranked, ...hits.slice(prefix.length)];

  return { hits, count: prefix.length };
}
