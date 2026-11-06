/**
 * The demo's worker: it owns the benchmark corpus, the indexes, the user's notes and the models; the page only
 * renders what it posts. It follows the defuss-vectorsearch demo worker (model files fetched through `loadFile` with
 * byte progress, kept in the Cache API, newest query wins) and the defuss-lexicalsearch demo (corpus download and
 * index build on page load, notes searchable as you type).
 * Every search runs the factory the reader picked, from defuss-search/strategies:
 * - lexical-only: createLexicalOnlySearch, no model;
 * - tiny: createLexicalSemanticTinySearch over the passages' prebuilt TurboQuant token index (scripts/demo-data.mjs);
 *   MoEdernColBERT encodes only the questions and the user's notes;
 * - semantic: createLexicalSemanticSearch over the recorded Winzling vectors, optionally with the ColBERT reranker.
 * The benchmark restricts BM25 to the question's language, so each factory runs once per language field. The
 * vector source is built once and shared through the factories' `vector` option: one copy of the token index or
 * the vectors serves all 20 searches.
 * Why recorded question vectors: the 1,000 benchmark questions carry the vectors the recall benchmark used, so an
 * example question ranks exactly as in the published figures, before any model download. VERIFIED: the e2e test
 * measures the efficient preset over all 1,000 questions here and compares each language with docs/data/recall.json.
 */
import { loadCld3Pack } from 'defuss-lid/cld3-pack';
import { searchPreset } from 'defuss-search';
import { createColbertRetriever } from 'defuss-search/colbert';
import {
  createLexicalOnlySearch,
  createLexicalSemanticSearch,
  createLexicalSemanticTinySearch,
} from 'defuss-search/strategies';
import { createVectorRetriever } from 'defuss-search/vector';
import { languageCases } from '../fixtures/languages.mjs';
import { createLanguageIndex } from './bench-search.mjs';
import { methodOf, modelBytes } from './factories.mjs';
import { unpackTokenIndex } from './token-index.mjs';

const CANDIDATES = 25;
const CACHE_NAME = 'defuss-search-demo-models';
const wasmPaths = new URL('./ort/', import.meta.url).href;
const post = (event) => self.postMessage(event);
const log = (tone, text) => post({ type: 'log', tone, text });
const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
const message = (error) => (error instanceof Error ? error.message : String(error));
// Without a usable Cache API (insecure origin, blocked storage) models still load, only uncached.
const openCache = async () =>
  typeof caches === 'undefined' ? undefined : caches.open(CACHE_NAME).catch(() => undefined);

/** Thrown by the reranker slot before MoEdernColBERT is loaded; the gate decided the question needs it. */
class RerankerMissing extends Error {}

let manifest, manifestUrl;
let bench; // { corpus, index, documents, vectors?, queryVectors?, tokens? }
let embedder, colbert;
const models = { colbert: 'idle', winzling: 'idle' };
let choice = { factory: 'lexical-only', rerank: false };
const searches = new Map(); // `${factory}:${rerank}:${code}` → HybridSearch

/**
 * Downloads one file with byte progress through XMLHttpRequest's progress events, at most every 40 ms plus once at
 * the end. Why not a streamed fetch: VERIFIED (20 page loads each, 2026-11-01) reading fetch bodies with getReader()
 * in this worker made Chromium report 6 to 10 completed downloads as net::ERR_ABORTED; arrayBuffer() and XHR reported
 * none, and only XHR also reports progress.
 */
function download(url, onBytes) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let reported = 0;
    request.open('GET', url);
    request.responseType = 'arraybuffer';
    request.onprogress = (event) => {
      if (performance.now() - reported < 40) return;
      reported = performance.now();
      onBytes(event.loaded);
    };
    request.onload = () => {
      if (request.status !== 200) return reject(new Error(`${url}: HTTP ${request.status}`));
      const bytes = new Uint8Array(request.response);
      onBytes(bytes.length);
      resolve(bytes);
    };
    request.onerror = () => reject(new Error(`${url}: network error`));
    request.send();
  });
}
const gunzip = async (bytes) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer(),
  );
const progress = (phase, loaded, total) => post({ type: 'progress', phase, loaded, total });

