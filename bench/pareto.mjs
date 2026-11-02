/** VERIFIED: finite quality/work frontier, with query-group development/holdout separation. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { LexicalSearch } from 'defuss-lexicalsearch';
import { fuseRankings, searchPreset } from 'defuss-search';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
import { createColbertAdapter } from 'defuss-search/colbert';
import { createColbertReranker } from 'defuss-vectorsearch/onnx.js';
import { loadDataset, datasetSha256, datasetUrl } from './dataset.mjs';
import { loadEmbeddings } from './embeddings.mjs';
import { languageCases } from '../fixtures/languages.mjs';
import { downloadModels, loadModelFile, releases } from '../scripts/models.mjs';
const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const { documents, queries, languages } = await loadDataset();
const cache = await loadEmbeddings({ documents, queries }, log);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fields = Object.fromEntries(
  await Promise.all(
    languageCases.map(async (x) => [
      x.code,
      { analyzer: (await import(`defuss-lexicalsearch/${x.entry}`)).default },
    ]),
  ),
);
const index = new LexicalSearch({ fields, maxTokenLength: 1024 });
index.addAll(documents);
const lex = new Map(
  languages.map((code) => [code, createLexicalRetriever(index, { search: { fields: [code] } })]),
);
const vector = createVectorRetriever({ ids: documents.map((x) => x.id), vectors: cache.vectors });
const records = [];
for (let i = 0; i < queries.length; i++) {
  const q = { text: queries[i].text, vector: cache.queryVectors[i] };
  const lexical = await lex.get(queries[i].language).retrieve(q, { limit: 25 });
  const dense = await vector.retrieve(q, { limit: 25 });
  const lexicalSecond = await lex
    .get(queries[i].language)
    .rescore(q, { ids: new Set(dense.map((x) => x.id)), limit: dense.length });
  const vectorSecond = await vector.rescore(q, {
    ids: new Set(lexical.map((x) => x.id)),
    limit: lexical.length,
  });
  const cascade = (primary, secondary) => {
    const matched = new Set(secondary.map((x) => x.id));
    return [...secondary, ...primary.filter((x) => !matched.has(x.id))];
  };
  // Evidence for the presets' weak-lexical rule, as the engine computes it (src/pipeline/weak-lexical.ts).
  const top = lexical[0];
  const share = top && (await lex.get(queries[i].language).matchShare(q, top.id));
  const lexicalCosine = top && vectorSecond.find((x) => x.id === top.id)?.score;
  records.push({
    ...queries[i],
    group: Math.floor(i / languages.length),
    lexical,
    vector: dense,
    weak: { share, gap: dense[0] && lexicalCosine !== undefined ? dense[0].score - lexicalCosine : undefined },
    vectorFirst: cascade(dense, lexicalSecond),
    lexicalFirst: cascade(lexical, vectorSecond),
  });
}
const fuse = (row, profile) =>
  fuseRankings(
    [
      { name: 'lexical', hits: row.lexical, weight: profile.lexicalWeight },
      { name: 'vector', hits: row.vector, weight: 1 },
    ],
    { k: profile.k },
  );
/** The presets' weak-lexical rule over a replayed order: the vector first hit moves to the top. */
const rule = searchPreset('efficient').weakLexical;
const weak = (row, order) => {
  const first = row.vector[0];
  if (
    !first ||
    !row.lexical[0] ||
    row.lexical[0].id === first.id ||
    row.weak.share === undefined ||
    !(row.weak.share < rule.share && row.weak.gap > rule.gap)
  )
    return order;
  return [...order.filter((hit) => hit.id === first.id), ...order.filter((hit) => hit.id !== first.id)];
};
const scores = (rows, ranker) => {
  const counts = { queries: rows.length, r1: 0, r5: 0, r10: 0, r25: 0, candidateRecall: 0 };
  for (const row of rows) {
    const rank = ranker(row).findIndex((hit) => hit.id === row.target) + 1;
    for (const k of [1, 5, 10, 25]) counts[`r${k}`] += rank > 0 && rank <= k ? 1 : 0;
    counts.candidateRecall += rank > 0 ? 1 : 0;
  }
  return Object.fromEntries(
    Object.entries(counts).map(([key, n]) => [key, key === 'queries' ? n : n / rows.length]),
  );
};
const quality = ['r1', 'r5', 'r10', 'r25', 'candidateRecall'];
const costs = ['vectorQueries', 'neuralQueries', 'neuralDocuments'];
const dominates = (a, b) =>
  quality.every((k) => a[k] >= b[k]) &&
  costs.every((k) => a[k] <= b[k]) &&
  (quality.some((k) => a[k] > b[k]) || costs.some((k) => a[k] < b[k]));
