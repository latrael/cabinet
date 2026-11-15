import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IndexRecord } from './item.ts';
import { linkKey } from './links.ts';
import type { ItemSummary, LinkKind, MatchField, SearchHit } from './types.ts';

const SCHEMA_VERSION = '3';

export interface ListQuery {
  type?: string | string[];
  status?: string | string[];
  tag?: string;
  collection?: string;
  q?: string;
  sort?: 'created' | 'updated' | 'title';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  excludeTypes?: string[];
}

export interface Backlink {
  sourceId: string;
  kind: LinkKind;
  context?: string;
  section?: string;
  alias?: string;
}

export interface OutLink {
  target: string;
  targetId: string | null;
  kind: LinkKind;
  alias?: string;
  context?: string;
  section?: string;
}

export interface SearchOptions {
  type?: string | string[];
  status?: string | string[];
  tag?: string;
  limit?: number;
  excludeIds?: string[];
}

type Row = Record<string, any>;

const SUMMARY_COLS =
  'id, path, slug, type, title, status, created, updated, why, tags, collections, url, site, cover, attachment, excerpt, extraction, project_status';

export function rowToSummary(r: Row): ItemSummary {
  return {
    id: r.id,
    path: r.path,
    slug: r.slug,
    type: r.type,
    title: r.title,
    status: r.status,
    created: r.created,
    updated: r.updated,
    why: r.why ?? undefined,
    tags: JSON.parse(r.tags || '[]'),
    collections: JSON.parse(r.collections || '[]'),
    url: r.url ?? undefined,
    site: r.site ?? undefined,
    cover: r.cover ?? undefined,
    attachment: r.attachment ?? undefined,
    excerpt: r.excerpt ?? undefined,
    extraction: r.extraction ?? undefined,
    projectStatus: r.project_status ?? undefined,
  };
}

/** Turn free text into a safe FTS5 query: every token quoted, last one prefix-matched. */
export function ftsQuery(input: string, mode: 'and' | 'or' = 'and'): string | null {
  const tokens = input
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!tokens.length) return null;
  const parts = tokens.map((t, i) => `"${t.replace(/"/g, '')}"${i === tokens.length - 1 && t.length >= 2 ? '*' : ''}`);
  return parts.join(mode === 'and' ? ' ' : ' OR ');
}

function inClause(col: string, values: string | string[] | undefined, params: unknown[]): string {
  if (!values || (Array.isArray(values) && !values.length)) return '';
  const arr = Array.isArray(values) ? values : [values];
  params.push(...arr);
  return ` AND ${col} IN (${arr.map(() => '?').join(',')})`;
}

/**
 * The disposable SQLite index. Everything here can be rebuilt from the Markdown files.
 */
