import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SAMPLE = new URL('../../../sample-library', import.meta.url).pathname;

/** Copy the sample library into a fresh temp dir. */
export function tempSample(): { dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'cabinet-test-'));
  const dir = join(base, 'lib');
  cpSync(SAMPLE, dir, { recursive: true });
  return { dir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cabinet-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | null | false, timeout = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error('waitFor timed out');
}
