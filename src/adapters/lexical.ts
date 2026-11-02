import type {
  Analyzer,
  FieldOptions,
  JsonValue,
  LexicalSearch,
  LexicalSearchOptions,
  SearchOptions,
} from 'defuss-lexicalsearch';
import type { Retriever, RetrievalContext, SearchQuery } from '../types';
import { idsCopy, integer, queryCopy, throwIfAborted } from '../core/validation';

const SURFACE = '~surface';
/** The name of a field's unstemmed companion. */
export const surfaceField = (field: string) => `${field}${SURFACE}`;
const surfaces = new WeakMap<Analyzer, Analyzer>();
/**
 * The analyzer without its stemmer and phonetic key: same tokens, normalization and stopwords, words kept as written.
 * One instance per analyzer, because LexicalSearch rejects two analyzers with one id and different functions.
 * Snapshots name it by id, so `LexicalSearch.fromJSON()` needs it in its analyzer registry.
 */
export function surfaceAnalyzer(analyzer: Analyzer): Analyzer {
  let surface = surfaces.get(analyzer);
  if (!surface) {
    surface = Object.freeze({
      id: `${analyzer.id}${SURFACE}`,
      tokenize: analyzer.tokenize,
      ...(analyzer.normalize ? { normalize: analyzer.normalize } : {}),
      ...(analyzer.stopWords ? { stopWords: [...analyzer.stopWords] } : {}),
      ...(analyzer.kind ? { kind: analyzer.kind } : {}),
      ...(analyzer.segmented ? { segmented: true } : {}),
    });
    surfaces.set(analyzer, surface);
  }
  return surface;
}
/**
 * Adds an unstemmed companion to every field whose analyzer stems, so a query word written exactly as in a document
 * outscores the other words that share its stem. The companion analyzes the same input (`source`, no second copy of
 * the text), carries the field's weight times `weight` and its `b`, and is searched with its field by
 * createLexicalRetriever. Fields without a stemmer get none: their companion would index the same terms and act as a
 * higher weight on the field. Returns `options` itself when no field stems.
 * VERIFIED: bench/surface.mjs (2026-11-02) measured the efficient preset with and without companions: exact words in
 * the defuss-shadcn docs rose from 71% to 98% R@1, the docs' natural-language queries from 37% to 40%, the notes
 * stayed equal and Belebele moved from 91.3% to 91.2%. The companions doubled the docs' indexed tokens.
 */
export function withSurfaceFields(
  options: LexicalSearchOptions = {},
  { weight = 1 }: { weight?: number } = {},
): LexicalSearchOptions {
  if (!Number.isFinite(weight) || weight <= 0) throw new RangeError('weight must be positive');
  const fields: Record<string, FieldOptions> = { ...(options.fields ?? { text: {} }) };
  let added = false;
  for (const [name, field] of Object.entries(fields)) {
    const analyzer = field.analyzer ?? options.analyzer;
    if (!analyzer?.stem || name.endsWith(SURFACE) || fields[surfaceField(name)]) continue;
    fields[surfaceField(name)] = {
      source: field.source ?? name,
      analyzer: surfaceAnalyzer(analyzer),
      weight: (field.weight ?? 1) * weight,
      ...(field.b !== undefined ? { b: field.b } : {}),
    };
    added = true;
  }
  return added ? { ...options, fields } : options;
}

