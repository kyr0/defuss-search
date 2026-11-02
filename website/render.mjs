/**
 * Pure markup builders for the demo: data in, defuss-shadcn markup out, no DOM and no state. Every interpolated
 * text goes through escape(), since passages and notes are third-party or user text.
 * Why one column for the chosen factory: the gold passage's rank in it is the comparison the benchmark makes, so a
 * reader can check one question against the published figures by eye, and switch factories to compare.
 * VERIFIED: scripts/e2e.mjs compares the column's rendered gold rank with the worker's hits.
 */
import { METHODS, factoryOf } from './factories.mjs';

const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const names = new Intl.DisplayNames(['en'], { type: 'language' });
/** "deu_Latn" → "German"; the dataset codes are ISO 639-3 plus script, which BCP 47 reads as "deu-Latn". */
export const languageName = (code) => names.of(code.split('_')[0]) ?? code;
export const languageTag = (code) => code.replace('_', '-');
export const formatMs = (ms) => (ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`);
export const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 1 : 2)} MB`;

const icon = (name) => `<svg class="hs-icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const sourceRanks = (signals) =>
  [
    signals.lexical ? `lexical #${signals.lexical}` : 'no lexical match',
    signals.vector ? `vector #${signals.vector}` : 'not in vector top 25',
  ].join(' · ');

const fixed = (value, digits = 3) =>
  Number.isFinite(value) ? value.toFixed(digits) : escape(String(value));
const sourceName = { lexical: 'Lexical', vector: 'Vector', reranker: 'ColBERT' };
/** One fusion term as the library computed it: weight / (k + rank) = contribution. */
const renderTerm = ({ source, rank, weight, contribution }) =>
  `<li><span>${escape(sourceName[source] ?? source)} #${rank}</span><code>${fixed(weight, 2)} / (k + ${rank}) = ${fixed(contribution)}</code></li>`;

/**
 * The "Why" panel of a note hit: matched words, each source's rank and raw score, the fusion terms and the policy
 * reasons. Native details/summary, so it opens by keyboard and needs no script.
 */
/** Policy reasons as sentences; unknown reasons stay as the library names them. */
const REASONS = {
  'weak-lexical':
    "moved to the top: BM25's first hit matched only few or common words of the query",
  'source-coverage': 'kept in view so each source has a hit near the top',
};
const reasonText = (reason) =>
  REASONS[reason] ??
  (reason.startsWith('rerank-skipped:') ? `ColBERT skipped (${reason.slice(15)})` : reason);

function renderWhy(explain, rank, languages) {
  const words = explain.terms.length
    ? explain.terms
        .map(
          (t) =>
            `<code>${escape(t.query)}</code>${t.term !== t.query ? ` → <code>${escape(t.term)}</code>` : ''} <span class="hs-why-dim">${escape(t.kind)}, ${escape(languages?.includes(t.field) ? languageName(t.field) : t.field)}</span>`,
        )
        .join(', ')
    : 'none';
  const signals = Object.entries(explain.signals)
    .map(
      ([key, signal]) =>
        `<li><span>${escape(sourceName[key] ?? key)} #${signal.rank}</span><code>${key === 'vector' ? 'cosine' : key === 'lexical' ? 'BM25' : 'score'} ${fixed(signal.score)}</code></li>`,
    )
    .join('');
  const rows = [
    `<dt>Matched words</dt><dd>${words}</dd>`,
    signals ? `<dt>Sources</dt><dd><ul class="hs-why-list">${signals}</ul></dd>` : '',
    explain.contributions.length
      ? `<dt>Fusion</dt><dd><ul class="hs-why-list">${explain.contributions.map(renderTerm).join('')}</ul></dd>`
      : '',
    explain.rerankContributions.length
      ? `<dt>Rerank fusion</dt><dd><ul class="hs-why-list">${explain.rerankContributions.map(renderTerm).join('')}</ul></dd>`
      : '',
    explain.reasons.length
      ? `<dt>Policies</dt><dd>${explain.reasons.map((r) => escape(reasonText(r))).join('; ')}</dd>`
      : '',
    `<dt>Final score</dt><dd><code>${escape(explain.scoreKind)} ${fixed(explain.score)}</code></dd>`,
  ].join('');
  return `<details class="hs-why"><summary>Why #${rank}</summary><dl class="hs-why-body">${rows}</dl></details>`;
}

