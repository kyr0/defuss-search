import {
  buildTurboQuantIndex,
  rerankSearchHits,
  scoreTurboQuantIndex,
} from 'defuss-vectorsearch/turboquant.js';
import type { Awaitable, Retriever, RetrievalContext, SearchQuery } from '../types';
import {
  abortable,
  compareId,
  id,
  idsCopy,
  integer,
  queryCopy,
  throwIfAborted,
} from '../core/validation';

export interface VectorRetrieverOptions {
  /** Stable document IDs in the exact same row order as vectors. Copied on creation. */
  ids: readonly string[];
  vectors: readonly ArrayLike<number>[];
  embedQuery?: (text: string, context: { signal?: AbortSignal }) => Awaitable<ArrayLike<number>>;
  metric?: 'cosine' | 'dot';
  strategy?: 'exact' | 'turboquant';
  /** Recheck this many approximate candidates using retained float vectors. 0 disables. */
  refineCandidates?: number;
  seed?: number;
  clip?: number;
}

function vectorCopy(input: ArrayLike<number>, dimensions: number, cosine: boolean): Float32Array {
  if (!input || input.length !== dimensions)
    throw new RangeError(`Vector dimensions must equal ${dimensions}`);
  const values = Array.from(input);
  if (!values.every(Number.isFinite)) throw new TypeError('Vectors must contain finite numbers');
  // Scale before summing squares, including for extremely large/small input magnitudes.
  let scale = 0;
  for (const value of values) scale = Math.max(scale, Math.abs(value));
  if (cosine) {
    if (!scale) throw new RangeError('Cosine vectors must have nonzero norm');
    let sum = 0;
    for (const value of values) sum += (value / scale) ** 2;
    const norm = Math.sqrt(sum);
    for (let i = 0; i < values.length; i++) values[i] = values[i]! / scale / norm;
  }
  const result = Float32Array.from(values);
  if (!result.every(Number.isFinite)) throw new RangeError('Vector values overflow Float32');
  return result;
}

/** Exact float dot/cosine or upstream TurboQuant scan. Candidate rescoring is always exact. */
export function createVectorRetriever(options: VectorRetrieverOptions): Retriever {
  if (
    !options ||
    !Array.isArray(options.ids) ||
    !Array.isArray(options.vectors) ||
    options.ids.length !== options.vectors.length
  )
    throw new TypeError('IDs and vectors must be arrays of equal length');
  const ids = [...options.ids];
  ids.forEach(id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate vector IDs');
  const metric = options.metric ?? 'cosine',
    strategy = options.strategy ?? 'exact',
    refine = options.refineCandidates ?? 0;
  if (!['cosine', 'dot'].includes(metric) || !['exact', 'turboquant'].includes(strategy))
    throw new TypeError('Unknown vector metric/strategy');
  if (strategy === 'turboquant' && metric !== 'cosine')
    throw new Error('TurboQuant requires cosine-normalized vectors');
  integer(refine, 'refineCandidates');
  if (options.seed !== undefined) integer(options.seed, 'seed', 0, 0xffffffff);
  if (
    options.clip !== undefined &&
    (!Number.isFinite(options.clip) || options.clip <= 0 || options.clip > 100)
  )
    throw new RangeError('clip must be in (0, 100]');
  const dimensions = options.vectors[0]?.length ?? 0;
  if (ids.length) integer(dimensions, 'dimensions', strategy === 'turboquant' ? 2 : 1, 65536);
  const vectors = options.vectors.map((value) =>
    vectorCopy(value, dimensions, metric === 'cosine'),
  );
  const packed =
    strategy === 'turboquant' && ids.length
      ? buildTurboQuantIndex(vectors, { seed: options.seed, clip: options.clip })
      : undefined;
  const embed = options.embedQuery;
  if (embed !== undefined && typeof embed !== 'function')
    throw new TypeError('embedQuery must be a function');
  // The last embedded text and its validated copy: a rescore inside the same search (the weak-lexical rule's exact
  // score) and a repeated query reuse it instead of embedding again. Only resolved vectors are kept, so an aborted
  // or failed embedding never answers another caller, and the copy is this adapter's own, so an embedder that reuses
  // its output buffer cannot change it. VERIFIED: on Belebele, text-only queries then ranked exactly like queries
  // carrying their vector, with one embedding per question.
  let last: { text: string; vector: Float32Array } | undefined;
  const embedText = async (text: string, signal?: AbortSignal) => {
    if (last?.text === text) return last.vector;
    const raw = await abortable(embed!(text, { signal }), signal);
    const vector = vectorCopy(raw, dimensions, metric === 'cosine');
    last = { text, vector };
    return vector;
  };
  const run = async (input: SearchQuery, context: RetrievalContext, rescore = false) => {
    throwIfAborted(context.signal);
    integer(context.limit, 'limit');
    const query = queryCopy(input),
      allowed = idsCopy(context.ids);
    const candidates = ids.flatMap((id, index) =>
      !allowed || allowed.has(id) ? [{ index, score: 0 }] : [],
    );
    if (!candidates.length || !context.limit) return [];
    if (!query.vector && !embed) throw new Error('Supply query.vector or configure embedQuery');
    const vector = query.vector
      ? vectorCopy(query.vector, dimensions, metric === 'cosine')
      : await embedText(query.text, context.signal);
    throwIfAborted(context.signal);
    const sort = <T extends { index: number; score: number }>(values: T[]): T[] => {
      if (values.some((hit) => !Number.isFinite(hit.score)))
        throw new RangeError('Vector score overflow');
      return values.sort((a, b) => b.score - a.score || compareId(ids[a.index]!, ids[b.index]!));
    };
    let scored: { index: number; score: number }[];
    if (packed && !rescore) {
      const scores = scoreTurboQuantIndex(packed, vector);
      scored = sort(candidates.map((hit) => ({ index: hit.index, score: scores[hit.index]! })));
      if (refine) {
        const shortlist = scored.slice(0, Math.max(refine, context.limit));
        scored = sort(rerankSearchHits(vectors, vector, shortlist, shortlist.length));
      }
    } else scored = sort(rerankSearchHits(vectors, vector, candidates, candidates.length));
    throwIfAborted(context.signal);
    return scored.slice(0, context.limit).map((hit) => ({ id: ids[hit.index]!, score: hit.score }));
  };
  return { retrieve: run, rescore: (query, context) => run(query, context, true) };
}
