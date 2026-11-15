import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderKanban, RefreshCcw, Sparkles } from 'lucide-react';
import { api, thumbUrl, type ItemSummary } from '../lib/api.ts';
import { MOD } from '../lib/meta.ts';
import { openCapture } from '../lib/store.ts';
import { ItemCard } from '../components/ItemCard.tsx';
import { isUrl } from '../components/CaptureSheet.tsx';

interface HomeData {
  interests: { projects: ItemSummary[]; tags: Array<{ tag: string; count: number }> };
  recent: ItemSummary[];
  counts: Record<string, number>;
  revisit: ItemSummary[];
  digest: { id: string; created: string; payload: any; status: string } | null;
}

export function HomePage() {
  const home = useQuery({ queryKey: ['home'], queryFn: () => api<HomeData>('/api/home') });
  const d = home.data;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <div>
      <p className="mb-1 font-serif text-[15px] text-faded italic">{today}</p>
      <PasteStrip />

      <div className="mt-10 grid gap-10 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-labelledby="recent">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 id="recent" className="section-title">
              Recently saved
            </h2>
            <Link to="/library" className="text-[13px] text-lamp hover:underline">
              Open the library
            </Link>
          </div>
          {d && d.recent.length === 0 && <EmptyHome />}
          <div className="masonry">
            {d?.recent.map((i) => (
              <ItemCard key={i.id} item={i} />
            ))}
          </div>
        </section>

        <aside className="flex flex-col gap-8">
          {d && (
            <Link to="/inbox" className="card card-interactive mt-3 block px-4 py-3.5" data-testid="inbox-count">
              <div className="font-serif text-[30px] leading-none text-lamp">{d.counts.inbox ?? 0}</div>
              <div className="mt-1 text-[13.5px] text-ink-soft">{d.counts.inbox === 1 ? 'item waits' : 'items wait'} in your inbox</div>
            </Link>
          )}

          {d?.digest && d.digest.status === 'new' && (
            <Link to="/inbox" className="block rounded-[3px] border border-lamp/40 bg-lamp-wash/60 px-4 py-3 text-[13.5px] text-lamp-deep">
              <Sparkles size={14} className="mr-1.5 inline" />
              {d.digest.payload?.summary ?? 'A new inbox digest is ready.'}
            </Link>
          )}

          <section aria-labelledby="interests">
            <h2 id="interests" className="section-title mb-3">
              On your mind
            </h2>
            <ul className="flex flex-col gap-2">
              {d?.interests.projects.map((p) => (
                <li key={p.id}>
                  <Link to="/item/$id" params={{ id: p.id }} className="group flex items-center gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[2px] bg-paper-deep shadow-[var(--shadow-card)]">
                      {p.cover ? <img src={thumbUrl(p.cover, 120)} alt="" className="h-full w-full object-cover" /> : <FolderKanban size={16} className="text-faded" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-serif text-[15.5px] group-hover:text-lamp">{p.title}</span>
                      <span className="block truncate text-[12.5px] text-faded">{p.excerpt}</span>
                    </span>
                  </Link>
                </li>
              ))}
              {d && d.interests.projects.length === 0 && <li className="text-[13.5px] text-faded">Start a project to keep related things together.</li>}
            </ul>
            {d && d.interests.tags.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {d.interests.tags.slice(0, 10).map((t) => (
                  <Link key={t.tag} to="/library" search={{ tag: t.tag } as any} className="chip hover:bg-card">
                    #{t.tag}
                  </Link>
                ))}
              </div>
            )}
          </section>

          {d && d.revisit.length > 0 && (
            <section aria-labelledby="revisit">
              <div className="mb-1 flex items-baseline gap-2">
                <h2 id="revisit" className="section-title">
                  Revisit
                </h2>
                <RefreshCcw size={13} className="text-faded" aria-hidden />
              </div>
              <p className="mb-2 text-[12.5px] text-faded">Older things you haven't opened in a while. A new pick each day.</p>
              <div className="flex flex-col gap-1">
                {d.revisit.map((i) => (
                  <ItemCard key={i.id} item={i} compact />
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function PasteStrip() {
  const [v, setV] = useState('');
  const submit = () => {
    const t = v.trim();
    if (!t) return openCapture({});
    setV('');
    if (isUrl(t)) openCapture({ url: t });
    else openCapture({ text: t });
  };
  return (
    <div className="card mt-4 flex items-center gap-3 px-5 py-4" data-dropzone="" onDrop={(e) => {
      const files = [...e.dataTransfer.files];
      if (files.length) {
        e.preventDefault();
        openCapture({ files });
      }
    }} onDragOver={(e) => e.preventDefault()}>
      <input
        className="min-w-0 flex-1 bg-transparent font-serif text-[22px] leading-tight text-ink placeholder:text-faded/80 focus:outline-none md:text-[26px]"
        placeholder="Paste a link, drop a file, or jot a thought"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            openCapture({ files });
            return;
          }
          const text = e.clipboardData.getData('text/plain');
          if (isUrl(text)) {
            e.preventDefault();
            openCapture({ url: text.trim() });
          }
        }}
        aria-label="Capture"
        data-testid="paste-strip"
      />
      <span className="hidden shrink-0 text-[12.5px] text-faded md:inline">
        or press <span className="kbd">{MOD} V</span> anywhere
      </span>
    </div>
  );
}

function EmptyHome() {
  return (
    <div className="card mt-3 px-6 py-8">
      <h3 className="font-serif text-[18px]">Your cabinet is empty</h3>
      <p className="mt-1 max-w-prose text-[14px] text-ink-soft">
        Paste a link above, drop in a photo or PDF, or start a project. Everything is saved as plain Markdown in your library folder.
      </p>
    </div>
  );
}
