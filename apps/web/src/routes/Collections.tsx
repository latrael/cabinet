import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Shapes } from 'lucide-react';
import { api, thumbUrl, type ItemDetail, type ItemSummary } from '../lib/api.ts';
import type { useItem } from '../lib/useItem.ts';
import { ItemCard, TypeTab } from '../components/ItemCard.tsx';
import { Editor } from '../editor/Editor.tsx';
import { ItemMenu } from './ItemPage.tsx';

interface Coll {
  name: string;
  count: number;
  doc: ItemSummary | null;
  sample: ItemSummary[];
}

export function CollectionsPage() {
  const q = useQuery({ queryKey: ['collections'], queryFn: () => api<{ collections: Coll[] }>('/api/collections') });
  return (
    <div>
      <header className="mb-6">
        <h1 className="font-serif text-[30px] leading-tight">Collections</h1>
        <p className="text-[14px] text-faded">Loose groupings. Add any item to a collection from its page or while saving.</p>
      </header>
      {q.isSuccess && q.data.collections.length === 0 && <p className="text-[15px] text-faded">No collections yet.</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-6">
        {q.data?.collections.map((c) => {
          const covers = [c.doc?.cover, ...c.sample.map((s) => s.cover ?? (s.type === 'image' ? s.attachment : undefined))].filter(Boolean).slice(0, 3) as string[];
          return (
            <Link key={c.name} to="/collections/$name" params={{ name: c.name }} className="card card-interactive mt-3 block">
              <TypeTab type="collection" />
              <div className="flex h-28 gap-px overflow-hidden rounded-t-[2px] bg-paper-deep">
                {covers.length ? covers.map((src) => <img key={src} src={thumbUrl(src, 300)} alt="" className="h-full min-w-0 flex-1 object-cover" />) : <Shapes className="m-auto text-faded" />}
              </div>
              <div className="px-4 py-3">
                <h3 className="font-serif text-[18px]">{c.name}</h3>
                <p className="text-[12.5px] text-faded">
                  {c.count} {c.count === 1 ? 'item' : 'items'}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function CollectionPage() {
  const { name } = useParams({ strict: false }) as { name: string };
  const qc = useQueryClient();
  const items = useQuery({ queryKey: ['items', 'collection', name], queryFn: () => api<{ items: ItemSummary[] }>(`/api/items?collection=${encodeURIComponent(name)}&limit=500`) });
  const doc = useQuery({ queryKey: ['collections'], queryFn: () => api<{ collections: Coll[] }>('/api/collections') });
  const c = doc.data?.collections.find((x) => x.name === name);
  const [desc, setDesc] = useState('');
  return (
    <div>
      <header className="mb-6">
        <span className="text-[12.5px] font-semibold text-brass">Collection</span>
        <h1 className="font-serif text-[32px] leading-tight">{name}</h1>
        {c?.doc ? (
          <p className="mt-1 max-w-prose font-serif text-[16px] text-ink-soft">
            {c.doc.excerpt}{' '}
            <Link to="/item/$id" params={{ id: c.doc.id }} className="text-[13px] text-lamp hover:underline">
              Edit description
            </Link>
          </p>
        ) : (
          <form
            className="mt-2 flex max-w-xl gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              await api('/api/items', { method: 'POST', json: { type: 'collection', title: name, body: desc } });
              qc.invalidateQueries();
            }}
          >
            <input className="field text-[14px]" placeholder="Add a description (creates collections/…md)" value={desc} onChange={(e) => setDesc(e.target.value)} />
            <button className="btn" disabled={!desc.trim()}>
              Save
            </button>
          </form>
        )}
      </header>
      <div className="masonry">
        {items.data?.items.filter((i) => i.type !== 'collection').map((i) => <ItemCard key={i.id} item={i} />)}
      </div>
    </div>
  );
}

/** A collection's own Markdown file (description + cover). */
export function CollectionView({ it }: { it: ReturnType<typeof useItem> }) {
  const d = it.data as ItemDetail;
  const [body, setBody] = useState(d.item.body);
  useEffect(() => setBody(d.item.body), [d.item.body]);
  const members = useQuery({ queryKey: ['items', 'collection', d.item.title], queryFn: () => api<{ items: ItemSummary[] }>(`/api/items?collection=${encodeURIComponent(d.item.title)}&limit=500`) });
  return (
    <div>
      <div className="mb-1 flex items-center">
        <span className="text-[12.5px] font-semibold text-brass">Collection</span>
        <span className="ml-auto">
          <ItemMenu item={d.item} />
        </span>
      </div>
      <h1 className="font-serif text-[32px] leading-tight">{d.item.title}</h1>
      <div className="mt-2 max-w-2xl" onBlur={() => body !== d.item.body && void it.mutate(() => ({ body }))}>
        <Editor value={body} onChange={setBody} placeholder="Describe this collection" ariaLabel="Collection description" />
      </div>
      <div className="masonry mt-8">
        {members.data?.items.filter((i) => i.id !== d.item.id).map((i) => <ItemCard key={i.id} item={i} />)}
      </div>
    </div>
  );
}
