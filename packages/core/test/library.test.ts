import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, test } from 'vitest';
import { exportLibrary, listLibraryFiles, restoreLibrary, validateExport } from '../src/archive.ts';
import { parseMarkdown } from '../src/format.ts';
import { ConflictError, Library } from '../src/library.ts';
import { extractLinks } from '../src/links.ts';
import { parseProject } from '../src/project.ts';
import { currentInterests, revisit } from '../src/revisit.ts';
import { sleep, tempSample, waitFor } from './helpers.ts';

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

describe('indexing and links', () => {
  test('indexes the sample library', async () => {
    const lib = await openSample();
    const c = lib.index.counts();
    expect(c.total).toBe(24);
    expect(c.project).toBe(3);
    expect(c.inbox).toBe(2);
  });

  test('resolves links by slug, title and alias; backlinks include project material with context', async () => {
    const lib = await openSample();
    const rooms = lib.find('japanese-listening-rooms')!;
    expect(lib.find('Japanese listening rooms')!.id).toBe(rooms.id);
    expect(lib.find(rooms.id)!.id).toBe(rooms.id);
    const backs = lib.index.backlinks(rooms.id);
    const bySource = (slug: string) => backs.find((b) => b.sourceId === lib.find(slug)!.id);
    expect(bySource('what-makes-a-room-calm')?.kind).toBe('link');
    expect(bySource('reading-corner')).toMatchObject({ kind: 'material', section: 'Inspiration', context: 'the low warm light is the feeling I want' });
    expect(bySource('listening-rooms-essay')).toMatchObject({ kind: 'material', section: 'Sources' });
    // The same item carries different per-project context
    const projects = lib.index.projectsFor(rooms.id);
    expect(projects.map((p) => p.context).sort()).toEqual(['history paragraph, the kissa origin', 'the low warm light is the feeling I want']);
    // "why" links count too
    const corner = lib.find('reading-corner')!;
    expect(lib.index.backlinks(corner.id).some((b) => b.sourceId === rooms.id)).toBe(true);
    // Embeds resolve to the image item that owns the attachment
    const out = lib.index.outgoing(lib.find('paper-lamp-photo')!.id);
    expect(out.find((l) => l.kind === 'embed')?.targetId).toBe(lib.find('paper-lamp-photo')!.id);
  });

  test('graph neighbourhood grows with depth', async () => {
    const lib = await openSample();
    const id = lib.find('reading-corner')!.id;
    const g1 = lib.index.graph(id, 1);
    const g2 = lib.index.graph(id, 2);
    expect(g1.nodes.length).toBeGreaterThan(4);
    expect(g2.nodes.length).toBeGreaterThan(g1.nodes.length);
    expect(lib.index.graph(id, 2, ['note']).nodes.every((n) => n.type === 'note' || n.id === id)).toBe(true);
  });
});

