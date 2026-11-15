import { Dialog } from 'radix-ui';
import type { ConflictState } from '../lib/useItem.ts';

export function ConflictDialog({ conflict, onResolve }: { conflict: ConflictState | null; onResolve: (c: 'mine' | 'disk' | 'copy') => void }) {
  return (
    <Dialog.Root open={!!conflict}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgba(0,0,0,0.3)]" />
        <Dialog.Content aria-describedby="conflict-desc" className="fixed top-[20vh] left-1/2 z-50 w-[min(480px,94vw)] -translate-x-1/2 border border-rule-strong bg-card p-6 shadow-[var(--shadow-sheet)]" data-testid="conflict-dialog">
          <Dialog.Title className="font-serif text-[20px]">This changed while you were editing</Dialog.Title>
          <p id="conflict-desc" className="mt-2 text-[14px] text-ink-soft">
            “{conflict?.current.title}” was edited somewhere else (another editor, an agent, or a sync) after you opened it. Nothing has been overwritten. Choose which version to keep.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <button className="btn btn-primary justify-center" onClick={() => onResolve('mine')}>
              Keep mine
            </button>
            <button className="btn justify-center" onClick={() => onResolve('disk')}>
              Take the version on disk
            </button>
            <button className="btn justify-center" onClick={() => onResolve('copy')}>
              Save mine as a copy
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
