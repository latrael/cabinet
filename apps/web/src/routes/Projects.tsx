import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderKanban, Plus } from 'lucide-react';
import { api, thumbUrl, type ItemSummary } from '../lib/api.ts';
import { relTime } from '../lib/meta.ts';
import { setUi } from '../lib/store.ts';
import { TypeTab } from '../components/ItemCard.tsx';

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
            <h2 className="section-title mb-4 capitalize">{g}</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-6">
              {list.map((p) => (
                <Link key={p.id} to="/item/$id" params={{ id: p.id }} className="card card-interactive mt-3 block" data-item={p.slug}>
                  <TypeTab type="project" />
                  <div className="flex h-32 items-center justify-center overflow-hidden rounded-t-[2px] bg-paper-deep">
                    {p.cover ? <img src={thumbUrl(p.cover, 480)} alt="" className="h-full w-full object-cover" /> : <FolderKanban size={24} className="text-faded" />}
                  </div>
                  <div className="px-4 py-3">
                    <h3 className="font-serif text-[18px]">{p.title}</h3>
                    {p.excerpt && <p className="mt-1 line-clamp-2 text-[13px] text-ink-soft">{p.excerpt}</p>}
                    <div className="card-rule mt-2.5 mb-1.5" />
                    <div className="text-[11.5px] text-faded">changed {relTime(p.updated)}</div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
