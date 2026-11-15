import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { Library } from '@cabinet/core';
import { createApp } from './app.ts';
import { Auth } from './auth.ts';
import { CapturePipeline } from './capture/pipeline.ts';
import { Thumbs } from './capture/media.ts';
import type { AiBridge, ServerContext, Transcriber } from './context.ts';
import { JobRunner } from './jobs.ts';

export interface StartOptions {
  library: string;
  port?: number;
  host?: string; // overrides config.server.allowRemote
  watch?: boolean;
  git?: boolean;
  gitDebounceMs?: number;
  webDist?: string | null;
  quiet?: boolean;
  /** Build the AI bridge once the library is open (milestone 7). */
  ai?: (ctx: ServerContext) => Promise<AiBridge | null> | AiBridge | null;
  transcriber?: (ctx: ServerContext) => Transcriber | null;
  /** Extra integrations (MCP HTTP, Telegram). Return a stop function. */
  plugins?: Array<(ctx: ServerContext) => Promise<(() => Promise<void>) | void> | (() => Promise<void>) | void>;
  extraHosts?: string[];
}

export interface RunningServer {
  ctx: ServerContext;
  url: string;
  port: number;
  close: () => Promise<void>;
  app: ReturnType<typeof createApp>;
}

export const VERSION = '0.1.0';

export function defaultWebDist(): string | null {
  const p = fileURLToPath(new URL('../../web/dist', import.meta.url));
  return existsSync(p) ? p : null;
}

export async function buildContext(opts: StartOptions): Promise<ServerContext> {
  const openLib = () =>
    Library.open(opts.library, { watch: opts.watch ?? true, git: opts.git, debounceMs: opts.gitDebounceMs });
  const lib = await openLib();
  const jobs = new JobRunner(lib);
  const thumbs = new Thumbs(lib.root);
  const ctx: ServerContext = {
    lib,
    auth: new Auth(lib, { extraHosts: opts.extraHosts }),
    jobs,
    thumbs,
    capture: new CapturePipeline(lib, jobs, thumbs),
    ai: null,
    transcriber: null,
    webDist: opts.webDist === undefined ? defaultWebDist() : opts.webDist,
    version: VERSION,
    startedAt: new Date().toISOString(),
    extras: { mounts: [] },
    reopen: async () => {
      const listeners = lib.listeners('error-log');
      ctx.lib = await openLib();
      for (const l of listeners) ctx.lib.on('error-log', l as any);
      ctx.jobs = new JobRunner(ctx.lib);
      ctx.thumbs = new Thumbs(ctx.lib.root);
      ctx.capture = new CapturePipeline(ctx.lib, ctx.jobs, ctx.thumbs, ctx.capture.hooks);
      ctx.auth = new Auth(ctx.lib, { extraHosts: opts.extraHosts });
      await ctx.extras.onReopen?.();
    },
  };
  if (!opts.quiet) lib.on('error-log', (e) => console.error('[cabinet]', e instanceof Error ? e.message : e));
  ctx.transcriber = opts.transcriber?.(ctx) ?? null;
  ctx.capture.hooks.transcribe = ctx.transcriber ? (p) => ctx.transcriber!.transcribe(p) : undefined;
  ctx.ai = (await opts.ai?.(ctx)) ?? null;
  ctx.capture.hooks.afterExtract = (id, author) => ctx.ai?.onItemChanged(id, author);
  return ctx;
}

/** Simulate having no internet: only loopback hosts can be fetched (used by offline tests). */
export function blockOutboundNetwork() {
  const real = globalThis.fetch;
  if ((real as any).__cabinetBlocked) return;
  const blocked: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return Promise.reject(new TypeError(`network blocked: ${host}`));
    return real(input, init);
  };
  (blocked as any).__cabinetBlocked = true;
  globalThis.fetch = blocked;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  if (process.env.CABINET_BLOCK_NETWORK === '1') blockOutboundNetwork();
  const ctx = await buildContext(opts);
  const stops: Array<() => Promise<void>> = [];
  for (const p of opts.plugins ?? []) {
    const stop = await p(ctx);
    if (stop) stops.push(stop);
  }
  const app = createApp(ctx);
  const host = opts.host ?? (ctx.lib.config.server.allowRemote ? '0.0.0.0' : '127.0.0.1');
  const port = opts.port ?? Number(process.env.CABINET_PORT ?? 4747);
  let server!: ServerType;
  const actualPort = await new Promise<number>((res, rej) => {
    server = serve({ fetch: app.fetch, port, hostname: host }, (info) => res(info.port));
    server.once('error', rej);
  });
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;
  if (!opts.quiet) console.log(`Cabinet ${VERSION} · library ${ctx.lib.root} · ${url}${host === '0.0.0.0' ? ' (listening on all interfaces)' : ''}`);
  return {
    ctx,
    app,
    url,
    port: actualPort,
    close: async () => {
      for (const s of stops) await s().catch(() => {});
      await ctx.ai?.close().catch(() => {});
      await new Promise<void>((r) => {
        (server as any).closeAllConnections?.();
        server.close(() => r());
      });
      await ctx.jobs.idle();
      await ctx.lib.close();
    },
  };
}
