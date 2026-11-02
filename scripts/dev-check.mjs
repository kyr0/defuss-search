/**
 * make e2e: start the make dev server on a free port, then check the injected reload hook, the
 * event stream and the clean SIGTERM exit. It runs before the package test because its startup
 * build writes docs/assets from the source tree; the package test then rebuilds them from the
 * tarball. Rebuild-on-edit is not exercised here, since that would modify tracked sources.
 * VERIFIED: a mutation probe that removed the reload hook failed this check (session 2026-11-01).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const child = spawn(process.execPath, ['scripts/dev.mjs'], {
  env: { ...process.env, PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('make dev did not become ready in 30 s')),
      30000,
    );
    child.once('exit', (code) => reject(new Error(`make dev exited early with code ${code}`)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      const ready = / INFO Dev server ready url=(\S+)/.exec(line);
      if (ready) {
        clearTimeout(timer);
        resolve(ready[1]);
      }
    });
  });
  for (const route of ['/', '/defuss-search/']) {
    const page = await fetch(url + route);
    assert.equal(page.status, 200, route);
    const html = await page.text();
    assert.ok(html.includes('<section id="recall"'), `${route} serves the built website`);
    assert.ok(html.endsWith('location.reload()</script>'), `${route} carries the reload hook`);
  }
  assert.equal((await fetch(url + '/package.json')).status, 404);
  const events = new AbortController();
  const stream = await fetch(url + '/__reload', { signal: events.signal });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const { value } = await stream.body.getReader().read();
  assert.equal(new TextDecoder().decode(value), ': connected\n\n');
  events.abort();
  child.kill('SIGTERM');
  assert.equal(await exited, 0, 'make dev exits cleanly on SIGTERM');
  await mkdir('output/e2e', { recursive: true });
  await writeFile(
    'output/e2e/dev.json',
    JSON.stringify({ completedAt: new Date().toISOString(), url, reloadHook: true, sigterm: 0 }) +
      '\n',
  );
  console.log(
    `${new Date().toISOString()} INFO PASS: make dev serves, injects reload, exits on SIGTERM`,
  );
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
}
