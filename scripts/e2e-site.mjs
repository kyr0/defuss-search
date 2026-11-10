/**
 * The landing page around the demo, in a real Chromium on the packed build (scripts/e2e.mjs calls these):
 * - checkSite: section routes and Back/Forward, a heading anchor on every content h2 and none on the consulting
 *   block and the closing call to action, the install switch and its memory, the playground (each example prints
 *   what the same snippet prints in Node.js, an edited snippet, an error, a timeout), every chart and its table
 *   against docs/data, the diagram tabs, the scroll entrances, the hero figures and the credit's model links;
 * - checkLanguagesAndThemes: German from the browser language, the switch and its memory, the subpages in German,
 *   light and dark from the system, screenshots of each in output/e2e/, readability (scripts/e2e-readability.mjs)
 *   in both themes on a desktop and a phone and in German, no rotator or diagram that flickers, and the chosen
 *   search method visible in forced colours, and the hero's rotating line still under reduced motion.
 * Each returns a summary for output/e2e/browser.json.
 * VERIFIED: make e2e runs both on the packed build in Chromium and passes (2026-11-09).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as root from 'defuss-search';
import * as strategiesModule from 'defuss-search/strategies';
import * as indexing from 'defuss-search/indexing';
import * as lexical from 'defuss-search/lexical';
import * as lexicalsearch from 'defuss-lexicalsearch';
import * as en from 'defuss-lexicalsearch/en';
import * as de from 'defuss-lexicalsearch/de';
import { modelBytes } from '../website/factories.mjs';
import { MODEL_FACTS } from './figures.mjs';
import { runSnippet } from '../website/playground-source.mjs';
import { SNIPPETS } from '../website/playground-snippets.mjs';
import { PACKAGE_MANAGERS } from './highlight.mjs';
import { checkReadability } from './e2e-readability.mjs';

// The table of website/playground-worker.mjs, from the packages this repository installs.
const MODULES = {
  'defuss-search': root,
  'defuss-search/strategies': strategiesModule,
  'defuss-search/indexing': indexing,
  'defuss-search/lexical': lexical,
  'defuss-lexicalsearch': lexicalsearch,
  'defuss-lexicalsearch/en': en,
  'defuss-lexicalsearch/de': de,
};
const SETS = [
  'belebele',
  'notes translation',
  'notes paraphrase',
  'notes keyword',
  'api fixture exact',
  'api fixture paraphrase',
  'api docs exact',
  'api docs natural',
];
const FACTORIES = ['lexical-only', 'tiny', 'efficient', 'reranked'];
const number = (tag, value, options) => new Intl.NumberFormat(tag, options).format(value);
const share = (tag, value) =>
  number(tag, value, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const PACKAGES = 'defuss-search defuss-lexicalsearch defuss-vectorsearch';

/** Waits until the router has scrolled `id` to the top of the view (below the floating header). */
async function landsOn(page, id) {
  await page.waitForFunction(
    (id) => {
      const top = document.getElementById(id)?.getBoundingClientRect().top;
      return top !== undefined && top > -8 && top < 160;
    },
    id,
    { timeout: 10000 },
  );
}

