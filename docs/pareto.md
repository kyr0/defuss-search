# Quality and inference-work frontier

VERIFIED: v0.4.0, lexicalsearch 0.3.0, vectorsearch 0.2.1, Bun 1.4.3. Two presets share the measured frontier with lexical-only search. `searchPreset('efficient')` is the fastest hybrid: 25 candidates per source, weighted RRF with k=1 and lexical/vector weights 3:1, no neural reranking. `searchPreset('reranked')` adds a gated ColBERT stage and has the highest mean R@5 over all 1,000 questions. Constructors without a preset keep their earlier defaults.

VERIFIED: both presets also apply the weak-lexical rule: when BM25's first hit matches less than 20% of the query's IDF-weighted words and trails the vector source's first hit by more than 0.15 cosine, the vector hit moves to the top. The replay below applies it after fusion and after the neural stage, as the engine does. Its thresholds were chosen by `bench/confidence-fusion.mjs` on all 1,000 questions and on other corpora, so the held-out figures are not independent of that choice; the fusion and neural settings were chosen on the development half alone.

## What Pareto-optimal means here

VERIFIED: the objectives maximize R@1, R@5, R@10, R@25 and candidate recall while minimizing vector queries, neural queries and neural documents. One evaluated configuration dominates another only when it is no worse on every objective and strictly better on at least one. This is a finite empirical frontier, not a proof over all possible algorithms or production corpora. Lexical traversal work, vector distance evaluations, memory, energy, browser latency and index construction are not frontier objectives. Vector-query counts describe retrieval calls; supplied query vectors can avoid embedding inference.

VERIFIED: 36 fusion candidates cover k in {0,1,5,10,20,60} and lexical/vector weight ratios in {0.25,0.5,1,2,3,4}:1. A separate 32-candidate neural sweep covers k in {0,1,10,60}, weights {0.25,0.5,1,2}, and an enabled/disabled 0.1 margin gate. Candidate budgets remain 25; these are not window-size or model-selection sweeps.

## Selection without translation leakage

VERIFIED: the first 25 original question groups and all their translations form the 500-query development partition. The last 25 groups and their translations form the 500-query holdout. Parameters are selected on development R@1, then R@5, R@10, R@25, candidate recall, then less inference work; names break remaining ties. Both selections are fixed before holdout evaluation. The fixture was already used for aggregate v0.2.0 reporting, so this is a parameter holdout, not a newly collected external test set. Different questions may still share a relevant passage.

The lexical adapter knows the query language; vector search scans all 2,000 passages. Gold passages must match the query language. No automatic language identification is implemented. Exact promotion and source-coverage policies are disabled in this benchmark and tested separately.

## Held-out results: 500 queries

VERIFIED: the selected configurations were evaluated unchanged on all 20 languages.

| Configuration | R@1 | R@5 | R@10 | Candidate recall | Vector queries | Neural queries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 91.4% | 97.0% | 98.0% | 98.6% | 0 | 0 |
| vector | 40.2% | 59.4% | 64.0% | 74.0% | 500 | 0 |
| vector-first | 70.4% | 73.4% | 73.6% | 74.0% | 500 | 0 |
| lexical-first | 61.6% | 72.0% | 79.2% | 98.6% | 500 | 0 |
| legacy-fusion | 66.4% | 79.6% | 95.6% | 99.8% | 500 | 0 |
| efficient | 92.4% | 96.6% | 98.4% | 99.8% | 500 | 0 |
| reranked-always | 92.0% | 96.8% | 98.4% | 99.8% | 500 | 500 |
| reranked | 92.4% | 96.8% | 98.4% | 99.8% | 500 | 444 |

VERIFIED: held-out frontier: `lexical`, `efficient`, `reranked`. Efficient dominates the previous equal-weight k=60 fusion on the measured objectives. Lexical-only remains cheaper and has slightly higher R@5 on this split; efficient improves R@1 and candidate recall. Reranking adds one held-out R@5 success for 444 neural calls: it buys quality with inference, and the website demo uses it by default.

