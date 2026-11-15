import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Library-level config, committed with the library at `.cabinet/config.json`. */
export interface LibraryConfig {
  version: 1;
  name: string;
  git: {
    autoCommit: boolean;
    debounceMs: number;
    remote?: string;
    push: boolean;
  };
  ai: {
    provider: 'ollama' | 'anthropic' | 'openai' | 'none';
    ollamaUrl: string;
    chatModel: string;
    embedModel: string;
    anthropicModel: string;
    openaiModel: string;
    openaiEmbedModel: string;
    enrichOnCapture: boolean;
    inboxAgent: { enabled: boolean; intervalMinutes: number };
  };
  telegram: {
    enabled: boolean;
    allowedChats: number[];
  };
  server: {
    allowRemote: boolean; // listen beyond localhost; requires passphrase
  };
}

/** Secrets live in `.cabinet/secrets.json`, which is gitignored. */
export interface LibrarySecrets {
  passphraseHash?: string; // scrypt
  sessionSecret?: string;
  anthropicKey?: string;
  openaiKey?: string;
  telegramToken?: string;
  telegramPairing?: { code: string; expires: number };
  tokens?: Array<{ id: string; name: string; hash: string; created: string; lastUsed?: string }>;
}

export function defaultConfig(name = 'Cabinet'): LibraryConfig {
  return {
    version: 1,
    name,
    git: { autoCommit: true, debounceMs: 30_000, push: false },
    ai: {
      provider: 'ollama',
      ollamaUrl: 'http://127.0.0.1:11434',
      chatModel: 'qwen3:8b',
      embedModel: 'nomic-embed-text',
      anthropicModel: 'claude-opus-5-5',
      openaiModel: 'gpt-5.1-mini',
      openaiEmbedModel: 'text-embedding-3-small',
      enrichOnCapture: true,
      inboxAgent: { enabled: true, intervalMinutes: 360 },
    },
    telegram: { enabled: false, allowedChats: [] },
    server: { allowRemote: false },
  };
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over as T) ?? base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as any)?.[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out;
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

export function loadConfig(root: string): LibraryConfig {
  return deepMerge(defaultConfig(), readJson(join(root, '.cabinet', 'config.json'), {}));
}

export function saveConfig(root: string, cfg: LibraryConfig) {
  writeJson(join(root, '.cabinet', 'config.json'), cfg);
}

export function loadSecrets(root: string): LibrarySecrets {
  return readJson(join(root, '.cabinet', 'secrets.json'), {});
}

export function saveSecrets(root: string, s: LibrarySecrets) {
  const p = join(root, '.cabinet', 'secrets.json');
  writeJson(p, s);
}

export { deepMerge };

/** App-level settings (outside any library): which library to open. */
export function appSettingsPath(): string {
  return process.env.CABINET_APP_CONFIG ?? join(homedir(), '.config', 'cabinet', 'app.json');
}

export function defaultLibraryPath(): string {
  if (process.env.CABINET_LIBRARY) return process.env.CABINET_LIBRARY;
  const app = readJson<{ libraryPath?: string }>(appSettingsPath(), {});
  return app.libraryPath ?? join(homedir(), 'Cabinet');
}

export function setDefaultLibraryPath(p: string) {
  const path = appSettingsPath();
  const app = readJson<Record<string, unknown>>(path, {});
  app.libraryPath = p;
  writeJson(path, app);
}

export function libraryExists(root: string): boolean {
  return existsSync(join(root, '.cabinet', 'config.json'));
}
