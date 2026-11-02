/**
 * Experiment: MoEdernColBERT 1.5M q8 (3.97 MB) as the first-stage retriever, one to one against Winzling uint4
 * (39.8 MB). ColBERT encodes every document once into a token matrix and ranks all documents by MaxSim; Winzling
 * ranks them by the cosine of one 384-dimensional vector. Both serve as the vector source alone and inside the
 * efficient preset. Corpora: Belebele (2,000 passages, 1,000 questions), the demo's 100 sample notes
 * (fixtures/notes-benchmark.mjs) and the API fixture (52 symbols, 15 queries, gain-3 judgments as relevant).
 * Why a full MaxSim scan instead of a ColBERT index: the corpora are small enough that the scan is exact, so the
 * comparison measures the models, not an approximate index.
 * VERIFIED: in the 2026-11-01 run (output/bench/colbert-retrieval.json) ColBERT retrieved worse than Winzling on
 * Belebele (36.8% against 41.7% R@1, 48.7% against 60.5% R@5) and on every notes slice (translations 59.3% against
 * 98.9% R@1); on the API fixture it tied on exact symbols and won 6 against 4 of 10 paraphrases at R@1 while losing
 * at R@5. Inside the efficient preset it never beat Winzling. Its token matrices take about 30 times the space of
 * a Winzling vector, and a full MaxSim scan of 2,000 passages took about 0.6 s per query.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { LexicalSearch, apiSearchPreset } from 'defuss-lexicalsearch';
import { HybridSearch, searchPreset } from 'defuss-search';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
import { createColbertReranker, createWinzlingEmbedder, maxSim } from 'defuss-vectorsearch/onnx.js';
import { languageCases } from '../fixtures/languages.mjs';
import { QUERIES, TOPICS } from '../fixtures/notes-benchmark.mjs';
import { downloadModels, loadModelFile, releases } from '../scripts/models.mjs';
import { createBenchSearch, createLanguageIndex } from '../website/bench-search.mjs';
import { SAMPLE_NOTES } from '../website/sample-notes.mjs';
import { loadDataset } from './dataset.mjs';
import { loadEmbeddings } from './embeddings.mjs';

const N = 25;
const K = [1, 5, 10, 25];
const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
const codeOfEntry = Object.fromEntries(languageCases.map((x) => [x.entry, x.code]));
// Model download sizes as pinned in the demo manifest (docs/data/manifest.json).
const manifest = JSON.parse(
  await readFile(new URL('../docs/data/manifest.json', import.meta.url), 'utf8'),
);
const bytesOf = (name) =>
  Object.values(manifest.models[name].files).reduce((sum, file) => sum + file.bytes, 0);

await downloadModels();
const colbert = createColbertReranker({
  model: '1.5m',
  precision: 'q8',
  device: 'cpu',
  numThreads: 1,
  loadFile: loadModelFile('colbert'),
  allowRemoteModels: false,
  truncate: true,
});
const embedder = createWinzlingEmbedder({
  device: 'cpu',
  numThreads: 1,
  loadFile: loadModelFile('winzling'),
  allowRemoteModels: false,
});
const timings = { colbertDocumentMs: 0, colbertDocuments: 0, colbertQueryMs: 0, colbertQueries: 0 };

/** Token matrices of documents, cached as concatenated float32 rows with per-document token counts. */
async function encodeDocuments(name, texts) {
  const key = createHash('sha256')
    .update(
      `${JSON.stringify(releases.find((x) => x.name === 'colbert').files)}\u0000${texts.join('\u0001')}`,
    )
    .digest('hex');
  const base = new URL(`../input/colbert-retrieval-${name}`, import.meta.url);
  try {
    const meta = JSON.parse(await readFile(`${base.pathname}.json`, 'utf8'));
    if (meta.key === key) {
      const bytes = await readFile(`${base.pathname}.f32`);
      const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      let offset = 0;
      return meta.counts.map((tokenCount) => {
        const data = floats.subarray(offset, offset + tokenCount * meta.dimensions);
        offset += tokenCount * meta.dimensions;
        return {
          data,
          tokenCount,
          dimensions: meta.dimensions,
          fingerprint: meta.fingerprint,
          truncated: false,
        };
      });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const started = performance.now();
  const matrices = [];
  for (let i = 0; i < texts.length; i += 64)
    matrices.push(...(await colbert.encodeDocuments(texts.slice(i, i + 64), { truncate: true })));
  timings.colbertDocumentMs += performance.now() - started;
  timings.colbertDocuments += texts.length;
  const total = matrices.reduce((sum, m) => sum + m.data.length, 0);
  const floats = new Float32Array(total);
  let offset = 0;
  for (const m of matrices) {
    floats.set(m.data, offset);
    offset += m.data.length;
  }
  await mkdir(new URL('../input/', import.meta.url), { recursive: true });
  await writeFile(`${base.pathname}.f32`, Buffer.from(floats.buffer));
  await writeFile(
    `${base.pathname}.json`,
    JSON.stringify({
      key,
      dimensions: matrices[0].dimensions,
      fingerprint: matrices[0].fingerprint,
      counts: matrices.map((m) => m.tokenCount),
    }),
  );
  return matrices;
}
async function encodeQuery(text) {
  const started = performance.now();
  const [matrix] = await colbert.encodeQueries([text], { truncate: true });
  timings.colbertQueryMs += performance.now() - started;
  timings.colbertQueries++;
  return matrix;
}
/** A Retriever over a full MaxSim scan; the scan per query text is computed once and reused. */
function colbertRetriever(ids, matrices) {
  const scans = new Map();
  const scan = async (text) => {
    if (!scans.has(text)) {
      const query = await encodeQuery(text);
      const started = performance.now();
      const scored = ids.map((id, i) => ({ id, score: maxSim(query, matrices[i]) }));
      scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      scans.set(text, { scored, ms: performance.now() - started });
    }
    return scans.get(text).scored;
  };
  return {
    scans,
    async retrieve(query, { limit, ids: allowed }) {
      const scored = await scan(query.text);
      return (allowed ? scored.filter((hit) => allowed.has(hit.id)) : scored).slice(0, limit);
    },
  };
}
const rankIn = (hits, relevant) => hits.findIndex((hit) => relevant.has(hit.id ?? hit)) + 1;

/** R@k of the four configurations for one corpus. */
async function measure(name, units, { winzling, colbertSource, hybrids }) {
  const ranks = {
    winzling: [],
    colbert: [],
    'efficient + winzling': [],
    'efficient + colbert': [],
  };
  for (const unit of units) {
    const query = { text: unit.text, vector: unit.vector };
    const context = { limit: N, ids: unit.ids };
    ranks.winzling.push(rankIn(await winzling(unit).retrieve(query, context), unit.relevant));
    ranks.colbert.push(rankIn(await colbertSource(unit).retrieve(query, context), unit.relevant));
    // The short-text route is off here, so both models are compared inside the same fusion; bench/bm25-switch.mjs
    // measures the route itself.
    const options = {
      ...searchPreset('efficient'),
      vectorOnlyBelow: undefined,
      limit: N,
      ids: unit.ids,
    };
    const { withWinzling, withColbert } = hybrids(unit);
    ranks['efficient + winzling'].push(
      rankIn(await withWinzling.search(query, options), unit.relevant),
    );
    ranks['efficient + colbert'].push(
      rankIn(await withColbert.search(query, options), unit.relevant),
    );
  }
  const recall = Object.fromEntries(
    Object.entries(ranks).map(([method, list]) => [
      method,
      Object.fromEntries(
        K.map((k) => [`r${k}`, list.filter((r) => r > 0 && r <= k).length / list.length]),
      ),
    ]),
  );
  log(`${name}: ${units.length} queries measured`);
  return { name, queries: units.length, recall };
}

const results = [];

// ---- Belebele ------------------------------------------------------------------------------------------------------
const { documents, queries } = await loadDataset();
const { vectors, queryVectors } = await loadEmbeddings({ documents, queries }, log);
const bench = createBenchSearch({ documents, vectors });
const passageMatrices = await encodeDocuments(
  'belebele',
  documents.map((x) => x.text),
);
const passageColbert = colbertRetriever(
  documents.map((x) => x.id),
  passageMatrices,
);
const colbertHybrid = new Map(
  [...bench.lexical].map(([code, lexical]) => [
    code,
    new HybridSearch({ lexical, vector: passageColbert }),
  ]),
);
const belebeleUnits = queries.map((query, i) => ({
  text: query.text,
  vector: queryVectors[i],
  language: query.language,
  relevant: new Set([query.target]),
}));
results.push(
  await measure('belebele', belebeleUnits, {
    winzling: () => bench.vector,
    colbertSource: () => passageColbert,
    hybrids: (unit) => ({
      withWinzling: bench.hybrid.get(unit.language),
      withColbert: colbertHybrid.get(unit.language),
    }),
  }),
);
const scanMs = [...passageColbert.scans.values()].reduce((sum, scan) => sum + scan.ms, 0);

// ---- notes ---------------------------------------------------------------------------------------------------------
const notes = SAMPLE_NOTES.map((note, i) => ({
  id: `note-${i + 1}`,
  text: note.text,
  language: codeOfEntry[note.lang],
}));
const winzlingStarted = performance.now();
const noteVectors = await embedder.embedDocuments(notes.map((note) => note.text));
const winzlingDocumentMs = (performance.now() - winzlingStarted) / notes.length;
const noteIndex = createLanguageIndex();
noteIndex.addAll(notes.map((note) => ({ id: note.id, fields: { [note.language]: note.text } })));
const noteLexical = createLexicalRetriever(noteIndex);
const noteWinzling = createVectorRetriever({
  ids: notes.map((note) => note.id),
  vectors: noteVectors,
});
const noteColbert = colbertRetriever(
  notes.map((note) => note.id),
  await encodeDocuments(
    'notes',
    notes.map((note) => note.text),
  ),
);
const noteHybrids = {
  withWinzling: new HybridSearch({ lexical: noteLexical, vector: noteWinzling }),
  withColbert: new HybridSearch({ lexical: noteLexical, vector: noteColbert }),
};
const members = (topics) =>
  new Set(topics.flatMap((topic) => TOPICS[topic].map((n) => `note-${n}`)));
const allNotes = new Set(notes.map((note) => note.id));
const translationUnits = [];
for (const group of Object.values(TOPICS))
  for (const n of group) {
    const ids = new Set(allNotes);
    ids.delete(`note-${n}`);
    const text = notes[n - 1].text;
    translationUnits.push({
      text,
      vector: await embedder.embedQuery(text),
      ids,
      relevant: new Set(group.filter((m) => m !== n).map((m) => `note-${m}`)),
    });
  }
const queryStarted = performance.now();
const authored = [];
for (const query of QUERIES)
  authored.push({
    type: query.type,
    text: query.text,
    vector: await embedder.embedQuery(query.text),
    relevant: members(query.topics),
  });
const winzlingQueryMs = (performance.now() - queryStarted) / QUERIES.length;
const noteSources = {
  winzling: () => noteWinzling,
  colbertSource: () => noteColbert,
  hybrids: () => noteHybrids,
};
results.push(await measure('notes translation', translationUnits, noteSources));
for (const type of ['keyword', 'paraphrase'])
  results.push(
    await measure(
      `notes ${type}`,
      authored.filter((unit) => unit.type === type),
      noteSources,
    ),
  );

// ---- API fixture ---------------------------------------------------------------------------------------------------
const api = JSON.parse(
  await readFile(new URL('../fixtures/api-embeddings.json', import.meta.url), 'utf8'),
);
const apiIndex = new LexicalSearch(apiSearchPreset);
apiIndex.addAll(api.documents);
const apiLexical = createLexicalRetriever(apiIndex, { search: { fuzzy: false } });
const apiWinzling = createVectorRetriever({
  ids: api.documents.map((x) => x.id),
  vectors: api.vectors,
});
const apiColbert = colbertRetriever(
  api.documents.map((x) => x.id),
  await encodeDocuments(
    'api',
    api.documents.map((x) => `${x.fields.symbol}\n${x.fields.description}`),
  ),
);
const apiHybrids = {
  withWinzling: new HybridSearch({ lexical: apiLexical, vector: apiWinzling }),
  withColbert: new HybridSearch({ lexical: apiLexical, vector: apiColbert }),
};
const apiUnits = api.queries.map((query) => ({
  type: query.exact ? 'exact' : 'paraphrase',
  text: query.text,
  vector: query.vector,
  relevant: new Set(
    Object.entries(query.relevant).flatMap(([id, gain]) => (gain === 3 ? [id] : [])),
  ),
}));
const apiSources = {
  winzling: () => apiWinzling,
  colbertSource: () => apiColbert,
  hybrids: () => apiHybrids,
};
for (const type of ['exact', 'paraphrase'])
  results.push(
    await measure(
      `api ${type}`,
      apiUnits.filter((unit) => unit.type === type),
      apiSources,
    ),
  );

await colbert.dispose();
await embedder.dispose();

const tokens = passageMatrices.reduce((sum, m) => sum + m.tokenCount, 0) / passageMatrices.length;
const dimensions = passageMatrices[0].dimensions;
const report = {
  generatedAt: new Date().toISOString(),
  runtime: process.versions.bun
    ? `Bun ${process.versions.bun}`
    : `Node.js ${process.versions.node}`,
  models: {
    winzling: { bytes: bytesOf('winzling'), dimensions: 384, bytesPerDocument: 384 * 4 },
    colbert: {
      bytes: bytesOf('colbert'),
      dimensions,
      tokensPerPassage: tokens,
      bytesPerPassage: tokens * dimensions * 4,
    },
  },
  timings: {
    colbertDocumentMs: timings.colbertDocuments
      ? timings.colbertDocumentMs / timings.colbertDocuments
      : null,
    colbertQueryMs: timings.colbertQueries ? timings.colbertQueryMs / timings.colbertQueries : null,
    colbertScanMsPer2000: scanMs / belebeleUnits.length,
    winzlingDocumentMs,
    winzlingQueryMs,
  },
  results,
};
await mkdir(new URL('../output/bench/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../output/bench/colbert-retrieval.json', import.meta.url),
  JSON.stringify(report, null, 2),
);
const pct = (x) => (100 * x).toFixed(1).padStart(5);
console.log(
  'corpus               n | R@1/R@5: winzling | colbert | efficient+winzling | efficient+colbert',
);
for (const row of results)
  console.log(
    `${row.name.padEnd(18)} ${String(row.queries).padStart(4)} | ${Object.values(row.recall)
      .map((r) => `${pct(r.r1)}/${pct(r.r5)}`)
      .join(' | ')}`,
  );
console.log(JSON.stringify({ models: report.models, timings: report.timings }, null, 1));
log('Wrote output/bench/colbert-retrieval.json');
