import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Check, Sparkles } from 'lucide-react';
import { api, type ItemSummary } from '../lib/api.ts';
import { toast } from '../lib/store.ts';
import { ItemCard } from '../components/ItemCard.tsx';
import { DigestPanel } from '../components/DigestPanel.tsx';

export function InboxPage() {
  const qc = useQueryClient();
  const inbox = useQuery({ queryKey: ['items', 'inbox'], queryFn: () => api<{ items: ItemSummary[]; total: number }>('/api/items?status=inbox&limit=200&sort=created') });
  const setStatus = async (item: ItemSummary, status: 'library' | 'archived') => {
    const d = await api<any>(`/api/items/${item.id}`);
    await api(`/api/items/${item.id}`, { method: 'PUT', json: { frontmatter: { status }, baseHash: d.item.hash } });
    qc.invalidateQueries();
    toast(status === 'library' ? `Filed “${item.title}” in the library` : `Archived “${item.title}”`, {
      action: { label: 'Undo', run: async () => {
        const d2 = await api<any>(`/api/items/${item.id}`);
        await api(`/api/items/${item.id}`, { method: 'PUT', json: { frontmatter: { status: 'inbox' }, baseHash: d2.item.hash } });
        qc.invalidateQueries();
      } },
    });
  };
  const items = inbox.data?.items ?? [];
  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="font-serif text-[30px] leading-tight">Inbox</h1>
          <p className="text-[14px] text-faded">New captures land here. File them in the library when you've looked at them, or archive them.</p>
        </div>
      </header>
      <DigestPanel />
      {inbox.isSuccess && items.length === 0 && (
        <div className="card mt-3 px-6 py-8 text-[15px] text-ink-soft">
          <Sparkles size={16} className="mb-2 text-brass" />
          Inbox zero. Anything you paste, send from Telegram, or an agent captures will show up here.
        </div>
      )}
      <div className="masonry mt-4">
        {items.map((i) => (
          <ItemCard
            key={i.id}
            item={i}
            footer={
              <div className="flex gap-1">
                <button className="btn btn-sm btn-quiet" onClick={() => void setStatus(i, 'library')}>
                  <Check size={13} /> File in library
                </button>
                <button className="btn btn-sm btn-quiet ml-auto" onClick={() => void setStatus(i, 'archived')} aria-label={`Archive ${i.title}`}>
                  <Archive size={13} /> Archive
                </button>
              </div>
            }
          />
        ))}
      </div>
    </div>
  );
}
