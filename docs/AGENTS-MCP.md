# Connecting AI agents (MCP)

Cabinet is an MCP server, so any MCP-capable agent can use your library as memory and context. There are two ways in:

| Transport | For | Auth | Git author |
| --- | --- | --- | --- |
| **stdio** (`cabinet mcp`) | Agents on the same computer: Claude Code, Claude Desktop, Cursor, … | None. The agent runs Cabinet as a subprocess with direct file access. | `agent:<--agent name>` |
| **Streamable HTTP** (`/mcp`) | Agents elsewhere: another machine, a server, a phone app | A per-agent bearer token from **Settings → Agents** (or `cabinet token <name>`) | `agent:<token name>` |

Every change an agent makes is a normal git commit in your library with the agent as author, so `git log --author=agent:` shows exactly what agents did and `git revert` undoes it.

## Claude Code

```bash
claude mcp add cabinet -- node /path/to/cabinet/apps/cli/src/main.ts mcp --agent claude-code
```

Add `--library ~/Cabinet` if your library isn't the default. Or put this in `.mcp.json` / `--mcp-config`:

```json
{
  "mcpServers": {
    "cabinet": {
      "command": "node",
      "args": ["/path/to/cabinet/apps/cli/src/main.ts", "mcp", "--library", "/Users/you/Cabinet", "--agent", "claude-code"]
    }
  }
}
```

Tested with Claude Code 2.1: `claude -p "call get_context for 'reading corner lighting', then remember …" --mcp-config cabinet.json` returned the project intent from the library and wrote `memories/reading-corner-lamp-height.md`, committed as `agent:claude-code`.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cabinet": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/cabinet/apps/cli/src/main.ts", "mcp", "--agent", "claude-desktop"]
    }
  }
}
```

Use the absolute path to Node 24+ (Desktop doesn't load your shell's PATH).

## Remote agents over HTTP

1. Allow network access in **Settings → Access** and set a passphrase (or run Cabinet behind Tailscale).
2. Create a token in **Settings → Agents**. It's shown once.
3. Point the agent at `http(s)://<host>:4747/mcp` with `Authorization: Bearer cab_…`:

```json
{
  "mcpServers": {
    "cabinet": { "type": "http", "url": "http://my-server:4747/mcp", "headers": { "Authorization": "Bearer cab_…" } }
  }
}
```

The HTTP endpoint is stateless (a fresh MCP session per request) and always requires a token, even from localhost, so every write is attributable.

## Tools

| Tool | What it does |
| --- | --- |
| `search` | Keyword + meaning search. Each hit says where it matched (title, note, content, tag, PDF text, similar meaning). |
| `get_item` | Full Markdown, frontmatter, `hash`, backlinks, projects and outgoing links for one item (by id, slug, title or `[[link]]`). |
| `get_context(topic)` | A compact briefing for agents: relevant memories, projects (intent, material, open questions, to-dos), and notes/sources with why they were saved and short excerpts. |
| `list_recent` | Newest items, optionally by type or status. |
| `list_projects` | Projects with status, kind, intent and section names. |
| `get_backlinks` | What links to an item, including projects and their per-project context. |
| `get_graph` | The neighbourhood of an item, 1–3 hops. |
| `capture` | Save a URL or text (quote/text/note) to the inbox, or straight into a project. URLs are fetched in the background. |
| `create_note` | Write a note; reports any `[[links]]` that don't resolve yet. |
| `update_note` | Replace the body (needs `base_hash` from `get_item`; refused if the file changed since) or `append` text. |
| `link_items` | Add `[[target]]` to an item's `## Related` list with an optional note. |
| `add_to_project` | Reference an item in a project's `## Material`, in a section, with context. |
| `remember` | Store a short durable fact in `memories/` (`type: memory`, `agent: <name>`). |
| `recall` | Search memories. |

Every item is also an MCP resource at `cabinet://item/{id}` (Markdown).

## Agents with plain file access

Agents that can read files but don't speak MCP can read `AGENTS.md` at the root of the library. It explains the folder layout, frontmatter and linking conventions. Changes they make on disk are picked up by Cabinet's file watcher and committed as `you`.
