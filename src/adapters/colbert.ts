import type { Awaitable, Reranker } from '../types';
import { abortable, checkHits, id, integer, queryCopy, throwIfAborted } from '../core/validation';

/** Structural contract of defuss-vectorsearch's raw ColbertReranker.rerank(). */
export interface ColbertLike {
  rerank(
    query: string,
    documents: readonly string[],
    options: { topK: number; truncate?: boolean; documentLength?: number },
  ): Awaitable<readonly { index: number; score: number }[]>;
}
export interface ColbertAdapterOptions {
  truncate?: boolean;
  documentLength?: number;
}

/** Never call rerankHits here: it already fuses dense ranks and would double-vote that signal. */
export function createColbertAdapter(
  model: ColbertLike,
  resolveText: (id: string) => Awaitable<string>,
  options: ColbertAdapterOptions = {},
): Reranker {
  if (typeof model?.rerank !== 'function' || typeof resolveText !== 'function')
    throw new TypeError('Raw reranker and text resolver are required');
  const settings = { ...options };
  if (settings.documentLength !== undefined)
    integer(settings.documentLength, 'documentLength', 3, 512);
  if (settings.truncate !== undefined && typeof settings.truncate !== 'boolean')
    throw new TypeError('truncate must be a boolean');
  return {
    async rerank(input, suppliedIds, { signal }) {
      throwIfAborted(signal);
      const query = queryCopy(input),
        ids = [...suppliedIds];
      integer(ids.length, 'rerank candidates');
      ids.forEach(id);
      if (new Set(ids).size !== ids.length) throw new Error('Duplicate rerank candidate IDs');
      if (!ids.length) return [];
      const texts = await abortable(
        Promise.all(
          ids.map(async (id) => {
            const text = await resolveText(id);
            if (typeof text !== 'string') throw new Error(`Missing text for candidate ${id}`);
            return text;
          }),
        ),
        signal,
      );
      throwIfAborted(signal);
      const ranked = await abortable(
        model.rerank(query.text, texts, { ...settings, topK: ids.length }),
        signal,
      );
      if (!Array.isArray(ranked) || ranked.length !== ids.length)
        throw new Error('Raw reranker must return every candidate');
      const mapped = ranked.map((hit) => {
        integer(hit.index, 'rerank index', 0, ids.length - 1);
        return { id: ids[hit.index]!, score: hit.score };
      });
      const checked = checkHits(mapped, new Set(ids), ids.length);
      if (checked.some((hit, i) => i > 0 && hit.score > checked[i - 1]!.score))
        throw new Error('Raw reranker scores must be descending');
      return checked;
    },
  };
}
