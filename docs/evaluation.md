# Evaluation of v0.4.0

VERIFIED: Authored illustrative fixture, no held-out tuning or confidence intervals. These results do not establish production superiority. Neural rows include exact promotion; not a pure reranker ablation.

52 API documents, 15 queries. Real pinned Winzling embeddings. Full details and per-query judgments: `fixtures/api-corpus.mjs`, `output/benchmark.json`. Scores below use graded relevance for nDCG; any positive grade counts for Recall/MRR. Candidate recall measures this finite retrieved pool.

| Configuration | Recall@10 | MRR@10 | nDCG@10 | Top-1 relevant | Candidate recall |
|---|---:|---:|---:|---:|---:|
| lexical | 96.7% | 0.850 | 0.882 | 73.3% | 100.0% |
| vector | 90.0% | 0.716 | 0.765 | 60.0% | 90.0% |
| efficient | 96.7% | 0.889 | 0.910 | 80.0% | 100.0% |
| efficient + exact | 96.7% | 0.889 | 0.910 | 80.0% | 100.0% |
| vector-first | 90.0% | 0.783 | 0.815 | 66.7% | 90.0% |
| lexical-first | 96.7% | 0.786 | 0.833 | 66.7% | 100.0% |
| fusion | 96.7% | 0.811 | 0.854 | 66.7% | 100.0% |
| fusion + exact + coverage | 96.7% | 0.811 | 0.854 | 66.7% | 100.0% |
| vector-first + exact + ColBERT | 90.0% | 0.844 | 0.834 | 80.0% | 90.0% |
| lexical-first + exact + ColBERT | 96.7% | 0.811 | 0.847 | 73.3% | 100.0% |
| fusion + exact + ColBERT | 96.7% | 0.822 | 0.859 | 73.3% | 100.0% |
| reranked + exact | 96.7% | 0.889 | 0.911 | 80.0% | 100.0% |

Latency below excludes embeddings and ColBERT, measured on darwin arm64 with Bun 1.4.3. 10,000 synthetic 64D documents, 5 warmups, 30 samples. These are a reproducibility smoke test, not a general performance guarantee.

| Vector scan | Build ms | Median ms | p95 ms |
|---|---:|---:|---:|
| exact | 52.33 | 3.33 | 3.75 |
| turboquant | 57.42 | 3.64 | 9.58 |

Exact mode scores and sorts all eligible rows. TurboQuant also scans all rows, then refines 100 float-vector candidates. This adapter retains the original vectors for exact rescoring; it does not claim the memory savings of a quantized-only index.
