import { buildTurboQuantIndex, scoreTurboQuantIndex } from 'defuss-vectorsearch/turboquant.js';
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

/** One text's ColBERT token vectors, row-major: defuss-vectorsearch's TokenMatrix fits this shape. */
export interface TokenMatrixLike {
  readonly data: ArrayLike<number>;
  readonly tokenCount: number;
  readonly dimensions: number;
}
export interface ColbertRetrieverOptions {
  /** Stable document IDs in the same order as `matrices`. Copied on creation. */
  ids: readonly string[];
  matrices: readonly TokenMatrixLike[];
  /** The query's token vectors, e.g. `(text) => colbert.encodeQueries([text]).then(([m]) => m)`. */
  encodeQuery: (text: string, context: { signal?: AbortSignal }) => Awaitable<TokenMatrixLike>;
  /**
   * 'turboquant' (default) keeps 4-bit codes, 64 bytes per 128-dimensional token instead of 512 in float32;
   * 'exact' keeps float32 tokens.
   */
  quantization?: 'turboquant' | 'exact';
  seed?: number;
}

/** Validate one matrix and write its unit-length rows into `out` at `offset`; ColBERT scores token cosines. */
function rows(
  matrix: TokenMatrixLike,
  dimensions?: number,
  out?: Float32Array,
  offset = 0,
): Float32Array {
  if (!matrix || typeof matrix !== 'object') throw new TypeError('Token matrices must be objects');
  integer(matrix.tokenCount, 'tokenCount', 1, 100000);
  integer(matrix.dimensions, 'token dimensions', 1, 65536);
  if (dimensions !== undefined && matrix.dimensions !== dimensions)
    throw new RangeError(`Token dimensions must equal ${dimensions}`);
  if (!matrix.data || matrix.data.length !== matrix.tokenCount * matrix.dimensions)
    throw new RangeError('Token matrix data must hold tokenCount x dimensions values');
  // Allocate only after validation, so a malformed matrix fails with the messages above.
  out ??= new Float32Array(matrix.tokenCount * matrix.dimensions);
  const d = matrix.dimensions,
    data = matrix.data;
  for (let t = 0; t < matrix.tokenCount; t++) {
    let sum = 0;
    for (let j = t * d; j < (t + 1) * d; j++) {
      if (!Number.isFinite(data[j]!))
        throw new TypeError('Token vectors must contain finite numbers');
      sum += data[j]! ** 2;
    }
    if (!(sum > 0)) throw new RangeError('Token vectors must have nonzero norm');
    const norm = Math.sqrt(sum);
    for (let j = t * d; j < (t + 1) * d; j++) out[offset + j] = data[j]! / norm;
  }
  return out;
}

/**
 * ColBERT as a first-stage retriever: every document keeps its token vectors, and a query scores each document by
 * MaxSim (for each query token, the best cosine among the document's tokens, averaged over query tokens, so scores
 * stay in [-1, 1] like a single-vector cosine). The scan visits every stored token.
 * TurboQuant applies because ColBERT token vectors are unit-length. VERIFIED: on 181,361 Belebele passage tokens it
 * cut 92.9 MB of float32 to 11.6 MB of codes, scored a query token in 7.3 ms, and missed exact cosines by 0.009 on
 * average (probe 2026-11-01; bench/strategies.mjs measures recall).
 */
export function createColbertRetriever(options: ColbertRetrieverOptions): Retriever {
  if (
    !options ||
    !Array.isArray(options.ids) ||
    !Array.isArray(options.matrices) ||
    options.ids.length !== options.matrices.length
  )
    throw new TypeError('IDs and token matrices must be arrays of equal length');
  if (typeof options.encodeQuery !== 'function') throw new TypeError('encodeQuery is required');
  const quantization = options.quantization ?? 'turboquant';
  if (!['turboquant', 'exact'].includes(quantization)) throw new TypeError('Unknown quantization');
  if (options.seed !== undefined) integer(options.seed, 'seed', 0, 0xffffffff);
  const ids = [...options.ids];
  ids.forEach(id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate document IDs');
  const dimensions = options.matrices[0]?.dimensions;
  const offsets = new Int32Array(ids.length + 1);
  options.matrices.forEach((matrix, i) => {
    integer(matrix?.tokenCount, 'tokenCount', 1, 100000);
    offsets[i + 1] = offsets[i]! + matrix.tokenCount;
  });
  const d = dimensions ?? 0;
  // One float32 copy, written in place, so the peak stays near twice the input size.
  const flat = new Float32Array(offsets[ids.length]! * d);
  options.matrices.forEach((matrix, i) => rows(matrix, dimensions, flat, offsets[i]! * d));
  const packed =
    quantization === 'turboquant' && ids.length
      ? buildTurboQuantIndex(
          Array.from({ length: offsets[ids.length]! }, (_, t) => flat.subarray(t * d, (t + 1) * d)),
          options.seed !== undefined ? { seed: options.seed } : {},
        )
      : undefined;
  // With codes built, the float tokens are no longer needed.
  const tokens = packed ? undefined : flat;
  const position = new Map(ids.map((value, i) => [value, i]));
  const encode = options.encodeQuery;

  /** Averaged MaxSim of every document for one query text. Shared by callers, so it takes no caller's signal. */
  const scan = async (text: string) => {
    const matrix = await encode(text, {});
    const q = rows(matrix, d || undefined);
    const scores = new Float64Array(ids.length);
    for (let t = 0; t < matrix.tokenCount; t++) {
      const token = q.subarray(t * d, (t + 1) * d);
      const all = packed ? scoreTurboQuantIndex(packed, token) : undefined;
      for (let doc = 0; doc < ids.length; doc++) {
        let best = -Infinity;
        for (let s = offsets[doc]!; s < offsets[doc + 1]!; s++) {
          let value: number;
          if (all) value = all[s]!;
          else {
            value = 0;
            for (let j = 0; j < d; j++) value += token[j]! * tokens![s * d + j]!;
          }
          if (value > best) best = value;
        }
        scores[doc] = scores[doc]! + best;
      }
    }
    for (let doc = 0; doc < ids.length; doc++) scores[doc] = scores[doc]! / matrix.tokenCount;
    return scores;
  };
  // The scan visits every token whatever the eligible IDs, so the last query's scores serve a rescore within the
  // same search (and repeated queries) without a second scan or query encoding.
  let last: { text: string; scores: Promise<Float64Array> } | undefined;
  const run = async (input: SearchQuery, context: RetrievalContext) => {
    throwIfAborted(context.signal);
    integer(context.limit, 'limit');
    const query = queryCopy(input),
      allowed = idsCopy(context.ids);
    const docs = allowed
      ? [...allowed].flatMap((value) => {
          const i = position.get(value);
          return i === undefined ? [] : [i];
        })
      : ids.map((_, i) => i);
    if (!docs.length || !context.limit) return [];
    if (last?.text !== query.text) {
      const pending = { text: query.text, scores: scan(query.text) };
      last = pending;
      pending.scores.catch(() => {
        if (last === pending) last = undefined;
      });
    }
    const scores = await abortable(last.scores, context.signal);
    return docs
      .map((doc) => ({ id: ids[doc]!, score: scores[doc]! }))
      .sort((a, b) => b.score - a.score || compareId(a.id, b.id))
      .slice(0, context.limit);
  };
  return { retrieve: run, rescore: run };
}
