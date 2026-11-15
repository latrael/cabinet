import type { LibraryIndex } from './index-db.ts';
import type { StateStore } from './state.ts';
import type { ItemSummary } from './types.ts';

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seededRandom(seed: string): () => number {
  let a = hashString(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interests {
  projects: ItemSummary[];
  tags: Array<{ tag: string; count: number }>;
}

export function currentInterests(index: LibraryIndex, now = new Date(), days = 30): Interests {
  const since = new Date(now.getTime() - days * 86400_000).toISOString();
  const projects = index.list({ type: 'project', limit: 50, sort: 'updated' }).items.filter((p) => (p.projectStatus ?? 'active') === 'active');
  const rows = index.db
    .prepare(
      `SELECT t.tag tag, count(*) c FROM tags t JOIN items i ON i.id = t.item_id
       WHERE i.created >= ? OR i.updated >= ? GROUP BY t.tag ORDER BY c DESC, t.tag LIMIT 12`,
    )
    .all(since, since) as Array<{ tag: string; c: number }>;
  return { projects, tags: rows.map((r) => ({ tag: r.tag, count: r.c })) };
}

/**
 * "Revisit": older items, weighted by age, how rarely they've been opened and closeness
 * to current interests. Deterministic per day (seeded by the date).
 */
export function revisit(index: LibraryIndex, state: StateStore, opts: { now?: Date; count?: number; minAgeDays?: number } = {}): ItemSummary[] {
  const now = opts.now ?? new Date();
  const count = opts.count ?? 4;
  const minAge = opts.minAgeDays ?? 14;
  const cutoff = new Date(now.getTime() - minAge * 86400_000).toISOString();
  const candidates = index
    .list({ excludeTypes: ['project', 'collection', 'memory'], status: ['library', 'inbox'], limit: 2000, sort: 'created', order: 'asc' })
    .items.filter((i) => i.created && i.created < cutoff);
  if (!candidates.length) return [];
  const interests = currentInterests(index, now);
  const hotTags = new Map(interests.tags.map((t) => [t.tag, t.count]));
  const projectIds = new Set(interests.projects.map((p) => p.id));
  const opens = state.opens();
  const rand = seededRandom(now.toISOString().slice(0, 10));
  const scored = candidates.map((c) => {
    const ageDays = (now.getTime() - Date.parse(c.created)) / 86400_000;
    const age = Math.min(1, ageDays / 120) + 0.2;
    const rarity = 1 / (1 + (opens.get(c.id)?.count ?? 0));
    let interest = 1;
    for (const t of c.tags) interest += (hotTags.get(t.toLowerCase()) ?? 0) > 0 ? 0.5 : 0;
    if (index.projectsFor(c.id).some((p) => projectIds.has(p.projectId))) interest += 0.75;
    return { c, score: age * rarity * interest * (0.35 + rand()) };
  });
  scored.sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id));
  return scored.slice(0, count).map((s) => s.c);
}
