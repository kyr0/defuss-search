/**
 * Fail closed on release mismatches that a source-only TypeScript build cannot observe.
 * VERIFIED: it guards the generated recall figures, the demo corpus and token index against the installed Winzling,
 * the ColBERT and model pins, the Pages workflow that ships the gitignored ONNX Runtime files, and the demo's
 * "highest mean R@5" label against the published means; `make verify` runs it last.
 */
import assert from 'node:assert/strict';
import { searchPreset } from 'defuss-search';
import { readFile, access, readdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { WINZLING_PROFILE } from 'defuss-vectorsearch/onnx.js';
import { releases } from './models.mjs';
import { languageCases } from '../fixtures/languages.mjs';
import {
  K,
  LANGUAGE_GUESS,
  renderLanguageGlance,
  renderLanguageGuess,
  renderRecall,
  renderRecallTable,
} from './recall-docs.mjs';
import { FACTORIES } from '../website/factories.mjs';
import { factoryFiguresPage } from '../website/render.mjs';
import { assetVersion, versionPage } from './website-build.mjs';
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const pkg = await json('package.json');
const provenance = await json('docs/upstreams.json');
for (const peer of provenance.repositories) {
  assert.equal(
    pkg.devDependencies[peer.package],
    peer.version,
    'Recorded release differs from the installed integration target',
  );
  assert.equal((await json(`node_modules/${peer.package}/package.json`)).version, peer.version);
  assert.equal(pkg.peerDependencies[peer.package], `^${peer.version}`);
}
const recall = await json('docs/data/recall.json');
assert.equal(recall.version, pkg.version);
// VERIFIED: docs/data/language-guess.json records the lexicalsearch and defuss-lid versions it measured, so its
// figures must come from this release and the installed ones.
const guessReport = await json('docs/data/language-guess.json');
assert.equal(guessReport.version, pkg.version, 'Rerun bun run bench:language-guess');
assert.equal(
  guessReport.lexicalsearch,
  (await json('node_modules/defuss-lexicalsearch/package.json')).version,
);
assert.equal(guessReport.identifier.version, pkg.devDependencies['defuss-lid']);
assert.deepEqual(
  Object.values(recall.languages).map((x) => x.entry),
  languageCases.map((x) => x.entry),
);
assert.deepEqual(
  recall.presets.map((x) => x.id),
  ['efficient', 'reranked'],
);
assert.deepEqual(
  recall.runtimes.map((x) => x.runtime.split(' ')[0]),
  ['Bun', 'Node.js', 'Chromium'],
  'Publish recall measured on Bun, Node.js and Chromium',
);
for (const preset of recall.presets)
  for (const row of Object.values(preset.languages))
    for (const k of K)
      assert.ok(Number.isFinite(row[`r${k}`]) && row[`r${k}`] >= 0 && row[`r${k}`] <= 1);
// VERIFIED: (mutation probe) generated figures in the website source and README must match the report they claim to show.
for (const [file, pattern, render] of [
  ['website/index.html', /<!-- recall:start -->[\s\S]*<!-- recall:end -->/, renderRecall],
  ['README.md', /<!-- recall-table:start -->[\s\S]*<!-- recall-table:end -->/, renderRecallTable],
  ['README.md', /<!-- languages:start -->[\s\S]*<!-- languages:end -->/, renderLanguageGlance],
  ['docs/languages.md', LANGUAGE_GUESS, (report) => renderLanguageGuess(report, guessReport)],
])
  assert.equal(
    (await readFile(file, 'utf8')).match(pattern)?.[0],
    render(recall),
    `${file} is stale; run make docs`,
  );
// The built page carries the picker's figures as rendered from the strategies report, and every page names the
// version of the scripts beside it, so a browser never mixes two deploys' files (scripts/website-build.mjs).
const version = await assetVersion();
for (const page of ['docs/index.html', 'docs/reference.html', 'docs/pareto.html']) {
  const html = await readFile(page, 'utf8');
  const stamps = [...html.matchAll(/assets\/(?:app|page)\.js\?v=([0-9a-f]+)"/g)].map((m) => m[1]);
  assert.ok(
    stamps.length && stamps.every((stamp) => stamp === version),
    `${page} names scripts version ${stamps} instead of ${version}; run make docs`,
  );
}
assert.ok(
  !(await readFile('docs/assets/search-worker.js', 'utf8')).includes('chunks/'),
  'The worker must not import chunks: a cached worker would request files a later deploy removed',
);
assert.equal(
  versionPage(await readFile('docs/index.html', 'utf8')),
  factoryFiguresPage(
    await readFile('website/index.html', 'utf8'),
    FACTORIES,
    await json('docs/data/strategies.json'),
  ),
  'docs/index.html is stale; run make docs',
);
for (const path of [
  'ARCH.md',
  'bun.lock',
  'mise.toml',
  '.vae/VERIFY.py',
  '.vae/MEMORY.md',
  '.vae/CLI_GIST.md',
  '.github/workflows/verify.yml',
  '.github/workflows/pages.yml',
  'docs/index.html',
  'docs/reference.html',
  'docs/.nojekyll',
  'docs/assets/app.js',
  'docs/assets/search-worker.js',
  'docs/assets/page.js',
  'docs/assets/ort/ort-wasm-simd-threaded.jsep.wasm',
  'docs/data/manifest.json',
  'docs/data/corpus.json.gz',
  'docs/data/vectors.bin.gz',
  'docs/data/tokens.bin.gz',
])
  await access(path);
const makefile = await readFile('Makefile', 'utf8');
for (const verb of [
  'setup',
  'start',
  'stop',
  'status',
  'log',
  'metrics',
  'bench',
  'test',
  'coverage',
  'lint',
  'e2e',
  'verify',
])
  assert.match(makefile, new RegExp(`^${verb}:`, 'm'), `Missing make ${verb}`);
const ci = await readFile('.github/workflows/verify.yml', 'utf8');
assert.ok(ci.includes('make verify') && ci.includes('make setup'));
// docs/assets/ort/ is gitignored, so only a Pages artifact built by `make docs` carries the ONNX Runtime files.
const pages = await readFile('.github/workflows/pages.yml', 'utf8');
assert.ok(
  /push:\s+branches: \[main\]/.test(pages) &&
    pages.includes('run: make docs') &&
    pages.includes('upload-pages-artifact'),
  'pages.yml must build docs/ with make docs on every push to main and deploy that artifact',
);
for (const page of ['docs/index.html', 'docs/reference.html', 'docs/pareto.html']) {
  const html = await readFile(page, 'utf8');
  for (const [, asset] of html.matchAll(/(?:src|href)="(assets\/[^"#?]+)"/g))
    await access(`docs/${asset}`);
}

for (const name of await readdir('node_modules/onnxruntime-web/dist')) {
  if (/^ort-wasm.*\.(?:mjs|wasm)$/.test(name)) await access(`docs/assets/ort/${name}`);
}

// The demo corpus: sizes as recorded, the installed model's vectors and pins, the benchmark's shape.
const demo = await json('docs/data/manifest.json');
for (const key of ['corpus', 'vectors', 'tokens']) {
  const bytes = await readFile(`docs/data/${demo[key].file}`);
  assert.equal(bytes.length, demo[key].bytes, `${demo[key].file} size; run make bench`);
  assert.equal(gunzipSync(bytes).length, demo[key].rawBytes, `${demo[key].file} unpacked size`);
}
assert.equal(
  demo.vectors.rawBytes,
  4 * demo.vectors.dims * (demo.vectors.passages + demo.vectors.queries),
);
const corpus = JSON.parse(gunzipSync(await readFile(`docs/data/${demo.corpus.file}`)));
assert.equal(
  corpus.model,
  WINZLING_PROFILE.fingerprint,
  'Demo vectors come from another Winzling; run make bench',
);
assert.equal(corpus.dataset.sha256, recall.dataset.sha256);
assert.equal(corpus.passages.text.length, demo.vectors.passages);
// The prebuilt token index: one count per passage, the codes of every token, from the pinned ColBERT.
const colbertPin = releases.find((release) => release.name === 'colbert');
assert.equal(
  demo.tokens.model,
  `${colbertPin.id}@${colbertPin.revision}:${colbertPin.files['model_q8.onnx']}`,
  'Demo token index comes from another MoEdernColBERT; run make bench',
);
assert.equal(demo.tokens.documents, corpus.passages.text.length);
assert.equal(
  demo.tokens.rawBytes,
  4 * demo.tokens.documents + demo.tokens.size * demo.tokens.codeBytes,
);
assert.equal(corpus.queries.text.length, demo.vectors.queries);
for (const release of releases) {
  assert.equal(
    demo.models[release.name].base,
    `https://huggingface.co/${release.id}/resolve/${release.revision}/`,
    `${release.name} revision; run make bench`,
  );
  for (const [file, sha256] of Object.entries(release.files)) {
    const entry = demo.models[release.name].files[file];
    assert.equal(entry?.sha256, sha256, `${release.name} ${file} pin; run make bench`);
    assert.ok(Number.isInteger(entry.gzip) && entry.gzip > 0, `${release.name} ${file} gzip size`);
  }
}
const pareto = await json('docs/data/pareto.json');
assert.equal(pareto.version, pkg.version);
// VERIFIED (2026-11-09): reranked led mean R@5 with the vectorsearch 0.2.1 models and fell behind efficient with
// 0.3.1, so the README preset table calls it "Highest mean R@5" exactly while the figures show it.
const fullR5 = Object.fromEntries(pareto.all.results.map((row) => [row.name, row.r5]));
const rerankedLeads =
  recall.presets[1].mean.r5 > recall.presets[0].mean.r5 && fullR5.reranked > fullR5.lexical;
assert.equal(
  /\| Highest mean R@5;/.test(await readFile('README.md', 'utf8')),
  rerankedLeads,
  rerankedLeads
    ? 'Reranked has the highest mean R@5; say so in the README preset table'
    : 'Reranked no longer has the highest mean R@5; update the README preset table',
);
assert.ok(pareto.holdout.frontier.includes('efficient'));
const efficient = searchPreset('efficient'),
  neural = searchPreset('reranked').rerank;
assert.equal(efficient.fusion.k, pareto.selected.fusion.k);
assert.equal(efficient.fusion.weights.lexical, pareto.selected.fusion.lexicalWeight);
assert.equal(neural.k, pareto.selected.neural.k);
assert.equal(neural.weight, pareto.selected.neural.weight);
assert.equal(pareto.selected.neural.gated, true);

// Every built chunk is imported by an entry or another chunk; a second build into docs/assets once left stale ones.
const assets = 'docs/assets';
const chunks = await readdir(`${assets}/chunks`);
const sources = await Promise.all(
  [
    ...(await readdir(assets))
      .filter((file) => file.endsWith('.js'))
      .map((file) => `${assets}/${file}`),
    ...chunks.map((file) => `${assets}/chunks/${file}`),
  ].map(async (file) => [file, await readFile(file, 'utf8')]),
);
for (const chunk of chunks)
  assert.ok(
    sources.some(([file, text]) => !file.endsWith(`/${chunk}`) && text.includes(chunk)),
    `docs/assets/chunks/${chunk} is not imported; rebuild with make docs`,
  );

console.log(
  `${new Date().toISOString()} INFO PASS: release provenance, 20-language recall and frontier, project contracts`,
);
