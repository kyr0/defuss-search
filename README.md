# defuss-search

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Hybrid search for TypeScript and JavaScript apps in Bun, Node.js and the browser: [defuss-lexicalsearch](https://github.com/kyr0/defuss-lexicalsearch) and [defuss-vectorsearch](https://github.com/kyr0/defuss-vectorsearch) retrieve over one set of document IDs, their rankings are merged, and ColBERT can rerank the top candidates.

## TL;DR

Lexical search finds exact matches but misses paraphrases; vector search finds meaning but does not guarantee that a query equal to a symbol or ID returns that document first. defuss-search runs both with explicit candidate budgets and merges their rankings, and every result reports which source found it and why it ranks where it does.

- **Two measured presets.** `searchPreset('reranked')`, the default, fuses the lexical and vector top 25 with weighted reciprocal rank fusion (RRF) and reorders them with a gated ColBERT stage; `searchPreset('efficient')` runs the same fusion without a reranker. Both let the vector source's first hit lead when BM25's first hit matched only few or common words of the query.
- **Three retrieval strategies.** Vector first with lexical rescoring, lexical first with vector rescoring, or fusion of two independent rankings.
- **Literal symbols stay literal.** `exact: 'promote'` ranks original-string matches of symbols and IDs, such as `?.` and `Array.prototype.push()`, first.
- **Inspectable results.** Source ranks, raw scores, fusion contributions, policy reasons and the neural decision accompany every hit; the final rank is authoritative.
- **20 languages.** One lexical analyzer per language field, with recall measured per language below.
- **Bun, Node.js and browsers.** ESM and CommonJS with TypeScript declarations; the root entry has no runtime dependencies, and model runtimes load only when the caller attaches a model.

### Languages at a glance

Pass a language's analyzer from `defuss-lexicalsearch/<entry>` to its field. R@5 is the share of a language's 50 benchmark questions whose gold passage ranks in the top 5 of 2,000 passages; [Retrieval quality by language](#retrieval-quality-by-language) explains the benchmark.

<!-- languages:start -->
| Analysis | Entries | R@5, reranked |
| --- | --- | ---: |
| Snowball stemming | `en` `de` `fr` `es` `pt` `it` `nl` `pl` `ru` `tr` `ar` `hi` `id` | 82–100% |
| Word segmentation | `th` `zh` `ja` | 98–100% |
| Syllable bigrams | `ko` | 96% |
| Words plus trigrams | `bn` `ur` | 94–96% |
| Tone mark folding | `vi` | 98% |

Mean over all 20 languages, reranked preset (the default): **92.5%** R@1 and **97.3%** R@5, with ColBERT for 893 of 1,000 questions. The efficient preset runs no ColBERT and reaches 92.5% R@1 and 97.3% R@5.
<!-- languages:end -->

## Quick start

The package requires Node.js 26 or newer or Bun 1.4.3 or newer. Install it together with the optional peers its adapters use:

```sh
bun add defuss-search defuss-lexicalsearch defuss-vectorsearch
```

A first search over two API symbols. The hand-authored vectors make the order reproducible without a model download; production vectors come from one embedding model for documents and queries.

```js
import { apiSearchPreset } from 'defuss-lexicalsearch';
import { searchPreset } from 'defuss-search';
import { createHybridIndex } from 'defuss-search/indexing';

const search = createHybridIndex({
  documents: [
    { id: 'push', fields: { symbol: 'Array.prototype.push()', description: 'Add elements to the end of an array' } },
    { id: 'pop', fields: { symbol: 'Array.prototype.pop()', description: 'Remove the last element of an array' } },
  ],
  vectors: [[1, 0], [0, 1]],
  defaults: searchPreset('efficient'), // no reranker here; searchPreset() means 'reranked'
  lexical: apiSearchPreset,
  lexicalSearch: { exact: { fields: ['symbol'] } },
});
const hits = await search.search({ text: 'Array.prototype.push()', vector: [0, 1] }, {
  strategy: 'fusion', exact: 'promote',
});
console.log(hits[0].id); // push
```

The query vector points at `pop()`, yet the exact symbol match puts `push()` first. VERIFIED: `test/readme.test.mjs` runs the three `js` examples on this page against the package on Node.js and Bun and checks their printed output. The [API reference](docs/reference.md) covers real model setup and adapters for existing indexes.

## Usage

### Pick a ready-made strategy

`defuss-search/strategies` wraps an existing `LexicalSearch` index in one of three searches. Each returns a `HybridSearch`, so results, explanations and options stay the same when an application moves from one to the next.

```js
import { LexicalSearch } from 'defuss-lexicalsearch';
import en from 'defuss-lexicalsearch/en';
import { createLexicalOnlySearch } from 'defuss-search/strategies';

const index = new LexicalSearch({ fields: { text: { analyzer: en } } });
index.addAll([
  { id: 'walk', fields: { text: 'Dogs need a walk every morning' } },
  { id: 'sofa', fields: { text: 'A cat sleeps on the warm sofa' } },
]);
const search = createLexicalOnlySearch(index);
const hits = await search.search('morning walks');
console.log(hits[0].id); // walk
```

The two semantic searches take model instances that the caller creates and disposes, and encode the documents once when they are built:

```ts
import { createColbertReranker, createWinzlingEmbedder } from 'defuss-vectorsearch/onnx.js';
import { createLexicalSemanticSearch, createLexicalSemanticTinySearch } from 'defuss-search/strategies';

const documents = [{ id: 'walk', text: 'Dogs need a walk every morning' } /* ... */];
const colbert = createColbertReranker({ model: '1.5m', precision: 'q8', device: 'cpu' });
const tiny = await createLexicalSemanticTinySearch(index, { documents, colbert });
const semantic = await createLexicalSemanticSearch(index, {
  documents,
  embedder: createWinzlingEmbedder({ device: 'cpu' }),
  reranker: colbert, // optional: searchPreset('reranked') instead of 'efficient'
});
```

| Factory | Model download (Brotli) | Vector index per document | Search |
| --- | --- | --- | --- |
| `createLexicalOnlySearch` | None | None | BM25 |
| `createLexicalSemanticTinySearch` | Winzling-reranker, 2.28 MB | 64 bytes per ColBERT token in TurboQuant codes: 5.8 KB per Belebele passage, 16.5 KB per API-docs section | BM25 fused with a MaxSim scan over every stored token |
| `createLexicalSemanticSearch` | Winzling-embed, 28.81 MB; with the reranker also Winzling-reranker | 1,536 bytes: one float32 vector of 384 dimensions | The efficient or reranked preset |

VERIFIED: defuss-vectorsearch 0.4.0 downloads each model file as `<file>.br` from its pinned Hugging Face revision, decodes it with defuss-brotli and checks the decoded file's SHA-256 against the pin. The `.br` files of Winzling-embed take 28.81 MB and those of Winzling-reranker 2.28 MB, against 39.76 MB and 3.83 MB unpacked (2026-11-09, `scripts/demo-data.mjs`, which decodes each one against its pin). [ARCH.md](ARCH.md#website-demo) explains why the website loads the models from Hugging Face.

VERIFIED: `bun run bench:strategies` measured the three factories on Bun 1.4.3 with one CPU thread and the defuss-vectorsearch 0.4.0 models (R@1 / R@5, 2026-11-10):

| Corpus | Lexical-only | Tiny | Lexical-semantic, efficient |
| --- | ---: | ---: | ---: |
| Belebele, 1,000 questions in 20 languages | 90.3% / 97.3% | 90.6% / 96.7% | 92.5% / 97.3% |
| Demo notes found by their translations (91) | 22.0% / 24.2% | 47.3% / 72.5% | 97.8% / 100% |
| Paraphrase queries over the notes (22) | 27.3% / 27.3% | 45.5% / 81.8% | 81.8% / 100% |
| defuss-shadcn docs, exact matches (100) | 98.0% / 98.0% | 98.0% / 98.0% | 98.0% / 98.0% |
| defuss-shadcn docs, natural-language queries (100) | 40.0% / 70.0% | 40.0% / 72.0% | 40.0% / 76.0% |

The docs index has [unstemmed companions](#match-words-as-written); without them the three factories reached 71% R@1 on the exact matches.

In the latest 2026-11-10 run, a tiny query took 3.5 ms over the 100 notes, 124 ms over Belebele's 2,000 passages (180,626 tokens) and 1.4 s over the 8,043 documentation sections (2,070,073 tokens), query encoding included; four earlier runs with this ColBERT took 119 to 133 ms over Belebele, and four runs with the previous ColBERT ranged from 117 to 240 ms and 1.3 to 2.5 s. The tiny search avoids the Winzling-embed download and helps where words differ between query and document, but it stays far behind Winzling-embed on translations and paraphrases, and its scan grows with the token count. The tiny strategy uses a weak-lexical gap of 0.1. Searches that differ only in their lexical options, such as one per language, can share one token index or vector set through the `vector` option; the [reference](docs/reference.md#ready-made-strategies) lists each factory's options.

### Choose a preset

| Preset | Fusion | Neural stage | Tradeoff |
| --- | --- | --- | --- |
| `searchPreset('reranked')`, the default | RRF with lexical and vector weights 2:1, k=20 for a query in one of Winzling-embed's eight target languages and k=0 otherwise; 25 candidates each; weak-lexical rule (share 0.2, gap 0.15) | Top 25; RRF k=1, neural weight 0.25; agreement and margin gate 0.1 | Needs a ColBERT reranker; inference on most queries; no recall gain on the benchmark with the vectorsearch 0.4.0 models |
| `searchPreset('efficient')` | Same retrieval and rule | Off | Fastest hybrid; no reranker inference; the choice for a search without a reranker |

`searchPreset()` without a name returns the reranked preset, and a `HybridSearch` without a reranker rejects it with "A reranker must be configured", so pass `searchPreset('efficient')` there.

VERIFIED: the fusion and neural settings of both presets were selected on 500 development questions and evaluated on 500 held-out questions. The fusion is selected for two language groups: a query whose `language` is one of Winzling-embed's eight target languages (de, en, es, fr, it, nl, pt, ru) gets RRF k=20; any other language, or no `language`, gets k=0; both with lexical and vector weights 2:1 (`fusion.byLanguage`). Winzling-embed's vectors are far stronger in those eight languages. The group tunes only k: equal weights, its own best pick, cost a guessed `language` 1.5 points R@1 when BM25 searches all 20 fields, and in `bun run bench:language-groups` four groups by language family led these two by only 0.15 points R@1, 1.5 of 1,000 questions, while searched bins and one group per language scored lower. On the holdout, efficient reaches **93.6% R@1**, **96.8% R@5** and **99.6% candidate recall**, against 92.4% R@1 and the same R@5 with one setting for every language and **67.2%**, **79.6%** and **99.6%** for equal-weight fusion with k=60. Lexical-only search reaches 97.0% R@5 without vector retrieval and stays on the measured frontier. The reranked preset matches efficient's held-out R@1 and R@5, gains one R@10 success and needs ColBERT for 445 of the 500 questions. Over all 1,000 questions it reaches 97.3% R@5 like efficient and lexical-only search, with the same R@1 as efficient; the website demo offers it as the lexical-semantic factory with its reranker. The [frontier analysis](docs/pareto.md) has the method, costs and limits.

VERIFIED: the weak-lexical rule moves the vector source's first hit to the top when BM25's first hit matches less than 20% of the query's words, weighted by their inverse document frequency in the index, and trails it by more than 0.15 cosine. `bun run bench:confidence-fusion` measured the efficient preset with and without it (2026-11-09, defuss-vectorsearch 0.3.1):

| Corpus | R@1 without | R@1 with | R@5 without | R@5 with |
| --- | ---: | ---: | ---: | ---: |
| Belebele, 1,000 questions | 91.0% | 91.2% | 97.3% | 97.3% |
| Belebele passages cut to 6 words | 48.4% | 47.6% | 62.8% | 62.8% |
| Belebele passages cut to 16 words | 66.8% | 65.8% | 80.7% | 80.7% |
| Demo notes found by their translations (91) | 61.5% | 97.8% | 100% | 100% |
| Paraphrase queries over the notes (22) | 59.1% | 81.8% | 100% | 100% |
| defuss-shadcn docs, natural-language queries (100) | 36.0% | 37.0% | 73.0% | 73.0% |
| defuss-shadcn docs, exact matches (100) | 71.0% | 71.0% | 82.0% | 82.0% |

The thresholds are the grid setting with the highest mean R@1 among those that cost no corpus more than one point of R@1, chosen on these same queries; with the vectorsearch 0.3.1 models, passages cut to 16 words sit exactly at that limit, 10 of 1,000 questions. the held-out figures above include the rule and are not independent of that choice.

Pass a preset as the constructor's or index's `defaults`, or spread it into per-query options. Each call returns an independent options object, and constructors without a preset keep their defaults. The reranked preset requires an attached reranker, and exact promotion still requires configured original-string fields.

### Choose retrieval and ranking

| Strategy | Candidate source | Second stage |
| --- | --- | --- |
| `vector-first` | Vector top 25 by default | Lexical search restricted to those IDs |
| `lexical-first` | Lexical top 25 by default | Exact vector scoring of those IDs |
| `fusion` | Independent lexical and vector top 25 | Weighted RRF of their deduplicated union |

VERIFIED: a cascade never adds candidates beyond its first stage. Lexical rescoring uses the corpus statistics of the full index. Candidates that the second stage does not rank stay at the end; `unmatched: 'drop'` removes them, and `cascade: 'fuse'` keeps both stage rankings as fusion inputs.

`exact: 'promote'` requires configured original-string fields. Fusion can add literal candidates; cascades cannot. `balance: { window: 5, lexical: 1, vector: 1 }` reserves the best available candidate from each source in the first five. A combination of exact promotion and coverage that cannot fit the window throws. Both policies apply before and again after neural reranking.

### Search another language

Import only the analyzer your index needs. For a multilingual corpus, configure one field per language and restrict the lexical adapter's `search.fields` when the application knows the query language.

```js
import ru from 'defuss-lexicalsearch/ru';
import { createHybridIndex } from 'defuss-search/indexing';

const search = createHybridIndex({
  documents: [
    { id: 'books', fields: { text: 'Мы читали книги в библиотеке.' } },
    { id: 'other', fields: { text: 'unrelated text' } },
  ],
  vectors: [[1, 0], [0, 1]],
  lexical: { analyzer: ru },
});
const hits = await search.search({ text: 'книга', vector: [1, 0] }, {
  strategy: 'lexical-first',
});
console.log(hits[0].id); // books
```

VERIFIED: the Russian stemmer matches `книга` with `книги`. `test/languages.test.mjs` runs all 20 analyzers through the three strategies, exact symbols and eligibility on Bun and Node.js. This establishes adapter compatibility; retrieval quality per language is measured in [Retrieval quality by language](#retrieval-quality-by-language), and the embedding model's quality differs by language.

When the application cannot know the query language, pass a language identifier's guess as the query's `language`. The lexical adapter forwards it to defuss-lexicalsearch, which weighs the fields of that language three times more and keeps every other field searchable, so a misread short query still finds its words; vector sources and rerankers ignore it. The `major_20` pack of [defuss-lid](https://github.com/kyr0/defuss-lid) covers the 20 language entries:

```js
import { LexicalSearch } from 'defuss-lexicalsearch';
import de from 'defuss-lexicalsearch/de';
import en from 'defuss-lexicalsearch/en';
import { load } from 'defuss-lid/packs/major_20';
import { createLexicalOnlySearch } from 'defuss-search/strategies';

const index = new LexicalSearch({ fields: { de: { analyzer: de }, en: { analyzer: en } } });
index.addAll([
  { id: 'de-1', fields: { de: 'Pinguine im Zoo' } },
  { id: 'en-1', fields: { en: 'penguins at the zoo' } },
]);
const search = await createLexicalOnlySearch(index);
const lid = await load();
const text = 'Wann öffnet der Zoo?';
const hits = await search.search({ text, language: lid.predict(text)[0]?.language });
lid.dispose();
console.log(hits.map((hit) => hit.id).join(',')); // de-1,en-1
```

VERIFIED: on the 1,000 benchmark questions, with defuss-lid 0.5.0 guessing 987 languages right, the efficient preset over all 20 fields reached 89.7% R@1 with the guess and 81.5% without it, against 92.5% with the known language (2026-11-10) ([details](docs/languages.md#when-the-questions-language-is-unknown)).

### Match words as written

A stemmer maps different words onto one stem, such as "tabs" and "tab", so a document that repeats "tab" can outrank the one that says "Tabs". `createHybridIndex()` therefore gives every field whose analyzer stems an unstemmed companion: a derived field that analyzes the same text without the stemmer, with the field's weight and `b`. A word written as in the document then scores in both fields. Fields without a stemmer get no companion, because it would index the same terms and act as a higher weight on the field, so `apiSearchPreset` and the seven languages without a Snowball stemmer (segmenters, bigrams, trigrams and Vietnamese tone folding) stay as they are. `surface: false` turns the companions off, and `surface: { weight }` scales their weight (default 1). For a `LexicalSearch` you build yourself, such as the index the strategies wrap, pass its options through `withSurfaceFields()` from `defuss-search/lexical`; `createLexicalRetriever()` searches a companion together with its field, also when `search.fields` names only the field.

VERIFIED: `bun run bench:surface` measured the efficient preset with stemmed fields alone and with companions of weight 1 (R@1 / R@5, defuss-vectorsearch 0.3.1 models, 2026-11-09):

| Corpus | Stemmed fields | With companions |
| --- | ---: | ---: |
| defuss-shadcn docs, exact matches (100) | 71.0% / 82.0% | 98.0% / 98.0% |
| defuss-shadcn docs, natural-language queries (100) | 37.0% / 73.0% | 40.0% / 76.0% |
| Belebele, 1,000 questions in 20 languages | 91.2% / 97.3% | 91.4% / 96.8% |
| Demo notes: translations, keywords, paraphrases (135) | 97.8%, 100%, 81.8% R@1 | equal |

Weight 0.5 reached 95.0% on the exact matches. The companions doubled the indexed tokens of the docs (1.10 to 2.19 million) and nearly doubled their build time (0.54 s to 0.94 s in one run, 0.55 s to 1.02 s in another). On Belebele's natural-language questions the companions gained two questions of 1,000 at rank 1 and lost five from the top 5; single languages moved by up to three of 50 questions in either direction. The website demo and the recall benchmark index Belebele without companions; the strategies benchmark indexes the docs with them.

### Attach a neural reranker

The [ColBERT adapter](src/adapters/colbert.ts) takes an upstream `createColbertReranker()` instance and a function that resolves an ID to its text. Pass it as `reranker` to `HybridSearch` or `createHybridIndex`. Without a preset, the neural stage fuses the current order with the raw neural order inside the first 25 candidates; `rerank: { method: 'replace' }` uses the neural order alone, and `rerank: false` disables the stage for one query.

VERIFIED: the adapter calls the upstream `rerank()`. The upstream `rerankHits()` already fuses dense ranks, so calling it would count the vector signal twice. Importing the package neither chooses, downloads nor disposes a model; the caller creates and shuts down models. See [neural reranking](docs/reference.md#neural-reranking).

## Reference

### Entry points

| Entry | Exports | Runtime peers |
| --- | --- | --- |
| `defuss-search` | `HybridSearch`, `fuseRankings`, `searchPreset`, public types | None |
| `defuss-search/lexical` | `createLexicalRetriever`, `withSurfaceFields`, `surfaceAnalyzer`, `surfaceField` | Caller supplies a lexical index |
| `defuss-search/vector` | `createVectorRetriever` | `defuss-vectorsearch` |
| `defuss-search/colbert` | `createColbertAdapter`, `createColbertRetriever`, `buildColbertTokenIndex` | Caller supplies the raw model; the retriever's TurboQuant codes use `defuss-vectorsearch` |
| `defuss-search/indexing` | `createHybridIndex` | Both search packages |
| `defuss-search/strategies` | `createLexicalOnlySearch`, `createLexicalSemanticTinySearch`, `createLexicalSemanticSearch` | `defuss-lexicalsearch`; the two semantic factories also `defuss-vectorsearch` and a model the caller supplies |

`createHybridIndex()` owns an immutable snapshot of the corpus; rebuild and swap it to update. Adapters that the caller owns must keep their indexes and text resolvers consistent while a query runs.

### Ranking and results

`rank` is the final order. Raw scores, fused scores and the scores of an unreranked tail can use different scales, so never sort returned hits by score. `searchWithStats()` adds the candidate counts, stage timings, source representatives and `rerankDecision`.

Shared `ids` eligibility restricts **both** sources before top-k; a lexical metadata filter applies to the lexical source only. Keep the query, corpus, candidate windows and policies fixed across pages. `totalCandidates` counts the finite candidate pool, not every matching document in the corpus.

An `AbortSignal` stops waiting for asynchronous work; it cannot interrupt an ONNX call or a synchronous scoring loop. An error in any source fails the whole query rather than dropping that source silently.

### Retrieval quality by language

`make bench` measures R@1, R@5, R@10 and R@25 on [tiny-embedding-bench-v1](https://github.com/kyr0/tiny-embedding-bench/tree/main/datasets/tiny-embedding-bench-v1), the SHA-256-pinned benchmark that both upstream packages report: 100 passages and 50 questions, each in 20 languages, with one gold passage per question. All 2,000 passages form one index. Lexical search knows the question's language and searches that language's field; vector search scans every passage, so a question also competes with the 19 translations of its gold passage. Each value is the share of a language's 50 questions, so a step of 2% is one question.

- **Reranked:** `searchPreset('reranked')` with real Winzling-reranker inference on every query its gate does not skip.
- **Efficient:** `searchPreset('efficient')` through `HybridSearch`, with real Winzling-embed vectors.

<!-- recall-table:start -->
| Language | Entry | Analysis | Reranked R@1 | Reranked R@5 | Reranked R@10 | Reranked R@25 | Efficient R@1 | Efficient R@5 | Efficient R@10 | Efficient R@25 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| English | `en` | Snowball | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| German | `de` | Snowball | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| French | `fr` | Snowball | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| Italian | `it` | Snowball | 98% | 100% | 100% | 100% | 98% | 100% | 100% | 100% |
| Russian | `ru` | Snowball | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| Indonesian | `id` | Snowball | 94% | 100% | 100% | 100% | 94% | 100% | 100% | 100% |
| Thai | `th` | segmenter | 94% | 100% | 100% | 100% | 94% | 100% | 100% | 100% |
| Spanish | `es` | Snowball | 92% | 98% | 100% | 100% | 92% | 98% | 100% | 100% |
| Portuguese | `pt` | Snowball | 96% | 98% | 98% | 98% | 96% | 98% | 98% | 98% |
| Dutch | `nl` | Snowball | 94% | 98% | 100% | 100% | 94% | 98% | 100% | 100% |
| Polish | `pl` | Snowball | 90% | 98% | 100% | 100% | 90% | 98% | 100% | 100% |
| Vietnamese | `vi` | tone folding | 96% | 98% | 100% | 100% | 96% | 98% | 100% | 100% |
| Chinese | `zh` | segmenter | 94% | 98% | 98% | 100% | 94% | 98% | 100% | 100% |
| Japanese | `ja` | segmenter | 90% | 98% | 100% | 100% | 90% | 98% | 100% | 100% |
| Turkish | `tr` | Snowball | 90% | 96% | 96% | 96% | 90% | 96% | 96% | 96% |
| Arabic | `ar` | Snowball | 90% | 96% | 96% | 98% | 90% | 96% | 96% | 98% |
| Urdu | `ur` | trigrams | 84% | 96% | 100% | 100% | 84% | 96% | 100% | 100% |
| Korean | `ko` | bigrams | 88% | 96% | 100% | 100% | 88% | 96% | 98% | 100% |
| Bangla | `bn` | trigrams | 90% | 94% | 96% | 98% | 90% | 94% | 96% | 98% |
| Hindi | `hi` | Snowball | 70% | 82% | 88% | 92% | 70% | 82% | 88% | 92% |
| **Mean** |  |  | **92.5%** | **97.3%** | **98.6%** | **99.1%** | **92.5%** | **97.3%** | **98.6%** | **99.1%** |

Runtime comparison: Bun 1.4.3, Node.js 26.11.1 and Chromium 156.0.8078.4 returned the same rank for each of the 1,000 questions under both presets.
<!-- recall-table:end -->

VERIFIED: `make bench` runs the same measurement module on Bun and Node.js with native ONNX Runtime and in Chromium with WASM, and the line under the table states how their per-question ranks compare. `scripts/recall-report.mjs` fails unless the [frontier analysis](docs/pareto.md), which replays cached neural scores, gives the same figures for every language. Reranking reorders only the top 25, so R@25 is identical for both presets. The figures cover this fixture; an embedding model's quality differs by language, and Winzling-embed targets nine of the 20. `make bench` writes `docs/data/recall.json`, the website section and this table; the [API evaluation](docs/evaluation.md) measures a separate fixture of API symbols.

### Limits

| Option | Default | Range |
| --- | --- | --- |
| `lexicalCandidates`, `vectorCandidates`, `exactCandidates` | 25 | 1 to 10,000 |
| `limit` (results per page) | 10 | 0 to 10,000 |
| `rerank.candidates` | 25 | 1 to 10,000 |
| `balance.window` | off | 1 to 30,000 |
| `vectorOnlyBelow` (analyzed terms per document) | off | at least 0 |
| `weakLexical.share`, `weakLexical.gap` | off; presets 0.2 and 0.15 | share 0 to 1; gap at least 0 |
| `fusion.k`, `rerank.k` (RRF constant) | 60 | 0 to 1,000,000,000 |
| Source and neural weights | 1 | 0 to 1,000,000 |
| Query text | | at most 16,384 UTF-16 code units |
| Vector dimensions | | 1 to 65,536 |
| ColBERT tokens per document (`createColbertRetriever`) | | 1 to 100,000 |
| Rank lists per `fuseRankings()` call | | 1 to 64 |

Exact vector mode scores every eligible row. TurboQuant also scans every row; with `refineCandidates` it rescores that many candidates with the float vectors, which it retains for exact cascade rescoring. It is therefore neither an approximate nearest-neighbor graph nor a memory saving. `bun run bench` measures both scans on 10,000 synthetic documents.

### Not included

The package has no language detection (the caller passes the query's `language`), document persistence, server or authentication, model download, embedding training or approximate nearest-neighbor index. Query and document vectors must come from compatible model and preprocessing settings; equal dimensions do not establish that.

## Configuration

The library reads no environment variables; configure it through constructor and query options. The `.env` keys configure development commands only; copy `.env.example` to `.env` to set them:

| Key | Meaning | Default |
| --- | --- | --- |
| `PORT` | Port of `make start`, `make demo` and `make dev`; 0 picks a free port | 4173 |
| `DEFUSS_MODEL_DIR` | Directory of the pinned model files | `.models` |
| `DEFUSS_CHROMIUM` | Chromium executable for browser checks | empty: Playwright's Chromium |
| `DEFUSS_LIVE_BROWSER` | 1 adds real WASM models to `make e2e` | 0 |
| `ONNXRUNTIME_NODE_INSTALL_CUDA` | onnxruntime-node installer setting; its CPU binaries need no download | skip |

## How it works

A query copies its vector, options and eligible IDs, then retrieves from both sources in parallel (fusion) or rescores one source's candidates with the other (cascade). Pure functions fuse the rankings and apply exact promotion and source coverage. An optional gate skips ColBERT when the raw vector scores show a clear winner that already ranks first and lexical retrieval agrees; otherwise ColBERT reorders the top candidates and the policies apply again. Ranks are assigned before the page is cut. [ARCH.md](ARCH.md) explains the design decisions, ranking invariants, the recall benchmark, operations, security and privacy.

## Website

The website in `docs/` is the project page and a live demo. Before the demo shows, the reader picks one of the three factories of `defuss-search/strategies`, because each one downloads something different. Every size here is a download, Brotli-compressed. Lexical-only needs only the passage text (0.32 MB). Lexical-semantic tiny loads Winzling-reranker (2.28 MB) and the passages' prebuilt TurboQuant token index: 180,626 tokens, 11.6 MB of codes, 7.80 MB as Brotli. `scripts/demo-data.mjs` builds that index with `buildColbertTokenIndex()` from the token matrices of the strategies benchmark, so the browser encodes only the questions and notes; encoding the 2,000 passages in headless Chromium on Apple silicon had taken 13 to 15 s. Lexical-semantic, the measured default that the picker preselects, loads the recorded Winzling-embed vectors (4.23 MB), Winzling-embed (28.81 MB) only for typed text, and Winzling-reranker for its optional reranker. The corpus, 2,000 Belebele passages and 1,000 questions in 20 languages, downloads while the reader chooses and is indexed the way the recall benchmark does. Each question shows the factory's top 10 and the rank of the gold passage; a reranked list marks each hit's move against the efficient order. The picker shows each model's download, and each factory's R@1 and R@5 on Belebele, the translated notes and the defuss-shadcn docs from `docs/data/strategies.json`. The worker downloads each model file as `<file>.br` from its pinned Hugging Face revision with byte progress, decodes it with defuss-brotli, checks the decoded file's SHA-256 against the pin and keeps it in the Cache API for the next visit. A button measures R@1, R@5, R@10 and R@25 over all 1,000 questions for the chosen factory and compares them with the published figures; each measured factory adds a row. "Change factory" returns to the picker and keeps what is loaded. The "My data" tab searches the user's notes with the same factory: lexically at once, and by meaning once the factory's model has encoded them. Each note carries a language, and the lexical index analyzes it with that language's analyzer and stopwords, so a shared function word such as German "mit" is no match. Each note hit opens a "Why" panel with the matched words, each source's rank and raw score and the fusion terms, and its text scrolls the board to the note.

Around the demo, the page has a playground that runs editable snippets against the published packages in a Web Worker, two diagrams of a query's path, four charts of quality, time, download and index size from `docs/data/strategies.json` and `docs/data/pareto.json` with a table of the same numbers under each, recall per language for each preset and each k, and the install and coding-agent instructions with a bun, pnpm, npm and yarn switch. It opens in English or German by the browser's language, with a switch that keeps the choice, and in light or dark by the system's setting. Every section and heading has an address such as `#/performance`, so links into the page survive a reload on GitHub Pages. Code is highlighted at build time with Shiki. The API and frontier references are rendered from `docs/` with the same header and footer; their text stays English, with a note in German. `docs/llms.txt` sums up the package for coding agents, with every figure taken from the reports. The relative URLs work at a domain root and under `/defuss-search/`, and the page loads the defuss-shadcn stylesheets and runtime from `docs/assets/vendor`.

```sh
make dev       # serve with live reload; rebuild on every source edit
make demo      # make docs, then make start
make status
make log
make stop
```

`make dev` runs in the foreground until Ctrl+C. It rebuilds the site when a file under `website/`, `src/` or `fixtures/` changes, and reloads every open page. `make start` serves `http://127.0.0.1:4173` unless `PORT` says otherwise; add `?models=off` to load models only on a click. `make bench` also writes the demo corpus, `docs/data/corpus.json.gz`, `docs/data/vectors.bin.gz`, `docs/data/tokens.bin.gz` and `docs/data/manifest.json`, through `scripts/demo-data.mjs`. `make docs` renders `docs/data/recall.json` into the page and the tables above, and the e2e test compares every rendered figure with that file. Every push to `main` runs the Pages workflow, which builds `docs/` with `make docs` and deploys that build; only it carries the ONNX Runtime Web files, which git ignores. `make docs` stamps each page's script and stylesheet URLs with a version of the build, so a reload after a deploy loads the new scripts.

## Development

```sh
make setup && make verify
```

`make setup` installs the Node.js and Bun versions pinned in `mise.toml` through [mise](https://mise.jdx.dev), the locked dependencies and Playwright's Chromium. `make verify` runs, in order:

| Verb | What it checks |
| --- | --- |
| `make lint` | oxlint with warnings as errors, strict TypeScript and the formatting of `src/` |
| `make test` | a clean build, the tests on Bun and on Node.js, the README examples, and ESM and CommonJS declaration consumers |
| `make coverage` | line and function coverage of the built package, printed as `TOTAL <n>%`; fails below 80% |
| `make e2e` | builds the website, checks that `make dev` serves it with the reload script, packs the tarball, installs it in an isolated consumer (Node.js ESM and CommonJS, Bun, declarations, a browser bundle without model runtimes), then drives every page in Chromium, including each recall figure and tab |
| `scripts/check-project.mjs` | release peers, website assets, the recall report and the generated tables agree |

`make` lists every verb. `make build` writes the package to `dist/`: ESM, CommonJS and TypeScript declarations. `make bench` measures recall on Bun, Node.js and Chromium and the quality/work frontier, then regenerates the published figures; it downloads the pinned models and the dataset into `.models/` and `input/` once. Real-model checks run separately:

```sh
bun run test:models:bun && bun run test:models   # native CPU Winzling-embed and ColBERT
bun run test:wasm:bun && bun run test:wasm       # browser entry with WASM, in Bun and Node.js
bun run test:gate:bun && bun run test:gate       # a skipped neural stage reads no ColBERT file
bun run test:gate:wasm:bun && bun run test:gate:wasm   # the same with the WASM backend
DEFUSS_LIVE_BROWSER=1 make e2e                   # real WASM models in Chromium
```

Reports go to `output/`, caches to `input/`, and service state to `tmp/` and `var/log/`. [.vae/VERIFY.py](.vae/VERIFY.py) is the defuss-vae policy; the Makefile gates need no agent plugin. The [verification record](docs/verification.md) lists the executed checks, and the [changelog](CHANGELOG.md) the releases. Start reading the code from [ARCH.md](ARCH.md).

## License

[MIT](LICENSE). The [research notes](docs/research.md) cite the fusion research and the upstream packages. Model and dependency licenses apply to their assets; see [THIRD_PARTY.md](THIRD_PARTY.md).
