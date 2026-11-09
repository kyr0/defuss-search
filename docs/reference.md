# API reference

Hybrid lexical/vector retrieval with explicit candidate budgets, explainable ranking, and optional ColBERT reranking. Built against **defuss-lexicalsearch 0.4.0** and **defuss-vectorsearch 0.2.1**. Version **0.4.0**, MIT.

| Strategy | Candidate generation | Final ordering before optional neural reranking |
|---|---|---|
| `vector-first` | Vector top 25 | Lexical ranking within those IDs; unmatched candidates stay at the end |
| `lexical-first` | Lexical top 25 | Exact vector similarity within those IDs; unmatched candidates stay at the end |
| `fusion` (default) | Independent lexical top 25 + vector top 25 | Deduplicated weighted reciprocal rank fusion (RRF) |

All three can apply a final, bounded neural reranker. Cascades cannot recover a document missed by their first stage. Fusion can retain documents found by either source. Neither fusion nor a neural model is guaranteed to improve relevance on every corpus; see [research](research.md) and the measured [evaluation](evaluation.md).

## Run from a checkout

`make setup` installs the Node.js and Bun versions pinned in `mise.toml`, the locked dependencies and Playwright's Chromium. Then:

```sh
make verify            # lint, tests on Bun and Node.js, coverage, packed-package and browser e2e
bun examples/node.mjs
make demo
make dev               # the website with live reload, rebuilt on every source edit
```

The demo starts with a factory picker; `?factory=tiny` (or `lexical-only`, `semantic`) preselects one. Lexical-only needs no model. Lexical-semantic ranks benchmark questions with their recorded Winzling vectors, loads MoEdernColBERT for its reranker and Winzling for typed text. The tiny factory loads MoEdernColBERT and encodes the passages in the browser. Models download from their pinned Hugging Face revisions, and the worker checks each file's SHA-256 before the Cache API keeps it.

```sh
bun run models         # pinned releases; SHA-256 checked; stored in .models
bun run test:models    # native CPU Winzling + MoEdernColBERT integration
make demo              # the browser loads the WASM models from Hugging Face
```

`DEFUSS_CHROMIUM=/path/to/chrome` selects an existing browser binary for `make e2e`. `DEFUSS_LIVE_BROWSER=1 make e2e` additionally tests the live WASM models. See [verification](verification.md) for the recorded results.

## Install into another project

Install the package with the optional peers:

```sh
bun add defuss-search defuss-lexicalsearch defuss-vectorsearch
```

The root entry has **no runtime dependencies**. Peer packages are optional for custom retrievers; install them when using their adapters. `/indexing` uses both peers; `/vector` imports only the pure TurboQuant/vector-math subpath, keeping model runtimes out of the basic search bundle. `/colbert` accepts the model structurally and does not load it itself.

## Explicit presets and neural work

