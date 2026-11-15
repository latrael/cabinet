#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const image = process.argv[2] ?? 'cabinet:local';
const temp = mkdtempSync(join(tmpdir(), 'cabinet-docker-smoke-'));
const data = join(temp, 'data');
mkdirSync(data);
const model = process.env.CABINET_WHISPER_MODEL ?? join(homedir(), '.cache/cabinet/whisper/ggml-base.bin');
const hasModel = existsSync(model);
const models = hasModel ? dirname(model) : join(temp, 'models');
mkdirSync(models, { recursive: true });
const name = `cabinet-smoke-${randomBytes(5).toString('hex')}`;
const password = randomBytes(20).toString('hex');
const mount = ['--mount', `type=bind,source=${data},target=/data`, '--mount', `type=bind,source=${models},target=/models,readonly`];
if (process.getuid) mount.push('--user', `${process.getuid()}:${process.getgid()}`);
const modelEnv = ['-e', `CABINET_WHISPER_MODEL=/models/${basename(model)}`];
let running = false;
let library = '/data/Empty';
let base = '';
let cookie = '';

async function docker(args) {
  return (await exec('docker', args, { maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}
async function cli(args, input) {
  const argv = ['run', '--rm', ...(input === undefined ? [] : ['-i']), ...mount, ...modelEnv, '-e', `CABINET_LIBRARY=${library}`, image, ...args];
  if (input === undefined) return docker(argv);
  await new Promise((resolve, reject) => {
    const p = spawn('docker', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    p.stdout.on('data', (d) => { output += d; });
    p.stderr.on('data', (d) => { output += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`CLI exited ${code}: ${output}`)));
    p.stdin.end(input);
  });
}
async function until(fn, timeout = 30_000) {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for container');
    await new Promise((r) => setTimeout(r, 250));
  }
}
async function start() {
  await docker(['run', '-d', '--rm', '--name', name, ...mount, ...modelEnv, '-e', `CABINET_LIBRARY=${library}`, '-p', '127.0.0.1::4747', image, 'start', '--host', '0.0.0.0', '--no-ai', '--no-telegram']);
  running = true;
  base = 'http://' + await docker(['port', name, '4747/tcp']);
  await until(async () => {
    try { return (await fetch(base + '/api/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  });
  cookie = '';
}
async function stop() {
  if (running) {
    await docker(['stop', '--time', '30', name]);
    running = false;
  }
}
async function login() {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: password }) });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
}
async function request(path, options = {}, status = 200) {
  const res = await fetch(base + path, { ...options, headers: { cookie, ...options.headers } });
  assert.equal(res.status, status, `${path}: ${res.status}`);
  return res;
}
async function json(path, body, method = 'POST', status = 200) {
  return (await request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, status)).json();
}
async function upload(filename, mime, bytes) {
  const body = new FormData();
  body.set('file', new Blob([bytes], { type: mime }), filename);
  return (await request('/api/capture', { method: 'POST', body }, 201)).json();
}
async function idle() {
  await until(async () => (await (await request('/api/settings')).json()).jobs.pending === 0, 120_000);
}
async function mcp(method, params, token, id) {
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  assert.equal(res.status, 200);
  const text = await res.text();
  return JSON.parse(res.headers.get('content-type')?.includes('text/event-stream') ? text.split('\n').find((line) => line.startsWith('data:')).slice(5) : text);
}

try {
  await cli(['init']);
  await cli(['passphrase', '--stdin'], password + '\n');
  await start();
  await request('/api/items', {}, 401);
  await login();
  assert.equal((await (await request('/api/items')).json()).total, 0);
  const html = await (await request('/')).text();
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  await request(asset);
  console.log('PASS: empty external library, authenticated browser API and built web assets');
  await stop();

  library = '/data/Demo';
  await cli(['init', '--sample']);
  await cli(['passphrase', '--stdin'], password + '\n');
  await start();
  await login();
  const sample = await (await request('/api/items')).json();
  assert.ok(sample.total > 20);
  const captured = await json('/api/capture', { kind: 'note', text: 'Docker packaging persistence note [[reading-corner]]' }, 'POST', 201);
  assert.ok((await (await request('/api/search?q=Docker&mode=keyword')).json()).hits.some((h) => h.item.id === captured.item.id));
  const imageItem = await upload('photo.png', 'image/png', readFileSync(join(root, 'sample-library/attachments/2026/06/01hy-paper-lamp.png')));
  assert.equal(imageItem.item.type, 'image');
  await request('/files/' + imageItem.item.frontmatter.attachment);
  await request('/thumbs?src=' + encodeURIComponent(imageItem.item.frontmatter.attachment) + '&w=240');
  const pdf = await upload('primer.pdf', 'application/pdf', readFileSync(join(root, 'sample-library/attachments/2026/07/01j2-room-acoustics-primer.pdf')));
  await idle();
  assert.equal((await (await request('/api/items/' + pdf.item.id)).json()).item.frontmatter.extraction, 'ok');
  console.log('PASS: sample library, note capture/search, attachments, native image thumbnail and PDF extraction');

  const agent = await json('/api/settings/tokens', { name: 'docker-smoke' });
  const init = await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cabinet-smoke', version: '1' } }, agent.token, 1);
  assert.ok(init.result.serverInfo);
  const tools = await mcp('tools/list', {}, agent.token, 2);
  assert.ok(tools.result.tools.some((t) => t.name === 'get_context'));
  const search = await mcp('tools/call', { name: 'search', arguments: { query: 'reading' } }, agent.token, 3);
  assert.ok(!search.result.isError);
  console.log('PASS: authenticated MCP initialization, tools and library search');

  const settings = await (await request('/api/settings')).json();
  if (hasModel) {
    assert.equal(settings.transcription.ok, true, settings.transcription.reason);
    const voice = await upload('voice-note.ogg', 'audio/ogg', readFileSync(join(root, 'e2e/fixtures/voice-note.ogg')));
    await idle();
    const item = (await (await request('/api/items/' + voice.item.id)).json()).item;
    assert.equal(item.frontmatter.extraction, 'ok');
    assert.match(item.body, /measure the reading corner/i);
    console.log('PASS: real container OGG → ffmpeg → whisper.cpp → indexed transcript');
  } else {
    console.log('SKIP: real transcription (set CABINET_WHISPER_MODEL to an existing model file)');
  }

  await stop();
  await start();
  await login();
  await request('/api/items/' + captured.item.id);
  const exported = await (await request('/api/export')).arrayBuffer();
  await request('/api/items/' + captured.item.id, { method: 'DELETE' });
  await request('/api/items/' + captured.item.id, {}, 404);
  const form = new FormData();
  form.set('file', new Blob([exported], { type: 'application/zip' }), 'library.zip');
  const restored = await (await request('/api/restore', { method: 'POST', body: form })).json();
  assert.ok(restored.backup.startsWith('/data/Demo.backup-'));
  assert.ok(existsSync(join(data, basename(restored.backup))));
  await request('/api/items/' + captured.item.id);
  console.log('PASS: restart persistence, ZIP export/restore, sibling backup and retained login');
  console.log('Docker smoke complete. Disposable containers/data will be removed.');
} catch (error) {
  if (running) console.error(await docker(['logs', '--tail', '30', name]).catch(() => 'Container logs unavailable'));
  throw error;
} finally {
  try { await stop(); } finally { rmSync(temp, { recursive: true, force: true }); }
}
