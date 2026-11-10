/**
 * Fail closed on release mismatches that a source-only TypeScript build cannot observe.
 * VERIFIED: it guards the generated recall figures, the demo corpus and token index against the installed Winzling,
 * the ColBERT and model pins, the Pages workflow that ships the gitignored ONNX Runtime files, and the demo's
 * "highest mean R@5" label against the published means; `make verify` runs it last.
 */
import assert from 'node:assert/strict';
import { searchPreset } from 'defuss-search';
import { readFile, access, readdir } from 'node:fs/promises';
import { brotliDecompressSync } from 'node:zlib';
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
import { renderIndex } from './figures.mjs';
import { renderLlms } from './llms.mjs';
import { normalize } from './localize.mjs';
import { assetVersion, versionPage } from './website-build.mjs';
import { MESSAGES } from '../website/messages.mjs';
import catalog from '../website/i18n/de.mjs';
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
const strategiesReport = await json('docs/data/strategies.json');
for (const [file, pattern, render] of [
  [
    'website/index.html',
    /<!-- recall:start -->[\s\S]*<!-- recall:end -->/,
    (report) => renderRecall(report, strategiesReport),
  ],
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
for (const worker of ['search-worker.js', 'playground-worker.js'])
  assert.ok(
    !(await readFile(`docs/assets/${worker}`, 'utf8')).includes('chunks/'),
    `${worker} must not import chunks: a cached worker would request files a later deploy removed`,
  );
assert.equal(
  versionPage(await readFile('docs/index.html', 'utf8')),
  await renderIndex(await readFile('website/index.html', 'utf8'), {
    recall,
    strategies: strategiesReport,
    manifest: JSON.parse(await readFile('docs/data/manifest.json', 'utf8')),
    hero: JSON.parse(await readFile('docs/data/hero-examples.json', 'utf8')),
  }),
  'docs/index.html is stale; run make docs',
);
// docs/llms.txt is what scripts/llms.mjs renders from the committed reports and the main page's example.
assert.equal(
  await readFile('docs/llms.txt', 'utf8'),
  renderLlms({
    pkg,
    recall,
    strategies: strategiesReport,
    pareto: await json('docs/data/pareto.json'),
    indexSource: await readFile('website/index.html', 'utf8'),
  }),
  'docs/llms.txt is stale; run make docs',
);
// The footer's "Built with" names defuss-vae first, then every installed defuss package, and nothing else, not
// the defuss framework itself; each links its site, {name}.defuss.org (the maintainer's rules: the libraries under
// the defuss projects are theirs to credit). Packages without a site keep their npm page.
// VERIFIED: db.defuss.org and env.defuss.org had no DNS record on 2026-11-09; the other sites answered 200.
{
  const NO_SITE = ['defuss-db', 'defuss-env'];
  const column = (await readFile('website/index.html', 'utf8')).match(/data-t>Built with<\/h3>\s*<ul[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? '';
  const links = [...column.matchAll(/href="([^"]+)"[^>]*>([\w.-]+)<svg/g)].map((m) => ({ href: m[1], name: m[2] }));
  const named = links.map((link) => link.name);
  const installed = (await readdir('node_modules')).filter((name) => name.startsWith('defuss-') && name !== 'defuss-search');
  assert.equal(named[0], 'defuss-vae', 'Built with: defuss-vae comes first');
  assert.deepEqual(named.filter((name) => !name.startsWith('defuss-')), [], 'Built with: defuss packages only, not defuss itself');
  assert.deepEqual(installed.filter((name) => !named.includes(name)), [], 'Built with: name every defuss project used');
  for (const { href, name } of links)
    assert.equal(
      href,
      NO_SITE.includes(name) ? `https://www.npmjs.com/package/${name}` : `https://${name.slice('defuss-'.length)}.defuss.org/`,
      `Built with: ${name} links its site`,
    );
}
// The features say "No runtime dependencies", and the badges name the published version.
assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'The page claims a core without dependencies');
for (const [, shown] of (await readFile('website/index.html', 'utf8')).matchAll(/>(?:npm )?v(\d+\.\d+\.\d+)/g))
  assert.equal(shown, pkg.version, `website/index.html shows v${shown}; the package is ${pkg.version}`);
// Every German text reaches a page: each catalog entry appears in a built page's German template or attribute.
const builtPages = await Promise.all(
  ['docs/index.html', 'docs/reference.html', 'docs/pareto.html'].map((page) => readFile(page, 'utf8')),
);
const german = new Set();
for (const html of builtPages) {
  for (const [, text] of html.matchAll(/<template data-i18n-for="[^"]+" data-i18n-locale="de">([\s\S]*?)<\/template>/g))
    // A figure or size slot carries its value on the page (scripts/figures.mjs) and is empty in the catalog.
    german.add(
      normalize(
        text
          .replace(/<span data-fig="([\w-]+)"[^>]*>[^<]*<\/span>/g, '<span data-fig="$1"></span>')
          // a download size too (scripts/figures.mjs fillBytes)
          .replace(/<span data-bytes="(\w+)"[^>]*>[^<]*<\/span>/g, '<span data-bytes="$1"></span>'),
      ),
    );
  for (const [, text] of html.matchAll(/data-i18n-[\w-]+-de="([^"]*)"/g))
    german.add(normalize(text.replace(/&quot;/g, '"').replace(/&amp;/g, '&')));
}
const unused = catalog.filter(([, de]) => !german.has(normalize(de))).map(([en]) => en);
assert.deepEqual(unused, [], 'website/i18n/de.mjs has entries no page uses; remove them');
// Prose in both languages: no dashes or quotes typed as typography, no arrows, check marks, emoji or middle dots.
const BANNED = /[\u2014\u2026\u201a\u201c-\u201f\u2018\u2019\u00b7\u2022\u2190-\u21ff\u2713-\u2718\u2600-\u27bf\u{1f300}-\u{1faff}]| \u2013 /u;
const visible = (html) =>
  html
    .replace(/<(script|style|kbd|pre|code|svg)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]*>/g, ' ');
for (const [where, text] of [
  ...catalog.map(([en, de]) => [`website/i18n/de.mjs: ${en}`, visible(de)]),
  ...Object.entries(MESSAGES).flatMap(([lang, messages]) =>
    Object.entries(messages).map(([key, text]) => [`website/messages.mjs ${lang}.${key}`, text]),
  ),
  ...builtPages.map((html, i) => [['docs/index.html', 'docs/reference.html', 'docs/pareto.html'][i], visible(html)]),
  ['docs/llms.txt', await readFile('docs/llms.txt', 'utf8')],
])
  assert.ok(!BANNED.test(text), `${where}: replace ${JSON.stringify(text.match(BANNED)?.[0])} with plain text`);
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
  'docs/llms.txt',
  'docs/.nojekyll',
  'docs/assets/app.js',
  'docs/assets/search-worker.js',
  'docs/assets/playground-worker.js',
  'docs/assets/page.js',
  'docs/pareto.html',
  'docs/assets/ort/ort-wasm-simd-threaded.jsep.wasm',
  'docs/data/manifest.json',
  'docs/assets/brotli/decompressor.wasm',
  'docs/data/corpus.json.br',
  'docs/data/vectors.bin.br',
  'docs/data/tokens.bin.br',
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
  assert.equal(brotliDecompressSync(bytes).length, demo[key].rawBytes, `${demo[key].file} unpacked size`);
}
assert.equal(
  demo.vectors.rawBytes,
  4 * demo.vectors.dims * (demo.vectors.passages + demo.vectors.queries),
);
const corpus = JSON.parse(brotliDecompressSync(await readFile(`docs/data/${demo.corpus.file}`)));
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
    assert.ok(Number.isInteger(entry.brotli) && entry.brotli > 0, `${release.name} ${file} Brotli size`);
  }
}
// The website's per-language bars and the factory picker's Belebele figures for lexical-only and tiny come from one
// run: 50 questions per language, so the mean over languages equals the corpus share.
for (const id of ['lexical-only', 'tiny']) {
  const rows = Object.values(strategiesReport.languages[id]);
  assert.equal(rows.length, Object.keys(recall.languages).length, `${id} languages`);
  for (const k of K)
    assert.ok(
      Math.abs(
        rows.reduce((sum, row) => sum + row[`r${k}`], 0) / rows.length -
          strategiesReport.corpora.belebele[id][`r${k}`],
      ) < 1e-6,
      `${id} R@${k} per language disagrees with Belebele; run bun run bench:strategies`,
    );
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
// The presets' base fusion is the other languages' selection, their one byLanguage group Winzling's.
const [group] = efficient.fusion.byLanguage;
assert.equal(efficient.fusion.byLanguage.length, 1);
assert.equal(efficient.fusion.k, pareto.selected.fusion.other.k);
assert.equal(efficient.fusion.weights.lexical, pareto.selected.fusion.other.lexicalWeight);
assert.equal(group.k, pareto.selected.fusion.winzling.k);
assert.equal(group.weights.lexical, pareto.selected.fusion.winzling.lexicalWeight);
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
