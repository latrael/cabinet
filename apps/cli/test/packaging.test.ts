import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Library, loadSecrets } from '@cabinet/core';
import { Auth } from '@cabinet/server';
import { tempDir, waitFor } from '../../../packages/core/test/helpers.ts';

const ROOT = new URL('../../..', import.meta.url).pathname;
const CLI = join(ROOT, 'apps/cli/src/main.ts');
let cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const c of cleanups.reverse()) await c(); cleanups = []; });

function command(args: string[], input = ''): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    p.stdout.on('data', (d) => { output += d; });
    p.stderr.on('data', (d) => { output += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, output }));
    p.stdin.end(input);
  });
}

test('passphrase bootstrap works through stdin without exposing it; short secrets leave no passphrase', async () => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const library = join(t.dir, 'Empty Cabinet');
  const short = await command([CLI, 'passphrase', '--stdin', '--library', library], 'short\n');
  expect(short.code).toBe(1);
  expect(short.output).toContain('at least 8');
  expect(loadSecrets(library).passphraseHash).toBeUndefined();
  const passphrase = 'synthetic-passphrase-for-packaging';
  const saved = await command([CLI, 'passphrase', '--stdin', '--library', library], passphrase + '\n');
  expect(saved.code).toBe(0);
  expect(saved.output).not.toContain(passphrase);
  expect(JSON.stringify(loadSecrets(library))).not.toContain(passphrase);
  const lib = await Library.open(library, { git: false });
  cleanups.push(() => lib.close());
  const auth = new Auth(lib);
  expect(auth.checkPassphrase(passphrase)).toBe(true);
  expect(auth.checkPassphrase('incorrect')).toBe(false);
  const result = auth.check({ remote: '172.18.0.1', method: 'GET', headers: { host: 'localhost:4747' } });
  expect(result.ok).toBe(false);
  expect(auth.verifySession(auth.issueSession())).toBe(true);
});

test('launchd renderer uses absolute paths, escapes XML and refuses accidental replacement', async () => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const output = join(t.dir, 'com.cabinet.plist');
  const library = join(t.dir, 'Cabinet & Notes');
  const args = [join(ROOT, 'scripts/render-launchd.mjs'), '--output', output, '--library', library, '--log-dir', join(t.dir, 'Logs')];
  const generated = await command(args);
  expect(generated.code).toBe(0);
  const xml = readFileSync(output, 'utf8');
  expect(xml).toContain(process.execPath);
  expect(xml).toContain('Cabinet &amp; Notes');
  expect(xml).toContain(join(ROOT, 'apps/cli/src/main.ts'));
  expect(xml).not.toMatch(/__[A-Z_]+__/);
  expect((await command(args)).code).toBe(1);
  if (process.platform === 'darwin') {
    const p = spawn('/usr/bin/plutil', ['-lint', output]);
    expect(await new Promise((r) => p.on('close', r))).toBe(0);
  }
});

test('packaged CLI starts an empty external library, serves the web app and flushes on SIGTERM', async () => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const library = join(t.dir, 'Cabinet');
  const p = spawn(process.execPath, [CLI, 'start', '--library', library, '--port', '0', '--no-ai', '--no-telegram'], {
    cwd: ROOT, env: { ...process.env, CABINET_APP_CONFIG: join(t.dir, 'app.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  p.stdout.on('data', (d) => { output += d; });
  p.stderr.on('data', (d) => { output += d; });
  const ended = new Promise((resolve) => p.once('exit', resolve));
  cleanups.push(async () => { if (p.exitCode === null) { p.kill('SIGTERM'); await ended; } });
  const url = await waitFor(() => {
    if (p.exitCode !== null) throw new Error(output);
    return output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  }, 10_000);
  const web = await fetch(url);
  expect(web.status).toBe(200);
  expect(await web.text()).toContain('/assets/');
  expect((await (await fetch(url + '/api/items')).json()).total).toBe(0);
  const captured = await fetch(url + '/api/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'An empty-library packaging smoke note', kind: 'note' }) });
  expect(captured.status).toBe(201);
  p.kill('SIGTERM');
  expect(await ended).toBe(0);
  expect(readFileSync(join(library, 'notes/an-empty-library-packaging-smoke-note.md'), 'utf8')).toContain('packaging smoke note');
  const lib = await Library.open(library);
  cleanups.push(() => lib.close());
  expect((await lib.git!.log()).some((c) => c.author === 'you')).toBe(true);
});
