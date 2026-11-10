import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogMap, localize, normalize, scanElements } from '../scripts/localize.mjs';

const catalog = catalogMap([
  ['Find the <em>exact</em> word', 'Finde das <em>genaue</em> Wort'],
  ['Copy code', 'Code kopieren'],
  ['How it works', 'So funktioniert es'],
]);

test('a data-t region gets a target and one template per language beside it', () => {
  const { html, missing } = localize('<p class="x" data-t>Find the <em>exact</em>\n  word</p>', catalog);
  assert.deepEqual(missing, []);
  const name = /data-i18n-target="(t-[a-z0-9]+)"/.exec(html)[1];
  assert.equal(
    html,
    `<p class="x" data-i18n-target="${name}">Find the <em>exact</em>\n  word</p>` +
      `<template data-i18n-for="${name}" data-i18n-locale="en">Find the <em>exact</em>\n  word</template>` +
      `<template data-i18n-for="${name}" data-i18n-locale="de">Finde das <em>genaue</em> Wort</template>`,
  );
});

test('repeated texts get distinct targets, and a missing translation is reported', () => {
  const { html, missing } = localize('<b data-t>Copy code</b><b data-t>Copy code</b><i data-t>New text</i>', catalog);
  const names = [...html.matchAll(/data-i18n-target="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, 3);
  assert.deepEqual(missing, ['New text']);
});

test('attributes outside regions get variants; attributes inside a region belong to its templates', () => {
  const { html } = localize(
    '<button aria-label="Copy code" title="Copy code"><svg aria-hidden="true"/></button><p data-t>Find the <em>exact</em> word</p><input placeholder="Copy code" />',
    catalog,
  );
  assert.match(html, /<button aria-label="Copy code" title="Copy code" data-i18n-aria-label-en="Copy code" data-i18n-aria-label-de="Code kopieren" data-i18n-title-en="Copy code" data-i18n-title-de="Code kopieren">/);
  assert.match(html, /<input placeholder="Copy code" data-i18n-placeholder-en="Copy code" data-i18n-placeholder-de="Code kopieren" \/>/);
  const inside = localize('<p data-t>Find the <em>exact</em> word</p>', catalogMap([['Find the <em>exact</em> word', 'x']]));
  assert.doesNotMatch(inside.html, /data-i18n-aria/);
});

test('an anchored heading links its section route and names the heading in both languages', () => {
  const { html } = localize('<h2 id="how" data-anchor><span data-t>How it works</span></h2>', catalog);
  // The anchor comes first in the heading, before its text.
  assert.match(html, /^<h2 id="how" data-anchor><a class="heading-anchor" href="#\/how" data-router-link aria-label="Link to section: How it works" data-i18n-aria-label-en="Link to section: How it works" data-i18n-aria-label-de="Link zum Abschnitt: So funktioniert es">§<\/a><span data-i18n-target=/);
  assert.throws(() => localize('<h2 data-anchor><span data-t>How it works</span></h2>', catalog), /needs an id/);
  // A section title links its section: data-anchor names the target.
  assert.match(
    localize('<h2 id="how-title" data-anchor="how"><span data-t>How it works</span></h2>', catalog).html,
    /href="#\/how" data-router-link/,
  );
  // A translated heading would lose the anchor with its content.
  assert.throws(() => localize('<h2 id="how" data-anchor data-t>How it works</h2>', catalog), /wrap its text/);
});

test('the scanner skips raw text and fails on markup it cannot balance', () => {
  const elements = scanElements('<div><script>const a = "<p>";</script><textarea><b></textarea></div>');
  assert.deepEqual(
    elements.map((e) => e.name),
    ['div', 'script', 'textarea'],
  );
  assert.throws(() => scanElements('<div><span></div>'), /Unbalanced <\/div>/);
  assert.throws(() => scanElements('<div>'), /never closed/);
  assert.throws(() => localize('<p data-t><b data-t>x</b></p>', catalog), /Nested data-t region/);
});

test('catalog keys ignore the whitespace a formatter moves', () => {
  assert.equal(normalize('Find the\n   <a\n  href="#x"\n  >exact</a\n> word '), 'Find the <a href="#x">exact</a> word');
  assert.throws(() => catalogMap([['a', 'b'], ['a ', 'c']]), /Two translations/);
});
