import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type ItemSummary } from '../lib/api.ts';
import { TYPE_LABEL } from '../lib/meta.ts';
import { GraphCanvas, GRAPH_LEGEND, type GraphData } from '../components/GraphCanvas.tsx';

const FILTERS = [
  { label: 'notes', types: ['note'] },
  { label: 'sources', types: ['article', 'link', 'quote', 'text', 'video', 'image', 'pdf', 'audio'] },
  { label: 'projects', types: ['project', 'collection'] },
  { label: 'memories', types: ['memory'] },
];

export function GraphPage() {
  const s = useSearch({ strict: false }) as { focus?: string; depth?: number };
  const navigate = useNavigate();
  const recent = useQuery({ queryKey: ['items', 'graph-default'], queryFn: () => api<{ items: ItemSummary[] }>('/api/items?type=project&sort=updated&limit=1'), enabled: !s.focus });
  const focus = s.focus ?? recent.data?.items[0]?.id;
  const [depth, setDepth] = useState(s.depth ?? 2);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  useEffect(() => {
    setExpanded([]);
    setSelected(undefined);
  }, [focus]);
  const types = FILTERS.filter((f) => !off.has(f.label)).flatMap((f) => f.types);
  const tq = off.size ? `&types=${types.join(',')}` : '';
  const graph = useQuery({
    queryKey: ['graph-page', focus, depth, tq, expanded],
    enabled: !!focus,
    placeholderData: (p) => p,
    queryFn: async () => {
      const base = await api<GraphData>(`/api/items/${focus}/graph?depth=${depth}${tq}`);
      // Clicking a node expands one hop outward from it.
      const extra = await Promise.all(expanded.map((id) => api<GraphData>(`/api/items/${id}/graph?depth=1${tq}`)));
      const nodes = new Map(base.nodes.map((n) => [n.id, n]));
      const edges = new Map(base.edges.map((e) => [e.source + '>' + e.target, e]));
      for (const g of extra) {
        for (const n of g.nodes) nodes.set(n.id, n);
        for (const e of g.edges) edges.set(e.source + '>' + e.target, e);
      }
      return { center: base.center, nodes: [...nodes.values()], edges: [...edges.values()] };
    },
  });
  const sel = graph.data?.nodes.find((n) => n.id === selected) ?? graph.data?.nodes.find((n) => n.id === graph.data?.center);
  return (
    <div>
      <header className="mb-4 flex flex-wrap items-end gap-4">
        <div className="mr-auto">
          <h1 className="font-serif text-[30px] leading-tight">Graph</h1>
          <p className="text-[14px] text-faded">Click a node to expand from it. Double-click to open it. Drag to move, scroll to zoom.</p>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-ink-soft">
          Depth
          <select className="field !w-auto text-[13px]" value={depth} onChange={(e) => setDepth(Number(e.target.value))} data-testid="graph-depth">
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.label}
              className={`chip ${off.has(f.label) ? '' : 'chip-active'}`}
              aria-pressed={!off.has(f.label)}
              onClick={() => setOff((o) => (o.has(f.label) ? new Set([...o].filter((x) => x !== f.label)) : new Set([...o, f.label])))}
            >
              {f.label}
            </button>
          ))}
        </div>
      </header>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="card overflow-hidden">
          <GraphCanvas
            data={graph.data}
            height={620}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              setExpanded((e) => (e.includes(id) || id === focus ? e : [...e, id]));
            }}
            onOpen={(id) => navigate({ to: '/item/$id', params: { id } })}
          />
        </div>
        <aside>
          {sel && (
            <div className="card mt-3 p-4">
              <div className="text-[12px] text-faded">{TYPE_LABEL[sel.type]}</div>
              <h2 className="font-serif text-[18px]">{sel.title}</h2>
              {sel.excerpt && <p className="mt-1 line-clamp-4 text-[13px] text-ink-soft">{sel.excerpt}</p>}
              <div className="mt-3 flex gap-2">
                <Link to="/item/$id" params={{ id: sel.id }} className="btn btn-sm">
                  Open
                </Link>
                {sel.id !== focus && (
                  <button className="btn btn-sm" onClick={() => navigate({ to: '/graph', search: { focus: sel.id, depth } as any })}>
                    Center here
                  </button>
                )}
              </div>
            </div>
          )}
          <ul className="mt-5 flex flex-col gap-1.5 text-[13px] text-ink-soft">
            {GRAPH_LEGEND.map((l) => (
              <li key={l.label} className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full border-[1.5px]" style={{ borderColor: l.color, background: l.hollow ? '#fcfbf8' : l.color }} />
                {l.label}
              </li>
            ))}
            <li className="flex items-center gap-2">
              <span className="inline-block h-0.5 w-4 bg-ink/60" /> project material
            </li>
          </ul>
          <p className="mt-4 text-[12.5px] text-faded">{graph.data?.nodes.length ?? 0} items shown</p>
        </aside>
      </div>
    </div>
  );
}
