import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { agentsMd, libraryGitignore } from './agents-md.ts';
import { defaultConfig, loadConfig, saveConfig, type LibraryConfig } from './config.ts';
import { serializeMarkdown, setSection, getSection, parseMarkdown } from './format.ts';
import { AutoCommitter } from './git.ts';
import { newId, nowIso, safeFileName, sha1, slugify } from './ids.ts';
import { LibraryIndex } from './index-db.ts';
import { buildRecord, itemFromText } from './item.ts';
import { linkKey, rewriteLinks } from './links.ts';
import { addEntry, parseMaterial, writeMaterial } from './project.ts';
import { StateStore } from './state.ts';
import { folderForType, type Author, type Frontmatter, type Item, type ItemType, type LibraryEvent, type Status } from './types.ts';
import { isLibraryMarkdown, LibraryWatcher, type WatchEvent } from './watcher.ts';

export class ConflictError extends Error {
  current: Item;
  constructor(current: Item) {
    super('The file changed on disk since you opened it');
    this.current = current;
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`Not found: ${what}`);
    this.name = 'NotFoundError';
  }
}

export interface LibraryOptions {
  watch?: boolean;
  git?: boolean;
  debounceMs?: number;
  indexPath?: string; // override (tests)
}

export interface CreateInput {
  type: ItemType;
  title?: string;
  body?: string;
  why?: string;
  tags?: string[];
  collections?: string[];
  status?: Status;
  slug?: string;
  frontmatter?: Partial<Frontmatter>;
  captured_via?: string;
  id?: string;
  created?: string;
}

export interface UpdateInput {
  frontmatter?: Partial<Frontmatter> & Record<string, unknown>;
  body?: string;
  baseHash?: string;
  /** Rename the file to match a changed title (default: only when the slug was derived from the old title). */
  renameFile?: boolean;
}

export const CONTENT_FOLDERS = ['notes', 'sources', 'projects', 'collections', 'memories'];

