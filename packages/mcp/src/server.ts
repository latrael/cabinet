import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ConflictError,
  ITEM_TYPES,
  getSection,
  parseProject,
  splitNotesAndContent,
  type Item,
  type ItemSummary,
  type Library,
  type SearchHit,
} from '@cabinet/core';

/** What the MCP tools need. Everything is resolved lazily so a restored library is picked up. */
export interface McpDeps {
  lib: () => Library;
  /** Agent name; writes are committed as `agent:<name>` and captured_via `mcp:<name>`. */
  agent: string;
  search?: (q: string, opts: { type?: string | string[]; limit?: number }) => Promise<{ hits: SearchHit[]; mode: string }>;
  related?: (text: string, opts: { excludeIds?: string[]; limit?: number }) => Promise<Array<{ item: ItemSummary; score: number; reason: string }>>;
  capture?: (input: {
    url?: string;
    text?: string;
    kind?: 'text' | 'quote' | 'note';
    title?: string;
    why?: string;
    tags?: string[];
    projectId?: string;
    section?: string;
    context?: string;
    author?: string;
    via: string;
  }) => Promise<{ item: Item; duplicate?: boolean }>;
  onChanged?: (id: string) => void;
}

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

function brief(i: ItemSummary) {
  return { id: i.id, slug: i.slug, title: i.title, type: i.type, status: i.status, created: i.created, why: i.why, tags: i.tags, url: i.url };
}

export const INSTRUCTIONS = `Cabinet is the owner's personal library: notes, saved sources (articles, links, quotes, videos, images, PDFs), hobby projects and agent memories, stored as Markdown files.
Use it as long-term memory and context:
- Before answering questions about the owner's interests, projects or past saves, call get_context (or search + get_item).
- When you learn a durable fact about the owner or their work, call remember. Use recall to look facts up.
- Save useful links or text with capture; write longer thinking with create_note.
- Reference items as [[slug]] inside note bodies to link them.
- update_note needs the base_hash from get_item so you never overwrite edits made elsewhere.
Every change you make is committed to git under your agent name, so the owner can review and revert it.`;