describe('writes', () => {
  test('create, update, conflict detection', async () => {
    const lib = await openSample();
    const item = lib.create({ type: 'note', title: 'Bulb shopping', body: 'See [[akari-style-floor-lamp]].', tags: ['Lighting ', '#To Buy'] });
    expect(item.path).toBe('notes/bulb-shopping.md');
    expect(item.tags).toEqual(['lighting', 'to-buy']);
    const lamp = lib.find('akari-style-floor-lamp')!;
    expect(lib.index.backlinks(lamp.id).some((b) => b.sourceId === item.id)).toBe(true);

    const updated = lib.update(item.id, { body: 'Changed', baseHash: item.hash });
    expect(updated.body).toBe('Changed\n');
    // A stale base hash is rejected with the current version attached
    expect(() => lib.update(item.id, { body: 'Mine', baseHash: item.hash })).toThrow(ConflictError);
    try {
      lib.update(item.id, { body: 'Mine', baseHash: item.hash });
    } catch (e) {
      expect((e as ConflictError).current.body).toBe('Changed\n');
    }
    // External edit also invalidates the base hash
    writeFileSync(join(lib.root, updated.path), readFileSync(join(lib.root, updated.path), 'utf8') + 'disk edit\n');
    expect(() => lib.update(item.id, { body: 'x', baseHash: updated.hash })).toThrow(ConflictError);
  });

  test('renaming rewrites links everywhere, including project material and why', async () => {
    const lib = await openSample();
    const rooms = lib.find('japanese-listening-rooms')!;
    lib.update(rooms.id, { frontmatter: { title: 'Tokyo listening bars' } });
    const renamed = lib.read(rooms.id);
    expect(renamed.path).toBe('sources/tokyo-listening-bars.md');
    expect(existsSync(join(lib.root, 'sources/japanese-listening-rooms.md'))).toBe(false);
    const corner = lib.find('reading-corner')!;
    expect(corner.body).toContain('- [[tokyo-listening-bars]]: the low warm light is the feeling I want');
    expect(lib.find('what-makes-a-room-calm')!.body).toContain('[[tokyo-listening-bars]]');
    expect(lib.index.backlinks(rooms.id).length).toBeGreaterThanOrEqual(3);
    // A note whose title doesn't match its slug keeps its filename
    const n = lib.create({ type: 'note', title: 'X', slug: 'custom-slug' });
    expect(lib.update(n.id, { frontmatter: { title: 'Y' } }).path).toBe('notes/custom-slug.md');
  });

  test('link items and add to project', async () => {
    const lib = await openSample();
    const a = lib.find('wabi-sabi-small-spaces')!;
    const b = lib.find('what-makes-a-room-calm')!;
    lib.linkItems(a.id, b.id, 'you', 'same idea');
    expect(lib.read(a.id).body).toMatch(/## Related\n- \[\[what-makes-a-room-calm\]\]: same idea\n\n## Content/);
    lib.linkItems(a.id, b.id); // idempotent
    expect(extractLinks(lib.read(a.id).body).filter((l) => l.target === b.slug)).toHaveLength(1);
    const p = lib.find('reading-corner')!;
    lib.addToProject(p.id, a.id, { section: 'Inspiration', context: 'imperfection is fine' });
    const model = parseProject(lib.read(p.id).body);
    expect(model.material.find((s) => s.name === 'Inspiration')!.lines.at(-1)).toMatchObject({ target: a.slug, context: 'imperfection is fine' });
    expect(lib.index.projectsFor(a.id)[0]).toMatchObject({ projectId: p.id, section: 'Inspiration' });
  });

  test('a rebuilt index matches the live index after many operations', async () => {
    const lib = await openSample();
    const n = lib.create({ type: 'note', title: 'Live index', body: '[[reading-corner]] [[Warm light]]' });
    lib.update(n.id, { body: 'Now [[vinyl-care]]', frontmatter: { tags: ['x'] } });
    lib.rename(lib.find('vinyl-care')!.id, 'record-care');
    lib.delete(lib.find('sourdough-hydration')!.id);
    lib.addToProject(lib.find('sourdough')!.id, lib.find('record-fair-notes')!.id, { section: 'Odd' });
    const live = lib.index.dump();
    lib.rebuild();
    expect(lib.index.dump()).toEqual(live);
  });
});

describe('search', () => {
  test('keyword search labels where it matched, fully offline', async () => {
    const lib = await openSample();
    const title = lib.index.search('listening rooms');
    expect(title[0].item.slug).toMatch(/listening-rooms/);
    expect(title[0].field).toBe('title');
    const pdf = lib.index.search('flutter echo');
    expect(pdf[0].item.slug).toBe('room-acoustics-primer');
    expect(pdf[0].field).toBe('pdf');
    expect(pdf[0].snippet).toContain('«');
    const content = lib.index.search('kissa');
    expect(content.find((h) => h.item.slug === 'japanese-listening-rooms')).toMatchObject({ field: 'content' });
    const note = lib.index.search('armchair');
    expect(note.some((h) => h.field === 'note')).toBe(true);
    const tag = lib.index.search('vinyl');
    expect(tag.some((h) => h.field === 'tag' || h.field === 'title')).toBe(true);
    // prefix + stemming
    expect(lib.index.search('acoust').length).toBeGreaterThan(0);
    // filters
    expect(lib.index.search('light', { type: 'note' }).every((h) => h.item.type === 'note')).toBe(true);
  });

  test('home: interests and a daily-seeded revisit', async () => {
    const lib = await openSample();
    const now = new Date('2026-11-14T12:00:00Z');
    const interests = currentInterests(lib.index, now);
    expect(interests.projects.map((p) => p.slug).sort()).toEqual(['listening-rooms-essay', 'reading-corner']);
    expect(interests.tags.length).toBeGreaterThan(0);
    const a = revisit(lib.index, lib.state, { now });
    const b = revisit(lib.index, lib.state, { now });
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(a).toHaveLength(4);
    expect(a.every((x) => x.created < '2026-10-31')).toBe(true);
  });
});

describe('watcher', () => {
  test('external edits, creates and deletes are picked up', async () => {
    const lib = await openSample({ git: false, watch: true });
    const events: any[] = [];
    lib.on('event', (e) => events.push(e));
    const p = join(lib.root, 'notes/vinyl-care.md');
    const text = readFileSync(p, 'utf8').replace('Inner sleeves', 'Anti-static inner sleeves');
    writeFileSync(p, text);
    await waitFor(() => events.find((e) => e.kind === 'updated' && e.origin === 'disk'));
    expect(lib.index.search('anti-static')[0].item.slug).toBe('vinyl-care');

    writeFileSync(join(lib.root, 'notes/from-obsidian.md'), '# From Obsidian\n\nLinks to [[vinyl-care]].\n');
    const created = await waitFor(() => events.find((e) => e.kind === 'created' && e.origin === 'disk'));
    expect(lib.index.getSummary(created.id)!.title).toBe('From Obsidian');
    expect(lib.index.backlinks(lib.find('vinyl-care')!.id).some((b) => b.sourceId === created.id)).toBe(true);

    // our own writes do not echo back as disk events
    const before = events.length;
    lib.update(lib.find('vinyl-care')!.id, { body: 'app write' });
    await sleep(600);
    expect(events.slice(before).filter((e) => e.origin === 'disk')).toHaveLength(0);
  });
});

describe('git auto-commit', () => {
  test('commits are attributed to who made the change', async () => {
    const lib = await openSample({ git: true, debounceMs: 50 });
    lib.create({ type: 'note', title: 'By me' }, 'you');
    lib.create({ type: 'memory', title: 'Agent fact' }, 'agent:claude');
    lib.create({ type: 'text', title: 'From phone' }, 'telegram');
    await lib.git!.flush();
    const log = await simpleGit(lib.root).log();
    const authors = log.all.map((c) => c.author_name);
    expect(authors).toEqual(expect.arrayContaining(['you', 'agent:claude', 'telegram']));
    const agentCommit = log.all.find((c) => c.author_name === 'agent:claude')!;
    expect(agentCommit.message).toContain('Agent fact');
    const status = await simpleGit(lib.root).status();
    expect(status.files.filter((f) => !f.path.startsWith('.cabinet/') && f.path !== '.gitignore' && f.path !== 'AGENTS.md')).toEqual(
      expect.arrayContaining([]),
    );
    // generated files are ignored
    expect(status.files.some((f) => f.path.includes('index.sqlite'))).toBe(false);
  });
});

describe('export / restore', () => {
  test('restore leaves the library byte-identical', async () => {
    const lib = await openSample();
    lib.create({ type: 'note', title: 'Exported note', body: 'Survives the round trip.' });
    const zip = exportLibrary(lib.root);
    expect(validateExport(zip).ok).toBe(true);
    const files = listLibraryFiles(lib.root);
    expect(files.some((f) => f.includes('index.sqlite'))).toBe(false);
    const snapshot = new Map(files.map((f) => [f, readFileSync(join(lib.root, f))]));
    await lib.close();

    const { backup } = restoreLibrary(lib.root, zip);
    expect(backup && existsSync(backup)).toBeTruthy();
    const after = listLibraryFiles(lib.root);
    expect(after).toEqual(files);
    for (const f of after) expect(readFileSync(join(lib.root, f)).equals(snapshot.get(f)!), f).toBe(true);

    const reopened = await Library.open(lib.root, { git: false });
    cleanups.push(() => reopened.close());
    expect(reopened.find('exported-note')!.body).toBe('Survives the round trip.\n');
  });

  test('rejects unsafe or foreign archives', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    expect(validateExport(strToU8('nope')).ok).toBe(false);
    const evil = zipSync({ '../evil.md': strToU8('x'), '.cabinet-export.json': strToU8('{"format":"cabinet-export"}') });
    const v = validateExport(evil);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/Unsafe|config/);
  });
});

describe('Obsidian compatibility (format level)', () => {
  test('frontmatter is standard YAML, links are wikilinks, embeds point at real files', async () => {
    const lib = await openSample();
    for (const rel of lib.listMarkdownFiles()) {
      const text = readFileSync(join(lib.root, rel), 'utf8');
      expect(text.startsWith('---\n'), rel).toBe(true);
      const { frontmatter, hasFrontmatter } = parseMarkdown(text);
      expect(hasFrontmatter).toBe(true);
      // Obsidian reads tags/aliases as lists of plain strings
      if (frontmatter.tags) expect(Array.isArray(frontmatter.tags)).toBe(true);
      for (const l of extractLinks(text)) {
        if (l.embed) expect(existsSync(join(lib.root, l.target)), `${rel} embeds ${l.target}`).toBe(true);
        else expect(lib.resolveLink(l.target), `${rel} → ${l.target}`).not.toBeNull();
      }
    }
  });
});
