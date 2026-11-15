import { useSyncExternalStore } from 'react';

export interface CaptureSeed {
  url?: string;
  text?: string;
  files?: File[];
  kind?: 'text' | 'quote' | 'note';
}

export interface UiState {
  capture: CaptureSeed | null;
  palette: boolean;
  paletteMode: 'search' | 'new-project';
  /** The project currently open, so pastes go straight into it. */
  activeProject: { id: string; title: string; sections: string[] } | null;
  toasts: Array<{ id: number; text: string; tone?: 'ok' | 'error'; action?: { label: string; run: () => void } }>;
  chatOpen: boolean;
}

let state: UiState = { capture: null, palette: false, paletteMode: 'search', activeProject: null, toasts: [], chatOpen: false };
const subs = new Set<() => void>();

export function getUi() {
  return state;
}
export function setUi(patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const s of subs) s();
}
export function useUi<T>(sel: (s: UiState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => sel(state),
  );
}

let toastId = 0;
export function toast(text: string, opts: { tone?: 'ok' | 'error'; action?: { label: string; run: () => void }; ms?: number } = {}) {
  const id = ++toastId;
  setUi((s) => ({ toasts: [...s.toasts, { id, text, tone: opts.tone, action: opts.action }] }));
  setTimeout(() => setUi((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), opts.ms ?? 4200);
}

export function openCapture(seed: CaptureSeed = {}) {
  setUi({ capture: seed, palette: false });
}
