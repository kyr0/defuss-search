/** VERIFIED: one report shape for every runtime, so scripts/recall-report.mjs can compare them question by question. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { WINZLING_PROFILE } from 'defuss-vectorsearch/onnx.js';
import { datasetSha256, datasetUrl } from './dataset.mjs';
import { summarize, K } from './recall-core.mjs';
const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);

export async function writeRecallReport(name, environment, { documents, queries }, runs) {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const presets = summarize(queries, runs);
  const report = {
    version: pkg.version,
    completedAt: new Date().toISOString(),
    ...environment,
    platform: `${platform()} ${arch()}`,
    peers: {
      lexical: pkg.devDependencies['defuss-lexicalsearch'],
      vector: pkg.devDependencies['defuss-vectorsearch'],
    },
    dataset: {
      url: datasetUrl,
      sha256: datasetSha256,
      passages: documents.length,
      questions: queries.length,
    },
    embedding: WINZLING_PROFILE.fingerprint,
    presets,
    ranks: runs,
  };
  await mkdir('output/bench', { recursive: true });
  await writeFile(`output/bench/recall-${name}.json`, JSON.stringify(report) + '\n');
  for (const preset of presets)
    log(
      `${report.runtime} ${preset.id}: ${K.map((k) => `R@${k} ${(100 * preset.mean[`r${k}`]).toFixed(1)}%`).join(' ')}; neural ${preset.neuralQueries}/${queries.length}`,
    );
  return report;
}
