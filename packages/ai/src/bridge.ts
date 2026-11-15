import { join } from 'node:path';
import { embedMany, generateText, isStepCount, Output, streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import {
  excerpt,
  getSection,
  newId,
  normalizeTag,
  parseProject,
  revisit,
  splitNotesAndContent,
  type Author,
  type ItemSummary,
  type Library,
  type LibraryEvent,
  type LibrarySecrets,
  type SearchHit,
  type Suggestion,
} from '@cabinet/core';
import { Providers } from './providers.ts';
import { chunkText, VectorStore, type Chunk } from './vectors.ts';

/** The parts of the server context the AI layer needs (structural, to avoid a package cycle). */
export interface AiHost {
  lib: Library;
  auth: { secrets: LibrarySecrets };
  jobs: { add(job: { key: string; label: string; itemId?: string; run: () => Promise<void> }): void };
  extras: Record<string, any>;
}

export interface RelatedHit {
  item: ItemSummary;
  score: number;
  reason: 'similar meaning' | 'keyword';
}

const RRF_K = 60;

function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/^<think>[\s\S]*$/, '');
}

export class AiService {
  host: AiHost;
  providers: Providers;
  store: VectorStore;
  private queue = new Set<string>();
  private working = false;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queryCache = new Map<string, number[]>();
  private schedule: ReturnType<typeof setInterval> | null = null;
  private libListener: ((e: LibraryEvent) => void) | null = null;
  private closed = false;
  embedFailures = 0;

  constructor(host: AiHost) {
    this.host = host;
    this.providers = new Providers(
      () => this.lib.config,
      () => this.host.auth.secrets,
    );
    this.store = new VectorStore(join(this.lib.root, '.cabinet', 'cache', 'vectors.sqlite'));
    this.attach();
  }

  get lib(): Library {
    return this.host.lib;
  }

  /** Listen to library changes (re-attached after a restore swaps the library). */
  private attach() {
    this.libListener = (e: LibraryEvent) => {
      if (!e.id) return;
      if (e.kind === 'deleted') this.store.removeItem(e.id);
      else if (e.kind === 'created' || e.kind === 'updated' || e.kind === 'renamed') this.queueEmbed(e.id);
    };
    this.lib.on('event', this.libListener);
  }

  async reopen() {
    this.store.close();
    this.store = new VectorStore(join(this.lib.root, '.cabinet', 'cache', 'vectors.sqlite'));
    this.attach();
    void this.embedAll();
  }

  start() {
    void this.embedAll();
    this.schedule = setInterval(() => void this.maybeRunInboxAgent(), 5 * 60_000);
    this.schedule.unref?.();
  }

