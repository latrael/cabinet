import { nowIso } from './ids.ts';
import { NotFoundError, type Library } from './library.ts';
import type { Author, Item, ItemSummary, LibraryEvent, MemoryFrontmatter, MemoryLifecycle, MemorySource, Status } from './types.ts';

export type ProposalStatus = 'proposed' | 'approved' | 'rejected';

export interface ProjectSuggestion {
  id: string;
  slug: string;
  title: string;
  intent?: string;
}

export class UnknownProjectError extends Error {
  query: string;
  suggestions: ProjectSuggestion[];
  constructor(query: string, suggestions: ProjectSuggestion[] = []) {
    const message = suggestions.length
      ? `No exact project matched "${query}". Closest existing projects: ${suggestions.map((s) => `${s.slug} (${s.title})`).join(', ')}. Reuse one of these slugs, omit \`project\` for a general/owner-level memory, or create a new project first with \`create_project\`.`
      : `No project matched "${query}". Check \`list_projects\`, call \`create_project\` if this is a genuinely new ongoing project, or omit \`project\` for a general/owner-level memory.`;
    super(message);
    this.query = query;
    this.suggestions = suggestions;
    this.name = 'UnknownProjectError';
  }
}

export interface Proposal {
  id: string;
  slug: string;
  path: string;
  title: string;
  text: string;
  status: ProposalStatus;
  hash: string;
  agent: string;
  proposed_by: string;
  proposed_at: string;
  thread_id: string | null;
  project_ids: string[];
  sources: MemorySource[];
  decided_by: string | null;
  decided_at: string | null;
  reject_reason: string | null;
  original_text: string | null;
}

export class AlreadyDecidedError extends Error {
  current: Proposal;
  constructor(current: Proposal) {
    super(`Proposal already ${current.status}`);
    this.current = current;
    this.name = 'AlreadyDecidedError';
  }
}

export interface ProposeMemoryInput {
  fact: string;
  title?: string;
  tags?: string[];
  threadId?: string;
  project?: string;
  sources?: Array<{ item?: string; item_id?: string; url?: string; quote?: string }>;
  agent?: string;
  capturedVia?: string;
}

export interface ListProposalsQuery {
  status?: 'proposed' | 'approved' | 'rejected' | 'all';
  projectId?: string;
  threadId?: string;
  agent?: string;
  limit?: number;
  offset?: number;
}

export interface ProposalCounts {
  total: number;
  byProject: Record<string, number>;
  byThread: Record<string, number>;
}

function asStr(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Date) return v.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const s = String(v).trim();
  return s || undefined;
}

function rawMemoryObj(item: Item): Record<string, unknown> | null {
  if (item.type !== 'memory') return null;
  const m = item.frontmatter.memory;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  return m as unknown as Record<string, unknown>;
}

function lifecycleToStatus(lifecycle: unknown): ProposalStatus | null {
  switch (lifecycle) {
    case 'proposed':
      return 'proposed';
    case 'active':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return null;
  }
}

export function itemToProposal(item: Item): Proposal | null {
  const m = rawMemoryObj(item);
  if (!m) return null;
  const status = lifecycleToStatus(m.lifecycle);
  if (!status) return null;
  const agentFm = asStr(item.frontmatter.agent);
  const proposedBy = asStr(m.proposed_by) ?? (agentFm ? `agent:${agentFm}` : 'you');
  const agent = agentFm ?? proposedBy.replace(/^agent:/, '');
  const proposedAt = asStr(m.proposed_at) ?? item.created;
  const projectIds = Array.isArray(m.project_ids)
    ? m.project_ids.map(asStr).filter((x): x is string => !!x)
    : [];
  const sources: MemorySource[] = Array.isArray(m.sources)
    ? m.sources
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s))
        .map((s) => {
          const out: MemorySource = {};
          const itemId = asStr(s.item_id);
          const url = asStr(s.url);
          const quote = asStr(s.quote);
          if (itemId) out.item_id = itemId;
          if (url) out.url = url;
          if (quote) out.quote = quote;
          return out;
        })
        .filter((s) => s.item_id || s.url || s.quote)
    : [];
  return {
    id: item.id,
    slug: item.slug,
    path: item.path,
    title: item.title,
    text: item.body.trim(),
    status,
    hash: item.hash,
    agent,
    proposed_by: proposedBy,
    proposed_at: proposedAt,
    thread_id: asStr(m.thread_id) ?? null,
    project_ids: projectIds,
    sources,
    decided_by: asStr(m.decided_by) ?? null,
    decided_at: asStr(m.decided_at) ?? null,
    reject_reason: asStr(m.reject_reason) ?? null,
    original_text: asStr(m.original_text) ?? null,
  };
}

