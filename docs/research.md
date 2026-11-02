# Research and implementation decisions

Research date: 2026-10-31. This package implements retrieval orchestration; the underlying lexical and vector algorithms remain in their own packages.

## Current upstream basis

| Repository | Inspected commit | Installed release |
|---|---|---|
| [kyr0/defuss-lexicalsearch](https://github.com/kyr0/defuss-lexicalsearch) | `904701a0fc1add25bd71e4cd44c622e6ac0af2e2` | `0.3.0` |
| [kyr0/defuss-vectorsearch](https://github.com/kyr0/defuss-vectorsearch) | `2548805349efba8070d06739cb38e625c4619784` | `0.2.1` |

The actual published packages are installed as pinned development dependencies; the lockfile records their integrity. Runtime compatibility is declared through optional `^0.3.0` lexical and `^0.2.1` vector peers. The package does not vendor either repository or copy its model implementation.

The lexical package exposes candidate IDs in its existing full-index search. The vector package exposes pure TurboQuant scoring, exact float rescoring, Winzling embeddings, raw ColBERT `rerank()`, and dense-plus-ColBERT `rerankHits()`. These distinctions determine the adapters rather than guessing from method names. The existing API preset is an object; its exact-first ordering is not necessarily descending in raw BM25 scores.

## Evidence

1. [Cormack, Clarke and Büttcher, SIGIR 2009: Reciprocal Rank Fusion](https://cormack.uwaterloo.ca/cormack/cormacksigir09-rrf.pdf). RRF combines ordered lists using reciprocal ranks, without requiring their scores to share a scale. The paper selected `k=60` during pilot work and evaluated it on several retrieval collections. This supports a useful default, not a universal optimal parameter. Our implementation extends the sum with explicit nonnegative source weights and treats missing finite-window hits as zero votes.
2. [Bruch, Gai and Ingber: An Analysis of Fusion Functions for Hybrid Retrieval](https://arxiv.org/abs/2210.11934) ([TOIS DOI](https://doi.org/10.1145/3596512)). Their experiments find RRF parameter sensitivity and advantages for tuned convex score combination. We therefore expose both RRF and normalized weighted score fusion. We do not call RRF parameter-free or claim it dominates calibrated score fusion. No learned weights are shipped because no representative held-out user query set was supplied.
3. [Sentence Transformers: Retrieve & Re-Rank](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html). This describes a candidate retrieval stage, lexical or dense, followed by a more costly scorer on those candidates. Our deduction: a reranker cannot recover an omitted document. Both cascade modes therefore preserve a clear first-stage recall ceiling. ColBERT is a late-interaction model, not the cross-encoder used in that tutorial; the orchestration principle transfers, not the architecture or score semantics.
4. [Elasticsearch RRF reference](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion). Independent retrievers, bounded rank windows and fusion before pagination provide a useful operational model. We keep windows fixed across pages and document that changing windows can change scores and ordering. We interpret recommendations to use RRF without tuning as a starting point, in light of the contrary parameter-sensitivity evidence above.

## Chosen behavior

**Two-stage retrieval.** Vector-first retrieves 25 vector candidates, then searches the original lexical index restricted to their IDs. This preserves full-corpus document frequencies and lengths for BM25. Missing lexical hits remain at the end by default: lexical zero-overlap is expected for some semantic matches. Lexical-first retrieves 25 lexical candidates and scores their vectors exactly. Neither mode searches outside that pool in stage two. Replacement and rank-fusion variants are both available.

**Parallel union.** Fusion independently retrieves lexical and vector candidates and deduplicates their union by stable IDs. Weighted RRF is the default because lexical exact-first tiers, BM25 scores and cosine similarities have incompatible semantics. Input order, not numeric score sorting, defines source ranks. Normalized linear fusion is explicit and rejects nonmonotonic score lists. Its constant-list and missing-hit conventions are documented and tested.

**Exactness and representation.** RRF alone cannot guarantee that a literal identifier beats a document receiving two moderate votes. Nor can it guarantee that each source has a representative in a truncated top 5. These are product requirements separate from fusion scoring. Literal equality on configured original fields can promote verified identifiers; an optional fixed-prefix coverage policy reserves the best available source representatives. Both are re-applied after neural ranking. Infeasible combinations raise an error. No fuzzy, phonetic or analyzed token match is silently labeled literal equality.

**Existing reranking.** The upstream vector package's `rerankHits()` already incorporates dense rank. Calling that and treating its result as an independent extra dense vote would overweight dense retrieval. This package uses raw `rerank()`, maps its relative candidate positions to document IDs, and optionally fuses that order with the current hybrid order. This is explicitly hierarchical fusion, not the same formula as a single three-source flat RRF. `method: 'replace'` is also available for experiments.

**Bounded cost and candid score explanations.** Only a configurable prefix enters the neural stage. Unreranked tail candidates remain behind that prefix. Their original scores are not comparable with the new scores, so final rank and score kind are separate. Original and neural fusion contributions remain inspectable. Duplicate source votes, nonfinite scores and candidate-scope escapes are rejected.

**Scale.** The included dense adapter uses upstream exact or TurboQuant scans, not HNSW or another sublinear index. Exact mode sorts eligible scored vectors. TurboQuant scores all rows, applies eligibility before truncation, and can refine an approximate shortlist. Full floats remain available for exact rescoring; this is a deliberate memory tradeoff. Larger backends can implement the same retriever contract.

## Evaluation and limits

The authored 52-document / 15-query fixture includes punctuation-heavy identifiers and paraphrases. Embeddings and reranking were run with pinned Winzling and MoEdernColBERT 1.5m q8 releases. Their actual hashes and outputs are in `output/model-assets.json` and `output/live-node.json`; query/document vectors are included for reproducibility without downloads. Tests also use small hand-authored vectors solely for numeric and ordering assertions, clearly separated from quality evaluation.

The [evaluation](evaluation.md) reports lexical-only and vector-only baselines, both cascades, fusion, policies and a neural stage. This API-heavy fixture favors lexical search: fusion does not uniformly beat its strongest source. Several neural configurations improve one metric while weakening another. Those findings support configurable strategies and explicit policies, not an automatic claim of improvement. Neural rows include exact promotion, so they are not a pure neural ablation. Production tuning should use separate training/validation queries, held-out judgments, candidate recall, nDCG/MRR, and end-to-end latency with the intended model and corpus size.

Persistence, HTTP serving, incremental vector updates, document chunking and training a learned ranker are outside this package's scope. The owned-index factory is an immutable snapshot; custom backends and upstream indexes can provide storage and indexing lifecycle. Models remain caller-owned and must be disposed by the caller.

## v0.3.0: measured frontier and early inference gate

VERIFIED: vectorsearch 0.2.1 was published on 2026-10-31 at 15:48:17 UTC. Its [source change](https://github.com/kyr0/defuss-vectorsearch/commit/2548805349efba8070d06739cb38e625c4619784) adds a dense-score margin guard to `fuseRanks` and `rerankHits`: with the default margin 0.1, the dense order survives a sufficiently large lead. `rerankHits` still encodes the query and passages before making that decision.

VERIFIED: hybrid search consumes raw `rerank`, so upgrading the peer alone would not adopt that guard. The new explicit hybrid gate runs before inference, and adds lexical/current-order agreement requirements so a vector margin cannot override lexical disagreement or an exact promotion. Tests use the published German library-note case with actual model providers and confirm zero ColBERT file reads on the skipped path.

VERIFIED: [the frontier experiment](pareto.md) selects lexical-weighted k=1 fusion and an optional low-weight neural stage on a grouped development partition. Both presets are exposed explicitly rather than changing historical defaults. The efficient preset is the recommendation because the neural alternative buys only one extra held-out R@5 success for hundreds of inference calls. Pareto optimality is scoped to the stated finite configurations, data, objectives and inference-work accounting.
