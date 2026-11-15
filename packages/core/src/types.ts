// Shared types. This module is pure (no Node imports) so the web app can use it.

export const SOURCE_KINDS = ['article', 'link', 'quote', 'text', 'video', 'image', 'pdf', 'audio'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const ITEM_TYPES = ['note', ...SOURCE_KINDS, 'project', 'collection', 'memory'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const STATUSES = ['inbox', 'library', 'archived'] as const;
export type Status = (typeof STATUSES)[number];

export const PROJECT_STATUSES = ['active', 'paused', 'done'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_KINDS = ['hobby', 'learning', 'writing', 'build'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export type Extraction = 'ok' | 'failed' | 'manual' | 'pending';

export interface SourceInfo {
  url?: string;
  author?: string;
  site?: string;
  published?: string;
}

/** Frontmatter as stored on disk. Unknown keys are preserved untouched. */
export interface Frontmatter {
  id: string;
  type: ItemType;
  title: string;
  created: string;
  updated: string;
  status?: Status;
  why?: string;
  tags?: string[];
  collections?: string[];
  aliases?: string[];
  source?: SourceInfo;
  captured_via?: string;
  attachment?: string;
  cover?: string;
  extraction?: Extraction;
  // projects
  project_status?: ProjectStatus;
  kind?: ProjectKind;
  intent?: string;
  view?: 'cards' | 'list';
  // memories
  agent?: string;
  [key: string]: unknown;
}

/** Folder each type lives in. */
export function folderForType(type: ItemType): string {
  switch (type) {
    case 'note':
      return 'notes';
    case 'project':
      return 'projects';
    case 'collection':
      return 'collections';
    case 'memory':
      return 'memories';
    default:
      return 'sources';
  }
}

export function isSourceType(type: string): type is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(type);
}

/** A parsed item as served by the API. */
export interface Item {
  id: string;
  path: string; // relative to library root, posix separators
  slug: string;
  type: ItemType;
  title: string;
  status: Status;
  created: string;
  updated: string;
  why?: string;
  tags: string[];
  collections: string[];
  frontmatter: Frontmatter;
  body: string; // full markdown body (everything after frontmatter)
  hash: string; // sha1 of the file bytes, used as the base hash for saves
}

export interface ItemSummary {
  id: string;
  path: string;
  slug: string;
  type: ItemType;
  title: string;
  status: Status;
  created: string;
  updated: string;
  why?: string;
  tags: string[];
  collections: string[];
  url?: string;
  site?: string;
  cover?: string;
  attachment?: string;
  excerpt?: string;
  extraction?: Extraction;
  projectStatus?: ProjectStatus;
}

export type LinkKind = 'link' | 'embed' | 'material';

export interface LinkRef {
  sourceId: string;
  target: string; // raw target text inside [[ ]]
  targetId: string | null; // resolved id, null if unresolved
  kind: LinkKind;
  alias?: string;
  context?: string; // per-project context for material links
  section?: string; // project section for material links
}

export type MatchField = 'title' | 'note' | 'content' | 'tag' | 'pdf' | 'semantic';

export const MATCH_LABELS: Record<MatchField, string> = {
  title: 'title',
  note: 'note',
  content: 'content',
  tag: 'tag',
  pdf: 'PDF text',
  semantic: 'similar meaning',
};

export interface SearchHit {
  item: ItemSummary;
  score: number;
  field: MatchField;
  snippet: string; // contains «» around matched terms
}

export type Author = string; // 'you' | `agent:${string}` | 'telegram' | 'inbox-agent' | 'cli'

export interface LibraryEvent {
  kind: 'created' | 'updated' | 'deleted' | 'renamed' | 'rebuilt' | 'suggestions' | 'digest' | 'job';
  id?: string;
  path?: string;
  oldPath?: string;
  origin: 'app' | 'disk';
  author?: Author;
  data?: unknown;
}
