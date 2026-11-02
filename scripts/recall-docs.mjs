/**
 * Renders docs/data/recall.json into the website's "Measured, not promised" section and the
 * README tables. VERIFIED: static markup, so the figures read right without JavaScript; the e2e test
 * compares every rendered figure with the JSON file.
 */
import { readFile, writeFile } from 'node:fs/promises';

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

function renderPanel(recall, preset, index) {
  const tabs = K.map(
    (k) =>
      `<button class="tab-trigger" role="tab" aria-selected="${k === DEFAULT_K}" aria-controls="recall-panel-${preset.id}-${k}" id="recall-tab-${preset.id}-${k}"${k === DEFAULT_K ? '' : ' tabindex="-1"'}>R@${k}</button>`,
  ).join('\n                  ');
  const panels = K.map((k) => {
    const bars = sortedCodes(recall, preset, k)
      .map((code) => {
        const { name, analysis } = recall.languages[code];
        const value = Math.round(100 * preset.languages[code][`r${k}`]);
        const id = `r${k}-${preset.id}-${code}`;
        return `<div class="progress-field" data-recall="${code}">
                    <div class="progress-header"><span class="progress-label" id="${id}">${escape(name)} <span class="badge" data-variant="outline" data-size="xs">${escape(analysis)}</span></span><output class="progress-value" for="${id}-bar">${value}%</output></div>
                    <progress class="progress" id="${id}-bar" data-size="xs" data-tone="auto" value="${value}" max="100" aria-labelledby="${id}"></progress>
                  </div>`;
      })
      .join('\n                  ');
    return `<div class="tab-content hs-recall-list" role="tabpanel" id="recall-panel-${preset.id}-${k}" aria-labelledby="recall-tab-${preset.id}-${k}" data-preset="${preset.id}" data-k="${k}" tabindex="0"${k === DEFAULT_K ? '' : ' hidden'}>
                  ${bars}
                </div>`;
  }).join('\n                ');
  const means = K.map(
    (k) =>
      `R@${k} <strong data-recall-mean="${preset.id}-${k}">${percent(preset.mean[`r${k}`], 1)}</strong>`,
  ).join(' · ');
  const work =
    preset.id === 'reranked'
      ? ` ColBERT ran for <strong data-recall-neural>${preset.neuralQueries.toLocaleString('en')}</strong> of ${recall.dataset.questions.toLocaleString('en')} questions.`
      : '';
  return `<div class="tab-content" role="tabpanel" id="recall-panel-${preset.id}" aria-labelledby="recall-tab-${preset.id}" tabindex="0"${index ? ' hidden' : ''}>
              <p class="hs-recall-note">${escape(preset.description)} Mean over ${Object.keys(recall.languages).length} languages: ${means}.${work}</p>
              <div class="tabs hs-recall-tabs">
                <div class="tab-list" role="tablist" aria-label="Recall at k, ${escape(preset.name)}" data-size="sm">
                  ${tabs}
                </div>
                ${panels}
              </div>
            </div>`;
}

