/**
 * The three ready-made searches of defuss-search/strategies, measured through their factories on Belebele, the
 * demo notes, the 52-entry API fixture and the defuss-shadcn API docs:
 * - lexical-only (no model);
 * - lexical-semantic-tiny (MoEdernColBERT 1.5M as the only vector model) over a TurboQuant token index, and over an
 *   exact float32 index on the notes and the API fixture (an exact JavaScript scan of Belebele's 181,361 tokens
 *   takes seconds per query; bench/colbert-retrieval.mjs measured it), with a grid of weak-lexical gaps, because
 *   ColBERT's averaged MaxSim spreads differently from a Winzling cosine;
 * - lexical-semantic, without and with the ColBERT reranker (searchPreset('efficient') and 'reranked').
 * Reports R@1, R@5, R@10 and R@25 per corpus, the mean search time per query, model download sizes and index bytes
 * per document; scripts/strategies-report.mjs publishes the website's figures from it to docs/data/strategies.json.
 * Times: a tiny search's first variant includes ColBERT query encoding and the token scan, and later variants reuse
 * the retriever's cached scores; lexical-semantic times use recorded Winzling query vectors and cached ColBERT pair
 * scores, so they exclude model inference.
 * Output: output/bench/strategies.json, with Belebele also per question language (`languages`) for the website's
 * recall by language.
 * VERIFIED: in the run of 2026-11-02 (Bun 1.4.3, Apple silicon, one thread), R@1 / R@5 of lexical-only, tiny (TurboQuant, gap
 * 0.1) and lexical-semantic (efficient) were 90.3/97.3, 90.3/97.0 and 91.3/97.3 on Belebele; 22.0/24.2, 50.5/67.0
 * and 97.8/100 for notes found by their translations; 98/98 for all three on exact API-docs words and 40/70, 40/72
 * and 40/76 for natural-language API-docs queries, over a docs index with unstemmed companions.
 * Over four runs a tiny query took 117 to 240 ms over Belebele's 181,361 tokens and 1.3 to 2.5 s over the API docs'
 * 2,070,075 tokens.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { LexicalSearch, apiSearchPreset } from 'defuss-lexicalsearch';
import { searchPreset } from 'defuss-search';
import { withSurfaceFields } from 'defuss-search/lexical';
import {
  createLexicalOnlySearch,
  createLexicalSemanticSearch,
  createLexicalSemanticTinySearch,
} from 'defuss-search/strategies';
import { createColbertReranker, createWinzlingEmbedder } from 'defuss-vectorsearch/onnx.js';
import { downloadModels, loadModelFile } from '../scripts/models.mjs';
import { createLanguageIndex } from '../website/bench-search.mjs';
import { analyzers } from '../website/languages.mjs';
import { loadApiDocs } from './api-docs.mjs';
import { cachedMatrices, cachedVectors, createCachedColbert, notesCorpus } from './corpora.mjs';
import { loadDataset } from './dataset.mjs';
import { loadEmbeddings } from './embeddings.mjs';

const N = 25;
const GAPS = [0.05, 0.1, 0.15, 0.2];
const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
await downloadModels();
let colbertModel;
let embedderModel;
const colbert = async () =>
  (colbertModel ??= createColbertReranker({
    model: '1.5m',
    precision: 'q8',
    device: 'cpu',
    numThreads: 1,
    loadFile: loadModelFile('colbert'),
    allowRemoteModels: false,
  }));
const embedder = () =>
  (embedderModel ??= createWinzlingEmbedder({
    device: 'cpu',
    numThreads: 1,
    loadFile: loadModelFile('winzling'),
    allowRemoteModels: false,
  }));
const encoder = {
  encodeDocuments: async (texts, options) => (await colbert()).encodeDocuments(texts, options),
  encodeQueries: async (texts, options) => (await colbert()).encodeQueries(texts, options),
};
const cachedColbert = await createCachedColbert(colbert);
/** Winzling embedder whose query vectors come from a lookup first, as the demo's recorded vectors do. */
const recorded = (vectors) => ({
  embedDocuments: (texts) => embedder().embedDocuments(texts),
  embedQuery: (text) => vectors.get(text) ?? embedder().embedQuery(text),
});

