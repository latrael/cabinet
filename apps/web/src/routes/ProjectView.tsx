import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, ClipboardPaste, GripVertical, ImageIcon, LayoutGrid, List, PanelRightOpen, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { linkKey } from '@cabinet/core/links';
import {
  addEntry,
  addSection,
  moveEntry,
  parseProject,
  removeEntry,
  removeSection,
  renameSection,
  setEntryContext,
  writeChecklist,
  writeMaterial,
  writeNotes,
  writeQuestions,
  type MaterialEntry,
} from '@cabinet/core/project';
import { PROJECT_KINDS, PROJECT_STATUSES } from '@cabinet/core/types';
import { api, thumbUrl, type ItemSummary } from '../lib/api.ts';
import { host, MOD, TYPE_ICON, TYPE_LABEL } from '../lib/meta.ts';
import { openCapture, setUi, toast } from '../lib/store.ts';
import type { useItem } from '../lib/useItem.ts';
import { Editor } from '../editor/Editor.tsx';
import { ItemMenu } from './ItemPage.tsx';

type It = ReturnType<typeof useItem>;

const UNSORTED = '';
const entryId = (section: string, target: string) => `e::${section}::${target}`;
const parseEntryId = (id: string) => {
  const [, section, ...rest] = id.split('::');
  return { section, target: rest.join('::') };
};

