# Cabinet: personal hobby, research and AI memory hub

## Context
One local-first home for collecting inspiration (like Sublime), thinking in linked Markdown (like Obsidian, but with its own identity), and running hobby projects. It is also the central memory and context bank for AI agents. It runs on a Mac now and can move to a 24/7 Windows/Linux box later.

Decisions:
- **Name:** Cabinet. The folder is renamed to `cabinet`.
- **Repo:** private GitHub repo `latrael/cabinet`, MIT license so it can go public later, with commits at every milestone.
- **Storage:** Markdown files with YAML frontmatter are the source of truth, using our own conventions. Obsidian compatibility is a side benefit, not the design driver. The library is its own git repo and auto-commits each change, labelled by who made it.
- **Library location:** `~/Cabinet`. Dev and tests use a synthetic sample library.
- **Design:** warm paper aesthetic (cream background, serif reading type, tactile cards).
- **AI:** pluggable providers (Ollama by default, Claude/OpenAI optional). First release includes semantic search, chat with the library, auto-enrich suggestions and a background inbox agent.
- **Agent access:** MCP server, both stdio (local agents) and HTTP with a token (remote agents).
- **On the go:** a Telegram bot, with voice notes saved and transcribed locally using whisper.cpp.
- **Access:** single user. Localhost by default. LAN/Tailscale access requires a passphrase, and each agent gets its own token.
- **Runtime:** a Node process on the Mac (optionally a launchd service) plus a Docker image for the home server.
- **Order:** build the core first, then the AI layer, in one continuous build.

## Stack, and why
- **TypeScript everywhere, pnpm workspace.** One language across server, web, MCP and CLI. Runs the same on macOS, Linux, Windows and Docker.
- **Server: Hono on Node 26.** Small, fast and typed. It also serves the built web app, so there's one process and one port (`localhost:4747`).
- **Index: built-in `node:sqlite` with FTS5.** No native compile, so it's portable. Embedding vectors are stored as BLOBs and searched by brute-force cosine, which is plenty for a personal library; `sqlite-vec` can be added later. The whole DB is disposable and rebuilt from the files.
- **Web: React + Vite + TanStack Router/Query, Tailwind v4 with custom design tokens, Radix primitives.**
  - Editor: CodeMirror 6 with `[[` autocomplete and inline Markdown styling.
  - Graph: `d3-force` on a canvas.
- **Capture:**
  - `@mozilla/readability` + `linkedom` + `turndown` for article to Markdown.
  - OpenGraph for previews; YouTube/Vimeo oEmbed for videos.
  - `unpdf` for PDF text and thumbnails; `sharp` for image thumbnails.
- **Infrastructure:** `chokidar` for watching external edits; `simple-git` for auto-commit.
- **AI:** AI SDK provider abstraction. Ollama goes through its OpenAI-compatible endpoint; Anthropic/OpenAI are optional and need a key. Default models are `nomic-embed-text` and `qwen3:8b`.
- **MCP:** `@modelcontextprotocol/sdk`. **Telegram:** grammY long-polling, so no public port is needed. **Transcription:** whisper.cpp + ffmpeg, installed via Homebrew and included in the Docker image.
- **Tests:** Vitest (core, server, MCP) and Playwright (end-to-end flows and screenshots).

## Repo layout
```
cabinet/
  packages/core/     library format, parser/serializer, link resolver, indexer, search, watcher, git, export/restore
  packages/ai/       providers, embeddings, hybrid search, chat agent, enrichment, inbox agent, transcription
  packages/mcp/      MCP tools/resources; stdio entry + HTTP handler
  apps/server/       Hono API, SSE live updates, auth, capture pipeline, job runner, Telegram bot
  apps/web/          React SPA
  apps/cli/          `cabinet start|mcp|rebuild|export|restore|init|token`
  sample-library/    synthetic content (listening rooms, reading corner, etc.)
  docs/              STORAGE.md, SETUP.md, AGENTS-MCP.md, LIMITATIONS.md, screenshots/
  e2e/               Playwright specs
  Dockerfile, docker-compose.yml, launchd/com.cabinet.plist
```

