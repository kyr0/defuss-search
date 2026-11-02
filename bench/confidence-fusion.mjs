/**
 * Can a per-query lexical confidence decide how much BM25 counts? Rank fusion gives BM25's first hit 3/(1+1) = 1.5
 * points whether it matched one common word or the whole query, and the vector source's first hit at most 0.5, so
 * a weak lexical match always wins. This experiment weighs BM25 by evidence the query itself carries:
 * - c, the lexical confidence: the share of the query's information that BM25's first hit matches, each analyzed
 *   query term weighted by its IDF in a background corpus of the same language (the Belebele passages of that
 *   language; for a Belebele question, the passages of the other half of the passage groups). A word that is
 *   frequent in the language ("mehr", "mit") weighs little even when a small index holds it only twice.
 * - g, the semantic agreement: cosine(query, BM25's first hit) minus cosine(query, the vector source's first hit).
 * Variants: BM25's fusion weight scaled by c, and gates that drop BM25 below a c or g threshold. Baselines: lexical,
 * vector, the efficient and reranked presets, and an in-script replica of efficient fusion as a parity check.
 * Corpora: Belebele (2,000 passages; also cut to 6 and 16 words), the demo notes, the 52-entry API fixture and the
 * defuss-shadcn API docs (8,043 sections, 100 exact and 100 natural-language queries, bench/api-docs.mjs). The API
 * docs weigh as much as Belebele in the combined score, because real searches include documentation with code.
 * VERIFIED: in the 2026-11-01 run (output/bench/confidence-fusion.json), dropping BM25 when c < 0.3 and g < -0.1
 * kept Belebele at 90.9% R@1 (efficient preset: 91.0%) and raised the notes from 61.5% to 97.8% R@1 for translations
 * and from 63.6% to 90.9% for paraphrases. It cost 4.3 points on passages cut to 6 words (44.0% against 48.3%) and
 * the API fixture's exact query `?.`, in which the English analyzer keeps no term (c = 0). On the API docs every
 * method except vector search found 71.0% of the exact words at rank 1 (vector: 9.0%); on the natural-language
 * queries the gate reached 38.0% against 36.0%. Scaling BM25's weight by c alone cost Belebele 6.5 points (84.5%).
 * The in-script replica ranks the first relevant document like the library's efficient preset in 97.1% of records.
 * VERIFIED: promoting the vector source's first hit instead of dropping BM25 kept those R@1 figures and lost at most
 * 0.4 points of R@5. Computing c from the index's own document frequencies did about as well as the background
 * corpus, so the library ships that form (Retriever.matchShare, src/pipeline/weak-lexical.ts). Its 3 x 3 grid runs
 * through HybridSearch; the presets' setting (share < 0.2, gap > 0.15) reached 97.8% and 86.4% R@1 on the notes'
 * translation and paraphrase queries and 91.3% on Belebele, against 61.5%, 63.6% and 91.0% without the rule.
 * HYPOTHESIS: the gate's thresholds hold on queries that did not pick them; falsifier: on fresh queries it loses more
 * than a point of Belebele R@1 or most of the notes gain. All 17 variants were scored on the same queries.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { LexicalSearch, apiSearchPreset, normalizeToken } from 'defuss-lexicalsearch';
import { HybridSearch, searchPreset } from 'defuss-search';
import { createColbertAdapter } from 'defuss-search/colbert';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
import { createColbertReranker, createWinzlingEmbedder } from 'defuss-vectorsearch/onnx.js';
import { languageCases } from '../fixtures/languages.mjs';
import { downloadModels, loadModelFile } from '../scripts/models.mjs';
import { createBenchSearch, createLanguageIndex } from '../website/bench-search.mjs';
import { analyzers } from '../website/languages.mjs';
import { loadApiDocs } from './api-docs.mjs';
import { cachedVectors, createCachedColbert, notesCorpus, truncate } from './corpora.mjs';
import { loadDataset } from './dataset.mjs';
import { loadEmbeddings } from './embeddings.mjs';

const N = 25;
const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
await downloadModels();
let colbertModel;
let embedderModel;
const colbert = () =>
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
const cachedColbert = await createCachedColbert(colbert);

// ---- lexical confidence ----------------------------------------------------------------------------------------------
const entryOf = Object.fromEntries(languageCases.map((x) => [x.code, x.entry]));
/** The library's analysis order: tokenize, normalize, stem; stopwords are analyzed the same way, then removed. */
const analyzed = (text, a) =>
  a
    .tokenize(text)
    .map((t) => (a.normalize ?? normalizeToken)(t))
    .filter(Boolean)
    .map((t) => (a.stem ? a.stem(t) : t))
    .filter(Boolean);
