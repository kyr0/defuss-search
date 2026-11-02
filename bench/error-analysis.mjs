/**
 * Where does the default preset (searchPreset('efficient'), weak-lexical rule included) miss at rank 1, and why?
 * Every miss on Belebele, the demo notes and the defuss-shadcn API docs is classified by where the gold document
 * stood in each source and what took its place:
 * - not retrieved: the gold document is in neither source's top 25;
 * - vector only: only the vector source retrieved it, and BM25's hits outranked it;
 * - lexical only: only BM25 retrieved it;
 * - both, outranked: both sources retrieved it, below the winner;
 * plus corpus-specific causes: a stemming collision (the winner holds another form of an exact query word), a
 * section of the gold page (API docs), or a translation of the gold passage (Belebele).
 * Output: output/bench/error-analysis.json with counts and every miss.
 * VERIFIED: in the run of 2026-11-01, BM25 supplied the rank-1 winner in 77 of 87 Belebele misses, 62 of 63 natural-language
 * and 29 of 29 exact-word API-docs misses. Every exact-word miss is a stemming collision; 30 natural-language misses
 * lost to another section of the gold page; 2 of the 5 notes misses are vector-only gold documents that Winzling
 * itself ranked below its own first hit.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { LexicalSearch } from 'defuss-lexicalsearch';
import { HybridSearch, searchPreset } from 'defuss-search';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
import { createWinzlingEmbedder } from 'defuss-vectorsearch/onnx.js';
import { downloadModels, loadModelFile } from '../scripts/models.mjs';
import { createBenchSearch, createLanguageIndex } from '../website/bench-search.mjs';
import { analyzers } from '../website/languages.mjs';
import { loadApiDocs } from './api-docs.mjs';
import { cachedVectors, notesCorpus } from './corpora.mjs';
import { loadDataset } from './dataset.mjs';
import { loadEmbeddings } from './embeddings.mjs';

const N = 25;
const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
await downloadModels();
let model;
const embedder = () =>
  (model ??= createWinzlingEmbedder({
    device: 'cpu',
    numThreads: 1,
    loadFile: loadModelFile('winzling'),
    allowRemoteModels: false,
  }));
const misses = [];
const counted = {};

/** One query through the default preset; a miss is recorded with both source ranks and the winner. */
async function check({ corpus, text, vector, relevant, search, lexical, vectorRetriever, textOf, extra }) {
  counted[corpus] = (counted[corpus] ?? 0) + 1;
  const query = { text, vector };
  const response = await search.searchWithStats(query, { ...searchPreset('efficient'), limit: N });
  const ids = response.hits.map((hit) => hit.id);
  if (relevant.has(ids[0])) return;
  const lexIds = (await lexical.retrieve({ text }, { limit: N })).map((hit) => hit.id);
  const vecIds = (await vectorRetriever.retrieve(query, { limit: N })).map((hit) => hit.id);
  const rankOf = (list) => list.findIndex((id) => relevant.has(id)) + 1;
  const lex = rankOf(lexIds),
    vec = rankOf(vecIds);
  const cause = !lex && !vec ? 'not retrieved' : !lex ? 'vector only' : !vec ? 'lexical only' : 'both, outranked';
  misses.push({
    corpus,
    text,
    cause,
    rank: rankOf(ids),
    lexicalRank: lex,
    vectorRank: vec,
    winner: ids[0],
    winnerText: textOf(ids[0])?.slice(0, 160),
    winnerLexicalRank: lexIds.indexOf(ids[0]) + 1,
    winnerVectorRank: vecIds.indexOf(ids[0]) + 1,
    weakLexical: response.weakLexical.action,
    ...extra?.(ids[0]),
  });
}

// ---- Belebele ---------------------------------------------------------------------------------------------------------
const { documents, queries } = await loadDataset();
const { vectors, queryVectors } = await loadEmbeddings({ documents, queries }, log);
const passageText = new Map(documents.map((d) => [d.id, d.text]));
const bench = createBenchSearch({ documents, vectors });
for (let i = 0; i < queries.length; i++) {
  const q = queries[i];
  await check({
    corpus: 'belebele',
    text: q.text,
    vector: queryVectors[i],
    relevant: new Set([q.target]),
    search: bench.hybrid.get(q.language),
    lexical: bench.lexical.get(q.language),
    vectorRetriever: bench.vector,
    textOf: (id) => passageText.get(id),
    extra: (winner) => ({
      language: q.language,
      // Same passage group, other language: the vector source found the right text in the wrong language.
      translation: winner?.split(':')[0] === q.target.split(':')[0],
    }),
  });
}
log(`belebele: ${misses.filter((m) => m.corpus === 'belebele').length} misses`);

