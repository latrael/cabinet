import { createHash, randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { loadSecrets, saveSecrets, nowIso, type Library, type LibrarySecrets } from '@cabinet/core';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
export const SESSION_COOKIE = 'cabinet_session';
const SESSION_DAYS = 30;

export interface AuthResult {
  ok: boolean;
  author: string;
  via: 'local' | 'session' | 'token' | 'none';
  scopes: string[];
  status?: number;
  reason?: string;
}

function sha256(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Single-user auth.
 * - Loopback requests with a localhost Host header are trusted (DNS-rebinding safe).
 * - Anything else needs a passphrase session cookie or a per-agent bearer token.
 * - Cookie/local mutations must be same-origin (CSRF protection).
 */
export class Auth {
  private lib: Library;
  secrets: LibrarySecrets;
  extraHosts: string[];

  constructor(lib: Library, opts: { extraHosts?: string[] } = {}) {
    this.lib = lib;
    this.secrets = loadSecrets(lib.root);
    this.extraHosts = opts.extraHosts ?? [];
    if (!this.secrets.sessionSecret) {
      this.secrets.sessionSecret = randomBytes(32).toString('hex');
      this.save();
    }
  }

  save() {
    saveSecrets(this.lib.root, this.secrets);
  }

  reload() {
    this.secrets = loadSecrets(this.lib.root);
  }

  get hasPassphrase(): boolean {
    return !!this.secrets.passphraseHash;
  }

  setPassphrase(passphrase: string | null) {
    if (!passphrase) {
      delete this.secrets.passphraseHash;
    } else {
      if (passphrase.length < 8) throw new Error('Use at least 8 characters');
      const salt = randomBytes(16).toString('hex');
      const hash = scryptSync(passphrase, salt, 32).toString('hex');
      this.secrets.passphraseHash = `scrypt$${salt}$${hash}`;
    }
    // Rotating the secret signs everyone out.
    this.secrets.sessionSecret = randomBytes(32).toString('hex');
    this.save();
  }

  checkPassphrase(passphrase: string): boolean {
    const h = this.secrets.passphraseHash;
    if (!h) return false;
    const [, salt, hash] = h.split('$');
    const got = scryptSync(passphrase, salt, 32);
    return timingSafeEqual(got, Buffer.from(hash, 'hex'));
  }

  issueSession(): string {
    const exp = Date.now() + SESSION_DAYS * 86400_000;
    const payload = `v1.${exp}`;
    const sig = createHmac('sha256', this.secrets.sessionSecret!).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  verifySession(value: string | undefined): boolean {
    if (!value) return false;
    const parts = value.split('.');
    if (parts.length !== 3) return false;
    const payload = `${parts[0]}.${parts[1]}`;
    const sig = createHmac('sha256', this.secrets.sessionSecret!).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(parts[2]);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    return Number(parts[1]) > Date.now();
  }

  createToken(name: string, opts?: { scopes?: string[] }): { id: string; token: string; name: string; scopes: string[] } {
    const clean = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40) || 'agent';
    const token = 'cab_' + randomBytes(24).toString('base64url');
    const id = randomBytes(6).toString('hex');
    const scopes = [...new Set((opts?.scopes ?? []).filter((s) => s === 'review'))];
    this.secrets.tokens = [
      ...(this.secrets.tokens ?? []),
      { id, name: clean, hash: sha256(token), created: nowIso(), ...(scopes.length ? { scopes } : {}) },
    ];
    this.save();
    return { id, token, name: clean, scopes };
  }

  revokeToken(id: string) {
    this.secrets.tokens = (this.secrets.tokens ?? []).filter((t) => t.id !== id);
    this.save();
  }

  listTokens() {
    return (this.secrets.tokens ?? []).map(({ id, name, created, lastUsed, scopes }) => ({
      id,
      name,
      created,
      lastUsed,
      scopes: scopes ?? [],
    }));
  }

  verifyToken(token: string): { id: string; name: string; scopes: string[] } | null {
    const h = sha256(token);
    const t = (this.secrets.tokens ?? []).find((x) => {
      const a = Buffer.from(x.hash);
      const b = Buffer.from(h);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!t) return null;
    const now = nowIso();
    if (!t.lastUsed || Date.parse(now) - Date.parse(t.lastUsed) > 60_000) {
      t.lastUsed = now;
      this.save();
    }
    return { id: t.id, name: t.name, scopes: t.scopes ?? [] };
  }

  isLocalHost(host: string | undefined): boolean {
    if (!host) return false;
    if (LOCAL_HOSTS.test(host)) return true;
    const bare = host.replace(/:\d+$/, '').toLowerCase();
    return this.extraHosts.includes(bare);
  }

  /**
   * Decide whether a request is allowed.
   * @param remote socket remote address
   * @param headers lower-cased request headers
   */
  check(req: { remote?: string; method: string; headers: Record<string, string | undefined>; cookie?: string }): AuthResult {
    const authz = req.headers['authorization'];
    if (authz?.startsWith('Bearer ')) {
      const t = this.verifyToken(authz.slice(7).trim());
      if (t) return { ok: true, author: `agent:${t.name}`, via: 'token', scopes: t.scopes };
      return { ok: false, author: '', via: 'none', scopes: [], status: 401, reason: 'Invalid token' };
    }
    const host = req.headers['host'];
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const origin = req.headers['origin'];
    const site = req.headers['sec-fetch-site'];
    const sameOrigin = () => {
      if (site && !['same-origin', 'none'].includes(site)) return false;
      if (origin && origin !== 'null') {
        try {
          return new URL(origin).host === host;
        } catch {
          return false;
        }
      }
      return true;
    };
    const local = !!req.remote && LOOPBACK.has(req.remote) && this.isLocalHost(host);
    if (local) {
      if (mutating && !sameOrigin()) return { ok: false, author: '', via: 'none', scopes: [], status: 403, reason: 'Cross-origin request blocked' };
      return { ok: true, author: 'you', via: 'local', scopes: [] };
    }
    if (this.verifySession(req.cookie)) {
      if (mutating && !sameOrigin()) return { ok: false, author: '', via: 'none', scopes: [], status: 403, reason: 'Cross-origin request blocked' };
      return { ok: true, author: 'you', via: 'session', scopes: [] };
    }
    return {
      ok: false,
      author: '',
      via: 'none',
      scopes: [],
      status: 401,
      reason: this.hasPassphrase ? 'Sign in required' : 'Remote access needs a passphrase. Set one from Settings on this computer.',
    };
  }
}