/** One result row: rank, text, language, source ranks for hybrid hits, the move against efficient, gold marks. */
function renderHit(hit, i, { method, gold, languages, beforeRanks, jump }) {
  const code = languages ? languages[hit.language] : '';
  const mark =
    gold && hit.group === gold.group ? (hit.id === gold.id ? 'exact' : 'translation') : '';
  const before = beforeRanks?.get(hit.id);
  const moved = before ? before - (i + 1) : 0;
  const meta = [
    code ? `<span class="badge" data-variant="outline" data-size="xs">${escape(code)}</span>` : '',
    method === 'lexical-only'
      ? ''
      : `<span class="hs-source">${escape(sourceRanks(hit.signals))}</span>`,
    moved
      ? `<span class="badge hs-moved" data-variant="outline" data-size="xs" title="Efficient rank ${before}"><span aria-hidden="true">${moved > 0 ? '↑' : '↓'}${Math.abs(moved)}</span><span class="sr-only">moved from position ${before}</span></span>`
      : '',
    mark
      ? `<span class="aura aura-gold aura-sm hs-gold" style="--shape-round:999px"><span class="badge"${mark === 'translation' ? ' data-variant="secondary"' : ''} data-size="xs">${mark === 'exact' ? 'Gold' : 'Gold · translation'}</span></span>`
      : '',
  ].join('');
  return `<li class="hs-hit" data-id="${escape(hit.id)}"${mark ? ` data-gold="${mark}"` : ''}>
    <span class="hs-hit-rank" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
    <div class="hs-hit-body">${
      jump
        ? `<button type="button" class="hs-hit-text hs-hit-jump" data-note="${escape(hit.id)}" aria-label="Show ${escape(hit.id.replace('-', ' '))}: ${escape(hit.text)}"${code ? ` lang="${languageTag(code)}"` : ''}>${escape(hit.text)}</button>`
        : `<p class="hs-hit-text"${code ? ` lang="${languageTag(code)}"` : ''}>${escape(hit.text)}</p>`
    }<p class="hs-hit-meta">${meta}</p>${hit.explain ? renderWhy(hit.explain, i + 1, languages) : ''}</div>
  </li>`;
}

const goldRank = (column, gold) =>
  gold ? column.hits.findIndex((hit) => hit.id === gold.id) + 1 : 0;

const spinner =
  '<svg class="spinner" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
/** What a column waits for, with the button that loads it where a click helps. */
const WAITING = {
  'needs-embedder': {
    text: 'This text has no recorded vector. Winzling embeds it on this device.',
    load: ['winzling', 'cpu', 'Load Winzling and search'],
  },
  'needs-reranker': {
    text: 'The gate found no clear winner, so this question needs MoEdernColBERT; below is the efficient order.',
    load: ['colbert', 'cpu', 'Load the reranker'],
  },
  'needs-colbert': {
    text: 'The tiny factory encodes each question with MoEdernColBERT before it scans the token index.',
    load: ['colbert', 'cpu', 'Load MoEdernColBERT and search'],
  },
  'needs-tokens': { text: 'Loading the prebuilt token index...', busy: true },
  'needs-vectors': { text: 'Loading the recorded Winzling vectors...', busy: true },
  pending: { text: 'MoEdernColBERT is reranking...', busy: true },
};

/** The figure under the column title: the gold passage's rank, or what the column waits for. */
function renderFigure(method, column, data, gold) {
  const waiting = WAITING[column.state];
  if (waiting && !column.hits?.length)
    return `<div class="hs-figure" data-state="${waiting.busy ? 'busy' : 'needs-model'}">${waiting.busy ? `<span class="hs-figure-value">${spinner}</span>` : ''}<span class="hs-figure-label">${waiting.text}</span>${waiting.load ? `<button type="button" class="btn" data-size="sm" data-load="${waiting.load[0]}">${icon(waiting.load[1])}${waiting.load[2]}</button>` : ''}</div>`;
  const rank = goldRank(column, gold);
  // On short documents the presets route to the vector source alone; the figure names the deciding length.
  const shortRoute =
    column.route?.route === 'vector'
      ? `vector only: ${column.route.averageLength.toFixed(1)} terms per document, below ${column.route.threshold}`
      : '';
  // The weak-lexical rule names its evidence when it moved the vector source's first hit up.
  const weak =
    column.weakLexical?.action === 'promoted'
      ? `vector #1 first: BM25's #1 matched ${Math.round(100 * column.weakLexical.share)}% of the weighted words · `
      : '';
  const vector = data.recorded
    ? 'recorded vector'
    : data.embedMs
      ? `embed ${formatMs(data.embedMs)}`
      : '';
  const timing =
    weak +
    (method === 'lexical-only'
      ? formatMs(column.ms)
      : method === 'tiny'
        ? `ColBERT query and token scan · ${formatMs(column.ms)}`
        : method === 'efficient' || column.state !== 'done'
          ? `${vector} · ${shortRoute || `fuse ${formatMs(column.ms)}`}`
          : column.decision?.reason === 'short-documents'
            ? `${shortRoute}; no BM25, no ColBERT`
            : column.decision?.action === 'skipped'
              ? `ColBERT skipped: vector margin ${column.decision.margin.toFixed(3)} above ${column.decision.threshold}, lexical ${column.decision.lexical}`
              : `ColBERT applied · rerank ${formatMs(column.rerankMs)}`);
  const value = gold ? (rank ? `#${rank}` : '–') : `${column.hits.length}`;
  const label = gold ? (rank ? 'gold passage rank' : 'gold passage not in the top 25') : 'results';
  const note = waiting
    ? `<span class="hs-figure-wait">${waiting.busy ? spinner : ''}${waiting.text}${waiting.load ? ` <button type="button" class="btn" data-size="sm" data-variant="outline" data-load="${waiting.load[0]}">${waiting.load[2]}</button>` : ''}</span>`
    : '';
  return `<div class="hs-figure" data-gold-rank="${rank}"><span class="hs-figure-value">${value}</span><span class="hs-figure-label">${label}</span><span class="hs-figure-meta">${escape(timing)}</span>${note}</div>`;
}