// ---- the demo notes ---------------------------------------------------------------------------------------------------
const { notes, text: noteText, units } = notesCorpus();
const noteVectors = new Map(
  (await cachedVectors('confidence-notes', notes.map((n) => n.text), embedder)).map((v, i) => [
    notes[i].id,
    v,
  ]),
);
for (const unit of units) {
  const subset = unit.leaveOut ? notes.filter((n) => n.id !== unit.leaveOut) : notes;
  const index = createLanguageIndex();
  index.addAll(subset.map((n) => ({ id: n.id, fields: { [n.language]: n.text } })));
  const lexical = createLexicalRetriever(index);
  const vectorRetriever = createVectorRetriever({
    ids: subset.map((n) => n.id),
    vectors: subset.map((n) => noteVectors.get(n.id)),
  });
  await check({
    corpus: `notes ${unit.type}`,
    text: unit.text,
    vector: await embedder().embedQuery(unit.text),
    relevant: unit.relevant,
    search: new HybridSearch({ lexical, vector: vectorRetriever }),
    lexical,
    vectorRetriever,
    textOf: (id) => noteText.get(id),
  });
}
log(`notes: ${misses.filter((m) => m.corpus.startsWith('notes')).length} misses`);

// ---- the API docs -----------------------------------------------------------------------------------------------------
const docs = await loadApiDocs();
const sectionText = (s) => `${s.title}\n${s.text}`;
const docVectors = await cachedVectors('api-docs-winzling', docs.sections.map(sectionText), embedder);
const byId = new Map(docs.sections.map((s) => [s.id, s]));
const en = analyzers.en;
const docIndex = new LexicalSearch({
  fields: { title: { analyzer: en, weight: 3 }, text: { analyzer: en } },
  maxTokenLength: 1024,
});
docIndex.addAll(docs.sections.map((s) => ({ id: s.id, fields: { title: s.title, text: s.text } })));
const docLexical = createLexicalRetriever(docIndex);
const docVector = createVectorRetriever({ ids: docs.sections.map((s) => s.id), vectors: docVectors });
const docSearch = new HybridSearch({ lexical: docLexical, vector: docVector });
const stem = (word) => en.stem((en.normalize ?? ((w) => w.toLowerCase()))(word));
for (const query of [...docs.exact, ...docs.natural]) {
  const goldPage = query.page ?? byId.get([...query.relevant][0]).page;
  await check({
    corpus: `api docs ${query.type}`,
    text: query.text,
    vector: await embedder().embedQuery(query.text),
    relevant: query.relevant,
    search: docSearch,
    lexical: docLexical,
    vectorRetriever: docVector,
    textOf: (id) => byId.get(id) && sectionText(byId.get(id)),
    extra: (winner) => {
      const section = byId.get(winner);
      const words = new Set((sectionText(section).match(/\p{L}[\p{L}\p{N}]*/gu) ?? []).map((w) => w.toLowerCase()));
      return {
        samePage: section.page === goldPage,
        // The winner lacks the exact query word but holds another word with the same stem.
        stemCollision:
          query.type === 'exact' &&
          !words.has(query.text) &&
          [...words].some((w) => stem(w) === stem(query.text)),
      };
    },
  });
}
log(`api docs: ${misses.filter((m) => m.corpus.startsWith('api docs')).length} misses`);
await model?.dispose();

// ---- summary ----------------------------------------------------------------------------------------------------------
const summary = Object.entries(counted).map(([corpus, queriesRun]) => {
  const rows = misses.filter((m) => m.corpus === corpus);
  const by = (key) => rows.filter((m) => m[key]).length;
  return {
    corpus,
    queries: queriesRun,
    misses: rows.length,
    causes: Object.fromEntries(
      ['not retrieved', 'vector only', 'lexical only', 'both, outranked'].map((c) => [
        c,
        rows.filter((m) => m.cause === c).length,
      ]),
    ),
    goldInTop5: rows.filter((m) => m.rank > 0 && m.rank <= 5).length,
    winnerFromBm25: rows.filter((m) => m.winnerLexicalRank === 1).length,
    translation: by('translation'),
    samePage: by('samePage'),
    stemCollision: by('stemCollision'),
    weakLexicalPromoted: rows.filter((m) => m.weakLexical === 'promoted').length,
  };
});
await mkdir(new URL('../output/bench/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../output/bench/error-analysis.json', import.meta.url),
  JSON.stringify({ generatedAt: new Date().toISOString(), summary, misses }, null, 1),
);
for (const s of summary) console.log(JSON.stringify(s));
log('Wrote output/bench/error-analysis.json');
