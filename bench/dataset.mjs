import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { languageCases } from '../fixtures/languages.mjs';
export const datasetUrl =
  'https://github.com/kyr0/tiny-embedding-bench/raw/refs/heads/main/datasets/tiny-embedding-bench-v1/dataset.json';
export const datasetSha256 = '3d09d3653b72cf19c5226cd134bdd7d92ac31f2822cf45bc60879e7a95a75e6d';
/** Reuse both upstreams' frozen benchmark and verify bytes before parsing. */
export async function loadDataset() {
  const path = new URL('../input/tiny-embedding-bench-v1.json', import.meta.url);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(datasetUrl);
    if (!response.ok) throw new Error(`Dataset HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== datasetSha256)
    throw new Error('Dataset SHA-256 mismatch');
  const data = JSON.parse(bytes);
  if (
    data.schema !== 'tiny-multilingual-retrieval.v1' ||
    data.languages.length !== languageCases.length ||
    !data.languages.every((code) => languageCases.some((x) => x.code === code))
  )
    throw new Error('Unexpected dataset language/schema');
  const groups = new Map(data.corpus.map((row, i) => [row.id, i]));
  const gold = new Map(data.qrels.map(([query, passage]) => [query, groups.get(passage)]));
  const documents = data.corpus.flatMap((row, i) =>
    row.text.map((text, l) => ({
      id: `${i}:${l}`,
      fields: { [data.languages[l]]: text },
      text,
      language: data.languages[l],
    })),
  );
  const queries = data.queries.flatMap((row) =>
    row.text.map((text, l) => ({
      text,
      language: data.languages[l],
      target: `${gold.get(row.id)}:${l}`,
    })),
  );
  if (
    documents.length !== 2000 ||
    queries.length !== 1000 ||
    queries.some((q) => q.target.startsWith('undefined'))
  )
    throw new Error('Invalid benchmark shape/qrels');
  await mkdir(new URL('../input/', import.meta.url), { recursive: true });
  await writeFile(path, bytes);
  return { documents, queries, languages: data.languages };
}
