/**
 * make dev: build the website, serve it with live reload and rebuild when its sources change.
 * It proxies the production static server (scripts/server.mjs) instead of extending it, so the
 * served paths, the /defuss-search/ prefix and the traversal guard stay identical, and the reload
 * hook is injected at serve time, never written into the committed docs/ build.
 * VERIFIED: a website/ edit rebuilds and reloads an open page (session 2026-11-01); e2e checks the
 * hook, the event stream and the clean SIGTERM exit.
 */
import { spawn } from 'node:child_process';
import { statSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { startServer } from './server.mjs';
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new RangeError('PORT must be in [0,65535]');
const log = (level, message) => console.log(`${new Date().toISOString()} ${level} ${message}`);
// VERIFIED: the build writes none of these paths unless their content changes (writeRecall
// compares first), so a rebuild never triggers itself.
const sources = [
  'website',
  'src',
  'fixtures',
  'docs/reference.md',
  'docs/data/recall.json',
  'scripts/docs.mjs',
  'scripts/recall-docs.mjs',
  'scripts/highlight.mjs',
];
const hook = `<script>new EventSource('/__reload').onmessage=()=>location.reload()</script>`;
const clients = new Set();

/** Runs one build step; output is shown only on failure, so a healthy loop logs one line per build. */
const step = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });

let building = false,
  pending = new Set();
async function rebuild(changed) {
  if (building) {
    for (const file of changed) pending.add(file);
    return;
  }
  building = true;
  const started = performance.now();
  // The website imports the package by name, which resolves to dist/; only src/ edits need pkgroll.
  const result = [...changed].some((file) => file.startsWith('src/'))
    ? await step(['run', 'build'])
    : { ok: true };
  const docs = result.ok ? await step(['scripts/docs.mjs']) : result;
  const ms = Math.round(performance.now() - started);
  if (docs.ok) {
    log('INFO', `Rebuilt ms=${ms} changed=${[...changed].join(',') || 'startup'}`);
    for (const client of clients) client.write('data: reload\n\n');
  } else log('ERROR', `Build failed ms=${ms}; serving the last good build\n${docs.output.trim()}`);
  building = false;
  if (pending.size) {
    const next = pending;
    pending = new Set();
    await rebuild(next);
  }
}

const site = await startServer(0);
const server = createServer(async (request, response) => {
  if (request.url === '/__reload') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    response.write(': connected\n\n');
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  try {
    const upstream = await fetch(site.url + request.url);
    const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
    let body = Buffer.from(await upstream.arrayBuffer());
    if (type.startsWith('text/html')) body = Buffer.concat([body, Buffer.from(hook)]);
    response.writeHead(upstream.status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(body);
  } catch (error) {
    response.writeHead(502).end(String(error));
  }
});
// Bind before the first build, so a busy port fails fast with one line instead of a stack trace.
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
} catch (error) {
  if (error.code !== 'EADDRINUSE') throw error;
  log('ERROR', `Port ${port} is in use; run PORT=0 make dev for a free port`);
  process.exit(1);
}
await rebuild(new Set());
let timer,
  changed = new Set();
const watchers = sources.map((path) => {
  const directory = statSync(path).isDirectory();
  return watch(path, { recursive: true }, (_event, file) => {
    changed.add(directory && file ? `${path}/${file}` : path);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = changed;
      changed = new Set();
      void rebuild(batch);
    }, 100);
  });
});
log('INFO', `Dev server ready url=http://127.0.0.1:${server.address().port}`);
const stop = () => {
  for (const watcher of watchers) watcher.close();
  for (const client of clients) client.end();
  log('INFO', 'Dev server stopped');
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
