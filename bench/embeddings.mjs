/** Real Winzling vectors for the pinned fixture, cached under input/ and keyed by dataset and model. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createWinzlingEmbedder, WINZLING_PROFILE } from 'defuss-vectorsearch/onnx.js';
import { datasetSha256 } from './dataset.mjs';
import { downloadModels, loadModelFile } from '../scripts/models.mjs';
const path = 'input/multilingual-vectors.json';
const key = createHash('sha256')
  .update(datasetSha256 + WINZLING_PROFILE.fingerprint)
  .digest('hex');

/** VERIFIED: reuse the cache only when it was made from the same dataset bytes and model files. */
export async function loadEmbeddings({ documents, queries }, log = () => {}) {
  try {
    const cache = JSON.parse(await readFile(path, 'utf8'));
    if (
      cache.key === key &&
      cache.vectors.length === documents.length &&
      cache.queryVectors.length === queries.length
    ) {
      log('Using the dataset/model-keyed embedding cache');
      return { vectors: cache.vectors, queryVectors: cache.queryVectors };
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  await downloadModels();
  const embedder = createWinzlingEmbedder({
    device: 'cpu',
    numThreads: 1,
    loadFile: loadModelFile('winzling'),
    allowRemoteModels: false,
  });
  try {
    log(`Embedding ${documents.length} passages`);
    const vectors = (await embedder.embedDocuments(documents.map((x) => x.text))).map((x) =>
      Array.from(x),
    );
    log(`Embedding ${queries.length} questions`);
    const queryVectors = (await embedder.embedQueries(queries.map((x) => x.text))).map((x) =>
      Array.from(x),
    );
    await mkdir('input', { recursive: true });
    await writeFile(path, JSON.stringify({ key, vectors, queryVectors }));
    return { vectors, queryVectors };
  } finally {
    await embedder.dispose();
  }
}
