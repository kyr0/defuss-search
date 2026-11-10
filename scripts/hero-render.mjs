/**
 * The hero figure's example searches, rendered from docs/data/hero-examples.json (scripts/hero-examples.mjs) into
 * the empty `data-hero-examples` placeholder of website/index.html, before the translation step:
 * - the labels are `data-t` regions, so website/i18n/de.mjs translates them like any other text;
 * - each question and its lists exist once per language, marked `data-hero-locale`, because the German page asks
 *   the question in German and shows that question's own run; site.css shows the page language's copy;
 * - a fused hit's reason uses the page's messages (website/messages.mjs) in each language.
 * Why at build time: the figure is markup before any script runs, and scripts/check-project.mjs compares the
 * committed page with this rendering.
 * VERIFIED: make e2e checks that each panel shows this file's lists in the page's language (scripts/e2e-site.mjs).
 */
import { MESSAGES } from '../website/messages.mjs';
import { escape } from './highlight.mjs';

const PLACEHOLDER = '<div class="hs-fusion-examples" data-hero-examples></div>';
const LOCALES = ['en', 'de'];
const message = (locale, key, values = {}) =>
  MESSAGES[locale][key].replace(/\{(\w+)\}/g, (_, name) => values[name]);

/** The corpus badge and the line under a lexical list that holds every BM25 hit, per corpus and lexical mode. */
const CORPUS = {
  notes: ({ documents, languages }) => `${documents} notes, ${languages} languages`,
  api: ({ documents }) => `${documents} API symbols`,
};
const NO_MORE = {
  bm25: 'No other note shares a word with the question.',
  fuzzy: 'No other note matches, even with one typo per word.',
  exact: 'No other symbol matches.',
};
const LEXICAL_CODE = { bm25: 'BM25', fuzzy: 'BM25 fuzzy', exact: 'BM25 exact' };
const REASON = { 'literal-exact': 'hero-exact', 'weak-lexical': 'hero-weak-lexical' };

/** A document as the lists show it: a note with its language after it, or an API symbol over its description. */
const doc = ({ lang, symbol, text }) =>
  symbol
    ? `<code class="hs-rank-symbol">${escape(symbol)}</code><span class="hs-rank-text" lang="en">${escape(text)}</span>`
    : `<span class="hs-rank-text" lang="${lang}">${escape(text)}</span><span class="badge hs-rank-lang" data-variant="outline" data-size="xs">${lang}</span>`;

/** Why a fused hit stands where it does: the reasons the figure names, then each source's rank. */
const why = (locale, hit) => {
  const badges = hit.reasons.map(
    (reason) => `<span class="badge" data-variant="secondary" data-size="xs">${escape(message(locale, REASON[reason]))}</span> `,
  );
  const ranks = ['lexical', 'vector']
    .filter((source) => hit[source])
    .map((source) => message(locale, `source-${source}`, { rank: hit[source] }));
  return `<span class="hs-rank-why">${badges.join('')}${escape(ranks.join(', '))}</span>`;
};

const list = (kind, locale, hits, item) =>
  `<ol class="hs-rank-list" role="list" data-list="${kind}" data-hero-locale="${locale}">${hits
    .map((hit) => `<li data-doc="${escape(hit.doc.id)}">${item(hit)}</li>`)
    .join('')}</ol>`;

const wires = (from, to) =>
  `<svg class="hs-fusion-wires" viewBox="0 0 200 48" preserveAspectRatio="none" aria-hidden="true">${[from, to]
    .map(([a, b]) => `<path d="M${a} 0C${a} 30 ${b} 18 ${b} 48" pathLength="1" />`)
    .join('')}</svg>`;

const source = (kind, title, code, example, body) =>
  `<div class="hs-rank" data-source="${kind}"><p class="hs-rank-title"><span data-t>${title}</span><code${
    kind === 'lexical' && example.lexicalMode !== 'bm25' ? ' data-t' : ''
  }>${code}</code></p>${body}</div>`;

const PACKAGES = {
  lexical: ['https://lexicalsearch.defuss.org/', 'defuss-lexicalsearch'],
  vector: ['https://vectorsearch.defuss.org/', 'defuss-vectorsearch'],
};
const packageLink = (kind) =>
  `<a class="hs-rank-source" href="${PACKAGES[kind][0]}" target="_blank" rel="noopener">${PACKAGES[kind][1]}<svg class="hs-icon hs-ext" aria-hidden="true"><use href="#i-external" /></svg><span class="sr-only" data-t> (opens in a new tab)</span></a>`;

function panel(example, i) {
  const at = (locale) => example.locales[locale];
  const lexical =
    LOCALES.map((locale) => list('lexical', locale, at(locale).lexical, (hit) => doc(hit.doc))).join('') +
    LOCALES.filter((locale) => at(locale).lexicalTotal <= at(locale).lexical.length)
      .map((locale) => `<p class="hs-rank-empty" data-hero-locale="${locale}" data-t>${NO_MORE[example.lexicalMode]}</p>`)
      .join('') +
    packageLink('lexical');
  const vector = LOCALES.map((locale) => list('vector', locale, at(locale).vector, (hit) => doc(hit.doc))).join('') + packageLink('vector');
  const fused = LOCALES.map((locale) => list('fused', locale, at(locale).fused, (hit) => doc(hit.doc) + why(locale, hit))).join('');
  return `<div class="hs-fusion-example" id="hero-example-${example.id}" data-example="${example.id}"${i ? '' : ' data-active'}>
                <div class="search-box hs-fusion-query" data-size="lg" data-variant="muted" aria-hidden="true"><svg class="hs-icon"><use href="#i-search" /></svg>${LOCALES.map(
                  (locale) => `<span class="hs-fusion-placeholder" data-hero-locale="${locale}">${escape(at(locale).question)}</span>`,
                ).join('')}<span class="badge hs-fusion-corpus" data-variant="outline" data-size="xs" data-t>${CORPUS[example.corpus.kind](example.corpus)}</span></div>
                ${wires([100, 50], [100, 150])}
                <div class="hs-fusion-sources">${source('lexical', 'Lexical search:', LEXICAL_CODE[example.lexicalMode], example, lexical)}${source('vector', 'Vector search:', 'cosine', example, vector)}</div>
                ${wires([50, 100], [150, 100])}
                <div class="hs-rank hs-rank-fused" data-source="fused"><p class="hs-rank-title"><span data-t>Unified ranking</span><code>RRF 2:1</code></p>${fused}</div>
              </div>`;
}

/** The page with the examples in place of their placeholder; throws when the placeholder is missing. */
export function heroExamplesPage(html, hero) {
  if (!html.includes(PLACEHOLDER)) throw new Error('index.html lacks the hero examples placeholder');
  return html.replace(
    PLACEHOLDER,
    () => `<div class="hs-fusion-examples">
              ${hero.examples.map(panel).join('\n              ')}
              </div>`,
  );
}