  async close() {
    this.closed = true;
    if (this.schedule) clearInterval(this.schedule);
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.libListener) this.lib.off('event', this.libListener);
    this.store.close();
  }

  async status() {
    const s = await this.providers.status();
    return { ...s, indexed: this.store.size, items: this.store.itemIds().length };
  }

  // ------------------------------------------------------------------ embeddings

  private chunksFor(id: string): Chunk[] | null {
    const t = this.lib.index.textFor(id);
    const s = this.lib.index.getSummary(id);
    if (!t || !s) return null;
    const header = [t.title, t.why ? `Why: ${t.why}` : '', t.tags ? `Tags: ${t.tags}` : ''].filter(Boolean).join('\n');
    const body = [t.notes, t.content].filter(Boolean).join('\n\n');
    return chunkText(id, header, body);
  }

  queueEmbed(id: string) {
    this.queue.add(id);
    void this.drain();
  }

  async embedAll(): Promise<number> {
    const ids = this.lib.index.list({ limit: 100_000 }).items.map((i) => i.id);
    this.store.retain(new Set(ids));
    for (const id of ids) this.queue.add(id);
    return this.drain();
  }

  private async drain(): Promise<number> {
    if (this.working || this.closed) return 0;
    this.working = true;
    let embedded = 0;
    try {
      const em = await this.providers.embeddingModel();
      if (!em) return 0;
      while (this.queue.size && !this.closed) {
        const batch: Array<{ id: string; chunks: Chunk[] }> = [];
        for (const id of this.queue) {
          this.queue.delete(id);
          const chunks = this.chunksFor(id);
          if (!chunks) {
            this.store.removeItem(id);
            continue;
          }
          if (this.store.isCurrent(id, chunks, em.id)) continue;
          batch.push({ id, chunks });
          if (batch.reduce((n, b) => n + b.chunks.length, 0) >= 24) break;
        }
        if (!batch.length) continue;
        const todo = batch.flatMap((b) => this.store.missing(b.chunks, em.id));
        try {
          for (let i = 0; i < todo.length; i += 32) {
            const part = todo.slice(i, i + 32);
            const { embeddings } = await embedMany({
              model: em.model,
              values: part.map((c) => (em.prefix ? 'search_document: ' : '') + c.text.slice(0, 6000)),
              maxRetries: 1,
            });
            part.forEach((c, j) => this.store.putCache(c.hash, em.id, embeddings[j]));
            embedded += part.length;
          }
          for (const b of batch) this.store.setItem(b.id, b.chunks, em.id);
          this.embedFailures = 0;
        } catch (e) {
          this.embedFailures++;
          for (const b of batch) this.queue.add(b.id);
          this.lib.emit('error-log', e);
          break; // try again on the next change
        }
      }
    } finally {
      this.working = false;
    }
    return embedded;
  }

  async reindexAll(): Promise<{ embedded: number }> {
    return { embedded: await this.embedAll() };
  }

  private async embedQuery(q: string, timeoutMs = 2500): Promise<{ vec: number[]; model: string } | null> {
    const em = await this.providers.embeddingModel();
    if (!em) return null;
    const key = em.id + '|' + q;
    const cached = this.queryCache.get(key);
    if (cached) return { vec: cached, model: em.id };
    try {
      const { embeddings } = await embedMany({
        model: em.model,
        values: [(em.prefix ? 'search_query: ' : '') + q.slice(0, 4000)],
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      this.queryCache.set(key, embeddings[0]);
      if (this.queryCache.size > 200) this.queryCache.delete(this.queryCache.keys().next().value!);
      return { vec: embeddings[0], model: em.id };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ search

  async search(q: string, opts: { type?: string | string[]; status?: string | string[]; tag?: string; limit?: number }): Promise<{ hits: SearchHit[]; mode: 'hybrid' | 'keyword' }> {
    const limit = opts.limit ?? 30;
    const kw = this.lib.index.search(q, { ...opts, limit: 50 });
    const qv = await this.embedQuery(q);
    if (!qv || this.store.size === 0) return { hits: kw.slice(0, limit), mode: 'keyword' };
    const types = opts.type ? (Array.isArray(opts.type) ? opts.type : [opts.type]) : null;
    const statuses = opts.status ? (Array.isArray(opts.status) ? opts.status : [opts.status]) : null;
    const vec = this.store
      .search(qv.vec, { model: qv.model, limit: 40, minScore: 0.45 })
      .map((v) => ({ ...v, item: this.lib.index.getSummary(v.itemId) }))
      .filter((v): v is typeof v & { item: ItemSummary } => {
        if (!v.item) return false;
        if (types && !types.includes(v.item.type)) return false;
        if (statuses && !statuses.includes(v.item.status)) return false;
        if (opts.tag && !v.item.tags.map((t) => t.toLowerCase()).includes(opts.tag.toLowerCase())) return false;
        return true;
      });
    const scores = new Map<string, { score: number; hit?: SearchHit; vec?: (typeof vec)[number] }>();
    kw.forEach((h, rank) => scores.set(h.item.id, { score: 1 / (RRF_K + rank) + (h.score >= 20 ? 0.02 : 0), hit: h }));
    vec.forEach((v, rank) => {
      // vector-only matches need to be reasonably close
      const e = scores.get(v.itemId);
      const add = 1 / (RRF_K + rank);
      if (e) {
        e.score += add;
        e.vec = v;
      } else if (rank < 12 && v.score >= 0.55) scores.set(v.itemId, { score: add * 0.9, vec: v });
    });
    const fused = [...scores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([, e]): SearchHit => {
        if (e.hit) return { ...e.hit, score: e.score };
        const text = e.vec!.text.split('\n').slice(1).join(' ') || e.vec!.text;
        return { item: e.vec!.item, score: e.score, field: 'semantic', snippet: excerpt(text, 200) };
      });
    return { hits: fused, mode: 'hybrid' };
  }

  async related(text: string, opts: { excludeIds?: string[]; limit?: number } = {}): Promise<RelatedHit[]> {
    const limit = opts.limit ?? 6;
    const exclude = new Set(opts.excludeIds ?? []);
    const qv = await this.embedQuery(text.slice(0, 3000), 3000);
    if (qv && this.store.size > 0) {
      const hits = this.store
        .search(qv.vec, { model: qv.model, limit: limit + 6, exclude, minScore: 0.5 })
        .map((h) => ({ item: this.lib.index.getSummary(h.itemId)!, score: h.score, reason: 'similar meaning' as const }))
        .filter((h) => h.item && h.item.type !== 'collection');
      if (hits.length) return hits.slice(0, limit);
    }
    return this.keywordRelated(text, [...exclude], limit);
  }

  private keywordRelated(text: string, exclude: string[], limit: number): RelatedHit[] {
    const stop = new Set('the a an and or of to in on for with is are was be this that it as at by from i my me you your we our about into not but have has'.split(' '));
    const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !stop.has(w)).slice(0, 14);
    if (!words.length) return [];
    return this.lib.index
      .search(words.join(' '), { limit: limit + exclude.length + 4, excludeIds: exclude })
      .filter((h) => h.item.type !== 'collection')
      .slice(0, limit)
      .map((h) => ({ item: h.item, score: h.score, reason: 'keyword' as const }));
  }

  // ------------------------------------------------------------------ enrichment

  onItemChanged(id: string, _author: Author) {
    this.queueEmbed(id);
    const s = this.lib.index.getSummary(id);
    if (!s || !this.lib.config.ai.enrichOnCapture) return;
    if (['note', 'project', 'collection', 'memory'].includes(s.type)) return;
    if (s.extraction === 'pending') return;
    const age = Date.now() - Date.parse(s.created);
    if (age > 15 * 60_000) return;
    if (this.lib.state.get(`enriched:${id}`)) return;
    const prev = this.timers.get(id);
    if (prev) clearTimeout(prev);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.lib.state.set(`enriched:${id}`, new Date().toISOString());
        this.host.jobs.add({ key: `enrich:${id}`, label: 'Suggesting tags and links', itemId: id, run: () => this.enrich(id) });
      }, 2500),
    );
  }

  private hint(): string {
    return this.providers.isLocalChat ? ' /no_think' : '';
  }

  async enrich(id: string): Promise<void> {
    const status = await this.providers.status();
    const model = this.providers.chatModel();
    if (!model || !status.chat) return;
    const item = this.lib.read(id);
    const { notes, content } = splitNotesAndContent(item.body);
    const linked = new Set([item.id, ...this.lib.index.outgoing(id).map((o) => o.targetId), ...this.lib.index.backlinks(id).map((b) => b.sourceId)].filter(Boolean) as string[]);
    const text = [item.title, item.why ?? '', notes, content].join('\n').slice(0, 4000);
    const candidates = (await this.related(text, { excludeIds: [...linked], limit: 8 })).filter((c) => c.item.type !== 'memory');
    const vocab = this.lib.index.allTags().slice(0, 60).map((t) => t.tag);
    const collections = this.lib.index.allCollections().map((c) => c.name);
    const schema = z.object({
      tags: z.array(z.string()).describe('Up to 4 short lowercase tags. Prefer existing tags.'),
      summary: z.string().describe('One or two plain sentences on what this is. Empty if the item is too short to need one.'),
      links: z.array(z.object({ slug: z.string(), reason: z.string().describe('A few words on how they connect') })).describe('Only candidates that are genuinely related.'),
      collection: z.string().describe('One existing collection name that clearly fits, or empty.'),
    });
    const prompt = `Item to organise:
Title: ${item.title}
Type: ${item.type}
Current tags: ${item.tags.join(', ') || 'none'}
Why the owner saved it: ${item.why ?? '(not given)'}
Text:
${(notes + '\n' + content).slice(0, 3500)}

Existing tags in the library: ${vocab.join(', ') || 'none yet'}
Existing collections: ${collections.join(', ') || 'none'}
Candidate related items (slug: title):
${candidates.map((c) => `- ${c.item.slug}: ${c.item.title}`).join('\n') || '(none)'}`;
    const r = await generateText({
      model,
      instructions:
        'You help organise a personal library of saved links, notes and projects. Propose tags, a short summary, links to candidate items, and a collection. Be conservative: suggest a link only when a reader would see the connection.' +
        this.hint(),
      prompt,
      output: Output.object({ schema }),
      maxRetries: 1,
    });
    const out = r.output;
    this.lib.state.clearPending(id, 'enrich');
    const cur = this.lib.read(id);
    const newTags = [...new Set(out.tags.map(normalizeTag).filter(Boolean))].filter((t) => !cur.tags.includes(t)).slice(0, 4);
    if (newTags.length) this.lib.state.addSuggestion({ itemId: id, kind: 'tags', payload: { tags: newTags }, source: 'enrich' });
    const summary = stripThink(out.summary ?? '')
      .trim()
      .split(/(?<=[.!?])\s+/)
      .slice(0, 2)
      .join(' ');
    if (summary && !cur.frontmatter.summary && summary.length > 20) this.lib.state.addSuggestion({ itemId: id, kind: 'summary', payload: { summary }, source: 'enrich' });
    for (const l of out.links ?? []) {
      const c = candidates.find((x) => x.item.slug === l.slug);
      if (c) this.lib.state.addSuggestion({ itemId: id, kind: 'link', payload: { targetId: c.item.id, slug: c.item.slug, title: c.item.title, reason: l.reason }, source: 'enrich' });
    }
    const coll = collections.find((c) => c.toLowerCase() === (out.collection ?? '').trim().toLowerCase());
    if (coll && !cur.collections.includes(coll)) this.lib.state.addSuggestion({ itemId: id, kind: 'collection', payload: { collection: coll }, source: 'enrich' });
    this.lib.emit('event', { kind: 'suggestions', id, origin: 'app' });
  }

  async acceptSuggestion(sid: string, _author: Author): Promise<void> {
    const s = this.lib.state.getSuggestion(sid);
    if (!s || s.status !== 'pending') throw new Error('Suggestion not found');
    const by: Author = s.source === 'inbox-agent' ? 'inbox-agent' : 'agent:enrich';
    const item = this.lib.read(s.itemId);
    const p = s.payload;
    switch (s.kind) {
      case 'tags':
        this.lib.update(item.id, { frontmatter: { tags: [...item.tags, ...p.tags] } }, by, `tag “${item.title}” (accepted)`);
        break;
      case 'summary':
        this.lib.update(item.id, { frontmatter: { summary: p.summary } }, by, `summarise “${item.title}” (accepted)`);
        break;
      case 'link':
        this.lib.linkItems(item.id, p.targetId, by, p.reason);
        break;
      case 'collection':
        this.lib.update(item.id, { frontmatter: { collections: [...new Set([...item.collections, p.collection])] } }, by, `add “${item.title}” to ${p.collection} (accepted)`);
        break;
      case 'triage':
        this.applyTriage(item.id, p, by);
        break;
    }
    this.lib.state.setSuggestionStatus(sid, 'accepted');
    this.lib.emit('event', { kind: 'suggestions', id: item.id, origin: 'app' });
  }

  private applyTriage(id: string, p: any, by: Author) {
    const item = this.lib.read(id);
    const tags = [...new Set([...item.tags, ...((p.tags as string[]) ?? []).map(normalizeTag)])];
    if (p.action === 'archive') {
      this.lib.update(id, { frontmatter: { status: 'archived' } }, by, `archive “${item.title}” (accepted)`);
      return;
    }
    if (p.action === 'project' && p.projectId) this.lib.addToProject(p.projectId, id, { section: p.section || undefined, context: p.context || undefined }, by);
    this.lib.update(id, { frontmatter: { status: 'library', tags } }, by, `file “${item.title}” (accepted)`);
  }

  // ------------------------------------------------------------------ inbox agent

  private async maybeRunInboxAgent() {
    const cfg = this.lib.config.ai.inboxAgent;
    if (!cfg.enabled || this.closed) return;
    const last = this.lib.state.get('inboxAgentLastRun');
    if (!last) {
      this.lib.state.set('inboxAgentLastRun', new Date().toISOString());
      return;
    }
    if (Date.now() - Date.parse(last) < cfg.intervalMinutes * 60_000) return;
    const inbox = this.lib.index.counts().inbox ?? 0;
    if (!inbox) return;
    try {
      await this.runInboxAgent();
    } catch (e) {
      this.lib.emit('error-log', e);
    }
  }

  async runInboxAgent(): Promise<unknown> {
    this.lib.state.set('inboxAgentLastRun', new Date().toISOString());
    const status = await this.providers.status();
    const model = this.providers.chatModel();
    const pendingTriage = new Set(this.lib.state.suggestions({ status: 'pending', source: 'inbox-agent' }).map((s) => s.itemId));
    const inbox = this.lib.index.list({ status: 'inbox', limit: 15, sort: 'created', order: 'asc' }).items.filter((i) => !pendingTriage.has(i.id));
    const projects = this.lib.index
      .list({ type: 'project', limit: 30, sort: 'updated' })
      .items.filter((p) => (p.projectStatus ?? 'active') === 'active')
      .map((p) => {
        const body = this.lib.read(p.id).body;
        return { ...p, sections: parseProject(body).material.map((s) => s.name).filter(Boolean) };
      });
    const created: Suggestion[] = [];
    if (model && status.chat && inbox.length) {
      const schema = z.object({
        decisions: z.array(
          z.object({
            index: z.number().int(),
            action: z.enum(['file', 'project', 'archive', 'keep']),
            project: z.number().int().describe('Project number when action is "project", else -1'),
            section: z.string().describe('Existing or new section name in that project, or empty'),
            context: z.string().describe('Why it matters to that project, a few words, or empty'),
            tags: z.array(z.string()).describe('Up to 3 tags'),
            reason: z.string().describe('One short sentence'),
          }),
        ),
      });
      for (let i = 0; i < inbox.length; i += 5) {
        const part = inbox.slice(i, i + 5);
        const prompt = `Active projects:
${projects.map((p, j) => `${j}. ${p.title}${p.excerpt ? ` — ${p.excerpt.slice(0, 120)}` : ''}${p.sections.length ? ` (sections: ${p.sections.join(', ')})` : ''}`).join('\n') || '(none)'}

Inbox items:
${part
  .map((it, j) => `${j}. [${it.type}] ${it.title}${it.why ? ` — why: ${it.why}` : ''}${it.tags.length ? ` — tags: ${it.tags.join(', ')}` : ''}${it.excerpt ? `\n   ${it.excerpt.slice(0, 220)}` : ''}`)
  .join('\n')}`;
        try {
          const r = await generateText({
            model,
            instructions:
              'You triage a personal inbox of saved links and notes. For each item choose: "project" if it clearly belongs to one of the active projects, "file" to keep it in the library, "archive" if it looks like noise, or "keep" if unsure. Suggest tags. Proposals are reviewed by the owner before anything changes.' +
              this.hint(),
            prompt,
            output: Output.object({ schema }),
            maxRetries: 1,
          });
          for (const d of r.output.decisions) {
            const it = part[d.index];
            if (!it || d.action === 'keep') continue;
            let proj = d.action === 'project' ? projects[d.project] : undefined;
            if (d.action === 'project' && !proj) continue;
            // Already in that project? Then the useful proposal is just to file it.
            if (proj && this.lib.index.projectsFor(it.id).some((p) => p.projectId === proj!.id)) {
              d.action = 'file';
              proj = undefined;
            }
            const tags = [...new Set(d.tags.map(normalizeTag).filter(Boolean))].slice(0, 3);
            const label =
              d.action === 'project'
                ? `Add to ${proj!.title}${d.section ? ` › ${d.section}` : ''}`
                : d.action === 'archive'
                  ? 'Archive it'
                  : `File in the library${tags.length ? ` with ${tags.map((t) => '#' + t).join(' ')}` : ''}`;
            created.push(
              this.lib.state.addSuggestion({
                itemId: it.id,
                kind: 'triage',
                source: 'inbox-agent',
                payload: { action: d.action, projectId: proj?.id, section: d.section, context: d.context, tags, reason: d.reason, label },
              }),
            );
          }
        } catch (e) {
          this.lib.emit('error-log', e);
        }
      }
    }
    const picks = revisit(this.lib.index, this.lib.state, { count: 3 });
    const counts = { file: 0, project: 0, archive: 0 };
    for (const s of created) counts[s.payload.action as keyof typeof counts]++;
    const parts: string[] = [];
    if (counts.project) parts.push(`${counts.project} for projects`);
    if (counts.file) parts.push(`${counts.file} to file`);
    if (counts.archive) parts.push(`${counts.archive} to archive`);
    const summary = created.length
      ? `The inbox agent looked at ${inbox.length} new ${inbox.length === 1 ? 'item' : 'items'}: ${parts.join(', ')}. Review the proposals in your inbox.`
      : inbox.length && !status.chat
        ? 'The inbox agent needs a chat model to sort your inbox. Revisit picks are below.'
        : 'Nothing new to sort. Here are a few older things to revisit.';
    const digest = this.lib.state.addDigest({ summary, triage: created.map((s) => s.id), revisit: picks.map((p) => p.id), model: status.chatModel });
    this.lib.emit('event', { kind: 'digest', origin: 'app', data: { id: digest.id } });
    return digest;
  }

  // ------------------------------------------------------------------ chat

  private chatTools(seen: Map<string, { id: string; title: string; type: string }>) {
    const lib = this.lib;
    const note = (i: ItemSummary) => {
      seen.set(i.slug, { id: i.id, title: i.title, type: i.type });
      return i;
    };
    return {
      search: tool({
        description: 'Search the library by words and meaning. Returns matching items with a snippet and where it matched.',
        inputSchema: z.object({
          query: z.string().describe('A few keywords or a short phrase'),
          type: z.string().optional().describe('Only when the owner asks for one kind of item (note, article, video, pdf, project…). Usually omit.'),
        }),
        execute: async ({ query, type }) => {
          let { hits } = await this.search(query, { type: type || undefined, limit: 8 });
          if (type && hits.length < 4) {
            // A type filter is advisory: widen the search when it finds little.
            const more = (await this.search(query, { limit: 8 })).hits.filter((h) => !hits.some((x) => x.item.id === h.item.id));
            hits = [...hits, ...more].slice(0, 8);
          }
          return hits.map((h) => ({
            slug: note(h.item).slug,
            title: h.item.title,
            type: h.item.type,
            matched: h.field,
            snippet: h.snippet.replace(/[«»]/g, ''),
            why: h.item.why,
            excerpt: h.item.excerpt?.slice(0, 300),
          }));
        },
      }),
      get_item: tool({
        description: 'Read one item by slug or title: notes, saved content excerpt, tags, projects and backlinks.',
        inputSchema: z.object({ ref: z.string() }),
        execute: async ({ ref }) => {
          const item = lib.find(ref.replace(/^\[\[|\]\]$/g, ''));
          if (!item) return { error: `No item called ${ref}` };
          note(lib.index.getSummary(item.id)!);
          const { notes, content } = splitNotesAndContent(item.body);
          const backlinks = lib.index.backlinks(item.id).map((b) => lib.index.getSummary(b.sourceId)).filter((x): x is ItemSummary => !!x).map((x) => note(x).slug);
          const projects = lib.index.projectsFor(item.id).map((p) => ({ project: note(lib.index.getSummary(p.projectId)!).slug, section: p.section, context: p.context }));
          return {
            slug: item.slug,
            title: item.title,
            type: item.type,
            why: item.why,
            tags: item.tags,
            source: item.frontmatter.source,
            notes: notes.slice(0, 2500),
            content: content.slice(0, 3500),
            timestamps: getSection(item.body, 'Timestamps'),
            backlinks,
            projects,
          };
        },
      }),
      list_projects: tool({
        description: 'List projects with their status and intent.',
        inputSchema: z.object({}),
        execute: async () => lib.index.list({ type: 'project', limit: 50, sort: 'updated' }).items.map((p) => ({ slug: note(p).slug, title: p.title, status: p.projectStatus, intent: p.excerpt })),
      }),
      list_recent: tool({
        description: 'List the most recently saved items.',
        inputSchema: z.object({ limit: z.number().int().min(1).max(30).optional() }),
        execute: async ({ limit }) => lib.index.list({ limit: limit ?? 10, sort: 'created', excludeTypes: ['collection'] }).items.map((i) => ({ slug: note(i).slug, title: i.title, type: i.type, created: i.created, why: i.why })),
      }),
    };
  }

  /** Tool-using chat over the library. Streams NDJSON events. */
  async chat(input: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; chatId?: string }): Promise<Response> {
    const status = await this.providers.status();
    const model = this.providers.chatModel();
    const enc = new TextEncoder();
    const chatId = input.chatId || newId();
    if (!model || !status.chat) {
      return new Response(enc.encode(JSON.stringify({ t: 'error', message: status.reason ?? 'No chat model available.' }) + '\n'), {
        headers: { 'content-type': 'application/x-ndjson' },
      });
    }
    const seen = new Map<string, { id: string; title: string; type: string }>();
    const messages: ModelMessage[] = input.messages.slice(-12).map((m) => ({ role: m.role, content: m.content }));
    const today = new Date().toISOString().slice(0, 10);
    // Retrieve up front so even small local models start from the right material.
    const question = [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const pre = question ? (await this.search(question, { limit: 6 })).hits : [];
    for (const h of pre) seen.set(h.item.slug, { id: h.item.id, title: h.item.title, type: h.item.type });
    const context = pre.length
      ? `\n\nPossibly relevant items found for the latest question (read them with get_item for detail):\n${pre
          .map((h) => `- [[${h.item.slug}]] ${h.item.title} (${h.item.type})${h.item.why ? ` — why saved: ${h.item.why}` : ''}${h.item.excerpt ? `\n  ${h.item.excerpt.slice(0, 280)}` : ''}`)
          .join('\n')}`
      : '';
    const result = streamText({
      model,
      instructions: `You are the assistant inside Cabinet, the owner's personal library of notes, saved sources and hobby projects. Today is ${today}.
Answer from the library. First search broadly (try two or three phrasings, without a type filter), then read the two to four most relevant items with get_item, and only then answer.
Cite every item you use as [[slug]] (the slug from the tools), inline where it supports the point.
If the library doesn't contain the answer, say so plainly and suggest what to save. Keep answers concise and warm; use short paragraphs or lists.${context}${this.hint()}`,
      messages,
      tools: this.chatTools(seen),
      stopWhen: isStepCount(6),
      maxRetries: 1,
    });
    const lib = this.lib;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + '\n'));
        let text = '';
        let inThink = false;
        let pending = '';
        try {
          for await (const part of result.stream) {
            if (part.type === 'text-delta') {
              // strip <think>…</think> that some local models emit inline
              pending += part.text;
              let out = '';
              for (;;) {
                if (inThink) {
                  const end = pending.indexOf('</think>');
                  if (end < 0) {
                    pending = pending.slice(-8);
                    break;
                  }
                  pending = pending.slice(end + 8).replace(/^\s+/, '');
                  inThink = false;
                } else {
                  const start = pending.indexOf('<think>');
                  if (start < 0) {
                    const keep = pending.lastIndexOf('<');
                    const safe = keep >= 0 && pending.length - keep < 8 ? pending.slice(0, keep) : pending;
                    out += safe;
                    pending = pending.slice(safe.length);
                    break;
                  }
                  out += pending.slice(0, start);
                  pending = pending.slice(start + 7);
                  inThink = true;
                }
              }
              if (out) {
                text += out;
                send({ t: 'text', v: out });
              }
            } else if (part.type === 'tool-call') {
              send({ t: 'tool', name: part.toolName, input: part.input });
            } else if (part.type === 'error') {
              send({ t: 'error', message: String((part as any).error?.message ?? (part as any).error ?? 'error') });
            }
          }
          if (pending && !inThink) {
            text += pending;
            send({ t: 'text', v: pending });
          }
          // resolve every [[slug]] in the answer for the client
          for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) {
            const key = m[1].trim();
            if (seen.has(key)) continue;
            const id = lib.resolveLink(key);
            const s = id ? lib.index.getSummary(id) : undefined;
            if (s) seen.set(key, { id: s.id, title: s.title, type: s.type });
          }
          send({ t: 'items', items: Object.fromEntries(seen) });
          const all = [...input.messages, { role: 'assistant' as const, content: text, items: Object.fromEntries(seen) }];
          lib.state.saveChat(chatId, input.messages[0]?.content.slice(0, 80) ?? 'Chat', all);
          send({ t: 'done', chatId });
        } catch (e) {
          send({ t: 'error', message: (e as Error).message });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' } });
  }
}

/** Entry point used by the server wiring. */
export async function createAiBridge(host: AiHost) {
  const svc = new AiService(host);
  svc.start();
  const prevReopen = host.extras.onReopen;
  host.extras.onReopen = async () => {
    await prevReopen?.();
    await svc.reopen();
  };
  host.extras.ai = svc;
  return {
    status: () => svc.status(),
    search: (q: string, o: any) => svc.search(q, o),
    related: (t: string, o: any) => svc.related(t, o),
    onItemChanged: (id: string, a: Author) => svc.onItemChanged(id, a),
    enrich: (id: string) => svc.enrich(id),
    runInboxAgent: () => svc.runInboxAgent(),
    chat: (i: any) => svc.chat(i),
    reindexAll: () => svc.reindexAll(),
    acceptSuggestion: (id: string, a: Author) => svc.acceptSuggestion(id, a),
    close: () => svc.close(),
    service: svc,
  };
}
