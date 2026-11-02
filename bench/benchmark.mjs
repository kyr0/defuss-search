/**
 * API-fixture relevance (Recall@10, MRR, nDCG) and vector-scan timing; writes output/benchmark.json
 * and docs/evaluation.md. Recorded Winzling vectors keep it free of model downloads, so CI can run
 * it on every push (VERIFIED: .github/workflows/verify.yml). Neural rows appear only when
 * output/live-node.json matches the package version.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { apiSearchPreset, LexicalSearch } from 'defuss-lexicalsearch';
import { HybridSearch, searchPreset } from 'defuss-search';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
const data = JSON.parse(await readFile('fixtures/api-embeddings.json', 'utf8'));
const index = new LexicalSearch(apiSearchPreset);
index.addAll(data.documents);
const lexical = createLexicalRetriever(index, { exact: { fields: ['symbol'] } }),
  vector = createVectorRetriever({ ids: data.documents.map((x) => x.id), vectors: data.vectors });
const hybrid = new HybridSearch({ lexical, vector });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
let live;
try {
  live = JSON.parse(await readFile('output/live-node.json', 'utf8'));
  if (live.version !== pkg.version) live = undefined;
} catch {
  /* Neural rows only when actual model run is available. */
}
function metrics(ids, relevant, k = 10) {
  const gains = ids.slice(0, k).map((id) => relevant[id] ?? 0),
    ideal = Object.values(relevant)
      .sort((a, b) => b - a)
      .slice(0, k);
  const dcg = (values) =>
    values.reduce((sum, gain, i) => sum + (2 ** gain - 1) / Math.log2(i + 2), 0);
  const first = gains.findIndex((gain) => gain > 0);
  return {
    recall10: gains.filter((x) => x > 0).length / Object.keys(relevant).length,
    mrr10: first < 0 ? 0 : 1 / (first + 1),
    ndcg10: dcg(gains) / dcg(ideal),
    top1: gains[0] > 0 ? 1 : 0,
  };
}
const configurations = [
  ['lexical', async (q) => lexical.retrieve(q, { limit: 25 })],
  ['vector', async (q) => vector.retrieve(q, { limit: 25 })],
  ['efficient', async (q) => hybrid.search(q, { ...searchPreset('efficient'), limit: 100 })],
  [
    'efficient + exact',
    async (q) => hybrid.search(q, { ...searchPreset('efficient'), exact: 'promote', limit: 100 }),
  ],
  ...['vector-first', 'lexical-first', 'fusion'].map((strategy) => [
    strategy,
    async (q) => hybrid.search(q, { strategy, limit: 100 }),
  ]),
  [
    'fusion + exact + coverage',
    async (q) =>
      hybrid.search(q, {
        exact: 'promote',
        balance: { window: 5, lexical: 1, vector: 1 },
        limit: 100,
      }),
  ],
];
if (live)
  for (const strategy of ['vector-first', 'lexical-first', 'fusion'])
    configurations.push([
      `${strategy} + exact + ColBERT`,
      async (q) =>
        live.records.find((row) => row.query === q.text && row.strategy === strategy).reranked,
    ]);
if (live?.presetRecords)
  configurations.push([
    'reranked + exact',
    async (q) =>
      live.presetRecords.find((row) => row.query === q.text && row.preset === 'reranked').response
        .hits,
  ]);
const rows = [];
for (const [name, search] of configurations) {
  const measurements = [];
  for (const q of data.queries) {
    const hits = await search(q);
    measurements.push({
      query: q.text,
      ...metrics(
        hits.map((hit) => hit.id),
        q.relevant,
      ),
      candidateRecall:
        Object.keys(q.relevant).filter((id) => hits.some((hit) => hit.id === id)).length /
        Object.keys(q.relevant).length,
    });
  }
  rows.push({
    name,
    ...Object.fromEntries(
      ['recall10', 'mrr10', 'ndcg10', 'top1', 'candidateRecall'].map((key) => [
        key,
        measurements.reduce((sum, row) => sum + row[key], 0) / measurements.length,
      ]),
    ),
    queries: measurements,
  });
}
// Warm exact-vector/fusion timing on 10k deterministic 64D vectors, no model inference.
let seed = 41;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32 - 0.5;
};
const corpus = Array.from({ length: 10000 }, () => Float32Array.from({ length: 64 }, random));
const names = corpus.map((_, i) => `doc-${String(i).padStart(5, '0')}`);
const timing = [];
for (const strategy of ['exact', 'turboquant']) {
  const started = performance.now();
  const retriever = createVectorRetriever({
    ids: names,
    vectors: corpus,
    strategy,
    refineCandidates: strategy === 'turboquant' ? 100 : 0,
  });
  const buildMs = performance.now() - started;
  const samples = [];
  for (let i = 0; i < 35; i++) {
    const t = performance.now();
    await retriever.retrieve({ text: '', vector: corpus[i] }, { limit: 25 });
    if (i >= 5) samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  timing.push({
    strategy,
    documents: corpus.length,
    dimensions: 64,
    buildMs,
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
    samples: samples.length,
    note: 'Exact adapter sorts scored candidates. TurboQuant scans all rows and refines 100. Both retain float vectors; no ANN sublinear claim.',
  });
}
const report = {
  version: pkg.version,
  runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
  model: data.model.fingerprint,
  documents: data.documents.length,
  queries: data.queries.length,
  warning:
    'Authored illustrative fixture, no held-out tuning or confidence intervals. These results do not establish production superiority. Neural rows include exact promotion; not a pure reranker ablation.',
  rows,
  timing,
};
await mkdir('output', { recursive: true });
await writeFile('output/benchmark.json', JSON.stringify(report, null, 2) + '\n');
const percent = (x) => (100 * x).toFixed(1) + '%';
const markdown = `# Evaluation of v${pkg.version}\n\nVERIFIED: ${report.warning}\n\n${report.documents} API documents, ${report.queries} queries. Real pinned Winzling embeddings. Full details and per-query judgments: \`fixtures/api-corpus.mjs\`, \`output/benchmark.json\`. Scores below use graded relevance for nDCG; any positive grade counts for Recall/MRR. Candidate recall measures this finite retrieved pool.\n\n| Configuration | Recall@10 | MRR@10 | nDCG@10 | Top-1 relevant | Candidate recall |\n|---|---:|---:|---:|---:|---:|\n${rows.map((row) => `| ${row.name} | ${percent(row.recall10)} | ${row.mrr10.toFixed(3)} | ${row.ndcg10.toFixed(3)} | ${percent(row.top1)} | ${percent(row.candidateRecall)} |`).join('\n')}\n\nLatency below excludes embeddings and ColBERT, measured on ${platform()} ${arch()} with ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`}. 10,000 synthetic 64D documents, 5 warmups, 30 samples. These are a reproducibility smoke test, not a general performance guarantee.\n\n| Vector scan | Build ms | Median ms | p95 ms |\n|---|---:|---:|---:|\n${timing.map((row) => `| ${row.strategy} | ${row.buildMs.toFixed(2)} | ${row.medianMs.toFixed(2)} | ${row.p95Ms.toFixed(2)} |`).join('\n')}\n\nExact mode scores and sorts all eligible rows. TurboQuant also scans all rows, then refines 100 float-vector candidates. This adapter retains the original vectors for exact rescoring; it does not claim the memory savings of a quantized-only index.\n`;
await writeFile('docs/evaluation.md', markdown);
console.table(rows.map(({ queries: _queries, ...row }) => row));
