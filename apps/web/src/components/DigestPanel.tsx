import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { api, type ItemSummary, type Suggestion } from '../lib/api.ts';
import { relTime, TYPE_ICON } from '../lib/meta.ts';
import { toast } from '../lib/store.ts';

/** The inbox agent's latest digest: triage proposals to accept or dismiss, and revisit picks. */
export function DigestPanel() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => api<any>('/api/ai/status') });
  const digests = useQuery({ queryKey: ['digests'], queryFn: () => api<{ digests: Array<{ id: string; created: string; payload: any; status: string }> }>('/api/digests') });
  const triage = useQuery({
    queryKey: ['suggestions', 'triage'],
    queryFn: () => api<{ suggestions: Array<Suggestion & { item: ItemSummary }> }>('/api/suggestions?status=pending'),
    select: (d) => d.suggestions.filter((s) => s.kind === 'triage'),
  });
  const [running, setRunning] = useState(false);
  const d = digests.data?.digests[0];
  const revisitIds: string[] = d?.payload?.revisit ?? [];
  const revisit = useQuery({
    queryKey: ['digest-revisit', d?.id],
    enabled: revisitIds.length > 0,
    queryFn: async () => (await Promise.all(revisitIds.map((id) => api<any>(`/api/items/${id}`).catch(() => null)))).filter(Boolean).map((x) => x.item),
  });
  const act = async (s: Suggestion, a: 'accept' | 'dismiss') => {
    try {
      await api(`/api/suggestions/${s.id}/${a}`, { method: 'POST' });
      qc.invalidateQueries();
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };
  if (status.data?.provider === 'none' || (!d && !status.data?.chat)) return null;
  return (
    <section className="mb-6 border border-lamp/30 bg-lamp-wash/40 px-5 py-4" data-testid="digest">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={15} className="text-brass" />
        <h2 className="font-serif text-[17px]">Inbox agent</h2>
        {d && <span className="text-[12px] text-faded">last run {relTime(d.created)}</span>}
        <button
          className="btn btn-sm ml-auto"
          disabled={running || !status.data?.chat}
          onClick={async () => {
            setRunning(true);
            try {
              await api('/api/digests/run', { method: 'POST' });
              qc.invalidateQueries();
            } catch (e) {
              toast((e as Error).message, { tone: 'error' });
            } finally {
              setRunning(false);
            }
          }}
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : null} {running ? 'Sorting the inbox…' : 'Sort my inbox now'}
        </button>
      </div>
      {d && <p className="mt-1.5 text-[14px] text-ink-soft">{d.payload.summary}</p>}
      {(triage.data?.length ?? 0) > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {triage.data!.map((s) => {
            const Icon = TYPE_ICON[s.item.type];
            return (
              <li key={s.id} className="flex items-start gap-2.5 bg-card px-3 py-2 text-[13.5px] shadow-[var(--shadow-card)]" data-testid="triage">
                <Icon size={14} className="mt-0.5 shrink-0 text-faded" />
                <div className="min-w-0 flex-1">
                  <Link to="/item/$id" params={{ id: s.item.id }} className="font-serif text-[15px] hover:text-lamp">
                    {s.item.title}
                  </Link>
                  <div className="text-ink">{s.payload.label}</div>
                  {s.payload.reason && <div className="text-[12.5px] text-faded">{s.payload.reason}</div>}
                </div>
                <button className="btn btn-sm" onClick={() => void act(s, 'accept')} aria-label={`Accept: ${s.payload.label}`}>
                  <Check size={13} /> Do it
                </button>
                <button className="btn btn-sm btn-quiet" onClick={() => void act(s, 'dismiss')} aria-label="Dismiss">
                  <X size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {(revisit.data?.length ?? 0) > 0 && (
        <div className="mt-3 text-[13px] text-ink-soft">
          Worth revisiting:{' '}
          {revisit.data!.map((i: any, n: number) => (
            <span key={i.id}>
              {n > 0 && ', '}
              <Link to="/item/$id" params={{ id: i.id }} className="font-serif text-lamp hover:underline">
                {i.title}
              </Link>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
