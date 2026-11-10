import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as root from 'defuss-search';
import * as strategies from 'defuss-search/strategies';
import * as indexing from 'defuss-search/indexing';
import * as lexical from 'defuss-search/lexical';
import * as lexicalsearch from 'defuss-lexicalsearch';
import * as en from 'defuss-lexicalsearch/en';
import * as de from 'defuss-lexicalsearch/de';
import { inspect, rewriteImports, runSnippet } from '../website/playground-source.mjs';
import { SNIPPETS } from '../website/playground-snippets.mjs';

// The same table as website/playground-worker.mjs, with the packages this repository installs.
const modules = {
  'defuss-search': root,
  'defuss-search/strategies': strategies,
  'defuss-search/indexing': indexing,
  'defuss-search/lexical': lexical,
  'defuss-lexicalsearch': lexicalsearch,
  'defuss-lexicalsearch/en': en,
  'defuss-lexicalsearch/de': de,
};
const run = async (name) => {
  const result = await runSnippet(SNIPPETS[name], modules);
  assert.equal(result.error, undefined);
  return result.lines.map((line) => line.text);
};

test('the playground examples print what the page says they show', async () => {
  assert.deepEqual(await run('lexical'), ['["1. walk", "2. park"]']);
  assert.deepEqual(await run('exact'), [
    '1 push { exact: true, reasons: ["literal-exact"] }',
    '2 pop { exact: false, reasons: [] }',
  ]);
  const explain = await run('explain');
  assert.deepEqual(explain.slice(0, 3), [
    '1 shift 2.50 { lexical: 1, vector: 2 }',
    '2 pop 2.00 { lexical: 2, vector: 1 }',
    '3 push 1.00 { lexical: 3, vector: 3 }',
  ]);
  assert.match(explain[3], /^#1 \{\n {2}lexical: \{[\s\S]*contribution: 2,[\s\S]*vector: \{ rank: 2,[\s\S]*contribution: 0\.5 \}\n\}$/);
  assert.deepEqual(await run('languages'), ['de ["de-1"]', 'en ["en-1"]']);
});

test('imports become lookups on the same lines, and an unknown module is named', () => {
  const available = ['a', 'b/c'];
  assert.equal(
    rewriteImports("import x from 'a';\nimport { y, z as w } from \"b/c\"\nimport * as all from 'a';\nimport d, { e } from 'a';", available),
    'const x = __module("a").default;\nconst { y, z: w } = __module("b/c");\nconst all = __module("a");\nconst d = __module("a").default; const { e } = __module("a");',
  );
  assert.equal(rewriteImports("import {\n  y,\n} from 'a';\nthrow 1;", available), 'const { y } = __module("a");\n\n\nthrow 1;');
  assert.throws(() => rewriteImports("import fs from 'node:fs';", available), /no module "node:fs"\. Available: a, b\/c/);
});

test('a thrown error and the console levels reach the output', async () => {
  const result = await runSnippet("console.warn('careful', 1n);\nnull.x;", modules);
  assert.deepEqual(result.lines, [{ level: 'warn', text: 'careful 1n' }]);
  assert.match(result.error, /^TypeError: /);
  assert.equal(inspect({ a: [1, 'x'], b: new Map([['k', new Set([2])]]) }), '{ a: [1, "x"], b: Map(1) { "k" => Set(1) { 2 } } }');
  const loop = { name: 'loop' };
  loop.self = loop;
  assert.equal(inspect(loop), '{ name: "loop", self: [Circular] }');
});
