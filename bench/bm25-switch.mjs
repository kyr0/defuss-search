/**
 * When does BM25 help, and when should a search turn it off? Each query runs through six methods: lexical (BM25),
 * vector, vector + ColBERT, the efficient and reranked presets, and semantic-first (vector + ColBERT with lexical
 * coverage promotion, bench/semantic-first.mjs). It then scores rules that switch between the reranked preset (BM25
 * on) and a BM25-free method.
 * Corpora:
 * - Belebele (tiny-embedding-bench-v1) at 20 to 2,000 passages: random subsets of whole passage groups (all 20
 *   languages of a passage), with the questions whose gold passage is in the subset. The lexical index is rebuilt
 *   per subset, so BM25's document frequencies come from the subset, as in a small real index.
 * - The demo's 100 short sample notes (fixtures/notes-benchmark.mjs): every translated note as a query for its
 *   translations, with itself left out of the index, and assistant-written keyword and paraphrase queries.
 * Raw ColBERT scores are cached per query and document text, so a pair scored in one subset is reused in the next.
 * Why rules on observable properties: a library can only switch on what it sees at query time, namely index size,
 * document length and the lexical evidence of the query itself.
 * VERIFIED: in the 2026-11-01 runs (output/bench/bm25-switch.json), BM25 led on full Belebele passages at every
 * size from 20 to 2,000 (lexical 98.8% R@1 at 20 passages, vector 82.9%), and still on passages cut to 6 words
 * (8 analyzed terms): lexical 47.4%, vector 19.8%. On the notes (8.7 terms) vector alone led: 98.9% R@1 on
 * translations and 95.5% on paraphrases, against 61.5% and 63.6% for the reranked preset. Short documents favor
 * BM25 in one corpus and the vector source in the other, so document length is no valid switch: the corpora
 * differ in what counts as relevant (the question's own passage, with shared words, against translations and
 * paraphrases). The best length rule (vector below 10 terms) gains about 35 points on the notes and loses about 23
 * on the shortest Belebele passages. ColBERT reordering of the vector order lowered R@1 on every corpus except
 * the full 2,000 passages, and the reranked preset matched the efficient preset's R@1 everywhere.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { HybridSearch, searchPreset } from 'defuss-search';
import { createColbertAdapter } from 'defuss-search/colbert';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
import { createColbertReranker, createWinzlingEmbedder } from 'defuss-vectorsearch/onnx.js';
import { downloadModels, loadModelFile } from '../scripts/models.mjs';
import { createBenchSearch, createLanguageIndex } from '../website/bench-search.mjs';
import { cachedVectors, createCachedColbert, notesCorpus, random, truncate } from './corpora.mjs';
import { coverages, semanticFirst } from './coverage.mjs';
import { loadDataset } from './dataset.mjs';
import { loadEmbeddings } from './embeddings.mjs';

const N = 25;
const METHODS = ['lexical', 'vector', 'colbert', 'efficient', 'reranked', 'semantic'];
// [passage groups, random subsets]; one group is one passage in all 20 languages.
const PLAN = [
  [1, 20],
  [2, 20],
  [5, 10],
  [10, 10],
  [25, 5],
  [50, 5],
  [100, 1],
];
const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
// ---- ColBERT with a pair cache --------------------------------------------------------------------------------------
await downloadModels();
const colbert = createColbertReranker({
  model: '1.5m',
  precision: 'q8',
  device: 'cpu',
  numThreads: 1,
  loadFile: loadModelFile('colbert'),
  allowRemoteModels: false,
});
const cachedColbert = await createCachedColbert(() => colbert);

/** Ranked ID lists of all six methods for one query, plus the query's lexical evidence. */
async function run({ text, vector, lexical, vectorRetriever, hybrid, index, fields, textOf }) {
  const query = { text, vector };
  const lexicalIds = (await lexical.retrieve({ text }, { limit: N })).map((hit) => hit.id);
  const vectorIds = (await vectorRetriever.retrieve(query, { limit: N })).map((hit) => hit.id);
  const colbertIds = (
    await cachedColbert.rerank(text, vectorIds.map(textOf), { topK: vectorIds.length })
  ).map(({ index: i }) => vectorIds[i]);
  const efficient = await hybrid.search(query, { ...searchPreset('efficient'), limit: N });
  const reranked = await hybrid.searchWithStats(query, { ...searchPreset('reranked'), limit: N });
  const inside = coverages(index, text, {
    fields,
    ids: new Set(vectorIds),
    limit: N,
    typos: false,
  });
  const outside = coverages(index, text, { fields, limit: 50, typos: false });
  return {
    orders: {
      lexical: lexicalIds,
      vector: vectorIds,
      colbert: colbertIds,
      efficient: efficient.map((hit) => hit.id),
      reranked: reranked.hits.map((hit) => hit.id),
      semantic: semanticFirst({
        order: colbertIds,
        coverage: new Map(inside.map((hit) => [hit.id, hit.coverage])),
        outside,
        minIn: 0.33,
        minOut: 0.5,
      }),
    },
    neural: reranked.rerankDecision.action === 'applied',
    // Coverage of the best lexical hit: the query-time evidence a switching rule can use.
    topCoverage: outside[0]?.coverage ?? 0,
  };
}
/** Average analyzed terms per document over the given fields (all fields when omitted), as a library sees it. */
const fieldLength = (index, fields) => {
  const all = index.stats().fields;
  const chosen = fields ? fields.map((field) => all[field]).filter(Boolean) : Object.values(all);
  const documents = chosen.reduce((sum, field) => sum + field.documents, 0);
  return chosen.reduce((sum, field) => sum + field.tokens, 0) / Math.max(1, documents);
};
const averageLength = (index) => fieldLength(index);
const ranksOf = (orders, relevant) =>
  Object.fromEntries(
    METHODS.map((method) => [method, orders[method].findIndex((id) => relevant.has(id)) + 1]),
  );

