# Changelog

## Unreleased

- Add `buildColbertTokenIndex()` to `defuss-search/colbert`, and an `index` option to `createColbertRetriever()` that takes its result instead of `matrices`: a token index built once, for example at build time, ranks as one built from the same matrices without encoding or quantizing the documents again.
- The website demo preselects lexical-semantic tiny and downloads the passages' prebuilt token index (8.87 MB gzipped) instead of encoding the 2,000 passages in the browser, which took 13 to 15 s; MoEdernColBERT encodes only the questions and notes.
- The Pages workflow builds the site on every push to `main` and deploys that build. Served from the branch, the site lacked the gitignored ONNX Runtime Web files, so every model load failed with "no available backend found".

## 0.4.0

- Add an end-to-end recall benchmark: R@1, R@5, R@10 and R@25 per language for both presets through `HybridSearch`, run on Bun, Node.js and Chromium (WASM ColBERT). All three runtimes returned identical ranks for the 1,000 questions, matching the frontier replay.
- Add the website section "Measured, not promised" with preset tabs and nested R@k tabs, rendered statically from `docs/data/recall.json`; generate the README language tables from the same report.
- Fail `make verify` when the website section or README tables differ from the recall report.
- Replace `bench/multilingual.mjs` and `docs/data/languages.json` with the recall benchmark and report.
- Add `make dev`: the website with live reload, rebuilt when `website/`, `src/` or `fixtures/` change; `make e2e` checks that it serves the reload script and exits on SIGTERM.
- Rebuild the website on the layout of the defuss-lexicalsearch and defuss-vectorsearch sites: introduction, pipeline diagram, frontier and recall figures, consulting and usage sections with highlighted code and a coding-agent prompt, and the shared footer. The API and frontier pages share the header and highlight their code blocks. The vendored defuss-shadcn runtime replaces `website/tabs.mjs`.
- Replace the website demo with a factory picker and one result column: the reader picks lexical-only, lexical-semantic tiny or lexical-semantic (with or without the ColBERT reranker) before the demo shows, and the page loads only what that factory needs. The tiny factory encodes the 2,000 benchmark passages in the browser into a TurboQuant token index; lexical-semantic ranks benchmark questions with their recorded Winzling vectors, which now download separately from the passages. Models load with byte progress and stay in the Cache API; a button measures R@1 to R@25 for all 1,000 questions with the chosen factory and compares them with the published figures; the "My data" tab searches the user's own notes with the same factory. The equal-weight fusion profile and the strategy selector are removed from the demo.
- Each demo note has a language and is indexed with that language's analyzer and stopwords; a German note no longer matches a query on "mit".
- Notes search results explain their score in a "Why" panel (matched words, source ranks and scores, fusion terms) and lead to their note on the board.
- Add `bun run bench:semantic-first`, an experiment that ranks the vector top 25 by ColBERT and promotes passages by query-word coverage; on the benchmark holdout it reached 74.6% R@1 and 83.4% R@5, against 92.0% and 96.8% for the reranked preset.
- Add `bun run bench:bm25-switch`: six methods on Belebele subsets of 20 to 2,000 passages, on the passages cut to 6 to 32 words and on the 100 sample notes. BM25 leads on the passages at every size; on the notes, vector search alone reaches 98.9% R@1 for translations and 95.5% for paraphrases, against 61.5% and 63.6% for the reranked preset. Neither index size nor document length separates the two cases: Belebele passages cut to 8 terms still favor BM25.
- Add the opt-in option `vectorOnlyBelow`: below that many analyzed terms per document, a fusion query uses the vector source alone and skips the reranker; the lexical adapter reports the average with `averageLength()`, and responses carry `route`. No preset sets it: on Belebele passages cut to 8 terms, BM25 still led with 47.4% R@1 against 19.8% for the vector source.
- Add `bun run bench:colbert-retrieval`: MoEdernColBERT 1.5M as the first-stage retriever against Winzling. ColBERT retrieved worse on Belebele (36.8% against 41.7% R@1) and on the notes (59.3% against 98.9% for translations), with token matrices about 30 times the size of a Winzling vector.
- Both presets set the new option `weakLexical: { share: 0.2, gap: 0.15 }`: when BM25's first hit matches less than 20% of the query's words, weighted by their inverse document frequency in the index, and trails the vector source's first hit by more than 0.15 cosine, the vector hit moves to the top. On the benchmarks the efficient preset rose from 61.5% to 97.8% R@1 for notes found by their translations and from 63.6% to 86.4% for paraphrase queries, and from 91.0% to 91.3% on Belebele; R@5 stayed within 0.4 points on every corpus. Responses report the decision in `weakLexical`, the lexical adapter adds `matchShare()`, and constructors without a preset leave the option off.
- Add `bun run bench:confidence-fusion` and an API-docs corpus (`bench/api-docs.mjs`): defuss-shadcn's 410 MDX pages at a pinned commit in 8,043 sections, with 100 exact-word queries and 100 assistant-written natural-language queries. Dropping BM25 when its first hit matches less than 30% of the query's words, weighted by their IDF in the Belebele passages of the same language, and when its cosine to the query trails the vector first hit by more than 0.1 kept Belebele at 90.9% R@1 (efficient preset: 91.0%) and raised the notes' translation queries from 61.5% to 97.8%; it cost 4.3 points on passages cut to 6 words. Moving only the vector source's first hit to the top kept that R@1 and lost at most 0.4 points of R@5; that variant became the presets' rule.
- Add `defuss-search/strategies` with three ready-made searches on an existing `LexicalSearch` index: `createLexicalOnlySearch` (BM25, no model), `createLexicalSemanticTinySearch` (BM25 fused with MoEdernColBERT 1.5M, 3.97 MB, as the only vector model) and `createLexicalSemanticSearch` (Winzling vectors with the efficient preset, or the reranked preset when a ColBERT reranker is passed). The semantic factories load their adapters on demand. On notes found by their translations they reached 22.0%, 50.5% and 97.8% R@1; on Belebele 90.3%, 90.3% and 91.3%.
- Add `createColbertRetriever` to `defuss-search/colbert`: ColBERT token matrices as a first-stage retriever scored by averaged MaxSim, stored as TurboQuant codes of 64 bytes per token by default (`quantization: 'exact'` keeps float32). A query scans every token: 117 to 240 ms over Belebele's 181,361 tokens, 1.3 to 2.5 s over 2,070,075 tokens of the defuss-shadcn docs.
- The demo's factory picker shows each model's gzipped size next to its file size (MoEdernColBERT 2.09 MB, Winzling 29.08 MB) and each factory's R@1 / R@5 on the defuss-shadcn docs. `make docs` writes these tables into the page from `docs/data/strategies.json`, so they show before the scripts run.
- The website and the README describe exact matching with symbols and IDs, and their first example finds `Array.prototype.push()` by its exact symbol; `test/readme.test.mjs` checks each README example against the output its comment states.
- Remove the demo's `?models=local` mode and the local server's `/models/` route: the opt-in live e2e loads the models from Hugging Face, as a visitor does. The worker rejects a downloaded model file whose SHA-256 differs from the pin, and `make verify` checks that the manifest names the pinned revisions.
- The weak-lexical rule rescores BM25's first hit exactly also for queries given as text alone: the vector adapter keeps the last query's embedding, so the rescore runs no model. Text-only queries previously used a bound and moved the vector hit for 3 Belebele questions instead of 10; they now rank like queries that carry their vector.
- Both semantic factories accept `vector`, a vector source built earlier, so searches that differ only in their lexical options share one token index or vector set.
- Add `bun run bench:strategies`, which measures the three factories (R@1 to R@25, time per query, index size) and a weak-lexical gap grid for the tiny search, and publishes the figures the website shows to `docs/data/strategies.json`; the tiny search uses a gap of 0.1, which raised its R@1 on translated notes from 40.7% (rule off) to 50.5% and cost Belebele 0.2 points.
- `createHybridIndex()` adds an unstemmed companion field to every field whose analyzer stems (`surface`, on by default; `surface: false` turns it off). `defuss-search/lexical` adds `withSurfaceFields()` for indexes the caller builds, `surfaceAnalyzer()` and `surfaceField()`; `createLexicalRetriever()` searches a companion with its field and leaves it out of its statistics. On the defuss-shadcn docs, exact words rose from 71% to 98% R@1 and natural-language queries from 37% to 40% (efficient preset); Belebele moved from 91.3% to 91.2%. `bun run bench:surface` measures it, and the strategies benchmark indexes the docs with companions.
- Add `bun run bench:errors`, which classifies every rank-1 miss of the efficient preset on Belebele, the notes and the API docs. BM25 supplied the wrong winner in 77 of 87 Belebele misses; all 29 exact-word misses in the API docs are stemming collisions, and 30 of 63 natural-language misses lost to another section of the gold page.
- `make bench` writes the demo corpus to `docs/data/` with `scripts/demo-data.mjs`; `fixtures/language-embeddings.json` and `scripts/language-fixture.mjs` are removed.
- Install instructions use the package name, `bun add defuss-search`, instead of the local tarball.
- Restructure the README like the sibling packages (languages at a glance, reference, limits, configuration, website, development) and replace delivery-specific instructions in the reference and verification pages.

