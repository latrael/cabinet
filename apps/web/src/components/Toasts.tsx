import { useUi, setUi } from '../lib/store.ts';

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[80] flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-center gap-3 px-4 py-2.5 text-[13.5px] shadow-[var(--shadow-lift)] ${
            t.tone === 'error' ? 'bg-alert text-white' : 'bg-ink text-white'
          }`}
        >
          <span>{t.text}</span>
          {t.action && (
            <button
              className="font-semibold text-highlight underline-offset-2 hover:underline"
              onClick={() => {
                t.action!.run();
                setUi((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }));
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