/** The passages and questions with progress over their compressed size, then the lexical index build, timed. */
async function loadBench() {
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`${manifestUrl}: HTTP ${response.status}`);
  manifest = await response.json();
  log('info', `fetch corpus · ${mb(manifest.corpus.bytes)} passages and questions (gzip)`);
  const json = await download(new URL(manifest.corpus.file, manifestUrl).href, (n) =>
    progress('corpus', n, manifest.corpus.bytes),
  ).then(gunzip);
  const corpus = JSON.parse(new TextDecoder().decode(json));
  const documents = corpus.passages.text.map((text, i) => ({
    id: `${corpus.passages.group[i]}:${corpus.passages.language[i]}`,
    text,
    code: corpus.languages[corpus.passages.language[i]],
  }));
  log(
    'success',
    `${documents.length.toLocaleString('en')} passages · ${corpus.languages.length} languages`,
  );
  post({ type: 'phase', phase: 'index', done: false });
  const started = performance.now();
  const index = createLanguageIndex();
  index.addAll(documents.map(({ id, text, code }) => ({ id, fields: { [code]: text } })));
  const indexMs = performance.now() - started;
  const terms = index.stats().terms;
  log(
    'success',
    `lexical index · ${terms.toLocaleString('en')} terms in 20 analyzer fields · ${Math.round(indexMs)} ms`,
  );
  bench = { corpus, index, documents };
  post({
    type: 'indexed',
    passages: documents.length,
    languages: corpus.languages,
    dataset: corpus.dataset,
    terms,
    indexMs,
    queries: corpus.queries.text.map((text, i) => ({
      text,
      language: corpus.queries.language[i],
      gold: corpus.queries.gold[i],
      group: corpus.passages.group[corpus.queries.gold[i]],
    })),
  });
}
const rowOf = (corpus, id) => {
  const [group, language] = id.split(':').map(Number);
  return group * corpus.languages.length + language;
};

/** The recorded Winzling vectors of the passages and questions, which only lexical-semantic needs. */
let vectorsLoading;
const loadVectors = () =>
  (vectorsLoading ??= (async () => {
    const { dims, passages: count, bytes, rawBytes, file } = manifest.vectors;
    log('info', `fetch recorded Winzling vectors · ${mb(bytes)} (gzip)`);
    const binary = await download(new URL(file, manifestUrl).href, (n) =>
      progress('vectors', n, bytes),
    ).then(gunzip);
    const floats = new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / 4);
    const row = (i) => floats.subarray(i * dims, (i + 1) * dims);
    bench.vectors = createVectorRetriever({
      ids: bench.documents.map((doc) => doc.id),
      vectors: bench.documents.map((_, i) => row(i)),
    });
    bench.queryVectors = bench.corpus.queries.text.map((_, i) => row(count + i));
    log('success', `${count.toLocaleString('en')} passage vectors · ${mb(rawBytes)} float32`);
    post({ type: 'ready', model: 'vectors' });
  })().catch((error) => {
    vectorsLoading = undefined;
    throw error;
  }));

/**
 * The tiny factory's token index: the passages' TurboQuant codes, built by scripts/demo-data.mjs from the matrices
 * the strategies benchmark encoded, so this browser runs no passage encoding. Queries need MoEdernColBERT, which
 * loads in its own lane; the retriever reaches it only when a query is scanned.
 */
let tokensLoading;
const loadTokens = () =>
  (tokensLoading ??= (async () => {
    const meta = manifest.tokens;
    const started = performance.now();
    log('info', `fetch token index · ${mb(meta.bytes)} TurboQuant codes (gzip)`);
    const bytes = await download(new URL(meta.file, manifestUrl).href, (n) =>
      progress('tokens', n, meta.bytes),
    ).then(gunzip);
    bench.tokens = createColbertRetriever({
      ids: bench.documents.map((doc) => doc.id),
      index: unpackTokenIndex(meta, bytes),
      encodeQuery: async (text) => (await colbert.encodeQueries([text], { truncate: true }))[0],
    });
    const ms = performance.now() - started;
    log(
      'success',
      `token index · ${meta.size.toLocaleString('en')} tokens · ${mb(meta.rawBytes)} TurboQuant codes · ${Math.round(ms)} ms`,
    );
    post({ type: 'ready', model: 'tokens', tokens: meta.size, bytes: meta.rawBytes, ms });
  })().catch((error) => {
    tokensLoading = undefined;
    throw error;
  }));

