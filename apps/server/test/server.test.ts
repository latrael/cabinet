import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseProject } from '@cabinet/core';
import { startServer, type RunningServer } from '../src/server.ts';
import { startFixtureServer } from '../../../e2e/fixtures/server.ts';
import { tempSample, waitFor } from '../../../packages/core/test/helpers.ts';

let srv: RunningServer;
let fx: Awaited<ReturnType<typeof startFixtureServer>>;
let cleanup: () => void;

const api = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(srv.url + path, { ...init, headers, body });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.arrayBuffer(), headers: res.headers };
};

beforeAll(async () => {
  const t = tempSample();
  cleanup = t.cleanup;
  fx = await startFixtureServer();
  srv = await startServer({ library: t.dir, port: 0, quiet: true, webDist: null, git: true, gitDebounceMs: 50 });
});

afterAll(async () => {
  await srv?.close();
  await fx?.close();
  cleanup?.();
});

describe('items API', () => {
  test('list and detail with backlinks and projects', async () => {
    const list = await api('/api/items?type=project');
    expect(list.data.total).toBe(3);
    const d = await api('/api/items/japanese-listening-rooms?open=1');
    expect(d.status).toBe(200);
    expect(d.data.item.title).toBe('Japanese listening rooms');
    expect(d.data.backlinks.length).toBeGreaterThanOrEqual(3);
    expect(d.data.projects.map((p: any) => p.project.title).sort()).toEqual(['Listening rooms essay', 'Reading corner']);
  });

  test('stale saves get a 409 with the current version', async () => {
    const d = (await api('/api/items/vinyl-care')).data;
    const ok = await api(`/api/items/${d.item.id}`, { method: 'PUT', json: { body: 'v2\n', baseHash: d.item.hash } });
    expect(ok.status).toBe(200);
    const stale = await api(`/api/items/${d.item.id}`, { method: 'PUT', json: { body: 'mine\n', baseHash: d.item.hash } });
    expect(stale.status).toBe(409);
    expect(stale.data.current.body).toBe('v2\n');
    // keep mine → save copy
    const copy = await api(`/api/items/${d.item.id}/copy`, { method: 'POST', json: { body: 'mine\n' } });
    expect(copy.status).toBe(201);
    expect(copy.data.item.title).toBe('Vinyl care (my copy)');
  });

  test('autocomplete and resolve', async () => {
    const s = await api('/api/suggest?q=warm');
    expect(s.data.items.map((i: any) => i.slug)).toContain('warm-light');
    const r = await api('/api/resolve?ref=' + encodeURIComponent('Reading corner'));
    expect(r.data.item.slug).toBe('reading-corner');
  });

  test('search reports where each hit matched', async () => {
    const r = await api('/api/search?q=flutter+echo&mode=keyword');
    expect(r.data.hits[0]).toMatchObject({ field: 'pdf' });
    expect(r.data.hits[0].item.slug).toBe('room-acoustics-primer');
  });

  test('home payload', async () => {
    const h = await api('/api/home');
    expect(h.data.interests.projects.length).toBe(2);
    expect(h.data.counts.inbox).toBeGreaterThanOrEqual(2);
    expect(h.data.revisit.length).toBeGreaterThan(0);
  });
});

