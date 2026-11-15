import { startServer, type RunningServer, type StartOptions } from '@cabinet/server';

export interface CabinetStartOptions {
  library: string;
  port?: number;
  host?: string;
  ai?: boolean;
  telegram?: boolean;
  watch?: boolean;
  quiet?: boolean;
  webDist?: string | null;
  gitDebounceMs?: number;
}

/** Wire the server with every integration (AI, MCP over HTTP, Telegram, transcription). */
export async function startCabinet(o: CabinetStartOptions): Promise<RunningServer> {
  const plugins: NonNullable<StartOptions['plugins']> = [];
  const integrations = await loadIntegrations();
  if (integrations.mcp) plugins.push(integrations.mcp);
  if (o.telegram !== false && integrations.telegram) plugins.push(integrations.telegram);
  return startServer({
    library: o.library,
    port: o.port,
    host: o.host,
    watch: o.watch,
    quiet: o.quiet,
    webDist: o.webDist,
    gitDebounceMs: o.gitDebounceMs,
    ai: o.ai === false ? undefined : integrations.ai,
    transcriber: integrations.transcriber,
    plugins,
  });
}

async function loadIntegrations(): Promise<{
  ai?: StartOptions['ai'];
  transcriber?: StartOptions['transcriber'];
  mcp?: NonNullable<StartOptions['plugins']>[number];
  telegram?: NonNullable<StartOptions['plugins']>[number];
}> {
  const out: Awaited<ReturnType<typeof loadIntegrations>> = {};
  try {
    const ai = await import('@cabinet/ai');
    if ((ai as any).createAiBridge) out.ai = (ctx) => (ai as any).createAiBridge(ctx);
    if ((ai as any).createTranscriber) out.transcriber = (ctx) => (ai as any).createTranscriber(ctx);
  } catch {
    /* AI package optional */
  }
  try {
    const mcp = await import('@cabinet/mcp');
    if ((mcp as any).mountHttp) out.mcp = (ctx) => (mcp as any).mountHttp(ctx);
  } catch {
    /* MCP optional */
  }
  try {
    const tg = await import('@cabinet/server/telegram' as string);
    if (tg.telegramPlugin) out.telegram = (ctx) => tg.telegramPlugin(ctx);
  } catch {
    /* Telegram optional */
  }
  return out;
}
