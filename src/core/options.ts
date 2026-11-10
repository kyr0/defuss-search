import type { FusionOptions, HybridSearchOptions, LanguageFusion } from '../types';
import { integer, weight } from './validation';

const primary = (tag: string) => tag.split('-')[0]!.toLowerCase();
/** Copy one group, or return the value unchanged for languageGroups() to reject. */
const copyGroup = (group: LanguageFusion) =>
  group && typeof group === 'object'
    ? {
        ...group,
        languages: Array.isArray(group.languages) ? [...group.languages] : group.languages,
        weights: group.weights && { ...group.weights },
      }
    : group;

/** Copy nested configuration so later caller mutations cannot change an in-flight query. */
export function copyOptions(value: HybridSearchOptions): HybridSearchOptions {
  return {
    ...value,
    fusion: value.fusion && {
      ...value.fusion,
      weights: { ...value.fusion.weights },
      ...(Array.isArray(value.fusion.byLanguage)
        ? { byLanguage: value.fusion.byLanguage.map(copyGroup) }
        : {}),
    },
    balance: value.balance && { ...value.balance },
    rerank: value.rerank && { ...value.rerank },
    weakLexical: value.weakLexical && { ...value.weakLexical },
  };
}
/**
 * Validate `byLanguage` against the base settings it overrides; returns the groups with lower-case languages.
 * VERIFIED: test/engine.test.mjs covers primary-subtag matching, precedence, `[]` and rejection at creation and per call.
 */
function languageGroups(groups: unknown, base: Required<Omit<FusionOptions, 'byLanguage'>>) {
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new TypeError('fusion.byLanguage must be an array');
  return groups.map((group: LanguageFusion) => {
    if (!group || typeof group !== 'object') throw new TypeError('fusion.byLanguage holds objects');
    const { languages } = group;
    if (!Array.isArray(languages) || !languages.length)
      throw new TypeError('A fusion.byLanguage group needs languages');
    for (const tag of languages)
      if (typeof tag !== 'string' || !tag) throw new TypeError('Group languages are nonempty tags');
    if (group.k !== undefined) integer(group.k, 'byLanguage k', 0, 1e9);
    const weights = { ...base.weights, ...group.weights };
    weight(weights.lexical, 'byLanguage lexical weight');
    weight(weights.vector, 'byLanguage vector weight');
    if (!(weights.lexical! + weights.vector!))
      throw new RangeError('At least one byLanguage source weight must be positive');
    return { languages: languages.map(primary), k: group.k ?? base.k, weights };
  });
}

export function optionsFor(
  defaults: HybridSearchOptions,
  supplied: HybridSearchOptions,
  hasReranker: boolean,
  language?: string,
) {
  const combined = { ...defaults, ...supplied };
  if (
    combined.rerank !== undefined &&
    combined.rerank !== false &&
    (!combined.rerank || typeof combined.rerank !== 'object' || Array.isArray(combined.rerank))
  )
    throw new TypeError('rerank must be false or an options object');
  const { byLanguage: defaultGroups, ...defaultFusion } = defaults.fusion ?? {};
  const { byLanguage: ownGroups, ...ownFusion } = supplied.fusion ?? {};
  const base = {
    method: 'rrf' as const,
    k: 60,
    ...defaultFusion,
    ...ownFusion,
    weights: { lexical: 1, vector: 1, ...defaultFusion.weights, ...ownFusion.weights },
  };
  // A search that sets its own k or weights means them for every language, unless it names groups too.
  const groups = languageGroups(
    ownGroups ??
      (ownFusion.k === undefined && ownFusion.weights === undefined ? defaultGroups : undefined),
    base,
  );
  const group =
    language === undefined
      ? undefined
      : groups.find((g) => g.languages.includes(primary(language)));
  const fusion = group ? { ...base, k: group.k, weights: group.weights } : base;
  const rerank =
    combined.rerank === false || (!hasReranker && combined.rerank === undefined)
      ? (false as const)
      : {
          candidates: 25,
          method: 'rrf' as const,
          k: 60,
          weight: 1,
          ...defaults.rerank,
          ...supplied.rerank,
        };
  const o = {
    strategy: 'fusion' as const,
    lexicalCandidates: 25,
    vectorCandidates: 25,
    cascade: 'replace' as const,
    unmatched: 'keep' as const,
    exact: 'none' as const,
    exactCandidates: 25,
    limit: 10,
    offset: 0,
    ...combined,
    fusion,
    rerank,
  };
  for (const key of ['lexicalCandidates', 'vectorCandidates', 'exactCandidates'] as const)
    integer(o[key], key, 1);
  integer(o.limit, 'limit');
  integer(o.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  if (!['fusion', 'lexical-first', 'vector-first'].includes(o.strategy))
    throw new TypeError('Unknown strategy');
  if (!['replace', 'fuse'].includes(o.cascade)) throw new TypeError('Unknown cascade policy');
  if (!['keep', 'drop'].includes(o.unmatched)) throw new TypeError('Unknown unmatched policy');
  if (!['none', 'promote'].includes(o.exact)) throw new TypeError('Unknown exact policy');
  if (!['rrf', 'linear'].includes(fusion.method)) throw new TypeError('Unknown fusion method');
  integer(fusion.k, 'RRF k', 0, 1e9);
  weight(fusion.weights.lexical, 'lexical weight');
  weight(fusion.weights.vector, 'vector weight');
  if (!(fusion.weights.lexical + fusion.weights.vector))
    throw new RangeError('At least one source weight must be positive');
  if (
    o.vectorOnlyBelow !== undefined &&
    (typeof o.vectorOnlyBelow !== 'number' ||
      Number.isNaN(o.vectorOnlyBelow) ||
      o.vectorOnlyBelow < 0)
  )
    throw new RangeError('vectorOnlyBelow must be a nonnegative number');
  if (o.weakLexical !== undefined && o.weakLexical !== false) {
    const w = o.weakLexical;
    if (!w || typeof w !== 'object' || Array.isArray(w))
      throw new TypeError('weakLexical must be false or { share, gap }');
    if (typeof w.share !== 'number' || !(w.share >= 0 && w.share <= 1))
      throw new RangeError('weakLexical.share must be a number in [0, 1]');
    if (typeof w.gap !== 'number' || !Number.isFinite(w.gap) || w.gap < 0)
      throw new RangeError('weakLexical.gap must be a finite nonnegative number');
    o.weakLexical = { share: w.share, gap: w.gap };
  }
  if (o.balance) {
    o.balance = { ...o.balance };
    integer(o.balance.window, 'balance.window', 1, 30000);
    integer(o.balance.lexical, 'balance.lexical', 0, o.balance.window);
    integer(o.balance.vector, 'balance.vector', 0, o.balance.window);
  }
  if (rerank) {
    if (!hasReranker) throw new Error('A reranker must be configured');
    integer(rerank.candidates, 'rerank.candidates', 1);
    integer(rerank.k, 'rerank.k', 0, 1e9);
    weight(rerank.weight, 'rerank.weight');
    if (
      rerank.skipIfVectorMargin !== undefined &&
      (typeof rerank.skipIfVectorMargin !== 'number' ||
        Number.isNaN(rerank.skipIfVectorMargin) ||
        rerank.skipIfVectorMargin < 0)
    )
      throw new RangeError('rerank.skipIfVectorMargin must be a nonnegative number');
    if (!['rrf', 'replace'].includes(rerank.method)) throw new TypeError('Unknown rerank method');
  }
  return o;
}

export type ResolvedOptions = ReturnType<typeof optionsFor>;
