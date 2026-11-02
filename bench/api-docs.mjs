/**
 * The API-docs corpus: defuss-shadcn's 410 MDX documentation pages (8 MB, about 1,860 code blocks) at one commit, the
 * snapshot defuss-lexicalsearch searches, split into sections a vector model can embed whole.
 * Sections hold at most MAX characters, start at a heading, and never cut a code block unless the block alone is too
 * long. Whole pages would not work: their median is 12,700 characters, and an embedding model reads only its first
 * few hundred tokens.
 * Exact queries are single words of at least four letters that occur in one to three sections; the natural-language
 * queries in fixtures/api-docs-queries.mjs were written by the assistant after reading randomly drawn sections.
 * VERIFIED: the loader checks the snapshot's SHA-256 before use, and each natural query's anchor text must occur in
 * its gold section, so a change to the chunking fails loudly instead of moving the gold labels.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATURAL } from '../fixtures/api-docs-queries.mjs';
import { random } from './corpora.mjs';

export const COMMIT = '896cf2ac69c53317e669604f2c28d524d947c10a';
const DOCUMENTS_SHA256 = '3847a7510c5a144b53b7ba19788f7f63e024306ca1f99b4ef3cb211c9d01df4a';
export const SOURCE = `https://github.com/kyr0/defuss-shadcn/tree/${COMMIT}/src/documentation`;
const MAX = 1200;

/** The pinned pages as {path, text}, fetched once from GitHub and cached in input/. */
export async function loadPages() {
  const path = new URL('../input/defuss-shadcn-docs.json', import.meta.url);
  let fixture;
  try {
    fixture = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const work = await mkdtemp(join(tmpdir(), 'api-docs-'));
    try {
      const archive = join(work, 'repo.tgz');
      const root = `defuss-shadcn-${COMMIT}`;
      execFileSync('curl', [
        '-fsSL',
        '-o',
        archive,
        `https://codeload.github.com/kyr0/defuss-shadcn/tar.gz/${COMMIT}`,
      ]);
      execFileSync('tar', ['-xzf', archive, '-C', work, `${root}/LICENSE`, `${root}/src/documentation`]);
      const docs = join(work, root, 'src/documentation');
      const paths = (await readdir(docs, { recursive: true }))
        .filter((x) => x.endsWith('.mdx'))
        .sort();
      fixture = {
        source: SOURCE,
        license: await readFile(join(work, root, 'LICENSE'), 'utf8'),
        documents: await Promise.all(
          paths.map(async (x) => ({ path: x, text: await readFile(join(docs, x), 'utf8') })),
        ),
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    await mkdir(new URL('../input/', import.meta.url), { recursive: true });
    await writeFile(path, JSON.stringify(fixture));
  }
  const sha = createHash('sha256').update(JSON.stringify(fixture.documents)).digest('hex');
  if (sha !== DOCUMENTS_SHA256) throw new Error(`API docs SHA-256 mismatch: ${sha}`);
  return fixture;
}

const HEADING = /^\s*(<H[23][\s>]|<h[23][\s>]|#{2,3} )/;
/** One page as sections {id, page, title, text}; ids are `<path>#<n>`. */
export function chunkPage({ path, text }) {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const title = /^title:\s*"?(.*?)"?\s*$/m.exec(front?.[1] ?? '')?.[1] ?? path;
  const body = (front ? text.slice(front[0].length) : text).replace(/^import .*$/gm, '');
  const blocks = [];
  let lines = [];
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && !line.trim()) {
      if (lines.length) blocks.push(lines);
      lines = [];
    } else lines.push(line);
  }
  if (lines.length) blocks.push(lines);
  // Pieces: blocks within MAX, longer blocks cut at line ends, single overlong lines cut at MAX.
  const pieces = blocks.flatMap((block) => {
    const joined = block.join('\n');
    if (joined.length <= MAX) return [joined];
    const out = [];
    let current = '';
    for (const line of block.flatMap((l) => l.match(new RegExp(`[^]{1,${MAX}}`, 'g')) ?? [''])) {
      if (current && current.length + 1 + line.length > MAX) {
        out.push(current);
        current = line;
      } else current = current ? `${current}\n${line}` : line;
    }
    if (current) out.push(current);
    return out;
  });
  const sections = [];
  let current = '';
  for (const piece of pieces) {
    if (current && (HEADING.test(piece) || current.length + 2 + piece.length > MAX)) {
      sections.push(current);
      current = piece;
    } else current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) sections.push(current);
  return sections.map((section, n) => ({ id: `${path}#${n}`, page: path, title, text: section }));
}

const WORD = /\p{L}[\p{L}\p{N}]*/gu;
const wordsOf = (section) =>
  new Set((`${section.title}\n${section.text}`.match(WORD) ?? []).map((w) => w.toLowerCase()));

/** Single words of at least four letters found in one to three sections; drawn page first, then section. */
export function exactQueries(sections, { count = 100, seed = 4 } = {}) {
  const sets = sections.map(wordsOf);
  const df = new Map();
  for (const set of sets) for (const word of set) df.set(word, (df.get(word) ?? 0) + 1);
  const byPage = Map.groupBy(
    sections.map((section, i) => ({ section, i })),
    (x) => x.section.page,
  );
  const pages = [...byPage.keys()];
  const next = random(seed);
  const used = new Set();
  const queries = [];
  for (let tries = 0; queries.length < count && tries < count * 50; tries++) {
    const list = byPage.get(pages[Math.floor(next() * pages.length)]);
    const { i } = list[Math.floor(next() * list.length)];
    const options = [...sets[i]]
      .filter((w) => /^\p{L}{4,}$/u.test(w) && df.get(w) <= 3 && !used.has(w))
      .sort();
    if (!options.length) continue;
    const word = options[Math.floor(next() * options.length)];
    used.add(word);
    queries.push({
      type: 'exact',
      text: word,
      relevant: new Set(sections.flatMap((s, j) => (sets[j].has(word) ? [s.id] : []))),
    });
  }
  return queries;
}

/**
 * The sections the natural-language queries were written from: one drawn section per drawn page. Draws skip
 * sections under 300 characters (closing tags such as `</DocPage>`) and sections whose text occurs more than once,
 * such as the "Interactive" paragraph shared by the diagram pages: a query cannot single out one of identical texts.
 */
export function drawSections(sections, { count = 100, seed = 7 } = {}) {
  const repeats = new Map();
  for (const s of sections) repeats.set(s.text, (repeats.get(s.text) ?? 0) + 1);
  const byPage = Map.groupBy(
    sections.filter((s) => s.text.length >= 300 && repeats.get(s.text) === 1),
    (s) => s.page,
  );
  const pages = [...byPage.keys()];
  if (pages.length < count) throw new RangeError(`Only ${pages.length} pages have a drawable section`);
  const next = random(seed);
  const drawn = new Map();
  while (drawn.size < count) {
    const page = pages[Math.floor(next() * pages.length)];
    if (drawn.has(page)) continue;
    const list = byPage.get(page);
    drawn.set(page, list[Math.floor(next() * list.length)]);
  }
  return [...drawn.values()];
}

/** Sections, exact queries and the authored natural-language queries with their gold section and page. */
export async function loadApiDocs() {
  const fixture = await loadPages();
  const sections = fixture.documents.flatMap(chunkPage);
  const byId = new Map(sections.map((s) => [s.id, s]));
  const natural = NATURAL.map((q) => {
    const gold = byId.get(q.gold);
    if (!gold?.text.includes(q.anchor))
      throw new Error(`Natural query "${q.text}" lost its gold section ${q.gold}`);
    return {
      type: 'natural',
      text: q.text,
      relevant: new Set([q.gold]),
      page: gold.page,
    };
  });
  return { license: fixture.license, sections, exact: exactQueries(sections), natural };
}
