import YAML from 'yaml';
import type { Frontmatter } from './types.ts';

/** Canonical key order when writing frontmatter. Unknown keys follow in their original order. */
export const KEY_ORDER = [
  'id',
  'type',
  'title',
  'status',
  'created',
  'updated',
  'why',
  'tags',
  'collections',
  'aliases',
  'source',
  'captured_via',
  'attachment',
  'cover',
  'extraction',
  'kind',
  'project_status',
  'intent',
  'view',
  'agent',
  'memory',
] as const;

const FLOW_KEYS = new Set(['tags', 'collections', 'aliases']);

export interface ParsedFile {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

const FM_RE = /^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/;

/** Parse a markdown file into frontmatter + body. Tolerant: bad YAML yields empty frontmatter. */
export function parseMarkdown(text: string): ParsedFile {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = FM_RE.exec(src);
  if (!m) return { frontmatter: {}, body: src, hasFrontmatter: false };
  let fm: unknown;
  try {
    fm = YAML.parse(m[1]) ?? {};
  } catch {
    fm = {};
  }
  if (typeof fm !== 'object' || Array.isArray(fm) || fm === null) fm = {};
  let body = src.slice(m[0].length);
  if (body.startsWith('\n')) body = body.slice(1);
  return { frontmatter: fm as Record<string, unknown>, body, hasFrontmatter: true };
}

function clean(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((v) => v !== undefined && v !== null);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const c = clean(v);
      if (c !== undefined && c !== '') out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/** Order keys canonically, drop empty values. */
export function orderFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string) => {
    const v = clean(fm[k]);
    if (v === undefined) return;
    if (v === '' || (Array.isArray(v) && v.length === 0 && FLOW_KEYS.has(k))) return;
    out[k] = v;
  };
  for (const k of KEY_ORDER) put(k);
  for (const k of Object.keys(fm)) if (!(KEY_ORDER as readonly string[]).includes(k)) put(k);
  return out;
}

export function stringifyFrontmatter(fm: Record<string, unknown>): string {
  const ordered = orderFrontmatter(fm);
  const doc = new YAML.Document(ordered);
  for (const k of FLOW_KEYS) {
    const node = doc.get(k, true) as { flow?: boolean } | undefined;
    if (node && typeof node === 'object') node.flow = true;
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** Serialize frontmatter + body. Output always ends with a single newline. */
export function serializeMarkdown(fm: Frontmatter | Record<string, unknown>, body: string): string {
  const yaml = stringifyFrontmatter(fm as Record<string, unknown>);
  let b = body.replace(/\r\n?/g, '\n').replace(/^\n+/, '');
  if (b.length && !b.endsWith('\n')) b += '\n';
  b = b.replace(/\n{3,}$/, '\n');
  return `---\n${yaml}---\n${b.length ? '\n' + b : ''}`;
}

// ---------------------------------------------------------------------------
// Body sections. Level-2 headings split the body. Fenced code is skipped.

export interface Section {
  heading: string; // heading text without ##
  start: number; // offset of the heading line
  bodyStart: number; // offset just after the heading line
  end: number; // offset where the next level-2 heading (or EOF) starts
}

export function splitSections(body: string, level = 2): { preambleEnd: number; sections: Section[] } {
  const sections: Section[] = [];
  const prefix = '#'.repeat(level) + ' ';
  let inFence = false;
  let offset = 0;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith(prefix)) {
      if (sections.length) sections[sections.length - 1].end = offset;
      const next = offset + line.length + (i < lines.length - 1 ? 1 : 0);
      sections.push({ heading: line.slice(prefix.length).trim(), start: offset, bodyStart: next, end: body.length });
    }
    offset += line.length + 1;
  }
  return { preambleEnd: sections.length ? sections[0].start : body.length, sections };
}

export function findSection(body: string, heading: string): Section | undefined {
  const h = heading.toLowerCase();
  return splitSections(body).sections.find((s) => s.heading.toLowerCase() === h);
}

/** Text of a level-2 section without its heading, trimmed. */
export function getSection(body: string, heading: string): string | undefined {
  const s = findSection(body, heading);
  if (!s) return undefined;
  return body.slice(s.bodyStart, s.end).replace(/^\n+/, '').replace(/\s+$/, '');
}

/** The user notes area: everything before the first level-2 heading. */
export function getPreamble(body: string): string {
  return body.slice(0, splitSections(body).preambleEnd).replace(/\s+$/, '');
}

export function setPreamble(body: string, text: string): string {
  const { preambleEnd } = splitSections(body);
  const rest = body.slice(preambleEnd);
  const t = text.replace(/\s+$/, '');
  if (!rest) return t ? t + '\n' : '';
  return (t ? t + '\n\n' : '') + rest;
}

/**
 * Replace (or insert) a level-2 section. `after` lists headings the new section should follow
 * when it doesn't exist yet; otherwise it's appended. Passing `null` text removes the section.
 */
export function setSection(body: string, heading: string, text: string | null, opts: { before?: string[] } = {}): string {
  const s = findSection(body, heading);
  const content = text === null ? '' : `## ${heading}\n${text.replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
  if (s) {
    let after = body.slice(s.end);
    const head = body.slice(0, s.start);
    if (text === null) return (head.replace(/\s+$/, '') + (after ? '\n\n' + after : '\n')).replace(/^\n+/, '');
    if (after) after = '\n' + after;
    return head + content + after;
  }
  if (text === null) return body;
  // Insert before the first of opts.before that exists, else append.
  const { sections, preambleEnd } = splitSections(body);
  const beforeSet = new Set((opts.before ?? []).map((b) => b.toLowerCase()));
  const target = sections.find((x) => beforeSet.has(x.heading.toLowerCase()));
  if (target) {
    return body.slice(0, target.start) + content + '\n' + body.slice(target.start);
  }
  void preambleEnd;
  const trimmed = body.replace(/\s+$/, '');
  return (trimmed ? trimmed + '\n\n' : '') + content;
}

/** Split a source body into user notes and the extracted content. */
export function splitNotesAndContent(body: string): { notes: string; content: string } {
  const content = [getSection(body, 'Content'), getSection(body, 'Timestamps')].filter(Boolean).join('\n\n');
  const { sections, preambleEnd } = splitSections(body);
  const noteParts = [body.slice(0, preambleEnd)];
  for (const s of sections) {
    const h = s.heading.toLowerCase();
    if (h === 'content' || h === 'timestamps') continue;
    noteParts.push(body.slice(s.start, s.end));
  }
  return { notes: noteParts.join('').trim(), content };
}

/** Strip markdown syntax to plain-ish text for snippets and embeddings. */
export function toPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[\[([^\]]+)\]\]/g, ' ')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\]\]/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*+>]\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function excerpt(md: string, max = 220): string {
  const t = toPlainText(md);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
}
