/**
 * The benchmark's search setup, used by the recall benchmark (bench/recall-core.mjs). The website demo builds its
 * searches with the defuss-search/strategies factories on the same index layout and field restriction, so it ranks
 * each benchmark question the way the published figures do. One LexicalSearch holds every passage with one analyzer
 * field per language, and a question searches its own language's field; vector retrieval scans all passages.
 * VERIFIED: the e2e test recomputes the efficient preset's R@k for all 1,000 questions in the browser and compares
 * it with docs/data/recall.json.
 */
import { LexicalSearch } from 'defuss-lexicalsearch';
import { HybridSearch } from 'defuss-search';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
import { languageCases } from '../fixtures/languages.mjs';
import { analyzers } from './languages.mjs';

/**
 * One field per benchmark language, each with its language's analyzer and stopwords. The benchmark searches the
 * question's field; the demo's notes search every field, and each field analyzes the query with its own analyzer.
 * Why per-language fields for a handful of notes: BM25 learns that "mit" or "the" is common only from many
 * documents, so a small index needs the stopword lists. VERIFIED: in a 2026-11-01 probe over the 100 sample notes,
 * "mit" matched none of them, and "the zoo" matched the German and the English zoo note by "zoo".
 */
export const languageIndexOptions = Object.freeze({
  fields: Object.fromEntries(languageCases.map((x) => [x.code, { analyzer: analyzers[x.entry] }])),
  // The frontier benchmark indexes with the same token limit, so both reports agree.
  maxTokenLength: 1024,
});
export const createLanguageIndex = () => new LexicalSearch(languageIndexOptions);

/** documents: [{ id, fields: { [code]: text } }]; vectors: one row per document, in the same order. */
export function createBenchSearch({ documents, vectors, reranker }) {
  const index = createLanguageIndex();
  index.addAll(documents.map(({ id, fields }) => ({ id, fields })));
  const vector = createVectorRetriever({ ids: documents.map((x) => x.id), vectors });
  const lexical = new Map(
    languageCases.map((x) => [
      x.code,
      createLexicalRetriever(index, { search: { fields: [x.code] } }),
    ]),
  );
  const hybrid = new Map(
    [...lexical].map(([code, retriever]) => [
      code,
      new HybridSearch({ lexical: retriever, vector, reranker }),
    ]),
  );
  // For a question whose language is unknown or only guessed: BM25 over every language field.
  // VERIFIED: bench/language-guess.mjs measures both presets with it (docs/languages.md).
  const all = new HybridSearch({ lexical: createLexicalRetriever(index), vector, reranker });
  return { index, vector, lexical, hybrid, all };
}
