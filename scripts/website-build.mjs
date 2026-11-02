/**
 * Builds the website's scripts into <docs>/assets and stamps each page's script and stylesheet URLs with a version
 * of this build. `make docs` runs it from the source tree; scripts/package-test.mjs runs it in the tarball consumer
 * (`bun scripts/website-build.mjs <docs>`), so both builds share one configuration.
 * Why: GitHub Pages sends every file with `cache-control: max-age=600`, and each deploy replaces the hashed chunks.
 * VERIFIED: a browser that kept the previous deploy's search-worker.js imported its lazy chunk
 * browser-tcxbxgfd.js, which the new deploy no longer had, and every model load failed (2026-11-02). Two measures:
 * - The worker is one file without chunks, so a cached worker never imports a file a later deploy removed. It grows
 *   from 200 KB plus 350 KB of lazy chunks to 571 KB, which the default tiny factory loads anyway.
 * - `?v=<version>` on app.js, page.js and site.css (app.js passes it on to the worker) gives every build its own
 *   cache entries, so a reload, which revalidates the HTML, never runs the previous build's scripts. A content hash
 *   beats a timestamp: an unchanged build keeps its cached files.
 */
import { createHash } from 'node:crypto';
import { copyFile, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PAGE_ASSET = /((?:src|href)="assets\/(?:app\.js|page\.js|site\.css))(?:\?v=[0-9a-f]+)?"/g;

/** A hash of every built script and the stylesheet, sorted by path. */
export async function assetVersion(docs = 'docs') {
  const assets = join(docs, 'assets');
  const chunks = await readdir(join(assets, 'chunks')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = [
    ...(await readdir(assets)).filter((name) => /\.(?:js|css)$/.test(name)),
    ...chunks.map((name) => `chunks/${name}`),
  ].sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file}\0`).update(await readFile(join(assets, file)));
  return hash.digest('hex').slice(0, 12);
}

/** Points a page's script and stylesheet URLs at one build; without `version`, removes the stamps. */
export const versionPage = (html, version) =>
  html.replace(PAGE_ASSET, version ? `$1?v=${version}"` : '$1"');

/** Builds the scripts and the stylesheet, then stamps every page in `docs`. Bun only. */
export async function buildWebsite(docs = 'docs') {
  const assets = join(docs, 'assets');
  await rm(join(assets, 'chunks'), { recursive: true, force: true });
  const options = { outdir: assets, target: 'browser', format: 'esm', minify: true };
  const builds = [
    // The page entries share chunks; both load them at once, so they expire from a cache together.
    Bun.build({
      ...options,
      entrypoints: ['website/app.mjs', 'website/page.mjs'],
      splitting: true,
      naming: { entry: '[name].js', chunk: 'chunks/[name]-[hash].js', asset: '[name].[ext]' },
    }),
    Bun.build({ ...options, entrypoints: ['website/search-worker.mjs'], splitting: false }),
  ];
  for (const build of await Promise.all(builds))
    if (!build.success) throw new AggregateError(build.logs, 'Website build failed');
  await copyFile('website/site.css', join(assets, 'site.css'));
  const version = await assetVersion(docs);
  for (const name of await readdir(docs))
    if (name.endsWith('.html')) {
      const path = join(docs, name);
      await writeFile(path, versionPage(await readFile(path, 'utf8'), version));
    }
  return version;
}

if (import.meta.main) {
  const version = await buildWebsite(process.argv[2]);
  console.log(`${new Date().toISOString()} INFO Website scripts built version=${version}`);
}
