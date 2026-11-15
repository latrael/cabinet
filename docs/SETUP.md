# Setup

Cabinet runs one Node process serving the API and built web app. The source checkout and your library are separate: updating/pushing the app does not upload a library stored elsewhere.

## Native install

Requirements: Node.js 26 (package minimum 24.12), pnpm 10.32.1 and Git. Install pnpm with `npm install --global pnpm@10.32.1` if needed. On macOS, Git may require Apple's Command Line Tools. Native macOS and Linux-container flows were tested; native Windows is not verified.

```sh
git clone https://github.com/latrael/cabinet.git
cd cabinet
pnpm install --frozen-lockfile
pnpm build
pnpm cabinet init "$HOME/Cabinet"
pnpm start
```

Open http://localhost:4747. This creates an empty library outside the repository and a local Git repository inside that library. No AI model, API key or Telegram account is needed for core use.

On Windows, use PowerShell with Node/pnpm/Git installed. The same commands work with `$HOME/Cabinet`; paths containing spaces must be quoted. Use Docker or a separate service manager for unattended hosting; launchd is macOS-only.

### Choose another library

```sh
pnpm cabinet path "/absolute/path/to/My Cabinet"
pnpm cabinet init
pnpm start
```

`path` saves the default in `~/.config/cabinet/app.json`. `init <path>` initializes that folder but does **not** change the saved default. `--library <path>` selects a library for one invocation. In Settings, changing the library folder changes the next startup; it does not move your existing files.

Selection order: `--library` → `CABINET_LIBRARY` → saved app setting → `~/Cabinet`. In shell commands, `~` expands only when unquoted; use `"$HOME/Cabinet"` or a full path. MCP JSON and launchd need absolute paths.

For a separate demo:

```sh
pnpm cabinet init "$HOME/Cabinet-Demo" --sample
pnpm cabinet start --library "$HOME/Cabinet-Demo" --no-ai --no-telegram
```

### AI

