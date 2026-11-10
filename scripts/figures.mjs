/**
 * The built main page from its source, in one function that `make docs` writes and scripts/check-project.mjs
 * compares, so docs/index.html cannot drift from what the source and the reports render:
 * 1. the factory picker's figures from docs/data/strategies.json;
 * 2. the code placeholders, highlighted by Shiki (scripts/highlight.mjs);
 * 3. the translation markup from website/i18n/de.mjs (scripts/localize.mjs), failing on any text without German;
 * 4. the figures named by `data-fig`, from the reports, after the translation, so a translated sentence keeps its
 *    slot and the catalog does not change when a benchmark does;
 * 5. the download sizes named by `data-bytes`, from docs/data/manifest.json, in the page's number format.
 * VERIFIED: scripts/check-project.mjs compares the committed docs/index.html with this rendering.
 */
import { FACTORIES, modelBytes } from '../website/factories.mjs';
import { expandCode } from './highlight.mjs';
import { catalogMap, localize } from './localize.mjs';

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** A figure cell or slot the page reformats in its language (website/i18n.mjs). */
const share = (x) => `data-num="${x}" data-num-style="percent">${pct(x)}`;
const score = (x) => `data-num="${x}" data-num-digits="3">${x.toFixed(3)}`;
const times = (x) => `data-num="${x}" data-num-digits="1">${x.toFixed(1)}`;

/**
 * What the models' own repositories publish, for the hero's quality and size cards. Quality: nDCG@10 from each model
 * card at the revision docs/data/manifest.json pins; Winzling-reranker against the upstream FP32 model on NanoBEIR
 * English (13 tasks), Winzling-embed against its own FP32 checkpoint, the 64k-vocabulary model before quantization,
 * on 23 Nano retrieval tasks (the original 256k Bekko was not run on that suite). Size: the base models'
 * model.safetensors and tokenizer.json as Hugging Face lists them at the named revision, uncompressed.
 * VERIFIED (2026-11-10): the model cards' tables; Hugging Face's tree API for the sizes; the safetensors headers for
 * the dtypes, BF16 for Bekko and F32 for SauerkrautLM-MoEdernColBERT-1.5M.
 */
export const MODEL_FACTS = {
  reranker: { ndcg: 0.597, original: 0.591 },
  embed: { ndcg: 0.626, fp32: 0.6233 },
  bases: {
    // hotchpotch/bekko-embedding-v1-a8m@c721113d59a1d91b447450324f51c4b3332c924a: weights 211,952,896 + tokenizer 34,363,442
    bekko: 211952896 + 34363442,
    // VAGOsolutions/SauerkrautLM-MoEdernColBERT-1.5M@9d360b8b88ae11bea5784bf9012ff509fdd5c2da: 5,875,264 + 1,956,542
    sauerkraut: 5875264 + 1956542,
  },
};

/**
 * The picker's measured figures for one factory, R@1 and R@5 from strategies.json; lexical-semantic shows its
 * efficient preset and names the reranked one below.
 */
