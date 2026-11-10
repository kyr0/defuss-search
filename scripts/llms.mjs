/**
 * docs/llms.txt (https://search.defuss.org/llms.txt, the llmstxt.org format): what a coding agent needs to choose,
 * install and use defuss-search, in one page. Every figure comes from the reports that `make bench` and
 * `bun run bench:strategies` write, and the quick start is the main page's usage example, so the file cannot claim
 * more than the measurements show; scripts/check-project.mjs compares the committed file with this rendering.
 * Why one file with the essentials, not a link list only: an agent reads it once, without fetching ten pages, and
 * the links point to the full reference when it needs more.
 * VERIFIED: scripts/check-project.mjs fails when docs/llms.txt differs from this rendering.
 */
const SITE = 'https://search.defuss.org';
const REPO = 'https://github.com/kyr0/defuss-search';
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

/** The usage example of website/index.html (`<pre data-code="js" data-id="usage-code">`), unescaped. */
export function usageCode(indexSource) {
  const code = indexSource.match(/<pre data-code="js"[^>]*data-id="usage-code">\n?([\s\S]*?)<\/pre>/)?.[1];
  if (!code) throw new Error('website/index.html lacks the usage-code example');
  return code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trimEnd();
}

export function renderLlms({ pkg, recall, strategies, pareto, indexSource }) {
  const efficient = recall.presets.find((preset) => preset.id === 'efficient');
  const reranked = recall.presets.find((preset) => preset.id === 'reranked');
  const corpus = (name) => strategies.corpora[name];
  const { passages, questions } = recall.dataset;
  const languages = Object.keys(recall.languages).length;
  const [weakestCode, weakest] = Object.entries(efficient.languages).sort(([, a], [, b]) => a.r1 - b.r1)[0];
  const row = (label, name) =>
    `| ${label} | ${['lexical-only', 'tiny', 'efficient']
      .map((id) => `${pct(corpus(name)[id].r1)} / ${pct(corpus(name)[id].r5)}`)
      .join(' | ')} |`;
  const holdout = (name) => pareto.holdout.results.find((result) => result.name === name);
  return `# defuss-search

> Hybrid search for JavaScript and TypeScript in the browser, Bun and Node.js. BM25 and vector retrieval run over the same documents and are fused into one ranking; a document whose symbol or ID equals the query ranks first, an optional ColBERT reranker refines the top 25, and every hit explains its rank. No search server; the root entry has no runtime dependencies. MIT license, version ${pkg.version}.

Use it when one search box must find exact strings (symbols, IDs, error codes, part numbers) and meaning (paraphrases, translations) in one ranked list, inside your app. It is not a hosted search service: it has no server, persistence, authentication or approximate nearest-neighbor index (see Limits).

## Measured

From this repository's benchmarks, version ${recall.version} (\`make bench\`, \`bun run bench:strategies\`, ${strategies.runtime}, one thread). Recall@k (R@k) is the share of queries whose relevant document ranks in the top k.

- ${pct(efficient.mean.r1)} R@1 and ${pct(efficient.mean.r5)} R@5 for ${questions.toLocaleString('en')} questions in ${languages} languages over ${passages.toLocaleString('en')} passages (tiny-embedding-bench-v1, a Belebele subset), default fusion without a reranker. Bun, Node.js and Chromium return the same rank for every question.
- ${pct(corpus('api docs exact').efficient.r1)} R@1 for exact matches in 8,043 documentation sections (defuss-shadcn; each query uses a section's own words).
- ${pct(corpus('notes translation').efficient.r1)} R@1 for notes searched in another language; BM25 alone reaches ${pct(corpus('notes translation')['lexical-only'].r1)}.
- ${pct(holdout('efficient').r1)} R@1 on 500 held-out questions with the fusion settings tuned on 500 others; the gated reranker reaches the same R@1 (${pct(holdout('reranked').r1)}).
- Fusing and ranking ${passages.toLocaleString('en')} passages takes ${strategies.corpora.belebele.efficient.ms.toFixed(1)} ms per query once the query vector exists; model inference is extra.
- Model downloads: none for lexical-only search, ${mb(strategies.modelBytes.colbert)} (Winzling-reranker) for the tiny factory, ${mb(strategies.modelBytes.winzling)} (Winzling-embed) for the lexical-semantic factory, each as Brotli files decoded in the browser.

| Query set, R@1 / R@5 | Lexical-only | Tiny | Lexical-semantic |
| --- | ---: | ---: | ---: |
${row(`Belebele, ${questions.toLocaleString('en')} questions, ${languages} languages`, 'belebele')}
${row('Notes found by their translations', 'notes translation')}
${row('Notes found by a paraphrase', 'notes paraphrase')}
${row('API docs, exact matches', 'api docs exact')}
${row('API docs, natural-language questions', 'api docs natural')}

## Install

\`\`\`sh
bun add defuss-search defuss-lexicalsearch defuss-vectorsearch
\`\`\`

\`pnpm add\`, \`npm install\` and \`yarn add\` take the same packages. \`defuss-lexicalsearch\` and \`defuss-vectorsearch\` are optional peers: install the ones you use.

## Quick start

\`\`\`js
${usageCode(indexSource)}
\`\`\`

## Choose

- Factories in \`defuss-search/strategies\`, each returning a \`HybridSearch\`: \`createLexicalOnlySearch(index)\` needs no model; \`createLexicalSemanticTinySearch(index, { documents, colbert })\` uses one ${mb(strategies.modelBytes.colbert)} model; \`createLexicalSemanticSearch(index, { documents, embedder, reranker })\` uses Winzling-embed vectors and an optional ColBERT reranker. Start with lexical-only and add a model when translations or paraphrases matter.
- Presets: \`searchPreset('efficient')\` fuses without a reranker; pass it whenever no reranker is configured. \`searchPreset('reranked')\`, the default, needs a reranker; on the benchmark it matched efficient's R@1 (${pct(reranked.mean.r1)}) and ran ColBERT for ${reranked.neuralQueries} of ${questions.toLocaleString('en')} questions.
- Retrieval: \`strategy: 'fusion'\` (default), \`'vector-first'\` or \`'lexical-first'\`. A cascade never adds candidates its first stage missed.
- Exact matches: \`exact: 'promote'\` with \`lexicalSearch: { exact: { fields: [...] } }\` ranks original-string matches first.
- Languages: one lexical analyzer per language field; pass the query's \`language\`, the package does not detect it.

## Entry points

| Entry | Exports |
| --- | --- |
| \`defuss-search\` | \`HybridSearch\`, \`fuseRankings\`, \`searchPreset\`, types |
| \`defuss-search/indexing\` | \`createHybridIndex\` |
| \`defuss-search/strategies\` | \`createLexicalOnlySearch\`, \`createLexicalSemanticTinySearch\`, \`createLexicalSemanticSearch\` |
| \`defuss-search/lexical\` | \`createLexicalRetriever\`, \`withSurfaceFields\`, \`surfaceAnalyzer\`, \`surfaceField\` |
| \`defuss-search/vector\` | \`createVectorRetriever\` |
| \`defuss-search/colbert\` | \`createColbertAdapter\`, \`createColbertRetriever\`, \`buildColbertTokenIndex\` |

ESM and CommonJS with TypeScript declarations. Importing the package downloads no model; the caller creates and disposes models.

## Results

- \`rank\` is the final order. Scores from different stages use different scales: never sort hits by score.
- Each hit carries its rank and raw score per source, the fusion contributions and the reasons for a promotion; \`searchWithStats()\` adds candidate counts, stage timings and the reranker decision.
- Shared \`ids\` eligibility restricts both sources before top-k.

## Limits

- No language detection, persistence, server, authentication, model download or embedding training.
- Vector search scores every eligible row (exact or TurboQuant codes); there is no approximate nearest-neighbor index, so query cost grows with the corpus.
- \`createHybridIndex()\` holds an immutable snapshot; rebuild it to update.
- Query and document vectors must come from the same model and preprocessing.
- An \`AbortSignal\` cannot interrupt a running ONNX call.
- The figures above hold for these fixtures. Model quality differs by language: the weakest of the ${languages}, ${recall.languages[weakestCode].name}, reaches ${pct(weakest.r1)} R@1.

## Docs

- [README](${REPO}#readme): usage, presets, per-language recall table
- [API reference](${SITE}/reference.html): every option, adapters, neural reranking
- [Frontier analysis](${SITE}/pareto.html): how the presets were chosen, with costs and limits
- [Live demo and playground](${SITE}/): the benchmark in your browser, and runnable code
- [Architecture](${REPO}/blob/main/ARCH.md): design, operations, security and privacy

## Optional

- [npm package](https://www.npmjs.com/package/defuss-search)
- [Changelog](${REPO}/blob/main/CHANGELOG.md)
- [Models and licenses](${REPO}/blob/main/THIRD_PARTY.md)
`;
}