export function ProjectView({ it }: { it: It }) {
  const detail = it.data!;
  const { item } = detail;
  const fm = item.frontmatter as any;
  const model = useMemo(() => parseProject(item.body), [item.body]);
  const [panel, setPanel] = useState(false);
  const [gather, setGather] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const view: 'cards' | 'list' = fm.view === 'list' ? 'list' : 'cards';

  // Pastes and drops while this project is open go straight into it.
  useEffect(() => {
    setUi({ activeProject: { id: item.id, title: item.title, sections: model.material.map((s) => s.name).filter(Boolean) } });
    return () => setUi({ activeProject: null });
  }, [item.id, item.title, model.material]);

  const byKey = useMemo(() => {
    const m = new Map<string, ItemSummary>();
    for (const o of detail.outgoing) if (o.item) m.set(linkKey(o.target), o.item);
    return m;
  }, [detail.outgoing]);

  /** Apply a body transformation; re-applied on top of external edits if needed. */
  const op = (fn: (body: string) => string) => it.mutate((cur) => ({ body: fn(cur.body) }));
  const mat = (fn: (m: ReturnType<typeof parseProject>['material']) => ReturnType<typeof parseProject>['material']) =>
    op((body) => writeMaterial(body, fn(parseProject(body).material)));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const sections = model.material.length ? model.material : [];
  const hasUnsorted = sections.some((s) => s.name === UNSORTED);

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const a = String(active.id);
    const o = String(over.id);
    let toSection: string;
    let toIndex: number;
    if (o.startsWith('e::')) {
      const t = parseEntryId(o);
      toSection = t.section;
      const sec = sections.find((s) => s.name === t.section);
      toIndex = sec ? sec.lines.filter((l) => l.kind === 'item').findIndex((l) => (l as MaterialEntry).target === t.target) : 0;
    } else if (o.startsWith('s::')) {
      toSection = o.slice(3);
      toIndex = Number.MAX_SAFE_INTEGER;
    } else return;
    if (a.startsWith('lib::')) {
      const slug = active.data.current?.slug as string;
      void mat((m) => addEntry(m, slug, { section: toSection, index: toIndex }));
      toast(`Added to ${toSection || 'the project'}`, { tone: 'ok' });
      return;
    }
    if (a.startsWith('e::')) {
      const from = parseEntryId(a);
      if (a === o) return;
      void mat((m) => moveEntry(m, from.target, toSection, toIndex));
    }
  };
  const onDragStart = (e: DragStartEvent) => setDragging(String(e.active.id));
  const draggingItem = dragging ? (dragging.startsWith('lib::') ? null : byKey.get(linkKey(parseEntryId(dragging).target))) : null;

  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <ProjectHeader it={it} onPickCover={() => undefined} />
        <div className="mt-6 mb-3 flex flex-wrap items-center gap-2">
          <h2 className="section-title mr-2">Material</h2>
          <button className="btn btn-sm" onClick={() => setGather(true)} data-testid="gather">
            <Search size={13} /> Gather
          </button>
          <button className="btn btn-sm" onClick={() => openCapture({})}>
            <ClipboardPaste size={13} /> Save new into project
          </button>
          <NewSection onAdd={(name) => void mat((m) => addSection(m, name))} />
          <div className="ml-auto flex items-center gap-1">
            <button className={`btn btn-sm btn-quiet ${view === 'cards' ? '!bg-paper-deep' : ''}`} onClick={() => void it.mutate(() => ({ frontmatter: { view: 'cards' } }))} aria-label="Cards" aria-pressed={view === 'cards'}>
              <LayoutGrid size={14} />
            </button>
            <button className={`btn btn-sm btn-quiet ${view === 'list' ? '!bg-paper-deep' : ''}`} onClick={() => void it.mutate(() => ({ frontmatter: { view: 'list' } }))} aria-label="List" aria-pressed={view === 'list'}>
              <List size={14} />
            </button>
            <button className={`btn btn-sm btn-quiet ${panel ? '!bg-paper-deep' : ''}`} onClick={() => setPanel(!panel)} aria-label="Show library panel" aria-pressed={panel} data-testid="toggle-library-panel">
              <PanelRightOpen size={14} />
            </button>
          </div>
        </div>
        <p className="mb-5 text-[12.5px] text-faded">
          Paste a link or drop a file anywhere on this page to save it here. Drag cards to reorder or move them between sections. <span className="kbd">{MOD} V</span>
        </p>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className={panel ? 'grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]' : ''}>
            <div className="flex flex-col gap-7">
              {sections.length === 0 && (
                <div className="rounded-[3px] border border-dashed border-rule-strong px-6 py-8 text-center text-[14.5px] text-faded">
                  Nothing here yet. Paste a link, use Gather to pick things you already saved, or open the library panel and drag cards in.
                </div>
              )}
              {!hasUnsorted && sections.length > 0 && dragging?.startsWith('lib::') && <SectionBlock name={UNSORTED} entries={[]} byKey={byKey} view={view} mat={mat} />}
              {sections.map((s) => (
                <SectionBlock key={s.name || '__unsorted'} name={s.name} entries={s.lines.filter((l): l is MaterialEntry => l.kind === 'item')} byKey={byKey} view={view} mat={mat} />
              ))}
            </div>
            {panel && <LibraryPanel exclude={new Set([...byKey.values()].map((i) => i.id).concat(item.id))} />}
          </div>
          <DragOverlay>{draggingItem ? <div className="card rotate-1 px-3 py-2 font-serif text-[14px] shadow-[var(--shadow-lift)]">{draggingItem.title}</div> : null}</DragOverlay>
        </DndContext>
      </div>

      <aside className="flex min-w-0 flex-col gap-7">
        <Checklist it={it} items={model.checklist} />
        <Questions it={it} items={model.questions} />
        <ProjectNotes it={it} notes={model.notes} />
      </aside>
      <GatherDialog open={gather} onOpenChange={setGather} sections={sections.map((s) => s.name).filter(Boolean)} exclude={new Set([...byKey.values()].map((i) => i.id).concat(item.id))} onAdd={(slugs, section) => mat((m) => slugs.reduce((acc, slug) => addEntry(acc, slug, { section }), m))} />
    </div>
  );
}

// ------------------------------------------------------------------ header

