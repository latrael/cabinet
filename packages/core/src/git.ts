import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { Author } from './types.ts';

export function authorIdentity(author: Author): { name: string; email: string } {
  const safe = author.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return { name: author, email: `${safe}@cabinet.local` };
}

interface Pending {
  paths: Set<string>;
  notes: Set<string>;
}

export interface GitOptions {
  debounceMs: number;
  enabled: boolean;
  remote?: string;
  push?: boolean;
  onError?: (e: unknown) => void;
  onCommit?: (info: { author: Author; message: string; files: string[] }) => void;
}

/**
 * Debounced auto-commit. Changes are grouped per author so every commit is attributable:
 * `you`, `agent:<name>`, `telegram`, `inbox-agent`.
 */
export class AutoCommitter {
  private pending = new Map<Author, Pending>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();
  private git: SimpleGit;

  private root: string;
  private opts: GitOptions;

  constructor(root: string, opts: GitOptions) {
    this.root = root;
    this.opts = opts;
    this.git = simpleGit({ baseDir: root });
  }

  static async ensureRepo(root: string): Promise<void> {
    const git = simpleGit({ baseDir: root });
    if (!existsSync(join(root, '.git'))) {
      await git.init(['-b', 'main']);
    }
    // Committer identity is always "Cabinet"; the author carries who made the change.
    await git.addConfig('user.name', 'Cabinet', false, 'local');
    await git.addConfig('user.email', 'cabinet@cabinet.local', false, 'local');
  }

  setOptions(opts: Partial<GitOptions>) {
    this.opts = { ...this.opts, ...opts };
  }

  track(path: string, author: Author, note?: string) {
    if (!this.opts.enabled) return;
    let p = this.pending.get(author);
    if (!p) {
      p = { paths: new Set(), notes: new Set() };
      this.pending.set(author, p);
    }
    p.paths.add(path);
    if (note) p.notes.add(note);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.opts.debounceMs);
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Commit everything pending now. Safe to call repeatedly. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    this.pending = new Map();
    this.running = this.running.then(() => this.commitBatch(batch)).catch((e) => this.opts.onError?.(e));
    return this.running;
  }

  /** Retry git commands when another process (e.g. an MCP stdio server) holds the index lock. */
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= 6 || !/index\.lock|unable to create .*lock/i.test(String((e as Error).message))) throw e;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }

  private async commitBatch(batch: Map<Author, Pending>) {
    let committed = false;
    for (const [author, p] of batch) {
      const files = [...p.paths];
      if (!files.length) continue;
      await this.retry(() => this.git.raw(['add', '-A', '--', ...files]));
      const staged = (await this.git.raw(['diff', '--cached', '--name-only'])).trim();
      if (!staged) continue;
      const notes = [...p.notes];
      const subject =
        notes.length === 1 ? `${author}: ${notes[0]}` : notes.length ? `${author}: ${notes.length} changes` : `${author}: update ${files.length} file(s)`;
      const body = notes.length > 1 ? '\n\n' + notes.map((n) => `- ${n}`).join('\n') : '';
      const id = authorIdentity(author);
      await this.retry(() => this.git.raw(['commit', '-q', '-m', subject + body, `--author=${id.name} <${id.email}>`, '--', ...files]));
      committed = true;
      this.opts.onCommit?.({ author, message: subject, files });
    }
    if (committed && this.opts.push && this.opts.remote) {
      try {
        await this.git.push(this.opts.remote, 'main');
      } catch (e) {
        this.opts.onError?.(e);
      }
    }
  }

  async log(limit = 20, path?: string): Promise<Array<{ hash: string; date: string; author: string; message: string }>> {
    try {
      const r = await this.git.log({ maxCount: limit, ...(path ? { file: path } : {}) });
      return r.all.map((c) => ({ hash: c.hash, date: c.date, author: c.author_name, message: c.message }));
    } catch {
      return [];
    }
  }

  async close() {
    await this.flush();
  }
}