const frontier = (rows) =>
  rows.filter((row) => !rows.some((other) => dominates(other, row))).map((x) => x.name);
// The same translated question never occurs on both sides of this split.
const development = records.filter((row) => row.group < 25);
const holdout = records.filter((row) => row.group >= 25);
const priority = (a, b) => {
  for (const metric of quality) if (a[metric] !== b[metric]) return b[metric] - a[metric];
  for (const metric of costs) if (a[metric] !== b[metric]) return a[metric] - b[metric];
  return a.name.localeCompare(b.name, 'en');
};
const fusionGrid = [];
for (const k of [0, 1, 5, 10, 20, 60])
  for (const lexicalWeight of [0.25, 0.5, 1, 2, 3, 4]) {
    const p = { name: `rrf-k${k}-lex${lexicalWeight}`, k, lexicalWeight };
    fusionGrid.push({
      ...p,
      ...scores(development, (row) => fuse(row, p)),
      vectorQueries: development.length,
      neuralQueries: 0,
      neuralDocuments: 0,
    });
  }
const selected = [...fusionGrid].sort(priority)[0];
const supplied = searchPreset('efficient');
if (supplied.fusion.k !== selected.k || supplied.fusion.weights.lexical !== selected.lexicalWeight)
  throw new Error(
    `Efficient preset differs from development selection: ${JSON.stringify(selected)}`,
  );
