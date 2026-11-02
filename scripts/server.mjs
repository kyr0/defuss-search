import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
/** Static-only server. A project Pages prefix exercises relative URLs during e2e. */
export async function startServer(port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new RangeError('PORT must be in [0,65535]');
  const docs = resolve(root, 'docs'),
    examples = resolve(root, 'examples');
  const server = createServer(async (request, response) => {
    try {
      let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname.startsWith('/defuss-search/'))
        pathname = pathname.slice('/defuss-search'.length);
      let base = docs,
        name = pathname.slice(1);
      if (pathname.startsWith('/examples/')) {
        base = examples;
        name = pathname.slice(10);
      }
      if (pathname.endsWith('/')) name += 'index.html';
      const file = await realpath(resolve(base, name));
      const resolvedBase = await realpath(base);
      if (!file.startsWith(resolvedBase + sep)) {
        response.writeHead(403).end();
        return;
      }
      const bytes = await readFile(file);
      response.writeHead(200, {
        'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer(Number(process.env.PORT ?? 4173));
  await mkdir(resolve(root, 'tmp'), { recursive: true });
  await writeFile(
    resolve(root, 'tmp/demo.json'),
    JSON.stringify({ pid: process.pid, url: server.url }),
  );
  console.log(`${new Date().toISOString()} INFO Website ready url=${server.url}`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
