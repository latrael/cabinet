import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Bot } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { WhisperTranscriber } from '@cabinet/ai';
import { loadSecrets } from '@cabinet/core';
import { buildContext } from '../src/server.ts';
import { createApp } from '../src/app.ts';
import type { ServerContext } from '../src/context.ts';
import { createTelegramBot, telegramPlugin } from '../src/telegram.ts';
import { SAMPLE, tempSample, waitFor } from '../../../packages/core/test/helpers.ts';
import { startFixtureServer } from '../../../e2e/fixtures/server.ts';

const TOKEN = '123456:test-token';
const ME = { id: 123456, is_bot: true as const, first_name: 'Cabinet', username: 'cabinet_test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
const CHAT = 42;
let cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const clean of cleanups.reverse()) await clean();
  cleanups = [];
});

async function setup(transcriber?: WhisperTranscriber) {
  const temp = tempSample();
  const ctx = await buildContext({ library: temp.dir, git: true, watch: false, quiet: true, transcriber: () => transcriber ?? null });
  cleanups.push(temp.cleanup, async () => { await ctx.jobs.idle(); await ctx.lib.close(); });
  ctx.lib.saveConfig({ ...ctx.lib.config, telegram: { enabled: true, allowedChats: [CHAT] } });
  ctx.auth.secrets.telegramToken = TOKEN;
  ctx.auth.save();
  const app = createApp(ctx);
  const access = ctx.auth.createToken("telegram-tests").token;
  const request = async (path: string, body?: unknown, method = 'POST') => {
    const res = await app.request(`http://localhost/api/settings${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${access}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(res.status).toBe(200);
    return res.json();
  };
  return { ctx, request };
}

function mockApi(bot: Bot) {
  const sent: string[] = [];
  const files: string[] = [];
  bot.botInfo = ME;
  bot.api.config.use(async (_prev, method, payload, signal): Promise<any> => {
    if (method === 'getMe') return { ok: true, result: ME };
    if (method === 'deleteWebhook') return { ok: true, result: true };
    if (method === 'sendMessage') {
      sent.push((payload as any).text);
      return { ok: true, result: { message_id: 100, date: 0, chat: { id: CHAT, type: 'private' }, text: (payload as any).text } };
    }
    if (method === 'getFile') {
      files.push((payload as any).file_id);
      return { ok: true, result: { file_id: (payload as any).file_id, file_unique_id: 'file', file_path: (payload as any).file_id } };
    }
    if (method === 'getUpdates') {
      if ((payload as any).limit === 1) return { ok: true, result: [] };
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('Stopped', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    throw new Error(`Unexpected Telegram method ${method}`);
  });
  let id = 0;
  const send = (patch: Partial<Message> = {}, chatId = CHAT, type = 'private') => {
    const text = (patch as any).text as string | undefined;
    const command = text?.startsWith('/') ? text.split(' ')[0] : undefined;
    return bot.handleUpdate({ update_id: ++id, message: { message_id: id, date: 0, from: { id: chatId, is_bot: false, first_name: 'Tester' }, chat: { id: chatId, type }, ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}), ...patch } } as Update);
  };
  return { sent, files, send };
}

function fixtureDownload() {
  return vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname.split('/').pop();
    const name = path === 'photo.png' ? 'attachments/2026/06/01hy-paper-lamp.png' : path === 'primer.pdf' ? 'attachments/2026/07/01j2-room-acoustics-primer.pdf' : undefined;
    const data = name ? readFileSync(join(SAMPLE, name)) : readFileSync(new URL('../../../e2e/fixtures/voice-note.ogg', import.meta.url));
    return new Response(data);
  });
}

function latest(ctx: ServerContext, kind: string) {
  return ctx.lib.read(ctx.lib.index.list({ type: kind, limit: 1 }).items[0].id);
}

describe('Telegram access and pairing', () => {
  test('blocks unpaired chats and groups before downloads, search or writes; pairing is private and single-use', async () => {
    const { ctx, request } = await setup();
    const download = fixtureDownload();
    const m = mockApi(createTelegramBot(ctx, TOKEN, download));
    const initial = ctx.lib.index.counts().total;
    await m.send({ text: '/search reading' }, 99);
    await m.send({ voice: { file_id: 'voice.ogg', file_unique_id: 'v', duration: 3 } }, 99);
    expect(m.sent.join('\n')).toContain('Pair this private chat first');
    expect(download).not.toHaveBeenCalled();
    const { code } = await request('/telegram/pair');
    await m.send({ text: `/pair ${code}` }, 99, 'group');
    expect(ctx.lib.config.telegram.allowedChats).not.toContain(99);
    await m.send({ text: '/pair wrong' }, 99);
    expect(m.sent.at(-1)).toContain('Invalid or expired');
    await m.send({ text: `/pair ${code}` }, 99);
    expect(ctx.lib.config.telegram.allowedChats).toContain(99);
    expect((await request('/telegram', undefined, 'GET')).allowedChats).toContain(99);
    expect(loadSecrets(ctx.lib.root).telegramPairing).toBeUndefined();
    await m.send({ text: `/pair ${code}` }, 100);
    expect(ctx.lib.config.telegram.allowedChats).not.toContain(100);
    expect(ctx.lib.index.counts().total).toBe(initial);
    await request('/telegram/chats/99', undefined, 'DELETE');
    await m.send({ text: 'Do not save this' }, 99);
    expect(ctx.lib.index.counts().total).toBe(initial);
  });

  test('rejects expired codes and bounds repeated guesses', async () => {
    const { ctx, request } = await setup();
    const m = mockApi(createTelegramBot(ctx, TOKEN));
    const { code } = await request('/telegram/pair');
    ctx.auth.secrets.telegramPairing!.expires = Date.now() - 1;
    await m.send({ text: `/pair ${code}` }, 99);
    expect(ctx.lib.config.telegram.allowedChats).not.toContain(99);
    const next = await request('/telegram/pair');
    for (let i = 0; i < 20; i++) await m.send({ text: '/pair wrong' }, 99);
    await m.send({ text: `/pair ${next.code}` }, 99);
    expect(ctx.lib.config.telegram.allowedChats).not.toContain(99);
  });
});

describe('Telegram capture and commands', () => {
  test('saves text once across redelivery/restart, in the inbox, with Telegram provenance and git author', async () => {
    const { ctx } = await setup();
    const m = mockApi(createTelegramBot(ctx, TOKEN));
    await m.send({ text: 'A Telegram idea about ceramic lamps' });
    const item = latest(ctx, 'text');
    expect(item.body).toContain('ceramic lamps');
    expect(item.status).toBe('inbox');
    expect(item.frontmatter.captured_via).toBe('telegram');
    const again = mockApi(createTelegramBot(ctx, TOKEN));
    await again.send({ text: 'A Telegram idea about ceramic lamps' });
    expect(again.sent.at(-1)).toContain('Already saved');
    expect(ctx.lib.index.list({ type: 'text' }).items.filter((i) => i.title === item.title)).toHaveLength(1);
    await ctx.lib.git!.flush();
    expect((await ctx.lib.git!.log(5)).some((c) => c.author === 'telegram')).toBe(true);
    await m.send({ text: '/unknown' });
    expect(m.sent.at(-1)).toContain('/search');
  });

  test('captures a URL with its surrounding context and extracts the article', async () => {
    const { ctx } = await setup();
    const fx = await startFixtureServer();
    cleanups.push(fx.close);
    const m = mockApi(createTelegramBot(ctx, TOKEN));
    const text = `For the reading corner ${fx.url}/article`;
    await m.send({ text, entities: [{ type: 'url', offset: 23, length: text.length - 23 }] });
    await ctx.jobs.idle();
    const item = latest(ctx, 'article');
    expect(item.why).toBe('For the reading corner');
    expect(item.frontmatter.source?.url).toBe(`${fx.url}/article`);
    expect(item.body).toContain('Washi');
  });

  test('downloads photos and PDFs, preserves captions and extracts PDF text', async () => {
    const { ctx } = await setup();
    const download = fixtureDownload();
    const m = mockApi(createTelegramBot(ctx, TOKEN, download));
    await m.send({ photo: [{ file_id: 'small.png', file_unique_id: 'a', width: 10, height: 10 }, { file_id: 'photo.png', file_unique_id: 'b', width: 100, height: 100 }], caption: 'Warm light for the desk' });
    const image = latest(ctx, 'image');
    expect(image.why).toBe('Warm light for the desk');
    expect(m.files).toEqual(['photo.png']);
    expect(readFileSync(ctx.lib.abs(image.frontmatter.attachment!))).toEqual(readFileSync(join(SAMPLE, 'attachments/2026/06/01hy-paper-lamp.png')));
    await m.send({ document: { file_id: 'primer.pdf', file_unique_id: 'p', file_name: 'primer.pdf', mime_type: 'application/pdf' } });
    await ctx.jobs.idle();
    expect(latest(ctx, 'pdf').body).toContain('flutter');
    expect(latest(ctx, 'pdf').frontmatter.extraction).toBe('ok');
  });

  test('keeps voice audio when transcription is unavailable or fails', async () => {
    const { ctx } = await setup();
    const m = mockApi(createTelegramBot(ctx, TOKEN, fixtureDownload()));
    const voice = { file_id: 'voice.ogg', file_unique_id: 'v', duration: 3 };
    await m.send({ voice });
    await ctx.jobs.idle();
    let item = latest(ctx, 'audio');
    expect(item.frontmatter.extraction).toBe('failed');
    expect(readFileSync(ctx.lib.abs(item.frontmatter.attachment!)).length).toBeGreaterThan(0);
    ctx.capture.hooks.transcribe = async () => { throw new Error('missing model'); };
    await m.send({ voice });
    await ctx.jobs.idle();
    item = latest(ctx, 'audio');
    expect(item.frontmatter.extraction).toBe('failed');
    expect(item.body).toContain('![[attachments/');
  });

  test('late transcription preserves content supplied manually while it was running', async () => {
    const { ctx } = await setup();
    let finish!: (text: string) => void;
    ctx.capture.hooks.transcribe = () => new Promise((resolve) => { finish = resolve; });
    const m = mockApi(createTelegramBot(ctx, TOKEN, fixtureDownload()));
    await m.send({ voice: { file_id: 'voice.ogg', file_unique_id: 'v', duration: 3 } });
    const item = latest(ctx, 'audio');
    ctx.capture.setManualContent(item.id, 'My corrected transcript');
    finish('An automatic transcript');
    await ctx.jobs.idle();
    expect(ctx.lib.read(item.id).body).toContain('My corrected transcript');
    expect(ctx.lib.read(item.id).frontmatter.extraction).toBe('manual');
  });

  test('rejects oversized, unsupported and failed downloads without saving or exposing tokens', async () => {
    const { ctx } = await setup();
    const download = vi.fn<typeof fetch>(async () => { throw new Error(`https://api.telegram.org/file/bot${TOKEN}/secret`); });
    const m = mockApi(createTelegramBot(ctx, TOKEN, download));
    const before = ctx.lib.index.counts().total;
    await m.send({ voice: { file_id: 'large', file_unique_id: 'l', duration: 3, file_size: 21 * 1024 * 1024 } });
    expect(m.sent.at(-1)).toContain('20 MB');
    expect(m.files).toHaveLength(0);
    await m.send({ document: { file_id: 'exe', file_unique_id: 'x', file_name: 'program.exe' } });
    expect(download).not.toHaveBeenCalled();
    await m.send({ voice: { file_id: 'voice', file_unique_id: 'v', duration: 3 } });
    expect(m.sent.at(-1)).toContain('request failed');
    expect(m.sent.join('\n')).not.toContain(TOKEN);
    expect(ctx.lib.index.counts().total).toBe(before);
    const oversized = mockApi(createTelegramBot(ctx, TOKEN, async () => new Response(new Uint8Array(21 * 1024 * 1024))));
    await oversized.send({ voice: { file_id: 'voice', file_unique_id: 'v', duration: 3 } });
    expect(oversized.sent.at(-1)).toContain('20 MB');
    expect(ctx.lib.index.counts().total).toBe(before);
  });

  test('rechecks revocation while a file download is in flight', async () => {
    const { ctx } = await setup();
    const m = mockApi(createTelegramBot(ctx, TOKEN, async () => {
      ctx.lib.config.telegram.allowedChats = [];
      return new Response('audio');
    }));
    const before = ctx.lib.index.counts().total;
    await m.send({ voice: { file_id: 'voice', file_unique_id: 'v', duration: 3 } });
    expect(ctx.lib.index.counts().total).toBe(before);
  });

  test('search works without AI; ask reports unavailable chat; commands are not captured', async () => {
    const { ctx } = await setup();
    const m = mockApi(createTelegramBot(ctx, TOKEN));
    const before = ctx.lib.index.counts().total;
    await m.send({ text: '/search reading' });
    expect(m.sent.at(-1)).toContain('[[reading-corner]]');
    await m.send({ text: '/ask Which lamp?' });
    expect(m.sent.at(-1)).toContain('Chat is unavailable');
    await m.send({ text: '/search' });
    expect(m.sent.at(-1)).toBe('Usage: /search <words>');
    expect(ctx.lib.index.counts().total).toBe(before);
  });

  test('uses the AI bridge for hybrid search and cited answers, splitting long replies safely', async () => {
    const { ctx } = await setup();
    const chat = vi.fn(async () => new Response(JSON.stringify({ t: 'text', v: '💡'.repeat(2500) + ' [[reading-corner]]' }) + '\n' + JSON.stringify({ t: 'done' }) + '\n'));
    const search = vi.fn(async () => ({ hits: ctx.lib.index.search('reading', { limit: 1 }), mode: 'hybrid' }));
    ctx.ai = { status: async () => ({ chat: true }), chat, search } as any;
    const m = mockApi(createTelegramBot(ctx, TOKEN));
    await m.send({ text: '/search cozy corner' });
    expect(search).toHaveBeenCalledWith('cozy corner', { limit: 6 });
    m.sent.length = 0;
    await m.send({ text: '/ask Which lamp?' });
    expect(chat).toHaveBeenCalledWith({ messages: [{ role: 'user', content: 'Which lamp?' }] });
    expect(m.sent.join('')).toBe('💡'.repeat(2500) + ' [[reading-corner]]');
    expect(m.sent.every((s) => s.length <= 4000)).toBe(true);
    chat.mockImplementationOnce(async () => new Response('{"t":"error","message":"provider secret"}\n'));
    await m.send({ text: '/ask retry' });
    expect(m.sent.at(-1)).toContain('could not finish');
    expect(m.sent.at(-1)).not.toContain('provider secret');
  });

  test('real OGG voice capture runs ffmpeg + whisper and indexes the transcript (when installed)', async (t) => {
    const transcriber = new WhisperTranscriber();
    if (!(await transcriber.available()).ok) return t.skip();
    const { ctx } = await setup(transcriber);
    const m = mockApi(createTelegramBot(ctx, TOKEN, fixtureDownload()));
    await m.send({ voice: { file_id: 'voice.ogg', file_unique_id: 'v', duration: 4 }, caption: 'A reminder' });
    await ctx.jobs.idle();
    const item = latest(ctx, 'audio');
    expect(item.frontmatter.extraction).toBe('ok');
    expect(item.body).toMatch(/measure the reading corner/i);
    expect(item.why).toBe('A reminder');
    expect(ctx.lib.index.search('ordering paper lamp').some((h) => h.item.id === item.id)).toBe(true);
  }, 60_000);
});

