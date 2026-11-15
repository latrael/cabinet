import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderKanban, Plus } from 'lucide-react';
import { api, thumbUrl, type ItemSummary } from '../lib/api.ts';
import { relTime } from '../lib/meta.ts';
import { setUi } from '../lib/store.ts';

export function ProjectsPage() {
  const q = useQuery({ queryKey: ['items', 'projects', 'all'], queryFn: () => api<{ items: ItemSummary[] }>('/api/items?type=project&sort=updated&limit=200') });
  const groups = ['active', 'paused', 'done'] as const;
  const items = q.data?.items ?? [];
  return (
    <div>
      <header className="mb-6 flex items-end gap-3">
        <div className="mr-auto">
          <h1 className="font-serif text-[30px] leading-tight">Projects</h1>
          <p className="text-[14px] text-faded">Gather material into sections, keep notes, questions and a checklist.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setUi({ palette: true, paletteMode: 'new-project' })} data-testid="new-project">
          <Plus size={14} /> New project
        </button>
      </header>
      {q.isSuccess && items.length === 0 && <p className="text-[15px] text-faded">No projects yet. Start one for anything you're making, learning or writing.</p>}
      {groups.map((g) => {
        const list = items.filter((p) => (p.projectStatus ?? 'active') === g);
        if (!list.length) return null;
        return (
          <section key={g} className="mb-10">
            <h2 className="section-title">{g}</h2>
            <div className="item-grid">
              {list.map((p) => (
                <ProjectCell key={p.id} project={p} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** A project in the item grid: cover, name, what it is for, when it last changed. */
export function ProjectCell({ project: p }: { project: ItemSummary }) {
  return (
    <Link to="/item/$id" params={{ id: p.id }} className="item-cell block" data-item={p.slug}>
      <div className="mb-3 flex aspect-[3/2] items-center justify-center overflow-hidden bg-paper-deep">
        {p.cover ? <img src={thumbUrl(p.cover, 480)} alt="" className="h-full w-full object-cover" /> : <FolderKanban size={22} strokeWidth={1.5} className="text-faded" />}
      </div>
      <h3 className="item-title font-serif text-[21px] leading-[1.2]">{p.title}</h3>
      {p.excerpt && <p className="mt-1.5 line-clamp-2 font-serif text-[14.5px] leading-snug text-ink-soft">{p.excerpt}</p>}
      <div className="mt-2 text-[11.5px] text-faded">Changed {relTime(p.updated)}</div>
    </Link>
  );
}
