/**
 * Runtime-neutral recall measurement through the public presets. Bun, Node.js and the
 * browser bundle run this same module, so their per-question ranks can be compared. VERIFIED: on
 * 2026-10-31 all three returned the same rank for each of the 1,000 questions.
 */
import { searchPreset } from 'defuss-search';
import { createBenchSearch } from '../website/bench-search.mjs';
import { languageCases, targetLanguages } from '../fixtures/languages.mjs';

const tagOf = Object.fromEntries(languageCases.map((x) => [x.code, x.entry]));

export const K = [1, 5, 10, 25];
const { fusion } = searchPreset('efficient');
const [group] = fusion.byLanguage;
const ratio = (w) => `${w.lexical}:${w.vector}`;
// The description below says "eight" and names one weight ratio; a preset that changes either needs new words.
if (group.languages.length !== 8 || ratio(group.weights) !== ratio(fusion.weights))
  throw new Error("Describe the efficient preset's language group in PRESETS");
export const PRESETS = {
  efficient: {
    name: 'Efficient',
    description: `searchPreset('efficient'): lexical and vector top 25, weighted RRF with weights ${ratio(fusion.weights)}, k=${group.k} for Winzling-embed's eight target languages and k=${fusion.k} for the others, no neural stage; when BM25's first hit matches few or only common query words and trails the vector first hit, that vector hit leads.`,
  },
  reranked: {
    name: 'Reranked',
    description:
      "searchPreset('reranked'): the same retrieval, then Winzling-reranker refines the top 25 unless both sources agree on a clear vector winner.",
  },
};

/**
 * One index holds all passages, one analyzer field per language. By default a question searches
 * its own language's field (the language is known); vector retrieval scans every passage, so a
 * question also competes with the translations of its gold passage. `route: 'all'` searches every
 * language field, and `route: 'guessed'` does too, with `guesses[i]` as question i's `language`.
 * Returns, per preset, each question's target rank (0: outside the top 25) and whether neural
 * inference ran. VERIFIED: bench/language-guess.mjs runs the all and guessed routes (2026-11-06).
 */
export async function measureRecall({
  documents,
  queries,
  vectors,
  queryVectors,
  reranker,
  presets = Object.keys(PRESETS),
  route = 'known',
  guesses = [],
  onProgress = () => {},
}) {
  if (!['known', 'all', 'guessed'].includes(route)) throw new Error(`Unknown route ${route}`);
  if (route === 'guessed' && guesses.length !== queries.length)
    throw new Error('One guess per question is required');
  const { hybrid: searchers, all } = createBenchSearch({ documents, vectors, reranker });
  const runs = {};
  for (const preset of presets) {
    const options = { ...searchPreset(preset), limit: Math.max(...K) };
    const ranks = [],
      neural = [];
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const searcher = route === 'known' ? searchers.get(query.language) : all;
      if (!searcher) throw new Error(`No analyzer for ${query.language}`);
      // A known language goes with the query too: the presets pick their fusion by it (fusion.byLanguage).
      const tag = route === 'known' ? tagOf[query.language] : route === 'guessed' ? guesses[i] : undefined;
      const language = tag ? { language: tag } : {};
      const result = await searcher.searchWithStats(
        { text: query.text, vector: queryVectors[i], ...language },
        options,
      );
      ranks.push(result.hits.findIndex((hit) => hit.id === query.target) + 1);
      neural.push(result.rerankDecision.action === 'applied');
      onProgress(preset, i + 1, queries.length);
    }
    runs[preset] = { ranks, neural };
  }
  return runs;
}

/** R@k per language as a share of its questions, plus unweighted means over languages. */
export function summarize(queries, runs) {
  const codes = languageCases.map((x) => x.code);
  const mean = (rows, subset) =>
    Object.fromEntries(
      K.map((k) => [
        `r${k}`,
        subset.reduce((sum, code) => sum + rows[code][`r${k}`], 0) / subset.length,
      ]),
    );
  return Object.entries(runs).map(([id, { ranks, neural }]) => {
    const languages = Object.fromEntries(
      codes.map((code) => {
        const picked = queries.flatMap((query, i) => (query.language === code ? [i] : []));
        if (!picked.length) throw new Error(`No questions for ${code}`);
        return [
          code,
          {
            questions: picked.length,
            ...Object.fromEntries(
              K.map((k) => [
                `r${k}`,
                picked.filter((i) => ranks[i] > 0 && ranks[i] <= k).length / picked.length,
              ]),
            ),
            neuralQueries: picked.filter((i) => neural[i]).length,
          },
        ];
      }),
    );
    return {
      id,
      ...PRESETS[id],
      mean: mean(languages, codes),
      target: mean(
        languages,
        codes.filter((code) => targetLanguages.has(code)),
      ),
      neuralQueries: neural.filter(Boolean).length,
      languages,
    };
  });
}