const records = [];

// ---- Belebele at several index sizes -------------------------------------------------------------------------------
const { documents, queries } = await loadDataset();
const { vectors, queryVectors } = await loadEmbeddings({ documents, queries }, log);
const texts = new Map(documents.map((x) => [x.id, x.text]));
const belebeleColbert = createColbertAdapter(cachedColbert, (id) => texts.get(id), {
  truncate: true,
});
const groupOf = (id) => Number(id.split(':')[0]);
for (const [groups, subsets] of PLAN) {
  for (let seed = 0; seed < subsets; seed++) {
    const next = random(1000 * groups + seed);
    const order = Array.from({ length: 100 }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const chosen = new Set(order.slice(0, groups));
    const rows = documents.flatMap((x, i) => (chosen.has(groupOf(x.id)) ? [i] : []));
    const asked = queries.flatMap((q, i) => (chosen.has(groupOf(q.target)) ? [i] : []));
    if (!asked.length) continue;
    const search = createBenchSearch({
      documents: rows.map((i) => documents[i]),
      vectors: rows.map((i) => vectors[i]),
      reranker: belebeleColbert,
    });
    const length = averageLength(search.index);
    for (const i of asked) {
      const query = queries[i];
      const result = await run({
        text: query.text,
        vector: queryVectors[i],
        lexical: search.lexical.get(query.language),
        vectorRetriever: search.vector,
        hybrid: search.hybrid.get(query.language),
        index: search.index,
        fields: [query.language],
        textOf: (id) => texts.get(id),
      });
      records.push({
        corpus: 'belebele',
        type: 'question',
        size: rows.length,
        averageLength: length,
        fieldLength: fieldLength(search.index, [query.language]),
        ranks: ranksOf(result.orders, new Set([query.target])),
        neural: result.neural,
        topCoverage: result.topCoverage,
      });
    }
    log(
      `belebele ${rows.length} passages, subset ${seed + 1}/${subsets}: ${asked.length} questions; ColBERT pairs scored ${cachedColbert.scored()}`,
    );
  }
}

const embedder = createWinzlingEmbedder({
  device: 'cpu',
  numThreads: 1,
  loadFile: loadModelFile('winzling'),
  allowRemoteModels: false,
});

// ---- Belebele passages cut to their first k words ------------------------------------------------------------------
// The gold labels stay: a passage's opening still names its topic, and every method sees the same shortened text.
const WORDS = [6, 8, 12, 16, 24, 32];
for (const k of WORDS) {
  const shortened = documents.map((x) => {
    const text = truncate(x.text, x.language, k);
    return { id: x.id, fields: { [x.language]: text }, text };
  });
  const shortText = new Map(shortened.map((x) => [x.id, x.text]));
  const search = createBenchSearch({
    documents: shortened,
    vectors: await cachedVectors(
      `bm25-switch-truncated-${k}`,
      shortened.map((x) => x.text),
      () => embedder,
    ),
    reranker: createColbertAdapter(cachedColbert, (id) => shortText.get(id), { truncate: true }),
  });
  const length = averageLength(search.index);
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const result = await run({
      text: query.text,
      vector: queryVectors[i],
      lexical: search.lexical.get(query.language),
      vectorRetriever: search.vector,
      hybrid: search.hybrid.get(query.language),
      index: search.index,
      fields: [query.language],
      textOf: (id) => shortText.get(id),
    });
    records.push({
      corpus: 'truncated',
      type: 'question',
      words: k,
      size: shortened.length,
      averageLength: length,
      fieldLength: fieldLength(search.index, [query.language]),
      ranks: ranksOf(result.orders, new Set([query.target])),
      neural: result.neural,
      topCoverage: result.topCoverage,
    });
  }
  log(
    `passages cut to ${k} words: ${length.toFixed(1)} terms on average; ColBERT pairs scored ${cachedColbert.scored()}`,
  );
}

