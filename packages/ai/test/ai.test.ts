import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Library, saveConfig, loadConfig } from '@cabinet/core';
import { AiService, type AiHost } from '../src/bridge.ts';
import { chunkText, VectorStore } from '../src/vectors.ts';
import { tempDir, tempSample } from '../../core/test/helpers.ts';

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function host(ollamaUrl: string): Promise<{ svc: AiService; lib: Library }> {
  const t = tempSample();
  const cfg = loadConfig(t.dir);
  cfg.ai.ollamaUrl = ollamaUrl;
  saveConfig(t.dir, cfg);
  const lib = await Library.open(t.dir, { git: false });
  const h: AiHost = { lib, auth: { secrets: {} }, jobs: { add: (j) => void j.run() }, extras: {} };
  const svc = new AiService(h);
  cleanups.push(t.cleanup, () => lib.close(), () => svc.close());
  return { svc, lib };
}

async function ollamaReady(): Promise<boolean> {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1000) });
    const j = (await r.json()) as { models: Array<{ name: string }> };
    return j.models.some((m) => m.name.startsWith('nomic-embed-text'));
  } catch {
    return false;
  }
}

describe('chunking and vector store', () => {
  test('chunks long text on paragraphs with the title header on each chunk', () => {
    const body = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(60)).join('\n\n');
    const chunks = chunkText('X', 'My title\nWhy: because', body, 800);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0].text.startsWith('My title\nWhy: because')).toBe(true);
    expect(chunks[2].text.startsWith('My title\n')).toBe(true);
    expect(chunkText('X', 'My title\nWhy: because', body, 800).map((c) => c.hash)).toEqual(chunks.map((c) => c.hash));
  });

  test('cosine search, cache reuse and retention', () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    const path = join(t.dir, 'v.sqlite');
    const store = new VectorStore(path);
    const a = chunkText('A', 'Lamps', 'warm paper lamps');
    const b = chunkText('B', 'Bread', 'sourdough crumb');
    store.putCache(a[0].hash, 'm', [1, 0, 0]);
    store.putCache(b[0].hash, 'm', [0, 1, 0]);
    store.setItem('A', a, 'm');
    store.setItem('B', b, 'm');
    expect(store.search([0.9, 0.1, 0], { model: 'm' })[0].itemId).toBe('A');
    expect(store.search([0.9, 0.1, 0], { model: 'other' })).toHaveLength(0);
    expect(store.missing(a, 'm')).toHaveLength(0);
    store.close();
    const again = new VectorStore(path);
    expect(again.size).toBe(2);
    again.retain(new Set(['B']));
    expect(again.itemIds()).toEqual(['B']);
    // the cache survives, so re-adding A needs no new embedding
    expect(again.missing(a, 'm')).toHaveLength(0);
    again.close();
  });
});

describe('without Ollama (offline / not installed)', () => {
  test('status explains, search degrades to keywords with match labels, chat reports why', async () => {
    const { svc } = await host('http://127.0.0.1:9');
    const st = await svc.status();
    expect(st.chat).toBe(false);
    expect(st.embeddings).toBe(false);
    expect(st.reason).toMatch(/Ollama isn't reachable/);
    const r = await svc.search('flutter echo', {});
    expect(r.mode).toBe('keyword');
    expect(r.hits[0]).toMatchObject({ field: 'pdf' });
    const rel = await svc.related('warm paper lamp light for reading');
    expect(rel.length).toBeGreaterThan(0);
    expect(rel[0].reason).toBe('keyword');
    const res = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(await res.text()).toMatch(/"t":"error"/);
    const digest: any = await svc.runInboxAgent();
    expect(digest.payload.triage).toEqual([]);
    expect(digest.payload.summary).toMatch(/needs a chat model/);
  });
});

describe('with local Ollama (skipped when unavailable)', () => {
  test('embeds the library and finds things by meaning', async (ctx) => {
    if (!(await ollamaReady())) return ctx.skip();
    const { svc, lib } = await host('http://127.0.0.1:11434');
    await svc.embedAll();
    expect(svc.store.itemIds().length).toBe(lib.index.counts().total);
    const r = await svc.search('gramophone', {});
    expect(r.mode).toBe('hybrid');
    const top = r.hits.slice(0, 4).map((h) => h.item.slug);
    expect(top.some((s) => /listening|record/.test(s))).toBe(true);
    expect(r.hits[0].field).toBe('semantic');
    const rel = await svc.related('how do I stop echo in a small room');
    expect(rel[0].reason).toBe('similar meaning');
    expect(rel.map((h) => h.item.slug)).toContain('room-acoustics-primer');
    // incremental: editing one item only re-embeds that item
    const before = svc.store.size;
    const n = lib.create({ type: 'note', title: 'Horn speakers', body: 'Big horns need a large room.' });
    svc.queueEmbed(n.id);
    await new Promise((r) => setTimeout(r, 1500));
    expect(svc.store.size).toBe(before + 1);
  }, 60_000);
});
