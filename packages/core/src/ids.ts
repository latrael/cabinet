import { createHash } from 'node:crypto';
import { monotonicFactory } from 'ulid';

const mono = monotonicFactory();

export function newId(time?: number): string {
  return mono(time);
}

export function sha1(data: string | Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Lowercase ASCII slug, max 80 chars. Falls back to "untitled". */
export function slugify(input: string, max = 80): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let out = s.slice(0, max).replace(/-+$/, '');
  if (!out) out = 'untitled';
  return out;
}

/** Safe file name for attachments: keeps extension, slugs the stem. */
export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() || 'file';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  return slugify(stem, 60) + (ext ? '.' + ext : '');
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
