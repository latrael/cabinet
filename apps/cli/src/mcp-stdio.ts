import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Library, loadSecrets } from '@cabinet/core';
import { createCabinetMcpServer, type McpDeps } from '@cabinet/mcp';
import { CapturePipeline, JobRunner, Thumbs } from '@cabinet/server';

/**
 * MCP over stdio for local agents (Claude Code, Claude Desktop). Opens the library directly;
 * stdout carries only JSON-RPC, so all logging goes to stderr.
 */
export async function runStdio(opts: { library: string; agent: string; ai?: boolean; defaults?: McpDeps['defaults'] }) {
  const lib = await Library.open(opts.library, { watch: true });
  lib.on('error-log', (e) => process.stderr.write(`[cabinet] ${e instanceof Error ? e.message : String(e)}\n`));
  const jobs = new JobRunner(lib, 1);
  const thumbs = new Thumbs(lib.root);
  const capture = new CapturePipeline(lib, jobs, thumbs);
  const host = { lib, auth: { secrets: loadSecrets(lib.root) }, jobs, extras: {} as Record<string, any> };
  let ai: any = null;
  if (opts.ai !== false && lib.config.ai.provider !== 'none') {
    try {
      const { AiService } = await import('@cabinet/ai');
      ai = new AiService(host);
      void ai.embedAll().catch(() => {});
    } catch {
      ai = null;
    }
  }
  const author = `agent:${opts.agent}`;
  const server = createCabinetMcpServer({
    lib: () => lib,
    agent: opts.agent,
    defaults: opts.defaults,
    search: ai ? (q, o) => ai.search(q, o) : undefined,
    related: ai ? (t, o) => ai.related(t, o) : undefined,
    onChanged: (id) => ai?.queueEmbed(id),
    capture: async (input) => {
      const fields = { why: input.why, tags: input.tags, projectId: input.projectId, section: input.section, context: input.context, title: input.title, via: input.via };
      return input.url ? capture.captureUrl({ url: input.url, ...fields }, author) : capture.captureText({ text: input.text ?? '', kind: input.kind, author: input.author, ...fields }, author);
    },
  });
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await jobs.idle();
    await ai?.close();
    await lib.close(); // flushes pending git commits
    process.exit(0);
  };
  transport.onclose = () => void shutdown();
  process.stdin.on('end', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await server.connect(transport);
  process.stderr.write(`[cabinet] MCP server ready on stdio for agent "${opts.agent}" (library ${lib.root})\n`);
}
