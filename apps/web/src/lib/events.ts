import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

type Listener = (e: any) => void;
const listeners = new Set<Listener>();

export function onLibraryEvent(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** One EventSource for the app. Refreshes queries when the library changes anywhere. */
export function useLibraryEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('library', (msg) => {
        const e = JSON.parse((msg as MessageEvent).data);
        for (const l of listeners) l(e);
        if (e.kind === 'job' && e.data?.state === 'started') return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          qc.invalidateQueries({
            predicate: (q) => {
              const k = q.queryKey[0];
              // the open item is refreshed by its own view, to respect unsaved edits
              return k !== 'item-edit';
            },
          });
        }, 120);
      });
      es.onerror = () => {
        es?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      es?.close();
      if (retry) clearTimeout(retry);
      if (pending) clearTimeout(pending);
    };
  }, [qc]);
}