## Storage format (documented in `docs/STORAGE.md`)
```
~/Cabinet/
  AGENTS.md              explains the format to any agent with file access
  notes/<slug>.md        your thinking
  sources/<slug>.md      article | link | quote | text | video | image | pdf | audio
  projects/<slug>.md
  collections/<slug>.md  optional description and cover for a collection
  memories/<slug>.md     short atomic facts written by agents ("remember")
  attachments/YYYY/MM/<id>-<name>.<ext>
  .cabinet/              config.json (committed); index.sqlite, cache/, thumbs/, secrets.json (gitignored)
  .gitignore
```
- **Frontmatter:**
  - Core fields: `id` (ULID, survives renames), `type`, `title`, `created`, `updated`, `status` (inbox|library|archived).
  - Optional: `why`, `tags[]`, `collections[]`.
  - Provenance: `source {url, author, site, published}`, `captured_via` (web|telegram|mcp:<agent>|cli).
  - Files: `attachment` and `cover` as relative paths. `extraction` (ok|failed|manual).
- **Body:** a user notes area, then a `## Content` section holding extracted article or PDF text.
  - Videos get a `## Timestamps` list in the form `- [04:12](https://youtu.be/ID?t=252) note`.
- **Links:** `[[slug]]`, `[[slug|alias]]` and `![[attachment]]` embeds, resolved by filename, title or alias.
  - When the app renames a file, it rewrites the links pointing to it.
  - Tag and collection membership lives in the item's frontmatter.
  - A project's material lives in its body under `## Material`. `###` headings are sections, and each list line is `- [[slug]]: per-project context`. Notes, Questions and Checklist (`- [ ]`) are further sections. No content is ever duplicated.
- **Index:** items, links, tags, an FTS table (title, why, body, content, tags), chunks and embeddings are derived from the files and regenerable. Chats, pending AI suggestions, digests and interaction state live separately in `.cabinet/state.sqlite`; this local app state is not reconstructable exactly from Markdown.

## Signature flow: paste → context → connected
1. Paste anywhere: global `⌘V` on any screen with no input focused (URLs, images, text, files); also `⌘K`, "+", Telegram or MCP.
2. A capture sheet opens instantly with an optimistic preview card; metadata and readable content fill in from the background.
3. Add context in the same sheet: "Why I saved this" (with `[[` autocomplete), tags, collections/projects. `Enter` saves, `⌘Enter` saves and opens.
4. "Connects to…" lists related items (embeddings when available, keyword search otherwise). One click links.
5. Saved items land in the inbox already connected. AI enrichment proposes more later, pending approval.

Target: paste to saved in under 3 seconds, no required fields.

## Projects you organize yourself
- Create from "New project" or `⌘K → New project`: title, optional kind (hobby / learning / writing / build), short intent.
- Capturing while a project is open saves into that project (skipping the inbox). The item still lives once in `sources/`.
- "Gather" adds existing material via search or drag from the side panel.
- Per-project context on each item, separate from the item's general "why".
- Named sections, drag to reorder, Notes / Questions / Checklist, cover image, status (active / paused / done), cards or list view.
- Stored in the project body:
  ```markdown
  ## Material
  ### Lighting
  - [[japanese-listening-rooms]]: the low warm light is the feeling I want
  - [[paper-lamp-photo]]
  ### To buy
  - [[akari-lamp]]: check sizes first
  ## Questions
  - How much sound dampening does a reading corner need?
  ## Checklist
  - [ ] Measure the corner
  ```

## Key behaviours
- **Capture:** "+", `⌘K`, paste anywhere, drag-and-drop, Telegram, MCP. `status: inbox` by default. Failed extraction is saved with `extraction: failed` and offers manual paste. Remote thumbnails are cached locally.
- **External edits:** watcher reindexes and pushes SSE. Saves carry a base hash; on mismatch the server returns 409 and the UI offers keep mine / take disk / save copy.
- **Git:** debounced auto-commit (~30s) authored as `you`, `agent:<name>`, `telegram` or `inbox-agent`. Optional push to a private remote.
- **Search:** FTS5 BM25 + vector similarity with reciprocal-rank fusion; snippets labelled by matched field. Fully local; degrades to keyword-only without Ollama.
- **Home:** current interests, recent captures, inbox count, a daily-seeded "Revisit".
- **Graph:** focused on one item at depth 1–3, click to expand, type filters, mini graph in the item side panel.
- **Item view:** reader / video / PDF / image, notes editor, connections panel (backlinks, outgoing, related, AI suggestions, mini graph).
- **AI suggestions:** tags, summary, related items and link proposals in a tray; nothing written until accepted. Scheduled inbox agent digest. Chat agent cites `[[items]]`, answers can be saved as notes.
- **MCP tools:** `search`, `get_item`, `get_context(topic)`, `list_recent`, `capture`, `create_note`, `update_note` (base hash), `link_items`, `add_to_project`, `list_projects`, `get_backlinks`, `get_graph`, `remember`, `recall`; resources at `cabinet://item/{id}`.
- **Telegram:** pairing code from Settings, allowlisted chat IDs; text, links, photos, PDFs, voice notes; `/search`, `/ask`.
- **Export/restore:** zip export (index/cache excluded, git history optional); restore validates, moves the current library aside, rebuilds. "Rebuild index" in Settings and `cabinet rebuild`.
- **Settings:** library path, AI providers and keys, models, MCP tokens, Telegram, git remote, passphrase, export/restore, rebuild.

