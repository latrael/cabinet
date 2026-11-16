import type { Author, ItemSummary, Library, SearchHit } from '@cabinet/core';
import type { Auth } from './auth.ts';
import type { CapturePipeline } from './capture/pipeline.ts';
import type { Thumbs } from './capture/media.ts';
import type { JobRunner } from './jobs.ts';

export interface RelatedHit {
  item: ItemSummary;
  score: number;
  reason: 'similar meaning' | 'keyword';
}

/** What the server needs from the AI layer. Every method degrades gracefully. */
export interface AiBridge {
  status(): Promise<{ provider: string; chat: boolean; embeddings: boolean; chatModel?: string; embedModel?: string; reason?: string; indexed?: number }>;
  search(q: string, opts: { type?: string | string[]; status?: string | string[]; tag?: string; limit?: number }): Promise<{ hits: SearchHit[]; mode: 'hybrid' | 'keyword' }>;
  related(text: string, opts: { excludeIds?: string[]; limit?: number }): Promise<RelatedHit[]>;
  onItemChanged(id: string, author: Author): void;
  enrich(id: string): Promise<void>;
  runInboxAgent(): Promise<unknown>;
  chat(input: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; chatId?: string }): Promise<Response>;
  reindexAll(): Promise<{ embedded: number }>;
  acceptSuggestion(id: string, author: Author): Promise<void>;
  close(): Promise<void>;
}

export interface Transcriber {
  available(): Promise<{ ok: boolean; reason?: string }>;
  transcribe(absPath: string): Promise<string>;
}

export interface ServerContext {
  lib: Library;
  auth: Auth;
  jobs: JobRunner;
  thumbs: Thumbs;
  capture: CapturePipeline;
  ai: AiBridge | null;
  transcriber: Transcriber | null;
  webDist: string | null;
  version: string;
  startedAt: string;
  /** Replace the open library (used by restore). */
  reopen: () => Promise<void>;
  extras: Record<string, any>;
}

export type Vars = { Variables: { author: Author; via: string; scopes: string[] } };
