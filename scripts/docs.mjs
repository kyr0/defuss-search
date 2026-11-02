import { mkdir, readFile, writeFile, copyFile, rm, readdir } from 'node:fs/promises';
import { marked } from 'marked';
import { codeBlock } from './highlight.mjs';
import { writeRecall } from './recall-docs.mjs';
import { FACTORIES } from '../website/factories.mjs';
import { factoryFiguresPage } from '../website/render.mjs';
/** Build static files with relative URLs, so GitHub project Pages and local hosting agree. */
await mkdir('docs/assets', { recursive: true });
await rm('docs/assets/chunks', { recursive: true, force: true });
await mkdir('docs/data', { recursive: true });
const build = await Bun.build({
  entrypoints: ['website/app.mjs', 'website/search-worker.mjs', 'website/page.mjs'],
  outdir: 'docs/assets',
  target: 'browser',
  format: 'esm',
  splitting: true,
  minify: true,
  naming: { entry: '[name].js', chunk: 'chunks/[name]-[hash].js', asset: '[name].[ext]' },
});
if (!build.success) throw new AggregateError(build.logs, 'Website build failed');
// VERIFIED: the measured recall section is static markup, regenerated from the committed report.
const recall = JSON.parse(await readFile('docs/data/recall.json', 'utf8'));
if (Object.keys(recall.languages).length !== 20)
  throw new Error('The docs require the measured 20-language recall report');
await writeRecall(recall);
// VERIFIED: the picker's figures are static markup from docs/data/strategies.json, so the page shows them before its
// scripts run and scripts/check-project.mjs can compare them with the report.
const strategies = JSON.parse(await readFile('docs/data/strategies.json', 'utf8'));
await writeFile(
  'docs/index.html',
  factoryFiguresPage(await readFile('website/index.html', 'utf8'), FACTORIES, strategies),
);
await copyFile('website/site.css', 'docs/assets/site.css');
await writeFile('docs/.nojekyll', '');
// ORT 1.30 selects a loader according to browser capabilities (JSPI, Asyncify or JSEP).
// Ship every matching loader/wasm pair so deployments do not depend on one test browser.
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
// The Markdown pages share the main page's header, theme switch, highlighted code blocks and footer.
marked.use({ renderer: { code: ({ text, lang }) => codeBlock(text, lang) } });
const head = (await readFile('website/index.html', 'utf8')).match(
  /<link\s+rel="icon"[\s\S]*?<link rel="stylesheet" href="assets\/site.css" \/>/,
)?.[0];
if (!head) throw new Error('website/index.html: the icon, theme script and stylesheet links moved');
const icon = (path) => `<svg class="hs-icon" aria-hidden="true" viewBox="0 0 24 24">${path}</svg>`;
const icons = {
  logo: '<path d="M3 5h7M3 12h5M3 19h7"/><circle cx="16" cy="12" r="4"/><path d="m19 15 2.5 2.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  github:
    '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  back: '<path d="M19 12H5m7 7-7-7 7-7"/>',
};
for (const [page, title] of [
  ['reference', 'API reference'],
  ['pareto', 'Pareto analysis'],
]) {
  const source = await readFile(`docs/${page}.md`, 'utf8');
  const nav = [
    ['index.html#demo', 'Demo'],
    ['reference.html', 'API reference'],
    ['pareto.html', 'Frontier'],
  ]
    .map(
      ([href, label]) =>
        `<li class="nav-menu-item"><a class="nav-menu-link" href="${href}"${href === `${page}.html` ? ' aria-current="page"' : ''}>${label}</a></li>`,
    )
    .join('');
  await writeFile(
    `docs/${page}.html`,
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>defuss-search ${title}</title>
${head}
</head>
<body>
<div class="hs-page">
<header class="mk-header" data-variant="floating"><div class="mk-header-inner"><a href="index.html" class="mk-header-brand">${icon(icons.logo)}<span class="mk-header-name">defuss-search</span></a><nav class="mk-header-nav" aria-label="Main"><ul class="nav-menu-list">${nav}</ul></nav><div class="mk-header-actions"><label class="swap" data-variant="rotate" data-size="sm"><input type="checkbox" id="theme-toggle" aria-label="Dark mode"><span class="swap-on">${icon(icons.moon)}</span><span class="swap-off">${icon(icons.sun)}</span></label><a class="btn" data-variant="ghost" data-size="icon" href="https://github.com/kyr0/defuss-search" aria-label="defuss-search on GitHub">${icon(icons.github)}</a></div></div></header>
<main class="hs-section hs-prose"><a class="btn" data-variant="ghost" data-size="sm" href="index.html">${icon(icons.back)}Back to defuss-search</a>
${marked.parse(source)}</main>
<footer class="mk-footer" style="width:100%"><div class="mk-footer-inner"><div class="mk-footer-bottom"><a href="index.html" class="mk-footer-brand">${icon(icons.logo)}<span class="mk-footer-brand-name">defuss-search</span></a><div class="mk-footer-meta"><p class="mk-footer-copy">© 2026 Aron Homberg (kyr0) · MIT</p></div></div></div></footer>
</div>
<script type="module" src="assets/vendor/all.min.js"></script>
<script type="module" src="assets/page.js"></script>
</body>
</html>
`,
  );
}
console.log(
  `${new Date().toISOString()} INFO Static docs built with ${build.outputs.length} JavaScript assets`,
);
