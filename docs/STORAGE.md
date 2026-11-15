# Library storage format

The library is separate from the app checkout. By default it is `~/Cabinet`; choose another folder with `cabinet path` or `--library`. A new library is empty unless initialized with `--sample`.

Markdown with YAML frontmatter and attachments are the source of truth. The app can rebuild its search index from these files. Obsidian can read the format, but Cabinet does not require Obsidian or its plugins.

## Folder layout

```text
Cabinet/
  AGENTS.md
  notes/<slug>.md
  sources/<slug>.md
  projects/<slug>.md
  collections/<slug>.md
  memories/<slug>.md
  attachments/YYYY/MM/<id>-<filename>.<ext>
  .cabinet/
    config.json
    secrets.json
    index.sqlite
    state.sqlite
    cache/
    thumbs/
    tmp/
    trash/
  .gitignore
  .git/
```

Notes, sources, projects, collections and memories contain indexed Markdown items. Other non-hidden Markdown files can also be indexed; `AGENTS.md` is agent guidance rather than a library item. Attachment paths use forward slashes relative to the library root. Binary files are kept as files rather than embedded into Markdown.

## Frontmatter

```yaml
---
id: 01JDX3KRVN7YBJK8F0QGWCM6AE
type: article
title: Paper lamps and evening light
created: 2026-11-14T18:00:00Z
updated: 2026-11-14T18:00:00Z
status: inbox
why: Lighting ideas for [[reading-corner]]
tags:
  - interiors
  - warm-light
collections:
  - Reading corner
source:
  url: https://example.org/paper-lamps
  author: Example Writer
  site: Example Journal
captured_via: web
extraction: ok
---

My own notes stay here.

## Content
Extracted article text goes here.
```

| Field | Meaning |
| --- | --- |
| `id` | ULID identity; preserved through app renames. Do not change it. |
| `type` | `note`, `article`, `link`, `quote`, `text`, `video`, `image`, `pdf`, `audio`, `project`, `collection`, `memory` |
| `title` | Display name; files have a separate slug derived from their filename |
| `created`, `updated` | ISO timestamps; app updates preserve `created` |
| `status` | `inbox`, `library` or `archived`; app-created captures default to inbox |
| `why` | Context for saving the item; may contain `[[links]]` |
| `tags`, `collections` | Membership arrays; tags are normalized by the app |
| `aliases` | Alternative names for link resolution |
| `source` | Optional `url`, `author`, `site`, `published` |
| `captured_via` | Provenance such as `web`, `telegram`, `cli` or `mcp:<agent>` |
| `attachment`, `cover` | Relative attachment paths; a cover can also originate as a remote URL cached for display |
| `extraction` | `pending`, `ok`, `failed` or `manual` |

Unknown frontmatter keys are retained. Saving through the app canonicalizes YAML formatting/key order; YAML comments are not preserved as metadata. Files imported without complete frontmatter may be readable/indexable, but use the app or follow the generated `AGENTS.md` to create stable identities and timestamps.

## Bodies and links

A source's own notes precede its `## Content` section. Extracted PDF text and voice transcripts also use `## Content`. Images/audio embed their original attachment using `![[attachments/...]]`; a failed extraction keeps the saved item and attachment. Manually supplied content uses `extraction: manual`.

Links support `[[slug]]`, `[[slug|label]]` and `![[attachment]]`. Markdown code is excluded from wikilink parsing. The resolver considers filenames, titles and aliases, and the index records backlinks and unresolved links. Prefer unique slugs; ambiguous duplicate titles are not a namespace system.

App renames preserve IDs and rewrite references to old names. Renaming files in another editor does not run the app's reference-rewrite operation. External file edits are watched, reindexed and sent to the browser over SSE.

Videos can include:

```markdown
## Timestamps
- [04:12](https://youtu.be/VIDEO_ID?t=252) A useful detail about placement
```

## Projects

A project is a Markdown item under `projects/`. Its frontmatter can include `kind` (`hobby`, `learning`, `writing`, `build`), `intent`, `project_status` (`active`, `paused`, `done`) and `view` (`cards`, `list`).

```markdown
## Material
### Lighting
- [[paper-lamps]]: I want this low, warm light
- [[lamp-photo]]
### To buy
- [[floor-lamp]]: Check the dimensions

## Notes
Keep the floor clear.

## Questions
- Would a wall light work better?

## Checklist
- [ ] Measure the corner
```

Material entries reference existing items; the content is not duplicated. The text after `:` is per-project context, separate from an item's general `why`. Sections and list order are stored in this body. Collections use frontmatter membership plus optional collection description items; they do not contain copied source files.

## Index, app state and secrets

| Path | Purpose | Rebuildable? | Git / content ZIP |
| --- | --- | --- | --- |
| `.cabinet/config.json` | Library/provider/model/git/network settings and paired chat IDs | Keep it | Committed / included |
| `.cabinet/index.sqlite*` | Item records, links, tags and full-text search | Yes, from library files | Ignored / excluded |
| `.cabinet/cache/` | Embedding cache/vector store and cached media | Recomputable/refetchable, sometimes needs models/network | Ignored / excluded |
| `.cabinet/thumbs/` | Generated thumbnails | Yes | Ignored / excluded |
| `.cabinet/state.sqlite*` | Chat history, suggestions, digests, opens and Telegram deduplication state | **No**, not byte-for-byte recoverable from Markdown | Ignored / excluded |
| `.cabinet/secrets.json` | API keys, bot token, pairing code, passphrase hash, session secret and hashed agent tokens | **No**, configure again if lost | Ignored / excluded |
| `.git/` | Local library history | Keep if you need history | Included in ZIP only with `--git` |

The generated `.gitignore` also excludes temporary/trash directories. The current ZIP exporter includes ordinary files outside its explicit cache/state/secrets exclusions, including trash if present; review what you keep in the library before sharing an export.

Losing the index does not lose content. Losing `state.sqlite` does lose unsaved chat/state, even though saved notes remain. Losing secrets invalidates access/configured integrations. A content ZIP is not a complete machine backup. For a full backup, stop Cabinet and copy the whole library including hidden files. See [Setup](SETUP.md#backups-restore-and-updates).

## Git and concurrent edits

The library has its own Git repository, independent of the app repo. Changes are debounced (30 seconds by default) into commits authored as `you`, `telegram`, `agent:<name>` or the relevant background agent. Push is disabled by default. A remote is optional and must be configured separately.

Web/API saves carry a base hash of the file bytes. A changed file returns HTTP 409 with the current version; the UI offers keep mine, take disk or save a copy. Writers with plain file access should read before writing and preserve IDs. Atomic file replacement and conflict checks are not a multi-user transaction system; run one web server per library.

## Export and restore

ZIP exports include library files, attachments and config, excluding generated caches/index, app state and secrets. History is optional. Restore validates paths/manifest, moves the current folder to a sibling `Cabinet.backup-<timestamp>`, extracts files, preserves existing destination secrets and rebuilds the index. A fresh destination cannot recover secrets from an export.

The parent directory must be writable and on the same filesystem for the rename. Docker therefore mounts the parent at `/data`, with the library at `/data/Cabinet`; binding the library itself as a mount point prevents this rename.
