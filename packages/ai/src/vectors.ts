import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface Chunk {
  itemId: string;
  ix: number;
  text: string;
  hash: string;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** Split text into ~1000 char chunks on paragraph boundaries with a little overlap. */
export function chunkText(itemId: string, header: string, body: string, size = 1000): Chunk[] {
  const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > size && cur) {
      chunks.push(cur);
      cur = cur.slice(-150) + '\n\n' + p;
    } else cur = cur ? cur + '\n\n' + p : p;
    while (cur.length > size * 1.6) {
      chunks.push(cur.slice(0, size));
      cur = cur.slice(size - 150);
    }
  }
  if (cur) chunks.push(cur);
  if (!chunks.length) chunks.push('');
  return chunks.slice(0, 40).map((c, ix) => {
    const text = (ix === 0 ? header + '\n' + c : header.split('\n')[0] + '\n' + c).trim();
    return { itemId, ix, text, hash: sha1(text) };
  });
}

function toBlob(v: number[] | Float32Array): Uint8Array {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * Embedding store. Vectors are cached by (text hash, model) in `.cabinet/cache/vectors.sqlite`,
 * so rebuilding the index never re-embeds unchanged text. Search is brute-force cosine over
 * an in-memory matrix, which is fast for tens of thousands of chunks.
 */
export class VectorStore {
  private db: DatabaseSync;
  private mem = new Map<string, { model: string; chunks: Array<{ ix: number; text: string; vec: Float32Array }> }>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cache (hash TEXT NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (hash, model));
      CREATE TABLE IF NOT EXISTS item_chunks (item_id TEXT NOT NULL, ix INTEGER NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY (item_id, ix));
    `);
    this.load();
  }

  close() {
    this.db.close();
  }

  private load() {
    this.mem.clear();
    const rows = this.db
      .prepare('SELECT c.item_id, c.ix, c.text, c.model, v.vec FROM item_chunks c JOIN cache v ON v.hash = c.hash AND v.model = c.model ORDER BY c.item_id, c.ix')
      .all() as Array<{ item_id: string; ix: number; text: string; model: string; vec: Uint8Array }>;
    for (const r of rows) {
      let e = this.mem.get(r.item_id);
      if (!e) {
        e = { model: r.model, chunks: [] };
        this.mem.set(r.item_id, e);
      }
      e.chunks.push({ ix: r.ix, text: r.text, vec: normalize(fromBlob(r.vec)) });
    }
  }

  get size(): number {
    let n = 0;
    for (const e of this.mem.values()) n += e.chunks.length;
    return n;
  }

  itemIds(): string[] {
    return [...this.mem.keys()];
  }

  /** Which chunks still need embedding for this model. */
  missing(chunks: Chunk[], model: string): Chunk[] {
    const stmt = this.db.prepare('SELECT 1 FROM cache WHERE hash = ? AND model = ?');
    return chunks.filter((c) => !stmt.get(c.hash, model));
  }

  isCurrent(itemId: string, chunks: Chunk[], model: string): boolean {
    const rows = this.db.prepare('SELECT ix, hash, model FROM item_chunks WHERE item_id = ? ORDER BY ix').all(itemId) as Array<{ ix: number; hash: string; model: string }>;
    if (rows.length !== chunks.length) return false;
    return rows.every((r, i) => r.hash === chunks[i].hash && r.model === model) && this.mem.has(itemId);
  }

  putCache(hash: string, model: string, vec: number[]) {
    this.db.prepare('INSERT OR REPLACE INTO cache (hash, model, vec) VALUES (?, ?, ?)').run(hash, model, toBlob(vec));
  }

  /** Replace an item's chunks (all chunk vectors must already be cached). */
  setItem(itemId: string, chunks: Chunk[], model: string) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM item_chunks WHERE item_id = ?').run(itemId);
      const ins = this.db.prepare('INSERT INTO item_chunks (item_id, ix, hash, text, model) VALUES (?, ?, ?, ?, ?)');
      for (const c of chunks) ins.run(itemId, c.ix, c.hash, c.text, model);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    const get = this.db.prepare('SELECT vec FROM cache WHERE hash = ? AND model = ?');
    const entry = { model, chunks: [] as Array<{ ix: number; text: string; vec: Float32Array }> };
    for (const c of chunks) {
      const r = get.get(c.hash, model) as { vec: Uint8Array } | undefined;
      if (r) entry.chunks.push({ ix: c.ix, text: c.text, vec: normalize(fromBlob(r.vec)) });
    }
    this.mem.set(itemId, entry);
  }

  removeItem(itemId: string) {
    this.db.prepare('DELETE FROM item_chunks WHERE item_id = ?').run(itemId);
    this.mem.delete(itemId);
  }

  /** Keep only these items (drops vectors for deleted items). */
  retain(ids: Set<string>) {
    for (const id of [...this.mem.keys()]) if (!ids.has(id)) this.removeItem(id);
  }

  /** Best-matching items by max chunk similarity. */
  search(query: number[], opts: { model: string; limit?: number; exclude?: Set<string>; minScore?: number } ): Array<{ itemId: string; score: number; text: string }> {
    const q = normalize(Float32Array.from(query));
    const out: Array<{ itemId: string; score: number; text: string }> = [];
    for (const [itemId, e] of this.mem) {
      if (e.model !== opts.model || opts.exclude?.has(itemId)) continue;
      let best = -1;
      let text = '';
      for (const c of e.chunks) {
        if (c.vec.length !== q.length) continue;
        let s = 0;
        for (let i = 0; i < q.length; i++) s += q[i] * c.vec[i];
        if (s > best) {
          best = s;
          text = c.text;
        }
      }
      if (best >= (opts.minScore ?? 0)) out.push({ itemId, score: best, text });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.limit ?? 20);
  }
}
