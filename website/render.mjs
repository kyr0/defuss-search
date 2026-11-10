/**
 * Pure markup builders for the demo: data in, defuss-shadcn markup out, no DOM and no state. Every interpolated
 * text goes through escape(), since passages and notes are third-party or user text, and every word of the page's
 * own comes from website/messages.mjs in the current language; the demo renders again after a language switch.
 * Why one column for the chosen factory: the gold passage's rank in it is the comparison the benchmark makes, so a
 * reader can check one question against the published figures by eye, and switch factories to compare.
 * VERIFIED: scripts/e2e.mjs compares the column's rendered gold rank with the worker's hits.
 */
import { METHODS, factoryOf } from './factories.mjs';
import { formatMs, formatNumber, languageName, percent, t } from './i18n.mjs';

export const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
/** A benchmark code ("deu_Latn") as a valid BCP 47 tag: Intl shortens the ISO 639-3 code ("de-Latn"), as axe-core requires. */
export const languageTag = (code) => Intl.getCanonicalLocales(code.replace('_', '-'))[0];

const icon = (name) => `<svg class="hs-icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
/** A model download button inside a spinning glow (defuss-shadcn's aura), so a reader sees what starts a download. */
const loadButton = ([model, iconName, label], variant = '') =>
  `<span class="aura aura-dual aura-glow aura-lg hs-load-aura"><button type="button" class="btn" data-size="sm"${variant ? ` data-variant="${variant}"` : ''} data-load="${model}">${icon(iconName)}${t(label)}</button></span>`;
/** A small badge of plain text; the demo's figures and times read as badges rather than a run of prose. */
export const badge = (text, variant = 'outline') =>
  `<span class="badge" data-variant="${variant}" data-size="xs">${escape(text)}</span>`;
const sourceRanks = (signals) => [
  signals.lexical ? t('source-lexical', { rank: signals.lexical }) : t('source-no-lexical'),
  signals.vector ? t('source-vector', { rank: signals.vector }) : t('source-no-vector'),
];

const fixed = (value, digits = 3) =>
  Number.isFinite(value)
    ? formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : escape(String(value));
const sourceName = (key) => (['lexical', 'vector', 'reranker'].includes(key) ? t(`name-${key}`) : key);
/** One fusion term as the library computed it: weight / (k + rank) = contribution. */
const renderTerm = ({ source, rank, weight, contribution }) =>
  `<li><span>${escape(sourceName(source))} #${rank}</span><code>${fixed(weight, 2)} / (k + ${rank}) = ${fixed(contribution)}</code></li>`;

/** Policy reasons as sentences; unknown reasons stay as the library names them. */
const reasonText = (reason) =>
  reason === 'weak-lexical' || reason === 'source-coverage'
    ? t(`reason-${reason}`)
    : reason.startsWith('rerank-skipped:')
      ? t('reason-rerank-skipped', { detail: reason.slice(15) })
      : reason;

/**
 * The "Why" panel of a note hit: matched words, each source's rank and raw score, the fusion terms and the policy
 * reasons. Native details/summary, so it opens by keyboard and needs no script.
 */
function renderWhy(explain, rank, languages) {
  const words = explain.terms.length
    ? explain.terms
        .map(
          (term) =>
            `<code>${escape(term.query)}</code>${term.term !== term.query ? ` <span class="hs-why-dim">=</span> <code>${escape(term.term)}</code>` : ''} <span class="hs-why-dim">${escape(term.kind)}, ${escape(languages?.includes(term.field) ? languageName(term.field) : term.field)}</span>`,
        )
        .join(', ')
    : t('why-none');
  const signals = Object.entries(explain.signals)
    .map(
      ([key, signal]) =>
        `<li><span>${escape(sourceName(key))} #${signal.rank}</span><code>${key === 'vector' ? 'cosine' : key === 'lexical' ? 'BM25' : 'score'} ${fixed(signal.score)}</code></li>`,
    )
    .join('');
  const rows = [
    `<dt>${t('why-words')}</dt><dd>${words}</dd>`,
    signals ? `<dt>${t('why-sources')}</dt><dd><ul class="hs-why-list">${signals}</ul></dd>` : '',
    explain.contributions.length
      ? `<dt>${t('why-fusion')}</dt><dd><ul class="hs-why-list">${explain.contributions.map(renderTerm).join('')}</ul></dd>`
      : '',
    explain.rerankContributions.length
      ? `<dt>${t('why-rerank')}</dt><dd><ul class="hs-why-list">${explain.rerankContributions.map(renderTerm).join('')}</ul></dd>`
      : '',
    explain.reasons.length
      ? `<dt>${t('why-policies')}</dt><dd>${explain.reasons.map((reason) => escape(reasonText(reason))).join('; ')}</dd>`
      : '',
    `<dt>${t('why-score')}</dt><dd><code>${escape(explain.scoreKind)} ${fixed(explain.score)}</code></dd>`,
  ].join('');
  return `<details class="hs-why"><summary>${t('why-title', { rank })}</summary><dl class="hs-why-body">${rows}</dl></details>`;
}

