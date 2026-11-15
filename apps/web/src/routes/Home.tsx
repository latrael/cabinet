import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus, Search } from 'lucide-react';
import { api, type ItemSummary, type SearchHit } from '../lib/api.ts';
import { MOD, TYPE_ICON, TYPE_LABEL } from '../lib/meta.ts';
import { openCapture, setUi } from '../lib/store.ts';
import { ItemCard } from '../components/ItemCard.tsx';
import { isUrl } from '../components/CaptureSheet.tsx';
import { ProjectCell } from './Projects.tsx';

interface HomeData {
  interests: { projects: ItemSummary[]; tags: Array<{ tag: string; count: number }> };
  counts: Record<string, number>;
  revisit: ItemSummary[];
  /** Recently opened items. Absent on servers started before this was added. */
  resume?: ItemSummary[];
}

export function HomePage() {
  const home = useQuery({ queryKey: ['home'], queryFn: () => api<HomeData>('/api/home') });
  const d = home.data;
  const inbox = d?.counts.inbox ?? 0;
  const projects = d?.interests.projects ?? [];
  const resume = d?.resume ?? [];
  const empty = !!d && projects.length === 0 && resume.length === 0 && d.revisit.length === 0;
  return (
    <div>
      <div className="mx-auto max-w-[760px] pt-4 pb-12 md:pt-8 md:pb-14">
        <SearchBar />
        {d && inbox > 0 && (
          <Link to="/inbox" className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-ink-soft hover:text-lamp" data-testid="inbox-count">
            <span className="font-bold text-lamp tabular-nums">{inbox}</span>
            {inbox === 1 ? 'item is waiting in your inbox' : 'items are waiting in your inbox'}
            <ArrowRight size={13} aria-hidden />
          </Link>
        )}
      </div>

      {empty && (
        <p className="mx-auto max-w-[760px] font-serif text-[17px] leading-relaxed text-ink-soft">
          Nothing here yet. Paste a link into the bar above, drop in a photo or PDF, or start a project. Everything is saved as plain Markdown in your library folder.
        </p>
      )}

      {resume.length > 0 && (
        <section aria-labelledby="continue" className="mb-12">
          <h2 id="continue" className="section-title">
            Continue
          </h2>
          <div className="item-grid">
            {resume.map((i) => (
              <ItemCard key={i.id} item={i} compact />
            ))}
          </div>
        </section>
      )}

      {d && !empty && (
        <section aria-labelledby="projects" className="mb-12">
          <div className="section-title flex items-baseline justify-between">
            <h2 id="projects" className="[font:inherit] tracking-[inherit]">
              Projects
            </h2>
            <span className="flex gap-4 text-[12px] font-medium tracking-normal normal-case">
              <button className="inline-flex items-center gap-1 text-ink-soft hover:text-lamp" onClick={() => setUi({ palette: true, paletteMode: 'new-project' })}>
                <Plus size={12} aria-hidden /> New project
              </button>
              <Link to="/projects" className="text-ink-soft hover:text-lamp">
                All projects
              </Link>
            </span>
          </div>
          {projects.length === 0 ? (
            <p className="mt-4 font-serif text-[16px] text-faded">No active projects. Start one to keep related things together.</p>
          ) : (
            <div className="item-grid">
              {projects.slice(0, 8).map((p) => (
                <ProjectCell key={p.id} project={p} />
              ))}
            </div>
          )}
        </section>
      )}

      {d && d.revisit.length > 0 && (
        <section aria-labelledby="revisit">
          <div className="section-title flex items-baseline justify-between gap-4">
            <h2 id="revisit" className="[font:inherit] tracking-[inherit]">
              Revisit
            </h2>
            <span className="text-[12px] font-normal tracking-normal text-faded normal-case">Older things you haven't opened in a while. A new pick each day.</span>
          </div>
          <div className="item-grid">
            {d.revisit.map((i) => (
              <ItemCard key={i.id} item={i} compact />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** One bar for both jobs: type to search the library, paste or drop to save something new. */
function SearchBar() {
  const navigate = useNavigate();
  const [v, setV] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(-1);
  const [open, setOpen] = useState(false);
  const text = v.trim();
  const url = isUrl(text);

  useEffect(() => {
    const t = setTimeout(() => setQ(text), 180);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => setSel(-1), [q]);

  const res = useQuery({
    queryKey: ['search', 'home-bar', q],
    enabled: q.length >= 2 && !isUrl(q),
    queryFn: () => api<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=6`),
    placeholderData: (p) => p,
  });
  const hits = text.length >= 2 && !url ? (res.data?.hits ?? []) : [];

  const save = () => {
    setV('');
    if (!text) openCapture({});
    else if (url) openCapture({ url: text });
    else openCapture({ text });
  };
  const seeAll = () => void navigate({ to: '/search', search: { q: text } as any });
  // Rows below the bar, in order: each hit, then "all results", then "save".
  const rows = text && !url ? hits.length + 2 : 0;
  const run = (i: number) => {
    if (i < hits.length) void navigate({ to: '/item/$id', params: { id: hits[i].item.id } });
    else if (i === hits.length) seeAll();
    else save();
  };
  const showPanel = open && rows > 0;

  return (
    <div
      className="relative"
      data-dropzone=""
      onDrop={(e) => {
        const files = [...e.dataTransfer.files];
        if (files.length) {
          e.preventDefault();
          openCapture({ files });
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}
    >
      <div className="flex items-center gap-3 border-b-2 border-ink pb-2 focus-within:border-lamp">
        <Search size={22} strokeWidth={1.6} className="shrink-0 text-faded" aria-hidden />
        <input
          className="min-w-0 flex-1 bg-transparent font-serif text-[24px] leading-tight text-ink placeholder:text-faded/70 focus:outline-none md:text-[30px]"
          placeholder="Search, or paste a link to save it"
          value={v}
          onChange={(e) => {
            setV(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (!text || url || e.metaKey || e.ctrlKey) save();
              else if (sel >= 0) run(sel);
              else seeAll();
            } else if (e.key === 'ArrowDown' && rows) {
              e.preventDefault();
              setSel((s) => (s + 1) % rows);
            } else if (e.key === 'ArrowUp' && rows) {
              e.preventDefault();
              setSel((s) => (s <= 0 ? rows - 1 : s - 1));
            } else if (e.key === 'Escape') {
              setV('');
            }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              openCapture({ files });
              return;
            }
            const pasted = e.clipboardData.getData('text/plain');
            if (isUrl(pasted)) {
              e.preventDefault();
              openCapture({ url: pasted.trim() });
            }
          }}
          aria-label="Search or save"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="home-bar-results"
          data-testid="paste-strip"
        />
      </div>
      <p className="mt-2 text-[12px] text-faded">
        {url ? 'Press Enter to save this link.' : `Type to search. Paste a link, drop a file, or press ${MOD} Enter to save what you typed.`}
      </p>

      {showPanel && (
        <ul id="home-bar-results" role="listbox" className="card absolute inset-x-0 top-[calc(100%-22px)] z-20 py-1 shadow-[var(--shadow-lift)]" data-testid="home-bar-results">
          {hits.map((h, i) => {
            const Icon = TYPE_ICON[h.item.type];
            return (
              <Row key={h.item.id} active={sel === i} onHover={() => setSel(i)} onRun={() => run(i)}>
                <Icon size={14} strokeWidth={1.7} className="shrink-0 text-faded" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-serif text-[16px]">{h.item.title}</span>
                <span className="kicker shrink-0">{TYPE_LABEL[h.item.type]}</span>
              </Row>
            );
          })}
          {hits.length === 0 && res.isSuccess && q === text && <li className="px-4 py-2 text-[13px] text-faded">Nothing in your library matches “{text}”.</li>}
          <Row active={sel === hits.length} onHover={() => setSel(hits.length)} onRun={seeAll} divider>
            <Search size={14} strokeWidth={1.7} className="shrink-0 text-faded" aria-hidden />
            <span className="flex-1 text-[13.5px]">See all results</span>
            <span className="kbd">Enter</span>
          </Row>
          <Row active={sel === hits.length + 1} onHover={() => setSel(hits.length + 1)} onRun={save}>
            <Plus size={14} strokeWidth={1.7} className="shrink-0 text-faded" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[13.5px]">Save “{text}” as a note</span>
            <span className="kbd">{MOD} Enter</span>
          </Row>
        </ul>
      )}
    </div>
  );
}

function Row({ active, divider, onHover, onRun, children }: { active: boolean; divider?: boolean; onHover: () => void; onRun: () => void; children: React.ReactNode }) {
  return (
    <li role="option" aria-selected={active} className={divider ? 'mt-1 border-t border-rule pt-1' : ''}>
      <button
        type="button"
        className={`flex w-full items-center gap-3 px-4 py-2 text-left ${active ? 'bg-paper-deep' : ''}`}
        onMouseEnter={onHover}
        // mousedown, not click: the input's blur would close the list first
        onMouseDown={(e) => {
          e.preventDefault();
          onRun();
        }}
      >
        {children}
      </button>
    </li>
  );
}
