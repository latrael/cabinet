import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, DropdownMenu, Popover } from 'radix-ui';
import { Archive, Check, Clock, ExternalLink, FileCode, FolderPlus, History, Inbox, Loader2, MoreHorizontal, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { getSection, setSection, splitSections } from '@cabinet/core/format';
import { linkKey } from '@cabinet/core/links';
import { api, fileUrl, type Item, type ItemDetail, type ItemSummary } from '../lib/api.ts';
import { renderMarkdown } from '../lib/markdown.ts';
import { host, longDate, relTime, tabPosition, TYPE_LABEL } from '../lib/meta.ts';
import { toast } from '../lib/store.ts';
import { useItem } from '../lib/useItem.ts';
import { Editor } from '../editor/Editor.tsx';
import { ConnectionsPanel } from '../components/ConnectionsPanel.tsx';
import { ConflictDialog } from '../components/ConflictDialog.tsx';
import { TagInput } from '../components/TagInput.tsx';
import { AddToPicker } from '../components/AddToPicker.tsx';
import { ProjectView } from './ProjectView.tsx';
import { CollectionView } from './Collections.tsx';

// ------------------------------------------------------------------ body helpers

const CONTENT_SECTIONS = new Set(['content', 'timestamps']);

export function splitBody(body: string, type: string): { notes: string; rest: string } {
  if (type === 'note' || type === 'memory') return { notes: body.replace(/\s+$/, ''), rest: '' };
  const { sections, preambleEnd } = splitSections(body);
  let notes = body.slice(0, preambleEnd);
  let rest = '';
  for (const s of sections) {
    const chunk = body.slice(s.start, s.end);
    if (CONTENT_SECTIONS.has(s.heading.toLowerCase())) rest += chunk.replace(/\s+$/, '') + '\n\n';
    else notes += chunk;
  }
  return { notes: notes.replace(/\s+$/, ''), rest: rest.trim() };
}

export function composeBody(notes: string, rest: string): string {
  return [notes.trim(), rest.trim()].filter(Boolean).join('\n\n') + '\n';
}

function useResolver(detail: ItemDetail | undefined) {
  return useMemo(() => {
    const map = new Map<string, ItemSummary>();
    for (const o of detail?.outgoing ?? []) if (o.item) map.set(linkKey(o.target), o.item);
    return (target: string) => {
      const i = map.get(linkKey(target));
      return i ? { id: i.id, title: i.title } : null;
    };
  }, [detail]);
}

/** Handle clicks on rendered wikilinks with the router. */
function useLinkClicks(onUnresolved?: (target: string) => void) {
  const navigate = useNavigate();
  return (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a.wikilink') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    if (a.dataset.id) navigate({ to: '/item/$id', params: { id: a.dataset.id } });
    else if (a.dataset.target) onUnresolved?.(a.dataset.target);
  };
}

export function Markdown({ md, detail, className }: { md: string; detail?: ItemDetail; className?: string }) {
  const resolve = useResolver(detail);
  const onClick = useLinkClicks();
  const html = useMemo(() => renderMarkdown(md, resolve), [md, resolve]);
  return <div className={`prose-cabinet ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ------------------------------------------------------------------ page

export function ItemPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const it = useItem(id);
  const d = it.data;
  if (it.query.isError) return <p className="font-serif text-[18px] text-faded">This item isn't in your cabinet. It may have been deleted or renamed.</p>;
  if (!d) return <Loader2 className="animate-spin text-faded" />;
  return (
    <>
      {d.item.type === 'project' ? <ProjectView it={it} /> : d.item.type === 'collection' ? <CollectionView it={it} /> : <ItemView it={it} />}
      <ConflictDialog conflict={it.conflict} onResolve={(c) => void it.resolveConflict(c)} />
    </>
  );
}

type It = ReturnType<typeof useItem>;

// ------------------------------------------------------------------ header pieces

export function ItemMenu({ item, onRefetch }: { item: Item; onRefetch?: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [raw, setRaw] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ hash: string; date: string; author: string; message: string }> | null>(null);
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="btn btn-quiet btn-sm" aria-label="More actions">
          <MoreHorizontal size={16} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-48 border border-rule-strong bg-card p-1 text-[13.5px] shadow-[var(--shadow-lift)]">
            <DropdownMenu.Item className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 outline-none data-[highlighted]:bg-paper" onSelect={async () => setRaw(await api<string>(`/api/items/${item.id}/raw`))}>
              <FileCode size={14} /> Show Markdown file
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 outline-none data-[highlighted]:bg-paper"
              onSelect={async () => setHistory((await api<{ commits: any[] }>(`/api/items/${item.id}/history`)).commits)}
            >
              <History size={14} /> History
            </DropdownMenu.Item>
            {onRefetch && (
              <DropdownMenu.Item className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 outline-none data-[highlighted]:bg-paper" onSelect={onRefetch}>
                <RefreshCw size={14} /> Fetch the page again
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item
              className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 outline-none data-[highlighted]:bg-paper"
              onSelect={async () => {
                await api(`/api/items/${item.id}/enrich`, { method: 'POST' }).catch((e) => toast(e.message, { tone: 'error' }));
                toast('Asking the local model for suggestions…');
              }}
            >
              <Sparkles size={14} /> Suggest tags and links
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-rule" />
            <DropdownMenu.Item
              className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-alert outline-none data-[highlighted]:bg-alert-wash"
              onSelect={async () => {
                if (!confirm(`Delete “${item.title}”? The file is removed; git history keeps a copy.`)) return;
                await api(`/api/items/${item.id}`, { method: 'DELETE' });
                qc.invalidateQueries();
                toast(`Deleted “${item.title}”`);
                navigate({ to: '/library' });
              }}
            >
              <Trash2 size={14} /> Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Dialog.Root open={raw !== null} onOpenChange={(o) => !o && setRaw(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgba(0,0,0,0.3)]" />
          <Dialog.Content aria-describedby={undefined} className="fixed top-[8vh] left-1/2 z-50 max-h-[80vh] w-[min(760px,94vw)] -translate-x-1/2 overflow-auto border border-rule-strong bg-card p-5 shadow-[var(--shadow-sheet)]">
            <Dialog.Title className="mb-2 font-serif text-[18px]">{item.path}</Dialog.Title>
            <pre className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-soft">{raw}</pre>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={history !== null} onOpenChange={(o) => !o && setHistory(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgba(0,0,0,0.3)]" />
          <Dialog.Content aria-describedby={undefined} className="fixed top-[12vh] left-1/2 z-50 max-h-[70vh] w-[min(560px,94vw)] -translate-x-1/2 overflow-auto border border-rule-strong bg-card p-5 shadow-[var(--shadow-sheet)]">
            <Dialog.Title className="mb-3 font-serif text-[18px]">History</Dialog.Title>
            {history?.length === 0 && <p className="text-[14px] text-faded">No commits yet. Changes are committed about 30 seconds after they happen.</p>}
            <ul className="flex flex-col">
              {history?.map((c) => (
                <li key={c.hash} className="border-b border-rule py-2 text-[13.5px]">
                  <div className="text-ink">{c.message}</div>
                  <div className="text-[12px] text-faded">
                    {c.author} — {relTime(c.date)} — {c.hash.slice(0, 7)}
                  </div>
                </li>
              ))}
            </ul>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export function AddToProjectButton({ item }: { item: Item }) {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState('');
  const [section, setSectionName] = useState('');
  const [context, setContext] = useState('');
  const [open, setOpen] = useState(false);
  const projects = useQuery({ queryKey: ['items', 'projects'], queryFn: () => api<{ items: ItemSummary[] }>('/api/items?type=project&sort=updated&limit=100'), enabled: open });
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="btn btn-sm">
        <FolderPlus size={13} /> Add to project
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50 w-80 border border-rule-strong bg-card p-3 shadow-[var(--shadow-lift)]">
          <form
            className="flex flex-col gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!projectId) return;
              await api(`/api/items/${item.id}/project`, { method: 'POST', json: { projectId, section: section || undefined, context: context || undefined } });
              qc.invalidateQueries();
              setOpen(false);
              toast('Added to the project', { tone: 'ok' });
            }}
          >
            <select className="field text-[13.5px]" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project" autoFocus>
              <option value="">Choose a project</option>
              {projects.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <input className="field text-[13.5px]" placeholder="Section (optional)" value={section} onChange={(e) => setSectionName(e.target.value)} />
            <input className="field text-[13.5px]" placeholder="Why it matters to this project" value={context} onChange={(e) => setContext(e.target.value)} />
            <button className="btn btn-primary justify-center" disabled={!projectId}>
              Add
            </button>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function TitleInput({ it, className }: { it: It; className?: string }) {
  const item = it.data!.item;
  const [v, setV] = useState(item.title);
  useEffect(() => setV(item.title), [item.title]);
  const save = () => {
    if (v.trim() && v.trim() !== item.title) void it.mutate(() => ({ frontmatter: { title: v.trim() } }));
  };
  return (
    <input
      className={`w-full bg-transparent font-serif text-[30px] leading-tight font-[560] text-ink focus:outline-none md:text-[34px] ${className ?? ''}`}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      aria-label="Title"
      data-testid="item-title"
    />
  );
}

// ------------------------------------------------------------------ media

const YT = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/))([\w-]{6,})/;
const VIMEO = /vimeo\.com\/(\d+)/;

function VideoBlock({ item, it }: { item: Item; it: It }) {
  const url = (item.frontmatter.source as any)?.url as string | undefined;
  const yt = url ? YT.exec(url)?.[1] : undefined;
  const vm = url ? VIMEO.exec(url)?.[1] : undefined;
  const [start, setStart] = useState<number | undefined>(undefined);
  const [t, setT] = useState('');
  const [note, setNote] = useState('');
  const stamps = (getSection(item.body, 'Timestamps') ?? '')
    .split('\n')
    .map((l) => /^\s*-\s*\[([\d:]+)\]\(([^)]+)\)\s*(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ label: m[1], url: m[2], note: m[3], sec: m[1].split(':').reduce((a, b) => a * 60 + Number(b), 0) }));
  const src = yt ? `https://www.youtube-nocookie.com/embed/${yt}?rel=0${start !== undefined ? `&start=${start}&autoplay=1` : ''}` : vm ? `https://player.vimeo.com/video/${vm}${start !== undefined ? `#t=${start}s` : ''}` : null;
  const add = async () => {
    const parts = t.trim().split(':').map(Number);
    if (!parts.length || parts.some(Number.isNaN)) return;
    const sec = parts.reduce((a, b) => a * 60 + b, 0);
    const label = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    const link = yt ? `https://youtu.be/${yt}?t=${sec}` : vm ? `https://vimeo.com/${vm}#t=${sec}s` : url;
    await it.mutate((cur) => {
      const existing = getSection(cur.body, 'Timestamps') ?? '';
      const lines = [...existing.split('\n').filter((l) => l.trim()), `- [${label}](${link}) ${note.trim()}`.trimEnd()];
      lines.sort((a, b) => {
        const s = (l: string) => (/\[([\d:]+)\]/.exec(l)?.[1] ?? '0').split(':').reduce((x, y) => x * 60 + Number(y), 0);
        return s(a) - s(b);
      });
      return { body: setSection(cur.body, 'Timestamps', lines.join('\n')) };
    });
    setT('');
    setNote('');
  };
  return (
    <div>
      {src ? (
        <div className="aspect-video w-full overflow-hidden bg-ink shadow-[var(--shadow-card)]">
          <iframe key={src} src={src} title={item.title} className="h-full w-full" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" />
        </div>
      ) : null}
      <div className="mt-4">
        <h2 className="mb-2 font-sans text-[13px] font-semibold text-ink-soft">Timestamps</h2>
        <ul className="flex flex-col" data-testid="timestamps">
          {stamps.map((s, i) => (
            <li key={i} className="flex gap-3 border-b border-rule py-1.5 text-[14.5px]">
              <button className="w-14 shrink-0 text-left font-semibold text-lamp tabular-nums hover:underline" onClick={() => setStart(s.sec)}>
                {s.label}
              </button>
              <span className="font-serif">{s.note}</span>
              <a href={s.url} target="_blank" rel="noreferrer" className="ml-auto text-faded hover:text-lamp" aria-label="Open at this time">
                <ExternalLink size={13} />
              </a>
            </li>
          ))}
        </ul>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="field !w-24 text-[13.5px] tabular-nums" placeholder="04:12" value={t} onChange={(e) => setT(e.target.value)} aria-label="Time" />
          <input className="field text-[13.5px]" placeholder="What happens here" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Timestamp note" />
          <button className="btn" disabled={!t.trim()}>
            <Clock size={13} /> Add
          </button>
        </form>
      </div>
    </div>
  );
}

function ManualContent({ item, onDone }: { item: Item; onDone: () => void }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div className=" border border-alert/30 bg-alert-wash/60 px-4 py-3 text-[14px]" data-testid="extraction-failed">
      <p className="text-ink">Cabinet couldn't read this page, so only the link was saved. You can paste the text yourself, or try fetching it again.</p>
      {open ? (
        <div className="mt-2">
          <textarea className="field min-h-[140px] font-serif" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the article text here" autoFocus />
          <div className="mt-2 flex gap-2">
            <button
              className="btn btn-primary"
              disabled={!text.trim()}
              onClick={async () => {
                await api(`/api/items/${item.id}/content`, { method: 'POST', json: { content: text } });
                onDone();
              }}
            >
              Save content
            </button>
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button className="btn btn-sm" onClick={() => setOpen(true)}>
            Paste content
          </button>
          <button
            className="btn btn-sm"
            onClick={async () => {
              await api(`/api/items/${item.id}/refetch`, { method: 'POST' });
              onDone();
            }}
          >
            <RefreshCw size={12} /> Try again
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the item view

function ItemView({ it }: { it: It }) {
  const qc = useQueryClient();
  const detail = it.data!;
  const { item } = detail;
  const fm = item.frontmatter as any;
  const src = fm.source ?? {};
  const isNoteLike = item.type === 'note' || item.type === 'memory';
  const server = splitBody(item.body, item.type);
  const [notes, setNotes] = useState(server.notes);
  const base = useRef({ notes: server.notes, hash: item.hash });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Sync with server when not editing.
  useEffect(() => {
    if (timer.current) return;
    setNotes(server.notes);
    base.current = { notes: server.notes, hash: item.hash };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.hash]);

  const flush = async (value: string) => {
    timer.current = null;
    const baseNotes = base.current.notes;
    const res = await it.mutate((cur) => {
      const parts = splitBody(cur.body, cur.type);
      // Only rebase if nobody else touched the notes.
      if (cur.hash !== base.current.hash && parts.notes.trim() !== baseNotes.trim()) return null;
      return { body: composeBody(value, parts.rest) };
    });
    if (res) {
      base.current = { notes: splitBody(res.item.body, res.item.type).notes, hash: res.item.hash };
      setSavedAt(Date.now());
    }
  };
  const onNotes = (v: string) => {
    setNotes(v);
    it.setDirty(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(v), 900);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const [why, setWhy] = useState(item.why ?? '');
  useEffect(() => setWhy(item.why ?? ''), [item.why]);
  const saveWhy = () => {
    if ((item.why ?? '') !== why.trim()) void it.mutate(() => ({ frontmatter: { why: why.trim() || null } }));
  };

  const setStatus = (status: string) => void it.mutate(() => ({ frontmatter: { status } }));
  const content = getSection(item.body, 'Content');
  const navigate = useNavigate();

  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_300px]">
      <article className="min-w-0">
        <div className="mb-2 flex items-center gap-2">
          <span className="kicker">{TYPE_LABEL[item.type]}</span>
          {item.status === 'inbox' && <span className=" bg-lamp-wash px-1.5 text-[12px] text-lamp">in your inbox</span>}
          {item.status === 'archived' && <span className=" bg-paper-deep px-1.5 text-[12px] text-faded">archived</span>}
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-2 text-[12px] text-faded" aria-live="polite">
              {it.saving ? 'Saving…' : it.changedOnDisk ? 'Changed on disk' : savedAt ? 'Saved' : ''}
            </span>
            {item.status === 'inbox' && (
              <button className="btn btn-sm" onClick={() => setStatus('library')}>
                <Check size={13} /> File in library
              </button>
            )}
            {item.status !== 'inbox' && item.status !== 'archived' && !isNoteLike && (
              <button className="btn btn-sm btn-quiet" onClick={() => setStatus('inbox')} aria-label="Move to inbox">
                <Inbox size={13} />
              </button>
            )}
            {item.status !== 'archived' ? (
              <button className="btn btn-sm btn-quiet" onClick={() => setStatus('archived')} aria-label="Archive">
                <Archive size={13} />
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => setStatus('library')}>
                Unarchive
              </button>
            )}
            <ItemMenu item={item} onRefetch={src.url ? () => void api(`/api/items/${item.id}/refetch`, { method: 'POST' }) : undefined} />
          </div>
        </div>

        <TitleInput it={it} />
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-faded">
          {src.url && (
            <a href={src.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-lamp hover:underline" data-testid="source-link">
              {src.site ?? host(src.url)} <ExternalLink size={11} />
            </a>
          )}
          {src.author && <span>{src.author}</span>}
          {src.published && <span>published {longDate(src.published)}</span>}
          <span>saved {longDate(item.created)}</span>
          {fm.captured_via && fm.captured_via !== 'web' && <span>via {fm.captured_via}</span>}
          {fm.extraction === 'pending' && (
            <span className="inline-flex items-center gap-1 text-brass">
              <Loader2 size={12} className="animate-spin" /> reading the page
            </span>
          )}
        </div>

        {!isNoteLike && (
          <div className="mt-5">
            <label className="label mb-0.5 block">Why I saved this</label>
            <div onBlur={saveWhy}>
              <Editor value={why} onChange={setWhy} placeholder="Add your reason. Type [[ to link." excludeId={item.id} ariaLabel="Why I saved this" onOpenLink={(t) => navigate({ to: '/item/$id', params: { id: t } })} />
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="min-w-[220px] flex-1">
            <TagInput value={item.tags} onChange={(tags) => void it.mutate(() => ({ frontmatter: { tags } }))} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AddToPicker
              allowProjects={false}
              value={item.collections.map((c) => ({ kind: 'collection' as const, title: c }))}
              onChange={(v) => void it.mutate(() => ({ frontmatter: { collections: v.map((x) => x.title) } }))}
            />
            <AddToProjectButton item={item} />
          </div>
        </div>

        {fm.extraction === 'failed' && (
          <div className="mt-5">
            <ManualContent item={item} onDone={() => qc.invalidateQueries()} />
          </div>
        )}

        {/* Media */}
        <div className="mt-6">
          {item.type === 'video' && <VideoBlock item={item} it={it} />}
          {item.type === 'image' && fm.attachment && (
            <a href={fileUrl(fm.attachment)} target="_blank" rel="noreferrer">
              <img src={fileUrl(fm.attachment)} alt={item.title} className="max-h-[70vh] shadow-[var(--shadow-lift)]" />
            </a>
          )}
          {item.type === 'pdf' && fm.attachment && (
            <div className="overflow-hidden border border-rule bg-card shadow-[var(--shadow-card)]">
              <iframe src={fileUrl(fm.attachment)} title={item.title} className="h-[72vh] w-full" data-testid="pdf-viewer" />
            </div>
          )}
          {item.type === 'audio' && fm.attachment && <audio controls src={fileUrl(fm.attachment)} className="w-full" />}
        </div>

        {/* Notes */}
        <section className="mt-7">
          {!isNoteLike && <h2 className="mb-1 font-sans text-[13px] font-semibold text-ink-soft">Your notes</h2>}
          <div className={isNoteLike ? 'min-h-[50vh]' : 'card px-4 py-2'} data-testid="notes-editor">
            <Editor
              value={notes}
              onChange={onNotes}
              onSave={() => {
                if (timer.current) clearTimeout(timer.current);
                void flush(notes);
              }}
              placeholder={isNoteLike ? 'Start writing. Type [[ to link to anything in your cabinet.' : 'What do you think about it? Type [[ to link.'}
              excludeId={item.id}
              minHeight={isNoteLike ? '50vh' : '80px'}
              autoFocus={new URLSearchParams(location.search).has('edit')}
              ariaLabel="Notes"
              onOpenLink={async (t) => {
                const r = await api<{ id: string | null }>(`/api/resolve?ref=${encodeURIComponent(t)}`);
                if (r.id) navigate({ to: '/item/$id', params: { id: r.id } });
              }}
            />
          </div>
          <p className="mt-1 text-[12px] text-faded">Saves as you type. Hold {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} and click a link to open it.</p>
        </section>

        {/* Extracted content */}
        {item.type === 'quote' && !content ? null : content && item.type !== 'video' ? (
          <section className="mt-10 border-t border-rule pt-6" data-testid="reader">
            <h2 className="mb-3 font-sans text-[13px] font-semibold text-ink-soft">{item.type === 'pdf' ? 'Text from the PDF' : item.type === 'audio' ? 'Transcript' : 'Saved content'}</h2>
            <Markdown md={content} detail={detail} />
          </section>
        ) : null}
      </article>
      <aside className="min-w-0 xl:sticky xl:top-6 xl:max-h-[calc(100vh-3rem)] xl:self-start xl:overflow-y-auto">
        <ConnectionsPanel detail={detail} />
      </aside>
    </div>
  );
}

export { tabPosition, Plus };