/** One result row: rank, text, language, source ranks for hybrid hits, the move against efficient, gold marks. */
function renderHit(hit, i, { method, gold, languages, beforeRanks, jump }) {
  const code = languages ? languages[hit.language] : '';
  const mark =
    gold && hit.group === gold.group ? (hit.id === gold.id ? 'exact' : 'translation') : '';
  const before = beforeRanks?.get(hit.id);
  const moved = before ? before - (i + 1) : 0;
  const meta = [
    code ? badge(code) : '',
    method === 'lexical-only' ? '' : sourceRanks(hit.signals).map((text) => badge(text)).join(''),
    moved
      ? `<span class="badge hs-moved" data-variant="outline" data-size="xs" title="${escape(t('moved-title', { rank: before }))}">${icon(moved > 0 ? 'arrow-up' : 'arrow-down')}<span aria-hidden="true">${Math.abs(moved)}</span><span class="sr-only">${escape(t('moved-from', { rank: before }))}</span></span>`
      : '',
    mark
      ? `<span class="aura aura-gold aura-sm hs-gold" style="--shape-round:999px"><span class="badge"${mark === 'translation' ? ' data-variant="secondary"' : ''} data-size="xs">${mark === 'exact' ? t('gold') : t('gold-translation')}</span></span>`
      : '',
  ].join('');
  return `<li class="hs-hit" data-id="${escape(hit.id)}"${mark ? ` data-gold="${mark}"` : ''}>
    <span class="hs-hit-rank" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
    <div class="hs-hit-body">${
      jump
        ? `<button type="button" class="hs-hit-text hs-hit-jump" data-note="${escape(hit.id)}" aria-label="${escape(t('show-note', { note: t('note-label', { n: hit.id.replace('note-', '') }), text: hit.text }))}"${code ? ` lang="${languageTag(code)}"` : ''}>${escape(hit.text)}</button>`
        : `<p class="hs-hit-text"${code ? ` lang="${languageTag(code)}"` : ''}>${escape(hit.text)}</p>`
    }<p class="hs-hit-meta">${meta}</p>${hit.explain ? renderWhy(hit.explain, i + 1, languages) : ''}</div>
  </li>`;
}

const goldRank = (column, gold) =>
  gold ? column.hits.findIndex((hit) => hit.id === gold.id) + 1 : 0;

const spinner =
  '<svg class="spinner" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
/** What a column waits for, with the button that loads it where a click helps: [message, model, icon, button]. */
const WAITING = {
  'needs-embedder': { text: 'needs-embedder', load: ['winzling', 'cpu', 'load-embedder'] },
  'needs-reranker': { text: 'needs-reranker', load: ['colbert', 'cpu', 'load-reranker'] },
  'needs-colbert': { text: 'needs-colbert', load: ['colbert', 'cpu', 'load-colbert'] },
  'needs-tokens': { text: 'needs-tokens', busy: true },
  'needs-vectors': { text: 'needs-vectors', busy: true },
  pending: { text: 'pending-rerank', busy: true },
};

