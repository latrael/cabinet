import { readFileSync } from 'node:fs';
import { getSection, setSection, type Author, type Item, type Library } from '@cabinet/core';
import type { JobRunner } from '../jobs.ts';
import { pdfMeta, pdfText, type Thumbs } from './media.ts';
import {
  decodeHtml,
  extractArticle,
  extractMeta,
  fetchOEmbed,
  fetchUrl,
  formatTimestamp,
  kindFromContentType,
  kindFromUrl,
  looksLikeUrl,
  normalizeUrl,
  parseVideoUrl,
  safeHost,
  videoTimestampUrl,
  type PageMeta,
} from './web.ts';

export interface CaptureContext {
  why?: string;
  tags?: string[];
  collections?: string[];
  projectId?: string;
  section?: string;
  context?: string; // per-project context
  links?: string[]; // ids to connect to
  status?: 'inbox' | 'library';
  via?: string; // captured_via
  title?: string;
}

export interface UrlCapture extends CaptureContext {
  url: string;
  preview?: PageMeta & { kind?: string };
}

export interface TextCapture extends CaptureContext {
  text: string;
  kind?: 'text' | 'quote' | 'note';
  author?: string; // quote attribution
  sourceUrl?: string;
}

export interface FileCapture extends CaptureContext {
  data: Uint8Array;
  filename: string;
  mime?: string;
}

export interface CaptureResult {
  item: Item;
  duplicate?: boolean;
}

export interface CaptureHooks {
  /** Called once background extraction finished (AI enrichment, embeddings). */
  afterExtract?: (itemId: string, author: Author) => void;
  /** Transcribe an audio attachment (absolute path) to text. */
  transcribe?: (absPath: string) => Promise<string>;
}

