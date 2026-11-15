// Project body model: `## Material` with `###` sections of `- [[slug]]: context` lines,
// plus Notes / Questions / Checklist sections. Pure module, shared by server and web.
import { getSection, setSection, splitSections } from './format.ts';

export interface MaterialEntry {
  kind: 'item';
  target: string;
  alias?: string;
  context?: string;
}
export interface MaterialText {
  kind: 'text';
  raw: string;
}
export type MaterialLine = MaterialEntry | MaterialText;

export interface MaterialSection {
  name: string; // '' for entries before the first ### heading
  lines: MaterialLine[];
}

export interface ChecklistItem {
  done: boolean;
  text: string;
}

export interface ProjectModel {
  material: MaterialSection[];
  notes: string;
  questions: string[];
  checklist: ChecklistItem[];
}

const ENTRY_RE = /^\s*[-*+]\s+\[\[([^\[\]\n]+?)\]\]\s*(?::\s*(.*))?$/;

export function parseMaterial(text: string): MaterialSection[] {
  const sections: MaterialSection[] = [{ name: '', lines: [] }];
  for (const line of text.split('\n')) {
    const h = /^###\s+(.*)$/.exec(line);
    if (h) {
      sections.push({ name: h[1].trim(), lines: [] });
      continue;
    }
    const cur = sections[sections.length - 1];
    const m = ENTRY_RE.exec(line);
    if (m) {
      const inner = m[1];
      const pipe = inner.indexOf('|');
      const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
      const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : undefined;
      const context = m[2]?.trim() || undefined;
      cur.lines.push({ kind: 'item', target, alias, context });
    } else if (line.trim() !== '') {
      cur.lines.push({ kind: 'text', raw: line });
    }
  }
  if (sections[0].lines.length === 0) sections.shift();
  return sections;
}

