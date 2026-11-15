import { useEffect, useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderKanban, Home, Inbox, Library, Menu, MessageCircle, Plus, Search, Settings, Share2, Shapes, X, type LucideIcon } from 'lucide-react';
import { api, setUnauthorizedHandler, type ItemSummary } from '../lib/api.ts';
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

function Drawer({ to, icon: Icon, label, count, exact }: { to: string; icon: LucideIcon; label: string; count?: number; exact?: boolean }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: !!exact }}
      className="group relative flex items-center gap-2.5 rounded-[3px] px-2.5 py-[7px] text-[14px] text-ink-soft hover:bg-paper-deep/70 data-[status=active]:bg-card data-[status=active]:text-ink data-[status=active]:shadow-[var(--shadow-card)]"
    >
      {/* brass label holder on the active drawer */}
      <span className="absolute top-1/2 left-0 h-4 w-[3px] -translate-y-1/2 rounded-r-sm bg-brass opacity-0 group-data-[status=active]:opacity-100" />
      <Icon size={16} strokeWidth={1.7} />
      <span className="flex-1">{label}</span>
      {count !== undefined && count > 0 && <span className="min-w-5 rounded-full bg-lamp px-1.5 text-center text-[11px] leading-[18px] font-semibold text-[#f6f1e4]">{count}</span>}
    </Link>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const counts = useQuery({ queryKey: ['counts'], queryFn: () => api<{ counts: Record<string, number> }>('/api/home').then((h) => h), staleTime: 10_000 });
  const projects = useQuery({ queryKey: ['items', 'projects', 'active'], queryFn: () => api<{ items: ItemSummary[] }>('/api/items?type=project&sort=updated&limit=20') });
  const active = (projects.data?.items ?? []).filter((p) => (p.projectStatus ?? 'active') === 'active').slice(0, 6);
  return (
    <nav className="flex h-full flex-col gap-0.5 px-3 py-4" aria-label="Main" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <Link to="/" className="mb-4 flex items-center gap-2 px-2.5">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
          <rect x="3" y="3" width="26" height="26" rx="3" fill="#2E5B4E" />
          <rect x="7" y="8" width="18" height="7" rx="1.5" fill="#F0E9D8" />
          <rect x="7" y="18" width="18" height="7" rx="1.5" fill="#F0E9D8" />
          <rect x="13" y="10.5" width="6" height="2" rx="1" fill="#A8843A" />
          <rect x="13" y="20.5" width="6" height="2" rx="1" fill="#A8843A" />
        </svg>
        <span className="font-serif text-[19px] font-semibold tracking-[-0.01em]">Cabinet</span>
      </Link>
      <button className="btn btn-primary mb-3 w-full justify-center" onClick={() => openCapture({})} data-testid="new-capture">
        <Plus size={15} /> Save something
      </button>
      <Drawer to="/" icon={Home} label="Home" exact />
      <Drawer to="/inbox" icon={Inbox} label="Inbox" count={counts.data?.counts?.inbox} />
      <Drawer to="/library" icon={Library} label="Library" />
      <Drawer to="/projects" icon={FolderKanban} label="Projects" />
      <Drawer to="/collections" icon={Shapes} label="Collections" />
      <Drawer to="/graph" icon={Share2} label="Graph" />
      <Drawer to="/search" icon={Search} label="Search" />
      <Drawer to="/chat" icon={MessageCircle} label="Ask" />
      {active.length > 0 && (
        <div className="mt-5">
          <div className="mb-1 px-2.5 text-[12px] font-semibold text-faded">Active projects</div>
          {active.map((p) => (
            <Link
              key={p.id}
              to="/item/$id"
              params={{ id: p.id }}
              className="block truncate rounded-[3px] px-2.5 py-1 font-serif text-[14px] text-ink-soft hover:bg-paper-deep/70 data-[status=active]:text-lamp"
            >
              {p.title}
            </Link>
          ))}
        </div>
      )}
      <div className="mt-auto pt-4">
        <Drawer to="/settings" icon={Settings} label="Settings" />
        <button className="mt-1 flex w-full items-center gap-2 px-2.5 py-1 text-[12px] text-faded hover:text-ink" onClick={() => setUi({ palette: true })}>
          <span className="kbd">{MOD} K</span> search and commands
        </button>
      </div>
    </nav>
  );
}

export function AppShell() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [menu, setMenu] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    api('/api/auth/status')
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => setMenu(false), [pathname]);

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
  return <Shell menu={menu} setMenu={setMenu} />;
}

function Shell({ menu, setMenu }: { menu: boolean; setMenu: (v: boolean) => void }) {
  useLibraryEvents();
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 border-r border-rule bg-paper-deep/40 lg:block">
        <Sidebar />
      </aside>
      {menu && (
        <div className="fixed inset-0 z-40 lg:hidden" onClick={() => setMenu(false)}>
          <div className="absolute inset-0 bg-[rgba(43,40,35,0.25)]" />
          <aside className="absolute inset-y-0 left-0 w-[260px] bg-paper shadow-[var(--shadow-sheet)]" onClick={(e) => e.stopPropagation()}>
            <Sidebar onNavigate={() => setMenu(false)} />
          </aside>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-rule bg-paper/90 px-4 py-2 backdrop-blur lg:hidden">
          <button className="btn btn-quiet btn-sm" onClick={() => setMenu(!menu)} aria-label="Menu">
            {menu ? <X size={18} /> : <Menu size={18} />}
          </button>
          <span className="font-serif text-[17px] font-semibold">Cabinet</span>
          <button className="btn btn-sm ml-auto" onClick={() => setUi({ palette: true })} aria-label="Search">
            <Search size={14} />
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => openCapture({})} aria-label="Save something">
            <Plus size={14} />
          </button>
        </div>
        <main className="mx-auto w-full max-w-[1280px] px-5 pt-6 pb-24 md:px-9 md:pt-8">
          <Outlet />
        </main>
      </div>
      <CaptureSheet />
      <CommandPalette />
      <Toasts />
    </div>
  );
}