/** The figure under the column title: the gold passage's rank, or what the column waits for. */
function renderFigure(method, column, data, gold) {
  const waiting = WAITING[column.state];
  if (waiting && !column.hits?.length)
    return `<div class="hs-figure" data-state="${waiting.busy ? 'busy' : 'needs-model'}">${waiting.busy ? `<span class="hs-figure-value">${spinner}</span>` : ''}<span class="hs-figure-label">${t(waiting.text)}</span>${waiting.load ? loadButton(waiting.load) : ''}</div>`;
  const rank = goldRank(column, gold);
  // On short documents the presets route to the vector source alone; the figure names the deciding length.
  const shortRoute =
    column.route?.route === 'vector'
      ? t('route-vector', {
          terms: formatNumber(column.route.averageLength, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
          threshold: column.route.threshold,
        })
      : '';
  // The weak-lexical rule names its evidence when it moved the vector source's first hit up.
  const weak =
    column.weakLexical?.action === 'promoted'
      ? t('weak-promoted', { share: percent(column.weakLexical.share, 0) })
      : '';
  const vector = data.recorded
    ? t('time-recorded')
    : data.embedMs
      ? t('time-embed', { time: formatMs(data.embedMs) })
      : '';
  const timing = [
    weak,
    ...(method === 'lexical-only'
      ? [t('summary-search', { time: formatMs(column.ms) })]
      : method === 'tiny'
        ? [t('time-tiny', { time: formatMs(column.ms) })]
        : method === 'efficient' || column.state !== 'done'
          ? [vector, shortRoute || t('time-fuse', { time: formatMs(column.ms) })]
          : column.decision?.reason === 'short-documents'
            ? [t('time-short', { route: shortRoute })]
            : column.decision?.action === 'skipped'
              ? [
                  t('time-skipped', {
                    margin: fixed(column.decision.margin),
                    threshold: column.decision.threshold,
                    lexical: column.decision.lexical,
                  }),
                ]
              : [t('time-applied', { time: formatMs(column.rerankMs) })]),
  ].filter(Boolean);
  const value = gold ? (rank ? `#${rank}` : '-') : `${column.hits.length}`;
  const label = gold ? (rank ? t('figure-gold') : t('figure-gold-missing')) : t('figure-results');
  const note = waiting
    ? `<span class="hs-figure-wait">${waiting.busy ? spinner : ''}${t(waiting.text)}${waiting.load ? ` ${loadButton(waiting.load, 'outline')}` : ''}</span>`
    : '';
  return `<div class="hs-figure" data-gold-rank="${rank}"><span class="hs-figure-value">${value}</span><span class="hs-figure-label">${label}</span><span class="hs-figure-meta hs-badges">${timing.map((text) => badge(text)).join('')}</span>${note}</div>`;
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
      ? `<p class="hs-method-empty">${t('no-match')}</p>`
      : '';
  return `<section class="card hs-method" data-method="${method}" data-state="${column.state}" aria-labelledby="method-${data.index}">
    <div class="card-header">
      <div class="hs-method-head"><h4 class="card-title" id="method-${data.index}">${METHODS[method].title}</h4><code class="hs-method-fn">${factory.fn}()</code></div>
      <p class="card-description">${t(`factory-${factory.id}`)}</p>
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
      return `<div class="command-group"><p class="command-group-heading">${escape(t('group-heading', { language: languageName(code), code }))}</p>${items}</div>`;
    })
    .join('');

export const renderExampleButtons = (picks, queries, languages) =>
  picks
    .map(
      (i) =>
        `<button type="button" class="btn" data-variant="outline" data-size="sm" data-needs-models data-query="${i}" lang="${languageTag(languages[queries[i].language])}">${escape(queries[i].text)}</button>`,
    )
    .join('');

/** A worker log line as a terminal line; the newest one carries the cursor. The log stays in English. */
export const renderLogLine = (tone, text) =>
  `<pre data-prefix="${tone === 'success' ? '✓' : tone === 'warning' ? '!' : tone === 'destructive' ? '✗' : '>'}" data-tone="${tone}" data-cursor><code>${escape(text)}</code></pre>`;

/** A yellow note: its language, a native textarea and a status line the board fills in. */
export const renderNote = (id, n, language, codes) => `<article class="hs-note" id="${id}">
  <div class="hs-note-head">
    <label class="hs-note-label" for="${id}-text" data-msg="note-label">${escape(t('note-label', { n }))}</label>
    <select class="hs-note-lang" id="${id}-lang" data-needs-models aria-label="${escape(t('note-language', { n }))}">${codes
      .map(
        (code) =>
          `<option value="${code}"${code === language ? ' selected' : ''} data-lang-name="${code}">${escape(languageName(code))}</option>`,
      )
      .join('')}</select>
  </div>
  <textarea class="textarea hs-note-text" id="${id}-text" data-needs-models rows="4" placeholder="${escape(t('note-placeholder'))}" lang="${languageTag(language)}"></textarea>
  <p class="hs-note-status" role="status" aria-live="polite"><span class="hs-note-hint">${t('note-unindexed')}</span></p>
</article>`;

/** The status of one note: lexical indexing is immediate; a vector or ColBERT tokens follow once the model is loaded. */
export const renderNoteStatus = (state, detail = '', kind = 'none') => {
  const waits = { vector: 'note-waits-vector', matrix: 'note-waits-matrix' }[kind];
  const label = { vector: 'note-vector', matrix: 'note-matrix' }[kind] ?? 'note-lexical';
  return {
    lexical: `<span class="badge" data-variant="outline" data-size="xs">${t('note-lexical')}</span>${waits ? `<span class="hs-note-hint">${t(waits)}</span>` : ''}`,
    hybrid: `<span class="badge" data-variant="secondary" data-size="xs">${t(label)}</span><span class="hs-note-time">${escape(detail)}</span>`,
    removed: `<span class="hs-note-hint">${t('note-removed')}</span>`,
    failed: `<span class="badge" data-variant="outline" data-size="xs">${t('note-failed')}</span><span class="hs-note-time">${escape(detail)}</span>`,
  }[state];
};
