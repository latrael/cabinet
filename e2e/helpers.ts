import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

export const ROOT = new URL('..', import.meta.url).pathname;
export const SHOTS = join(ROOT, 'docs/screenshots');

export function tempLibrary(): { dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'cabinet-e2e-'));
  const dir = join(base, 'Cabinet');
  cpSync(join(ROOT, 'sample-library'), dir, { recursive: true });
  return { dir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export interface ServerHandle {
  url: string;
  proc: ChildProcess;
  stop: () => Promise<void>;
}

/** Start Cabinet as a real child process with outbound internet blocked. */
export async function startCabinet(library: string, port: number, opts: { ai?: boolean } = {}): Promise<ServerHandle> {
  const args = [join(ROOT, 'apps/cli/src/main.ts'), 'start', '--library', library, '--port', String(port), '--no-telegram', '--quiet'];
  if (!opts.ai) args.push('--no-ai');
  const proc = spawn(process.execPath, args, {
    env: { ...process.env, CABINET_BLOCK_NETWORK: '1', CABINET_APP_CONFIG: join(library, '..', 'app.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url + '/api/health');
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > 20_000) throw new Error('Cabinet did not start:\n' + log);
    if (proc.exitCode !== null) throw new Error('Cabinet exited:\n' + log);
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    url,
    proc,
    stop: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
      }),
  };
}

/** Simulate ⌘V with a URL or text when nothing is focused. */
export async function pasteText(page: Page, text: string) {
  await page.evaluate((t) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

export async function pasteFile(page: Page, path: string, name: string, type: string) {
  const b64 = readFileSync(path).toString('base64');
  await page.evaluate(
    ({ b64, name, type }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], name, { type }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { b64, name, type },
  );
}

export async function apiGet(base: string, path: string) {
  const r = await fetch(base + path);
  return r.json();
}

/** Block every request that isn't to our local servers (the browser side of "offline"). */
export async function blockInternet(page: Page) {
  await page.context().route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort('internetdisconnected'));
}