/** The raw-reranker contract with MoEdernColBERT behind it once loaded; until then a marker the search reports. */
const colbertSlot = {
  rerank(query, texts, options) {
    if (!colbert) throw new RerankerMissing('MoEdernColBERT is not loaded');
    return colbert.rerank(query, texts, options);
  },
};

/** A factory's search for one language, created on first use; undefined while its index is missing. */
async function searchFor(code, { factory, rerank } = choice) {
  const key = `${factory}:${rerank}:${code}`;
  if (searches.has(key)) return searches.get(key);
  const lexical = { search: { fields: [code] } };
  let search;
  if (factory === 'lexical-only') search = createLexicalOnlySearch(bench.index, { lexical });
  else if (factory === 'tiny') {
    // The index scans only with MoEdernColBERT there to encode the query.
    if (!bench.tokens || !colbert) return undefined;
    search = await createLexicalSemanticTinySearch(bench.index, { vector: bench.tokens, lexical });
  } else {
    if (!bench.vectors) return undefined;
    search = await createLexicalSemanticSearch(bench.index, {
      documents: bench.documents,
      vector: bench.vectors,
      ...(rerank ? { reranker: colbertSlot } : {}),
      lexical,
    });
  }
  searches.set(key, search);
  return search;
}

// ---- models -----------------------------------------------------------------------------------------------------
// Each model downloads from its pinned Hugging Face revision; scripts/demo-data.mjs records the base URL.
const releaseBase = (name) => new URL(manifest.models[name].base, manifestUrl).href;
const sha256 = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
async function isCached(name) {
  const cache = await openCache();
  if (!cache) return false;
  const files = Object.keys(manifest.models[name].files);
  return (await Promise.all(files.map((file) => cache.match(releaseBase(name) + file)))).every(
    Boolean,
  );
}

/**
 * `loadFile` for one model: Cache API first, else a download whose bytes the page sees as progress. The cache
 * keeps a file only after its SHA-256 matched the pin.
 */
function fileLoader(name, stats) {
  const { files } = manifest.models[name];
  const total = modelBytes(files);
  const loaded = new Map();
  const report = (file, bytes) => {
    loaded.set(file, bytes);
    progress(
      name,
      [...loaded.values()].reduce((a, b) => a + b, 0),
      total,
    );
  };
  return async (file) => {
    const entry = files[file];
    const url = releaseBase(name) + file;
    const cache = await openCache();
    const hit = await cache?.match(url);
    let bytes;
    if (hit) bytes = new Uint8Array(await hit.arrayBuffer());
    else {
      log('info', `fetch ${name} ${file} · ${mb(entry.bytes)}`);
      bytes = await download(url, (n) => report(file, n));
      stats.downloaded += bytes.length;
      if ((await sha256(bytes)) !== entry.sha256)
        throw new Error(`${name} ${file}: SHA-256 differs from the pinned release`);
      if (cache) await cache.put(url, new Response(bytes));
    }
    report(file, entry.bytes);
    log('success', `${name} ${file} · ${mb(bytes.length)} · ${hit ? 'from cache' : 'downloaded'}`);
    return bytes;
  };
}

