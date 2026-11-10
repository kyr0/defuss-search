/**
 * Build step of the website's translation: the page source is written in English, website/i18n/de.mjs holds the
 * German of every marked text, and this module writes the defuss-i18n markup that switches between them in the
 * browser (website/i18n.mjs binds it):
 * - an element with a bare `data-t` attribute is a region: it becomes `data-i18n-target`, with one `<template
 *   data-i18n-locale>` per language beside it, the English one holding the authored content;
 * - `aria-label`, `title`, `placeholder` and `alt` outside regions get `data-i18n-{attribute}-{locale}` variants;
 * - a heading with `data-anchor` and an id gets a heading-anchor link (`#/{id}`, the router's section route) whose
 *   label names the heading in each language.
 * Why a catalog keyed by the English text, not by invented keys: the page source stays readable English, and an
 * edited sentence fails the build until its translation is updated, so the two languages cannot drift apart.
 * The scanner understands the HTML this repository writes (every element closed, no implicit end tags); it fails
 * loudly on anything else rather than guessing.
 * VERIFIED: test/localize.test.mjs checks regions, anchors and the region-heading error; make docs fails on a text
 * without German.
 */
const VOID = new Set(
  'area base br col embed hr img input link meta source track wbr'.split(' '),
);
const RAW = new Set(['script', 'style', 'textarea']);
const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];
const TAG =
  /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTRIBUTE = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The attributes of a start tag's attribute text, in order. */
export function parseAttributes(text) {
  return [...text.matchAll(ATTRIBUTE)].map((m) => [m[1], m[2] ?? m[3] ?? m[4] ?? null]);
}

/**
 * The elements of `html` as { name, start, openEnd, closeStart, end, attrs, parent }: `start`/`openEnd` bound the
 * start tag, `closeStart`/`end` the end tag (equal to `openEnd` for a void or self-closed element). Comments and
 * the content of script, style and textarea are skipped. Throws on an end tag that closes nothing open.
 */
export function scanElements(html) {
  const elements = [];
  const stack = [];
  TAG.lastIndex = 0;
  for (let m; (m = TAG.exec(html)); ) {
    if (m[0].startsWith('<!--')) continue;
    const [whole, closing, rawName, attrText, selfClose] = m;
    const name = rawName.toLowerCase();
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== name)
        throw new Error(`Unbalanced </${name}> at ${m.index}: ${open ? `<${open.name}> is open` : 'nothing is open'}`);
      open.closeStart = m.index;
      open.end = m.index + whole.length;
      continue;
    }
    const element = {
      name,
      start: m.index,
      openEnd: m.index + whole.length,
      attrs: parseAttributes(attrText),
      parent: stack.at(-1) ?? null,
    };
    elements.push(element);
    if (VOID.has(name) || selfClose) {
      element.closeStart = element.end = element.openEnd;
    } else if (RAW.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, element.openEnd);
      if (close < 0) throw new Error(`<${name}> at ${m.index} is never closed`);
      element.closeStart = close;
      element.end = html.indexOf('>', close) + 1;
      TAG.lastIndex = element.end;
    } else stack.push(element);
  }
  if (stack.length) throw new Error(`<${stack.at(-1).name}> at ${stack.at(-1).start} is never closed`);
  return elements;
}

/** The catalog key of an English text: whitespace collapsed, also inside tags. */
export const normalize = (html) =>
  html
    .replace(/\s+/g, ' ')
    .replace(/\s+(\/?>)/g, '$1')
    .replace(/(<\/?[\w-]+) +/g, '$1 ')
    .trim();