const stops = new Map();
function terms(text, code) {
  const a = analyzers[entryOf[code]];
  if (!stops.has(code))
    stops.set(code, new Set((a.stopWords ?? []).flatMap((w) => analyzed(w, a))));
  const stop = stops.get(code);
  return analyzed(text, a).filter((t) => !stop.has(t));
}
const { documents, queries } = await loadDataset();
const groupOf = (id) => Number(id.split(':')[0]);
const backgrounds = new Map();
/** Document frequencies of one language's Belebele passages: half 0 or 1 of the passage groups, or 'all'. */
function background(code, half = 'all') {
  const key = `${code}:${half}`;
  if (!backgrounds.has(key)) {
    const texts = documents
      .filter(
        (d) =>
          d.language === code && (half === 'all' || (groupOf(d.id) < 50 ? 0 : 1) === half),
      )
      .map((d) => d.text);
    const df = new Map();
    for (const text of texts)
      for (const term of new Set(terms(text, code))) df.set(term, (df.get(term) ?? 0) + 1);
    backgrounds.set(key, { df, n: texts.length });
  }
  return backgrounds.get(key);
}
const locals = new Map();
/** Document frequencies of the indexed texts themselves: what a library sees without a background corpus. */
function indexStats(key, code, texts) {
  if (!locals.has(key)) {
    const df = new Map();
    for (const text of texts())
      for (const term of new Set(terms(text, code))) df.set(term, (df.get(term) ?? 0) + 1);
    locals.set(key, { df, n: Math.max(1, texts().length) });
  }
  return locals.get(key);
}
const idf = (b, t) => {
  const d = b.df.get(t) ?? 0;
  return Math.log(1 + (b.n - d + 0.5) / (d + 0.5));
};
/** Share of the query's background IDF mass that the document matches; the matched field's language analyzes both. */
function confidence(query, doc, code, b) {
  const wanted = [...new Set(terms(query, code))];
  if (!wanted.length) return 0;
  const present = new Set(terms(doc, code));
  let total = 0;
  let matched = 0;
  for (const t of wanted) {
    const w = idf(b, t);
    total += w;
    if (present.has(t)) matched += w;
  }
  return total ? matched / total : 0;
}
const cosine = (a, b) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
};

