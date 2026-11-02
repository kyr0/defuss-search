import { readFile } from 'node:fs/promises';
import { apiSearchPreset } from 'defuss-lexicalsearch';
import { createHybridIndex } from 'defuss-search/indexing';
// Genuine, pinned Winzling vectors shipped with the authored evaluation fixture.
const data = JSON.parse(
  await readFile(new URL('../fixtures/api-embeddings.json', import.meta.url), 'utf8'),
);
const index = createHybridIndex({
  documents: data.documents,
  vectors: data.vectors,
  lexical: apiSearchPreset,
  lexicalSearch: { exact: { fields: ['symbol'] } },
});
const query = data.queries.find((query) => query.text === 'add an item at the end of a list');
for (const strategy of ['vector-first', 'lexical-first', 'fusion']) {
  const result = await index.search(query, {
    strategy,
    vectorCandidates: 25,
    lexicalCandidates: 25,
    limit: 5,
    exact: 'promote',
  });
  console.log(
    strategy,
    result.map((hit) => ({ rank: hit.rank, id: hit.id, score: hit.score, signals: hit.signals })),
  );
}
