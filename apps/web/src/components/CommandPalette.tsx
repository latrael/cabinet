import { useEffect, useMemo, useState } from 'react';
import { Dialog } from 'radix-ui';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderKanban, Inbox, Library, Link2, MessageCircle, NotebookPen, Quote, Search, Settings, Share2, type LucideIcon } from 'lucide-react';
import { PROJECT_KINDS } from '@cabinet/core/types';
import { api, type ItemDetail, type ItemSummary } from '../lib/api.ts';
import { TYPE_ICON, TYPE_LABEL } from '../lib/meta.ts';
import { openCapture, setUi, toast, useUi } from '../lib/store.ts';
import { isUrl } from './CaptureSheet.tsx';

interface Action {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

export function CommandPalette() {
  const open = useUi((s) => s.palette);
  const mode = useUi((s) => s.paletteMode);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => setUi({ palette: o, paletteMode: 'search' })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgba(0,0,0,0.22)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-50 w-[min(600px,94vw)] -translate-x-1/2 overflow-hidden border border-rule-strong bg-card shadow-[var(--shadow-sheet)] focus:outline-none"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          {mode === 'new-project' ? <NewProjectForm /> : <PaletteSearch />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const close = () => setUi({ palette: false });
  const go = (to: string) => {
    close();
    navigate({ to });
  };
  const results = useQuery({
    queryKey: ['palette', q],
    queryFn: () => api<{ items: ItemSummary[] }>(`/api/suggest?q=${encodeURIComponent(q)}&limit=8`),
    placeholderData: (p) => p,
  });

  const actions: Action[] = useMemo(() => {
    const a: Action[] = [];
    const t = q.trim();
    if (t && isUrl(t)) a.push({ id: 'save-url', label: `Save link ${t.slice(0, 50)}`, icon: Link2, run: () => openCapture({ url: t }) });
    a.push(
      { id: 'new-note', label: t && !isUrl(t) ? `New note “${t}”` : 'New note', icon: NotebookPen, run: () => void createNote(t && !isUrl(t) ? t : 'Untitled note') },
      { id: 'new-project', label: 'New project', icon: FolderKanban, run: () => setUi({ paletteMode: 'new-project' }) },
      { id: 'capture', label: t && !isUrl(t) ? `Save “${t.slice(0, 40)}” as a quote` : 'Save a quote or snippet', icon: Quote, run: () => openCapture({ text: t && !isUrl(t) ? t : '', kind: 'quote' }) },
    );
    if (t) a.push({ id: 'search', label: `Search for “${t}”`, icon: Search, run: () => (close(), navigate({ to: '/search', search: { q: t } as any })) });
    a.push(
      { id: 'inbox', label: 'Go to inbox', icon: Inbox, run: () => go('/inbox') },
      { id: 'library', label: 'Go to library', icon: Library, run: () => go('/library') },
      { id: 'projects', label: 'Go to projects', icon: FolderKanban, run: () => go('/projects') },
      { id: 'graph', label: 'Open the graph', icon: Share2, run: () => go('/graph') },
      { id: 'chat', label: 'Ask your cabinet', icon: MessageCircle, run: () => go('/chat') },
      { id: 'settings', label: 'Settings', icon: Settings, run: () => go('/settings') },
    );
    const ql = t.toLowerCase();
    return a.filter((x) => !ql || ['save-url', 'new-note', 'capture', 'search'].includes(x.id) || x.label.toLowerCase().includes(ql));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function createNote(title: string) {
    close();
    const d = await api<ItemDetail>('/api/items', { method: 'POST', json: { type: 'note', title } });
    navigate({ to: '/item/$id', params: { id: d.item.id }, search: { edit: 1 } as any });
  }

  const items = q.trim() ? (results.data?.items ?? []) : [];
  const rows: Array<{ kind: 'item'; item: ItemSummary } | { kind: 'action'; action: Action }> = [
    ...actions.slice(0, q.trim() ? 4 : 99).map((action) => ({ kind: 'action' as const, action })),
    ...items.map((item) => ({ kind: 'item' as const, item })),
    ...(q.trim() ? actions.slice(4).map((action) => ({ kind: 'action' as const, action })) : []),
  ];
  useEffect(() => setSel(0), [q]);

  const run = (i: number) => {
    const r = rows[i];
    if (!r) return;
    if (r.kind === 'item') go(`/item/${r.item.id}`);
    else r.action.run();
  };

  return (
    <div>
      <div className="flex items-center gap-2.5 border-b border-rule px-4">
        <Search size={16} className="text-faded" />
        <input
          autoFocus
          className="h-12 flex-1 bg-transparent text-[16px] focus:outline-none"
          placeholder="Search, paste a link, or type a command"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Command"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(rows.length - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(sel);
            }
          }}
        />
      </div>
      <ul className="max-h-[56vh] overflow-y-auto py-1.5" role="listbox">
        {rows.map((r, i) => {
          const Icon = r.kind === 'item' ? TYPE_ICON[r.item.type] : r.action.icon;
          return (
            <li key={r.kind === 'item' ? r.item.id : r.action.id} role="option" aria-selected={i === sel}>
              <button
                className={`flex w-full items-center gap-3 px-4 py-2 text-left text-[14.5px] ${i === sel ? 'bg-ink text-white' : 'text-ink'}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => run(i)}
              >
                <Icon size={15} strokeWidth={1.7} className={i === sel ? '' : 'text-faded'} />
                <span className={`flex-1 truncate ${r.kind === 'item' ? 'font-serif' : ''}`}>{r.kind === 'item' ? r.item.title : r.action.label}</span>
                {r.kind === 'item' && <span className={`text-[12px] ${i === sel ? 'text-white' : 'text-faded'}`}>{TYPE_LABEL[r.item.type]}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function NewProjectForm() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<string>('');
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  async function create() {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const d = await api<ItemDetail>('/api/items', {
        method: 'POST',
        json: { type: 'project', title: title.trim(), frontmatter: { kind: kind || undefined, intent: intent.trim() || undefined, project_status: 'active', view: 'cards' }, body: '## Material\n' },
      });
      setUi({ palette: false, paletteMode: 'search' });
      qc.invalidateQueries();
      toast(`Created ${d.item.title}`, { tone: 'ok' });
      navigate({ to: '/item/$id', params: { id: d.item.id } });
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
      setBusy(false);
    }
  }
  return (
    <form
      className="p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <h2 className="mb-4 font-serif text-[20px]">New project</h2>
      <label className="label mb-1 block" htmlFor="np-title">
        Title
      </label>
      <input id="np-title" className="field mb-4 font-serif text-[16px]" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Reading corner" />
      <span className="label mb-1 block">Kind (optional)</span>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {PROJECT_KINDS.map((k) => (
          <button key={k} type="button" className={`chip ${kind === k ? 'chip-active' : ''}`} onClick={() => setKind(kind === k ? '' : k)} aria-pressed={kind === k}>
            {k}
          </button>
        ))}
      </div>
      <label className="label mb-1 block" htmlFor="np-intent">
        Intent (optional)
      </label>
      <textarea id="np-intent" className="field mb-5 min-h-[64px] font-serif" value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="What are you trying to make or learn?" />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={() => setUi({ paletteMode: 'search' })}>
          Back
        </button>
        <button className="btn btn-primary" disabled={!title.trim() || busy}>
          Create project
        </button>
      </div>
    </form>
  );
}
