/**
 * The recall benchmark in headless Chromium: the same core module, bundled for the browser,
 * with WASM MoEdernColBERT. Pages are served through Playwright routing, so no port opens.
 * Run with Bun (it bundles with Bun.build); writes output/bench/recall-chromium.json.
 */
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { loadDataset } from './dataset.mjs';
import { loadEmbeddings } from './embeddings.mjs';
import { writeRecallReport } from './recall-output.mjs';
import { downloadModels, modelRoot } from '../scripts/models.mjs';
const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
const { documents, queries } = await loadDataset();
const { vectors, queryVectors } = await loadEmbeddings({ documents, queries }, log);
await downloadModels();
const build = await Bun.build({
  entrypoints: ['bench/recall-page.mjs'],
  target: 'browser',
  format: 'esm',
  splitting: true,
});
if (!build.success) throw new AggregateError(build.logs, 'Benchmark page build failed');
const files = new Map(
  await Promise.all(
    build.outputs.map(async (out) => [out.path.replace(/^\.\//, ''), await out.text()]),
  ),
);
const entry = build.outputs.find((out) => out.kind === 'entry-point').path.replace(/^\.\//, '');
const data = JSON.stringify({
  documents: documents.map(({ id, fields, text }) => ({ id, fields, text })),
  queries,
  vectors,
  queryVectors,
});
// VERIFIED: https makes a secure context: the model loader verifies SHA-256 pins with crypto.subtle.
const origin = 'https://recall.bench/';
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.DEFUSS_CHROMIUM || undefined,
});
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
    else log(`chromium ${message.text()}`);
  });
  await page.route(`${origin}**`, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const extension = path.slice(path.lastIndexOf('.'));
    if (path === '')
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><script type="module" src="${entry}"></script>`,
      });
    if (path === 'data.json') return route.fulfill({ contentType: 'application/json', body: data });
    if (files.has(path))
      return route.fulfill({ contentType: 'text/javascript', body: files.get(path) });
    const local = path.startsWith('ort/')
      ? `node_modules/onnxruntime-web/dist/${path.slice(4)}`
      : path.startsWith('models/colbert/') && !path.includes('..')
        ? `${modelRoot}/colbert/${path.slice(15)}`
        : undefined;
    if (!local || local.includes('..')) return route.fulfill({ status: 404, body: 'Not found' });
    try {
      return route.fulfill({
        contentType: types[extension] ?? 'application/octet-stream',
        body: await readFile(local),
      });
    } catch {
      return route.fulfill({ status: 404, body: 'Not found' });
    }
  });
  await page.goto(origin);
  await page.waitForFunction(() => typeof window.measureRecall === 'function');
  const started = performance.now();
  const runs = await page.evaluate(() => window.measureRecall());
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  await writeRecallReport(
    'chromium',
    {
      runtime: `Chromium ${browser.version()}`,
      icu: null,
      reranker: 'MoEdernColBERT 1.5M q8, onnxruntime-web WASM, 1 thread, truncation on',
      elapsedMs: performance.now() - started,
    },
    { documents, queries },
    runs,
  );
} finally {
  await browser.close();
}