// ---- one query through every method ---------------------------------------------------------------------------------
/** Weighted RRF over ranked ID lists, k = 1; ties keep the first-seen order. */
function rrf(lists) {
  const scores = new Map();
  for (const [ids, weight] of lists)
    ids.forEach((id, r) => scores.set(id, (scores.get(id) ?? 0) + weight / (1 + r + 1)));
  return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
const LIBRARY_SHARES = [0.1, 0.2, 0.3];
const LIBRARY_GAPS = [0.05, 0.1, 0.15];
const records = [];
const rank = (ids, relevant) => ids.findIndex((id) => relevant.has(id)) + 1;
async function measure({ slices, text, vector, lexical, vectorRetriever, hybrid, doc }) {
  const lexIds = (await lexical.retrieve({ text }, { limit: N })).map((hit) => hit.id);
  const vecIds = (await vectorRetriever.retrieve({ text, vector }, { limit: N })).map(
    (hit) => hit.id,
  );
  const query = { text, vector };
  const ids = async (options) => (await hybrid.search(query, { ...options, limit: N })).map((hit) => hit.id);
  // The presets before the weak-lexical rule (weakLexical: false), as shipped, and the rule's threshold grid.
  const efficient = await ids({ ...searchPreset('efficient'), weakLexical: false });
  const reranked = await ids({ ...searchPreset('reranked'), weakLexical: false });
  const library = {
    'efficient preset': await ids(searchPreset('efficient')),
    'reranked preset': await ids(searchPreset('reranked')),
  };
  for (const share of LIBRARY_SHARES)
    for (const gap of LIBRARY_GAPS)
      library[`library rule share < ${share}, gap > ${gap}`] = await ids({
        ...searchPreset('efficient'),
        weakLexical: { share, gap },
      });
  const top = lexIds[0] && doc(lexIds[0]);
  const c = top ? confidence(text, top.text, top.code, top.background) : 0;
  const cIndex = top ? confidence(text, top.text, top.code, top.local()) : 0;
  const g = top && vecIds[0] ? cosine(vector, top.vector) - cosine(vector, doc(vecIds[0]).vector) : -1;
  const orders = {
    lexical: lexIds,
    vector: vecIds,
    efficient,
    reranked,
    replica: rrf([
      [lexIds, 3],
      [vecIds, 1],
    ]),
    weighted: rrf([
      [lexIds, 3 * c],
      [vecIds, 1],
    ]),
    saturated: rrf([
      [lexIds, 3 * Math.min(1, 2 * c)],
      [vecIds, 1],
    ]),
    // What a gate can do instead of dropping BM25: put the vector source's first hits above the efficient order,
    // or mirror the fusion weights so BM25's hits stay in the list below the vector source's.
    promote1: [...new Set([...vecIds.slice(0, 1), ...efficient])],
    promote2: [...new Set([...vecIds.slice(0, 2), ...efficient])],
    mirror2: rrf([
      [lexIds, 1],
      [vecIds, 2],
    ]),
    mirror3: rrf([
      [lexIds, 1],
      [vecIds, 3],
    ]),
    ...library,
  };
  for (const [slice, relevant] of slices)
    records.push({
      slice,
      c,
      cIndex,
      g,
      ranks: Object.fromEntries(Object.entries(orders).map(([m, ids]) => [m, rank(ids, relevant)])),
    });
}

// ---- Belebele, full and cut to 6 and 16 words -----------------------------------------------------------------------
const { vectors, queryVectors } = await loadEmbeddings({ documents, queries }, log);
const index = new Map(documents.map((d, i) => [d.id, i]));
async function belebele(slice, passages, passageVectors) {
  const text = new Map(passages.map((d) => [d.id, d.text]));
  const search = createBenchSearch({
    documents: passages,
    vectors: passageVectors,
    reranker: createColbertAdapter(cachedColbert, (id) => text.get(id), { truncate: true }),
  });
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const half = groupOf(q.target) < 50 ? 1 : 0;
    await measure({
      slices: [[slice, new Set([q.target])]],
      text: q.text,
      vector: queryVectors[i],
      lexical: search.lexical.get(q.language),
      vectorRetriever: search.vector,
      hybrid: search.hybrid.get(q.language),
      doc: (id) => ({
        text: text.get(id),
        code: documents[index.get(id)].language,
        vector: passageVectors[index.get(id)],
        background: background(documents[index.get(id)].language, half),
        local: () => {
          const code = documents[index.get(id)].language;
          return indexStats(`${slice}:${code}`, code, () =>
            passages.filter((d) => d.language === code).map((d) => d.text),
          );
        },
      }),
    });
  }
  log(`${slice}: ${queries.length} questions; ColBERT pairs scored ${cachedColbert.scored()}`);
}
await belebele('belebele', documents, vectors);
for (const k of [6, 16]) {
  const shortened = documents.map((x) => {
    const text = truncate(x.text, x.language, k);
    return { id: x.id, fields: { [x.language]: text }, text, language: x.language };
  });
  await belebele(
    `cut to ${k} words`,
    shortened,
    await cachedVectors(
      `bm25-switch-truncated-${k}`,
      shortened.map((x) => x.text),
      embedder,
    ),
  );
}

