/**
 * Why the presets fuse with two language groups: a replay of the efficient preset's fusion (36 RRF settings, with the
 * weak-lexical rule) where each language group gets the setting that its tuning questions rank best. Every grouping
 * is tuned on one half of the 50 question groups and scored on the other half, then the halves swap, so each of the
 * 1,000 questions is scored by a setting chosen without it; this repeats over 20 seeded halvings.
 * Part A compares fixed groupings. Part B searches groupings (bins of 4, of 3 and 2, of 5, any bins up to 5 by an
 * exact set partition, any size by local search) inside the tuning half alone, scoring each bin by 5-fold
 * cross-validation there, and scores the chosen grouping on the other half.
 * The lexical side knows the question's language; "guessed" picks the group by defuss-lid's major_20 guess instead.
 * Output: output/bench/language-groups.json. Run: bun run bench:language-groups (about a minute, no model inference).
 * VERIFIED: the run of 2026-11-10 (Bun 1.4.3, defuss-vectorsearch 0.4.0 vectors) gave one group 90.76% R@1, two groups
 * (Winzling-embed's 8 and the rest) 92.27%, ahead of one on all 20 halvings, four by family 92.42% (better in 14, worse
 * in 6), one per language 91.36%; every searched grouping scored 91.4% to 91.9% on average, below two groups.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { LexicalSearch } from 'defuss-lexicalsearch';
import { fuseRankings, searchPreset } from 'defuss-search';
import { createLexicalRetriever } from 'defuss-search/lexical';
import { createVectorRetriever } from 'defuss-search/vector';
import { load } from 'defuss-lid/packs/major_20';
import { loadDataset } from './dataset.mjs';
import { loadEmbeddings } from './embeddings.mjs';
import { languageCases, targetLanguages } from '../fixtures/languages.mjs';

const log = (message) => console.log(`${new Date().toISOString()} INFO ${message}`);
const { documents, queries, languages } = await loadDataset();
const cache = await loadEmbeddings({ documents, queries }, log);
const fields = Object.fromEntries(
  await Promise.all(
    languageCases.map(async (x) => [x.code, { analyzer: (await import(`defuss-lexicalsearch/${x.entry}`)).default }]),
  ),
);
const codeOf = Object.fromEntries(languageCases.map((x) => [x.entry, x.code]));
const index = new LexicalSearch({ fields, maxTokenLength: 1024 });
index.addAll(documents);
const lex = new Map(languages.map((c) => [c, createLexicalRetriever(index, { search: { fields: [c] } })]));
const vector = createVectorRetriever({ ids: documents.map((x) => x.id), vectors: cache.vectors });
const rule = searchPreset('efficient').weakLexical;
const grid = [];
for (const k of [0, 1, 5, 10, 20, 60])
  for (const lexicalWeight of [0.25, 0.5, 1, 2, 3, 4]) grid.push({ name: `rrf-k${k}-lex${lexicalWeight}`, k, lexicalWeight });
const P = grid.length;
const L = languages.length;
const li = Object.fromEntries(languages.map((c, i) => [c, i]));
const FULL = (1 << L) - 1;

// Each question's gold rank under every setting; selection compares R@1, then R@5, then R@10, packed in one number.
const lid = await load();
const rows = [];
for (let i = 0; i < queries.length; i++) {
  const q = { text: queries[i].text, vector: cache.queryVectors[i] };
  const searcher = lex.get(queries[i].language);
  const lexical = await searcher.retrieve(q, { limit: 25 });
  const dense = await vector.retrieve(q, { limit: 25 });
  const top = lexical[0];
  const share = top && (await searcher.matchShare(q, top.id));
  const rescored = await vector.rescore(q, { ids: new Set(lexical.map((x) => x.id)), limit: lexical.length });
  const cosine = top && rescored.find((x) => x.id === top.id)?.score;
  const gap = dense[0] && cosine !== undefined ? dense[0].score - cosine : undefined;
  const weak = dense[0] && top && top.id !== dense[0].id && share !== undefined && share < rule.share && gap > rule.gap;
  const ranks = grid.map((p) => {
    let order = fuseRankings(
      [
        { name: 'lexical', hits: lexical, weight: p.lexicalWeight },
        { name: 'vector', hits: dense, weight: 1 },
      ],
      { k: p.k },
    );
    if (weak) order = [...order.filter((h) => h.id === dense[0].id), ...order.filter((h) => h.id !== dense[0].id)];
    return order.findIndex((h) => h.id === queries[i].target) + 1;
  });
  const guess = codeOf[lid.predict(q.text)[0]?.language];
  rows.push({
    l: li[queries[i].language],
    g: guess === undefined ? -1 : li[guess],
    group: Math.floor(i / L),
    ranks,
    s: ranks.map((n) => (n === 1 ? 1e6 : 0) + (n > 0 && n <= 5 ? 1e3 : 0) + (n > 0 && n <= 10 ? 1 : 0)),
  });
}
lid.dispose();

const argmax = (v) => {
  let best = 0;
  for (let p = 1; p < P; p++) if (v[p] > v[best]) best = p;
  return best;
};
const sumBin = (table, mask) => {
  const v = new Float64Array(P);
  for (let l = 0; l < L; l++) if ((mask >> l) & 1) for (let p = 0; p < P; p++) v[p] += table[l][p];
  return v;
};
const perLanguage = (pick) => {
  const table = [...Array(L)].map(() => new Float64Array(P));
  for (const r of rows) if (pick(r)) for (let p = 0; p < P; p++) table[r.l][p] += r.s[p];
  return table;
};
/** Tune each bin on the train groups and count rank-1 and top-5 hits on the test groups. */
const evaluate = (bins, train, test) => {
  const table = perLanguage((r) => train.has(r.group));
  const setting = bins.map((mask) => argmax(sumBin(table, mask)));
  const binOf = new Int32Array(L);
  bins.forEach((mask, b) => {
    for (let l = 0; l < L; l++) if ((mask >> l) & 1) binOf[l] = b;
  });
  const out = { r1: 0, r5: 0, guessedR1: 0 };
  for (const r of rows) {
    if (!test.has(r.group)) continue;
    const n = r.ranks[setting[binOf[r.l]]];
    out.r1 += n === 1;
    out.r5 += n > 0 && n <= 5;
    out.guessedR1 += r.ranks[setting[binOf[r.g < 0 ? r.l : r.g]]] === 1;
  }
  return out;
};
const bins = (...lists) => lists.map((list) => list.reduce((mask, entry) => mask | (1 << li[codeOf[entry]]), 0));
const winzling = [...targetLanguages].reduce((mask, code) => mask | (1 << li[code]), 0);
const family = bins(['en', 'de', 'nl'], ['fr', 'es', 'pt', 'it'], ['ru', 'pl', 'id']);
const fixed = {
  'one group': [FULL],
  "two: Winzling's 8 and the rest": [winzling, FULL & ~winzling],
  'four by family': [...family, FULL & ~family.reduce((a, b) => a | b)],
  'four: de ru en fr / es pt it nl / pl tr ar hi bn ur / id vi th zh ja ko': bins(
    ['de', 'ru', 'en', 'fr'],
    ['es', 'pt', 'it', 'nl'],
    ['pl', 'tr', 'ar', 'hi', 'bn', 'ur'],
    ['id', 'vi', 'th', 'zh', 'ja', 'ko'],
  ),
  'each language alone': languages.map((_, l) => 1 << l),
};
const BASELINE = "two: Winzling's 8 and the rest";

