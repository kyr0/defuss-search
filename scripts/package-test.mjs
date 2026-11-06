/**
 * Install the packed tarball in an isolated consumer and use it like a user: Node.js ESM and CommonJS,
 * Bun, NodeNext declarations and a browser bundle. VERIFIED: tests of the source tree cannot catch a broken
 * export map, a missing file or a model runtime leaking into the browser bundle.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, cp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = process.cwd();
const node = 'node';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('output/package', { recursive: true });
const archive = resolve(`output/package/${manifest.name}-${manifest.version}.tgz`);
execFileSync('bun', ['pm', 'pack', '--destination', resolve('output/package')], { stdio: 'pipe' });
const temporary = await mkdtemp(join(tmpdir(), 'defuss-search-consumer-'));
const run = (command, args, cwd = temporary) =>
  execFileSync(command, args, { cwd, stdio: 'pipe', env: process.env }).toString();
try {
  await writeFile(
    join(temporary, 'package.json'),
    JSON.stringify({
      name: 'isolated-hybrid-consumer',
      private: true,
      type: 'module',
      dependencies: { 'defuss-search': `file:${archive}` },
    }),
  );
  run('bun', ['install']);
  const core = `import assert from 'node:assert/strict';import {fuseRankings,searchPreset} from 'defuss-search';assert.equal(searchPreset('efficient').rerank,false);assert.equal(fuseRankings([{name:'one',hits:[{id:'x',score:2}]}])[0].id,'x');`;
  await writeFile(join(temporary, 'core.mjs'), core);
  run(node, ['core.mjs']);
  // The root entry must not depend on either optional peer at runtime.
  await assert.rejects(readFile(join(temporary, 'node_modules/defuss-lexicalsearch/package.json')));
  const consumer = `import assert from 'node:assert/strict';import {createHybridIndex} from 'defuss-search/indexing';import {apiSearchPreset} from 'defuss-lexicalsearch';import {en} from 'defuss-lexicalsearch/en';import {searchPreset} from 'defuss-search';import {surfaceAnalyzer,surfaceField,withSurfaceFields} from 'defuss-search/lexical';import {createColbertAdapter} from 'defuss-search/colbert';const search=createHybridIndex({documents:[{id:'C++',fields:{symbol:'C++',description:'language'}},{id:'C',fields:{symbol:'C',description:'language'}}],vectors:[[1,0],[.9,.1]],lexical:apiSearchPreset,lexicalSearch:{exact:{fields:['symbol']}}});const hits=await search.search({text:'C++',vector:[0,1]},{exact:'promote'});assert.equal(hits[0].id,'C++');assert.equal(typeof createColbertAdapter,'function');const docs=createHybridIndex({documents:[{id:'tab',fields:{text:'Press the tab key to reach the next tab stop'}},{id:'tabs',fields:{text:'Tabs switch between panels'}}],vectors:[[1,0],[1,0]],lexical:{fields:{text:{analyzer:en}}}});assert.equal((await docs.search({text:'tabs',vector:[1,0]},searchPreset('efficient')))[0].id,'tabs','unstemmed companions are on by default');const fields=withSurfaceFields({fields:{text:{analyzer:en}}}).fields;assert.equal(fields[surfaceField('text')].analyzer,surfaceAnalyzer(en));const {de}=await import('defuss-lexicalsearch/de');const notes=createHybridIndex({documents:[{id:'de',fields:{de:'Pinguine im Zoo'}},{id:'en',fields:{en:'penguins at the zoo'}}],vectors:[[1,0],[1,0]],lexical:{fields:{de:{analyzer:de},en:{analyzer:en}}}});for(const [language,first] of [['de','de'],['en','en']])assert.equal((await notes.search({text:'zoo',vector:[1,0],language},searchPreset('efficient')))[0].id,first,'the query language weighs its fields');`;
  run('bun', [
    'add',
    '--exact',
    `defuss-lexicalsearch@${manifest.devDependencies['defuss-lexicalsearch']}`,
    `defuss-vectorsearch@${manifest.devDependencies['defuss-vectorsearch']}`,
    // The website's language identifier; the package itself does not import it.
    `defuss-lid@${manifest.devDependencies['defuss-lid']}`,
  ]);
  await writeFile(join(temporary, 'consumer.mjs'), consumer);
  run(node, ['consumer.mjs']);
  run('bun', ['consumer.mjs']);
  await writeFile(
    join(temporary, 'consumer.cjs'),
    `const assert=require('node:assert/strict');const {HybridSearch,fuseRankings,searchPreset}=require('defuss-search');assert.equal(searchPreset('efficient').rerank,false);for(const name of ['lexical','vector','colbert','indexing','strategies'])assert.ok(Object.keys(require('defuss-search/'+name)).length);assert.equal(typeof HybridSearch,'function');assert.equal(fuseRankings([{name:'x',hits:[]}]).length,0);`,
  );
  run(node, ['consumer.cjs']);
  await cp(join(root, 'test/consumer.mts'), join(temporary, 'types.mts'));
  await cp(join(root, 'test/consumer.cts'), join(temporary, 'types.cts'));
  run(node, [
    join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    '--strict',
    '--skipLibCheck',
    'types.mts',
    'types.cts',
  ]);
  await writeFile(
    join(temporary, 'browser.mjs'),
    `import {createHybridIndex} from 'defuss-search/indexing';import {createColbertAdapter,createColbertRetriever} from 'defuss-search/colbert';import {createLexicalOnlySearch,createLexicalSemanticSearch,createLexicalSemanticTinySearch} from 'defuss-search/strategies';globalThis.hybridPackage={createHybridIndex,createColbertAdapter,createColbertRetriever,createLexicalOnlySearch,createLexicalSemanticSearch,createLexicalSemanticTinySearch};`,
  );
  run('bun', ['build', '--target=browser', '--format=esm', '--outfile=bundle.js', 'browser.mjs']);
  const bundle = await readFile(join(temporary, 'bundle.js'), 'utf8');
  for (const forbidden of [
    'onnxruntime-node',
    '@huggingface/transformers',
    'defuss-multicore',
    'node:fs',
  ])
    assert.ok(!bundle.includes(forbidden), `Unexpected browser dependency ${forbidden}`);
  const packaged = JSON.parse(
    await readFile(join(temporary, 'node_modules/defuss-search/package.json'), 'utf8'),
  );
  for (const [, exports] of Object.entries(packaged.exports))
    for (const condition of ['import', 'require'])
      for (const path of Object.values(exports[condition]))
        await readFile(join(temporary, 'node_modules/defuss-search', path));
  // Build the website in the isolated consumer with the configuration of `make docs`: its package imports must
  // resolve from the tarball. The build replaces the source tree's chunks and restamps the pages.
  await cp(join(root, 'website'), join(temporary, 'website'), { recursive: true });
  await cp(join(root, 'fixtures'), join(temporary, 'fixtures'), { recursive: true });
  run('bun', [join(root, 'scripts/website-build.mjs'), join(root, 'docs')]);
  await mkdir(join(root, 'output'), { recursive: true });
  await writeFile(
    join(root, 'output/package-check.json'),
    JSON.stringify(
      {
        version: manifest.version,
        completedAt: new Date().toISOString(),
        archive: `${manifest.name}-${manifest.version}.tgz`,
        node: process.version,
        bun: run('bun', ['--version']).trim(),
        checks: [
          'isolated tarball install',
          'root ESM without peers',
          'peer adapters in Node ESM and Bun',
          'CommonJS all entries',
          'NodeNext ESM/CJS declaration consumers',
          'browser bundle without model runtimes or Node imports',
          'all exported files present',
          'website built against installed tarball',
        ],
        browserBundleBytes: Buffer.byteLength(bundle),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `${new Date().toISOString()} INFO PASS: isolated tarball, Node ESM/CJS, Bun, declarations and browser dependency boundary`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
