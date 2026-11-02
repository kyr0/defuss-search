import { copyOptions, optionsFor } from './core/options';
import { applyPolicies } from './core/policies';
import { rankCandidates } from './core/ranking';
import { rerankGate } from './core/rerank-gate';
import { routeFor } from './core/route';
import { idsCopy, queryCopy, throwIfAborted } from './core/validation';
import { attachExact } from './pipeline/exact';
import { retrieveCandidates } from './pipeline/retrieval';
import { rerankPrefix } from './pipeline/rerank';
import { weakLexical } from './pipeline/weak-lexical';
import type {
  HybridConfig,
  HybridHit,
  HybridResponse,
  HybridSearchOptions,
  SearchQuery,
} from './types';

/**
 * Stands in for the lexical source on the short-text route: no BM25 candidates, exact lookup unaffected.
 * VERIFIED: test/route.test.mjs promotes a literal match on this route.
 */
const NO_LEXICAL = { retrieve: () => [] };

/**
 * Orchestrates bounded retrieval, ranking, optional policies and neural reranking.
 *
 * Source adapters own their indexes and model lifecycles. A query snapshots its
 * options, vector and eligible IDs before awaiting anything; adapters must keep
 * their corpus consistent until that query finishes. Final rank is authoritative.
 */
export class HybridSearch {
  private readonly lexical: HybridConfig['lexical'];
  private readonly vector: HybridConfig['vector'];
  private readonly reranker: HybridConfig['reranker'];
  private readonly defaults: HybridSearchOptions;

  constructor(config: HybridConfig) {
    if (
      typeof config?.lexical?.retrieve !== 'function' ||
      typeof config?.vector?.retrieve !== 'function'
    )
      throw new TypeError('Lexical and vector retrievers are required');
    if (config.reranker && typeof config.reranker.rerank !== 'function')
      throw new TypeError('Invalid reranker');
    this.lexical = config.lexical;
    this.vector = config.vector;
    this.reranker = config.reranker;
    this.defaults = copyOptions(config.defaults ?? {});
    optionsFor(this.defaults, {}, !!this.reranker);
  }

  /** Return a page of ranked hits; candidate windows remain fixed across pages. */
  async search(
    input: string | SearchQuery,
    options: HybridSearchOptions = {},
  ): Promise<HybridHit[]> {
    return (await this.searchWithStats(input, options)).hits;
  }

  /** Return hits plus finite-pool counts, stage timings and coverage representatives. */
  async searchWithStats(
    input: string | SearchQuery,
    options: HybridSearchOptions = {},
  ): Promise<HybridResponse> {
    const started = performance.now();
    const query = queryCopy(input),
      o = optionsFor(this.defaults, options, !!this.reranker);
    const allowed = idsCopy(o.ids);
    throwIfAborted(o.signal);
    if (o.exact === 'promote' && !this.lexical.exact)
      throw new Error(
        'Exact promotion requires a lexical retriever with configured literal exact fields',
      );
    const timings = { lexicalMs: 0, vectorMs: 0, exactMs: 0, rerankMs: 0, totalMs: 0 };
    const response: HybridResponse = {
      hits: [],
      totalCandidates: 0,
      strategy: o.strategy,
      counts: { lexical: 0, vector: 0, exact: 0, reranked: 0 },
      rerankDecision: { action: o.rerank ? 'empty' : 'disabled' },
      route: { route: 'hybrid' },
      weakLexical: o.weakLexical
        ? { action: 'unavailable', reason: 'no-candidates' }
        : { action: 'disabled' },
      timings,
      representatives: { lexical: [], vector: [] },
    };
    if (
      (!query.text.length && query.vector === undefined) ||
      allowed?.size === 0 ||
      o.limit === 0
    ) {
      timings.totalMs = performance.now() - started;
      return response;
    }

    const route = routeFor(this.lexical, o);
    response.route = route;
    const candidates = await retrieveCandidates(
      { lexical: route.route === 'vector' ? NO_LEXICAL : this.lexical, vector: this.vector },
      query,
      o,
      allowed,
      timings,
    );
    response.counts.lexical = candidates.lexical.length;
    response.counts.vector = candidates.vector.length;
    let hits = rankCandidates(candidates, o);
    if (o.exact === 'promote') {
      const start = performance.now();
      response.counts.exact = await attachExact(hits, query, this.lexical, o, allowed);
      timings.exactMs = performance.now() - start;
    }
    let policy = applyPolicies(
      hits,
      o.exact === 'promote',
      o.balance,
      candidates.lexical,
      candidates.vector,
    );
    hits = policy.hits;
    const skip =
      o.rerank && route.route === 'vector'
        ? ({
            action: 'skipped',
            reason: 'short-documents',
            averageLength: route.averageLength!,
            threshold: route.threshold!,
          } as const)
        : o.rerank
          ? rerankGate(hits, candidates.lexical, candidates.vector, o.rerank.skipIfVectorMargin)
          : undefined;
    if (skip) {
      response.rerankDecision = skip;
      hits[0]?.reasons.push(`rerank-skipped:${skip.reason}`);
    }
    if (o.rerank && hits.length && !skip) {
      const start = performance.now();
      const reranked = await rerankPrefix(hits, query, this.reranker!, o.rerank, o.signal);
      response.counts.reranked = reranked.count;
      response.rerankDecision = { action: 'applied', candidates: reranked.count };
      timings.rerankMs = performance.now() - start;
      // Neural order must not weaken explicitly requested exactness or source coverage.
      policy = applyPolicies(
        reranked.hits,
        o.exact === 'promote',
        o.balance,
        candidates.lexical,
        candidates.vector,
      );
      hits = policy.hits;
    }
    // After reranking and policies, so neither can undo the promotion; requested exact matches stay first.
    response.weakLexical = await weakLexical(
      hits,
      candidates,
      query,
      { lexical: this.lexical, vector: this.vector },
      o,
    );
    throwIfAborted(o.signal);
    hits.forEach((hit, index) => {
      hit.rank = index + 1;
    });
    response.hits = hits.slice(o.offset, o.offset + o.limit);
    response.totalCandidates = hits.length;
    response.representatives = policy.representatives;
    timings.totalMs = performance.now() - started;
    return response;
  }
}