function firstWords(text: string, n = 8): string {
  const words = text.replace(/[>#*_`]/g, ' ').trim().split(/\s+/).slice(0, n).join(' ');
  return words.length < text.trim().length ? words.replace(/[,.;:!?]+$/, '') + '…' : words;
}

function placeholderTitle(url: string): string {
  try {
    const u = new URL(url);
    const tail = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    return tail ? `${tail} — ${u.hostname.replace(/^www\./, '')}` : u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export class CapturePipeline {
  lib: Library;
  jobs: JobRunner;
  thumbs: Thumbs;
  hooks: CaptureHooks;

  constructor(lib: Library, jobs: JobRunner, thumbs: Thumbs, hooks: CaptureHooks = {}) {
    this.lib = lib;
    this.jobs = jobs;
    this.thumbs = thumbs;
    this.hooks = hooks;
  }

  findByUrl(url: string): Item | null {
    const row = this.lib.index.db.prepare('SELECT id FROM items WHERE url = ? LIMIT 1').get(url) as { id: string } | undefined;
    return row ? this.lib.read(row.id) : null;
  }

  /** Post-create steps shared by all capture kinds: project, connections. */
  private finish(item: Item, ctx: CaptureContext, author: Author): Item {
    if (ctx.projectId) {
      try {
        this.lib.addToProject(ctx.projectId, item.id, { section: ctx.section, context: ctx.context }, author);
      } catch (e) {
        this.lib.emit('error-log', e);
      }
    }
    for (const target of ctx.links ?? []) {
      try {
        this.lib.linkItems(item.id, target, author);
      } catch (e) {
        this.lib.emit('error-log', e);
      }
    }
    return this.lib.read(item.id);
  }

  private status(ctx: CaptureContext): 'inbox' | 'library' {
    return ctx.status ?? (ctx.projectId ? 'library' : 'inbox');
  }

  /** Save a link instantly; extraction happens in the background. */
  captureUrl(input: UrlCapture, author: Author = 'you'): CaptureResult {
    const url = normalizeUrl(input.url);
    const existing = this.findByUrl(url);
    if (existing) {
      if (input.projectId) this.finish(existing, { projectId: input.projectId, section: input.section, context: input.context }, author);
      return { item: this.lib.read(existing.id), duplicate: true };
    }
    const video = parseVideoUrl(url);
    const guessed = (input.preview?.kind as string | undefined) ?? kindFromUrl(url) ?? 'link';
    const type = video ? 'video' : guessed === 'article' ? 'link' : guessed;
    const p = input.preview ?? {};
    let body = '';
    if (video?.start !== undefined) {
      body = `## Timestamps\n- [${formatTimestamp(video.start)}](${videoTimestampUrl(video, video.start)}) \n`;
    }
    const item = this.lib.create(
      {
        type: type as any,
        title: input.title?.trim() || p.title || placeholderTitle(url),
        why: input.why,
        tags: input.tags,
        collections: input.collections,
        status: this.status(input),
        captured_via: input.via ?? 'web',
        body,
        frontmatter: {
          source: { url, site: p.site ?? safeHost(url), author: p.author, published: p.published },
          cover: p.image,
          extraction: 'pending',
        },
      },
      author,
    );
    if (p.image) void this.thumbs.get(p.image, 480);
    this.jobs.add({ key: `extract:${item.id}`, label: `Fetching ${safeHost(url)}`, itemId: item.id, run: () => this.extract(item.id, author) });
    return { item: this.finish(item, input, author) };
  }

  /** Background: fetch the page/file and fill in content, metadata and covers. */
  async extract(id: string, author: Author = 'you'): Promise<void> {
    let item = this.lib.read(id);
    const url = (item.frontmatter.source as any)?.url as string | undefined;
    if (!url) return;
    const placeholder = placeholderTitle(url);
    const titleIsPlaceholder = item.title === placeholder || item.title === url;
    const fm: Record<string, unknown> = {};
    const source: Record<string, unknown> = { ...((item.frontmatter.source as object) ?? {}) };
    let content: string | undefined;
    let ok = false;
    try {
      const video = parseVideoUrl(url);
      if (video) {
        const o = await fetchOEmbed(video, url);
        if (o) {
          if (titleIsPlaceholder && o.title) fm.title = o.title;
          source.author ??= o.author_name;
          source.site = o.provider_name ?? source.site;
          if (!item.frontmatter.cover && o.thumbnail_url) fm.cover = o.thumbnail_url;
          ok = true;
        } else if (video.provider === 'youtube') {
          if (!item.frontmatter.cover) fm.cover = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
        }
        fm.type = 'video';
      } else {
        const r = await fetchUrl(url);
        if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
        const kind = kindFromContentType(r.contentType) ?? kindFromUrl(r.url) ?? 'link';
        if (kind === 'pdf') {
          const name = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'document.pdf');
          const rel = this.lib.saveAttachment(r.data, name.endsWith('.pdf') ? name : name + '.pdf', author);
          const [{ text }, meta] = await Promise.all([pdfText(r.data), pdfMeta(r.data)]);
          fm.type = 'pdf';
          fm.attachment = rel;
          if (titleIsPlaceholder && meta.title) fm.title = meta.title;
          source.author ??= meta.author;
          content = text;
          ok = !!text.trim();
          void this.thumbs.get(rel, 480);
        } else if (kind === 'image') {
          const name = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'image.jpg');
          const rel = this.lib.saveAttachment(r.data, name, author);
          fm.type = 'image';
          fm.attachment = rel;
          fm.cover = rel;
          ok = true;
          void this.thumbs.get(rel, 480);
        } else if (kind === 'audio') {
          const name = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'audio');
          const rel = this.lib.saveAttachment(r.data, name, author);
          fm.type = 'audio';
          fm.attachment = rel;
          ok = true;
        } else {
          const html = decodeHtml(r.data, r.contentType);
          const meta = extractMeta(html, r.url);
          const article = extractArticle(html, r.url);
          if (titleIsPlaceholder && (meta.title || article?.title)) fm.title = meta.title ?? article?.title;
          source.site = meta.site ?? article?.site ?? source.site;
          source.author ??= article?.byline ?? meta.author;
          source.published ??= meta.published ?? article?.published;
          if (!item.frontmatter.cover && meta.image) fm.cover = meta.image;
          if (article && article.textLength >= 500) {
            fm.type = 'article';
            content = article.markdown;
          } else {
            fm.type = 'link';
            content = meta.description ?? article?.excerpt;
          }
          ok = true;
        }
      }
    } catch (e) {
      this.lib.emit('error-log', e);
      ok = false;
    }
    // Re-read: the user may have edited notes while we were fetching.
    item = this.lib.read(id);
    let body = item.body;
    if (content?.trim() && !getSection(body, 'Content')) body = setSection(body, 'Content', content.trim(), { before: ['Timestamps'] });
    fm.source = Object.fromEntries(Object.entries(source).filter(([, v]) => v));
    fm.extraction = ok ? 'ok' : 'failed';
    if (item.frontmatter.extraction === 'manual') delete fm.extraction;
    this.lib.update(id, { frontmatter: fm as any, body }, author, `fetch “${(fm.title as string) ?? item.title}”`);
    if (typeof fm.cover === 'string') void this.thumbs.get(fm.cover, 480);
    if (ok) this.hooks.afterExtract?.(id, author);
  }

  /** Paste content by hand when extraction failed. */
  setManualContent(id: string, content: string, author: Author = 'you'): Item {
    const item = this.lib.read(id);
    const body = setSection(item.body, 'Content', content.trim(), { before: ['Timestamps'] });
    const updated = this.lib.update(id, { body, frontmatter: { extraction: 'manual' } }, author, `add content to “${item.title}”`);
    this.hooks.afterExtract?.(id, author);
    return updated;
  }

  refetch(id: string, author: Author = 'you') {
    this.lib.update(id, { frontmatter: { extraction: 'pending' } }, author);
    this.jobs.add({ key: `extract:${id}`, label: 'Fetching again', itemId: id, run: () => this.extract(id, author) });
  }

  captureText(input: TextCapture, author: Author = 'you'): CaptureResult {
    const text = input.text.trim();
    if (!text) throw new Error('Nothing to capture');
    if (looksLikeUrl(text) && input.kind !== 'quote' && input.kind !== 'note') return this.captureUrl({ ...input, url: text }, author);
    const kind = input.kind ?? 'text';
    let body: string;
    let title = input.title?.trim();
    if (kind === 'quote') {
      body = text
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n') + '\n';
      title ||= firstWords(text, 7);
    } else {
      body = text + '\n';
      const h1 = /^#\s+(.+)$/m.exec(text)?.[1];
      title ||= h1 ?? firstWords(text.split('\n')[0], 8);
    }
    const item = this.lib.create(
      {
        type: kind === 'note' ? 'note' : kind,
        title,
        body,
        why: input.why,
        tags: input.tags,
        collections: input.collections,
        status: this.status(input),
        captured_via: input.via ?? 'web',
        frontmatter: input.author || input.sourceUrl ? { source: { author: input.author, url: input.sourceUrl } } : undefined,
      },
      author,
    );
    const done = this.finish(item, input, author);
    this.hooks.afterExtract?.(item.id, author);
    return { item: done };
  }

  captureFile(input: FileCapture, author: Author = 'you'): CaptureResult {
    const mime = (input.mime ?? '').toLowerCase();
    const name = input.filename || 'file';
    const lower = name.toLowerCase();
    const isPdf = mime === 'application/pdf' || lower.endsWith('.pdf');
    const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|heic)$/.test(lower);
    const isAudio = mime.startsWith('audio/') || /\.(mp3|m4a|ogg|oga|opus|wav|flac|webm)$/.test(lower);
    const isText = mime.startsWith('text/') || /\.(md|txt|markdown)$/.test(lower);
    if (isText && !isPdf) {
      return this.captureText({ ...input, text: new TextDecoder().decode(input.data), title: input.title ?? name.replace(/\.[^.]+$/, '') }, author);
    }
    const rel = this.lib.saveAttachment(input.data, name, author);
    const stem = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Untitled';
    const type = isPdf ? 'pdf' : isImage ? 'image' : isAudio ? 'audio' : 'text';
    const body = isImage || isAudio ? `![[${rel}]]\n` : '';
    const item = this.lib.create(
      {
        type,
        title: input.title?.trim() || (isAudio ? `Voice note ${new Date().toISOString().slice(0, 16).replace('T', ' ')}` : stem),
        why: input.why,
        tags: input.tags,
        collections: input.collections,
        status: this.status(input),
        captured_via: input.via ?? 'web',
        body,
        frontmatter: {
          attachment: rel,
          cover: isImage ? rel : undefined,
          extraction: isPdf || isAudio ? 'pending' : undefined,
        },
      },
      author,
    );
    if (isImage || isPdf) void this.thumbs.get(rel, 480);
    if (isPdf) this.jobs.add({ key: `pdf:${item.id}`, label: 'Reading PDF', itemId: item.id, run: () => this.extractPdf(item.id, author) });
    else if (isAudio) this.jobs.add({ key: `transcribe:${item.id}`, label: 'Transcribing', itemId: item.id, run: () => this.transcribe(item.id, author) });
    else this.hooks.afterExtract?.(item.id, author);
    return { item: this.finish(item, input, author) };
  }

  async extractPdf(id: string, author: Author = 'you') {
    const item = this.lib.read(id);
    const rel = item.frontmatter.attachment as string;
    const data = readFileSync(this.lib.abs(rel));
    let content = '';
    let meta: { title?: string; author?: string } = {};
    try {
      [{ text: content }, meta] = await Promise.all([pdfText(data), pdfMeta(data)]);
    } catch (e) {
      this.lib.emit('error-log', e);
    }
    const cur = this.lib.read(id);
    const fm: Record<string, unknown> = { extraction: content.trim() ? 'ok' : 'failed' };
    if (meta.title && cur.title === item.title && meta.title.length > 3) fm.title = meta.title;
    if (meta.author) fm.source = { ...((cur.frontmatter.source as object) ?? {}), author: meta.author };
    const body = content.trim() ? setSection(cur.body, 'Content', content.trim()) : cur.body;
    this.lib.update(id, { frontmatter: fm as any, body }, author, `read PDF “${cur.title}”`);
    if (content.trim()) this.hooks.afterExtract?.(id, author);
  }

  async transcribe(id: string, author: Author = 'you') {
    const item = this.lib.read(id);
    const rel = item.frontmatter.attachment as string;
    if (!this.hooks.transcribe) {
      this.lib.update(id, { frontmatter: { extraction: 'failed' } }, author, 'transcription unavailable');
      return;
    }
    let text = '';
    try {
      text = await this.hooks.transcribe(this.lib.abs(rel));
    } catch (e) {
      this.lib.emit('error-log', e);
    }
    const cur = this.lib.read(id);
    const fm: Record<string, unknown> = { extraction: text.trim() ? 'ok' : 'failed' };
    if (text.trim() && cur.title.startsWith('Voice note')) fm.title = firstWords(text, 8);
    const body = text.trim() ? setSection(cur.body, 'Content', text.trim()) : cur.body;
    this.lib.update(id, { frontmatter: fm as any, body }, author, `transcribe “${cur.title}”`);
    if (text.trim()) this.hooks.afterExtract?.(id, author);
  }
}