/** The website section between the recall markers of website/index.html. */
export function renderRecall(recall) {
  const [efficient, reranked] = ['efficient', 'reranked'].map((id) =>
    recall.presets.find((p) => p.id === id),
  );
  const count = Object.keys(recall.languages).length;
  const perfect = Object.keys(recall.languages).filter(
    (code) => efficient.languages[code].r5 === 1,
  );
  const tabs = [efficient, reranked]
    .map(
      (p, i) =>
        `<button class="tab-trigger" role="tab" aria-selected="${i === 0}" aria-controls="recall-panel-${p.id}" id="recall-tab-${p.id}"${i ? ' tabindex="-1"' : ''}>${escape(p.name)}</button>`,
    )
    .join('\n              ');
  const icu = recall.runtimes
    .filter((r) => r.icu)
    .map((r) => `${r.runtime.split(' ')[0]} ${r.icu}`);
  return `<!-- recall:start -->
        <!-- Generated by scripts/recall-docs.mjs from docs/data/recall.json (make bench); run make docs instead of editing. -->
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
                  <div class="mk-stat" data-recall-stat="r1"><span class="mk-stat-value">${percent(efficient.mean.r1, 1)}</span><span class="mk-stat-label">mean R@1 over ${count} languages with the efficient preset, no neural inference</span></div>
                  <div class="mk-stat" data-recall-stat="r5"><span class="mk-stat-value">${percent(efficient.mean.r5, 1)}</span><span class="mk-stat-label">mean R@5; the gold passage is among the first five results</span></div>
                  <div class="mk-stat" data-recall-stat="neural"><span class="mk-stat-value">${reranked.neuralQueries.toLocaleString('en')}</span><span class="mk-stat-label">of ${recall.dataset.questions.toLocaleString('en')} questions need ColBERT inference with the reranked preset, for a mean R@5 of ${percent(reranked.mean.r5, 1)}</span></div>
                  <div class="mk-stat" data-recall-stat="perfect"><span class="mk-stat-value">${perfect.length} of ${count}</span><span class="mk-stat-label">languages reach 100% R@5 with the efficient preset: ${escape(list(perfect.map((code) => recall.languages[code].name)))}</span></div>
                </div>
                <p class="hs-footnote">* Runtime comparison: ${escape(determinism(recall))} Word segmentation for Japanese, Chinese and Thai follows the runtime's ICU data (${escape(icu.join(', '))}).</p>
              </div>
              <figure class="mk-stats-media card hs-recall">
                <figcaption class="card-header"><h3 class="card-title">Recall by query language</h3><p class="card-description">Share of a language's ${recall.dataset.perLanguage} questions whose gold passage ranks in the top k of ${recall.dataset.passages.toLocaleString('en')}; one question is 2 points. The badge names how the language's lexical analyzer works. Reranking reorders only the top ${recall.candidates}, so R@${recall.candidates} is the same for both presets.</p></figcaption>
                <div class="card-content tabs hs-recall-tabs">
                  <div class="tab-list" role="tablist" aria-label="Ranking preset" id="recall-tabs">
              ${tabs}
                  </div>
            ${[efficient, reranked].map((p, i) => renderPanel(recall, p, i)).join('\n            ')}
                </div>
              </figure>
            </div>
          </section>
        </section>
        <!-- recall:end -->`;
}

/** README: per-language R@k for both presets, sorted like the website's default tab. */
export function renderRecallTable(recall) {
  const presets = ['efficient', 'reranked'].map((id) => recall.presets.find((p) => p.id === id));
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

/** README: one row per kind of lexical analysis with the efficient preset's R@5 range. */
export function renderLanguageGlance(recall) {
  const efficient = recall.presets.find((p) => p.id === 'efficient');
  const reranked = recall.presets.find((p) => p.id === 'reranked');
  const codes = Object.keys(recall.languages);
  const rows = Object.entries(METHODS).map(([method, label]) => {
    const group = codes.filter((code) => recall.languages[code].analysis === method);
    if (!group.length) throw new Error(`No language uses ${method}`);
    const values = group.map((code) => efficient.languages[code].r5);
    const low = Math.min(...values),
      high = Math.max(...values);
    return `| ${label} | ${group.map((code) => `\`${recall.languages[code].entry}\``).join(' ')} | ${low === high ? percent(low) : `${percent(low).slice(0, -1)}–${percent(high)}`} |`;
  });
  if (codes.some((code) => !METHODS[recall.languages[code].analysis]))
    throw new Error('A language analysis lacks a README label');
  return [
    '<!-- languages:start -->',
    '| Analysis | Entries | R@5, efficient |',
    '| --- | --- | ---: |',
    ...rows,
    '',
    `Mean over all ${codes.length} languages, efficient preset: **${percent(efficient.mean.r1, 1)}** R@1 and **${percent(efficient.mean.r5, 1)}** R@5. The reranked preset reaches ${percent(reranked.mean.r5, 1)} R@5 and runs ColBERT for ${reranked.neuralQueries.toLocaleString('en')} of ${recall.dataset.questions.toLocaleString('en')} questions.`,
    '<!-- languages:end -->',
  ].join('\n');
}

/** Replace the generated parts of website/index.html and README.md; return the changed files. */
export async function writeRecall(recall) {
  const changed = [];
  for (const [file, pattern, render] of [
    ['website/index.html', /<!-- recall:start -->[\s\S]*<!-- recall:end -->/, renderRecall],
    ['README.md', /<!-- recall-table:start -->[\s\S]*<!-- recall-table:end -->/, renderRecallTable],
    ['README.md', /<!-- languages:start -->[\s\S]*<!-- languages:end -->/, renderLanguageGlance],
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