function ProjectHeader({ it }: { it: It; onPickCover: () => void }) {
  const item = it.data!.item;
  const fm = item.frontmatter as any;
  const [title, setTitle] = useState(item.title);
  const [intent, setIntent] = useState(fm.intent ?? '');
  useEffect(() => setTitle(item.title), [item.title]);
  useEffect(() => setIntent(fm.intent ?? ''), [fm.intent]);
  const images = it.data!.outgoing.map((o) => o.item).filter((i): i is ItemSummary => !!i && !!(i.cover || (i.type === 'image' && i.attachment)));
  return (
    <header className="flex flex-col gap-5 md:flex-row">
      <CoverPicker cover={fm.cover} images={images} onPick={(cover) => void it.mutate(() => ({ frontmatter: { cover } }))} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12.5px] font-semibold text-brass">Project</span>
          <select className="bg-transparent text-[12.5px] text-faded focus:outline-none" value={fm.kind ?? ''} onChange={(e) => void it.mutate(() => ({ frontmatter: { kind: e.target.value || null } }))} aria-label="Kind">
            <option value="">no kind</option>
            {PROJECT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex rounded-[3px] border border-rule-strong bg-card text-[12.5px]" role="radiogroup" aria-label="Status">
              {PROJECT_STATUSES.map((s) => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={(fm.project_status ?? 'active') === s}
                  className={`px-2.5 py-1 ${(fm.project_status ?? 'active') === s ? 'bg-lamp text-[#f6f1e4]' : 'text-ink-soft hover:bg-paper'}`}
                  onClick={() => void it.mutate(() => ({ frontmatter: { project_status: s } }))}
                >
                  {s}
                </button>
              ))}
            </div>
            <ItemMenu item={item} />
          </div>
        </div>
        <input
          className="w-full bg-transparent font-serif text-[34px] leading-tight font-[560] focus:outline-none"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== item.title && void it.mutate(() => ({ frontmatter: { title: title.trim() } }))}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          aria-label="Project title"
          data-testid="item-title"
        />
        <textarea
          className="mt-1 w-full resize-none bg-transparent font-serif text-[16.5px] leading-relaxed text-ink-soft italic placeholder:text-faded focus:outline-none"
          rows={2}
          value={intent}
          placeholder="What is this project for?"
          onChange={(e) => setIntent(e.target.value)}
          onBlur={() => intent !== (fm.intent ?? '') && void it.mutate(() => ({ frontmatter: { intent: intent.trim() || null } }))}
          aria-label="Intent"
        />
      </div>
    </header>
  );
}

