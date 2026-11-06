import type { RankedHit, SearchQuery } from '../types';
export function integer(
  value: unknown,
  name: string,
  min = 0,
  max = 10000,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer in [${min}, ${max}]`);
}
export function weight(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e6)
    throw new RangeError(`${name} must be finite in [0, 1000000]`);
}
export function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length)
    throw new TypeError('IDs must be nonempty strings');
}
export const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export function queryCopy(input: string | SearchQuery): SearchQuery {
  const value = typeof input === 'string' ? { text: input } : input;
  if (!value || typeof value.text !== 'string' || value.text.length > 16384)
    throw new TypeError('Query text must be a string of at most 16384 UTF-16 units');
  // VERIFIED: LexicalSearch rejects an invalid tag with a RangeError (test/query-language.test.mjs), so a copy only
  // needs to keep a nonempty string.
  if (value.language !== undefined && (typeof value.language !== 'string' || !value.language))
    throw new TypeError('Query language must be a nonempty BCP 47 tag');
  const language = value.language === undefined ? {} : { language: value.language };
  if (value.vector === undefined) return Object.freeze({ text: value.text, ...language });
  integer(value.vector.length, 'vector dimensions', 1, 65536);
  const vector = Array.from(value.vector);
  if (!vector.every(Number.isFinite))
    throw new TypeError('Query vector must contain finite numbers');
  return Object.freeze({ text: value.text, vector: Object.freeze(vector), ...language });
}
export function idsCopy(values?: ReadonlySet<string>): Set<string> | undefined {
  if (values === undefined) return undefined;
  if (!(values instanceof Set)) throw new TypeError('ids must be a Set');
  const copy = new Set(values);
  for (const value of copy) id(value);
  return copy;
}
export function checkHits(
  value: readonly RankedHit[],
  allowed?: ReadonlySet<string>,
  limit = 10000,
): RankedHit[] {
  if (!Array.isArray(value) || value.length > limit)
    throw new TypeError(`Retriever must return an array of at most ${limit} hits`);
  const seen = new Set<string>();
  return value.map((hit) => {
    if (!hit) throw new TypeError('Invalid hit');
    id(hit.id);
    if (!Number.isFinite(hit.score)) throw new TypeError(`Nonfinite score for ${hit.id}`);
    if (seen.has(hit.id)) throw new Error(`Duplicate hit ID: ${hit.id}`);
    if (allowed && !allowed.has(hit.id))
      throw new Error(`Retriever escaped candidate/filter scope: ${hit.id}`);
    if (hit.tier !== undefined && typeof hit.tier !== 'string') throw new TypeError('Invalid tier');
    seen.add(hit.id);
    return { id: hit.id, score: hit.score, ...(hit.tier !== undefined ? { tier: hit.tier } : {}) };
  });
}
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Search aborted');
}
/** Stop awaiting promptly; underlying model work may still complete if it has no cancellation API. */
export function abortable<T>(operation: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  const promise = Promise.resolve(operation);
  // The operation may synchronously abort its own signal before returning a promise.
  // Observe its eventual rejection even when the caller has already cancelled.
  if (signal?.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason ?? new Error('Search aborted'));
  }
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error('Search aborted'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        if (signal.aborted) reject(signal.reason ?? new Error('Search aborted'));
        else resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