/** The chosen factory's column, top `limit` hits; a reranked list marks each hit's move against the efficient one. */
export function renderResults(data, { gold, languages, limit = 10, jump = false }) {
  const { column, method } = data;
  const factory = factoryOf(data.factory);
  const beforeRanks = column.before
    ? new Map(column.before.map((id, i) => [id, i + 1]))
    : undefined;
  const hits = (column.hits ?? [])
    .slice(0, limit)
    .map((hit, i) => renderHit(hit, i, { method, gold, languages, beforeRanks, jump }))
    .join('');
  const empty =
    column.state === 'done' && !column.hits.length
      ? '<p class="hs-method-empty">No match.</p>'
      : '';
  return `<section class="card hs-method" data-method="${method}" data-state="${column.state}" aria-labelledby="method-${data.index}">
    <div class="card-header">
      <div class="hs-method-head"><h3 class="card-title" id="method-${data.index}">${METHODS[method].title}</h3><code class="hs-method-fn">${factory.fn}()</code></div>
      <p class="card-description">${factory.description}</p>
    </div>
    <div class="card-content">${renderFigure(method, column, data, gold)}<ol class="hs-hits">${hits}</ol>${empty}</div>
  </section>`;
}

/** The benchmark questions as palette groups, one per language. */
export const renderQueryGroups = (queries, languages) =>
  languages
    .map((code, language) => {
      const items = queries
        .map((query, i) => [query, i])
        .filter(([query]) => query.language === language)
        .map(
          ([query, i]) =>
            `<button class="command-item" data-query="${i}" lang="${languageTag(code)}">${escape(query.text)}</button>`,
        )
        .join('');
      return `<div class="command-group"><p class="command-group-heading">${escape(languageName(code))} · ${escape(code)}</p>${items}</div>`;
    })
    .join('');

export const renderExampleButtons = (picks, queries) =>
  picks
    .map(
      (i) =>
        `<button type="button" class="btn" data-variant="outline" data-size="sm" data-query="${i}">${escape(queries[i].text)}</button>`,
    )
    .join('');

/** A worker log line as a terminal line; the newest one carries the cursor. */
export const renderLogLine = (tone, text) =>
  `<pre data-prefix="${tone === 'success' ? '✓' : tone === 'warning' ? '!' : tone === 'destructive' ? '✗' : '>'}" data-tone="${tone}" data-cursor><code>${escape(text)}</code></pre>`;

/** A yellow note: its language, a native textarea and a status line the board fills in. */
export const renderNote = (id, n, language, codes) => `<article class="hs-note" id="${id}">
  <div class="hs-note-head">
    <label class="hs-note-label" for="${id}-text">Note ${n}</label>
    <select class="hs-note-lang" id="${id}-lang" aria-label="Language of note ${n}">${codes
      .map(
        (code) =>
          `<option value="${code}"${code === language ? ' selected' : ''}>${escape(languageName(code))}</option>`,
      )
      .join('')}</select>
  </div>
  <textarea class="textarea hs-note-text" id="${id}-text" rows="4" placeholder="Write anything, in the language above..." lang="${languageTag(language)}"></textarea>
  <p class="hs-note-status" role="status" aria-live="polite"><span class="hs-note-hint">Not indexed yet</span></p>
</article>`;

