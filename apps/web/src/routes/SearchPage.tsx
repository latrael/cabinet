import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { MATCH_LABELS } from '@cabinet/core/types';
import { api, type SearchHit } from '../lib/api.ts';
import { SOURCE_FILTERS, TYPE_ICON, TYPE_LABEL } from '../lib/meta.ts';

function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith('«') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

export function SearchPage() {
  const s = useSearch({ strict: false }) as { q?: string; type?: string };
  const navigate = useNavigate();
  const [q, setQ] = useState(s.q ?? '');
  useEffect(() => setQ(s.q ?? ''), [s.q]);
  const res = useQuery({
    queryKey: ['search', s.q, s.type],
    enabled: !!s.q,
    queryFn: () => api<{ hits: SearchHit[]; mode: string; ms: number }>(`/api/search?q=${encodeURIComponent(s.q!)}${s.type ? `&type=${s.type}` : ''}`),
    placeholderData: (p) => p,
  });
  const submit = (v: string) => navigate({ to: '/search', search: { ...s, q: v || undefined } as any, replace: true });
  useEffect(() => {
    const t = setTimeout(() => q !== (s.q ?? '') && submit(q), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  return (
    <div className="max-w-3xl">
      <h1 className="mb-4 font-serif text-[30px] leading-tight">Search</h1>
      <div className="card flex items-center gap-3 px-4">
        <Search size={18} className="text-faded" />
        <input className="h-12 flex-1 bg-transparent font-serif text-[19px] focus:outline-none" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Words, ideas, half-remembered titles" aria-label="Search" data-testid="search-input" />
      </div>
      <div className="mt-3 mb-5 flex flex-wrap gap-1.5">
        <button className={`chip ${!s.type ? 'chip-active' : ''}`} onClick={() => navigate({ to: '/search', search: { q: s.q } as any })}>
          everything
        </button>
        {[...SOURCE_FILTERS, 'project' as const].map((t) => (
          <button key={t} className={`chip ${s.type === t ? 'chip-active' : ''}`} onClick={() => navigate({ to: '/search', search: { q: s.q, type: s.type === t ? undefined : t } as any })}>
            {TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      {res.data && (
        <p className="mb-3 text-[12.5px] text-faded" data-testid="search-meta">
          {res.data.hits.length} {res.data.hits.length === 1 ? 'result' : 'results'} in {res.data.ms} ms,{' '}
          {res.data.mode === 'hybrid' ? 'matching words and meaning' : 'matching words (meaning search is offline)'}
        </p>
      )}
      <ol className="flex flex-col" data-testid="search-results">
        {res.data?.hits.map((h) => {
          const Icon = TYPE_ICON[h.item.type];
          return (
            <li key={h.item.id} className="border-b border-rule py-3.5">
              <Link to="/item/$id" params={{ id: h.item.id }} className="group block">
                <div className="flex items-baseline gap-2">
                  <Icon size={14} className="shrink-0 translate-y-0.5 text-faded" />
                  <span className="font-serif text-[17px] group-hover:text-lamp">{h.item.title}</span>
                  <span className="ml-auto shrink-0 bg-paper-deep px-1.5 text-[11.5px] text-ink-soft" data-testid="match-field">
                    matched {MATCH_LABELS[h.field]}
                  </span>
                </div>
                {h.snippet && (
                  <p className="mt-1 pl-6 text-[14px] leading-relaxed text-ink-soft">
                    <Snippet text={h.snippet} />
                  </p>
                )}
              </Link>
            </li>
          );
        })}
      </ol>
      {res.data && res.data.hits.length === 0 && <p className="font-serif text-[16px] text-faded">Nothing found. Try fewer or different words.</p>}
    </div>
  );
}
