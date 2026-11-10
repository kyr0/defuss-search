/**
 * The hero's example searches, run for real: each question goes through createLexicalSemanticSearch with
 * Winzling-embed and Winzling-reranker on the CPU, as the demo's notes search does (website/search-worker.mjs), and
 * the first hits of BM25, of the vector source and of the default preset are written to
 * docs/data/hero-examples.json, from which the build renders the figure (scripts/hero-render.mjs).
 * `--check` runs them again and fails when the file differs, so a new model, preset or corpus text cannot leave the
 * figure showing a ranking the library no longer returns.
 * Why recorded runs over a hand-written schematic: the figure claims what the library returns, and only the library
 * with its models can confirm it. Why a file instead of running at build time: `make docs` needs no model download.
 * Corpora: the demo's 100 sample notes, each in its language's field, and the API fixture (fixtures/api-corpus.mjs)
 * with defuss-lexicalsearch's apiSearchPreset, its symbols matched literally (`exact: 'promote'`). The typo example
 * allows BM25 one edit per word (`fuzzy: 1, transpositions: true`); the demo's own notes search does not.
 * Run: bun run hero (writes), bun run test:hero (checks)
 * VERIFIED: on 2026-11-10 `bun run test:hero` matched a fresh run for all four examples in English and German, and a
 * changed rank in the built page made the earlier single-example check fail.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { apiSearchPreset, LexicalSearch } from 'defuss-lexicalsearch';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createLexicalSemanticSearch } from 'defuss-search/strategies';
import { createVectorRetriever } from 'defuss-search/vector';
import { createColbertReranker, createWinzlingEmbedder } from 'defuss-vectorsearch/onnx.js';
import { documents as apiDocuments, documentText } from '../fixtures/api-corpus.mjs';
import { languageCases } from '../fixtures/languages.mjs';
import { createLanguageIndex } from '../website/bench-search.mjs';
import { SAMPLE_NOTES } from '../website/sample-notes.mjs';
import { downloadModels, loadModelFile } from './models.mjs';

const FILE = new URL('../docs/data/hero-examples.json', import.meta.url);
/** In the order the figure shows them; `show` caps each list. */
const EXAMPLES = [
  {
    id: 'translation',
    corpus: 'notes',
    questions: { en: 'When is my dentist appointment?', de: 'Wann ist mein Zahnarzttermin?' },
    show: 4,
  },
  {
    id: 'meaning',
    corpus: 'notes',
    questions: { en: 'Water, there was sand and I was hungry', de: 'Wasser, es war Sand da und ich hatte Hunger' },
    show: 3,
  },
  {
    id: 'symbols',
    corpus: 'api',
    lexical: { exact: { fields: ['symbol'] } },
    search: { exact: 'promote' },
    questions: { en: '??', de: '??' },
    show: 3,
  },
  {
    id: 'typos',
    corpus: 'notes',
    lexical: { search: { fuzzy: 1, transpositions: true } },
    questions: { en: 'piza dugh', de: 'Pizzatieg' },
    show: 3,
  },
];
/** The reasons the figure names; the reranker's own ones only say that it ran. */
const SHOWN_REASONS = new Set(['literal-exact', 'weak-lexical']);
const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);

await downloadModels();
const embedder = createWinzlingEmbedder({ device: 'cpu', numThreads: 1, loadFile: loadModelFile('winzling'), allowRemoteModels: false });
const reranker = createColbertReranker({ model: '1.5m', precision: 'q8', device: 'cpu', numThreads: 1, loadFile: loadModelFile('colbert'), allowRemoteModels: false });

/** Each corpus once: its documents as the figure shows them, its lexical index and its vector source. */
async function loadCorpus(kind) {
  let docs, index;
  if (kind === 'notes') {
    const field = Object.fromEntries(languageCases.map((x) => [x.entry, x.code]));
    docs = SAMPLE_NOTES.map((note, i) => ({ id: `n${i + 1}`, lang: note.lang, text: note.text, field: field[note.lang] }));
    index = createLanguageIndex();
    index.addAll(docs.map((doc) => ({ id: doc.id, fields: { [doc.field]: doc.text } })));
  } else {
    docs = apiDocuments.map((doc) => ({ id: doc.id, symbol: doc.fields.symbol, text: doc.fields.description, embedded: documentText(doc) }));
    index = new LexicalSearch(apiSearchPreset);
    index.addAll(apiDocuments.map(({ id, fields }) => ({ id, fields })));
  }
  const texts = docs.map((doc) => doc.embedded ?? doc.text);
  const vector = createVectorRetriever({ ids: docs.map((doc) => doc.id), vectors: await embedder.embedDocuments(texts) });
  const shown = new Map(docs.map(({ id, lang, symbol, text }) => [id, { id, ...(lang ? { lang } : {}), ...(symbol ? { symbol } : {}), text }]));
  const size = kind === 'notes' ? { documents: docs.length, languages: new Set(docs.map((doc) => doc.lang)).size } : { documents: docs.length };
  return { index, vector, shown, size, documents: docs.map((doc, i) => ({ id: doc.id, text: texts[i] })) };
}

const corpora = {};
const examples = [];
for (const example of EXAMPLES) {
  const corpus = (corpora[example.corpus] ??= await loadCorpus(example.corpus));
  const lexical = createLexicalRetriever(corpus.index, example.lexical ?? {});
  const search = await createLexicalSemanticSearch(corpus.index, {
    documents: corpus.documents,
    vector: corpus.vector,
    reranker,
    lexical: example.lexical ?? {},
  });
  const locales = {};
  for (const [locale, question] of Object.entries(example.questions)) {
    const query = { text: question, vector: await embedder.embedQuery(question) };
    const lexicalHits = await lexical.retrieve({ text: question }, { limit: 25 });
    const vectorHits = await corpus.vector.retrieve(query, { limit: example.show });
    // The demo asks for 25 hits (CANDIDATES in website/search-worker.mjs); the figure shows the first ones.
    const { hits } = await search.searchWithStats(query, { limit: 25, ...example.search });
    locales[locale] = {
      question,
      lexicalTotal: lexicalHits.length,
      lexical: lexicalHits.slice(0, example.show).map((hit) => ({ doc: corpus.shown.get(hit.id) })),
      vector: vectorHits.map((hit) => ({ doc: corpus.shown.get(hit.id) })),
      fused: hits.slice(0, example.show).map((hit) => ({
        doc: corpus.shown.get(hit.id),
        ...Object.fromEntries(['lexical', 'vector'].filter((s) => hit.contributions?.[s]).map((s) => [s, hit.contributions[s].rank])),
        reasons: (hit.reasons ?? []).filter((reason) => SHOWN_REASONS.has(reason)),
      })),
    };
    log(`Ran hero example id=${example.id} locale=${locale} fused=${hits.slice(0, example.show).map((hit) => hit.id).join(',')}`);
  }
  examples.push({ id: example.id, corpus: { kind: example.corpus, ...corpus.size }, lexicalMode: example.lexical?.exact ? 'exact' : example.lexical?.search?.fuzzy ? 'fuzzy' : 'bm25', locales });
}

const report = { schema: 'defuss-search-hero-examples.v1', examples };
if (process.argv.includes('--check')) {
  assert.deepEqual(JSON.parse(await readFile(FILE, 'utf8')), report, 'docs/data/hero-examples.json differs from a fresh run; run bun run hero');
  log('Hero examples match a fresh run');
} else {
  await writeFile(FILE, `${JSON.stringify(report, null, 2)}\n`);
  log(`Wrote ${FILE.pathname}`);
}
