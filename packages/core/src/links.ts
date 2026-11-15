// Wikilink parsing, resolution keys and rewriting. Pure module.

export interface WikiLink {
  raw: string; // full match including brackets
  target: string; // target without heading/alias
  heading?: string;
  alias?: string;
  embed: boolean;
  start: number;
  end: number;
}

const LINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

/** Ranges of fenced code blocks and inline code spans, which are ignored for links. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /^(\s*)(```|~~~)[^\n]*\n[\s\S]*?(?:^\s*\2[^\n]*$|$(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  const inline = /`[^`\n]+`/g;
  while ((m = inline.exec(text))) {
    const s = m.index;
    if (!ranges.some(([a, b]) => s >= a && s < b)) ranges.push([s, s + m[0].length]);
  }
  return ranges;
}

export function extractLinks(text: string): WikiLink[] {
  const ranges = codeRanges(text);
  const out: WikiLink[] = [];
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) {
    const start = m.index;
    if (ranges.some(([a, b]) => start >= a && start < b)) continue;
    const inner = m[2];
    const pipe = inner.indexOf('|');
    const targetPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : undefined;
    const hash = targetPart.indexOf('#');
    const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    const heading = hash >= 0 ? targetPart.slice(hash + 1).trim() : undefined;
    if (!target) continue;
    out.push({ raw: m[0], target, heading, alias, embed: m[1] === '!', start, end: start + m[0].length });
  }
  return out;
}

/** Normalize a link target or item name into a lookup key. */
export function linkKey(s: string): string {
  let k = s.trim().replace(/\\/g, '/');
  if (k.toLowerCase().endsWith('.md')) k = k.slice(0, -3);
  const slash = k.lastIndexOf('/');
  if (slash >= 0) k = k.slice(slash + 1);
  return k.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

/** Normalized key for attachment embeds (keeps the extension, drops folders). */
export function attachmentKey(s: string): string {
  const k = s.trim().replace(/\\/g, '/');
  const slash = k.lastIndexOf('/');
  return (slash >= 0 ? k.slice(slash + 1) : k).toLowerCase();
}

export function isAttachmentTarget(target: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg|pdf|mp3|m4a|ogg|oga|wav|mp4|webm|mov)$/i.test(target);
}

/**
 * Rewrite links whose key is in `fromKeys` so they point at `toSlug`, keeping aliases and headings.
 * Returns the new text and the number of links changed.
 */
export function rewriteLinks(text: string, fromKeys: string[], toSlug: string): { text: string; count: number } {
  const keys = new Set(fromKeys.map(linkKey));
  const links = extractLinks(text).filter((l) => !l.embed && keys.has(linkKey(l.target)));
  if (!links.length) return { text, count: 0 };
  let out = '';
  let pos = 0;
  for (const l of links) {
    out += text.slice(pos, l.start);
    out += `[[${toSlug}${l.heading ? '#' + l.heading : ''}${l.alias ? '|' + l.alias : ''}]]`;
    pos = l.end;
  }
  out += text.slice(pos);
  return { text: out, count: links.length };
}

/** The `[[` query being typed at `pos`, if any (for autocomplete). */
export function openLinkQuery(text: string, pos: number): { from: number; query: string } | null {
  const before = text.slice(Math.max(0, pos - 200), pos);
  const idx = before.lastIndexOf('[[');
  if (idx < 0) return null;
  const q = before.slice(idx + 2);
  if (/[\]\n]/.test(q)) return null;
  return { from: pos - q.length, query: q };
}
