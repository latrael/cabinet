import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileText, FolderKanban, Image as ImageIcon, Link2, Loader2, Plus, Quote, ScrollText, X } from 'lucide-react';
import { extractLinks } from '@cabinet/core/links';
import { api, thumbUrl, type ItemDetail, type ItemSummary, type RelatedHit } from '../lib/api.ts';
import { host, MOD, TYPE_ICON, TYPE_LABEL } from '../lib/meta.ts';
import { setUi, toast, useUi, type CaptureSeed } from '../lib/store.ts';
import { Editor } from '../editor/Editor.tsx';
import { TagInput } from './TagInput.tsx';
import { AddToPicker, type AddTarget } from './AddToPicker.tsx';

interface Preview {
  url?: string;
  kind?: string;
  title?: string;
  description?: string;
  image?: string;
  site?: string;
  author?: string;
  published?: string;
}

const URL_RE = /^(https?:\/\/|www\.)\S+\.\S+$/i;

export function isUrl(s: string) {
  return URL_RE.test(s.trim()) || /^https?:\/\/localhost(:\d+)?\//.test(s.trim()) || /^https?:\/\/127\.0\.0\.1(:\d+)?\//.test(s.trim());
}

export function CaptureSheet() {
  const seed = useUi((s) => s.capture);
  const open = !!seed;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && setUi({ capture: null })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgba(43,40,35,0.28)] data-[state=open]:animate-[fadeIn_120ms_ease]" />
        <Dialog.Content
          className="fixed top-[6vh] left-1/2 z-50 flex max-h-[88vh] w-[min(640px,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-[4px] border border-rule-strong bg-paper shadow-[var(--shadow-sheet)] focus:outline-none"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {seed && <CaptureForm key={JSON.stringify({ u: seed.url, t: seed.text, f: seed.files?.map((f) => f.name) })} seed={seed} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CaptureForm({ seed }: { seed: CaptureSeed }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const activeProject = useUi((s) => s.activeProject);
  const startedAt = useRef(performance.now());

  const [url] = useState(seed.url ?? (seed.text && isUrl(seed.text) ? seed.text.trim() : ''));
  const [text, setText] = useState(seed.text && !isUrl(seed.text) ? seed.text : '');
  const [kind, setKind] = useState<'text' | 'quote' | 'note'>(seed.kind ?? (seed.text && seed.text.length < 400 && !seed.text.includes('\n\n') ? 'quote' : 'text'));
  const [author, setAuthor] = useState('');
  const files = useMemo(() => seed.files ?? [], [seed.files]);
  const mode: 'url' | 'text' | 'file' = files.length ? 'file' : url ? 'url' : 'text';

  const [why, setWhy] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [targets, setTargets] = useState<AddTarget[]>(activeProject ? [{ kind: 'project', id: activeProject.id, title: activeProject.title }] : []);
  const [section, setSection] = useState('');
  const [context, setContext] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['preview', url],
    enabled: mode === 'url' && !!url,
    staleTime: 60_000,
    retry: false,
    queryFn: () => api<{ preview: Preview; existing: ItemSummary | null }>('/api/capture/preview', { method: 'POST', json: { url } }),
  });
  const p: Preview = preview.data?.preview ?? {};
  const existing = preview.data?.existing ?? null;

  const imgUrl = useMemo(() => (files[0] && files[0].type.startsWith('image/') ? URL.createObjectURL(files[0]) : null), [files]);
  useEffect(() => () => void (imgUrl && URL.revokeObjectURL(imgUrl)), [imgUrl]);

  // "Connects to…": related items for what we know so far.
  const relatedText = [title, p.title, p.description, text, why, files.map((f) => f.name.replace(/[-_.]/g, ' ')).join(' '), tags.join(' ')].filter(Boolean).join('\n');
  const [debounced, setDebounced] = useState(relatedText);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(relatedText), 350);
    return () => clearTimeout(t);
  }, [relatedText]);
  const related = useQuery({
    queryKey: ['related', debounced],
    enabled: debounced.trim().length > 2,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: () => api<{ hits: RelatedHit[] }>('/api/related', { method: 'POST', json: { text: debounced } }),
  });
  const whyLinks = new Set(extractLinks(why).map((l) => l.target.toLowerCase()));

  const project = targets.find((t) => t.kind === 'project');
  const projectSections = useQuery({
    queryKey: ['project-sections', project?.id],
    enabled: !!project,
    queryFn: async () => {
      const d = await api<ItemDetail>(`/api/items/${project!.id}`);
      const { parseProject } = await import('@cabinet/core/project');
      return parseProject(d.item.body).material.map((s) => s.name).filter(Boolean);
    },
  });

  const displayTitle = title || p.title || (mode === 'file' ? files[0]?.name : undefined) || (url ? host(url) : '') || '';

  async function save(openAfter: boolean) {
    if (saving) return;
    if (mode === 'text' && !text.trim()) {
      setError('Type or paste something to save.');
      return;
    }
    setSaving(true);
    setError(null);
    const collections = targets.filter((t) => t.kind === 'collection').map((t) => t.title);
    try {
      let result: ItemDetail;
      const common = {
        why: why.trim() || undefined,
        tags,
        collections,
        projectId: project?.id,
        section: project ? section || undefined : undefined,
        context: project ? context.trim() || undefined : undefined,
        links,
        title: title.trim() || undefined,
      };
      if (mode === 'file') {
        const fd = new FormData();
        fd.append('file', files[0]);
        for (const [k, v] of Object.entries(common)) {
          if (v === undefined) continue;
          fd.append(k, Array.isArray(v) ? v.join(',') : String(v ?? ''));
        }
        result = await api<ItemDetail>('/api/capture', { method: 'POST', body: fd });
        for (const extra of files.slice(1)) {
          const f2 = new FormData();
          f2.append('file', extra);
          if (project?.id) f2.append('projectId', project.id);
          await api('/api/capture', { method: 'POST', body: f2 });
        }
      } else if (mode === 'url') {
        result = await api<ItemDetail>('/api/capture', {
          method: 'POST',
          json: { url, preview: preview.data ? { ...p, kind: p.kind } : undefined, ...common },
        });
      } else {
        result = await api<ItemDetail>('/api/capture', { method: 'POST', json: { text, kind, author: author.trim() || undefined, ...common } });
      }
      const ms = Math.round(performance.now() - startedAt.current);
      (window as any).__lastCaptureMs = ms;
      setUi({ capture: null });
      qc.invalidateQueries();
      const where = project ? `to ${project.title}` : result.item.status === 'inbox' ? 'to your inbox' : '';
      if (result.duplicate) toast('Already in your library', { action: { label: 'Open', run: () => navigate({ to: '/item/$id', params: { id: result.item.id } }) } });
      else
        toast(`Saved ${where}`.trim(), {
          tone: 'ok',
          action: openAfter ? undefined : { label: 'Open', run: () => navigate({ to: '/item/$id', params: { id: result.item.id } }) },
        });
      if (openAfter) navigate({ to: '/item/$id', params: { id: result.item.id } });
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save(true);
    } else if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName === 'INPUT' && !(e.target as HTMLElement).dataset.noSubmit) {
      e.preventDefault();
      void save(false);
    }
  };

  const KindIcon = mode === 'file' ? (files[0]?.type.startsWith('image/') ? ImageIcon : FileText) : mode === 'url' ? (p.kind === 'video' ? TYPE_ICON.video : Link2) : kind === 'quote' ? Quote : ScrollText;

  return (
    <form
      className="flex min-h-0 flex-col"
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
      data-testid="capture-sheet"
    >
      <div className="flex items-center justify-between border-b border-rule px-5 py-3">
        <Dialog.Title className="font-serif text-[18px]">{project ? `Save to ${project.title}` : 'Save to your cabinet'}</Dialog.Title>
        <Dialog.Close className="btn btn-quiet btn-sm" aria-label="Close">
          <X size={16} />
        </Dialog.Close>
      </div>

      <div className="min-h-0 overflow-y-auto px-5 py-4">
        {/* Optimistic preview card */}
        <div className="card mt-2 flex gap-3.5 p-3" data-testid="capture-preview">
          <div className="flex h-20 w-24 shrink-0 items-center justify-center overflow-hidden rounded-[2px] bg-paper-deep">
            {imgUrl ? (
              <img src={imgUrl} alt="" className="h-full w-full object-cover" />
            ) : p.image ? (
              <img src={thumbUrl(p.image, 240)} alt="" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.display = 'none')} />
            ) : (
              <KindIcon size={26} strokeWidth={1.4} className="text-faded" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            {mode === 'text' ? (
              <>
                <div className="mb-1.5 flex gap-1" role="radiogroup" aria-label="Kind">
                  {(['quote', 'text', 'note'] as const).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={kind === k} className={`chip ${kind === k ? 'chip-active' : ''}`} onClick={() => setKind(k)}>
                      {k}
                    </button>
                  ))}
                </div>
                <textarea
                  className="field min-h-[72px] font-serif text-[15px]"
                  value={text}
                  autoFocus={!text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Paste or type a quote, a thought, a snippet…"
                  aria-label="Text"
                />
                {kind === 'quote' && <input className="field mt-1.5 text-[13px]" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Who said it (optional)" />}
              </>
            ) : (
              <>
                <input
                  className="w-full bg-transparent font-serif text-[16.5px] leading-snug text-ink placeholder:text-faded focus:outline-none"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={displayTitle || 'Title'}
                  aria-label="Title"
                />
                <div className="mt-1 line-clamp-2 text-[12.5px] text-faded">
                  {mode === 'url' ? (p.description ?? (preview.isFetching ? 'Looking at the page…' : url)) : `${files.length > 1 ? `${files.length} files · ` : ''}${files[0]?.type || 'file'} · ${Math.max(1, Math.round((files[0]?.size ?? 0) / 1024))} KB`}
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-faded">
                  {mode === 'url' && <span className="truncate">{p.site ?? host(url)}</span>}
                  {mode === 'url' && p.kind && p.kind !== 'link' && <span>{TYPE_LABEL[p.kind as keyof typeof TYPE_LABEL] ?? p.kind}</span>}
                  {preview.isFetching && <Loader2 size={12} className="animate-spin" aria-label="Fetching details" />}
                </div>
              </>
            )}
          </div>
        </div>
        {existing && (
          <p className="mt-2 text-[13px] text-brass">
            You saved this before as “{existing.title}”. Saving opens the existing item{project ? ' and adds it to the project' : ''}.
          </p>
        )}

        <label className="label mt-5 mb-1 block">Why I saved this</label>
        <div className="field !py-1">
          <Editor
            value={why}
            onChange={setWhy}
            placeholder="Optional. Type [[ to link something you already have."
            onSubmit={() => void save(true)}
            onEnter={() => void save(false)}
            ariaLabel="Why I saved this"
            className="text-[15px]"
            autoFocus={mode !== 'text'}
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label mb-1 block">Tags</label>
            <TagInput value={tags} onChange={setTags} />
          </div>
          <div>
            <label className="label mb-1 block">Add to</label>
            <AddToPicker value={targets} onChange={setTargets} />
          </div>
        </div>

        {project && (
          <div className="mt-4 rounded-[3px] border border-rule bg-card/60 p-3">
            <div className="mb-2 flex items-center gap-2 text-[13px] text-ink-soft">
              <FolderKanban size={14} /> In <strong className="font-semibold">{project.title}</strong>
            </div>
            <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
              <input
                className="field text-[13.5px]"
                list="capture-sections"
                value={section}
                onChange={(e) => setSection(e.target.value)}
                placeholder="Section (optional)"
                aria-label="Project section"
                data-no-submit=""
              />
              <datalist id="capture-sections">{projectSections.data?.map((s) => <option key={s} value={s} />)}</datalist>
              <input className="field text-[13.5px]" value={context} onChange={(e) => setContext(e.target.value)} placeholder="Why it matters to this project" aria-label="Project context" />
            </div>
          </div>
        )}

        <div className="mt-5">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="label">Connects to…</span>
            {related.data?.hits[0] && <span className="text-[11.5px] text-faded">{related.data.hits[0].reason === 'similar meaning' ? 'by meaning' : 'by shared words'}</span>}
          </div>
          {(related.data?.hits ?? []).length === 0 ? (
            <p className="text-[13px] text-faded">{related.isFetching ? 'Looking through your cabinet…' : 'Nothing similar yet. Connections appear as you add context.'}</p>
          ) : (
            <ul className="flex flex-col" data-testid="connects-to">
              {related.data!.hits.slice(0, 5).map((h) => {
                const on = links.includes(h.item.id) || whyLinks.has(h.item.slug.toLowerCase());
                const Icon = TYPE_ICON[h.item.type];
                return (
                  <li key={h.item.id}>
                    <button
                      type="button"
                      className={`flex w-full items-center gap-2.5 rounded-[3px] px-2 py-1.5 text-left text-[14px] hover:bg-card ${on ? 'text-lamp' : 'text-ink'}`}
                      onClick={() => setLinks((l) => (l.includes(h.item.id) ? l.filter((x) => x !== h.item.id) : [...l, h.item.id]))}
                      aria-pressed={on}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center rounded-[2px] border ${on ? 'border-lamp bg-lamp text-card' : 'border-rule-strong'}`}>{on && <Check size={11} strokeWidth={3} />}</span>
                      <Icon size={13} className="shrink-0 text-faded" />
                      <span className="truncate font-serif">{h.item.title}</span>
                      <span className="ml-auto shrink-0 text-[11.5px] text-faded">{on ? 'linked' : 'link'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {error && <p className="mt-3 text-[13px] text-alert">{error}</p>}
      </div>

      <div className="flex items-center gap-3 border-t border-rule bg-paper-deep/50 px-5 py-3">
        <span className="hidden text-[12px] text-faded sm:inline">
          <span className="kbd">Enter</span> save · <span className="kbd">{MOD} Enter</span> save and open
        </span>
        <div className="ml-auto flex gap-2">
          <button type="button" className="btn" disabled={saving} onClick={() => void save(true)}>
            Save and open
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving} data-testid="capture-save">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save
          </button>
        </div>
      </div>
    </form>
  );
}
