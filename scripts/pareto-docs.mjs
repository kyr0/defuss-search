/** VERIFIED: derive published tables from measured reports; never fill missing measurements. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { languageCases, targetLanguages } from '../fixtures/languages.mjs';
import { searchPreset } from 'defuss-search';
import { LANGUAGE_GUESS } from './recall-docs.mjs';

const rule = searchPreset('efficient').weakLexical;
const report = JSON.parse(await readFile('output/bench/pareto.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (report.version !== pkg.version)
  throw new Error('Rerun the frontier benchmark for this release');
const percent = (n) => `${(100 * n).toFixed(1)}%`;
const { winzling, other } = report.selected.fusion;
const groupOf = (name) => report.fusionGroups.find((group) => group.name === name);
const developmentQueries = (name) => groupOf(name).grid[0].queries;
const fusionText = `weighted RRF with lexical/vector weights ${other.lexicalWeight}:1 and k=${other.k}; a query whose \`language\` is one of Winzling-embed's ${groupOf('winzling').languages.length} target languages gets ${winzling.lexicalWeight}:1 and k=${winzling.k} (\`fusion.byLanguage\`)`;
const ungrouped = (part) => report[part].results.find((row) => row.name === 'efficient-ungrouped');
// Which preset has the higher mean R@5 over all 1,000 questions, as measured, not as last time.
const allRow = (name) => report.all.results.find((row) => row.name === name);
const rerankedLeads = allRow('reranked').r5 > allRow('efficient').r5;
const rerankedText = rerankedLeads
  ? 'adds a gated ColBERT stage and has the highest mean R@5 over all 1,000 questions'
  : `adds a gated ColBERT stage; over all 1,000 questions it reaches ${percent(allRow('reranked').r5)} R@5 against ${percent(allRow('efficient').r5)} for efficient, so the neural stage buys no R@5 on this fixture`;
// The neural stage's held-out effect in questions, per k, as measured.
const holdoutRow = (name) => report.holdout.results.find((row) => row.name === name);
const neuralDeltas = [1, 5, 10, 25]
  .map((k) => [
    k,
    Math.round(
      (holdoutRow('reranked')[`r${k}`] - holdoutRow('efficient')[`r${k}`]) *
        holdoutRow('efficient').queries,
    ),
  ])
  .filter(([, delta]) => delta !== 0)
  .map(
    ([k, delta]) =>
      `${delta > 0 ? '+' : ''}${delta} R@${k} ${Math.abs(delta) === 1 ? 'success' : 'successes'}`,
  );
const neuralText = `Against efficient, reranking changes ${neuralDeltas.length ? neuralDeltas.join(', ') : 'no held-out R@k success'} for ${holdoutRow('reranked').neuralQueries} neural calls`;
const table = (rows) =>
  rows
    .map(
      (row) =>
        `| ${row.name} | ${percent(row.r1)} | ${percent(row.r5)} | ${percent(row.r10)} | ${percent(row.candidateRecall)} | ${row.vectorQueries} | ${row.neuralQueries} |`,
    )
    .join('\n');
const header =
  '| Configuration | R@1 | R@5 | R@10 | Candidate recall | Vector queries | Neural queries |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |';
const snapshot = {
  version: report.version,
  dataset: report.dataset,
  selected: report.selected,
  development: report.development,
  holdout: report.holdout,
  all: report.all,
};
await mkdir('docs/data', { recursive: true });
await writeFile('docs/data/pareto.json', JSON.stringify(snapshot, null, 2) + '\n');
const languages = languageCases.map(({ entry, code, name }) => {
  const rows = report.languages[code].results;
  const recall = (method) => rows.find((row) => row.name === method).r5;
  return {
    entry,
    code,
    name,
    target: targetLanguages.has(code),
    lexical: recall('lexical'),
    vector: recall('vector'),
    efficient: recall('efficient'),
    reranked: recall('reranked'),
  };
});
await writeFile(
  'docs/pareto.md',
  `# Quality and inference-work frontier

VERIFIED: v${report.version}, lexicalsearch ${report.peers.lexical}, vectorsearch ${report.peers.vector}, ${report.runtime}. The held-out frontier holds ${report.holdout.frontier.map((x) => `\`${x}\``).join(', ')}. \`searchPreset('efficient')\` is the fastest hybrid: 25 candidates per source, ${fusionText}, no neural reranking. \`searchPreset('reranked')\` ${rerankedText}. Constructors without a preset keep their earlier defaults.

VERIFIED: both presets also apply the weak-lexical rule: when BM25's first hit matches less than ${100 * rule.share}% of the query's IDF-weighted words and trails the vector source's first hit by more than ${rule.gap} cosine, the vector hit moves to the top. The replay below applies it after fusion and after the neural stage, as the engine does. Its thresholds were chosen by \`bench/confidence-fusion.mjs\` on all 1,000 questions and on other corpora, so the held-out figures are not independent of that choice; the fusion and neural settings were chosen on the development half alone.

## What Pareto-optimal means here

VERIFIED: the objectives maximize R@1, R@5, R@10, R@25 and candidate recall while minimizing vector queries, neural queries and neural documents. One evaluated configuration dominates another only when it is no worse on every objective and strictly better on at least one. This is a finite empirical frontier, not a proof over all possible algorithms or production corpora. Lexical traversal work, vector distance evaluations, memory, energy, browser latency and index construction are not frontier objectives. Vector-query counts describe retrieval calls; supplied query vectors can avoid embedding inference.

VERIFIED: 36 fusion candidates cover k in {0,1,5,10,20,60} and lexical/vector weight ratios in {0.25,0.5,1,2,3,4}:1, selected separately for Winzling-embed's target languages (${developmentQueries('winzling')} development queries) and the other languages (${developmentQueries('other')}). A separate 32-candidate neural sweep covers k in {0,1,10,60}, weights {0.25,0.5,1,2}, and an enabled/disabled 0.1 margin gate. Candidate budgets remain 25; these are not window-size or model-selection sweeps.

## Selection without translation leakage

VERIFIED: the first 25 original question groups and all their translations form the 500-query development partition. The last 25 groups and their translations form the 500-query holdout. Parameters are selected on development R@1, then R@5, R@10, R@25, candidate recall, then less inference work; names break remaining ties. All selections are fixed before holdout evaluation. The fixture was already used for aggregate v0.2.0 reporting, so this is a parameter holdout, not a newly collected external test set. Different questions may still share a relevant passage.

The lexical adapter knows the query language; vector search scans all 2,000 passages. Gold passages must match the query language. No automatic language identification is implemented. Exact promotion and source-coverage policies are disabled in this benchmark and tested separately.

## Held-out results: 500 queries

VERIFIED: the selected configurations were evaluated unchanged on all 20 languages.

${header}
${table(report.holdout.results)}

VERIFIED: held-out frontier: ${report.holdout.frontier.map((x) => `\`${x}\``).join(', ')}. \`efficient-ungrouped\` applies the other languages' setting to every language, as the presets did before \`byLanguage\`: ${percent(ungrouped('holdout').r1)} R@1 and ${percent(ungrouped('holdout').r5)} R@5 against efficient's ${percent(holdoutRow('efficient').r1)} and ${percent(holdoutRow('efficient').r5)}. Why two groups: Winzling-embed's vectors are far stronger in its target languages, and in \`bun run bench:language-groups\` four groups by language family led two by only 0.15 points R@1, while one group, searched bins and one group per language scored lower. Efficient dominates the previous equal-weight k=60 fusion on the measured objectives. Lexical-only remains cheaper and ${holdoutRow('lexical').r5 > holdoutRow('efficient').r5 ? 'has slightly higher' : holdoutRow('lexical').r5 === holdoutRow('efficient').r5 ? 'reaches the same' : 'has lower'} R@5 on this split; efficient improves R@1 and candidate recall. ${neuralText}.

## Full fixture: 1,000 queries

${header}
${table(report.all.results)}

The full-fixture table includes development data and is descriptive, not an independent generalization estimate. Each question has one gold passage; R@k is its inclusion rate. The fusion candidate pool is the deduplicated union, so its candidate recall can exceed either source's recall without guaranteeing better early ranks.

## Optional neural stage

VERIFIED: \`searchPreset('reranked')\` uses the same retrieval settings, then fuses the current prefix with raw ColBERT ranks using k=${report.selected.neural.k}, neural weight=${report.selected.neural.weight}, and a 0.1 source-margin gate. It requires an attached reranker. With k=1 and weight=1/4, the prior winner scores at least 1/2; every other hit scores at most 1/3 + 1/8 = 11/24. Therefore this neural stage cannot displace the prior winner; it only refines lower ranks. Tests enumerate all 5,040 permutations of a seven-candidate list, alongside this general bound.

VERIFIED: the gate skips inference only when (1) the raw vector list is monotonic with at least two hits, (2) its first score leads the second by at least the configured threshold, (3) its winner is already first after hybrid ranking/policies, and (4) lexical retrieval agrees or is empty. A skip preserves the whole current ordering. \`rerankDecision\` reports the evidence; skipped hits contain no invented neural scores. Infinity disables the gate. A 0.1 cosine gap is a heuristic from vectorsearch 0.2.1, not a calibrated correctness probability, and is not portable to arbitrary score scales.

The upstream dense guard lives in \`rerankHits\` after inference. This package deliberately consumes raw \`rerank\` output to avoid double fusion, and evaluates its own hybrid-aware guard before calling that method. A wider dense lead never overrides lexical disagreement, literal promotion or global eligibility.

VERIFIED: raw ColBERT 1.5m q8 scores were measured on all 1,000 query prefixes with explicit truncation. Alternative fusion weights and gates replay those same measured scores. The gated call counts and summed saved inference times are counterfactual work estimates, not second end-to-end latency measurements. Real CPU/WASM integration tests separately prove that the gate can avoid every ColBERT file read and still allow forced inference.

UNKNOWN: quality on an external corpus, relevance judgments beyond one same-language gold, other embedding models, other neural budgets, and whether the neural stage helps on other data. No production superiority or universal optimum is claimed.

## Reproduce

\`make bench\` runs the end-to-end recall benchmark on Bun, Node.js and Chromium, this frontier analysis, and report generation. The first run downloads pinned models and the SHA-verified dataset. Cached embeddings are keyed by dataset/model; cached neural scores also bind candidate IDs, query texts, adapter source, peers, runtime and model files. Delete \`input/pareto-neural.json\` to measure neural inference again.

- Machine-readable results: \`output/bench/pareto.json\` and \`output/bench/selection.json\`.
- Website data: [data/pareto.json](data/pareto.json).
- Dataset: ${report.dataset.url}
- SHA-256: \`${report.dataset.sha256}\`.
- Updated upstream guard: https://github.com/kyr0/defuss-vectorsearch/commit/2548805349efba8070d06739cb38e625c4619784
`,
);
// scripts/recall-docs.mjs fills the guessed-language block from the recall report, which recall-report.mjs writes
// after this script; a rerun here keeps the block it finds.
const guessBlock =
  (await readFile('docs/languages.md', 'utf8').catch(() => '')).match(LANGUAGE_GUESS)?.[0] ??
  '<!-- language-guess:start -->\n<!-- language-guess:end -->';
await writeFile(
  'docs/languages.md',
  `# Multilingual retrieval

VERIFIED: v${report.version} integrates all 20 lexicalsearch ${report.peers.lexical} analyzers with vectorsearch ${report.peers.vector}. The pinned fixture contains 2,000 passages and 1,000 questions, with 50 questions per language. Lexical retrieval knows the query language; vector retrieval searches the entire corpus. Each query has one same-language gold passage.

The efficient preset uses lexical-weighted RRF (${other.lexicalWeight}:1, k=${other.k}; ${winzling.lexicalWeight}:1, k=${winzling.k} for Winzling-embed's target languages), selected per group on 500 development queries, and the weak-lexical rule. The table includes all 1,000 queries; see the [Pareto report](pareto.md) for the separate held-out results and the finite scope of its optimality claim. Analyzer availability does not establish equal semantic quality.

| Language | Analyzer | Winzling target | Lexical R@5 | Vector R@5 | Efficient R@5 | Reranked R@5 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
${languages.map((x) => `| ${x.name} | \`${x.entry}\` | ${x.target ? 'yes' : 'no'} | ${percent(x.lexical)} | ${percent(x.vector)} | ${percent(x.efficient)} | ${percent(x.reranked)} |`).join('\n')}

VERIFIED: \`test/languages.test.mjs\` exercises all analyzer imports, the three original strategies, exact symbols and eligibility on Bun and Node. Browser tests exercise all 20 language selections using recorded real Winzling vectors. The frontier benchmark replays real ColBERT scores for all 1,000 query prefixes, using explicit truncation. The [end-to-end recall report](data/recall.json) runs both presets through \`HybridSearch\` on Bun, Node.js and Chromium and reproduces this table's efficient and reranked figures.

## When the question's language is unknown

An application often cannot know which language a user types. BM25 can then search all 20 language fields, but words that several languages share match across them. A language identifier's guess, passed as the query's \`language\`, makes lexicalsearch weigh the guessed language's fields three times more while every other field stays searchable, so a misread short query still finds its words. VERIFIED: \`bun run bench:language-guess\` measures both presets on all 1,000 questions with defuss-lid's \`major_20\` guesses, which cover the fixture's 20 languages:

${guessBlock}

VERIFIED: Winzling's eight target languages remain distinct from the other twelve. Neither preset detects a language or silently routes an unsupported language to a different model: the caller passes \`language\`, chooses analyzers and supplies compatible query/document embeddings.

See [release provenance](upstreams.json), [API evaluation](evaluation.md), [verification](verification.md), and [Pareto methodology](pareto.md).
`,
);
console.log(`${new Date().toISOString()} INFO Published measured Pareto and language tables`);
