/**
 * Lexical coverage and the semantic-first ordering, shared by bench/semantic-first.mjs and bench/bm25-switch.mjs.
 * Coverage is the share of a query's analyzed terms (stopwords removed) that a document contains, exactly or, for
 * terms of at least five code points, within one edit. Unlike BM25 it needs no corpus statistics, so it means the
 * same in an index of five notes and of 2,000 passages.
 * VERIFIED: the term count comes from the library's own analysis (the term count of a one-document index), so
 * stopwords and stemming apply to the query as to the documents.
 * UNKNOWN: whether segmented languages (Thai, Chinese, Japanese) split a query and a document into the same words;
 * coverage is capped at 1 for that reason.
 */
import { LexicalSearch } from 'defuss-lexicalsearch';
import { languageCases } from '../fixtures/languages.mjs';
import { analyzers } from '../website/languages.mjs';

const entryOf = Object.fromEntries(languageCases.map((x) => [x.code, x.entry]));

/** Distinct analyzed terms of `text` in one language field, counted by the library's own analysis pipeline. */
const terms = new Map();
export function termCount(field, text) {
  const key = `${field}\u0000${text}`;
  if (!terms.has(key)) {
    const probe = new LexicalSearch({
      fields: { [field]: { analyzer: analyzers[entryOf[field]] } },
      maxTokenLength: 1024,
    });
    probe.add({ id: 'q', fields: { [field]: text } });
    terms.set(key, probe.stats().terms);
  }
  return terms.get(key);
}

const counts = (match, typos) =>
  match.kind === 'exact' ||
  match.kind === 'literal' ||
  (typos && match.kind === 'fuzzy' && match.distance <= 1 && [...match.query].length >= 5);

/** Lexical hits with their coverage, in BM25 order; a passage's coverage uses its own field's analyzer. */
export function coverages(index, text, { fields, ids, limit, typos }) {
  const hits = index.search(text, {
    fields,
    ids,
    limit,
    explain: true,
    ...(typos ? { fuzzy: 1, transpositions: true } : {}),
  });
  return hits.map((hit) => {
    const byField = new Map();
    for (const match of hit.matches ?? [])
      if (counts(match, typos))
        (byField.get(match.field) ?? byField.set(match.field, new Set()).get(match.field)).add(
          match.query,
        );
    let coverage = 0;
    for (const [field, matched] of byField)
      coverage = Math.max(coverage, matched.size / Math.max(1, termCount(field, text)));
    return { id: hit.id, coverage: Math.min(1, coverage) };
  });
}

/** Pure ranking step: promoted candidates by coverage, then the remaining candidates in their given order. */
export function semanticFirst({ order, coverage, outside, minIn, minOut }) {
  const position = new Map(order.map((id, i) => [id, i]));
  const promoted = [
    ...order
      .filter((id) => (coverage.get(id) ?? 0) >= minIn)
      .map((id) => ({ id, share: coverage.get(id), outside: 0, tie: position.get(id) })),
    ...outside
      .filter((hit) => !position.has(hit.id) && hit.coverage >= minOut)
      .map((hit, i) => ({ id: hit.id, share: hit.coverage, outside: 1, tie: i })),
  ].sort((a, b) => b.share - a.share || a.outside - b.outside || a.tie - b.tie);
  const chosen = new Set(promoted.map((hit) => hit.id));
  return [...promoted.map((hit) => hit.id), ...order.filter((id) => !chosen.has(id))];
}
