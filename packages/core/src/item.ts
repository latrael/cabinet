import { excerpt, findSection, getPreamble, parseMarkdown, splitNotesAndContent } from './format.ts';
import { sha1 } from './ids.ts';
import { attachmentKey, extractLinks, linkKey } from './links.ts';
import { parseMaterial } from './project.ts';
import {
  ITEM_TYPES,
  PROJECT_STATUSES,
  STATUSES,
  type Frontmatter,
  type Item,
  type ItemSummary,
  type ItemType,
  type LinkKind,
  type ProjectStatus,
  type Status,
} from './types.ts';

export interface IndexedLink {
  target: string;
  key: string;
  kind: LinkKind;
  alias?: string;
  context?: string;
  section?: string;
}

export interface IndexRecord {
  item: Item;
  summary: ItemSummary;
  notes: string; // user-written body (no Content/Timestamps)
  content: string; // extracted content
  links: IndexedLink[];
  keys: Array<{ key: string; priority: number }>;
}

const FOLDER_TYPES: Record<string, ItemType> = {
  notes: 'note',
  sources: 'link',
  projects: 'project',
  collections: 'collection',
  memories: 'memory',
};

export function inferType(relPath: string): ItemType {
  const top = relPath.split('/')[0];
  return FOLDER_TYPES[top] ?? 'note';
}

export function slugFromPath(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  return base.replace(/\.md$/i, '');
}

export function pseudoId(relPath: string): string {
  return 'p' + sha1(relPath).slice(0, 25).toUpperCase();
}

function asString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Date) return v.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const s = String(v).trim();
  return s || undefined;
}

function asStringArray(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((x) => String(x).trim().replace(/^#/, '')).filter(Boolean);
}

/** Build an Item from a file's text. Never throws: malformed files still get indexed. */
export function itemFromText(relPath: string, text: string, mtime?: number): Item {
  const { frontmatter, body } = parseMarkdown(text);
  const fm = frontmatter as Record<string, unknown>;
  const typeRaw = asString(fm.type);
  const type: ItemType = typeRaw && (ITEM_TYPES as readonly string[]).includes(typeRaw) ? (typeRaw as ItemType) : inferType(relPath);
  const slug = slugFromPath(relPath);
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = asString(fm.title) ?? h1 ?? slug.replace(/-/g, ' ');
  const statusRaw = asString(fm.status);
  const status: Status = statusRaw && (STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as Status) : 'library';
  const fallbackTime = mtime ? new Date(mtime).toISOString().replace(/\.\d{3}Z$/, 'Z') : '';
  const created = asString(fm.created) ?? fallbackTime;
  const updated = asString(fm.updated) ?? created;
  const id = asString(fm.id) ?? pseudoId(relPath);
  const tags = asStringArray(fm.tags);
  const collections = asStringArray(fm.collections);
  const normalized: Frontmatter = {
    ...(fm as object),
    id,
    type,
    title,
    created,
    updated,
  } as Frontmatter;
  if (tags.length) normalized.tags = tags;
  if (collections.length) normalized.collections = collections;
  return {
    id,
    path: relPath,
    slug,
    type,
    title,
    status,
    created,
    updated,
    why: asString(fm.why),
    tags,
    collections,
    frontmatter: normalized,
    body,
    hash: sha1(text),
  };
}

export function summarize(item: Item): ItemSummary {
  const fm = item.frontmatter;
  const source = (fm.source ?? {}) as Record<string, unknown>;
  const { notes, content } = splitNotesAndContent(item.body);
  const ps = asString(fm.project_status);
  return {
    id: item.id,
    path: item.path,
    slug: item.slug,
    type: item.type,
    title: item.title,
    status: item.status,
    created: item.created,
    updated: item.updated,
    why: item.why,
    tags: item.tags,
    collections: item.collections,
    url: asString(source.url),
    site: asString(source.site),
    cover: asString(fm.cover),
    attachment: asString(fm.attachment),
    excerpt: excerpt(item.type === 'project' ? asString(fm.intent) ?? getPreamble(item.body) : notes || content, 240) || undefined,
    extraction: asString(fm.extraction) as ItemSummary['extraction'],
    projectStatus: ps && (PROJECT_STATUSES as readonly string[]).includes(ps) ? (ps as ProjectStatus) : item.type === 'project' ? 'active' : undefined,
  };
}

export function buildRecord(relPath: string, text: string, mtime?: number): IndexRecord {
  const item = itemFromText(relPath, text, mtime);
  const summary = summarize(item);
  const { notes, content } = splitNotesAndContent(item.body);

  // Links: body + why. Material entries carry their section and per-project context.
  const links: IndexedLink[] = [];
  const material = item.type === 'project' ? findSection(item.body, 'Material') : undefined;
  const materialInfo = new Map<string, { section: string; context?: string }>();
  if (material) {
    for (const sec of parseMaterial(item.body.slice(material.bodyStart, material.end))) {
      for (const l of sec.lines) if (l.kind === 'item') materialInfo.set(linkKey(l.target), { section: sec.name, context: l.context });
    }
  }
  for (const l of extractLinks(item.body)) {
    const key = l.embed ? attachmentKey(l.target) : linkKey(l.target);
    const inMaterial = material && l.start >= material.bodyStart && l.start < material.end;
    const info = inMaterial ? materialInfo.get(key) : undefined;
    links.push({
      target: l.target,
      key,
      kind: info ? 'material' : l.embed ? 'embed' : 'link',
      alias: l.alias,
      context: info?.context,
      section: info ? info.section : undefined,
    });
  }
  if (item.why) {
    for (const l of extractLinks(item.why)) links.push({ target: l.target, key: linkKey(l.target), kind: 'link', alias: l.alias });
  }

  const keys: Array<{ key: string; priority: number }> = [
    { key: linkKey(item.slug), priority: 0 },
    { key: item.id.toLowerCase(), priority: 1 },
    { key: linkKey(item.title), priority: 2 },
  ];
  for (const a of asStringArray(item.frontmatter.aliases)) keys.push({ key: linkKey(a), priority: 3 });
  if (summary.attachment) keys.push({ key: attachmentKey(summary.attachment), priority: 4 });
  const seen = new Set<string>();
  const uniqueKeys = keys.filter((k) => (seen.has(k.key) ? false : (seen.add(k.key), true)));

  return { item, summary, notes, content, links, keys: uniqueKeys };
}