export function memoryEventData(item: Item): Record<string, unknown> | null {
  const proposal = itemToProposal(item);
  if (!proposal) return null;
  const data: Record<string, unknown> = {
    action: proposal.status,
    status: proposal.status,
    project_ids: proposal.project_ids,
  };
  if (proposal.thread_id) data.thread_id = proposal.thread_id;
  return data;
}

function emitMemoryEvent(lib: Library, item: Item, proposal: Proposal, origin: 'app' | 'disk', author?: Author) {
  const data: Record<string, unknown> = {
    action: proposal.status,
    status: proposal.status,
    project_ids: proposal.project_ids,
  };
  if (proposal.thread_id) data.thread_id = proposal.thread_id;
  const evt: LibraryEvent = {
    kind: 'memory',
    id: item.id,
    path: item.path,
    origin,
    ...(author ? { author } : {}),
    data,
  };
  lib.emit('event', evt);
}

const QUERY_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on',
  'or', 'our', 'so', 'that', 'the', 'their', 'this', 'to', 'with', 'you', 'your',
]);

function normalizeText(value: string): string {
  return value
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function compactText(value: string): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function scoreProjectSummary(
  summary: ItemSummary,
  queryNorm: string,
  queryCompact: string,
  tokens: string[],
): number {
  const slugNorm = normalizeText(summary.slug);
  const titleNorm = normalizeText(summary.title);
  const slugCompact = slugNorm.replace(/\s+/g, '');
  const titleCompact = titleNorm.replace(/\s+/g, '');
  const slugTitleTokens = new Set([...slugNorm.split(' '), ...titleNorm.split(' ')].filter(Boolean));
  const tagTokens = new Set(summary.tags.flatMap((t) => normalizeText(t).split(' ')).filter(Boolean));
  const excerptNorm = summary.excerpt ? normalizeText(summary.excerpt) : '';
  const excerptTokens = new Set(excerptNorm ? excerptNorm.split(' ').filter(Boolean) : []);

  let score = 0;

  if (queryNorm && (slugNorm === queryNorm || titleNorm === queryNorm)) {
    score += 100;
  } else if (queryCompact && (slugCompact === queryCompact || titleCompact === queryCompact)) {
    score += 100;
  } else if (queryCompact.length >= 3) {
    if (slugCompact.includes(queryCompact) || titleCompact.includes(queryCompact)) {
      score += 60;
    } else if (
      (slugCompact.length >= 3 && queryCompact.includes(slugCompact)) ||
      (titleCompact.length >= 3 && queryCompact.includes(titleCompact))
    ) {
      score += 55;
    } else if (queryNorm.length >= 3 && (slugNorm.includes(queryNorm) || titleNorm.includes(queryNorm))) {
      score += 50;
    }
  }

  for (const token of tokens) {
    if (slugTitleTokens.has(token)) {
      score += 25;
      continue;
    }
    if (token.length >= 3 && (slugCompact.includes(token) || titleCompact.includes(token))) {
      score += 15;
      continue;
    }
    if (token.length >= 4) {
      let reverseMatched = false;
      for (const candidateToken of slugTitleTokens) {
        if (candidateToken.length >= 3 && token.includes(candidateToken)) {
          reverseMatched = true;
          break;
        }
      }
      if (reverseMatched) {
        score += 12;
        continue;
      }
    }
    if (tagTokens.has(token)) {
      score += 10;
      continue;
    }
    if (token.length >= 3 && excerptTokens.has(token)) {
      score += 6;
      continue;
    }
    if (token.length >= 4) {
      for (const excerptToken of excerptTokens) {
        if (excerptToken.startsWith(token)) {
          score += 4;
          break;
        }
      }
    }
  }

  return score;
}

function projectIntent(lib: Library, summary: ItemSummary): string | undefined {
  try {
    const item = lib.read(summary.id);
    const fmIntent = asStr(item.frontmatter.intent);
    if (fmIntent) return fmIntent;
  } catch {
    // Fall back to summary excerpt if file cannot be read
  }
  return summary.excerpt?.trim() || undefined;
}

export function suggestProjects(lib: Library, query: string, limit = 5): ProjectSuggestion[] {
  const trimmed = query.trim();
  const cap = Math.max(0, Math.floor(limit));
  if (!trimmed || cap === 0) return [];

  const queryNorm = normalizeText(trimmed);
  const queryCompact = compactText(trimmed);
  const rawTokens = queryNorm ? queryNorm.split(' ').filter(Boolean) : [];
  const tokens = [...new Set(rawTokens.filter((t) => t.length >= 2 && !QUERY_STOPWORDS.has(t)))];

  const candidates = new Map<string, { summary: ItemSummary; score: number }>();

  for (const hit of lib.index.search(trimmed, { type: 'project', limit: cap })) {
    if (hit.item.type !== 'project') continue;
    const ftsScore = (Number.isFinite(hit.score) && hit.score > 0 ? hit.score : 1) + 20;
    const prev = candidates.get(hit.item.id);
    candidates.set(hit.item.id, {
      summary: hit.item,
      score: prev ? Math.max(prev.score, ftsScore) : ftsScore,
    });
  }

  for (const summary of lib.index.list({ type: 'project', limit: 200 }).items) {
    if (summary.type !== 'project') continue;
    const fuzzyScore = scoreProjectSummary(summary, queryNorm, queryCompact, tokens);
    if (fuzzyScore <= 0) continue;
    const prev = candidates.get(summary.id);
    candidates.set(summary.id, {
      summary: prev?.summary ?? summary,
      score: (prev?.score ?? 0) + fuzzyScore,
    });
  }

  return [...candidates.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const titleCmp = a.summary.title.localeCompare(b.summary.title);
      return titleCmp !== 0 ? titleCmp : a.summary.id.localeCompare(b.summary.id);
    })
    .slice(0, cap)
    .map(({ summary }) => {
      const intent = projectIntent(lib, summary);
      return {
        id: summary.id,
        slug: summary.slug,
        title: summary.title,
        ...(intent ? { intent } : {}),
      };
    });
}

