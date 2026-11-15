import type { ServerContext } from './context.ts';

/** Telegram bot plugin (implemented in milestone 9). */
export async function telegramPlugin(_ctx: ServerContext): Promise<(() => Promise<void>) | void> {
  return undefined;
}
