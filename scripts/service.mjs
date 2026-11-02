/**
 * make start|stop|status|log for the website: a detached server with its PID and URL in tmp/ and
 * logs in var/log/ (VERIFIED: make start|status|stop in e2e), so it survives the launching shell and stops cleanly on SIGTERM.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
const verb = process.argv[2];
const state = async () => {
  try {
    const s = JSON.parse(await readFile('tmp/demo.json', 'utf8'));
    process.kill(s.pid, 0);
    return s;
  } catch {
    return null;
  }
};
const log = (level, message) => console.log(`${new Date().toISOString()} ${level} ${message}`);
if (verb === 'start') {
  const current = await state();
  if (current) {
    log('INFO', `Already running url=${current.url}`);
    process.exit(0);
  }
  await mkdir('var/log', { recursive: true });
  await mkdir('tmp', { recursive: true });
  try {
    await unlink('tmp/demo.json');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stdout = openSync('var/log/demo.stdout', 'a'),
    stderr = openSync('var/log/demo.stderr', 'a');
  const child = spawn(process.execPath, ['scripts/server.mjs'], {
    detached: true,
    stdio: ['ignore', stdout, stderr],
    env: process.env,
  });
  child.unref();
  closeSync(stdout);
  closeSync(stderr);
  await writeFile('tmp/demo.pid', String(child.pid));
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ready = await state();
    if (ready) {
      log('INFO', `Started url=${ready.url}`);
      process.exit(0);
    }
  }
  throw new Error('Website failed to start; inspect make log');
} else if (verb === 'stop') {
  const current = await state();
  if (current) {
    process.kill(current.pid, 'SIGTERM');
    for (let i = 0; i < 100; i++) {
      if (!(await state())) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  for (const path of ['tmp/demo.pid', 'tmp/demo.json'])
    try {
      await unlink(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  log('INFO', 'Website stopped');
} else if (verb === 'status') log('INFO', JSON.stringify(await state()) ?? 'stopped');
else if (verb === 'log') {
  for (const name of ['stdout', 'stderr'])
    try {
      console.log(
        (await readFile(`var/log/demo.${name}`, 'utf8')).split('\n').slice(-40).join('\n'),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
} else throw new Error('Use start, stop, status or log');
