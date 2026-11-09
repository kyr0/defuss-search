/** Exercise the packed-package website through its public controls and make-managed server. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { K, sortedCodes, percent } from './recall-docs.mjs';
import { releases } from './models.mjs';
const recall = JSON.parse(await readFile('docs/data/recall.json', 'utf8'));
const strategies = JSON.parse(await readFile('docs/data/strategies.json', 'utf8'));
/** VERIFIED: every rendered recall figure equals docs/data/recall.json; nested tabs work by mouse and keys. */
async function checkRecall(page) {
  const visible = (selector) => page.locator(selector).isVisible();
  for (const preset of recall.presets) {
    await page.click(`#recall-tab-${preset.id}`);
    assert.ok(await visible(`#recall-panel-${preset.id}`), preset.id);
    for (const k of K) {
      await page.click(`#recall-tab-${preset.id}-${k}`);
      const panel = page.locator(`#recall-panel-${preset.id}-${k}`);
      assert.ok(await panel.isVisible(), `${preset.id} R@${k}`);
      assert.equal(
        await page.locator(`#recall-tab-${preset.id}-${k}`).getAttribute('aria-selected'),
        'true',
      );
      const rows = await panel
        .locator('.progress-field')
        .evaluateAll((fields) =>
          fields.map((field) => [field.dataset.recall, field.querySelector('output').textContent]),
        );
      assert.deepEqual(
        rows,
        sortedCodes(recall, preset, k).map((code) => [
          code,
          percent(preset.languages[code][`r${k}`]),
        ]),
      );
      assert.equal(
        await page.textContent(`[data-recall-mean="${preset.id}-${k}"]`),
        percent(preset.mean[`r${k}`], 1),
      );
      for (const other of K.filter((x) => x !== k))
        assert.equal(await visible(`#recall-panel-${preset.id}-${other}`), false);
    }
  }
  const [efficient, reranked] = recall.presets;
  const stat = (name) => page.textContent(`[data-recall-stat="${name}"] .mk-stat-value`);
  assert.equal(await stat('r1'), percent(efficient.mean.r1, 1));
  assert.equal(await stat('r5'), percent(efficient.mean.r5, 1));
  assert.equal(await stat('neural'), reranked.neuralQueries.toLocaleString('en'));
  assert.equal(
    await page.textContent('[data-recall-neural]'),
    reranked.neuralQueries.toLocaleString('en'),
  );
  // Keyboard: arrows move and wrap, Home and End jump; each tablist stays independent.
  await page.click('#recall-tab-efficient');
  await page.click('#recall-tab-efficient-5');
  const keys = [
    ['ArrowRight', 10],
    ['End', 25],
    ['ArrowRight', 1],
    ['ArrowLeft', 25],
    ['Home', 1],
  ];
  for (const [key, k] of keys) {
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => document.activeElement.id), `recall-tab-efficient-${k}`);
    assert.ok(await visible(`#recall-panel-efficient-${k}`), `${key} -> R@${k}`);
  }
  assert.ok(await visible('#recall-panel-efficient'));
  assert.equal(await visible('#recall-panel-reranked'), false);
  await page.click('#recall-tab-efficient-5');
}
const run = (verb) =>
  execFileSync('make', [verb], { encoding: 'utf8', env: { ...process.env, PORT: '0' } });
