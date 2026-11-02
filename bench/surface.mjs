/**
 * Unstemmed companion fields (withSurfaceFields) against stemmed fields alone, under BM25 alone and the efficient
 * preset with recorded Winzling vectors, on Belebele (one field per language, BM25 restricted to the question's
 * language), the demo notes (every field searched) and the defuss-shadcn API docs (title weight 3 plus text, English).
 * Companion weights 1 and 0.5 times the field weight. Also counts the indexed tokens, which the companions add to,
 * and the build time of each index.
 * Why: bench/error-analysis.mjs traced all 29 exact-word misses in the API docs to stemming collisions, where the
 * stemmer maps another word onto the query's stem and that word's section wins.
 * Output: output/bench/surface.json.
 * VERIFIED: in the run of 2026-11-02 (Bun 1.4.3), the efficient preset reached R@1 / R@5 of 71/84 stemmed and 98/98
 * with companions of weight 1 on exact docs words, 37/76 and 40/76 on natural-language docs queries, 91.3/97.3 and
 * 91.2/97.1 on Belebele; the notes were equal. Weight 0.5 reached 94/98 on the exact words. The companions took the
 * docs from 1,095,878 to 2,191,756 indexed tokens and Belebele from 128,736 to 192,231.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { LexicalSearch } from 'defuss-lexicalsearch';
import { HybridSearch, searchPreset } from 'defuss-search';
import { createLexicalRetriever, withSurfaceFields } from 'defuss-search/lexical';
import { createLexicalOnlySearch } from 'defuss-search/strategies';
import { createVectorRetriever } from 'defuss-search/vector';
import { createWinzlingEmbedder } from 'defuss-vectorsearch/onnx.js';
import { languageCases } from '../fixtures/languages.mjs';
import { downloadModels, loadModelFile } from '../scripts/models.mjs';
import { languageIndexOptions } from '../website/bench-search.mjs';
import { analyzers } from '../website/languages.mjs';
import { loadApiDocs } from './api-docs.mjs';
import { cachedVectors, notesCorpus } from './corpora.mjs';
import { loadDataset } from './dataset.mjs';
import { loadEmbeddings } from './embeddings.mjs';

const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
const VARIANTS = { stemmed: undefined, 'surface 1': 1, 'surface 0.5': 0.5 };
const SEARCHES = ['lexical-only', 'efficient'];
await downloadModels();
let model;
const embedder = () =>
  (model ??= createWinzlingEmbedder({
    device: 'cpu',
    numThreads: 1,
    loadFile: loadModelFile('winzling'),
    allowRemoteModels: false,
  }));
const options = (base, weight) => (weight ? withSurfaceFields(base, { weight }) : base);
const results = {};
const index = {};
/** Builds one index and records its token count and build time once per corpus and variant. */
function build(corpus, variant, base, documents) {
  const started = performance.now();
  const built = new LexicalSearch(options(base, VARIANTS[variant]));
  built.addAll(documents);
  const ms = performance.now() - started;
  const stats = built.stats();
  index[corpus] ??= {};
  index[corpus][variant] ??= {
    documents: stats.documents,
    terms: stats.terms,
    tokens: Object.values(stats.fields).reduce((sum, field) => sum + field.tokens, 0),
    buildMs: Math.round(ms),
  };
  return built;
}
/** BM25 alone (the lexical-only factory) and the efficient preset over the same lexical retriever options. */
const searches = (built, vector, lexical = {}) => ({
  'lexical-only': createLexicalOnlySearch(built, { lexical }),
  efficient: new HybridSearch({ lexical: createLexicalRetriever(built, lexical), vector }),
});
async function score(corpus, variant, pair, query, relevant) {
  for (const name of SEARCHES) {
    const options = name === 'efficient' ? searchPreset('efficient') : {};
    const ids = (await pair[name].search(query, { ...options, limit: 5 })).map((hit) => hit.id);
    const rank = ids.findIndex((id) => relevant.has(id)) + 1;
    const row = (((results[corpus] ??= {})[variant] ??= {})[name] ??= { queries: 0, r1: 0, r5: 0 });
    row.queries++;
    if (rank === 1) row.r1++;
    if (rank >= 1) row.r5++;
  }
}

// ---- Belebele: one field per language, BM25 restricted to the question's language ----------------------------------
{
  const { documents, queries } = await loadDataset();
  const { vectors, queryVectors } = await loadEmbeddings({ documents, queries }, log);
  const vector = createVectorRetriever({ ids: documents.map((d) => d.id), vectors });
  for (const variant of Object.keys(VARIANTS)) {
    const built = build(
      'belebele',
      variant,
      languageIndexOptions,
      documents.map(({ id, fields }) => ({ id, fields })),
    );
    // The restriction names the language field only; the retriever adds its companion.
    const perLanguage = new Map(
      languageCases.map((x) => [x.code, searches(built, vector, { search: { fields: [x.code] } })]),
    );
    for (const [i, q] of queries.entries()) {
      const search = perLanguage.get(q.language);
      const query = { text: q.text, vector: queryVectors[i] };
      const relevant = new Set([q.target]);
      await score('belebele', variant, search, query, relevant);
      await score(`belebele ${q.language}`, variant, search, query, relevant);
    }
    log(`belebele ${variant}: ${queries.length} questions`);
  }
}

