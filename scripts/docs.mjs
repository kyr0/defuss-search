import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { marked } from 'marked';
import { codeBlock } from './highlight.mjs';
import { writeRecall } from './recall-docs.mjs';
import { renderIndex } from './figures.mjs';
import { renderLlms } from './llms.mjs';
import { bilingual, catalogMap, headingAnchor, localize, plainText } from './localize.mjs';
import { buildWebsite } from './website-build.mjs';
/** Build static files with relative URLs, so GitHub project Pages and local hosting agree. */
await mkdir('docs/assets', { recursive: true });
await mkdir('docs/data', { recursive: true });
// VERIFIED: the measured recall section is static markup, regenerated from the committed report.
const recall = JSON.parse(await readFile('docs/data/recall.json', 'utf8'));
if (Object.keys(recall.languages).length !== 20)
  throw new Error('The docs require the measured 20-language recall report');
await writeRecall(recall);
// VERIFIED: the picker's figures are static markup from docs/data/strategies.json, so the page shows them before its
// scripts run and scripts/check-project.mjs can compare them with the report; the German comes from website/i18n.
const strategies = JSON.parse(await readFile('docs/data/strategies.json', 'utf8'));
await writeFile(
  'docs/index.html',
  await renderIndex(await readFile('website/index.html', 'utf8'), {
    recall,
    strategies,
    manifest: JSON.parse(await readFile('docs/data/manifest.json', 'utf8')),
  }),
);
await writeFile('docs/.nojekyll', '');
// The agent-facing summary at the site root, from the same reports (scripts/llms.mjs).
await writeFile(
  'docs/llms.txt',
  renderLlms({
    pkg: JSON.parse(await readFile('package.json', 'utf8')),
    recall,
    strategies,
    pareto: JSON.parse(await readFile('docs/data/pareto.json', 'utf8')),
    indexSource: await readFile('website/index.html', 'utf8'),
  }),
);
// ORT 1.30 selects a loader according to browser capabilities (JSPI, Asyncify or JSEP).
// Ship every matching loader/wasm pair so deployments do not depend on one test browser.
// The demo's language identifier: defuss-lid's major_20 pack and the CLD3 core it fills, next to the worker.
// VERIFIED: make e2e loads both from assets/lid in Chromium and detects German (2026-11-06).
await mkdir('docs/assets/lid', { recursive: true });
await copyFile(
  'node_modules/defuss-lid/models/cld3-pq-dno/major_20.cld3q',
  'docs/assets/lid/major_20.cld3q',
);
await copyFile(
  'node_modules/defuss-lid/runtime/cld3-core.bin.gz',
  'docs/assets/lid/cld3-core.bin.gz',
);
// Their notices: CLD3's weights (Apache-2.0) as refitted by defuss-lid, and the cld3-asm WebAssembly (MIT).
await copyFile('node_modules/defuss-lid/models/cld3-pq-dno/NOTICE.md', 'docs/assets/lid/NOTICE.md');
for (const name of ['CLD3-Apache-2.0.txt', 'cld3-asm-MIT.txt'])
  await copyFile(`node_modules/defuss-lid/licenses/${name}`, `docs/assets/lid/${name}`);
// The Brotli decoder the demo worker unpacks its data and model files with (defuss-brotli, MIT), with its notices;
// gitignored like the language pack, so the Pages build (make docs) ships it.
await mkdir('docs/assets/brotli', { recursive: true });
await copyFile('node_modules/defuss-brotli/dist/decompressor.wasm', 'docs/assets/brotli/decompressor.wasm');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.txt'])
  await copyFile(`node_modules/defuss-brotli/${name}`, `docs/assets/brotli/${name}`);
