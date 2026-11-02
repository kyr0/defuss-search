/** Browser half of bench/recall-browser.mjs: the shared recall core with WASM MoEdernColBERT. */
import { createColbertReranker } from 'defuss-vectorsearch/browser.js';
import { createColbertAdapter } from 'defuss-search/colbert';
import { measureRecall } from './recall-core.mjs';

window.measureRecall = async () => {
  const response = await fetch('data.json');
  if (!response.ok) throw new Error(`data.json: HTTP ${response.status}`);
  const data = await response.json();
  // VERIFIED: one thread works, as on static hosts without cross-origin isolation headers.
  const model = createColbertReranker({
    model: '1.5m',
    precision: 'q8',
    device: 'wasm',
    numThreads: 1,
    wasmPaths: new URL('ort/', location.href).href,
    allowRemoteModels: false,
    loadFile: async (file) => {
      const asset = await fetch(`models/colbert/${file}`);
      if (!asset.ok) throw new Error(`models/colbert/${file}: HTTP ${asset.status}`);
      return new Uint8Array(await asset.arrayBuffer());
    },
  });
  const texts = new Map(data.documents.map((x) => [x.id, x.text]));
  try {
    return await measureRecall({
      ...data,
      reranker: createColbertAdapter(model, (id) => texts.get(id), { truncate: true }),
      onProgress: (preset, done, total) => {
        if (done % 250 === 0) console.log(`${preset} ${done}/${total} questions`);
      },
    });
  } finally {
    await model.dispose();
  }
};
