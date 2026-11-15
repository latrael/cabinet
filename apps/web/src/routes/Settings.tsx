import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, KeyRound, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { api } from '../lib/api.ts';
import { relTime } from '../lib/meta.ts';
import { toast } from '../lib/store.ts';

interface SettingsData {
  config: any;
  libraryPath: string;
  defaultLibraryPath: string;
  secrets: { passphrase: boolean; anthropicKey: boolean; openaiKey: boolean; telegramToken: boolean };
  tokens: Array<{ id: string; name: string; created: string; lastUsed?: string }>;
  telegram: { running: boolean; username?: string; error?: string };
  transcription: { ok: boolean; reason?: string };
  jobs: { pending: number; failures: Array<{ key: string; error: string; at: string }> };
  version: string;
}

function Block({ title, children, desc, id }: { title: string; desc?: string; children: React.ReactNode; id?: string }) {
  return (
    <section className="grid gap-4 border-t border-rule py-7 md:grid-cols-[220px_1fr]" id={id}>
      <div>
        <h2 className="font-serif text-[19px]">{title}</h2>
        {desc && <p className="mt-1 text-[13px] text-faded">{desc}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-faded">{hint}</span>}
    </label>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-[14px]">
      <input type="checkbox" className="h-4 w-4 accent-lamp" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function SecretField({ label, isSet, onSave, placeholder }: { label: string; isSet: boolean; onSave: (v: string | null) => Promise<void>; placeholder?: string }) {
  const [v, setV] = useState('');
  return (
    <Field label={label} hint={isSet ? 'Saved in .cabinet/secrets.json (never committed).' : undefined}>
      <div className="flex gap-2">
        <input type="password" className="field" placeholder={isSet ? '••••••••  (saved)' : placeholder} value={v} onChange={(e) => setV(e.target.value)} autoComplete="off" />
        <button className="btn" disabled={!v} onClick={() => onSave(v).then(() => setV(''))}>
          Save
        </button>
        {isSet && (
          <button className="btn btn-quiet btn-danger" onClick={() => onSave(null)} aria-label={`Clear ${label}`}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </Field>
  );
}

function Snippet({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-[3px] bg-paper-deep px-3 py-2.5 text-[12px] leading-relaxed text-ink-soft">{text}</pre>
      <button className="btn btn-sm absolute top-1.5 right-1.5" onClick={() => navigator.clipboard.writeText(text).then(() => toast('Copied'))} aria-label="Copy">
        <Copy size={12} />
      </button>
    </div>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsData>('/api/settings') });
  const ai = useQuery({ queryKey: ['ai-status'], queryFn: () => api<any>('/api/ai/status'), refetchInterval: 15_000 });
  const commits = useQuery({ queryKey: ['git-log'], queryFn: () => api<{ commits: Array<{ hash: string; date: string; author: string; message: string }> }>('/api/settings/git/log') });
  const [cfg, setCfg] = useState<any>(null);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [tokenName, setTokenName] = useState('');
  const [pairing, setPairing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [libPath, setLibPath] = useState('');
  const [pass, setPass] = useState('');
  useEffect(() => {
    if (s.data) {
      setCfg(structuredClone(s.data.config));
      setLibPath(s.data.libraryPath);
    }
  }, [s.data]);
  if (!s.data || !cfg) return <Loader2 className="animate-spin text-faded" />;
  const d = s.data;

  const saveConfig = async (patch: any) => {
    try {
      const r = await api<SettingsData>('/api/settings', { method: 'PUT', json: patch });
      qc.setQueryData(['settings'], r);
      qc.invalidateQueries({ queryKey: ['ai-status'] });
      toast('Settings saved', { tone: 'ok' });
    } catch (e) {
      toast((e as Error).message, { tone: 'error' });
    }
  };
  const saveSecret = (key: string) => async (v: string | null) => {
    const r = await api<SettingsData>('/api/settings/secrets', { method: 'PUT', json: { [key]: v } });
    qc.setQueryData(['settings'], r);
    qc.invalidateQueries({ queryKey: ['ai-status'] });
    toast(v ? 'Saved' : 'Cleared', { tone: 'ok' });
  };
  const host = location.origin;
  const mcpStdio = JSON.stringify({ mcpServers: { cabinet: { command: 'node', args: [`<path-to-cabinet>/apps/cli/src/main.ts`, 'mcp', '--library', d.libraryPath, '--agent', 'claude'] } } }, null, 2);
  const mcpHttp = JSON.stringify({ mcpServers: { cabinet: { type: 'http', url: `${host}/mcp`, headers: { Authorization: 'Bearer <token>' } } } }, null, 2);

  return (
    <div className="max-w-4xl">
      <h1 className="font-serif text-[30px] leading-tight">Settings</h1>
      <p className="mb-4 text-[14px] text-faded">Cabinet {d.version}. Settings are stored in your library’s .cabinet/config.json; secrets in .cabinet/secrets.json.</p>

      <Block title="Library" desc="Your Markdown files are the source of truth. The index is disposable and can be rebuilt any time.">
        <Field label="Library folder" hint="Changing it takes effect the next time Cabinet starts.">
          <div className="flex gap-2">
            <input className="field font-mono text-[13px]" value={libPath} onChange={(e) => setLibPath(e.target.value)} />
            <button
              className="btn"
              disabled={libPath === d.libraryPath}
              onClick={async () => {
                try {
                  await api('/api/settings/library-path', { method: 'PUT', json: { path: libPath } });
                  toast('Saved. Restart Cabinet to open the new library.', { tone: 'ok', ms: 7000 });
                } catch (e) {
                  toast((e as Error).message, { tone: 'error' });
                }
              }}
            >
              Use this folder
            </button>
          </div>
        </Field>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn"
            disabled={busy === 'rebuild'}
            data-testid="rebuild"
            onClick={async () => {
              setBusy('rebuild');
              try {
                const r = await api<{ items: number; ms: number; embedded: number }>('/api/rebuild?embeddings=1', { method: 'POST' });
                toast(`Rebuilt the index: ${r.items} items in ${r.ms} ms${r.embedded ? `, ${r.embedded} passages embedded` : ''}`, { tone: 'ok' });
                qc.invalidateQueries();
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === 'rebuild' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Rebuild index
          </button>
          <a className="btn" href="/api/export" download data-testid="export">
            <Download size={14} /> Export as zip
          </a>
          <a className="btn btn-quiet" href="/api/export?git=1" download>
            Export with git history
          </a>
          <label className="btn cursor-pointer" data-testid="restore">
            <Upload size={14} /> Restore from zip
            <input
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                const fd = new FormData();
                fd.append('file', f);
                try {
                  const dry = await api<{ files: number }>('/api/restore?dryRun=1', { method: 'POST', body: fd });
                  if (!confirm(`Restore ${dry.files} files from ${f.name}? Your current library will be moved aside as a backup first.`)) return;
                  const fd2 = new FormData();
                  fd2.append('file', f);
                  setBusy('restore');
                  const r = await api<{ items: number; backup: string }>('/api/restore', { method: 'POST', body: fd2 });
                  toast(`Restored ${r.items} items. Previous library kept at ${r.backup}`, { tone: 'ok', ms: 9000 });
                  qc.invalidateQueries();
                } catch (err: any) {
                  toast(err.data?.errors?.join('; ') ?? err.message, { tone: 'error', ms: 8000 });
                } finally {
                  setBusy(null);
                }
              }}
            />
          </label>
        </div>
        {d.jobs.failures.length > 0 && (
          <details className="text-[13px] text-faded">
            <summary className="cursor-pointer">Recent background errors ({d.jobs.failures.length})</summary>
            <ul className="mt-2">
              {d.jobs.failures.map((f, i) => (
                <li key={i}>
                  {relTime(f.at)}: {f.key}: {f.error}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Block>

      <Block title="AI" desc="Runs locally with Ollama by default. Nothing leaves this computer unless you choose Claude or OpenAI.">
        <div className="rounded-[3px] bg-card px-3 py-2 text-[13.5px] shadow-[var(--shadow-card)]" data-testid="ai-status">
          {ai.data ? (
            <>
              <strong className="font-semibold">{ai.data.provider}</strong>: chat {ai.data.chat ? `ready (${ai.data.chatModel})` : 'unavailable'}, meaning search {ai.data.embeddings ? `ready (${ai.data.embedModel}, ${ai.data.indexed ?? 0} passages)` : 'unavailable'}
              {ai.data.reason && <div className="text-[12.5px] text-faded">{ai.data.reason}</div>}
            </>
          ) : (
            'Checking…'
          )}
        </div>
        <Field label="Provider">
          <select className="field" value={cfg.ai.provider} onChange={(e) => setCfg({ ...cfg, ai: { ...cfg.ai, provider: e.target.value } })}>
            <option value="ollama">Ollama (local)</option>
            <option value="anthropic">Claude (Anthropic API)</option>
            <option value="openai">OpenAI</option>
            <option value="none">Off</option>
          </select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ollama address">
            <input className="field" value={cfg.ai.ollamaUrl} onChange={(e) => setCfg({ ...cfg, ai: { ...cfg.ai, ollamaUrl: e.target.value } })} />
          </Field>
          <Field label="Embedding model (Ollama)" hint="Used for meaning search even when chat uses Claude or OpenAI.">
            <input className="field" value={cfg.ai.embedModel} onChange={(e) => setCfg({ ...cfg, ai: { ...cfg.ai, embedModel: e.target.value } })} />
          </Field>
          <Field label="Chat model (Ollama)">
            <input className="field" value={cfg.ai.chatModel} onChange={(e) => setCfg({ ...cfg, ai: { ...cfg.ai, chatModel: e.target.value } })} />
          </Field>
          <Field label="Claude model">
            <input className="field" value={cfg.ai.anthropicModel} onChange={(e) => setCfg({ ...cfg, ai: { ...cfg.ai, anthropicModel: e.target.value } })} />
          </Field>
          <Field label="OpenAI model">
            <input className="field" value={cfg.ai.openaiModel} onChange={(e) => setCfg({ ...cfg, ai: { ...cfg.ai, openaiModel: e.target.value } })} />
          </Field>
        </div>
        <Toggle checked={cfg.ai.enrichOnCapture} onChange={(v) => setCfg({ ...cfg, ai: { ...cfg.ai, enrichOnCapture: v } })} label="Suggest tags and links for new captures" />
        <div className="flex flex-wrap items-center gap-3">
          <Toggle checked={cfg.ai.inboxAgent.enabled} onChange={(v) => setCfg({ ...cfg, ai: { ...cfg.ai, inboxAgent: { ...cfg.ai.inboxAgent, enabled: v } } })} label="Run the inbox agent every" />
          <input
            type="number"
            min={15}
            className="field !w-24"
            value={cfg.ai.inboxAgent.intervalMinutes}
            onChange={(e) => setCfg({ ...cfg, ai: { ...cfg.ai, inboxAgent: { ...cfg.ai.inboxAgent, intervalMinutes: Number(e.target.value) } } })}
            aria-label="Inbox agent interval in minutes"
          />
          <span className="text-[14px]">minutes</span>
        </div>
        <div>
          <button className="btn btn-primary" onClick={() => saveConfig({ ai: cfg.ai })}>
            Save AI settings
          </button>
        </div>
        <SecretField label="Anthropic API key" isSet={d.secrets.anthropicKey} onSave={saveSecret('anthropicKey')} placeholder="sk-ant-…" />
        <SecretField label="OpenAI API key" isSet={d.secrets.openaiKey} onSave={saveSecret('openaiKey')} placeholder="sk-…" />
      </Block>

      <Block title="Agents" desc="Give each agent its own token. Its changes are committed under its name, so you can review or revert them.">
        <div>
          <span className="label mb-1 block">Access tokens</span>
          {d.tokens.length === 0 && <p className="text-[13.5px] text-faded">No tokens yet.</p>}
          <ul className="flex flex-col">
            {d.tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 border-b border-rule py-2 text-[14px]">
                <KeyRound size={14} className="text-faded" />
                <span className="font-semibold">agent:{t.name}</span>
                <span className="text-[12.5px] text-faded">created {relTime(t.created)}{t.lastUsed ? `, last used ${relTime(t.lastUsed)}` : ', never used'}</span>
                <button
                  className="btn btn-sm btn-quiet btn-danger ml-auto"
                  onClick={async () => {
                    if (!confirm(`Revoke the token for ${t.name}?`)) return;
                    qc.setQueryData(['settings'], await api(`/api/settings/tokens/${t.id}`, { method: 'DELETE' }));
                  }}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
          <form
            className="mt-3 flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const t = await api<{ name: string; token: string }>('/api/settings/tokens', { method: 'POST', json: { name: tokenName || 'agent' } });
              setNewToken(t);
              setTokenName('');
              qc.invalidateQueries({ queryKey: ['settings'] });
            }}
          >
            <input className="field !w-60" placeholder="Agent name, e.g. claude-desktop" value={tokenName} onChange={(e) => setTokenName(e.target.value)} />
            <button className="btn">Create token</button>
          </form>
          {newToken && (
            <div className="mt-3 rounded-[3px] border border-brass/50 bg-highlight/30 p-3 text-[13.5px]">
              Token for <strong>{newToken.name}</strong>. Copy it now; it won’t be shown again.
              <Snippet text={newToken.token} />
            </div>
          )}
        </div>
        <div>
          <span className="label mb-1 block">MCP for local agents (Claude Code, Claude Desktop)</span>
          <p className="mb-1.5 text-[13px] text-faded">
            Runs over stdio, no token needed. For Claude Code: <code className="rounded bg-paper-deep px-1">claude mcp add cabinet -- node &lt;path&gt;/apps/cli/src/main.ts mcp</code>
          </p>
          <Snippet text={mcpStdio} />
        </div>
        <div>
          <span className="label mb-1 block">MCP for remote agents (HTTP)</span>
          <Snippet text={mcpHttp} />
        </div>
      </Block>

      <Block title="Telegram" desc="Send links, photos, PDFs, text and voice notes to your cabinet from your phone. Voice notes are transcribed on this computer.">
        <div className="text-[13.5px]" data-testid="telegram-status">
          {d.telegram.running ? (
            <span className="text-lamp">Bot running{d.telegram.username ? ` as @${d.telegram.username}` : ''}.</span>
          ) : (
            <span className="text-faded">Bot not running{d.telegram.error ? `: ${d.telegram.error}` : ''}.</span>
          )}{' '}
          <span className="text-faded">Transcription: {d.transcription.ok ? 'ready (whisper.cpp)' : `unavailable${d.transcription.reason ? ` (${d.transcription.reason})` : ''}`}.</span>
        </div>
        <SecretField label="Bot token from @BotFather" isSet={d.secrets.telegramToken} onSave={saveSecret('telegramToken')} placeholder="123456:ABC…" />
        <Toggle checked={cfg.telegram.enabled} onChange={(v) => saveConfig({ telegram: { ...cfg.telegram, enabled: v } })} label="Enable the bot" />
        <div>
          <button
            className="btn"
            onClick={async () => {
              const r = await api<{ code: string }>('/api/settings/telegram/pair', { method: 'POST' });
              setPairing(r.code);
            }}
          >
            Pair a chat
          </button>
          {pairing && (
            <p className="mt-2 text-[14px]">
              Send <code className="rounded bg-paper-deep px-1.5 py-0.5 font-semibold">/pair {pairing}</code> to your bot within 10 minutes.
            </p>
          )}
        </div>
        {cfg.telegram.allowedChats.length > 0 && (
          <ul className="text-[14px]">
            {cfg.telegram.allowedChats.map((c: number) => (
              <li key={c} className="flex items-center gap-2 border-b border-rule py-1.5">
                Chat {c}
                <button
                  className="btn btn-sm btn-quiet btn-danger ml-auto"
                  onClick={async () => {
                    qc.setQueryData(['settings'], await api(`/api/settings/telegram/chats/${c}`, { method: 'DELETE' }));
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="History" desc="Every change is committed to git in your library folder, labelled with who made it.">
        <Toggle checked={cfg.git.autoCommit} onChange={(v) => setCfg({ ...cfg, git: { ...cfg.git, autoCommit: v } })} label="Commit changes automatically" />
        <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
          <Field label="Private remote (optional)" hint="For example git@github.com:you/cabinet-library.git">
            <input className="field" value={cfg.git.remote ?? ''} onChange={(e) => setCfg({ ...cfg, git: { ...cfg.git, remote: e.target.value || undefined } })} />
          </Field>
          <Field label="Wait before committing">
            <select className="field" value={cfg.git.debounceMs} onChange={(e) => setCfg({ ...cfg, git: { ...cfg.git, debounceMs: Number(e.target.value) } })}>
              <option value={10000}>10 seconds</option>
              <option value={30000}>30 seconds</option>
              <option value={120000}>2 minutes</option>
            </select>
          </Field>
        </div>
        <Toggle checked={cfg.git.push} onChange={(v) => setCfg({ ...cfg, git: { ...cfg.git, push: v } })} label="Push after each commit" />
        <div>
          <button className="btn btn-primary" onClick={() => saveConfig({ git: cfg.git })}>
            Save history settings
          </button>
        </div>
        <ul className="max-h-64 overflow-y-auto text-[13px]">
          {commits.data?.commits.map((c) => (
            <li key={c.hash} className="flex gap-3 border-b border-rule py-1.5">
              <span className="w-24 shrink-0 font-semibold text-ink-soft">{c.author}</span>
              <span className="flex-1 truncate">{c.message}</span>
              <span className="shrink-0 text-faded">{relTime(c.date)}</span>
            </li>
          ))}
        </ul>
      </Block>

      <Block title="Access" desc="Cabinet only listens on this computer unless you allow your network. Other devices then need the passphrase.">
        <Toggle checked={cfg.server.allowRemote} onChange={(v) => saveConfig({ server: { allowRemote: v } })} label="Allow devices on my network or Tailscale (takes effect on restart)" />
        <Field label={d.secrets.passphrase ? 'Change passphrase' : 'Set a passphrase'} hint="At least 8 characters. Changing it signs out other devices.">
          <div className="flex gap-2">
            <input type="password" className="field" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
            <button
              className="btn"
              disabled={pass.length < 8}
              onClick={async () => {
                try {
                  qc.setQueryData(['settings'], await api('/api/settings/passphrase', { method: 'POST', json: { passphrase: pass } }));
                  setPass('');
                  toast('Passphrase saved', { tone: 'ok' });
                } catch (e) {
                  toast((e as Error).message, { tone: 'error' });
                }
              }}
            >
              Save
            </button>
            {d.secrets.passphrase && (
              <button
                className="btn btn-quiet btn-danger"
                onClick={async () => {
                  qc.setQueryData(['settings'], await api('/api/settings/passphrase', { method: 'POST', json: { passphrase: null } }));
                  toast('Passphrase removed');
                }}
              >
                Remove
              </button>
            )}
          </div>
        </Field>
      </Block>
    </div>
  );
}
