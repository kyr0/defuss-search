/**
 * Renders docs/data/recall.json into the website's "Measured, not promised" section and the README tables; the
 * website's recall card adds lexical-only and tiny per language from docs/data/strategies.json, under a strategy tab
 * bar above the preset tabs. Why two reports rather than running both strategies in bench/recall.mjs: the strategies
 * bench already runs them per question language, and the tiny search encodes every query with ColBERT, which
 * bench/recall.mjs would repeat on Bun, Node.js and Chromium. The footnote says they ran on one runtime.
 * VERIFIED: static markup, so the figures read right without JavaScript; the e2e test compares every rendered
 * figure with the JSON files.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { factoryOf } from '../website/factories.mjs';

export const K = [1, 5, 10, 25];
const DEFAULT_K = 5;
const escape = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char],
  );
export const percent = (share, digits = 0) => `${(100 * share).toFixed(digits)}%`;
const list = (items) =>
  items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const external = (href, text) =>
  `<a href="${href}" target="_blank" rel="noopener">${text}<span class="sr-only"> (opens in a new tab)</span></a>`;

/** Languages by descending R@k; ties keep the dataset's language order. */
export const sortedCodes = (recall, preset, k) => {
  const codes = Object.keys(recall.languages);
  return [...codes].sort(
    (a, b) =>
      preset.languages[b][`r${k}`] - preset.languages[a][`r${k}`] ||
      codes.indexOf(a) - codes.indexOf(b),
  );
};

/** One sentence that states what the cross-runtime comparison found, never more. */
export function determinism(recall) {
  const names = recall.runtimes.map((r) => r.runtime);
  const differing = recall.runtimes.filter((r) => Object.values(r.differences).some((n) => n > 0));
  if (!differing.length)
    return `${list(names)} returned the same rank for each of the ${recall.dataset.questions.toLocaleString('en')} questions under both presets.`;
  return `${differing
    .map(
      (r) =>
        `${r.runtime} differs from ${names[0]} on ${Object.entries(r.differences)
          .map(([p, n]) => `${n} ${p}`)
          .join(' and ')} questions`,
    )
    .join('; ')}.`;
}

/** A tab button; the first of a list carries focus, the others take it by arrow keys. */
const tab = (id, controls, label, selected) =>
  `<button class="tab-trigger" role="tab" aria-selected="${selected}" aria-controls="${controls}" id="${id}"${selected ? '' : ' tabindex="-1"'}>${escape(label)}</button>`;

/** One search's note, its R@k tabs and a bar per language; `row` has id, name, description, languages and mean. */
function renderBody(recall, row, pad) {
  const tabs = K.map((k) =>
    tab(`recall-tab-${row.id}-${k}`, `recall-panel-${row.id}-${k}`, `R@${k}`, k === DEFAULT_K),
  ).join(`\n${pad}      `);
  const panels = K.map((k) => {
    const bars = sortedCodes(recall, row, k)
      .map((code) => {
        const { name, analysis } = recall.languages[code];
        const value = Math.round(100 * row.languages[code][`r${k}`]);
        const id = `r${k}-${row.id}-${code}`;
        return `<div class="progress-field" data-recall="${code}">
${pad}      <div class="progress-header"><span class="progress-label" id="${id}">${escape(name)} <span class="badge" data-variant="outline" data-size="xs">${escape(analysis)}</span></span><output class="progress-value" for="${id}-bar">${value}%</output></div>
${pad}      <progress class="progress" id="${id}-bar" data-size="xs" data-tone="auto" value="${value}" max="100" aria-labelledby="${id}"></progress>
${pad}    </div>`;
      })
      .join(`\n${pad}    `);
    return `<div class="tab-content hs-recall-list" role="tabpanel" id="recall-panel-${row.id}-${k}" aria-labelledby="recall-tab-${row.id}-${k}" data-preset="${row.id}" data-k="${k}" tabindex="0"${k === DEFAULT_K ? '' : ' hidden'}>
${pad}    ${bars}
${pad}  </div>`;
  }).join(`\n${pad}  `);
  const means = K.map(
    (k) =>
      `R@${k} <strong data-recall-mean="${row.id}-${k}">${percent(row.mean[`r${k}`], 1)}</strong>`,
  ).join(' · ');
  const work =
    row.id === 'reranked'
      ? ` ColBERT ran for <strong data-recall-neural>${row.neuralQueries.toLocaleString('en')}</strong> of ${recall.dataset.questions.toLocaleString('en')} questions.`
      : '';
  return `<p class="hs-recall-note">${escape(row.description)} Mean over ${Object.keys(recall.languages).length} languages: ${means}.${work}</p>
${pad}<div class="tabs hs-recall-tabs">
${pad}  <div class="tab-list" role="tablist" aria-label="Recall at k, ${escape(row.name)}" data-size="sm">
${pad}      ${tabs}
${pad}  </div>
${pad}  ${panels}
${pad}</div>`;
}