// ---- the demo notes -------------------------------------------------------------------------------------------------
const { notes, text: noteText, units } = notesCorpus();
const noteVectors = new Map(
  (
    await cachedVectors(
      'confidence-notes',
      notes.map((n) => n.text),
      embedder,
    )
  ).map((v, i) => [notes[i].id, v]),
);
const noteLanguage = new Map(notes.map((n) => [n.id, n.language]));
const notesColbert = createColbertAdapter(cachedColbert, (id) => noteText.get(id), {
  truncate: true,
});
function notesSearch(subset) {
  const lexicalIndex = createLanguageIndex();
  lexicalIndex.addAll(subset.map((n) => ({ id: n.id, fields: { [n.language]: n.text } })));
  const lexical = createLexicalRetriever(lexicalIndex);
  const vectorRetriever = createVectorRetriever({
    ids: subset.map((n) => n.id),
    vectors: subset.map((n) => noteVectors.get(n.id)),
  });
  return {
    lexical,
    vectorRetriever,
    hybrid: new HybridSearch({ lexical, vector: vectorRetriever, reranker: notesColbert }),
  };
}
const fullNotes = notesSearch(notes);
const noteDoc = (subset, key) => (id) => ({
  text: noteText.get(id),
  code: noteLanguage.get(id),
  vector: noteVectors.get(id),
  background: background(noteLanguage.get(id)),
  local: () =>
    indexStats(`notes:${key}:${noteLanguage.get(id)}`, noteLanguage.get(id), () =>
      subset.filter((n) => n.language === noteLanguage.get(id)).map((n) => n.text),
    ),
});
for (const unit of units) {
  const subset = unit.leaveOut ? notes.filter((n) => n.id !== unit.leaveOut) : notes;
  await measure({
    slices: [[`notes ${unit.type}`, unit.relevant]],
    text: unit.text,
    vector: await embedder().embedQuery(unit.text),
    ...(unit.leaveOut ? notesSearch(subset) : fullNotes),
    doc: noteDoc(subset, unit.leaveOut ?? 'all'),
  });
}
log(`notes: ${units.length} queries; ColBERT pairs scored ${cachedColbert.scored()}`);

// ---- the 52-entry API fixture ---------------------------------------------------------------------------------------
const api = JSON.parse(
  await readFile(new URL('../fixtures/api-embeddings.json', import.meta.url), 'utf8'),
);
const apiText = new Map(
  api.documents.map((x) => [x.id, `${x.fields.symbol}\n${x.fields.description}`]),
);
const apiVector = new Map(api.documents.map((x, i) => [x.id, api.vectors[i]]));
const apiIndex = new LexicalSearch(apiSearchPreset);
apiIndex.addAll(api.documents);
{
  const lexical = createLexicalRetriever(apiIndex, { search: { fuzzy: false } });
  const vectorRetriever = createVectorRetriever({
    ids: api.documents.map((x) => x.id),
    vectors: api.vectors,
  });
  const hybrid = new HybridSearch({
    lexical,
    vector: vectorRetriever,
    reranker: createColbertAdapter(cachedColbert, (id) => apiText.get(id), { truncate: true }),
  });
  for (const query of api.queries)
    await measure({
      slices: [
        [
          `api fixture ${query.exact ? 'exact' : 'paraphrase'}`,
          new Set(
            Object.entries(query.relevant).flatMap(([id, gain]) => (gain === 3 ? [id] : [])),
          ),
        ],
      ],
      text: query.text,
      vector: query.vector,
      lexical,
      vectorRetriever,
      hybrid,
      doc: (id) => ({
        text: apiText.get(id),
        code: 'eng_Latn',
        vector: apiVector.get(id),
        background: background('eng_Latn'),
        local: () => indexStats('api fixture', 'eng_Latn', () => [...apiText.values()]),
      }),
    });
}