const packaged = JSON.parse(await readFile('output/package-check.json', 'utf8'));
assert.ok(
  packaged.checks.includes('website built against installed tarball'),
  'Run make e2e to build the packed website first',
);
// Do not stop a developer's already-running demo at the end of this test.
assert.ok(run('status').includes('null'), 'Stop the demo with make stop before make e2e');
run('start');
const { url } = JSON.parse(await readFile('tmp/demo.json', 'utf8'));
const live = process.env.DEFUSS_LIVE_BROWSER === '1';
let browser;
const errors = [];
const modelRequests = { colbert: 0, winzling: 0 };
// The token index's size comes from the manifest that scripts/demo-data.mjs wrote for the pinned ColBERT.
const tokenCount = JSON.parse(
  await readFile('docs/data/manifest.json', 'utf8'),
).tokens.size.toLocaleString('en');
try {
  run('status');
  run('log');
  for (const route of [
    '/',
    '/defuss-search/',
    '/defuss-search/reference.html',
    '/defuss-search/pareto.html',
    '/examples/node.mjs',
  ])
    assert.equal((await fetch(url + route)).status, 200, route);
  for (const route of ['/package.json', '/.env', '/.git/config', '/defuss-search/missing.html'])
    assert.equal((await fetch(url + route)).status, 404, route);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.DEFUSS_CHROMIUM || undefined,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  page.on('request', (request) => {
    for (const { name, id } of releases)
      if (request.url().startsWith(`https://huggingface.co/${id}/`)) modelRequests[name] += 1;
  });
  const workers = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('requestfailed', (request) =>
    errors.push(`${request.url()}: ${request.failure()?.errorText}`),
  );
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  // Live runs load the models from Hugging Face, as a visitor would; the default run stays model-free.
  await page.goto(`${url}/defuss-search/${live ? '' : '?models=off'}`);
  await page.waitForFunction(() => window.corpusReady, {}, { timeout: 120000 });
  // The worker shares the page's build version, so the browser cache never pairs two deploys' scripts.
  const stamp = (await page.getAttribute('script[src^="assets/app.js"]', 'src')).split('?v=')[1];
  assert.match(stamp, /^[0-9a-f]{12}$/);
  assert.deepEqual(
    workers.map((url) => new URL(url).pathname.split('/').pop() + new URL(url).search),
    [`search-worker.js?v=${stamp}`],
  );
  assert.equal(
    await page.evaluate(() => crossOriginIsolated),
    false,
    'Exercise the same header constraints as GitHub Pages',
  );
  // The factory picker comes first; its figures are the published strategies benchmark.
  assert.ok(await page.locator('#factory-picker').isVisible());
  assert.ok(await page.isChecked('#factory-tiny'), 'The picker preselects lexical-semantic tiny');
  assert.equal(
    await page.locator('#demo-window').isVisible(),
    false,
    'The demo shows after a pick',
  );
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  for (const [id, row] of [
    ['lexical-only', 'lexical-only'],
    ['tiny', 'tiny'],
    ['semantic', 'efficient'],
  ])
    for (const [figure, corpus] of [
      ['belebele', 'belebele'],
      ['notes', 'notes translation'],
      ['docs-exact', 'api docs exact'],
      ['docs-natural', 'api docs natural'],
    ]) {
      const cells = await page
        .locator(`[data-figure="${id}-${figure}"] td`)
        .evaluateAll((tds) => tds.map((td) => td.textContent));
      const x = strategies.corpora[corpus][row];
      assert.deepEqual(cells, [pct(x.r1), pct(x.r5)], `${id} ${corpus}`);
    }
  /** Picks a factory in the picker and starts the demo; `ready` waits until its indexes are built. */
  const startFactory = async (id, { rerank = true, ready = true } = {}) => {
    if (await page.locator('#demo-window').isVisible()) await page.click('#factory-change');
    assert.ok(await page.locator('#factory-picker').isVisible());
    await page.check(`#factory-${id}`);
    if (id === 'semantic') await page.setChecked('#factory-rerank', rerank);
    await page.click('#factory-start');
    assert.ok(await page.locator('#demo-window').isVisible());
    if (ready) await page.waitForFunction((f) => window.demoReady === f, id, { timeout: 300000 });
  };
  /** Runs an action and returns the next final result of `factory`; `until` waits for a later one. */
  const ask = async (factory, action, until = () => true) => {
    await page.evaluate(() => {
      window.lastSearch = null;
      window.lastError = null;
    });
    await action();
    await page.waitForFunction(
      ([factory, source]) =>
        window.lastError ||
        (window.lastSearch?.factory === factory && new Function('data', source)(window.lastSearch)),
      [factory, `return (${until})(data)`],
      { timeout: 300000 },
    );
    assert.equal(await page.evaluate(() => window.lastError), null);
    return page.evaluate(() => window.lastSearch);
  };
  const done = (data) => data.column.state === 'done';
  /** The one rendered column: its gold-rank figure equals the gold passage's position in the worker's data. */
  const checkColumn = async (data) => {
    assert.equal(await page.locator('#compare .hs-method').count(), 1);
    assert.equal(
      await page.locator('#compare .hs-method').getAttribute('data-method'),
      data.method,
    );
    if (!data.column.hits) return;
    const rank = data.column.hits.findIndex((hit) => hit.id === data.gold.id) + 1;
    assert.equal(
      await page.locator('#compare .hs-figure').first().getAttribute('data-gold-rank'),
      String(rank),
    );
  };
  const fromPalette = async (factory, language, until) => {
    await page.click('[data-command-trigger="cmd"]');
    const item = page.locator(`#cmd-list .command-item[lang="${language}"]`).first();
    const text = await item.textContent();
    const result = await ask(factory, () => item.click(), until);
    assert.equal(result.text, text);
    return result;
  };
  /** The in-browser measurement's per-language R@k, as the page computes the means. */
  const measure = async () => {
    await page.evaluate(() => (window.lastMeasure = null));
    await page.click('#measure-run');
    await page.waitForFunction(
      () => window.lastMeasure || window.lastError,
      {},
      { timeout: 900000 },
    );
    assert.equal(await page.evaluate(() => window.lastError), null);
    return page.evaluate(() => window.lastMeasure);
  };
  const share = (measured, method, code, k) => {
    const own = measured.ranks[method].filter((_, i) => measured.languages[i] === code);
    return own.filter((rank) => rank > 0 && rank <= k).length / own.length;
  };
  const meanOf = (measured, method) =>
    Object.fromEntries(
      K.map((k) => {
        const codes = [...new Set(measured.languages)];
        return [
          `r${k}`,
          codes.reduce((sum, code) => sum + share(measured, method, code, k), 0) / codes.length,
        ];
      }),
    );

  // ---- lexical-only: no model, BM25 per language ----------------------------------------------------------------
  await startFactory('lexical-only');
  const example = await ask('lexical-only', () => page.locator('#examples button').first().click());
  assert.equal(example.text, await page.inputValue('#query'));
  assert.equal(example.method, 'lexical-only');
  assert.ok(done(example));
  await checkColumn(example);
  const german = await fromPalette('lexical-only', 'deu-Latn');
  assert.equal(await page.inputValue('#language'), 'deu_Latn');
  await checkColumn(german);
  // Own text needs no model under lexical-only.
  const question = 'Which animals sleep most of the day?';
  await page.selectOption('#language', 'eng_Latn');
  const typed = await ask(
    'lexical-only',
    async () => {
      await page.fill('#query', question);
      await page.click('#search');
    },
    (data) => data.text === 'Which animals sleep most of the day?',
  );
  assert.ok(done(typed));
  assert.equal(typed.detected, 'eng_Latn');
  // VERIFIED (2026-11-06): a typed question searches the field of the language defuss-lid detects; the menu follows.
  const germanQuestion = 'Welche Tiere schlafen den größten Teil des Tages?';
  const detected = await ask(
    'lexical-only',
    async () => {
      await page.fill('#query', germanQuestion);
      await page.click('#search');
    },
    (data) => data.text === 'Welche Tiere schlafen den größten Teil des Tages?',
  );
  assert.ok(done(detected));
  assert.equal(detected.detected, 'deu_Latn');
  assert.equal(await page.inputValue('#language'), 'deu_Latn');
  assert.match(await page.textContent('#summary-time'), /German detected/);
  // A language picked from the menu overrides the detection.
  const picked = await ask(
    'lexical-only',
    () => page.selectOption('#language', 'eng_Latn'),
    (data) => data.text === 'Welche Tiere schlafen den größten Teil des Tages?' && !data.detected,
  );
  assert.ok(done(picked));
  assert.equal(await page.inputValue('#language'), 'eng_Latn');
  assert.equal(modelRequests.winzling + modelRequests.colbert, 0, 'Lexical-only loads no model');
  // The in-browser measurement reproduces the published lexical-only figures.
  const lexicalMeasure = await measure();
  assert.deepEqual(Object.keys(lexicalMeasure.ranks), ['lexical-only']);
  const lexicalMean = meanOf(lexicalMeasure, 'lexical-only');
  for (const k of K)
    assert.ok(
      Math.abs(lexicalMean[`r${k}`] - strategies.corpora.belebele['lexical-only'][`r${k}`]) < 1e-9,
      `lexical-only R@${k}: browser ${lexicalMean[`r${k}`]}`,
    );
  assert.match(await page.textContent('[data-measure="lexical-only"]'), /same as published/);

  // My data: notes are searchable lexically at once.
  await page.click('#tab-notes');
  // The search form hugs its controls; a stretched form pushed the results 30rem below the search bar.
  const slack = await page.locator('#notes-form').evaluate((form) => {
    const bottom = Math.max(...[...form.children].map((x) => x.getBoundingClientRect().bottom));
    return form.getBoundingClientRect().bottom - bottom;
  });
  assert.ok(slack < 2, `The notes search form is ${slack}px taller than its controls`);
  await page.click('#add-random-notes');
  await page.waitForFunction(
    () => document.querySelector('#notes-count').textContent === '5 notes',
    {},
    {
      timeout: 120000,
    },
  );
  // A German note in its language's field: the stopword "mit" must not make it a lexical hit, its content word must.
  await page.click('#add-note');
  await page.selectOption('#note-6-lang', 'deu_Latn');
  await page.fill(
    '#note-6-text',
    'Rezept: Kartoffelsuppe mit Lauch, Möhren und einem Schuss Sahne.',
  );
  await page.waitForFunction(
    () => document.querySelector('#notes-count').textContent === '6 notes',
    {},
    {
      timeout: 120000,
    },
  );
  const searchNotes = async (text, factory, until = () => true) => {
    await page.evaluate(() => (window.lastNotes = null));
    await page.fill('#notes-query', text);
    await page.waitForFunction(
      ([text, factory, source]) =>
        window.lastNotes?.text === text &&
        window.lastNotes.factory === factory &&
        new Function('data', source)(window.lastNotes),
      [text, factory, `return (${until})(data)`],
      { timeout: 120000 },
    );
    return page.evaluate(() => window.lastNotes);
  };
  const stopword = await searchNotes('Mehr Kontakt mit Tieren', 'lexical-only');
  assert.ok(
    !stopword.column.hits.some((hit) => hit.id === 'note-6'),
    'The German stopword "mit" matched the note',
  );
  const notesResult = await searchNotes('Kartoffelsuppe', 'lexical-only');
  assert.ok(
    notesResult.column.hits.some((hit) => hit.id === 'note-6'),
    'lexical finds "Kartoffelsuppe"',
  );
  // Each note hit explains its score, and its text leads to the note on the board.
  const hit = page.locator('#notes-compare .hs-hit[data-id="note-6"]');
  await hit.locator('.hs-why summary').click();
  assert.match(await hit.locator('.hs-why-body').textContent(), /kartoffelsupp/);
  await hit.locator('.hs-hit-jump').click();
  await page.waitForFunction(() => document.querySelector('#note-6').hasAttribute('data-flash'));
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'note-6-text');
  assert.equal(await page.locator('#notes-compare .hs-method').count(), 1);
  await page.click('#tab-bench');

  // ---- lexical-semantic with the reranker: recorded vectors; ColBERT for the gate's open questions ---------------
  await startFactory('semantic');
  // The question on screen runs again: own text needs Winzling, which loads only on Search.
  const typedSemantic = await ask(
    'semantic',
    () => page.click('#search'),
    live ? done : (data) => data.column.state === 'needs-embedder',
  );
  if (live) assert.ok(typedSemantic.embedMs > 0 && typedSemantic.column.hits.length > 0);
  else assert.ok(await page.locator('#compare [data-load="winzling"]').first().isVisible());
  const recorded = await fromPalette(
    'semantic',
    'jpn-Jpan',
    live ? done : (data) => data.column.state !== 'pending',
  );
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.method, 'reranked');
  await checkColumn(recorded);
  if (!live) {
    assert.equal(
      modelRequests.winzling + modelRequests.colbert,
      0,
      '?models=off must not fetch a model',
    );
    if (recorded.column.state === 'needs-reranker')
      assert.ok(await page.locator('#compare [data-load="colbert"]').first().isVisible());
  }
  // The in-browser benchmark reproduces the published per-language figures.
  const semanticMeasure = await measure();
  const presets = recall.presets.filter((preset) => semanticMeasure.ranks[preset.id]);
  assert.deepEqual(
    presets.map((preset) => preset.id),
    live ? ['efficient', 'reranked'] : ['efficient'],
  );
  for (const preset of presets) {
    for (const code of Object.keys(recall.languages))
      for (const k of K) {
        const value = share(semanticMeasure, preset.id, code, k);
        assert.ok(
          Math.abs(value - preset.languages[code][`r${k}`]) < 1e-9,
          `${preset.id} ${code} R@${k}: browser ${value}, published ${preset.languages[code][`r${k}`]}`,
        );
      }
    assert.match(await page.textContent(`[data-measure="${preset.id}"]`), /same as published/);
  }
  if (live) assert.equal(semanticMeasure.neural, recall.presets[1].neuralQueries);
  assert.equal(modelRequests.winzling > 0, live, 'Winzling loads only in the live run');
  // Notes get Winzling vectors under lexical-semantic.
  await page.click('#tab-notes');
  await page.waitForFunction(
    (embedded) =>
      document.querySelector('#notes-count').textContent === `6 notes · ${embedded} embedded`,
    live ? 6 : 0,
    { timeout: 120000 },
  );
  const semanticNotes = await searchNotes(
    'Kartoffeln mit Gemüse',
    'semantic',
    live ? done : () => true,
  );
  if (live) assert.ok(semanticNotes.column.hits.some((hit) => hit.id === 'note-6'));
  await page.click('#tab-bench');

  // ---- lexical-semantic tiny: the prebuilt token index, MoEdernColBERT encodes the questions in this browser -----
  let tinyMeasure;
  if (live) {
    await startFactory('tiny');
    const tiny = await ask('tiny', () => page.click('#search'), done);
    assert.equal(tiny.method, 'tiny');
    await checkColumn(tiny);
    assert.ok((await page.textContent('#p-tokens-hint')).includes(`${tokenCount} tokens`));
    tinyMeasure = await measure();
    assert.deepEqual(Object.keys(tinyMeasure.ranks), ['tiny']);
    // The prebuilt index with WASM ColBERT query encoding in Chromium reproduces the native Bun benchmark's figures.
    const tinyMean = meanOf(tinyMeasure, 'tiny');
    for (const k of K)
      assert.ok(
        Math.abs(tinyMean[`r${k}`] - strategies.corpora.belebele.tiny[`r${k}`]) < 1e-9,
        `tiny R@${k}: browser ${tinyMean[`r${k}`]}`,
      );
    assert.match(await page.textContent('[data-measure="tiny"]'), /same as published/);
    await page.click('#tab-notes');
    await page.waitForFunction(
      () => document.querySelector('#notes-count').textContent === '6 notes · 6 encoded',
      {},
      { timeout: 120000 },
    );
    await page.click('#tab-bench');
  } else {
    await startFactory('tiny', { ready: false });
    // The prebuilt token index is data, not a model: it loads at the pick also with models off.
    await page.waitForFunction(() => window.tokensReady, {}, { timeout: 120000 });
    assert.ok((await page.textContent('#p-tokens-hint')).includes(`${tokenCount} tokens`));
    const waiting = await ask('tiny', () => page.click('#search'));
    assert.equal(waiting.column.state, 'needs-colbert');
    assert.ok(await page.locator('#compare [data-load="colbert"]').first().isVisible());
    assert.equal(modelRequests.winzling + modelRequests.colbert, 0);
  }
  await page.click('#tab-bench');
  await checkRecall(page);
  assert.equal(await page.locator('#pareto-results tr').count(), 3);
  const dark = await page.locator('html').evaluate((el) => el.classList.contains('dark'));
  await page.click('#theme-toggle');
  assert.notEqual(await page.locator('html').evaluate((el) => el.classList.contains('dark')), dark);
  await page.click('#theme-toggle');
  for (const anchor of ['demo', 'how', 'pareto', 'recall', 'use']) {
    await page.locator(`nav a[href="#${anchor}"]`).click();
    assert.ok(page.url().endsWith(`#${anchor}`));
  }
  // The copy buttons copy the code and the prompt.
  await page.click('.mk-code-block-copy');
  await page.waitForFunction(() => document.querySelector('.mk-code-block-status').textContent);
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /createHybridIndex/);
  await page.click('#copy-prompt');
  await page.waitForFunction(() => document.querySelector('#copy-prompt-status').textContent);
  assert.match(
    await page.evaluate(() => navigator.clipboard.readText()),
    /^Integrate defuss-search/,
  );
  const holdout = JSON.parse(await readFile('docs/data/pareto.json', 'utf8')).holdout.results;
  const rerankedHoldout = holdout.find((row) => row.name === 'reranked');
  assert.equal(
    await page.textContent('[data-pareto="reranked-neural"]'),
    `${rerankedHoldout.neuralQueries} of ${rerankedHoldout.queries}`,
  );
  await mkdir('output/e2e', { recursive: true });
  // Sections fade in when scrolled into view, so a full-page capture would show them blank; capture the demo itself.
  await page.locator('#demo').scrollIntoViewIfNeeded();
  await page.locator('#demo').screenshot({ path: 'output/e2e/demo.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'Mobile overflow',
  );
  // Phones get the sheet menu instead of the header links.
  await page.click('[data-sheet-trigger="hs-menu"]');
  await page.locator('#hs-menu a[href="#how"]').click();
  assert.ok(page.url().endsWith('#how'));
  await page.waitForFunction(() => !document.querySelector('#hs-menu').open);
  await page.screenshot({ path: 'output/e2e/mobile.png', fullPage: true });
  await page.locator('a[href="pareto.html"]').click();
  assert.equal(await page.title(), 'defuss-search Pareto analysis');
  assert.ok(await page.locator('h1').isVisible());
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'Pareto mobile overflow',
  );
  await page.getByRole('link', { name: 'Back to defuss-search' }).click();
  await page.waitForFunction(() => window.corpusReady, {}, { timeout: 120000 });
  await page.locator('a[href="reference.html"]').first().click();
  assert.equal(await page.title(), 'defuss-search API reference');
  assert.ok(await page.locator('h1').isVisible());
  assert.ok(
    (await page.locator('.mk-code-block .mk-code-block-k').count()) > 0,
    'Highlighted code',
  );
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'Reference mobile overflow',
  );
  await page.getByRole('link', { name: 'Back to defuss-search' }).click();
  await page.waitForFunction(() => window.corpusReady, {}, { timeout: 120000 });
  assert.deepEqual(errors, []);
  await writeFile(
    `output/e2e/browser${live ? '-live' : ''}.json`,
    JSON.stringify(
      {
        version: packaged.version,
        completedAt: new Date().toISOString(),
        browser: await browser.version(),
        packedPackage: true,
        projectPagesPrefix: true,
        pages: 3,
        factories: ['lexical-only', 'semantic', 'tiny'],
        modelLoading: live
          ? 'tiny: ColBERT at the pick; semantic: reranker on the first question, embedder on own text'
          : 'off',
        measured: [
          'lexical-only',
          ...presets.map((preset) => preset.id),
          ...(tinyMeasure ? ['tiny'] : []),
        ],
        lexicalOnlyParity: true,
        perLanguageParity: true,
        tiny: tinyMeasure
          ? { browser: meanOf(tinyMeasure, 'tiny'), published: strategies.corpora.belebele.tiny }
          : 'needs MoEdernColBERT (models off)',
        notes: live ? 'lexical, Winzling vectors and ColBERT tokens' : 'lexical',
        recallFigures: recall.presets.length * K.length * Object.keys(recall.languages).length,
        recallKeyboardTabs: true,
        mobile: true,
        live,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `${new Date().toISOString()} INFO PASS: packed website, 3 pages, factory picker, demo with three factories, lexical-only and per-language parity with the published figures, notes, recall figures and tabs${live ? ', real WASM models' : ''}`,
  );
} finally {
  if (browser) await browser.close();
  run('stop');
}
