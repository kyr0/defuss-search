/**
 * R@1, R@5, R@10 and R@25 per query language for both presets, measured end to end through
 * HybridSearch with real Winzling vectors and real MoEdernColBERT inference (native CPU).
 * VERIFIED: runs unchanged under Bun and Node.js; writes output/bench/recall-bun.json or recall-node.json.
 */
import { createColbertReranker } from 'defuss-vectorsearch/onnx.js';
import { createColbertAdapter } from 'defuss-search/colbert';
import { loadDataset } from './dataset.mjs';
import { loadEmbeddings } from './embeddings.mjs';
import { measureRecall } from './recall-core.mjs';
import { writeRecallReport } from './recall-output.mjs';
import { downloadModels, loadModelFile } from '../scripts/models.mjs';
const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
const { documents, queries } = await loadDataset();
const { vectors, queryVectors } = await loadEmbeddings({ documents, queries }, log);
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
const started = performance.now();
let runs;
try {
  runs = await measureRecall({
    documents,
    queries,
    vectors,
    queryVectors,
    reranker: createColbertAdapter(model, (id) => texts.get(id), { truncate: true }),
    onProgress: (preset, done, total) => {
      if (done % 250 === 0) log(`${preset} ${done}/${total} questions`);
    },
  });
} finally {
  await model.dispose();
}
await writeRecallReport(
  process.versions.bun ? 'bun' : 'node',
  {
    runtime: process.versions.bun
      ? `Bun ${process.versions.bun}`
      : `Node.js ${process.versions.node}`,
    icu: process.versions.icu,
    reranker: 'MoEdernColBERT 1.5M q8, onnxruntime-node CPU, 1 thread, truncation on',
    elapsedMs: performance.now() - started,
  },
  { documents, queries },
  runs,
);