// ---- the defuss-shadcn API docs -------------------------------------------------------------------------------------
const docs = await loadApiDocs();
const sectionText = (s) => `${s.title}\n${s.text}`;
const docVectors = await cachedVectors('api-docs-winzling', docs.sections.map(sectionText), embedder);
log(`api docs: ${docs.sections.length} sections embedded`);
const sectionById = new Map(docs.sections.map((s, i) => [s.id, { ...s, vector: docVectors[i] }]));
{
  const en = analyzers.en;
  const lexicalIndex = new LexicalSearch({
    fields: { title: { analyzer: en, weight: 3 }, text: { analyzer: en } },
    maxTokenLength: 1024,
  });
  lexicalIndex.addAll(docs.sections.map((s) => ({ id: s.id, fields: { title: s.title, text: s.text } })));
  const lexical = createLexicalRetriever(lexicalIndex);
  const vectorRetriever = createVectorRetriever({
    ids: docs.sections.map((s) => s.id),
    vectors: docVectors,
  });
  const hybrid = new HybridSearch({
    lexical,
    vector: vectorRetriever,
    reranker: createColbertAdapter(cachedColbert, (id) => sectionText(sectionById.get(id)), {
      truncate: true,
    }),
  });
  const pageSections = Map.groupBy(docs.sections, (s) => s.page);
  for (const query of [...docs.exact, ...docs.natural])
    await measure({
      slices: [
        [`api docs ${query.type}`, query.relevant],
        ...(query.page
          ? [['api docs natural (page)', new Set(pageSections.get(query.page).map((s) => s.id))]]
          : []),
      ],
      text: query.text,
      vector: await embedder().embedQuery(query.text),
      lexical,
      vectorRetriever,
      hybrid,
      doc: (id) => ({
        text: sectionText(sectionById.get(id)),
        code: 'eng_Latn',
        vector: sectionById.get(id).vector,
        background: background('eng_Latn'),
        local: () => indexStats('api docs', 'eng_Latn', () => docs.sections.map(sectionText)),
      }),
    });
  log(`api docs: ${docs.exact.length + docs.natural.length} queries; ColBERT pairs scored ${cachedColbert.scored()}`);
}
await cachedColbert.save();
await colbertModel?.dispose();
await embedderModel?.dispose();

// ---- summary --------------------------------------------------------------------------------------------------------
const SLICES = [...new Set(records.map((r) => r.slice))];
const bySlice = Map.groupBy(records, (r) => r.slice);
const recall = (rows, pick, k) => rows.filter((r) => pick(r) > 0 && pick(r) <= k).length / rows.length;
/** A variant is a function from a record to the rank it achieves. */
const variants = {
  lexical: (r) => r.ranks.lexical,
  vector: (r) => r.ranks.vector,
  efficient: (r) => r.ranks.efficient,
  reranked: (r) => r.ranks.reranked,
  'efficient preset': (r) => r.ranks['efficient preset'],
  'reranked preset': (r) => r.ranks['reranked preset'],
  'weighted by c': (r) => r.ranks.weighted,
  'weighted by min(1, 2c)': (r) => r.ranks.saturated,
};
for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
  variants[`vector when c < ${t}`] = (r) => (r.c < t ? r.ranks.vector : r.ranks.efficient);
for (const d of [0, 0.05, 0.1, 0.15, 0.2])
  variants[`vector when g < -${d}`] = (r) => (r.g < -d ? r.ranks.vector : r.ranks.efficient);