function CoverPicker({ cover, images, onPick }: { cover?: string; images: ItemSummary[]; onPick: (c: string | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button className="group flex h-36 w-full items-center justify-center overflow-hidden rounded-[3px] bg-paper-deep shadow-[var(--shadow-card)] md:w-48" onClick={() => setOpen(!open)} aria-label="Change cover">
        {cover ? <img src={thumbUrl(cover, 480)} alt="" className="h-full w-full object-cover" /> : <ImageIcon size={22} className="text-faded" />}
        <span className="absolute right-1.5 bottom-1.5 rounded-sm bg-card/90 px-1.5 py-0.5 text-[11px] text-ink-soft opacity-0 group-hover:opacity-100">Pin a cover</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 z-20 mt-1 w-72 rounded-[3px] border border-rule-strong bg-card p-2 shadow-[var(--shadow-lift)]">
          {images.length === 0 && <p className="p-2 text-[13px] text-faded">Add an image to the material to use it as a cover.</p>}
          <div className="grid grid-cols-3 gap-1.5">
            {images.map((i) => {
              const src = i.cover ?? i.attachment!;
              return (
                <button key={i.id} onClick={() => (onPick(src), setOpen(false))} className={`aspect-square overflow-hidden rounded-[2px] ${src === cover ? 'ring-2 ring-brass' : ''}`} aria-label={`Use ${i.title}`}>
                  <img src={thumbUrl(src, 160)} alt="" className="h-full w-full object-cover" />
                </button>
              );
            })}
          </div>
          {cover && (
            <button className="btn btn-sm btn-quiet mt-2" onClick={() => (onPick(null), setOpen(false))}>
              Remove cover
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NewSection({ onAdd }: { onAdd: (name: string) => void }) {
  const [v, setV] = useState('');
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button className="btn btn-sm btn-quiet" onClick={() => setOpen(true)}>
        <Plus size={13} /> Section
      </button>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onAdd(v.trim());
        setV('');
        setOpen(false);
      }}
    >
      <input className="field !h-[26px] !w-44 !py-0 text-[13px]" autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={() => !v && setOpen(false)} placeholder="Section name" aria-label="New section name" />
    </form>
  );
}

// ------------------------------------------------------------------ sections and entries

type Mat = (fn: (m: ReturnType<typeof parseProject>['material']) => ReturnType<typeof parseProject>['material']) => Promise<unknown>;

function SectionBlock({ name, entries, byKey, view, mat }: { name: string; entries: MaterialEntry[]; byKey: Map<string, ItemSummary>; view: 'cards' | 'list'; mat: Mat }) {
  const { setNodeRef, isOver } = useDroppable({ id: `s::${name}` });
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(name);
  return (
    <section ref={setNodeRef} className={`rounded-[4px] transition-colors ${isOver ? 'bg-lamp-wash/50 outline-2 outline-lamp/30 outline-dashed' : ''}`} data-section={name || 'unsorted'}>
      <div className="group mb-2 flex items-center gap-2 border-b border-rule pb-1">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (v.trim() && v.trim() !== name) void mat((m) => renameSection(m, name, v.trim()));
              setEditing(false);
            }}
          >
            <input className="field !h-7 !w-56 !py-0 font-serif text-[16px]" autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={() => setEditing(false)} aria-label="Section name" />
          </form>
        ) : (
          <h3 className="font-serif text-[17px] text-ink">{name || 'Unsorted'}</h3>
        )}
        <span className="text-[12px] text-faded">{entries.length}</span>
        {name && !editing && (
          <span className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <button className="btn btn-sm btn-quiet" onClick={() => (setV(name), setEditing(true))} aria-label={`Rename ${name}`}>
              <Pencil size={12} />
            </button>
            <button className="btn btn-sm btn-quiet" onClick={() => void mat((m) => removeSection(m, name))} aria-label={`Remove section ${name}`} title="Remove section (its items move to Unsorted)">
              <Trash2 size={12} />
            </button>
          </span>
        )}
      </div>
      <SortableContext items={entries.map((e) => entryId(name, e.target))} strategy={view === 'cards' ? rectSortingStrategy : verticalListSortingStrategy}>
        <div className={view === 'cards' ? 'grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] items-start gap-x-4 gap-y-5 pt-2' : 'flex flex-col'}>
          {entries.map((e) => (
            <Entry key={e.target} section={name} entry={e} item={byKey.get(linkKey(e.target))} view={view} mat={mat} />
          ))}
          {entries.length === 0 && <div className="py-3 text-[13px] text-faded">Drop items here.</div>}
        </div>
      </SortableContext>
    </section>
  );
}