export function normalizeTag(t: string): string {
  return t
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '');
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export class Library extends EventEmitter {
  readonly root: string;
  config: LibraryConfig;
  index: LibraryIndex;
  state: StateStore;
  git: AutoCommitter | null = null;
  private watcher: LibraryWatcher | null = null;
  private closed = false;

  private constructor(root: string, opts: LibraryOptions) {
    super();
    this.setMaxListeners(100);
    this.root = resolve(root);
    this.config = loadConfig(this.root);
    this.index = new LibraryIndex(opts.indexPath ?? join(this.root, '.cabinet', 'index.sqlite'));
    this.state = new StateStore(join(this.root, '.cabinet', 'state.sqlite'));
  }

  /** Create the library folder structure if missing. Idempotent. */
  static initStructure(root: string, name = 'Cabinet') {
    mkdirSync(root, { recursive: true });
    for (const f of [...CONTENT_FOLDERS, 'attachments', '.cabinet']) mkdirSync(join(root, f), { recursive: true });
    if (!existsSync(join(root, '.cabinet', 'config.json'))) saveConfig(root, defaultConfig(name));
    if (!existsSync(join(root, 'AGENTS.md'))) writeFileSync(join(root, 'AGENTS.md'), agentsMd());
    if (!existsSync(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), libraryGitignore());
  }

  static async open(root: string, opts: LibraryOptions = {}): Promise<Library> {
    Library.initStructure(root);
    const lib = new Library(root, opts);
    const gitEnabled = opts.git ?? lib.config.git.autoCommit;
    if (gitEnabled) {
      await AutoCommitter.ensureRepo(lib.root);
      lib.git = new AutoCommitter(lib.root, {
        enabled: true,
        debounceMs: opts.debounceMs ?? lib.config.git.debounceMs,
        remote: lib.config.git.remote,
        push: lib.config.git.push,
        onError: (e) => lib.emit('error-log', e),
        onCommit: (info) => lib.emit('commit', info),
      });
    }
    lib.sync();
    if (opts.watch) {
      lib.watcher = new LibraryWatcher(lib.root, (e) => lib.onWatch(e));
      await lib.watcher.start();
    }
    return lib;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('closed');
    await this.watcher?.stop();
    await this.git?.close();
    this.index.close();
    this.state.close();
  }

  saveConfig(cfg: LibraryConfig) {
    this.config = cfg;
    saveConfig(this.root, cfg);
    this.git?.setOptions({ remote: cfg.git.remote, push: cfg.git.push, debounceMs: cfg.git.debounceMs });
    this.git?.track('.cabinet/config.json', 'you', 'update settings');
  }

  private emitEvent(e: LibraryEvent) {
    this.emit('event', e);
  }

  // ------------------------------------------------------------------ paths

  abs(rel: string): string {
    const p = resolve(this.root, rel);
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new Error(`Path escapes library: ${rel}`);
    return p;
  }

  listMarkdownFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        const rel = toPosix(relative(this.root, full));
        if (e.isDirectory()) {
          if (['attachments', 'node_modules'].includes(e.name) && !rel.includes('/')) continue;
          walk(full);
        } else if (e.isFile() && isLibraryMarkdown(rel)) out.push(rel);
      }
    };
    walk(this.root);
    return out.sort();
  }

  // ------------------------------------------------------------------ indexing

  private indexFile(rel: string): Item | null {
    const abs = this.abs(rel);
    let text: string;
    let mtime = 0;
    try {
      text = readFileSync(abs, 'utf8');
      mtime = statSync(abs).mtimeMs;
    } catch {
      return null;
    }
    const rec = buildRecord(rel, text, mtime);
    this.index.upsert(rec, mtime);
    return rec.item;
  }

  /** Bring the index in line with the files on disk (incremental). */
  sync(): { added: number; updated: number; removed: number } {
    const files = this.listMarkdownFiles();
    const known = this.index.fileState();
    let added = 0;
    let updated = 0;
    let removed = 0;
    this.index.transaction(() => {
      for (const rel of files) {
        const k = known.get(rel);
        known.delete(rel);
        const abs = this.abs(rel);
        const mtime = statSync(abs).mtimeMs;
        if (k && k.mtime === mtime) continue;
        const text = readFileSync(abs, 'utf8');
        if (k && k.hash === sha1(text)) continue;
        this.index.upsert(buildRecord(rel, text, mtime), mtime);
        if (k) updated++;
        else added++;
      }
      for (const [, v] of known) {
        this.index.remove(v.id);
        removed++;
      }
    });
    return { added, updated, removed };
  }

  /** Drop the index and rebuild it from the files. */
  rebuild(): { items: number; ms: number } {
    const t = performance.now();
    const files = this.listMarkdownFiles();
    this.index.transaction(() => {
      this.index.clear();
      for (const rel of files) {
        const abs = this.abs(rel);
        const text = readFileSync(abs, 'utf8');
        const mtime = statSync(abs).mtimeMs;
        this.index.upsert(buildRecord(rel, text, mtime), mtime);
      }
    });
    const res = { items: files.length, ms: Math.round(performance.now() - t) };
    this.emitEvent({ kind: 'rebuilt', origin: 'app', data: res });
    return res;
  }

  private onWatch(e: WatchEvent) {
    if (this.closed) return;
    try {
      if (e.type === 'unlink') {
        const id = this.index.idForPath(e.path);
        if (!id) return;
        if (existsSync(this.abs(e.path))) return;
        this.index.remove(id);
        this.git?.track(e.path, 'you', `delete ${e.path} (external)`);
        this.emitEvent({ kind: 'deleted', id, path: e.path, origin: 'disk' });
        return;
      }
      const abs = this.abs(e.path);
      if (!existsSync(abs)) return;
      const text = readFileSync(abs, 'utf8');
      const known = this.index.fileState().get(e.path);
      if (known && known.hash === sha1(text)) return; // our own write, or no real change
      const item = this.indexFile(e.path);
      if (!item) return;
      this.git?.track(e.path, 'you', `edit “${item.title}” (external)`);
      this.emitEvent({ kind: known ? 'updated' : 'created', id: item.id, path: e.path, origin: 'disk' });
    } catch (err) {
      this.emit('error-log', err);
    }
  }

  // ------------------------------------------------------------------ reads

  read(id: string): Item {
    const path = this.index.pathForId(id);
    if (!path) throw new NotFoundError(id);
    return this.readPath(path);
  }

  readPath(rel: string): Item {
    const abs = this.abs(rel);
    if (!existsSync(abs)) throw new NotFoundError(rel);
    const text = readFileSync(abs, 'utf8');
    return itemFromText(rel, text, statSync(abs).mtimeMs);
  }

  /** Look up by id, slug, title or alias. */
  find(ref: string): Item | null {
    const id = this.index.getSummary(ref) ? ref : this.index.resolve(ref);
    if (!id) return null;
    try {
      return this.read(id);
    } catch {
      return null;
    }
  }

  rawText(id: string): string {
    const path = this.index.pathForId(id);
    if (!path) throw new NotFoundError(id);
    return readFileSync(this.abs(path), 'utf8');
  }

  // ------------------------------------------------------------------ writes

  private writeAtomic(rel: string, text: string) {
    const abs = this.abs(rel);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, abs);
  }

  uniqueSlug(base: string, ignoreId?: string): string {
    let slug = slugify(base);
    let n = 2;
    const taken = (s: string) => {
      if (!this.index.slugExists(s)) return false;
      if (ignoreId) {
        const id = this.index.resolve(s);
        if (id === ignoreId) return false;
      }
      return true;
    };
    const root = slug;
    while (taken(slug) || CONTENT_FOLDERS.some((f) => existsSync(join(this.root, f, slug + '.md')))) {
      slug = `${root}-${n++}`;
    }
    return slug;
  }

  create(input: CreateInput, author: Author = 'you'): Item {
    const now = nowIso();
    const title = (input.title ?? '').trim() || 'Untitled';
    const slug = input.slug ? this.uniqueSlug(input.slug) : this.uniqueSlug(title);
    const folder = folderForType(input.type);
    const rel = `${folder}/${slug}.md`;
    const fm: Record<string, unknown> = {
      id: input.id ?? newId(),
      type: input.type,
      title,
      status: input.status ?? (['note', 'project', 'collection', 'memory'].includes(input.type) ? 'library' : 'inbox'),
      created: input.created ?? now,
      updated: input.created ?? now,
      why: input.why?.trim() || undefined,
      tags: input.tags?.map(normalizeTag).filter(Boolean),
      collections: input.collections?.filter(Boolean),
      captured_via: input.captured_via,
      ...(input.frontmatter ?? {}),
    };
    const text = serializeMarkdown(fm, input.body ?? '');
    this.writeAtomic(rel, text);
    const item = this.indexFile(rel)!;
    this.git?.track(rel, author, `add ${input.type} “${title}”`);
    this.emitEvent({ kind: 'created', id: item.id, path: rel, origin: 'app', author });
    return item;
  }

  update(id: string, patch: UpdateInput, author: Author = 'you', note?: string): Item {
    const path = this.index.pathForId(id);
    if (!path) throw new NotFoundError(id);
    const abs = this.abs(path);
    if (!existsSync(abs)) throw new NotFoundError(path);
    const currentText = readFileSync(abs, 'utf8');
    const current = itemFromText(path, currentText);
    if (patch.baseHash && patch.baseHash !== current.hash) throw new ConflictError(current);

    const { frontmatter: rawFm } = parseMarkdown(currentText);
    const fm: Record<string, unknown> = { ...rawFm, id: current.id, type: current.type, title: current.title, created: current.created };
    if (patch.frontmatter) {
      for (const [k, v] of Object.entries(patch.frontmatter)) {
        if (k === 'id' || k === 'created') continue;
        fm[k] = v === null ? undefined : v;
      }
    }
    if (Array.isArray(fm.tags)) fm.tags = [...new Set((fm.tags as string[]).map(normalizeTag).filter(Boolean))];
    fm.updated = nowIso();
    const body = patch.body ?? current.body;
    const text = serializeMarkdown(fm, body);
    if (text === currentText) return current;

    const newTitle = String(fm.title ?? current.title);
    const titleChanged = newTitle !== current.title;
    const shouldRename = titleChanged && (patch.renameFile ?? slugify(current.title) === current.slug);

    this.writeAtomic(path, text);
    let item = this.indexFile(path)!;
    this.git?.track(path, author, note ?? `edit “${item.title}”`);
    this.emitEvent({ kind: 'updated', id: item.id, path, origin: 'app', author });
    if (shouldRename) item = this.rename(id, newTitle, author, [current.title]);
    return item;
  }

  /** Rename an item's file to a new slug and rewrite every link that points at it. */
  rename(id: string, newName: string, author: Author = 'you', extraOldKeys: string[] = []): Item {
    const oldPath = this.index.pathForId(id);
    if (!oldPath) throw new NotFoundError(id);
    const item = this.readPath(oldPath);
    const slug = this.uniqueSlug(newName, id);
    if (slug === item.slug) return item;
    const newPath = `${oldPath.slice(0, oldPath.lastIndexOf('/') + 1)}${slug}.md`;
    const backlinkers = [...new Set(this.index.backlinks(id).map((b) => b.sourceId))];
    renameSync(this.abs(oldPath), this.abs(newPath));
    this.index.remove(id);
    const renamed = this.indexFile(newPath)!;
    this.git?.track(oldPath, author);
    this.git?.track(newPath, author, `rename “${item.title}” → ${slug}`);
    const oldKeys = [item.slug, item.title, ...extraOldKeys];
    for (const src of backlinkers) {
      const srcPath = this.index.pathForId(src);
      if (!srcPath) continue;
      const text = readFileSync(this.abs(srcPath), 'utf8');
      const { frontmatter, body } = parseMarkdown(text);
      const r1 = rewriteLinks(body, oldKeys, slug);
      let why = frontmatter.why as string | undefined;
      let c2 = 0;
      if (typeof why === 'string') {
        const r2 = rewriteLinks(why, oldKeys, slug);
        why = r2.text;
        c2 = r2.count;
      }
      if (!r1.count && !c2) continue;
      const out = serializeMarkdown({ ...frontmatter, why }, r1.text);
      this.writeAtomic(srcPath, out);
      this.indexFile(srcPath);
      this.git?.track(srcPath, author, `update links to ${slug}`);
      this.emitEvent({ kind: 'updated', id: src, path: srcPath, origin: 'app', author });
    }
    this.emitEvent({ kind: 'renamed', id, path: newPath, oldPath, origin: 'app', author });
    return renamed;
  }

  delete(id: string, author: Author = 'you') {
    const path = this.index.pathForId(id);
    if (!path) throw new NotFoundError(id);
    const item = this.readPath(path);
    unlinkSync(this.abs(path));
    const att = item.frontmatter.attachment;
    if (typeof att === 'string' && att.startsWith('attachments/') && existsSync(this.abs(att))) {
      rmSync(this.abs(att));
      this.git?.track(att, author);
    }
    this.index.remove(id);
    this.git?.track(path, author, `delete “${item.title}”`);
    this.emitEvent({ kind: 'deleted', id, path, origin: 'app', author });
  }

  /** Store a file under attachments/YYYY/MM/<id>-<name>. Returns the library-relative path. */
  saveAttachment(data: Uint8Array, name: string, author: Author = 'you', date = new Date()): string {
    const y = String(date.getUTCFullYear());
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const rel = `attachments/${y}/${m}/${newId().slice(-10).toLowerCase()}-${safeFileName(name)}`;
    const abs = this.abs(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    this.git?.track(rel, author);
    return rel;
  }

  /** Add `[[target]]` to the source item's `## Related` list (idempotent). */
  linkItems(fromId: string, toId: string, author: Author = 'you', note?: string): Item {
    const from = this.read(fromId);
    const to = this.read(toId);
    const existing = getSection(from.body, 'Related') ?? '';
    const already = this.index.outgoing(fromId).some((l) => l.targetId === toId);
    if (already) return from;
    const line = `- [[${to.slug}]]${note ? ': ' + note : ''}`;
    const body = setSection(from.body, 'Related', existing ? existing + '\n' + line : line, { before: ['Content', 'Timestamps'] });
    return this.update(fromId, { body }, author, `link “${from.title}” → “${to.title}”`);
  }

  /** Reference an item from a project's Material (never duplicates content). */
  addToProject(projectId: string, itemId: string, opts: { section?: string; context?: string } = {}, author: Author = 'you'): Item {
    const project = this.read(projectId);
    if (project.type !== 'project') throw new Error('Not a project');
    const target = this.read(itemId);
    const sections = parseMaterial(getSection(project.body, 'Material') ?? '');
    const next = addEntry(sections, target.slug, { section: opts.section, context: opts.context });
    const body = writeMaterial(project.body, next);
    return this.update(projectId, { body }, author, `add “${target.title}” to project “${project.title}”`);
  }

  /** Items whose slug/title/alias keys collide with `ref`. */
  resolveLink(ref: string): string | null {
    return this.index.resolve(ref);
  }

  linkKey = linkKey;
}
