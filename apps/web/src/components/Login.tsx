import { useState } from 'react';
import { api } from '../lib/api.ts';

export function Login({ onDone }: { onDone: () => void }) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        className="card w-[min(380px,100%)] p-7"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('/api/auth/login', { method: 'POST', json: { passphrase: pass } });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1 className="mb-1 font-serif text-[24px]">Cabinet</h1>
        <p className="mb-5 text-[14px] text-faded">This cabinet is locked. Enter the passphrase set on the computer that runs it.</p>
        <label className="label mb-1 block" htmlFor="pass">
          Passphrase
        </label>
        <input id="pass" type="password" className="field mb-3" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
        {error && <p className="mb-3 text-[13px] text-alert">{error}</p>}
        <button className="btn btn-primary w-full justify-center" disabled={busy || !pass}>
          Unlock
        </button>
      </form>
    </div>
  );
}
