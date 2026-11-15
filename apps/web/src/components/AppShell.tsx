import { useEffect, useState } from 'react';
import { Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderKanban, Home, Inbox, Library, MessageCircle, Plus, Search, Settings, Share2, Shapes, type LucideIcon } from 'lucide-react';
import { api, setUnauthorizedHandler } from '../lib/api.ts';
import { useLibraryEvents } from '../lib/events.ts';
import { MOD } from '../lib/meta.ts';
import { getUi, openCapture, setUi } from '../lib/store.ts';
import { CaptureSheet, isUrl } from './CaptureSheet.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { Toasts } from './Toasts.tsx';
import { Login } from './Login.tsx';

function isEditable(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (!e) return false;
  return e.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) || !!e.closest?.('[contenteditable="true"], .cm-editor');
}

function NavLink({ to, icon: Icon, label, count, exact }: { to: string; icon: LucideIcon; label: string; count?: number; exact?: boolean }) {
  return (
    <Link to={to} activeOptions={{ exact: !!exact }} className="nav-link">
      <Icon size={15} strokeWidth={1.7} aria-hidden />
      <span>{label}</span>
      {count !== undefined && count > 0 && <span className="text-[11.5px] font-bold text-lamp tabular-nums">{count}</span>}
    </Link>
  );
}

/** The nameplate, the date, and one row of sections. The same on every page. */
function Masthead() {
  const counts = useQuery({ queryKey: ['counts'], queryFn: () => api<{ counts: Record<string, number> }>('/api/home'), staleTime: 10_000 });
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <header className="mx-auto w-full max-w-[1180px] px-5 md:px-9">
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 pt-5 pb-4 md:grid-cols-[1fr_auto_1fr] md:pt-7">
        <span className="hidden text-[12px] text-faded md:block">{today}</span>
        <Link to="/" className="nameplate" aria-label="Cabinet, home">
          Cabinet
        </Link>
        <div className="flex items-center justify-end gap-2">
          <button className="btn btn-quiet btn-sm hidden sm:inline-flex" onClick={() => setUi({ palette: true })}>
            <span className="kbd">{MOD} K</span>
          </button>
          <button className="btn btn-primary" onClick={() => openCapture({})} data-testid="new-capture">
            <Plus size={15} /> Save
          </button>
        </div>
      </div>
      <nav className="flex gap-x-6 overflow-x-auto border-t-2 border-b border-t-ink border-b-rule md:justify-center lg:gap-x-7" aria-label="Main">
        <NavLink to="/" icon={Home} label="Home" exact />
        <NavLink to="/inbox" icon={Inbox} label="Inbox" count={counts.data?.counts?.inbox} />
        <NavLink to="/library" icon={Library} label="Library" />
        <NavLink to="/projects" icon={FolderKanban} label="Projects" />
        <NavLink to="/collections" icon={Shapes} label="Collections" />
        <NavLink to="/graph" icon={Share2} label="Graph" />
        <NavLink to="/search" icon={Search} label="Search" />
        <NavLink to="/chat" icon={MessageCircle} label="Ask" />
        <NavLink to="/settings" icon={Settings} label="Settings" />
      </nav>
    </header>
  );
}

export function AppShell() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    api('/api/auth/status')
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditable(e.target) || getUi().capture || getUi().palette) return;
      const dt = e.clipboardData;
      if (!dt) return;
      const files = [...dt.files];
      if (files.length) {
        e.preventDefault();
        openCapture({ files });
        return;
      }
      const text = dt.getData('text/plain');
      if (!text.trim()) return;
      e.preventDefault();
      if (isUrl(text)) openCapture({ url: text.trim() });
      else openCapture({ text });
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setUi((s) => ({ palette: !s.palette, paletteMode: 'search' }));
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files') || e.dataTransfer?.types.includes('text/uri-list')) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt || (e.target as HTMLElement).closest?.('[data-dropzone]')) return;
      const files = [...dt.files];
      if (files.length) {
        e.preventDefault();
        openCapture({ files });
        return;
      }
      const uri = dt.getData('text/uri-list') || dt.getData('text/plain');
      if (uri && isUrl(uri.split('\n')[0])) {
        e.preventDefault();
        openCapture({ url: uri.split('\n')[0].trim() });
      }
    };
    document.addEventListener('paste', onPaste);
    document.addEventListener('keydown', onKey);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, []);

  if (authed === false) return <Login onDone={() => setAuthed(true)} />;
  if (authed === null) return null;
  return <Shell />;
}

function Shell() {
  useLibraryEvents();
  return (
    <div className="min-h-screen">
      <Masthead />
      <main className="mx-auto w-full max-w-[1180px] px-5 pt-8 pb-24 md:px-9 md:pt-10">
        <Outlet />
      </main>
      <CaptureSheet />
      <CommandPalette />
      <Toasts />
    </div>
  );
}