function Entry({ section, entry, item, view, mat }: { section: string; entry: MaterialEntry; item?: ItemSummary; view: 'cards' | 'list'; mat: Mat }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entryId(section, entry.target) });
  const [editing, setEditing] = useState(false);
  const [ctx, setCtx] = useState(entry.context ?? '');
  useEffect(() => setCtx(entry.context ?? ''), [entry.context]);
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const Icon = item ? TYPE_ICON[item.type] : X;
  const cover = item && (item.cover ?? (item.type === 'image' ? item.attachment : item.type === 'pdf' ? item.attachment : undefined));
  const saveCtx = () => {
    setEditing(false);
    if (ctx.trim() !== (entry.context ?? '')) void mat((m) => setEntryContext(m, entry.target, ctx));
  };
  const contextEl = editing ? (
    <textarea
      className="field mt-1 min-h-[52px] text-[13px]"
      autoFocus
      value={ctx}
      onChange={(e) => setCtx(e.target.value)}
      onBlur={saveCtx}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          saveCtx();
        }
        if (e.key === 'Escape') setEditing(false);
      }}
      placeholder="Why it matters to this project"
      aria-label="Project context"
    />
  ) : (
    <button className={`mt-1 block w-full text-left text-[13px] leading-snug ${entry.context ? 'font-serif text-ink-soft italic' : 'text-faded/80 hover:text-faded'}`} onClick={() => setEditing(true)} data-testid="entry-context">
      {entry.context || 'Add project context'}
    </button>
  );
  if (view === 'list')
    return (
      <div ref={setNodeRef} style={style} className="group flex items-start gap-2 border-b border-rule py-2" data-entry={entry.target}>
        <button className="mt-1 cursor-grab text-faded/60 hover:text-faded" {...attributes} {...listeners} aria-label={`Drag ${item?.title ?? entry.target}`}>
          <GripVertical size={14} />
        </button>
        <Icon size={14} className="mt-1 shrink-0 text-faded" />
        <div className="min-w-0 flex-1">
          {item ? (
            <Link to="/item/$id" params={{ id: item.id }} className="font-serif text-[15.5px] hover:text-lamp">
              {item.title}
            </Link>
          ) : (
            <span className="font-serif text-[15.5px] text-faded">{entry.target} (missing)</span>
          )}
          {contextEl}
        </div>
        <button className="btn btn-sm btn-quiet opacity-0 group-hover:opacity-100" onClick={() => void mat((m) => removeEntry(m, entry.target))} aria-label={`Remove ${item?.title ?? entry.target} from project`}>
          <X size={13} />
        </button>
      </div>
    );
  return (
    <div ref={setNodeRef} style={style} className="card group flex flex-col" data-entry={entry.target}>
      <div className="flex items-center gap-1 px-2 pt-1.5">
        <button className="cursor-grab text-faded/50 hover:text-faded" {...attributes} {...listeners} aria-label={`Drag ${item?.title ?? entry.target}`}>
          <GripVertical size={14} />
        </button>
        <span className="text-[11px] text-faded">{item ? TYPE_LABEL[item.type] : 'missing'}</span>
        <button className="ml-auto text-faded opacity-0 group-hover:opacity-100 hover:text-ink" onClick={() => void mat((m) => removeEntry(m, entry.target))} aria-label={`Remove ${item?.title ?? entry.target} from project`}>
          <X size={13} />
        </button>
      </div>
      {item ? (
        <Link to="/item/$id" params={{ id: item.id }} className="block px-3 pt-1">
          {cover && <img src={thumbUrl(cover, 360)} alt="" className="mb-2 aspect-[4/3] w-full rounded-[2px] object-cover" loading="lazy" />}
          <div className="font-serif text-[15px] leading-snug hover:text-lamp">{item.title}</div>
          <div className="text-[11.5px] text-faded">{item.site ?? host(item.url) ?? ''}</div>
        </Link>
      ) : (
        <div className="px-3 pt-1 font-serif text-[15px] text-faded">{entry.target}</div>
      )}
      <div className="px-3 pt-0.5 pb-2.5">{contextEl}</div>
    </div>
  );
}

// ------------------------------------------------------------------ library side panel (drag source)

function LibraryPanel({ exclude }: { exclude: Set<string> }) {
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['panel', q],
    queryFn: () => (q.trim() ? api<{ items: ItemSummary[] }>(`/api/suggest?q=${encodeURIComponent(q)}&limit=20`) : api<{ items: ItemSummary[] }>('/api/items?exclude=project,collection&limit=30&sort=created')),
    placeholderData: (p) => p,
  });
  return (
    <aside className="rounded-[4px] border border-rule bg-paper-deep/50 p-3 lg:sticky lg:top-4 lg:max-h-[80vh] lg:self-start lg:overflow-y-auto" data-testid="library-panel">
      <div className="mb-2 text-[13px] font-semibold text-ink-soft">Inbox and library</div>
      <input className="field mb-2 text-[13px]" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter library" />
      <div className="flex flex-col gap-1.5">
        {(list.data?.items ?? [])
          .filter((i) => !exclude.has(i.id))
          .map((i) => (
            <PanelItem key={i.id} item={i} />
          ))}
      </div>
    </aside>
  );
}