/** Loads one model: files with progress, then the ONNX Runtime Web session, then one warm-up call. */
async function loadModel(name, device = 'wasm') {
  if (models[name] === 'ready' || models[name] === 'loading') return;
  models[name] = 'loading';
  const started = performance.now();
  const stats = { downloaded: 0 };
  let fallback = null,
    cached;
  // Every failure, the runtime import included, returns the model to idle, so a retry can load it.
  try {
    cached = await isCached(name);
    const { createWinzlingEmbedder, createColbertReranker } = await import(
      'defuss-vectorsearch/browser.js'
    );
    // One thread also works on static hosts without cross-origin isolation headers.
    const options = {
      numThreads: 1,
      wasmPaths,
      loadFile: fileLoader(name, stats),
      allowRemoteModels: false,
    };
    if (name === 'colbert') {
      const next = createColbertReranker({
        model: '1.5m',
        precision: 'q8',
        device: 'wasm',
        ...options,
      });
      post({ type: 'phase', phase: 'runtime', model: name, done: false });
      await next.load();
      await next.rerank('warm-up', ['warm-up'], { truncate: true });
      colbert = next;
    } else {
      const create = (target) => createWinzlingEmbedder({ device: target, ...options });
      let next = create(device);
      post({ type: 'phase', phase: 'runtime', model: name, done: false });
      try {
        await next.load();
      } catch (error) {
        if (device !== 'webgpu') throw error;
        fallback = message(error);
        log('warning', `WebGPU failed: ${fallback} · falling back to WASM`);
        next = create('wasm');
        await next.load();
      }
      await next.embedQuery('warm-up');
      embedder = next;
    }
  } catch (error) {
    models[name] = 'idle';
    throw error;
  }
  models[name] = 'ready';
  const ms = performance.now() - started;
  log(
    'success',
    `${name} ready · ${name === 'winzling' ? embedder.device : 'wasm'} · ${Math.round(ms)} ms`,
  );
  post({
    type: 'ready',
    model: name,
    device: name === 'winzling' ? embedder.device : 'wasm',
    fallback,
    ms,
    cached,
    downloadedBytes: stats.downloaded,
  });
  // After 'ready': a failed note embedding must not mark the loaded model as failed.
  await representPendingNotes().catch((error) => fail(error, { notes: true }));
}

// ---- the user's notes: lexical at once, then what the chosen factory adds --------------------------------------
const CODES = languageCases.map((x) => x.code);
const notes = new Map(); // id → { text, language, vector?, matrix? }
let notesSearch;
/** What a note needs beyond its text under the chosen factory: a Winzling vector, ColBERT tokens or nothing. */
const representation = () =>
  choice.factory === 'semantic' ? 'vector' : choice.factory === 'tiny' ? 'matrix' : undefined;
const modelFor = { vector: () => embedder, matrix: () => colbert };
async function represent(entries) {
  const kind = representation();
  if (!kind || !modelFor[kind]() || !entries.length) return;
  const texts = entries.map(([, note]) => note.text);
  const values =
    kind === 'vector'
      ? await embedder.embedDocuments(texts)
      : await colbert.encodeDocuments(texts, { truncate: true });
  entries.forEach(([, note], i) => (note[kind] = values[i]));
}
/**
 * Each note sits in its language's field; a notes query searches every field, each with its own analyzer. The
 * factory's vector source holds the notes that have the representation it needs.
 */
async function rebuildNotes() {
  const index = createLanguageIndex();
  index.addAll([...notes].map(([id, note]) => ({ id, fields: { [note.language]: note.text } })));
  const kind = representation();
  const ready = kind ? [...notes].filter(([, note]) => note[kind]) : [];
  const empty = { retrieve: () => [] };
  let search;
  if (choice.factory === 'lexical-only') search = createLexicalOnlySearch(index);
  else if (choice.factory === 'tiny')
    search = await createLexicalSemanticTinySearch(index, {
      vector: ready.length
        ? createColbertRetriever({
            ids: ready.map(([id]) => id),
            matrices: ready.map(([, note]) => note.matrix),
            encodeQuery: async (text) =>
              (await colbert.encodeQueries([text], { truncate: true }))[0],
          })
        : empty,
    });
  else
    search = await createLexicalSemanticSearch(index, {
      documents: [...notes].map(([id, note]) => ({ id, text: note.text })),
      vector: ready.length
        ? createVectorRetriever({
            ids: ready.map(([id]) => id),
            vectors: ready.map(([, note]) => note.vector),
          })
        : empty,
      ...(choice.rerank ? { reranker: colbertSlot } : {}),
    });
  notesSearch = { index, search, key: `${choice.factory}:${choice.rerank}` };
}
async function putNote({ id, version, text, language }) {
  if (!CODES.includes(language)) throw new Error(`No analyzer for ${language}`);
  const removed = !text.trim();
  let embedMs = 0;
  if (removed) notes.delete(id);
  else {
    // A language change alone keeps vector and tokens: neither depends on the analyzer.
    const previous = notes.get(id);
    const same = previous?.text === text;
    const note = { text, language, vector: same ? previous.vector : undefined };
    note.matrix = same ? previous.matrix : undefined;
    const started = performance.now();
    await represent([[id, note]]);
    embedMs = note[representation()] ? performance.now() - started : 0;
    notes.set(id, note);
  }
  await rebuildNotes();
  post({ type: 'note', id, version, removed, ...noteState(id), embedMs, ...noteCounts() });
}
/**
 * Notes added before the model was ready, or under another factory, get the representation now; `all` reports
 * every note, since a factory change changes what each status means.
 */
