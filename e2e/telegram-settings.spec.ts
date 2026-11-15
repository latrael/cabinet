import { expect, test } from '@playwright/test';
import { startServer } from '../apps/server/src/server.ts';
import { createTelegramBot, telegramPlugin } from '../apps/server/src/telegram.ts';
import { blockInternet, tempLibrary } from './helpers.ts';

// Exercise the real web app, Settings routes and polling lifecycle without
// contacting Telegram or requiring a personal bot token.
test('Telegram settings: enable, pair, refresh status, revoke and disable', async ({ page }) => {
  const lib = tempLibrary();
  let bot: ReturnType<typeof createTelegramBot> | undefined;
  const srv = await startServer({
    library: lib.dir, port: 0, quiet: true, watch: false, git: false,
    plugins: [(ctx) => telegramPlugin(ctx, { createBot: (c, token) => {
      bot = createTelegramBot(c, token);
      bot.api.config.use(async (_prev, method, payload, signal): Promise<any> => {
        if (method === 'getMe') return { ok: true, result: { id: 123456, is_bot: true, first_name: 'Cabinet', username: 'cabinet_test_bot' } };
        if (method === 'deleteWebhook') return { ok: true, result: true };
        if (method === 'sendMessage') return { ok: true, result: { message_id: 1, date: 0, chat: { id: 42, type: 'private' }, text: (payload as any).text } };
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
      return bot;
    } })],
  });
  try {
    await blockInternet(page);
    await page.goto(srv.url + '/settings');
    await expect(page.getByTestId('telegram-status')).toContainText('Bot not running');
    await page.getByPlaceholder('123456:ABC…').fill('123456:fake-test-token');
    await page.locator('label').filter({ hasText: 'Bot token from @BotFather' }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByPlaceholder('••••••••  (saved)')).toHaveValue('');
    await page.getByLabel('Enable the bot').click();
    await expect(page.getByLabel('Enable the bot')).toBeChecked();
    await expect(page.getByTestId('telegram-status')).toContainText('@cabinet_test_bot');
    const paired = page.waitForResponse((r) => r.url().endsWith('/api/settings/telegram/pair') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Pair a chat', exact: true }).click();
    const { code } = await (await paired).json();
    await expect(page.locator('p').filter({ hasText: `/pair ${code}` })).toContainText('private chat');
    await bot!.handleUpdate({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 42, type: 'private', first_name: 'Tester' }, from: { id: 42, is_bot: false, first_name: 'Tester' }, text: `/pair ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 5 }] } } as Parameters<NonNullable<typeof bot>['handleUpdate']>[0]);
    await expect(page.locator('li').filter({ hasText: 'Chat 42' })).toBeVisible();
    // Editing other settings must not clear newly paired chats or unsaved fields.
    await page.getByLabel('Chat model (Ollama)', { exact: true }).fill('unsaved-local-choice');
    await page.waitForResponse((r) => r.url().endsWith('/api/settings/telegram'));
    await expect(page.getByLabel('Chat model (Ollama)', { exact: true })).toHaveValue('unsaved-local-choice');
    await page.locator('li').filter({ hasText: 'Chat 42' }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('li').filter({ hasText: 'Chat 42' })).toHaveCount(0);
    expect(srv.ctx.lib.config.telegram.allowedChats).toEqual([]);
    await page.getByLabel('Enable the bot').click();
    await expect(page.getByLabel('Enable the bot')).not.toBeChecked();
    await expect(page.getByTestId('telegram-status')).toContainText('Bot not running');
    expect(bot!.isRunning()).toBe(false);
  } finally {
    await srv.close();
    lib.cleanup();
  }
});
