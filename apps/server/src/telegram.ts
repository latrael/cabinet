import { Bot, type Context } from 'grammy';
import type { ServerContext } from './context.ts';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const HELP = 'Send text, a link, a photo, a PDF or a voice note to save it to your inbox.\n/search <words> searches your library.\n/ask <question> asks your library assistant.';

class TelegramInputError extends Error {}

async function reply(ctx: Context, text: string) {
  // Plain text avoids interpreting saved Markdown as Telegram formatting. Splitting
  // by code point preserves emoji and keeps every message below Telegram's limit.
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 2000) await ctx.reply(chars.slice(i, i + 2000).join(''));
}

/** Download only from Telegram, with a timeout and a bound on actual bytes read. */
async function downloadFile(url: string, download: typeof fetch): Promise<Uint8Array> {
  const res = await download(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!res.ok || !res.body) throw new TelegramInputError('Could not download that file. Please send it again.');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) throw new TelegramInputError('Files must be 20 MB or smaller.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Separate construction from polling so real middleware can be tested offline. */
export function createTelegramBot(ctx: ServerContext, token: string, download: typeof fetch = fetch): Bot {
  const bot = new Bot(token, { client: { timeoutSeconds: 30 } });
  let attemptedCode: string | undefined;
  let failedPairings = 0;

  bot.use(async (tg, next) => {
    if (!ctx.lib.config.telegram.enabled || ctx.auth.secrets.telegramToken !== token) return;
    // Library contents are personal. Groups/channels cannot pair or query it.
    if (tg.chat?.type !== 'private' || !tg.message) return;
    try {
      await next();
    } catch (e) {
      // Telegram errors can contain a download URL with the bot token. Never
      // persist those raw errors in the library log, Settings or a chat reply.
      ctx.lib.emit('error-log', new Error('Telegram request failed; check the bot connection and retry.'));
      await reply(tg, e instanceof TelegramInputError ? e.message : 'That request failed. Please try again.').catch(() => {});
    }
  });

  bot.command('pair', async (tg) => {
    const pairing = ctx.auth.secrets.telegramPairing;
    if (attemptedCode !== pairing?.code) {
      attemptedCode = pairing?.code;
      failedPairings = 0;
    }
    if (!pairing || pairing.expires <= Date.now() || failedPairings >= 20 || String(tg.match).trim() !== pairing.code) {
      failedPairings++;
      await reply(tg, 'Invalid or expired pairing code. Generate a new code in Cabinet Settings.');
      return;
    }
    const cfg = ctx.lib.config;
    if (!cfg.telegram.allowedChats.includes(tg.chat.id)) {
      ctx.lib.saveConfig({ ...cfg, telegram: { ...cfg.telegram, allowedChats: [...cfg.telegram.allowedChats, tg.chat.id] } });
    }
    delete ctx.auth.secrets.telegramPairing;
    ctx.auth.save();
    await reply(tg, 'Paired with Cabinet.\n' + HELP);
  });

  bot.use(async (tg, next) => {
    if (!ctx.lib.config.telegram.allowedChats.includes(tg.chat!.id)) {
      await reply(tg, 'Pair this private chat first: generate a code in Cabinet Settings, then send /pair <code>.');
      return;
    }
    await next();
  });

  bot.command(['start', 'help'], (tg) => reply(tg, HELP));

  bot.command('search', async (tg) => {
    const q = String(tg.match).trim();
    if (!q) return reply(tg, 'Usage: /search <words>');
    const hits = ctx.ai ? (await ctx.ai.search(q, { limit: 6 })).hits : ctx.lib.index.search(q, { limit: 6 });
    await reply(tg, hits.length ? hits.map((h) => `${h.item.title}\n[[${h.item.slug}]] · ${h.field}\n${h.snippet}`).join('\n\n') : 'No matching items.');
  });

  bot.command('ask', async (tg) => {
    const q = String(tg.match).trim();
    if (!q) return reply(tg, 'Usage: /ask <question>');
    if (!ctx.ai || !(await ctx.ai.status()).chat) return reply(tg, 'Chat is unavailable. Check the AI provider in Cabinet Settings. /search still works.');
    const res = await ctx.ai.chat({ messages: [{ role: 'user', content: q }] });
    if (!res.ok) throw new TelegramInputError('The library assistant is unavailable. Please try again.');
    let answer = '';
    let failed = false;
    for (const line of (await res.text()).split('\n')) {
      if (!line.trim()) continue;
      const part = JSON.parse(line);
      if (part.t === 'text') answer += part.v;
      if (part.t === 'error') failed = true;
    }
    await reply(tg, answer.trim() + (failed ? '\n\nThe assistant could not finish. Please try again.' : '') || 'The assistant returned no answer. Please try again.');
  });

  bot.on('message', async (tg) => {
    const msg = tg.message;
    if (msg.text?.startsWith('/')) return reply(tg, HELP);
    const key = `telegram:${tg.me.id}:${tg.chat.id}:${msg.message_id}`;
    const existing = ctx.lib.state.get(key);
    if (existing && ctx.lib.index.getSummary(existing)) return reply(tg, 'Already saved to your inbox.');
    const photo = msg.photo?.at(-1);
    const file = msg.voice ?? msg.audio ?? msg.document ?? photo;
    let result;
    if (file) {
      if ((file.file_size ?? 0) > MAX_FILE_BYTES) throw new TelegramInputError('Files must be 20 MB or smaller.');
      const filename = msg.voice ? 'voice-note.ogg' : msg.audio?.file_name ?? msg.document?.file_name ?? (photo ? 'photo.jpg' : 'audio.mp3');
      const mime = msg.voice ? 'audio/ogg' : msg.audio?.mime_type ?? msg.document?.mime_type ?? (photo ? 'image/jpeg' : undefined);
      if (!msg.voice && !msg.audio && !photo && !/^(application\/pdf|image\/|audio\/|text\/)/.test(mime ?? '') && !/\.(pdf|png|jpe?g|gif|webp|avif|heic|mp3|m4a|ogg|oga|opus|wav|flac|webm|md|txt|markdown)$/i.test(filename)) {
        throw new TelegramInputError('Send a photo, PDF, audio file or text file.');
      }
      const remote = await tg.api.getFile(file.file_id);
      if (!remote.file_path) throw new TelegramInputError('That file is unavailable. Please send it again.');
      if ((remote.file_size ?? 0) > MAX_FILE_BYTES) throw new TelegramInputError('Files must be 20 MB or smaller.');
      const path = remote.file_path.split('/').map(encodeURIComponent).join('/');
      const data = await downloadFile(`https://api.telegram.org/file/bot${token}/${path}`, download);
      // Re-check after downloading in case Settings revoked this chat meanwhile.
      if (!ctx.lib.config.telegram.enabled || ctx.auth.secrets.telegramToken !== token || !ctx.lib.config.telegram.allowedChats.includes(tg.chat.id)) return;
      result = ctx.capture.captureFile({ data, filename, mime, why: msg.caption, via: 'telegram' }, 'telegram');
    } else if (msg.text) {
      const entity = msg.entities?.find((e) => e.type === 'url' || e.type === 'text_link');
      const url = entity?.type === 'text_link' ? entity.url : entity ? msg.text.slice(entity.offset, entity.offset + entity.length) : undefined;
      result = url && /^https?:\/\//i.test(url)
        ? ctx.capture.captureUrl({ url, why: (msg.text.slice(0, entity!.offset) + msg.text.slice(entity!.offset + entity!.length)).trim() || undefined, via: 'telegram' }, 'telegram')
        : ctx.capture.captureText({ text: msg.text, via: 'telegram' }, 'telegram');
    } else {
      return reply(tg, HELP);
    }
    // Save before replying: Telegram may redeliver an update if the reply fails.
    ctx.lib.state.set(key, result.item.id);
    const audio = result.item.type === 'audio';
    const transcriptionReady = audio && ctx.transcriber && (await ctx.transcriber.available()).ok;
    await reply(tg, `${result.duplicate ? 'Already saved' : 'Saved'}: ${result.item.title}\n[[${result.item.slug}]]${audio ? transcriptionReady ? '\nAudio saved. Transcription runs locally in the background; check Cabinet for the result.' : '\nAudio saved. Transcription is unavailable; check Cabinet Settings.' : ''}`);
  });

  bot.catch(() => {
    ctx.lib.emit('error-log', new Error('Telegram update failed.'));
  });
  return bot;
}

export interface TelegramOptions {
  createBot?: (ctx: ServerContext, token: string) => Bot;
}

/** Settings changes and library restores replace polling without restarting Cabinet. */
export async function telegramPlugin(ctx: ServerContext, options: TelegramOptions = {}): Promise<() => Promise<void>> {
  let state: { running: boolean; username?: string; error?: string } = { running: false };
  let active: { bot: Bot; abort: AbortController; task: Promise<void> } | undefined;
  let activeToken: string | undefined;
  let closed = false;
  let changes = Promise.resolve();

  const stopBot = async () => {
    const old = active;
    active = undefined;
    state = { running: false };
    if (!old) return;
    old.abort.abort();
    if (old.bot.isRunning()) await old.bot.stop().catch(() => {});
    await old.task;
  };

  const refresh = async () => {
    const token = ctx.lib.config.telegram.enabled ? ctx.auth.secrets.telegramToken : undefined;
    if (closed || (token === activeToken && active)) return;
    activeToken = token;
    await stopBot();
    if (!token) {
      if (ctx.lib.config.telegram.enabled) state.error = 'Save a BotFather token to start the bot.';
      return;
    }
    try {
      const bot = (options.createBot ?? createTelegramBot)(ctx, token);
      const abort = new AbortController();
      const run = { bot, abort, task: Promise.resolve() };
      active = run;
      run.task = (async () => {
        try {
          // Unlike bot.init(), a direct getMe does not retry indefinitely. The
          // abort signal also makes disable/shutdown safe during initialization.
          bot.botInfo = await bot.api.getMe(abort.signal as unknown as Parameters<typeof bot.api.getMe>[0]);
          if (abort.signal.aborted) return;
          await bot.start({ allowed_updates: ['message'], onStart: (info) => {
            if (active === run) state = { running: true, username: info.username };
          } });
        } catch {
          if (!abort.signal.aborted && active === run) {
            state = { running: false, error: 'Could not connect to Telegram. Check the bot token and connection; toggle the bot to retry.' };
          }
        } finally {
          if (active === run) state.running = false;
        }
      })();
    } catch {
      state = { running: false, error: 'Could not start Telegram. Check the bot token.' };
    }
  };

  const previousConfig = ctx.extras.onConfigChanged;
  const previousReopen = ctx.extras.onReopen;
  ctx.extras.telegram = { status: () => ({ ...state }) };
  ctx.extras.onConfigChanged = async () => {
    await previousConfig?.();
    changes = changes.then(refresh);
    await changes;
  };
  ctx.extras.onReopen = async () => {
    await previousReopen?.();
    changes = changes.then(refresh);
    await changes;
  };
  await refresh();
  return async () => {
    closed = true;
    await changes;
    await stopBot();
    ctx.extras.onConfigChanged = previousConfig;
    ctx.extras.onReopen = previousReopen;
  };
}