const results = {};
/** Belebele per question language: variant → language code → counts, for the website's recall by language. */
const languages = {};
const tokens = {};
const blank = () => ({ queries: 0, r1: 0, r5: 0, r10: 0, r25: 0, ms: 0 });
/** Score one query in every variant of one search; variants are per-query options over the factory defaults. */
async function measure(corpus, search, variants, query, relevant, language) {
  for (const [name, options] of Object.entries(variants)) {
    const started = performance.now();
    const ids = (await search.search(query, { ...options, limit: N })).map((hit) => hit.id);
    const ms = performance.now() - started;
    const rank = ids.findIndex((id) => relevant.has(id)) + 1;
    const rows = [((results[corpus] ??= {})[name] ??= blank())];
    if (language) rows.push(((languages[name] ??= {})[language] ??= blank()));
    for (const row of rows) {
      row.queries++;
      row.ms += ms;
      for (const k of [1, 5, 10, 25]) if (rank >= 1 && rank <= k) row[`r${k}`]++;
    }
  }
}
const tinyVariants = (label) => ({
  [`${label}`]: {},
  [`${label}, weak-lexical off`]: { weakLexical: false },
  ...Object.fromEntries(GAPS.map((gap) => [`${label}, gap ${gap}`, { weakLexical: { share: 0.2, gap } }])),
});
const semanticVariants = {
  'lexical-semantic (efficient)': searchPreset('efficient'),
  'lexical-semantic (reranked)': {},
};
const tokenCount = (matrices) => matrices.reduce((sum, m) => sum + m.tokenCount, 0);

// ---- Belebele: one search per question language, as the benchmark restricts BM25 to that language ------------------
{
  const { documents, queries } = await loadDataset();
  const { vectors, queryVectors } = await loadEmbeddings({ documents, queries }, log);
  const matrices = await cachedMatrices('belebele', documents.map((d) => d.text), colbert);
  tokens.belebele = { documents: documents.length, tokens: tokenCount(matrices) };
  const queryVector = new Map(queries.map((q, i) => [q.text, queryVectors[i]]));
  const index = createLanguageIndex();
  index.addAll(documents.map(({ id, fields }) => ({ id, fields })));
  const docs = documents.map((d) => ({ id: d.id, text: d.text }));
  for (const code of new Set(queries.map((q) => q.language))) {
    const lexical = { search: { fields: [code] } };
    const asked = queries.filter((q) => q.language === code);
    const searches = {
      lexical: createLexicalOnlySearch(index, { lexical }),
      tiny: await createLexicalSemanticTinySearch(index, { documents: docs, colbert: encoder, matrices, lexical }),
      semantic: await createLexicalSemanticSearch(index, {
        documents: docs,
        embedder: recorded(queryVector),
        vectors,
        reranker: cachedColbert,
        lexical,
      }),
    };
    for (const q of asked) {
      const relevant = new Set([q.target]);
      await measure('belebele', searches.lexical, { 'lexical-only': {} }, q.text, relevant, code);
      await measure('belebele', searches.tiny, tinyVariants('tiny, TurboQuant'), q.text, relevant, code);
      await measure('belebele', searches.semantic, semanticVariants, q.text, relevant, code);
    }
    log(`belebele ${code}: ${asked.length} questions`);
  }
}