export function serializeMaterial(sections: MaterialSection[]): string {
  const parts: string[] = [];
  for (const s of sections) {
    const lines = s.lines.map((l) =>
      l.kind === 'text' ? l.raw : `- [[${l.target}${l.alias ? '|' + l.alias : ''}]]${l.context ? ': ' + l.context : ''}`,
    );
    if (s.name) parts.push([`### ${s.name}`, ...lines].join('\n'));
    else if (lines.length) parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

export function parseList(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split('\n')
    .map((l) => /^\s*[-*+]\s+(?!\[[ xX]\]\s)(.*)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x);
}

export function parseChecklist(text: string | undefined): ChecklistItem[] {
  if (!text) return [];
  const out: ChecklistItem[] = [];
  for (const l of text.split('\n')) {
    const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(l);
    if (m) out.push({ done: m[1] !== ' ', text: m[2].trim() });
  }
  return out;
}

export function parseProject(body: string): ProjectModel {
  return {
    material: parseMaterial(getSection(body, 'Material') ?? ''),
    notes: getSection(body, 'Notes') ?? '',
    questions: parseList(getSection(body, 'Questions')),
    checklist: parseChecklist(getSection(body, 'Checklist')),
  };
}

const ORDER = ['Material', 'Notes', 'Questions', 'Checklist'];

function before(heading: string): string[] {
  return ORDER.slice(ORDER.indexOf(heading) + 1);
}

/** Write the material model back into the body, in place. */
export function writeMaterial(body: string, sections: MaterialSection[]): string {
  return setSection(body, 'Material', serializeMaterial(sections), { before: before('Material') });
}

export function writeQuestions(body: string, questions: string[]): string {
  const text = questions.map((q) => `- ${q}`).join('\n');
  return setSection(body, 'Questions', questions.length ? text : '', { before: before('Questions') });
}

export function writeChecklist(body: string, items: ChecklistItem[]): string {
  const text = items.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n');
  return setSection(body, 'Checklist', items.length ? text : '', { before: before('Checklist') });
}

export function writeNotes(body: string, notes: string): string {
  return setSection(body, 'Notes', notes, { before: before('Notes') });
}

// ---------------------------------------------------------------------------
// Material operations. All return new arrays (never mutate input).

function clone(sections: MaterialSection[]): MaterialSection[] {
  return sections.map((s) => ({ name: s.name, lines: s.lines.map((l) => ({ ...l })) }));
}

function sameTarget(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function findEntry(sections: MaterialSection[], target: string): { section: number; line: number } | null {
  for (let s = 0; s < sections.length; s++) {
    const i = sections[s].lines.findIndex((l) => l.kind === 'item' && sameTarget(l.target, target));
    if (i >= 0) return { section: s, line: i };
  }
  return null;
}

export function materialTargets(sections: MaterialSection[]): string[] {
  return sections.flatMap((s) => s.lines.filter((l): l is MaterialEntry => l.kind === 'item').map((l) => l.target));
}

export function addSection(sections: MaterialSection[], name: string): MaterialSection[] {
  const out = clone(sections);
  if (!out.some((s) => s.name.toLowerCase() === name.toLowerCase())) out.push({ name, lines: [] });
  return out;
}

export function renameSection(sections: MaterialSection[], from: string, to: string): MaterialSection[] {
  return clone(sections).map((s) => (s.name === from ? { ...s, name: to } : s));
}

/** Remove a section; its entries move to the unsectioned group at the top. */
export function removeSection(sections: MaterialSection[], name: string): MaterialSection[] {
  const out = clone(sections);
  const idx = out.findIndex((s) => s.name === name);
  if (idx < 0) return out;
  const [removed] = out.splice(idx, 1);
  const items = removed.lines.filter((l) => l.kind === 'item');
  if (items.length) {
    let top = out.find((s) => s.name === '');
    if (!top) {
      top = { name: '', lines: [] };
      out.unshift(top);
    }
    top.lines.push(...items);
  }
  return out;
}

export function moveSection(sections: MaterialSection[], name: string, toIndex: number): MaterialSection[] {
  const out = clone(sections);
  const idx = out.findIndex((s) => s.name === name);
  if (idx < 0) return out;
  const [s] = out.splice(idx, 1);
  out.splice(Math.max(0, Math.min(toIndex, out.length)), 0, s);
  return out;
}

/** Add an entry (or update its context if already present in that section). */
export function addEntry(
  sections: MaterialSection[],
  target: string,
  opts: { section?: string; context?: string; index?: number } = {},
): MaterialSection[] {
  let out = clone(sections);
  const existing = findEntry(out, target);
  if (existing) {
    const entry = out[existing.section].lines[existing.line] as MaterialEntry;
    if (opts.context !== undefined) entry.context = opts.context || undefined;
    if (opts.section !== undefined && out[existing.section].name !== opts.section) {
      return moveEntry(out, target, opts.section, opts.index ?? Number.MAX_SAFE_INTEGER);
    }
    return out;
  }
  const name = opts.section ?? '';
  let sec = out.find((s) => s.name === name);
  if (!sec) {
    out = name === '' ? [{ name: '', lines: [] }, ...out] : [...out, { name, lines: [] }];
    sec = out.find((s) => s.name === name)!;
  }
  const entry: MaterialEntry = { kind: 'item', target, context: opts.context || undefined };
  insertEntry(sec, entry, opts.index);
  return out;
}

function insertEntry(sec: MaterialSection, entry: MaterialEntry, index?: number) {
  // index counts only item lines
  const itemPositions = sec.lines.map((l, i) => (l.kind === 'item' ? i : -1)).filter((i) => i >= 0);
  if (index === undefined || index >= itemPositions.length) {
    const last = itemPositions.length ? itemPositions[itemPositions.length - 1] + 1 : sec.lines.length;
    sec.lines.splice(last, 0, entry);
  } else {
    sec.lines.splice(itemPositions[Math.max(0, index)], 0, entry);
  }
}

export function removeEntry(sections: MaterialSection[], target: string): MaterialSection[] {
  const out = clone(sections);
  const pos = findEntry(out, target);
  if (pos) out[pos.section].lines.splice(pos.line, 1);
  return out;
}

export function setEntryContext(sections: MaterialSection[], target: string, context: string): MaterialSection[] {
  const out = clone(sections);
  const pos = findEntry(out, target);
  if (pos) (out[pos.section].lines[pos.line] as MaterialEntry).context = context.trim() || undefined;
  return out;
}

/** Move an entry to `toSection` at item index `toIndex` (creating the section if needed). */
export function moveEntry(sections: MaterialSection[], target: string, toSection: string, toIndex: number): MaterialSection[] {
  let out = clone(sections);
  const pos = findEntry(out, target);
  if (!pos) return out;
  const [entry] = out[pos.section].lines.splice(pos.line, 1) as MaterialEntry[];
  let sec = out.find((s) => s.name === toSection);
  if (!sec) {
    out = toSection === '' ? [{ name: '', lines: [] }, ...out] : [...out, { name: toSection, lines: [] }];
    sec = out.find((s) => s.name === toSection)!;
  }
  insertEntry(sec, entry, toIndex);
  return out;
}

/** True when the body has a Material section at all (used to decide where to insert). */
export function hasMaterial(body: string): boolean {
  return splitSections(body).sections.some((s) => s.heading.toLowerCase() === 'material');
}
