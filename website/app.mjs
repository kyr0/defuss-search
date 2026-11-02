/**
 * Entry of the main page: the shared chrome, the live demo and the frontier figures. VERIFIED: the static
 * sections work before, and without, the search worker; the defuss-shadcn runtime drives the tabs.
 */
import { initChrome } from './chrome.mjs';
import { initDemo } from './demo.mjs';

initChrome();
initDemo();

/** Only the held-out frontier's configurations: the page promotes nothing a measured option dominates. */
const frontier = await fetch(new URL('../data/pareto.json', import.meta.url)).then((response) => {
  if (!response.ok) throw new Error('Pareto report unavailable');
  return response.json();
});
const rows = Object.fromEntries(
  frontier.holdout.results
    .filter((row) => frontier.holdout.frontier.includes(row.name))
    .map((row) => [row.name, row]),
);
const share = (value) => `${(100 * value).toFixed(1)}%`;
const cell = (text, className) => {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
};
for (const name of frontier.holdout.frontier) {
  const row = rows[name];
  const tr = document.createElement('tr');
  tr.append(
    cell(name),
    ...['r1', 'r5', 'candidateRecall'].map((key) => cell(share(row[key]), 'hs-num')),
    cell(String(row.vectorQueries), 'hs-num'),
    cell(String(row.neuralQueries), 'hs-num'),
  );
  document.querySelector('#pareto-results').append(tr);
}
for (const [name, value] of Object.entries({
  'efficient-r1': share(rows.efficient.r1),
  'reranked-r5': share(rows.reranked.r5),
  'reranked-neural': `${rows.reranked.neuralQueries} of ${rows.reranked.queries}`,
  'lexical-r5': share(rows.lexical.r5),
}))
  document.querySelector(`[data-pareto="${name}"]`).textContent = value;
