export function agentsMd(): string {
  return `# AGENTS.md — how this Cabinet library works

This folder is a **Cabinet** library: a personal collection of notes, saved sources and projects,
stored as plain Markdown files with YAML frontmatter. Cabinet (the app) indexes these files;
the files are the source of truth. If you are an AI agent with file access, read this first.
If you can, prefer the Cabinet MCP server (\`cabinet mcp\`), which keeps the index and git history tidy.

## Folders

| Folder | Contains |
| --- | --- |
| \`notes/\` | The owner's own thinking (\`type: note\`). |
| \`sources/\` | Saved things: \`article\`, \`link\`, \`quote\`, \`text\`, \`video\`, \`image\`, \`pdf\`, \`audio\`. |
| \`projects/\` | Hobby projects (\`type: project\`). |
| \`collections/\` | Optional description/cover for a collection (\`type: collection\`). |
| \`memories/\` | Short atomic facts written by agents (\`type: memory\`). |
| \`attachments/YYYY/MM/\` | Binary files (images, PDFs, audio). |
| \`.cabinet/\` | App config. \`index.sqlite\`, \`cache/\`, \`thumbs/\`, \`secrets.json\` are generated/private — never edit them. |

## Frontmatter

\`\`\`yaml
id: 01JD...          # ULID, never change it (survives renames)
type: article        # note | article | link | quote | text | video | image | pdf | audio | project | collection | memory
title: Japanese listening rooms
status: inbox        # inbox | library | archived
created: 2026-11-14T10:00:00Z
updated: 2026-11-14T10:00:00Z
why: The low warm light is what I want for [[reading-corner]]   # optional, the owner's reason for saving
tags: [audio, interiors]
collections: [Listening rooms]
source: { url: https://..., author: ..., site: ..., published: ... }
captured_via: web     # web | telegram | mcp:<agent> | cli
attachment: attachments/2026/11/abc-photo.jpg
cover: attachments/2026/11/abc-cover.jpg
extraction: ok        # ok | failed | manual
\`\`\`

Projects add \`kind\` (hobby | learning | writing | build), \`intent\`, \`project_status\` (active | paused | done) and \`view\` (cards | list).
Memories add \`agent\` (who remembered it).

## Body

- Sources: the owner's notes first, then \`## Content\` with extracted text. Videos may have \`## Timestamps\` with lines like
  \`- [04:12](https://youtu.be/ID?t=252) what happens here\`.
- Links: \`[[slug]]\`, \`[[slug|label]]\`, embeds \`![[attachments/2026/11/x.jpg]]\`. Slugs are file names without \`.md\`.
- \`## Related\` lists manual connections: \`- [[slug]]: optional note\`.
- Projects keep their material under \`## Material\`. Each \`### Heading\` is a section the owner named; each line is
  \`- [[slug]]: why this matters to this project\`. Then \`## Notes\`, \`## Questions\` and \`## Checklist\` (\`- [ ] task\`).
  Never copy an item's content into a project — reference it.

## Rules for agents

1. Never change \`id\` or \`created\`. Update \`updated\` when you edit.
2. Don't overwrite the owner's notes. Append, or propose changes.
3. Put new atomic facts in \`memories/<slug>.md\` with \`type: memory\` and \`agent: <your name>\`.
4. Every change is auto-committed to git with its author, so the owner can review and revert.
`;
}

export function libraryGitignore(): string {
  return `# Cabinet generated / private files
.cabinet/index.sqlite*
.cabinet/state.sqlite*
.cabinet/cache/
.cabinet/thumbs/
.cabinet/secrets.json
.cabinet/tmp/
.cabinet/trash/
.DS_Store
.obsidian/workspace*.json
`;
}