// ---- the demo notes: every field searched; translations leave their own note out -------------------------------------
{
  const { notes, units } = notesCorpus();
  const vectors = await cachedVectors(
    'confidence-notes',
    notes.map((n) => n.text),
    embedder,
  );
  const vectorOf = new Map(notes.map((n, i) => [n.id, vectors[i]]));
  const queryVector = new Map();
  for (const unit of units) queryVector.set(unit.text, await embedder().embedQuery(unit.text));
  for (const variant of Object.keys(VARIANTS)) {
    const make = (subset) =>
      searches(
        build(
          'notes',
          variant,
          languageIndexOptions,
          subset.map((n) => ({ id: n.id, fields: { [n.language]: n.text } })),
        ),
        createVectorRetriever({
          ids: subset.map((n) => n.id),
          vectors: subset.map((n) => vectorOf.get(n.id)),
        }),
      );
    const full = make(notes);
    for (const unit of units) {
      const search = unit.leaveOut ? make(notes.filter((n) => n.id !== unit.leaveOut)) : full;
      const query = { text: unit.text, vector: queryVector.get(unit.text) };
      await score(`notes ${unit.type}`, variant, search, query, unit.relevant);
    }
  }
  log(`notes: ${units.length} queries`);
}

// ---- the defuss-shadcn API docs: 8,043 sections, English title (weight 3) and text ----------------------------------
{
  const docs = await loadApiDocs();
  const vectors = await cachedVectors(
    'api-docs-winzling',
    docs.sections.map((s) => `${s.title}\n${s.text}`),
    embedder,
  );
  const vector = createVectorRetriever({ ids: docs.sections.map((s) => s.id), vectors });
  const queries = [...docs.exact, ...docs.natural];
  const queryVector = new Map();
  for (const q of queries) queryVector.set(q.text, await embedder().embedQuery(q.text));
  const base = {
    fields: { title: { analyzer: analyzers.en, weight: 3 }, text: { analyzer: analyzers.en } },
    maxTokenLength: 1024,
  };
  const documents = docs.sections.map((s) => ({
    id: s.id,
    fields: { title: s.title, text: s.text },
  }));
  for (const variant of Object.keys(VARIANTS)) {
    const search = searches(build('api docs', variant, base, documents), vector);
    for (const q of queries)
      await score(
        `api docs ${q.type}`,
        variant,
        search,
        { text: q.text, vector: queryVector.get(q.text) },
        q.relevant,
      );
  }
  log(`api docs: ${queries.length} queries`);
}
await model?.dispose();

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const percent = (row) => ({
  queries: row.queries,
  r1: row.r1 / row.queries,
  r5: row.r5 / row.queries,
});
const report = {
  version: pkg.version,
  completedAt: new Date().toISOString(),
  runtime: `Bun ${Bun.version}`,
  variants: VARIANTS,
  results: Object.fromEntries(
    Object.entries(results).map(([corpus, variants]) => [
      corpus,
      Object.fromEntries(
        Object.entries(variants).map(([variant, searches]) => [
          variant,
          Object.fromEntries(Object.entries(searches).map(([name, row]) => [name, percent(row)])),
        ]),
      ),
    ]),
  ),
  index,
};
await mkdir('output/bench', { recursive: true });
await writeFile('output/bench/surface.json', JSON.stringify(report, null, 2) + '\n');
const pct = (x) => (100 * x).toFixed(1).padStart(5);
const names = Object.keys(VARIANTS);
for (const search of SEARCHES) {
  console.log(`\n${search}: R@1 / R@5`);
  console.log('corpus'.padEnd(34) + names.map((n) => n.padStart(16)).join(''));
  for (const [corpus, variants] of Object.entries(report.results)) {
    const cells = names.map((n) => variants[n][search]);
    if (
      corpus.startsWith('belebele ') &&
      cells.every((c) => c.r1 === cells[0].r1 && c.r5 === cells[0].r5)
    )
      continue;
    console.log(
      corpus.padEnd(34) + cells.map((c) => `${pct(c.r1)} / ${pct(c.r5)}`.padStart(16)).join(''),
    );
  }
}
console.log('\nindexed tokens / build ms');
for (const [corpus, variants] of Object.entries(index))
  console.log(
    corpus.padEnd(34) +
      names.map((n) => `${variants[n].tokens} / ${variants[n].buildMs}`.padStart(22)).join(''),
  );
log('Wrote output/bench/surface.json');