// ---- the demo notes: translations with the query note left out, then the authored queries ---------------------------
{
  const { notes, units } = notesCorpus();
  const matrices = await cachedMatrices('notes', notes.map((n) => n.text), colbert);
  tokens.notes = { documents: notes.length, tokens: tokenCount(matrices) };
  const vectors = await cachedVectors('confidence-notes', notes.map((n) => n.text), embedder);
  const matrixOf = new Map(notes.map((n, i) => [n.id, matrices[i]]));
  const vectorOf = new Map(notes.map((n, i) => [n.id, vectors[i]]));
  const queryVector = new Map();
  for (const unit of units) queryVector.set(unit.text, await embedder().embedQuery(unit.text));
  const build = async (subset) => {
    const index = createLanguageIndex();
    index.addAll(subset.map((n) => ({ id: n.id, fields: { [n.language]: n.text } })));
    const docs = subset.map((n) => ({ id: n.id, text: n.text }));
    const m = subset.map((n) => matrixOf.get(n.id));
    return {
      lexical: createLexicalOnlySearch(index),
      tiny: await createLexicalSemanticTinySearch(index, { documents: docs, colbert: encoder, matrices: m }),
      exact: await createLexicalSemanticTinySearch(index, {
        documents: docs,
        colbert: encoder,
        matrices: m,
        quantization: 'exact',
      }),
      semantic: await createLexicalSemanticSearch(index, {
        documents: docs,
        embedder: recorded(queryVector),
        vectors: subset.map((n) => vectorOf.get(n.id)),
        reranker: cachedColbert,
      }),
    };
  };
  const full = await build(notes);
  for (const unit of units) {
    const s = unit.leaveOut ? await build(notes.filter((n) => n.id !== unit.leaveOut)) : full;
    const corpus = `notes ${unit.type}`;
    await measure(corpus, s.lexical, { 'lexical-only': {} }, unit.text, unit.relevant);
    await measure(corpus, s.tiny, tinyVariants('tiny, TurboQuant'), unit.text, unit.relevant);
    await measure(corpus, s.exact, tinyVariants('tiny, exact'), unit.text, unit.relevant);
    await measure(corpus, s.semantic, semanticVariants, unit.text, unit.relevant);
  }
  log(`notes: ${units.length} queries`);
}

// ---- the 52-entry API fixture -----------------------------------------------------------------------------------------
{
  const api = JSON.parse(await readFile(new URL('../fixtures/api-embeddings.json', import.meta.url), 'utf8'));
  const docs = api.documents.map((x) => ({ id: x.id, text: `${x.fields.symbol}\n${x.fields.description}` }));
  const matrices = await cachedMatrices('api', docs.map((d) => d.text), colbert);
  tokens['api fixture'] = { documents: docs.length, tokens: tokenCount(matrices) };
  const index = new LexicalSearch(apiSearchPreset);
  index.addAll(api.documents);
  const lexical = { search: { fuzzy: false } };
  const queryVector = new Map(api.queries.map((q) => [q.text, q.vector]));
  const s = {
    lexical: createLexicalOnlySearch(index, { lexical }),
    tiny: await createLexicalSemanticTinySearch(index, { documents: docs, colbert: encoder, matrices, lexical }),
    exact: await createLexicalSemanticTinySearch(index, {
      documents: docs,
      colbert: encoder,
      matrices,
      quantization: 'exact',
      lexical,
    }),
    semantic: await createLexicalSemanticSearch(index, {
      documents: docs,
      embedder: recorded(queryVector),
      vectors: api.vectors,
      reranker: cachedColbert,
      lexical,
    }),
  };
  for (const q of api.queries) {
    const corpus = `api fixture ${q.exact ? 'exact' : 'paraphrase'}`;
    const relevant = new Set(Object.entries(q.relevant).flatMap(([id, gain]) => (gain === 3 ? [id] : [])));
    await measure(corpus, s.lexical, { 'lexical-only': {} }, q.text, relevant);
    await measure(corpus, s.tiny, tinyVariants('tiny, TurboQuant'), q.text, relevant);
    await measure(corpus, s.exact, tinyVariants('tiny, exact'), q.text, relevant);
    await measure(corpus, s.semantic, semanticVariants, q.text, relevant);
  }
}