export async function checkSite(page, { strategies }) {
  const base = page.url().split('#')[0];
  // ---- hero figures: the reports, in the page's number format ------------------------------------------------
  // The quality card quotes the model cards (scripts/figures.mjs MODEL_FACTS); the size card the manifest and the bases.
  for (const [slot, value] of [
    ['reranker-ndcg', MODEL_FACTS.reranker.ndcg],
    ['reranker-original-ndcg', MODEL_FACTS.reranker.original],
    ['embed-ndcg', MODEL_FACTS.embed.ndcg],
    ['embed-fp32-ndcg', MODEL_FACTS.embed.fp32],
  ])
    assert.equal(await page.textContent(`[data-fig="${slot}"]`), value.toFixed(3), slot);
  const megabytes = (bytes) => `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 1 : 2)} MB`;
  // Beside each figure, how many times better or smaller, from the same numbers.
  const manifestFiles = JSON.parse(await readFile('docs/data/manifest.json', 'utf8')).models;
  const download = (name) => modelBytes(manifestFiles[name].files);
  const notes = strategies.corpora['notes translation'];
  for (const [slot, ratio] of [
    ['translation-times', notes.efficient.r1 / notes['lexical-only'].r1],
    ['colbert-times', MODEL_FACTS.bases.sauerkraut / download('colbert')],
    ['winzling-times', MODEL_FACTS.bases.bekko / download('winzling')],
  ])
    assert.equal(await page.textContent(`[data-fig="${slot}"]`), ratio.toFixed(1), slot);
  // One size card per model: each against its own base model.
  for (const base of ['bekko', 'sauerkraut'])
    assert.equal(await page.textContent(`.hs-usp-vs [data-bytes="${base}"]`), megabytes(MODEL_FACTS.bases[base]));
  // Each card: what it is about, the figure, its comparison, a rule, what was measured and the techniques behind it
  // (the language templates sit between).
  for (const card of await page.locator('.hs-usp').all())
    assert.deepEqual(
      await card.evaluate((el) => [...el.children].filter((x) => !x.matches('.hs-usp-icon, template')).map((x) => x.className)),
      ['badge hs-usp-kicker', 'hs-usp-value', 'hs-usp-vs', 'separator hs-usp-rule', 'hs-usp-label', 'hs-usp-techniques'],
    );
  assert.deepEqual(
    await page.locator('.hs-usp-kicker').allTextContents(),
    ['Accuracy', 'Real-world quality', 'Model compression', 'Model compression'],
  );
  for (const count of await page.locator('.hs-usp-tags').evaluateAll((rows) => rows.map((row) => row.querySelectorAll('.badge').length)))
    assert.ok(count >= 4, `a card names ${count} techniques`);
  // The two model cards link their reproduction code on Hugging Face, at the revisions the demo pins.
  const repro = await page.locator('.hs-usp-repro').evaluateAll((links) => links.map((link) => link.href));
  assert.equal(repro.length, 2);
  for (const model of ['colbert', 'winzling'])
    assert.ok(
      repro.includes(`${manifestFiles[model].base.replace('/resolve/', '/tree/')}reproduce`),
      `${model} links its reproduction code`,
    );
  assert.equal(await page.textContent('[data-fig="translation-r1"]'), share('en', strategies.corpora['notes translation'].efficient.r1));
  assert.equal(
    await page.textContent('[data-fig="translation-lexical-r1"]'),
    share('en', strategies.corpora['notes translation']['lexical-only'].r1),
  );
  // The credit under the figure links the two models the demo loads (their repositories in docs/data/manifest.json).
  const { models } = JSON.parse(await readFile('docs/data/manifest.json', 'utf8'));
  const credit = await page.locator('.hs-hero-credit a').evaluateAll((links) => links.map((link) => link.href));
  for (const model of ['winzling', 'colbert'])
    assert.ok(credit.includes(models[model].base.split('/resolve/')[0]), `the hero credit links ${model}`);
  assert.ok(credit.includes('https://www.linkedin.com/in/aronhomberg/'), 'the hero credit links the author');
  // Each recall strategy names its model download under the strategy tabs, the Brotli sizes of the manifest.
  const manifest = JSON.parse(await readFile('docs/data/manifest.json', 'utf8'));
  const bytes = { colbert: modelBytes(manifest.models.colbert.files), winzling: modelBytes(manifest.models.winzling.files) };
  bytes.models = bytes.colbert + bytes.winzling;
  const downloads = await page.locator('#recall .hs-recall-download [data-bytes]').evaluateAll((nodes) =>
    nodes.map((node) => [node.dataset.bytes, node.textContent]),
  );
  assert.deepEqual(downloads.map(([name]) => name), ['models', 'winzling', 'colbert']);
  for (const [name, text] of downloads)
    assert.equal(text, `${(bytes[name] / 1e6).toFixed(bytes[name] >= 1e7 ? 1 : 2)} MB`, `recall download ${name}`);

  // ---- routes: deep links, the nav, Back and Forward, the old #id addresses ------------------------------------
  const nav = await page.locator('.mk-header-nav a[data-router-link]').evaluateAll((links) =>
    links.map((link) => link.getAttribute('href')),
  );
  assert.deepEqual(nav, ['#/demo', '#/playground', '#/how', '#/performance', '#/recall', '#/use']);
  for (const href of nav) {
    await page.click(`.mk-header-nav a[href="${href}"]`);
    assert.ok(page.url().endsWith(href), href);
    await landsOn(page, href.slice(2));
    assert.equal(await page.getAttribute(`.mk-header-nav a[href="${href}"]`, 'aria-current'), 'location');
  }
  await page.goBack();
  assert.ok(page.url().endsWith('#/recall'), 'Back walks the sections');
  await landsOn(page, 'recall');
  await page.goForward();
  assert.ok(page.url().endsWith('#/use'), 'Forward walks the sections');
  await landsOn(page, 'use');
  // The hero's two links, each clicked again after scrolling away: a link to the current address still scrolls there.
  // VERIFIED defect (2026-11-10): the router left such a click unchanged, so a second "Playground" did nothing.
  for (const href of ['#/demo', '#/demo', '#/playground', '#/playground']) {
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.click(`.hs-hero-actions a[href="${href}"]`);
    assert.ok(page.url().endsWith(href), href);
    await landsOn(page, href.slice(2));
  }
  // Every content h2 of the page carries a heading anchor to its route; one followed lands on its section. The
  // consulting block and the closing call to action are not content and carry none.
  const UNANCHORED = ['enterprise-title', 'get-started-title'];
  const all = await page.locator('main h2').evaluateAll((list) =>
    list.map((h) => ({ id: h.id, anchor: h.querySelector('a.heading-anchor')?.getAttribute('href') })),
  );
  for (const id of UNANCHORED) assert.equal(all.find((h) => h.id === id)?.anchor, undefined, `h2#${id} has an anchor`);
  const headings = all.filter((h) => !UNANCHORED.includes(h.id));
  assert.ok(headings.length >= 7, `${headings.length} h2`);
  for (const heading of headings) assert.ok(heading.anchor?.startsWith('#/'), `h2#${heading.id} has no anchor`);
  for (const target of headings.map((h) => h.anchor.slice(2)))
    assert.ok(await page.locator(`[id="${target}"]`).count(), `anchor #/${target} has no target`);
  await page.locator('#how-title').scrollIntoViewIfNeeded();
  await page.locator('#how-title a.heading-anchor').click();
  assert.ok(page.url().endsWith('#/how'));
  await landsOn(page, 'how');
  for (const [address, id] of [
    ['#/pareto', 'pareto'],
    ['#recall', 'recall'], // from before the routes
  ]) {
    // A fresh load, as from a link on another site.
    await page.goto('about:blank');
    await page.goto(`${base}${address}`);
    await page.waitForFunction(() => window.routerStart);
    if (address === '#recall') assert.ok(page.url().endsWith('#/recall'), 'An old address becomes its route');
    await landsOn(page, id);
  }
  await page.waitForFunction(() => window.corpusReady, {}, { timeout: 120000 });

  // ---- install switch: bun by default, one choice for every block, kept, copied --------------------------------
  const blocks = page.locator('[data-install]');
  assert.equal(await blocks.count(), 2);
  const shown = (i) => blocks.nth(i).locator('pre[data-pm]:visible code').innerText();
  assert.equal(await shown(0), `bun add ${PACKAGES}`);
  const hero = blocks.nth(0);
  await hero.scrollIntoViewIfNeeded();
  for (const [pm, add] of PACKAGE_MANAGERS) {
    await hero.locator(`button[value="${pm}"]`).click();
    await page.waitForFunction((pm) => [...document.querySelectorAll('[data-install]')].every((b) => b.dataset.pm === pm), pm);
    assert.equal(await shown(0), `${add} ${PACKAGES}`);
    assert.equal(await shown(1), `${add} ${PACKAGES}`);
    assert.equal(await hero.locator(`button[value="${pm}"]`).getAttribute('aria-pressed'), 'true');
  }
  // A second press keeps the choice.
  await hero.locator('button[value="yarn"]').click();
  await page.waitForTimeout(50);
  assert.equal(await hero.locator('button[value="yarn"]').getAttribute('aria-pressed'), 'true');
  await hero.locator('[data-copy-install]').click();
  await page.waitForFunction(() => document.querySelector('[data-install] [data-copy-status]').textContent);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `yarn add ${PACKAGES}`);
  await hero.locator('button[value="pnpm"]').click();
  await page.reload();
  await page.waitForFunction(() => window.corpusReady, {}, { timeout: 120000 });
  assert.equal(await shown(1), `pnpm add ${PACKAGES}`, 'The package manager is kept');
  await blocks.nth(0).locator('button[value="bun"]').click();

  // ---- playground: the examples print what Node.js prints, an edit runs, errors and endless loops end ---------
  await page.locator('#playground').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#pg .code-example-editor[data-painted]'), {}, { timeout: 30000 });
  assert.ok((await page.locator('#pg .code-example-paint span[style*="--code-example-dark"]').count()) > 10);
  const run = async (trigger = () => page.click('#pg-run')) => {
    await page.evaluate(() => (window.playgroundResult = null));
    await trigger();
    await page.waitForFunction(() => window.playgroundResult, {}, { timeout: 15000 });
    return page.evaluate(() => window.playgroundResult);
  };
  const examples = await page.locator('#pg-examples button[value]').evaluateAll((list) => list.map((b) => b.value));
  assert.deepEqual(examples, Object.keys(SNIPPETS));
  for (const example of examples) {
    await page.click(`#pg-examples button[value="${example}"]`);
    await page.waitForFunction((code) => document.querySelector('#pg-source').value === code, SNIPPETS[example]);
    const browser = await run();
    const node = await runSnippet(SNIPPETS[example], MODULES);
    assert.equal(browser.error, undefined, `${example}: ${browser.error}`);
    assert.deepEqual(browser.lines, node.lines, `${example} prints the same in the browser and Node.js`);
    assert.equal(
      await page.locator('#pg-output pre:not([data-tone="muted"])').count(),
      node.lines.length,
      `${example} console lines`,
    );
  }
  await page.fill('#pg-source', "import leftPad from 'left-pad';\nconsole.log(leftPad('1', 3));");
  assert.match((await run()).error, /The playground has no module "left-pad"\. Available: defuss-search, /);
  await page.fill('#pg-source', "import { searchPreset } from 'defuss-search';\nconsole.log(searchPreset('efficient').rerank);");
  const edited = await run(() => page.press('#pg-source', 'ControlOrMeta+Enter'));
  assert.deepEqual(edited.lines, [{ level: 'log', text: 'false' }]);
  await page.fill('#pg-source', "throw new Error('no index');");
  assert.equal((await run()).error, 'Error: no index');
  await page.fill('#pg-source', 'while (true) {}');
  const stalled = await run();
  assert.equal(stalled.timeout, true, 'An endless loop ends after five seconds');
  await page.click('#pg-reset');
  const again = await run();
  assert.equal(again.error, undefined, 'The next run starts a new Worker');

  // ---- charts: each table holds the reports' numbers; the controls redraw ------------------------------------
  await page.locator('#performance').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => window.chartsReady, {}, { timeout: 30000 });
  const pareto = JSON.parse(await readFile('docs/data/pareto.json', 'utf8'));
  const sets = SETS.filter((set) => strategies.corpora[set]);
  const quality = await page.locator('[data-chart-table="quality"] tbody tr').evaluateAll((rows) =>
    rows.map((row) => ({ set: row.dataset.row, k: row.dataset.k, cells: [...row.querySelectorAll('td')].map((td) => td.textContent) })),
  );
  assert.equal(quality.length, sets.length * 4);
  for (const row of quality)
    assert.deepEqual(row.cells, FACTORIES.map((id) => share('en', strategies.corpora[row.set][id][row.k])), `${row.set} ${row.k}`);
  const frontier = await page.locator('#pareto-results tr').evaluateAll((rows) => rows.map((row) => row.dataset.row));
  assert.deepEqual(frontier, pareto.holdout.results.filter((row) => pareto.holdout.frontier.includes(row.name)).map((row) => row.name));
  const sizes = await page.locator('[data-chart-table="size"] tbody tr').evaluateAll((rows) =>
    rows.map((row) => [row.dataset.row, ...[...row.querySelectorAll('td')].map((td) => td.textContent)]),
  );
  for (const [corpus, winzling, colbert] of sizes) {
    assert.equal(winzling, number('en', strategies.indexBytesPerDocument[corpus].winzlingFloat32));
    assert.equal(colbert, number('en', strategies.indexBytesPerDocument[corpus].colbertTurboQuant));
  }
  for (const id of ['chart-quality', 'chart-tradeoff', 'chart-size', 'chart-frontier'])
    assert.ok(await page.locator(`#${id} svg`).count(), `${id} is drawn`);
  const state = (id) => page.locator(`#${id}`).evaluate((el) => JSON.parse(el.dataset.state));
  const quality1 = page.locator('#chart-quality-card [data-chart-control="k"] button[value="r1"]');
  await quality1.click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#chart-quality').dataset.state).k === 'r1');
  // Two factories at most, tiny and reranked first: a third press releases the oldest, and the last one stays.
  const series = (id) => page.click(`#chart-quality-card [data-chart-control="series"] button[value="${id}"]`);
  assert.deepEqual((await state('chart-quality')).series, ['tiny', 'reranked']);
  await series('efficient');
  await page.waitForTimeout(50);
  assert.deepEqual((await state('chart-quality')).series, ['efficient', 'reranked']);
  await series('reranked');
  await series('efficient');
  await page.waitForTimeout(50);
  assert.deepEqual((await state('chart-quality')).series, ['efficient']);
  await page.selectOption('#chart-tradeoff-card select[data-chart-control="corpus"]', 'notes translation');
  assert.equal((await state('chart-tradeoff')).corpus, 'notes translation');

  // ---- how it works: two diagrams in tabs ---------------------------------------------------------------------
  await page.locator('#how').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('#how-panel-query').isVisible());
  assert.ok((await page.locator('#pipeline .diagram-node').count()) >= 8);
  await page.click('#how-tab-app');
  assert.ok(await page.locator('#how-panel-app').isVisible());
  assert.equal(await page.locator('#how-panel-query').isVisible(), false);
  await page.click('#how-tab-query');

  // ---- scroll entrances: items start once they are in view ----------------------------------------------------
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#features [data-enter]')].every((item) => item.dataset.dfEntrance),
  );
  // Shortcuts show the modifier of this system.
  const modifiers = await page.locator('kbd[data-mod]').evaluateAll((keys) => [...new Set(keys.map((k) => k.textContent))]);
  assert.deepEqual(modifiers, [(await page.evaluate(() => /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform))) ? '⌘' : 'Ctrl']);
  return {
    routes: nav.length,
    anchors: headings.length,
    installSwitch: PACKAGE_MANAGERS.map(([pm]) => pm),
    playground: [...examples, 'edit', 'error', 'timeout'],
    charts: 4,
    chartRows: quality.length,
    diagrams: 2,
  };
}