/** A tab panel around `body`, hidden unless selected. */
const panel = (id, selected, body, pad) =>
  `<div class="tab-content" role="tabpanel" id="recall-panel-${id}" aria-labelledby="recall-tab-${id}" tabindex="0"${selected ? '' : ' hidden'}>
${pad}  ${body}
${pad}</div>`;

/**
 * Lexical-only and the tiny strategy per question language, from docs/data/strategies.json; their names come from
 * the demo's factory list. Lexical-semantic is the recall report's two presets.
 */
function strategyRows(recall, strategies) {
  const codes = Object.keys(recall.languages);
  return ['lexical-only', 'tiny'].map((id) => {
    const languages = strategies.languages?.[id];
    if (!languages || codes.some((code) => !languages[code]))
      throw new Error(
        `docs/data/strategies.json lacks ${id} per language; run bun run bench:strategies`,
      );
    const mean = Object.fromEntries(
      K.map((k) => [
        `r${k}`,
        codes.reduce((sum, code) => sum + languages[code][`r${k}`], 0) / codes.length,
      ]),
    );
    return { id, name: factoryOf(id).title, description: STRATEGY_NOTES[id], languages, mean };
  });
}
const STRATEGY_NOTES = {
  'lexical-only':
    "createLexicalOnlySearch(): BM25 alone over the question's language, with its analyzer and stopwords; no model.",
  tiny: 'createLexicalSemanticTinySearch(): BM25 fused with MoEdernColBERT 1.5M as the only vector model, over a TurboQuant token index of every passage; no Winzling, no reranker.',
};

/** The website section between the recall markers of website/index.html. */
export function renderRecall(recall, strategies) {
  const [reranked, efficient] = ['reranked', 'efficient'].map((id) =>
    recall.presets.find((p) => p.id === id),
  );
  const [lexical, tiny] = strategyRows(recall, strategies);
  const count = Object.keys(recall.languages).length;
  const perfect = Object.keys(recall.languages).filter((code) => reranked.languages[code].r5 === 1);
  const icu = recall.runtimes
    .filter((r) => r.icu)
    .map((r) => `${r.runtime.split(' ')[0]} ${r.icu}`);
  const pad = '            ';
  const strategyTabs = [
    tab('recall-tab-lexical-only', 'recall-panel-lexical-only', lexical.name, false),
    tab('recall-tab-tiny', 'recall-panel-tiny', tiny.name, false),
    tab('recall-tab-semantic', 'recall-panel-semantic', factoryOf('semantic').title, true),
  ].join(`\n${pad}  `);
  const presetTabs = [reranked, efficient]
    .map((p, i) => tab(`recall-tab-${p.id}`, `recall-panel-${p.id}`, p.name, i === 0))
    .join(`\n${pad}      `);
  const semantic = `<div class="tabs hs-recall-tabs">
${pad}    <div class="tab-list" role="tablist" aria-label="Ranking preset" id="recall-tabs">
${pad}      ${presetTabs}
${pad}    </div>
${pad}    ${[reranked, efficient].map((p, i) => panel(p.id, i === 0, renderBody(recall, p, `${pad}      `), `${pad}    `)).join(`\n${pad}    `)}
${pad}  </div>`;
  return `<!-- recall:start -->
        <!-- Generated by scripts/recall-docs.mjs from docs/data/recall.json and docs/data/strategies.json (make bench); run make docs instead of editing. -->
        <!-- prettier-ignore -->
        <section id="recall" class="container hs-section parallax-reveal" aria-labelledby="recall-title">
          <section class="mk-stats" style="width: 100%">
            <div class="mk-stats-layout">
              <div class="mk-stats-copy">
                <div class="mk-stats-head">
                  <h2 class="mk-stats-title" id="recall-title">Measured, not promised<sup class="hs-footnote-mark">*</sup></h2>
                  <p class="mk-stats-desc">Each of the ${recall.dataset.passages.toLocaleString('en')} passages of ${external('https://github.com/kyr0/tiny-embedding-bench/tree/main/datasets/tiny-embedding-bench-v1', 'tiny-embedding-bench-v1')} is indexed once, and ${recall.dataset.questions.toLocaleString('en')} questions in ${count} languages search them. R@k is the share of a language's ${recall.dataset.perLanguage} questions whose gold passage, in the question's language, ranks in the top k. Lexical search knows the question's language; vector search scans every passage, so a question also competes with the ${count - 1} translations of its gold passage. From <code>make bench</code>, version ${escape(recall.version)}.</p>
                </div>
                <div class="mk-stats-grid">
                  <div class="mk-stat" data-recall-stat="r1"><span class="mk-stat-value">${percent(reranked.mean.r1, 1)}</span><span class="mk-stat-label">mean R@1 over ${count} languages with the reranked preset, the default</span></div>
                  <div class="mk-stat" data-recall-stat="r5"><span class="mk-stat-value">${percent(reranked.mean.r5, 1)}</span><span class="mk-stat-label">mean R@5; the gold passage is among the first five results</span></div>
                  <div class="mk-stat" data-recall-stat="neural"><span class="mk-stat-value">${reranked.neuralQueries.toLocaleString('en')}</span><span class="mk-stat-label">of ${recall.dataset.questions.toLocaleString('en')} questions run ColBERT with the reranked preset; the efficient preset runs none and reaches ${percent(efficient.mean.r5, 1)} R@5</span></div>
                  <div class="mk-stat" data-recall-stat="perfect"><span class="mk-stat-value">${perfect.length} of ${count}</span><span class="mk-stat-label">languages reach 100% R@5 with the reranked preset: ${escape(list(perfect.map((code) => recall.languages[code].name)))}</span></div>
                </div>
                <p class="hs-footnote">* Runtime comparison: ${escape(determinism(recall))} Word segmentation for Japanese, Chinese and Thai follows the runtime's ICU data (${escape(icu.join(', '))}). ${escape(lexical.name)} and ${escape(tiny.name)} were measured on ${escape(strategies.runtime)} only, by <code>${escape(strategies.source)}</code>.</p>
              </div>
              <figure class="mk-stats-media card hs-recall">
                <figcaption class="card-header"><h3 class="card-title">Recall by query language</h3><p class="card-description">Share of a language's ${recall.dataset.perLanguage} questions whose gold passage ranks in the top k of ${recall.dataset.passages.toLocaleString('en')}; one question is 2 points. The badge names how the language's lexical analyzer works. Reranking reorders only the top ${recall.candidates}, so R@${recall.candidates} is the same for both presets.</p></figcaption>
                <div class="card-content tabs hs-recall-tabs">
${pad}<div class="tab-list" role="tablist" aria-label="Search strategy" id="recall-strategies">
${pad}  ${strategyTabs}
${pad}</div>
${pad}${panel('lexical-only', false, renderBody(recall, lexical, `${pad}  `), pad)}
${pad}${panel('tiny', false, renderBody(recall, tiny, `${pad}  `), pad)}
${pad}${panel('semantic', true, semantic, pad)}
                </div>
              </figure>
            </div>
          </section>
        </section>
        <!-- recall:end -->`;
}

