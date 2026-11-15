# Telegram capture and voice notes

Cabinet runs a Telegram bot using long polling. The computer running Cabinet must stay awake, connected to the internet and running Cabinet to receive messages. You do not need a public server port.

Your library remains in its own folder (by default `~/Cabinet`), outside the app repository. Telegram captures are ordinary library files, saved to the inbox with `captured_via: telegram` and git author `telegram`.

## Connect your bot

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. In Cabinet's **Settings → Telegram**, save the token and enable the bot. The status will show the bot's username when connected.
3. Click **Pair a chat**. In a **private chat** with your bot, send `/pair 123456` using the code shown in Settings.
4. The code expires after ten minutes and can only be used once. If pairing fails repeatedly, generate a new code.
5. Your paired chat appears in Settings automatically. **Remove** revokes its access. Groups and channels are not supported.

Tokens are stored in the library's gitignored `.cabinet/secrets.json`. Token changes, enabling and disabling take effect without restarting Cabinet. If a connection fails, check the token/internet connection and toggle the bot off and on to retry. `--no-telegram` disables the integration for that server process.

## Use it

- Send text to save a text item.
- Send a URL to capture its page in the background. For a URL inside a longer message, Cabinet saves the first URL and uses the surrounding text as “Why I saved this”.
- Send a photo, PDF or audio file to save its attachment. Captions become “Why I saved this”. PDF text is extracted in the background.
- Send a voice note to save its original OGG audio and transcribe it locally. The reply acknowledges the saved audio; the transcript appears in Cabinet when the background job finishes.
- `/search <words>` searches the library. It uses hybrid search when configured, and keyword search without AI.
- `/ask <question>` uses Cabinet's configured chat provider and returns answers with `[[item]]` citations. Each question is independent. `/help` lists the commands.

File downloads are limited to 20 MB, consistent with the standard [Telegram Bot API download limit documented by grammY](https://grammy.dev/guide/files#file-size-limits). Oversized or unsupported files are rejected without creating an item. Redelivered capture messages are deduplicated using local library state.

## Local transcription

On macOS, install the executables:

```sh
brew install ffmpeg whisper-cpp
```

Download the multilingual `ggml-base.bin` model using the instructions in the [official whisper.cpp models directory](https://github.com/ggml-org/whisper.cpp/tree/master/models), and place it at:

```text
~/.cache/cabinet/whisper/ggml-base.bin
```

Alternatively, point `CABINET_WHISPER_MODEL` at your model file. Use `CABINET_WHISPER_BIN` and `CABINET_FFMPEG_BIN` for executable paths outside `PATH`. Restart Cabinet after changing its environment. On Linux/Windows, install native ffmpeg and whisper.cpp executables and set these paths as needed; this milestone was tested on macOS.

**Settings → Telegram** shows whether transcription is ready. Missing tools/models or failed transcription do not discard the audio: the item keeps its attachment and is marked `extraction: failed`. You can add its content manually. Manual content supplied while transcription is running is preserved.

Voice audio passes through Telegram's servers before Cabinet downloads it. Transcription itself runs locally using ffmpeg and whisper.cpp. `/ask` and enrichment use your selected AI provider, which may be a remote provider if you configured one.

## Verification

Automated tests use real grammY middleware and mocked Telegram API requests, covering pairing/expiry/reuse, private-chat restrictions, revocation, captures, duplicate delivery, file failures, search/ask and polling lifecycle changes. A Playwright test covers Settings → API → pairing status → revocation. A real OGG fixture passes through ffmpeg/whisper and becomes searchable library text when those tools and the model are installed; that test skips when they are unavailable.

A live BotFather connection and real phone delivery have not been verified. No personal token is included in the repository.