for (const t of [0.3, 0.5])
  for (const d of [0.05, 0.1])
    variants[`vector when c < ${t} and g < -${d}`] = (r) =>
      r.c < t && r.g < -d ? r.ranks.vector : r.ranks.efficient;
const ACTIONS = { promote1: 'vector #1 first', promote2: 'vector #1-2 first', mirror2: 'weights 1:2', mirror3: 'weights 1:3' };
for (const [action, label] of Object.entries(ACTIONS))
  for (const [t, d] of [
    [0.3, 0.1],
    [0.3, 0.05],
    [0.5, 0.1],
  ])
    variants[`${label} when c < ${t} and g < -${d}`] = (r) =>
      r.c < t && r.g < -d ? r.ranks[action] : r.ranks.efficient;
for (const t of [0.2, 0.3, 0.4, 0.5])
  for (const d of [0.05, 0.1])
    variants[`vector #1 first when cIndex < ${t} and g < -${d}`] = (r) =>
      r.cIndex < t && r.g < -d ? r.ranks.promote1 : r.ranks.efficient;
for (const share of LIBRARY_SHARES)
  for (const gap of LIBRARY_GAPS) {
    const name = `library rule share < ${share}, gap > ${gap}`;
    variants[name] = (r) => r.ranks[name];
  }
const table = Object.entries(variants).map(([name, pick]) => {
  const at = (slice, k) => recall(bySlice.get(slice), pick, k);
  const apiDocs = [...bySlice.get('api docs exact'), ...bySlice.get('api docs natural')];
  return {
    name,
    slices: Object.fromEntries(SLICES.map((s) => [s, { r1: at(s, 1), r5: at(s, 5) }])),
    // Belebele and the API docs weigh equally; R@1.
    combined: (at('belebele', 1) + recall(apiDocs, pick, 1)) / 2,
  };
});
// Parity: the replica ranks the first relevant document where the library's efficient preset does (ties may differ).
const parity = records.filter((r) => r.ranks.replica === r.ranks.efficient).length / records.length;
const cStats = SLICES.map((slice) => {
  const rows = bySlice.get(slice);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    slice,
    queries: rows.length,
    cWhenLexicalRight: mean(rows.filter((r) => r.ranks.lexical === 1).map((r) => r.c)),
    cWhenLexicalWrong: mean(rows.filter((r) => r.ranks.lexical !== 1).map((r) => r.c)),
  };
});
const report = {
  generatedAt: new Date().toISOString(),
  runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`,
  candidates: N,
  apiDocs: { sections: docs.sections.length, exact: docs.exact.length, natural: docs.natural.length },
  replicaParity: parity,
  table,
  cStats,
  records,
};
await mkdir(new URL('../output/bench/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../output/bench/confidence-fusion.json', import.meta.url),
  JSON.stringify(report, null, 1),
);
const pct = (x) => (100 * x).toFixed(1).padStart(5);
const short = ['belebele', 'cut to 6 words', 'notes translation', 'notes paraphrase', 'api docs exact', 'api docs natural'];
console.log(`replica ranks the first relevant document like efficient in ${pct(parity)}% of records`);
console.log(`${'R@1'.padEnd(36)}${short.map((s) => s.slice(-12).padStart(13)).join('')}  combined`);
for (const row of table)
  console.log(
    `${row.name.padEnd(36)}${short.map((s) => pct(row.slices[s].r1).padStart(13)).join('')}  ${pct(row.combined)}`,
  );
console.log(`${'R@5'.padEnd(36)}${short.map((s) => s.slice(-12).padStart(13)).join('')}`);
for (const row of table)
  console.log(`${row.name.padEnd(36)}${short.map((s) => pct(row.slices[s].r5).padStart(13)).join('')}`);
for (const s of cStats)
  console.log(`c ${s.slice.padEnd(26)} right ${s.cWhenLexicalRight?.toFixed(2)} wrong ${s.cWhenLexicalWrong?.toFixed(2)}`);
log('Wrote output/bench/confidence-fusion.json');
