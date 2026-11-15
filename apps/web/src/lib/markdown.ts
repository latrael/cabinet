import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { fileUrl } from './api.ts';

export type Resolver = (target: string) => { id: string; title: string } | null;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Render Cabinet Markdown (wikilinks, embeds, task lists) to sanitized HTML. */
export function renderMarkdown(md: string, resolve: Resolver): string {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    extensions: [
      {
        name: 'wikiembed',
        level: 'inline',
        start: (src: string) => src.indexOf('![['),
        tokenizer(src: string) {
          const m = /^!\[\[([^\]\n]+?)\]\]/.exec(src);
          if (m) return { type: 'wikiembed', raw: m[0], target: m[1].split('|')[0].trim() };
          return undefined;
        },
        renderer(token: any) {
          const t: string = token.target;
          if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(t)) return `<img src="${fileUrl(t)}" alt="" loading="lazy">`;
          if (/\.(mp3|m4a|ogg|oga|opus|wav|webm)$/i.test(t)) return `<audio controls src="${fileUrl(t)}"></audio>`;
          if (/\.pdf$/i.test(t)) return `<a href="${fileUrl(t)}" target="_blank" rel="noreferrer">${escapeHtml(t.split('/').pop()!)}</a>`;
          const r = resolve(t);
          return r ? `<a class="wikilink" data-id="${r.id}" href="/item/${r.id}">${escapeHtml(r.title)}</a>` : `<span class="wikilink unresolved">${escapeHtml(t)}</span>`;
        },
      },
      {
        name: 'wikilink',
        level: 'inline',
        start: (src: string) => src.indexOf('[['),
        tokenizer(src: string) {
          const m = /^\[\[([^\]\n]+?)\]\]/.exec(src);
          if (!m) return undefined;
          const [targetPart, alias] = m[1].split('|');
          const target = targetPart.split('#')[0].trim();
          return { type: 'wikilink', raw: m[0], target, alias: alias?.trim() };
        },
        renderer(token: any) {
          const r = resolve(token.target);
          const label = escapeHtml(token.alias ?? r?.title ?? token.target);
          return r
            ? `<a class="wikilink" data-id="${r.id}" href="/item/${r.id}">${label}</a>`
            : `<a class="wikilink unresolved" data-target="${escapeHtml(token.target)}" href="#" title="Not in your library yet">${label}</a>`;
        },
      },
    ],
  });
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-id', 'data-target', 'loading'], ADD_TAGS: ['audio'] });
}
