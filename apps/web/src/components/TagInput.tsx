import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../lib/api.ts';

const norm = (t: string) => t.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');

export function TagInput({ value, onChange, placeholder = 'Add a tag' }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const [focus, setFocus] = useState(false);
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api<{ tags: Array<{ tag: string; count: number }> }>('/api/tags'), staleTime: 30_000 });
  const add = (t: string) => {
    const n = norm(t);
    if (n && !value.includes(n)) onChange([...value, n]);
    setDraft('');
  };
  const q = norm(draft);
  const suggestions = (tags.data?.tags ?? []).filter((t) => !value.includes(t.tag) && (!q || t.tag.includes(q))).slice(0, 6);
  return (
    <div className="relative">
      <div className="field flex min-h-[36px] flex-wrap items-center gap-1 !py-1">
        {value.map((t) => (
          <span key={t} className="chip !h-6">
            #{t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))} className="text-faded hover:text-ink">
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          className="min-w-[80px] flex-1 bg-transparent text-[14px] focus:outline-none"
          value={draft}
          placeholder={value.length ? '' : placeholder}
          aria-label="Tags"
          data-no-submit=""
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 150)}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,\s]$/.test(v) && v.trim()) add(v.slice(0, -1));
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              e.preventDefault();
              e.stopPropagation();
              add(draft);
            } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
          }}
        />
      </div>
      {focus && suggestions.length > 0 && (
        <div className="absolute top-full right-0 left-0 z-10 mt-1 border border-rule-strong bg-card py-1 shadow-[var(--shadow-lift)]">
          {suggestions.map((s) => (
            <button key={s.tag} type="button" className="flex w-full justify-between px-3 py-1 text-left text-[13px] hover:bg-paper" onMouseDown={(e) => e.preventDefault()} onClick={() => add(s.tag)}>
              <span>#{s.tag}</span>
              <span className="text-faded">{s.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