## 0.3.0

- Integrate published defuss-vectorsearch 0.2.1; keep lexicalsearch 0.3.0.
- Add explicit efficient and reranked presets selected on a grouped development partition; preserve legacy constructor defaults.
- Add an optional hybrid-aware vector-margin gate before neural inference, with structured decisions and no fabricated neural evidence.
- Preserve the prior winner under the selected low-weight neural fusion; verify the score bound and all seven-item permutations.
- Measure the finite quality/inference-work frontier on 1,000 multilingual queries, including a 500-query parameter holdout and real raw ColBERT scores.
- Keep browser ColBERT assets lazy; expose preset selection, measured frontier tables and a rendered methodology page.
- Verify zero neural model reads on the guarded library-note case, with native CPU and WASM runtimes.

## 0.2.0

- Refactor the engine into option, ranking, retrieval, literal-evidence and neural-reranking modules; preserve public entry points and query options.
- Document module invariants and public contracts; format the implementation and tooling consistently.
- Require lexical 0.3.0; retain vector 0.2.0, the latest verified published release on 2026-10-31.
- Fix literal exact promotion when fuzzy, prefix or substring defaults are enabled. Exact lookup disables lexical expansions while retaining eligibility.
- Exercise all 20 language analyzers on Bun and Node, and evaluate the pinned 20-language upstream dataset with real embeddings.
- Add a static docs website, multilingual worker demo, API reference and measured language table.
- Align the README, architecture documentation, Makefile, defuss-vae policy and GitHub verification/Pages workflows with the sibling projects.
- Test native and WASM model integration under Bun as well as Node and Chromium.

VERIFIED: the docs distribution includes all ONNX Runtime Web loader/WASM variants selected by browser capabilities. The live browser gate exercises model loading and reranking without cross-origin isolation headers.

## 0.1.0

- Introduce both retrieval cascades, weighted RRF and normalized score fusion, exact promotion, source coverage and optional ColBERT reranking.
