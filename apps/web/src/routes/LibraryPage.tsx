import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { LayoutGrid, List } from 'lucide-react';
import { api, type ItemSummary } from '../lib/api.ts';
import { SOURCE_FILTERS, TYPE_LABEL } from '../lib/meta.ts';
import { ItemCard, ItemRow } from '../components/ItemCard.tsx';

const PAGE = 60;

export function LibraryPage() {
  const s = useSearch({ strict: false }) as { type?: string; tag?: string; collection?: string; view?: string; sort?: string };
  const navigate = useNavigate();
  const set = (patch: Record<string, string | undefined>) => navigate({ to: '/library', search: { ...s, ...patch } as any, replace: true });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api<{ tags: Array<{ tag: string; count: number }> }>('/api/tags') });
  const collections = useQuery({ queryKey: ['collections'], queryFn: () => api<{ collections: Array<{ name: string; count: number }> }>('/api/collections') });
  const params = new URLSearchParams();
  if (s.type) params.set('type', s.type);
  else params.set('exclude', 'project,collection');
  if (s.tag) params.set('tag', s.tag);
  if (s.collection) params.set('collection', s.collection);
  params.set('status', 'inbox,library');
  params.set('sort', s.sort ?? 'created');
  const q = useInfiniteQuery({
    queryKey: ['items', 'library', params.toString()],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<{ items: ItemSummary[]; total: number }>(`/api/items?${params}&limit=${PAGE}&offset=${pageParam}`),
    getNextPageParam: (last, all) => (all.length * PAGE < last.total ? all.length * PAGE : undefined),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;
  const view = s.view ?? 'cards';
  return (
    <div>
      <header className="mb-5 flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="font-serif text-[30px] leading-tight">Library</h1>
          <p className="text-[14px] text-faded">
            {total} {total === 1 ? 'item' : 'items'}
            {s.tag ? ` tagged #${s.tag}` : ''}
            {s.collection ? ` in ${s.collection}` : ''}
          </p>
        </div>
        <select className="field !w-auto text-[13px]" value={s.sort ?? 'created'} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort">
          <option value="created">Newest saved</option>
          <option value="updated">Recently changed</option>
          <option value="title">Title</option>
        </select>
        <div className="flex rounded-[3px] border border-rule-strong bg-card" role="group" aria-label="View">
          <button className={`btn btn-sm !border-0 ${view === 'cards' ? '!bg-paper-deep' : '!bg-transparent'}`} onClick={() => set({ view: 'cards' })} aria-pressed={view === 'cards'} aria-label="Cards">
            <LayoutGrid size={14} />
          </button>
          <button className={`btn btn-sm !border-0 ${view === 'list' ? '!bg-paper-deep' : '!bg-transparent'}`} onClick={() => set({ view: 'list' })} aria-pressed={view === 'list'} aria-label="List">
            <List size={14} />
          </button>
        </div>
      </header>
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Type">
        <button className={`chip ${!s.type ? 'chip-active' : ''}`} onClick={() => set({ type: undefined })}>
          everything
        </button>
        {SOURCE_FILTERS.map((t) => (
          <button key={t} className={`chip ${s.type === t ? 'chip-active' : ''}`} onClick={() => set({ type: s.type === t ? undefined : t })}>
            {TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <select className="field !w-auto text-[13px]" value={s.tag ?? ''} onChange={(e) => set({ tag: e.target.value || undefined })} aria-label="Tag">
          <option value="">Any tag</option>
          {tags.data?.tags.map((t) => (
            <option key={t.tag} value={t.tag}>
              #{t.tag} ({t.count})
            </option>
          ))}
        </select>
        <select className="field !w-auto text-[13px]" value={s.collection ?? ''} onChange={(e) => set({ collection: e.target.value || undefined })} aria-label="Collection">
          <option value="">Any collection</option>
          {collections.data?.collections.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.count})
            </option>
          ))}
        </select>
      </div>
      {view === 'cards' ? (
        <div className="masonry">
          {items.map((i) => (
            <ItemCard key={i.id} item={i} />
          ))}
        </div>
      ) : (
        <div className="border-t border-rule">
          {items.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </div>
      )}
      {q.hasNextPage && (
        <button className="btn mx-auto mt-6 block" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          Show more
        </button>
      )}
      {q.isSuccess && items.length === 0 && <p className="text-[15px] text-faded">Nothing matches these filters.</p>}
    </div>
  );
}