/**
 * Nothing on the page shows the same thing twice in a row. VERIFIED (frame sampling, 2026-11-09): the sliding
 * text-rotate rewound through its earlier lines at the end of each loop, and the stepped diagram showed all its
 * parts, hid most, then showed them again. Now every rotator fades one line at a time, and a diagram only adds parts
 * while it plays.
 */
async function checkNoFlicker(page) {
  assert.equal(await page.locator('.text-rotate:not([data-effect="fade"])').count(), 0, 'A sliding rotator rewinds');
  const lines = await page.evaluate(
    () =>
      new Promise((done) => {
        const box = document.querySelector('.hs-flip .text-rotate');
        const items = [...box.querySelectorAll(':scope > span > span')];
        const seen = [];
        const start = performance.now();
        const tick = () => {
          const shown = items.flatMap((item, i) => (Number(getComputedStyle(item).opacity) > 0.5 ? [i] : []));
          const key = shown.join('+');
          if (key && seen.at(-1) !== key) seen.push(key);
          // Past two changes of line: four lines share 18 s, 4.5 s each.
          if (performance.now() - start < 10000) requestAnimationFrame(tick);
          else done({ seen, count: items.length });
        };
        tick();
      }),
  );
  assert.ok(lines.seen.length >= 3, `the rotator showed ${lines.seen}`);
  for (const [i, key] of lines.seen.entries()) {
    assert.match(key, /^\d+$/, `two rotator lines at once: ${key}`);
    if (i) assert.equal(Number(key), (Number(lines.seen[i - 1]) + 1) % lines.count, `rotator order ${lines.seen}`);
  }
  await page.evaluate(() => document.querySelector('#how').scrollIntoView({ behavior: 'instant' }));
  const counts = await page.evaluate(
    () =>
      new Promise((done) => {
        const figure = document.querySelector('#pipeline');
        const counts = [];
        const start = performance.now();
        let played = false;
        const tick = () => {
          const parts = figure.querySelectorAll('.diagram-node, .diagram-group, .diagram-cell, .diagram-wire, .diagram-wire-label');
          const count = [...parts].filter((part) => Number(getComputedStyle(part).opacity) > 0.5).length;
          if (counts.at(-1) !== count) counts.push(count);
          played ||= !!figure.querySelector('[data-step-state="current"]');
          const finished = played && !figure.querySelector('[data-step-state="future"]');
          if (!finished && performance.now() - start < 20000) requestAnimationFrame(tick);
          else done(counts);
        };
        tick();
      }),
  );
  assert.ok(counts.length > 3, `the diagram did not play: ${counts}`);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], `the diagram hid parts again: ${counts}`);
  return { rotator: lines.seen.length, diagram: counts };
}