/** Plain text of an HTML fragment, for labels. */
export const plainText = (html) =>
  normalize(html.replace(/<[^>]*>/g, ' ')).replace(
    /&(amp|lt|gt|quot|#39|nbsp);/g,
    (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e],
  );
const escapeAttribute = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const has = (element, name) => element.attrs.some(([key]) => key === name);
const value = (element, name) => element.attrs.find(([key]) => key === name)?.[1];

/** A short stable name for a region: FNV-1a of its key, plus a counter for repeated texts. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** The heading-anchor link of section `id`, labelled in both languages (plain text in, escaped here); it goes first. */
export const headingAnchor = (id, en, de) =>
  `<a class="heading-anchor" href="#/${id}" data-router-link aria-label="Link to section: ${escapeAttribute(en)}" data-i18n-aria-label-en="Link to section: ${escapeAttribute(en)}" data-i18n-aria-label-de="Link zum Abschnitt: ${escapeAttribute(de)}">§</a>`;

/**
 * A region written by a generator in both languages, for text that carries measured figures: the catalog cannot key
 * it, because the English changes with every benchmark run. `name` must be unique on the page; `en` and `de` are HTML.
 */
export const bilingual = (tag, attrs, name, en, de) =>
  `<${tag}${attrs ? ` ${attrs}` : ''} data-i18n-target="${name}">${en}</${tag}><template data-i18n-for="${name}" data-i18n-locale="en">${en}</template><template data-i18n-for="${name}" data-i18n-locale="de">${de}</template>`;

/** Builds the lookup of a catalog given as [english, german] pairs; a repeated English text must not differ. */
export function catalogMap(pairs) {
  const map = new Map();
  for (const [en, de] of pairs) {
    const key = normalize(en);
    if (map.has(key) && map.get(key) !== de) throw new Error(`Two translations of: ${key}`);
    map.set(key, de);
  }
  return map;
}

/**
 * Writes the translation markup into a page. `catalog` maps normalized English to German (catalogMap). Returns
 * { html, missing, used }: the English texts without a translation (the build fails on any) and the keys used, so
 * scripts/check-project.mjs can report catalog entries no page needs.
 */
export function localize(html, catalog) {
  const elements = scanElements(html);
  const missing = new Set();
  const used = new Set();
  const german = (en) => {
    const key = normalize(en);
    if (!catalog.has(key)) {
      missing.add(key);
      return en;
    }
    used.add(key);
    return catalog.get(key);
  };
  const edits = []; // [position, deleteCount, insert], applied from the end
  const regions = elements.filter((element) => has(element, 'data-t') && value(element, 'data-t') === null);
  const counts = new Map();
  for (const region of regions) {
    for (let up = region.parent; up; up = up.parent)
      if (regions.includes(up)) throw new Error(`Nested data-t region <${region.name}> at ${region.start}`);
    const inner = html.slice(region.openEnd, region.closeStart);
    const key = normalize(inner);
    if (!key) throw new Error(`Empty data-t region <${region.name}> at ${region.start}`);
    const base = `t-${hash(key)}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    const name = n === 1 ? base : `${base}-${n}`;
    // Replace only the attribute, so an attribute variant inserted before the tag's end never overlaps this edit.
    const marker = /\sdata-t(?=[\s/>])/.exec(html.slice(region.start, region.openEnd));
    edits.push([region.start + marker.index, marker[0].length, ` data-i18n-target="${name}"`]);
    edits.push([
      region.end,
      0,
      `<template data-i18n-for="${name}" data-i18n-locale="en">${inner}</template><template data-i18n-for="${name}" data-i18n-locale="de">${german(inner)}</template>`,
    ]);
  }
  const inRegion = (element) => {
    for (let up = element.parent; up; up = up.parent) if (regions.includes(up) || up.name === 'template') return true;
    return false;
  };
  for (const element of elements) {
    if (element.name === 'template' || inRegion(element)) continue;
    const variants = [];
    for (const attribute of ATTRIBUTES) {
      const text = value(element, attribute);
      if (!text || !/\p{L}/u.test(text) || has(element, `data-i18n-${attribute}-de`)) continue;
      variants.push(
        ` data-i18n-${attribute}-en="${escapeAttribute(text)}" data-i18n-${attribute}-de="${escapeAttribute(german(text))}"`,
      );
    }
    if (/^h[1-6]$/.test(element.name) && has(element, 'data-anchor')) {
      // `data-anchor="how"` links the section the heading titles; a bare data-anchor links the heading's own id.
      const id = value(element, 'data-anchor') || value(element, 'id');
      if (!id) throw new Error(`<${element.name} data-anchor> at ${element.start} needs an id`);
      // A translation replaces a region's content, and with it an anchor inside: mark a span in the heading instead.
      if (regions.includes(element))
        throw new Error(`<${element.name} data-anchor> at ${element.start} is a data-t region; wrap its text`);
      // The label names the heading by its region marked data-anchor-text, else its first region, else its text.
      const inside = regions.filter((region) => {
        for (let up = region.parent; up; up = up.parent) if (up === element) return true;
        return false;
      });
      const named = inside.find((region) => has(region, 'data-anchor-text')) ?? inside[0];
      const inner = html.slice((named ?? element).openEnd, (named ?? element).closeStart);
      const en = plainText(inner);
      const de = plainText(named ? german(inner) : inner);
      // First in the heading, so the anchors of every heading line up at the start.
      edits.push([element.openEnd, 0, headingAnchor(id, en, de)]);
    }
    // Right after the last attribute: before the whitespace and the `/>` or `>` that end the tag.
    const tagEnd = element.openEnd - /\s*\/?>$/.exec(html.slice(element.start, element.openEnd))[0].length;
    if (variants.length) edits.push([tagEnd, 0, variants.join('')]);
  }
  edits.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  let out = html;
  for (const [at, remove, insert] of edits) out = out.slice(0, at) + insert + out.slice(at + remove);
  return { html: out, missing: [...missing], used: [...used] };
}
