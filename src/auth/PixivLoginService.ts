/**
 * PixivLoginService — host-driven PKCE login + token import + accounts.
 * Tokens never appear in argv; import goes through stdin.
 */
import { createHash, randomBytes } from 'node:crypto';
import { PixivProvider } from '../pixiv-provider/types';
import { CLIENT_ID, CLIENT_SECRET } from '../terminal-login/constants';

export interface LoginStartResult {
  loginId: string;
  authorizeUrl: string;
  expiresAt: string;
}

export interface LoginSession {
  loginId: string;
  codeVerifier: string;
  createdAt: number;
  used: boolean;
}

export class AuthHostLoginSessionInvalidError extends Error {
  readonly code = 'AUTH_HOST_LOGIN_SESSION_INVALID';
  constructor(message = 'login session invalid or expired') {
    super(message);
    this.name = 'AuthHostLoginSessionInvalidError';
  }
}

const SESSION_TTL_MS = 10 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function s256(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

export function parseCallback(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('empty callback');
  // pure code
  if (!raw.includes('://') && !raw.includes('=')) return raw;
  try {
    const url = new URL(raw.replace(/^pixiv:/, 'https://pixiv.invalid/'));
    const code = url.searchParams.get('code');
    if (code) return code;
  } catch {
    /* fall through */
  }
  const m = raw.match(/[?&]code=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  throw new Error('callback missing code');
}

export interface TokenImporter {
  importToken(refreshToken: string): Promise<void>;
  listAccounts(): Promise<{ userId: string; name?: string; isDefault: boolean }[]>;
  useAccount(uid: string): Promise<void>;
  check(): Promise<{ authenticated: boolean }>;
}

export class PixivLoginService {
  private sessions = new Map<string, LoginSession>();

  constructor(
    private readonly importer: TokenImporter,
    private readonly opts: {
      authorizeBaseUrl?: string;
      now?: () => number;
    } = {}
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(): LoginStartResult {
    const loginId = b64url(randomBytes(12));
    const codeVerifier = b64url(randomBytes(32));
    const challenge = s256(codeVerifier);
    this.sessions.set(loginId, {
      loginId,
      codeVerifier,
      createdAt: this.now(),
      used: false,
    });
    const base =
      this.opts.authorizeBaseUrl ||
      process.env.ARTFLOW_PIXIV_OAUTH_BASE_URL ||
      'https://app-api.pixiv.net';
    const authorizeUrl =
      `${base}/web/v1/login?code_challenge=${challenge}` +
      `&code_challenge_method=S256&client=pixiv-android`;
    return {
      loginId,
      authorizeUrl,
      expiresAt: new Date(this.now() + SESSION_TTL_MS).toISOString(),
    };
  }

  private takeSession(loginId: string): LoginSession {
    const s = this.sessions.get(loginId);
    if (!s || s.used || this.now() - s.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(loginId);
      throw new AuthHostLoginSessionInvalidError();
    }
    s.used = true;
    this.sessions.delete(loginId);
    return s;
  }

  async complete(input: { loginId: string; callback: string }): Promise<{ ok: true }> {
    const session = this.takeSession(input.loginId);
    const code = parseCallback(input.callback);
    const tokenBase =
      this.opts.authorizeBaseUrl ||
      process.env.ARTFLOW_PIXIV_OAUTH_BASE_URL ||
      'https://oauth.secure.pixiv.net';
    const res = await fetch(`${tokenBase}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.ARTFLOW_PIXIV_CLIENT_ID ?? CLIENT_ID,
        client_secret: process.env.ARTFLOW_PIXIV_CLIENT_SECRET ?? CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        code_verifier: session.codeVerifier,
        redirect_uri: 'pixiv://account/login',
        include_policy: 'true',
      }),
    });
    if (!res.ok) {
      throw new Error(`token exchange failed: ${res.status}`);
    }
    const body = (await res.json()) as { refresh_token?: string };
    const refresh = body.refresh_token;
    if (!refresh) throw new Error('token exchange missing refresh_token');
    await this.importer.importToken(refresh);
    return { ok: true };
  }

  async importToken(refreshToken: string): Promise<{ ok: true }> {
    if (!refreshToken || !refreshToken.trim()) {
      throw new Error('refresh token required');
    }
    await this.importer.importToken(refreshToken.trim());
    return { ok: true };
  }

  async accounts() {
    return this.importer.listAccounts();
  }

  async use(uid: string) {
    await this.importer.useAccount(uid);
  }

  async check() {
    return this.importer.check();
  }
}

/** In-memory importer used by tests and when provider has no CLI. */
export class MemoryTokenImporter implements TokenImporter {
  tokens: string[] = [];
  accounts: { userId: string; name?: string; isDefault: boolean }[] = [];
  active?: string;

  async importToken(refreshToken: string): Promise<void> {
    this.tokens.push(refreshToken);
    this.accounts = [
      {
        userId: `u-${this.tokens.length}`,
        name: 'Imported',
        isDefault: true,
      },
    ];
    this.active = refreshToken;
  }
  async listAccounts() {
    return this.accounts;
  }
  async useAccount(uid: string) {
    this.active = uid;
  }
  async check() {
    return { authenticated: this.tokens.length > 0 };
  }
}

/** Importer that delegates to pixiv-cli via a provider-like exec. */
export class CliTokenImporter implements TokenImporter {
  constructor(
    private readonly run: (
      args: string[],
      stdin?: string
    ) => Promise<{ code: number; stdout: string; stderr: string }>
  ) {}

  async importToken(refreshToken: string): Promise<void> {
    // stdin only — never argv
    const res = await this.run(['auth', 'import', '--json'], refreshToken);
    if (res.code !== 0) throw new Error(res.stderr || 'auth import failed');
  }
  async listAccounts() {
    const res = await this.run(['auth', 'list', '--json']);
    if (res.code !== 0) return [];
    try {
      const parsed = JSON.parse(res.stdout || '[]');
      return Array.isArray(parsed)
        ? parsed.map((a: Record<string, unknown>, i: number) => ({
            userId: String(a.userId ?? a.id ?? i),
            name: a.name ? String(a.name) : undefined,
            isDefault: Boolean(a.isDefault ?? i === 0),
          }))
        : [];
    } catch {
      return [];
    }
  }
  async useAccount(uid: string) {
    await this.run(['auth', 'use', uid, '--json']);
  }
  async check() {
    const res = await this.run(['auth', 'check', '--json']);
    return { authenticated: res.code === 0 };
  }
}
