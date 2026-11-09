/**
 * Publishes the figures the website's factory picker and in-browser measurement show: the four searches of
 * output/bench/strategies.json (lexical-only, the tiny strategy's default and lexical-semantic with and without the
 * reranker) per corpus, Belebele per question language for lexical-only and tiny, the index bytes per document and
 * the model sizes, as docs/data/strategies.json.
 * Why a separate file: output/ is not committed, and the website build reads only docs/data/.
 * VERIFIED: scripts/e2e.mjs compares the picker's figures and the in-browser lexical-only measurement with this file.
 */
import { readFile, writeFile } from 'node:fs/promises';

const ROWS = {
  'lexical-only': 'lexical-only',
  'tiny, TurboQuant': 'tiny',
  'lexical-semantic (efficient)': 'efficient',
  'lexical-semantic (reranked)': 'reranked',
};
const report = JSON.parse(
  await readFile(new URL('../output/bench/strategies.json', import.meta.url), 'utf8'),
);
if (!report.languages)
  throw new Error('output/bench/strategies.json lacks per-language rows; rerun bun bench/strategies.mjs');
const manifest = JSON.parse(
  await readFile(new URL('../docs/data/manifest.json', import.meta.url), 'utf8'),
);
const bytes = (name) =>
  Object.values(manifest.models[name].files).reduce((sum, file) => sum + file.bytes, 0);
const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;
const published = {
  generatedAt: report.generatedAt,
  runtime: report.runtime,
  source: 'bun run bench:strategies',
  modelBytes: { colbert: bytes('colbert'), winzling: bytes('winzling') },
  corpora: Object.fromEntries(
    Object.entries(report.table).map(([corpus, rows]) => [
      corpus,
      Object.fromEntries(
        Object.entries(ROWS)
          .filter(([name]) => rows[name])
          .map(([name, id]) => [
            id,
            {
              queries: rows[name].queries,
              ...Object.fromEntries(
                ['r1', 'r5', 'r10', 'r25'].map((k) => [k, round(rows[name][k], 6)]),
              ),
              ms: round(rows[name].ms, 1),
            },
          ]),
      ),
    ]),
  ),
  // Belebele per question language for lexical-only and tiny; lexical-semantic's come from docs/data/recall.json,
  // which three runtimes measured.
  languages: Object.fromEntries(
    ['lexical-only', 'tiny, TurboQuant'].map((name) => [
      ROWS[name],
      Object.fromEntries(
        Object.entries(report.languages[name]).map(([code, row]) => [
          code,
          Object.fromEntries(['r1', 'r5', 'r10', 'r25'].map((k) => [k, round(row[k], 6)])),
        ]),
      ),
    ]),
  ),
  indexBytesPerDocument: Object.fromEntries(
    Object.entries(report.indexBytesPerDocument).map(([corpus, sizes]) => [
      corpus,
      { colbertTurboQuant: Math.round(sizes.colbertTurboQuant), winzlingFloat32: sizes.winzlingFloat32 },
    ]),
  ),
};
await writeFile(
  new URL('../docs/data/strategies.json', import.meta.url),
  JSON.stringify(published, null, 1) + '\n',
);
console.log(`${new Date().toISOString()} INFO wrote docs/data/strategies.json`);