export class LibraryIndex {
  db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
    this.migrate();
  }

  private migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    const v = (this.db.prepare("SELECT value FROM meta WHERE key='schema'").get() as Row | undefined)?.value;
    if (v !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS items; DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS keys;
        DROP TABLE IF EXISTS tags; DROP TABLE IF EXISTS item_collections; DROP TABLE IF EXISTS fts;
      `);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        n INTEGER PRIMARY KEY,
        id TEXT UNIQUE NOT NULL,
        path TEXT UNIQUE NOT NULL,
        slug TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created TEXT, updated TEXT, why TEXT,
        tags TEXT, collections TEXT,
        url TEXT, site TEXT, cover TEXT, attachment TEXT,
        excerpt TEXT, extraction TEXT, project_status TEXT,
        hash TEXT NOT NULL, mtime REAL,
        notes TEXT, content TEXT
      );
      CREATE INDEX IF NOT EXISTS items_type ON items(type);
      CREATE INDEX IF NOT EXISTS items_created ON items(created);
      CREATE TABLE IF NOT EXISTS links (
        src TEXT NOT NULL, target TEXT NOT NULL, target_key TEXT NOT NULL, kind TEXT NOT NULL,
        alias TEXT, context TEXT, section TEXT, ord INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS links_src ON links(src);
      CREATE INDEX IF NOT EXISTS links_key ON links(target_key);
      CREATE TABLE IF NOT EXISTS keys (key TEXT NOT NULL, item_id TEXT NOT NULL, priority INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS keys_key ON keys(key);
      CREATE INDEX IF NOT EXISTS keys_item ON keys(item_id);
      CREATE TABLE IF NOT EXISTS tags (item_id TEXT NOT NULL, tag TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
      CREATE INDEX IF NOT EXISTS tags_item ON tags(item_id);
      CREATE TABLE IF NOT EXISTS item_collections (item_id TEXT NOT NULL, name TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ic_name ON item_collections(name);
      CREATE INDEX IF NOT EXISTS ic_item ON item_collections(item_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        title, why, notes, content, tags,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `);
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  close() {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  clear() {
    this.db.exec('DELETE FROM items; DELETE FROM links; DELETE FROM keys; DELETE FROM tags; DELETE FROM item_collections; DELETE FROM fts;');
  }

  upsert(rec: IndexRecord, mtime = 0) {
    const s = rec.summary;
    const existingByPath = this.stmt('SELECT id FROM items WHERE path = ?').get(rec.item.path) as Row | undefined;
    if (existingByPath && existingByPath.id !== s.id) this.remove(existingByPath.id);
    const existing = this.stmt('SELECT n FROM items WHERE id = ?').get(s.id) as Row | undefined;
    const values = [
      s.id, s.path, s.slug, s.type, s.title, s.status, s.created, s.updated, s.why ?? null,
      JSON.stringify(s.tags), JSON.stringify(s.collections), s.url ?? null, s.site ?? null, s.cover ?? null,
      s.attachment ?? null, s.excerpt ?? null, s.extraction ?? null, s.projectStatus ?? null,
      rec.item.hash, mtime, rec.notes, rec.content,
    ];
    let n: number;
    if (existing) {
      n = existing.n;
      this.stmt(
        `UPDATE items SET id=?, path=?, slug=?, type=?, title=?, status=?, created=?, updated=?, why=?, tags=?, collections=?,
         url=?, site=?, cover=?, attachment=?, excerpt=?, extraction=?, project_status=?, hash=?, mtime=?, notes=?, content=? WHERE n=?`,
      ).run(...(values as any[]), n);
      this.stmt('DELETE FROM fts WHERE rowid = ?').run(n);
    } else {
      const r = this.stmt(
        `INSERT INTO items (id, path, slug, type, title, status, created, updated, why, tags, collections, url, site, cover,
         attachment, excerpt, extraction, project_status, hash, mtime, notes, content) VALUES (${values.map(() => '?').join(',')})`,
      ).run(...(values as any[]));
      n = Number(r.lastInsertRowid);
    }
    this.stmt('INSERT INTO fts (rowid, title, why, notes, content, tags) VALUES (?, ?, ?, ?, ?, ?)').run(
      n, s.title, s.why ?? '', rec.notes, rec.content, s.tags.join(' '),
    );
    this.stmt('DELETE FROM links WHERE src = ?').run(s.id);
    rec.links.forEach((l, i) =>
      this.stmt('INSERT INTO links (src, target, target_key, kind, alias, context, section, ord) VALUES (?,?,?,?,?,?,?,?)').run(
        s.id, l.target, l.key, l.kind, l.alias ?? null, l.context ?? null, l.section ?? null, i,
      ),
    );
    this.stmt('DELETE FROM keys WHERE item_id = ?').run(s.id);
    for (const k of rec.keys) this.stmt('INSERT INTO keys (key, item_id, priority) VALUES (?,?,?)').run(k.key, s.id, k.priority);
    this.stmt('DELETE FROM tags WHERE item_id = ?').run(s.id);
    for (const t of new Set(s.tags.map((t) => t.toLowerCase()))) this.stmt('INSERT INTO tags (item_id, tag) VALUES (?,?)').run(s.id, t);
    this.stmt('DELETE FROM item_collections WHERE item_id = ?').run(s.id);
    for (const c of new Set(s.collections)) this.stmt('INSERT INTO item_collections (item_id, name) VALUES (?,?)').run(s.id, c);
  }

  remove(id: string) {
    const row = this.stmt('SELECT n FROM items WHERE id = ?').get(id) as Row | undefined;
    if (!row) return;
    this.stmt('DELETE FROM fts WHERE rowid = ?').run(row.n);
    this.stmt('DELETE FROM items WHERE n = ?').run(row.n);
    this.stmt('DELETE FROM links WHERE src = ?').run(id);
    this.stmt('DELETE FROM keys WHERE item_id = ?').run(id);
    this.stmt('DELETE FROM tags WHERE item_id = ?').run(id);
    this.stmt('DELETE FROM item_collections WHERE item_id = ?').run(id);
  }

  // ---------------------------------------------------------------- lookups

  fileState(): Map<string, { id: string; hash: string; mtime: number }> {
    const m = new Map<string, { id: string; hash: string; mtime: number }>();
    for (const r of this.stmt('SELECT id, path, hash, mtime FROM items').all() as Row[]) m.set(r.path, { id: r.id, hash: r.hash, mtime: r.mtime });
    return m;
  }

  getSummary(id: string): ItemSummary | undefined {
    const r = this.stmt(`SELECT ${SUMMARY_COLS} FROM items WHERE id = ?`).get(id) as Row | undefined;
    return r ? rowToSummary(r) : undefined;
  }

  getSummaries(ids: string[]): ItemSummary[] {
    if (!ids.length) return [];
    const rows = this.db.prepare(`SELECT ${SUMMARY_COLS} FROM items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[];
    const byId = new Map(rows.map((r) => [r.id, rowToSummary(r)]));
    return ids.map((id) => byId.get(id)).filter((x): x is ItemSummary => !!x);
  }

  pathForId(id: string): string | undefined {
    return (this.stmt('SELECT path FROM items WHERE id = ?').get(id) as Row | undefined)?.path;
  }

  idForPath(path: string): string | undefined {
    return (this.stmt('SELECT id FROM items WHERE path = ?').get(path) as Row | undefined)?.id;
  }

  textFor(id: string): { title: string; why: string; notes: string; content: string; tags: string } | undefined {
    return this.stmt('SELECT title, why, notes, content, tags FROM items WHERE id = ?').get(id) as any;
  }

  /** Resolve a link target (slug, id, title, alias or attachment name) to an item id. */
  resolve(target: string): string | null {
    const key = linkKey(target);
    const r = this.stmt('SELECT item_id FROM keys WHERE key = ? ORDER BY priority LIMIT 1').get(key) as Row | undefined;
    if (r) return r.item_id;
    const r2 = this.stmt('SELECT item_id FROM keys WHERE key = ? ORDER BY priority LIMIT 1').get(target.trim().toLowerCase()) as Row | undefined;
    return r2?.item_id ?? null;
  }

  slugExists(slug: string): boolean {
    return !!this.stmt('SELECT 1 FROM items WHERE lower(slug) = lower(?)').get(slug);
  }

  list(q: ListQuery = {}): { items: ItemSummary[]; total: number } {
    const params: unknown[] = [];
    let where = 'WHERE 1=1';
    where += inClause('i.type', q.type, params);
    where += inClause('i.status', q.status, params);
    if (q.excludeTypes?.length) {
      where += ` AND i.type NOT IN (${q.excludeTypes.map(() => '?').join(',')})`;
      params.push(...q.excludeTypes);
    }
    if (q.tag) {
      where += ' AND i.id IN (SELECT item_id FROM tags WHERE tag = ?)';
      params.push(q.tag.toLowerCase());
    }
    if (q.collection) {
      where += ' AND i.id IN (SELECT item_id FROM item_collections WHERE name = ?)';
      params.push(q.collection);
    }
    if (q.q) {
      const fq = ftsQuery(q.q);
      if (fq) {
        where += ' AND i.n IN (SELECT rowid FROM fts WHERE fts MATCH ?)';
        params.push(fq);
      }
    }
    const sort = q.sort === 'title' ? 'i.title COLLATE NOCASE' : q.sort === 'updated' ? 'i.updated' : 'i.created';
    const order = q.order ?? (q.sort === 'title' ? 'asc' : 'desc');
    const total = (this.db.prepare(`SELECT count(*) c FROM items i ${where}`).get(...(params as any[])) as Row).c;
    const rows = this.db
      .prepare(`SELECT ${SUMMARY_COLS.split(', ').map((c) => 'i.' + c).join(', ')} FROM items i ${where} ORDER BY ${sort} ${order}, i.id ${order} LIMIT ? OFFSET ?`)
      .all(...(params as any[]), q.limit ?? 100, q.offset ?? 0) as Row[];
    return { items: rows.map(rowToSummary), total };
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.stmt('SELECT type, count(*) c FROM items GROUP BY type').all() as Row[]) out[r.type] = r.c;
    const inbox = this.stmt("SELECT count(*) c FROM items WHERE status = 'inbox'").get() as Row;
    out.inbox = inbox.c;
    out.total = (this.stmt('SELECT count(*) c FROM items').get() as Row).c;
    return out;
  }

  allTags(): Array<{ tag: string; count: number; lastUsed: string }> {
    return (
      this.stmt(
        'SELECT t.tag tag, count(*) count, max(i.created) lastUsed FROM tags t JOIN items i ON i.id = t.item_id GROUP BY t.tag ORDER BY count DESC, t.tag',
      ).all() as Row[]
    ).map((r) => ({ tag: r.tag, count: r.count, lastUsed: r.lastUsed }));
  }

  allCollections(): Array<{ name: string; count: number }> {
    return (this.stmt('SELECT name, count(*) count FROM item_collections GROUP BY name ORDER BY name').all() as Row[]).map((r) => ({
      name: r.name,
      count: r.count,
    }));
  }

  outgoing(id: string): OutLink[] {
    return (this.stmt('SELECT target, target_key, kind, alias, context, section FROM links WHERE src = ? ORDER BY ord').all(id) as Row[]).map(
      (r) => ({
        target: r.target,
        targetId: this.resolveKey(r.target_key),
        kind: r.kind,
        alias: r.alias ?? undefined,
        context: r.context ?? undefined,
        section: r.section ?? undefined,
      }),
    );
  }

  private resolveKey(key: string): string | null {
    const r = this.stmt('SELECT item_id FROM keys WHERE key = ? ORDER BY priority LIMIT 1').get(key) as Row | undefined;
    return r?.item_id ?? null;
  }

  backlinks(id: string): Backlink[] {
    const rows = this.stmt(
      `SELECT l.src, l.kind, l.context, l.section, l.alias, l.target_key FROM links l
       WHERE l.target_key IN (SELECT key FROM keys WHERE item_id = ?) AND l.src != ?`,
    ).all(id, id) as Row[];
    const out: Backlink[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (this.resolveKey(r.target_key) !== id) continue;
      const k = r.src + '|' + r.kind + '|' + (r.section ?? '');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ sourceId: r.src, kind: r.kind, context: r.context ?? undefined, section: r.section ?? undefined, alias: r.alias ?? undefined });
    }
    return out;
  }

  /** All resolved edges between items. */
  edges(): Array<{ source: string; target: string; kind: LinkKind }> {
    const rows = this.stmt(
      `SELECT l.src source, (SELECT item_id FROM keys k WHERE k.key = l.target_key ORDER BY priority LIMIT 1) target, l.kind kind FROM links l`,
    ).all() as Row[];
    const seen = new Set<string>();
    const out: Array<{ source: string; target: string; kind: LinkKind }> = [];
    for (const r of rows) {
      if (!r.target || r.target === r.source) continue;
      const k = r.source + '>' + r.target;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ source: r.source, target: r.target, kind: r.kind });
    }
    return out;
  }

  /** Neighbourhood graph around `id` up to `depth` hops (both directions). */
  graph(id: string, depth = 1, types?: string[]): { nodes: ItemSummary[]; edges: Array<{ source: string; target: string; kind: LinkKind }> } {
    const all = this.edges();
    const adj = new Map<string, Set<string>>();
    for (const e of all) {
      if (!adj.has(e.source)) adj.set(e.source, new Set());
      if (!adj.has(e.target)) adj.set(e.target, new Set());
      adj.get(e.source)!.add(e.target);
      adj.get(e.target)!.add(e.source);
    }
    const typeOk = (nid: string) => {
      if (!types?.length || nid === id) return true;
      const t = (this.stmt('SELECT type FROM items WHERE id = ?').get(nid) as Row | undefined)?.type;
      return t ? types.includes(t) : false;
    };
    const seen = new Set([id]);
    let frontier = [id];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const m of adj.get(n) ?? []) {
          if (seen.has(m) || !typeOk(m)) continue;
          seen.add(m);
          next.push(m);
        }
      }
      frontier = next;
    }
    const nodes = this.getSummaries([...seen]);
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: all.filter((e) => ids.has(e.source) && ids.has(e.target)) };
  }

  /** Projects that reference an item via Material. */
  projectsFor(id: string): Array<{ projectId: string; section?: string; context?: string }> {
    return this.backlinks(id)
      .filter((b) => b.kind === 'material')
      .map((b) => ({ projectId: b.sourceId, section: b.section, context: b.context }));
  }

  // ---------------------------------------------------------------- search

  /** Keyword search with BM25 ranking and match-location labels. */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const limit = opts.limit ?? 30;
    let hits = this.runFts(query, 'and', opts, limit);
    if (!hits.length) hits = this.runFts(query, 'or', opts, limit);
    return hits;
  }

  private runFts(query: string, mode: 'and' | 'or', opts: SearchOptions, limit: number): SearchHit[] {
    const fq = ftsQuery(query, mode);
    if (!fq) return [];
    const params: unknown[] = [fq];
    let where = '';
    where += inClause('i.type', opts.type, params);
    where += inClause('i.status', opts.status, params);
    if (opts.tag) {
      where += ' AND i.id IN (SELECT item_id FROM tags WHERE tag = ?)';
      params.push(opts.tag.toLowerCase());
    }
    if (opts.excludeIds?.length) {
      where += ` AND i.id NOT IN (${opts.excludeIds.map(() => '?').join(',')})`;
      params.push(...opts.excludeIds);
    }
    const S = (col: number) => `snippet(fts, ${col}, '«', '»', '…', 14)`;
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLS.split(', ').map((c) => 'i.' + c).join(', ')},
          bm25(fts, 10.0, 5.0, 3.0, 1.0, 6.0) AS score,
          ${S(0)} s_title, ${S(1)} s_why, ${S(2)} s_notes, ${S(3)} s_content, ${S(4)} s_tags
         FROM fts JOIN items i ON i.n = fts.rowid
         WHERE fts MATCH ? ${where}
         ORDER BY score LIMIT ?`,
      )
      .all(...(params as any[]), limit) as Row[];
    return rows.map((r) => {
      const summary = rowToSummary(r);
      const has = (s: string | null) => !!s && s.includes('«');
      let field: MatchField;
      let snippet: string;
      if (has(r.s_title)) {
        field = 'title';
        snippet = has(r.s_why) ? r.s_why : has(r.s_notes) ? r.s_notes : has(r.s_content) ? r.s_content : r.s_title;
      } else if (has(r.s_why)) {
        field = 'note';
        snippet = r.s_why;
      } else if (has(r.s_notes)) {
        field = 'note';
        snippet = r.s_notes;
      } else if (has(r.s_tags)) {
        field = 'tag';
        snippet = '#' + String(r.s_tags).split(' ').join(' #');
      } else {
        field = summary.type === 'pdf' ? 'pdf' : 'content';
        snippet = r.s_content ?? '';
      }
      return { item: summary, score: -r.score + titleBoost(query, summary.title), field, snippet: cleanSnippet(snippet) };
    }).sort((a, b) => b.score - a.score);
  }

  /** A stable dump of the logical index contents, for rebuild-equality tests. */
  dump(): unknown {
    const items = (this.db.prepare(`SELECT ${SUMMARY_COLS}, hash, notes, content FROM items ORDER BY id`).all() as Row[]).map((r) => ({ ...r }));
    const links = (this.db.prepare('SELECT src, target, target_key, kind, alias, context, section, ord FROM links ORDER BY src, ord').all() as Row[]).map(
      (r) => ({ ...r }),
    );
    const keys = (this.db.prepare('SELECT key, item_id, priority FROM keys ORDER BY item_id, key').all() as Row[]).map((r) => ({ ...r }));
    const tags = (this.db.prepare('SELECT item_id, tag FROM tags ORDER BY item_id, tag').all() as Row[]).map((r) => ({ ...r }));
    return { items, links, keys, tags };
  }
}

/** Exact-phrase and all-words title matches outrank body matches. */
function titleBoost(query: string, title: string): number {
  const q = query.trim().toLowerCase();
  const t = title.toLowerCase();
  if (!q) return 0;
  if (t === q) return 100;
  if (t.includes(q)) return 50;
  const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  if (words.length && words.every((w) => t.includes(w))) return 20;
  return 0;
}

function cleanSnippet(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[#*_`>]+/g, (m) => (m === '#' ? '#' : ''))
    .replace(/\s+/g, ' ')
    .trim();
}
