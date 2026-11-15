import type { Item, ItemSummary, LinkKind, SearchHit } from '@cabinet/core/types';

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, data: any) {
    super(data?.message ?? `Request failed (${status})`);
    this.status = status;
    this.data = data;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body, credentials: 'same-origin' });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, data);
  }
  return data as T;
}

export interface Backlink {
  sourceId: string;
  kind: LinkKind;
  context?: string;
  section?: string;
  item: ItemSummary;
}
export interface OutLink {
  target: string;
  targetId: string | null;
  kind: LinkKind;
  alias?: string;
  context?: string;
  section?: string;
  item?: ItemSummary;
}
export interface Suggestion {
  id: string;
  itemId: string;
  kind: 'tags' | 'summary' | 'link' | 'related' | 'triage' | 'collection';
  payload: any;
  status: string;
  created: string;
  source: string;
  item?: ItemSummary;
}
export interface ItemDetail {
  item: Item;
  backlinks: Backlink[];
  outgoing: OutLink[];
  projects: Array<{ projectId: string; section?: string; context?: string; project: ItemSummary }>;
  suggestions: Suggestion[];
  duplicate?: boolean;
}
export interface RelatedHit {
  item: ItemSummary;
  score: number;
  reason: string;
}

export const fileUrl = (rel: string) => '/files/' + rel.split('/').map(encodeURIComponent).join('/');
export const thumbUrl = (src: string, w = 480) => `/thumbs?src=${encodeURIComponent(src)}&w=${w}`;

export type { Item, ItemSummary, SearchHit };

export async function saveItem(id: string, patch: { body?: string; frontmatter?: Record<string, unknown>; baseHash?: string; renameFile?: boolean }) {
  return api<ItemDetail>(`/api/items/${id}`, { method: 'PUT', json: patch });
}
