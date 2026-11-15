import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  ConflictError,
  NotFoundError,
  currentInterests,
  exportLibrary,
  ITEM_TYPES,
  revisit,
  validateExport,
  type Item,
  type LibraryEvent,
} from '@cabinet/core';
import { SESSION_COOKIE } from './auth.ts';
import { previewUrl } from './capture/web.ts';
import type { ServerContext, Vars } from './context.ts';
import { settingsRoutes } from './settings.ts';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function remoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

function errorResponse(c: Context, e: unknown) {
  if (e instanceof ConflictError) return c.json({ error: 'conflict', message: e.message, current: e.current }, 409);
  if (e instanceof NotFoundError) return c.json({ error: 'not_found', message: e.message }, 404);
  const msg = e instanceof Error ? e.message : String(e);
  return c.json({ error: 'bad_request', message: msg }, 400);
}

export function itemDetail(ctx: ServerContext, item: Item) {
  const lib = ctx.lib;
  const backlinks = lib.index
    .backlinks(item.id)
    .map((b) => ({ ...b, item: lib.index.getSummary(b.sourceId) }))
    .filter((b) => b.item);
  const outgoing = lib.index.outgoing(item.id).map((o) => ({ ...o, item: o.targetId ? lib.index.getSummary(o.targetId) : undefined }));
  const projects = lib.index
    .projectsFor(item.id)
    .map((p) => ({ ...p, project: lib.index.getSummary(p.projectId) }))
    .filter((p) => p.project);
  const suggestions = lib.state.suggestions({ itemId: item.id, status: 'pending' });
  return { item, backlinks, outgoing, projects, suggestions };
}