for (const row of records) row.prior = fuse(row, selected);
await mkdir('output/bench', { recursive: true });
log(`Development selected ${selected.name}; preparing real neural scores`);
const neuralKey = hash(
  JSON.stringify({
    datasetSha256,
    model: releases.find((x) => x.name === 'colbert'),
    runtime: process.versions.bun ?? process.version,
    peers: pkg.devDependencies,
    adapter: await readFile('src/adapters/colbert.ts', 'utf8'),
    truncate: true,
    inputs: records.map((r) => [r.text, r.prior.slice(0, 25).map((x) => x.id)]),
  }),
);
let neuralCache;
try {
  neuralCache = JSON.parse(await readFile('input/pareto-neural.json', 'utf8'));
  if (neuralCache.key !== neuralKey || neuralCache.rows.length !== records.length)
    neuralCache = undefined;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const reusedNeuralCache = !!neuralCache;
if (!neuralCache) {
  await downloadModels();
  const model = createColbertReranker({
    model: '1.5m',
    precision: 'q8',
    device: 'cpu',
    numThreads: 1,
    loadFile: loadModelFile('colbert'),
    allowRemoteModels: false,
  });
  const texts = new Map(documents.map((x) => [x.id, x.text]));
  const adapter = createColbertAdapter(model, (id) => texts.get(id), { truncate: true });
  neuralCache = { key: neuralKey, measuredAt: new Date().toISOString(), rows: [] };
  try {
    // Warm model loading is excluded from per-query timings.
    await model.load();
    for (let i = 0; i < records.length; i++) {
      const row = records[i],
        ids = row.prior.slice(0, 25).map((x) => x.id);
      const start = performance.now();
      const hits = await adapter.rerank({ text: row.text }, ids, {});
      neuralCache.rows.push({ hits, ms: performance.now() - start });
      if ((i + 1) % 100 === 0) log(`Neural queries ${i + 1}/${records.length}`);
    }
    await writeFile('input/pareto-neural.json', JSON.stringify(neuralCache));
  } finally {
    await model.dispose();
  }
}
for (let i = 0; i < records.length; i++) {
  const row = records[i],
    raw = neuralCache.rows[i],
    prefix = row.prior.slice(0, 25);
  if (
    raw.hits.length !== prefix.length ||
    new Set(raw.hits.map((x) => x.id)).size !== prefix.length ||
    raw.hits.some((x) => !Number.isFinite(x.score) || !prefix.some((y) => y.id === x.id))
  )
    throw new Error('Invalid neural cache');
  row.neural = raw.hits;
  row.neuralMs = raw.ms;
  // Mirrors the public gate's specified conditions; engine tests verify actual skipped calls.
  row.margin = row.vector.length > 1 ? row.vector[0].score - row.vector[1].score : null;
  row.agrees =
    row.vector[0]?.id === row.prior[0]?.id &&
    (!row.lexical.length || row.lexical[0].id === row.vector[0]?.id);
}
const skipped = (row, p) => p.gated && row.agrees && row.margin !== null && row.margin >= 0.1;
const neuralOrder = (row, p) =>
  skipped(row, p)
    ? row.prior
    : [
        ...fuseRankings(
          [
            { name: 'prior', hits: row.prior.slice(0, 25) },
            { name: 'reranker', hits: row.neural, weight: p.weight },
          ],
          { k: p.k },
        ),
        ...row.prior.slice(25),
      ];
const work = (rows, p) => {
  const active = rows.filter((row) => !skipped(row, p));
  return {
    vectorQueries: rows.length,
    neuralQueries: active.length,
    neuralDocuments: active.reduce((n, row) => n + row.neural.length, 0),
  };
};
const neuralGrid = [];
for (const k of [0, 1, 10, 60])
  for (const weight of [0.25, 0.5, 1, 2])
    for (const gated of [false, true]) {
      const p = { name: `neural-k${k}-w${weight}-${gated ? 'gated' : 'always'}`, k, weight, gated };
      neuralGrid.push({
        ...p,
        ...scores(development, (row) => neuralOrder(row, p)),
        ...work(development, p),
      });
    }
const selectedNeural = [...neuralGrid].sort(priority)[0];
// Freeze both selections before accessing holdout judgments for any profile.
await writeFile(
  'output/bench/selection.json',
  JSON.stringify({ fusion: selected, neural: selectedNeural }, null, 2) + '\n',
);
log(`Development selected ${selectedNeural.name}`);
const profiles = [
  { name: 'lexical', vector: false, rank: (row) => row.lexical },
  { name: 'vector', vector: true, rank: (row) => row.vector },
  { name: 'vector-first', vector: true, rank: (row) => row.vectorFirst },
  {
    name: 'lexical-first',
    vector: (row) => row.lexical.length > 0,
    rank: (row) => row.lexicalFirst,
  },
  { name: 'legacy-fusion', vector: true, rank: (row) => fuse(row, { k: 60, lexicalWeight: 1 }) },
  { name: 'efficient', vector: true, rank: (row) => weak(row, row.prior) },
  {
    name: 'reranked-always',
    vector: true,
    neural: { ...selectedNeural, gated: false },
    rank: (row) => neuralOrder(row, { ...selectedNeural, gated: false }),
  },
  {
    name: 'reranked',
    vector: true,
    neural: selectedNeural,
    rank: (row) => weak(row, neuralOrder(row, selectedNeural)),
  },
];
const evaluate = (rows) => {
  const results = profiles.map((p) => ({
    name: p.name,
    ...scores(rows, p.rank),
    ...(p.neural
      ? work(rows, p.neural)
      : {
          vectorQueries:
            typeof p.vector === 'function'
              ? rows.filter(p.vector).length
              : p.vector
                ? rows.length
                : 0,
          neuralQueries: 0,
          neuralDocuments: 0,
        }),
    summedMeasuredNeuralMs: p.neural
      ? rows.filter((r) => !skipped(r, p.neural)).reduce((s, r) => s + r.neuralMs, 0)
      : 0,
  }));
  return { results, frontier: frontier(results) };
};
const report = {
  version: pkg.version,
  completedAt: new Date().toISOString(),
  runtime: `Bun ${process.versions.bun}`,
  peers: {
    lexical: pkg.devDependencies['defuss-lexicalsearch'],
    vector: pkg.devDependencies['defuss-vectorsearch'],
  },
  dataset: {
    url: datasetUrl,
    sha256: datasetSha256,
    documents: documents.length,
    queries: records.length,
  },
  scope:
    'Finite empirical frontier; maximize R@1/5/10/25 and candidate recall; minimize vector queries, neural queries and neural documents. Not a universal or production optimum.',
  selectionRule:
    'First 25 source question groups (500 translations): descending R@1, R@5, R@10, R@25, candidate recall, then ascending work; stable name tie-break. Last 25 groups (500 translations) held out from selection.',
  queryLanguageKnown: true,
  vectorScope: 'full 2000 documents; same-language gold',
  candidates: 25,
  neural: {
    model: 'MoEdernColBERT 1.5m q8 / CPU',
    truncate: true,
    measuredAt: neuralCache.measuredAt,
    reusedCache: reusedNeuralCache,
    note: 'Raw neural scores measured once per query. Alternative fusions/gates replay those scores. Gated work and summed time are counterfactual savings, not a second end-to-end latency measurement.',
  },
  fusionGrid,
  fusionFrontier: frontier(fusionGrid),
  neuralGrid,
  neuralFrontier: frontier(neuralGrid),
  selected: { fusion: selected, neural: selectedNeural },
  development: evaluate(development),
  holdout: evaluate(holdout),
  all: evaluate(records),
  languages: Object.fromEntries(
    languages.map((code) => [code, evaluate(records.filter((r) => r.language === code))]),
  ),
};
await writeFile('output/bench/pareto.json', JSON.stringify(report, null, 2) + '\n');
await writeFile('output/bench/pareto.done', 'ok\n');
log('PASS: finite frontier, development selection and untouched holdout report saved');