## Milestones (commit and push after each)
0. Write this plan to `PLAN.md`.
1. Scaffold workspace, TypeScript, Vitest, lint. `git init`, `gh repo create latrael/cabinet --private`, LICENSE (MIT), README stub.
2. Core: format parser/serializer, link resolver, indexer, FTS, watcher, git auto-commit, sample-library generator, unit tests.
3. Server: REST API, capture pipeline (article/quote/text/note/image/pdf/video), SSE, conflict handling, auth.
4. Web: design system, app shell, home, inbox, library, item view, editor, quick capture.
5. Links, backlinks, graph, projects, collections, search page with match explanations.
6. Export/restore, rebuild, settings. Playwright end-to-end tests with screenshots.
7. AI: providers, embeddings and hybrid search, chat, enrichment suggestions, inbox agent. Ollama models pulled.
8. MCP (stdio + HTTP) plus config snippet for Claude Code/Desktop, tested with a real MCP client.
9. Telegram bot plus whisper.cpp transcription.
10. Dockerfile, compose, launchd plist, docs (SETUP, STORAGE, MCP, LIMITATIONS), final screenshots. Rename `hobbyhub` → `cabinet` last.

## Progress (2026-11-14)
- Milestones 0–8: implemented in the existing milestone commits.
- **Milestone 9: implemented and locally verified.** Telegram private-chat pairing, chat allowlist/revocation, text/link/photo/PDF/audio/voice capture, `/search`, `/ask`, live Settings status, polling lifecycle and local whisper.cpp transcription. Setup: `docs/TELEGRAM.md`.
- Verification at milestone 9: **77 Vitest tests passed**, including real OGG → ffmpeg → Whisper → searchable library text; the Telegram Settings Playwright test passed; lint, typecheck and web build passed. Telegram API calls and AI command responses use mocks in these new tests. Real phone/BotFather delivery remains unverified; no personal bot token was supplied.
- **Milestone 10: implemented and verified.** Multi-stage Docker image (Node, built web app, Git, ffmpeg, whisper.cpp), Compose with external parent data/model mounts and non-root UID mapping, first-passphrase CLI, launchd plist/renderer, complete README and SETUP/STORAGE/LIMITATIONS/MCP guides, and 13 documented screenshots. The folder is already named `cabinet`.
- Final verification: **80 Vitest tests and 11 Playwright browser flows passed**, plus lint, typecheck and production web build. Linux ARM64 container smoke passed for empty/sample libraries, authentication, captures/search, native image/PDF processing, MCP HTTP, real OGG transcription, restart persistence and export/restore. The documented Compose init/passphrase/start/login flow passed. The launchd template was rendered/linted and the hidden passphrase prompt was checked in a real terminal. No persistent service was installed.
- **Milestones 0–10 are complete.** Remaining owner setup/verification: optional live BotFather/phone delivery, hosted provider keys/models, and installing a chosen background service. Native Windows/Linux-host, Linux AMD64 containers and long-running unattended operation are not verified; see `docs/LIMITATIONS.md`.

## Verification
- **Vitest:** format round-trip, link/backlink resolution, rebuild == live index, conflict detection, export → restore byte-identical, MCP via in-memory client, offline search with match labels.
- **Playwright** against a temp copy of the sample library (screenshots to `docs/screenshots/`): paste-capture flow under 3s; article/quote/PDF/video capture; note with backlinks; graph; hand-made project with paste, gather, sections, reorder and Markdown check; restart; external edit + conflict; offline search; rebuild; export/restore.
- **Obsidian:** format-level compatibility test; open as a vault if Obsidian is installed.
- **Real-world:** MCP from Claude Code via stdio; Telegram live only with a BotFather token (else mocked); Docker image with the sample library mounted.
- **Deliverables:** README, `docs/STORAGE.md`, `docs/LIMITATIONS.md`, screenshots.
