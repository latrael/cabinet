import type { Library } from '@cabinet/core';

export interface Job {
  key: string; // dedupe key, e.g. "extract:<id>"
  label: string;
  itemId?: string;
  run: () => Promise<void>;
}

/** Small in-process job queue. Background work never blocks a capture. */
export class JobRunner {
  private queue: Job[] = [];
  private active = new Set<string>();
  private idleWaiters: Array<() => void> = [];
  private lib: Library;
  private concurrency: number;
  failures: Array<{ key: string; error: string; at: string }> = [];

  constructor(lib: Library, concurrency = 2) {
    this.lib = lib;
    this.concurrency = concurrency;
  }

  add(job: Job) {
    if (this.active.has(job.key) || this.queue.some((j) => j.key === job.key)) return;
    this.queue.push(job);
    this.pump();
  }

  get pending(): number {
    return this.queue.length + this.active.size;
  }

  private pump() {
    while (this.active.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.active.add(job.key);
      this.lib.emit('event', { kind: 'job', origin: 'app', id: job.itemId, data: { key: job.key, label: job.label, state: 'started' } });
      job
        .run()
        .catch((e) => {
          this.failures.unshift({ key: job.key, error: String(e?.message ?? e), at: new Date().toISOString() });
          this.failures.length = Math.min(this.failures.length, 50);
          this.lib.emit('error-log', e);
        })
        .finally(() => {
          this.active.delete(job.key);
          this.lib.emit('event', { kind: 'job', origin: 'app', id: job.itemId, data: { key: job.key, label: job.label, state: 'done' } });
          this.pump();
          if (this.pending === 0) for (const w of this.idleWaiters.splice(0)) w();
        });
    }
  }

  /** Resolves when the queue is empty (tests, shutdown). */
  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
}