Install and start [Ollama](https://ollama.com), then pull the default models:

```sh
ollama pull nomic-embed-text
ollama pull qwen3:8b
```

In **Settings → AI**, check the provider, Ollama address (default `http://127.0.0.1:11434`), chat and embedding model names. Ollama must be running. Without it, keyword search still works; chat/meaning search report their availability. The app checks the local endpoint rather than launching Ollama for you.

To use Anthropic or OpenAI, choose the provider, set a model supported by your account, save your key in Settings and save AI settings. Keys are stored in the library's gitignored secrets file. Hosted inference uses that provider's network and billing; no hosted API is needed for local use. Embeddings prefer a reachable local model and can use OpenAI when a key is configured.

For voice setup and bot pairing, see [Telegram](TELEGRAM.md). Transcription is independently available even with `--no-ai`.

### Network access

Localhost access from the same computer is trusted. To use another device:

1. Set a passphrase from local **Settings → Access**.
2. Enable network access there, then restart Cabinet (or start with `--host 0.0.0.0`).
3. Open the host's LAN/Tailscale address on port 4747 and sign in.

Tailscale does not replace Cabinet's passphrase. Agents use separate bearer tokens from Settings or `pnpm cabinet token <name>`. Changing a passphrase invalidates existing browser sessions. Cabinet supplies HTTP; use a trusted private network or an HTTPS reverse proxy for transport protection. Forwarded headers do not make remote requests local.

You can set/reset a passphrase offline using the CLI (stop/restart a running server so it reloads secrets):

```sh
pnpm cabinet passphrase --library "$HOME/Cabinet"
```

The terminal prompt hides input and asks for confirmation. `--stdin` accepts a passphrase from a pipe for automation; passphrases are not accepted as command-line arguments. Minimum length is eight characters.

## Docker

Install Docker Engine/Desktop with Compose v2 and start its daemon. From the source checkout, create a local `.env` from the example and choose writable host folders **outside this repository**:

```sh
cp .env.example .env
mkdir -p "$HOME/CabinetData" "$HOME/.cache/cabinet/whisper"
```

Set `CABINET_UID` and `CABINET_GID` in `.env` to the values printed by `id -u` and `id -g` on macOS/Linux, matching the owner of those directories. The default is 1000:1000. On Windows/Docker Desktop, keep the defaults unless your bind-mount setup requires otherwise. Optional `.env` settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `CABINET_DATA_DIR` | `${HOME}/CabinetData` | Host parent folder mounted at `/data` |
| `CABINET_WHISPER_MODELS_DIR` | `${HOME}/.cache/cabinet/whisper` | Read-only model folder mounted at `/models` |
| `CABINET_PORT` | `4747` | Host localhost port |
| `CABINET_UID`, `CABINET_GID` | `1000`, `1000` | Container process identity for host file ownership |

Use absolute paths in `.env`. Compose reads this file; the native Node CLI does not automatically load `.env`.

Build, initialize an empty library, then set its initial passphrase with the hidden interactive prompt:

```sh
docker compose build
docker compose run --rm cabinet init
docker compose run --rm cabinet passphrase
docker compose up -d
```

Open http://localhost:4747 and sign in. Inside a container, browser requests arrive over Docker's network rather than loopback, so a passphrase is required even when the published host port is localhost. For an automated setup, pipe a secret into `docker compose run --rm -T cabinet passphrase --stdin` from your secret source.

The default library is `/data/Cabinet`, corresponding to `~/CabinetData/Cabinet` on the host. Mounting `/data` gives restore room to rename `Cabinet` into a sibling `Cabinet.backup-…`. **Do not bind-mount the library itself at `/data/Cabinet`** if you want restore to work. Your source checkout is not mounted into the runtime container. The image starts as a non-root user, installs production dependencies, and builds whisper.cpp with portable CPU settings; no speech or Ollama models are downloaded by the image.

To try synthetic content, use `docker compose run --rm cabinet init --sample` instead of `init` before first startup. To use an existing library, stop its native process and copy it into the data folder as `Cabinet`; do not run multiple Cabinet web servers on that same library.

Place `ggml-base.bin` in the host model directory for transcription. The image supplies ffmpeg and whisper.cpp; Settings reports transcription unavailable until a model exists at `/models/ggml-base.bin`.

For host Ollama, set **Settings → AI → Ollama address** to `http://host.docker.internal:11434`. Compose adds that hostname for Linux as well as Docker Desktop. The host service must listen on an address reachable from the container; host loopback alone may not be reachable on Linux. If you run Ollama in another container, put it on the same network and use its service hostname instead. Ollama/GPU provisioning is separate from this Compose service. [Docker's networking guide](https://docs.docker.com/compose/how-tos/networking/) explains service names and container/host addressing.

Useful commands:

```sh
docker compose ps
docker compose logs -f cabinet
docker compose stop
docker compose up -d --build
```

Stop the service before changing its passphrase using a one-off CLI container, then start it again. Settings restricted to the local computer (passphrase, server bind settings, default library path) stay restricted in Docker browser sessions: use the CLI for passphrase changes and Compose for port/mount changes.

Compose publishes only `127.0.0.1:4747`. To deliberately expose it on a LAN, change the host bind address in `docker-compose.yml`, keep the passphrase set and use an appropriate private-network/HTTPS setup. Models and library files stay in your host folders when containers are removed. The health check tests `/api/health`; it does not establish AI/provider readiness.

### Repeatable container smoke check

After building the image, run:

```sh
node scripts/smoke-docker.mjs
```

This uses disposable host folders and containers to verify empty startup, synthetic-library capture/search, authentication, PDF/image processing, restart persistence, export/restore, MCP HTTP, and real OGG transcription when the local speech model is available. It does not use your main library or hosted AI. See [Limitations](LIMITATIONS.md) for the latest result.

## macOS background service

Build the web app first. Render the supplied plist using your current Node executable and absolute repository/library paths:

```sh
node scripts/render-launchd.mjs --library "$HOME/Cabinet" --output "$HOME/Library/LaunchAgents/com.cabinet.plist"
plutil -lint "$HOME/Library/LaunchAgents/com.cabinet.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.cabinet.plist"
launchctl kickstart "gui/$(id -u)/com.cabinet"
```

Rendering creates the log directory and plist; loading it is a separate action. Existing plists are preserved unless you pass `--force`. Do not run a second server on the same port/library. This LaunchAgent starts at login, restarts if it exits, and runs only while that user is logged in; it does not prevent sleep.

Logs are `~/Library/Logs/Cabinet/stdout.log` and `stderr.log`. The generated PATH includes the chosen Node directory, Homebrew and system tools. It does not load your shell profile. To customize transcription paths or other environment values, add them to `EnvironmentVariables` in the rendered plist.

To stop/unload:

```sh
launchctl bootout "gui/$(id -u)/com.cabinet"
```

After a Node version manager upgrade, the absolute Node path may change. Unload, render again with the new Node (`--force`), then bootstrap again. After moving the source checkout, regenerate its paths too. Log rotation is not configured by the template.

## Backups, restore and updates

- **Portable content export:** use Settings → Export, or `pnpm cabinet export /path/to/backup.zip --library /path/to/library`. Add `--git` for history. Index/cache, private secrets and app state are excluded.
- **Complete backup:** stop Cabinet and copy the entire library folder, including `.git` and `.cabinet`. This also preserves keys, sessions, chat history, suggestions and local deduplication state. Keep that copy private.
- **Restore content:** use Settings, or stop the server and run `pnpm cabinet restore /path/to/backup.zip --library /path/to/library`. The current library is kept as a sibling backup. Existing destination secrets are preserved; a fresh-machine restore needs keys/tokens/passphrase configured again. App state/chat history is not restored from the ZIP.
- **Rebuild:** Settings → Rebuild index, or `pnpm cabinet rebuild --library /path/to/library`. Files remain the source of truth. A rebuild does not recover excluded chat history/state.
- **Update native:** stop Cabinet, `git pull --ff-only`, `pnpm install --frozen-lockfile`, `pnpm build`, restart. Restart an installed LaunchAgent after rebuilding.
- **Update Docker:** stop Cabinet, update the checkout, then `docker compose up -d --build`. Keep the same data/model paths. Do not change library format versions without reading the release notes.

## Runtime environment reference

| Variable | Effect |
| --- | --- |
| `CABINET_LIBRARY` | Default library path (overridden by `--library`) |
| `CABINET_APP_CONFIG` | App defaults file instead of `~/.config/cabinet/app.json` |
| `CABINET_PORT` | Server port (overridden by `--port`; Compose uses it for the host published port) |
| `CABINET_WHISPER_MODEL` | Speech model file |
| `CABINET_WHISPER_BIN`, `CABINET_FFMPEG_BIN` | Absolute executable paths |
| `CABINET_AGENT` | Default MCP stdio agent name (overridden by `--agent`) |
| `CABINET_BLOCK_NETWORK=1` | Test mode: server fetches outside loopback fail; do not set for normal capture/Telegram |

CLI options include `--no-ai`, `--no-telegram`, `--host`, `--port` and `--library`. Use `pnpm cabinet help` for commands. API keys and the Telegram token belong in Settings/secrets, not in the source repo.