await mkdir('docs/assets/ort', { recursive: true });
for (const name of await readdir('node_modules/onnxruntime-web/dist')) {
  if (/^ort-wasm.*\.(?:mjs|wasm)$/.test(name))
    await copyFile(`node_modules/onnxruntime-web/dist/${name}`, `docs/assets/ort/${name}`);
}
// Refresh measured tables only when the matching benchmark exists; a checkout
// without runtime output retains its committed docs/data snapshots.
try {
  await readFile('output/bench/pareto.json');
  await import('./pareto-docs.mjs');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

// The Markdown pages share the main page's head, header, language and theme switches, highlighted code blocks and
// footer. Their body stays English; in German a note says so, and the body keeps lang="en" for screen readers.
/** GitHub's heading slugs, so links that work on GitHub (docs/reference.md#neural-reranking) work here too. */
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
marked.use({
  renderer: {
    code: ({ text, lang }) => codeBlock(text, lang),
    heading({ tokens, depth }) {
      const html = this.parser.parseInline(tokens);
      const text = plainText(html);
      const id = slug(text);
      return `<h${depth} id="${id}">${depth > 1 ? headingAnchor(id, text, text) : ''}${html}</h${depth}>\n`;
    },
  },
});
const source = await readFile('website/index.html', 'utf8');
const head = source.match(/<link\s+rel="icon"[\s\S]*?<link rel="stylesheet" href="assets\/site.css" \/>/)?.[0];
const sprite = source.match(/<svg class="sr-only" aria-hidden="true">[\s\S]*?<\/svg>\n/)?.[0];
if (!head || !sprite) throw new Error('website/index.html: the head links or the icon sprite moved');
const icon = (name) => `<svg class="hs-icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const catalog = catalogMap((await import('../website/i18n/de.mjs')).default);
for (const [page, title, titleDe] of [
  ['reference', 'API reference', 'API-Referenz'],
  ['pareto', 'Pareto analysis', 'Pareto-Analyse'],
]) {
  const markdown = await readFile(`docs/${page}.md`, 'utf8');
  const nav = [
    ['index.html#/demo', 'Demo'],
    ['index.html#/playground', 'Playground'],
    ['reference.html', 'API reference'],
    ['pareto.html', 'Frontier analysis'],
  ]
    .map(
      ([href, label]) =>
        `<li class="nav-menu-item"><a class="nav-menu-link" href="${href}"${href === `${page}.html` ? ' aria-current="page"' : ''} data-t>${label}</a></li>`,
    )
    .join('');
  const html = `<!doctype html>
<html lang="en" data-title-de="defuss-search: ${titleDe}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>defuss-search: ${title}</title>
${head}
</head>
<body data-i18n-component>
${sprite}<div class="hs-page" id="top">
<header class="mk-header" data-variant="floating"><div class="mk-header-inner"><a href="index.html" class="mk-header-brand hs-brand"><svg class="hs-logo" viewBox="0 0 32 32" aria-hidden="true"><circle class="hs-logo-lexical" cx="12.5" cy="13" r="7.5"/><circle class="hs-logo-vector" cx="17.5" cy="13" r="7.5"/><path class="hs-logo-handle" d="m22.6 18.6 6 6"/></svg><span class="mk-header-name">defuss<span class="hs-brand-search">-search</span></span></a><nav class="mk-header-nav" aria-label="Main"><ul class="nav-menu-list">${nav}</ul></nav><div class="mk-header-actions"><div class="toggle-group hs-locale" role="group" aria-label="Language" data-type="single" data-size="xs" data-locale-switch><button class="toggle" type="button" aria-pressed="true" value="en" lang="en"><span aria-hidden="true">EN</span><span class="sr-only">English</span></button><button class="toggle" type="button" aria-pressed="false" value="de" lang="de"><span aria-hidden="true">DE</span><span class="sr-only">Deutsch</span></button></div><label class="swap" data-variant="rotate" data-size="sm"><input type="checkbox" id="theme-toggle" aria-label="Dark mode"><span class="swap-on">${icon('moon')}</span><span class="swap-off">${icon('sun')}</span></label><a class="btn" data-variant="ghost" data-size="icon" href="https://github.com/kyr0/defuss-search" aria-label="defuss-search on GitHub">${icon('github')}</a></div></div></header>
<main class="hs-section hs-prose"><a class="btn" data-variant="ghost" data-size="sm" href="index.html">${icon('arrow')}<span data-t>Back to defuss-search</span></a>
${bilingual('p', 'class="hs-lang-note"', 'lang-note', '', 'Diese Seite gibt es nur auf Englisch: Sie beschreibt die API und ihre Messungen in den Begriffen des Codes.')}
<div lang="en">
${marked.parse(markdown)}</div>
</main>
<footer class="mk-footer" style="width:100%"><div class="mk-footer-inner"><div class="mk-footer-bottom"><a href="index.html" class="mk-footer-brand">${icon('logo')}<span class="mk-footer-brand-name">defuss-search</span></a><div class="mk-footer-meta"><p class="mk-footer-copy" data-t>&copy; 2026 Aron Homberg (kyr0), MIT license.</p></div></div></div></footer>
</div>
<div id="toast-container" class="toast-container" role="region" aria-label="Notifications" data-position="bottom-right"></div>
<script type="module" src="assets/vendor/all.min.js"></script>
<script type="module" src="assets/page.js"></script>
</body>
</html>
`;
  const localized = localize(html, catalog);
  if (localized.missing.length)
    throw new Error(`website/i18n/de.mjs lacks German for ${localized.missing.join(' | ')}`);
  await writeFile(`docs/${page}.html`, localized.html);
}
// Last, because it stamps the pages written above with the version of the scripts it builds.
const version = await buildWebsite('docs');
console.log(`${new Date().toISOString()} INFO Static docs built version=${version}`);