async function representPendingNotes({ all = false } = {}) {
  const kind = representation();
  const pending = kind ? [...notes].filter(([, note]) => !note[kind]) : [];
  await represent(pending);
  await rebuildNotes();
  for (const [id, note] of all ? [...notes] : pending)
    if (notes.get(id) === note && (all || note[kind]))
      post({
        type: 'note',
        id,
        version: -1,
        removed: false,
        ...noteState(id),
        embedMs: 0,
        ...noteCounts(),
      });
}
const noteState = (id) => {
  const kind = representation();
  return { kind: kind ?? 'none', embedded: !!(kind && notes.get(id)?.[kind]) };
};
const noteCounts = () => {
  const kind = representation();
  return {
    count: notes.size,
    kind: kind ?? 'none',
    embeddedCount: kind ? [...notes.values()].filter((note) => note[kind]).length : 0,
  };
};

// ---- search: the chosen factory for one query -------------------------------------------------------------------
const passageHit = (hit, i) => {
  const row = rowOf(bench.corpus, hit.id);
  return {
    id: hit.id,
    rank: hit.rank ?? i + 1,
    score: hit.score,
    scoreKind: hit.scoreKind,
    signals: Object.fromEntries(
      Object.entries(hit.signals ?? {}).map(([key, signal]) => [key, signal.rank]),
    ),
    text: bench.corpus.passages.text[row],
    language: bench.corpus.passages.language[row],
    group: bench.corpus.passages.group[row],
  };
};
/**
 * The evidence behind one note's position, for the result's "Why" panel: the words the lexical index matched, each
 * source's rank and raw score, and each fusion term weight / (k + rank). The library returns all of it per hit.
 */
const explainHit = (hit, matches) => ({
  score: hit.score,
  scoreKind: hit.scoreKind ?? 'lexical',
  signals: Object.fromEntries(
    Object.entries(hit.signals ?? {}).map(([key, signal]) => [
      key,
      { rank: signal.rank, score: signal.score },
    ]),
  ),
  contributions: Object.entries(hit.contributions ?? {}).map(([source, part]) => ({
    source,
    rank: part.rank,
    weight: part.weight,
    contribution: part.contribution,
  })),
  rerankContributions: Object.entries(hit.rerankContributions ?? {}).map(([source, part]) => ({
    source,
    rank: part.rank,
    weight: part.weight,
    contribution: part.contribution,
  })),
  reasons: hit.reasons ?? [],
  terms: (matches.get(hit.id) ?? []).map(({ query, term, kind, field }) => ({
    query,
    term,
    kind,
    field,
  })),
});
/** Note hits carry their explanation; `matches` holds the lexical index's matched words per note. */
const noteHitWith = (matches) => (hit, i) => ({
  id: hit.id,
  rank: hit.rank ?? i + 1,
  score: hit.score,
  scoreKind: hit.scoreKind,
  signals: Object.fromEntries(
    Object.entries(hit.signals ?? {}).map(([key, signal]) => [key, signal.rank]),
  ),
  text: notes.get(hit.id)?.text ?? '',
  language: CODES.indexOf(notes.get(hit.id)?.language),
  explain: explainHit(hit, matches),
});

/** One response as a result column: hits, timings and the decisions behind the order. */
const columnOf = (response, toHit) => ({
  state: 'done',
  hits: response.hits.map(toHit),
  ms: response.timings.totalMs,
  rerankMs: response.timings.rerankMs,
  decision: response.rerankDecision,
  route: response.route,
  weakLexical: response.weakLexical,
});

// ---- the language of a typed question: defuss-lid's major_20 pack, loaded with the first one ------------------------
const codeOfEntry = Object.fromEntries(languageCases.map((x) => [x.entry, x.code]));
let identifier;
/**
 * The fixture code of the language major_20 reads in `text`; undefined when it reads none. The pack covers the
 * fixture's 20 languages, so every answer names a field. scripts/docs.mjs copies the pack and the CLD3 core next to
 * this worker. VERIFIED: defuss-lid 0.5.0's README states that it checks the core's SHA-256 before instantiating it.
 */
