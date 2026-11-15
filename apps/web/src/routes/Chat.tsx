import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Loader2, NotebookPen, Plus, Search, BookOpen } from 'lucide-react';
import { linkKey } from '@cabinet/core/links';
import { api, type ItemDetail } from '../lib/api.ts';
import { renderMarkdown } from '../lib/markdown.ts';
import { relTime } from '../lib/meta.ts';
import { toast } from '../lib/store.ts';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  items?: Record<string, { id: string; title: string; type: string }>;
  tools?: Array<{ name: string; input: any }>;
  error?: string;
}

function Answer({ msg }: { msg: Msg }) {
  const navigate = useNavigate();
  const html = useMemo(() => {
    const items = new Map(Object.entries(msg.items ?? {}).map(([k, v]) => [linkKey(k), v]));
    return renderMarkdown(msg.content, (t) => {
      const i = items.get(linkKey(t));
      return i ? { id: i.id, title: i.title } : null;
    });
  }, [msg]);
  return (
    <div
      className="prose-cabinet !text-[16.5px]"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a.wikilink') as HTMLAnchorElement | null;
        if (a?.dataset.id) {
          e.preventDefault();
          navigate({ to: '/item/$id', params: { id: a.dataset.id } });
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function toolLabel(t: { name: string; input: any }) {
  if (t.name === 'search') return `Searched for “${t.input?.query ?? ''}”`;
  if (t.name === 'get_item') return `Read ${t.input?.ref ?? 'an item'}`;
  if (t.name === 'list_projects') return 'Looked at your projects';
  if (t.name === 'list_recent') return 'Looked at recent saves';
  return t.name;
}

export function ChatPage() {
  const s = useSearch({ strict: false }) as { id?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => api<any>('/api/ai/status') });
  const chats = useQuery({ queryKey: ['chats'], queryFn: () => api<{ chats: Array<{ id: string; title: string; updated: string }> }>('/api/chats') });
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (s.id && s.id !== chatId) {
      api<{ messages: Msg[] }>(`/api/chats/${s.id}`).then((c) => {
        setMsgs(c.messages);
        setChatId(s.id);
      });
    }
    if (!s.id) {
      setMsgs([]);
      setChatId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const history: Msg[] = [...msgs, { role: 'user', content: text.trim() }];
    setMsgs([...history, { role: 'assistant', content: '', tools: [] }]);
    setInput('');
    setBusy(true);
    const update = (fn: (m: Msg) => Msg) => setMsgs((all) => [...all.slice(0, -1), fn(all[all.length - 1])]);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, messages: history.map((m) => ({ role: m.role, content: m.content })) }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).message ?? `Chat failed (${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.t === 'text') update((m) => ({ ...m, content: m.content + ev.v }));
          else if (ev.t === 'tool') update((m) => ({ ...m, tools: [...(m.tools ?? []), { name: ev.name, input: ev.input }] }));
          else if (ev.t === 'items') update((m) => ({ ...m, items: ev.items }));
          else if (ev.t === 'error') update((m) => ({ ...m, error: ev.message }));
          else if (ev.t === 'done') {
            setChatId(ev.chatId);
            if (!chatId) navigate({ to: '/chat', search: { id: ev.chatId } as any, replace: true });
            qc.invalidateQueries({ queryKey: ['chats'] });
          }
        }
      }
    } catch (e) {
      update((m) => ({ ...m, error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  async function saveAsNote(i: number) {
    const q = msgs[i - 1]?.content ?? 'Answer';
    const a = msgs[i];
    const title = q.length > 70 ? q.slice(0, 67).replace(/\s+\S*$/, '') + '…' : q;
    const d = await api<ItemDetail>('/api/items', { method: 'POST', json: { type: 'note', title, body: `${a.content}\n\n> Asked Cabinet: ${q}\n` } });
    toast('Saved as a note', { tone: 'ok', action: { label: 'Open', run: () => navigate({ to: '/item/$id', params: { id: d.item.id } }) } });
  }

  const ready = status.data?.chat;
  return (
    <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="hidden lg:block">
        <Link to="/chat" search={{} as any} className="btn btn-sm mb-3">
          <Plus size={13} /> New conversation
        </Link>
        <ul className="flex flex-col">
          {chats.data?.chats.map((c) => (
            <li key={c.id}>
              <Link to="/chat" search={{ id: c.id } as any} className={`block truncate px-2 py-1.5 text-[13.5px] hover:bg-paper-deep/70 ${c.id === chatId ? 'bg-card shadow-[var(--shadow-card)]' : 'text-ink-soft'}`}>
                {c.title}
                <span className="block text-[11.5px] text-faded">{relTime(c.updated)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </aside>
      <div className="flex min-h-[calc(100vh-8rem)] max-w-3xl flex-col">
        <h1 className="font-serif text-[30px] leading-tight">Ask your cabinet</h1>
        <p className="mb-6 text-[14px] text-faded">
          {status.data ? (ready ? `Answers come from your library, with links to what they’re based on. Running on ${status.data.chatModel}.` : status.data.reason) : 'Checking the model…'}
        </p>
        <div className="flex flex-1 flex-col gap-7" data-testid="chat-log">
          {msgs.length === 0 && (
            <div className="flex flex-wrap gap-2">
              {['What have I saved about lighting?', 'Summarise my Reading corner project', 'What should I revisit this week?'].map((q) => (
                <button key={q} className="chip !h-auto !py-1.5 text-[13px] hover:bg-card" onClick={() => void send(q)} disabled={!ready}>
                  {q}
                </button>
              ))}
            </div>
          )}
          {msgs.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="self-end bg-ink px-4 py-2.5 text-[15px] text-white shadow-[var(--shadow-card)]">
                {m.content}
              </div>
            ) : (
              <div key={i} className="card px-5 py-4" data-testid="chat-answer">
                {(m.tools?.length ?? 0) > 0 && (
                  <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-faded">
                    {m.tools!.map((t, j) => (
                      <li key={j} className="flex items-center gap-1">
                        {t.name === 'search' ? <Search size={11} /> : <BookOpen size={11} />}
                        {toolLabel(t)}
                      </li>
                    ))}
                  </ul>
                )}
                {m.content ? <Answer msg={m} /> : !m.error && <Loader2 size={16} className="animate-spin text-faded" />}
                {m.error && <p className="mt-2 text-[13.5px] text-alert">{m.error}</p>}
                {m.content && !(busy && i === msgs.length - 1) && (
                  <button className="btn btn-sm btn-quiet mt-3" onClick={() => void saveAsNote(i)}>
                    <NotebookPen size={13} /> Save as note
                  </button>
                )}
              </div>
            ),
          )}
          <div ref={bottom} />
        </div>
        <form
          className="card sticky bottom-4 mt-6 flex items-end gap-2 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent py-2 font-serif text-[16px] focus:outline-none"
            rows={1}
            placeholder={ready ? 'Ask about anything you’ve saved' : 'Chat needs a model; see Settings'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            disabled={!ready}
            aria-label="Question"
            data-testid="chat-input"
          />
          <button className="btn btn-primary !h-9 !w-9 justify-center !px-0" disabled={busy || !input.trim() || !ready} aria-label="Send">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={15} />}
          </button>
        </form>
      </div>
    </div>
  );
}