function PanelItem({ item }: { item: ItemSummary }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `lib::${item.id}`, data: { slug: item.slug } });
  const Icon = TYPE_ICON[item.type];
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={`flex cursor-grab items-center gap-2 rounded-[3px] bg-card px-2 py-1.5 text-[13.5px] shadow-[var(--shadow-card)] ${isDragging ? 'opacity-40' : ''}`} data-panel-item={item.slug}>
      <Icon size={13} className="shrink-0 text-faded" />
      <span className="truncate font-serif">{item.title}</span>
      {item.status === 'inbox' && <span className="ml-auto text-[10.5px] text-lamp">inbox</span>}
    </div>
  );
}

// ------------------------------------------------------------------ gather dialog

function GatherDialog({ open, onOpenChange, sections, exclude, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; sections: string[]; exclude: Set<string>; onAdd: (slugs: string[], section?: string) => Promise<unknown> }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<ItemSummary[]>([]);
  const [section, setSection] = useState('');
  const results = useQuery({
    queryKey: ['gather', q],
    enabled: open,
    queryFn: () => (q.trim() ? api<{ items: ItemSummary[] }>(`/api/suggest?q=${encodeURIComponent(q)}&limit=20`) : api<{ items: ItemSummary[] }>('/api/items?exclude=project,collection&limit=20&sort=updated')),
    placeholderData: (p) => p,
  });
  useEffect(() => {
    if (!open) {
      setQ('');
      setPicked([]);
      setSection('');
    }
  }, [open]);
  const toggle = (i: ItemSummary) => setPicked((p) => (p.some((x) => x.id === i.id) ? p.filter((x) => x.id !== i.id) : [...p, i]));
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgba(43,40,35,0.28)]" />
        <Dialog.Content aria-describedby={undefined} className="fixed top-[8vh] left-1/2 z-50 flex max-h-[84vh] w-[min(600px,94vw)] -translate-x-1/2 flex-col rounded-[4px] border border-rule-strong bg-paper shadow-[var(--shadow-sheet)]" data-testid="gather-dialog">
          <div className="border-b border-rule px-5 py-3">
            <Dialog.Title className="font-serif text-[19px]">Gather material</Dialog.Title>
            <p className="text-[13px] text-faded">Pick things you already saved. They stay where they are; the project just points to them.</p>
          </div>
          <div className="px-5 pt-3">
            <input className="field" autoFocus placeholder="Search your cabinet" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search to gather" />
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {(results.data?.items ?? [])
              .filter((i) => !exclude.has(i.id) && i.type !== 'project')
              .map((i) => {
                const on = picked.some((x) => x.id === i.id);
                const Icon = TYPE_ICON[i.type];
                return (
                  <li key={i.id}>
                    <button className="flex w-full items-center gap-2.5 rounded-[3px] px-2 py-1.5 text-left hover:bg-card" onClick={() => toggle(i)} aria-pressed={on}>
                      <span className={`flex h-4 w-4 items-center justify-center rounded-[2px] border ${on ? 'border-lamp bg-lamp text-card' : 'border-rule-strong'}`}>{on && <Check size={11} strokeWidth={3} />}</span>
                      <Icon size={13} className="text-faded" />
                      <span className="truncate font-serif text-[15px]">{i.title}</span>
                      <span className="ml-auto text-[11.5px] text-faded">{TYPE_LABEL[i.type]}</span>
                    </button>
                  </li>
                );
              })}
          </ul>
          <div className="flex items-center gap-2 border-t border-rule px-5 py-3">
            <input className="field !w-48 text-[13.5px]" list="gather-sections" placeholder="Into section (optional)" value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section" />
            <datalist id="gather-sections">{sections.map((s) => <option key={s} value={s} />)}</datalist>
            <button
              className="btn btn-primary ml-auto"
              disabled={!picked.length}
              onClick={async () => {
                await onAdd(
                  picked.map((p) => p.slug),
                  section.trim() || undefined,
                );
                toast(`Gathered ${picked.length} ${picked.length === 1 ? 'item' : 'items'}`, { tone: 'ok' });
                onOpenChange(false);
              }}
            >
              Add {picked.length || ''} to project
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ------------------------------------------------------------------ checklist, questions, notes

