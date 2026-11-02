/**
 * Experiment: semantic-first ranking with lexical coverage promotion, the strategy the human proposed on 2026-11-01.
 * 1. Vector top 25, reordered by raw MoEdernColBERT scores.
 * 2. Coverage of a passage: the share of the query's analyzed terms (stopwords removed) it contains, exactly or,
 *    for terms of at least five code points, within one edit. Coverage needs no corpus statistics, unlike BM25,
 *    whose IDF cannot tell a function word from a rare word in an index of a few notes.
 * 3. Candidates with coverage of at least minIn move to the front, ordered by coverage, then ColBERT.
 * 4. Lexical hits outside the vector set join that front group only with coverage of at least minOut.
 * Thresholds are selected on the 500 development questions and reported on the 500 held-out questions, like the
 * frontier analysis. The notes part runs the demo's 100 sample notes with real Winzling and ColBERT.
 * VERIFIED: in the 2026-11-01 run (output/bench/semantic-first.json), the hypothesis that coverage promotion keeps the
 * benchmark's quality failed. The best development variant (vector order, exact words, minIn 0.33, minOut 0.5) reached
 * 74.6% R@1 and 83.4% R@5 on the holdout, against 92.0% and 96.8% for the reranked preset. Gold passages share a
 * quarter to a half of a question's words, which BM25's IDF exploits and a coverage threshold discards. On the
 * sample notes it ranked animal notes first for "Mehr Kontakt mit Tieren", where both presets put two notes that
 * share only "mehr" first. The notes part always uses the ColBERT order, as proposed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { HybridSearch, searchPreset } from 'defuss-search';
import { createColbertAdapter } from 'defuss-search/colbert';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
import { createColbertReranker, createWinzlingEmbedder } from 'defuss-vectorsearch/onnx.js';
import { languageCases } from '../fixtures/languages.mjs';
import { downloadModels, loadModelFile, releases } from '../scripts/models.mjs';
import { createBenchSearch, createLanguageIndex } from '../website/bench-search.mjs';
import { SAMPLE_NOTES } from '../website/sample-notes.mjs';
import { loadDataset } from './dataset.mjs';
import { coverages, semanticFirst } from './coverage.mjs';
import { loadEmbeddings } from './embeddings.mjs';

const N = 25;
const K = [1, 5, 10, 25];
const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
const codeOfEntry = Object.fromEntries(languageCases.map((x) => [x.entry, x.code]));

const colbert = createColbertReranker({
  model: '1.5m',
  precision: 'q8',
  device: 'cpu',
  numThreads: 1,
  loadFile: loadModelFile('colbert'),
  allowRemoteModels: false,
});
const colbertOrder = async (text, ids, textOf) => {
  const ranked = await colbert.rerank(
    text,
    ids.map((id) => textOf(id)),
    { topK: ids.length, truncate: true },
  );
  const scores = Array.from({ length: ids.length });
  for (const { index, score } of ranked) scores[index] = score;
  return { scores, order: rankByScores(ids, scores) };
};
const rankByScores = (ids, scores) =>
  ids
    .map((id, i) => [id, scores[i], i])
    .sort((a, b) => b[1] - a[1] || a[2] - b[2])
    .map(([id]) => id);

// ---- benchmark ------------------------------------------------------------------------------------------------
const { documents, queries } = await loadDataset();
const { vectors, queryVectors } = await loadEmbeddings({ documents, queries }, log);
await downloadModels();
const { index, vector } = createBenchSearch({ documents, vectors });
const texts = new Map(documents.map((x) => [x.id, x.text]));
const cachePath = new URL('../input/semantic-first-colbert.json', import.meta.url);
const cacheKey = JSON.stringify(releases.find((x) => x.name === 'colbert').files);
let cache = { key: cacheKey, entries: [] };
try {
  const stored = JSON.parse(await readFile(cachePath, 'utf8'));
  if (stored.key === cacheKey) cache = stored;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const records = [];
let computed = 0;
for (let i = 0; i < queries.length; i++) {
  const query = queries[i];
  const ids = (
    await vector.retrieve({ text: query.text, vector: queryVectors[i] }, { limit: N })
  ).map((hit) => hit.id);
  let scores = cache.entries[i]?.ids.join() === ids.join() ? cache.entries[i].scores : undefined;
  if (!scores) {
    ({ scores } = await colbertOrder(query.text, ids, (id) => texts.get(id)));
    cache.entries[i] = { ids, scores };
    computed++;
  }
  const record = {
    group: Math.floor(i / languageCases.length),
    target: query.target,
    vector: ids,
    colbert: rankByScores(ids, scores),
  };
  for (const typos of [false, true]) {
    const inside = coverages(index, query.text, {
      fields: [query.language],
      ids: new Set(ids),
      limit: N,
      typos,
    });
    record[typos ? 'typo' : 'exact'] = {
      coverage: new Map(inside.map((hit) => [hit.id, hit.coverage])),
      outside: coverages(index, query.text, { fields: [query.language], limit: 50, typos }),
    };
  }
  records.push(record);
  if ((i + 1) % 100 === 0) log(`${i + 1}/${queries.length} questions; ColBERT ran for ${computed}`);
}
if (computed) {
  await mkdir(new URL('../input/', import.meta.url), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache));
}

const recall = (rows, rank) => {
  const out = {};
  const ranks = rows.map(rank);
  for (const k of K) out[`r${k}`] = ranks.filter((r) => r > 0 && r <= k).length / rows.length;
  return out;
};
const position = (order, target) => order.indexOf(target) + 1;
const development = records.filter((row) => row.group < 25);
const holdout = records.filter((row) => row.group >= 25);

const variants = [];
for (const base of ['vector', 'colbert'])
  for (const typos of [false, true])
    for (const minIn of [Infinity, 1, 0.75, 0.66, 0.5, 0.33])
      for (const minOut of [Infinity, 1, 0.75, 0.66, 0.5]) {
        if (minOut < minIn) continue;
        if (minIn === Infinity && minOut === Infinity && typos) continue;
        const name = `${base}${minIn === Infinity && minOut === Infinity ? '' : ` · ${typos ? 'typo' : 'exact'} in≥${minIn} out≥${minOut}`}`;
        const rank = (row) => {
          const lexical = row[typos ? 'typo' : 'exact'];
          return position(
            semanticFirst({ order: row[base], ...lexical, minIn, minOut }),
            row.target,
          );
        };
        variants.push({
          name,
          base,
          typos,
          minIn,
          minOut,
          development: recall(development, rank),
          holdout: recall(holdout, rank),
          all: recall(records, rank),
        });
      }
// The Lexical column with a minimum coverage: BM25 order, hits below the threshold dropped.
for (const minimum of [0, 0.33, 0.5, 0.66]) {
  const rank = (row) =>
    position(
      row.exact.outside
        .filter((hit) => hit.coverage >= minimum)
        .slice(0, N)
        .map((hit) => hit.id),
      row.target,
    );
  variants.push({
    name: `lexical BM25 · coverage≥${minimum}`,
    development: recall(development, rank),
    holdout: recall(holdout, rank),
    all: recall(records, rank),
  });
}
const better = (a, b) =>
  K.map((k) => b.development[`r${k}`] - a.development[`r${k}`]).find((d) => Math.abs(d) > 1e-12) ??
  0;
const strategies = variants.filter(
  (v) => v.base && (v.minIn !== Infinity || v.minOut !== Infinity),
);
const selected = [...strategies].sort(better)[0];

// ---- notes: the demo's sample notes with real models ---------------------------------------------------------------
const embedder = createWinzlingEmbedder({
  device: 'cpu',
  numThreads: 1,
  loadFile: loadModelFile('winzling'),
  allowRemoteModels: false,
});
const notes = SAMPLE_NOTES.map((note, i) => ({
  id: `note-${i + 1}`,
  text: note.text,
  language: codeOfEntry[note.lang],
}));
const noteText = new Map(notes.map((note) => [note.id, note.text]));
const noteVectors = await embedder.embedDocuments(notes.map((note) => note.text));
const noteIndex = createLanguageIndex();
noteIndex.addAll(notes.map((note) => ({ id: note.id, fields: { [note.language]: note.text } })));
const noteVector = createVectorRetriever({
  ids: notes.map((note) => note.id),
  vectors: noteVectors,
});
const noteHybrid = new HybridSearch({
  lexical: createLexicalRetriever(noteIndex),
  vector: noteVector,
  reranker: createColbertAdapter(colbert, (id) => noteText.get(id), { truncate: true }),
});
const notesReport = [];
for (const text of [
  'Mehr Kontakt mit Tieren',
  'Kartoffelsuppe',
  'Kartofelsuppe',
  'Server langsam',
  'Steuererklärung Frist',
]) {
  const queryVector = await embedder.embedQuery(text);
  const top = (hits) => hits.slice(0, 5).map((hit) => noteText.get(hit.id ?? hit));
  const efficient = await noteHybrid.search(
    { text, vector: queryVector },
    { ...searchPreset('efficient'), limit: 5 },
  );
  const reranked = await noteHybrid.search(
    { text, vector: queryVector },
    { ...searchPreset('reranked'), limit: 5 },
  );
  const ids = (await noteVector.retrieve({ text, vector: queryVector }, { limit: N })).map(
    (hit) => hit.id,
  );
  const { order } = await colbertOrder(text, ids, (id) => noteText.get(id));
  const typos = selected.typos;
  const inside = coverages(noteIndex, text, { ids: new Set(ids), limit: N, typos });
  const proposed = semanticFirst({
    order,
    coverage: new Map(inside.map((hit) => [hit.id, hit.coverage])),
    outside: coverages(noteIndex, text, { limit: 50, typos }),
    minIn: selected.minIn,
    minOut: selected.minOut,
  });
  notesReport.push({
    text,
    efficient: top(efficient),
    reranked: top(reranked),
    proposed: top(proposed),
  });
}
await colbert.dispose();
await embedder.dispose();

const references = JSON.parse(await readFile(new URL('../docs/data/pareto.json', import.meta.url)));
const report = {
  generatedAt: new Date().toISOString(),
  runtime: process.versions.bun
    ? `Bun ${process.versions.bun}`
    : `Node.js ${process.versions.node}`,
  candidates: N,
  selection:
    'Development (first 25 question groups): descending R@1, R@5, R@10, R@25; holdout (last 25 groups) reported.',
  selected,
  references: Object.fromEntries(
    ['lexical', 'vector', 'efficient', 'reranked'].map((name) => {
      const row = references.holdout.results.find((x) => x.name === name);
      return [name, { r1: row.r1, r5: row.r5, r10: row.r10 }];
    }),
  ),
  variants,
  notes: notesReport,
};
await mkdir(new URL('../output/bench/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../output/bench/semantic-first.json', import.meta.url),
  JSON.stringify(report, (key, value) => (value === Infinity ? 'off' : value), 2),
);
const pct = (x) => (100 * x).toFixed(1).padStart(5);
const row = (v) =>
  `${v.name.padEnd(46)} dev ${pct(v.development.r1)} ${pct(v.development.r5)} | holdout ${K.map((k) => pct(v.holdout[`r${k}`])).join(' ')} | all ${K.map((k) => pct(v.all[`r${k}`])).join(' ')}`;
console.log(
  'variant                                         dev R@1 R@5 | holdout R@1 R@5 R@10 R@25 | all',
);
for (const v of [...strategies].sort(better).slice(0, 8)) console.log(row(v));
for (const v of variants.filter((x) => !strategies.includes(x))) console.log(row(v));
console.log('reference holdout', JSON.stringify(report.references));
console.log('selected', selected.name);
for (const note of notesReport) console.log(JSON.stringify(note, null, 1));
log('Wrote output/bench/semantic-first.json');
