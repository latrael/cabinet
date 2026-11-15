import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

export const USER_AGENT = 'Mozilla/5.0 (compatible; Cabinet/0.1; personal library)';

export interface FetchResult {
  url: string; // final URL after redirects
  status: number;
  contentType: string;
  data: Uint8Array;
}

export async function fetchUrl(url: string, opts: { timeoutMs?: number; maxBytes?: number; accept?: string } = {}): Promise<FetchResult> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    headers: { 'user-agent': USER_AGENT, accept: opts.accept ?? 'text/html,application/xhtml+xml,application/pdf,image/*;q=0.9,*/*;q=0.8' },
  });
  const max = opts.maxBytes ?? 25 * 1024 * 1024;
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new Error(`Response larger than ${Math.round(max / 1024 / 1024)} MB`);
      }
      chunks.push(value);
    }
  }
  const data = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    data.set(c, o);
    o += c.byteLength;
  }
  return { url: res.url || url, status: res.status, contentType: (res.headers.get('content-type') ?? '').toLowerCase(), data };
}

export function decodeHtml(data: Uint8Array, contentType: string): string {
  const m = /charset=([\w-]+)/i.exec(contentType);
  let charset = m?.[1] ?? 'utf-8';
  const head = new TextDecoder('latin1').decode(data.slice(0, 2048));
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (!m && meta) charset = meta[1];
  try {
    return new TextDecoder(charset).decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}

export function normalizeUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) links can be captured');
  // Strip common tracking parameters
  for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_eid|igshid)/i.test(p)) u.searchParams.delete(p);
  return u.toString();
}

export function looksLikeUrl(text: string): boolean {
  const t = text.trim();
  if (/\s/.test(t) || t.length > 2048) return false;
  return /^(https?:\/\/)[^\s]+\.[^\s]+/i.test(t) || /^www\.[^\s]+\.[a-z]{2,}/i.test(t) || /^https?:\/\/localhost(:\d+)?\//i.test(t);
}

// ---------------------------------------------------------------- video

export interface VideoRef {
  provider: 'youtube' | 'vimeo';
  id: string;
  start?: number;
}

export function parseVideoUrl(url: string): VideoRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const t = u.searchParams.get('t') ?? u.searchParams.get('start') ?? (u.hash.match(/t=([\dhms]+)/)?.[1] ?? null);
  const start = t ? parseTimestamp(t) : undefined;
  if (host === 'youtu.be') return { provider: 'youtube', id: u.pathname.slice(1).split('/')[0], start };
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const v = u.searchParams.get('v');
    if (v) return { provider: 'youtube', id: v, start };
    const m = /^\/(shorts|embed|live)\/([\w-]{6,})/.exec(u.pathname);
    if (m) return { provider: 'youtube', id: m[2], start };
  }
  if (host === 'vimeo.com') {
    const m = /^\/(\d+)/.exec(u.pathname);
    if (m) return { provider: 'vimeo', id: m[1], start };
  }
  return null;
}

export function parseTimestamp(t: string): number | undefined {
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  const c = t.split(':').map(Number);
  if (c.every((x) => !Number.isNaN(x)) && c.length >= 2) return c.reduce((a, b) => a * 60 + b, 0);
  return undefined;
}

export function formatTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function videoTimestampUrl(v: VideoRef, sec: number): string {
  return v.provider === 'youtube' ? `https://youtu.be/${v.id}?t=${sec}` : `https://vimeo.com/${v.id}#t=${sec}s`;
}

export interface OEmbed {
  title?: string;
  author_name?: string;
  provider_name?: string;
  thumbnail_url?: string;
}

export async function fetchOEmbed(v: VideoRef, url: string, timeoutMs = 6000): Promise<OEmbed | null> {
  const endpoint =
    v.provider === 'youtube'
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${v.id}`)}`
      : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) return null;
    return (await res.json()) as OEmbed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- metadata

export interface PageMeta {
  title?: string;
  description?: string;
  image?: string;
  site?: string;
  author?: string;
  published?: string;
  favicon?: string;
  type?: string;
}

