import { abortable, checkHits, throwIfAborted } from '../core/validation';
import type { ResolvedOptions } from '../core/options';
import type {
  HybridConfig,
  HybridResponse,
  RankedHit,
  RetrievalContext,
  SearchQuery,
  Source,
} from '../types';

/** Source order is authoritative, including exact-first lexical tiers. */
export interface Candidates {
  lexical: RankedHit[];
  vector: RankedHit[];
  primary: RankedHit[];
  secondary: RankedHit[];
  primarySource: Source;
  secondarySource: Source;
}

/** Retrieve independent lists or rescore the first-stage pool without changing its recall ceiling. */
export async function retrieveCandidates(
  retrievers: Pick<HybridConfig, 'lexical' | 'vector'>,
  query: SearchQuery,
  o: ResolvedOptions,
  allowed: ReadonlySet<string> | undefined,
  timings: HybridResponse['timings'],
): Promise<Candidates> {
  const signal = o.signal;
  const run = async (
    source: Source,
    limit: number,
    ids: ReadonlySet<string> | undefined,
    rescore = false,
  ): Promise<RankedHit[]> => {
    throwIfAborted(signal);
    if (ids?.size === 0) return [];
    const retriever = source === 'lexical' ? retrievers.lexical : retrievers.vector;
    const context: RetrievalContext = { limit, ids: ids && new Set(ids), signal };
    const start = performance.now();
    const method = rescore ? (retriever.rescore ?? retriever.retrieve) : retriever.retrieve;
    const result = await abortable(method.call(retriever, query, context), signal);
    timings[source === 'lexical' ? 'lexicalMs' : 'vectorMs'] += performance.now() - start;
    return checkHits(result, ids, limit);
  };
  let lexical: RankedHit[],
    vector: RankedHit[],
    primary: RankedHit[] = [],
    secondary: RankedHit[] = [];
  let primarySource: Source = 'vector',
    secondarySource: Source = 'lexical';
  if (o.strategy === 'fusion') {
    [lexical, vector] = await Promise.all([
      run('lexical', o.lexicalCandidates, allowed),
      run('vector', o.vectorCandidates, allowed),
    ]);
  } else {
    primarySource = o.strategy === 'vector-first' ? 'vector' : 'lexical';
    secondarySource = primarySource === 'vector' ? 'lexical' : 'vector';
    primary = await run(
      primarySource,
      primarySource === 'vector' ? o.vectorCandidates : o.lexicalCandidates,
      allowed,
    );
    secondary = await run(
      secondarySource,
      primary.length,
      new Set(primary.map((hit) => hit.id)),
      true,
    );
    [lexical, vector] = primarySource === 'lexical' ? [primary, secondary] : [secondary, primary];
  }

  return { lexical, vector, primary, secondary, primarySource, secondarySource };
}
