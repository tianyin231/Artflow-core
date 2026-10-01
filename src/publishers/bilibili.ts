/**
 * Bilibili open-platform publisher with OAuth + HMAC signing.
 * All bases overridable via ARTFLOW_BILIBILI_BASE_URL for mocks.
 */
import { createHmac } from 'node:crypto';
import {
  PublishOptions,
  PublishPackage,
  PublishResult,
  PublishValidation,
  Publisher,
  PublisherCapabilities,
  AuthState,
  validateCommon,
} from './types';

export function bilibiliSign(
  params: Record<string, string>,
  clientSecret: string,
  timestamp: number
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const payload = `${sorted}&timestamp=${timestamp}`;
  return createHmac('sha256', clientSecret).update(payload).digest('hex');
}

export interface BilibiliCredentials {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export class BilibiliOpenPlatformPublisher implements Publisher {
  readonly id = 'bilibili';
  readonly displayName = 'Bilibili';
  readonly capabilities: PublisherCapabilities = {
    auth: 'oauth2',
    maxSizeBytes: 8 * 1024 * 1024 * 1024,
    maxDurationSec: 3 * 3600,
    aspectRatios: ['16:9', '9:16', '1:1'],
    titleMax: 80,
    descMax: 2000,
    tagsMax: 12,
  };

  constructor(
    private creds: BilibiliCredentials,
    private readonly secretGet?: (id: string) => string | undefined
  ) {}

  private baseUrl(): string {
    return process.env.ARTFLOW_BILIBILI_BASE_URL || 'https://openupos.bilivideo.com';
  }

  validate(pkg: PublishPackage): PublishValidation {
    return validateCommon(pkg, this.capabilities);
  }

  async authStatus(): Promise<{ state: AuthState; expiresAt?: string; account?: string }> {
    if (!this.creds.accessToken && !this.secretGet?.('bilibili.accessToken')) {
      return { state: 'not_configured' };
    }
    const token = this.creds.accessToken || this.secretGet?.('bilibili.accessToken');
    if (!token) return { state: 'not_configured' };
    if (this.creds.expiresAt && this.creds.expiresAt < Date.now()) {
      return { state: 'expired', expiresAt: new Date(this.creds.expiresAt).toISOString() };
    }
    return {
      state: 'ok',
      expiresAt: this.creds.expiresAt ? new Date(this.creds.expiresAt).toISOString() : undefined,
      account: this.creds.clientId,
    };
  }

  async beginAuth(): Promise<{ authorizeUrl: string; state: string }> {
    const state = `bili-${Date.now()}`;
    const redirect = process.env.ARTFLOW_BILIBILI_REDIRECT || 'http://127.0.0.1:3300/api/auth/bilibili/callback';
    const authorizeUrl =
      `https://account.bilibili.com/oauth2/authorize?client_id=${this.creds.clientId}` +
      `&response_type=code&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;
    return { authorizeUrl, state };
  }

  async completeAuth(input: { state: string; callback: string }): Promise<void> {
    const url = new URL(input.callback.replace(/^bilibili:/, 'https://x.invalid/'));
    const code = url.searchParams.get('code');
    if (!code) throw new Error('missing code');
    const res = await fetch(`${this.baseUrl()}/oauth2/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        code,
      }),
    });
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) throw new Error('token exchange failed');
    this.creds.accessToken = body.access_token;
    this.creds.refreshToken = body.refresh_token;
    this.creds.expiresAt = Date.now() + (body.expires_in ?? 7200) * 1000;
  }

  async refreshAuth(): Promise<void> {
    const refresh = this.creds.refreshToken || this.secretGet?.('bilibili.refreshToken');
    if (!refresh) throw new Error('no refresh token');
    const res = await fetch(`${this.baseUrl()}/oauth2/refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: refresh,
      }),
    });
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) throw new Error('refresh failed');
    this.creds.accessToken = body.access_token;
    this.creds.refreshToken = body.refresh_token;
    this.creds.expiresAt = Date.now() + (body.expires_in ?? 7200) * 1000;
  }

  async publish(pkg: PublishPackage, opts: PublishOptions): Promise<PublishResult> {
    const validation = this.validate(pkg);
    if (!validation.ok) {
      return { status: 'failed', message: validation.issues.map((i) => i.message).join('; ') };
    }
    if (opts.dryRun) {
      return { status: 'dry_run', message: 'bilibili dry-run' };
    }
    const status = await this.authStatus();
    if (status.state === 'not_configured' || status.state === 'expired') {
      try {
        if (status.state === 'expired') await this.refreshAuth();
      } catch {
        return { status: 'auth_required', message: '需重新授权' };
      }
      if ((await this.authStatus()).state === 'not_configured') {
        return { status: 'auth_required', message: '需重新授权' };
      }
    }
    const token = this.creds.accessToken || this.secretGet?.('bilibili.accessToken') || '';
    const ts = Math.floor(Date.now() / 1000);
    const sign = bilibiliSign(
      { title: pkg.title, desc: pkg.description },
      this.creds.clientSecret,
      ts
    );
    const res = await fetch(`${this.baseUrl()}/x/open-platform/v2/video/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-client-sign': sign,
        'x-client-timestamp': String(ts),
      },
      body: JSON.stringify({
        title: pkg.title,
        desc: pkg.description,
        tag: pkg.tags.join(','),
        copyright: 1,
        source: pkg.sources[0]?.url,
      }),
    });
    const body = (await res.json()) as { code?: number; data?: { vid?: string; aid?: string }; message?: string };
    if (!res.ok || (body.code !== undefined && body.code !== 0)) {
      return { status: 'failed', message: body.message || `HTTP ${res.status}` };
    }
    return {
      status: 'submitted',
      remoteId: String(body.data?.vid ?? body.data?.aid ?? ''),
      url: body.data?.aid ? `https://www.bilibili.com/video/av${body.data.aid}` : undefined,
    };
  }
}
