import { watch, type FSWatcher } from 'chokidar';
import { relative, sep } from 'node:path';

export interface WatchEvent {
  type: 'add' | 'change' | 'unlink';
  path: string; // relative, posix
}

const IGNORED_DIRS = new Set(['.cabinet', '.git', '.obsidian', '.trash', 'node_modules', 'attachments']);

export function isLibraryMarkdown(rel: string): boolean {
  if (!rel.toLowerCase().endsWith('.md')) return false;
  const parts = rel.split('/');
  if (parts.some((p) => IGNORED_DIRS.has(p) || p.startsWith('.'))) return false;
  if (parts.length === 1 && ['agents.md', 'readme.md'].includes(parts[0].toLowerCase())) return false;
  return true;
}

/** Watches the library for external edits (any editor, Obsidian, git pull, sync tools). */
export class LibraryWatcher {
  private watcher: FSWatcher | null = null;
  private root: string;
  private onEvent: (e: WatchEvent) => void;

  constructor(root: string, onEvent: (e: WatchEvent) => void) {
    this.root = root;
    this.onEvent = onEvent;
  }

  async start(): Promise<void> {
    const root = this.root;
    this.watcher = watch(root, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
      ignored: (p: string, stats?: { isFile(): boolean }) => {
        const rel = relative(root, p).split(sep).join('/');
        if (!rel) return false;
        const parts = rel.split('/');
        if (parts.some((x) => IGNORED_DIRS.has(x) || (x.startsWith('.') && x !== '.'))) return true;
        if (stats?.isFile() && !rel.toLowerCase().endsWith('.md')) return true;
        return false;
      },
    });
    const emit = (type: WatchEvent['type']) => (p: string) => {
      const rel = relative(root, p).split(sep).join('/');
      if (isLibraryMarkdown(rel)) this.onEvent({ type, path: rel });
    };
    this.watcher.on('add', emit('add')).on('change', emit('change')).on('unlink', emit('unlink'));
    await new Promise<void>((resolve) => this.watcher!.once('ready', () => resolve()));
  }

  async stop() {
    await this.watcher?.close();
    this.watcher = null;
  }
}
