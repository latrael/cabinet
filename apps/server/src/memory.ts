import { Hono, type Context } from 'hono';
import {
  AlreadyDecidedError,
  ConflictError,
  NotFoundError,
  approveProposal,
  getProposal,
  listProposals,
  proposalCounts,
  rejectProposal,
} from '@cabinet/core';
import type { ServerContext, Vars } from './context.ts';

const VALID_STATUSES = new Set(['proposed', 'approved', 'rejected', 'all']);

function errorResponse(c: Context, e: unknown) {
  if (e instanceof AlreadyDecidedError) return c.json({ error: 'already_decided', message: e.message, current: e.current }, 409);
  if (e instanceof ConflictError) return c.json({ error: 'conflict', message: e.message, current: e.current }, 409);
  if (e instanceof NotFoundError) return c.json({ error: 'not_found', message: e.message }, 404);
  const msg = e instanceof Error ? e.message : String(e);
  return c.json({ error: 'bad_request', message: msg }, 400);
}

function canReview(c: Context<Vars>): boolean {
  const via = c.get('via');
  const scopes = c.get('scopes') ?? [];
  return via === 'local' || via === 'session' || (via === 'token' && scopes.includes('review'));
}

function viaTokenName(c: Context<Vars>): string | undefined {
  if (c.get('via') !== 'token') return undefined;
  return String(c.get('author')).replace(/^agent:/, '') || undefined;
}

export function memoryRoutes(ctx: ServerContext) {
  const r = new Hono<Vars>();

  r.get('/proposals', (c) => {
    const q = c.req.query();
    const status = q.status ?? 'proposed';
    if (!VALID_STATUSES.has(status)) {
      return c.json({ error: 'bad_request', message: `Invalid status: ${status}` }, 400);
    }

    let projectId: string | undefined;
    if (q.project) {
      const proj = ctx.lib.find(q.project);
      if (!proj || proj.type !== 'project') {
        return c.json({ proposals: [], total: 0 });
      }
      projectId = proj.id;
    }

    const limit = q.limit !== undefined ? Math.min(Math.max(1, Math.floor(Number(q.limit) || 50)), 200) : 50;
    const offset = q.offset !== undefined ? Math.max(0, Math.floor(Number(q.offset) || 0)) : 0;

    return c.json(
      listProposals(ctx.lib, {
        status: status as 'proposed' | 'approved' | 'rejected' | 'all',
        projectId,
        threadId: q.thread || undefined,
        agent: q.agent || undefined,
        limit,
        offset,
      }),
    );
  });

  r.get('/proposals/counts', (c) => c.json(proposalCounts(ctx.lib)));

  r.get('/proposals/:id', (c) => {
    const proposal = getProposal(ctx.lib, c.req.param('id'));
    if (!proposal) return c.json({ error: 'not_found', message: `Proposal not found: ${c.req.param('id')}` }, 404);
    return c.json({ proposal });
  });

  r.post('/proposals/:id/approve', async (c) => {
    if (!canReview(c)) {
      return c.json({ error: 'forbidden', message: 'Agents cannot review proposals' }, 403);
    }
    try {
      const b = await c.req.json<{ text?: string; title?: string; baseHash?: string }>().catch(() => ({} as { text?: string; title?: string; baseHash?: string }));
      if (b.text !== undefined && (typeof b.text !== 'string' || b.text.trim() === '')) {
        return c.json({ error: 'bad_request', message: 'Text cannot be empty' }, 400);
      }
      const proposal = approveProposal(
        ctx.lib,
        c.req.param('id'),
        { text: b.text, title: b.title, baseHash: b.baseHash, via: viaTokenName(c) },
        'you',
      );
      ctx.ai?.onItemChanged(proposal.id, 'you');
      return c.json({ proposal });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  r.post('/proposals/:id/reject', async (c) => {
    if (!canReview(c)) {
      return c.json({ error: 'forbidden', message: 'Agents cannot review proposals' }, 403);
    }
    try {
      const b = await c.req.json<{ reason?: string; baseHash?: string }>().catch(() => ({} as { reason?: string; baseHash?: string }));
      const proposal = rejectProposal(
        ctx.lib,
        c.req.param('id'),
        { reason: b.reason, baseHash: b.baseHash, via: viaTokenName(c) },
        'you',
      );
      return c.json({ proposal });
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  return r;
}