export function createApp(ctx: ServerContext) {
  const app = new Hono<Vars>();

  // ------------------------------------------------------------ auth middleware
  const guard = async (c: Context<Vars>, next: () => Promise<void>) => {
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const r = ctx.auth.check({ remote: remoteAddress(c), method: c.req.method, headers, cookie: getCookie(c, SESSION_COOKIE) });
    if (!r.ok) return c.json({ error: 'unauthorized', message: r.reason, passphrase: ctx.auth.hasPassphrase }, (r.status ?? 401) as 401);
    c.set('author', r.author);
    c.set('via', r.via);
    await next();
  };

  app.get('/api/health', (c) => c.json({ ok: true, version: ctx.version }));

  app.post('/api/auth/login', async (c) => {
    const { passphrase } = await c.req.json<{ passphrase: string }>().catch(() => ({ passphrase: '' }));
    if (!ctx.auth.hasPassphrase || !ctx.auth.checkPassphrase(passphrase ?? '')) {
      await new Promise((r) => setTimeout(r, 600));
      return c.json({ error: 'unauthorized', message: 'Wrong passphrase' }, 401);
    }
    setCookie(c, SESSION_COOKIE, ctx.auth.issueSession(), {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: 30 * 86400,
      secure: c.req.url.startsWith('https:'),
    });
    return c.json({ ok: true });
  });
  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path.startsWith('/api/auth/login') || c.req.path === '/api/auth/logout') return next();
    return guard(c, next);
  });
  app.use('/files/*', guard);
  app.use('/thumbs', guard);

  app.get('/api/auth/status', (c) => c.json({ ok: true, via: c.get('via'), author: c.get('author'), passphrase: ctx.auth.hasPassphrase }));

  // ------------------------------------------------------------ SSE
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: LibraryEvent[] = [];
      let wake: (() => void) | null = null;
      const onEvent = (e: LibraryEvent) => {
        queue.push(e);
        wake?.();
      };
      ctx.lib.on('event', onEvent);
      const lib = ctx.lib;
      let alive = true;
      stream.onAbort(() => {
        alive = false;
        wake?.();
      });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ version: ctx.version }) });
      while (alive) {
        if (!queue.length) {
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 25_000);
          });
          wake = null;
        }
        if (!alive) break;
        if (!queue.length) {
          await stream.writeSSE({ event: 'ping', data: '{}' });
          continue;
        }
        while (queue.length) {
          const e = queue.shift()!;
          await stream.writeSSE({ event: 'library', data: JSON.stringify(e) });
        }
      }
      lib.off('event', onEvent);
    }),
  );

  // ------------------------------------------------------------ items
  app.get('/api/items', (c) => {
    const q = c.req.query();
    const split = (v?: string) => (v ? v.split(',').filter(Boolean) : undefined);
    const r = ctx.lib.index.list({
      type: split(q.type),
      status: split(q.status),
      tag: q.tag,
      collection: q.collection,
      q: q.q,
      sort: (q.sort as any) ?? 'created',
      order: q.order as any,
      limit: Math.min(Number(q.limit ?? 60), 500),
      offset: Number(q.offset ?? 0),
      excludeTypes: split(q.exclude),
    });
    return c.json(r);
  });

  app.get('/api/items/:id', (c) => {
    try {
      const ref = c.req.param('id');
      const item = ctx.lib.find(ref);
      if (!item) return c.json({ error: 'not_found' }, 404);
      if (c.req.query('open') === '1') ctx.lib.state.recordOpen(item.id);
      return c.json(itemDetail(ctx, item));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get('/api/items/:id/raw', (c) => {
    try {
      return c.text(ctx.lib.rawText(c.req.param('id')));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post('/api/items', async (c) => {
    try {
      const b = await c.req.json<any>();
      if (!ITEM_TYPES.includes(b.type)) throw new Error('Unknown type');
      const item = ctx.lib.create(
        {
          type: b.type,
          title: b.title,
          body: b.body ?? '',
          why: b.why,
          tags: b.tags,
          collections: b.collections,
          status: b.status,
          frontmatter: b.frontmatter,
          captured_via: b.captured_via ?? (b.type === 'note' || b.type === 'project' ? undefined : 'web'),
        },
        c.get('author'),
      );
      ctx.ai?.onItemChanged(item.id, c.get('author'));
      return c.json(itemDetail(ctx, item), 201);
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.put('/api/items/:id', async (c) => {
    try {
      const b = await c.req.json<any>();
      const item = ctx.lib.update(
        c.req.param('id'),
        { body: b.body, frontmatter: b.frontmatter, baseHash: b.baseHash, renameFile: b.renameFile },
        c.get('author'),
      );
      ctx.ai?.onItemChanged(item.id, c.get('author'));
      return c.json(itemDetail(ctx, item));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post('/api/items/:id/rename', async (c) => {
    try {
      const { name } = await c.req.json<{ name: string }>();
      return c.json(itemDetail(ctx, ctx.lib.rename(c.req.param('id'), name, c.get('author'))));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.delete('/api/items/:id', (c) => {
    try {
      ctx.lib.delete(c.req.param('id'), c.get('author'));
      return c.json({ ok: true });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post('/api/items/:id/link', async (c) => {
    try {
      const { targetId, note } = await c.req.json<{ targetId: string; note?: string }>();
      return c.json(itemDetail(ctx, ctx.lib.linkItems(c.req.param('id'), targetId, c.get('author'), note)));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post('/api/items/:id/project', async (c) => {
    try {
      const { projectId, section, context } = await c.req.json<{ projectId: string; section?: string; context?: string }>();
      ctx.lib.addToProject(projectId, c.req.param('id'), { section, context }, c.get('author'));
      return c.json(itemDetail(ctx, ctx.lib.read(c.req.param('id'))));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  /** Conflict resolution: save my version as a new copy. */
  app.post('/api/items/:id/copy', async (c) => {
    try {
      const { body, frontmatter } = await c.req.json<any>();
      const orig = ctx.lib.read(c.req.param('id'));
      const fm = { ...orig.frontmatter, ...(frontmatter ?? {}) } as any;
      delete fm.id;
      const item = ctx.lib.create(
        {
          type: orig.type,
          title: `${fm.title ?? orig.title} (my copy)`,
          body: body ?? orig.body,
          why: fm.why,
          tags: fm.tags,
          collections: fm.collections,
          status: orig.status,
          frontmatter: Object.fromEntries(Object.entries(fm).filter(([k]) => !['type', 'title', 'created', 'updated', 'why', 'tags', 'collections', 'status'].includes(k))),
        },
        c.get('author'),
      );
      return c.json(itemDetail(ctx, item), 201);
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post('/api/items/:id/content', async (c) => {
    try {
      const { content } = await c.req.json<{ content: string }>();
      return c.json(itemDetail(ctx, ctx.capture.setManualContent(c.req.param('id'), content, c.get('author'))));
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post('/api/items/:id/refetch', (c) => {
    try {
      ctx.capture.refetch(c.req.param('id'), c.get('author'));
      return c.json({ ok: true });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get('/api/items/:id/graph', (c) => {
    try {
      const item = ctx.lib.find(c.req.param('id'));
      if (!item) return c.json({ error: 'not_found' }, 404);
      const depth = Math.max(1, Math.min(3, Number(c.req.query('depth') ?? 1)));
      const types = c.req.query('types')?.split(',').filter(Boolean);
      return c.json({ center: item.id, ...ctx.lib.index.graph(item.id, depth, types) });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.get('/api/items/:id/history', async (c) => {
    const path = ctx.lib.index.pathForId(c.req.param('id'));
    if (!path || !ctx.lib.git) return c.json({ commits: [] });
    return c.json({ commits: await ctx.lib.git.log(20, path) });
  });

  app.get('/api/items/:id/related', async (c) => {
    try {
      const item = ctx.lib.read(c.req.param('id'));
      const text = [item.title, item.why ?? '', item.tags.join(' '), item.body.slice(0, 2000)].join('\n');
      const linked = new Set([item.id, ...ctx.lib.index.outgoing(item.id).map((o) => o.targetId), ...ctx.lib.index.backlinks(item.id).map((b) => b.sourceId)]);
      const hits = ctx.ai
        ? await ctx.ai.related(text, { excludeIds: [...linked].filter(Boolean) as string[], limit: 8 })
        : keywordRelated(ctx, text, [...linked].filter(Boolean) as string[], 8);
      return c.json({ hits });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // ------------------------------------------------------------ lookup / autocomplete
  app.get('/api/resolve', (c) => {
    const id = ctx.lib.resolveLink(c.req.query('ref') ?? '');
    return c.json({ id, item: id ? ctx.lib.index.getSummary(id) : null });
  });

  app.get('/api/suggest', (c) => {
    const q = (c.req.query('q') ?? '').trim();
    const types = c.req.query('type')?.split(',').filter(Boolean);
    const limit = Number(c.req.query('limit') ?? 8);
    const params: unknown[] = [];
    let where = '1=1';
    if (types?.length) {
      where += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }
    let rows: any[];
    if (!q) {
      rows = ctx.lib.index.db.prepare(`SELECT id FROM items WHERE ${where} ORDER BY updated DESC LIMIT ?`).all(...(params as any[]), limit);
    } else {
      rows = ctx.lib.index.db
        .prepare(
          `SELECT id, CASE WHEN lower(title) = lower(?) OR lower(slug) = lower(?) THEN 0
                  WHEN lower(title) LIKE lower(?) OR slug LIKE lower(?) THEN 1 ELSE 2 END AS rank
           FROM items WHERE ${where} AND (title LIKE ? OR slug LIKE ?) ORDER BY rank, length(title) LIMIT ?`,
        )
        .all(q, q, q + '%', q + '%', ...(params as any[]), '%' + q + '%', '%' + q.replace(/\s+/g, '-') + '%', limit);
      if (rows.length < limit) {
        const more = ctx.lib.index.search(q, { limit, type: types }).map((h) => ({ id: h.item.id }));
        for (const m of more) if (!rows.some((r) => r.id === m.id)) rows.push(m);
      }
    }
    return c.json({ items: ctx.lib.index.getSummaries(rows.slice(0, limit).map((r) => r.id)) });
  });

  // ------------------------------------------------------------ search
  app.get('/api/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json({ hits: [], mode: 'keyword' });
    const opts = {
      type: c.req.query('type')?.split(',').filter(Boolean),
      status: c.req.query('status')?.split(',').filter(Boolean),
      tag: c.req.query('tag') || undefined,
      limit: Number(c.req.query('limit') ?? 40),
    };
    const t = performance.now();
    if (ctx.ai && c.req.query('mode') !== 'keyword') {
      const r = await ctx.ai.search(q, opts);
      return c.json({ ...r, ms: Math.round(performance.now() - t) });
    }
    return c.json({ hits: ctx.lib.index.search(q, opts), mode: 'keyword', ms: Math.round(performance.now() - t) });
  });

  /** "Connects to…" for the capture sheet: related items for free text. */
  app.post('/api/related', async (c) => {
    const { text, exclude } = await c.req.json<{ text: string; exclude?: string[] }>();
    if (!text?.trim()) return c.json({ hits: [] });
    const hits = ctx.ai ? await ctx.ai.related(text, { excludeIds: exclude, limit: 6 }) : keywordRelated(ctx, text, exclude ?? [], 6);
    return c.json({ hits });
  });

  // ------------------------------------------------------------ home
  app.get('/api/home', (c) => {
    const lib = ctx.lib;
    const now = new Date();
    const interests = currentInterests(lib.index, now);
    const recent = lib.index.list({ excludeTypes: ['project', 'collection', 'memory'], limit: 12, sort: 'created' }).items;
    const counts = lib.index.counts();
    const digest = lib.state.digests(1)[0] ?? null;
    return c.json({
      interests,
      recent,
      counts,
      revisit: revisit(lib.index, lib.state, { now }),
      digest,
      jobs: ctx.jobs.pending,
    });
  });

  app.get('/api/tags', (c) => c.json({ tags: ctx.lib.index.allTags() }));
  app.get('/api/collections', (c) => {
    const counts = ctx.lib.index.allCollections();
    const docs = ctx.lib.index.list({ type: 'collection', limit: 500, sort: 'title' }).items;
    const names = new Set([...counts.map((x) => x.name), ...docs.map((d) => d.title)]);
    const out = [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
      const doc = docs.find((d) => d.title.toLowerCase() === name.toLowerCase());
      const count = counts.find((x) => x.name.toLowerCase() === name.toLowerCase())?.count ?? 0;
      const sample = ctx.lib.index.list({ collection: name, limit: 4, sort: 'created' }).items;
      return { name, count, doc: doc ?? null, sample };
    });
    return c.json({ collections: out });
  });

  // ------------------------------------------------------------ capture
  app.post('/api/capture/preview', async (c) => {
    const { url } = await c.req.json<{ url: string }>();
    try {
      const { normalizeUrl } = await import('./capture/web.ts');
      const u = normalizeUrl(url);
      const existing = ctx.capture.findByUrl(u);
      const p = await previewUrl(u, 2500);
      if (p.image) void ctx.thumbs.get(p.image, 480);
      return c.json({ preview: p, existing: existing ? ctx.lib.index.getSummary(existing.id) : null });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.post('/api/capture', async (c) => {
    try {
      const ct = c.req.header('content-type') ?? '';
      const author = c.get('author');
      if (ct.includes('multipart/form-data')) {
        const form = await c.req.parseBody({ all: true });
        const file = form.file as File | undefined;
        const ctxFields = parseCtxFields(form);
        if (!file || typeof file === 'string') throw new Error('No file');
        const r = ctx.capture.captureFile({ data: new Uint8Array(await file.arrayBuffer()), filename: file.name, mime: file.type, ...ctxFields }, author);
        return c.json({ ...itemDetail(ctx, r.item), duplicate: !!r.duplicate }, 201);
      }
      const b = await c.req.json<any>();
      const fields = {
        why: b.why,
        tags: b.tags,
        collections: b.collections,
        projectId: b.projectId,
        section: b.section,
        context: b.context,
        links: b.links,
        status: b.status,
        title: b.title,
        via: b.via,
      };
      const r = b.url
        ? ctx.capture.captureUrl({ url: b.url, preview: b.preview, ...fields }, author)
        : ctx.capture.captureText({ text: b.text ?? '', kind: b.kind, author: b.author, sourceUrl: b.sourceUrl, ...fields }, author);
      return c.json({ ...itemDetail(ctx, r.item), duplicate: !!r.duplicate }, r.duplicate ? 200 : 201);
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  // ------------------------------------------------------------ files
  app.get('/files/*', (c) => {
    const rel = decodeURIComponent(c.req.path.slice('/files/'.length));
    if (!rel.startsWith('attachments/') || rel.split('/').includes('..')) return c.text('Not found', 404);
    let abs: string;
    try {
      abs = ctx.lib.abs(rel);
    } catch {
      return c.text('Not found', 404);
    }
    if (!existsSync(abs)) return c.text('Not found', 404);
    const size = statSync(abs).size;
    const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    const range = c.req.header('range');
    const headers: Record<string, string> = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    };
    if (type === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'";
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m?.[1] ? Number(m[1]) : 0;
      const end = m?.[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      const stream = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
      return new Response(stream, { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
    }
    return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, { headers: { ...headers, 'content-length': String(size) } });
  });

  app.get('/thumbs', async (c) => {
    const src = c.req.query('src') ?? '';
    const w = Number(c.req.query('w') ?? 480);
    if (!src) return c.text('Missing src', 400);
    const p = await ctx.thumbs.get(src, w);
    if (!p) return c.text('Not found', 404);
    return new Response(readFileSync(p), { headers: { 'content-type': 'image/webp', 'cache-control': 'private, max-age=86400' } });
  });

  // ------------------------------------------------------------ maintenance
  app.post('/api/rebuild', async (c) => {
    const r = ctx.lib.rebuild();
    let embedded = 0;
    if (ctx.ai && c.req.query('embeddings') === '1') embedded = (await ctx.ai.reindexAll()).embedded;
    return c.json({ ...r, embedded });
  });

  app.get('/api/export', async (c) => {
    await ctx.lib.git?.flush();
    const zip = exportLibrary(ctx.lib.root, { includeGit: c.req.query('git') === '1' });
    const name = `cabinet-${new Date().toISOString().slice(0, 10)}.zip`;
    return new Response(zip as unknown as BodyInit, {
      headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}"`, 'content-length': String(zip.byteLength) },
    });
  });

  app.post('/api/restore', async (c) => {
    try {
      const form = await c.req.parseBody();
      const file = form.file as File | undefined;
      if (!file || typeof file === 'string') throw new Error('No file');
      const data = new Uint8Array(await file.arrayBuffer());
      const v = validateExport(data);
      if (!v.ok) return c.json({ error: 'invalid', errors: v.errors }, 400);
      if (c.req.query('dryRun') === '1') return c.json({ ok: true, files: v.files });
      const { restoreLibrary } = await import('@cabinet/core');
      const root = ctx.lib.root;
      await ctx.lib.close();
      const r = restoreLibrary(root, data);
      await ctx.reopen();
      const rebuilt = ctx.lib.rebuild();
      return c.json({ ok: true, backup: r.backup, files: r.files, items: rebuilt.items });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  app.route('/api/settings', settingsRoutes(ctx));

  // ------------------------------------------------------------ AI routes (filled when AI is enabled)
  app.get('/api/ai/status', async (c) => c.json(ctx.ai ? await ctx.ai.status() : { provider: 'none', chat: false, embeddings: false, reason: 'AI disabled' }));
  app.get('/api/suggestions', (c) => {
    const status = (c.req.query('status') as any) ?? 'pending';
    const list = ctx.lib.state.suggestions({ status, itemId: c.req.query('item') || undefined });
    return c.json({ suggestions: list.map((s) => ({ ...s, item: ctx.lib.index.getSummary(s.itemId) })).filter((s) => s.item) });
  });
  app.post('/api/suggestions/:id/accept', async (c) => {
    try {
      if (!ctx.ai) throw new Error('AI disabled');
      await ctx.ai.acceptSuggestion(c.req.param('id'), c.get('author'));
      return c.json({ ok: true });
    } catch (e) {
      return errorResponse(c, e);
    }
  });
  app.post('/api/suggestions/:id/dismiss', (c) => {
    ctx.lib.state.setSuggestionStatus(c.req.param('id'), 'dismissed');
    ctx.lib.emit('event', { kind: 'suggestions', origin: 'app' });
    return c.json({ ok: true });
  });
  app.post('/api/items/:id/enrich', async (c) => {
    if (!ctx.ai) return c.json({ error: 'AI disabled' }, 400);
    ctx.jobs.add({ key: `enrich:${c.req.param('id')}`, label: 'Thinking about this item', itemId: c.req.param('id'), run: () => ctx.ai!.enrich(c.req.param('id')) });
    return c.json({ ok: true, queued: true });
  });
  app.get('/api/digests', (c) => c.json({ digests: ctx.lib.state.digests(10) }));
  app.post('/api/digests/run', async (c) => {
    if (!ctx.ai) return c.json({ error: 'AI disabled' }, 400);
    try {
      return c.json({ digest: await ctx.ai.runInboxAgent() });
    } catch (e) {
      return errorResponse(c, e);
    }
  });
  app.post('/api/digests/:id/seen', (c) => {
    ctx.lib.state.markDigest(c.req.param('id'), 'seen');
    return c.json({ ok: true });
  });
  app.post('/api/chat', async (c) => {
    if (!ctx.ai) return c.json({ error: 'AI disabled' }, 400);
    const body = await c.req.json<any>();
    return ctx.ai.chat(body);
  });
  app.get('/api/chats', (c) => c.json({ chats: ctx.lib.state.chats() }));
  app.get('/api/chats/:id', (c) => {
    const chat = ctx.lib.state.getChat(c.req.param('id'));
    return chat ? c.json(chat) : c.json({ error: 'not_found' }, 404);
  });

  // ------------------------------------------------------------ extras (MCP, etc.)
  for (const mount of ctx.extras.mounts ?? []) mount(app, guard);

  // ------------------------------------------------------------ web app
  if (ctx.webDist && existsSync(ctx.webDist)) {
    const dist = ctx.webDist;
    app.use('/assets/*', serveStatic({ root: dist }));
    app.use('/*', serveStatic({ root: dist }));
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
      return c.html(readFileSync(join(dist, 'index.html'), 'utf8'));
    });
  } else {
    app.get('/', (c) => c.text('Cabinet server is running. Build the web app with `pnpm build` or run `pnpm dev`.'));
  }

  return app;
}

function parseCtxFields(form: Record<string, any>) {
  const str = (k: string) => (typeof form[k] === 'string' && form[k] ? (form[k] as string) : undefined);
  const list = (k: string) => {
    const v = form[k] ?? form[k + '[]'];
    if (!v) return undefined;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    return arr.map((x: any) => String(x).trim()).filter(Boolean);
  };
  return {
    why: str('why'),
    tags: list('tags'),
    collections: list('collections'),
    projectId: str('projectId'),
    section: str('section'),
    context: str('context'),
    links: list('links'),
    title: str('title'),
    via: str('via'),
    status: str('status') as any,
  };
}

export function keywordRelated(ctx: ServerContext, text: string, exclude: string[], limit: number) {
  // Use the most distinctive words of the text as an OR query.
  const stop = new Set('the a an and or of to in on for with is are was be this that it as at by from i my me you your we our about into not but have has'.split(' '));
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !stop.has(w)).slice(0, 14);
  if (!words.length) return [];
  const hits = ctx.lib.index.search(words.join(' '), { limit: limit + exclude.length + 4, excludeIds: exclude });
  return hits
    .filter((h) => !['collection'].includes(h.item.type))
    .slice(0, limit)
    .map((h) => ({ item: h.item, score: h.score, reason: 'keyword' as const }));
}
