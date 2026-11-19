import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AlreadyDecidedError,
  ConflictError,
  Library,
  NotFoundError,
  UnknownProjectError,
  approveProposal,
  getProposal,
  isActiveMemory,
  listProposals,
  proposalCounts,
  proposeMemory,
  rejectProposal,
  serializeMarkdown,
  suggestProjects,
  type LibraryEvent,
  type ProjectSuggestion,
} from '../src/index.ts';
import { tempSample, waitFor } from './helpers.ts';

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function openSample(opts: Parameters<typeof Library.open>[1] = { git: false }) {
  const t = tempSample();
  const lib = await Library.open(t.dir, opts);
  cleanups.push(t.cleanup, () => lib.close());
  return lib;
}

describe('memory proposals (core)', () => {
  test('proposeMemory writes memories/*.md with resolved project, sources, thread_id and drops bad source refs', async () => {
    const lib = await openSample();
    const project = lib.find('reading-corner')!;
    const sourceItem = lib.find('japanese-listening-rooms')!;
    const longQuote = 'Q'.repeat(350);

    const p = proposeMemory(
      lib,
      {
        fact: 'The armchair in the [[reading-corner]] is 95 cm tall.',
        title: 'Armchair height',
        tags: ['Furniture'],
        threadId: '  t-123  ',
        project: 'reading-corner',
        sources: [
          { item: 'japanese-listening-rooms', quote: longQuote },
          { item: 'does-not-exist-anywhere' },
          { item: 'does-not-exist', url: 'https://example.com/spec', quote: '95 cm' },
          { url: 'https://example.com/2' },
          { url: 'https://example.com/3' },
          { url: 'https://example.com/4' },
          { url: 'https://example.com/5-dropped' },
        ],
        agent: 'claude-code',
      },
      'agent:claude-code',
    );

    expect(p.path).toMatch(/^memories\/armchair-height\.md$/);
    expect(p.status).toBe('proposed');
    expect(p.agent).toBe('claude-code');
    expect(p.proposed_by).toBe('agent:claude-code');
    expect(p.thread_id).toBe('t-123');
    expect(p.project_ids).toEqual([project.id]);
    expect(p.sources).toHaveLength(5);
    expect(p.sources[0]).toEqual({ item_id: sourceItem.id, quote: 'Q'.repeat(300) });
    expect(p.sources[1]).toEqual({ url: 'https://example.com/spec', quote: '95 cm' });
    expect(p.decided_by).toBeNull();
    expect(p.decided_at).toBeNull();
    expect(p.reject_reason).toBeNull();
    expect(p.original_text).toBeNull();

    const item = lib.read(p.id);
    expect(item.status).toBe('inbox');
    expect(item.frontmatter.agent).toBe('claude-code');
    expect(item.frontmatter.captured_via).toBe('mcp:claude-code');
    expect(item.frontmatter.memory?.lifecycle).toBe('proposed');
    expect(item.frontmatter.memory?.schema_version).toBe(1);
    expect(isActiveMemory(item)).toBe(false);

    // Non-project or unknown project throws UnknownProjectError
    const nonProject = lib.find('warm-light')!;
    expect(() => proposeMemory(lib, { fact: 'Some fact', project: nonProject.slug, agent: 'x' }, 'agent:x')).toThrow(UnknownProjectError);
    expect(() => proposeMemory(lib, { fact: 'Some fact', project: 'no-such-project', agent: 'x' }, 'agent:x')).toThrow(UnknownProjectError);
  });

  test('listProposals filters by status/project/thread/agent, excludes legacy memories, and proposalCounts aggregates', async () => {
    const lib = await openSample();
    const corner = lib.find('reading-corner')!;
    const sourdough = lib.find('sourdough')!;

    // Legacy memories exist in sample-library and are active, never listed as proposals
    const legacy = lib.index.list({ type: 'memory', limit: 100 }).items;
    expect(legacy.length).toBeGreaterThan(0);
    for (const s of legacy) expect(isActiveMemory(lib.read(s.id))).toBe(true);
    expect(listProposals(lib, { status: 'all' }).total).toBe(0);
    expect(getProposal(lib, legacy[0].id)).toBeNull();

    const p1 = proposeMemory(lib, { fact: 'Fact one about lamps.', project: corner.slug, threadId: 'th-1', agent: 'bot-a' }, 'agent:bot-a');
    const p2 = proposeMemory(lib, { fact: 'Fact two about bread.', project: sourdough.id, threadId: 'th-1', agent: 'bot-b' }, 'agent:bot-b');
    const p3 = proposeMemory(lib, { fact: 'Fact three about chairs.', project: corner.id, threadId: 'th-2', agent: 'bot-a' }, 'agent:bot-a');

    expect(listProposals(lib).total).toBe(3);
    expect(listProposals(lib, { projectId: corner.id }).proposals.map((p) => p.id).sort()).toEqual([p1.id, p3.id].sort());
    expect(listProposals(lib, { threadId: 'th-1' }).proposals.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
    expect(listProposals(lib, { agent: 'bot-b' }).proposals.map((p) => p.id)).toEqual([p2.id]);

    const counts = proposalCounts(lib);
    expect(counts.total).toBe(3);
    expect(counts.byProject).toEqual({ [corner.id]: 2, [sourdough.id]: 1 });
    expect(counts.byThread).toEqual({ 'th-1': 2, 'th-2': 1 });

    approveProposal(lib, p1.id, {}, 'you');
    rejectProposal(lib, p2.id, { reason: 'Duplicate' }, 'you');

    expect(listProposals(lib, { status: 'proposed' }).proposals.map((p) => p.id)).toEqual([p3.id]);
    expect(listProposals(lib, { status: 'approved' }).proposals.map((p) => p.id)).toEqual([p1.id]);
    expect(listProposals(lib, { status: 'rejected' }).proposals.map((p) => p.id)).toEqual([p2.id]);
    expect(listProposals(lib, { status: 'all' }).total).toBe(3);

    const countsAfter = proposalCounts(lib);
    expect(countsAfter.total).toBe(1);
    expect(countsAfter.byProject).toEqual({ [corner.id]: 1 });
    expect(countsAfter.byThread).toEqual({ 'th-2': 1 });
  });

  test('approve and reject handle edits, original_text, ConflictError, AlreadyDecidedError, NotFoundError', async () => {
    const lib = await openSample();
    const p = proposeMemory(lib, { fact: 'Original agent wording.', agent: 'claude' }, 'agent:claude');

    // Stale baseHash throws ConflictError
    expect(() => approveProposal(lib, p.id, { baseHash: '0'.repeat(40) }, 'you')).toThrow(ConflictError);

    // Approve with edited text keeps original_text and sets status library + lifecycle active
    const approved = approveProposal(lib, p.id, { text: 'Edited human wording.', title: 'Updated memory title', baseHash: p.hash }, 'you');
    expect(approved.status).toBe('approved');
    expect(approved.text).toBe('Edited human wording.');
    expect(approved.original_text).toBe('Original agent wording.');
    expect(approved.decided_by).toBe('you');
    expect(approved.decided_at).toBeTruthy();

    const item = lib.read(p.id);
    expect(item.status).toBe('library');
    expect(item.frontmatter.memory?.lifecycle).toBe('active');
    expect(isActiveMemory(item)).toBe(true);

    // Second approve or reject throws AlreadyDecidedError
    expect(() => approveProposal(lib, p.id, {}, 'you')).toThrow(AlreadyDecidedError);
    expect(() => rejectProposal(lib, p.id, {}, 'you')).toThrow(AlreadyDecidedError);

    // Reject path
    const p2 = proposeMemory(lib, { fact: 'Wrong fact.', agent: 'claude' }, 'agent:claude');
    const rejected = rejectProposal(lib, p2.id, { reason: 'Not accurate' }, 'you');
    expect(rejected.status).toBe('rejected');
    expect(rejected.reject_reason).toBe('Not accurate');
    expect(rejected.decided_by).toBe('you');
    expect(existsSync(join(lib.root, rejected.path))).toBe(true);
    const rejItem = lib.read(p2.id);
    expect(rejItem.status).toBe('archived');
    expect(rejItem.frontmatter.memory?.lifecycle).toBe('rejected');
    expect(isActiveMemory(rejItem)).toBe(false);

    expect(() => approveProposal(lib, p2.id, {}, 'you')).toThrow(AlreadyDecidedError);
    expect(() => approveProposal(lib, 'nonexistent', {}, 'you')).toThrow(NotFoundError);
  });

  test('events: propose, approve, reject emit kind=memory without body text', async () => {
    const lib = await openSample();
    const events: LibraryEvent[] = [];
    lib.on('event', (e) => {
      if (e.kind === 'memory') events.push(e);
    });

    const p1 = proposeMemory(lib, { fact: 'Secret fact body text.', threadId: 't-evt', project: 'reading-corner', agent: 'a' }, 'agent:a');
    approveProposal(lib, p1.id, {}, 'you');
    const p2 = proposeMemory(lib, { fact: 'Another secret body.', agent: 'a' }, 'agent:a');
    rejectProposal(lib, p2.id, {}, 'you');

    expect(events).toHaveLength(4);
    expect(events.map((e) => (e.data as any).action)).toEqual(['proposed', 'approved', 'proposed', 'rejected']);
    expect(events[0].origin).toBe('app');
    expect(events[0].author).toBe('agent:a');
    expect((events[0].data as any).thread_id).toBe('t-evt');
    expect((events[0].data as any).project_ids).toHaveLength(1);
    expect((events[2].data as any)).not.toHaveProperty('thread_id');
    expect((events[2].data as any).project_ids).toEqual([]);
    for (const e of events) {
      const s = JSON.stringify(e);
      expect(s).not.toContain('Secret fact body text');
      expect(s).not.toContain('Another secret body');
      expect(e.data).not.toHaveProperty('text');
      expect(e.data).not.toHaveProperty('fact');
    }
  });

  test('disk-origin: external write of memory proposal emits memory event with origin=disk', async () => {
    const lib = await openSample({ git: false, watch: true });
    const events: LibraryEvent[] = [];
    lib.on('event', (e) => {
      if (e.kind === 'memory' && e.origin === 'disk') events.push(e);
    });

    const content = serializeMarkdown(
      {
        id: '01JDISKPROPOSAL00000000000',
        type: 'memory',
        title: 'External memory proposal',
        status: 'inbox',
        created: '2026-11-15T10:00:00Z',
        updated: '2026-11-15T10:00:00Z',
        agent: 'claude-code',
        captured_via: 'mcp:claude-code',
        memory: {
          schema_version: 1,
          lifecycle: 'proposed',
          proposed_by: 'agent:claude-code',
          proposed_at: '2026-11-15T10:00:00Z',
          thread_id: 'disk-thread',
        },
      },
      'Written externally on disk.\n',
    );
    writeFileSync(join(lib.root, 'memories/external-memory-proposal.md'), content);

    const evt = await waitFor(() => events.find((e) => e.id === '01JDISKPROPOSAL00000000000'));
    expect(evt.origin).toBe('disk');
    expect(evt.data).toMatchObject({ action: 'proposed', status: 'proposed', project_ids: [], thread_id: 'disk-thread' });
  });

  test('git: attributes propose to agent:x and approve/reject to you', async () => {
    const lib = await openSample({ git: true, debounceMs: 50 });
    const p = proposeMemory(lib, { fact: 'Git tracked memory.', title: 'Git memory', agent: 'x' }, 'agent:x');
    await lib.git!.flush();

    approveProposal(lib, p.id, {}, 'you');
    await lib.git!.flush();

    const log = await simpleGit(lib.root).log();
    const proposeCommit = log.all.find((c) => c.author_name === 'agent:x' && c.message.includes('add memory “Git memory”'));
    const approveCommit = log.all.find((c) => c.author_name === 'you' && c.message.includes('approve memory “Git memory”'));
    expect(proposeCommit).toBeTruthy();
    expect(approveCommit).toBeTruthy();
    expect(readFileSync(join(lib.root, p.path), 'utf8')).toContain('lifecycle: active');
  });

  test('proposeMemory throws UnknownProjectError with fuzzy suggestions and actionable guidance', async () => {
    const lib = await openSample();
    const nabilProj = lib.create({
      type: 'project',
      slug: 'nabilincdotxyz',
      title: 'nabilinc.xyz',
      frontmatter: { intent: 'Personal website and portfolio for Nabil.' },
    });
    const projectCountBefore = lib.index.list({ type: 'project', limit: 200 }).total;

    // Partial slug match ("reading" -> "reading-corner")
    let partialErr: unknown;
    try {
      proposeMemory(lib, { fact: 'Prefers floor lamps.', project: '  reading  ', agent: 'claude' }, 'agent:claude');
    } catch (e) {
      partialErr = e;
    }
    expect(partialErr).toBeInstanceOf(Error);
    expect(partialErr).toBeInstanceOf(UnknownProjectError);
    const err1 = partialErr as UnknownProjectError;
    expect(err1.name).toBe('UnknownProjectError');
    expect(err1.query).toBe('reading');
    expect(err1.suggestions.map((s) => s.slug)).toContain('reading-corner');
    expect(err1.suggestions[0]).toMatchObject({
      slug: 'reading-corner',
      title: 'Reading corner',
      intent: 'A calm corner by the window for reading in the evening: warm light, soft sound, no screens.',
    });
    expect(err1.message).toContain('No exact project matched "reading"');
    expect(err1.message).toContain('reading-corner (Reading corner)');
    expect(err1.message).toContain('create_project');
    expect(err1.message).toContain('omit `project`');

    // Token/substring mismatch ("nabil-site" -> "nabilincdotxyz")
    let tokenErr: unknown;
    try {
      proposeMemory(lib, { fact: 'Site uses custom serif typography.', project: 'nabil-site', agent: 'claude' }, 'agent:claude');
    } catch (e) {
      tokenErr = e;
    }
    expect(tokenErr).toBeInstanceOf(UnknownProjectError);
    const err2 = tokenErr as UnknownProjectError;
    expect(err2.query).toBe('nabil-site');
    expect(err2.suggestions.map((s) => s.id)).toContain(nabilProj.id);
    expect(err2.message).toContain('nabilincdotxyz (nabilinc.xyz)');

    // Never auto-creates projects
    expect(lib.index.list({ type: 'project', limit: 200 }).total).toBe(projectCountBefore);
  });

  test('proposeMemory rejects non-project refs (note, article, collection, memory) and only suggests projects', async () => {
    const lib = await openSample();
    const note = lib.create({ type: 'note', slug: 'sourdough-starter-note', title: 'Sourdough starter note', body: 'Feed daily.\n' });
    const article = lib.find('japanese-listening-rooms')!;
    const collection = lib.find('listening-rooms')!;
    const memory = lib.find('prefers-warm-light')!;

    expect(note.type).toBe('note');
    expect(article.type).toBe('article');
    expect(collection.type).toBe('collection');
    expect(memory.type).toBe('memory');

    for (const [ref, expectedProjectSlug] of [
      [note.slug, 'sourdough'],
      [article.slug, 'listening-rooms-essay'],
      [collection.slug, 'listening-rooms-essay'],
    ] as const) {
      let caught: unknown;
      try {
        proposeMemory(lib, { fact: 'Test fact.', project: ref, agent: 'claude' }, 'agent:claude');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnknownProjectError);
      const err = caught as UnknownProjectError;
      expect(err.query).toBe(ref);
      expect(err.suggestions.map((s) => s.slug)).toContain(expectedProjectSlug);
      for (const s of err.suggestions) {
        expect(lib.read(s.id).type).toBe('project');
      }
      expect(err.suggestions.map((s) => s.id)).not.toContain(note.id);
      expect(err.suggestions.map((s) => s.id)).not.toContain(article.id);
      expect(err.suggestions.map((s) => s.id)).not.toContain(collection.id);
      expect(err.suggestions.map((s) => s.id)).not.toContain(memory.id);
    }

    // Memory ref also throws UnknownProjectError and never suggests memories
    let memErr: unknown;
    try {
      proposeMemory(lib, { fact: 'Test fact.', project: memory.slug, agent: 'claude' }, 'agent:claude');
    } catch (e) {
      memErr = e;
    }
    expect(memErr).toBeInstanceOf(UnknownProjectError);
    for (const s of (memErr as UnknownProjectError).suggestions) {
      expect(lib.read(s.id).type).toBe('project');
    }
  });

  test('proposeMemory zero-match UnknownProjectError guides to list_projects, create_project, or omitting project', async () => {
    const lib = await openSample();
    let caught: unknown;
    try {
      proposeMemory(lib, { fact: 'Completely unrelated fact.', project: 'quantum-teleporter-v9', agent: 'claude' }, 'agent:claude');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownProjectError);
    const err = caught as UnknownProjectError;
    expect(err.query).toBe('quantum-teleporter-v9');
    expect(err.suggestions).toEqual([]);
    expect(err.message).toContain('No project matched "quantum-teleporter-v9"');
    expect(err.message).toContain('list_projects');
    expect(err.message).toContain('create_project');
    expect(err.message).toContain('omit `project`');
  });

  test('suggestProjects deduplicates, enforces limit, normalizes tokens, and excludes non-projects', async () => {
    const lib = await openSample();

    // Empty / whitespace / zero limit return []
    expect(suggestProjects(lib, '')).toEqual([]);
    expect(suggestProjects(lib, '   ')).toEqual([]);
    expect(suggestProjects(lib, 'reading', 0)).toEqual([]);

    // Normalized / camelCase / compact matching + intent field handling
    const compactMatches: ProjectSuggestion[] = suggestProjects(lib, 'ReadingCorner');
    expect(compactMatches.map((s) => s.slug)).toEqual(['reading-corner']);
    expect(compactMatches[0].intent).toBe('A calm corner by the window for reading in the evening: warm light, soft sound, no screens.');

    // Project without intent omits undefined intent key cleanly
    const bareProject = lib.create({ type: 'project', slug: 'alpha-bare', title: 'Alpha bare' });
    const bareMatches = suggestProjects(lib, 'alpha-bare');
    expect(bareMatches).toEqual([{ id: bareProject.id, slug: 'alpha-bare', title: 'Alpha bare' }]);
    expect('intent' in bareMatches[0]).toBe(false);

    // Create 7 matching projects and a matching note/article to verify dedup, cap, and type filtering
    for (let i = 1; i <= 7; i++) {
      lib.create({
        type: 'project',
        slug: `synth-lab-${i}`,
        title: `Synth Lab ${i}`,
        frontmatter: { intent: `Analog synth experiment ${i}` },
      });
    }
    const nonProjNote = lib.create({ type: 'note', slug: 'synth-lab', title: 'Synth Lab' });
    const nonProjArticle = lib.create({ type: 'article', slug: 'synth-lab-guide', title: 'Synth Lab Guide' });

    const defaultTop = suggestProjects(lib, 'synth lab');
    expect(defaultTop).toHaveLength(5);
    expect(new Set(defaultTop.map((s) => s.id)).size).toBe(5);
    for (const s of defaultTop) {
      expect(lib.read(s.id).type).toBe('project');
      expect(s.id).not.toBe(nonProjNote.id);
      expect(s.id).not.toBe(nonProjArticle.id);
    }

    const cappedTop = suggestProjects(lib, 'synth lab', 3);
    expect(cappedTop).toHaveLength(3);
    expect(new Set(cappedTop.map((s) => s.id)).size).toBe(3);
  });
});