describe('capture pipeline', () => {
  test('article: saved instantly, filled in by the background job', async () => {
    const t = performance.now();
    const r = await api('/api/capture', {
      method: 'POST',
      json: { url: fx.url + '/article?utm_source=x', why: 'For the [[reading-corner]]', tags: ['Lighting'] },
    });
    const ms = performance.now() - t;
    expect(r.status).toBe(201);
    expect(ms).toBeLessThan(1500);
    expect(r.data.item.frontmatter.extraction).toBe('pending');
    expect(r.data.item.frontmatter.source.url).toBe(fx.url + '/article');
    await srv.ctx.jobs.idle();
    const d = (await api(`/api/items/${r.data.item.id}`)).data;
    expect(d.item.type).toBe('article');
    expect(d.item.title).toBe('Lamps that glow, not shine');
    expect(d.item.frontmatter.extraction).toBe('ok');
    expect(d.item.frontmatter.source.site).toBe('Fixture Journal');
    expect(d.item.body).toContain('## Content');
    expect(d.item.body).toMatch(/\[our note on kelvin\]\(http:\/\/127\.0\.0\.1:\d+\/notes\/kelvin\)/);
    expect(d.item.why).toBe('For the [[reading-corner]]');
    expect(d.outgoing.some((o: any) => o.item?.slug === 'reading-corner')).toBe(true);
    // remote cover cached locally
    const thumb = await api('/thumbs?src=' + encodeURIComponent(d.item.frontmatter.cover));
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    // duplicate detection
    const dup = await api('/api/capture', { method: 'POST', json: { url: fx.url + '/article' } });
    expect(dup.data.duplicate).toBe(true);
    expect(dup.data.item.id).toBe(r.data.item.id);
  });

  test('preview gives OpenGraph metadata fast', async () => {
    const p = await api('/api/capture/preview', { method: 'POST', json: { url: fx.url + '/bulb' } });
    expect(p.data.preview.title).toBe('Warm filament bulb, 2200 K');
    expect(p.data.preview.description).toContain('E27');
  });

  test('thin page becomes a link with its description', async () => {
    const r = await api('/api/capture', { method: 'POST', json: { url: fx.url + '/bulb' } });
    await srv.ctx.jobs.idle();
    const d = (await api(`/api/items/${r.data.item.id}`)).data;
    expect(d.item.type).toBe('link');
    expect(d.item.body).toContain('E27 filament bulb');
  });

  test('failed extraction keeps the link and accepts manual content', async () => {
    const r = await api('/api/capture', { method: 'POST', json: { url: fx.url + '/broken' } });
    await srv.ctx.jobs.idle();
    const d = (await api(`/api/items/${r.data.item.id}`)).data;
    expect(d.item.frontmatter.extraction).toBe('failed');
    const m = await api(`/api/items/${r.data.item.id}/content`, { method: 'POST', json: { content: 'Pasted by hand about quillwork.' } });
    expect(m.data.item.frontmatter.extraction).toBe('manual');
    expect((await api('/api/search?q=quillwork&mode=keyword')).data.hits[0].item.id).toBe(r.data.item.id);
  });

  test('remote PDF is stored as an attachment and its text indexed', async () => {
    const r = await api('/api/capture', { method: 'POST', json: { url: fx.url + '/primer.pdf' } });
    await srv.ctx.jobs.idle();
    const d = (await api(`/api/items/${r.data.item.id}`)).data;
    expect(d.item.type).toBe('pdf');
    expect(d.item.frontmatter.attachment).toMatch(/^attachments\/\d{4}\/\d{2}\/.+-primer\.pdf$/);
    expect(d.item.title).toBe('A primer on small-room acoustics');
    expect(d.item.body).toContain('Flutter echo');
    const file = await api('/files/' + d.item.frontmatter.attachment);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    const thumb = await api('/thumbs?src=' + encodeURIComponent(d.item.frontmatter.attachment));
    expect(thumb.status).toBe(200);
  });

  test('video bookmark with a timestamp', async () => {
    const r = await api('/api/capture', { method: 'POST', json: { url: 'https://youtu.be/Zz9Yy8Xx7Ww?t=252', why: 'groove spacing' } });
    expect(r.data.item.type).toBe('video');
    expect(r.data.item.body).toContain('- [04:12](https://youtu.be/Zz9Yy8Xx7Ww?t=252)');
    await srv.ctx.jobs.idle();
  });

  test('quote and text', async () => {
    const q = await api('/api/capture', { method: 'POST', json: { text: 'The details are not the details. They make the design.', kind: 'quote', author: 'Charles Eames' } });
    expect(q.data.item.type).toBe('quote');
    expect(q.data.item.body).toBe('> The details are not the details. They make the design.\n');
    expect(q.data.item.frontmatter.source.author).toBe('Charles Eames');
    const t = await api('/api/capture', { method: 'POST', json: { text: 'Remember to ask about the obi pressings' } });
    expect(t.data.item.type).toBe('text');
    expect(t.data.item.status).toBe('inbox');
  });

  test('image upload, file serving and thumbnails', async () => {
    const png = readFileSync(join(srv.ctx.lib.root, 'attachments/2026/06/01hy-paper-lamp.png'));
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), 'My Lamp.PNG');
    fd.append('tags', 'lighting,photos');
    const r = await api('/api/capture', { method: 'POST', body: fd });
    expect(r.status).toBe(201);
    expect(r.data.item.type).toBe('image');
    expect(r.data.item.tags).toEqual(['lighting', 'photos']);
    const att = r.data.item.frontmatter.attachment;
    expect(att).toMatch(/-my-lamp\.png$/);
    expect((await api('/files/' + att)).status).toBe(200);
    expect((await api('/files/../.cabinet/secrets.json')).status).toBe(404);
    expect((await api('/thumbs?src=' + encodeURIComponent(att) + '&w=200')).status).toBe(200);
  });

  test('capturing straight into a project skips the inbox and records per-project context', async () => {
    const p = (await api('/api/items/reading-corner')).data.item;
    const r = await api('/api/capture', {
      method: 'POST',
      json: { url: fx.url + '/article-2', projectId: p.id, section: 'Lighting', context: 'the lamp height idea' },
    });
    expect(r.data.item.status).toBe('library');
    await srv.ctx.jobs.idle();
    const model = parseProject((await api('/api/items/reading-corner')).data.item.body);
    const lighting = model.material.find((s) => s.name === 'Lighting')!;
    const last = lighting.lines.at(-1) as any;
    expect(last.context).toBe('the lamp height idea');
    // the background fetch may already have renamed the file; the link follows it
    expect((await api('/api/resolve?ref=' + encodeURIComponent(last.target))).data.id).toBe(r.data.item.id);
    await srv.ctx.jobs.idle();
    // the item still lives once, in sources/
    expect(r.data.item.path.startsWith('sources/')).toBe(true);
  });
});