/** The status of one note: lexical indexing is immediate; a vector or ColBERT tokens follow once the model is loaded. */
const KINDS = {
  none: { badge: 'Lexical', waits: '' },
  vector: { badge: 'Lexical + vector', waits: 'vector waits for Winzling' },
  matrix: { badge: 'Lexical + ColBERT tokens', waits: 'tokens wait for MoEdernColBERT' },
};
export const renderNoteStatus = (state, detail = '', kind = 'none') =>
  ({
    lexical: `<span class="badge" data-variant="outline" data-size="xs">Lexical</span>${KINDS[kind].waits ? `<span class="hs-note-hint">${KINDS[kind].waits}</span>` : ''}`,
    hybrid: `<span class="badge" data-variant="secondary" data-size="xs">${KINDS[kind].badge}</span><span class="hs-note-time">${escape(detail)}</span>`,
    removed: `<span class="hs-note-hint">Empty: removed from the index</span>`,
    failed: `<span class="badge" data-variant="outline" data-size="xs">Failed</span><span class="hs-note-time">${escape(detail)}</span>`,
  })[state];

/**
 * The in-browser measurement next to the published figures: recall.json per preset, strategies.json for
 * lexical-only and tiny. Both are means over 20 languages with 50 questions each.
 */
export function renderMeasure(rows, published) {
  const cell = (value) => `<td class="hs-num">${(100 * value).toFixed(1)}%</td>`;
  return rows
    .map(({ id, mean, neural }) => {
      const reference = published[id];
      const same =
        reference &&
        ['r1', 'r5', 'r10', 'r25'].every((k) => Math.abs(reference[k] - mean[k]) < 1e-9);
      const status = reference
        ? same
          ? '<span class="badge" data-variant="secondary" data-size="xs">same as published</span>'
          : `<span class="badge" data-variant="outline" data-size="xs">differs from published</span><span class="hs-note-hint"> ${(100 * reference.r1).toFixed(1)}% R@1, ${(100 * reference.r5).toFixed(1)}% R@5</span>`
        : '<span class="hs-note-hint">not published</span>';
      return `<tr data-measure="${id}"><th scope="row">${METHODS[id].title}</th>${['r1', 'r5', 'r10', 'r25'].map((k) => cell(mean[k])).join('')}<td class="hs-num">${neural ?? 0}</td><td>${status}</td></tr>`;
    })
    .join('');
}

/**
 * The picker's measured figures for one factory, R@1 and R@5 from strategies.json; lexical-semantic shows its
 * efficient preset and names the reranked one below.
 */
export function renderFactoryFigures(id, published) {
  const row = id === 'semantic' ? 'efficient' : id;
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  const cells = (corpus) => {
    const x = published.corpora[corpus]?.[row];
    return x ? `<td>${pct(x.r1)}</td><td>${pct(x.r5)}</td>` : '<td>–</td><td>–</td>';
  };
  const reranked = id === 'semantic' ? published.corpora.belebele?.reranked : undefined;
  return `<table class="hs-factory-table">
    <thead><tr><th scope="col"><span class="sr-only">Corpus</span></th><th scope="col">R@1</th><th scope="col">R@5</th></tr></thead>
    <tbody>
      <tr data-figure="${id}-belebele"><th scope="row">Belebele, 20 languages</th>${cells('belebele')}</tr>
      <tr data-figure="${id}-notes"><th scope="row">Notes found by their translations</th>${cells('notes translation')}</tr>
      <tr data-figure="${id}-docs-exact"><th scope="row">API docs, exact words</th>${cells('api docs exact')}</tr>
      <tr data-figure="${id}-docs-natural"><th scope="row">API docs, natural-language questions</th>${cells('api docs natural')}</tr>
    </tbody>
  </table>${reranked ? `<p class="hs-factory-note" data-figure="semantic-reranked">With the reranker: ${pct(reranked.r1)} / ${pct(reranked.r5)} on Belebele.</p>` : ''}`;
}
/** The page with each factory's empty `data-figures` placeholder filled; throws when one is missing. */
export function factoryFiguresPage(html, factories, published) {
  return factories.reduce((page, { id }) => {
    const empty = `<span class="hs-factory-figures" data-figures="${id}"></span>`;
    if (!page.includes(empty)) throw new Error(`index.html lacks the figures placeholder of ${id}`);
    return page.replace(
      empty,
      () =>
        `<span class="hs-factory-figures" data-figures="${id}">${renderFactoryFigures(id, published)}</span>`,
    );
  }, html);
}