// Seeded halvings of the 50 question groups; the first keeps the frontier benchmark's split.
let seed = 12345;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const halvings = [[...Array(50).keys()]];
for (let s = 1; s < 20; s++) {
  const order = [...Array(50).keys()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  halvings.push(order);
}
const halves = (order) => [new Set(order.slice(0, 25)), new Set(order.slice(25))];
/** Both directions of one halving, as shares of the 1,000 questions. */
const twoFold = (chooseA, chooseB, a, b) => {
  const x = evaluate(chooseA, a, b);
  const y = evaluate(chooseB, b, a);
  return Object.fromEntries(Object.keys(x).map((key) => [key, (x[key] + y[key]) / rows.length]));
};

const fixedResults = Object.fromEntries(
  Object.entries(fixed).map(([name, groups]) => [
    name,
    halvings.map((order) => twoFold(groups, groups, ...halves(order))),
  ]),
);
const summary = (runs) => {
  const base = fixedResults[BASELINE];
  const mean = (key) => runs.reduce((sum, r) => sum + r[key], 0) / runs.length;
  const delta = runs.map((r, i) => r.r1 - base[i].r1);
  return {
    halvings: runs.length,
    r1: mean('r1'),
    r5: mean('r5'),
    guessedR1: mean('guessedR1'),
    r1Min: Math.min(...runs.map((r) => r.r1)),
    r1Max: Math.max(...runs.map((r) => r.r1)),
    r1AgainstTwo: {
      better: delta.filter((d) => d > 1e-9).length,
      worse: delta.filter((d) => d < -1e-9).length,
      mean: delta.reduce((a, b) => a + b, 0) / delta.length,
    },
  };
};

/** Bins chosen inside `train` alone, each bin scored by 5-fold cross-validation over its groups. */
const searchBins = (train) => {
  const ordered = [...train].sort((a, b) => a - b);
  const fold = new Map(ordered.map((g, i) => [g, i % 5]));
  const fit = [...Array(5)].map((_, f) => perLanguage((r) => train.has(r.group) && fold.get(r.group) !== f));
  const check = [...Array(5)].map((_, f) => perLanguage((r) => train.has(r.group) && fold.get(r.group) === f));
  const memo = new Map();
  const score = (mask) => {
    let v = memo.get(mask);
    if (v !== undefined) return v;
    v = 0;
    for (let f = 0; f < 5; f++) {
      const p = argmax(sumBin(fit[f], mask));
      for (let l = 0; l < L; l++) if ((mask >> l) & 1) v += check[f][l][p];
    }
    memo.set(mask, v);
    return v;
  };
  const total = (list) => list.reduce((sum, mask) => sum + score(mask), 0);
  /** Exact best set partition into bins of the given sizes; `limits` caps how many bins of a size it may use. */
  const partition = (sizes, limits = {}) => {
    const best = new Map();
    const max = Math.max(...sizes);
    const solve = (rest, used) => {
      if (!rest) return { v: 0, bins: [] };
      const key = rest * 8 + used;
      if (best.has(key)) return best.get(key);
      const low = rest & -rest;
      const others = [];
      for (let l = 0; l < L; l++) if ((1 << l) !== low && rest & (1 << l)) others.push(1 << l);
      let found = { v: -Infinity, bins: null };
      const grow = (start, mask, size) => {
        const capped = limits[size] !== undefined;
        if (sizes.includes(size) && !(capped && used >= limits[size])) {
          const tail = solve(rest & ~mask, used + (capped ? 1 : 0));
          if (tail.v > -Infinity && score(mask) + tail.v > found.v)
            found = { v: score(mask) + tail.v, bins: [mask, ...tail.bins] };
        }
        if (size < max) for (let i = start; i < others.length; i++) grow(i + 1, mask | others[i], size + 1);
      };
      grow(0, low, 1);
      best.set(key, found);
      return found;
    };
    return solve(FULL, 0).bins;
  };
  /** Best-improvement moves (one language to another or a new bin, or two bins merged) until none improves. */
  const localSearch = (start) => {
    let current = [...start];
    for (;;) {
      let next;
      let value = total(current);
      for (let l = 0; l < L; l++) {
        const bit = 1 << l;
        const from = current.findIndex((mask) => mask & bit);
        for (let to = -1; to < current.length; to++) {
          if (to === from) continue;
          const moved = current.map((m, i) => (i === from ? m & ~bit : i === to ? m | bit : m)).filter(Boolean);
          if (to === -1) moved.push(bit);
          if (total(moved) > value) [next, value] = [moved, total(moved)];
        }
      }
      for (let i = 0; i < current.length; i++)
        for (let j = i + 1; j < current.length; j++) {
          const merged = current.filter((_, k) => k !== i && k !== j).concat(current[i] | current[j]);
          if (total(merged) > value) [next, value] = [merged, total(merged)];
        }
      if (!next) return current;
      current = next;
    }
  };
  const anySize = Object.values(fixed)
    .slice(0, 3)
    .concat([fixed['each language alone']])
    .map(localSearch)
    .sort((a, b) => total(b) - total(a))[0];
  return {
    '5 bins of 4': partition([4]),
    '6 bins of 3 and 1 of 2': partition([3, 2], { 2: 1 }),
    '4 bins of 5': partition([5]),
    'any bins of up to 5': partition([1, 2, 3, 4, 5]),
    'any bins, local search': anySize,
  };
};
const names = (mask) =>
  languageCases
    .filter((x) => (mask >> li[x.code]) & 1)
    .map((x) => x.entry)
    .join(' ');
// The search runs on 3 halvings; each takes a few seconds.
const searched = {};
const chosen = {};
for (const order of halvings.slice(0, 3)) {
  const [a, b] = halves(order);
  const fromA = searchBins(a);
  const fromB = searchBins(b);
  for (const name of Object.keys(fromA)) {
    (searched[name] ??= []).push(twoFold(fromA[name], fromB[name], a, b));
    (chosen[name] ??= []).push([fromA[name].map(names), fromB[name].map(names)]);
  }
}
const report = {
  completedAt: new Date().toISOString(),
  runtime: `Bun ${process.versions.bun}`,
  questions: rows.length,
  settings: grid.map((p) => p.name),
  note: 'Shares of all questions, each scored by settings tuned on the other half; means over halvings.',
  fixed: Object.fromEntries(Object.entries(fixedResults).map(([name, runs]) => [name, summary(runs)])),
  searched: Object.fromEntries(
    Object.entries(searched).map(([name, runs]) => [
      name,
      { ...summary(runs), chosen: chosen[name], two: fixedResults[BASELINE].slice(0, runs.length).map((r) => r.r1) },
    ]),
  ),
};
await mkdir('output/bench', { recursive: true });
await writeFile('output/bench/language-groups.json', JSON.stringify(report, null, 2) + '\n');
for (const [part, entries] of Object.entries({ fixed: report.fixed, searched: report.searched }))
  for (const [name, r] of Object.entries(entries))
    log(
      `${part} "${name}": R@1 ${(100 * r.r1).toFixed(2)}% (${(100 * r.r1Min).toFixed(1)} to ${(100 * r.r1Max).toFixed(1)}), R@5 ${(100 * r.r5).toFixed(2)}%, guessed R@1 ${(100 * r.guessedR1).toFixed(2)}%, against two groups better ${r.r1AgainstTwo.better} worse ${r.r1AgainstTwo.worse} of ${r.halvings}`,
    );
log('PASS: language-group replay saved to output/bench/language-groups.json');