describe('Telegram polling lifecycle', () => {
  test('starts from Settings, rotates token, survives reopen, disables and shuts down cleanly', async () => {
    const { ctx, request } = await setup();
    ctx.lib.config.telegram.enabled = false;
    const bots: Bot[] = [];
    const stop = await telegramPlugin(ctx, { createBot: (c, token) => {
      const bot = createTelegramBot(c, token);
      mockApi(bot);
      bots.push(bot);
      return bot;
    } });
    cleanups.push(stop);
    expect(bots).toHaveLength(0);
    await request('', { telegram: { enabled: true } }, 'PUT');
    await waitFor(() => ctx.extras.telegram.status().running);
    expect(ctx.extras.telegram.status().username).toBe(ME.username);
    await request('/secrets', { telegramToken: '654321:replacement' }, 'PUT');
    await waitFor(() => ctx.extras.telegram.status().running);
    expect(bots).toHaveLength(2);
    expect(bots[0].isRunning()).toBe(false);
    await ctx.jobs.idle();
    await ctx.lib.close();
    await ctx.reopen();
    expect(ctx.extras.telegram.status().running).toBe(true);
    await request('', { telegram: { enabled: false } }, 'PUT');
    expect(bots[1].isRunning()).toBe(false);
    expect(ctx.extras.telegram.status().running).toBe(false);
    await request('', { telegram: { enabled: true } }, 'PUT');
    await waitFor(() => ctx.extras.telegram.status().running);
    await stop();
    expect(bots.every((b) => !b.isRunning())).toBe(true);
  });

  test('can disable during initialization without waiting for Telegram', async () => {
    const { ctx, request } = await setup();
    const stop = await telegramPlugin(ctx, { createBot: (c, token) => {
      const bot = createTelegramBot(c, token);
      bot.api.config.use((_prev, _method, _payload, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
      }));
      return bot;
    } });
    cleanups.push(stop);
    await request('', { telegram: { enabled: false } }, 'PUT');
    expect(ctx.extras.telegram.status()).toEqual({ running: false });
  });

  test('bad tokens are shown as a safe status error and never prevent Cabinet from starting', async () => {
    const { ctx, request } = await setup();
    const stop = await telegramPlugin(ctx, { createBot: (c, token) => {
      const bot = createTelegramBot(c, token);
      bot.api.config.use(() => { throw new Error(`failed at /bot${token}/getMe`); });
      return bot;
    } });
    cleanups.push(stop);
    await waitFor(() => ctx.extras.telegram.status().error);
    const data = await request('', undefined, 'GET');
    expect(data.telegram.running).toBe(false);
    expect(data.telegram.error).toContain('Could not connect');
    expect(JSON.stringify(data)).not.toContain(TOKEN);
    await request('/secrets', { telegramToken: null }, 'PUT');
    expect(ctx.extras.telegram.status().error).toContain('Save a BotFather token');
  });
});
