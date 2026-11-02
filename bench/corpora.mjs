/**
 * Corpus helpers shared by bench/bm25-switch.mjs and bench/confidence-fusion.mjs: seeded draws, passages cut to
 * their first words, float32 vector caches, the ColBERT pair cache and the demo notes with their query units.
 * VERIFIED: the vector and ColBERT cache keys include the pinned model files, so a model change recomputes instead
 * of reusing stale scores.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { languageCases } from '../fixtures/languages.mjs';
import { QUERIES, TOPICS } from '../fixtures/notes-benchmark.mjs';
import { releases } from '../scripts/models.mjs';
import { SAMPLE_NOTES } from '../website/sample-notes.mjs';

/** Deterministic draws: mulberry32. */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const entryOfCode = Object.fromEntries(languageCases.map((x) => [x.code, x.entry]));
const codeOfEntry = Object.fromEntries(languageCases.map((x) => [x.entry, x.code]));
const segmenters = new Map();
/** The text up to the end of its k-th word; Intl.Segmenter also finds words in Thai, Chinese and Japanese. */
export function truncate(text, code, k) {
  const locale = entryOfCode[code];
  if (!segmenters.has(locale))
    segmenters.set(locale, new Intl.Segmenter(locale, { granularity: 'word' }));
  let words = 0;
  for (const part of segmenters.get(locale).segment(text))
    if (part.isWordLike && ++words === k) return text.slice(0, part.index + part.segment.length);
  return text;
}

const filesOf = (name) => JSON.stringify(releases.find((x) => x.name === name).files);
const input = (file) => new URL(`../input/${file}`, import.meta.url);

/** Winzling document vectors of `texts`, cached in input/<name>.f32 and keyed by the model files and the texts. */
export async function cachedVectors(name, texts, embedder) {
  const key = createHash('sha256')
    .update(`${filesOf('winzling')}\u0000${texts.join('\u0001')}`)
    .digest('hex');
  try {
    const meta = JSON.parse(await readFile(input(`${name}.json`), 'utf8'));
    if (meta.key === key) {
      const bytes = await readFile(input(`${name}.f32`));
      const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      return texts.map((_, i) => floats.subarray(i * meta.dims, (i + 1) * meta.dims));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const embedded = await embedder().embedDocuments(texts);
  const dims = embedded[0].length;
  const floats = new Float32Array(embedded.length * dims);
  embedded.forEach((vector, i) => floats.set(vector, i * dims));
  await mkdir(input(''), { recursive: true });
  await writeFile(input(`${name}.f32`), Buffer.from(floats.buffer));
  await writeFile(input(`${name}.json`), JSON.stringify({ key, dims }));
  return embedded;
}

/**
 * The raw-reranker contract of createColbertAdapter, answered from a pair cache keyed by query and document text.
 * `colbert` is a function returning the real reranker, so a run whose pairs are all cached never loads the model.
 */
export async function createCachedColbert(colbert, file = 'bm25-switch-colbert.json') {
  const cacheKey = filesOf('colbert');
  const pairs = new Map();
  try {
    const stored = JSON.parse(await readFile(input(file), 'utf8'));
    if (stored.key === cacheKey) for (const [key, score] of stored.scores) pairs.set(key, score);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let scored = 0;
  const pairKey = (query, text) =>
    createHash('sha1').update(`${query}\u0001${text}`).digest('base64');
  return {
    async rerank(query, documents, { topK }) {
      const keys = documents.map((text) => pairKey(query, text));
      const missing = keys.flatMap((key, i) => (pairs.has(key) ? [] : [i]));
      if (missing.length) {
        const ranked = await (await colbert()).rerank(
          query,
          missing.map((i) => documents[i]),
          { topK: missing.length, truncate: true },
        );
        for (const { index, score } of ranked) pairs.set(keys[missing[index]], score);
        scored += missing.length;
      }
      return documents
        .map((_, index) => ({ index, score: pairs.get(keys[index]) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, topK);
    },
    scored: () => scored,
    async save() {
      await mkdir(input(''), { recursive: true });
      await writeFile(input(file), JSON.stringify({ key: cacheKey, scores: [...pairs] }));
    },
  };
}

/**
 * The demo's 100 notes and their query units: every translated note as a query for its translations (with itself
 * left out of the index), then the assistant-written keyword and paraphrase queries of fixtures/notes-benchmark.mjs.
 */
export function notesCorpus() {
  const notes = SAMPLE_NOTES.map((note, i) => ({
    id: `note-${i + 1}`,
    text: note.text,
    language: codeOfEntry[note.lang],
  }));
  const text = new Map(notes.map((note) => [note.id, note.text]));
  const members = (topics) =>
    new Set(topics.flatMap((topic) => TOPICS[topic].map((n) => `note-${n}`)));
  const units = [
    ...Object.values(TOPICS).flatMap((group) =>
      group.map((n) => ({
        type: 'translation',
        text: text.get(`note-${n}`),
        leaveOut: `note-${n}`,
        relevant: new Set(group.filter((m) => m !== n).map((m) => `note-${m}`)),
      })),
    ),
    ...QUERIES.map((query) => ({
      type: query.type,
      text: query.text,
      relevant: members(query.topics),
    })),
  ];
  return { notes, text, units };
}

/**
 * ColBERT token matrices of `texts`, cached in input/colbert-retrieval-<name>.f32 with per-text token counts and
 * keyed by the model files and the texts (the format bench/colbert-retrieval.mjs writes). `cache: false` encodes
 * without writing, for corpora whose float32 tokens would take gigabytes.
 */
export async function cachedMatrices(name, texts, colbert, { cache = true } = {}) {
  const key = createHash('sha256')
    .update(`${filesOf('colbert')}\u0000${texts.join('\u0001')}`)
    .digest('hex');
  if (cache)
    try {
      const meta = JSON.parse(await readFile(input(`colbert-retrieval-${name}.json`), 'utf8'));
      if (meta.key === key) {
        const bytes = await readFile(input(`colbert-retrieval-${name}.f32`));
        const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        let offset = 0;
        return meta.counts.map((tokenCount) => {
          const data = floats.subarray(offset, offset + tokenCount * meta.dimensions);
          offset += tokenCount * meta.dimensions;
          return { data, tokenCount, dimensions: meta.dimensions };
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  const model = await colbert();
  const matrices = [];
  for (let i = 0; i < texts.length; i += 64)
    matrices.push(...(await model.encodeDocuments(texts.slice(i, i + 64), { truncate: true })));
  if (cache) {
    const floats = new Float32Array(matrices.reduce((sum, m) => sum + m.data.length, 0));
    let offset = 0;
    for (const m of matrices) {
      floats.set(m.data, offset);
      offset += m.data.length;
    }
    await mkdir(input(''), { recursive: true });
    await writeFile(input(`colbert-retrieval-${name}.f32`), Buffer.from(floats.buffer));
    await writeFile(
      input(`colbert-retrieval-${name}.json`),
      JSON.stringify({
        key,
        dimensions: matrices[0].dimensions,
        fingerprint: matrices[0].fingerprint,
        counts: matrices.map((m) => m.tokenCount),
      }),
    );
  }
  return matrices;
}