// ---- the demo's short notes ----------------------------------------------------------------------------------------
const { notes, text: noteText, units } = notesCorpus();
const noteVectors = new Map(
  (await embedder.embedDocuments(notes.map((note) => note.text))).map((v, i) => [notes[i].id, v]),
);
const notesColbert = createColbertAdapter(cachedColbert, (id) => noteText.get(id), {
  truncate: true,
});
function notesSearch(subset) {
  const index = createLanguageIndex();
  index.addAll(subset.map((note) => ({ id: note.id, fields: { [note.language]: note.text } })));
  const lexical = createLexicalRetriever(index);
  const vectorRetriever = createVectorRetriever({
    ids: subset.map((note) => note.id),
    vectors: subset.map((note) => noteVectors.get(note.id)),
  });
  const hybrid = new HybridSearch({ lexical, vector: vectorRetriever, reranker: notesColbert });
  return { index, lexical, vectorRetriever, hybrid, length: averageLength(index) };
}
const full = notesSearch(notes);
for (const unit of units) {
  const search = unit.leaveOut
    ? notesSearch(notes.filter((note) => note.id !== unit.leaveOut))
    : full;
  const result = await run({
    text: unit.text,
    vector: await embedder.embedQuery(unit.text),
    ...search,
    fields: undefined,
    textOf: (id) => noteText.get(id),
  });
  records.push({
    corpus: 'notes',
    type: unit.type,
    text: unit.text,
    size: unit.leaveOut ? notes.length - 1 : notes.length,
    averageLength: search.length,
    fieldLength: search.length,
    ranks: ranksOf(result.orders, unit.relevant),
    neural: result.neural,
    topCoverage: result.topCoverage,
  });
}
log(`notes: ${units.length} queries; ColBERT pairs scored ${cachedColbert.scored()}`);
await colbert.dispose();
await embedder.dispose();
await cachedColbert.save();

// ---- summaries and switching rules ---------------------------------------------------------------------------------
const recallAt = (rows, method, k) =>
  rows.filter((row) => row.ranks[method] > 0 && row.ranks[method] <= k).length / rows.length;
const slices = [
  ...PLAN.map(([groups]) => ({
    name: `belebele ${groups * 20}`,
    rows: records.filter((row) => row.corpus === 'belebele' && row.size === groups * 20),
  })),
  ...WORDS.map((k) => ({
    name: `cut to ${k} words`,
    rows: records.filter((row) => row.corpus === 'truncated' && row.words === k),
  })),
  ...['translation', 'keyword', 'paraphrase'].map((type) => ({
    name: `notes ${type}`,
    rows: records.filter((row) => row.corpus === 'notes' && row.type === type),
  })),
].filter((slice) => slice.rows.length);
const table = slices.map((slice) => ({
  name: slice.name,
  queries: slice.rows.length,
  averageLength: slice.rows.reduce((sum, row) => sum + row.averageLength, 0) / slice.rows.length,
  fieldLength: slice.rows.reduce((sum, row) => sum + row.fieldLength, 0) / slice.rows.length,
  r1: Object.fromEntries(METHODS.map((m) => [m, recallAt(slice.rows, m, 1)])),
  r5: Object.fromEntries(METHODS.map((m) => [m, recallAt(slice.rows, m, 5)])),
}));
/** A rule picks the reranked preset (BM25 on) or the BM25-free method per query; scored per slice. */
const LENGTHS = [0, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 38, 1000];
const rules = [];
const offMethods = ['vector', 'colbert', 'semantic'];
const ruleSpecs = [
  ...[0, 50, 100, 200, 500, 1000, 2001].map((t) => ({
    name: `BM25 when index ≥ ${t} documents`,
    on: (row) => row.size >= t,
  })),
  ...LENGTHS.map((t) => ({
    name: `BM25 when the searched fields average ≥ ${t} terms`,
    on: (row) => row.fieldLength >= t,
  })),
  ...[0, 0.25, 0.34, 0.5, 0.67, 1.01].map((t) => ({
    name: `BM25 when its top hit covers ≥ ${t} of the query`,
    on: (row) => row.topCoverage >= t,
  })),
];
for (const off of offMethods)
  for (const spec of ruleSpecs) {
    const scores = slices.map((slice) => {
      const pick = (row) => row.ranks[spec.on(row) ? 'reranked' : off];
      const hit = (k) =>
        slice.rows.filter((row) => pick(row) > 0 && pick(row) <= k).length / slice.rows.length;
      return { name: slice.name, r1: hit(1), r5: hit(5) };
    });
    rules.push({ rule: spec.name, off, slices: scores });
  }

