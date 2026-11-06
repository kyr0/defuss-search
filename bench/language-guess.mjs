/**
 * Recall when the application does not know a question's language: both presets through HybridSearch, BM25 over all
 * 20 language fields, once without a language and once with defuss-lid's major_20 guess passed as the query's
 * `language`, which lexicalsearch turns into a weight on that language's fields. major_20 covers the fixture's 20
 * languages, so every guess names a field. The known-language figures come from bench/recall.mjs (docs/data/recall.json).
 * ColBERT scores are cached per query and passage text in input/language-guess-colbert.json; a rerun needs no model.
 * Output: output/bench/language-guess.json and the snapshot docs/data/language-guess.json, which
 * scripts/recall-docs.mjs renders into docs/languages.md and scripts/check-project.mjs checks.
 * VERIFIED: the run of 2026-11-06 (Bun 1.4.3, defuss-lid 0.5.0, lexicalsearch 0.4.0) guessed 987 of 1,000 languages
 * right; the efficient preset reached 81.6% R@1 without a language and 90.1% with the guess.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { load as loadLanguageIdentifier } from 'defuss-lid/packs/major_20';
import { createColbertReranker } from 'defuss-vectorsearch/onnx.js';
import { createColbertAdapter } from 'defuss-search/colbert';
import { languageCases } from '../fixtures/languages.mjs';
import { downloadModels, loadModelFile } from '../scripts/models.mjs';
import { createCachedColbert } from './corpora.mjs';
import { loadDataset } from './dataset.mjs';
import { loadEmbeddings } from './embeddings.mjs';
import { measureRecall, summarize } from './recall-core.mjs';

const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
const { documents, queries } = await loadDataset();
const { vectors, queryVectors } = await loadEmbeddings({ documents, queries }, log);
const lid = await loadLanguageIdentifier();
const guesses = queries.map((query) => lid.predict(query.text)[0]?.language);
lid.dispose();
const entryOf = Object.fromEntries(languageCases.map((x) => [x.code, x.entry]));
const right = Object.fromEntries(
  languageCases.map(({ code }) => [
    code,
    queries.filter((query, i) => query.language === code && guesses[i] === entryOf[code]).length,
  ]),
);
const { version: lidVersion } = JSON.parse(
  await readFile(new URL('../node_modules/defuss-lid/package.json', import.meta.url), 'utf8'),
);

let model;
const cached = await createCachedColbert(async () => {
  await downloadModels();
  return (model ??= createColbertReranker({
    model: '1.5m',
    precision: 'q8',
    device: 'cpu',
    numThreads: 1,
    loadFile: loadModelFile('colbert'),
    allowRemoteModels: false,
  }));
}, 'language-guess-colbert.json');
const texts = new Map(documents.map((x) => [x.id, x.text]));
const reranker = createColbertAdapter(cached, (id) => texts.get(id), { truncate: true });
const routes = {};
try {
  for (const route of ['all', 'guessed']) {
    const runs = await measureRecall({
      documents,
      queries,
      vectors,
      queryVectors,
      reranker,
      route,
      guesses,
      onProgress: (preset, done, total) => {
        if (done % 500 === 0) log(`${route} ${preset} ${done}/${total} questions`);
      },
    });
    routes[route] = summarize(queries, runs).map(({ id, mean, neuralQueries, languages }) => ({
      id,
      mean,
      neuralQueries,
      languages,
    }));
  }
} finally {
  await cached.save();
  await model?.dispose();
}
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lexical = JSON.parse(
  await readFile(
    new URL('../node_modules/defuss-lexicalsearch/package.json', import.meta.url),
    'utf8',
  ),
).version;
const report = {
  version,
  lexicalsearch: lexical,
  identifier: { package: 'defuss-lid', version: lidVersion, pack: 'major_20' },
  questions: queries.length,
  right,
  routes,
};
await mkdir(new URL('../output/bench/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../output/bench/language-guess.json', import.meta.url),
  JSON.stringify(
    { ...report, runtime: `Bun ${process.versions.bun}`, measuredAt: new Date().toISOString() },
    null,
    2,
  ) + '\n',
);
await writeFile(
  new URL('../docs/data/language-guess.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
const total = Object.values(right).reduce((sum, n) => sum + n, 0);
log(`guessed ${total} of ${queries.length} question languages right`);
for (const [route, presets] of Object.entries(routes))
  for (const p of presets)
    log(
      `${route} ${p.id}: R@1 ${(100 * p.mean.r1).toFixed(1)}% R@5 ${(100 * p.mean.r5).toFixed(1)}%`,
    );
