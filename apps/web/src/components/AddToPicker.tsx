import { useState } from 'react';
import { Popover } from 'radix-ui';
import { useQuery } from '@tanstack/react-query';
import { Check, FolderKanban, Library, Plus, X } from 'lucide-react';
import { api, type ItemSummary } from '../lib/api.ts';

export interface AddTarget {
  kind: 'project' | 'collection';
  id?: string;
  title: string;
}

export function AddToPicker({ value, onChange, allowProjects = true }: { value: AddTarget[]; onChange: (v: AddTarget[]) => void; allowProjects?: boolean }) {
  const [q, setQ] = useState('');
  const projects = useQuery({ queryKey: ['items', 'projects'], queryFn: () => api<{ items: ItemSummary[] }>('/api/items?type=project&sort=updated&limit=100') });
  const collections = useQuery({ queryKey: ['collections'], queryFn: () => api<{ collections: Array<{ name: string; count: number }> }>('/api/collections') });
  const has = (t: AddTarget) => value.some((v) => v.kind === t.kind && v.title.toLowerCase() === t.title.toLowerCase());
  const toggle = (t: AddTarget) => {
    if (has(t)) onChange(value.filter((v) => !(v.kind === t.kind && v.title.toLowerCase() === t.title.toLowerCase())));
    // only one project at a time keeps the per-project context unambiguous
    else onChange([...value.filter((v) => (t.kind === 'project' ? v.kind !== 'project' : true)), t]);
  };
  const ql = q.trim().toLowerCase();
  const ps = (projects.data?.items ?? []).filter((p) => !ql || p.title.toLowerCase().includes(ql));
  const cs = (collections.data?.collections ?? []).filter((c) => !ql || c.name.toLowerCase().includes(ql));
  const exact = cs.some((c) => c.name.toLowerCase() === ql);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((t) => (
        <span key={t.kind + t.title} className="chip !h-6">
          {t.kind === 'project' ? <FolderKanban size={11} /> : <Library size={11} />}
          {t.title}
          <button type="button" aria-label={`Remove ${t.title}`} onClick={() => toggle(t)} className="text-faded hover:text-ink">
            <X size={11} />
          </button>
        </span>
      ))}
      <Popover.Root onOpenChange={(o) => !o && setQ('')}>
        <Popover.Trigger asChild>
          <button type="button" className="btn btn-sm" data-testid="add-to">
            <Plus size={13} /> {allowProjects ? 'Collection or project' : 'Collection'}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={4} className="z-[60] w-72 border border-rule-strong bg-card p-1.5 shadow-[var(--shadow-lift)]">
            <input
              className="field mb-1 text-[13.5px]"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find or create a collection"
              data-no-submit=""
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  if (q.trim()) toggle({ kind: 'collection', title: q.trim() });
                  setQ('');
                }
              }}
            />
            <div className="max-h-64 overflow-y-auto">
              {allowProjects && ps.length > 0 && <div className="px-2 pt-1.5 pb-0.5 text-[11.5px] font-semibold text-faded">Projects</div>}
              {allowProjects &&
                ps.map((p) => {
                  const t: AddTarget = { kind: 'project', id: p.id, title: p.title };
                  return (
                    <button key={p.id} type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13.5px] hover:bg-paper" onClick={() => toggle(t)}>
                      <FolderKanban size={13} className="text-faded" />
                      <span className="flex-1 truncate">{p.title}</span>
                      {has(t) && <Check size={13} className="text-lamp" />}
                    </button>
                  );
                })}
              <div className="px-2 pt-1.5 pb-0.5 text-[11.5px] font-semibold text-faded">Collections</div>
              {cs.map((c) => {
                const t: AddTarget = { kind: 'collection', title: c.name };
                return (
                  <button key={c.name} type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13.5px] hover:bg-paper" onClick={() => toggle(t)}>
                    <Library size={13} className="text-faded" />
                    <span className="flex-1 truncate">{c.name}</span>
                    {has(t) && <Check size={13} className="text-lamp" />}
                  </button>
                );
              })}
              {ql && !exact && (
                <button type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13.5px] text-lamp hover:bg-paper" onClick={() => toggle({ kind: 'collection', title: q.trim() })}>
                  <Plus size={13} /> New collection “{q.trim()}”
                </button>
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