function Checklist({ it, items }: { it: It; items: Array<{ done: boolean; text: string }> }) {
  const [v, setV] = useState('');
  const save = (next: Array<{ done: boolean; text: string }>) => it.mutate((cur) => ({ body: writeChecklist(cur.body, next) }));
  const done = items.filter((i) => i.done).length;
  return (
    <section data-testid="checklist">
      <h2 className="section-title mb-2 flex items-baseline gap-2">
        Checklist {items.length > 0 && <span className="font-sans text-[12.5px] font-normal text-faded">{done} of {items.length}</span>}
      </h2>
      <ul className="flex flex-col">
        {items.map((c, i) => (
          <li key={i} className="group flex items-start gap-2 py-1">
            <input type="checkbox" className="mt-1 accent-lamp" checked={c.done} onChange={() => void save(items.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))} aria-label={c.text} />
            <span className={`flex-1 font-serif text-[15px] ${c.done ? 'text-faded line-through' : ''}`}>{c.text}</span>
            <button className="text-faded opacity-0 group-hover:opacity-100" onClick={() => void save(items.filter((_, j) => j !== i))} aria-label={`Remove ${c.text}`}>
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) void save([...items, { done: false, text: v.trim() }]);
          setV('');
        }}
      >
        <input className="field mt-1 text-[13.5px]" placeholder="Add a step" value={v} onChange={(e) => setV(e.target.value)} aria-label="New checklist item" />
      </form>
    </section>
  );
}

function Questions({ it, items }: { it: It; items: string[] }) {
  const [v, setV] = useState('');
  const save = (next: string[]) => it.mutate((cur) => ({ body: writeQuestions(cur.body, next) }));
  return (
    <section data-testid="questions">
      <h2 className="section-title mb-2">Questions</h2>
      <ul className="flex flex-col gap-1">
        {items.map((q, i) => (
          <li key={i} className="group flex items-start gap-2 font-serif text-[15px] leading-snug">
            <span className="text-brass">?</span>
            <span className="flex-1">{q}</span>
            <button className="text-faded opacity-0 group-hover:opacity-100" onClick={() => void save(items.filter((_, j) => j !== i))} aria-label={`Remove question ${q}`}>
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) void save([...items, v.trim().replace(/\?*$/, '?')]);
          setV('');
        }}
      >
        <input className="field mt-2 text-[13.5px]" placeholder="Add a question" value={v} onChange={(e) => setV(e.target.value)} aria-label="New question" />
      </form>
    </section>
  );
}

function ProjectNotes({ it, notes }: { it: It; notes: string }) {
  const [v, setV] = useState(notes);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setV(notes);
  }, [notes, dirty]);
  const save = () => {
    if (!dirty) return;
    setDirty(false);
    void it.mutate((cur) => ({ body: writeNotes(cur.body, v) }));
  };
  return (
    <section>
      <h2 className="section-title mb-1">Notes</h2>
      <div className="card px-3 py-1.5" onBlur={save}>
        <Editor
          value={v}
          onChange={(x) => {
            setV(x);
            setDirty(true);
          }}
          onSave={save}
          placeholder="Thinking, measurements, plans. Type [[ to link."
          minHeight="90px"
          ariaLabel="Project notes"
        />
      </div>
    </section>
  );
}