/** A fresh context: the browser's language and colour scheme, nothing stored. */
async function open(
  browser,
  url,
  { locale, colorScheme, viewport = { width: 1280, height: 900 }, forcedColors, reducedMotion },
  errors,
) {
  const context = await browser.newContext({ locale, colorScheme, viewport, forcedColors, reducedMotion });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${locale}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${locale}: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(url);
  await page.waitForFunction(() => window.routerStart);
  return { context, page };
}

export async function checkLanguagesAndThemes(browser, url, errors) {
  const shots = [];
  // ---- German: from the browser's language, before any choice --------------------------------------------------
  const { context, page } = await open(browser, `${url}?models=off`, { locale: 'de-DE', colorScheme: 'light' }, errors);
  await page.waitForFunction(() => window.corpusReady, {}, { timeout: 120000 });
  assert.equal(await page.getAttribute('html', 'lang'), 'de');
  assert.equal(await page.title(), 'defuss-search: hybride Suche im Browser');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('hs-pending')), false);
  assert.equal((await page.textContent('#hero-title')).trim(), 'Effizient suchen nach exakten Treffern und nach Bedeutung');
  assert.match(await page.textContent('.hs-hero-credit'), /^\s*Lexikalische Suche, Vektorsuche, Fusion und Modell-Inferenz implementiert von Aron Homberg/);
  assert.equal(await page.textContent('.mk-header-nav a[href="#/how"]'), 'So funktioniert es');
  assert.equal(await page.getAttribute('.mk-header-nav', 'aria-label'), 'Hauptmenü');
  assert.equal(await page.getAttribute('#how-title a.heading-anchor', 'aria-label'), 'Link zum Abschnitt: Zweimal abrufen, einmal fusionieren, nur bei Bedarf neu ordnen');
  assert.equal(await page.textContent('[data-fig="reranker-ndcg"]'), MODEL_FACTS.reranker.ndcg.toFixed(3).replace('.', ','));
  // Every translated region has its two templates, and the German one is on screen.
  const regions = await page.evaluate(() => {
    // Numbers inside a region show in the page's format and a modifier key shows Ctrl off Apple systems
    // (website/chrome.mjs), so the comparison leaves their text out.
    const same = (html) => html.replace(/(<[^>]*\bdata-(?:num|mod)\b[^>]*>)[^<]*/g, '$1').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[data-i18n-target]')].map((el) => {
      const name = el.dataset.i18nTarget;
      const de = document.querySelector(`template[data-i18n-for="${name}"][data-i18n-locale="de"]`);
      const en = document.querySelector(`template[data-i18n-for="${name}"][data-i18n-locale="en"]`);
      return { name, de: !!de, en: !!en, shown: de && same(el.innerHTML) === same(de.innerHTML) };
    });
  });
  assert.ok(regions.length > 250, `${regions.length} regions`);
  for (const region of regions) assert.ok(region.de && region.en && region.shown, `region ${region.name}`);
  // Messages a script writes follow the language too.
  assert.equal(await page.textContent('#pg-copy span'), 'Kopieren');
  await page.locator('#hero').screenshot({ path: 'output/e2e/hero-de-light.png' });
  shots.push('hero-de-light');
  // The switch: English now, kept on reload, and German again.
  await page.click('.mk-header .hs-locale button[value="en"]');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal((await page.textContent('#hero-title')).trim(), 'Search efficiently for exact matches and by meaning');
  assert.equal(await page.textContent('#pg-copy span'), 'Copy');
  assert.equal(await page.getAttribute('.mk-header-nav', 'aria-label'), 'Main');
  await page.reload();
  await page.waitForFunction(() => window.routerStart);
  assert.equal(await page.getAttribute('html', 'lang'), 'en', 'The chosen language is kept');
  await page.click('.mk-header .hs-locale button[value="de"]');
  await page.waitForFunction(() => document.documentElement.lang === 'de');
  // The Markdown pages: German chrome and note, English body.
  for (const [file, title] of [
    ['reference.html', 'defuss-search: API-Referenz'],
    ['pareto.html', 'defuss-search: Pareto-Analyse'],
  ]) {
    await page.goto(`${url}${file}`);
    await page.waitForFunction(() => window.routerStart);
    assert.equal(await page.title(), title);
    assert.equal(await page.getAttribute('html', 'lang'), 'de');
    assert.ok(await page.locator('.hs-lang-note').isVisible(), `${file} says its body is English`);
    assert.equal(await page.getAttribute('main > div[lang]', 'lang'), 'en');
    assert.equal((await page.textContent('main > a.btn span')).trim(), 'Zurück zu defuss-search');
    const anchors = await page.locator('main h2 a.heading-anchor').count();
    assert.ok(anchors > 2, `${file} heading anchors`);
  }
  // German words are longer: the size floor, axe and the measured contrast in German too.
  await page.goto(`${url}?models=off`);
  await page.waitForFunction(() => window.routerStart);
  const readability = { 'de-light-desktop': await checkReadability(page, 'de light desktop') };
  await context.close();
  let flicker;

  // ---- themes from the system, English, desktop and phone; screenshots of the main sections ------------------
  for (const colorScheme of ['light', 'dark'])
    for (const [device, viewport] of [
      ['desktop', { width: 1280, height: 900 }],
      ['mobile', { width: 390, height: 844 }],
    ]) {
      const opened = await open(browser, `${url}?models=off`, { locale: 'en-US', colorScheme, viewport }, errors);
      if (colorScheme === 'light' && device === 'desktop') flicker = await checkNoFlicker(opened.page);
      const dark = await opened.page.evaluate(() => document.documentElement.classList.contains('dark'));
      assert.equal(dark, colorScheme === 'dark', `${colorScheme}: the page follows the system`);
      assert.ok(
        await opened.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${device} ${colorScheme}: no horizontal scroll`,
      );
      for (const section of ['hero', 'playground', 'how', 'performance', 'enterprise']) {
        const target = opened.page.locator(`#${section}`);
        await target.scrollIntoViewIfNeeded();
        if (section === 'performance') await opened.page.waitForFunction(() => window.chartsReady, {}, { timeout: 30000 });
        await opened.page.waitForTimeout(400);
        await target.screenshot({ path: `output/e2e/${section}-${colorScheme}-${device}.png` });
        shots.push(`${section}-${colorScheme}-${device}`);
      }
      readability[`en-${colorScheme}-${device}`] = await checkReadability(opened.page, `${colorScheme} ${device}`);
      // On a phone the language switch sits in the menu, where the header bar has no room for it.
      if (device === 'mobile') {
        assert.equal(await opened.page.locator('.mk-header-actions .hs-locale').isVisible(), false);
        await opened.page.click('.mk-header-menu');
        await opened.page.locator('.hs-locale-sheet').waitFor({ state: 'visible' });
        await opened.page.keyboard.press('Escape');
      }
      await opened.context.close();
    }
  // ---- forced colours and reduced motion: gradients drop out, so the chosen method shows in the system
  // highlight; the hero's rotating line holds its first claim without an animation -----------------------------
  {
    const forced = await open(
      browser,
      `${url}?models=off`,
      { locale: 'en-US', colorScheme: 'light', forcedColors: 'active', reducedMotion: 'reduce' },
      errors,
    );
    const claims = await forced.page.evaluate(() =>
      [...document.querySelectorAll('.hs-flip .text-rotate > span > span')].map((line) => ({
        opacity: Number(getComputedStyle(line).opacity),
        animations: line.getAnimations().length,
      })),
    );
    assert.deepEqual(
      claims.map((line) => [line.opacity, line.animations]),
      claims.map((_, i) => [i ? 0 : 1, 0]),
      'reduced motion: the first claim stands still',
    );
    const radio = await forced.page.evaluate(() => {
      const checked = document.querySelector('input[name="factory"]:checked');
      const dot = getComputedStyle(checked, '::after');
      return { image: dot.backgroundImage, color: dot.backgroundColor, ring: getComputedStyle(checked).borderTopColor };
    });
    assert.equal(radio.image, 'none', 'forced colours: no gradient dot');
    // A dropped gradient leaves a colour with zero alpha (Chromium: rgba(255, 255, 255, 0)).
    const clear = (color) => color === 'transparent' || /^rgba\([^)]*,\s*0\)$/.test(color);
    assert.ok(!clear(radio.color), `forced colours: the checked radio shows its dot (${radio.color})`);
    assert.ok(!clear(radio.ring), `forced colours: the checked radio shows its ring (${radio.ring})`);
    await forced.context.close();
  }
  return {
    german: true,
    regions: 'every region has en and de',
    subpages: 2,
    themes: ['light', 'dark'],
    screenshots: shots.length,
    readability,
    flicker,
  };
}