## Full fixture: 1,000 queries

| Configuration | R@1 | R@5 | R@10 | Candidate recall | Vector queries | Neural queries |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 90.3% | 97.3% | 98.0% | 98.4% | 0 | 0 |
| vector | 41.7% | 60.5% | 66.4% | 75.8% | 1000 | 0 |
| vector-first | 72.5% | 75.3% | 75.5% | 75.8% | 1000 | 0 |
| lexical-first | 61.6% | 73.0% | 80.9% | 98.4% | 996 | 0 |
| legacy-fusion | 67.5% | 80.8% | 96.7% | 99.4% | 1000 | 0 |
| efficient | 91.3% | 97.3% | 98.5% | 99.4% | 1000 | 0 |
| reranked-always | 91.0% | 97.4% | 98.5% | 99.4% | 1000 | 1000 |
| reranked | 91.3% | 97.4% | 98.5% | 99.4% | 1000 | 885 |

The full-fixture table includes development data and is descriptive, not an independent generalization estimate. Each question has one gold passage; R@k is its inclusion rate. The fusion candidate pool is the deduplicated union, so its candidate recall can exceed either source's recall without guaranteeing better early ranks.

## Optional neural stage

VERIFIED: `searchPreset('reranked')` uses the same retrieval settings, then fuses the current prefix with raw ColBERT ranks using k=1, neural weight=0.25, and a 0.1 source-margin gate. It requires an attached reranker. With k=1 and weight=1/4, the prior winner scores at least 1/2; every other hit scores at most 1/3 + 1/8 = 11/24. Therefore this neural stage cannot displace the prior winner; it only refines lower ranks. Tests enumerate all 5,040 permutations of a seven-candidate list, alongside this general bound.

VERIFIED: the gate skips inference only when (1) the raw vector list is monotonic with at least two hits, (2) its first score leads the second by at least the configured threshold, (3) its winner is already first after hybrid ranking/policies, and (4) lexical retrieval agrees or is empty. A skip preserves the whole current ordering. `rerankDecision` reports the evidence; skipped hits contain no invented neural scores. Infinity disables the gate. A 0.1 cosine gap is a heuristic from vectorsearch 0.2.1, not a calibrated correctness probability, and is not portable to arbitrary score scales.

The upstream dense guard lives in `rerankHits` after inference. This package deliberately consumes raw `rerank` output to avoid double fusion, and evaluates its own hybrid-aware guard before calling that method. A wider dense lead never overrides lexical disagreement, literal promotion or global eligibility.

VERIFIED: raw ColBERT 1.5m q8 scores were measured on all 1,000 query prefixes with explicit truncation. Alternative fusion weights and gates replay those same measured scores. The gated call counts and summed saved inference times are counterfactual work estimates, not second end-to-end latency measurements. Real CPU/WASM integration tests separately prove that the gate can avoid every ColBERT file read and still allow forced inference.

UNKNOWN: quality on an external corpus, relevance judgments beyond one same-language gold, other embedding models, other neural budgets, and whether the small neural R@5 gain persists. No production superiority or universal optimum is claimed.

## Reproduce

`make bench` runs the end-to-end recall benchmark on Bun, Node.js and Chromium, this frontier analysis, and report generation. The first run downloads pinned models and the SHA-verified dataset. Cached embeddings are keyed by dataset/model; cached neural scores also bind candidate IDs, query texts, adapter source, peers, runtime and model files. Delete `input/pareto-neural.json` to measure neural inference again.

- Machine-readable results: `output/bench/pareto.json` and `output/bench/selection.json`.
- Website data: [data/pareto.json](data/pareto.json).
- Dataset: https://github.com/kyr0/tiny-embedding-bench/raw/refs/heads/main/datasets/tiny-embedding-bench-v1/dataset.json
- SHA-256: `3d09d3653b72cf19c5226cd134bdd7d92ac31f2822cf45bc60879e7a95a75e6d`.
- Updated upstream guard: https://github.com/kyr0/defuss-vectorsearch/commit/2548805349efba8070d06739cb38e625c4619784
