import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { simpleGit } from 'simple-git';
import { Library, approveProposal } from '@cabinet/core';
import { createCabinetMcpServer, type McpDeps } from '../src/server.ts';
import { tempSample } from '../../core/test/helpers.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
let cleanups: Array<() => unknown> = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const parse = (r: any) => {
  const t = r.content?.[0]?.text ?? '';
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

async function memoryClient(defaults?: McpDeps['defaults']) {
  const t = tempSample();
  const lib = await Library.open(t.dir, { git: false });
  const server = createCabinetMcpServer({ lib: () => lib, agent: 'tester', defaults });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  cleanups.push(t.cleanup, () => lib.close(), () => client.close());
  return { client, lib };
}

describe('MCP tools (in-memory client)', () => {
  test('lists the full tool set and the item resource template', async () => {
    const { client } = await memoryClient();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      ['add_to_project', 'capture', 'create_note', 'get_backlinks', 'get_context', 'get_graph', 'get_item', 'link_items', 'list_projects', 'list_recent', 'recall', 'remember', 'search', 'update_note'].sort(),
    );
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate);
    expect(templates).toContain('cabinet://item/{id}');
    expect(client.getInstructions()).toMatch(/personal library/);
  });

  test('read tools: search, get_item, get_context, backlinks, graph, projects, recent', async () => {
    const { client } = await memoryClient();
    const s = parse(await client.callTool({ name: 'search', arguments: { query: 'flutter echo' } }));
    expect(s.hits[0]).toMatchObject({ slug: 'room-acoustics-primer', matched: 'pdf' });
    const item = parse(await client.callTool({ name: 'get_item', arguments: { ref: '[[reading-corner]]' } }));
    expect(item.frontmatter.title).toBe('Reading corner');
    expect(item.hash).toMatch(/^[0-9a-f]{40}$/);
    const ctx = parse(await client.callTool({ name: 'get_context', arguments: { topic: 'warm light for reading' } }));
    expect(ctx).toMatch(/^# Context: warm light for reading/);
    expect(ctx).toMatch(/## What I know \(memories\)/);
    expect(ctx).toMatch(/Prefers|2700/);
    expect(ctx).toMatch(/### Reading corner/);
    expect(ctx).toMatch(/Open questions: How much sound dampening/);
    const bl = parse(await client.callTool({ name: 'get_backlinks', arguments: { ref: 'japanese-listening-rooms' } }));
    expect(bl.some((b: any) => b.slug === 'reading-corner' && b.kind === 'material' && b.context)).toBe(true);
    const g = parse(await client.callTool({ name: 'get_graph', arguments: { ref: 'reading-corner', depth: 1 } }));
    expect(g.nodes.length).toBeGreaterThan(4);
    const projects = parse(await client.callTool({ name: 'list_projects', arguments: {} }));
    expect(projects.find((p: any) => p.slug === 'reading-corner').sections).toEqual(['Inspiration', 'Lighting', 'Acoustics', 'To buy']);
    const recent = parse(await client.callTool({ name: 'list_recent', arguments: { limit: 3 } }));
    expect(recent).toHaveLength(3);
  });

  test('write tools: remember proposes, recall/get_context exclude until approved, create_note, update_note, link, add_to_project, capture', async () => {
    const { client, lib } = await memoryClient();
    const corner = lib.find('reading-corner')!;
    const mem = parse(
      await client.callTool({
        name: 'remember',
        arguments: {
          fact: 'The owner is building a horn speaker for the [[reading-corner]].',
          tags: ['audio'],
          thread_id: 'thread-42',
          project: 'reading-corner',
          sources: [{ item: 'japanese-listening-rooms', quote: 'Horn speakers fill the room' }],
        },
      }),
    );
    expect(mem).toMatchObject({ outcome: 'proposed', remembered: false, status: 'proposed' });
    expect(mem.path).toMatch(/^memories\//);

    const memItem = lib.read(mem.id);
    expect(memItem.status).toBe('inbox');
    expect(memItem.frontmatter.agent).toBe('tester');
    expect(memItem.frontmatter.captured_via).toBe('mcp:tester');
    expect(memItem.frontmatter.memory).toMatchObject({
      schema_version: 1,
      lifecycle: 'proposed',
      proposed_by: 'agent:tester',
      thread_id: 'thread-42',
      project_ids: [corner.id],
    });
    expect(memItem.frontmatter.memory?.sources?.[0]?.item_id).toBe(lib.find('japanese-listening-rooms')!.id);

    // Proposed memory is excluded from recall and get_context
    const recallBefore = parse(await client.callTool({ name: 'recall', arguments: { query: 'horn speaker' } }));
    expect(recallBefore).toMatchObject({ memories: [] });
    const ctxBefore = parse(await client.callTool({ name: 'get_context', arguments: { topic: 'horn speaker' } }));
    expect(ctxBefore).not.toContain('The owner is building a horn speaker');

    // Once approved, recall and get_context include it
    approveProposal(lib, mem.id, {}, 'you');
    const recallAfter = parse(await client.callTool({ name: 'recall', arguments: { query: 'horn speaker' } }));
    expect(recallAfter[0].fact).toMatch(/horn speaker/);
    const ctxAfter = parse(await client.callTool({ name: 'get_context', arguments: { topic: 'horn speaker' } }));
    expect(ctxAfter).toContain('The owner is building a horn speaker');

    const note = parse(await client.callTool({ name: 'create_note', arguments: { title: 'Horn plan', body: 'See [[room-acoustics-primer]] and [[nothing-yet]].' } }));
    expect(note.unresolved_links).toEqual(['nothing-yet']);
    const refused = await client.callTool({ name: 'update_note', arguments: { ref: note.slug, body: 'x' } });
    expect(refused.isError).toBe(true);
    const ok = parse(await client.callTool({ name: 'update_note', arguments: { ref: note.slug, body: 'Version 2', base_hash: note.hash } }));
    const stale = await client.callTool({ name: 'update_note', arguments: { ref: note.slug, body: 'Version 3', base_hash: note.hash } });
    expect(stale.isError).toBe(true);
    expect(parse(stale)).toMatch(/Conflict/);
    expect(lib.read(note.id).body).toBe('Version 2\n');
    await client.callTool({ name: 'update_note', arguments: { ref: note.slug, append: 'Added later.', base_hash: ok.hash } });
    expect(lib.read(note.id).body).toBe('Version 2\n\nAdded later.\n');

    await client.callTool({ name: 'link_items', arguments: { from: note.slug, to: 'Warm light', note: 'lighting too' } });
    expect(lib.read(note.id).body).toContain('- [[warm-light]]: lighting too');
    await client.callTool({ name: 'add_to_project', arguments: { project: 'Reading corner', item: note.slug, section: 'Acoustics', context: 'agent research' } });
    expect(lib.find('reading-corner')!.body).toContain(`- [[${note.slug}]]: agent research`);

    const cap = parse(await client.callTool({ name: 'capture', arguments: { text: 'A good room sounds smaller than it is.', kind: 'quote' } }));
    expect(cap.slug).toBeTruthy();
    const res = await client.readResource({ uri: `cabinet://item/${note.id}` });
    expect((res.contents[0] as any).text).toContain('title: Horn plan');
    const missing = await client.callTool({ name: 'get_item', arguments: { ref: 'does-not-exist' } });
    expect(missing.isError).toBe(true);
  });

  test('remember uses session defaults when omitted, explicit wins, bad explicit project errors, bad default project ignored', async () => {
    const { client, lib } = await memoryClient({ threadId: 'default-thread', project: 'reading-corner' });
    const corner = lib.find('reading-corner')!;
    const sourdough = lib.find('sourdough')!;

    const m1 = parse(await client.callTool({ name: 'remember', arguments: { fact: 'Uses default thread and project.' } }));
    expect(lib.read(m1.id).frontmatter.memory).toMatchObject({ thread_id: 'default-thread', project_ids: [corner.id] });

    const m2 = parse(await client.callTool({ name: 'remember', arguments: { fact: 'Explicit overrides defaults.', thread_id: 'explicit-thread', project: 'sourdough' } }));
    expect(lib.read(m2.id).frontmatter.memory).toMatchObject({ thread_id: 'explicit-thread', project_ids: [sourdough.id] });

    const badExplicit = await client.callTool({ name: 'remember', arguments: { fact: 'Bad explicit project.', project: 'nonexistent-project' } });
    expect(badExplicit.isError).toBe(true);

    const { client: clientBadDefault, lib: lib2 } = await memoryClient({ threadId: 't-bad', project: 'nonexistent-project' });
    const m3 = parse(await clientBadDefault.callTool({ name: 'remember', arguments: { fact: 'Ignores unresolvable default project.' } }));
    expect(m3.outcome).toBe('proposed');
    expect(lib2.read(m3.id).frontmatter.memory?.project_ids).toBeUndefined();
  });
});

describe('real MCP clients', () => {
  test('stdio: `cabinet mcp` spawned like Claude Code would, writes attributed to the agent', async () => {
    const t = tempSample();
    cleanups.push(t.cleanup);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'apps/cli/src/main.ts'), 'mcp', '--library', t.dir, '--agent', 'claude-code', '--thread', 'stdio-t1', '--project', 'sourdough', '--no-ai'],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(14);
    const ctx = parse(await client.callTool({ name: 'get_context', arguments: { topic: 'sourdough' } }));
    expect(ctx).toMatch(/Sourdough/);
    const mem = parse(await client.callTool({ name: 'remember', arguments: { fact: 'Bakes on Sundays.' } }));
    expect(mem).toMatchObject({ outcome: 'proposed', remembered: false, status: 'proposed' });
    await client.close();
    // the process flushed its git commit on exit
    await new Promise((r) => setTimeout(r, 800));
    expect(existsSync(join(t.dir, mem.path))).toBe(true);
    const raw = readFileSync(join(t.dir, mem.path), 'utf8');
    expect(raw).toContain('agent: claude-code');
    expect(raw).toContain('lifecycle: proposed');
    expect(raw).toContain('thread_id: stdio-t1');
    const log = await simpleGit(t.dir).log();
    expect(log.all.some((c) => c.author_name === 'agent:claude-code')).toBe(true);
  }, 30_000);

  test('HTTP: token required; tools work with a bearer token', async () => {
    const { startCabinet } = await import('../../../apps/cli/src/start.ts');
    const t = tempSample();
    const srv = await startCabinet({ library: t.dir, port: 0, ai: false, telegram: false, quiet: true, webDist: null });
    cleanups.push(t.cleanup, () => srv.close());
    const token = srv.ctx.auth.createToken('remote-bot').token;
    const noAuth = await fetch(srv.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(noAuth.status).toBe(401);
    const client = new Client({ name: 'http-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const s = parse(await client.callTool({ name: 'search', arguments: { query: 'listening rooms' } }));
    expect(s.hits.length).toBeGreaterThan(0);
    const mem = parse(await client.callTool({ name: 'remember', arguments: { fact: 'Remote agent was here.' } }));
    expect(mem).toMatchObject({ outcome: 'proposed', remembered: false, status: 'proposed' });
    expect(srv.ctx.lib.read(mem.id).frontmatter.agent).toBe('remote-bot');
    expect(srv.ctx.lib.read(mem.id).frontmatter.memory?.proposed_by).toBe('agent:remote-bot');
    await client.close();
  }, 30_000);
});