/** README: per-language R@k for both presets, reranked first and sorted like the website's default tab. */
export function renderRecallTable(recall) {
  const presets = ['reranked', 'efficient'].map((id) => recall.presets.find((p) => p.id === id));
  const row = (cells) => `| ${cells.join(' | ')} |`;
  return [
    '<!-- recall-table:start -->',
    row([
      'Language',
      'Entry',
      'Analysis',
      ...presets.flatMap((p) => K.map((k) => `${p.name} R@${k}`)),
    ]),
    row(['---', '---', '---', ...presets.flatMap(() => K.map(() => '---:'))]),
    ...sortedCodes(recall, presets[0], DEFAULT_K).map((code) => {
      const { name, entry, analysis } = recall.languages[code];
      return row([
        name,
        `\`${entry}\``,
        analysis,
        ...presets.flatMap((p) => K.map((k) => percent(p.languages[code][`r${k}`]))),
      ]);
    }),
    row([
      '**Mean**',
      '',
      '',
      ...presets.flatMap((p) => K.map((k) => `**${percent(p.mean[`r${k}`], 1)}**`)),
    ]),
    '',
    `Runtime comparison: ${determinism(recall)}`,
    '<!-- recall-table:end -->',
  ].join('\n');
}

const METHODS = {
  Snowball: 'Snowball stemming',
  segmenter: 'Word segmentation',
  bigrams: 'Syllable bigrams',
  trigrams: 'Words plus trigrams',
  'tone folding': 'Tone mark folding',
};