/**
 * Three ways by the searched fields' average length: vector alone below t, the efficient preset (BM25, no ColBERT)
 * from t, the reranked preset (BM25 and ColBERT) from u. Ranked by the mean over slices of R@1, then R@5.
 */
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const threeWay = [];
for (const t of LENGTHS)
  for (const u of LENGTHS) {
    if (u < t) continue;
    const pick = (row) =>
      row.ranks[row.fieldLength < t ? 'vector' : row.fieldLength < u ? 'efficient' : 'reranked'];
    const scores = slices.map((slice) => {
      const hit = (k) =>
        slice.rows.filter((row) => pick(row) > 0 && pick(row) <= k).length / slice.rows.length;
      return { name: slice.name, r1: hit(1), r5: hit(5) };
    });
    threeWay.push({
      vectorBelow: t,
      colbertFrom: u,
      r1: mean(scores.map((x) => x.r1)),
      r5: mean(scores.map((x) => x.r5)),
      slices: scores,
    });
  }
threeWay.sort((a, b) => b.r1 - a.r1 || b.r5 - a.r5 || a.vectorBelow - b.vectorBelow);

const report = {
  generatedAt: new Date().toISOString(),
  runtime: process.versions.bun
    ? `Bun ${process.versions.bun}`
    : `Node.js ${process.versions.node}`,
  candidates: N,
  plan: PLAN,
  queriesWrittenBy: 'assistant, 2026-11-01 (fixtures/notes-benchmark.mjs)',
  table,
  rules,
  threeWay,
  records,
};
await mkdir(new URL('../output/bench/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../output/bench/bm25-switch.json', import.meta.url),
  JSON.stringify(report, null, 1),
);
const pct = (x) => (100 * x).toFixed(1).padStart(5);
console.log(`slice                 n   len | R@1 ${METHODS.join(' ')} | R@5 ${METHODS.join(' ')}`);
for (const row of table)
  console.log(
    `${row.name.padEnd(20)} ${String(row.queries).padStart(4)} ${row.fieldLength.toFixed(0).padStart(4)} |${METHODS.map((m) => pct(row.r1[m])).join('')} |${METHODS.map((m) => pct(row.r5[m])).join('')}`,
  );
for (const rule of rules.filter((x) => x.off === 'vector'))
  console.log(
    `${`${rule.rule} else ${rule.off}`.padEnd(64)} ${rule.slices.map((s) => `${s.name.replace('belebele ', 'b').replace('notes ', '')} ${pct(s.r1)}/${pct(s.r5)}`).join(' ')}`,
  );
console.log('three ways (vector below t, efficient from t, reranked from u), best mean R@1 first:');
for (const row of threeWay.slice(0, 12))
  console.log(
    `t=${String(row.vectorBelow).padStart(4)} u=${String(row.colbertFrom).padStart(4)} mean ${pct(row.r1)}/${pct(row.r5)} | ${row.slices.map((x) => `${x.name.replace('belebele ', 'b').replace('notes ', '').replace('cut to ', 'w').replace(' words', '')} ${pct(x.r1)}`).join(' ')}`,
  );
log('Wrote output/bench/bm25-switch.json');