export function renderFactoryFigures(id, published) {
  const row = id === 'semantic' ? 'efficient' : id;
  const cells = (corpus) => {
    const x = published.corpora[corpus]?.[row];
    return x ? `<td ${share(x.r1)}</td><td ${share(x.r5)}</td>` : '<td>-</td><td>-</td>';
  };
  const reranked = id === 'semantic' ? published.corpora.belebele?.reranked : undefined;
  return `<table class="hs-factory-table">
    <thead><tr><th scope="col"><span class="sr-only" data-t>Corpus</span></th><th scope="col">R@1</th><th scope="col">R@5</th></tr></thead>
    <tbody>
      <tr data-figure="${id}-belebele"><th scope="row" data-t>Belebele, 20 languages</th>${cells('belebele')}</tr>
      <tr data-figure="${id}-notes"><th scope="row" data-t>Notes found by their translations</th>${cells('notes translation')}</tr>
      <tr data-figure="${id}-docs-exact"><th scope="row" data-t>API docs, exact matches</th>${cells('api docs exact')}</tr>
      <tr data-figure="${id}-docs-natural"><th scope="row" data-t>API docs, natural-language questions</th>${cells('api docs natural')}</tr>
    </tbody>
  </table>${reranked ? `<p class="hs-factory-note" data-figure="semantic-reranked"><span data-t>With the reranker, R@1 and R@5 on Belebele:</span> <span ${share(reranked.r1)}</span>, <span ${share(reranked.r5)}</span></p>` : ''}`;
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

/**
 * The figures a `data-fig` slot may name: the hero's claims, each from its source. Quality: the quantized models'
 * nDCG@10 against their FP32 versions (MODEL_FACTS); meaning: notes found by a translation, hybrid against BM25
 * alone (docs/data/strategies.json), and how many times better; size: how many times smaller each download
 * (docs/data/manifest.json) is than its base model's files.
 */
export function figures({ strategies, manifest }) {
  const corpus = (name, factory) => strategies.corpora[name][factory].r1;
  const download = (name) => modelBytes(manifest.models[name].files);
  return {
    'translation-times': times(corpus('notes translation', 'efficient') / corpus('notes translation', 'lexical-only')),
    'colbert-times': times(MODEL_FACTS.bases.sauerkraut / download('colbert')),
    'winzling-times': times(MODEL_FACTS.bases.bekko / download('winzling')),
    'reranker-ndcg': score(MODEL_FACTS.reranker.ndcg),
    'reranker-original-ndcg': score(MODEL_FACTS.reranker.original),
    'embed-ndcg': score(MODEL_FACTS.embed.ndcg),
    'embed-fp32-ndcg': score(MODEL_FACTS.embed.fp32),
    'translation-r1': share(corpus('notes translation', 'efficient')),
    'translation-lexical-r1': share(corpus('notes translation', 'lexical-only')),
  };
}

/** Fills every `<span data-fig="name"></span>`, in the live markup and in the translation templates alike. */
export function fillFigures(html, reports) {
  const values = figures(reports);
  return html.replace(/<span data-fig="([\w-]+)"><\/span>/g, (_, name) => {
    if (!values[name]) throw new Error(`Unknown figure ${name}`);
    return `<span data-fig="${escape(name)}" ${values[name]}</span>`;
  });
}

/** Megabytes as the page writes them (formatMb in website/i18n.mjs), in English until the page repaints. */
const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 1 : 2)} MB`;
/** Fills every `<span data-bytes="name">` with the size of the Brotli download the demo fetches. */
export function fillBytes(html, manifest) {
  const sizes = {
    corpus: manifest.corpus.bytes,
    vectors: manifest.vectors.bytes,
    tokens: manifest.tokens.bytes,
    colbert: modelBytes(manifest.models.colbert.files),
    winzling: modelBytes(manifest.models.winzling.files),
    ...MODEL_FACTS.bases,
  };
  sizes.models = sizes.colbert + sizes.winzling;
  return html.replace(/<span data-bytes="(\w+)">[^<]*<\/span>/g, (_, name) => {
    if (!sizes[name]) throw new Error(`Unknown download ${name}`);
    // data-num lets the page write the size in its language before the demo repaints it (website/i18n.mjs).
    const digits = sizes[name] >= 1e7 ? 1 : 2;
    return `<span data-bytes="${name}" data-num="${sizes[name] / 1e6}" data-num-digits="${digits}" data-num-unit=" MB">${mb(sizes[name])}</span>`;
  });
}

/** website/index.html as Pages serves it, before the build stamps the script versions. */
export async function renderIndex(source, { recall, strategies, manifest }) {
  const { default: pairs } = await import('../website/i18n/de.mjs');
  const { html, missing } = localize(expandCode(factoryFiguresPage(source, FACTORIES, strategies)), catalogMap(pairs));
  if (missing.length)
    throw new Error(`website/i18n/de.mjs lacks German for ${missing.length} texts:\n${missing.join('\n')}`);
  return fillBytes(fillFigures(html, { recall, strategies, manifest }), manifest);
}