async function detectLanguage(text) {
  identifier ??= loadCld3Pack(new URL('./lid/major_20.cld3q', import.meta.url), {
    coreURL: new URL('./lid/cld3-core.bin.gz', import.meta.url),
  }).catch((error) => {
    identifier = undefined; // the next typed question tries again
    throw error;
  });
  return codeOfEntry[(await identifier).predict(text)[0]?.language];
}

let pending;
let searching = false;
/** Runs only the newest query: typing costs one embedding or scan per pause, however many keystrokes arrive. */
async function pump() {
  if (searching) return;
  searching = true;
  try {
    while (pending) {
      const job = pending;
      pending = undefined;
      await runSearch(job);
    }
  } finally {
    searching = false;
  }
}
async function runSearch(job) {
  // A search carries the factory the page showed when it was asked, so a switch never mislabels a result.
  const { factory, rerank } = job;
  const method = methodOf(factory, rerank);
  const base = { type: 'results', index: job.index, id: job.id, text: job.text, factory, method };
  const answer = (column, extra = {}) => post({ ...base, final: true, column, ...extra });
  try {
    const notesIndex = job.index === 'notes';
    if (!notesIndex && !bench) throw new Error('The corpus is still loading');
    if (notesIndex && notesSearch?.key !== `${factory}:${rerank}`) await rebuildNotes();
    // A typed question searches the field of its detected language, as a benchmark question searches its own; the
    // page then selects that language. Notes keep searching every field (ARCH.md, "Website demo").
    const detected = !notesIndex && job.detect ? await detectLanguage(job.text) : undefined;
    if (detected) {
      job = { ...job, language: detected };
      base.detected = detected;
    }
    if (!notesIndex && !CODES.includes(job.language))
      throw new Error(`No analyzer for ${job.language}`);
    const toHit = notesIndex
      ? noteHitWith(
          new Map(
            notesSearch.index
              .search(job.text, { explain: true, limit: CANDIDATES })
              .map((hit) => [hit.id, hit.matches ?? []]),
          ),
        )
      : passageHit;
    const search = notesIndex ? notesSearch.search : await searchFor(job.language, job);
    if (!search)
      return answer({
        state: factory === 'tiny' ? (colbert ? 'needs-tokens' : 'needs-colbert') : 'needs-vectors',
      });
    if (factory !== 'semantic')
      return answer(columnOf(await search.searchWithStats(job.text, { limit: CANDIDATES }), toHit));
    // Lexical-semantic: a benchmark question keeps its recorded vector; any other text needs Winzling.
    let vector,
      embedMs = 0;
    const recorded =
      !notesIndex && job.example >= 0 && bench.corpus.queries.text[job.example] === job.text;
    if (recorded) vector = bench.queryVectors[job.example];
    else if (embedder) {
      const embedding = performance.now();
      vector = await embedder.embedQuery(job.text);
      embedMs = performance.now() - embedding;
    }
    if (!vector) return answer({ state: 'needs-embedder' });
    const query = { text: job.text, vector };
    const efficient = columnOf(
      await search.searchWithStats(query, { ...searchPreset('efficient'), limit: CANDIDATES }),
      toHit,
    );
    if (!rerank) return answer(efficient, { embedMs, recorded });
    // The efficient order shows at once; the reranked one replaces it, with each hit's move against it.
    post({ ...base, final: false, embedMs, recorded, column: { ...efficient, state: 'pending' } });
    if (pending) return; // a newer query supersedes the reranked order
    try {
      const reranked = columnOf(await search.searchWithStats(query, { limit: CANDIDATES }), toHit);
      answer({ ...reranked, before: efficient.hits.map((hit) => hit.id) }, { embedMs, recorded });
    } catch (error) {
      if (!(error instanceof RerankerMissing)) throw error;
      answer({ ...efficient, state: 'needs-reranker' }, { embedMs, recorded });
    }
  } catch (error) {
    post({ type: 'error', index: job.index, message: message(error) });
  }
}

