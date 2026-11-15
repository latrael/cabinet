import type { ItemType } from '@cabinet/core/types';
import {
  AudioLines,
  BookOpen,
  Brain,
  FileText,
  FolderKanban,
  Image as ImageIcon,
  Library as LibraryIcon,
  Link2,
  NotebookPen,
  Quote,
  ScrollText,
  Video,
  type LucideIcon,
} from 'lucide-react';

export const TYPE_LABEL: Record<ItemType, string> = {
  note: 'note',
  article: 'article',
  link: 'link',
  quote: 'quote',
  text: 'text',
  video: 'video',
  image: 'image',
  pdf: 'PDF',
  audio: 'audio',
  project: 'project',
  collection: 'collection',
  memory: 'memory',
};

export const TYPE_ICON: Record<ItemType, LucideIcon> = {
  note: NotebookPen,
  article: BookOpen,
  link: Link2,
  quote: Quote,
  text: ScrollText,
  video: Video,
  image: ImageIcon,
  pdf: FileText,
  audio: AudioLines,
  project: FolderKanban,
  collection: LibraryIcon,
  memory: Brain,
};

/**
 * Catalogue tab position, as a fraction of card width. Notes sit left, sources in the
 * middle band, projects right, memories at the far right — like staggered divider tabs.
 */
export function tabPosition(type: ItemType): string {
  switch (type) {
    case 'note':
      return '12px';
    case 'article':
    case 'link':
    case 'text':
      return 'calc(28% - 14px)';
    case 'quote':
    case 'video':
    case 'image':
    case 'pdf':
    case 'audio':
      return 'calc(50% - 30px)';
    case 'project':
    case 'collection':
      return 'calc(72% - 40px)';
    case 'memory':
      return 'calc(100% - 70px)';
    default:
      return '12px';
  }
}

export const SOURCE_FILTERS: ItemType[] = ['note', 'article', 'link', 'quote', 'text', 'video', 'image', 'pdf', 'audio', 'memory'];

export function relTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function longDate(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function host(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}
export const MOD = isMac() ? '⌘' : 'Ctrl';
