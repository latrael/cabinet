import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId, nowIso } from './ids.ts';

export type SuggestionKind = 'tags' | 'summary' | 'link' | 'related' | 'triage' | 'collection';
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed';

export interface Suggestion {
  id: string;
  itemId: string;
  kind: SuggestionKind;
  payload: any;
  status: SuggestionStatus;
  created: string;
  source: string; // 'enrich' | 'inbox-agent' | ...
}

export interface Digest {
  id: string;
  created: string;
  payload: any;
  status: 'new' | 'seen';
}

type Row = Record<string, any>;

/**
 * Non-library state: opens, AI suggestions, digests and chats. Lives in `.cabinet/state.sqlite`
 * (gitignored). Losing it loses no library content.
 */
export class StateStore {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS opens (item_id TEXT PRIMARY KEY, count INTEGER NOT NULL, last TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS suggestions (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL, created TEXT NOT NULL, source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sugg_item ON suggestions(item_id, status);
      CREATE TABLE IF NOT EXISTS digests (id TEXT PRIMARY KEY, created TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, created TEXT NOT NULL, updated TEXT NOT NULL, title TEXT, messages TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  close() {
    this.db.close();
  }

  recordOpen(itemId: string) {
    this.db
      .prepare('INSERT INTO opens (item_id, count, last) VALUES (?, 1, ?) ON CONFLICT(item_id) DO UPDATE SET count = count + 1, last = excluded.last')
      .run(itemId, nowIso());
  }

  opens(): Map<string, { count: number; last: string }> {
    const m = new Map<string, { count: number; last: string }>();
    for (const r of this.db.prepare('SELECT * FROM opens').all() as Row[]) m.set(r.item_id, { count: r.count, last: r.last });
    return m;
  }

  addSuggestion(s: Omit<Suggestion, 'id' | 'created' | 'status'> & { status?: SuggestionStatus }): Suggestion {
    const full: Suggestion = { id: newId(), created: nowIso(), status: s.status ?? 'pending', ...s } as Suggestion;
    this.db
      .prepare('INSERT INTO suggestions (id, item_id, kind, payload, status, created, source) VALUES (?,?,?,?,?,?,?)')
      .run(full.id, full.itemId, full.kind, JSON.stringify(full.payload), full.status, full.created, full.source);
    return full;
  }

  private toSuggestion(r: Row): Suggestion {
    return { id: r.id, itemId: r.item_id, kind: r.kind, payload: JSON.parse(r.payload), status: r.status, created: r.created, source: r.source };
  }

  suggestions(opts: { itemId?: string; status?: SuggestionStatus; source?: string } = {}): Suggestion[] {
    let sql = 'SELECT * FROM suggestions WHERE 1=1';
    const p: string[] = [];
    if (opts.itemId) {
      sql += ' AND item_id = ?';
      p.push(opts.itemId);
    }
    if (opts.status) {
      sql += ' AND status = ?';
      p.push(opts.status);
    }
    if (opts.source) {
      sql += ' AND source = ?';
      p.push(opts.source);
    }
    sql += ' ORDER BY created DESC';
    return (this.db.prepare(sql).all(...p) as Row[]).map((r) => this.toSuggestion(r));
  }

  getSuggestion(id: string): Suggestion | undefined {
    const r = this.db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toSuggestion(r) : undefined;
  }

  setSuggestionStatus(id: string, status: SuggestionStatus) {
    this.db.prepare('UPDATE suggestions SET status = ? WHERE id = ?').run(status, id);
  }

  clearPending(itemId: string, source: string) {
    this.db.prepare("DELETE FROM suggestions WHERE item_id = ? AND source = ? AND status = 'pending'").run(itemId, source);
  }

  addDigest(payload: any): Digest {
    const d: Digest = { id: newId(), created: nowIso(), payload, status: 'new' };
    this.db.prepare('INSERT INTO digests (id, created, payload, status) VALUES (?,?,?,?)').run(d.id, d.created, JSON.stringify(payload), d.status);
    return d;
  }

  digests(limit = 10): Digest[] {
    return (this.db.prepare('SELECT * FROM digests ORDER BY created DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      id: r.id,
      created: r.created,
      payload: JSON.parse(r.payload),
      status: r.status,
    }));
  }

  markDigest(id: string, status: 'new' | 'seen') {
    this.db.prepare('UPDATE digests SET status = ? WHERE id = ?').run(status, id);
  }

  saveChat(id: string, title: string, messages: unknown[]) {
    const now = nowIso();
    this.db
      .prepare(
        'INSERT INTO chats (id, created, updated, title, messages) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated = excluded.updated, title = excluded.title, messages = excluded.messages',
      )
      .run(id, now, now, title, JSON.stringify(messages));
  }

  chats(limit = 30): Array<{ id: string; title: string; updated: string }> {
    return (this.db.prepare('SELECT id, title, updated FROM chats ORDER BY updated DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      id: r.id,
      title: r.title,
      updated: r.updated,
    }));
  }

  getChat(id: string): { id: string; title: string; messages: any[] } | undefined {
    const r = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as Row | undefined;
    return r ? { id: r.id, title: r.title, messages: JSON.parse(r.messages) } : undefined;
  }

  get(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined)?.value;
  }

  set(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value);
  }
}
