import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Check, FolderKanban, Link2, Plus, Sparkles, X } from 'lucide-react';
import { api, type ItemDetail, type RelatedHit, type Suggestion } from '../lib/api.ts';
import { TYPE_ICON } from '../lib/meta.ts';
import { toast } from '../lib/store.ts';
import { GraphCanvas, type GraphData } from './GraphCanvas.tsx';

function Section({ title, count, children, testid }: { title: string; count?: number; children: React.ReactNode; testid?: string }) {
  return (
    <section className="border-t border-rule pt-3 pb-4" data-testid={testid}>
      <h3 className="mb-2 flex items-baseline gap-2 font-sans text-[13px] font-semibold text-ink-soft">
        {title}
        {count !== undefined && <span className="font-normal text-faded">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function Row({ id, title, type, note, icon }: { id: string; title: string; type: any; note?: React.ReactNode; icon?: React.ReactNode }) {
  const Icon = TYPE_ICON[type as keyof typeof TYPE_ICON] ?? Link2;
  return (
    <Link to="/item/$id" params={{ id }} className="group flex gap-2 px-1.5 py-1 hover:bg-card">
      <span className="mt-[3px] text-faded">{icon ?? <Icon size={13} strokeWidth={1.7} />}</span>
      <span className="min-w-0">
        <span className="block font-serif text-[14.5px] leading-snug group-hover:text-lamp">{title}</span>
        {note && <span className="block text-[12.5px] leading-snug text-faded">{note}</span>}
      </span>
    </Link>
  );
}

export function SuggestionTray({ suggestions, itemId }: { suggestions: Suggestion[]; itemId: string }) {
  const qc = useQueryClient();
  const act = async (s: Suggestion, action: 'accept' | 'dismiss') => {
    try {
      await api(`/api/suggestions/${s.id}/${action}`, { method: 'POST' });
      qc.invalidateQueries();
      if (action === 'accept') toast('Added to the file', { tone: 'ok' });
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };
  if (!suggestions.length) return null;
  const describe = (s: Suggestion): React.ReactNode => {
    switch (s.kind) {
      case 'tags':
        return (
          <>
            Tag with {(s.payload.tags as string[]).map((t) => (
              <span key={t} className="text-lamp">
                #{t}{' '}
              </span>
            ))}
          </>
        );
      case 'summary':
        return <>Summary: “{s.payload.summary}”</>;
      case 'link':
        return (
          <>
            Link to <strong className="font-semibold">{s.payload.title}</strong>
            {s.payload.reason ? <span className="text-faded"> · {s.payload.reason}</span> : null}
          </>
        );
      case 'collection':
        return <>Add to collection “{s.payload.collection}”</>;
      case 'triage':
        return <>{s.payload.label ?? s.payload.action}</>;
      default:
        return <>{JSON.stringify(s.payload)}</>;
    }
  };
  return (
    <Section title="Suggestions" count={suggestions.length} testid="suggestions">
      <p className="mb-2 text-[12px] text-faded">Proposed by the local model. Nothing changes until you accept.</p>
      <ul className="flex flex-col gap-1.5" data-item-id={itemId}>
        {suggestions.map((s) => (
          <li key={s.id} className="flex items-start gap-2 bg-card px-2 py-1.5 text-[13px] shadow-[var(--shadow-card)]">
            <Sparkles size={13} className="mt-0.5 shrink-0 text-brass" />
            <span className="min-w-0 flex-1 leading-snug">{describe(s)}</span>
            <button className="text-lamp hover:text-lamp-deep" onClick={() => void act(s, 'accept')} aria-label="Accept suggestion">
              <Check size={15} />
            </button>
            <button className="text-faded hover:text-ink" onClick={() => void act(s, 'dismiss')} aria-label="Dismiss suggestion">
              <X size={15} />
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function ConnectionsPanel({ detail }: { detail: ItemDetail }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { item } = detail;
  const graph = useQuery({ queryKey: ['graph', item.id, 1], queryFn: () => api<GraphData>(`/api/items/${item.id}/graph?depth=1`) });
  const related = useQuery({ queryKey: ['related-item', item.id], queryFn: () => api<{ hits: RelatedHit[] }>(`/api/items/${item.id}/related`), staleTime: 60_000 });
  const backlinks = detail.backlinks.filter((b) => b.kind !== 'material');
  const outgoing = detail.outgoing.filter((o) => o.kind !== 'embed' || !o.item || o.item.id !== item.id);
  const link = async (targetId: string) => {
    await api(`/api/items/${item.id}/link`, { method: 'POST', json: { targetId } });
    qc.invalidateQueries();
    toast('Linked', { tone: 'ok' });
  };
  const createFromLink = async (title: string) => {
    const d = await api<ItemDetail>('/api/items', { method: 'POST', json: { type: 'note', title } });
    qc.invalidateQueries();
    navigate({ to: '/item/$id', params: { id: d.item.id }, search: { edit: 1 } as any });
  };
  return (
    <div className="text-[14px]" data-testid="connections">
      {detail.projects.length > 0 && (
        <Section title="In projects" count={detail.projects.length} testid="in-projects">
          {detail.projects.map((p) => (
            <Row
              key={p.projectId + (p.section ?? '')}
              id={p.projectId}
              title={p.project.title}
              type="project"
              icon={<FolderKanban size={13} />}
              note={
                <>
                  {p.section && <span>{p.section}</span>}
                  {p.section && p.context && ': '}
                  {p.context && <span className="italic">{p.context}</span>}
                </>
              }
            />
          ))}
        </Section>
      )}
      <Section title="Linked from" count={backlinks.length} testid="backlinks">
        {backlinks.length === 0 ? (
          <p className="text-[13px] text-faded">Nothing links here yet.</p>
        ) : (
          backlinks.map((b) => <Row key={b.sourceId + b.kind} id={b.item.id} title={b.item.title} type={b.item.type} icon={<ArrowDownLeft size={13} />} note={b.item.why ?? b.item.excerpt?.slice(0, 90)} />)
        )}
      </Section>
      <Section title="Links to" count={outgoing.length} testid="outgoing">
        {outgoing.length === 0 ? (
          <p className="text-[13px] text-faded">Type [[ in your notes to link something.</p>
        ) : (
          outgoing.map((o, i) =>
            o.item ? (
              <Row key={i} id={o.item.id} title={o.item.title} type={o.item.type} icon={<ArrowUpRight size={13} />} note={o.context} />
            ) : (
              <div key={i} className="flex items-center gap-2 px-1.5 py-1 text-[13.5px] text-faded">
                <ArrowUpRight size={13} />
                <span className="flex-1 truncate font-serif">{o.target}</span>
                {o.kind !== 'embed' && (
                  <button className="btn btn-sm btn-quiet" onClick={() => void createFromLink(o.target)}>
                    <Plus size={12} /> Create
                  </button>
                )}
              </div>
            ),
          )
        )}
      </Section>
      <SuggestionTray suggestions={detail.suggestions} itemId={item.id} />
      {(related.data?.hits.length ?? 0) > 0 && (
        <Section title="Related" testid="related">
          {related.data!.hits.slice(0, 6).map((h) => (
            <div key={h.item.id} className="group flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <Row id={h.item.id} title={h.item.title} type={h.item.type} note={h.reason === 'similar meaning' ? 'similar meaning' : 'shared words'} />
              </div>
              <button className="btn btn-sm btn-quiet mt-1 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => void link(h.item.id)} aria-label={`Link to ${h.item.title}`}>
                <Link2 size={12} /> Link
              </button>
            </div>
          ))}
        </Section>
      )}
      <Section title="Neighbourhood">
        <div className=" border border-rule bg-card/70">
          <GraphCanvas data={graph.data} height={210} labels={false} onSelect={(id) => id !== item.id && navigate({ to: '/item/$id', params: { id } })} />
        </div>
        <Link to="/graph" search={{ focus: item.id } as any} className="mt-1.5 inline-block text-[12.5px] text-lamp hover:underline">
          Explore in the graph
        </Link>
      </Section>
    </div>
  );
}