export function isActiveMemory(item: Item): boolean {
  if (item.type !== 'memory') return false;
  const m = rawMemoryObj(item);
  if (!m) return true;
  return m.lifecycle === 'active';
}

export function proposeMemory(lib: Library, input: ProposeMemoryInput, author: Author): Proposal {
  const fact = input.fact.trim();
  if (!fact) throw new Error('Fact is required');

  const title =
    input.title?.trim() ||
    fact
      .replace(/\s+/g, ' ')
      .slice(0, 72)
      .replace(/[.,;:]?\s+\S*$/, '') ||
    fact.slice(0, 72);

  const agent = input.agent?.trim() || (author.startsWith('agent:') ? author.slice('agent:'.length) : author) || 'agent';
  const capturedVia = input.capturedVia ?? `mcp:${agent}`;
  const threadId = input.threadId?.trim().slice(0, 200) || undefined;

  const projectIds: string[] = [];
  if (input.project !== undefined && input.project.trim() !== '') {
    const projectQuery = input.project.trim();
    const proj = lib.find(projectQuery);
    if (!proj || proj.type !== 'project') {
      throw new UnknownProjectError(projectQuery, suggestProjects(lib, projectQuery));
    }
    projectIds.push(proj.id);
  }

  const sources: MemorySource[] = [];
  for (const s of input.sources ?? []) {
    if (sources.length >= 5) break;
    const entry: MemorySource = {};
    const ref = (s.item ?? s.item_id)?.trim();
    if (ref) {
      const found = lib.find(ref);
      if (found) entry.item_id = found.id;
    }
    const url = s.url?.trim();
    if (url) entry.url = url;
    const quote = s.quote?.trim().slice(0, 300);
    if (quote) entry.quote = quote;
    if (entry.item_id || entry.url || entry.quote) sources.push(entry);
  }

  const memoryFm: MemoryFrontmatter = {
    schema_version: 1,
    lifecycle: 'proposed',
    proposed_by: author,
    proposed_at: nowIso(),
    ...(threadId ? { thread_id: threadId } : {}),
    ...(projectIds.length ? { project_ids: projectIds } : {}),
    ...(sources.length ? { sources } : {}),
  };

  const item = lib.create(
    {
      type: 'memory',
      title,
      body: fact + '\n',
      tags: input.tags,
      status: 'inbox',
      captured_via: capturedVia,
      frontmatter: {
        agent,
        memory: memoryFm,
      },
    },
    author,
  );

  const proposal = itemToProposal(item)!;
  emitMemoryEvent(lib, item, proposal, 'app', author);
  return proposal;
}

