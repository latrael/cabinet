import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Library } from '@cabinet/core';
import { createCabinetMcpServer, type McpDeps } from './server.ts';

export { createCabinetMcpServer, INSTRUCTIONS, type McpDeps } from './server.ts';
export const VERSION = '0.1.0';

/** Structural slice of the server context used for MCP over HTTP. */
interface HttpCtx {
  lib: Library;
  ai: { search: McpDeps['search']; related: McpDeps['related']; onItemChanged: (id: string, a: string) => void } | null;
  capture: {
    captureUrl: (input: any, author: string) => { item: any; duplicate?: boolean };
    captureText: (input: any, author: string) => { item: any; duplicate?: boolean };
  };
  extras: Record<string, any>;
}

export function depsFromContext(ctx: HttpCtx, agent: string, defaults?: McpDeps['defaults']): McpDeps {
  const author = `agent:${agent}`;
  return {
    lib: () => ctx.lib,
    agent,
    defaults,
    search: ctx.ai ? (q, o) => ctx.ai!.search!(q, o) : undefined,
    related: ctx.ai ? (t, o) => ctx.ai!.related!(t, o) : undefined,
    onChanged: (id) => ctx.ai?.onItemChanged(id, author),
    capture: async (input) => {
      const fields = { why: input.why, tags: input.tags, projectId: input.projectId, section: input.section, context: input.context, title: input.title, via: input.via };
      return input.url
        ? ctx.capture.captureUrl({ url: input.url, ...fields }, author)
        : ctx.capture.captureText({ text: input.text ?? '', kind: input.kind, author: input.author, ...fields }, author);
    },
  };
}

/**
 * Plugin for the Cabinet server: MCP over Streamable HTTP at /mcp.
 * Requires an agent token (Authorization: Bearer cab_…); the token's name becomes the git author.
 */
export function mountHttp(ctx: HttpCtx) {
  ctx.extras.mounts = ctx.extras.mounts ?? [];
  ctx.extras.mounts.push((app: any, guard: any) => {
    app.all('/mcp', guard, async (c: any) => {
      if (c.get('via') !== 'token') {
        return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP over HTTP needs an agent token. Create one in Settings → Agents.' }, id: null }, 401);
      }
      const scopes: string[] = c.get('scopes') ?? [];
      if (scopes.includes('review')) {
        return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Review tokens cannot be used for MCP; create a separate agent token.' }, id: null }, 401);
      }
      const agent = String(c.get('author')).replace(/^agent:/, '');
      const threadId = c.req.header('x-cabinet-thread')?.trim() || undefined;
      const project = c.req.header('x-cabinet-project')?.trim() || undefined;
      const defaults = threadId || project ? { threadId, project } : undefined;
      const server = createCabinetMcpServer(depsFromContext(ctx, agent, defaults));
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(c.req.raw);
      } finally {
        void server.close();
      }
    });
  });
}
