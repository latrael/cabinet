import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseProject } from '@cabinet/core';
import { mountHttp } from '@cabinet/mcp';
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
  srv = await startServer({ library: t.dir, port: 0, quiet: true, webDist: null, git: true, gitDebounceMs: 50, plugins: [(ctx) => mountHttp(ctx)] });
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

describe('memory proposals API', () => {
  const mcpRemember = async (token: string, args: Record<string, unknown>, extraHeaders: Record<string, string> = {}) => {
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extraHeaders,
    };
    const res = await fetch(srv.url + '/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'remember', arguments: args },
      }),
    });
    const rpc = (await res.json()) as any;
    return { status: res.status, rpc, data: JSON.parse(rpc.result.content[0].text) };
  };

  test('POST /api/items as local is direct; via bearer token creates a proposal', async () => {
    const direct = await api('/api/items', { method: 'POST', json: { type: 'memory', title: 'Direct human memory', body: 'Written directly.\n' } });
    expect(direct.status).toBe(201);
    expect(direct.data.item.status).toBe('library');
    expect(direct.data.item.frontmatter.memory).toBeUndefined();
    expect((await api(`/api/memory/proposals/${direct.data.item.id}`)).status).toBe(404);

    const tok = (await api('/api/settings/tokens', { method: 'POST', json: { name: 'http-poster' } })).data;
    const agentCreate = await api('/api/items', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.token}` },
      json: {
        type: 'memory',
        title: 'Agent posted memory',
        body: 'Should become a proposal.',
        status: 'library',
        frontmatter: { memory: { lifecycle: 'active' } },
      },
    });
    expect(agentCreate.status).toBe(201);
    expect(agentCreate.data.item.status).toBe('inbox');
    expect(agentCreate.data.item.frontmatter.memory.lifecycle).toBe('proposed');
    expect(agentCreate.data.item.frontmatter.memory.proposed_by).toBe('agent:http-poster');

    // Clean up so counts stay clean for later tests if needed
    await api(`/api/memory/proposals/${agentCreate.data.item.id}/reject`, { method: 'POST', json: { reason: 'cleanup' } });
  });

  test('/mcp with X-Cabinet-Thread / X-Cabinet-Project headers, explicit wins, unknown header project ignored', async () => {
    const tok = (await api('/api/settings/tokens', { method: 'POST', json: { name: 'harness-agent' } })).data;
    const corner = (await api('/api/items/reading-corner')).data.item;
    const sourdough = (await api('/api/items/sourdough')).data.item;

    // Header defaults applied
    const r1 = await mcpRemember(
      tok.token,
      { fact: 'Header defaults fact.' },
      { 'X-Cabinet-Thread': 'hdr-thread-1', 'X-Cabinet-Project': 'reading-corner' },
    );
    expect(r1.data).toMatchObject({ outcome: 'proposed', remembered: false, status: 'proposed' });
    const p1 = (await api(`/api/memory/proposals/${r1.data.id}`)).data.proposal;
    expect(p1.thread_id).toBe('hdr-thread-1');
    expect(p1.project_ids).toEqual([corner.id]);

    // Explicit params override headers
    const r2 = await mcpRemember(
      tok.token,
      { fact: 'Explicit overrides headers.', thread_id: 'explicit-t2', project: 'sourdough' },
      { 'X-Cabinet-Thread': 'hdr-thread-1', 'X-Cabinet-Project': 'reading-corner' },
    );
    const p2 = (await api(`/api/memory/proposals/${r2.data.id}`)).data.proposal;
    expect(p2.thread_id).toBe('explicit-t2');
    expect(p2.project_ids).toEqual([sourdough.id]);

    // Unknown header project is ignored silently
    const r3 = await mcpRemember(
      tok.token,
      { fact: 'Unknown default project ignored.' },
      { 'X-Cabinet-Thread': 'hdr-thread-3', 'X-Cabinet-Project': 'no-such-project' },
    );
    expect(r3.data.outcome).toBe('proposed');
    const p3 = (await api(`/api/memory/proposals/${r3.data.id}`)).data.proposal;
    expect(p3.thread_id).toBe('hdr-thread-3');
    expect(p3.project_ids).toEqual([]);

    // Reject all three to leave proposed queue clean
    await api(`/api/memory/proposals/${p1.id}/reject`, { method: 'POST', json: {} });
    await api(`/api/memory/proposals/${p2.id}/reject`, { method: 'POST', json: {} });
    await api(`/api/memory/proposals/${p3.id}/reject`, { method: 'POST', json: {} });
  });

  test('list, counts, get, approve with edit, reject, conflicts, already_decided, and auth boundaries', async () => {
    const plainTok = (await api('/api/settings/tokens', { method: 'POST', json: { name: 'plain-agent' } })).data;
    const reviewTok = (await api('/api/settings/tokens', { method: 'POST', json: { name: 'harness-reviewer', scopes: ['review'] } })).data;

    // Review token cannot be used on /mcp
    const mcpWithReview = await fetch(srv.url + '/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${reviewTok.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{}',
    });
    expect(mcpWithReview.status).toBe(401);
    expect((await mcpWithReview.json()).error.message).toBe('Review tokens cannot be used for MCP; create a separate agent token.');

    // Create two proposals via MCP and commit them cleanly under the agent author
    const m1 = await mcpRemember(plainTok.token, { fact: 'Armchair is 95 cm tall.', thread_id: 't-list', project: 'reading-corner' });
    const m2 = await mcpRemember(plainTok.token, { fact: 'Starter is 100% hydration.', thread_id: 't-list-2', project: 'sourdough' });
    await srv.ctx.lib.git!.flush();
    const corner = (await api('/api/items/reading-corner')).data.item;

    // List and filters (tokens can read)
    const listAll = await api('/api/memory/proposals?status=proposed', { headers: { authorization: `Bearer ${plainTok.token}` } });
    expect(listAll.status).toBe(200);
    expect(listAll.data.total).toBe(2);

    const byProject = await api('/api/memory/proposals?project=reading-corner');
    expect(byProject.data.proposals.map((p: any) => p.id)).toEqual([m1.data.id]);

    const unknownProject = await api('/api/memory/proposals?project=does-not-exist');
    expect(unknownProject.status).toBe(200);
    expect(unknownProject.data).toEqual({ proposals: [], total: 0 });

    const byThread = await api('/api/memory/proposals?thread=t-list');
    expect(byThread.data.proposals.map((p: any) => p.id)).toEqual([m1.data.id]);

    const byAgent = await api('/api/memory/proposals?agent=plain-agent');
    expect(byAgent.data.total).toBe(2);

    expect((await api('/api/memory/proposals?status=bogus')).status).toBe(400);
    expect((await api('/api/memory/proposals/does-not-exist')).status).toBe(404);

    // Counts
    const counts = await api('/api/memory/proposals/counts');
    expect(counts.status).toBe(200);
    expect(counts.data.total).toBe(2);
    expect(counts.data.byProject[corner.id]).toBe(1);
    expect(counts.data.byThread['t-list']).toBe(1);

    // Plain bearer token gets 403 on approve/reject
    const forbiddenApprove = await api(`/api/memory/proposals/${m1.data.id}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${plainTok.token}` },
      json: {},
    });
    expect(forbiddenApprove.status).toBe(403);
    expect(forbiddenApprove.data.error).toBe('forbidden');

    const forbiddenReject = await api(`/api/memory/proposals/${m1.data.id}/reject`, {
      method: 'POST',
      headers: { authorization: `Bearer ${plainTok.token}` },
      json: {},
    });
    expect(forbiddenReject.status).toBe(403);

    // Agent PUT touching memory or status is 403
    const putMemory = await api(`/api/items/${m1.data.id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${plainTok.token}` },
      json: { frontmatter: { memory: { lifecycle: 'active' } } },
    });
    expect(putMemory.status).toBe(403);
    const putStatus = await api(`/api/items/${m1.data.id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${plainTok.token}` },
      json: { frontmatter: { status: 'library' } },
    });
    expect(putStatus.status).toBe(403);

    // Empty text on approve -> 400
    expect((await api(`/api/memory/proposals/${m1.data.id}/approve`, { method: 'POST', json: { text: '   ' } })).status).toBe(400);

    // Stale baseHash -> 409 conflict with current Item
    const stale = await api(`/api/memory/proposals/${m1.data.id}/approve`, {
      method: 'POST',
      json: { baseHash: '0'.repeat(40) },
    });
    expect(stale.status).toBe(409);
    expect(stale.data.error).toBe('conflict');
    expect(stale.data.current.id).toBe(m1.data.id);

    // Review token approves with edit; decided_by is 'you' and git note contains (via <name>)
    const prop1 = (await api(`/api/memory/proposals/${m1.data.id}`)).data.proposal;
    const approved = await api(`/api/memory/proposals/${m1.data.id}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reviewTok.token}` },
      json: { text: 'Armchair in reading corner is 95 cm tall.', baseHash: prop1.hash },
    });
    expect(approved.status).toBe(200);
    expect(approved.data.proposal).toMatchObject({
      status: 'approved',
      text: 'Armchair in reading corner is 95 cm tall.',
      original_text: 'Armchair is 95 cm tall.',
      decided_by: 'you',
    });

    // Second approve -> 409 already_decided with current Proposal
    const already = await api(`/api/memory/proposals/${m1.data.id}/approve`, { method: 'POST', json: {} });
    expect(already.status).toBe(409);
    expect(already.data.error).toBe('already_decided');
    expect(already.data.current.status).toBe('approved');

    await srv.ctx.lib.git!.flush();

    await srv.ctx.lib.git!.flush();

    // Review token rejects m2
    const rejected = await api(`/api/memory/proposals/${m2.data.id}/reject`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reviewTok.token}` },
      json: { reason: 'Not needed' },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.data.proposal).toMatchObject({
      status: 'rejected',
      reject_reason: 'Not needed',
      decided_by: 'you',
    });

    await srv.ctx.lib.git!.flush();
    const log = await srv.ctx.lib.git!.log(50);
    expect(log.some((c) => c.author === 'you' && c.message.includes('approve memory') && c.message.includes('(via harness-reviewer)'))).toBe(true);
    expect(log.some((c) => c.author === 'you' && c.message.includes('reject memory') && c.message.includes('(via harness-reviewer)'))).toBe(true);
  });

  test('SSE streams library events with kind=memory in order', async () => {
    const tok = (await api('/api/settings/tokens', { method: 'POST', json: { name: 'sse-agent' } })).data;
    const ac = new AbortController();
    const res = await fetch(srv.url + '/api/events', { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';

    // Wait for initial hello event so stream subscription is active
    while (!buf.includes('event: hello')) {
      const { value } = await reader.read();
      buf += dec.decode(value);
    }

    const created = await mcpRemember(tok.token, { fact: 'SSE memory test fact.', thread_id: 'sse-t1' });
    await api(`/api/memory/proposals/${created.data.id}/approve`, { method: 'POST', json: {} });

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !/"action":"approved"/.test(buf)) {
      const { value } = await reader.read();
      buf += dec.decode(value);
    }
    ac.abort();

    const memoryEvents = buf
      .split('\n\n')
      .filter((chunk) => chunk.includes('event: library'))
      .map((chunk) => {
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        return line ? JSON.parse(line.slice(6)) : null;
      })
      .filter((e) => e && e.kind === 'memory' && e.id === created.data.id);

    expect(memoryEvents.map((e) => e.data.action)).toEqual(['proposed', 'approved']);
    expect(memoryEvents[0].data).toMatchObject({ status: 'proposed', project_ids: [], thread_id: 'sse-t1' });
    expect(memoryEvents[1].data).toMatchObject({ status: 'approved', project_ids: [], thread_id: 'sse-t1' });
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
