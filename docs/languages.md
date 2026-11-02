# Multilingual retrieval

VERIFIED: v0.4.0 integrates all 20 lexicalsearch 0.3.0 analyzers with vectorsearch 0.2.1. The pinned fixture contains 2,000 passages and 1,000 questions, with 50 questions per language. Lexical retrieval knows the query language; vector retrieval searches the entire corpus. Each query has one same-language gold passage.

The efficient preset uses lexical-weighted RRF (3:1, k=1), selected on 500 development queries, and the weak-lexical rule. The table includes all 1,000 queries; see the [Pareto report](pareto.md) for the separate held-out results and the finite scope of its optimality claim. Analyzer availability does not establish equal semantic quality.

| Language | Analyzer | Winzling target | Lexical R@5 | Vector R@5 | Efficient R@5 | Reranked R@5 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| English | `en` | yes | 100.0% | 100.0% | 100.0% | 100.0% |
| German | `de` | yes | 98.0% | 96.0% | 100.0% | 100.0% |
| French | `fr` | yes | 100.0% | 94.0% | 100.0% | 100.0% |
| Spanish | `es` | yes | 98.0% | 84.0% | 98.0% | 98.0% |
| Portuguese | `pt` | yes | 98.0% | 94.0% | 98.0% | 98.0% |
| Italian | `it` | yes | 98.0% | 86.0% | 100.0% | 100.0% |
| Dutch | `nl` | yes | 98.0% | 90.0% | 98.0% | 98.0% |
| Polish | `pl` | no | 96.0% | 78.0% | 96.0% | 98.0% |
| Russian | `ru` | yes | 100.0% | 94.0% | 100.0% | 100.0% |
| Turkish | `tr` | no | 96.0% | 74.0% | 96.0% | 96.0% |
| Arabic | `ar` | no | 96.0% | 4.0% | 96.0% | 96.0% |
| Hindi | `hi` | no | 86.0% | 10.0% | 84.0% | 84.0% |
| Bangla | `bn` | no | 94.0% | 8.0% | 94.0% | 94.0% |
| Urdu | `ur` | no | 100.0% | 18.0% | 98.0% | 98.0% |
| Indonesian | `id` | yes | 98.0% | 92.0% | 100.0% | 100.0% |
| Vietnamese | `vi` | no | 98.0% | 58.0% | 98.0% | 98.0% |
| Thai | `th` | no | 98.0% | 20.0% | 98.0% | 98.0% |
| Chinese | `zh` | no | 98.0% | 32.0% | 98.0% | 98.0% |
| Japanese | `ja` | no | 100.0% | 38.0% | 98.0% | 98.0% |
| Korean | `ko` | no | 96.0% | 40.0% | 96.0% | 96.0% |

VERIFIED: `test/languages.test.mjs` exercises all analyzer imports, the three original strategies, exact symbols and eligibility on Bun and Node. Browser tests exercise all 20 language selections using recorded real Winzling vectors. The frontier benchmark replays real ColBERT scores for all 1,000 query prefixes, using explicit truncation. The [end-to-end recall report](data/recall.json) runs both presets through `HybridSearch` on Bun, Node.js and Chromium and reproduces this table's efficient and reranked figures.

VERIFIED: Winzling's nine target languages remain distinct from the additional eleven. Neither new hybrid preset performs language detection or silently routes an unsupported language to a different model. Clients choose analyzers and compatible query/document embeddings.

See [release provenance](upstreams.json), [API evaluation](evaluation.md), [verification](verification.md), and [Pareto methodology](pareto.md).