// ---- the defuss-shadcn API docs: 8,043 sections; the exact token index would hold gigabytes, so TurboQuant only ------
{
  const docsCorpus = await loadApiDocs();
  const docs = docsCorpus.sections.map((s) => ({ id: s.id, text: `${s.title}\n${s.text}` }));
  const matrices = await cachedMatrices('api-docs', docs.map((d) => d.text), colbert, { cache: false });
  tokens['api docs'] = { documents: docs.length, tokens: tokenCount(matrices) };
  log(`api docs: ${tokens['api docs'].tokens} ColBERT tokens`);
  const vectors = await cachedVectors('api-docs-winzling', docs.map((d) => d.text), embedder);
  const en = analyzers.en;
  // Exact component and option names make this corpus the case for unstemmed companions (bench/surface.mjs).
  const index = new LexicalSearch(
    withSurfaceFields({
      fields: { title: { analyzer: en, weight: 3 }, text: { analyzer: en } },
      maxTokenLength: 1024,
    }),
  );
  index.addAll(docsCorpus.sections.map((s) => ({ id: s.id, fields: { title: s.title, text: s.text } })));
  const queryVector = new Map();
  const all = [...docsCorpus.exact, ...docsCorpus.natural];
  for (const q of all) queryVector.set(q.text, await embedder().embedQuery(q.text));
  const s = {
    lexical: createLexicalOnlySearch(index),
    tiny: await createLexicalSemanticTinySearch(index, { documents: docs, colbert: encoder, matrices }),
    semantic: await createLexicalSemanticSearch(index, {
      documents: docs,
      embedder: recorded(queryVector),
      vectors,
      reranker: cachedColbert,
    }),
  };
  matrices.length = 0;
  for (const q of all) {
    const corpus = `api docs ${q.type}`;
    await measure(corpus, s.lexical, { 'lexical-only': {} }, q.text, q.relevant);
    await measure(corpus, s.tiny, tinyVariants('tiny, TurboQuant'), q.text, q.relevant);
    await measure(corpus, s.semantic, semanticVariants, q.text, q.relevant);
  }
  log(`api docs: ${all.length} queries`);
}
await cachedColbert.save();
await colbertModel?.dispose();
await embedderModel?.dispose();

// ---- summary ---------------------------------------------------------------------------------------------------------
const manifest = JSON.parse(await readFile(new URL('../docs/data/manifest.json', import.meta.url), 'utf8'));
/** Counts to shares and mean milliseconds, one level of keys deep. */
const shares = (groups) =>
  Object.fromEntries(
    Object.entries(groups).map(([group, rows]) => [
      group,
      Object.fromEntries(
        Object.entries(rows).map(([name, row]) => [
          name,
          {
            queries: row.queries,
            ...Object.fromEntries([1, 5, 10, 25].map((k) => [`r${k}`, row[`r${k}`] / row.queries])),
            ms: row.ms / row.queries,
          },
        ]),
      ),
    ]),
  );
const table = shares(results);
const report = {
  generatedAt: new Date().toISOString(),
  runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`,
  models: manifest.models ?? null,
  indexBytesPerDocument: Object.fromEntries(
    Object.entries(tokens).map(([corpus, t]) => [
      corpus,
      {
        colbertTokensPerDocument: t.tokens / t.documents,
        colbertTurboQuant: (64 * t.tokens) / t.documents,
        colbertFloat32: (512 * t.tokens) / t.documents,
        winzlingFloat32: 1536,
        winzlingTurboQuant: 192,
      },
    ]),
  ),
  table,
  languages: shares(languages),
};
await mkdir(new URL('../output/bench/', import.meta.url), { recursive: true });
await writeFile(new URL('../output/bench/strategies.json', import.meta.url), JSON.stringify(report, null, 1));
const pct = (x) => (100 * x).toFixed(1);
for (const [corpus, rows] of Object.entries(table)) {
  console.log(corpus);
  for (const [name, row] of Object.entries(rows))
    console.log(`  ${name.padEnd(36)} ${pct(row.r1).padStart(5)} ${pct(row.r5).padStart(5)} ${row.ms.toFixed(1).padStart(7)} ms`);
}
log('Wrote output/bench/strategies.json');
