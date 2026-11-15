import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Item, type ItemDetail } from './api.ts';
import { onLibraryEvent } from './events.ts';

export interface ConflictState {
  mine: { body?: string; frontmatter?: Record<string, unknown> };
  current: Item;
}

/**
 * Loads an item and provides `mutate(fn)`: apply a transformation to the latest body/frontmatter
 * and save it with the base hash. If the file changed in between, the transformation is
 * re-applied to the new version once (safe for structural edits like project reorders).
 */
export function useItem(id: string) {
  const qc = useQueryClient();
  const opened = useRef(false);
  const query = useQuery({
    queryKey: ['item-edit', id],
    queryFn: async () => {
      const d = await api<ItemDetail>(`/api/items/${encodeURIComponent(id)}${opened.current ? '' : '?open=1'}`);
      opened.current = true;
      return d;
    },
  });
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const dirty = useRef(false);

  const setDirty = useCallback((v: boolean) => {
    dirty.current = v;
  }, []);

  // Refresh when the file changes elsewhere, unless the user has unsaved edits.
  useEffect(() => {
    return onLibraryEvent((e) => {
      const itemId = query.data?.item.id;
      if (!itemId) return;
      if (e.kind === 'suggestions' || (e.kind === 'job' && e.id === itemId)) {
        void qc.invalidateQueries({ queryKey: ['item-edit', id] });
        return;
      }
      if (e.id !== itemId && !(e.kind === 'updated' || e.kind === 'created' || e.kind === 'deleted')) return;
      if (e.id === itemId && dirty.current && e.origin === 'disk') {
        setChangedOnDisk(true);
        return;
      }
      void qc.invalidateQueries({ queryKey: ['item-edit', id] });
    });
  }, [id, qc, query.data?.item.id]);

  const apply = useCallback(
    (detail: ItemDetail) => {
      qc.setQueryData(['item-edit', id], detail);
      if (detail.item.id !== id) qc.setQueryData(['item-edit', detail.item.id], detail);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'item-edit' });
    },
    [id, qc],
  );

  type Patch = { body?: string; frontmatter?: Record<string, unknown>; renameFile?: boolean };

  /** Save a patch computed from the current item. */
  const mutate = useCallback(
    async (fn: (item: Item) => Patch | null, opts: { rebase?: boolean; onConflictKeepMine?: boolean } = {}): Promise<ItemDetail | null> => {
      const d = qc.getQueryData<ItemDetail>(['item-edit', id]);
      if (!d) return null;
      const patch = fn(d.item);
      if (!patch) return null;
      setSaving(true);
      try {
        const res = await api<ItemDetail>(`/api/items/${d.item.id}`, { method: 'PUT', json: { ...patch, baseHash: d.item.hash } });
        apply(res);
        setChangedOnDisk(false);
        dirty.current = false;
        return res;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const current = e.data.current as Item;
          if (opts.rebase !== false) {
            // Re-apply the same edit on top of the new version.
            const again = fn(current);
            if (again) try {
              const res = await api<ItemDetail>(`/api/items/${current.id}`, { method: 'PUT', json: { ...again, baseHash: current.hash } });
              apply(res);
              dirty.current = false;
              return res;
            } catch {
              /* fall through to the conflict dialog */
            }
          }
          setConflict({ mine: patch, current });
          return null;
        }
        throw e;
      } finally {
        setSaving(false);
      }
    },
    [apply, id, qc],
  );

  const resolveConflict = useCallback(
    async (choice: 'mine' | 'disk' | 'copy') => {
      if (!conflict) return;
      const { mine, current } = conflict;
      setConflict(null);
      if (choice === 'mine') {
        const res = await api<ItemDetail>(`/api/items/${current.id}`, { method: 'PUT', json: { ...mine, baseHash: current.hash } });
        apply(res);
      } else if (choice === 'disk') {
        await qc.invalidateQueries({ queryKey: ['item-edit', id] });
      } else {
        await api<ItemDetail>(`/api/items/${current.id}/copy`, { method: 'POST', json: mine });
        await qc.invalidateQueries();
      }
      dirty.current = false;
      setChangedOnDisk(false);
    },
    [apply, conflict, id, qc],
  );

  return { query, data: query.data, mutate, saving, conflict, resolveConflict, changedOnDisk, setDirty, apply };
}
