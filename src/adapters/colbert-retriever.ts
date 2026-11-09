import { buildTurboQuantIndex, scoreTurboQuantIndex } from 'defuss-vectorsearch/turboquant.js';
import type { TurboQuantSearchIndex } from 'defuss-vectorsearch';
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
/**
 * A TurboQuant token index built ahead of time with `buildColbertTokenIndex()`: each document's token count, in
 * document order, and the codes of every token. It holds only numbers and typed arrays, so an application can
 * store it as bytes and pass it back as `index`; the retriever then skips document encoding and quantization.
 */
export interface ColbertTokenIndex {
  readonly tokenCounts: ArrayLike<number>;
  readonly turboquant: TurboQuantSearchIndex;
}
export interface ColbertRetrieverOptions {
  /** Stable document IDs in the same order as `matrices` or `index.tokenCounts`. Copied on creation. */
  ids: readonly string[];
  /** The documents' token vectors. Pass either `matrices` or `index`. */
  matrices?: readonly TokenMatrixLike[];
  /** A token index from `buildColbertTokenIndex()`; replaces `matrices`, `quantization` and `seed`. */
  index?: ColbertTokenIndex;
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

/** All matrices as one float32 array of unit rows, with each document's first token at `offsets[i]`. */
function flatten(matrices: readonly TokenMatrixLike[]) {
  const dimensions = matrices[0]?.dimensions;
  const offsets = new Int32Array(matrices.length + 1);
  matrices.forEach((matrix, i) => {
    integer(matrix?.tokenCount, 'tokenCount', 1, 100000);
    offsets[i + 1] = offsets[i]! + matrix.tokenCount;
  });
  const d = dimensions ?? 0;
  // One float32 copy, written in place, so the peak stays near twice the input size.
  const flat = new Float32Array(offsets[matrices.length]! * d);
  matrices.forEach((matrix, i) => rows(matrix, dimensions, flat, offsets[i]! * d));
  return { offsets, flat, d };
}
const quantize = (flat: Float32Array, d: number, seed?: number) =>
  buildTurboQuantIndex(
    Array.from({ length: flat.length / d }, (_, t) => flat.subarray(t * d, (t + 1) * d)),
    seed !== undefined ? { seed } : {},
  );

/**
 * Encodes nothing: quantizes token matrices computed earlier into the TurboQuant index that `createColbertRetriever`
 * would build, so an application can build it once (for example at build time) and ship the codes instead of
 * encoding every document on each client. VERIFIED: the Belebele index (2,000 passages, 180,626 tokens of the
 * defuss-vectorsearch 0.3.1 ColBERT) is 11.6 MB of codes, 8.89 MB gzipped; with the previous ColBERT, quantizing took
 * 127 ms in Bun and encoding the passages 13 to 15 s in Chromium.
 */
export function buildColbertTokenIndex(
  matrices: readonly TokenMatrixLike[],
  options: { seed?: number } = {},
): ColbertTokenIndex {
  if (!Array.isArray(matrices) || !matrices.length)
    throw new TypeError('Token matrices must be a nonempty array');
  if (options.seed !== undefined) integer(options.seed, 'seed', 0, 0xffffffff);
  const { flat, d } = flatten(matrices);
  return {
    tokenCounts: Int32Array.from(matrices, (matrix) => matrix.tokenCount),
    turboquant: quantize(flat, d, options.seed),
  };
}

/** Checks a prebuilt index against the IDs and returns its token offsets. */
function indexOffsets(index: ColbertTokenIndex, documents: number): Int32Array {
  const counts = index?.tokenCounts,
    packed = index?.turboquant;
  if (!counts || typeof counts.length !== 'number' || !packed || typeof packed !== 'object')
    throw new TypeError('index must hold tokenCounts and turboquant');
  if (counts.length !== documents)
    throw new RangeError('index.tokenCounts must hold one count per ID');
  const offsets = new Int32Array(documents + 1);
  for (let i = 0; i < documents; i++) {
    integer(counts[i], 'tokenCount', 1, 100000);
    offsets[i + 1] = offsets[i]! + counts[i]!;
  }
  integer(packed.dims, 'token dimensions', 1, 65536);
  if (
    packed.size !== offsets[documents] ||
    !(packed.codes instanceof Uint8Array) ||
    packed.codes.length !== packed.size * packed.codeBytes
  )
    throw new RangeError('index.turboquant must hold the codes of every counted token');
  return offsets;
}

/**
 * ColBERT as a first-stage retriever: every document keeps its token vectors, and a query scores each document by
 * MaxSim (for each query token, the best cosine among the document's tokens, averaged over query tokens, so scores
 * stay in [-1, 1] like a single-vector cosine). The scan visits every stored token.
 * TurboQuant applies because ColBERT token vectors are unit-length. VERIFIED: on 181,361 Belebele passage tokens of the
 * previous ColBERT it cut 92.9 MB of float32 to 11.6 MB of codes, scored a query token in 7.3 ms, and missed exact cosines by 0.009 on
 * average (probe 2026-11-01; bench/strategies.mjs measures recall). `index` takes the codes from
 * `buildColbertTokenIndex()` instead of the matrices.
 */
export function createColbertRetriever(options: ColbertRetrieverOptions): Retriever {
  if (!options || !Array.isArray(options.ids))
    throw new TypeError('IDs and token matrices must be arrays of equal length');
  if ((options.matrices === undefined) === (options.index === undefined))
    throw new TypeError('Pass either matrices or index');
  if (
    options.matrices !== undefined &&
    (!Array.isArray(options.matrices) || options.ids.length !== options.matrices.length)
  )
    throw new TypeError('IDs and token matrices must be arrays of equal length');
  if (typeof options.encodeQuery !== 'function') throw new TypeError('encodeQuery is required');
  const quantization = options.quantization ?? 'turboquant';
  if (!['turboquant', 'exact'].includes(quantization)) throw new TypeError('Unknown quantization');
  if (options.seed !== undefined) integer(options.seed, 'seed', 0, 0xffffffff);
  const ids = [...options.ids];
  ids.forEach(id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate document IDs');
  let offsets: Int32Array,
    d: number,
    packed: TurboQuantSearchIndex | undefined,
    tokens: Float32Array | undefined;
  if (options.index) {
    offsets = indexOffsets(options.index, ids.length);
    packed = options.index.turboquant;
    d = packed.dims;
  } else {
    const flat = flatten(options.matrices!);
    ({ offsets, d } = flat);
    packed =
      quantization === 'turboquant' && ids.length
        ? quantize(flat.flat, d, options.seed)
        : undefined;
    // With codes built, the float tokens are no longer needed.
    tokens = packed ? undefined : flat.flat;
  }
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
