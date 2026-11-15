import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { extractText, getDocumentProxy, renderPageAsImage } from 'unpdf';
import { fetchUrl } from './web.ts';

export async function pdfText(data: Uint8Array): Promise<{ pages: number; text: string }> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const r = await extractText(pdf, { mergePages: false });
  const text = r.text
    .map((p) => p.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean)
    .join('\n\n');
  return { pages: r.totalPages, text };
}

export async function pdfMeta(data: Uint8Array): Promise<{ title?: string; author?: string }> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const meta: any = await pdf.getMetadata();
    return { title: meta?.info?.Title || undefined, author: meta?.info?.Author || undefined };
  } catch {
    return {};
  }
}

export async function pdfFirstPage(data: Uint8Array, width = 640): Promise<Uint8Array> {
  return renderPageAsImage(new Uint8Array(data), 1, { canvasImport: () => import('@napi-rs/canvas'), width });
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/**
 * Thumbnails for attachments and remote images, cached under `.cabinet/thumbs`.
 * Remote originals are cached under `.cabinet/cache/remote` so covers work offline.
 */
export class Thumbs {
  private root: string;
  private inflight = new Map<string, Promise<string | null>>();
  constructor(root: string) {
    this.root = root;
  }

  private thumbPath(src: string, width: number) {
    return join(this.root, '.cabinet', 'thumbs', `${sha1(src + '@' + width)}.webp`);
  }

  remoteCachePath(url: string) {
    return join(this.root, '.cabinet', 'cache', 'remote', sha1(url));
  }

  /** Returns a path to a webp thumbnail, generating it if needed. Null if unavailable. */
  get(src: string, width = 480): Promise<string | null> {
    const w = Math.max(64, Math.min(1600, Math.round(width / 80) * 80 || 480));
    const out = this.thumbPath(src, w);
    if (existsSync(out)) return Promise.resolve(out);
    const key = out;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.generate(src, w, out).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async original(src: string): Promise<Uint8Array | null> {
    if (/^https?:\/\//i.test(src)) {
      const cached = this.remoteCachePath(src);
      if (existsSync(cached)) return readFileSync(cached);
      try {
        const r = await fetchUrl(src, { timeoutMs: 8000, maxBytes: 15 * 1024 * 1024, accept: 'image/*' });
        if (r.status >= 400) return null;
        mkdirSync(join(this.root, '.cabinet', 'cache', 'remote'), { recursive: true });
        writeFileSync(cached, r.data);
        return r.data;
      } catch {
        return null;
      }
    }
    if (src.includes('..') || !src.startsWith('attachments/')) return null;
    const p = join(this.root, src);
    if (!existsSync(p)) return null;
    const data = readFileSync(p);
    if (src.toLowerCase().endsWith('.pdf')) {
      try {
        return await pdfFirstPage(data, 900);
      } catch {
        return null;
      }
    }
    return data;
  }

  private async generate(src: string, width: number, out: string): Promise<string | null> {
    const data = await this.original(src);
    if (!data) return null;
    try {
      const buf = await sharp(data, { animated: false }).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      mkdirSync(join(this.root, '.cabinet', 'thumbs'), { recursive: true });
      writeFileSync(out, buf);
      return out;
    } catch {
      return null;
    }
  }

  async imageSize(data: Uint8Array): Promise<{ width?: number; height?: number }> {
    try {
      const m = await sharp(data).metadata();
      return { width: m.width, height: m.height };
    } catch {
      return {};
    }
  }
}
