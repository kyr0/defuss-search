import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

test('README runnable examples execute with their stated outputs', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const examples = [...readme.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.equal(examples.length, 3);
  // Temporary files live inside the package so Node and Bun resolve its self-reference.
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  const directory = await mkdtemp(new URL('../tmp/readme-', import.meta.url).pathname);
  try {
    for (let i = 0; i < examples.length; i++) {
      const file = join(directory, `${i}.mjs`);
      await writeFile(file, examples[i]);
      const output = execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim();
      // Each example states its output in the comment after its last console.log.
      const stated = [...examples[i].matchAll(/console\.log\(.*\);\s*\/\/\s*(\S+)/g)].at(-1)?.[1];
      assert.ok(stated, `example ${i + 1} states no output`);
      assert.equal(output, stated);
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});
