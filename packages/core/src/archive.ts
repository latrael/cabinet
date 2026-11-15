import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

const EXCLUDE_ALWAYS = [
  /^\.cabinet\/index\.sqlite/,
  /^\.cabinet\/state\.sqlite/,
  /^\.cabinet\/cache\//,
  /^\.cabinet\/thumbs\//,
  /^\.cabinet\/tmp\//,
  /^\.cabinet\/secrets\.json$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.[^/]*\.tmp$/,
];

export interface ExportOptions {
  includeGit?: boolean;
}

function walk(root: string, includeGit: boolean): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join('/');
      if (!includeGit && (rel === '.git' || rel.startsWith('.git/'))) continue;
      if (EXCLUDE_ALWAYS.some((r) => r.test(rel))) continue;
      if (e.isDirectory()) rec(full);
      else if (e.isFile()) out.push(rel);
    }
  };
  rec(root);
  return out.sort();
}

/** Zip the library (index, cache and secrets excluded; git history optional). */
export function exportLibrary(root: string, opts: ExportOptions = {}): Uint8Array {
  const files = walk(root, !!opts.includeGit);
  const z: Zippable = {};
  for (const rel of files) {
    const st = statSync(join(root, rel));
    z[rel] = [readFileSync(join(root, rel)), { mtime: st.mtime, level: /\.(png|jpe?g|webp|gif|pdf|mp3|m4a|ogg|mp4|zip)$/i.test(rel) ? 0 : 6 }];
  }
  z['.cabinet-export.json'] = strToU8(JSON.stringify({ format: 'cabinet-export', version: 1, created: new Date().toISOString(), files: files.length }));
  return zipSync(z);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  files: number;
}

export function validateExport(zip: Uint8Array): ValidationResult & { entries?: Record<string, Uint8Array> } {
  const errors: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch (e) {
    return { ok: false, errors: [`Not a valid zip: ${(e as Error).message}`], files: 0 };
  }
  const names = Object.keys(entries);
  for (const n of names) {
    if (n.startsWith('/') || n.split('/').includes('..') || /^[a-zA-Z]:/.test(n) || n.includes('\\')) errors.push(`Unsafe path in archive: ${n}`);
  }
  const manifest = entries['.cabinet-export.json'];
  if (!manifest) errors.push('Missing .cabinet-export.json manifest');
  else {
    try {
      const m = JSON.parse(strFromU8(manifest));
      if (m.format !== 'cabinet-export') errors.push('Manifest is not a Cabinet export');
    } catch {
      errors.push('Manifest is not valid JSON');
    }
  }
  if (!entries['.cabinet/config.json']) errors.push('Missing .cabinet/config.json');
  const files = names.filter((n) => !n.endsWith('/') && n !== '.cabinet-export.json').length;
  return { ok: errors.length === 0, errors, files, entries };
}

/**
 * Restore an export into `root`. The current library is moved aside to `<root>.backup-<stamp>`
 * first; returns that backup path. The caller must rebuild the index afterwards.
 */
export function restoreLibrary(root: string, zip: Uint8Array, opts: { keepSecretsFrom?: string } = {}): { backup: string | null; files: number } {
  const v = validateExport(zip);
  if (!v.ok || !v.entries) throw new Error('Invalid export: ' + v.errors.join('; '));
  const abs = resolve(root);
  let backup: string | null = null;
  let secrets: Uint8Array | null = null;
  if (existsSync(abs)) {
    const sp = join(abs, '.cabinet', 'secrets.json');
    if (existsSync(sp)) secrets = readFileSync(sp);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${abs}.backup-${stamp}`;
    renameSync(abs, backup);
  }
  mkdirSync(abs, { recursive: true });
  let files = 0;
  for (const [name, data] of Object.entries(v.entries)) {
    if (name.endsWith('/') || name === '.cabinet-export.json') continue;
    const target = resolve(abs, name);
    if (!target.startsWith(abs + sep)) throw new Error(`Unsafe path: ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    files++;
  }
  if (secrets) writeFileSync(join(abs, '.cabinet', 'secrets.json'), secrets);
  void opts;
  return { backup, files };
}

/** List files (for verification). */
export function listLibraryFiles(root: string, includeGit = false): string[] {
  return walk(root, includeGit);
}