export function listProposals(lib: Library, query: ListProposalsQuery = {}): { proposals: Proposal[]; total: number } {
  const statusFilter = query.status ?? 'proposed';
  let indexStatus: Status | Status[] | undefined;
  switch (statusFilter) {
    case 'proposed':
      indexStatus = 'inbox';
      break;
    case 'approved':
      indexStatus = 'library';
      break;
    case 'rejected':
      indexStatus = 'archived';
      break;
    case 'all':
      indexStatus = undefined;
      break;
  }

  const { items } = lib.index.list({ type: 'memory', status: indexStatus, limit: 100_000 });
  const matched: Proposal[] = [];
  for (const summary of items) {
    const item = lib.read(summary.id);
    const p = itemToProposal(item);
    if (!p) continue;
    if (statusFilter === 'approved' && (p.status !== 'approved' || !p.decided_at)) continue;
    if (statusFilter === 'proposed' && p.status !== 'proposed') continue;
    if (statusFilter === 'rejected' && p.status !== 'rejected') continue;
    if (statusFilter === 'all' && p.status === 'approved' && !p.decided_at) continue;
    if (query.projectId && !p.project_ids.includes(query.projectId)) continue;
    if (query.threadId && p.thread_id !== query.threadId) continue;
    if (query.agent && p.agent !== query.agent) continue;
    matched.push(p);
  }

  matched.sort((a, b) => {
    const cmp = b.proposed_at.localeCompare(a.proposed_at);
    return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
  });

  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.max(1, query.limit ?? 50);
  return {
    proposals: matched.slice(offset, offset + limit),
    total: matched.length,
  };
}

export function proposalCounts(lib: Library): ProposalCounts {
  const { proposals } = listProposals(lib, { status: 'proposed', limit: 100_000 });
  const byProject: Record<string, number> = {};
  const byThread: Record<string, number> = {};
  for (const p of proposals) {
    for (const pid of p.project_ids) {
      byProject[pid] = (byProject[pid] ?? 0) + 1;
    }
    if (p.thread_id) {
      byThread[p.thread_id] = (byThread[p.thread_id] ?? 0) + 1;
    }
  }
  return { total: proposals.length, byProject, byThread };
}

export function getProposal(lib: Library, ref: string): Proposal | null {
  const item = lib.find(ref);
  if (!item) return null;
  return itemToProposal(item);
}

export function approveProposal(
  lib: Library,
  ref: string,
  opts: { text?: string; title?: string; baseHash?: string; via?: string } = {},
  author: Author = 'you',
): Proposal {
  const item = lib.find(ref);
  if (!item) throw new NotFoundError(ref);
  const current = itemToProposal(item);
  if (!current) throw new NotFoundError(ref);
  if (current.status !== 'proposed') throw new AlreadyDecidedError(current);

  if (opts.text !== undefined && opts.text.trim() === '') {
    throw new Error('Text cannot be empty');
  }

  const prev = rawMemoryObj(item)!;
  const oldText = item.body.trim();
  const nextText = opts.text !== undefined ? opts.text.trim() : undefined;
  const edited = nextText !== undefined && nextText !== oldText;
  const nextTitle = opts.title?.trim() || undefined;
  const finalTitle = nextTitle ?? item.title;

  const nextMemory: Record<string, unknown> = {
    ...prev,
    lifecycle: 'active' satisfies MemoryLifecycle,
    decided_by: author,
    decided_at: nowIso(),
  };
  if (edited) nextMemory.original_text = oldText;

  const note = `approve memory “${finalTitle}”${opts.via ? ` (via ${opts.via})` : ''}`;
  const updated = lib.update(
    item.id,
    {
      body: nextText !== undefined ? nextText + '\n' : undefined,
      frontmatter: {
        status: 'library',
        ...(nextTitle ? { title: nextTitle } : {}),
        memory: nextMemory as unknown as MemoryFrontmatter,
      },
      baseHash: opts.baseHash ?? item.hash,
    },
    author,
    note,
  );

  const proposal = itemToProposal(updated)!;
  emitMemoryEvent(lib, updated, proposal, 'app', author);
  return proposal;
}

export function rejectProposal(
  lib: Library,
  ref: string,
  opts: { reason?: string; baseHash?: string; via?: string } = {},
  author: Author = 'you',
): Proposal {
  const item = lib.find(ref);
  if (!item) throw new NotFoundError(ref);
  const current = itemToProposal(item);
  if (!current) throw new NotFoundError(ref);
  if (current.status !== 'proposed') throw new AlreadyDecidedError(current);

  const prev = rawMemoryObj(item)!;
  const reason = opts.reason?.trim().slice(0, 500) || undefined;
  const nextMemory: Record<string, unknown> = {
    ...prev,
    lifecycle: 'rejected' satisfies MemoryLifecycle,
    decided_by: author,
    decided_at: nowIso(),
    ...(reason ? { reject_reason: reason } : {}),
  };

  const note = `reject memory “${item.title}”${opts.via ? ` (via ${opts.via})` : ''}`;
  const updated = lib.update(
    item.id,
    {
      frontmatter: {
        status: 'archived',
        memory: nextMemory as unknown as MemoryFrontmatter,
      },
      baseHash: opts.baseHash ?? item.hash,
    },
    author,
    note,
  );

  const proposal = itemToProposal(updated)!;
  emitMemoryEvent(lib, updated, proposal, 'app', author);
  return proposal;
}