export function extractMeta(html: string, baseUrl: string): PageMeta {
  const { document } = parseHTML(html);
  const meta = (...names: string[]) => {
    for (const n of names) {
      const el = document.querySelector(`meta[property="${n}"]`) ?? document.querySelector(`meta[name="${n}"]`);
      const v = el?.getAttribute('content')?.trim();
      if (v) return v;
    }
    return undefined;
  };
  const abs = (u?: string) => {
    if (!u) return undefined;
    try {
      return new URL(u, baseUrl).toString();
    } catch {
      return undefined;
    }
  };
  const icon = document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? '/favicon.ico';
  return {
    title: meta('og:title', 'twitter:title') ?? document.querySelector('title')?.textContent?.trim() ?? undefined,
    description: meta('og:description', 'twitter:description', 'description'),
    image: abs(meta('og:image', 'og:image:url', 'twitter:image', 'twitter:image:src')),
    site: meta('og:site_name', 'application-name') ?? safeHost(baseUrl),
    author: meta('article:author', 'author', 'twitter:creator'),
    published: meta('article:published_time', 'date', 'pubdate', 'og:article:published_time')?.slice(0, 10),
    favicon: abs(icon),
    type: meta('og:type'),
  };
}

export function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- article

export interface Article {
  title?: string;
  byline?: string;
  site?: string;
  published?: string;
  markdown: string;
  textLength: number;
  excerpt?: string;
}

function makeTurndown(baseUrl: string): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  const abs = (u: string) => {
    try {
      return new URL(u, baseUrl).toString();
    } catch {
      return u;
    }
  };
  td.addRule('absLinks', {
    filter: (node) => node.nodeName === 'A' && !!(node as any).getAttribute('href'),
    replacement: (content, node) => {
      const href = abs((node as any).getAttribute('href'));
      const text = content.trim();
      if (!text) return '';
      if (href.startsWith('javascript:')) return text;
      return `[${text}](${href})`;
    },
  });
  td.addRule('absImages', {
    filter: 'img',
    replacement: (_c, node) => {
      const src = (node as any).getAttribute('src') || (node as any).getAttribute('data-src');
      if (!src || src.startsWith('data:')) return '';
      const alt = ((node as any).getAttribute('alt') || '').replace(/[[\]]/g, '');
      return `![${alt}](${abs(src)})`;
    },
  });
  td.remove(['script', 'style', 'iframe', 'form', 'button', 'noscript'] as any);
  return td;
}

export function extractArticle(html: string, url: string): Article | null {
  const { document } = parseHTML(html);
  let parsed: ReturnType<Readability['parse']> = null;
  try {
    parsed = new Readability(document as any, { charThreshold: 300 }).parse();
  } catch {
    parsed = null;
  }
  if (!parsed?.content) return null;
  const markdown = makeTurndown(url)
    .turndown(parsed.content)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title: parsed.title?.trim() || undefined,
    byline: parsed.byline?.trim() || undefined,
    site: parsed.siteName?.trim() || undefined,
    published: (parsed as any).publishedTime?.slice(0, 10) || undefined,
    markdown,
    textLength: (parsed.textContent ?? '').trim().length,
    excerpt: parsed.excerpt?.trim() || undefined,
  };
}

export type RemoteKind = 'article' | 'link' | 'video' | 'pdf' | 'image' | 'audio';

export function kindFromUrl(url: string): RemoteKind | null {
  if (parseVideoUrl(url)) return 'video';
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (path.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpe?g|gif|webp|avif)$/.test(path)) return 'image';
  if (/\.(mp3|m4a|ogg|oga|wav|flac)$/.test(path)) return 'audio';
  return null;
}

export function kindFromContentType(ct: string): RemoteKind | null {
  if (ct.includes('application/pdf')) return 'pdf';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.includes('html') || ct.includes('xml')) return 'article';
  return null;
}

/** Fast preview for the capture sheet. Never throws. */
export async function previewUrl(url: string, timeoutMs = 2500): Promise<PageMeta & { url: string; kind: RemoteKind }> {
  const kind = kindFromUrl(url);
  const video = parseVideoUrl(url);
  if (video) {
    const o = await fetchOEmbed(video, url, timeoutMs);
    return {
      url,
      kind: 'video',
      title: o?.title,
      author: o?.author_name,
      site: o?.provider_name ?? (video.provider === 'youtube' ? 'YouTube' : 'Vimeo'),
      image: o?.thumbnail_url ?? (video.provider === 'youtube' ? `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg` : undefined),
    };
  }
  if (kind && kind !== 'article') return { url, kind, site: safeHost(url), title: decodeURIComponent(url.split('/').pop() || url) };
  try {
    const r = await fetchUrl(url, { timeoutMs, maxBytes: 3 * 1024 * 1024 });
    const ct = kindFromContentType(r.contentType);
    if (ct && ct !== 'article') return { url: r.url, kind: ct, site: safeHost(r.url) };
    const meta = extractMeta(decodeHtml(r.data, r.contentType), r.url);
    return { url: r.url, kind: 'link', ...meta };
  } catch {
    return { url, kind: 'link', site: safeHost(url) };
  }
}