describe('live updates', () => {
  test('SSE pushes external edits', async () => {
    const ac = new AbortController();
    const res = await fetch(srv.url + '/api/events', { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const p = join(srv.ctx.lib.root, 'notes/warm-light.md');
    setTimeout(() => writeFileSync(p, readFileSync(p, 'utf8') + '\nEdited outside.\n'), 300);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !/"origin":"disk"/.test(buf)) {
      const { value } = await reader.read();
      buf += dec.decode(value);
    }
    ac.abort();
    expect(buf).toMatch(/event: library/);
    expect(buf).toMatch(/"kind":"updated".*"origin":"disk"/);
  });
});

describe('auth', () => {
  test('cross-origin writes are blocked (CSRF)', async () => {
    const r = await api('/api/capture', { method: 'POST', json: { text: 'evil' }, headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
  });

  test('non-localhost Host needs a session or token (DNS rebinding safe)', async () => {
    // node fetch lets us override Host via a raw request
    const { request } = await import('node:http');
    const get = (headers: Record<string, string>) =>
      new Promise<{ status: number; body: string; setCookie?: string[] }>((resolve) => {
        const req = request(srv.url + '/api/items?limit=1', { headers }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode!, body, setCookie: res.headers['set-cookie'] }));
        });
        req.end();
      });
    expect((await get({ host: 'cabinet.lan:4747' })).status).toBe(401);
    // token
    const tok = (await api('/api/settings/tokens', { method: 'POST', json: { name: 'Test Agent' } })).data;
    expect(tok.token).toMatch(/^cab_/);
    expect((await get({ host: 'cabinet.lan:4747', authorization: `Bearer ${tok.token}` })).status).toBe(200);
    expect((await get({ host: 'cabinet.lan:4747', authorization: 'Bearer cab_wrong' })).status).toBe(401);
    // passphrase session
    await api('/api/settings/passphrase', { method: 'POST', json: { passphrase: 'correct horse battery' } });
    const login = await new Promise<{ status: number; cookie?: string }>((resolve) => {
      const req = request(srv.url + '/api/auth/login', { method: 'POST', headers: { host: 'cabinet.lan:4747', 'content-type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
      });
      req.end(JSON.stringify({ passphrase: 'correct horse battery' }));
    });
    expect(login.status).toBe(200);
    expect((await get({ host: 'cabinet.lan:4747', cookie: login.cookie! })).status).toBe(200);
    await api('/api/settings/passphrase', { method: 'POST', json: { passphrase: null } });
  });

  test('agent writes are attributed in git', async () => {
    const tok = (await api('/api/settings/tokens', { method: 'POST', json: { name: 'scout' } })).data;
    const r = await api('/api/capture', { method: 'POST', json: { text: 'Agent was here' }, headers: { authorization: `Bearer ${tok.token}` } });
    expect(r.status).toBe(201);
    await srv.ctx.lib.git!.flush();
    const log = await srv.ctx.lib.git!.log(50);
    expect(log.some((c) => c.author === 'agent:scout' && c.message.includes('Agent was here'))).toBe(true);
  });
});

describe('export / restore over HTTP', () => {
  test('round trip', async () => {
    const created = await api('/api/items', { method: 'POST', json: { type: 'note', title: 'Before export', body: 'keep me' } });
    const zip = await api('/api/export');
    expect(zip.headers.get('content-type')).toBe('application/zip');
    await api(`/api/items/${created.data.item.id}`, { method: 'DELETE' });
    expect((await api('/api/items/before-export')).status).toBe(404);
    const fd = new FormData();
    fd.append('file', new Blob([zip.data as ArrayBuffer]), 'export.zip');
    const r = await api('/api/restore', { method: 'POST', body: fd });
    expect(r.status).toBe(200);
    expect(r.data.backup).toBeTruthy();
    expect((await api('/api/items/before-export')).data.item.body).toBe('keep me\n');
    // still live after reopen
    await waitFor(async () => true);
    expect((await api('/api/items?type=project')).data.total).toBe(3);
  });
});
