# Current limitations and verification

Cabinet 0.1 is a personal, single-user application. Milestones 0–10 are implemented; the checks below describe the tested boundary rather than a claim that every provider, operating system or deployment is verified.

## Verified in milestone 10

| Check | Result |
| --- | --- |
| Vitest | 80 tests pass: core format/index/search/watcher/git/archive, server/auth/capture, AI fallback/local embeddings, MCP transports, Telegram and CLI packaging |
| TypeScript, ESLint, web production build | Pass; Vite reports an existing mixed static/dynamic-import optimization warning for the shared project module |
| Playwright | 11 browser flows pass against temporary demo libraries; final screenshots refreshed |
| Native CLI | Empty library outside the source repo, built web assets, capture and graceful shutdown with flushed git history |
| First-passphrase CLI | Hidden interactive prompt and stdin support; hashes stored, short passphrases rejected, no plaintext output |
| Docker image | Builds and runs on Docker Desktop Linux ARM64; runtime includes Git, ffmpeg and whisper.cpp v1.9.5 |
| Container smoke | Empty/sample library, passphrase login, capture/search, attachment serving, image thumbnails, PDF extraction, MCP HTTP, real OGG transcription, restart persistence, export/restore with sibling backup |
| Docker Compose | Configuration validates; documented Compose init → passphrase → up → authenticated browser API flow passes with non-root UID mapping |
| macOS launchd | Absolute-path renderer tested, XML escaping/replacement protection tested, rendered plist passes `plutil -lint`; no persistent LaunchAgent installed during verification |
| Personal content | Tests use temporary synthetic libraries, not the user's main library |

The repeatable image test is `node scripts/smoke-docker.mjs` after building `cabinet:local`. Real transcription tests skip if the model/tools are unavailable; they passed on this machine and inside the container with the mounted multilingual base model.

Earlier MCP documentation records a real Claude Code stdio check. Milestone 10 reruns SDK/transport tests and a real container HTTP client exchange, not a fresh Claude Desktop session.

## Not yet verified

- **Live Telegram:** middleware/API requests and Settings flows use mocks; real BotFather/phone delivery still needs an owner-supplied token.
- **Hosted AI:** no live Anthropic/OpenAI calls were made for this milestone. Keys, billing, account model access and model-specific behavior remain user setup. Choose model IDs supported by your account rather than assuming bundled defaults stay current.
- **Native Windows/Linux:** runtime paths are designed for portability, but native Windows and a bare Linux host were not tested. Linux ARM64 was tested inside Docker; Linux AMD64 image execution was not tested here.
- **Unattended operation:** no long-running launchd login/reboot/sleep test or home-server soak test was performed. The plist was rendered/linted and its Node/CLI startup path checked without installing it.
- **Real Obsidian app:** standard YAML/Markdown/wikilink compatibility has a format-level test; no vault was opened in Obsidian during this milestone.

## Data and recovery

Markdown and attachments are durable library content. The search index and embedding cache are rebuildable; chat history, unaccepted suggestions/digests, opens and Telegram deduplication state in `.cabinet/state.sqlite` are not reconstructable exactly from Markdown. Saving a chat answer as a note makes that answer normal library content.

Content ZIPs exclude secrets, state, cache and index. They are useful for portable content/history, not complete backups of sessions, keys or chats. Full backups require a stopped copy of the entire library. Existing destination secrets are preserved during restore, while a fresh destination requires reconfiguration. The current ZIP exporter can include trash/other files in the library outside its explicit exclusions.

Restore needs a writable parent on the same filesystem because it renames the library to a sibling backup. Mount the parent directory in Docker. Run one web server per library and stop it before offline CLI restore or complete filesystem backup. Local MCP stdio clients may share access, but this is not collaborative multi-user storage or a distributed filesystem protocol.

The background queue is in memory. A forced exit can leave extraction pending; jobs are not automatically resumed after a crash. The original saved capture/attachment remains. Retry supported URL extraction or supply content manually; voice notes can be resent. Graceful shutdown waits for jobs, but a service/container stop timeout can interrupt a long task.

## Capture, search and AI

- Article extraction works on fetched HTML; it does not execute a website's JavaScript, log in to subscriptions or bypass access controls. Failed extraction keeps the source link and offers manual content.
- PDFs use their existing text layer; scanned pages have no OCR. Thumbnail/rendering support depends on the native image/PDF libraries available in the package.
- Video capture stores metadata, a playable embed/bookmark and optional timestamp notes. It does not download video or generate video transcripts.
- Voice transcription is CPU-based in this Docker image, depends on installed binaries/model and may be inaccurate. Audio conversion has a two-minute timeout; Whisper has a fifteen-minute timeout. Missing/failed transcription keeps the audio.
- File uploads and ZIP exports are buffered in memory; large attachments/libraries require enough RAM.
- Keyword search works offline. Meaning search requires embeddings and initially takes time to index a library; its brute-force vector comparison is intended for personal-scale collections.
- Ollama is a separate service; the app does not start it or download its models. The Docker image does not include AI/speech models or GPU configuration. Container connectivity to host Ollama must be configured.
- Enrichment suggestions wait for acceptance. MCP and chat tools can write when invoked for tasks such as remembering/creating notes; they are not read-only search interfaces.
- Source fetches, remote images/video embeds and Telegram use the network. Transcription itself is local; configured hosted AI sends relevant text/context to that provider. “Local-first” does not mean every optional integration is offline.

## Access and operations

Cabinet has one owner, no user roles and no tenant isolation. Local loopback requests with an accepted Host header are trusted. Remote browser access requires a passphrase; HTTP MCP always requires a per-agent token. Tailscale does not bypass these checks. Some administrative settings can only be changed locally; Docker users bootstrap/change their passphrase through the CLI.

Cabinet serves HTTP without built-in TLS, and the library is not encrypted by the app. Secrets are local files excluded from Git/exports (passphrases and agent tokens are stored as hashes); filesystem/account access still matters. This package is intended for a trusted personal computer/private network, not direct public multi-tenant hosting. Port forwarding/reverse proxies do not turn it into a hardened public service.

The launchd template runs after user login, does not prevent sleep and does not rotate logs. Its absolute Node/source paths need regeneration after moving the checkout or removing that Node version. Compose restarts its container, but the host/daemon must remain available. Health checks establish HTTP process availability, not AI readiness or successful remote integration setup.