export function createCabinetMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'cabinet', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const author = `agent:${deps.agent}`;
  const via = `mcp:${deps.agent}`;
  const L = () => deps.lib();

  const resolve = (ref: string): Item => {
    const clean = ref.trim().replace(/^\[\[|\]\]$/g, '').replace(/^cabinet:\/\/item\//, '');
    const item = L().find(clean);
    if (!item) throw new Error(`No item matches "${ref}". Use search to find the right slug.`);
    return item;
  };

  const doSearch = async (q: string, type?: string, limit = 10) => {
    if (deps.search) return deps.search(q, { type, limit });
    return { hits: L().index.search(q, { type, limit }), mode: 'keyword' };
  };

  const guard = <A,>(fn: (args: A) => Promise<any> | any) => async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof ConflictError) return fail(`Conflict: the item changed since you read it (current hash ${e.current.hash}). Call get_item again and retry with the new base_hash.`);
      return fail((e as Error).message);
    }
  };

  // ---------------------------------------------------------------- read tools

  server.registerTool(
    'search',
    {
      title: 'Search the library',
      description: 'Search notes, sources, projects and memories by keywords and meaning. Each hit says where it matched (title, note, content, tag, PDF text, similar meaning).',
      inputSchema: { query: z.string(), type: z.enum(ITEM_TYPES).optional(), limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ query, type, limit }: { query: string; type?: string; limit?: number }) => {
      const r = await doSearch(query, type, limit ?? 10);
      return json({ mode: r.mode, hits: r.hits.map((h) => ({ ...brief(h.item), matched: h.field, snippet: h.snippet.replace(/[«»]/g, '') })) });
    }),
  );

  server.registerTool(
    'get_item',
    {
      title: 'Read an item',
      description: 'Read one item by id, slug, title or [[link]]. Returns frontmatter, the Markdown body, its hash (needed for update_note), backlinks and the projects it belongs to.',
      inputSchema: { ref: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ ref }: { ref: string }) => {
      const item = resolve(ref);
      const lib = L();
      return json({
        id: item.id,
        slug: item.slug,
        path: item.path,
        hash: item.hash,
        frontmatter: item.frontmatter,
        body: item.body,
        backlinks: lib.index.backlinks(item.id).map((b) => ({ ...brief(lib.index.getSummary(b.sourceId)!), kind: b.kind, context: b.context })),
        projects: lib.index.projectsFor(item.id).map((p) => ({ project: lib.index.getSummary(p.projectId)?.title, slug: lib.index.getSummary(p.projectId)?.slug, section: p.section, context: p.context })),
        links: lib.index.outgoing(item.id).map((o) => ({ target: o.target, resolved: o.targetId ? lib.index.getSummary(o.targetId)?.slug : null, kind: o.kind })),
      });
    }),
  );

  server.registerTool(
    'get_context',
    {
      title: 'Context pack for a topic',
      description:
        'A compact, ready-to-use briefing about a topic from the library: relevant memories, projects (with intent and open questions), notes and sources with why they were saved and short excerpts. Use this before working on anything the owner cares about.',
      inputSchema: { topic: z.string(), max_items: z.number().int().min(3).max(25).optional() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ topic, max_items }: { topic: string; max_items?: number }) => {
      const lib = L();
      const max = max_items ?? 10;
      const { hits } = await doSearch(topic, undefined, max * 2);
      const memories = (await doSearch(topic, 'memory', 6)).hits.filter((h) => h.item.type === 'memory');
      const seen = new Set<string>();
      const projects: ItemSummary[] = [];
      const others: SearchHit[] = [];
      for (const h of hits) {
        if (seen.has(h.item.id) || h.item.type === 'memory' || h.item.type === 'collection') continue;
        seen.add(h.item.id);
        if (h.item.type === 'project') projects.push(h.item);
        else others.push(h);
      }
      // Projects that contain the matching items are relevant too.
      for (const h of others.slice(0, max)) {
        for (const p of lib.index.projectsFor(h.item.id)) {
          if (!seen.has(p.projectId)) {
            const s = lib.index.getSummary(p.projectId);
            if (s) {
              seen.add(s.id);
              projects.push(s);
            }
          }
        }
      }
      const lines: string[] = [`# Context: ${topic}`, ''];
      if (memories.length) {
        lines.push('## What I know (memories)');
        for (const m of memories) {
          const body = lib.read(m.item.id).body.trim().replace(/\s+/g, ' ');
          lines.push(`- ${body} ([[${m.item.slug}]])`);
        }
        lines.push('');
      }
      if (projects.length) {
        lines.push('## Projects');
        for (const p of projects.slice(0, 4)) {
          const it = lib.read(p.id);
          const model = parseProject(it.body);
          lines.push(`### ${p.title} ([[${p.slug}]], ${p.projectStatus ?? 'active'})`);
          if (it.frontmatter.intent) lines.push(`Intent: ${it.frontmatter.intent}`);
          const material = model.material.flatMap((s) => s.lines.filter((l) => l.kind === 'item').map((l: any) => `${s.name ? s.name + ': ' : ''}[[${l.target}]]${l.context ? ` (${l.context})` : ''}`));
          if (material.length) lines.push(`Material: ${material.slice(0, 12).join('; ')}`);
          if (model.questions.length) lines.push(`Open questions: ${model.questions.join(' | ')}`);
          const todo = model.checklist.filter((c) => !c.done).map((c) => c.text);
          if (todo.length) lines.push(`To do: ${todo.join(' | ')}`);
          if (model.notes) lines.push(`Notes: ${model.notes.replace(/\s+/g, ' ').slice(0, 400)}`);
          lines.push('');
        }
      }
      if (others.length) {
        lines.push('## Notes and sources');
        for (const h of others.slice(0, max)) {
          const it = lib.read(h.item.id);
          const { notes, content } = splitNotesAndContent(it.body);
          const summary = (it.frontmatter.summary as string | undefined) ?? '';
          const ex = (summary || notes || content).replace(/\s+/g, ' ').slice(0, 320);
          lines.push(`- **${h.item.title}** [[${h.item.slug}]] (${h.item.type}${h.item.url ? `, ${h.item.url}` : ''})${h.item.why ? `\n  Why saved: ${h.item.why}` : ''}${ex ? `\n  ${ex}` : ''}`);
        }
      }
      if (lines.length <= 2) lines.push('Nothing in the library about this yet.');
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'list_recent',
    {
      title: 'Recent items',
      description: 'The most recently saved items, newest first.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional(), type: z.enum(ITEM_TYPES).optional(), status: z.enum(['inbox', 'library', 'archived']).optional() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ limit, type, status }: { limit?: number; type?: string; status?: string }) =>
      json(L().index.list({ limit: limit ?? 15, type, status, sort: 'created' }).items.map(brief)),
    ),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'All projects with status, kind and intent.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () =>
      json(
        L()
          .index.list({ type: 'project', limit: 200, sort: 'updated' })
          .items.map((p) => {
            const it = L().read(p.id);
            return { ...brief(p), status: p.projectStatus ?? 'active', kind: it.frontmatter.kind, intent: it.frontmatter.intent, sections: parseProject(it.body).material.map((s) => s.name).filter(Boolean) };
          }),
      ),
    ),
  );

  server.registerTool(
    'get_backlinks',
    {
      title: 'Backlinks',
      description: 'Items that link to the given item (including projects that reference it, with their per-project context).',
      inputSchema: { ref: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ ref }: { ref: string }) => {
      const item = resolve(ref);
      const lib = L();
      return json(lib.index.backlinks(item.id).map((b) => ({ ...brief(lib.index.getSummary(b.sourceId)!), kind: b.kind, section: b.section, context: b.context })));
    }),
  );

  server.registerTool(
    'get_graph',
    {
      title: 'Neighbourhood graph',
      description: 'Items connected to the given item within `depth` hops, with the links between them.',
      inputSchema: { ref: z.string(), depth: z.number().int().min(1).max(3).optional() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ ref, depth }: { ref: string; depth?: number }) => {
      const item = resolve(ref);
      const g = L().index.graph(item.id, depth ?? 1);
      const slug = new Map(g.nodes.map((n) => [n.id, n.slug]));
      return json({ center: item.slug, nodes: g.nodes.map(brief), edges: g.edges.map((e) => ({ from: slug.get(e.source), to: slug.get(e.target), kind: e.kind })) });
    }),
  );

  server.registerTool(
    'recall',
    {
      title: 'Recall memories',
      description: 'Search the memories agents have stored (short atomic facts about the owner and their work).',
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(30).optional() },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ query, limit }: { query: string; limit?: number }) => {
      const lib = L();
      const { hits } = await doSearch(query, 'memory', limit ?? 10);
      const out = hits
        .filter((h) => h.item.type === 'memory')
        .map((h) => {
          const it = lib.read(h.item.id);
          return { slug: it.slug, title: it.title, fact: it.body.trim(), agent: it.frontmatter.agent, created: it.created, tags: it.tags };
        });
      return json(out.length ? out : { memories: [], note: 'No matching memories.' });
    }),
  );

  // ---------------------------------------------------------------- write tools

  server.registerTool(
    'remember',
    {
      title: 'Remember a fact',
      description: 'Store a short, durable fact (one or two sentences) as a memory. Link related items with [[slug]]. Avoid duplicates: recall first.',
      inputSchema: { fact: z.string().min(3), title: z.string().optional(), tags: z.array(z.string()).optional() },
    },
    guard(async ({ fact, title, tags }: { fact: string; title?: string; tags?: string[] }) => {
      const t = title?.trim() || fact.replace(/\s+/g, ' ').slice(0, 72).replace(/[.,;:]?\s+\S*$/, '');
      const item = L().create({ type: 'memory', title: t, body: fact.trim() + '\n', tags, captured_via: via, frontmatter: { agent: deps.agent } }, author);
      deps.onChanged?.(item.id);
      return json({ remembered: true, slug: item.slug, id: item.id, path: item.path });
    }),
  );

  server.registerTool(
    'capture',
    {
      title: 'Capture into the inbox',
      description: 'Save a URL (article, video, PDF, image) or a piece of text/quote. Lands in the inbox unless a project is given. URLs are fetched in the background.',
      inputSchema: {
        url: z.string().optional(),
        text: z.string().optional(),
        kind: z.enum(['text', 'quote', 'note']).optional(),
        title: z.string().optional(),
        why: z.string().optional().describe('Why this is worth saving; may contain [[links]]'),
        tags: z.array(z.string()).optional(),
        project: z.string().optional().describe('Project slug or title to save straight into'),
        section: z.string().optional(),
        context: z.string().optional().describe('Why it matters to that project'),
        author: z.string().optional().describe('For quotes: who said it'),
      },
    },
    guard(async (a: any) => {
      if (!a.url && !a.text) return fail('Give a url or text.');
      const projectId = a.project ? resolve(a.project).id : undefined;
      if (deps.capture) {
        const r = await deps.capture({ ...a, projectId, via });
        return json({ id: r.item.id, slug: r.item.slug, title: r.item.title, type: r.item.type, status: r.item.status, duplicate: !!r.duplicate });
      }
      // Minimal fallback without the capture pipeline
      const item = L().create({ type: a.url ? 'link' : a.kind ?? 'text', title: a.title ?? (a.url || a.text.slice(0, 60)), body: a.text ?? '', why: a.why, tags: a.tags, captured_via: via, frontmatter: a.url ? { source: { url: a.url } } : undefined }, author);
      return json({ id: item.id, slug: item.slug, title: item.title });
    }),
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description: 'Write a new Markdown note. Use [[slug]] to link other items.',
      inputSchema: { title: z.string(), body: z.string(), tags: z.array(z.string()).optional() },
    },
    guard(async ({ title, body, tags }: { title: string; body: string; tags?: string[] }) => {
      const item = L().create({ type: 'note', title, body, tags, captured_via: via }, author);
      deps.onChanged?.(item.id);
      const lib = L();
      return json({ id: item.id, slug: item.slug, path: item.path, hash: item.hash, unresolved_links: lib.index.outgoing(item.id).filter((o) => !o.targetId).map((o) => o.target) });
    }),
  );

  server.registerTool(
    'update_note',
    {
      title: 'Update an item',
      description:
        'Change an item. Provide base_hash from get_item; if the file changed since, the update is refused so nothing is overwritten. `append` adds text to the end of the notes instead of replacing the body (base_hash optional).',
      inputSchema: {
        ref: z.string(),
        base_hash: z.string().optional(),
        body: z.string().optional(),
        append: z.string().optional(),
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
        why: z.string().optional(),
      },
    },
    guard(async (a: { ref: string; base_hash?: string; body?: string; append?: string; title?: string; tags?: string[]; why?: string }) => {
      const item = resolve(a.ref);
      if (a.body !== undefined && !a.base_hash) return fail('Replacing the body requires base_hash (from get_item). Use append to add text without it.');
      let body = a.body;
      if (a.append) {
        const base = body ?? item.body;
        const content = getSection(base, 'Content');
        if (content !== undefined && item.type !== 'note') {
          const idx = base.indexOf('## Content');
          body = base.slice(0, idx).replace(/\s+$/, '') + '\n\n' + a.append.trim() + '\n\n' + base.slice(idx);
        } else body = base.replace(/\s+$/, '') + '\n\n' + a.append.trim() + '\n';
      }
      const fm: Record<string, unknown> = {};
      if (a.title) fm.title = a.title;
      if (a.tags) fm.tags = a.tags;
      if (a.why !== undefined) fm.why = a.why;
      const updated = L().update(item.id, { body, frontmatter: fm, baseHash: a.base_hash ?? (a.append ? undefined : item.hash) }, author);
      deps.onChanged?.(updated.id);
      return json({ id: updated.id, slug: updated.slug, hash: updated.hash });
    }),
  );

  server.registerTool(
    'link_items',
    {
      title: 'Link two items',
      description: 'Add a [[link]] from one item to another (in its Related list), with an optional note on how they connect.',
      inputSchema: { from: z.string(), to: z.string(), note: z.string().optional() },
    },
    guard(async ({ from, to, note }: { from: string; to: string; note?: string }) => {
      const a = resolve(from);
      const b = resolve(to);
      const r = L().linkItems(a.id, b.id, author, note);
      return json({ from: r.slug, to: b.slug, linked: true });
    }),
  );

  server.registerTool(
    'add_to_project',
    {
      title: 'Add to a project',
      description: "Reference an existing item in a project's material, optionally in a named section and with per-project context. Content is never duplicated.",
      inputSchema: { project: z.string(), item: z.string(), section: z.string().optional(), context: z.string().optional() },
    },
    guard(async ({ project, item, section, context }: { project: string; item: string; section?: string; context?: string }) => {
      const p = resolve(project);
      const i = resolve(item);
      L().addToProject(p.id, i.id, { section, context }, author);
      return json({ project: p.slug, item: i.slug, section: section ?? null, added: true });
    }),
  );

  // ---------------------------------------------------------------- resources

  server.registerResource(
    'item',
    new ResourceTemplate('cabinet://item/{id}', {
      list: async () => ({
        resources: L()
          .index.list({ limit: 100, sort: 'updated' })
          .items.map((i) => ({ uri: `cabinet://item/${i.id}`, name: i.title, description: `${i.type}${i.why ? ': ' + i.why : ''}`, mimeType: 'text/markdown' })),
      }),
    }),
    { title: 'Cabinet item', description: 'An item from the library as Markdown (frontmatter + body).', mimeType: 'text/markdown' },
    async (uri, vars) => {
      const id = String(vars.id);
      const item = resolve(id);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: L().rawText(item.id) }] };
    },
  );

  return server;
}
