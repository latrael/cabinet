import { randomInt } from 'node:crypto';
import { Hono } from 'hono';
import { deepMerge, defaultLibraryPath, setDefaultLibraryPath, type LibraryConfig } from '@cabinet/core';
import type { ServerContext, Vars } from './context.ts';

/** Settings never return secrets, only whether they are set. */
export function settingsRoutes(ctx: ServerContext) {
  const r = new Hono<Vars>();

  const view = async () => {
    const s = ctx.auth.secrets;
    return {
      config: ctx.lib.config,
      libraryPath: ctx.lib.root,
      defaultLibraryPath: defaultLibraryPath(),
      secrets: {
        passphrase: !!s.passphraseHash,
        anthropicKey: !!s.anthropicKey,
        openaiKey: !!s.openaiKey,
        telegramToken: !!s.telegramToken,
      },
      tokens: ctx.auth.listTokens(),
      telegram: ctx.extras.telegram?.status?.() ?? { running: false },
      transcription: ctx.transcriber ? await ctx.transcriber.available() : { ok: false, reason: 'not configured' },
      jobs: { pending: ctx.jobs.pending, failures: ctx.jobs.failures.slice(0, 10) },
      version: ctx.version,
      mcp: { httpUrl: '/mcp', stdio: 'cabinet mcp' },
    };
  };

  const localOnly = (via: string) => {
    if (via !== 'local') throw new Error('This setting can only be changed from the computer running Cabinet');
  };

  r.get('/', async (c) => c.json(await view()));
  r.get('/telegram', (c) => c.json({
    ...(ctx.extras.telegram?.status?.() ?? { running: false }),
    allowedChats: ctx.lib.config.telegram.allowedChats,
  }));

  r.put('/', async (c) => {
    const patch = await c.req.json<Partial<LibraryConfig>>();
    if (patch.server && c.get('via') !== 'local') return c.json({ error: 'forbidden', message: 'Remote access settings can only be changed locally' }, 403);
    const next = deepMerge(ctx.lib.config, patch);
    ctx.lib.saveConfig(next);
    await ctx.extras.onConfigChanged?.();
    return c.json(await view());
  });

  r.put('/secrets', async (c) => {
    const b = await c.req.json<{ anthropicKey?: string | null; openaiKey?: string | null; telegramToken?: string | null }>();
    for (const k of ['anthropicKey', 'openaiKey', 'telegramToken'] as const) {
      if (b[k] === undefined) continue;
      if (b[k] === null || b[k] === '') delete ctx.auth.secrets[k];
      else ctx.auth.secrets[k] = String(b[k]).trim();
    }
    ctx.auth.save();
    await ctx.extras.onConfigChanged?.();
    return c.json(await view());
  });

  r.post('/passphrase', async (c) => {
    try {
      localOnly(c.get('via'));
      const { passphrase } = await c.req.json<{ passphrase: string | null }>();
      ctx.auth.setPassphrase(passphrase);
      return c.json(await view());
    } catch (e) {
      return c.json({ error: 'bad_request', message: (e as Error).message }, 400);
    }
  });

  r.post('/tokens', async (c) => {
    const { name, scopes } = await c.req.json<{ name: string; scopes?: string[] }>();
    const t = ctx.auth.createToken(name || 'agent', { scopes });
    return c.json({ ...t, note: 'Copy this token now. It is shown only once.' });
  });

  r.delete('/tokens/:id', async (c) => {
    ctx.auth.revokeToken(c.req.param('id'));
    return c.json(await view());
  });

  r.post('/telegram/pair', async (c) => {
    const code = String(randomInt(100000, 999999));
    ctx.auth.secrets.telegramPairing = { code, expires: Date.now() + 10 * 60_000 };
    ctx.auth.save();
    return c.json({ code, expiresInMinutes: 10 });
  });

  r.delete('/telegram/chats/:chat', async (c) => {
    const id = Number(c.req.param('chat'));
    const cfg = ctx.lib.config;
    cfg.telegram.allowedChats = cfg.telegram.allowedChats.filter((x) => x !== id);
    ctx.lib.saveConfig(cfg);
    return c.json(await view());
  });

  r.put('/library-path', async (c) => {
    try {
      localOnly(c.get('via'));
      const { path } = await c.req.json<{ path: string }>();
      if (!path?.trim()) throw new Error('Path required');
      setDefaultLibraryPath(path.trim());
      return c.json({ ok: true, restartRequired: true, path: path.trim() });
    } catch (e) {
      return c.json({ error: 'bad_request', message: (e as Error).message }, 400);
    }
  });

  r.get('/git/log', async (c) => c.json({ commits: (await ctx.lib.git?.log(30)) ?? [] }));
  r.post('/git/commit', async (c) => {
    await ctx.lib.git?.flush();
    return c.json({ ok: true });
  });

  return r;
}