/** README: one row per kind of lexical analysis with the default reranked preset's R@5 range. */
export function renderLanguageGlance(recall) {
  const efficient = recall.presets.find((p) => p.id === 'efficient');
  const reranked = recall.presets.find((p) => p.id === 'reranked');
  const codes = Object.keys(recall.languages);
  const rows = Object.entries(METHODS).map(([method, label]) => {
    const group = codes.filter((code) => recall.languages[code].analysis === method);
    if (!group.length) throw new Error(`No language uses ${method}`);
    const values = group.map((code) => reranked.languages[code].r5);
    const low = Math.min(...values),
      high = Math.max(...values);
    return `| ${label} | ${group.map((code) => `\`${recall.languages[code].entry}\``).join(' ')} | ${low === high ? percent(low) : `${percent(low).slice(0, -1)}–${percent(high)}`} |`;
  });
  if (codes.some((code) => !METHODS[recall.languages[code].analysis]))
    throw new Error('A language analysis lacks a README label');
  return [
    '<!-- languages:start -->',
    '| Analysis | Entries | R@5, reranked |',
    '| --- | --- | ---: |',
    ...rows,
    '',
    `Mean over all ${codes.length} languages, reranked preset (the default): **${percent(reranked.mean.r1, 1)}** R@1 and **${percent(reranked.mean.r5, 1)}** R@5, with ColBERT for ${reranked.neuralQueries.toLocaleString('en')} of ${recall.dataset.questions.toLocaleString('en')} questions. The efficient preset runs no ColBERT and reaches ${percent(efficient.mean.r1, 1)} R@1 and ${percent(efficient.mean.r5, 1)} R@5.`,
    '<!-- languages:end -->',
  ].join('\n');
}

export const LANGUAGE_GUESS = /<!-- language-guess:start -->[\s\S]*<!-- language-guess:end -->/;
/**
 * docs/languages.md's figures for a question language the application has to guess: R@5 per language with the
 * guess, then mean R@1 and R@5 with the language unknown, guessed and known. `guess` is docs/data/language-guess.json
 * (bench/language-guess.mjs); the known-language figures come from the recall report of the same release.
 * VERIFIED: scripts/check-project.mjs compares docs/languages.md's block with this output.
 */
export function renderLanguageGuess(recall, guess) {
  if (guess.version !== recall.version)
    throw new Error('Rerun bun run bench:language-guess for this release');
  const pick = (presets) => ['efficient', 'reranked'].map((id) => presets.find((p) => p.id === id));
  const known = pick(recall.presets),
    guessed = pick(guess.routes.guessed),
    unknown = pick(guess.routes.all);
  const codes = Object.keys(recall.languages);
  const total = codes.reduce((sum, code) => sum + guess.right[code], 0);
  const asked = (code) => recall.presets[0].languages[code].questions;
  const row = (cells) => `| ${cells.join(' | ')} |`;
  const means = (presets) => presets.flatMap((p) => [percent(p.mean.r1, 1), percent(p.mean.r5, 1)]);
  const { version, pack } = guess.identifier;
  return [
    '<!-- language-guess:start -->',
    row(['Language', 'Guessed right', 'Efficient R@5', 'Reranked R@5']),
    row(['---', '---:', '---:', '---:']),
    ...codes.map((code) =>
      row([
        recall.languages[code].name,
        `${guess.right[code]} of ${asked(code)}`,
        ...guessed.map((p) => percent(p.languages[code].r5, 1)),
      ]),
    ),
    row([
      '**Mean**',
      `**${total.toLocaleString('en')} of ${guess.questions.toLocaleString('en')}**`,
      ...guessed.map((p) => `**${percent(p.mean.r5, 1)}**`),
    ]),
    '',
    row(['Question language', 'Efficient R@1', 'Efficient R@5', 'Reranked R@1', 'Reranked R@5']),
    row(['---', '---:', '---:', '---:', '---:']),
    row(['Unknown: BM25 over all 20 fields', ...means(unknown)]),
    row([
      `Guessed by defuss-lid ${version} \`${pack}\`, passed as \`language\``,
      ...means(guessed),
    ]),
    row(["Known: BM25 over the question's field", ...means(known)]),
    '<!-- language-guess:end -->',
  ].join('\n');
}

/** Replace the generated parts of website/index.html, README.md and docs/languages.md; return the changed files. */
export async function writeRecall(recall) {
  const guess = JSON.parse(await readFile('docs/data/language-guess.json', 'utf8'));
  const strategies = JSON.parse(await readFile('docs/data/strategies.json', 'utf8'));
  const changed = [];
  for (const [file, pattern, render] of [
    [
      'website/index.html',
      /<!-- recall:start -->[\s\S]*<!-- recall:end -->/,
      (report) => renderRecall(report, strategies),
    ],
    ['README.md', /<!-- recall-table:start -->[\s\S]*<!-- recall-table:end -->/, renderRecallTable],
    ['README.md', /<!-- languages:start -->[\s\S]*<!-- languages:end -->/, renderLanguageGlance],
    ['docs/languages.md', LANGUAGE_GUESS, (report) => renderLanguageGuess(report, guess)],
  ]) {
    const text = await readFile(file, 'utf8');
    if (!pattern.test(text)) throw new Error(`${file} lacks the generated recall markers`);
    const next = text.replace(pattern, () => render(recall));
    if (next !== text) {
      await writeFile(file, next);
      changed.push(file);
    }
  }
  return changed;
}