/** Every benchmark question through the chosen factory; lexical-semantic also reports efficient when reranking. */
async function measure() {
  const { factory, rerank } = choice;
  if (factory === 'tiny' && !bench.tokens) throw new Error('The token index is still loading');
  if (factory === 'tiny' && !colbert) throw new Error('MoEdernColBERT is not loaded');
  if (factory === 'semantic' && !bench.vectors) throw new Error('The vectors are still loading');
  const methods =
    factory === 'semantic'
      ? ['efficient', ...(rerank && colbert ? ['reranked'] : [])]
      : [methodOf(factory, rerank)];
  const ranks = Object.fromEntries(methods.map((name) => [name, []]));
  const { corpus } = bench;
  let neural = 0;
  const started = performance.now();
  for (let i = 0; i < corpus.queries.text.length; i++) {
    const code = corpus.languages[corpus.queries.language[i]];
    const gold = corpus.queries.gold[i];
    const target = `${corpus.passages.group[gold]}:${corpus.passages.language[gold]}`;
    const rank = (hits) => hits.findIndex((hit) => hit.id === target) + 1;
    const search = await searchFor(code);
    const text = corpus.queries.text[i];
    if (factory !== 'semantic') {
      ranks[methods[0]].push(rank(await search.search(text, { limit: CANDIDATES })));
    } else {
      const query = { text, vector: bench.queryVectors[i] };
      ranks.efficient.push(
        rank(await search.search(query, { ...searchPreset('efficient'), limit: CANDIDATES })),
      );
      if (ranks.reranked) {
        const response = await search.searchWithStats(query, { limit: CANDIDATES });
        ranks.reranked.push(rank(response.hits));
        if (response.rerankDecision.action === 'applied') neural++;
      }
    }
    if ((i + 1) % 25 === 0)
      post({ type: 'measure-progress', done: i + 1, total: corpus.queries.text.length });
  }
  post({ type: 'measured', factory, ranks, neural, ms: performance.now() - started });
}

/** Prepares the chosen factory: the token index or the vectors start loading when it needs them. */
async function prepare() {
  const { factory } = choice;
  log('info', `factory · ${factory}${choice.rerank ? ' with the ColBERT reranker' : ''}`);
  if (factory === 'semantic') await loadVectors();
  if (factory === 'tiny') await loadTokens();
  await representPendingNotes({ all: true });
  post({ type: 'chosen', ...choice, ...noteCounts() });
}

// Three lanes: searches and notes wait only for the corpus, so a 40 MB model download never blocks typing;
// model loads and index builds run one at a time.
let indexed,
  modelQueue = Promise.resolve(),
  noteQueue = Promise.resolve();
const fail = (error, extra = {}) => post({ type: 'error', message: message(error), ...extra });
const queued = (work, extra) =>
  (modelQueue = modelQueue.then(work).catch((error) => fail(error, extra)));
self.onmessage = ({ data }) => {
  if (data.type === 'index') {
    ({ manifestUrl } = data);
    indexed = loadBench().then(
      async () =>
        post({
          type: 'probe',
          cached: { colbert: await isCached('colbert'), winzling: await isCached('winzling') },
        }),
      (error) => {
        indexed = undefined;
        fail(error, { corpus: true });
      },
    );
  } else if (data.type === 'factory') {
    // The choice applies at once, so notes and measurements never run under the previous factory; the loading
    // behind it waits its turn after model loads already queued.
    choice = { factory: data.factory, rerank: data.factory === 'semantic' && !!data.rerank };
    void indexed?.then(() => queued(prepare, { factory: data.factory }));
  } else if (data.type === 'search') {
    pending = data;
    void indexed?.then(pump);
  } else if (data.type === 'note')
    noteQueue = noteQueue
      .then(() => putNote(data))
      .catch((error) => fail(error, { note: data.id }));
  else if (data.type === 'measure')
    void indexed?.then(measure).catch((error) => fail(error, { measure: true }));
  else if (data.type === 'load')
    queued(async () => {
      for (const name of data.models)
        await loadModel(name, data.device).catch((error) => fail(error, { model: name }));
    });
  else if (data.type === 'clear-cache')
    // The catch keeps the queue resolved: a rejected queue would skip every later model load.
    queued(
      async () => {
        if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME);
        post({ type: 'cleared' });
      },
      { cache: true },
    );
};