VERIFIED: `searchPreset('efficient')` returns 25 candidates per source, RRF k=0, weights `{ lexical: 2, vector: 1 }`, `weakLexical: { share: 0.2, gap: 0.15 }` and `rerank: false`. `searchPreset('reranked')` keeps that retrieval and enables a 25-candidate raw ColBERT stage, RRF k=1, neural weight 0.25, and `skipIfVectorMargin: 0.1`. `searchPreset()` without a name returns the reranked preset, which a `HybridSearch` without a reranker rejects with "A reranker must be configured"; such a search takes `searchPreset('efficient')`. Import `searchPreset` from the root package; pass its result as `defaults` or spread it into query options. Without a preset, the defaults in [Ranking and policies](#ranking-and-policies) apply.

The optional neural weight cannot displace the prior top result: its minimum score is 1/2, while any other hit's maximum is 11/24. It can change lower ranks. Presets are selected on the development partition described in [Pareto analysis](pareto.md); their quality is not guaranteed on arbitrary corpora or embedding models.

`rerank.skipIfVectorMargin` is an explicit pre-inference gate. It compares the first two raw vector scores only when the complete vector list is monotonic, the current winner is the vector winner, and lexical retrieval agrees or has no hits. On a qualifying gap, the entire current ordering remains unchanged and the reranker is never called. Undefined or Infinity disables the gate. Non-numeric, NaN or negative thresholds throw before retrieval. A one-hit vector list cannot establish a margin. Thresholds are source-scale dependent; 0.1 is a Winzling cosine heuristic, not a probability.

`searchWithStats()` adds `rerankDecision`: `{ action: 'disabled' | 'empty' }`, `{ action: 'applied', candidates }`, or `{ action: 'skipped', reason: 'vector-margin', winner, margin, threshold, lexical: 'agrees' | 'empty' }`. A skip reports `counts.reranked: 0` and attaches no neural score or contribution. The first hit's reasons include `rerank-skipped:vector-margin`. Decisions use the complete candidate ordering before pagination and respect global eligibility and exact promotion.

## Create an owned index

```ts
import { apiSearchPreset } from 'defuss-lexicalsearch';
import { createWinzlingEmbedder } from 'defuss-vectorsearch/onnx.js';
import { createHybridIndex } from 'defuss-search/indexing';

const embedder = createWinzlingEmbedder({ device: 'cpu' });
// Native CPU requires onnxruntime-node@1.21.0; use device: 'wasm' otherwise.
const documents = [
  { id: 'push', fields: {
    symbol: 'Array.prototype.push()',
    description: 'Append an element to the end of an array',
  } },
  { id: 'pop', fields: {
    symbol: 'Array.prototype.pop()',
    description: 'Remove the last element from an array',
  } },
];
const vectors = await embedder.embedDocuments(documents.map(
  doc => `${doc.fields.symbol}\n${doc.fields.description}`,
));
const search = createHybridIndex({
  documents,
  vectors,                        // same row order as documents
  embedQuery: text => embedder.embedQuery(text),
  lexical: apiSearchPreset,        // this upstream export is an object
  lexicalSearch: { exact: { fields: ['symbol'], caseSensitive: true } },
});

const hits = await search.search('append an item', {
  strategy: 'fusion',
  lexicalCandidates: 25,
  vectorCandidates: 25,
  exact: 'promote',
  balance: { window: 5, lexical: 1, vector: 1 },
  limit: 10,
});
for (const hit of hits) console.log(hit.rank, search.get(hit.id), hit.signals);
// Keep embedder alive while searches use it; call await embedder.dispose() on shutdown.
```

`createHybridIndex()` adds an unstemmed companion to every field whose analyzer stems (`surface`, on by default; `surface: false` keeps the lexical options as given, `surface: { weight }` scales the companions' weight). `apiSearchPreset` has no stemming field, so the example above gets none. [Unstemmed companions](#unstemmed-companions) explains them.

`createHybridIndex()` owns a corpus snapshot. Documents, metadata and vectors are copied; `get()` returns an owned document copy. To update it, build a new index and swap your reference. Existing queries keep the previous snapshot. Generate documents and queries with the same model, preprocessing and embedding dimensions; dimensional compatibility alone does not prove model compatibility. This package cannot infer the provenance of arbitrary caller-provided vectors.

## Reuse existing indexes

```ts
import { HybridSearch } from 'defuss-search';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';

const search = new HybridSearch({
  lexical: createLexicalRetriever(existingLexicalIndex, {
    search: { fuzzy: 1, prefix: true },
    exact: { fields: ['symbol'] },
  }),
  vector: createVectorRetriever({
    ids: documentIds,
    vectors: documentVectors,
    embedQuery: text => embedder.embedQuery(text),
    metric: 'cosine',             // default; normalization is owned and stable
    strategy: 'turboquant',       // default is exact float-vector scan
    refineCandidates: 100,        // optional exact recheck; default 0
  }),
});

await search.search('query', { strategy: 'vector-first', vectorCandidates: 25 });
await search.search('query', { strategy: 'lexical-first', lexicalCandidates: 25 });
await search.search({ text: 'query', vector: precomputedQueryVector });
await search.search({ text: 'Wann öffnet der Zoo?', language: 'de' }); // e.g. a language identifier's guess
```

A query's `language` is a BCP 47 tag. The lexical adapter passes it to defuss-lexicalsearch's `language` option, which multiplies the weights of the fields whose analyzer has that primary language by `languageBoost` (default 3) and keeps every other field searchable; it overrides a fixed `search.language`. Vector sources and rerankers ignore it, and an invalid tag rejects the search with lexicalsearch's `RangeError`.

Lexical rescoring uses the **existing full index**, with candidate IDs passed to its search method. It does not rebuild an index from 25 documents and thereby change BM25 corpus statistics. Its options forward existing phrase, Boolean, prefix, suffix, substring, fuzzy, field and exclusion behavior. Literal modes compare original strings. Ranking order is authoritative even when lexical exact-first tiers make raw scores nonmonotonic.

Caller-owned indexes and text resolvers must remain consistent for a complete query. For concurrent corpus changes, replace a whole snapshot instead of mutating an index while retrieval/reranking is in flight. The vector adapter owns a copy of the stable ID-to-row mapping and the vectors. It retains full floats for exact candidate rescoring, even in TurboQuant mode. Both vector modes scan the corpus; this is not an ANN graph or a disk database. TurboQuant supports cosine only; dot product is available in exact mode.

## Unstemmed companions

`withSurfaceFields(options, { weight = 1 })` returns `LexicalSearch` options with a companion `<field>~surface` for every field whose analyzer has a stemmer. The companion analyzes the field's text (`source`, so documents carry it once) with `surfaceAnalyzer(analyzer)`, the same analyzer without its stemmer and phonetic key, and carries the field's weight times `weight` and its `b`. It returns `options` itself when no field stems, and applying it twice adds nothing.

```ts
import { LexicalSearch } from 'defuss-lexicalsearch';
import en from 'defuss-lexicalsearch/en';
import { surfaceAnalyzer, withSurfaceFields } from 'defuss-search/lexical';
import { createLexicalOnlySearch } from 'defuss-search/strategies';

const index = new LexicalSearch(withSurfaceFields({
  fields: { title: { analyzer: en, weight: 3 }, text: { analyzer: en } },
}));
const search = createLexicalOnlySearch(index, { lexical: { search: { fields: ['title'] } } });
// Snapshots name analyzers by id; restore with both analyzers in the registry:
LexicalSearch.fromJSON(index.toJSON(), { [en.id]: en, [surfaceAnalyzer(en).id]: surfaceAnalyzer(en) });
```

`createLexicalRetriever()` adds each listed field's companion to `search.fields` and leaves companions out of `averageLength()` and `matchShare()`, which would otherwise count every stemmed term twice. `surfaceField(name)` returns a companion's name. The README's [Match words as written](../README.md#match-words-as-written) lists the measured effect and cost.

## Neural reranking

```ts
import { createColbertReranker } from 'defuss-vectorsearch/onnx.js';
import { createColbertAdapter } from 'defuss-search/colbert';

const colbert = createColbertReranker({ model: '1.5m', precision: 'q8', device: 'cpu' });
const reranker = createColbertAdapter(colbert, id => documentTexts.get(id)!, {
  truncate: false,               // overlong input fails, rather than silently truncates
});
const search = new HybridSearch({ lexical, vector, reranker });
await search.search('query', {
  rerank: { candidates: 25, method: 'rrf', k: 60, weight: 1 },
});
// method: 'replace' uses only raw neural order within the prefix.
// rerank: false disables an attached reranker for this call.
// Dispose the caller-owned ColBERT model at shutdown.
```

With a reranker attached, the default is to rerank the first 25 current candidates. Only that prefix is reordered; the untouched tail follows it. The default neural stage fuses the **current ranking** with **raw ColBERT ranking**, once each. The adapter calls upstream `rerank()`, not `rerankHits()` (the latter already includes dense-rank fusion). Raw model indices are relative to the supplied candidate texts and are mapped back to stable document IDs. A missing, duplicate or out-of-scope candidate is an error.

In a browser worker, construct models using `defuss-vectorsearch/browser.js`, use `device: 'wasm'`, and configure both instances with identical `wasmPaths` and `numThreads`. See `website/search-worker.mjs`. No model is downloaded or selected merely by importing this package.

## Ranking and policies

- **RRF default:** `sum(weight / (k + rank))`, one-based ranks, `k=60`, both source weights 1. Missing sources contribute zero. Duplicate IDs inside one source are rejected; overlap across sources is deduplicated. Ties use code-unit document-ID order.
- **Linear alternative:** `fusion: { method: 'linear', weights: { lexical: 0.7, vector: 0.3 } }`. Min-max normalize each retrieved list, normalize weights by their sum, and use zero for a missing source. A constant list maps every present hit to 1. Descending raw scores are required; exact-first tiered lists can violate this and are rejected. Configure lexical `ranking: 'relevance'` when evaluating score fusion. Scores depend on the retrieved windows and are not probabilities. No automatic tuning is claimed.
- A **zero source weight** removes that source's score contribution, not its candidate membership. At least one weight must be positive. Exact and coverage policies remain independent of weights.
- **Cascade replacement** is the default: secondary hits first, followed by candidates absent from the secondary result in their original order. `unmatched: 'drop'` removes that tail. `cascade: 'fuse'` combines the two stage rankings using the chosen fusion method. Only the first-stage candidate budget applies; the second stage scores the entire first-stage pool.
- **Literal exact promotion** is opt-in: `exact: 'promote'` requires explicit exact fields on the lexical adapter. Equality is case-sensitive by default and preserves special characters, whitespace and Unicode spelling. It is not inferred from analyzed token matches or fuzzy tiers. Fusion may inject up to `exactCandidates` (default 25) additional literal matches; cascades only test retained first-stage IDs. Verified literal matches precede other candidates, including after neural reranking. Equality hits outside this finite exact window are not promised promotion.
- **Short-text routing** is opt-in: `vectorOnlyBelow: 12` makes a fusion query use the vector source alone, without BM25 candidates or the reranker, when the lexical adapter reports fewer than 12 analyzed terms per document over the fields it searches. The response's `route` names the route and the deciding average; `rerankDecision` then reads `{ action: 'skipped', reason: 'short-documents' }`. Exact promotion still applies. VERIFIED: `bun run bench:bm25-switch` (2026-11-01, defuss-vectorsearch 0.2.1 models) measured 98.9% R@1 with the vector source alone on short notes whose matches are translations, against 61.5% for the reranked preset, and 19.8% against 47.4% for BM25 on Belebele passages cut to eight terms, where the match shares the question's language and words. No preset sets it, because document length alone does not tell these cases apart.
- **Weak-lexical promotion** is on in both presets and off without them: `weakLexical: { share: 0.2, gap: 0.15 }`. In fusion, when BM25's first hit matches less than `share` of the query's words, each weighted by its inverse document frequency in the lexical index, and its vector score trails the vector source's first hit by more than `gap`, the vector source's first hit moves to the top; the other hits keep their order. Stopwords carry no weight, and a word the index lacks carries the most, so a translated or paraphrased query gives a low share. The step runs after reranking and policies, and requested exact matches stay ahead of the promoted hit. It needs `matchShare()` on the lexical retriever, which `createLexicalRetriever` provides. The lexical hit's vector score comes from the vector candidates, from an exact rescore when the query carries its vector, or otherwise from the last vector candidate as a bound. `searchWithStats()` reports `weakLexical`: `{ action: 'disabled' }`, `{ action: 'unavailable', reason }` with reason `strategy`, `no-candidates`, `same-first-hit`, `unsupported` or `no-words`, or `{ action: 'kept' | 'promoted', lexical, vector, share, gap, gapBound }`; the promoted hit's reasons include `weak-lexical`. VERIFIED: `bun run bench:confidence-fusion` measured the efficient preset at 97.8% R@1 for notes found by their translations (61.5% without the rule), 86.4% for paraphrase queries (63.6%) and 91.3% on Belebele (91.0%), with R@5 within 0.4 points on every corpus. Belebele passages cut to six words lost half a point of R@1. The thresholds were chosen on those same queries.
- **Source coverage** is opt-in: `balance: { window: 5, lexical: 1, vector: 1 }` puts each source's best available candidate in the first 5. Larger counts reserve each source's first N available IDs; overlap counts toward both. This is a fixed prefix of the full result ordering, not a new quota on every page. If exact promotion and coverage cannot both fit, search throws instead of silently weakening either policy. Short/empty sources reserve only what is available.

## Filtering, pagination and explanations

Pass `ids: new Set(eligibleDocumentIds)` to constrain **both sources before top-k**, including exact lookup and neural candidates. A lexical adapter's metadata filter constrains that adapter only; it is **not** a global authorization filter. Resolve tenant/visibility eligibility into the shared `ids` set or enforce equivalent eligibility in every custom retriever. Out-of-scope custom results fail closed.

`limit` defaults to 10 and `offset` to 0. Keep retrieval windows, corpus, query and policies unchanged across pages. Pagination never expands candidate windows automatically. Limits/windows are validated; source windows and neural budget are bounded to 10,000. `totalCandidates` is the finite candidate union/pool, not the total count of corpus matches. Zero limit returns an empty response without doing retrieval. An empty text with a supplied vector supports vector retrieval; empty text without a vector returns no results.

```ts
const response = await search.searchWithStats('query', {
  ids: new Set(['push', 'pop']),
  limit: 10, offset: 0,
  signal: AbortSignal.timeout(3000),
});
// { hits, totalCandidates, strategy, counts, timings, representatives, rerankDecision }
```

Each hit has `id`, authoritative `rank`, `score`, `scoreKind`, per-source `signals` (raw rank/score/tier), optional `contributions` and `rerankContributions`, `exact`, and `reasons`. A cascade tail or partially neural-reranked list can contain different score scales. **Do not re-sort final hits by score.** Policy promotion can also override numeric order. `exact: false` means no exact-policy evidence was attached, not proof that literal equality is impossible.

Errors fail the whole query; there is no silent fallback to a partial source. Abort rejects promptly while awaiting asynchronous work and is passed to custom adapters. It cannot interrupt synchronous lexical/vector loops or an ONNX call whose upstream API has no cancellation. The underlying model operation may complete after the caller stops waiting.

## Ready-made strategies

`defuss-search/strategies` builds a `HybridSearch` around an existing `LexicalSearch` index with one of three defaults. Each factory takes optional `lexical` retriever options (for example `{ search: { fields: ['de'] } }`) and `defaults` that override the strategy's options.

- `createLexicalOnlySearch(index)` returns a search without a vector source: BM25 order, the same hit and response shape as the hybrid searches, and no model.
- `await createLexicalSemanticTinySearch(index, { documents, colbert })` encodes every `{ id, text }` with the ColBERT model's `encodeDocuments()` in batches of 64, keeps the token vectors in a TurboQuant index (`quantization: 'exact'` keeps float32), and fuses BM25 with a MaxSim scan using the efficient preset's settings, except for a weak-lexical gap of 0.1 instead of 0.15. Pass `matrices` to reuse token matrices encoded earlier. Queries are encoded with `encodeQueries()`.
- `await createLexicalSemanticSearch(index, { documents, embedder, reranker? })` embeds the documents with Winzling's `embedDocuments()` (or takes `vectors`) and each query with `embedQuery()`. With a ColBERT `reranker` it uses `searchPreset('reranked')`, otherwise `searchPreset('efficient')`.

The tiny factory and the semantic factory's reranker call ColBERT with `truncate: true`: text past the model's input limit is dropped from the token index, the query and the reranked pair instead of failing the search. Split long documents into sections before indexing them. Both semantic factories also accept `vector`, a vector source built earlier with `createColbertRetriever` or `createVectorRetriever`, instead of encoding the documents. Searches that differ only in their lexical options, such as one per language field, then share one index; the website demo builds its 20 per-language searches this way. With `vector`, the tiny factory needs neither `documents` nor `colbert`, and the semantic factory needs no `embedder` but still takes `documents` for its reranker. The two semantic factories import their adapters when called, so an application that uses only `createLexicalOnlySearch` loads no defuss-vectorsearch code. The caller creates, caches and disposes the models.

`createColbertRetriever({ ids, matrices, encodeQuery, quantization? })` from `defuss-search/colbert` is the token index under the tiny strategy. Each score is MaxSim averaged over the query's tokens, so it lies in [-1, 1]. A query scans every stored token; the retriever keeps the last query's scores, so a rescore inside the same search costs no second scan. Matrices must share one dimension count and have nonzero token vectors; the retriever normalizes each token.

`buildColbertTokenIndex(matrices, { seed? })` quantizes token matrices into the TurboQuant index that the retriever would build and returns `{ tokenCounts, turboquant }`, numbers and typed arrays only. Build it once, for example at build time, store it as bytes, and pass it back as `createColbertRetriever({ ids, index, encodeQuery })` in place of `matrices`: the retriever then skips document encoding and quantization, and ranks exactly as one built from the same matrices. `ids` must follow the order of the matrices, and `index.tokenCounts` must hold one count per ID; the website demo ships its Belebele index this way (`website/token-index.mjs`).

## Custom backends

Implement `Retriever.retrieve(query, { limit, ids, signal })`, returning ordered `{ id, score }[]` with finite scores and unique stable string IDs. Apply eligibility before top-k. Optional `rescore()` handles a restricted pool; otherwise `retrieve()` is used with that pool and its count. The weak-lexical rule may call the vector source's `rescore()` for one document after `retrieve()` within the same search, also for a query given as text alone; a vector retriever that embeds query text should keep the last embedding, as the built-in adapters do, so this costs no second model call. Optional `exact()` must mean literal equality if you enable promotion. Optional `matchShare(query, id)` returns the share of the query's IDF-weighted words that document `id` matches, or undefined when no word is searchable; without it, `weakLexical` reports `unsupported` and changes nothing. Return at most `limit` hits.

Implement `Reranker.rerank(query, ids, { signal })` with a complete permutation of those IDs, descending finite scores. This supports other neural or application-specific rerankers. `fuseRankings()` is also exported independently for arbitrary named rank lists (up to 64), with RRF or normalized linear fusion.

## Development

`make setup`, `make build`, `make test`, `make lint`, `make coverage`, `make e2e`, `make bench`, `make verify`, `make demo` and `make dev` provide the standard entry points. `bun run test:package` installs the packed tarball in isolated projects, checks ESM/CommonJS and declarations, and bundles its adapters for a browser. `bun run test:wasm` runs the real browser-entry WASM models in Node as a separate integration check. See [verification](verification.md) for what was actually executed.