export interface LexicalRetrieverOptions<M extends JsonValue = Record<string, JsonValue>> {
  search?: Omit<SearchOptions<M>, 'limit' | 'offset'>;
  /** Original field equality, preserving punctuation. Case sensitive by default. */
  exact?: { fields: readonly string[]; caseSensitive?: boolean };
}
/** Reuses the complete index: candidate restrictions never change BM25 corpus statistics. */
export function createLexicalRetriever<M extends JsonValue>(
  index: LexicalSearch<M>,
  options: LexicalRetrieverOptions<M> = {},
): Retriever {
  if (typeof index?.search !== 'function') throw new TypeError('A LexicalSearch index is required');
  // Unstemmed companions (withSurfaceFields) follow their field into a field restriction, and stay out of the
  // per-document statistics, which would otherwise count every stemmed term twice.
  const schema = typeof index.stats === 'function' ? Object.keys(index.stats().fields) : [];
  const companion = new Set(
    schema.filter(
      (name) => name.endsWith(SURFACE) && schema.includes(name.slice(0, -SURFACE.length)),
    ),
  );
  const listed = options.search?.fields && [...options.search.fields];
  const base = {
    ...options.search,
    ids: idsCopy(options.search?.ids),
    fields:
      listed &&
      [...listed, ...listed.map(surfaceField).filter((name) => companion.has(name))].filter(
        (name, i, all) => all.indexOf(name) === i,
      ),
    exclude: options.search?.exclude && [...options.search.exclude],
  };
  const statFields = () => (base.fields ?? schema).filter((name) => !companion.has(name));
  const exact = options.exact && { ...options.exact, fields: [...options.exact.fields] };
  if (
    exact &&
    (!exact.fields.length ||
      exact.fields.some((field) => typeof field !== 'string' || !field.length))
  )
    throw new TypeError('Exact fields must be nonempty field names');
  const run = (input: SearchQuery, context: RetrievalContext, literal = false) => {
    throwIfAborted(context.signal);
    integer(context.limit, 'limit');
    const query = queryCopy(input);
    let ids = idsCopy(context.ids);
    if (base.ids)
      ids = ids ? new Set([...ids].filter((id) => base.ids!.has(id))) : new Set(base.ids);
    if (!context.limit || ids?.size === 0) return [];
    // Literal equality bypasses lexical expansion. Forwarding fuzzy/prefix defaults
    // would make this independent evidence lookup invalid in the upstream API.
    const literalOptions = literal
      ? ({
          mode: 'exact',
          fields: exact!.fields,
          caseSensitive: exact!.caseSensitive ?? true,
          prefix: false,
          suffix: false,
          substring: false,
          fuzzy: false,
          phonetic: false,
          transpositions: false,
        } as const)
      : {};
    return index
      .search(query.text, { ...base, ...literalOptions, ids, limit: context.limit, offset: 0 })
      .map((hit) => ({
        id: hit.id,
        score: hit.score,
        ...(hit.tier !== undefined ? { tier: hit.tier } : {}),
      }));
  };
  /**
   * Analyzed terms over the searched fields divided by their documents: the per-field document counts add up,
   * capped at the index size. Exact for one field, for fields every document has (a keyword field next to a text
   * field adds its terms to the same documents) and for disjoint per-language fields. When several searched
   * fields overlap on only some documents, the count is too high and the average too low.
   * VERIFIED: test/route.test.mjs checks a keyword field, a single field and disjoint language fields.
   */
  const averageLength = () => {
    const stats = index.stats();
    const names = statFields();
    let tokens = 0,
      documents = 0;
    for (const name of names) {
      const field = stats.fields[name];
      if (!field) continue;
      tokens += field.tokens;
      documents += field.documents;
    }
    documents = Math.min(documents, stats.documents);
    return documents ? tokens / documents : undefined;
  };
  /**
   * Share of the query's words, weighted by BM25's inverse document frequency in this index, that document `id`
   * matches. A word is a whitespace-delimited atom, the unit the query parser uses; each atom is searched alone with
   * the adapter's own fields and options, so stemming, stopwords and segmentation follow the field analyzers.
   * VERIFIED: in a probe on 2026-11-01, a stopword atom reported expandedTerms 0, so it carries no weight, and a word
   * absent from the index reported a total of 0, so it carries the largest weight and a translated query scores
   * low. Among 100 documents a word found in two weighs 3.7 and a word found in none 5.3.
   * UNKNOWN: whether the rule helps unspaced Japanese, Chinese or Thai queries: each forms one atom, so its share is
   * 0 or 1.
   */
  const matchShare = (input: SearchQuery, id: string) => {
    const query = queryCopy(input);
    const stats = index.stats();
    let documents = 0;
    for (const name of statFields()) documents += stats.fields[name]?.documents ?? 0;
    documents = Math.min(documents, stats.documents);
    const words = new Set(query.text.replace(/["\\]/g, ' ').split(/\s+/).filter(Boolean));
    const options = { ...base, ids: undefined, limit: 1, offset: 0 } as const;
    const target = new Set([id]);
    let total = 0,
      matched = 0;
    for (const word of words) {
      const all = index.searchWithStats(word, options);
      if (!all.stats.expandedTerms) continue;
      const weight = Math.log(1 + (documents - all.total + 0.5) / (all.total + 0.5));
      total += weight;
      if (all.total && index.searchWithStats(word, { ...options, ids: target }).total)
        matched += weight;
    }
    return total > 0 ? matched / total : undefined;
  };
  return {
    retrieve: run,
    rescore: run,
    averageLength,
    matchShare,
    ...(exact
      ? { exact: (query: SearchQuery, context: RetrievalContext) => run(query, context, true) }
      : {}),
  };
}
