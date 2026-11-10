/**
 * Merge the per-runtime recall reports into docs/data/recall.json. Bun is the reference run;
 * Node.js and Chromium are compared question by question and their differences are published,
 * never hidden. VERIFIED: the frontier report's replayed per-language figures must agree as well.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { languageCases, targetLanguages } from '../fixtures/languages.mjs';
import { K, writeRecall } from './recall-docs.mjs';
import { PRESETS } from '../bench/recall-core.mjs';
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const pkg = await json('package.json');
const reports = await Promise.all(
  ['bun', 'node', 'chromium'].map((name) => json(`output/bench/recall-${name}.json`)),
);
const [reference] = reports;
for (const report of reports)
  if (report.version !== pkg.version || report.dataset.sha256 !== reference.dataset.sha256)
    throw new Error(`Rerun make bench: ${report.runtime} measured another version or dataset`);
const differences = (report) =>
  Object.fromEntries(
    Object.entries(reference.ranks).map(([preset, run]) => [
      preset,
      run.ranks.filter(
        (rank, i) =>
          rank !== report.ranks[preset].ranks[i] ||
          run.neural[i] !== report.ranks[preset].neural[i],
      ).length,
    ]),
  );
// The frontier analysis replays cached neural scores; the end-to-end run must reproduce it.
try {
  const pareto = await json('output/bench/pareto.json');
  if (pareto.version === pkg.version)
    for (const preset of reference.presets)
      for (const [code, row] of Object.entries(preset.languages)) {
        const replay = pareto.languages[code].results.find((r) => r.name === preset.id);
        for (const k of K)
          if (Math.abs(replay[`r${k}`] - row[`r${k}`]) > 1e-12)
            throw new Error(`Frontier replay disagrees: ${preset.id} ${code} R@${k}`);
      }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const recall = {
  version: reference.version,
  dataset: {
    url: reference.dataset.url,
    sha256: reference.dataset.sha256,
    passages: reference.dataset.passages,
    questions: reference.dataset.questions,
    perLanguage: reference.dataset.questions / languageCases.length,
  },
  peers: reference.peers,
  embedding: reference.embedding,
  candidates: 25,
  queryLanguageKnown: true,
  runtimes: reports.map((report) => ({
    runtime: report.runtime,
    icu: report.icu,
    reranker: report.reranker,
    differences: differences(report),
  })),
  languages: Object.fromEntries(
    languageCases.map(({ code, entry, name, analysis }) => [
      code,
      { entry, name, analysis, target: targetLanguages.has(code) },
    ]),
  ),
  // The names and descriptions are code (bench/recall-core.mjs), not measurements: a wording change needs no rerun.
  presets: reference.presets.map((preset) => ({ ...preset, ...PRESETS[preset.id] })),
};
await mkdir('docs/data', { recursive: true });
await writeFile('docs/data/recall.json', JSON.stringify(recall, null, 2) + '\n');
const changed = await writeRecall(recall);
console.log(
  `${new Date().toISOString()} INFO Published docs/data/recall.json; updated ${changed.join(', ') || 'nothing else'}`,
);
